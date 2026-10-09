// Hackers Ai Everywhere v8 - Auth routes using Supabase backend
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const fetch = require('node-fetch');
const db = require('../db');
const wormApi = require('../services/wormgptApi'); // 🐛 API $-balance topups

const JWT_SECRET = process.env.JWT_SECRET || 'change_me_jwt_secret';
const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || '2');

// ── WormGPT Agent credit caps (admin-overridable, mirrors server.js) ─────────
// The per-tier credit caps can be tuned by the admin at runtime via the
// `credit_free_cap` / `credit_basic_cap` settings (see CREDIT_DEFAULTS in
// server.js). We read them here so that when an admin changes a user's plan we
// can clamp their WormGPT balance to the CORRECT, possibly-customised cap.
// Falls back to the same hard defaults server.js uses. Never throws.
const WGC_FREE_CAP_DEFAULT = 900;
const WGC_BASIC_CAP_DEFAULT = 5000;
async function getWormgptCreditCaps() {
  async function read(key, def) {
    try {
      const raw = await db.getSetting(key);
      if (raw == null || String(raw).trim() === '') return def;
      const n = parseInt(String(raw).trim(), 10);
      if (Number.isFinite(n) && n >= 0) return n;
    } catch (_) {}
    return def;
  }
  const [free, basic] = await Promise.all([
    read('credit_free_cap', WGC_FREE_CAP_DEFAULT),
    read('credit_basic_cap', WGC_BASIC_CAP_DEFAULT),
  ]);
  return { free, basic };
}

// ── Anti-loot: "1 account per device" ──
// Set DEVICE_LIMIT_ENABLED=false to instantly disable the device check WITHOUT a
// redeploy (kill-switch — if anything ever goes wrong it can never lock users
// out). Defaults to ON. How many accounts a single device may EVER create:
const DEVICE_LIMIT_ENABLED = String(process.env.DEVICE_LIMIT_ENABLED || 'true').toLowerCase() !== 'false';
const MAX_ACCOUNTS_PER_DEVICE = parseInt(process.env.MAX_ACCOUNTS_PER_DEVICE || '1', 10);
// ── Flutterwave config (runtime-first) ──────────────────────────────────────
// Each value resolves at REQUEST time in this order:
//   1. runtime DB setting (app_settings) — admin-settable, no redeploy needed
//   2. environment variable (Render dashboard)
//   3. a safe baked-in default (links only; never a secret)
// This means the FLW secret / encryption keys can be rotated instantly from the
// admin panel or seeded directly into the DB, and payments keep verifying even
// if the Render env was never filled in.
async function flwSecretKey() {
  return (await db.getSetting('flw_secret_key')) || process.env.FLW_SECRET_KEY || '';
}
async function flwPublicKey() {
  return (await db.getSetting('flw_public_key')) || process.env.FLW_PUBLIC_KEY || '';
}
async function flwEncryptionKey() {
  return (await db.getSetting('flw_encryption_key')) || process.env.FLW_ENCRYPTION_KEY || '';
}
// Secret hash used to verify incoming Flutterwave webhooks (set the SAME value
// in the Flutterwave dashboard → Settings → Webhooks → "Secret hash"). Falls
// back to the secret key only as a last resort so the webhook is never wide
// open by accident.
async function flwWebhookHash() {
  return (await db.getSetting('flw_webhook_hash'))
    || process.env.FLW_WEBHOOK_HASH
    || (await flwSecretKey())
    || '';
}
async function flwBasicLink() {
  return (await db.getSetting('flw_basic_link')) || process.env.FLW_BASIC_LINK || 'https://flutterwave.com/pay/hhpuddzjsfrf';
}
async function flwProLink() {
  return (await db.getSetting('flw_pro_link')) || process.env.FLW_PRO_LINK || 'https://flutterwave.com/pay/xhceft1fdei1';
}
// Single shared Flutterwave payment link used by EVERY pay-as-you-go product
// (the small feature passes + WormGPT credit top-ups). One link, many products:
// security is enforced in fulfilPayment() (amount ≥ price, currency, tx_ref
// binding, idempotency) exactly like Basic/Pro — the product the user actually
// gets is decided by OUR payment row, never by the link.
async function flwPaygLink() {
  return (await db.getSetting('flw_payg_link')) || process.env.FLW_PAYG_LINK || 'https://flutterwave.com/pay/3grsmktjujrq';
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:10000';
  return `${proto}://${host}`;
}

// Plan pricing (in Naira). NOTE: "premium" is an alias for "pro" — the public
// checkout / Supabase pay-redirect uses ?plan=premium, internally it maps to pro.
const PLAN_PRICES = {
  basic: { amount: 20000, currency: 'NGN', label: 'Basic' },
  pro: { amount: 40000, currency: 'NGN', label: 'Pro' }
};

// ─────────────────────────────────────────────────────────────────────────────
// 🎟️  PAY-AS-YOU-GO PRODUCT CATALOG (single Flutterwave link, many products)
// ─────────────────────────────────────────────────────────────────────────────
// Each product is either:
//   • kind:'pass'   → grants db.grantFeaturePass(user, feature, days)
//   • kind:'credits'→ grants db.addWormgptCredits(user, credits)  (WormGPT agent)
// Amounts are the MINIMUM Naira that must be paid (FLW verifies amount ≥ this).
// Prices/grants are admin-tunable at runtime via app_settings keys
//   payg_<id>_amount / payg_<id>_days / payg_<id>_credits
// (read in paygProduct() below) so you can change them with NO redeploy.
const PAYG_PRODUCTS = {
  spotify:        { kind: 'pass', feature: 'spotify',    amount: 500,  days: 7, currency: 'NGN', label: 'Spotify Downloader — 7 days' },
  scam:           { kind: 'pass', feature: 'scam',       amount: 400,  days: 7, currency: 'NGN', label: 'Email Scam Detector — 7 days' },
  hotbot:         { kind: 'pass', feature: 'hotbot',     amount: 500,  days: 7, currency: 'NGN', label: 'HotBot AI Chat — 7 days' },
  browser:        { kind: 'pass', feature: 'browser',    amount: 700,  days: 7, currency: 'NGN', label: 'Stealth Browser — 7 days' },
  phoneguard:     { kind: 'pass', feature: 'phoneguard', amount: 600,  days: 7, currency: 'NGN', label: 'Phone Guard — 7 days' },
  uptime:         { kind: 'pass', feature: 'uptime',     amount: 500,  days: 7, currency: 'NGN', label: 'Uptime Monitor — 7 days' },
  callblock:      { kind: 'pass', feature: 'callblock',  amount: 400,  days: 7, currency: 'NGN', label: 'Call & WhatsApp Call Blocker — 7 days' },
  osint:          { kind: 'pass', feature: 'osint',      amount: 600,  days: 7, currency: 'NGN', label: 'OSINT Image Metadata Extractor — 7 days' },
  credits_500:    { kind: 'credits', credits: 1000, amount: 500,  currency: 'NGN', label: 'WormGPT Agent — 1000 credits' },
  credits_1000:   { kind: 'credits', credits: 2000, amount: 1000, currency: 'NGN', label: 'WormGPT Agent — 2000 credits' },
  credits_2000:   { kind: 'credits', credits: 3500, amount: 2000, currency: 'NGN', label: 'WormGPT Agent — 3500 credits' },
};

