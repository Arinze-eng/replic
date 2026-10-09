// Standalone unit test for deepseekJudge pipeline. Mocks the deepseek + hotbot
// brains so we test the JUDGE LOGIC without any network calls.
const Module = require('module');
const path = require('path');

const origResolve = Module._resolveFilename;
const origLoad = Module._load;

// ── Mock state controlled per test case ──────────────────────────────────
let mock = {
  deepseekEnabled: true,
  // judge() verdict producer: given (question, answer) returns {correct, reason, corrected}
  judgeFn: null,
  // deepseekFinish text
  finishText: 'DEEPSEEK_FINAL_ANSWER',
};

const judgeModulePath = path.join(__dirname, '..', 'services', 'deepseekJudge.js');

// Intercept require('./deepseek') and require('./hotbot') AS SEEN FROM deepseekJudge.js
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename === judgeModulePath) {
    if (request === './deepseek') {
      return {
        isEnabled: async () => mock.deepseekEnabled,
        chat: async (prompt) => {
          // The judge sends a JSON-asking prompt; the finisher sends a "solve it" prompt.
          if (/ONLY a JSON object/.test(prompt)) {
            // Extract the candidate answer + question from the prompt for the judge fn.
            const v = mock.judgeFn ? mock.judgeFn(prompt) : { correct: true };
            return JSON.stringify({
              correct: !!v.correct,
              confidence: v.confidence != null ? v.confidence : (v.correct ? 0.9 : 0.4),
              reason: v.reason || (v.correct ? 'looks correct' : 'it is wrong'),
              corrected_answer: v.corrected || '',
            });
          }
          // Finisher path
          return mock.finishText;
        },
        getToken: async () => mock.deepseekEnabled ? 'fake-token' : '',
      };
    }
    if (request === './hotbot') {
      return {
        chat: async () => 'FALLBACK_JUDGE_BRAIN_REPLY',
      };
    }
  }
  return origLoad.apply(this, arguments);
};

// Fresh require of the judge with mocks in place.
delete require.cache[require.resolve('../services/deepseekJudge')];
const judge = require('../services/deepseekJudge');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  ✅ ' + label); }
  else { failed++; console.log('  ❌ ' + label); }
}

(async () => {
  console.log('\n=== TEST 1: winner is CORRECT → ship winner untouched ===');
  mock.judgeFn = () => ({ correct: true, reason: 'accurate' });
  {
    const r = await judge.runWithJudge({
      question: 'What is 2+2?',
      answer: '4',
      reverify: async () => 'SHOULD_NOT_BE_CALLED',
    });
    assert(r.answer === '4', 'ships the original winner');
    assert(r.decidedBy === 'race', 'decidedBy=race');
  }

  console.log('\n=== TEST 2: winner WRONG, reverify FIXES it → ship reverify ===');
  {
    let calls = 0;
    // First judge call (on winner) = wrong; second (on reverified) = correct.
    mock.judgeFn = (prompt) => {
      // The reverified answer text we return below is "CORRECTED_ANSWER".
      if (/CORRECTED_ANSWER/.test(prompt)) return { correct: true, reason: 'now correct' };
      return { correct: false, reason: 'off by one' };
    };
    const r = await judge.runWithJudge({
      question: 'What is 2+2?',
      answer: '5',
      reverify: async (critique) => { calls++; return 'CORRECTED_ANSWER'; },
    });
    assert(calls === 1, 'reverify was called once');
    assert(r.answer === 'CORRECTED_ANSWER', 'ships the corrected (reverified) answer');
    assert(r.decidedBy === 'reverify', 'decidedBy=reverify');
  }

  console.log('\n=== TEST 3: winner WRONG, reverify STILL WRONG → DeepSeek finishes ===');
  {
    mock.judgeFn = () => ({ correct: false, reason: 'still wrong' }); // always wrong
    mock.finishText = 'DEEPSEEK_SOLVED_IT';
    const r = await judge.runWithJudge({
      question: 'Hard problem',
      answer: 'bad winner',
      reverify: async () => 'still-bad-attempt',
    });
    assert(r.answer === 'DEEPSEEK_SOLVED_IT', 'DeepSeek produced the final answer');
    assert(r.decidedBy === 'deepseek-finish', 'decidedBy=deepseek-finish');
  }

  console.log('\n=== TEST 4: DeepSeek token ABSENT → falls back to strongest brain as judge ===');
  {
    mock.deepseekEnabled = false; // DeepSeek down
    // Fallback judge brain returns plain text; _parseVerdict heuristics apply.
    // We can't control fallback verdict text precisely, but it must NOT throw and must return an answer.
    mock.judgeFn = () => ({ correct: true });
    const r = await judge.runWithJudge({
      question: 'What is the capital of France?',
      answer: 'Paris',
    });
    assert(typeof r.answer === 'string' && r.answer.length > 0, 'never returns empty (resilient fallback)');
    mock.deepseekEnabled = true;
  }

  console.log('\n=== TEST 5: judge disabled via env → ship winner ===');
  {
    process.env.DEEPSEEK_JUDGE_DISABLED = '1';
    delete require.cache[require.resolve('../services/deepseekJudge')];
    const judge2 = require('../services/deepseekJudge');
    const r = await judge2.runWithJudge({ question: 'x', answer: 'WINNER', reverify: async () => 'X' });
    assert(r.answer === 'WINNER' && r.decidedBy === 'race', 'judge bypassed when disabled');
    delete process.env.DEEPSEEK_JUDGE_DISABLED;
  }

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('TEST CRASHED:', e); process.exit(1); });
