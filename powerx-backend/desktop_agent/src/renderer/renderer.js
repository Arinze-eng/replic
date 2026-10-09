// renderer.js — UI logic for the WormGPT Desktop Coding Agent.
// Talks to the main process exclusively through the secure `window.wormgpt`
// bridge (see preload.js). No Node access here.

'use strict';

const W = window.wormgpt;
const $ = (id) => document.getElementById(id);

let attachments = [];   // [{name, path}]
let running = false;
let currentRunId = null;
let currentUnsub = null;
let historyItems = [];

// ── tiny helpers ──────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
// Minimal, safe markdown: code fences, inline code, bold, links, newlines.
function md(t) {
  let s = esc(t);
  s = s.replace(/```([\s\S]*?)```/g, (_, c) => '<pre>' + c.replace(/^\n/, '') + '</pre>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" data-ext="1">$1</a>');
  return s;
}
function scrollDown() {
  const m = $('messages');
  m.scrollTop = m.scrollHeight;
}
function fmtBytes(n) {
  if (!n && n !== 0) return '';
  return n > 1024 ? Math.round(n / 1024) + 'KB' : n + 'B';
}

// ── AUTH ────────────────────────────────────────────────────────────────────
function showAuthError(msg) {
  const e = $('auth-error');
  e.textContent = msg;
  e.classList.remove('hidden');
}
function clearAuthError() { $('auth-error').classList.add('hidden'); }

document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    const which = t.dataset.tab;
    $('login-form').classList.toggle('hidden', which !== 'login');
    $('signup-form').classList.toggle('hidden', which !== 'signup');
    clearAuthError();
  };
});

$('login-form').onsubmit = async (e) => {
  e.preventDefault();
  clearAuthError();
  const btn = $('login-btn'); btn.disabled = true; btn.textContent = 'Signing in…';
  const r = await W.login($('login-email').value, $('login-password').value);
  btn.disabled = false; btn.textContent = 'Sign in';
  if (r.ok) enterApp(r.user);
  else showAuthError(r.error || 'Login failed.');
};

$('signup-form').onsubmit = async (e) => {
  e.preventDefault();
  clearAuthError();
  const btn = $('signup-btn'); btn.disabled = true; btn.textContent = 'Creating…';
  const r = await W.signup($('su-email').value, $('su-password').value, $('su-username').value);
  btn.disabled = false; btn.textContent = 'Create account';
  if (r.ok) enterApp(r.user);
  else showAuthError(r.error || 'Signup failed.');
};

$('save-base').onclick = async (e) => {
  e.preventDefault();
  const r = await W.setBaseUrl($('base-url').value);
  if (r.ok) { $('save-base').textContent = 'Saved ✓'; setTimeout(() => ($('save-base').textContent = 'Save'), 1500); }
};

$('logout').onclick = async () => {
  await W.logout();
  $('app').classList.add('hidden');
  $('auth').classList.remove('hidden');
};

// ── TIER / CREDITS ───────────────────────────────────────────────────────────
function tierName(user) {
  if (!user) return 'Free';
  if (user.role === 'admin') return 'Admin';
  const s = (user.subscription_status || 'free');
  if (s === 'active') {
    const p = (user.subscription_plan || '').toString();
    return p ? p[0].toUpperCase() + p.slice(1) : 'Active';
  }
  return s[0].toUpperCase() + s.slice(1);
}
function setCredits(v) {
  const pill = $('credit-pill');
  if (v === 'unlimited' || v == null) pill.textContent = '🪙 ∞';
  else pill.textContent = '🪙 ' + v;
}
function setTierBadge(user) {
  $('tier-badge').textContent = tierName(user) + ' plan';
  const nm = (user && (user.username || user.email || 'user')).toString();
  $('user-name').textContent = nm;
  $('user-avatar').textContent = nm.slice(0, 1).toUpperCase();
}

// ── ENTER APP ─────────────────────────────────────────────────────────────
async function enterApp(user) {
  $('auth').classList.add('hidden');
  $('app').classList.remove('hidden');
  setTierBadge(user || {});
  setCredits(tierName(user) === 'Pro' || tierName(user) === 'Admin' ? 'unlimited' : '—');
  await loadHistory();
  // refresh profile in the background (validates token)
  W.me().then((r) => { if (r.ok) { setTierBadge(r.user); } });
}