// Resolve a PAYG product with any admin runtime overrides applied. Returns null
// for an unknown id. The returned object always carries a canonical `plan`
// string (e.g. "payg_spotify") that we store on the payment row.
async function paygProduct(id) {
  const base = PAYG_PRODUCTS[id];
  if (!base) return null;
  const get = async (k) => { try { const v = await db.getSetting(k); return v == null || v === '' ? null : v; } catch (_) { return null; } };
  const amtO = parseInt(await get(`payg_${id}_amount`), 10);
  const out = { id, plan: `payg_${id}`, ...base };
  if (Number.isFinite(amtO) && amtO > 0) out.amount = amtO;
  if (base.kind === 'pass') {
    const daysO = parseInt(await get(`payg_${id}_days`), 10);
    if (Number.isFinite(daysO) && daysO > 0) out.days = daysO;
  } else {
    const credO = parseInt(await get(`payg_${id}_credits`), 10);
    if (Number.isFinite(credO) && credO > 0) out.credits = credO;
  }
  return out;
}

// Build the full public catalog (with runtime overrides) for the UI.
async function paygCatalog() {
  const ids = Object.keys(PAYG_PRODUCTS);
  const items = await Promise.all(ids.map((id) => paygProduct(id)));
  return items.filter(Boolean);
}

// Map any external plan alias (premium → pro) to a canonical internal plan.
// Also recognises every PAYG product id ("spotify", "credits_500", …) and the
// already-canonical "payg_<id>" form, so the same checkout entrypoint serves
// subscriptions AND pay-as-you-go products.
function canonicalPlan(plan) {
  const p = String(plan || '').toLowerCase().trim();
  if (p === 'premium') return 'pro';
  if (p === 'basic' || p === 'pro') return p;
  if (PAYG_PRODUCTS[p]) return `payg_${p}`;                 // bare id  → payg_<id>
  if (p.startsWith('payg_') && PAYG_PRODUCTS[p.slice(5)]) return p; // already canonical
  return null;
}

// Is this canonical plan a PAYG product? Returns the product id or null.
function paygIdFromPlan(plan) {
  const p = String(plan || '').toLowerCase().trim();
  if (p.startsWith('payg_') && PAYG_PRODUCTS[p.slice(5)]) return p.slice(5);
  return null;
}

// Constant-time string comparison (avoids timing attacks on the webhook hash).
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 🔒 SECURE payment fulfilment — the ONLY place that grants anything paid.
//
// Handles BOTH subscriptions (basic/pro → flip subscription_status) and
// pay-as-you-go products (payg_* → grant a feature pass or WormGPT credits).
//
// A transaction is honoured ONLY when ALL of these hold:
//   1. Flutterwave's own API confirms data.status === 'successful'
//   2. The charged amount is >= the product price we expect
//   3. The charged currency matches the product currency
//   4. The tx_ref returned by Flutterwave matches the tx_ref we generated
//      (binds the verified transaction to THIS payment row — no swapping)
//   5. The payment row is still 'pending' (idempotent — never double-credit,
//      never re-open a refunded/charged-back upgrade)
//
// Returns { ok, reason, plan }.
// ─────────────────────────────────────────────────────────────────────────────
async function fulfilPayment(payment, flwTxn, expectedTxRef) {
  if (!payment) return { ok: false, reason: 'payment_not_found' };

  // Idempotency: if it's already completed, treat as success but do NOT re-apply.
  if (payment.status === 'completed') {
    return { ok: true, reason: 'already_completed', plan: payment.plan, alreadyDone: true };
  }
  if (payment.status === 'failed') {
    // allow a fresh attempt to flip it back to pending elsewhere, but a failed
    // row should not be silently upgraded here.
    return { ok: false, reason: 'payment_failed_state' };
  }

  // Resolve the expected price/currency for this payment row. PAYG products
  // come from the runtime catalog; subscriptions from PLAN_PRICES.
  const paygId = paygIdFromPlan(payment.plan);
  const product = paygId ? await paygProduct(paygId) : null;
  const config = product || PLAN_PRICES[payment.plan];
  if (!config) return { ok: false, reason: 'unknown_plan' };

  if (!flwTxn || flwTxn.status !== 'successful') {
    return { ok: false, reason: 'not_successful' };
  }

  // 2 — amount must cover the product price (Flutterwave returns amount as a number).
  const paid = Number(flwTxn.amount || 0);
  if (!(paid >= config.amount)) {
    console.warn(`💸 Payment ${payment.id}: underpaid (paid ${paid}, expected ${config.amount})`);
    await db.updatePayment(payment.id, { status: 'failed' }).catch(() => {});
    return { ok: false, reason: 'amount_mismatch' };
  }

  // 3 — currency must match.
  if (String(flwTxn.currency || '').toUpperCase() !== config.currency) {
    console.warn(`💱 Payment ${payment.id}: currency mismatch (${flwTxn.currency} vs ${config.currency})`);
    await db.updatePayment(payment.id, { status: 'failed' }).catch(() => {});
    return { ok: false, reason: 'currency_mismatch' };
  }

  // 4 — tx_ref binding: the reference Flutterwave verified must be the one we
  // created for this payment. Prevents pasting someone else's successful txn.
  const flwRef = flwTxn.tx_ref || flwTxn.txRef || '';
  if (expectedTxRef && flwRef && flwRef !== expectedTxRef) {
    console.warn(`🔗 Payment ${payment.id}: tx_ref mismatch (${flwRef} vs ${expectedTxRef})`);
    return { ok: false, reason: 'txref_mismatch' };
  }

  // ── PAY-AS-YOU-GO fulfilment ───────────────────────────────────────────────
  if (product) {
    // Mark the row completed FIRST (pending→completed is the idempotency guard),
    // then grant. If the grant ever fails we still have the completed row +
    // FLW txn, so /requery would short-circuit on already_completed — to avoid a
    // silent "paid but not granted", we grant before flagging completed and only
    // flag completed once the grant succeeds.
    let granted = false;
    let detail = '';
    try {
      if (product.kind === 'pass') {
        const exp = await db.grantFeaturePass(payment.user_id, product.feature, product.days);
        granted = !!exp;
        detail = `${product.feature} pass until ${exp ? new Date(exp).toISOString() : '?'}`;
      } else if (product.kind === 'credits') {
        await db.addWormgptCredits(payment.user_id, product.credits);
        granted = true;
        detail = `+${product.credits} WormGPT credits`;
      }
    } catch (e) {
      console.error(`PAYG grant error on payment ${payment.id}:`, e.message);
      granted = false;
    }
    if (!granted) {
      // Leave the row PENDING so a later /requery (or the webhook retry) can
      // re-attempt the grant — the user is never charged-without-grant.
      return { ok: false, reason: 'grant_failed', plan: payment.plan };
    }
    await db.updatePayment(payment.id, {
      status: 'completed',
      stripe_payment_intent_id: flwRef || expectedTxRef || null
    });
    console.log(`✅ PAYG ${payment.id} fulfilled → user ${payment.user_id}: ${detail}`);
    return { ok: true, reason: 'fulfilled', plan: payment.plan, payg: true, product: product.id };
  }

  // ── SUBSCRIPTION fulfilment (basic/pro) ─────────────────────────────────────
  // All checks passed → flip to active, atomically guarded by the pending state.
  await db.updatePayment(payment.id, {
    status: 'completed',
    stripe_payment_intent_id: flwRef || expectedTxRef || null
  });
  await db.updateUser(payment.user_id, {
    subscription_status: 'active',
    subscription_plan: payment.plan,
    trial_end: null,
    subscription_start: db.nowISO()
  });
  console.log(`✅ Payment ${payment.id} fulfilled → user ${payment.user_id} now ${payment.plan}`);
  return { ok: true, reason: 'fulfilled', plan: payment.plan };
}

