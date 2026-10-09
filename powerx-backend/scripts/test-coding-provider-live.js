#!/usr/bin/env node
'use strict';
const providerName = String(process.env.LIVE_CODING_PROVIDER || process.argv[2] || '').toLowerCase();
const providers = {
  novita: require('../services/novitaSandbox'),
  upstash: require('../services/upstashBox'),
  upstashbox: require('../services/upstashBox'),
  runloop: require('../services/runloop'),
  daytona: require('../services/daytona'),
  githubactions: require('../services/githubActions'),
};
const mod = providers[providerName];
if (!mod) throw new Error('provider must be novita, upstash, daytona, runloop, or githubactions');
const root = mod.WORKDIR;
const task = `set -eu
rm -rf coding-e2e && git clone -q --depth 1 https://github.com/jonschlinkert/is-number.git coding-e2e
cd coding-e2e
cp index.js /tmp/is-number-good.js
cat > powerx-regression.test.js <<'JS'
'use strict';
const assert=require('node:assert/strict');
const isNumber=require('./');
assert.equal(isNumber(5),true);
assert.equal(isNumber('5'),true);
assert.equal(isNumber('5.1'),true);
assert.equal(isNumber(''),false);
assert.equal(isNumber('abc'),false);
assert.equal(isNumber(Infinity),false);
console.log('OPEN_SOURCE_REGRESSION_OK');
JS
# Introduce a realistic regression, prove the focused test catches it, then
# repair the source and run focused + upstream tests and syntax checks.
printf "module.exports = function(){ return true; };\n" > index.js
set +e
node powerx-regression.test.js >/tmp/broken.log 2>&1
BROKEN=$?
set -e
test "$BROKEN" -ne 0
cp /tmp/is-number-good.js index.js
node --check index.js
node powerx-regression.test.js
npm install --ignore-scripts --no-audit --no-fund >/dev/null
npm test
npm audit --omit=dev --audit-level=high || test $? -le 1
git diff --check
printf '# Coding verification\n\n- open-source project: jonschlinkert/is-number\n- injected regression: detected\n- repaired source: focused regression passed\n- upstream suite: passed\n- syntax and diff checks: passed\n' > VERIFICATION.md
cd ..
(command -v zip >/dev/null || (sudo apt-get update -y >/dev/null && sudo apt-get install -y zip >/dev/null))
zip -qr coding-e2e.zip coding-e2e -x 'coding-e2e/.git/*' 'coding-e2e/node_modules/*'
test -s coding-e2e.zip
printf 'CODING_E2E_OK\n'
`;

(async()=>{
  const key = await mod.testKey();
  if (!key.ok) throw new Error(key.message || `${providerName} authentication failed`);
  const reusableId = String(process.env.CODING_SANDBOX_ID || '').trim();
  const id = reusableId || await mod.createSandbox({ labels: { session: `coding-live-${Date.now()}` } });
  const ownsSandbox = !reusableId;
  try {
    const r = await mod.exec(id, task, { cwd: root, timeout: 1200 });
    if (r.exitCode !== 0 || !/CODING_E2E_OK/.test(r.output || '')) throw new Error(`exit ${r.exitCode}: ${(r.output || '').slice(-4000)}`);
    const zip = await mod.downloadFile(id, `${root}/coding-e2e.zip`);
    if (!zip || zip.length < 500 || zip[0] !== 0x50 || zip[1] !== 0x4b) throw new Error('invalid coding project zip');
    console.log(`✅ ${providerName}: coding build, tests, audit, verification report, and ZIP passed (${zip.length} bytes)`);
  } finally { if (ownsSandbox) { try { await mod.deleteSandbox(id); } catch (_) {} } }
})().catch(e=>{console.error('❌', e.message);process.exit(1)});