// ── HISTORY ─────────────────────────────────────────────────────────────────
async function loadHistory() {
  const r = await W.listHistory();
  historyItems = (r && r.items) || [];
  renderHistory();
}
function renderHistory() {
  const box = $('history-list');
  box.innerHTML = '';
  if (!historyItems.length) {
    box.innerHTML = '<div style="color:var(--dim);font-size:12px;padding:6px 2px">No tasks yet.</div>';
    return;
  }
  historyItems.forEach((h) => {
    const b = document.createElement('button');
    b.className = 'hist-item';
    const d = new Date(h.ts || Date.now());
    b.innerHTML = esc((h.task || 'task').slice(0, 60)) +
      '<span class="ht-date">' + d.toLocaleString() + '</span>';
    b.onclick = () => openHistory(h);
    box.appendChild(b);
  });
}
async function openHistory(h) {
  // Render the saved task + answer. If we have a jobId, refetch the durable job
  // for the freshest steps/files.
  startNewTask(true);
  addMsg('user', md(h.task || ''));
  const bub = addMsg('bot', '<div class="answer">Loading saved task…</div>');
  if (h.jobId) {
    const r = await W.getJob(h.jobId);
    if (r.ok && r.job) {
      renderFinal(bub, r.job.message || h.answer || '(no answer)', r.job.files || h.files || []);
      return;
    }
  }
  renderFinal(bub, h.answer || '(no saved answer)', h.files || []);
}

$('new-task').onclick = () => startNewTask(false);
function startNewTask(keep) {
  $('messages').innerHTML = '';
  $('empty-state') && null;
  if (!keep) {
    const es = document.createElement('div');
    // no-op; empty state only shows on first load
  }
}

// ── MESSAGES ─────────────────────────────────────────────────────────────────
function addMsg(role, html) {
  const es = $('empty-state'); if (es) es.remove();
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  el.innerHTML = html;
  $('messages').appendChild(el);
  scrollDown();
  return el;
}

// Wire external links inside a bubble to open in the system browser.
function wireExternal(el) {
  el.querySelectorAll('a[data-ext]').forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); W.openExternal(a.getAttribute('href')); };
  });
}

function renderFinal(bub, message, files) {
  let html = '<div class="answer">' + md(message || '✅ Done.') + '</div>';
  const imgs = (files || []).filter((f) => (f.b64 || f.url) && /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name || ''));
  if (imgs.length) {
    html += '<div class="shots">' + imgs.map((f) => {
      const mime = /\.png$/i.test(f.name) ? 'image/png' : (/\.gif$/i.test(f.name) ? 'image/gif' : 'image/jpeg');
      const src = f.b64 ? ('data:' + mime + ';base64,' + f.b64) : f.url;
      return '<img src="' + src + '" alt="' + esc(f.name) + '" title="' + esc(f.name) + '">';
    }).join('') + '</div>';
  }
  if (files && files.length) {
    html += '<div class="files">' + files.map((f, i) => {
      const have = (f.url && f.url.length) || (f.b64 && f.b64.length);
      if (f.tooLarge && !have) return '<span class="filechip" style="cursor:default"><span>📄 ' + esc(f.name) + '</span> <span class="x">(too large)</span></span>';
      return '<span class="filechip" data-fi="' + i + '">⬇ ' + esc(f.name) + ' <span class="x">(' + fmtBytes(f.size) + ')</span></span>';
    }).join('') + '</div>';
  }
  bub.innerHTML = html;
  wireExternal(bub);
  bub.querySelectorAll('.filechip[data-fi]').forEach((c) => {
    c.onclick = async () => {
      const f = files[+c.dataset.fi];
      const old = c.innerHTML; c.innerHTML = '⏳ Saving…';
      const r = await W.saveFile(f);
      c.innerHTML = r.ok ? '✅ Saved' : old;
      if (!r.ok && !r.canceled) c.innerHTML = old;
    };
  });
  scrollDown();
}

