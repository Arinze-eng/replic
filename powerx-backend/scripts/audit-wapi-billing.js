// Standalone audit/test for the WormGPT pay-as-you-go credit system.
// Runs against the live Supabase DB using the service key already in wormgptApi.js.
// It proves: (1) new prices, (2) atomic strict-charge closes the concurrency
// race, (3) insufficient-balance rejection, (4) refund path.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://hmlbprleoohibdwktdoz.supabase.co';
const wormApi = require('../services/wormgptApi');

const UID = '__audit_' + Date.now();
let failures = 0;
function assert(name, cond, extra){ if(cond){ console.log('  ✅', name); } else { console.error('  ❌', name, extra!==undefined?JSON.stringify(extra):''); failures++; } }

(async () => {
  console.log('\n=== 1) Pricing ===');
  assert('chat = $0.06',      wormApi.priceUsd('wormgpt-chat') === 0.06);
  assert('chat-pro = $0.09',  wormApi.priceUsd('wormgpt-chat-pro') === 0.09);
  assert('image = $1.00',     wormApi.priceUsd('wormgpt-image') === 1.00);
  assert('alias reasoning→pro', wormApi.priceUsd('some-reasoning-model') === 0.09);
  assert('alias image→image',   wormApi.priceUsd('cool-image-xl') === 1.00);
  assert('override applies', wormApi.priceUsd('wormgpt-chat', { 'wormgpt-chat': 0.5 }) === 0.5);

  console.log('\n=== 2) Atomic strict-charge closes the race ===');
  // Fund exactly one chat request ($0.06), then fire 10 concurrent strict charges.
  await wormApi.addBalance(UID, 0.06);
  const N = 10;
  const results = await Promise.all(
    Array.from({length:N}, () => wormApi.chargeStrict(UID, 0.06, { endpoint:'chat', model:'wormgpt-chat' }))
  );
  const ok = results.filter(r => r.ok).length;
  const insufficient = results.filter(r => r.insufficient).length;
  assert('exactly 1 of '+N+' concurrent charges succeeded', ok === 1, { ok, insufficient });
  assert('the other '+(N-1)+' were rejected as insufficient', insufficient === (N-1), { ok, insufficient });
  const bal1 = await wormApi.getBalance(UID);
  assert('balance drained to $0 (no overspend)', Math.round(bal1.balance_micro) === 0, bal1);
  assert('spent recorded = exactly $0.06', Math.round(bal1.spent_micro) === 60000, bal1);

  console.log('\n=== 3) Insufficient balance is rejected (no partial serve) ===');
  const c = await wormApi.chargeStrict(UID, 0.06, { endpoint:'chat', model:'wormgpt-chat' });
  assert('charge on empty balance → insufficient', c.ok === false && c.insufficient === true, c);
  const bal2 = await wormApi.getBalance(UID);
  assert('balance untouched at $0', Math.round(bal2.balance_micro) === 0, bal2);

  console.log('\n=== 4) Refund path (upstream failure after debit) ===');
  await wormApi.addBalance(UID, 1.00);            // fund one image
  const img = await wormApi.chargeStrict(UID, 1.00, { endpoint:'image', model:'wormgpt-image' });
  assert('image charge succeeded', img.ok === true, img);
  const midBal = await wormApi.getBalance(UID);
  assert('balance $0 after image charge', Math.round(midBal.balance_micro) === 0, midBal);
  await wormApi.refund(UID, 1.00, { endpoint:'image', model:'wormgpt-image' });  // simulate gen failure
  const afterRefund = await wormApi.getBalance(UID);
  assert('refund restored $1.00', Math.round(afterRefund.balance_micro) === 1000000, afterRefund);

  // cleanup
  try {
    const { createClient } = require('@supabase/supabase-js');
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) throw new Error('Supabase test credentials are not configured');
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth:{persistSession:false} });
    await sb.from('worm_api_usage').delete().eq('user_id', UID);
    await sb.from('worm_api_balance').delete().eq('user_id', UID);
    console.log('\n🧹 cleaned up test user', UID);
  } catch(e){ console.warn('cleanup skipped:', e.message); }

  console.log('\n=== RESULT: ' + (failures===0 ? 'ALL PASS ✅' : failures+' FAILURE(S) ❌') + ' ===\n');
  process.exit(failures===0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
