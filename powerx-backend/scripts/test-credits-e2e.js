// scripts/test-credits-e2e.js
// End-to-end test of the WormGPT Agent credit system against LIVE Supabase.
// Verifies init/renew, MODERATE draining, depletion clamp, admin top-up/set/
// reset, unlimited tiers (Pro/Admin), and the per-step cost classifier — while
// keeping live round-trips to a minimum (Supabase REST ≈ 1.2s/op).
require('dotenv').config();
const db = require('../db');

const CAPS = { free: 900, basic: 5000 };
const COSTS = { base: 10, step: 3, heavy: 6 };

const TEST_ID = 'credit-test-' + Date.now();
const freeUser = { id: TEST_ID, role: 'user', subscription_status: 'free', subscription_plan: null };
const proUser = { id: TEST_ID + '-p', role: 'user', subscription_status: 'active', subscription_plan: 'pro' };
const adminUser = { id: TEST_ID + '-a', role: 'admin', subscription_status: 'free', subscription_plan: null };

let pass = 0, fail = 0;
function ok(name, cond, extra = '') { if (cond) { pass++; console.log(`✅ ${name} ${extra}`); } else { fail++; console.log(`❌ ${name} ${extra}`); } }

// Pure cost model (matches server.js / bots): base + steps (1/3 heavy).
function taskCost(steps) {
  let c = COSTS.base;
  for (let i = 0; i < steps; i++) c += (i % 3 === 0) ? COSTS.heavy : COSTS.step;
  return c;
}

// The per-step classifier used by all callers (re-implemented identically here).
const HEAVY = new Set(['run_code','browse','web_search','deploy_render','generate_image','create_pdf']);
function creditStepCost(note, costs) {
  const n = String(note || '').toLowerCase();
  for (const t of HEAVY) if (n.includes(t)) return costs.heavy;
  return costs.step;
}

async function cleanup(id) {
  try { await db.setSetting(`wgc:bal:${id}`, ''); await db.setSetting(`wgc:day:${id}`, ''); await db.setSetting(`wgc:spent:${id}`, ''); await db.setSetting(`wgc:adminGrant:${id}`, ''); } catch (_) {}
}

