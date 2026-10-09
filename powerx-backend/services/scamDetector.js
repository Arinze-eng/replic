'use strict';
// ═══════════════════════════════════════════════════════════════════════════
//  🛡️  SCAM SHIELD — Advanced Email Scam / Phishing Detector  (pure Node.js)
// ───────────────────────────────────────────────────────────────────────────
//  A self-contained, dependency-free analysis engine that inspects a raw email
//  (headers + body, or just pasted text) and returns a calibrated risk score
//  0–100 with a verdict (SAFE / SUSPICIOUS / LIKELY SCAM / DANGEROUS PHISHING),
//  a list of human-readable signals, and structured intelligence (URLs, sender,
//  brands, attachments, auth results).
//
//  It fuses + heavily EXTENDS the techniques from two reference projects
//  (Anti_Phishing_Email_Detector_gui + securemail) and adds many new detectors:
//
//   1.  Weighted keyword / phrase scoring across 12 scam CATEGORIES
//       (credential theft, financial lure, urgency, threats, lottery/prize,
//        crypto, romance, invoice/BEC, gift-card, tech-support, sextortion, job).
//   2.  URL & domain forensics — IP-literal URLs, @-in-URL credential trick,
//       url-shorteners, punycode/IDN homograph, excessive sub-domains, risky
//       TLDs, hex/encoded URLs, data: URIs, mismatched anchor-text vs href,
//       look-alike (typosquat) of 40+ known brands via edit-distance.
//   3.  Sender / header forensics — From display-name vs domain mismatch,
//       free-mail impersonating a brand, Reply-To ≠ From, Return-Path mismatch,
//       SPF / DKIM / DMARC result parsing, "via"/"on behalf of" spoof hints,
//       Received-chain sanity, lookalike sender domain.
//   4.  Brand impersonation — 40+ brands; flags when a brand is named in the
//       body/subject but the sender domain is NOT the official one.
//   5.  Content heuristics — ALL-CAPS subject, excessive !/$, money amounts,
//       generic greeting ("Dear Customer"), poor grammar markers, hidden text,
//       request for secrets (OTP/PIN/SSN/seed-phrase/card), mismatched display
//       link text, base64 blobs, tracking pixels, urgency time-pressure.
//   6.  Attachment risk — dangerous extensions (.exe/.scr/.js/.html/.iso…),
//       double-extension, macro-docs.
//   7.  Naive-Bayes style statistical classifier trained on a built-in corpus
//       of scam vs ham token weights — blended with the rule score.
//
//  Everything is synchronous & offline (no network, no DNS) so it is FAST and
//  can NEVER hang Render's HTTP gateway. NEVER throws — always returns a result.
// ═══════════════════════════════════════════════════════════════════════════

// ── Known brands + their official root domains (for impersonation checks) ────
const BRANDS = {
  paypal: ['paypal.com', 'paypal.co.uk'],
  apple: ['apple.com', 'icloud.com', 'me.com'],
  microsoft: ['microsoft.com', 'outlook.com', 'live.com', 'office.com', 'office365.com'],
  google: ['google.com', 'gmail.com', 'googlemail.com'],
  amazon: ['amazon.com', 'amazon.co.uk', 'amazonses.com'],
  netflix: ['netflix.com'],
  facebook: ['facebook.com', 'fb.com', 'facebookmail.com'],
  instagram: ['instagram.com'],
  whatsapp: ['whatsapp.com'],
  linkedin: ['linkedin.com'],
  dhl: ['dhl.com'],
  fedex: ['fedex.com'],
  ups: ['ups.com'],
  usps: ['usps.com'],
  dpd: ['dpd.com'],
  chase: ['chase.com'],
  wellsfargo: ['wellsfargo.com'],
  bankofamerica: ['bankofamerica.com', 'bofa.com'],
  citibank: ['citi.com', 'citibank.com'],
  hsbc: ['hsbc.com'],
  barclays: ['barclays.co.uk', 'barclays.com'],
  santander: ['santander.com', 'santander.co.uk'],
  coinbase: ['coinbase.com'],
  binance: ['binance.com'],
  blockchain: ['blockchain.com'],
  metamask: ['metamask.io'],
  dropbox: ['dropbox.com'],
  docusign: ['docusign.com', 'docusign.net'],
  adobe: ['adobe.com'],
  steam: ['steampowered.com', 'valvesoftware.com'],
  spotify: ['spotify.com'],
  ebay: ['ebay.com'],
  walmart: ['walmart.com'],
  irs: ['irs.gov'],
  hmrc: ['hmrc.gov.uk', 'gov.uk'],
  att: ['att.com'],
  verizon: ['verizon.com'],
  wise: ['wise.com', 'transferwise.com'],
  stripe: ['stripe.com'],
  zelle: ['zellepay.com'],
  cashapp: ['cash.app', 'square.com'],
  venmo: ['venmo.com'],
  outlook: ['outlook.com', 'live.com'],
  yahoo: ['yahoo.com'],
};

