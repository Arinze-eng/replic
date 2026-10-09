// ── Telegram bridge for the WhatsApp Online Tracker ────────────────────────
// Flow:
//   1. Website user (logged in) enters their WhatsApp number, gets a deep-link
//      https://t.me/<bot>?start=<token>
//   2. They open the bot. /start <token> binds their Telegram chat to the
//      website user, then the bot auto-generates a WhatsApp pairing code
//      (via the Baileys session in services/whatsapp.js) and sends it in chat.
//   3. User enters that code in WhatsApp → Baileys reports "connected" →
//      bot sends a "✅ Linked!" message and the website unlocks tracking.
//   4. Every online/offline transition is pushed to the user's Telegram chat.
//
// Uses raw Telegram Bot API via node-fetch + long-polling (getUpdates), so no
// public webhook URL is required — works on Render free tier.

const fetch = require('node-fetch');
const db = require('../db');

// ── Runtime-first bot token ────────────────────────────────────────────────
// The token resolves in this order: runtime DB setting (`telegram_bot_token`,
// admin-settable, survives redeploys) → env TELEGRAM_BOT_TOKEN → empty. We keep
// `API` mutable and (re)build it in start() so a token saved from the admin
// panel takes effect on the next process start WITHOUT a code change. A baked
// env value still works as a fallback.
let BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
let API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;

async function resolveToken() {
  try {
    const runtime = await db.getSetting('telegram_bot_token');
    if (runtime && String(runtime).trim()) return String(runtime).trim();
  } catch (_) {}
  return process.env.TELEGRAM_BOT_TOKEN || '';
}

let waTracker = null; // injected to avoid circular require
function attachWaTracker(mod) { waTracker = mod; }

let polling = false;
let offset = 0;

function enabled() { return !!API; }

// ── Low-level Telegram helpers ──
async function tg(method, body) {
  if (!API) return null;
  try {
    const r = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await r.json();
  } catch (e) {
    console.error('TG api error', method, e.message);
    return null;
  }
}

async function sendMessage(chatId, text, extra = {}) {
  if (!chatId) return;
  return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
}

// ── Public helpers used by server.js ──

// Create (or refresh) a one-time link token for a user and return the deep link.
async function createLinkToken(userId, phone) {
  const token = 'lk_' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 8);
  await db.upsertTelegramLink(userId, {
    link_token: token,
    phone: phone || null,
    state: 'pending',
    updated_at: db.nowISO(),
  });
  return token;
}

async function getLink(userId) {
  return db.getTelegramLink(userId);
}

// Send a notification to a user's Telegram chat (used by whatsapp.js for events)
async function notifyUser(userId, text) {
  try {
    const link = await db.getTelegramLink(userId);
    if (link && link.chat_id) await sendMessage(link.chat_id, text);
  } catch (e) {}
}

// ── Bot command / message handling ──
async function handleUpdate(update) {
  try {
    const msg = update.message || update.edited_message;
    if (!msg || !msg.chat) return;
    const chatId = String(msg.chat.id);
    const text = (msg.text || '').trim();
    const username = msg.from?.username || '';

    // /start <token>  →  bind chat to website user, then start WA pairing
    if (text.startsWith('/start')) {
      const parts = text.split(/\s+/);
      const tokenArg = parts[1];

      if (!tokenArg) {
        await sendMessage(chatId,
          '👋 <b>WhatsApp Online Tracker</b>\n\n' +
          'To link your account, open the tracker on the website and tap ' +
          '<b>“Connect via Telegram”</b>. That button brings you back here with your number ready.\n\n' +
          'Then I’ll generate your WhatsApp pairing code automatically. 🟢');
        return;
      }

      const link = await db.getTelegramLinkByToken(tokenArg);
      if (!link) {
        await sendMessage(chatId, '⚠️ This link has expired. Go back to the website and tap <b>“Connect via Telegram”</b> again.');
        return;
      }

      // Bind this Telegram chat to the website user
      await db.upsertTelegramLink(link.user_id, {
        chat_id: chatId,
        tg_username: username,
        state: 'awaiting_code',
        updated_at: db.nowISO(),
      });

      const phone = link.phone;
      if (!phone) {
        await sendMessage(chatId, '✅ Telegram linked!\n\nNow send me your WhatsApp number in international format (e.g. <code>2348012345678</code>).');
        return;
      }

      await sendMessage(chatId,
        `✅ <b>Telegram linked!</b>\n\n📱 WhatsApp number: <code>${phone}</code>\n\n⏳ Generating your pairing code…`);
      await startPairing(link.user_id, chatId, phone);
      return;
    }

    // Bare phone number sent in chat (when no phone was pre-filled)
    const digits = text.replace(/[^0-9]/g, '');
    if (digits.length >= 8 && digits.length <= 15 && /^[0-9+\s\-()]+$/.test(text)) {
      const link = await db.getTelegramLinkByChat(chatId);
      if (link) {
        await db.upsertTelegramLink(link.user_id, { phone: digits, state: 'awaiting_code', updated_at: db.nowISO() });
        await sendMessage(chatId, `📱 Number set: <code>${digits}</code>\n\n⏳ Generating your pairing code…`);
        await startPairing(link.user_id, chatId, digits);
      } else {
        await sendMessage(chatId, 'Open the tracker on the website first and tap <b>“Connect via Telegram”</b>.');
      }
      return;
    }

    if (text === '/status') {
      const link = await db.getTelegramLinkByChat(chatId);
      if (!link) { await sendMessage(chatId, 'No linked account. Use the website to connect.'); return; }
      const st = waTracker ? await waTracker.getStatus(link.user_id) : null;
      await sendMessage(chatId, `Status: <b>${st?.status || 'unknown'}</b>${st?.phone ? ' · ' + st.phone : ''}`);
      return;
    }

    // fallback
    await sendMessage(chatId, 'Send your WhatsApp number, or use the <b>“Connect via Telegram”</b> button on the website. Type /status to check your link.');
  } catch (e) {
    console.error('TG handleUpdate error:', e.message);
  }
}