(async () => {
  console.log('🪙 WormGPT Credit System — E2E (live Supabase)\n');

  // ── PURE LOGIC (no network) ──
  ok('Free cap = 900', db.wormgptCreditCap(freeUser, CAPS) === 900);
  ok('Basic cap = 5000', db.wormgptCreditCap({ id:'x', subscription_status:'active', subscription_plan:'basic' }, CAPS) === 5000);
  ok('Pro = unlimited', db.wormgptCreditCap(proUser, CAPS) === Infinity && db.wormgptCreditUnlimited(proUser));
  ok('Admin = unlimited', db.wormgptCreditUnlimited(adminUser));

  const c8 = taskCost(8);
  ok('8-step task cost is MODERATE (30–80)', c8 >= 30 && c8 <= 80, `→ ${c8} credits`);
  const freeTasks = Math.floor(900 / c8);
  ok('Free ≈ 12–30 tasks/day (8-step)', freeTasks >= 12 && freeTasks <= 30, `→ ${freeTasks} tasks`);
  const basicTasks = Math.floor(5000 / c8);
  ok('Basic ≈ 60–160 tasks/day (8-step)', basicTasks >= 60 && basicTasks <= 160, `→ ${basicTasks} tasks`);

  // small task (3 steps) cheaper, big task (25 steps) costs more — proportional.
  ok('Small 3-step task is cheap (<35)', taskCost(3) < 35, `→ ${taskCost(3)}`);
  ok('Big 25-step task costs more (>90)', taskCost(25) > 90, `→ ${taskCost(25)}`);

  ok('Heavy tool (run_code) costs heavy', creditStepCost('🧠 using run_code', COSTS) === COSTS.heavy);
  ok('Light tool (plan) costs step', creditStepCost('🧠 thinking — using plan', COSTS) === COSTS.step);

  // ── LIVE (minimal round-trips) ──
  let ec = await db.ensureWormgptCredits(freeUser, CAPS);
  ok('LIVE Free init = cap (900)', ec.balance === 900, `→ ${ec.balance}`);

  // One real base charge + one real step charge.
  const b1 = await db.chargeWormgptCredits(freeUser, COSTS.base, { caps: CAPS, reason: 'task_base' });
  const b2 = await db.chargeWormgptCredits(freeUser, COSTS.heavy, { caps: CAPS, reason: 'step' });
  ok('LIVE base -10 then heavy -6', b1 === 890 && b2 === 884, `→ ${b1}, ${b2}`);

  // Depletion clamp: charge more than balance → never negative.
  const b3 = await db.chargeWormgptCredits(freeUser, 999999, { caps: CAPS, reason: 'step' });
  ok('LIVE balance clamps at 0', b3 === 0, `→ ${b3}`);

  // Admin SET / ADD / RESET (to cap).
  ok('LIVE admin SET → 100', (await db.setWormgptCredits(freeUser.id, 100)) === 100);
  ok('LIVE admin ADD +250 → 350', (await db.addWormgptCredits(freeUser.id, 250)) === 350);
  const capReset = db.wormgptCreditCap(freeUser, CAPS);
  ok('LIVE admin RESET → cap (900)', (await db.setWormgptCredits(freeUser.id, capReset)) === 900);

  // Pro / Admin never charged.
  ok('LIVE Pro charge no-op', (await db.chargeWormgptCredits(proUser, 9999, { caps: CAPS })) === Infinity);
  ok('LIVE Admin charge no-op', (await db.chargeWormgptCredits(adminUser, 9999, { caps: CAPS })) === Infinity);

  // Lifetime spent telemetry.
  ok('LIVE lifetime spent tracked', (await db.getWormgptLifetimeSpent(freeUser.id)) > 0);

  await cleanup(freeUser.id);

  // ── 🔻 DOWNGRADE-LEAK FIX (the reported bug) ─────────────────────────────
  // Scenario: a user is Basic (5000 credit cap), spends some, then the admin
  // downgrades them to Free SAME DAY. Before the fix the stale Basic balance
  // survived (no same-day renewal) and the renewal later preserved any
  // above-cap surplus → the Free user kept spending Basic credits. After the
  // fix, the downgrade hard-clamps the balance to the Free cap immediately.
  const dgId = TEST_ID + '-dg';
  const asBasic = { id: dgId, role: 'user', subscription_status: 'active', subscription_plan: 'basic' };
  const asFree  = { id: dgId, role: 'user', subscription_status: 'free', subscription_plan: null };

  // 1) Start as Basic today → balance initialises to the Basic cap (5000).
  let dgEc = await db.ensureWormgptCredits(asBasic, CAPS);
  ok('DG: Basic init = 5000', dgEc.balance === 5000, `→ ${dgEc.balance}`);

  // 2) Spend a little as Basic.
  await db.chargeWormgptCredits(asBasic, 200, { caps: CAPS, reason: 'step' });

  // 3) Admin downgrades to Free → reset clamps the balance to the Free cap.
  const after = await db.resetWormgptCreditsForTier(asFree, CAPS);
  ok('DG: downgrade clamps balance to Free cap (900)', after.balance === 900, `→ ${after.balance}`);

  // 4) SAME-DAY re-read as Free must NOT show the old Basic balance.
  const sameDay = await db.ensureWormgptCredits(asFree, CAPS);
  ok('DG: same-day Free balance ≤ Free cap', sameDay.balance <= 900, `→ ${sameDay.balance}`);

  // 5) Simulate a NEW DAY with a stale above-cap leftover and NO admin grant:
  //    the daily-renewal backstop must clamp it down to the Free cap.
  await db.setSetting(`wgc:bal:${dgId}`, '4000');     // stale Basic leftover
  await db.setSetting(`wgc:day:${dgId}`, '2000-01-01'); // force "new day"
  await db.setSetting(`wgc:adminGrant:${dgId}`, '');    // no genuine admin grant
  const renewed = await db.ensureWormgptCredits(asFree, CAPS);
  ok('DG: stale above-cap leftover self-heals to Free cap', renewed.balance === 900, `→ ${renewed.balance}`);

  await cleanup(dgId);

  console.log(`\n──────── ${pass} passed, ${fail} failed ────────`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