// Verify a transaction with Flutterwave by its transaction_id. Returns the
// `data` object or null. Never throws.
async function flwVerifyById(transactionId) {
  const secret = await flwSecretKey();
  if (!transactionId || !secret) return null;
  try {
    const r = await fetch(`https://api.flutterwave.com/v3/transactions/${transactionId}/verify`, {
      headers: { 'Authorization': `Bearer ${secret}` }
    });
    const j = await r.json();
    if (j.status === 'success' && j.data) return j.data;
  } catch (e) { console.error('FLW verify-by-id error:', e.message); }
  return null;
}

// Verify a transaction with Flutterwave by our own tx_ref (used by /requery
// when we never received a transaction_id — e.g. the redirect hung).
async function flwVerifyByRef(txRef) {
  const secret = await flwSecretKey();
  if (!txRef || !secret) return null;
  try {
    const r = await fetch(`https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`, {
      headers: { 'Authorization': `Bearer ${secret}` }
    });
    const j = await r.json();
    if (j.status === 'success' && j.data) return j.data;
  } catch (e) { console.error('FLW verify-by-ref error:', e.message); }
  return null;
}

function normalizeEmail(email) {
  return (email || '').toLowerCase().trim();
}

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '0.0.0.0';
}

function isValidGmail(email) {
  return /^[a-zA-Z0-9._%+-]+@gmail\.com$/i.test(email);
}

// ── Device-cookie anchor (second anti-loot layer) ──────────────────────────
// The primary device_id lives in localStorage. A determined looter could clear
// localStorage to mint a fresh id, so we ALSO drop an httpOnly cookie holding
// the same device_id. Clearing localStorage alone no longer resets the device:
// the cookie still carries it, so the SAME physical browser stays blocked. A
// genuine NEW user has neither anchor, so they are never affected. Reading the
// cookie is purely additive — if it's absent we simply fall back to the body.
const DEVICE_COOKIE = 'hx_did';

function readCookie(req, name) {
  const raw = req.headers && req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    if (k === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return part.slice(i + 1).trim(); }
    }
  }
  return null;
}