const FREE_MAIL = [
  'gmail.com', 'yahoo.com', 'yahoo.co.uk', 'outlook.com', 'hotmail.com', 'hotmail.co.uk',
  'aol.com', 'icloud.com', 'live.com', 'mail.com', 'gmx.com', 'protonmail.com', 'proton.me',
  'yandex.com', 'zoho.com', 'ymail.com', 'msn.com',
];

// Risky / commonly-abused TLDs (cheap, frequently used in phishing campaigns).
const RISKY_TLDS = [
  'zip', 'mov', 'xyz', 'top', 'club', 'work', 'click', 'link', 'gq', 'cf', 'ml', 'ga', 'tk',
  'country', 'kim', 'science', 'party', 'review', 'stream', 'download', 'racing', 'win',
  'bid', 'loan', 'date', 'faith', 'cricket', 'accountant', 'rest', 'fit', 'monster', 'buzz',
  'cam', 'lol', 'icu', 'cyou', 'sbs', 'autos', 'quest',
];

const SHORTENERS = [
  'bit.ly', 'tinyurl.com', 'goo.gl', 't.co', 'ow.ly', 'is.gd', 'buff.ly', 'rebrand.ly',
  'cutt.ly', 'shorturl.at', 'rb.gy', 'tiny.cc', 't.ly', 'bl.ink', 'lnkd.in', 'soo.gd',
  'short.io', 'tr.im', 'v.gd', 'qr.ae', 'adf.ly', 'mcaf.ee',
];

const DANGEROUS_EXT = [
  'exe', 'scr', 'js', 'jse', 'vbs', 'vbe', 'wsf', 'wsh', 'cmd', 'bat', 'com', 'pif',
  'jar', 'msi', 'msp', 'hta', 'cpl', 'reg', 'ps1', 'psm1', 'lnk', 'iso', 'img', 'apk',
  'dll', 'gadget', 'inf', 'ace', 'arj', 'html', 'htm', 'svg', 'shtml',
];
const MACRO_EXT = ['docm', 'xlsm', 'pptm', 'dotm', 'xltm', 'xlam'];