// ── LIVE SCREEN VIEWER ─────────────────────────────────────────────────────
function ensureLiveView(stepsEl) {
  let lv = stepsEl.querySelector('.liveview');
  if (lv) return lv;
  lv = document.createElement('div');
  lv.className = 'liveview';
  lv.innerHTML = '<div class="lv-bar"><span class="lv-badge">● LIVE</span><span class="lv-hud">connecting…</span></div><img alt="agent screen">';
  stepsEl.appendChild(lv);
  return lv;
}
function livePushFrame(stepsEl, payload) {
  const lv = ensureLiveView(stepsEl);
  const img = lv.querySelector('img');
  if (payload.frame) img.src = 'data:image/jpeg;base64,' + payload.frame;
  const hud = lv.querySelector('.lv-hud');
  const bits = [];
  if (payload.n != null) bits.push('#' + payload.n);
  if (payload.w && payload.h) bits.push(payload.w + '×' + payload.h);
  hud.textContent = bits.join(' · ') || 'live';
}

// ── RUN A TASK ───────────────────────────────────────────────────────────────
const composerHistory = [];  // {role, text} for context

function setRunning(on) {
  running = on;
  $('send-btn').classList.toggle('hidden', on);
  $('stop-btn').classList.toggle('hidden', !on);
  $('send-btn').disabled = on;
}

$('stop-btn').onclick = async () => {
  if (currentRunId) await W.abortAgent(currentRunId);
};

async function runTask(task) {
  if (running) return;
  $('paywall').classList.add('hidden');
  setRunning(true);

  const atts = attachments.slice();
  attachments = []; renderAttachRow();

  addMsg('user', md(task) + (atts.length ? '<div class="files">' + atts.map((a) => '<span class="filechip" style="cursor:default">📎 ' + esc(a.name) + '</span>').join('') + '</div>' : ''));
  composerHistory.push({ role: 'user', text: task });

  const bub = addMsg('bot', '<div class="steps"><div class="stepline"><span class="sp">●</span> <span class="typing"><i></i><i></i><i></i></span> Starting agent…</div></div>');
  const stepsEl = bub.querySelector('.steps');

  const addStep = (txt) => {
    const last = stepsEl.querySelector('.stepline:last-of-type');
    if (last && last.querySelector('.typing')) last.remove();
    const s = document.createElement('div');
    s.className = 'stepline done';
    s.innerHTML = '<span class="sp">▸</span> ' + esc(txt);
    stepsEl.appendChild(s);
    const typing = document.createElement('div');
    typing.className = 'stepline';
    typing.innerHTML = '<span class="sp">●</span> <span class="typing"><i></i><i></i><i></i></span>';
    stepsEl.appendChild(typing);
    scrollDown();
  };

  const runId = 'run_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  currentRunId = runId;
  let jobId = null;
  let finished = false;

  // subscribe to streamed events for this run
  const unsub = W.onAgentEvent(({ runId: rid, ev, payload }) => {
    if (rid !== runId) return;
    if (ev === 'start') {
      if (payload.tier) setTierBadge(Object.assign({}, W.__u || {}, { subscription_status: payload.tier === 'Free' ? 'free' : 'active', subscription_plan: payload.tier.toLowerCase() }));
      if (payload.credits != null) setCredits(payload.credits);
      if (payload.jobId) jobId = payload.jobId;
    } else if (ev === 'job') {
      if (payload.jobId) jobId = payload.jobId;
    } else if (ev === 'step') {
      if (payload.credits != null) setCredits(payload.credits);
      addStep(payload.note || 'working…');
    } else if (ev === 'screen') {
      if (payload.event === 'end') { /* keep last frame */ }
      else if (payload.frame) { livePushFrame(stepsEl, payload); scrollDown(); }
      else ensureLiveView(stepsEl);
    } else if (ev === 'done') {
      finished = true;
      renderFinal(bub, payload.message || '✅ Done.', payload.files || []);
      composerHistory.push({ role: 'assistant', text: (payload.message || 'Done.').slice(0, 4000) });
      // save to local history
      W.saveHistory({ task, answer: payload.message || '', files: (payload.files || []).map((f) => ({ name: f.name, url: f.url, size: f.size })), jobId, ts: Date.now() })
        .then(loadHistory);
    } else if (ev === 'error') {
      finished = true;
      const msg = payload.error || 'Agent failed.';
      const last = stepsEl.querySelector('.stepline:last-of-type');
      if (last && last.querySelector('.typing')) last.remove();
      bub.innerHTML = '<div class="answer err">❌ ' + esc(msg) + '</div>';
      if (payload.credits != null) setCredits(payload.credits);
      // Out-of-credits → show upgrade paywall
      if (/out of|credit|upgrade|renew|subscribe/i.test(msg)) showPaywall(msg);
    }
  });

  try {
    await W.runAgent({ runId, task, history: composerHistory.slice(0, -1), files: atts, mode: 'fusion' });
  } finally {
    if (typeof unsub === 'function') unsub();
    if (!finished) {
      const last = stepsEl.querySelector('.stepline:last-of-type');
      if (last && last.querySelector('.typing')) last.remove();
    }
    setRunning(false);
    currentRunId = null;
  }
}