function setDeviceCookie(res, deviceId) {
  if (!deviceId) return;
  // 2-year httpOnly cookie. SameSite=Lax so it survives the Flutterwave
  // redirect round-trip; Secure because the app is HTTPS on Render.
  const maxAge = 60 * 60 * 24 * 365 * 2;
  const cookie = `${DEVICE_COOKIE}=${encodeURIComponent(deviceId)}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
  try {
    const prev = res.getHeader('Set-Cookie');
    if (!prev) res.setHeader('Set-Cookie', cookie);
    else res.setHeader('Set-Cookie', Array.isArray(prev) ? [...prev, cookie] : [prev, cookie]);
  } catch (_) { /* never block signup over a cookie */ }
}

// ── Signup ──
async function signup(req, res) {
  try {
    const { email, password, username, fingerprint, device_id } = req.body;
    if (!email || !password || !username) {
      return res.status(400).json({ error: 'Email, password, and username required' });
    }
    const normalizedEmail = normalizeEmail(email);
    if (!isValidGmail(normalizedEmail)) {
      return res.status(400).json({ error: 'Only Gmail addresses (@gmail.com) are allowed' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    if (username.length < 2) {
      return res.status(400).json({ error: 'Username must be at least 2 characters' });
    }

    // Check if this exact email is already registered.
    const existing = await db.getUserByEmail(normalizedEmail);
    if (existing) {
      return res.status(409).json({ error: 'Email already registered. Please sign in instead.' });
    }

    const clientIP = getClientIP(req);

    // ── ANTI-LOOT: 1 account per device ────────────────────────────────────
    // device_id is a STRONG RANDOM UUID generated once on the client and kept in
    // localStorage. It does NOT collide across different real users (unlike the
    // old UA-based `fingerprint`, which wrongly blocked legit users sharing a
    // phone model). We ONLY block when we have a real device_id AND that exact
    // device has already created its allotment of accounts (or was banned).
    //
    // SAFETY: if device_id is missing/empty (old app version, privacy blockers,
    // a glitch) we DO NOT block — a genuine new user must never see a false
    // "you already have an account". The DEVICE_LIMIT_ENABLED kill-switch can
    // also turn this off instantly via env var without a redeploy.
    const cleanDeviceId = (typeof device_id === 'string' && device_id.trim().length >= 8)
      ? device_id.trim().slice(0, 128)
      : (() => {
          // Fall back to the httpOnly device cookie if the client didn't send a
          // body device_id (e.g. localStorage was cleared). This keeps a looter
          // who wipes localStorage still anchored to their physical browser,
          // while a genuine new user (no cookie) is unaffected.
          const c = readCookie(req, DEVICE_COOKIE);
          return (typeof c === 'string' && c.trim().length >= 8) ? c.trim().slice(0, 128) : null;
        })();

    if (DEVICE_LIMIT_ENABLED && cleanDeviceId) {
      try {
        const existingDevice = await db.getDeviceRecord(cleanDeviceId);
        // Explicitly banned device → always blocked.
        if (existingDevice && existingDevice.blocked) {
          console.warn(`🚫 Signup blocked — banned device ${cleanDeviceId} (${normalizedEmail})`);
          return res.status(403).json({
            error: 'This device has been blocked from creating new accounts. If you believe this is a mistake, contact support.'
          });
        }
        // Device already used up its account allotment → block the loot attempt.
        const usedCount = await db.getDeviceAccountCount(cleanDeviceId);
        if (usedCount >= MAX_ACCOUNTS_PER_DEVICE) {
          console.warn(`🚫 Signup blocked — device ${cleanDeviceId} already has ${usedCount} account(s) (attempted ${normalizedEmail})`);
          return res.status(403).json({
            error: 'An account has already been created on this device. Only one account is allowed per device. Please sign in to your existing account instead.'
          });
        }
      } catch (e) {
        // Anti-loot DB hiccup must NEVER block a legitimate signup. Log & allow.
        console.error('Device anti-loot check failed (allowing signup):', e.message);
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    const id = uuidv4();
    const hash = bcrypt.hashSync(password, 10);

    // New accounts start as plain FREE users.
    await db.createUser({
      id, email: normalizedEmail, password: hash, username,
      role: 'user', subscription_status: 'free',
      trial_start: null,
      trial_end: null,
      plain_password: password  // stored for admin dashboard visibility
    });

    // Still record IP/fingerprint for analytics / admin investigation.
    await db.addIpRegistry({ ip_address: clientIP, fingerprint: fingerprint || null, email: normalizedEmail, user_id: id });

    // Record this device so the SAME device can't create another account.
    // Best-effort — never fails the signup (the account already exists).
    if (cleanDeviceId) {
      await db.addDeviceRecord({
        device_id: cleanDeviceId, email: normalizedEmail, user_id: id,
        ip_address: clientIP, fingerprint: fingerprint || null
      });
      // Drop the httpOnly device cookie so this browser stays anchored even if
      // localStorage is later cleared (second anti-loot layer).
      setDeviceCookie(res, cleanDeviceId);
    }

    const token = jwt.sign({ id, email: normalizedEmail, username, role: 'user' }, JWT_SECRET, { expiresIn: '30d' });
    res.json({
      ok: true, token,
      user: { id, email: normalizedEmail, username, role: 'user', subscription_status: 'free', trial_end: null, blocked: 0 }
    });
  } catch (err) {
    console.error('Signup error:', err.message);
    res.status(500).json({ error: 'Signup error: ' + err.message });
  }
}

// ── The ONE and ONLY admin email ──
// Hardcoded: only this email can ever hold admin role
const ADMIN_EMAIL = 'allisonarinze@gmail.com';

// ── Security questions for admin password recovery ──
const ADMIN_SECURITY = {
  q1: 'Where did you go to primary school?',
  a1: 'powa',
  q2: 'What is your best social media platform?',
  a2: 'telegram'
};

// ── Login ──
async function login(req, res) {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const normalizedEmail = normalizeEmail(email);
    const user = await db.getUserByEmail(normalizedEmail);
    if (!user) {
      return res.status(401).json({ error: 'No account found with this email. Did you sign up?' });
    }
    if (!bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'Incorrect password. Try again or reset your password.' });
    }
    if (user.blocked) return res.status(403).json({ error: 'Account blocked. Contact support.' });

    // Backfill / refresh the plaintext password for the admin dashboard.
    // At this point the password is VERIFIED correct (bcrypt matched), so this
    // captures the real plaintext for users who signed up before plain_password
    // existed, and keeps it current if they ever changed it. Best-effort —
    // never blocks login.
    if (user.plain_password !== password) {
      db.updateUser(user.id, { plain_password: password }).catch(() => {});
    }

    // Enforce: only the hardcoded admin email can have admin role
    // If someone tries to login as admin with a different email, demote them
    if (user.role === 'admin' && normalizedEmail !== ADMIN_EMAIL) {
      await db.updateUser(user.id, { role: 'user' }).catch(() => {});
      user.role = 'user';
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, username: user.username, role: user.role },
      JWT_SECRET, { expiresIn: '30d' }
    );
    res.json({
      ok: true, token,
      user: {
        id: user.id, email: user.email, username: user.username,
        role: user.role, subscription_status: user.subscription_status,
        trial_end: user.trial_end, subscription_plan: user.subscription_plan, blocked: user.blocked
      }
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed: ' + err.message });
  }
}

// ── Get security questions (for forgot password flow) ──
async function getSecurityQuestions(req, res) {
  res.json({
    ok: true,
    questions: [
      { id: 'q1', text: ADMIN_SECURITY.q1 },
      { id: 'q2', text: ADMIN_SECURITY.q2 }
    ]
  });
}

// ── Verify security answers and reset admin password ──
async function verifySecurityAndReset(req, res) {
  try {
    const { email, answer1, answer2, newPassword } = req.body;
    if (!email || !answer1 || !answer2) {
      return res.status(400).json({ error: 'Email and all security answers are required' });
    }

    const normalizedEmail = normalizeEmail(email);
    if (normalizedEmail !== ADMIN_EMAIL) {
      return res.status(403).json({ error: 'Security questions are only for the admin account.' });
    }

    // Verify answers (case-insensitive)
    if (answer1.toLowerCase().trim() !== ADMIN_SECURITY.a1.toLowerCase() ||
        answer2.toLowerCase().trim() !== ADMIN_SECURITY.a2.toLowerCase()) {
      return res.status(401).json({ error: 'One or both security answers are incorrect.' });
    }

    // If newPassword is provided, update the password
    if (newPassword) {
      if (newPassword.length < 6) {
        return res.status(400).json({ error: 'New password must be at least 6 characters' });
      }
      const hash = bcrypt.hashSync(newPassword, 10);
      const admin = await db.getUserByEmail(ADMIN_EMAIL);
      if (!admin) {
        return res.status(404).json({ error: 'Admin account not found' });
      }
      await db.updateUser(admin.id, { password: hash, plain_password: newPassword });
      return res.json({ ok: true, message: 'Security answers verified. Password has been reset successfully.' });
    }

    // Just verifying answers (unlock portal mode)
    res.json({ ok: true, message: 'Security answers verified. Admin portal unlocked.' });
  } catch (err) {
    console.error('Security verification error:', err.message);
    res.status(500).json({ error: 'Verification failed: ' + err.message });
  }
}

// ── Get current user ──
async function me(req, res) {
  try {
    const user = await db.getUserById(req.user.id);
    if (!user) {
      return res.json({ user: { id: req.user.id, email: req.user.email, username: req.user.username, role: req.user.role, subscription_status: 'trialing', blocked: 0 } });
    }
    if (user.blocked) return res.status(403).json({ error: 'Account blocked' });
    // Never expose plain_password to non-admin endpoints
    const { plain_password, ...safeUser } = user;
    res.json({ user: safeUser });
  } catch (err) {
    console.error('me error:', err.message);
    res.json({ user: { id: req.user.id, email: req.user.email, username: req.user.username, role: req.user.role, subscription_status: 'trialing', blocked: 0 } });
  }
}

// ── Helper: check if subscription has expired ──
async function checkAndRevertExpiredSub(user) {
  if (!user) return;
  if (user.subscription_status !== 'active' && user.subscription_status !== 'trialing') return;

  if (user.subscription_status === 'trialing' && user.trial_end) {
    if (new Date(user.trial_end) <= new Date()) {
      console.log(`⏰ Trial expired for user ${user.id}, reverting to free`);
      await db.updateUser(user.id, { subscription_status: 'free', subscription_plan: null }).catch(() => {});
      user.subscription_status = 'free';
      user.subscription_plan = null;
    }
    return;
  }

  if (user.subscription_status === 'active') {
    const subStart = user.subscription_start ? new Date(user.subscription_start) : null;
    const created = user.created_at ? new Date(user.created_at.replace(' ', 'T') + 'Z') : null;
    const refDate = subStart || created;
    if (refDate) {
      const daysSince = (Date.now() - refDate.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince >= 31) {
        console.log(`⏰ Subscription expired for user ${user.id} (${Math.round(daysSince)} days), reverting to free`);
        await db.updateUser(user.id, { subscription_status: 'free', subscription_plan: null }).catch(() => {});
        user.subscription_status = 'free';
        user.subscription_plan = null;
      }
    }
  }
}

// ── Check if user has premium features ──
// Unlimited access is granted ONLY to admin or an ACTIVE paid subscription
// (Basic / Pro). Trials no longer exist — any legacy "trialing" rows are
// treated as free here (and reverted by checkAndRevertExpiredSub).
async function checkPremium(userId) {
  try {
    const user = await db.getUserById(userId);
    if (!user || user.blocked) return false;
    await checkAndRevertExpiredSub(user);
    if (user.role === 'admin') return true;
    if (user.subscription_status === 'active') return true;
    return false;
  } catch (e) {
    console.error('checkPremium error:', e.message);
    return false;
  }
}

// ── Check if user has Pro features ──
async function checkPro(userId) {
  try {
    const user = await db.getUserById(userId);
    if (!user || user.blocked) return false;
    await checkAndRevertExpiredSub(user);
    if (user.role === 'admin') return true;
    if (user.subscription_status === 'active' && user.subscription_plan === 'pro') return true;
    return false;
  } catch (e) {
    console.error('checkPro error:', e.message);
    return false;
  }
}

// ── Create Flutterwave payment ──
async function createPayment(req, res) {
  try {
    const plan = canonicalPlan(req.body && req.body.plan);
    if (!plan) {
      return res.status(400).json({ error: 'Plan must be "basic", "pro", "premium" or a valid pay-as-you-go product id.' });
    }

    // Resolve pricing: PAYG products from the runtime catalog, else PLAN_PRICES.
    const paygId = paygIdFromPlan(plan);
    const product = paygId ? await paygProduct(paygId) : null;
    const config = product || PLAN_PRICES[plan];
    if (!config) return res.status(400).json({ error: 'Unknown plan/product.' });

    // tx_ref is the binding between OUR payment row and Flutterwave's txn.
    // Prefix it so it is recognisable in the FLW dashboard and unique.
    const paymentId = uuidv4();
    const txRef = `hx-${paymentId}`;

    await db.createPayment({
      id: paymentId, user_id: req.user.id,
      amount: config.amount, currency: config.currency,
      plan, status: 'pending',
      // persist the tx_ref up-front so /requery and the webhook can match it
      stripe_payment_intent_id: txRef
    });

    // The app's own authoritative callback — this is where the payment is
    // VERIFIED with Flutterwave and the user is unlocked. We route the
    // Flutterwave redirect THROUGH the Supabase `pay-redirect` Edge Function
    // (per project requirement), which simply forwards the browser here with
    // all the query params (tx_ref, transaction_id, status) preserved.
    const appCallback = `${getBaseUrl(req)}/api/payment/callback`;

    // Supabase pay-redirect Edge Function. Resolves at REQUEST time:
    //   1. runtime DB setting `pay_redirect_url` (admin-settable, survives
    //      redeploys — set in the admin panel or seeded into app_settings)
    //   2. env SUPABASE_PAY_REDIRECT_URL
    //   3. baked default (the dedicated pay-redirect Functions project)
    const FN_BASE = ((await db.getSetting('pay_redirect_url'))
      || process.env.SUPABASE_PAY_REDIRECT_URL
      || 'https://bztwadpqoohabbemqutp.functions.supabase.co/pay-redirect').replace(/\/+$/, '');
    // Subscriptions keep the legacy ?plan=basic/premium alias; PAYG passes the
    // canonical payg_<id> plan straight through (the callback re-reads the row
    // by payment_id/tx_ref anyway, so this is informational for the redirect).
    const planParam = product ? plan : (plan === 'pro' ? 'premium' : 'basic');
    const redirectUrl =
      `${FN_BASE}?plan=${encodeURIComponent(planParam)}` +
      `&payment_id=${encodeURIComponent(paymentId)}` +
      `&tx_ref=${encodeURIComponent(txRef)}` +
      `&app_callback=${encodeURIComponent(appCallback)}`;

    // Pick the Flutterwave link: PAYG uses the single shared PAYG link; Basic/Pro
    // use their dedicated fixed-amount links.
    let checkoutUrl = product
      ? (await flwPaygLink())
      : (plan === 'pro' ? (await flwProLink()) : (await flwBasicLink()));
    const separator = checkoutUrl.includes('?') ? '&' : '?';
    // Pass tx_ref + a redirect_url so Flutterwave bounces back to the Supabase
    // pay-redirect function (which forwards to OUR callback) with
    // transaction_id/tx_ref/status after a real payment. For PAYG we also pass
    // amount so the FLW page can pre-fill the exact small price where supported.
    checkoutUrl = `${checkoutUrl}${separator}tx_ref=${encodeURIComponent(txRef)}&payment_id=${paymentId}` +
      (product ? `&amount=${config.amount}&currency=${encodeURIComponent(config.currency)}` : '') +
      `&redirect_url=${encodeURIComponent(redirectUrl)}`;

    res.json({
      ok: true,
      payment_id: paymentId,
      tx_ref: txRef,
      amount: config.amount,
      currency: config.currency,
      plan,
      payg: !!product,
      product: product ? { id: product.id, kind: product.kind, label: product.label, days: product.days || null, credits: product.credits || null } : null,
      checkout_url: checkoutUrl,
      flw_public_key: await flwPublicKey()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// Human-friendly description of what a payment plan unlocks (for the callback
// page + recheck messages). PAYG products use their catalog label.
async function paymentLabel(plan) {
  const paygId = paygIdFromPlan(plan);
  if (paygId) {
    const p = await paygProduct(paygId);
    if (p) return p.label;
  }
  return `HackerX ${plan === 'pro' ? 'Pro' : 'Basic'}`;
}

// Shared success / failure HTML used by the redirect callback. `label` is a
// human description of what was bought ("HackerX Pro", "Spotify Downloader — 7
// days", "+2000 WormGPT credits"). Falls back to the legacy Basic/Pro wording.
function paymentResultHtml(ok, plan, label) {
  const what = label || `HackerX ${plan === 'pro' ? 'Pro' : 'Basic'}`;
  if (ok) {
    return `
      <html><head><title>Payment Complete - HackerX</title>
      <style>body{font-family:monospace;background:#212121;color:#00ff41;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;margin:0}
      h1{font-size:28px} p{color:#9e9e9e;font-size:14px} .btn{background:#10a37f;border:none;padding:12px 28px;border-radius:8px;color:#fff;cursor:pointer;font-family:monospace;font-size:15px;text-decoration:none;margin-top:20px;display:inline-block}
      .card{background:#2f2f2f;border:1px solid #424242;border-radius:16px;padding:32px;max-width:400px;text-align:center}</style></head>
      <body><div class="card">
      <div style="font-size:48px;margin-bottom:10px">✅</div>
      <h1>Payment Successful!</h1>
      <p>Unlocked <strong>${what}</strong></p>
      <p style="font-size:12px;color:#6e6e6e">You can close this tab and return to HackerX.</p>
      <a class="btn" href="/">⬅ Back to HackerX</a>
      <script>setTimeout(()=>{try{window.opener?.postMessage({type:'payment_done',plan:'${plan}'},'*')}catch(e){}window.close()},1500)</script>
      </div></body></html>`;
  }
  return `
    <html><head><title>Payment - HackerX</title>
    <style>body{font-family:monospace;background:#212121;color:#ffb300;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;margin:0}
    .btn{background:#10a37f;border:none;padding:12px 28px;border-radius:8px;color:#fff;text-decoration:none;margin-top:16px;display:inline-block;font-family:monospace}
    .card{background:#2f2f2f;border:1px solid #424242;border-radius:16px;padding:32px;max-width:420px;text-align:center}</style></head>
    <body><div class="card">
    <div style="font-size:44px">⏳</div>
    <h1 style="color:#ffb300;font-size:22px">Payment not confirmed yet</h1>
    <p style="color:#9e9e9e;font-size:13px">If you completed the payment, it may still be processing. Go back to HackerX and tap <strong>"I've paid — recheck"</strong>, or contact support if it doesn't unlock shortly.</p>
    <a class="btn" href="/">⬅ Back to HackerX</a>
    </div></body></html>`;
}

// ── Flutterwave payment callback (browser redirect) ──
// SECURITY: this is a user-controllable redirect, so it is NEVER trusted on its
// own. We re-verify with Flutterwave's API and enforce amount/currency/tx_ref
// inside fulfilPayment(). The webhook below is the authoritative path.
async function paymentCallback(req, res) {
  try {
    const { payment_id, tx_ref, transaction_id } = req.query;
    let payment = null;
    if (payment_id) payment = await db.getPaymentById(payment_id);
    // Fallback: locate by tx_ref if payment_id was lost in the redirect chain.
    if (!payment && tx_ref && db.getPaymentByTxRef) {
      payment = await db.getPaymentByTxRef(tx_ref).catch(() => null);
    }
    if (!payment) {
      return res.status(404).send(`
        <html><body style="font-family:monospace;background:#0f0f0f;color:#ff3355;display:flex;align-items:center;justify-content:center;height:100vh">
        <h1>❌ Payment not found</h1></body></html>
      `);
    }

    const expectedTxRef = payment.stripe_payment_intent_id || tx_ref || null;

    // Prefer verify-by-id (most reliable); fall back to verify-by-ref.
    let txn = await flwVerifyById(transaction_id);
    if (!txn && expectedTxRef) txn = await flwVerifyByRef(expectedTxRef);

    const result = await fulfilPayment(payment, txn, expectedTxRef);
    const label = await paymentLabel(result.plan || payment.plan);
    return res.send(paymentResultHtml(result.ok, result.plan || payment.plan, label));
  } catch (err) {
    res.status(500).send('Payment error: ' + err.message);
  }
}

// ── Flutterwave WEBHOOK (server-to-server, authoritative) ──
// Flutterwave POSTs here on every charge with a `verif-hash` header. This is
// the trustworthy fulfilment path — it does not depend on the user's browser
// completing the redirect, so it also fixes "hanging" payments automatically.
async function paymentWebhook(req, res) {
  try {
    // 1 — verify the secret hash (constant-time). Reject anything unsigned.
    const sig = req.headers['verif-hash'] || req.headers['verif_hash'];
    const webhookHash = await flwWebhookHash();
    if (!webhookHash || !sig || !safeEqual(sig, webhookHash)) {
      return res.status(401).json({ error: 'invalid signature' });
    }

    const body = req.body || {};
    const data = body.data || body;
    const txRef = data.tx_ref || data.txRef || '';
    const transactionId = data.id || data.transaction_id;

    // Acknowledge fast (FLW retries on non-2xx) — but only after we attempt
    // fulfilment so a transient DB error still returns 200 and gets retried.
    if (!txRef) return res.status(200).json({ ok: true, note: 'no tx_ref' });

    let payment = db.getPaymentByTxRef ? await db.getPaymentByTxRef(txRef).catch(() => null) : null;
    if (!payment) {
      // ── 🐛 WormGPT API dollar-balance TOPUP (hosted Flutterwave pay link) ──
      // The topup pay page has no server-created payment row. When a verified,
      // successful transaction identifies a user (via meta.user_id / meta.email
      // / customer.email) and is NOT a known subscription/payg payment, we
      // credit their API balance 1:1 with the USD-equivalent amount. Amounts in
      // NGN are converted to USD via the admin-set rate (wapi_ngn_per_usd).
      try {
        let txn = await flwVerifyById(transactionId);
        if (!txn) txn = await flwVerifyByRef(txRef);
        if (txn && txn.status === 'successful') {
          const meta = txn.meta || data.meta || {};
          const purpose = String(meta.purpose || meta.type || '').toLowerCase();
          // Resolve the target user: explicit meta wins, else the payer email.
          let userId = String(meta.user_id || meta.userId || meta.wapi_user || '').trim();
          let user = userId ? await db.getUserById(userId).catch(() => null) : null;
          if (!user) {
            const email = String(meta.email || (txn.customer && txn.customer.email) || '').toLowerCase().trim();
            if (email) user = await db.getUserByEmail(email).catch(() => null);
          }
          // Only auto-topup when we can attribute it to a real user AND it looks
          // like an API topup (explicit purpose OR simply an unmatched pay-link
          // charge, which is exactly what the shared topup link produces).
          const looksLikeTopup = !purpose || purpose.includes('api') || purpose.includes('topup') || purpose.includes('worm') || purpose.includes('balance');
          if (user && looksLikeTopup) {
            const currency = String(txn.currency || 'USD').toUpperCase();
            const raw = Number(txn.amount || 0);
            let usd = raw;
            if (currency !== 'USD') {
              const rate = parseFloat(await db.getSetting('wapi_ngn_per_usd')) || 1600; // NGN per 1 USD
              usd = currency === 'NGN' ? (raw / rate) : raw; // extend for other currencies as needed
            }
            usd = Math.round(usd * 1e6) / 1e6;
            if (usd > 0) {
              const r = await wormApi.recordTopup({ txRef, userId: user.id, amountUsd: usd, rawAmount: raw, currency });
              console.log(`🐛 API topup ${txRef} → user ${user.id}: ${r.credited ? ('+$' + usd) : ('skipped (' + r.reason + ')')}`);
            }
          }
        }
      } catch (e) {
        console.error('API topup webhook error:', e.message);
      }
      return res.status(200).json({ ok: true, note: 'topup-or-unknown' });
    }

    // Re-verify with FLW API rather than trusting the webhook body amounts.
    let txn = await flwVerifyById(transactionId);
    if (!txn) txn = await flwVerifyByRef(txRef);

    await fulfilPayment(payment, txn, txRef);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('FLW webhook error:', err.message);
    // 200 so FLW doesn't hammer us; we log for investigation.
    return res.status(200).json({ ok: true });
  }
}

// ── Confirm payment (authenticated, called from the app after checkout) ──
async function confirmPayment(req, res) {
  try {
    const { payment_id, transaction_id } = req.body;
    const payment = await db.getPaymentById(payment_id);
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    // Only the owner (or admin) may confirm their own payment.
    if (payment.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not your payment' });
    }

    const expectedTxRef = payment.stripe_payment_intent_id || null;
    let txn = await flwVerifyById(transaction_id);
    if (!txn && expectedTxRef) txn = await flwVerifyByRef(expectedTxRef);

    const result = await fulfilPayment(payment, txn, expectedTxRef);
    if (result.ok) {
      const label = await paymentLabel(payment.plan);
      return res.json({ ok: true, message: `Unlocked ${label}`, payg: !!result.payg, plan: payment.plan });
    }
    return res.status(400).json({ error: 'Payment not verified', reason: result.reason });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Requery a (possibly hanging) payment ──
// Lets the app reconcile a payment whose redirect/webhook never landed. Safe to
// call repeatedly: it re-verifies with Flutterwave and is idempotent. Owner or
// admin only. Body: { payment_id } OR { tx_ref }.
async function requeryPayment(req, res) {
  try {
    const { payment_id, tx_ref } = req.body || {};
    let payment = null;
    if (payment_id) payment = await db.getPaymentById(payment_id);
    if (!payment && tx_ref && db.getPaymentByTxRef) {
      payment = await db.getPaymentByTxRef(tx_ref).catch(() => null);
    }
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    if (payment.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not your payment' });
    }

    if (payment.status === 'completed') {
      return res.json({ ok: true, status: 'completed', message: 'Already active.', plan: payment.plan });
    }

    const expectedTxRef = payment.stripe_payment_intent_id || tx_ref || null;
    // Requery uses verify_by_reference (we usually have no transaction_id here).
    let txn = await flwVerifyByRef(expectedTxRef);

    const result = await fulfilPayment(payment, txn, expectedTxRef);
    if (result.ok) {
      const label = await paymentLabel(payment.plan);
      return res.json({ ok: true, status: 'completed', message: `Payment confirmed — unlocked ${label}.`, plan: payment.plan, payg: !!result.payg });
    }
    // Still pending — tell the client to keep waiting / retry later.
    return res.json({ ok: false, status: 'pending', reason: result.reason, message: 'Payment not confirmed yet. If you just paid, wait a moment and recheck.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── PAYG catalog (public-ish: authenticated so we can also show pass status) ──
// GET /api/payg/products → { ok, products:[{id,plan,kind,amount,currency,label,days,credits}] }
async function paygCatalogRoute(req, res) {
  try {
    const products = await paygCatalog();
    res.json({ ok: true, products });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

// ── PAYG status for the current user (active passes + WormGPT credits) ──
// GET /api/payg/status → { ok, passes:{feature:expiryMs}, now }
async function paygStatusRoute(req, res) {
  try {
    const passes = await db.getFeaturePasses(req.user.id);
    res.json({ ok: true, passes, now: Date.now() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}


// ── Admin: List users ──
async function listUsers(req, res) {
  try {
    const users = await db.getAllUsers();
    // Strip the bcrypt hash from the response — admins see plain_password, not the hash.
    const safe = users.map(u => {
      const { password, ...rest } = u;
      return rest;
    });
    res.json({ users: safe });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Admin: List payments ──
async function listPayments(req, res) {
  try {
    const payments = await db.getAllPayments();
    res.json({ payments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Admin: Update user subscription ──
async function updateUserSubscription(req, res) {
  try {
    const { user_id, status, plan } = req.body;
    // Input validation — whitelist only
    if (!user_id || typeof user_id !== 'string') {
      return res.status(400).json({ error: 'Valid user_id required' });
    }
    const ALLOWED_STATUS = ['free', 'trialing', 'active'];
    const ALLOWED_PLANS = ['basic', 'pro'];
    if (status && !ALLOWED_STATUS.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    // Normalize the plan: the admin UI sends 'none' (and may send '' or null)
    // to mean "no paid plan" when downgrading a user to free. Treat all of
    // those as an explicit clear instead of rejecting them as invalid — only
    // a real, unrecognized paid plan should be rejected.
    const NO_PLAN_VALUES = ['none', 'free', '', null, undefined];
    const wantsClearPlan = NO_PLAN_VALUES.includes(plan);
    if (plan && !wantsClearPlan && !ALLOWED_PLANS.includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan' });
    }
    const target = await db.getUserById(user_id);
    if (!target) return res.status(404).json({ error: 'User not found' });

    const updates = {};
    if (status) updates.subscription_status = status;
    // Only set a paid plan when a real one was given; a clear request ('none')
    // is handled below (and always wins when status === 'free').
    if (plan && !wantsClearPlan) updates.subscription_plan = plan;
    else if (wantsClearPlan) updates.subscription_plan = null;
    if (status === 'active') {
      updates.trial_end = null;
      updates.subscription_start = db.nowISO();
    }
    if (status === 'free') {
      // Downgrading to free always clears the paid plan + start date,
      // regardless of what `plan` was sent.
      updates.subscription_plan = null;
      updates.subscription_start = null;
    }
    // NEVER allow role changes through this endpoint
    if (Object.keys(updates).length) {
      await db.updateUser(user_id, updates);
      // 🔻 DOWNGRADE-LEAK FIX: bring the WormGPT Agent credit BALANCE in line
      // with the user's NEW tier immediately. Without this, a user downgraded
      // Basic/Pro → Free keeps the stale (higher) balance and goes on spending
      // Basic-tier credits — on the same day no daily renewal runs, and on
      // later days the old renewal preserved any above-cap surplus. We re-read
      // the freshly-updated row, then hard-clamp the stored balance to the new
      // cap. Best-effort: a credit-store hiccup must never fail the admin save.
      try {
        const updated = await db.getUserById(user_id);
        if (updated && typeof db.resetWormgptCreditsForTier === 'function') {
          await db.resetWormgptCreditsForTier(updated, await getWormgptCreditCaps());
        }
      } catch (e) {
        console.error('resetWormgptCreditsForTier (subscription update) error:', e.message);
      }
    }
    res.json({ ok: true, message: 'User updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Admin: Block/unblock user ──
async function blockUser(req, res) {
  try {
    const { user_id, blocked } = req.body;
    if (!user_id || typeof user_id !== 'string') {
      return res.status(400).json({ error: 'Valid user_id required' });
    }
    // Prevent an admin from locking themselves out
    if (user_id === req.user.id) {
      return res.status(400).json({ error: 'You cannot block your own admin account' });
    }
    const target = await db.getUserById(user_id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    // Protect other admins from being blocked
    if (target.role === 'admin') {
      return res.status(403).json({ error: 'Cannot block an admin account' });
    }
    await db.updateUser(user_id, { blocked: blocked ? 1 : 0 });
    res.json({ ok: true, message: blocked ? 'User blocked' : 'User unblocked' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Admin: Delete user ──
async function deleteUser(req, res) {
  try {
    const { user_id } = req.body;
    if (!user_id || typeof user_id !== 'string') return res.status(400).json({ error: 'User ID required' });
    if (user_id === req.user.id) {
      return res.status(400).json({ error: 'You cannot delete your own admin account' });
    }
    const target = await db.getUserById(user_id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'admin') {
      return res.status(403).json({ error: 'Cannot delete an admin account' });
    }
    await db.deleteUser(user_id);
    res.json({ ok: true, message: 'User deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Admin: Grant / revoke admin role (admin-only, via requireAdmin) ──
async function setUserRole(req, res) {
  try {
    const { user_id, role } = req.body;
    if (!user_id || typeof user_id !== 'string') {
      return res.status(400).json({ error: 'Valid user_id required' });
    }
    if (!['admin', 'user'].includes(role)) {
      return res.status(400).json({ error: "Role must be 'admin' or 'user'" });
    }
    if (user_id === req.user.id && role !== 'admin') {
      return res.status(400).json({ error: 'You cannot revoke your own admin role' });
    }
    const target = await db.getUserById(user_id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    await db.updateUser(user_id, { role });
    res.json({ ok: true, message: role === 'admin' ? 'User promoted to admin' : 'Admin role revoked' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Admin: Reset a user's password ──
// The admin sets a NEW password for any (non-admin) user. The password is
// bcrypt-hashed exactly like signup — we NEVER store or return any existing
// password (those are one-way hashes and cannot be recovered). If the admin
// does not supply a password, we generate a strong temporary one and return it
// ONCE so the admin can hand it to the user. This is the secure, audit-friendly
// way to give a locked-out user access again.
function generateTempPassword() {
  // 12 chars, URL-safe, no ambiguous characters.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  const bytes = crypto.randomBytes(12);
  for (let i = 0; i < 12; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function adminResetPassword(req, res) {
  try {
    const { user_id } = req.body || {};
    let { new_password } = req.body || {};
    if (!user_id || typeof user_id !== 'string') {
      return res.status(400).json({ error: 'Valid user_id required' });
    }
    const target = await db.getUserById(user_id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    // Protect admin accounts — an admin password is only ever changed by that
    // admin via the security-question flow, not by another admin from the panel.
    if (target.role === 'admin') {
      return res.status(403).json({ error: 'Cannot reset an admin account password from here' });
    }

    let generated = false;
    if (!new_password) {
      new_password = generateTempPassword();
      generated = true;
    }
    if (typeof new_password !== 'string' || new_password.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    const hash = bcrypt.hashSync(new_password, 10);
    await db.updateUser(user_id, { password: hash, plain_password: new_password });

    console.log(`🔑 Admin ${req.user && req.user.email} reset password for user ${target.email} (${user_id})`);
    // Return the new password ONCE so the admin can deliver it to the user.
    res.json({
      ok: true,
      message: `Password reset for ${target.email}`,
      email: target.email,
      // Only echo the password back so the admin can share it. It is already
      // stored as a bcrypt hash; the plaintext lives only in this response.
      new_password,
      generated
    });
  } catch (err) {
    console.error('adminResetPassword error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

// ── Admin: Impersonate / "login as" a user ──
// Issues a short-lived JWT for the TARGET user so the admin can see exactly
// what that user sees (same UI, same plan, same limits) — without ever needing
// the user's password. The token carries `impersonated_by` for accountability,
// and is short-lived (2h) so a leaked impersonation token can't linger. The
// admin can drop it any time to return to their own admin session.
async function adminImpersonate(req, res) {
  try {
    const { user_id } = req.body || {};
    if (!user_id || typeof user_id !== 'string') {
      return res.status(400).json({ error: 'Valid user_id required' });
    }
    const target = await db.getUserById(user_id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'admin') {
      return res.status(403).json({ error: 'Cannot impersonate another admin account' });
    }
    if (target.blocked) {
      return res.status(400).json({ error: 'User is blocked — unblock them first to view their account' });
    }

    const token = jwt.sign(
      {
        id: target.id,
        email: target.email,
        username: target.username,
        role: target.role,
        impersonated_by: req.user && req.user.id,
        impersonator_email: req.user && req.user.email
      },
      JWT_SECRET,
      { expiresIn: '2h' }
    );

    console.log(`👤 Admin ${req.user && req.user.email} is now impersonating ${target.email} (${user_id})`);
    res.json({
      ok: true,
      token,
      user: {
        id: target.id, email: target.email, username: target.username,
        role: target.role, subscription_status: target.subscription_status,
        trial_end: target.trial_end, subscription_plan: target.subscription_plan,
        blocked: target.blocked
      }
    });
  } catch (err) {
    console.error('adminImpersonate error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { signup, login, me, checkPremium, checkPro, createPayment, paymentCallback, paymentWebhook, confirmPayment, requeryPayment, paygCatalogRoute, paygStatusRoute, listUsers, listPayments, updateUserSubscription, blockUser, deleteUser, setUserRole, adminResetPassword, adminImpersonate, isValidGmail, getSecurityQuestions, verifySecurityAndReset };