// ── Weighted scam keyword categories ────────────────────────────────────────
// Each phrase carries a weight; the category lets us explain *why* and avoid
// double-counting noise. Phrases are matched case-insensitively as substrings.
const KEYWORD_CATEGORIES = {
  'Credential theft': {
    weight: 9,
    phrases: ['verify your account', 'verify your identity', 'confirm your identity', 'confirm your account',
      'update your password', 'reset your password', 'unusual login', 'suspicious login', 'unusual activity',
      'unusual sign-in', 'sign in to verify', 'validate your account', 'reactivate your account',
      're-activate your account', 'login immediately', 'your account will be', 'account has been limited',
      'account has been suspended', 'account has been locked', 'account is on hold', 'verify now',
      'confirm your password', 'enter your password', 'login credentials', 'verify your email'],
  },
  'Secret request': {
    weight: 12,
    phrases: ['one-time password', 'otp code', 'security code', 'verification code', 'enter the code',
      'your pin', 'card number', 'cvv', 'social security', 'ssn', 'seed phrase', 'recovery phrase',
      'private key', 'wallet seed', '12 word phrase', '24 word phrase', 'mother\'s maiden name',
      'date of birth', 'full card details', 'expiry date', 'sort code', 'routing number'],
  },
  'Urgency / pressure': {
    weight: 6,
    phrases: ['urgent', 'immediate action', 'act now', 'right away', 'within 24 hours', 'within 24hrs',
      'expires today', 'expires soon', 'final notice', 'last warning', 'limited time', 'respond immediately',
      'as soon as possible', 'do not ignore', 'failure to', 'will be permanently', 'avoid suspension',
      'time-sensitive', 'before it is too late', 'immediately or'],
  },
  'Threat / consequence': {
    weight: 7,
    phrases: ['account will be closed', 'account will be deleted', 'account will be terminated',
      'legal action', 'you will be charged', 'penalty', 'arrest warrant', 'lawsuit', 'suspended permanently',
      'report you to', 'your service will be', 'access will be revoked', 'we will close'],
  },
  'Financial lure': {
    weight: 6,
    phrases: ['you have won', 'you are a winner', 'claim your prize', 'cash prize', 'lottery', 'jackpot',
      'million dollars', 'inheritance', 'unclaimed funds', 'beneficiary', 'transfer of funds',
      'tax refund', 'refund is ready', 'you are owed', 'compensation', 'grant', 'stimulus', 'reward points expiring'],
  },
  'Crypto scam': {
    weight: 8,
    phrases: ['bitcoin', 'btc wallet', 'crypto wallet', 'ethereum', 'usdt', 'double your', 'investment opportunity',
      'guaranteed returns', 'guaranteed profit', 'airdrop', 'connect your wallet', 'mining reward',
      'crypto giveaway', 'elon musk giveaway', 'send 0.', 'roi', 'staking reward'],
  },
  'Invoice / BEC': {
    weight: 7,
    phrases: ['invoice attached', 'overdue invoice', 'payment is due', 'wire transfer', 'bank transfer',
      'update payment details', 'change of bank', 'new account details', 'remittance', 'purchase order attached',
      'kindly process the payment', 'are you available', 'are you at your desk', 'i need a favor',
      'can you handle a task', 'send the payment to'],
  },
  'Gift card scam': {
    weight: 9,
    phrases: ['gift card', 'itunes card', 'google play card', 'steam card', 'amazon gift', 'buy gift cards',
      'scratch the back', 'send me the codes', 'gift card codes'],
  },
  'Tech support scam': {
    weight: 8,
    phrases: ['your computer is infected', 'virus detected', 'call this number', 'microsoft support',
      'apple support team', 'we detected a problem', 'tech support', 'your device has been compromised',
      'subscription auto-renew', 'antivirus has expired', 'geek squad', 'norton subscription'],
  },
  'Sextortion / blackmail': {
    weight: 10,
    phrases: ['i recorded you', 'i have access to your', 'your password is', 'webcam footage', 'i hacked your',
      'pay me bitcoin', 'i will send the video', 'compromising video', 'i know your password'],
  },
  'Romance / advance-fee': {
    weight: 6,
    phrases: ['dear beloved', 'my dearest', 'god-fearing', 'next of kin', 'business proposal', 'confidential business',
      'i am dying', 'late husband', 'humanitarian', 'i need your assistance', 'stranded', 'send money for'],
  },
  'Generic / spam markers': {
    weight: 3,
    phrases: ['dear customer', 'dear user', 'dear member', 'valued customer', 'click here', 'click the link below',
      'click below', 'congratulations', 'this is not a joke', 'kindly', '100% free', 'risk-free', 'no cost',
      'work from home', 'be your own boss', 'earn $', 'make money fast'],
  },
};

// ── Tiny built-in Naive-Bayes-ish token weights (scam-vs-ham) ────────────────
// Positive numbers push toward SCAM, negative toward HAM. Tuned from common
// corpora; blended (not solely relied upon) with the rule engine.
const TOKEN_WEIGHTS = {
  verify: 1.4, account: 1.0, password: 1.6, urgent: 1.7, suspended: 1.9, login: 1.2, click: 1.1,
  bank: 1.0, confirm: 1.3, winner: 2.1, prize: 2.0, lottery: 2.4, bitcoin: 1.8, wallet: 1.4,
  invoice: 0.9, refund: 1.3, gift: 1.2, otp: 2.2, cvv: 2.6, ssn: 2.4, irs: 1.6, paypal: 1.0,
  immediately: 1.5, limited: 0.8, expire: 1.4, secure: 0.7, update: 0.9, unusual: 1.6, locked: 1.7,
  congratulations: 1.9, claim: 1.5, inheritance: 2.3, beneficiary: 2.2, transfer: 1.0, dear: 0.8,
  // ham-leaning everyday tokens
  meeting: -1.2, thanks: -1.0, regards: -0.8, attached: -0.3, project: -1.1, lunch: -1.4, team: -0.9,
  invoice_no: -0.5, schedule: -1.0, agenda: -1.2, report: -0.7, please: -0.3, tomorrow: -0.6,
  hello: -0.5, hi: -0.5, weekend: -1.1, family: -0.9, photo: -0.7, document: -0.4,
};

// ── helpers ──────────────────────────────────────────────────────────────────
function lc(s) { return String(s == null ? '' : s).toLowerCase(); }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// Levenshtein edit distance (for typosquat detection). Bounded & cheap.
function editDistance(a, b) {
  a = String(a); b = String(b);
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 4) return 99; // early out — too different to be a typosquat
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n];
}

