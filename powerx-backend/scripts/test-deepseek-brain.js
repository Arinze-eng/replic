// E2E test for the rewired agent brain: DeepSeek PRIMARY → HotBot → Gemini.
const agent = require('../services/agentEngine');

const SYS = 'You are a terse assistant. Answer in one short line.';

async function ask(label, conv) {
  const t0 = Date.now();
  try {
    const out = await agent.brainComplete(SYS, conv);
    console.log(`✅ [${label}] (${Date.now() - t0}ms): ${JSON.stringify(String(out).slice(0, 160))}`);
    return out;
  } catch (e) {
    console.log(`❌ [${label}] (${Date.now() - t0}ms): ${e.message}`);
    return null;
  }
}

(async () => {
  console.log('=== TEST 1: default chain (DeepSeek primary) ===');
  await ask('default', [{ role: 'user', text: 'What is 17 * 23? Reply with just the number.' }]);

  console.log('\n=== TEST 2: SOLO=deepseek (force primary only) ===');
  process.env.AGENT_SOLO = 'deepseek';
  await ask('solo-deepseek', [{ role: 'user', text: 'Say the single word: BANANA' }]);

  console.log('\n=== TEST 3: SOLO=gemini fallback brain works ===');
  process.env.AGENT_SOLO = 'gemini';
  await ask('solo-gemini', [{ role: 'user', text: 'Say the single word: KIWI' }]);

  console.log('\n=== TEST 4: SOLO=hotbot fallback brain works ===');
  process.env.AGENT_SOLO = 'hotbot';
  await ask('solo-hotbot', [{ role: 'user', text: 'Say the single word: MANGO' }]);

  console.log('\n=== TEST 5: DeepSeek down → falls back automatically ===');
  // Simulate DeepSeek failure by clearing the token; chain should fall to HotBot/Gemini.
  delete process.env.AGENT_SOLO;
  const savedTok = process.env.DEEPSEEK_TOKEN;
  process.env.DEEPSEEK_TOKEN = '';
  // deepseek.getToken caches nothing; but admin DB token may exist. We rely on env-only here.
  await ask('deepseek-down-fallback', [{ role: 'user', text: 'Reply with the single word: FALLBACK' }]);
  process.env.DEEPSEEK_TOKEN = savedTok;

  console.log('\nDONE');
  process.exit(0);
})();
