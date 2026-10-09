'use strict';

const fs = require('fs');
const path = require('path');

function safeFilename(value, index = 0) {
  const base = path.basename(String(value || `artifact_${index + 1}`)).replace(/[\r\n\0"]/g, '_').trim();
  return base || `artifact_${index + 1}`;
}

function artifactBuffer(file) {
  if (!file || typeof file !== 'object') throw new Error('invalid artifact descriptor');
  if (Buffer.isBuffer(file.buffer)) return file.buffer;
  if (typeof file.b64 === 'string' && file.b64.trim()) return Buffer.from(file.b64, 'base64');
  if (typeof file.content === 'string') return Buffer.from(file.content, 'utf8');
  if (file.path && typeof file.path === 'string') return fs.readFileSync(file.path);
  throw new Error('artifact has no readable bytes');
}

/**
 * Deliver every generated artifact and return an auditable result. sendFile must
 * return true, or a provider response whose `ok` is not false. A false/null
 * response is a failure and is never silently counted as delivered.
 */
async function deliverGeneratedFiles({ files, maxBytes, channel, sendFile, sendNotice, onFailure }) {
  const list = Array.isArray(files) ? files : [];
  const delivered = [];
  const failed = [];

  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    const name = safeFilename(file && file.name, i);
    try {
      const buffer = artifactBuffer(file);
      if (!buffer.length) throw new Error('artifact is empty');
      if (Number.isFinite(maxBytes) && buffer.length > maxBytes) {
        const size = (buffer.length / 1024 / 1024).toFixed(1);
        throw new Error(`${size} MB exceeds the ${channel} upload limit`);
      }
      const response = await sendFile(buffer, name, `📎 ${name}`);
      const ok = response === true || !!(response && response.ok !== false);
      if (!ok) {
        const detail = response && (response.description || response.error || response.message);
        throw new Error(detail ? String(detail) : `${channel} rejected the upload`);
      }
      delivered.push(name);
    } catch (error) {
      const reason = error && error.message ? error.message : String(error);
      failed.push({ name, reason });
      if (typeof onFailure === 'function') {
        try { onFailure({ channel, name, reason, file }); } catch (_) {}
      }
      if (typeof sendNotice === 'function') {
        try { await sendNotice(`⚠️ I could not deliver ${name}: ${reason}.`); } catch (_) {}
      }
    }
  }

  return { attempted: list.length, delivered, failed, ok: failed.length === 0 };
}

module.exports = { safeFilename, artifactBuffer, deliverGeneratedFiles };
