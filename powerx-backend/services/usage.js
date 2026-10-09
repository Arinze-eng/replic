// services/usage.js
// ─────────────────────────────────────────────────────────────────────────────
// Live USAGE / BALANCE / CREDIT readout for every integration provider.
//
// Powers the admin panel → ⚙️ Integrations → "📊 Usage & Balance" block.
// Each function NEVER throws — it returns a normalized object so the panel can
// always render something useful (and an honest "not exposed by this provider"
// message where the upstream API has no usage endpoint).
//
// Normalized shape returned per provider:
//   {
//     ok:        boolean,   // did we successfully reach the provider?
//     configured:boolean,   // is a key set at all?
//     label:     string,    // human one-liner for the badge
//     metrics:   [ { name, value, unit?, hint? } ],  // 0..n rows to render
//     balance:   string|null,  // dollar/credit balance if the provider exposes it
//     plan:      string|null,  // plan / tier name if known
//     raw?:      any,           // small raw payload for debugging (never secrets)
//   }
// ─────────────────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');

let db = null;
try { db = require('../db'); } catch (_) { /* optional */ }

const runloopService = require('./runloop');
const daytonaService = require('./daytona');
const hopxService = require('./hopx');
const browserlessService = require('./browserless');
let wolfram = null;
try { wolfram = require('./wolfram'); } catch (_) {}

// ── small helpers ────────────────────────────────────────────────────────────
function num(n) {
  return (typeof n === 'number' && isFinite(n)) ? n : 0;
}
function round(n, d = 2) {
  const p = Math.pow(10, d);
  return Math.round(num(n) * p) / p;
}
function withTimeout(ms) {
  // node-fetch v2 supports a `timeout` option; also pass AbortSignal for v3 safety.
  try { return AbortSignal.timeout(ms); } catch (_) { return undefined; }
}
async function settingKey(name) {
  try { if (db && db.getSetting) { const v = await db.getSetting(name); if (v && v.trim()) return v.trim(); } } catch (_) {}
  return '';
}

// ── RENDER ───────────────────────────────────────────────────────────────────
// Render's public API does NOT expose a dollar credit balance, but it DOES
// expose: the workspace owner, every service + its compute plan, and live
// metrics (bandwidth MB, CPU, memory). On the FREE plan "usage" == bandwidth
// consumed + instance hours, which is exactly what an admin watches.
//   Key: render_api_key (runtime DB) → RENDER_API_KEY (env)
const RENDER_BASE = (process.env.RENDER_API_URL || 'https://api.render.com/v1').replace(/\/+$/, '');

async function getRenderKey() {
  return (await settingKey('render_api_key')) || (process.env.RENDER_API_KEY || '').trim();
}

async function renderApi(path, key) {
  const resp = await fetch(RENDER_BASE + path, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    timeout: 20000,
    signal: withTimeout(20000),
  });
  const text = await resp.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}
  return { ok: resp.ok, status: resp.status, json, text };
}

