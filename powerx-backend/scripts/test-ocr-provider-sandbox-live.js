#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const providerName = String(process.env.LIVE_OCR_PROVIDER || process.argv[2] || '').toLowerCase();
const providers = {
  novita: require('../services/novitaSandbox'),
  upstash: require('../services/upstashBox'), upstashbox: require('../services/upstashBox'),
  daytona: require('../services/daytona'), githubactions: require('../services/githubActions'),
};
const mod = providers[providerName];
if (!mod) throw new Error('provider must be novita, upstash, daytona, or githubactions');
const ocr = require('../services/simpleOcr');

function fsxFor(id) {
  const root = mod.WORKDIR;
  const abs = rel => `${root}/${String(rel).replace(/^\/+/, '')}`;
  return {
    async sh(command) { const r = await mod.exec(id, command, { cwd: root, timeout: 1200 }); if (r.exitCode) throw new Error(r.output || `exit ${r.exitCode}`); return r; },
    async uploadBuffer(rel, buf) { return mod.uploadFile(id, abs(rel), buf, path.basename(rel)); },
    async readText(rel) { return (await mod.downloadFile(id, abs(rel))).toString('utf8'); },
  };
}

(async () => {
  const fixture = process.env.OCR_FIXTURE;
  assert(fixture && fs.existsSync(fixture), 'OCR_FIXTURE is required');
  const probe = await mod.testKey(); assert(probe && probe.ok, probe && probe.message || 'provider probe failed');
  const id = await mod.createSandbox({ labels: { session: `ocr-live-${Date.now()}` } });
  try {
    const ctx = { fsx: fsxFor(id), onStep: m => console.log(m) };
    const result = await ocr.extract(ctx, fs.readFileSync(fixture), 'dense-exam-page.png', { mode: 'auto' });
    assert(result.ok, result.reason || 'OCR failed');
    const text = result.text || '';
    for (let i = 1; i <= 12; i++) assert(new RegExp(`QUESTION\\s+${i}\\b`, 'i').test(text), `missing QUESTION ${i}`);
    assert(text.length > 500, `OCR unexpectedly short: ${text.length}`);
    console.log(`✅ ${providerName}: dense OCR retained 12/12 questions (${text.length} chars, ${result.engine})`);
  } finally { try { await mod.deleteSandbox(id); } catch (_) {} }
})().catch(e => { console.error('❌', e.stack || e); process.exit(1); });
