// ─────────────────────────────────────────────────────────────────────────────
// 🐛 WormGPT Public API — OpenRouter-style metered API for uncensored chat +
// images. This is a DOLLAR-balance product, completely separate from the
// integer "wgc" agent credits (db.js). Users mint API keys (sk-worm-…), get a
// one-time $0.50 free grant (rate-limited 20 req/s) to test, then top up via
// Flutterwave to keep going. Every request drains their balance by a fixed
// per-model price — exactly the way OpenRouter meters usage.
//
// Storage (Supabase, tables created by migrations/wormgpt_public_api.sql):
//   worm_api_keys      — hashed API keys per user
//   worm_api_balance   — dollar balance (stored in micro-USD = USD*1e6)
//   worm_api_usage     — per-request ledger
//   worm_api_topups    — processed Flutterwave topups (idempotency)
//
// The chat/image generation itself is delegated to services/hotbot.js (the
// HotBot + Gemini + Sakana FUSION — the uncensored "hotbot/gemini/racers
// fusion" brain), so the API returns the SAME quality answers as the website.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();

let _sb = null;
function sb() {
  if (_sb) return _sb;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be configured');
  }
  _sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  return _sb;
}

// ── Money helpers ────────────────────────────────────────────────────────────
const MICRO = 1_000_000; // 1 USD = 1,000,000 micro-USD
function usdToMicro(usd) { return Math.round(Number(usd || 0) * MICRO); }
function microToUsd(micro) { return (Number(micro || 0) / MICRO); }
function fmtUsd(micro) { return '$' + microToUsd(micro).toFixed(4).replace(/0+$/, '').replace(/\.$/, '.00'); }

// ── Free grant + pricing (admin-overridable via app_settings; see server) ─────
const FREE_GRANT_USD = 0.50;      // one-time test balance for a brand-new user
const FREE_RATE_PER_SEC = 20;     // 20 req/s cap while on the free grant (admin-tunable)

// Per-request prices in USD (OpenRouter-style flat per-call for simplicity).
// Each request DRAINS the caller's dollar balance by exactly one of these:
//   uncensored chat          → $0.06
//   uncensored chat (pro/reasoning) → $0.09
//   image generation         → $1.00
// Admins can override any of these at runtime (app_settings: wapi_price_*),
// see server.js effectivePrices() — the values below are the DEFAULTS.
const PRICES = {
  'wormgpt-chat':     0.06,   // uncensored chat completion
  'wormgpt-chat-pro': 0.09,   // uncensored chat pro (reasoning)
  'wormgpt-image':    1.00,   // one generated image
};
function priceUsd(model, overrides = null) {
  const table = (overrides && typeof overrides === 'object') ? overrides : PRICES;
  const m = String(model || '').toLowerCase();
  if (table[m] != null) return table[m];
  // Robust model→bucket routing so aliases still bill correctly.
  if (m.includes('image')) return (table['wormgpt-image'] != null ? table['wormgpt-image'] : PRICES['wormgpt-image']);
  if (m.includes('pro') || m.includes('reason')) return (table['wormgpt-chat-pro'] != null ? table['wormgpt-chat-pro'] : PRICES['wormgpt-chat-pro']);
  return (table['wormgpt-chat'] != null ? table['wormgpt-chat'] : PRICES['wormgpt-chat']);
}

// ── API key helpers ────────────────────────────────────────────────────────
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

// Generate a new raw key: sk-worm-<40 url-safe chars>. Returns { raw, hash, prefix }.
function newKey() {
  const rand = crypto.randomBytes(30).toString('base64').replace(/[+/=]/g, '').slice(0, 40);
  const raw = 'sk-worm-' + rand;
  return { raw, hash: sha256(raw), prefix: raw.slice(0, 16) };
}

// Create + store a key for a user. Returns { id, key (RAW — shown ONCE), prefix }.
async function createApiKey(userId, label) {
  const { raw, hash, prefix } = newKey();
  const { data, error } = await sb().from('worm_api_keys')
    .insert({ user_id: String(userId), key_hash: hash, key_prefix: prefix, label: label ? String(label).slice(0, 80) : null })
    .select('id, key_prefix, created_at, label')
    .single();
  if (error) throw new Error(error.message);
  return { id: data.id, key: raw, prefix: data.key_prefix, label: data.label, created_at: data.created_at };
}