async function renderUsage() {
  const key = await getRenderKey();
  const out = { ok: false, configured: !!key, label: '', metrics: [], balance: null, plan: null };
  if (!key) { out.label = 'No Render API key set.'; return out; }
  try {
    // 1) Owner (workspace).
    const owners = await renderApi('/owners?limit=1', key);
    if (!owners.ok) {
      out.label = owners.status === 401 ? '❌ Invalid Render API key (401).' : `❌ Render API error (HTTP ${owners.status}).`;
      return out;
    }
    const owner = Array.isArray(owners.json) && owners.json[0] && owners.json[0].owner;
    const ownerId = owner && owner.id;

    // 2) Services + their compute plans.
    const svcs = await renderApi('/services?limit=50', key);
    const services = Array.isArray(svcs.json) ? svcs.json.map(s => s.service).filter(Boolean) : [];
    const planCount = {};
    let webSvc = null;
    for (const s of services) {
      const plan = (s.serviceDetails && s.serviceDetails.plan) || s.plan || 'unknown';
      planCount[plan] = (planCount[plan] || 0) + 1;
      if (!webSvc && /web/i.test(s.type || '')) webSvc = s;
      if (!webSvc) webSvc = s;
    }
    out.plan = Object.entries(planCount).map(([p, c]) => `${c}× ${p}`).join(', ') || null;

    // 3) Bandwidth used in the current calendar month (sum of hourly MB).
    let bandwidthMb = 0;
    if (webSvc && webSvc.id) {
      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
      const endTime = now.toISOString();
      const bw = await renderApi(
        `/metrics/bandwidth?resource=${encodeURIComponent(webSvc.id)}&startTime=${encodeURIComponent(monthStart)}&endTime=${encodeURIComponent(endTime)}`,
        key
      );
      if (bw.ok && Array.isArray(bw.json)) {
        for (const series of bw.json) {
          for (const v of (series.values || [])) bandwidthMb += num(v.value);
        }
      }
    }

    out.ok = true;
    out.metrics.push({ name: 'Workspace', value: (owner && owner.name) || 'Render', hint: ownerId || '' });
    out.metrics.push({ name: 'Services', value: String(services.length) });
    out.metrics.push({ name: 'Bandwidth (this month)', value: round(bandwidthMb, 1), unit: 'MB', hint: 'Free plan: 100 GB/mo' });
    out.metrics.push({ name: 'Compute plan', value: out.plan || 'unknown' });
    out.label = `✅ ${(owner && owner.name) || 'Render'} — ${services.length} service(s), ${round(bandwidthMb, 1)} MB bandwidth this month.`;
    // Render exposes no $ balance via API.
    out.balance = null;
    return out;
  } catch (e) {
    out.label = `❌ Could not reach Render: ${e.message}`;
    return out;
  }
}

// ── RUNLOOP ──────────────────────────────────────────────────────────────────
// Runloop bills usage-based compute and gives new accounts $50 trial credits.
// The public API exposes devboxes (list → active count) reliably. We also try
// a best-effort account/usage probe; if Runloop doesn't return a balance we say
// so honestly rather than inventing a number.
const RUNLOOP_BASE = (process.env.RUNLOOP_API_URL || 'https://api.runloop.ai/v1').replace(/\/+$/, '');

async function runloopUsage() {
  const key = (await runloopService.getApiKey().catch(() => '')) || '';
  const out = { ok: false, configured: !!key, label: '', metrics: [], balance: null, plan: null };
  if (!key) { out.label = 'No Runloop API key set.'; return out; }
  const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
  try {
    // Active devboxes (running) — primary usage signal.
    const r = await fetch(`${RUNLOOP_BASE}/devboxes?limit=100`, { headers, timeout: 20000, signal: withTimeout(20000) });
    if (!r.ok) {
      out.label = (r.status === 401 || r.status === 403) ? '❌ Invalid Runloop API key.' : `❌ Runloop API error (HTTP ${r.status}).`;
      return out;
    }
    const d = await r.json().catch(() => ({}));
    const arr = Array.isArray(d) ? d : (Array.isArray(d.devboxes) ? d.devboxes : []);
    const running = arr.filter(b => /run|active|provision|resum/i.test(String(b.status || ''))).length;
    out.ok = true;
    out.metrics.push({ name: 'Devboxes (total)', value: String(arr.length) });
    out.metrics.push({ name: 'Running now', value: String(running), hint: 'usage-based compute billed while running' });

    // Best-effort balance/usage probe (endpoints vary by plan; never fatal).
    for (const p of ['/account', '/billing', '/usage']) {
      try {
        const br = await fetch(`${RUNLOOP_BASE}${p}`, { headers, timeout: 12000, signal: withTimeout(12000) });
        if (br.ok) {
          const bj = await br.json().catch(() => null);
          const bal = bj && (bj.balance ?? bj.credits ?? bj.credit_balance ?? bj.remaining_credits);
          if (bal != null) { out.balance = `$${round(Number(bal), 2)}`; out.metrics.push({ name: 'Credit balance', value: out.balance }); }
          const pl = bj && (bj.plan || bj.tier || bj.subscription);
          if (pl) { out.plan = String(pl); out.metrics.push({ name: 'Plan', value: out.plan }); }
          if (bal != null || pl) break;
        }
      } catch (_) {}
    }
    out.label = out.balance
      ? `✅ ${arr.length} devbox(es), ${running} running — balance ${out.balance}.`
      : `✅ ${arr.length} devbox(es), ${running} running. (Runloop API exposes no $ balance; track credits at runloop.ai.)`;
    return out;
  } catch (e) {
    out.label = `❌ Could not reach Runloop: ${e.message}`;
    return out;
  }
}

