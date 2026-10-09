// End-to-end test for the Cloudflare-Workers-AI brain pipeline.
// Exercises:
//   1. cloudflare.brainChat()  — raw R1 call + <think> stripping + key rotation
//   2. brain.answer() plain text  — main brain answers
//   3. brain.answer() with a DOCX — file → text → brain reads it
//   4. brain.answer() with a pure image — routed to Gemini vision
//   5. stripThink() unit checks
//
// Uses the live Supabase rotation table + the user's Cloudflare accounts.
// Run:  node scripts/test-cf-brain-e2e.js

const assert = require('assert');
const cloudflare = require('../services/cloudflare');
const brain = require('../services/brain');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { console.log('  ✅', name); pass++; }
  else { console.log('  ❌', name, extra ? '— ' + extra : ''); fail++; }
}

async function main() {
  console.log('\n── stripThink() unit checks ──');
  ok('strips a complete <think> block',
    cloudflare.stripThink('<think>reasoning here</think>\n\nFinal answer.') === 'Final answer.');
  ok('keeps text after lone </think>',
    cloudflare.stripThink('blah blah</think>The answer') === 'The answer');
  ok('drops unterminated trailing <think>',
    cloudflare.stripThink('Answer first.<think>still thinking') === 'Answer first.');
  ok('passes through clean text',
    cloudflare.stripThink('Just an answer.') === 'Just an answer.');

  console.log('\n── 1. cloudflare.brainChat (R1 + rotation) ──');
  ok('brainEnabled() is true (a CF account is configured)', await cloudflare.brainEnabled());
  const raw = await cloudflare.brainChat(
    [{ role: 'user', content: 'Reply with exactly the token PONG-CF and nothing else.' }],
    { max_tokens: 512, timeout_ms: 60000 }
  );
  console.log('     reply:', JSON.stringify(raw.slice(0, 120)));
  ok('R1 returned a non-empty, think-stripped answer', !!(raw && raw.trim()));
  ok('answer contains no leftover <think> tag', !/<think>/i.test(raw), raw.slice(0, 80));

  console.log('\n── 2. brain.answer plain text (main brain) ──');
  let r = await brain.answer({ message: 'What is 17 + 25? Reply with just the number.' });
  console.log('     brain=' + r.brain + '  reply=' + JSON.stringify(String(r.reply).slice(0, 120)));
  ok('plain-text answered', !!(r.reply && r.reply.trim()));
  ok('main brain is cloudflare', r.brain === 'cloudflare', 'got ' + r.brain);
  ok('answer mentions 42', /42/.test(String(r.reply)));

  console.log('\n── 3. brain.answer with DOCX (file → text → brain) ──');
  // Build a tiny DOCX in-memory with a unique fact.
  const docx = require('docx');
  const { Document, Packer, Paragraph, TextRun } = docx;
  const doc = new Document({
    sections: [{ children: [
      new Paragraph({ children: [new TextRun('Project budget is 12,500,000 NGN.')] }),
      new Paragraph({ children: [new TextRun('The author is Arinze, Chief Banana Officer.')] }),
    ] }],
  });
  const docxBuf = await Packer.toBuffer(doc);
  r = await brain.answer({
    message: 'From the attached document, what is the budget and who is the author?',
    files: [{ name: 'memo.docx', buffer: docxBuf }],
  });
  console.log('     brain=' + r.brain + '  used=' + JSON.stringify(r.used) + '\n     reply=' + JSON.stringify(String(r.reply).slice(0, 200)));
  ok('DOCX answered', !!(r.reply && r.reply.trim()));
  ok('DOCX extracted via mammoth (not vision)', r.used[0] && r.used[0].engine === 'mammoth' && !r.used[0].sentToVision);
  ok('brain read the budget from the docx', /12[,.]?500[,.]?000/.test(String(r.reply)));

  console.log('\n── 4. brain.answer with a PURE image (→ Gemini vision) ──');
  // 1x1 red PNG.
  const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  r = await brain.answer({
    message: 'What is in this image?',
    files: [{ name: 'pixel.png', buffer: Buffer.from(pngB64, 'base64'), mime: 'image/png' }],
  });
  console.log('     brain=' + r.brain + '  used=' + JSON.stringify(r.used) + '\n     reply=' + JSON.stringify(String(r.reply).slice(0, 200)));
  ok('image answered', !!(r.reply && r.reply.trim()));
  ok('pure image routed to Gemini vision', r.used[0] && r.used[0].sentToVision === true && r.used[0].engine === 'gemini_vision');

  console.log(`\n──────────────  ${pass} passed, ${fail} failed  ──────────────\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
