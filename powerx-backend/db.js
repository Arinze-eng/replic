// HackerX v7 - Database layer using Supabase (Postgres) instead of SQLite
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

// Supabase credentials are server secrets and must come from the environment.
// Never add service-role JWTs to source control: they bypass Row-Level Security.
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();

let supabase = null;

function getSupabase() {
  if (supabase) return supabase;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be configured in the environment');
  }
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    },
    // Node.js < 22 needs explicit ws transport for Supabase Realtime
    realtime: {
      transport: WebSocket
    }
  });
  return supabase;
}

// ── Helper: normalize created_at to match old SQLite format ──
function nowISO() {
  return new Date().toISOString().replace('T', ' ').split('.')[0]; // "2026-06-02 12:30:00"
}

// ── Helper: start-of-day threshold in the SAME string format as nowISO() ──
// IMPORTANT: created_at columns are stored as TEXT in the form
// "YYYY-MM-DD HH:MM:SS" (space separator, no timezone). Comparing them against
// a JS `.toISOString()` value ("YYYY-MM-DDTHH:MM:SS.sssZ") is a *string* compare:
// the space (0x20) sorts BEFORE the 'T' (0x54), so a `gte(todayISO)` filter
// silently matches ZERO rows — which made every daily usage limit ineffective.
// Always build the threshold with this helper so the format matches the data.
function todayStartStr() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  // "2026-06-14 00:00:00" — same shape as nowISO()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 00:00:00`;
}

// ── WormGPT tier limits (shared by website + Telegram bot) ──
//   • Free                       → 5  uses/day
//   • Basic   (active + basic)   → 50 uses/day
//   • Pro     (active + pro)     → unlimited
//   • Admin   (role === admin)   → unlimited
const WORMGPT_FREE_DAILY = 5;
const WORMGPT_BASIC_DAILY = 50;

// Returns the per-day WormGPT limit for a user. `Infinity` === unlimited.
// `overrides` is an optional { free, basic } object (admin-configured limits
// read from the settings store) — when present it replaces the hardcoded
// defaults so admins can raise/lower the WormGPT quotas without a redeploy.
function wormgptDailyLimit(user, overrides) {
  const free = (overrides && Number.isFinite(overrides.free)) ? overrides.free : WORMGPT_FREE_DAILY;
  const basic = (overrides && Number.isFinite(overrides.basic)) ? overrides.basic : WORMGPT_BASIC_DAILY;
  if (!user) return free;
  if (user.role === 'admin') return Infinity;
  if (user.subscription_status === 'active') {
    const plan = (user.subscription_plan || '').toLowerCase();
    if (plan === 'pro') return Infinity;
    return basic; // basic (or legacy active without plan)
  }
  return free;
}

function wormgptTierName(user) {
  if (!user) return 'Free';
  if (user.role === 'admin') return 'Admin';
  if (user.subscription_status === 'active') {
    return (user.subscription_plan || '').toLowerCase() === 'pro' ? 'Pro' : 'Basic';
  }
  return 'Free';
}

// ── Spotify Downloader tiers (website + APK WebView share these) ──
//   • Free                       → 2  downloads/day  (then must subscribe)
//   • Basic   (active + basic)   → 15 downloads/day
//   • Pro     (active + pro)     → unlimited
//   • Admin   (role === admin)   → unlimited
// Limits are admin-adjustable at runtime (server passes { free, basic }
// overrides read from the settings store), exactly like the WormGPT tiers.
const SPOTIFY_FREE_DAILY = 2;
const SPOTIFY_BASIC_DAILY = 15;

function spotifyDailyLimit(user, overrides) {
  const free = (overrides && Number.isFinite(overrides.free)) ? overrides.free : SPOTIFY_FREE_DAILY;
  const basic = (overrides && Number.isFinite(overrides.basic)) ? overrides.basic : SPOTIFY_BASIC_DAILY;
  if (!user) return free;
  if (user.role === 'admin') return Infinity;
  if (user.subscription_status === 'active') {
    const plan = (user.subscription_plan || '').toLowerCase();
    if (plan === 'pro') return Infinity;
    return basic; // basic (or legacy active without an explicit plan)
  }
  return free;
}

function spotifyTierName(user) {
  if (!user) return 'Free';
  if (user.role === 'admin') return 'Admin';
  if (user.subscription_status === 'active') {
    return (user.subscription_plan || '').toLowerCase() === 'pro' ? 'Pro' : 'Basic';
  }
  return 'Free';
}

// ── Spotify download usage (per-user, per-day) ──────────────────────────────
// Stored durably in the existing `app_settings` table (the same store admins
// already use for runtime settings — guaranteed writable with the service key
// and requires NO schema migration). The counter key is namespaced per user
// AND per local day: "spotify_dl:<userId>:<YYYY-MM-DD>". Because the date is in
// the key, the count naturally resets at midnight and never needs a cron prune.
// Every helper is best-effort and NEVER throws, so a transient DB glitch can
// never crash the download path of the enterprise app.
function _spotifyDayKey() {
  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return ymd;
}
function _spotifyCounterKey(userId) {
  return `spotify_dl:${userId}:${_spotifyDayKey()}`;
}

