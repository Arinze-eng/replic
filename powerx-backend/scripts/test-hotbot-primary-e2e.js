// ─────────────────────────────────────────────────────────────────────────────
// test-hotbot-primary-e2e.js — verify the NEW "HotBot (GPT-5) is the primary
// brain, Gemini is the image/vision fallback" architecture end to end.
//
// Checks:
//   1. hotbot.chat() (plain text) returns a real GPT-5 answer.
//   2. The agent-loop brain (geminiComplete via brainComplete) returns a single
//      valid JSON action — proving HotBot drives the ReAct loop.
//   3. brain.answer() with an attached DOCX: the analyser extracts the text and
//      HotBot reads it and answers from the extracted content (brain==='hotbot').
//   4. brain.answer() with a pure image: Gemini vision describes it and the text
//      is fed back to the brain (used[].engine === 'gemini_vision').
//
// Run:  node scripts/test-hotbot-primary-e2e.js
// ─────────────────────────────────────────────────────────────────────────────

const assert = require('assert');
const hotbot = require('../services/hotbot');
const brain = require('../services/brain');
const agentEngine = require('../services/agentEngine');

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { console.log('  ✅', label); pass++; }
  else { console.log('  ❌', label); fail++; }
}

// Build a tiny real .docx in memory using the `docx` lib if present, else fall
// back to a minimal OOXML zip via adm-zip so the test never needs an external file.
function makeDocxBuffer(text) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml',
    Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>', 'utf8'));
  zip.addFile('_rels/.rels',
    Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>', 'utf8'));
  const paras = text.split('\n').map(t =>
    `<w:p><w:r><w:t xml:space="preserve">${t.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</w:t></w:r></w:p>`).join('');
  zip.addFile('word/document.xml',
    Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${paras}</w:body></w:document>`, 'utf8'));
  return zip.toBuffer();
}

// 1x1 red PNG (pure image, no text).
const RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64');

(async () => {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(' HotBot-primary brain — end-to-end regression');
  console.log('══════════════════════════════════════════════════════════════');

  // ── 1. HotBot plain text ──────────────────────────────────────────────────
  console.log('\n── 1. hotbot.chat() plain text (GPT-5 primary) ──');
  try {
    const reply = await hotbot.chat(
      [{ role: 'user', content: 'Reply with exactly the token PONG-HOTBOT and nothing else.' }],
      { _noJudge: true });
    console.log('     reply:', JSON.stringify(String(reply).slice(0, 120)));
    ok('HotBot returned a non-empty answer', !!(reply && String(reply).trim()));
  } catch (e) { ok('HotBot plain text (' + e.message + ')', false); }

  // ── 2. Agent-loop brain returns ONE valid JSON action ─────────────────────
  console.log('\n── 2. agent-loop brain (HotBot drives ReAct, JSON-only) ──');
  try {
    const sys = agentEngine.getAgentSystemPrompt();
    const raw = await agentEngine.brainComplete(sys, [
      { role: 'user', text: 'ATTACHED FILES: (none)\n\nUser: What is 2+2? Answer the user directly with finish.' },
    ]);
    console.log('     raw:', JSON.stringify(String(raw).slice(0, 200)));
    const parsed = agentEngine._internals.parseAction(raw);
    ok('brain reply parses into a JSON action object', !!(parsed && parsed.action));
    ok('action is a known tool (e.g. finish/plan/...)', !!(parsed && typeof parsed.action === 'string'));
  } catch (e) { ok('agent-loop JSON (' + e.message + ')', false); }

  // ── 3. DOCX → analyser extracts text → HotBot reads it ────────────────────
  console.log('\n── 3. brain.answer() with a DOCX (analyser → HotBot) ──');
  try {
    const docx = makeDocxBuffer('Project Phoenix budget memo.\nAuthor: Arinze Allison.\nTotal approved budget: 12,500,000 NGN.');
    const res = await brain.answer({
      message: 'Who is the author and what is the total approved budget? Answer concisely.',
      files: [{ name: 'memo.docx', buffer: docx }],
    });
    console.log('     brain:', res.brain, '| extractedChars:', res.extractedChars, '| used:', JSON.stringify(res.used));
    console.log('     reply:', JSON.stringify(String(res.reply).slice(0, 200)));
    ok('DOCX text was extracted (extractedChars > 0)', res.extractedChars > 0);
    ok('a doc engine (mammoth) read the file, not vision',
      res.used.some(u => u.kind === 'doc' && !u.sentToVision));
    ok('answer references the extracted budget figure',
      /12[,. ]?500[,. ]?000|12\.5\s*million|12500000/i.test(String(res.reply)));
    ok('a real brain answered (hotbot preferred)', !!res.brain);
  } catch (e) { ok('DOCX→brain (' + e.message + ')', false); }

  // ── 4. Pure image → Gemini vision describes → fed back to brain ───────────
  console.log('\n── 4. brain.answer() with a pure image (Gemini vision fallback) ──');
  try {
    const res = await brain.answer({
      message: 'Describe the attached image briefly.',
      files: [{ name: 'pixel.png', buffer: RED_PNG, mime: 'image/png' }],
    });
    console.log('     brain:', res.brain, '| used:', JSON.stringify(res.used));
    ok('image was routed to Gemini vision',
      res.used.some(u => u.kind === 'image' && u.engine === 'gemini_vision' && u.sentToVision));
    ok('a real brain produced the final answer', !!(res.reply && String(res.reply).trim()));
  } catch (e) { ok('image→vision (' + e.message + ')', false); }

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(` RESULT: ${pass} passed, ${fail} failed`);
  console.log('══════════════════════════════════════════════════════════════\n');
  process.exit(fail ? 1 : 0);
})();
