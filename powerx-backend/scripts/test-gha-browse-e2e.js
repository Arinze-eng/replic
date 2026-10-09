// E2E: real-time browsing inside the GitHub Actions (perCommand) sandbox.
// Proves request #1: browsing works on the GitHub Actions CI runner sandbox
// (single self-contained exec installs Playwright+Chromium and drives the page).
//
// Run with:  GHA_TOKEN=ghp_... node scripts/test-gha-browse-e2e.js
process.env.GITHUB_ACTIONS_TOKEN = process.env.GHA_TOKEN || process.env.GITHUB_ACTIONS_TOKEN;
process.env.GITHUB_ACTIONS_REPO = process.env.GITHUB_ACTIONS_REPO || 'Arinze-eng/powerx-sandbox';
process.env.GITHUB_ACTIONS_BRANCH = process.env.GITHUB_ACTIONS_BRANCH || 'main';
// Pin the active sandbox backend to GitHub Actions so sandboxBrowser resolves to it.
process.env.SANDBOX_BACKEND = 'githubactions';

const sandboxBrowser = require('../services/sandboxBrowser');

(async () => {
  console.log('== available? ==');
  const avail = await sandboxBrowser.available();
  console.log('  available:', avail);

  console.log('\n== browseInSandbox (example.com) via GitHub Actions runner ==');
  const t0 = Date.now();
  const s = await sandboxBrowser.browseInSandbox('https://example.com', {
    sessionKey: 'gha-browse-e2e', maxRounds: 4, screenshot: true,
  });
  console.log('  took', Math.round((Date.now() - t0) / 1000) + 's');
  console.log('  backend:', s.backend, '| ok:', s.ok, '| solved:', s.solved);
  console.log('  title:', s.title);
  console.log('  finalUrl:', s.finalUrl);
  console.log('  screenshotFile:', s.screenshotFile || '(none)');
  console.log('  text (first 300):', (s.text || '').slice(0, 300).replace(/\n+/g, ' '));
  if (!s.ok) { console.error('  raw:', (s.raw || s.error || '').slice(-800)); process.exit(1); }
  if (!/example/i.test(s.title || s.text || '')) {
    console.error('❌ page content did not contain expected text'); process.exit(1);
  }
  console.log('\n✅ GITHUB ACTIONS BROWSING E2E PASSED — real Chromium browsing works on the CI runner sandbox.');
})().catch(e => { console.error('E2E ERROR:', e); process.exit(1); });
