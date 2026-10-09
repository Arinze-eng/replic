'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { deliverGeneratedFiles } = require('../services/botFileDelivery');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-delivery-test-'));
  try {
    const zipPath = path.join(dir, 'full-project.zip');
    const zipBytes = Buffer.from('PK\x03\x04complete-project');
    fs.writeFileSync(zipPath, zipBytes);

    const received = [];
    const notices = [];
    const success = await deliverGeneratedFiles({
      files: [
        { path: zipPath, name: 'full-project.zip' },
        { buffer: Buffer.from('buffer-file'), name: 'buffer.txt' },
        { b64: Buffer.from('base64-file').toString('base64'), name: 'base64.txt' },
        { content: 'text-file', name: 'content.txt' },
      ],
      maxBytes: 1024 * 1024,
      channel: 'test',
      sendFile: async (buffer, name, caption) => {
        received.push({ buffer, name, caption });
        return { ok: true };
      },
      sendNotice: async message => notices.push(message),
    });

    assert.strictEqual(success.ok, true);
    assert.deepStrictEqual(success.delivered, ['full-project.zip', 'buffer.txt', 'base64.txt', 'content.txt']);
    assert.strictEqual(success.failed.length, 0);
    assert.strictEqual(received.length, 4);
    assert.deepStrictEqual(received[0].buffer, zipBytes, 'complete ZIP bytes must reach the channel unchanged');
    assert.strictEqual(received[0].caption, '📎 full-project.zip');
    assert.strictEqual(notices.length, 0);

    const failures = [];
    let attempts = 0;
    const rejected = await deliverGeneratedFiles({
      files: [
        { buffer: Buffer.from('reject'), name: 'rejected.zip' },
        { path: path.join(dir, 'missing.zip'), name: 'missing.zip' },
        { buffer: Buffer.alloc(32), name: 'oversize.zip' },
      ],
      maxBytes: 16,
      channel: 'test',
      sendFile: async () => { attempts++; return false; },
      sendNotice: async message => failures.push(message),
    });
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.delivered.length, 0);
    assert.strictEqual(rejected.failed.length, 3);
    assert.strictEqual(attempts, 1, 'missing and oversized files must not be handed to the provider');
    assert.strictEqual(failures.length, 3, 'every failed artifact must be visible to the user');

    const tg = fs.readFileSync(path.join(__dirname, '../services/wormgptBot.js'), 'utf8');
    const wa = fs.readFileSync(path.join(__dirname, '../services/whatsappBot.js'), 'utf8');
    for (const [name, source] of [['Telegram', tg], ['WhatsApp', wa]]) {
      assert.match(source, /deliverGeneratedFiles\(\{/);
      assert.match(source, /status: delivery\.failed\.length \? 'error' : 'done'/);
      assert.doesNotMatch(source, /for \(const f of \(result\.files \|\| \[\]\)\)[\s\S]{0,500}catch \(e\) \{ \/\* ignore \*\//,
        `${name} must not silently swallow artifact delivery failures`);
    }
    assert.match(wa, /return safeSend\(jid, \{ document: buffer/,
      'WhatsApp sendDocument must return the provider success result');
    assert.match(tg, /sendDocument failed after 3 attempts/,
      'Telegram document uploads must be retried and logged');

    console.log('✅ Bot file delivery: path/buffer/base64/text artifacts delivered');
    console.log('✅ Complete project ZIP bytes preserved unchanged');
    console.log('✅ Provider rejection, missing file and size limit are surfaced');
    console.log('✅ Telegram and WhatsApp integrations record delivery failure');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
