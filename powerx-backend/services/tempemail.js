// Temp Email Service — free disposable email via Mail.tm API (no API key needed)
// Uses mail.tm REST API: https://docs.mail.tm
// Supports any domain they provide — automatically gets current domains each time

const API_BASE = 'https://api.mail.tm';

// Cache domains + check if they're still valid
let domainCache = { domains: [], fetchedAt: 0 };
const CACHE_TTL = 5 * 60 * 1000; // 5 min

async function getDomains() {
  if (Date.now() - domainCache.fetchedAt < CACHE_TTL && domainCache.domains.length) {
    return domainCache.domains;
  }
  try {
    const res = await fetch(`${API_BASE}/domains`);
    const data = await res.json();
    const domains = (data['hydra:member'] || []).filter(d => d.isActive).map(d => d.domain);
    if (domains.length) {
      domainCache = { domains, fetchedAt: Date.now() };
    }
    return domains;
  } catch (e) {
    return domainCache.domains.length ? domainCache.domains : ['web-library.net'];
  }
}

// Create a new temp inbox with optional custom prefix and domain
async function createInbox({ prefix, domain: preferredDomain, randomSuffix } = {}) {
  const domains = await getDomains();
  if (!domains.length) throw new Error('No available domains');

  // Pick domain: prefer user's choice if available, else random
  let domain;
  if (preferredDomain && domains.includes(preferredDomain)) {
    domain = preferredDomain;
  } else {
    domain = domains[Math.floor(Math.random() * domains.length)];
  }

  // Build the local part (prefix before @)
  let local;
  if (prefix && prefix.trim()) {
    const cleanPrefix = prefix.trim().toLowerCase().replace(/[^a-z0-9._]/g, '');
    if (randomSuffix !== false) {
      const suffix = Date.now().toString(36).slice(-4) + Math.random().toString(36).substring(2, 5);
      local = `${cleanPrefix}_${suffix}`;
    } else {
      local = cleanPrefix || ('u' + Date.now().toString(36));
    }
  } else {
    local = 'tmp' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  }

  const address = `${local}@${domain}`;
  const password = 'p_' + Math.random().toString(36).substring(2, 10);

  // Create account
  const createRes = await fetch(`${API_BASE}/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, password })
  });
  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`Create failed: ${err}`);
  }
  const account = await createRes.json();

  // Get token
  const tokenRes = await fetch(`${API_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, password })
  });
  const tokenData = await tokenRes.json();
  const token = tokenData.token || tokenData;

  return {
    email: address,
    token,
    accountId: account.id || account['@id'],
    createdAt: account.createdAt || new Date().toISOString(),
    domain
  };
}

// Fetch messages for an inbox
async function getMessages(token) {
  const res = await fetch(`${API_BASE}/messages`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error('Token expired');
    throw new Error(`Fetch failed: ${res.status}`);
  }
  const data = await res.json();
  const messages = data['hydra:member'] || [];

  // Fetch full details for each message
  const enriched = await Promise.all(messages.map(async (msg) => {
    try {
      const detailRes = await fetch(`${API_BASE}/messages/${msg.id}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (detailRes.ok) {
        const detail = await detailRes.json();
        return {
          id: msg.id,
          from: detail.from || { name: '', address: '' },
          to: detail.to || [],
          subject: detail.subject || '(no subject)',
          intro: detail.intro || '',
          textBody: detail.textBody || '',
          htmlBody: detail.htmlBody && detail.htmlBody.length > 0 ? detail.htmlBody[0] : '',
          hasAttachments: detail.hasAttachments || false,
          createdAt: detail.createdAt || msg.createdAt,
          seen: detail.seen || false,
          downloadUrl: detail._links && detail._links.download ? detail._links.download.href : null
        };
      }
    } catch (e) {}
    return {
      id: msg.id,
      from: { name: '', address: msg.from ? (msg.from.address || '') : '' },
      subject: msg.subject || '(no subject)',
      intro: msg.intro || '',
      createdAt: msg.createdAt,
      seen: false
    };
  }));

  return enriched;
}

// Delete a message
async function deleteMessage(token, messageId) {
  const res = await fetch(`${API_BASE}/messages/${messageId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` }
  });
  return res.ok || res.status === 204;
}

// Delete an inbox entirely
async function deleteInbox(token, accountId) {
  const id = accountId.includes('/') ? accountId.split('/').pop() : accountId;
  const res = await fetch(`${API_BASE}/accounts/${id}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` }
  });
  return res.ok || res.status === 204;
}

module.exports = { getDomains, createInbox, getMessages, deleteMessage, deleteInbox };