// ── DAYTONA ──────────────────────────────────────────────────────────────────
// Backup sandbox. We report account reachability + active sandbox count.
const DAYTONA_BASE = (process.env.DAYTONA_API_URL || 'https://app.daytona.io/api').replace(/\/+$/, '');

async function daytonaUsage() {
  const key = (await daytonaService.getApiKey().catch(() => '')) || '';
  const out = { ok: false, configured: !!key, label: '', metrics: [], balance: null, plan: null };
  if (!key) { out.label = 'No Daytona API key set.'; return out; }
  const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
  try {
    // Sandbox list (path used by the daytona service's testKey).
    const r = await fetch(`${DAYTONA_BASE}/sandbox`, { headers, timeout: 20000, signal: withTimeout(20000) });
    if (!r.ok) {
      out.label = (r.status === 401 || r.status === 403) ? '❌ Invalid Daytona API key.' : `❌ Daytona API error (HTTP ${r.status}).`;
      return out;
    }
    const d = await r.json().catch(() => ([]));
    const arr = Array.isArray(d) ? d : (Array.isArray(d.items) ? d.items : (Array.isArray(d.sandboxes) ? d.sandboxes : []));
    const running = arr.filter(s => /run|start|active/i.test(String(s.state || s.status || ''))).length;
    out.ok = true;
    out.metrics.push({ name: 'Sandboxes (total)', value: String(arr.length) });
    out.metrics.push({ name: 'Running now', value: String(running) });
    out.label = `✅ Account reachable — ${arr.length} sandbox(es), ${running} running. (Daytona exposes no $ balance via API.)`;
    return out;
  } catch (e) {
    out.label = `❌ Could not reach Daytona: ${e.message}`;
    return out;
  }
}

// ── HOPX ──────────────────────────────────────────────────────────────────────
// Privileged micro-VM sandbox. We report account reachability + active sandbox
// count via the control plane (GET /v1/sandboxes).
const HOPX_BASE = (process.env.HOPX_API_URL || 'https://api.hopx.dev/v1').replace(/\/+$/, '');

async function hopxUsage() {
  const key = (await hopxService.getApiKey().catch(() => '')) || '';
  const out = { ok: false, configured: !!key, label: '', metrics: [], balance: null, plan: null };
  if (!key) { out.label = 'No HopX API key set.'; return out; }
  const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
  try {
    const r = await fetch(`${HOPX_BASE}/sandboxes`, { headers, timeout: 20000, signal: withTimeout(20000) });
    if (!r.ok) {
      out.label = (r.status === 401 || r.status === 403) ? '❌ Invalid HopX API key.' : `❌ HopX API error (HTTP ${r.status}).`;
      return out;
    }
    const d = await r.json().catch(() => ({}));
    const arr = Array.isArray(d) ? d : (Array.isArray(d.data) ? d.data : (Array.isArray(d.sandboxes) ? d.sandboxes : []));
    const running = arr.filter(s => /run|active|start/i.test(String(s.status || s.state || ''))).length;
    out.ok = true;
    out.metrics.push({ name: 'Sandboxes (total)', value: String(arr.length) });
    out.metrics.push({ name: 'Running now', value: String(running), hint: 'usage-based compute billed while running' });
    out.label = `✅ Account reachable — ${arr.length} micro-VM(s), ${running} running. (Track credit at console.hopx.dev.)`;
    return out;
  } catch (e) {
    out.label = `❌ Could not reach HopX: ${e.message}`;
    return out;
  }
}

