#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const sharp = require('sharp');
const ocr = require('../services/simpleOcr');

const providerName = String(process.env.LIVE_OCR_PROVIDER || process.argv[2] || '').toLowerCase();
const providers = {
  novita: require('../services/novitaSandbox'),
  upstash: require('../services/upstashBox'),
  upstashbox: require('../services/upstashBox'),
  runloop: require('../services/runloop'),
  daytona: require('../services/daytona'),
  githubactions: require('../services/githubActions'),
};
const mod = providers[providerName];
if (!mod) throw new Error('LIVE_OCR_PROVIDER must be novita, upstash, runloop, daytona, or githubactions');

function fsxFor(id) {
  const root = mod.WORKDIR;
  const abs = rel => `${root}/${String(rel).replace(/^\/+/, '')}`;
  return {
    kind: 'sandbox', backend: providerName, sandboxId: id, workdir: root,
    async sh(command) { const r = await mod.exec(id, command, { cwd: root, timeout: 900 }); return { exitCode: r.exitCode, output: r.output || '' }; },
    async uploadBuffer(rel, buf) { return mod.uploadFile(id, abs(rel), buf, path.posix.basename(rel)); },
    async readText(rel) { return (await mod.downloadFile(id, abs(rel))).toString('utf8'); },
    async downloadBuffer(rel) { return mod.downloadFile(id, abs(rel)); },
  };
}
async function examImage(i) {
  const lines = [
    `POWERX PAST QUESTIONS — PAGE ${i} OF 9`,
    `QUESTION ${i}. Evaluate ${i}x + ${i + 2} = ${i * 4}.`,
    `A. ${i}   B. ${i + 1}   C. ${i + 2}   D. ${i + 3}`,
    `UNIQUE_MARKER_PX_${i}_END`,
  ];
  const svg = `<svg width="1800" height="2400" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><g fill="black" font-family="DejaVu Sans" font-size="64">${lines.map((x,j)=>`<text x="100" y="${180+j*180}">${x.replace(/&/g,'&amp;')}</text>`).join('')}</g></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

(async () => {
  const keyTest = await mod.testKey();
  if (!keyTest.ok) throw new Error(keyTest.message || `${providerName} key test failed`);
  console.log(`✅ ${providerName} authenticated`);
  const existingId = String(process.env.LIVE_OCR_SANDBOX_ID || '').trim();
  const id = existingId || await mod.createSandbox({ labels: { session: `ocr-live-${Date.now()}` } });
  if (existingId && mod.startSandbox) assert(await mod.startSandbox(id), `could not resume ${providerName} sandbox`);
  const ctx = { fsx: fsxFor(id), onStep: m => console.log('  ·', m) };
  try {
    const warm = await ocr.warmup(ctx);
    if (!warm.ok) throw new Error('OCR warmup failed');
    console.log(`✅ ${providerName} OCR warm (${warm.ms}ms)`);
    const count = Math.max(1, Math.min(9, parseInt(process.env.LIVE_OCR_COUNT || '9', 10) || 9));
    const images = await Promise.all(Array.from({ length: count }, (_, i) => examImage(i + 1)));
    const results = new Array(count);
    let cursor = 0;
    async function worker() {
      while (true) {
        const i = cursor++;
        if (i >= images.length) return;
        results[i] = await ocr.extract(ctx, images[i], `page-${i + 1}.png`);
      }
    }
    await Promise.all(Array.from({ length: 3 }, () => worker()));
    results.forEach((r, i) => {
      if (!r.ok) throw new Error(`page ${i + 1} OCR failed: ${r.reason}`);
      const text = r.text || '';
      const normalized = text.toUpperCase().replace(/[^A-Z0-9]+/g, '');
      if (!normalized.includes(`QUESTION${i + 1}`) || !normalized.includes(`PX${i + 1}END`)) {
        throw new Error(`page ${i + 1} completeness marker missing: ${JSON.stringify(text.slice(0, 240))}`);
      }
    });
    console.log(`✅ ${providerName} read all ${count} image(s) in order with no skipped marker`);
  } finally {
    try {
      if (existingId && mod.pauseSandbox) await mod.pauseSandbox(id);
      else if (!existingId) await mod.deleteSandbox(id);
    } catch (_) {}
  }
})().catch(e => { console.error('❌', e.message); process.exit(1); });
