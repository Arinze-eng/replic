'use strict';
const name = String(process.env.LIVE_IMAGE_PROVIDER || '').toLowerCase();
const modules = { novita: '../services/novitaSandbox', upstash: '../services/upstashBox', upstashbox: '../services/upstashBox', daytona: '../services/daytona' };
if (!modules[name]) throw new Error('LIVE_IMAGE_PROVIDER must be novita, upstash, or daytona');
const provider = require(modules[name]);
(async () => {
  const providerKey = await provider.testKey();
  if (!providerKey.ok) throw new Error(providerKey.message || `${name} authentication failed`);
  const deapiKey = String(process.env.DEAPI_API_KEY || '').trim();
  if (!deapiKey) throw new Error('DEAPI_API_KEY is required');
  const id = await provider.createSandbox({ envVars: { DEAPI_API_KEY: deapiKey }, labels: { test: 'deapi-egress' } });
  try {
    const command = `set -eu; test -n "$DEAPI_API_KEY"; CODE=$(curl --retry 5 --retry-all-errors --retry-delay 2 --connect-timeout 20 --max-time 90 -sS -o /tmp/deapi-models.json -w '%{http_code}' -H "Authorization: Bearer $DEAPI_API_KEY" -H 'Accept: application/json' 'https://api.deapi.ai/api/v2/models?per_page=100&page=1'); test "$CODE" = 200; grep -q 'Flux_2_Klein_4B_BF16' /tmp/deapi-models.json; echo DEAPI_SANDBOX_OK`;
    const result = await provider.exec(id, command, { cwd: provider.WORKDIR, timeout: 120 });
    if (result.exitCode !== 0 || !/DEAPI_SANDBOX_OK/.test(result.output || '')) throw new Error(`exit ${result.exitCode}: ${(result.output || '').slice(-1500)}`);
    console.log(`✅ ${name}: DEAPI authentication and image-edit model access passed from sandbox`);
  } finally { try { await provider.deleteSandbox(id); } catch (_) {} }
})().catch(error => { console.error(`❌ ${name}:`, error.message); process.exit(1); });
