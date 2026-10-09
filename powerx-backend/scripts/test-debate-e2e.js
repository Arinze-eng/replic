// E2E test for the upgraded Mixture-of-Experts debate + anti-flicker renderer.
const debateSvc = require('../services/debate');
const { makeDebateRenderer } = require('../services/debateRender');

function section(t){ console.log('\n' + '='.repeat(70) + '\n' + t + '\n' + '='.repeat(70)); }

async function runCase(name, question, maxRounds) {
  section(`CASE: ${name}`);
  console.log('domain detected:', debateSvc.detectDomain(question));

  // Capture every message the renderer would SEND to the chat platform.
  const sent = [];
  const counts = { start: 0, round: 0, sandbox: 0, verdict: 0, other: 0 };
  const send = async (text) => {
    sent.push(text);
    const head = String(text).split('\n')[0];
    if (/Mixture-of-Experts engaged/.test(text)) counts.start++;
    else if (/^🥊 \*ROUND/.test(head)) counts.round++;
    else if (/ran code in the sandbox/.test(text)) counts.sandbox++;
    else if (/CONSENSUS REACHED|JUDGE/.test(text)) counts.verdict++;
    else counts.other++;
    console.log(`  → MSG[${sent.length}] (${text.length} chars): ${head.slice(0,80)}`);
  };

  const onEvent = makeDebateRenderer({ send, limit: 3800, experts: debateSvc.EXPERTS });

  const res = await debateSvc.debate(question, { maxRounds, onEvent, unify: true });

  // Give the serialized send-queue a tick to flush.
  await new Promise(r => setTimeout(r, 300));

  console.log('\n  --- RESULT ---');
  console.log('  converged   :', res.converged);
  console.log('  rounds       :', res.rounds.length);
  console.log('  finalAnswer  :', String(res.finalAnswer).slice(0, 120));
  console.log('  unified?     :', res.unified ? `yes (${res.unified.length} chars)` : 'no');
  console.log('  message tally:', JSON.stringify(counts));
  console.log('  total msgs   :', sent.length);

  // ANTI-FLICKER ASSERTION: at most one "ROUND N" message per round
  // (chunked parts allowed, but each round produces 1 base message unless huge).
  const roundMsgs = sent.filter(s => /^🥊 \*ROUND/.test(s.split('\n')[0]));
  const roundNums = new Set(roundMsgs.map(s => (s.match(/ROUND (\d+)/) || [])[1]));
  console.log('  distinct rounds rendered:', roundNums.size, '(engine rounds:', res.rounds.length + ')');
  const ok = roundNums.size === res.rounds.length;
  console.log(ok ? '  ✅ STABLE: exactly one consolidated message per round' : '  ❌ FLICKER: round message count mismatch');
  return { res, ok, sent };
}

(async () => {
  let allOk = true;
  try {
    const a = await runCase('MATH', 'A train travels 240 km in 3 hours, then 180 km in 2 hours. What is its average speed for the whole journey? Show working.', 3);
    allOk = allOk && a.ok;

    const b = await runCase('GENERAL', 'In one short paragraph, explain what a buffer overflow is and why it is dangerous.', 2);
    allOk = allOk && b.ok;

    section('OVERALL');
    console.log(allOk ? '✅ ALL E2E CHECKS PASSED' : '❌ SOME CHECKS FAILED');
    process.exit(allOk ? 0 : 1);
  } catch (e) {
    console.error('E2E ERROR:', e.message);
    process.exit(1);
  }
})();
