// Hackers Ai Everywhere - API Key Rotation (for future multi-key support)
// Currently using a single Cloudflare API token. This module is kept for extensibility.
const db = require('../db');

async function getNextApiKey() {
  return db.getNextApiKey();
}

async function markRateLimited(apiKey, cooldownMinutes = 1) {
  return db.markApiKeyRateLimited(apiKey, cooldownMinutes);
}

async function getAllApiKeys() {
  return db.getAllApiKeys();
}

async function toggleApiKey(id, active) {
  return db.toggleApiKey(id, active);
}

async function addApiKey(keyValue, provider = 'cloudflare') {
  return db.addApiKey(keyValue, provider);
}

module.exports = { getNextApiKey, markRateLimited, getAllApiKeys, toggleApiKey, addApiKey };