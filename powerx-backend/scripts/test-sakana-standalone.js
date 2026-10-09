// Standalone test for services/sakana.js (run from repo/evilgpt).
// Avoids requiring db.js (no Supabase creds locally) — sakana.js handles a
// missing db gracefully and falls back to env/default session.
process.env.SAKANA_SESSION = process.env.SAKANA_SESSION || '71cc2345-e7c8-4504-a351-e10c43779b4a';
const fs = require('fs');
const path = require('path');
const sakana = require('../services/sakana');

const TMP = path.resolve(__dirname, '../../../tmp');

(async () => {
  console.log('=== 0) testSession ===');
  console.log(await sakana.testSession());

  console.log('\n=== 1) text chat ===');
  try {
    const r = await sakana.chat([{ role: 'user', content: 'What is 17 times 3? Reply with just the number.' }]);
    console.log('reply:', JSON.stringify(r));
  } catch (e) { console.log('ERR', e.message); }

  console.log('\n=== 2) text chat with system + history ===');
  try {
    const r = await sakana.chat([
      { role: 'system', content: 'You always answer in ALL CAPS.' },
      { role: 'user', content: 'say hello' },
    ]);
    console.log('reply:', JSON.stringify(r));
  } catch (e) { console.log('ERR', e.message); }

  console.log('\n=== 3) PDF document analysis ===');
  try {
    const buf = fs.readFileSync(path.join(TMP, 'test_doc.pdf'));
    const r = await sakana.answerWithFiles({
      message: 'Quote the exact secret passphrase written in the attached document.',
      files: [{ name: 'test_doc.pdf', buffer: buf, mime: 'application/pdf' }],
    });
    console.log('reply:', JSON.stringify(r.reply), '| usedFiles:', r.usedFiles);
  } catch (e) { console.log('ERR', e.message); }

  console.log('\n=== 4) DOCX document analysis ===');
  try {
    const buf = fs.readFileSync(path.join(TMP, 'test_doc.docx'));
    const r = await sakana.answerWithFiles({
      message: 'What is the DOCX secret code and the Q3 revenue figure in the attached file?',
      files: [{ name: 'test_doc.docx', buffer: buf }],
    });
    console.log('reply:', JSON.stringify(r.reply), '| usedFiles:', r.usedFiles);
  } catch (e) { console.log('ERR', e.message); }

  console.log('\n=== 5) image input is rejected (so caller routes to vision) ===');
  try {
    await sakana.chat([{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }]);
    console.log('UNEXPECTED: did not reject');
  } catch (e) { console.log('correctly threw:', e.message); }

  console.log('\nDONE');
})();