// Trigger the Baileys pairing-code generation and relay code + result to TG
async function startPairing(userId, chatId, phone) {
  if (!waTracker) { await sendMessage(chatId, '⚠️ Tracker service not ready, try again in a moment.'); return; }
  try {
    const result = await waTracker.linkAccount(userId, phone);
    if (result.status === 'connected') {
      await sendMessage(chatId, '🎉 <b>Already linked!</b> You can now add numbers to track on the website.');
      return;
    }
    if (result.pairing_code) {
      await sendMessage(chatId,
        `🔑 <b>Your WhatsApp pairing code:</b>\n\n<code>${result.pairing_code}</code>\n\n` +
        `<b>How to enter it:</b>\n` +
        `1. Open <b>WhatsApp</b> on the phone for ${phone}\n` +
        `2. Tap <b>⋮ → Linked devices → Link a device</b>\n` +
        `3. Tap <b>“Link with phone number instead”</b>\n` +
        `4. Enter the code above\n\n` +
        `⏳ I’ll message you the moment it connects.`);
    } else {
      await sendMessage(chatId, `⚠️ Couldn’t generate a code (${result.error || result.status}). Send your number again to retry.`);
    }
  } catch (e) {
    await sendMessage(chatId, `⚠️ Error generating code: ${e.message}. Send your number again to retry.`);
  }
}

// ── Long-polling loop ──
async function pollLoop() {
  if (!API) return;
  while (polling) {
    try {
      const r = await fetch(`${API}/getUpdates?timeout=30&offset=${offset}`, { timeout: 40000 });
      const data = await r.json();
      if (data && data.ok && Array.isArray(data.result)) {
        for (const upd of data.result) {
          offset = upd.update_id + 1;
          handleUpdate(upd).catch(() => {});
        }
      }
    } catch (e) {
      await new Promise(res => setTimeout(res, 3000));
    }
  }
}

async function start() {
  // Resolve the token from the DB setting first (admin-settable, survives
  // redeploys), falling back to the env var. This is what makes "set the bot
  // token in Supabase and it stops getting wiped" work.
  try {
    const tok = await resolveToken();
    if (tok && tok !== BOT_TOKEN) {
      BOT_TOKEN = tok;
      API = `https://api.telegram.org/bot${BOT_TOKEN}`;
    } else if (tok && !API) {
      API = `https://api.telegram.org/bot${tok}`;
    }
  } catch (_) {}
  if (!API) { console.log('⏳ Telegram bot disabled (set telegram_bot_token in admin/Supabase or TELEGRAM_BOT_TOKEN env to enable).'); return; }
  if (polling) return;
  polling = true;
  // Clear any webhook so long-polling works
  await tg('deleteWebhook', { drop_pending_updates: false });
  const me = await tg('getMe', {});
  if (me && me.ok) console.log(`✅ Telegram bot online: @${me.result.username}`);
  pollLoop().catch(e => console.error('TG poll loop crashed:', e.message));
}

module.exports = {
  enabled, start, attachWaTracker,
  createLinkToken, getLink, notifyUser, sendMessage,
};
