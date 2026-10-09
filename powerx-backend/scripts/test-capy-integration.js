// Standalone test for services/capy.js (run from repo/evilgpt).
//
//   CAPY_API_KEY=capy_xxx node scripts/test-capy-integration.js
//
// Covers the full Capy.ai integration:
//   0) testConnection  — verifies the key + lists projects
//   1) URL harvesting  — unit test of the file-URL extractor (no network)
//   2) (optional, live) end-to-end run — submit a task that produces a file,
//      poll up to the ceiling, then download + validate the returned bytes.
//      Skipped unless CAPY_LIVE=1 (so CI / the brain regression stays fast).
//
// capy.js handles a missing db.js gracefully (falls back to env), so this can
// run with no Supabase creds.
const capy = require('../services/capy');

function assert(cond, msg) { if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; } else { console.log('✅', msg); } }

(async () => {
  console.log('=== 0) testConnection ===');
  const t = await capy.testConnection();
  console.log(JSON.stringify(t).slice(0, 500));
  if (process.env.CAPY_API_KEY || process.env.CAPY_LIVE) {
    assert(t.ok, 'Capy key valid and projects listed');
  } else {
    console.log('(no CAPY_API_KEY set — skipping the validity assertion)');
  }

  console.log('\n=== 1) URL harvesting (unit, no network) ===');
  const sample = [
    "All done. Here are your files.",
    "DELIVERABLES:",
    "https://0x0.st/abcd.pdf",
    "https://tmpfiles.org/dl/xy/report.xlsx",
    "https://files.catbox.moe/zzz.png",
    "https://capy.ai/threads/123      (should be ignored)",
    "https://github.com/owner/repo    (should be ignored)",
    "see [the doc](https://example.com/manual.docx) for details",
  ].join('\n');
  const urls = capy.harvestUrls(sample).filter(capy.looksLikeFileUrl);
  console.log('harvested file URLs:', urls);
  assert(urls.includes('https://0x0.st/abcd.pdf'), 'kept 0x0.st .pdf');
  assert(urls.includes('https://tmpfiles.org/dl/xy/report.xlsx'), 'kept tmpfiles .xlsx');
  assert(urls.includes('https://files.catbox.moe/zzz.png'), 'kept catbox .png');
  assert(urls.includes('https://example.com/manual.docx'), 'kept markdown-linked .docx');
  assert(!urls.some(u => /capy\.ai/.test(u)), 'dropped capy.ai dashboard link');
  assert(!urls.some(u => /github\.com/.test(u)), 'dropped github link');

  if (String(process.env.CAPY_LIVE || '').toLowerCase() === '1') {
    console.log('\n=== 2) LIVE end-to-end run (produces + downloads a file) ===');
    const ceilingMs = parseInt(process.env.CAPY_POLL_CEILING_MS || '480000', 10);
    try {
      const res = await capy.run(
        { message: 'Create a tiny text file named capy_e2e.txt containing exactly "capy e2e ok". Upload it via transfer.sh or 0x0.st and give me the direct download link.' },
        { ceilingMs, intervalMs: 8000, onStep: (m) => console.log('  [step]', m) }
      );
      console.log('brain:', res.brain, '| runState:', res.runState, '| threadId:', res.threadId);
      console.log('reply:', (res.reply || '').slice(0, 300));
      console.log('files:', res.files.map(f => ({ name: f.name, mime: f.mime, bytes: f.buffer.length, url: f.sourceUrl })));
      assert(res.reply || res.files.length, 'live run returned a reply or files');
    } catch (e) {
      console.error('LIVE run error:', e.message);
      process.exitCode = 1;
    }
  } else {
    console.log('\n(skipping LIVE end-to-end run — set CAPY_LIVE=1 to enable)');
  }

  console.log('\nDONE');
  process.exit(process.exitCode || 0);
})();
