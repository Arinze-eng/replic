// Binary-file variant of the upload fix test — proves images/PDF/binary (apk,
// xlsx, docx) buffers also host on Supabase and are readable by Capy.
process.env.CAPY_API_KEY = process.env.CAPY_API_KEY || 'capy_i9N9c8URbTdnXVpn8lMds8dw6Re4hxAOVNEVdzZeBk0';
process.env.CAPY_HEAD = process.env.CAPY_HEAD || '1';
const capy = require('../services/capy');
const fetch = require('node-fetch');
function log(...a) { console.log('[bin-test]', ...a); }

// Minimal valid 1-page PDF containing a unique marker string.
function makePdf(marker) {
  const body = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 120]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 60>>stream
BT /F1 14 Tf 20 60 Td (${marker} invoice total 12345) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`;
  return Buffer.from(body, 'latin1');
}

async function main() {
  const marker = 'PDFMARK_' + Math.random().toString(36).slice(2, 7).toUpperCase();
  const buf = makePdf(marker);
  log(`Built a ${buf.length}-byte PDF with marker ${marker}`);

  const hosted = await capy.uploadBuffersToPublic(
    [{ name: 'invoice.pdf', buffer: buf, mime: 'application/pdf' }],
    { userId: 'e2e-bin', onStep: (s) => log('  upload:', s) }
  );
  if (!hosted.length || !hosted[0].url) { console.error('❌ FAIL: no hosted URL for PDF.'); process.exit(1); }
  const url = hosted[0].url;
  log('✅ Hosted PDF URL:', url);

  // Confirm bytes round-trip intact (binary integrity).
  const r = await fetch(url, { timeout: 20000 });
  const back = Buffer.from(await r.arrayBuffer());
  log(`Fetched back ${back.length} bytes; byte-identical: ${back.equals(buf)}`);
  if (!back.equals(buf)) { console.error('❌ FAIL: binary bytes corrupted in transit.'); process.exit(1); }

  const out = await capy.run(
    { message: 'Download the PDF at attachmentUrls, read its text, and reply with ONLY the ' +
        'marker token (starts with PDFMARK_) and the invoice total number you see. Be brief.',
      attachmentUrls: [url] },
    { ceilingMs: 4 * 60 * 1000, intervalMs: 6000, onStep: (s) => log('  capy:', s) }
  );
  const reply = String(out && out.reply || '');
  log('Capy reply:', JSON.stringify(reply.slice(0, 300)));
  if (reply.includes(marker) && reply.includes('12345')) {
    log('✅ PASS: Capy read the binary PDF correctly.'); process.exit(0);
  }
  console.error('❌ FAIL: Capy did not read the PDF marker/total.'); process.exit(1);
}
main().catch((e) => { console.error('❌ ERROR:', e && e.stack || e); process.exit(1); });