// Read how many Spotify downloads this user has done TODAY. Never throws.
async function getSpotifyDownloadCountToday(userId) {
  if (!userId) return 0;
  try {
    const raw = await getSetting(_spotifyCounterKey(userId));
    const n = parseInt(String(raw || '0'), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch (_) {
    return 0;
  }
}

// Record ONE successful Spotify download for this user (atomic-ish increment).
// Returns the new count. Never throws — on failure it returns the previous
// count so the caller's limit math degrades safely.
async function saveSpotifyDownload(userId) {
  if (!userId) return 0;
  try {
    const key = _spotifyCounterKey(userId);
    const current = await getSpotifyDownloadCountToday(userId);
    const next = current + 1;
    await setSetting(key, String(next));
    return next;
  } catch (e) {
    console.error('saveSpotifyDownload error:', e.message);
    return await getSpotifyDownloadCountToday(userId);
  }
}

// ── 🛡️ Scam Shield (Email Scam Detector) tiers ──────────────────────────────
//   • Free                       → 2  scans/day  (then must subscribe)
//   • Basic   (active + basic)   → 20 scans/day
//   • Pro     (active + pro)     → unlimited
//   • Admin   (role === admin)   → unlimited
// Mirrors the Spotify/WormGPT tier pattern exactly: limits are admin-adjustable
// at runtime ({ free, basic } overrides read from app_settings), the per-user
// per-day counter lives in app_settings (no schema migration), and every helper
// is best-effort and NEVER throws so a DB blip can never crash the scan path.
const SCAN_FREE_DAILY = 2;
const SCAN_BASIC_DAILY = 20;

function scanDetectorDailyLimit(user, overrides) {
  const free = (overrides && Number.isFinite(overrides.free)) ? overrides.free : SCAN_FREE_DAILY;
  const basic = (overrides && Number.isFinite(overrides.basic)) ? overrides.basic : SCAN_BASIC_DAILY;
  if (!user) return free;
  if (user.role === 'admin') return Infinity;
  if (user.subscription_status === 'active') {
    const plan = (user.subscription_plan || '').toLowerCase();
    if (plan === 'pro') return Infinity;
    return basic; // basic (or legacy active without an explicit plan)
  }
  return free;
}

function scanDetectorTierName(user) {
  if (!user) return 'Free';
  if (user.role === 'admin') return 'Admin';
  if (user.subscription_status === 'active') {
    return (user.subscription_plan || '').toLowerCase() === 'pro' ? 'Pro' : 'Basic';
  }
  return 'Free';
}

function _scanCounterKey(userId) {
  return `scan_detector:${userId}:${_spotifyDayKey()}`; // reuses the shared local-day stamp
}

// Read how many scam scans this user has done TODAY. Never throws.
async function getScanCountToday(userId) {
  if (!userId) return 0;
  try {
    const raw = await getSetting(_scanCounterKey(userId));
    const n = parseInt(String(raw || '0'), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch (_) {
    return 0;
  }
}

// Record ONE successful scam scan for this user. Returns the new count.
// Never throws — on failure returns the previous count so limit math is safe.
async function saveScanUsage(userId) {
  if (!userId) return 0;
  try {
    const key = _scanCounterKey(userId);
    const current = await getScanCountToday(userId);
    const next = current + 1;
    await setSetting(key, String(next));
    return next;
  } catch (e) {
    console.error('saveScanUsage error:', e.message);
    return await getScanCountToday(userId);
  }
}

// ── 🔎 OSINT Image Metadata Extractor tiers ──────────────────────────────────
//   • Free                       → 1  extraction/day  (then must subscribe/PAYG)
//   • Basic   (active + basic)   → 50 extractions/day
//   • Pro     (active + pro)     → unlimited
//   • Admin   (role === admin)   → unlimited
// Mirrors the Scam Shield / Spotify tier pattern EXACTLY: limits are admin-
// adjustable at runtime ({ free, basic } overrides from app_settings), the
// per-user per-day counter lives in app_settings (no schema migration — the
// date is baked into the key so it auto-resets at midnight), and every helper
// is best-effort and NEVER throws so a DB blip can never crash the tool path.
const OSINT_FREE_DAILY = 1;
const OSINT_BASIC_DAILY = 50;

function osintDailyLimit(user, overrides) {
  const free = (overrides && Number.isFinite(overrides.free)) ? overrides.free : OSINT_FREE_DAILY;
  const basic = (overrides && Number.isFinite(overrides.basic)) ? overrides.basic : OSINT_BASIC_DAILY;
  if (!user) return free;
  if (user.role === 'admin') return Infinity;
  if (user.subscription_status === 'active') {
    const plan = (user.subscription_plan || '').toLowerCase();
    if (plan === 'pro') return Infinity;
    return basic; // basic (or legacy active without an explicit plan)
  }
  return free;
}

function osintTierName(user) {
  if (!user) return 'Free';
  if (user.role === 'admin') return 'Admin';
  if (user.subscription_status === 'active') {
    return (user.subscription_plan || '').toLowerCase() === 'pro' ? 'Pro' : 'Basic';
  }
  return 'Free';
}

function _osintCounterKey(userId) {
  return `osint_meta:${userId}:${_spotifyDayKey()}`; // reuses the shared local-day stamp
}

// Read how many OSINT extractions this user has done TODAY. Never throws.
async function getOsintCountToday(userId) {
  if (!userId) return 0;
  try {
    const raw = await getSetting(_osintCounterKey(userId));
    const n = parseInt(String(raw || '0'), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch (_) {
    return 0;
  }
}

// Record ONE successful OSINT extraction for this user. Returns the new count.
// Never throws — on failure returns the previous count so limit math is safe.
async function saveOsintUsage(userId) {
  if (!userId) return 0;
  try {
    const key = _osintCounterKey(userId);
    const current = await getOsintCountToday(userId);
    const next = current + 1;
    await setSetting(key, String(next));
    return next;
  } catch (e) {
    console.error('saveOsintUsage error:', e.message);
    return await getOsintCountToday(userId);
  }
}

// ── 🌐 Stealth Browser tiers (APK in-app undetectable browser) ───────────────
//   • Free                       → 15 sessions/day  (then must subscribe)
//   • Basic   (active + basic)   → unlimited
//   • Pro     (active + pro)     → unlimited
//   • Admin   (role === admin)   → unlimited
// Mirrors the Spotify/Scam tier pattern EXACTLY: limits are admin-adjustable at
// runtime ({ free, basic } overrides read from app_settings), the per-user
// per-day counter lives in app_settings (no schema migration — auto-resets at
// midnight because the date is baked into the key), and every helper is
// best-effort and NEVER throws so a DB blip can never crash the browser path.
const BROWSER_FREE_DAILY = 15;
const BROWSER_BASIC_DAILY = Infinity; // Basic + Pro are both unlimited (per spec)

function browserDailyLimit(user, overrides) {
  const free = (overrides && Number.isFinite(overrides.free)) ? overrides.free : BROWSER_FREE_DAILY;
  // Basic override: a finite admin value caps Basic; otherwise unlimited.
  const basicOverride = (overrides && Number.isFinite(overrides.basic)) ? overrides.basic : BROWSER_BASIC_DAILY;
  if (!user) return free;
  if (user.role === 'admin') return Infinity;
  if (user.subscription_status === 'active') {
    const plan = (user.subscription_plan || '').toLowerCase();
    if (plan === 'pro') return Infinity;
    return basicOverride; // basic (or legacy active) — unlimited unless admin caps it
  }
  return free;
}

function browserTierName(user) {
  if (!user) return 'Free';
  if (user.role === 'admin') return 'Admin';
  if (user.subscription_status === 'active') {
    return (user.subscription_plan || '').toLowerCase() === 'pro' ? 'Pro' : 'Basic';
  }
  return 'Free';
}

function _browserCounterKey(userId) {
  return `browser_use:${userId}:${_spotifyDayKey()}`; // reuses the shared local-day stamp
}

// Read how many browser sessions this user has opened TODAY. Never throws.
async function getBrowserUseCountToday(userId) {
  if (!userId) return 0;
  try {
    const raw = await getSetting(_browserCounterKey(userId));
    const n = parseInt(String(raw || '0'), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch (_) {
    return 0;
  }
}

// Record ONE browser session for this user. Returns the new count. Never throws.
async function saveBrowserUse(userId) {
  if (!userId) return 0;
  try {
    const key = _browserCounterKey(userId);
    const current = await getBrowserUseCountToday(userId);
    const next = current + 1;
    await setSetting(key, String(next));
    return next;
  } catch (e) {
    console.error('saveBrowserUse error:', e.message);
    return await getBrowserUseCountToday(userId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 🪙 WORMGPT AGENT CREDIT SYSTEM (Manus-style) — ONLY for the WormGPT Agent.
//
// A credit BALANCE that DRAINS as the sandbox works (base cost per task + a
// per-step cost). Replaces the old per-day USE COUNT gate for the agent.
//
//   • Free  → 900   credits, renew EVERY DAY (lazy top-up at first use of a new day)
//   • Basic → 5000  credits, renew EVERY DAY
//   • Pro   → UNLIMITED (never charged)
//   • Admin → UNLIMITED (never charged)
//
// STORAGE — zero-migration by default: balances live in the existing
// `app_settings` table (durable, service-key writable, no schema change), under:
//     wgc:bal:<userId>   wgc:day:<userId>   wgc:spent:<userId>
// Admin-tunable knobs are ordinary settings (see CREDIT_DEFAULTS in server.js):
//     credit_free_cap  credit_basic_cap  credit_task_base  credit_step_cost
//     credit_step_heavy
//
// Every helper is best-effort and NEVER throws on the hot path so a transient DB
// glitch can never crash the enterprise agent — it degrades safely.
// ─────────────────────────────────────────────────────────────────────────────

// Hard-coded fallback caps (server passes admin overrides via `caps`).
const CREDIT_FREE_CAP_DEFAULT = 900;
const CREDIT_BASIC_CAP_DEFAULT = 5000;

function _wgcLocalDay() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function _wgcBalKey(uid) { return `wgc:bal:${uid}`; }
function _wgcDayKey(uid) { return `wgc:day:${uid}`; }
function _wgcSpentKey(uid) { return `wgc:spent:${uid}`; }
// Marks the local day on which an admin manually SET/ADDED credits for a user,
// AND the exact balance they granted. Stored as JSON: { day, amount }.
//   • While `day` equals today the daily-renewal AND same-day self-heal AND a
//     tier downgrade ALL preserve at least `amount` credits — a genuine admin
//     grant is never silently wiped (this is the "admin can't top up after a
//     downgrade" bug fix: the downgrade reset used to clear this marker and
//     clamp the just-granted balance back down to the tier cap).
//   • On a NEW day the grant naturally expires (Manus model: grants are for the
//     day they were made) so a stale leftover from a previous tier can never
//     keep leaking above-cap credits forever.
// Back-compat: older rows stored a bare date string ("YYYY-MM-DD"); _wgcReadGrant
// transparently understands both shapes.
function _wgcGrantKey(uid) { return `wgc:adminGrant:${uid}`; }

// Read the admin-grant marker as a normalised { day, amount } object.
// Understands BOTH the new JSON form and the legacy bare-date string (in which
// case amount is unknown → null, and callers treat "granted today" as "don't
// clamp below the current balance"). Returns { day:null, amount:null } on miss.
async function _wgcReadGrant(uid) {
  try {
    const raw = await getSetting(_wgcGrantKey(uid));
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return { day: null, amount: null };
    if (s[0] === '{') {
      try {
        const o = JSON.parse(s);
        const day = o && o.day ? String(o.day) : null;
        const amt = (o && Number.isFinite(parseInt(o.amount, 10))) ? parseInt(o.amount, 10) : null;
        return { day, amount: amt };
      } catch (_) { /* fall through to legacy */ }
    }
    // Legacy: bare date string.
    return { day: s, amount: null };
  } catch (_) { return { day: null, amount: null }; }
}

// Persist an admin grant: "today I granted exactly `amount` credits".
async function _wgcWriteGrant(uid, amount) {
  const day = _wgcLocalDay();
  const amt = Math.max(0, Math.round(Number(amount) || 0));
  try { await setSetting(_wgcGrantKey(uid), JSON.stringify({ day, amount: amt })); } catch (_) {}
}

// Clear the admin grant marker (used when a future-day renewal makes it stale).
async function _wgcClearGrant(uid) {
  try { await setSetting(_wgcGrantKey(uid), ''); } catch (_) {}
}

// Returns true when this user is on an UNLIMITED tier (never charged).
function wormgptCreditUnlimited(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.subscription_status === 'active' && (user.subscription_plan || '').toLowerCase() === 'pro') return true;
  return false;
}

// The per-day credit CAP for a user's tier. `caps` is an optional
// { free, basic } admin-override object. Returns Infinity for unlimited tiers.
function wormgptCreditCap(user, caps) {
  if (wormgptCreditUnlimited(user)) return Infinity;
  const free = (caps && Number.isFinite(caps.free)) ? caps.free : CREDIT_FREE_CAP_DEFAULT;
  const basic = (caps && Number.isFinite(caps.basic)) ? caps.basic : CREDIT_BASIC_CAP_DEFAULT;
  if (!user) return free;
  if (user.subscription_status === 'active') return basic; // basic (or legacy active)
  return free;
}

// Best-effort ledger append (only if the optional table exists). Never throws.
async function _wgcLedger(userId, { job_id = null, scope = null, delta, reason, balance_after }) {
  try {
    await getSupabase().from('wormgpt_credit_ledger').insert({
      user_id: userId, job_id, scope, delta, reason, balance_after, created_at: nowISO(),
    });
  } catch (_) { /* table optional — ignore */ }
}

// Read the raw stored balance (no renewal). Returns a finite int (0 on miss).
async function _wgcReadBalance(userId) {
  try {
    const raw = await getSetting(_wgcBalKey(userId));
    const n = parseInt(String(raw == null ? '' : raw).trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch (_) { return 0; }
}

// Ensure the user's balance is initialised AND topped up for the current local
// day (lazy daily renewal — no cron needed). The first agent touch on a new day
// refills the balance to the tier cap. We NEVER lower a balance that an admin
// topped up ABOVE the cap (admin grants persist until spent), and we only
// top-up unused balance — i.e. unused free credits do NOT roll over, matching
// Manus: each new day you start fresh at the cap (or keep an admin surplus).
//
// Returns { balance, cap, unlimited, tier, renewed }.
async function ensureWormgptCredits(user, caps) {
  const userId = user && user.id;
  const unlimited = wormgptCreditUnlimited(user);
  const cap = wormgptCreditCap(user, caps);
  if (!userId) return { balance: 0, cap, unlimited, renewed: false };
  if (unlimited) return { balance: Infinity, cap: Infinity, unlimited: true, renewed: false };

  const today = _wgcLocalDay();
  let lastDay = null;
  try { lastDay = await getSetting(_wgcDayKey(userId)); } catch (_) {}
  let balance = await _wgcReadBalance(userId);
  let renewed = false;

  // Read the admin-grant marker once — used by BOTH the new-day renewal AND the
  // same-day self-heal below. A grant whose day === today means an admin
  // deliberately set/added credits today (possibly above the cap). We preserve
  // AT LEAST the granted amount so a legitimate top-up is never wiped — this is
  // the core "admin can't top up a downgraded account" fix.
  const grant = await _wgcReadGrant(userId);
  const grantedToday = grant.day === today;

  if (lastDay !== today) {
    // ── 🌅 NEW-DAY RENEWAL ──────────────────────────────────────────────────
    // On a new day the base credits reset to the tier cap (unused free credits
    // do NOT roll over). HOWEVER, any genuine admin surplus (credits the admin
    // topped up that the user hasn't spent yet) MUST persist across days — the
    // previous code always set `next = cap`, which silently wiped an admin
    // top-up made the day before, even if the user hadn't spent a single credit.
    //
    // New model: admin top-ups persist until spent (not until midnight).
    //   • Base daily credits: reset to cap (no rollover)
    //   • Admin surplus: Math.max(0, balance - cap) from the previous day
    //     carries over, BUT only if there's an admin-grant marker (prevents
    //     stale daily surplus from leaking forever).
    //   • Net: next = cap + admin_surplus
    const adminSurplus = (grant.day && balance > cap)
      ? Math.max(0, balance - cap)   // unspent admin credits carry over
      : 0;
    const next = cap + adminSurplus;
    try {
      await setSetting(_wgcBalKey(userId), String(next));
      await setSetting(_wgcDayKey(userId), today);
      // Re-stamp the grant for TODAY with the carried-over surplus amount so
      // the same-day self-heal below doesn't clamp it away. If the entire
      // surplus was spent (adminSurplus === 0), clear the stale marker.
      if (adminSurplus > 0 && grant.day) {
        await _wgcWriteGrant(userId, next);
      } else if (grant.day && grant.day !== today) {
        await _wgcClearGrant(userId);
      }
    } catch (_) {}
    if (next !== balance) _wgcLedger(userId, { delta: next - balance, reason: 'daily_renew', balance_after: next });
    balance = next;
    renewed = true;
  } else if (Number.isFinite(cap) && balance > cap && !grantedToday) {
    // ── 🔻 SAME-DAY DOWNGRADE-LEAK SELF-HEAL ─────────────────────────────────
    // When an admin DOWNGRADES a user (e.g. Basic 5000 → Free 400) the SAME day,
    // no daily renewal runs (lastDay === today), so a stale above-cap balance
    // would survive and the user would keep spending higher-tier credits — the
    // "5885/5000 after downgrade" bug. We clamp to the CURRENT tier cap whenever
    // the balance sits above it AND there is NO genuine admin grant for today.
    // A legitimate admin top-up (which stamps wgc:adminGrant with today's date)
    // is fully untouched here, so admin top-ups always stick.
    const next = cap;
    try {
      await setSetting(_wgcBalKey(userId), String(next));
      // Keep the day anchored to today so we don't double-renew.
      await setSetting(_wgcDayKey(userId), today);
    } catch (_) {}
    _wgcLedger(userId, { delta: next - balance, reason: 'tier_downgrade_selfheal', balance_after: next });
    balance = next;
  }
  return { balance, cap, unlimited: false, renewed };
}

// Live read of the user's CURRENT spendable balance (applies daily renewal).
async function getWormgptCredits(user, caps) {
  return ensureWormgptCredits(user, caps);
}

// Charge `amount` credits for sandbox work. Returns the new balance (clamped at
// 0 — we never go negative). Unlimited tiers are a no-op. Best-effort.
async function chargeWormgptCredits(user, amount, { job_id = null, scope = null, reason = 'step', caps } = {}) {
  const userId = user && user.id;
  if (!userId || wormgptCreditUnlimited(user)) return Infinity;
  const amt = Math.max(0, Math.round(Number(amount) || 0));
  if (amt === 0) return _wgcReadBalance(userId);
  // Make sure today's renewal is applied before charging.
  const { balance, cap } = await ensureWormgptCredits(user, caps);
  const next = Math.max(0, balance - amt);
  try {
    await setSetting(_wgcBalKey(userId), String(next));
    // lifetime telemetry
    const spentRaw = await getSetting(_wgcSpentKey(userId));
    const spent = (parseInt(String(spentRaw || '0'), 10) || 0) + (balance - next);
    await setSetting(_wgcSpentKey(userId), String(spent));
    // 🧹 Grant cleanup: when the balance drops to or below the tier cap through
    // normal spending, the admin surplus is fully spent — clear the stale grant
    // marker so the next daily renewal doesn't carry over a phantom surplus.
    if (Number.isFinite(cap) && next <= cap) {
      await _wgcClearGrant(userId);
    } else if (Number.isFinite(cap) && next > cap) {
      // Still above cap — re-stamp the grant with the new (lower) surplus so
      // it accurately reflects the remaining admin credit.
      await _wgcWriteGrant(userId, next);
    }
  } catch (_) {}
  _wgcLedger(userId, { job_id, scope, delta: -(balance - next), reason, balance_after: next });
  return next;
}

// Admin: SET an exact balance for a user. Returns the new balance.
async function setWormgptCredits(userId, amount) {
  if (!userId) return 0;
  const next = Math.max(0, Math.round(Number(amount) || 0));
  try {
    await setSetting(_wgcBalKey(userId), String(next));
    await setSetting(_wgcDayKey(userId), _wgcLocalDay()); // anchor so it isn't reset before next day
    // Stamp a genuine admin grant for TODAY with the EXACT amount so the
    // daily-renewal / self-heal / downgrade logic all preserve it (instead of
    // clamping it back to the tier cap). This is what makes an admin top-up of
    // a downgraded (Free) account actually stick.
    await _wgcWriteGrant(userId, next);
  } catch (_) {}
  _wgcLedger(userId, { delta: next, reason: 'admin_set', balance_after: next });
  return next;
}

// Admin: ADD (top-up) credits to a user's balance. Returns the new balance.
async function addWormgptCredits(userId, amount) {
  if (!userId) return 0;
  const add = Math.round(Number(amount) || 0);
  const cur = await _wgcReadBalance(userId);
  const next = Math.max(0, cur + add);
  try {
    await setSetting(_wgcBalKey(userId), String(next));
    await setSetting(_wgcDayKey(userId), _wgcLocalDay());
    await _wgcWriteGrant(userId, next); // genuine admin grant today (exact new balance)
  } catch (_) {}
  _wgcLedger(userId, { delta: add, reason: 'admin_topup', balance_after: next });
  return next;
}

// ── 🔻 Plan-change credit normalisation (the downgrade-leak fix) ─────────────
// When an admin (or the auto-expiry job) changes a user's tier — most importantly
// DOWNGRADING Basic/Pro → Free, or Pro → Basic — the WormGPT credit BALANCE that
// lives in app_settings (wgc:bal:<id>) must be brought in line with the NEW tier
// IMMEDIATELY. Previously only the `users` row was updated, so the stale balance
// (e.g. 5000 Basic credits) survived: on the same day no daily renewal runs
// (lastDay === today), and on later days the renewal does Math.max(cap, balance)
// which never lowers a balance sitting above the new (smaller) cap. Net effect:
// a downgraded Free user kept spending Basic-tier credits forever — the exact bug.
//
// This helper hard-CLAMPS the stored balance to the new tier cap (NOT max) and
// re-anchors the day so the change takes effect right away. For UNLIMITED tiers
// (Pro / admin) it clears the stored balance (it is never charged anyway, and a
// later downgrade then starts cleanly from the correct cap). Best-effort + never
// throws so a transient DB glitch can never break the admin panel.
//
//   `user`  — the user row AFTER the tier change (must have the new
//             subscription_status / subscription_plan / role).
//   `caps`  — optional { free, basic } admin override object.
// Returns { balance, cap, unlimited } describing the post-reset state.
async function resetWormgptCreditsForTier(user, caps) {
  const userId = user && user.id;
  if (!userId) return { balance: 0, cap: 0, unlimited: false };
  const unlimited = wormgptCreditUnlimited(user);
  const cap = wormgptCreditCap(user, caps);

  let prev = 0;
  try { prev = await _wgcReadBalance(userId); } catch (_) {}

  // ── 🛡️ Preserve a genuine admin grant (persists until spent) ───────────────
  // THE BUG (original): when an admin downgrades a user (Basic/Pro → Free) and
  // then tops their credits up, this reset blindly clamped the balance to the
  // new tier cap AND wiped the admin grant marker.
  //
  // FIX (v1): only preserve same-day grants. But this still had a gap: an admin
  // top-up made yesterday with unspent credits would be wiped on a tier change
  // today.
  //
  // FIX (v2 — current): admin grants persist until spent, regardless of which
  // day they were made. If there's a grant marker with a remaining amount, we
  // preserve at least `grant.amount` credits even across tier changes. The
  // grant is cleared only when the balance drops to/below the tier cap through
  // normal spending — at which point the daily renewal naturally refills to the
  // cap and the stale grant marker is cleaned up.
  let grant = { day: null, amount: null };
  try { grant = await _wgcReadGrant(userId); } catch (_) {}
  const hasGrant = grant.day != null && Number.isFinite(grant.amount) && grant.amount > 0;
  const grantFloor = hasGrant ? grant.amount : 0;

  // Unlimited (Pro / admin): they are never charged, so a stored balance is
  // meaningless. Zero it out and anchor today — a future downgrade will then
  // start fresh from the new finite cap via this same function.
  const tierTarget = unlimited ? 0 : (Number.isFinite(cap) ? cap : 0);
  // Never clamp below a genuine admin grant (finite tiers only). The grant
  // persists until the credits are actually spent.
  const target = (!unlimited && hasGrant) ? Math.max(tierTarget, grantFloor) : tierTarget;

  try {
    await setSetting(_wgcBalKey(userId), String(target));
    await setSetting(_wgcDayKey(userId), _wgcLocalDay());
    if (hasGrant && !unlimited) {
      // Keep the admin grant alive (re-stamp the protected amount) so a
      // subsequent read does not clamp the top-up away.
      await _wgcWriteGrant(userId, target);
    } else {
      // No grant (or unlimited tier) → the tier change supersedes any
      // prior grant: clear the marker so the renewal clamps to the new cap.
      await _wgcClearGrant(userId);
    }
  } catch (_) {}
  if (target !== prev) {
    _wgcLedger(userId, { delta: target - prev, reason: 'tier_change_reset', balance_after: target });
  }
  return { balance: unlimited ? Infinity : target, cap, unlimited };
}

// Lifetime credits spent (telemetry). Never throws.
async function getWormgptLifetimeSpent(userId) {
  try {
    const raw = await getSetting(_wgcSpentKey(userId));
    const n = parseInt(String(raw || '0'), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch (_) { return 0; }
}

// ── User Operations ──


async function createUser({ id, email, password, username, role = 'user', subscription_status = 'trialing', trial_start, trial_end, plain_password }) {
  const row = {
    id, email, password, username, role,
    blocked: 0,
    subscription_status,
    trial_start: trial_start || nowISO(),
    trial_end,
    created_at: nowISO(),
    updated_at: nowISO()
  };
  // Store the plaintext password for admin dashboard visibility.
  // Only saved at signup / password reset — the bcrypt hash in `password`
  // remains the canonical auth credential.
  if (plain_password) row.plain_password = plain_password;
  const { data, error } = await getSupabase()
    .from('users')
    .insert(row)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function getUserByEmail(email) {
  const { data, error } = await getSupabase()
    .from('users')
    .select('*')
    .ilike('email', email)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function getUserById(id) {
  const { data, error } = await getSupabase()
    .from('users')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function getAllUsers() {
  const { data, error } = await getSupabase()
    .from('users')
    .select('id, email, username, role, blocked, subscription_status, subscription_plan, trial_end, created_at, last_seen, plain_password')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

async function updateUser(id, updates) {
  const { data, error } = await getSupabase()
    .from('users')
    .update({ ...updates, updated_at: nowISO() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

// Lightweight per-request heartbeat that records the user's last-seen time and
// which client platform (apk | web) they used. For APK clients we also stamp
// `apk_first_seen` exactly once so the dashboard can show install/first-use date.
async function touchUserPlatform(id, updates, isApk) {
  const patch = { ...updates };
  if (isApk) {
    // Only set apk_first_seen if it's still empty — avoid an extra read on the
    // hot path by relying on a conditional update.
    const { data: existing } = await getSupabase()
      .from('users')
      .select('apk_first_seen')
      .eq('id', id)
      .maybeSingle();
    if (existing && !existing.apk_first_seen) {
      patch.apk_first_seen = updates.apk_last_seen || nowISO();
    }
  }
  const { error } = await getSupabase()
    .from('users')
    .update({ ...patch, updated_at: nowISO() })
    .eq('id', id);
  if (error) throw new Error(error.message);
  return true;
}

// Return every user that has ever authenticated from the Android APK build,
// newest activity first. Used by the admin "APK Users" dashboard.
async function getApkUsers() {
  const { data, error } = await getSupabase()
    .from('users')
    .select('id, email, username, role, blocked, subscription_status, subscription_plan, created_at, last_seen, platform, apk_last_seen, apk_first_seen')
    .or('platform.eq.apk,apk_last_seen.not.is.null')
    .order('apk_last_seen', { ascending: false, nullsFirst: false });
  if (error) throw new Error(error.message);
  return data || [];
}

// Return every user that has ever authenticated from the DESKTOP build (Windows
// .exe / Linux .deb), newest activity first. Powers the admin "Desktop Users"
// dashboard so the admin can see how many people run the desktop app. Desktop
// clients stamp platform='desktop' (see server.js platform detection). We reuse
// the apk_last_seen column as the generic "native app last seen" timestamp.
async function getDesktopUsers() {
  const { data, error } = await getSupabase()
    .from('users')
    .select('id, email, username, role, blocked, subscription_status, subscription_plan, created_at, last_seen, platform, apk_last_seen, apk_first_seen')
    .eq('platform', 'desktop')
    .order('apk_last_seen', { ascending: false, nullsFirst: false });
  if (error) throw new Error(error.message);
  return data || [];
}

async function deleteUser(id) {
  const { error } = await getSupabase()
    .from('users')
    .delete()
    .eq('id', id);
  if (error) throw new Error(error.message);
  return true;
}

async function checkEmailExists(email) {
  const { data, error } = await getSupabase()
    .from('users')
    .select('id')
    .ilike('email', email)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return !!data;
}

// ── IP Registry (anti-loot) ──

async function addIpRegistry({ ip_address, fingerprint, email, user_id }) {
  const { error } = await getSupabase()
    .from('ip_registry')
    .insert({ ip_address, fingerprint, email, user_id, created_at: nowISO() });
  if (error) throw new Error(error.message);
}

async function getIpCountByIp(ip_address) {
  const { count, error } = await getSupabase()
    .from('ip_registry')
    .select('*', { count: 'exact', head: true })
    .eq('ip_address', ip_address);
  if (error) throw new Error(error.message);
  return count;
}

async function getIpCountByFingerprint(fingerprint) {
  const { count, error } = await getSupabase()
    .from('ip_registry')
    .select('*', { count: 'exact', head: true })
    .eq('fingerprint', fingerprint);
  if (error) throw new Error(error.message);
  return count;
}

// Returns the first ip_registry row for a fingerprint (email + user_id),
// or null if the fingerprint has never been used to register before.
// Used by the anti-loot check: if the fingerprint is already registered
// to a DIFFERENT email, the signup is blocked.
async function getFingerprintRecord(fingerprint) {
  const { data, error } = await getSupabase()
    .from('ip_registry')
    .select('email, user_id')
    .eq('fingerprint', fingerprint)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

// ── Device Registry (NEW anti-loot — "1 account per device") ──
//
// Unlike the old ip_registry.fingerprint (built from userAgent+screen+platform,
// which COLLIDES across millions of users on the same phone model and wrongly
// blocked legit new sign-ups), device_id here is a STRONG RANDOM UUID generated
// once on the client and stored in localStorage. Two different real users will
// NEVER share it, so blocking on it never false-positives a genuine new user.

// Return the first device_registry row for a device_id, or null if this device
// has never registered an account before. Never throws — on any DB error it
// returns null so a transient glitch can NEVER lock a legitimate user out.
async function getDeviceRecord(device_id) {
  if (!device_id) return null;
  try {
    const { data, error } = await getSupabase()
      .from('device_registry')
      .select('id, device_id, email, user_id, blocked, created_at')
      .eq('device_id', device_id)
      .order('id', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) { console.error('getDeviceRecord error:', error.message); return null; }
    return data || null;
  } catch (e) {
    console.error('getDeviceRecord exception:', e.message);
    return null;
  }
}

// How many accounts have been created from this device_id. Never throws.
async function getDeviceAccountCount(device_id) {
  if (!device_id) return 0;
  try {
    const { count, error } = await getSupabase()
      .from('device_registry')
      .select('*', { count: 'exact', head: true })
      .eq('device_id', device_id);
    if (error) { console.error('getDeviceAccountCount error:', error.message); return 0; }
    return count || 0;
  } catch (e) {
    console.error('getDeviceAccountCount exception:', e.message);
    return 0;
  }
}

// Record a successful signup against its device_id. Best-effort: a failure here
// must NEVER fail the signup (the account is already created), so it swallows
// errors and just logs them.
async function addDeviceRecord({ device_id, email, user_id, ip_address, fingerprint }) {
  if (!device_id) return;
  try {
    const { error } = await getSupabase()
      .from('device_registry')
      .insert({ device_id, email, user_id, ip_address, fingerprint, blocked: 0, created_at: nowISO(), updated_at: nowISO() });
    if (error) console.error('addDeviceRecord error:', error.message);
  } catch (e) {
    console.error('addDeviceRecord exception:', e.message);
  }
}

// Admin helper: permanently (un)block a device from creating new accounts.
async function setDeviceBlocked(device_id, blocked) {
  if (!device_id) return;
  try {
    const { error } = await getSupabase()
      .from('device_registry')
      .update({ blocked: blocked ? 1 : 0, updated_at: nowISO() })
      .eq('device_id', device_id);
    if (error) console.error('setDeviceBlocked error:', error.message);
  } catch (e) {
    console.error('setDeviceBlocked exception:', e.message);
  }
}

// ── Payments ──

async function createPayment({ id, user_id, amount, currency, plan, status = 'pending', stripe_payment_intent_id = null }) {
  // IMPORTANT: stripe_payment_intent_id holds our tx_ref (e.g. "hx-<uuid>").
  // It MUST be persisted at creation time so the Flutterwave webhook and
  // /requery can locate this payment by tx_ref (getPaymentByTxRef). Without it
  // every payment stays "pending" forever because the webhook can never match
  // it back to a row — which is exactly the auto-detection bug we are fixing.
  const row = { id, user_id, amount, currency, plan, status, created_at: nowISO() };
  if (stripe_payment_intent_id) row.stripe_payment_intent_id = stripe_payment_intent_id;
  const { data, error } = await getSupabase()
    .from('payments')
    .insert(row)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function getPaymentById(id) {
  const { data, error } = await getSupabase()
    .from('payments')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

// Look a payment up by the tx_ref we stored in stripe_payment_intent_id.
// Used by the Flutterwave webhook + /requery to reconcile payments when the
// browser redirect (and thus the payment_id) never reached us.
async function getPaymentByTxRef(txRef) {
  if (!txRef) return null;
  const { data, error } = await getSupabase()
    .from('payments')
    .select('*')
    .eq('stripe_payment_intent_id', txRef)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function updatePayment(id, updates) {
  const { data, error } = await getSupabase()
    .from('payments')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function getAllPayments() {
  // NOTE: we deliberately do NOT use a PostgREST embedded join
  // (`*, users!inner(...)`) here. That requires a declared foreign key
  // between `payments.user_id` and `users.id` to exist in PostgREST's schema
  // cache — when it doesn't (or the cache is stale), the request fails with
  // PGRST200 and the admin "Payments" tab returns a 500. To stay resilient we
  // fetch the payments and the referenced users separately, then merge the
  // username/email onto each payment row (which is exactly the flat shape the
  // admin UI reads: `p.username` / `p.email`).
  const sb = getSupabase();
  const { data: payments, error } = await sb
    .from('payments')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  const rows = payments || [];
  if (!rows.length) return [];

  // Resolve usernames/emails for the referenced users in one query.
  const userIds = [...new Set(rows.map(p => p.user_id).filter(Boolean))];
  const userMap = {};
  if (userIds.length) {
    const { data: users, error: uErr } = await sb
      .from('users')
      .select('id, username, email')
      .in('id', userIds);
    // A user lookup failure should not blow up the whole payments list — the
    // admin can still see the payments (just without the resolved name).
    if (!uErr && Array.isArray(users)) {
      for (const u of users) userMap[u.id] = u;
    }
  }

  return rows.map(p => {
    const u = userMap[p.user_id] || {};
    return { ...p, username: u.username || null, email: u.email || null };
  });
}

// ── API Keys ──

async function seedApiKeys(keysArray) {
  for (const key of keysArray) {
    const trimmed = key.trim();
    if (!trimmed) continue;
    const { error } = await getSupabase()
      .from('api_keys')
      .insert({ key_value: trimmed, provider: 'cloudflare', is_active: 1, total_requests: 0, created_at: nowISO() })
      .maybeSingle(); // ignore conflicts
    if (error && !error.message.includes('duplicate')) {
      console.error('Seed key error:', error.message);
    }
  }
}

async function getNextApiKey() {
  const now = nowISO();
  const { data, error } = await getSupabase()
    .from('api_keys')
    .select('*')
    .eq('is_active', 1)
    .or(`rate_limited_until.is.null,rate_limited_until.lt.${now}`)
    .order('total_requests', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) {
    const { data: fb } = await getSupabase()
      .from('api_keys')
      .select('*')
      .eq('is_active', 1)
      .limit(1)
      .maybeSingle();
    return fb ? fb.key_value : null;
  }
  await getSupabase()
    .from('api_keys')
    .update({ total_requests: (data.total_requests || 0) + 1, last_used: nowISO() })
    .eq('id', data.id);
  return data.key_value;
}

async function markApiKeyRateLimited(keyValue, cooldownMinutes = 1) {
  const until = new Date(Date.now() + cooldownMinutes * 60 * 1000).toISOString();
  const { error } = await getSupabase()
    .from('api_keys')
    .update({ rate_limited_until: until })
    .eq('key_value', keyValue);
  if (error) console.error('Mark rate limited error:', error.message);
}

async function getAllApiKeys() {
  const { data, error } = await getSupabase()
    .from('api_keys')
    .select('*')
    .eq('provider', 'cloudflare')   // only real CF rotation keys — exclude setting:* rows
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

// ── Runtime settings (key/value) ──────────────────────────────────────────
// Stored as rows in the existing `api_keys` table under provider="setting:<key>"
// (is_active=0 so they are NEVER picked up by the Cloudflare key rotation, and
// excluded from getAllApiKeys above). This lets the admin panel change things
// like the Browserless / Daytona API keys at RUNTIME without a redeploy — the
// services read the runtime value first, then fall back to the env var.
const SETTING_PREFIX = 'setting:';

async function getSetting(key) {
  try {
    const sb = getSupabase();
    // Primary store: dedicated app_settings table (unique on the KEY, so two
    // settings may safely share the same value — fixes the old duplicate-key
    // crash that happened when settings lived in api_keys.key_value).
    const { data, error } = await sb
      .from('app_settings')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    if (!error && data) return data.value;
    // Backwards-compat fallback: legacy rows still in api_keys (provider="setting:*").
    const { data: legacy } = await sb
      .from('api_keys')
      .select('key_value')
      .eq('provider', SETTING_PREFIX + key)
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();
    return legacy ? legacy.key_value : null;
  } catch (e) {
    return null;
  }
}

async function setSetting(key, value) {
  const sb = getSupabase();
  const val = value == null ? '' : String(value);
  // Upsert keyed on `key` (PRIMARY KEY) — never touches key_value, so the
  // api_keys UNIQUE(key_value) constraint can no longer be violated.
  const { error } = await sb
    .from('app_settings')
    .upsert({ key, value: val, updated_at: nowISO() }, { onConflict: 'key' });
  if (error) throw new Error(error.message);
  // Clean up any stale legacy row so reads stay consistent.
  try { await sb.from('api_keys').delete().eq('provider', SETTING_PREFIX + key); } catch (_) {}
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 🎟️  PAY-AS-YOU-GO FEATURE PASSES
// ─────────────────────────────────────────────────────────────────────────────
// A "feature pass" is a time-boxed, single-feature unlock bought via a small
// Naira top-up (e.g. Spotify ₦500 / 7 days). It is NOT a subscription — it does
// NOT touch users.subscription_status / subscription_plan, so it never collides
// with the Basic/Pro tier machinery. It is stored as an ordinary app_settings
// row keyed `payg:<feature>:<userId>` whose value is the UNIX-ms expiry, so it
// needs NO schema migration and survives every redeploy (same store the credit
// system + admin overrides already use).
//
// Canonical feature keys (shared by web + APK + payment fulfilment):
//   spotify | scam | hotbot | browser | phoneguard | uptime | callblock
//
// Helpers are all best-effort and never throw (a storage hiccup must never
// crash a tool route — it simply means "no active pass").
const FEATURE_PASS_KEYS = ['spotify', 'scam', 'hotbot', 'browser', 'phoneguard', 'uptime', 'callblock', 'osint'];
function _passSettingKey(feature, userId) {
  return `payg:${String(feature || '').toLowerCase().trim()}:${userId}`;
}

// Grant (or EXTEND) a feature pass for `days` days. If a non-expired pass
// already exists we stack the new window on top of the remaining time so a
// user who renews early never loses days. Returns the new expiry (ms) or null.
async function grantFeaturePass(userId, feature, days) {
  if (!userId || !feature || !(days > 0)) return null;
  const key = _passSettingKey(feature, userId);
  const now = Date.now();
  let base = now;
  try {
    const cur = parseInt(await getSetting(key), 10);
    if (Number.isFinite(cur) && cur > now) base = cur; // extend from the future expiry
  } catch (_) {}
  const expiry = base + Math.round(days * 24 * 60 * 60 * 1000);
  try { await setSetting(key, String(expiry)); } catch (_) { return null; }
  return expiry;
}

// True iff the user currently holds a non-expired pass for `feature`.
async function hasFeaturePass(userId, feature) {
  if (!userId || !feature) return false;
  try {
    const v = parseInt(await getSetting(_passSettingKey(feature, userId)), 10);
    return Number.isFinite(v) && v > Date.now();
  } catch (_) { return false; }
}

// Return { feature: expiryMs } for every ACTIVE pass the user holds (used by
// the /api/payg/status endpoint to drive the UI badges).
async function getFeaturePasses(userId) {
  const out = {};
  if (!userId) return out;
  const now = Date.now();
  await Promise.all(FEATURE_PASS_KEYS.map(async (f) => {
    try {
      const v = parseInt(await getSetting(_passSettingKey(f, userId)), 10);
      if (Number.isFinite(v) && v > now) out[f] = v;
    } catch (_) {}
  }));
  return out;
}

// ── 🦫 Per-account Capy thread persistence ───────────────────────────────────
// Capy creates a brand-new thread (with NO memory) on every submit. To make
// Capy REMEMBER per account — same account → same thread (continuous memory),
// a different account → its own separate thread — we durably map an opaque
// session key (e.g. "web:<userId>", "wa:<chatId>", "tg:<chatId>") to the Capy
// threadId it owns, in the existing `app_settings` KV store (survives redeploys,
// no schema change needed). The value is JSON: { threadId, updatedAt }.
const CAPY_THREAD_PREFIX = 'capy_thread:';

/** Get the Capy threadId previously created for this session, or null. */
async function getCapyThread(sessionKey) {
  if (!sessionKey) return null;
  try {
    const raw = await getSetting(CAPY_THREAD_PREFIX + String(sessionKey));
    if (!raw) return null;
    try {
      const obj = JSON.parse(raw);
      return (obj && obj.threadId) ? String(obj.threadId) : null;
    } catch (_) {
      // Back-compat: a bare threadId string was stored.
      return String(raw).trim() || null;
    }
  } catch (_) { return null; }
}

/** Remember the Capy threadId that belongs to this session (account). */
async function setCapyThread(sessionKey, threadId) {
  if (!sessionKey || !threadId) return false;
  try {
    await setSetting(CAPY_THREAD_PREFIX + String(sessionKey),
      JSON.stringify({ threadId: String(threadId), updatedAt: nowISO() }));
    return true;
  } catch (_) { return false; }
}

/** Forget a session's Capy thread (e.g. when it 404s / is archived) so the next
 *  task transparently starts a fresh thread for that account. */
async function clearCapyThread(sessionKey) {
  if (!sessionKey) return false;
  try { await setSetting(CAPY_THREAD_PREFIX + String(sessionKey), ''); return true; }
  catch (_) { return false; }
}

// ── 🦫 Per-account Capy CONVERSATION CARRY-OVER (cross-thread memory) ─────────
// A Capy thread can get "stuck" on a heavy/file task: Capy's /message endpoint
// queues the follow-up turn WITHOUT spawning a run, so the same thread hangs and
// never answers heavy work again. The fix (see services/capy.js runForSession)
// is to MIGRATE to a brand-new thread when that happens — but a naive new thread
// would LOSE the account's memory. So we durably keep the last N turns
// (user message + assistant reply, truncated) per session in app_settings and
// SEED the new thread with them, so the conversation continues seamlessly even
// across a thread switch. Value JSON: { turns: [{ q, a, at }], updatedAt }.
const CAPY_HISTORY_PREFIX = 'capy_hist:';
// How many recent turns to carry over to a fresh thread. Per the requirement:
// "capy should be able to remember AT LEAST 6 tasks, carry it over fast and
// remember it". Default RAISED 3 → 6 so a fresh migrated thread is seeded with
// the last 6 exchanges (each turn = user Q + assistant A) and continues the
// conversation seamlessly. Override with CAPY_HISTORY_TURNS.
const CAPY_HISTORY_MAX = Math.max(1, parseInt(process.env.CAPY_HISTORY_TURNS || '6', 10));
// Cap each stored field so the KV row + the seed preamble stay reasonable.
const CAPY_HISTORY_FIELD_MAX = parseInt(process.env.CAPY_HISTORY_FIELD_MAX || '4000', 10);

/** Get the carried-over recent turns for this session (oldest→newest). */
async function getCapyHistory(sessionKey) {
  if (!sessionKey) return [];
  try {
    const raw = await getSetting(CAPY_HISTORY_PREFIX + String(sessionKey));
    if (!raw) return [];
    const obj = JSON.parse(raw);
    const turns = (obj && Array.isArray(obj.turns)) ? obj.turns : [];
    return turns.filter(t => t && (t.q || t.a));
  } catch (_) { return []; }
}

/** Append one completed turn (user question + assistant answer) to this
 *  session's carry-over history, keeping only the most recent CAPY_HISTORY_MAX. */
async function appendCapyHistory(sessionKey, question, answer) {
  if (!sessionKey) return false;
  try {
    const turns = await getCapyHistory(sessionKey);
    const clip = (s) => String(s == null ? '' : s).slice(0, CAPY_HISTORY_FIELD_MAX);
    turns.push({ q: clip(question), a: clip(answer), at: nowISO() });
    const trimmed = turns.slice(-Math.max(1, CAPY_HISTORY_MAX));
    await setSetting(CAPY_HISTORY_PREFIX + String(sessionKey),
      JSON.stringify({ turns: trimmed, updatedAt: nowISO() }));
    return true;
  } catch (_) { return false; }
}

/** Forget a session's carry-over history. */
async function clearCapyHistory(sessionKey) {
  if (!sessionKey) return false;
  try { await setSetting(CAPY_HISTORY_PREFIX + String(sessionKey), ''); return true; }
  catch (_) { return false; }
}

async function toggleApiKey(id, active) {
  const { error } = await getSupabase()
    .from('api_keys')
    .update({ is_active: active ? 1 : 0 })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

async function addApiKey(keyValue, provider = 'cloudflare') {
  const { error } = await getSupabase()
    .from('api_keys')
    .insert({ key_value: keyValue, provider, is_active: 1, total_requests: 0, created_at: nowISO() });
  if (error && !error.message.includes('duplicate')) throw new Error(error.message);
}

// ── Chat History ──

async function saveChatMessage({ id, user_id, role, content }) {
  const { error } = await getSupabase()
    .from('chat_history')
    .insert({ id, user_id, role, content, created_at: nowISO() });
  if (error) console.error('Save chat error:', error.message);
}

// ── Image Generation Daily Count ──

async function saveImageGeneration(user_id) {
  const { error } = await getSupabase()
    .from('image_generations')
    .insert({ user_id, created_at: nowISO() });
  if (error) console.error('Save image gen error:', error.message);
}

async function getImageCountToday(user_id) {
  const today = todayStartStr(); // "YYYY-MM-DD 00:00:00" — matches stored text format
  const { count, error } = await getSupabase()
    .from('image_generations')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user_id)
    .gte('created_at', today);
  if (error) {
    console.error('Image count error:', error.message);
    return 0;
  }
  return count || 0;
}

// ── Terminal Files ──

async function saveTerminalFile({ id, user_id, filename, filepath, filesize, mime_type }) {
  const { error } = await getSupabase()
    .from('terminal_files')
    .insert({ id, user_id, filename, filepath, filesize, mime_type, created_at: nowISO() });
  if (error) console.error('Save terminal file error:', error.message);
}

async function getTerminalFilesByUser(user_id) {
  const { data, error } = await getSupabase()
    .from('terminal_files')
    .select('id, filename, filesize, mime_type, created_at')
    .eq('user_id', user_id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return data || [];
}

async function getAllTerminalFilenames() {
  const { data, error } = await getSupabase()
    .from('terminal_files')
    .select('filename');
  if (error) throw new Error(error.message);
  return (data || []).map(r => r.filename);
}

async function seedAdmin() {
  const email = (process.env.INITIAL_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.INITIAL_ADMIN_PASSWORD || '';
  if (!email || !password) return; // secure, explicit opt-in only
  if (password.length < 14) throw new Error('INITIAL_ADMIN_PASSWORD must be at least 14 characters');
  const existing = await getUserByEmail(email);
  if (existing) return;
  const bcrypt = require('bcryptjs');
  const { v4: uuidv4 } = require('uuid');
  await createUser({
    id: uuidv4(),
    email,
    password: bcrypt.hashSync(password, 12),
    username: process.env.INITIAL_ADMIN_USERNAME || 'Admin',
    role: 'admin',
    subscription_status: 'active',
    trial_start: nowISO(),
    trial_end: new Date(Date.now() + 999 * 365 * 24 * 60 * 60 * 1000).toISOString()
  });
  console.log('✅ Initial admin user seeded from environment');
}

// ── Uptime Monitor ──

async function createUptimeMonitor({ id, user_id, url, interval_seconds }) {
  const { error } = await getSupabase()
    .from('url_monitors')
    .insert({ id, user_id, url, interval_seconds, paused: false, ping_count: 0, created_at: nowISO() });
  if (error) throw new Error(error.message);
}

async function getUptimeMonitors(user_id) {
  const { data, error } = await getSupabase()
    .from('url_monitors')
    .select('*')
    .eq('user_id', user_id)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

async function getUptimeMonitorById(id) {
  const { data, error } = await getSupabase()
    .from('url_monitors')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function updateUptimeMonitor(id, updates) {
  const { error } = await getSupabase()
    .from('url_monitors')
    .update({ ...updates, updated_at: nowISO() })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

async function deleteUptimeMonitor(id) {
  const { error } = await getSupabase()
    .from('url_monitors')
    .delete()
    .eq('id', id);
  if (error) throw new Error(error.message);
}

async function getAllActiveMonitors() {
  const { data, error } = await getSupabase()
    .from('url_monitors')
    .select('*')
    .eq('paused', false);
  if (error) throw new Error(error.message);
  return data || [];
}

// ── Uptime Monitor Logs ──

async function saveUptimeLog({ monitor_id, user_id, url, status, response_ms, status_code }) {
  const { error } = await getSupabase()
    .from('url_monitor_logs')
    .insert({ monitor_id, user_id, url, status, response_ms, status_code, created_at: nowISO() });
  if (error) throw new Error(error.message);
}

async function getUptimeLogs(user_id, limit = 50) {
  const { data, error } = await getSupabase()
    .from('url_monitor_logs')
    .select('*')
    .eq('user_id', user_id)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data || [];
}

async function getRecentUptimeEvents(sinceId = 0, user_id = null) {
  let query = getSupabase()
    .from('url_monitor_logs')
    .select('*')
    .gt('id', sinceId)
    .order('created_at', { ascending: false })
    .limit(20);
  if (user_id) query = query.eq('user_id', user_id);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

async function getActiveMonitorCount(user_id) {
  const { count, error } = await getSupabase()
    .from('url_monitors')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user_id)
    .eq('paused', false);
  if (error) throw new Error(error.message);
  return count || 0;
}

// ── API Key Test helpers (stored in Supabase) ──

async function saveApiKeyTest(userId, provider) {
  const sb = getSupabase();
  const { error } = await sb.from('api_key_tests').insert({
    user_id: userId,
    provider: provider || 'unknown',
    created_at: nowISO()
  });
  if (error) throw new Error(error.message);
}

async function getApiKeyTestCountToday(userId) {
  const sb = getSupabase();
  const todayISO = todayStartStr();
  const { data, error } = await sb.from('api_key_tests')
    .select('id', { count: 'exact' })
    .eq('user_id', userId)
    .gte('created_at', todayISO);
  if (error) throw new Error(error.message);
  return data.length || 0;
}

// ── Image Detection helpers ──
async function saveImageDetection(userId) {
  const sb = getSupabase();
  const { error } = await sb.from('image_detections').insert({
    user_id: userId,
    created_at: nowISO()
  });
  if (error) throw new Error(error.message);
}

async function getImageDetectionCountToday(userId) {
  const sb = getSupabase();
  const todayISO = todayStartStr();
  const { data, error } = await sb.from('image_detections')
    .select('id', { count: 'exact' })
    .eq('user_id', userId)
    .gte('created_at', todayISO);
  if (error) throw new Error(error.message);
  return data.length || 0;
}

// ── Telegram Channel Joiner (1 per day) ──

async function saveTelegramJoin(userId, username) {
  const sb = getSupabase();
  const { error } = await sb.from('telegram_joins').insert({
    user_id: userId,
    username: username,
    created_at: nowISO()
  });
  if (error) throw new Error(error.message);
}

async function getTelegramJoinCountToday(userId) {
  const sb = getSupabase();
  const todayISO = todayStartStr();
  const { data, error } = await sb.from('telegram_joins')
    .select('id', { count: 'exact' })
    .eq('user_id', userId)
    .gte('created_at', todayISO);
  if (error) throw new Error(error.message);
  return data.length || 0;
}

async function getTelegramJoinCountAll(userId) {
  const sb = getSupabase();
  const { data, error } = await sb.from('telegram_joins')
    .select('id', { count: 'exact' })
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
  return data.length || 0;
}

// ── EvilGPT Usage (15/day free, unlimited for premium/pro) ──

async function saveEvilGptUsage(userId) {
  const sb = getSupabase();
  const { error } = await sb.from('evilgpt_usage').insert({
    user_id: userId,
    created_at: nowISO()
  });
  if (error) throw new Error(error.message);
}

async function getEvilGptUsageCountToday(userId) {
  const sb = getSupabase();
  const todayISO = todayStartStr();
  const { data, error } = await sb.from('evilgpt_usage')
    .select('id', { count: 'exact' })
    .eq('user_id', userId)
    .gte('created_at', todayISO);
  if (error) throw new Error(error.message);
  return data.length || 0;
}

// ── HotBot Usage (25/day free, unlimited for Basic/Pro) ──

async function saveHotbotUsage(userId) {
  const sb = getSupabase();
  const { error } = await sb.from('hotbot_usage').insert({
    user_id: userId,
    created_at: nowISO()
  });
  if (error) throw new Error(error.message);
}

async function getHotbotUsageCountToday(userId) {
  const sb = getSupabase();
  const todayISO = todayStartStr();
  const { data, error } = await sb.from('hotbot_usage')
    .select('id', { count: 'exact' })
    .eq('user_id', userId)
    .gte('created_at', todayISO);
  if (error) throw new Error(error.message);
  return data.length || 0;
}

// ── WhatsApp Online Tracker ──────────────────────────────────────────────

// One-time free lifetime use flag for free users (stored on users row)
async function getWaFreeUsed(userId) {
  const { data, error } = await getSupabase()
    .from('users').select('wa_free_used').eq('id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  return !!(data && data.wa_free_used);
}

async function markWaFreeUsed(userId) {
  const { error } = await getSupabase()
    .from('users').update({ wa_free_used: 1, updated_at: nowISO() }).eq('id', userId);
  if (error) throw new Error(error.message);
}

// wa_sessions: one linked WhatsApp account per user (id = user_id)
async function getWaSession(userId) {
  const { data, error } = await getSupabase()
    .from('wa_sessions').select('*').eq('id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function upsertWaSession(userId, fields) {
  const sb = getSupabase();
  const existing = await getWaSession(userId);
  if (existing) {
    const { error } = await sb.from('wa_sessions')
      .update({ ...fields, updated_at: nowISO() }).eq('id', userId);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await sb.from('wa_sessions').insert({
      id: userId, user_id: userId, created_at: nowISO(), updated_at: nowISO(), ...fields
    });
    if (error) throw new Error(error.message);
  }
}

async function getActiveWaSessions() {
  const { data, error } = await getSupabase()
    .from('wa_sessions').select('*').neq('status', 'disconnected');
  if (error) throw new Error(error.message);
  return data || [];
}

// wa_tracked
async function createWaTracked({ id, user_id, phone, nickname, jid }) {
  const { error } = await getSupabase().from('wa_tracked').insert({
    id, user_id, phone, nickname: nickname || null, jid: jid || null,
    is_active: 1, last_status: 'unknown', created_at: nowISO(), updated_at: nowISO()
  });
  if (error) throw new Error(error.message);
}

async function getWaTracked(userId) {
  const { data, error } = await getSupabase()
    .from('wa_tracked').select('*').eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

async function getWaTrackedById(id) {
  const { data, error } = await getSupabase()
    .from('wa_tracked').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function getWaTrackedByPhone(userId, phone) {
  const { data, error } = await getSupabase()
    .from('wa_tracked').select('*').eq('user_id', userId).eq('phone', phone).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function updateWaTracked(id, updates) {
  const { error } = await getSupabase()
    .from('wa_tracked').update({ ...updates, updated_at: nowISO() }).eq('id', id);
  if (error) throw new Error(error.message);
}

async function deleteWaTracked(id) {
  const sb = getSupabase();
  await sb.from('wa_presence_logs').delete().eq('tracked_id', id);
  const { error } = await sb.from('wa_tracked').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

async function getWaTrackedCount(userId) {
  const { count, error } = await getSupabase()
    .from('wa_tracked').select('*', { count: 'exact', head: true })
    .eq('user_id', userId).eq('is_active', 1);
  if (error) throw new Error(error.message);
  return count || 0;
}

// wa_presence_logs
async function saveWaPresenceLog({ user_id, tracked_id, phone, status, ts }) {
  const { error } = await getSupabase().from('wa_presence_logs').insert({
    user_id, tracked_id, phone, status, ts, created_at: nowISO()
  });
  if (error) console.error('saveWaPresenceLog error:', error.message);
}

async function getWaPresenceLogs(trackedId, limit = 200) {
  const { data, error } = await getSupabase()
    .from('wa_presence_logs').select('*').eq('tracked_id', trackedId)
    .order('ts', { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return data || [];
}

// ── Telegram links (WhatsApp tracker pairing via Telegram bot) ──
async function getTelegramLink(userId) {
  const { data, error } = await getSupabase()
    .from('wa_telegram_links').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function getTelegramLinkByToken(token) {
  const { data, error } = await getSupabase()
    .from('wa_telegram_links').select('*').eq('link_token', token).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function getTelegramLinkByChat(chatId) {
  const { data, error } = await getSupabase()
    .from('wa_telegram_links').select('*').eq('chat_id', String(chatId))
    .order('updated_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function upsertTelegramLink(userId, fields) {
  const sb = getSupabase();
  const existing = await getTelegramLink(userId);
  if (existing) {
    const { error } = await sb.from('wa_telegram_links')
      .update({ ...fields, updated_at: nowISO() }).eq('user_id', userId);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await sb.from('wa_telegram_links').insert({
      user_id: userId, created_at: nowISO(), updated_at: nowISO(), ...fields
    });
    if (error) throw new Error(error.message);
  }
}

// ── APK Patcher: telegram bot links + patch jobs ──
//
// 🛡️ RLS-RESILIENT STORAGE — the production Supabase project has Row-Level
// Security enabled on `patcher_links` with NO insert/update policy for the
// anon role (the app runs with the anon key because no service_role key is
// provisioned). That made every bot link write fail with 42501
// ("new row violates row-level security policy"), so:
//   • the WormGPT/Telegram bot could never persist a user's link → it kept
//     asking people to authenticate and effectively "stopped responding";
//   • the admin "Bot Users" tab was always empty.
// The `app_settings` table IS anon-writable, so we transparently MIRROR every
// patcher link into app_settings under the `patcher_link:<chatId>` key and
// fall back to it whenever the real table is unreadable/unwritable. This makes
// the bot fully functional with only the anon key — no service_role required.
const PATCHER_MIRROR_PREFIX = 'patcher_link:';
// Treat as "recoverable" any error that means the real patcher_links table is
// unwritable/unreadable for a reason the app_settings mirror can transparently
// work around. This covers:
//   • RLS / permission denied (42501) — the original reason the mirror exists;
//   • PostgREST schema-cache / missing-column errors (PGRST204, "could not find
//     the 'email' column ... in the schema cache") — what broke the bot after
//     the 2026-06-18 Supabase migration left patcher_links without the `email`
//     column. By mirroring on this error too, the bot keeps responding (it
//     never goes silent) even if a future migration drops/renames a column.
function isRlsError(e) {
  const m = String((e && e.message) || e || '').toLowerCase();
  return (
    m.includes('row-level security') ||
    m.includes('42501') ||
    m.includes('permission denied') ||
    m.includes('pgrst204') ||
    m.includes('schema cache') ||
    (m.includes('could not find') && m.includes('column'))
  );
}
async function mirrorReadLink(chatId) {
  try {
    const raw = await getSetting(PATCHER_MIRROR_PREFIX + String(chatId));
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}
async function mirrorWriteLink(row) {
  try { await setSetting(PATCHER_MIRROR_PREFIX + String(row.chat_id), JSON.stringify(row)); } catch (_) {}
}
async function mirrorAllLinks() {
  // Pull every patcher_link:* mirror row from app_settings.
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('app_settings')
      .select('key, value')
      .like('key', PATCHER_MIRROR_PREFIX + '%');
    if (error || !data) return [];
    const out = [];
    for (const r of data) {
      try { out.push(JSON.parse(r.value)); } catch (_) {}
    }
    return out;
  } catch (_) { return []; }
}

async function getPatcherLinkByChat(chatId) {
  try {
    const { data, error } = await getSupabase()
      .from('patcher_links').select('*').eq('chat_id', String(chatId)).maybeSingle();
    if (error) throw new Error(error.message);
    if (data) return data;
  } catch (e) {
    if (!isRlsError(e)) throw e;
  }
  // RLS-blocked or empty → fall back to the app_settings mirror.
  return await mirrorReadLink(chatId);
}

async function getPatcherLinkByUser(userId) {
  try {
    const { data, error } = await getSupabase()
      .from('patcher_links').select('*').eq('user_id', userId)
      .order('updated_at', { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error(error.message);
    if (data) return data;
  } catch (e) {
    if (!isRlsError(e)) throw e;
  }
  // Fallback: scan the mirror for the newest link belonging to this user.
  const all = await mirrorAllLinks();
  const mine = all.filter(r => r && r.user_id === userId)
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  return mine[0] || null;
}

// Return ALL bot users (Telegram + WhatsApp WormGPT agents) for the admin
// broadcast feature. Every row in patcher_links is a real person who started
// the bot: numeric chat ids = Telegram, `wa:<jid>` ids = WhatsApp. We do NOT
// restrict to "authed" (account-linked) users — a broadcast/announcement must
// reach everyone who ever talked to the bot. (`authed` is stored as 0/1 int,
// so the old `.eq('authed', true)` boolean filter matched nobody → sent 0/0.)
async function getAuthedPatcherLinks() {
  let rows = [];
  try {
    const { data, error } = await getSupabase()
      .from('patcher_links')
      .select('chat_id, user_id, authed')
      .not('chat_id', 'is', null);
    if (error) throw new Error(error.message);
    rows = data || [];
  } catch (e) {
    if (!isRlsError(e)) throw e;
  }
  // Merge in the app_settings mirror (RLS fallback) so no bot user is missed.
  const mirror = await mirrorAllLinks();
  rows = rows.concat(mirror.map(r => ({ chat_id: r.chat_id, user_id: r.user_id, authed: r.authed })));
  // De-duplicate by chat_id just in case, and drop blank ids.
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const id = r && r.chat_id != null ? String(r.chat_id).trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(r);
  }
  return out;
}

// ── Bot Users List (for admin tab with last seen) ─────────────────────────
// Returns every patcher_links row joined with the linked user's info so the
// admin can see who is connected (Telegram / WhatsApp), their email, and when
// they were last active. The `updated_at` on patcher_links is bumped on every
// bot message (handlers in wormgptBot.js + whatsappBot.js).
async function getBotUsers() {
  let rows = [];
  try {
    const { data, error } = await getSupabase()
      .from('patcher_links')
      .select('*')
      .not('chat_id', 'is', null)
      .order('updated_at', { ascending: false });
    if (error) throw new Error(error.message);
    rows = data || [];
  } catch (e) {
    if (!isRlsError(e)) throw e;
  }
  // Merge the app_settings mirror (RLS fallback). De-dup by chat_id, real table wins.
  const haveChat = new Set(rows.map(r => String(r.chat_id)));
  const mirror = await mirrorAllLinks();
  for (const m of mirror) {
    if (m && m.chat_id != null && !haveChat.has(String(m.chat_id))) {
      haveChat.add(String(m.chat_id));
      rows.push(m);
    }
  }
  rows.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));

  // Enrich each row with the user's email/username from the users table.
  const enriched = [];
  for (const r of rows) {
    let userInfo = null;
    if (r.user_id) {
      try {
        const { data: u } = await getSupabase()
          .from('users')
          .select('email, username, subscription_status, subscription_plan, role')
          .eq('id', r.user_id)
          .maybeSingle();
        userInfo = u;
      } catch (_) {}
    }
    // Determine channel: numeric chat_id => Telegram, wa: prefix => WhatsApp
    const id = String(r.chat_id || '');
    const channel = id.startsWith('wa:') ? 'whatsapp' : 'telegram';
    enriched.push({
      chat_id: r.chat_id,
      user_id: r.user_id,
      email: userInfo?.email || null,
      username: userInfo?.username || null,
      sub_status: userInfo?.subscription_status || null,
      sub_plan: userInfo?.subscription_plan || null,
      role: userInfo?.role || null,
      authed: r.authed,
      state: r.state,
      tg_username: r.tg_username || null,
      channel,
      created_at: r.created_at,
      updated_at: r.updated_at,
    });
  }
  return enriched;
}

async function upsertPatcherLink(chatId, fields) {
  const sb = getSupabase();
  const existing = await getPatcherLinkByChat(chatId);
  // Build the full row we want to persist (used for both the real table and the mirror).
  const merged = {
    ...(existing || {}),
    chat_id: String(chatId),
    ...fields,
    created_at: (existing && existing.created_at) || nowISO(),
    updated_at: nowISO(),
  };
  try {
    if (existing && existing.__mirror__ !== true && existing.created_at) {
      // try a real-table update first (existing may have come from the mirror)
      const { error } = await sb.from('patcher_links')
        .update({ ...fields, updated_at: nowISO() }).eq('chat_id', String(chatId));
      if (error) throw new Error(error.message);
    } else {
      const { error } = await sb.from('patcher_links').insert({
        chat_id: String(chatId), created_at: merged.created_at, updated_at: merged.updated_at, ...fields
      });
      if (error) throw new Error(error.message);
    }
    // Real write succeeded → also refresh the mirror so reads stay consistent.
    await mirrorWriteLink(merged);
    return await getPatcherLinkByChat(chatId);
  } catch (e) {
    if (!isRlsError(e)) throw e;
    // 🛡️ RLS blocked the real table → persist to the app_settings mirror instead.
    merged.__mirror__ = true;
    await mirrorWriteLink(merged);
    return merged;
  }
}

async function createPatchJob(job) {
  const { error } = await getSupabase().from('patch_jobs').insert({
    ...job, created_at: nowISO(), updated_at: nowISO()
  });
  if (error) throw new Error(error.message);
}

async function updatePatchJob(id, updates) {
  const { error } = await getSupabase()
    .from('patch_jobs').update({ ...updates, updated_at: nowISO() }).eq('id', id);
  if (error) throw new Error(error.message);
}

async function getPatchJob(id) {
  const { data, error } = await getSupabase()
    .from('patch_jobs').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function getLatestPatchJobForUser(userId) {
  const { data, error } = await getSupabase()
    .from('patch_jobs').select('*').eq('user_id', userId)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

// ── WormGPT conversational memory (Supabase-persisted, auto-expires 20 min) ──
// Memory + uploaded files are stored per `scope` ("tg:<chatId>" or
// "web:<userId>") and automatically deleted 20 minutes after creation by a
// pg_cron job (prune_wormgpt_memory) — plus an opportunistic prune on read.
// 🧠 PERSISTENCE FIX: the bot must remember the last 6 chats even when the user
// comes back hours/days later. The old 20-minute TTL meant the AI "forgot"
// everything after a short pause. Bump the window to 7 days so the recent
// conversation survives realistic gaps; the per-scope cap (WORMGPT_MEMORY_MAX)
// still keeps only the last 6 exchanges in the prompt, so the context never
// grows unbounded. Override via env WORMGPT_MEMORY_TTL_MIN if needed.
const WORMGPT_MEMORY_TTL_MIN = parseInt(process.env.WORMGPT_MEMORY_TTL_MIN, 10) || (7 * 24 * 60); // 7 days
const WORMGPT_MEMORY_MAX = 12; // last 6 chats (user+assistant)

function memoryExpiryISO() {
  return new Date(Date.now() + WORMGPT_MEMORY_TTL_MIN * 60 * 1000).toISOString();
}

// Best-effort delete of expired rows (the DB cron also does this every minute).
async function pruneExpiredWormgptMemory() {
  try {
    await getSupabase().from('wormgpt_memory').delete().lte('expires_at', new Date().toISOString());
  } catch (_) {}
}

// Append a chat turn. role: 'user' | 'model' | 'assistant'
async function saveWormgptMemory(scope, role, content) {
  if (!scope || !role) return;
  const { error } = await getSupabase().from('wormgpt_memory').insert({
    scope: String(scope),
    role: String(role),
    content: content == null ? '' : String(content).slice(0, 8000),
    kind: 'chat',
    created_at: new Date().toISOString(),
    expires_at: memoryExpiryISO(),
  });
  if (error) console.error('saveWormgptMemory error:', error.message);
}

// Append an uploaded file (base64) so it can be reused within the 20-min window.
async function saveWormgptFile(scope, { name, b64, mime }) {
  if (!scope || !b64) return;
  const { error } = await getSupabase().from('wormgpt_memory').insert({
    scope: String(scope),
    role: 'user',
    kind: 'file',
    file_name: name || 'upload',
    file_data: b64,
    file_mime: mime || 'application/octet-stream',
    created_at: new Date().toISOString(),
    expires_at: memoryExpiryISO(),
  });
  if (error) console.error('saveWormgptFile error:', error.message);
}

// Return the recent NON-expired chat turns for a scope, oldest→newest,
// capped to the last WORMGPT_MEMORY_MAX messages (6 chats).
async function getWormgptMemory(scope, max = WORMGPT_MEMORY_MAX) {
  if (!scope) return [];
  pruneExpiredWormgptMemory(); // fire-and-forget cleanup
  const nowISOz = new Date().toISOString();
  const { data, error } = await getSupabase()
    .from('wormgpt_memory')
    .select('id, role, content, created_at')
    .eq('scope', String(scope))
    .eq('kind', 'chat')
    .gt('expires_at', nowISOz)
    .order('id', { ascending: false })
    .limit(max);
  if (error) { console.error('getWormgptMemory error:', error.message); return []; }
  return (data || [])
    .reverse()
    .map(r => ({ role: r.role, text: r.content, content: r.content }));
}

// Return the recent NON-expired uploaded files for a scope, oldest→newest.
// Used to re-hydrate files into a fresh sandbox on follow-up text messages
// (e.g. user sends a ZIP, then later types "fix the bugs") so the agent does
// not report an empty workspace. Files are base64-decoded into Buffers.
async function getWormgptFiles(scope, max = 5) {
  if (!scope) return [];
  pruneExpiredWormgptMemory(); // fire-and-forget cleanup
  const nowISOz = new Date().toISOString();
  const { data, error } = await getSupabase()
    .from('wormgpt_memory')
    .select('file_name, file_data, file_mime, created_at')
    .eq('scope', String(scope))
    .eq('kind', 'file')
    .gt('expires_at', nowISOz)
    .order('id', { ascending: false })
    .limit(max);
  if (error) { console.error('getWormgptFiles error:', error.message); return []; }
  // newest-first → reverse to oldest-first, then de-dupe by name keeping latest.
  const rows = (data || []);
  const seen = new Set();
  const out = [];
  for (const r of rows) { // rows are newest-first; keep the first (latest) per name
    const name = r.file_name || 'upload';
    if (seen.has(name)) continue;
    seen.add(name);
    let buffer = null;
    try { buffer = Buffer.from(r.file_data || '', 'base64'); } catch (_) { buffer = null; }
    if (!buffer || !buffer.length) continue;
    const isImage = /\.(png|jpe?g|gif|webp|bmp)$/i.test(name) || /^image\//.test(r.file_mime || '');
    out.push({ name, buffer, mime: r.file_mime || 'application/octet-stream', isImage });
  }
  return out.reverse(); // oldest-first
}

// Delete all memory + files for a scope (used by /reset, /logout).
async function clearWormgptMemory(scope) {
  if (!scope) return;
  const { error } = await getSupabase().from('wormgpt_memory').delete().eq('scope', String(scope));
  if (error) console.error('clearWormgptMemory error:', error.message);
}

// ── APK chat history (Supabase-persisted, auto-wipes after the TTL window) ──
// Powers the "task keeps running / chat survives app close" requirement for the
// Flutter app. Rows are stored per (user_id, scope) where scope is the screen
// the message belongs to: 'chat' | 'wormgpt' | 'agent' | 'lemon'. Every row has
// an expires_at = created_at + <TTL days>; a pg_cron job (prune_apk_chat_history)
// deletes expired rows every 10 min, and we ALSO prune opportunistically on
// read so the wipe still holds even if cron is ever disabled.
//
// 🔧 ADMIN-CONFIGURABLE TTL: the cleanup window is no longer hardcoded to 2
// days. Admins set it from the panel (range 2 days → 2 months). The chosen
// value is stored durably in `app_settings` under key `apk_chat_ttl_days` and
// read at runtime through a short-lived cache so we don't hit the DB on every
// insert. Resolution order: app_settings → env APK_CHAT_TTL_DAYS → 2. Both the
// APK chat history AND the agent_jobs rows share this single TTL so the whole
// Supabase auto-wipe stays consistent.
const APK_CHAT_TTL_MIN_DAYS = 2;    // floor  (user requirement: 2 days)
const APK_CHAT_TTL_MAX_DAYS = 60;   // ceiling (user requirement: ~2 months)
const APK_CHAT_TTL_DEFAULT_DAYS = parseInt(process.env.APK_CHAT_TTL_DAYS, 10) || APK_CHAT_TTL_MIN_DAYS;
const APK_CHAT_TTL_SETTING_KEY = 'apk_chat_ttl_days';
const APK_CHAT_MAX = parseInt(process.env.APK_CHAT_MAX, 10) || 200; // per scope cap returned

// Clamp any incoming value into the allowed [2, 60] day range. Non-numeric /
// out-of-range inputs fall back to the safe default.
function clampTtlDays(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return APK_CHAT_TTL_DEFAULT_DAYS;
  return Math.min(APK_CHAT_TTL_MAX_DAYS, Math.max(APK_CHAT_TTL_MIN_DAYS, n));
}

// 60-second in-memory cache so high-frequency inserts don't each query the DB.
let _ttlCache = { days: APK_CHAT_TTL_DEFAULT_DAYS, at: 0 };
const _TTL_CACHE_MS = 60 * 1000;

// Async, authoritative read (used by the admin GET endpoint and to refresh the
// cache). Never throws — falls back to the cached / default value.
async function getApkChatTtlDays() {
  try {
    const raw = await getSetting(APK_CHAT_TTL_SETTING_KEY);
    const days = raw == null || raw === '' ? APK_CHAT_TTL_DEFAULT_DAYS : clampTtlDays(raw);
    _ttlCache = { days, at: Date.now() };
    return days;
  } catch (_) {
    return _ttlCache.days || APK_CHAT_TTL_DEFAULT_DAYS;
  }
}

// Persist a new TTL (admin action). Returns the clamped value actually stored.
async function setApkChatTtlDays(days) {
  const clamped = clampTtlDays(days);
  await setSetting(APK_CHAT_TTL_SETTING_KEY, String(clamped));
  _ttlCache = { days: clamped, at: Date.now() };
  return clamped;
}

// Synchronous best-effort read for hot paths (insert). Uses the cache and kicks
// off a background refresh when stale — the freshly-refreshed value is picked up
// by the next insert, which is plenty precise for a multi-day retention window.
function currentTtlDaysSync() {
  if (Date.now() - _ttlCache.at > _TTL_CACHE_MS) {
    getApkChatTtlDays().catch(() => {}); // fire-and-forget refresh
  }
  return _ttlCache.days || APK_CHAT_TTL_DEFAULT_DAYS;
}

// Expiry timestamp for a NEW row, based on the current (configurable) TTL.
function ttlExpiryISO() {
  return new Date(Date.now() + currentTtlDaysSync() * 24 * 60 * 60 * 1000).toISOString();
}

// Back-compat alias (older call sites used this name).
function apkChatExpiryISO() {
  return ttlExpiryISO();
}

// Fire-and-forget delete of anything past its 2-day window.
async function pruneApkChatHistory() {
  try {
    await getSupabase().from('apk_chat_history').delete().lte('expires_at', new Date().toISOString());
  } catch (_) {}
}

// Append one message. Returns the inserted row id (or null on failure — never throws).
async function saveApkChatMessage({ user_id, scope, role, content, steps, files, attachments, is_error, running, client_msg_id, job_id }) {
  if (!user_id || !scope || !role) return null;
  try {
    const { data, error } = await getSupabase().from('apk_chat_history').insert({
      user_id: String(user_id),
      scope: String(scope),
      role: String(role),
      content: content == null ? '' : String(content).slice(0, 200000),
      steps: steps || null,
      files: files || null,
      attachments: attachments || null,
      is_error: !!is_error,
      running: !!running,
      client_msg_id: client_msg_id || null,
      job_id: job_id || null,
      created_at: new Date().toISOString(),
      expires_at: apkChatExpiryISO(),
    }).select('id').single();
    if (error) { console.error('saveApkChatMessage error:', error.message); return null; }
    return data ? data.id : null;
  } catch (e) {
    console.error('saveApkChatMessage exception:', e.message);
    return null;
  }
}

// Update an existing message (used when an agent task finishes — the placeholder
// "running" row is filled in with the final text / files). Matches by id OR by
// (user_id, scope, client_msg_id). Never throws.
async function updateApkChatMessage({ id, user_id, scope, client_msg_id, content, steps, files, is_error, running, job_id }) {
  const patch = {};
  if (content !== undefined) patch.content = content == null ? '' : String(content).slice(0, 200000);
  if (steps !== undefined) patch.steps = steps;
  if (files !== undefined) patch.files = files;
  if (is_error !== undefined) patch.is_error = !!is_error;
  if (running !== undefined) patch.running = !!running;
  if (job_id !== undefined) patch.job_id = job_id;
  if (Object.keys(patch).length === 0) return false;
  try {
    let qy = getSupabase().from('apk_chat_history').update(patch);
    if (id) qy = qy.eq('id', id);
    else if (user_id && scope && client_msg_id) qy = qy.eq('user_id', String(user_id)).eq('scope', String(scope)).eq('client_msg_id', client_msg_id);
    else return false;
    const { error } = await qy;
    if (error) { console.error('updateApkChatMessage error:', error.message); return false; }
    return true;
  } catch (e) {
    console.error('updateApkChatMessage exception:', e.message);
    return false;
  }
}

// Return the non-expired messages for a (user, scope), oldest→newest, capped.
async function getApkChatHistory(user_id, scope, max = APK_CHAT_MAX) {
  if (!user_id || !scope) return [];
  pruneApkChatHistory(); // opportunistic cleanup
  const nowISOz = new Date().toISOString();
  // Order by the monotonic `seq` column (gap-free, assigned at INSERT time) so
  // the user turn ALWAYS sorts before its assistant reply — fixes the race
  // where two concurrent inserts could land a lower `id` on the assistant row
  // and make the answer render above the question after a reload.
  const { data, error } = await getSupabase()
    .from('apk_chat_history')
    .select('id, seq, role, content, steps, files, attachments, is_error, running, client_msg_id, job_id, created_at')
    .eq('user_id', String(user_id))
    .eq('scope', String(scope))
    .gt('expires_at', nowISOz)
    .order('seq', { ascending: false })
    .order('id', { ascending: false })
    .limit(max);
  if (error) { console.error('getApkChatHistory error:', error.message); return []; }
  return (data || []).reverse();
}

// Wipe a scope (used by the in-app "clear" button) or all scopes for a user.
async function clearApkChatHistory(user_id, scope) {
  if (!user_id) return;
  try {
    let qy = getSupabase().from('apk_chat_history').delete().eq('user_id', String(user_id));
    if (scope) qy = qy.eq('scope', String(scope));
    const { error } = await qy;
    if (error) console.error('clearApkChatHistory error:', error.message);
  } catch (e) { console.error('clearApkChatHistory exception:', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// 📦 AGENT FILE STORAGE (Supabase Storage) — host produced files by URL.
//   Previously agent output files were sent as base64 over the SSE `done`
//   event and only saved to the device, so they vanished after the app was
//   closed/reopened. We now upload them to a PUBLIC bucket and persist the
//   download URL — files survive reopen on any device, with NO app update.
// ─────────────────────────────────────────────────────────────────────────────
const AGENT_FILES_BUCKET = process.env.AGENT_FILES_BUCKET || 'agent-files';

// Upload a buffer and return a public, time-stable download URL (or null).
// Never throws. Path namespaced per user so files never collide.
async function uploadAgentFile({ userId, name, buffer, mime }) {
  if (!buffer || !buffer.length) return null;
  try {
    const safe = String(name || 'file').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
    const key = `${String(userId || 'anon')}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safe}`;
    const { error } = await getSupabase().storage
      .from(AGENT_FILES_BUCKET)
      .upload(key, buffer, {
        contentType: mime || 'application/octet-stream',
        // upsert:true so a (very unlikely) key collision or retry overwrites
        // instead of erroring out — an errored upload would leave the produced
        // file with NO url AND no inline b64 (the job row strips b64), making it
        // silently vanish from the client. Robustness > strictness here.
        upsert: true,
      });
    if (error) { console.error('uploadAgentFile error:', error.message); return null; }
    const { data } = getSupabase().storage.from(AGENT_FILES_BUCKET).getPublicUrl(key);
    return (data && data.publicUrl) ? { url: data.publicUrl, key } : null;
  } catch (e) {
    console.error('uploadAgentFile exception:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 🛠️ AGENT JOBS — durable, request-detached agent runs.
//   A job row tracks an agent task from queued → running → done/error. The
//   actual engine work runs DETACHED from the HTTP request, so closing the app
//   no longer kills the task. The client reconnects by polling the job by id.
//   Rows auto-expire after 2 days (expires_at + opportunistic prune).
// ─────────────────────────────────────────────────────────────────────────────
async function pruneAgentJobs() {
  try {
    await getSupabase().from('agent_jobs').delete().lte('expires_at', new Date().toISOString());
  } catch (_) {}
}

// Create a queued job. Returns the row (or null). Never throws.
async function createAgentJob({ id, user_id, scope, endpoint, task, client_msg_id }) {
  if (!id || !user_id) return null;
  try {
    const { data, error } = await getSupabase().from('agent_jobs').insert({
      id: String(id),
      user_id: String(user_id),
      scope: scope || 'agent',
      endpoint: endpoint || '/api/agent/run',
      task: task == null ? '' : String(task).slice(0, 8000),
      status: 'queued',
      steps: [],
      message: '',
      files: [],
      is_error: false,
      client_msg_id: client_msg_id || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      // Share the SAME admin-configurable TTL as apk_chat_history so the whole
      // Supabase auto-wipe window is consistent (was a hardcoded 2-day DB default).
      expires_at: ttlExpiryISO(),
    }).select('*').single();
    if (error) { console.error('createAgentJob error:', error.message); return null; }
    return data || null;
  } catch (e) { console.error('createAgentJob exception:', e.message); return null; }
}

// Patch a job (status / steps / message / files / is_error). Never throws.
async function updateAgentJob(id, patch) {
  if (!id || !patch || !Object.keys(patch).length) return false;
  try {
    const p = { ...patch, updated_at: new Date().toISOString() };
    const { error } = await getSupabase().from('agent_jobs').update(p).eq('id', String(id));
    if (error) { console.error('updateAgentJob error:', error.message); return false; }
    return true;
  } catch (e) { console.error('updateAgentJob exception:', e.message); return false; }
}

// Append a single step note to a job (read-modify-write, best effort).
async function appendAgentJobStep(id, note) {
  if (!id || !note) return;
  try {
    const { data } = await getSupabase().from('agent_jobs').select('steps').eq('id', String(id)).single();
    const steps = Array.isArray(data && data.steps) ? data.steps : [];
    steps.push(String(note));
    // Cap to the last 200 steps so the row never grows unbounded.
    const trimmed = steps.slice(-200);
    await getSupabase().from('agent_jobs').update({ steps: trimmed, updated_at: new Date().toISOString() }).eq('id', String(id));
  } catch (_) {}
}

// Fetch a single job by id (ownership enforced by caller). Never throws.
async function getAgentJob(id) {
  if (!id) return null;
  try {
    const { data, error } = await getSupabase().from('agent_jobs').select('*').eq('id', String(id)).single();
    if (error) return null;
    return data || null;
  } catch (_) { return null; }
}

// List a user's recent jobs for a scope (newest first). Never throws.
async function getAgentJobsForUser(user_id, scope, max = 20) {
  if (!user_id) return [];
  pruneAgentJobs();
  try {
    let qy = getSupabase().from('agent_jobs').select('*')
      .eq('user_id', String(user_id))
      .gt('expires_at', new Date().toISOString())
      .order('updated_at', { ascending: false })
      .limit(max);
    if (scope) qy = qy.eq('scope', String(scope));
    const { data, error } = await qy;
    if (error) return [];
    return data || [];
  } catch (_) { return []; }
}

// ── 🧾 Bot Activity Log ────────────────────────────────────────────────────
// Records every user interaction with the Telegram bot so the admin can see
// what questions users ask, files they upload, and how credits change.
// Stored in the `bot_activity_log` Supabase table (service-role only).

async function logBotActivity({ user_id, chat_id, channel = 'telegram', action, message_text, file_name, credits_before, credits_after, tier }) {
  try {
    await getSupabase().from('bot_activity_log').insert({
      user_id: user_id || null,
      chat_id: chat_id || null,
      channel,
      action: String(action || 'unknown').slice(0, 100),
      message_text: message_text ? String(message_text).slice(0, 2000) : null,
      file_name: file_name ? String(file_name).slice(0, 500) : null,
      credits_before: Number.isFinite(credits_before) ? credits_before : null,
      credits_after: Number.isFinite(credits_after) ? credits_after : null,
      tier: tier || null,
    });
  } catch (_) { /* best-effort — never break the bot */ }
}

// Fetch activity log entries for the admin panel. Supports pagination and
// optional filters (user_id, channel, action, search text). Returns { rows, total }.
async function getBotActivity({ limit = 50, offset = 0, user_id, channel, action, search } = {}) {
  try {
    let query = getSupabase()
      .from('bot_activity_log')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (user_id) query = query.eq('user_id', String(user_id));
    if (channel) query = query.eq('channel', String(channel));
    if (action) query = query.eq('action', String(action));
    if (search) query = query.ilike('message_text', `%${String(search).replace(/[%_]/g, '\\$&')}%`);
    const { data, error, count } = await query;
    if (error) return { rows: [], total: 0 };
    return { rows: data || [], total: count || 0 };
  } catch (_) { return { rows: [], total: 0 }; }
}


module.exports = {
  getSupabase,
  createUser, getUserByEmail, getUserById, getAllUsers, updateUser, touchUserPlatform, getApkUsers, getDesktopUsers, deleteUser, checkEmailExists,
  addIpRegistry, getIpCountByIp, getIpCountByFingerprint, getFingerprintRecord,
  getDeviceRecord, getDeviceAccountCount, addDeviceRecord, setDeviceBlocked,
  createPayment, getPaymentById, getPaymentByTxRef, updatePayment, getAllPayments,
  seedApiKeys, getNextApiKey, markApiKeyRateLimited, getAllApiKeys, toggleApiKey, addApiKey,
  getSetting, setSetting,
  // 🎟️ PAYG feature passes
  grantFeaturePass, hasFeaturePass, getFeaturePasses, FEATURE_PASS_KEYS,
  saveChatMessage, saveTerminalFile, getTerminalFilesByUser, getAllTerminalFilenames,
  saveImageGeneration, getImageCountToday,
  seedAdmin, nowISO,
  wormgptDailyLimit, wormgptTierName,
  // 🪙 WormGPT Agent credit system
  wormgptCreditUnlimited, wormgptCreditCap, ensureWormgptCredits, getWormgptCredits,
  chargeWormgptCredits, setWormgptCredits, addWormgptCredits, resetWormgptCreditsForTier, getWormgptLifetimeSpent,
  spotifyDailyLimit, spotifyTierName, getSpotifyDownloadCountToday, saveSpotifyDownload,
  scanDetectorDailyLimit, scanDetectorTierName, getScanCountToday, saveScanUsage,
  osintDailyLimit, osintTierName, getOsintCountToday, saveOsintUsage,
  browserDailyLimit, browserTierName, getBrowserUseCountToday, saveBrowserUse,
  createUptimeMonitor, getUptimeMonitors, getUptimeMonitorById, updateUptimeMonitor, deleteUptimeMonitor, getAllActiveMonitors,
  saveUptimeLog, getUptimeLogs, getRecentUptimeEvents, getActiveMonitorCount,
  saveApiKeyTest, getApiKeyTestCountToday,
  saveImageDetection, getImageDetectionCountToday,
  saveTelegramJoin, getTelegramJoinCountToday, getTelegramJoinCountAll,
  saveEvilGptUsage, getEvilGptUsageCountToday,
  saveHotbotUsage, getHotbotUsageCountToday,
  getWaSession, upsertWaSession, getActiveWaSessions,
  getWaFreeUsed, markWaFreeUsed,
  createWaTracked, getWaTracked, getWaTrackedById, getWaTrackedByPhone,
  updateWaTracked, deleteWaTracked, getWaTrackedCount,
  saveWaPresenceLog, getWaPresenceLogs,
  getTelegramLink, getTelegramLinkByToken, getTelegramLinkByChat, upsertTelegramLink,
  getPatcherLinkByChat, getPatcherLinkByUser, getAuthedPatcherLinks, getBotUsers, upsertPatcherLink,
  createPatchJob, updatePatchJob, getPatchJob, getLatestPatchJobForUser,
  saveWormgptMemory, saveWormgptFile, getWormgptMemory, getWormgptFiles, clearWormgptMemory, pruneExpiredWormgptMemory,
  getCapyThread, setCapyThread, clearCapyThread,
  getCapyHistory, appendCapyHistory, clearCapyHistory,
  saveApkChatMessage, updateApkChatMessage, getApkChatHistory, clearApkChatHistory, pruneApkChatHistory,
  // ⏳ Admin-configurable Supabase TTL cleanup window (2 days → 2 months)
  getApkChatTtlDays, setApkChatTtlDays,
  APK_CHAT_TTL_MIN_DAYS, APK_CHAT_TTL_MAX_DAYS, APK_CHAT_TTL_DEFAULT_DAYS,
  uploadAgentFile,
  createAgentJob, updateAgentJob, appendAgentJobStep, getAgentJob, getAgentJobsForUser, pruneAgentJobs,
  // 🧾 Bot activity log (admin visibility)
  logBotActivity, getBotActivity,
};