// List a user's keys (never returns the raw key). Newest first.
async function listApiKeys(userId) {
  const { data, error } = await sb().from('worm_api_keys')
    .select('id, key_prefix, label, active, created_at, last_used_at')
    .eq('user_id', String(userId))
    .order('created_at', { ascending: false });
  if (error) return [];
  return (data || []).map(k => ({ ...k, key_prefix: k.key_prefix + '…' }));
}

// Revoke (deactivate) a key owned by this user.
async function revokeApiKey(userId, keyId) {
  const { error } = await sb().from('worm_api_keys')
    .update({ active: false })
    .eq('id', keyId).eq('user_id', String(userId));
  return !error;
}

// Resolve a raw API key → its row (must be active). Returns row or null.
async function resolveKey(rawKey) {
  const key = String(rawKey || '').trim();
  if (!key.startsWith('sk-worm-')) return null;
  const { data, error } = await sb().from('worm_api_keys')
    .select('id, user_id, active')
    .eq('key_hash', sha256(key)).eq('active', true)
    .maybeSingle();
  if (error || !data) return null;
  // Best-effort last-used stamp (don't block the request on it).
  sb().from('worm_api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', data.id).then(() => {}, () => {});
  return data;
}

// ── Balance ──────────────────────────────────────────────────────────────
// Read a user's balance row (creates a zero row implicitly on first charge).
async function getBalance(userId) {
  const { data } = await sb().from('worm_api_balance')
    .select('balance_micro, spent_micro, free_granted')
    .eq('user_id', String(userId)).maybeSingle();
  return {
    balance_micro: data ? Number(data.balance_micro) : 0,
    spent_micro:   data ? Number(data.spent_micro) : 0,
    free_granted:  data ? !!data.free_granted : false,
    balance_usd:   microToUsd(data ? data.balance_micro : 0),
    spent_usd:     microToUsd(data ? data.spent_micro : 0),
  };
}

// Grant the one-time free test balance ($0.50) if the user has never had it.
// Returns { granted, balance }. Idempotent: only ever grants once.
async function ensureFreeGrant(userId, freeUsd = FREE_GRANT_USD) {
  const uid = String(userId);
  const bal = await getBalance(uid);
  if (bal.free_granted) return { granted: false, balance: bal };
  // Mark granted FIRST (idempotency), then add — an upsert flips the flag.
  const { error: upErr } = await sb().from('worm_api_balance')
    .upsert({ user_id: uid, free_granted: true }, { onConflict: 'user_id' });
  if (upErr) return { granted: false, balance: bal };
  await sb().rpc('worm_api_add', { p_user: uid, p_amount: usdToMicro(freeUsd) });
  return { granted: true, balance: await getBalance(uid) };
}

// Add balance (topup / admin grant). Returns new balance row.
async function addBalance(userId, usd) {
  await sb().rpc('worm_api_add', { p_user: String(userId), p_amount: usdToMicro(usd) });
  return getBalance(userId);
}

// Set an exact balance (admin). Reads current then adjusts by the delta.
async function setBalance(userId, usd) {
  const cur = await getBalance(userId);
  const delta = usdToMicro(usd) - cur.balance_micro;
  await sb().rpc('worm_api_add', { p_user: String(userId), p_amount: delta });
  return getBalance(userId);
}

// Charge a request. Returns { ok, balance_micro, cost_micro }. Never negative.
async function charge(userId, costUsd, { keyId = null, endpoint, model, meta = {} } = {}) {
  const uid = String(userId);
  const costMicro = usdToMicro(costUsd);
  const { data, error } = await sb().rpc('worm_api_charge', { p_user: uid, p_cost: costMicro });
  const balAfter = error ? null : Number(data);
  // Ledger (best-effort).
  sb().from('worm_api_usage').insert({
    user_id: uid, key_id: keyId, endpoint, model,
    cost_micro: costMicro, balance_after: balAfter, meta,
  }).then(() => {}, () => {});
  return { ok: !error, balance_micro: balAfter, cost_micro: costMicro };
}

