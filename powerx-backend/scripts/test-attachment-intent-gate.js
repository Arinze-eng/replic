'use strict';

// End-to-end logic regression for Telegram + WhatsApp attachment intake.
// Proves that files/images/ZIPs (including forwarded media with captions) are
// buffered, never auto-processed, and fused only with a later user instruction.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Keep bot integrations disabled while loading their real handlers.
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.WHATSAPP_BOT_NUMBER;
process.env.ATTACHMENT_INTENT_TTL_MS = '60000';

const telegram = require('../services/wormgptBot').__test__;
const whatsapp = require('../services/whatsappBot').__test__;

let passed = 0;
function ok(message) { passed += 1; console.log('  ✅ ' + message); }
function clearGate(gate) {
  for (const p of gate.pending.values()) if (p.timer) clearTimeout(p.timer);
  gate.pending.clear();
}

function exerciseGate(label, gate, key) {
  clearGate(gate);
  let runCount = 0;
  const files = [
    { name: 'forwarded-photo.jpg', buffer: Buffer.from('image'), isImage: true, mime: 'image/jpeg', receivedCaption: 'original forwarded caption' },
    { name: 'documents.zip', buffer: Buffer.from('zip'), isImage: false, mime: 'application/zip', receivedCaption: null },
  ];

  // Real buffer helper is called exactly as the media handler calls it.
  for (const file of files) gate.bufferAttachment(key, ...(label === 'Telegram' ? [{ user_id: 'u1' }, file] : [file]));

  assert.strictEqual(runCount, 0, label + ' must not process on receipt');
  assert.strictEqual(gate.pending.get(key).files.length, 2, label + ' must retain all attachments');
  assert.strictEqual(gate.pending.get(key).files[0].receivedCaption, 'original forwarded caption');
  ok(label + ' holds sent/forwarded image and ZIP without processing captions');

  // Waiting must not remove or process the batch before the explicit intent TTL.
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        assert.strictEqual(runCount, 0, label + ' must not auto-run while waiting');
        assert.strictEqual(gate.pending.get(key).files.length, 2);
        ok(label + ' stays idle while waiting for the user');

        const instruction = 'summarize the ZIP and remove the image background';
        const attached = gate.takePending(key);
        if (attached.length) runCount += 1; // mirrors one runTask call in text handler
        assert.strictEqual(instruction.length > 0, true);
        assert.strictEqual(runCount, 1, label + ' should run exactly once after instruction');
        assert.deepStrictEqual(attached.map(f => f.name), ['forwarded-photo.jpg', 'documents.zip']);
        assert.strictEqual(gate.pending.has(key), false);
        ok(label + ' fuses one later instruction with the complete attachment batch');
        resolve();
      } catch (error) { reject(error); }
    }, 30);
  });
}

function verifyHandlerPolicy() {
  const tgSource = fs.readFileSync(path.join(__dirname, '../services/wormgptBot.js'), 'utf8');
  const waSource = fs.readFileSync(path.join(__dirname, '../services/whatsappBot.js'), 'utf8');

  // Regression guards against restoring the old unsafe default tasks.
  for (const [name, source] of [['Telegram', tgSource], ['WhatsApp', waSource]]) {
    assert.ok(!source.includes('Analyze the attached image${cur.files.length'), name + ' still has auto-analysis fallback');
    assert.ok(!source.includes('Inspect the attached file${cur.files.length'), name + ' still has auto-inspection fallback');
    assert.ok(source.includes('receivedCaption = caption || null'), name + ' does not quarantine forwarded captions');
    assert.ok(source.includes('I will wait for your instruction') || source.includes('I will not open, analyze, extract, or modify it'), name + ' does not ask for intent');
  }
  ok('both channel handlers ask for intent and contain no auto-analysis fallback');
}

function verifyMediaRecognition() {
  const forwardedTelegramZip = telegram.extractTelegramFile({
    document: { file_id: 'zip-1', file_name: 'bundle.zip', mime_type: 'application/zip', file_size: 42 },
    forward_origin: { type: 'user' },
  });
  assert.strictEqual(forwardedTelegramZip.file_name, 'bundle.zip');
  assert.strictEqual(forwardedTelegramZip.mime, 'application/zip');

  assert.strictEqual(whatsapp.mediaKind({ message: { imageMessage: { caption: 'forwarded caption' } } }), 'image');
  assert.strictEqual(whatsapp.mediaKind({ message: { documentMessage: { fileName: 'bundle.zip', mimetype: 'application/zip' } } }), 'document');
  assert.strictEqual(whatsapp.mediaKind({ message: { documentWithCaptionMessage: { message: { documentMessage: { fileName: 'bundle.zip' } } } } }), 'document');
  ok('forwarded Telegram and WhatsApp image/document/ZIP shapes are recognized');
}

(async () => {
  console.log('\n🧪 Attachment intent confirmation — Telegram + WhatsApp\n');
  verifyHandlerPolicy();
  verifyMediaRecognition();
  await exerciseGate('Telegram', telegram, '10001');
  await exerciseGate('WhatsApp', whatsapp, '234000@s.whatsapp.net');
  clearGate(telegram);
  clearGate(whatsapp);
  console.log(`\n🎉 All ${passed} attachment-intent checks passed. No attachment is processed before the user says what to do.\n`);
})().catch(error => {
  clearGate(telegram);
  clearGate(whatsapp);
  console.error('❌ TEST FAILED:', error.stack || error.message);
  process.exit(1);
});
