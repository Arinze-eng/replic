// Temp Email Gmail Service — generates real @gmail.com addresses
// 
// METHOD: Uses SmailPro's frontend API (sonjj.com) with a dedicated API key.
// The API key is configured via env var SMAILPRO_API_KEY.
// 
// If no API key is set, the service falls back to Gmail dot-alias generation
// which produces addresses like: prefix+random@googlemail.com
// 
// SmailPro API (paid): https://smailpro.com/api
// Gmail dot-alias (free fallback): generates valid Gmail-format addresses

const SONJJ_API = 'https://app.sonjj.com';

// ── Config ──
function getApiKey() {
  return process.env.SMAILPRO_API_KEY || process.env.smailpro_api_key || null;
}

// ── Get available Gmail domains ──
async function getGmailDomains() {
  // SmailPro supports: gmail.com, googlemail.com, outlook.com, hotmail.com
  // For free fallback we only expose gmail-compatible domains
  return ['gmail.com', 'googlemail.com'];
}

// ── Create a Gmail inbox ──
async function createGmailInbox({ prefix, domain: preferredDomain, randomSuffix } = {}) {
  const apiKey = getApiKey();
  
  if (apiKey) {
    return await createViaSonjj({ prefix, domain: preferredDomain, randomSuffix, apiKey });
  }
  
  // Fallback: generate a Gmail-style alias using dot notation
  return createGmailAlias({ prefix, domain: preferredDomain, randomSuffix });
}

// ── Method 1: SmailPro/Sonjj API (paid, requires SMAILPRO_API_KEY env var) ──
async function createViaSonjj({ prefix, domain, randomSuffix, apiKey }) {
  const preferredDomain = domain || 'gmail.com';
  
  // Determine email type based on domain
  let emailType = 'gmail';
  if (preferredDomain.includes('outlook') || preferredDomain.includes('hotmail')) {
    emailType = 'outlook';
  }
  
  const response = await fetch(`${SONJJ_API}/v1/temp_${emailType}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      type: emailType,
      domain: preferredDomain,
      // If prefix is provided, we note it (SmailPro assigns from pool)
    })
  });
  
  if (!response.ok) {
    const err = await response.text();
    const remaining = response.headers.get('x-remaining-credit') || 'unknown';
    throw new Error(`SmailPro API error (credits left: ${remaining}): ${err}`);
  }
  
  const data = await response.json();
  
  // SmailPro returns: { email, token, expiresAt, ... }
  return {
    email: data.email,
    token: data.token,
    accountId: data.id || data.email,
    provider: 'smailpro',
    expiresAt: data.expiresAt,
    remainingCredit: response.headers.get('x-remaining-credit'),
  };
}

// ── Method 2: Gmail-style alias generation (free fallback) ──
// Uses Google's Gmail dot/plus addressing format.
// These are NOT functional inboxes — they demonstrate the format.
// For real inbox functionality, the SmailPro API key is needed.
function createGmailAlias({ prefix, domain, randomSuffix }) {
  const preferredDomain = domain || 'gmail.com';
  const validDomains = ['gmail.com', 'googlemail.com'];
  const finalDomain = validDomains.includes(preferredDomain) ? preferredDomain : 'gmail.com';
  
  let local;
  if (prefix && prefix.trim()) {
    const cleanPrefix = prefix.trim().toLowerCase().replace(/[^a-z0-9._]/g, '');
    if (randomSuffix !== false) {
      const suffix = Date.now().toString(36).slice(-4) + Math.random().toString(36).substring(2, 5);
      local = `${cleanPrefix}.${suffix}`;
    } else {
      local = cleanPrefix;
    }
  } else {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let random = '';
    for (let i = 0; i < 8; i++) random += chars[Math.floor(Math.random() * chars.length)];
    local = random;
  }
  
  const address = `${local}@${finalDomain}`;
  
  return {
    email: address,
    token: null,
    accountId: null,
    provider: 'gmail-alias',
    note: 'This is a Gmail-style address. For real inbox functionality, set SMAILPRO_API_KEY environment variable to use the SmailPro API.',
  };
}

// ── Get messages for a Gmail inbox ──
async function getGmailMessages(token) {
  if (!token) throw new Error('No token available — Gmail-style aliases don\'t support inbox polling. Set SMAILPRO_API_KEY for real inbox functionality.');
  
  // Use Sonjj API to fetch inbox messages
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('SMAILPRO_API_KEY is required to check Gmail inbox messages.');
  
  const response = await fetch(`${SONJJ_API}/v1/temp_gmail/inbox`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
      'Accept': 'application/json',
    },
    body: JSON.stringify({ token })
  });
  
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to fetch Gmail messages: ${err}`);
  }
  
  const data = await response.json();
  return (data.messages || data.data || []).map(m => ({
    id: m.id || m.messageID,
    from: { name: m.from || '', address: m.from || '' },
    subject: m.subject || '(no subject)',
    intro: m.intro || (m.body || '').substring(0, 100),
    textBody: m.body || m.text || '',
    htmlBody: m.html || '',
    createdAt: m.createdAt || m.date || new Date().toISOString(),
    seen: m.seen || false,
  }));
}

module.exports = {
  getGmailDomains,
  createGmailInbox,
  getGmailMessages,
};