// ── ATOMIC strict charge (race-safe pay-as-you-go) ───────────────────────────
// Debits EXACTLY `costUsd` in a single locked DB transaction, but ONLY if the
// balance can fully cover it. Returns { ok, insufficient, balance_micro,
// cost_micro }. When ok=false & insufficient=true the balance was left
// untouched. This closes the TOCTOU race where two concurrent requests could
// both pass a separate getBalance() check and be served for the price of one.
// The row is written to the usage ledger only when a charge actually happened.
async function chargeStrict(userId, costUsd, { keyId = null, endpoint, model, meta = {} } = {}) {
  const uid = String(userId);
  const costMicro = usdToMicro(costUsd);
  const { data, error } = await sb().rpc('worm_api_charge_strict', { p_user: uid, p_cost: costMicro });
  if (error) return { ok: false, insufficient: false, balance_micro: null, cost_micro: costMicro, error: error.message };
  const balAfter = Number(data);
  if (balAfter < 0) {
    // Sentinel: insufficient balance — nothing was debited.
    return { ok: false, insufficient: true, balance_micro: null, cost_micro: costMicro };
  }
  sb().from('worm_api_usage').insert({
    user_id: uid, key_id: keyId, endpoint, model,
    cost_micro: costMicro, balance_after: balAfter, meta,
  }).then(() => {}, () => {});
  return { ok: true, insufficient: false, balance_micro: balAfter, cost_micro: costMicro };
}

// Refund a previously-charged amount (used when the upstream brain/image call
// fails AFTER we already debited). Idempotency is the caller's responsibility.
async function refund(userId, costUsd, { keyId = null, endpoint, model, meta = {} } = {}) {
  const uid = String(userId);
  const amtMicro = usdToMicro(costUsd);
  await sb().rpc('worm_api_add', { p_user: uid, p_amount: amtMicro });
  sb().from('worm_api_usage').insert({
    user_id: uid, key_id: keyId, endpoint: (endpoint || 'refund') + ':refund', model,
    cost_micro: -amtMicro, balance_after: null, meta: { ...meta, refund: true },
  }).then(() => {}, () => {});
  return getBalance(uid);
}

// ── Rate limit (free-tier only): 20 req/s per user (sliding 1s window). ──────
const _rl = new Map(); // uid -> [timestamps ms]
function rateOk(userId, perSec = FREE_RATE_PER_SEC) {
  const uid = String(userId);
  const now = Date.now();
  const arr = (_rl.get(uid) || []).filter(t => now - t < 1000);
  if (arr.length >= perSec) { _rl.set(uid, arr); return false; }
  arr.push(now);
  _rl.set(uid, arr);
  return true;
}

// Recent usage rows (admin + dashboard). Optional user filter.
async function recentUsage({ userId = null, limit = 50 } = {}) {
  let q = sb().from('worm_api_usage')
    .select('id, user_id, endpoint, model, cost_micro, balance_after, created_at')
    .order('created_at', { ascending: false }).limit(Math.min(500, limit));
  if (userId) q = q.eq('user_id', String(userId));
  const { data } = await q;
  return (data || []).map(r => ({ ...r, cost_usd: microToUsd(r.cost_micro), balance_after_usd: microToUsd(r.balance_after) }));
}

// Record a Flutterwave topup exactly once (idempotent on tx_ref). Credits the
// user's balance and returns { credited, balance }.
async function recordTopup({ txRef, userId, amountUsd, rawAmount, currency }) {
  const ref = String(txRef || '').trim();
  if (!ref || !userId || !(amountUsd > 0)) return { credited: false, reason: 'bad_args' };
  // Idempotency: insert the topup row; a duplicate tx_ref → already processed.
  const { error: insErr } = await sb().from('worm_api_topups')
    .insert({ tx_ref: ref, user_id: String(userId), amount_usd: amountUsd, raw_amount: rawAmount || null, currency: currency || null });
  if (insErr) {
    // Unique violation → already credited.
    return { credited: false, reason: 'already_processed' };
  }
  const balance = await addBalance(userId, amountUsd);
  return { credited: true, balance };
}

module.exports = {
  MICRO, usdToMicro, microToUsd, fmtUsd,
  FREE_GRANT_USD, FREE_RATE_PER_SEC, PRICES, priceUsd,
  createApiKey, listApiKeys, revokeApiKey, resolveKey,
  getBalance, ensureFreeGrant, addBalance, setBalance, charge, chargeStrict, refund,
  rateOk, recentUsage, recordTopup,
};