function showPaywall(msg) {
  $('paywall-text').textContent = msg;
  $('paywall').classList.remove('hidden');
}
$('pw-upgrade').onclick = async () => {
  const s = await W.getSession();
  const base = (s && s.baseUrl) || 'https://hackerx-v7-d5s4.onrender.com';
  W.openExternal(base + '/account.html');
};

// ── COMPOSER ─────────────────────────────────────────────────────────────────
const ta = $('task-input');
ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; });
ta.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
});
$('send-btn').onclick = submit;
function submit() {
  let task = ta.value.trim();
  if (!task && !attachments.length) return;
  if (!task) task = '(see attached file)';
  ta.value = ''; ta.style.height = 'auto';
  runTask(task);
}

$('attach-btn').onclick = async () => {
  const r = await W.pickFiles();
  if (r.ok && r.files.length) {
    attachments = attachments.concat(r.files);
    renderAttachRow();
  }
};
function renderAttachRow() {
  const row = $('attach-row');
  if (!attachments.length) { row.classList.add('hidden'); row.innerHTML = ''; return; }
  row.classList.remove('hidden');
  row.innerHTML = '';
  attachments.forEach((a, i) => {
    const chip = document.createElement('span');
    chip.className = 'attach-chip';
    chip.innerHTML = '📎 ' + esc(a.name) + ' <button data-i="' + i + '">×</button>';
    chip.querySelector('button').onclick = () => { attachments.splice(i, 1); renderAttachRow(); };
    row.appendChild(chip);
  });
}

// example prompts
document.addEventListener('click', (e) => {
  if (e.target.classList && e.target.classList.contains('example')) {
    ta.value = e.target.textContent; ta.focus();
    ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  }
});

// ── LOCAL SANDBOX TOGGLE ──────────────────────────────────────────────────────
async function refreshLocalStatus() {
  const st = $('local-status');
  const toggle = $('local-toggle');
  try {
    const mode = await W.getLocalMode();
    if (toggle) toggle.checked = !!(mode && mode.enabled);
    if (!(mode && mode.enabled)) { if (st) st.textContent = '☁️ cloud'; return; }
    const p = await W.probeLocal();
    if (st) {
      if (p && p.ok) st.textContent = '🟢 ' + (p.strategy || 'ready');
      else st.textContent = '🟡 ' + ((p && p.error) ? p.error.slice(0, 24) : 'unavailable');
    }
  } catch (_) { if (st) st.textContent = ''; }
}
(function wireLocalToggle() {
  const toggle = $('local-toggle');
  if (!toggle) return;
  toggle.addEventListener('change', async () => {
    await W.setLocalMode(toggle.checked);
    await refreshLocalStatus();
  });
})();

// ── BOOT ─────────────────────────────────────────────────────────────────────
(async function boot() {
  const s = await W.getSession();
  if (s && s.baseUrl) $('base-url').value = s.baseUrl;
  refreshLocalStatus();
  if (s && s.loggedIn) {
    enterApp(s.user);
  } else {
    $('auth').classList.remove('hidden');
  }
})();
