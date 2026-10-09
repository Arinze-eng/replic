// debateRender.js — STABLE, anti-flicker renderer for the Mixture-of-Experts
// debate. Used by BOTH the Telegram (wormgptBot) and WhatsApp (whatsappBot)
// front-ends so they behave identically.
//
// PROBLEM IT SOLVES: the old code posted a separate chat message for every
// micro-event (each expert turn, each stance line, each round_done). On
// WhatsApp/Telegram that is a rapid burst of tiny messages → the UI "flickers"
// and feels unstable, and long content got truncated to ~700–900 chars.
//
// THIS RENDERER: listens ONLY to the consolidated `round_summary` event and
// posts EXACTLY ONE message per round — "🥊 ROUND N — 🔷 Gemini vs 🟢 HotBot"
// containing BOTH experts' FULL arguments. Long rounds are split into a few
// numbered parts (so nothing is truncated) but still sent as discrete, stable
// messages rather than a flickering live stream. Sandbox runs and the final
// verdict each get one clean message too.
//
// Usage:
//   const { makeDebateRenderer } = require('./debateRender');
//   const onEvent = makeDebateRenderer({
//     send: (text) => sendText(jid, text),   // platform send fn (returns a promise)
//     limit: 4000,                            // platform max msg length
//     experts: debateSvc.EXPERTS,
//   });
//   await debateSvc.debate(task, { onEvent, sandbox });

const DEFAULT_EXPERTS = {
  gemini: { id: 'gemini', label: 'Gemini',        emoji: '🔷' },
  gpt:    { id: 'gpt',    label: 'GPT-5 (HotBot)', emoji: '🟢' },
};

// Split a long string into <=limit chunks on paragraph / line boundaries so a
// round is delivered as a few stable messages instead of one giant (rejected)
// blob or a flickering stream.
function chunk(text, limit) {
  text = String(text || '');
  if (text.length <= limit) return [text];
  const out = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if ((buf + '\n' + line).length > limit) {
      if (buf) out.push(buf);
      if (line.length > limit) {
        // hard-wrap an over-long single line
        for (let i = 0; i < line.length; i += limit) out.push(line.slice(i, i + limit));
        buf = '';
      } else {
        buf = line;
      }
    } else {
      buf = buf ? buf + '\n' + line : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function tag(experts, id) {
  const e = (experts || DEFAULT_EXPERTS)[id] || { emoji: '🤖', label: id };
  return `${e.emoji} *${e.label}*`;
}

// Build the ONE stable message body for a round (both experts' full content).
function renderRound(ev, experts) {
  const status = ev.agreed ? '🤝 they AGREE' : '⚔️ still arguing';
  const parts = [
    `🥊 *ROUND ${ev.round}* — ${tag(experts, 'gemini')} vs ${tag(experts, 'gpt')}  ·  ${status}`,
    '',
    `${tag(experts, 'gemini')}:`,
    String(ev.gemini || '').trim(),
    '',
    `${tag(experts, 'gpt')}:`,
    String(ev.gpt || '').trim(),
  ];
  if (ev.geminiFinal || ev.gptFinal) {
    parts.push('', `› _Stances:_ ${tag(experts, 'gemini')} → \`${ev.geminiFinal || '—'}\`  |  ${tag(experts, 'gpt')} → \`${ev.gptFinal || '—'}\``);
  }
  return parts.join('\n');
}

// Create an onEvent handler bound to a platform `send` fn.
//   send(text) -> Promise   (must serialize internally OR we serialize here)
// We chain sends so messages always arrive IN ORDER (no out-of-order flicker).
function makeDebateRenderer(opts = {}) {
  const send = typeof opts.send === 'function' ? opts.send : async () => {};
  const limit = Math.max(500, parseInt(opts.limit, 10) || 4000);
  const experts = opts.experts || DEFAULT_EXPERTS;
  const showSandbox = opts.showSandbox !== false;

  // Serialize all sends through a single tail promise so ordering is stable.
  let queue = Promise.resolve();
  const post = (text) => {
    queue = queue.then(async () => {
      const pieces = chunk(text, limit);
      for (let i = 0; i < pieces.length; i++) {
        const suffix = pieces.length > 1 ? `\n\n_(part ${i + 1}/${pieces.length})_` : '';
        try { await send(pieces[i] + suffix); } catch (_) {}
      }
    }).catch(() => {});
    return queue;
  };

  return function onEvent(ev) {
    try {
      switch (ev.type) {
        case 'start':
          post(
            '🧠 *Mixture-of-Experts* engaged — two AIs will work *one at a time*, compare, and debate until they agree on the most accurate result.\n' +
            `${tag(experts, 'gemini')} vs ${tag(experts, 'gpt')}` +
            (ev.domain && ev.domain !== 'general' ? `  ·  _domain:_ ${ev.domain}` : '') +
            (ev.needsSandbox ? '\n⚙️ _Terminal-verified task — each expert will RUN & verify code in the sandbox, one after the other._' : '')
          );
          break;

        // ⭐ THE STABLE PER-ROUND MESSAGE. We deliberately IGNORE the granular
        // 'turn' / 'thinking' / 'round_done' events so the chat does not flicker.
        case 'round_summary':
          post(renderRound(ev, experts));
          break;

        case 'sandbox':
          if (showSandbox) {
            post(
              `🧪 ${tag(experts, ev.expert)} ran code in the sandbox ${ev.ok ? '✅' : '⚠️'}:\n` +
              '```\n' + String(ev.output || '').slice(0, 1500) + '\n```'
            );
          }
          break;

        case 'verdict': {
          const head = ev.converged ? '✅ *CONSENSUS REACHED*' : '⚖️ *JUDGE’S DECISION* (no full consensus)';
          post(`${head}\n\n${String(ev.text || '').trim()}`);
          break;
        }

        // 'unified' is consumed by the bot itself (it becomes the final answer),
        // and 'turn'/'thinking'/'round_done' are intentionally not rendered.
        default:
          break;
      }
    } catch (_) {}
  };
}

module.exports = { makeDebateRenderer, renderRound, chunk, DEFAULT_EXPERTS };
