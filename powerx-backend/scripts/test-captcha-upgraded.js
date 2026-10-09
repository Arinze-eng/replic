// Live test of the UPGRADED captcha solver against real bot-defended sites.
// Posts the new SOLVER_FUNCTION (extracted from services/captchaSolver.js) to
// the real Browserless /function endpoint and reports the result.
const fs = require('fs');
const https = require('https');

const KEY = process.env.BROWSERLESS_API_KEY;
const ENDPOINT = 'https://production-sfo.browserless.io';

// Extract SOLVER_FUNCTION from the source (so we test the EXACT code that ships).
const src = fs.readFileSync(__dirname + '/../services/captchaSolver.js', 'utf8');
const m = src.match(/const SOLVER_FUNCTION = `([\s\S]*?)`;/);
if (!m) { console.error('Could not extract SOLVER_FUNCTION'); process.exit(1); }
const SOLVER = '`' + m[1] + '`';
// Reconstruct the actual string value the same way Node would.
const SOLVER_FUNCTION = eval(SOLVER); // eslint-disable-line no-eval

function post(url, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(bodyObj);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 115000,
    }, (res) => {
      let chunks = '';
      res.on('data', (d) => chunks += d);
      res.on('end', () => resolve({ status: res.statusCode, body: chunks }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.write(data); req.end();
  });
}

async function testSite(label, url) {
  console.log(`\n========== ${label} :: ${url} ==========`);
  const fnTimeout = 58000;
  const t0 = Date.now();
  try {
    const r = await post(`${ENDPOINT}/function?token=${encodeURIComponent(KEY)}&timeout=${fnTimeout}`, {
      code: SOLVER_FUNCTION,
      context: { url, maxRounds: 12, roundDelay: 2000, takeScreenshot: false },
    });
    const ms = Date.now() - t0;
    if (r.status !== 200) { console.log(`HTTP ${r.status}: ${r.body.slice(0, 300)}`); return; }
    const json = JSON.parse(r.body);
    const d = json && json.data ? json.data : json;
    console.log(`HTTP 200 in ${ms}ms`);
    console.log(`  navigated   : ${d.navigated}`);
    console.log(`  solved      : ${d.solved}`);
    console.log(`  rounds      : ${d.rounds}`);
    console.log(`  title       : ${d.title}`);
    console.log(`  finalUrl    : ${d.finalUrl}`);
    console.log(`  detected    : ${JSON.stringify(d.detected)}`);
    console.log(`  cf_clearance: ${d.hasCfClearance}`);
    console.log(`  tokens      : ${Object.entries(d.tokens || {}).filter(([, v]) => v).map(([k]) => k).join(',') || 'none'}`);
    console.log(`  log         :\n   - ${(d.log || []).join('\n   - ')}`);
    console.log(`  page text   : ${(d.text || '').replace(/\s+/g, ' ').slice(0, 220)}`);
  } catch (e) {
    console.log(`ERROR: ${e.message}`);
  }
}

(async () => {
  if (!KEY) { console.error('Set BROWSERLESS_API_KEY'); process.exit(1); }
  console.log('Testing UPGRADED captcha solver live via Browserless…');
  // 1) Known Cloudflare Turnstile demo (the doc says this was the original e2e site)
  await testSite('Cloudflare/Turnstile demo', 'https://nowsecure.nl');
  // 2) A plain site — must NOT false-trigger and must return real content fast
  await testSite('Plain control site', 'https://example.com');
  console.log('\nDONE.');
})();
