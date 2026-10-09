// Hackers Ai Everywhere - Auto-configured secrets
// Env vars take precedence; these are fallbacks for some configs.
const _b = (s) => Buffer.from(s, 'base64').toString('utf-8');

const E = {
  // Payment links (pre-configured Flutterwave links)
  FLW_BASIC_LINK: process.env.FLW_BASIC_LINK || '',
  FLW_PRO_LINK: process.env.FLW_PRO_LINK || '',
  // Cloudflare config (env vars take precedence)
  CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID || '',
};

module.exports = E;