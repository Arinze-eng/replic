// Proves the "admin can't top up after downgrade" fix end-to-end against the
// LIVE Supabase, for the reported user resistordiode424@gmail.com.
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY before running this live integration test');
}

const db = require('../db');

// admin-configured caps that match the live app_settings (free cap = 400)
const caps = { free: 400, basic: 5000 };

(async () => {
  const user = await db.getUserByEmail('resistordiode424@gmail.com');
  if (!user) { console.error('user not found'); process.exit(1); }
  console.log('User:', user.id, 'status=', user.subscription_status, 'plan=', user.subscription_plan, 'role=', user.role);

  // The user is currently FREE (downgraded). Treat as Free.
  const freeUser = { ...user, subscription_status: 'free', subscription_plan: null, role: 'user' };

  // 1) Simulate the downgrade reset (what happens when admin saves the user as free)
  await db.resetWormgptCreditsForTier(freeUser, caps);
  let st = await db.ensureWormgptCredits(freeUser, caps);
  console.log('After downgrade reset      -> balance', st.balance, 'cap', st.cap, '(expected ~400)');

  // 2) Admin TOPS UP to 3000 via op=set
  let bal = await db.setWormgptCredits(user.id, 3000);
  console.log('After admin SET 3000       -> stored', bal);
  st = await db.ensureWormgptCredits(freeUser, caps);
  console.log('Read back after SET        -> balance', st.balance, '(expected 3000, NOT clamped to 400)');
  const setOk = st.balance === 3000;

  // 3) Admin ADDS another 500
  bal = await db.addWormgptCredits(user.id, 500);
  console.log('After admin ADD 500        -> stored', bal);
  st = await db.ensureWormgptCredits(freeUser, caps);
  console.log('Read back after ADD        -> balance', st.balance, '(expected 3500)');
  const addOk = st.balance === 3500;

  // 4) WORST CASE: admin tops up, THEN downgrade reset runs again (e.g. expiry job
  //    or a second save). The top-up made TODAY must survive.
  await db.resetWormgptCreditsForTier(freeUser, caps);
  st = await db.ensureWormgptCredits(freeUser, caps);
  console.log('After top-up THEN downgrade-> balance', st.balance, '(expected >=3500, top-up preserved)');
  const survivesDowngrade = st.balance >= 3500;

  // 5) The user can actually USE the agent now (needs base+step ~13)
  const canUse = st.balance >= (10 + 3);
  console.log('User can run WormGPT agent -> ', canUse);

  // Restore a sane Free balance so we leave the account clean (cap).
  await db.resetWormgptCreditsForTier(freeUser, caps);
  await db.setWormgptCredits(user.id, 400);
  console.log('Restored balance to 400 (Free cap).');

  console.log('\nRESULT:',
    (setOk && addOk && survivesDowngrade && canUse) ? '✅ ALL PASS — admin top-up of a downgraded account now sticks.'
    : '❌ FAIL');
  process.exit((setOk && addOk && survivesDowngrade && canUse) ? 0 : 2);
})().catch(e => { console.error('ERR', e); process.exit(3); });