// ── BROWSERLESS ───────────────────────────────────────────────────────────────
// Cloud Browserless exposes a /usage (units) endpoint on most plans. We try it;
// if the account/plan doesn't expose it we fall back to a connectivity check.
async function browserlessUsage() {
  const key = (await browserlessService.getKey().catch(() => '')) || '';
  const endpoint = browserlessService.ENDPOINT || 'https://production-sfo.browserless.io';
  const out = { ok: false, configured: !!key, label: '', metrics: [], balance: null, plan: null };
  if (!key) { out.label = 'No Browserless API key set.'; return out; }
  try {
    // Browserless v2 usage/units endpoint (varies by deployment; best-effort).
    for (const p of ['/usage', '/metrics/units', '/self/usage']) {
      try {
        const r = await fetch(`${endpoint}${p}?token=${encodeURIComponent(key)}`, { timeout: 15000, signal: withTimeout(15000) });
        if (r.ok) {
          const d = await r.json().catch(() => null);
          if (d && typeof d === 'object') {
            const used = d.used ?? d.unitsUsed ?? d.usage ?? d.consumed;
            const limit = d.limit ?? d.unitLimit ?? d.allowed ?? d.quota;
            if (used != null) out.metrics.push({ name: 'Units used', value: String(used), hint: limit != null ? `of ${limit}` : '' });
            if (limit != null && used != null) {
              const remaining = Number(limit) - Number(used);
              out.metrics.push({ name: 'Units remaining', value: String(remaining) });
              out.balance = `${remaining} units`;
            }
            if (used != null) {
              out.ok = true;
              out.label = `✅ Usage reported — ${used}${limit != null ? ' / ' + limit : ''} units used.`;
              return out;
            }
          }
        }
      } catch (_) {}
    }
    // Fallback: connectivity check (the account is valid even if usage isn't exposed).
    const t = await browserlessService.testKey(key).catch(() => ({ ok: false, message: 'unreachable' }));
    out.ok = !!t.ok;
    out.label = t.ok
      ? '✅ Connected. (This Browserless plan does not expose a unit/usage API — check the Browserless dashboard for balance.)'
      : ('❌ ' + (t.message || 'Browserless unreachable.'));
    return out;
  } catch (e) {
    out.label = `❌ Could not reach Browserless: ${e.message}`;
    return out;
  }
}

// ── WOLFRAM ───────────────────────────────────────────────────────────────────
// WolframAlpha's free AppID = 2000 non-commercial calls/month. They expose no
// usage API, so we report the configured state + the known monthly quota.
async function wolframUsage() {
  const out = { ok: false, configured: false, label: '', metrics: [], balance: null, plan: null };
  try {
    const appid = wolfram && wolfram.getAppId ? await wolfram.getAppId() : '';
    out.configured = !!appid;
    if (!appid) { out.label = 'No WolframAlpha AppID set.'; return out; }
    out.ok = true;
    out.metrics.push({ name: 'Monthly quota', value: '2000', unit: 'calls', hint: 'free non-commercial tier' });
    out.label = '✅ AppID set. Free tier = 2000 calls/month. (Wolfram exposes no live usage API — view counts at developer.wolframalpha.com.)';
    return out;
  } catch (e) {
    out.label = `❌ Wolfram check failed: ${e.message}`;
    return out;
  }
}

// ── aggregate ─────────────────────────────────────────────────────────────────
async function getAllUsage() {
  const fail = e => ({ ok: false, configured: false, label: '❌ ' + e.message, metrics: [], balance: null, plan: null });
  const [render, runloop, daytona, hopx, browserless, wolframR] = await Promise.all([
    renderUsage().catch(fail),
    runloopUsage().catch(fail),
    daytonaUsage().catch(fail),
    hopxUsage().catch(fail),
    browserlessUsage().catch(fail),
    wolframUsage().catch(fail),
  ]);
  return { render, runloop, daytona, hopx, browserless, wolfram: wolframR, fetched_at: new Date().toISOString() };
}

module.exports = {
  getAllUsage,
  renderUsage, runloopUsage, daytonaUsage, hopxUsage, browserlessUsage, wolframUsage,
  getRenderKey, RENDER_BASE,
};
