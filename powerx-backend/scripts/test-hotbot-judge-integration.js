// Integration test: hotbot.chat() with DeepSeek as JUDGE. Mocks the network
// brains (gemini/hotbotReal/deepseek) so no real API calls are made.
const Module = require('module');
const path = require('path');
const origLoad = Module._load;

const hotbotPath = path.join(__dirname, '..', 'services', 'hotbot.js');
const judgePath  = path.join(__dirname, '..', 'services', 'deepseekJudge.js');

let mock = {
  geminiReply: 'GEMINI_WINNER',
  deepseekEnabled: true,
  judgeVerdict: { correct: true },   // what DeepSeek says about the winner
  reverifyVerdict: { correct: true },// what DeepSeek says about the reverified answer
  finishText: 'DEEPSEEK_FINISHED',
};

Module._load = function (request, parent) {
  const fromHotbot = parent && parent.filename === hotbotPath;
  const fromJudge  = parent && parent.filename === judgePath;

  if (fromHotbot && request === './gemini') {
    return { BASE_URL: 'http://x', ENDPOINT: '/y', AUTH_TOKEN: 'z', SYSTEM_PROMPT: '', extractText: () => mock.geminiReply };
  }
  if (fromHotbot && request === './hotbotReal') {
    return { DEFAULT_CHAT_MODEL: 'gpt-5', listModels: async () => [], chat: async () => mock.geminiReply, generateImage: async () => ({}), generateImageBuffer: async () => Buffer.from('') };
  }
  if (fromHotbot && request === './wolfram') {
    return { looksComputational: () => false, ask: async () => ({ ok: false }) };
  }
  if (fromHotbot && (request === './studentAI' || request === './aichatting' || request === './pollinations')) {
    return { isEnabled: () => false, imageEnabled: () => false, chat: async () => { throw new Error('off'); }, generateImage: async () => ({}), generateImageBuffer: async () => Buffer.from('') };
  }
  if ((fromHotbot || fromJudge) && request === './deepseek') {
    return {
      isEnabled: async () => mock.deepseekEnabled,
      getToken: async () => mock.deepseekEnabled ? 'tok' : '',
      chat: async (prompt) => {
        if (/ONLY a JSON object/.test(prompt)) {
          const v = /CORRECTED/.test(prompt) ? mock.reverifyVerdict : mock.judgeVerdict;
          return JSON.stringify({ correct: !!v.correct, confidence: 0.9, reason: v.reason || '', corrected_answer: '' });
        }
        return mock.finishText;
      },
    };
  }
  return origLoad.apply(this, arguments);
};

// node-fetch mock so geminiChat "succeeds" returning mock.geminiReply
const fetchMock = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: fetchMock };

// Force gemini-only race for determinism (no real hotbot backend).
process.env.HOTBOT_SOLO = 'gemini';

delete require.cache[require.resolve('../services/deepseekJudge')];
delete require.cache[require.resolve('../services/hotbot')];
const hotbot = require('../services/hotbot');

let passed = 0, failed = 0;
const assert = (c, l) => { if (c) { passed++; console.log('  ✅ ' + l); } else { failed++; console.log('  ❌ ' + l); } };

(async () => {
  console.log('\n=== INT 1: race winner judged CORRECT → returns winner ===');
  mock.judgeVerdict = { correct: true };
  {
    const out = await hotbot.chat([{ role: 'user', content: 'What is 2+2?' }]);
    assert(out === 'GEMINI_WINNER', 'returns race winner when judge approves (got: ' + out + ')');
  }

  console.log('\n=== INT 2: winner WRONG → reverify still wrong → DeepSeek finishes ===');
  mock.judgeVerdict = { correct: false, reason: 'wrong' };
  mock.reverifyVerdict = { correct: false, reason: 'still wrong' };
  mock.finishText = 'DEEPSEEK_FINISHED';
  {
    const out = await hotbot.chat([{ role: 'user', content: 'hard q' }]);
    assert(out === 'DEEPSEEK_FINISHED', 'DeepSeek finishes when brains keep failing (got: ' + out + ')');
  }

  console.log('\n=== INT 3: _noJudge opt bypasses judge (used by fallback judge brain) ===');
  mock.judgeVerdict = { correct: false };
  {
    const out = await hotbot.chat([{ role: 'user', content: 'q' }], { _noJudge: true });
    assert(out === 'GEMINI_WINNER', 'returns raw winner with _noJudge (no recursion)');
  }

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