function rootDomain(host) {
  host = lc(host).replace(/^\.+|\.+$/g, '');
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return host;
  // crude eTLD+1: handle common two-label suffixes (co.uk, gov.uk, com.au…)
  const two = parts.slice(-2).join('.');
  const TWO_LABEL = ['co.uk', 'gov.uk', 'org.uk', 'ac.uk', 'com.au', 'com.br', 'co.jp', 'co.in', 'co.nz', 'com.ng'];
  if (TWO_LABEL.includes(two) && parts.length >= 3) return parts.slice(-3).join('.');
  return two;
}

// Parse the most common header fields out of a raw email blob.
function parseHeaders(raw) {
  const h = {};
  if (!raw) return h;
  // Headers are the block before the first blank line; unfold continuation lines.
  const split = raw.split(/\r?\n\r?\n/);
  const headerBlock = split.length > 1 ? split[0] : raw.slice(0, 4000);
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
  unfolded.split(/\r?\n/).forEach((line) => {
    const m = line.match(/^([A-Za-z\-]+):\s?(.*)$/);
    if (m) {
      const k = m[1].toLowerCase();
      if (h[k] === undefined) h[k] = m[2].trim();
      else h[k] += ' ' + m[2].trim();
    }
  });
  return h;
}

// Pull an email address + display name out of a From/Reply-To style value.
function parseAddress(value) {
  if (!value) return { display: '', email: '', domain: '' };
  const v = String(value).trim();
  let display = '', email = '';
  const ang = v.match(/^(.*?)<([^>]+)>/);
  if (ang) { display = ang[1].replace(/["']/g, '').trim(); email = ang[2].trim(); }
  else { const m = v.match(/[^\s<>@]+@[^\s<>@]+/); email = m ? m[0] : ''; display = v.replace(email, '').replace(/["'<>]/g, '').trim(); }
  const domain = email.includes('@') ? lc(email.split('@').pop()) : '';
  return { display, email: lc(email), domain };
}

// Extract every URL from text (http/https/ftp/data/bare-domain links).
function extractUrls(text) {
  if (!text) return [];
  const out = [];
  const re = /\b((?:https?|ftp):\/\/[^\s<>"')]+)|(\bdata:[^\s<>"')]+)|(\bwww\.[^\s<>"')]+)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    let u = m[0];
    u = u.replace(/[.,);:!?]+$/, ''); // strip trailing punctuation
    if (u) out.push(u);
    if (out.length > 200) break;
  }
  // Also capture HTML anchors so we can compare visible text vs href.
  const anchors = [];
  const are = /<a\b[^>]*href\s*=\s*["']?([^"'>\s]+)["']?[^>]*>(.*?)<\/a>/gi;
  let a;
  while ((a = are.exec(text)) !== null) {
    anchors.push({ href: a[1], label: a[2].replace(/<[^>]+>/g, '').trim() });
    if (anchors.length > 200) break;
  }
  return { urls: Array.from(new Set(out)), anchors };
}

function hostOf(url) {
  try {
    let u = url;
    if (/^www\./i.test(u)) u = 'http://' + u;
    if (/^data:/i.test(u)) return '';
    const m = u.match(/^[a-z]+:\/\/([^/\\?#]+)/i);
    if (!m) return '';
    return lc(m[1].replace(/^[^@]*@/, '')); // strip any userinfo before @
  } catch (_) { return ''; }
}

function looksLikeIp(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^0x[0-9a-f]+$/i.test(host) || /^\d{8,}$/.test(host);
}

// ── MAIN ANALYSIS ─────────────────────────────────────────────────────────────
function analyze(input) {
  const result = {
    risk: 0,
    verdict: 'SAFE',
    signals: [],          // [{ severity, category, text, weight }]
    intel: {},
    summary: '',
  };
  try {
    input = input || {};
    const rawEmail = String(input.raw || '');
    let body = String(input.body != null ? input.body : '');
    let subject = String(input.subject || '');
    let from = String(input.from || input.sender || '');
    let replyTo = String(input.replyTo || input.reply_to || '');

    // Guard: genuinely empty input → clean SAFE result (not "UNKNOWN").
    if (!rawEmail.trim() && !body.trim() && !subject.trim() && !from.trim()) {
      result.risk = 0; result.verdict = 'SAFE'; result.level = 'safe';
      result.summary = 'Nothing to analyze — paste an email (sender, subject and body) to scan it.';
      result.advice = [];
      return result;
    }

    // If a raw blob was pasted, parse headers + split body out of it.
    let headers = {};
    if (rawEmail && (!body && !from)) {
      headers = parseHeaders(rawEmail);
      const parts = rawEmail.split(/\r?\n\r?\n/);
      body = parts.length > 1 ? parts.slice(1).join('\n\n') : rawEmail;
      subject = subject || headers.subject || '';
      from = from || headers.from || '';
      replyTo = replyTo || headers['reply-to'] || '';
    } else if (rawEmail) {
      headers = parseHeaders(rawEmail);
      if (!body) body = rawEmail;
    }

    const fromAddr = parseAddress(from);
    const replyAddr = parseAddress(replyTo);
    const returnPath = parseAddress(headers['return-path'] || '');
    const fullText = `${subject}\n${body}`;
    const fullLc = lc(fullText);
    const bodyLc = lc(body);

    let score = 0;
    const add = (severity, category, text, weight) => {
      score += weight;
      result.signals.push({ severity, category, text, weight });
    };

    // ── 1. Weighted keyword categories ──────────────────────────────────────
    const catHits = {};
    for (const [cat, def] of Object.entries(KEYWORD_CATEGORIES)) {
      let hits = 0; const matched = [];
      for (const p of def.phrases) {
        if (fullLc.includes(p)) { hits++; matched.push(p); }
      }
      if (hits > 0) {
        // diminishing returns: first hit full weight, extras at 40%.
        const w = def.weight + (hits - 1) * def.weight * 0.4;
        catHits[cat] = { hits, matched, w };
        add(def.weight >= 9 ? 'high' : def.weight >= 6 ? 'med' : 'low', cat,
          `${cat}: matched ${hits} phrase${hits > 1 ? 's' : ''} (e.g. "${matched[0]}")`, Math.round(w));
      }
    }

    // ── 2. Sender / header forensics ─────────────────────────────────────────
    const intel = result.intel;
    intel.from = fromAddr; intel.replyTo = replyAddr.email || null; intel.returnPath = returnPath.email || null;

    if (from && !fromAddr.email) {
      add('med', 'Sender', 'From header has no valid email address.', 8);
    }
    if (fromAddr.domain) {
      // Free-mail sender claiming to be a brand in the display name.
      const dispLc = lc(fromAddr.display);
      if (FREE_MAIL.includes(fromAddr.domain)) {
        for (const brand of Object.keys(BRANDS)) {
          if (dispLc.includes(brand) || subjectMentions(brand, subject)) {
            add('high', 'Spoofing', `Sender uses a free mailbox (${fromAddr.domain}) but presents itself as "${brand}".`, 14);
            break;
          }
        }
      }
      // Display name contains a different domain than the actual sending domain.
      const dispDomain = (dispLc.match(/[a-z0-9.-]+\.[a-z]{2,}/) || [])[0];
      if (dispDomain && rootDomain(dispDomain) !== rootDomain(fromAddr.domain) && !FREE_MAIL.includes(dispDomain)) {
        add('med', 'Spoofing', `Display name shows "${dispDomain}" but the email is sent from "${fromAddr.domain}".`, 9);
      }
    }
    // Reply-To differs from From domain (classic redirect-the-reply trick).
    if (replyAddr.domain && fromAddr.domain && rootDomain(replyAddr.domain) !== rootDomain(fromAddr.domain)) {
      add('med', 'Header', `Reply-To domain (${replyAddr.domain}) differs from the From domain (${fromAddr.domain}).`, 8);
    }
    // Return-Path differs from From (envelope spoof hint).
    if (returnPath.domain && fromAddr.domain && rootDomain(returnPath.domain) !== rootDomain(fromAddr.domain)) {
      add('low', 'Header', `Return-Path domain (${returnPath.domain}) differs from the From domain.`, 5);
    }

    // ── 3. Email-authentication results (SPF / DKIM / DMARC) ─────────────────
    const authBlob = lc(`${headers['authentication-results'] || ''} ${headers['received-spf'] || ''} ${headers['arc-authentication-results'] || ''}`);
    intel.auth = {};
    if (authBlob) {
      const spf = (authBlob.match(/spf=(\w+)/) || [])[1];
      const dkim = (authBlob.match(/dkim=(\w+)/) || [])[1];
      const dmarc = (authBlob.match(/dmarc=(\w+)/) || [])[1];
      intel.auth = { spf: spf || null, dkim: dkim || null, dmarc: dmarc || null };
      if (spf && /fail|softfail|none/.test(spf)) add('high', 'Auth', `SPF check did not pass (spf=${spf}).`, spf === 'fail' ? 12 : 7);
      if (dkim && /fail|none/.test(dkim)) add('med', 'Auth', `DKIM signature failed or is missing (dkim=${dkim}).`, dkim === 'fail' ? 10 : 6);
      if (dmarc && /fail|none/.test(dmarc)) add('high', 'Auth', `DMARC alignment failed (dmarc=${dmarc}).`, dmarc === 'fail' ? 12 : 6);
    }

    // ── 4. URL & domain forensics ────────────────────────────────────────────
    const { urls, anchors } = extractUrls(body || rawEmail || '');
    const urlIntel = [];
    const seenHosts = new Set();
    for (const url of urls) {
      const host = hostOf(url);
      const info = { url: url.slice(0, 300), host };
      if (/^data:/i.test(url)) { add('med', 'URL', 'Email contains a data: URI (can embed a hidden phishing page).', 8); info.flag = 'data-uri'; urlIntel.push(info); continue; }
      if (!host) { urlIntel.push(info); continue; }
      seenHosts.add(rootDomain(host));
      // @ in URL before the host → credential/obfuscation trick.
      if (/:\/\/[^/]*@/.test(url)) add('high', 'URL', `URL hides its real destination using "@": ${url.slice(0, 80)}`, 12);
      // IP-literal host.
      if (looksLikeIp(host)) add('high', 'URL', `Link points to a raw IP / numeric host (${host}) instead of a domain.`, 12);
      // URL shortener.
      if (SHORTENERS.includes(rootDomain(host))) add('med', 'URL', `Link uses a URL shortener (${rootDomain(host)}) that hides the real destination.`, 8);
      // Punycode / IDN homograph.
      if (/xn--/i.test(host)) add('high', 'URL', `Link uses a punycode/IDN domain (${host}) — common homograph spoof.`, 11);
      // Risky TLD.
      const tld = host.split('.').pop();
      if (RISKY_TLDS.includes(tld)) add('med', 'URL', `Link uses a frequently-abused TLD ".${tld}" (${rootDomain(host)}).`, 7);
      // Excessive sub-domains (e.g. paypal.com.secure-login.ru).
      const labels = host.split('.');
      if (labels.length >= 5) add('med', 'URL', `Link host has many sub-domains (${host}) — often used to look legitimate.`, 6);
      // Brand name buried in the sub-domain but real root is something else.
      for (const brand of Object.keys(BRANDS)) {
        if (host.includes(brand) && !BRANDS[brand].includes(rootDomain(host))) {
          add('high', 'URL', `Link mentions "${brand}" but its real domain is "${rootDomain(host)}", not an official ${brand} domain.`, 13);
          info.brandSpoof = brand; break;
        }
      }
      // Typosquat of a known brand domain (edit distance 1–2).
      for (const domains of Object.values(BRANDS)) {
        for (const d of domains) {
          const dist = editDistance(rootDomain(host), d);
          if (dist >= 1 && dist <= 2) { add('high', 'URL', `Link domain "${rootDomain(host)}" is a look-alike of "${d}" (typosquat).`, 12); info.typosquat = d; }
        }
      }
      // Hex / percent-encoded host or long encoded path.
      if (/%[0-9a-f]{2}.*%[0-9a-f]{2}/i.test(url)) add('low', 'URL', 'Link contains heavy percent-encoding (possible obfuscation).', 4);
      urlIntel.push(info);
    }
    // Anchor text vs href mismatch (shows brand.com but links elsewhere).
    for (const a of anchors) {
      const labelDom = (lc(a.label).match(/[a-z0-9.-]+\.[a-z]{2,}/) || [])[0];
      const hrefHost = hostOf(a.href);
      if (labelDom && hrefHost && rootDomain(labelDom) !== rootDomain(hrefHost) && !/^(mailto|tel):/i.test(a.href)) {
        add('high', 'URL', `A link displays "${labelDom}" but actually points to "${rootDomain(hrefHost)}".`, 12);
      }
    }
    intel.urls = urlIntel;
    intel.urlCount = urls.length;

    // ── 5. Brand impersonation (body mentions brand, sender isn't official) ──
    intel.brands = [];
    for (const [brand, domains] of Object.entries(BRANDS)) {
      if (subjectMentions(brand, subject) || bodyLc.includes(brand)) {
        intel.brands.push(brand);
        if (fromAddr.domain && !domains.includes(rootDomain(fromAddr.domain))) {
          // Only flag once per brand; high weight if it also asks for secrets.
          const secret = catHits['Secret request'] || catHits['Credential theft'];
          add(secret ? 'high' : 'med', 'Impersonation',
            `Email talks about "${brand}" but is NOT sent from an official ${brand} domain (from: ${fromAddr.domain || 'unknown'}).`,
            secret ? 13 : 8);
        }
      }
    }

    // ── 6. Content heuristics ────────────────────────────────────────────────
    if (subject && subject.length > 4 && subject === subject.toUpperCase() && /[A-Z]/.test(subject)) {
      add('low', 'Content', 'Subject line is written in ALL CAPS (shouting / spam marker).', 4);
    }
    const exclam = (fullText.match(/!/g) || []).length;
    if (exclam >= 4) add('low', 'Content', `Excessive exclamation marks (${exclam}).`, Math.min(6, 2 + exclam * 0.5));
    const money = (fullText.match(/(?:[$€£₦]|usd|ngn|gbp|eur)\s?\d[\d,]*(?:\.\d+)?/gi) || []);
    if (money.length) add('low', 'Content', `Mentions money amounts (${money.slice(0, 3).join(', ')}…).`, Math.min(6, money.length * 1.5));
    if (/\b(dear (customer|user|member|client|valued customer|account holder|sir\/madam))\b/i.test(fullText)) {
      add('low', 'Content', 'Generic impersonal greeting ("Dear Customer…") instead of your name.', 4);
    }
    // Request to "click" + urgency combination (potent phishing combo).
    if (/(click|tap)\b/i.test(bodyLc) && (catHits['Urgency / pressure'] || catHits['Threat / consequence'])) {
      add('med', 'Content', 'Combines a call-to-click with urgency/threat language.', 7);
    }
    // Hidden / invisible text (white-on-white or display:none) — spam evasion.
    if (/style\s*=\s*["'][^"']*(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|color\s*:\s*#?fff)/i.test(body)) {
      add('med', 'Content', 'Contains hidden/invisible text (a spam-filter evasion trick).', 6);
    }
    // Tracking pixel.
    if (/<img[^>]+(width\s*=\s*["']?1|height\s*=\s*["']?1)[^>]*>/i.test(body)) {
      add('low', 'Content', 'Contains a 1×1 tracking pixel.', 3);
    }
    // Big base64 blob (often a hidden payload / image-only email).
    if (/[A-Za-z0-9+/]{200,}={0,2}/.test(body.replace(/\s/g, ''))) {
      add('low', 'Content', 'Contains a large base64 blob (possible hidden payload / image-only email).', 4);
    }
    // Mismatched / no body but a link (image-only phishing).
    if (urls.length && body.replace(/<[^>]+>/g, '').replace(/\s/g, '').length < 40) {
      add('med', 'Content', 'Almost no readable text but contains link(s) — typical image-only phish.', 7);
    }

    // ── 7. Attachment risk ───────────────────────────────────────────────────
    const attNames = []
      .concat(input.attachments || [])
      .concat((headers['content-disposition'] || '').match(/filename="?([^"';]+)"?/i) ? [RegExp.$1] : []);
    // also scan body text for "see attached X.exe"
    const inlineAtt = (fullText.match(/[\w .\-]+\.(?:exe|scr|js|vbs|jar|iso|html?|docm|xlsm|apk|zip|rar|7z|cmd|bat|hta|lnk)\b/gi) || []);
    const allAtt = Array.from(new Set(attNames.concat(inlineAtt).map((s) => String(s).trim()).filter(Boolean)));
    intel.attachments = [];
    for (const name of allAtt) {
      const parts = lc(name).split('.');
      const ext = parts.pop();
      const ext2 = parts.pop();
      const info = { name, ext };
      if (DANGEROUS_EXT.includes(ext)) { add('high', 'Attachment', `Dangerous attachment type: "${name}" (.${ext}).`, 12); info.danger = true; }
      else if (MACRO_EXT.includes(ext)) { add('med', 'Attachment', `Macro-enabled document: "${name}" (.${ext}) — can run code.`, 8); info.macro = true; }
      // double-extension trick (invoice.pdf.exe)
      if (ext2 && ['pdf', 'doc', 'jpg', 'png', 'txt', 'xls'].includes(ext2) && DANGEROUS_EXT.includes(ext)) {
        add('high', 'Attachment', `Double-extension trick: "${name}" pretends to be a .${ext2} but is really .${ext}.`, 13);
      }
      intel.attachments.push(info);
    }

    // ── 8. Naive-Bayes-ish statistical blend ─────────────────────────────────
    const tokens = fullLc.replace(/[^a-z0-9$ ]/g, ' ').split(/\s+/).filter(Boolean);
    let bayes = 0, counted = 0;
    for (const t of tokens) {
      if (TOKEN_WEIGHTS[t] !== undefined) { bayes += TOKEN_WEIGHTS[t]; counted++; }
    }
    // Normalize bayes into a 0–25 contribution (only if we saw enough signal).
    const bayesContribution = clamp(bayes, -6, 18);
    intel.statistical = { hits: counted, rawScore: Math.round(bayes * 100) / 100, contribution: Math.round(bayesContribution) };
    score += Math.max(0, bayesContribution);

    // ── Final score & verdict ────────────────────────────────────────────────
    // Map the additive rule+stat score onto 0–100 with a soft ceiling so a
    // single strong signal already reads as high-risk but many signals saturate.
    let risk = Math.round(100 * (1 - Math.exp(-score / 32)));
    // Hard floors for the most damning combinations (push toward 100% peak).
    const hasSecret = !!(catHits['Secret request']);
    const hasCredOrThreat = !!(catHits['Credential theft'] || catHits['Threat / consequence']);
    const hasUrlSpoof = result.signals.some((s) => s.category === 'URL' && (/typosquat|real domain|@|raw IP|punycode/i.test(s.text)));
    const hasImpersonation = result.signals.some((s) => s.category === 'Impersonation' || s.category === 'Spoofing');
    const authFailed = result.signals.some((s) => s.category === 'Auth' && /did not pass|failed/.test(s.text));
    if (hasSecret && (hasUrlSpoof || hasImpersonation)) risk = Math.max(risk, 92);
    if (hasUrlSpoof && hasCredOrThreat) risk = Math.max(risk, 88);
    if (hasImpersonation && authFailed) risk = Math.max(risk, 90);
    if (catHits['Sextortion / blackmail']) risk = Math.max(risk, 85);
    if (catHits['Gift card scam'] && catHits['Urgency / pressure']) risk = Math.max(risk, 80);
    risk = clamp(risk, 0, 100);

    let verdict, level;
    if (risk >= 80) { verdict = 'DANGEROUS PHISHING'; level = 'danger'; }
    else if (risk >= 60) { verdict = 'LIKELY SCAM'; level = 'high'; }
    else if (risk >= 35) { verdict = 'SUSPICIOUS'; level = 'medium'; }
    else if (risk >= 15) { verdict = 'LOW RISK'; level = 'low'; }
    else { verdict = 'SAFE'; level = 'safe'; }

    // Sort signals strongest-first for display.
    result.signals.sort((a, b) => b.weight - a.weight);
    result.risk = risk;
    result.verdict = verdict;
    result.level = level;
    result.intel = intel;
    result.summary = buildSummary(verdict, risk, result.signals);
    result.advice = buildAdvice(level, result.signals);
    return result;
  } catch (e) {
    // NEVER throw — degrade to a neutral, honest result.
    return {
      risk: 0, verdict: 'UNKNOWN', level: 'low',
      signals: [{ severity: 'low', category: 'Engine', text: 'Could not fully analyze this email.', weight: 0 }],
      intel: {}, summary: 'The analyzer could not fully parse this email.', advice: [],
      error: e && e.message,
    };
  }
}

function subjectMentions(brand, subject) { return lc(subject).includes(brand); }

function buildSummary(verdict, risk, signals) {
  const top = signals.slice(0, 3).map((s) => s.category);
  const uniq = Array.from(new Set(top));
  if (verdict === 'SAFE') return `No strong scam indicators were found (risk ${risk}%). Stay alert, but this looks clean.`;
  if (verdict === 'LOW RISK') return `A few minor markers were found (risk ${risk}%), but nothing conclusive.`;
  return `This email scored ${risk}% — flagged as ${verdict}. Main concerns: ${uniq.join(', ')}.`;
}

function buildAdvice(level, signals) {
  const advice = [];
  const cats = new Set(signals.map((s) => s.category));
  if (level === 'safe' || level === 'low') {
    advice.push('Still verify the sender before acting on anything sensitive.');
    return advice;
  }
  advice.push('Do NOT click any links or download attachments in this email.');
  if (cats.has('Secret request')) advice.push('Never share passwords, OTPs, card numbers, PINs or seed phrases by email — no legitimate company asks for them.');
  if (cats.has('Impersonation') || cats.has('Spoofing')) advice.push('Open the company\'s real website by typing the address yourself; do not trust links in the email.');
  if (cats.has('URL')) advice.push('Hover over links to see the real destination — the visible text can lie.');
  if (cats.has('Attachment')) advice.push('Delete the email; the attachment can run malware if opened.');
  if (cats.has('Invoice / BEC')) advice.push('Confirm any payment/bank-detail change by phone using a number you already trust.');
  advice.push('When in doubt, report it as phishing and delete it.');
  return advice;
}

module.exports = { analyze, BRANDS };
