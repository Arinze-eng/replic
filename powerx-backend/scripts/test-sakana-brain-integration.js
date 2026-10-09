// Integration test: services/brain.js with Sakana as the head.
// Sets SAKANA_SESSION via env so db.getSetting (no local Supabase) isn't needed.
process.env.SAKANA_SESSION = process.env.SAKANA_SESSION || '71cc2345-e7c8-4504-a351-e10c43779b4a';
// Avoid accidentally hitting real Supabase for settings during this local test.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || '';

const fs = require('fs');
const path = require('path');
const brain = require('../services/brain');
const TMP = path.resolve(__dirname, '../../../tmp');

(async () => {
  console.log('=== A) text-only via brain.answer (Sakana head) ===');
  try {
    const r = await brain.answer({ message: 'What is 9 times 9? Just the number.' });
    console.log('brain:', r.brain, '| reply:', JSON.stringify(r.reply));
  } catch (e) { console.log('ERR', e.message); }

  console.log('\n=== B) PDF via brain.answer (Sakana native doc path) ===');
  try {
    const buf = fs.readFileSync(path.join(TMP, 'test_doc.pdf'));
    const r = await brain.answer({
      message: 'Quote the exact secret passphrase in the attached document.',
      files: [{ name: 'test_doc.pdf', buffer: buf, mime: 'application/pdf' }],
    });
    console.log('brain:', r.brain, '| used:', JSON.stringify(r.used), '| reply:', JSON.stringify(r.reply));
  } catch (e) { console.log('ERR', e.message); }

  console.log('\n=== C) DOCX via brain.answer ===');
  try {
    const buf = fs.readFileSync(path.join(TMP, 'test_doc.docx'));
    const r = await brain.answer({
      message: 'What is the DOCX secret code in the attached file?',
      files: [{ name: 'test_doc.docx', buffer: buf }],
    });
    console.log('brain:', r.brain, '| used:', JSON.stringify(r.used), '| reply:', JSON.stringify(r.reply));
  } catch (e) { console.log('ERR', e.message); }

  console.log('\nDONE');
  process.exit(0);
})();
