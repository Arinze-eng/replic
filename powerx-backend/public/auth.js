/* ─────────────────────────────────────────────────────────────
   ALL IN ONE TOOLBOX — Shared Auth Module (Supabase-backed)
   Restores the signup/login gate that the landing-page rewrite
   stripped out. Backend endpoints (/api/auth/*) are unchanged.

   Usage on a GATED page (feature requires sign-up):
     <script src="/auth.js"></script>
     <script> Auth.requireLogin(); </script>

   Usage on a FREE page (just show a Sign In button, no gate):
     <script src="/auth.js"></script>
     <script> Auth.mountButton(); </script>
   ───────────────────────────────────────────────────────────── */
(function () {
  const API = window.location.origin;
  const TOKEN_KEY = 'hae_token';

  let _user = null;
  let _verified = false;
  let _gateActive = false;       // true => block page until logged in
  let _onAuthed = null;          // callback after successful auth on a gated page

  // ── Modal branding ────────────────────────────────────────────────────────
  // Pages may set window.AUTH_BRAND before loading this file to skin the
  // sign-in modal (the football site does). Left unset, the original toolbox
  // branding is used verbatim so the admin panel is completely unchanged.
  const BRAND = Object.assign({
    logo: '🤖',
    title: 'ALL IN ONE',
    titleAccent: 'TOOLBOX',
    sub: 'Members Area',
    note: '🔒 This is a members-only feature. Create a free account or sign in to continue.'
  }, window.AUTH_BRAND || {});

  function getToken() {
    const t = localStorage.getItem(TOKEN_KEY);
    // Self-heal: if a token exists in storage but the mirror cookie is missing
    // (e.g. a session created before the cookie mirror shipped), backfill it so
    // server-side cookie auth works without forcing a re-login.
    if (t) {
      try {
        if (!/(?:^|;\s*)hae_token=/.test(document.cookie || '')) {
          document.cookie = TOKEN_KEY + '=' + encodeURIComponent(t) +
            '; path=/; max-age=' + (60 * 60 * 24 * 30) + '; SameSite=Lax';
        }
      } catch (e) {}
    }
    return t;
  }
  function setToken(t) {
    localStorage.setItem(TOKEN_KEY, t);
    // Mirror into a cookie so server-side token extraction keeps working even
    // when localStorage isn't readable for a request (APK WebView quirks, a
    // proxy that strips the Authorization header, etc). 30-day, lax, root path.
    try {
      document.cookie = TOKEN_KEY + '=' + encodeURIComponent(t) +
        '; path=/; max-age=' + (60 * 60 * 24 * 30) + '; SameSite=Lax';
    } catch (e) {}
  }
  function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
    try { document.cookie = TOKEN_KEY + '=; path=/; max-age=0; SameSite=Lax'; } catch (e) {}
  }

  function getFingerprint() {
    let fp = localStorage.getItem('hae_fp');
    if (!fp) {
      const nav = navigator, screen = window.screen;
      const raw = nav.userAgent + '|' + nav.language + '|' + screen.width + 'x' + screen.height + '|' + nav.hardwareConcurrency + '|' + nav.platform;
      fp = btoa(raw).slice(0, 40);
      localStorage.setItem('hae_fp', fp);
    }
    return fp;
  }

  // Strong, RANDOM per-device id used for "1 account per device" anti-loot.
  // Unlike the UA fingerprint above (which collides across users on the same
  // phone model), this is a random UUID generated ONCE and persisted, so it is
  // unique to this physical browser/device and never false-positives a legit
  // new user. Stored under several keys so clearing one doesn't trivially reset
  // it; if all are cleared a fresh id is created (acceptable — that's a new
  // browser profile / reinstall).
  function getDeviceId() {
    const KEY = 'hae_device';
    let id = localStorage.getItem(KEY);
    if (!id) {
      // Recover from a backup copy if the primary was cleared.
      try { id = localStorage.getItem('hae_device_bak') || (window.sessionStorage && sessionStorage.getItem(KEY)); } catch (e) {}
    }
    if (!id) {
      try {
        id = (crypto && crypto.randomUUID) ? crypto.randomUUID()
           : 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      } catch (e) {
        id = 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      }
    }
    try {
      localStorage.setItem(KEY, id);
      localStorage.setItem('hae_device_bak', id);
      if (window.sessionStorage) sessionStorage.setItem(KEY, id);
    } catch (e) {}
    return id;
  }

  // ── Inject styles + modal markup once ──
  function injectUI() {
    if (document.getElementById('hae-auth-style')) return;

    const style = document.createElement('style');
    style.id = 'hae-auth-style';
    style.textContent = `
      .hae-auth-overlay{display:none;position:fixed;inset:0;width:100%;height:100%;
        background:rgba(0,0,0,.78);z-index:99999;align-items:center;justify-content:center;backdrop-filter:blur(5px)}
      .hae-auth-overlay.show{display:flex}
      .hae-auth-modal{background:#0f1520;border:1px solid #1e2d4a;border-radius:20px;
        padding:34px 30px;width:420px;max-width:92%;position:relative;overflow:hidden;
        font-family:'Inter','Segoe UI',system-ui,sans-serif;color:#e8edf5}
      .hae-auth-modal::before{content:'';position:absolute;top:0;left:0;width:100%;height:3px;
        background:linear-gradient(90deg,#f38020,#ffd700,#f38020)}
      .hae-auth-modal .hae-close{position:absolute;top:14px;right:16px;background:none;border:none;
        color:#8899c4;font-size:22px;cursor:pointer}
      .hae-auth-modal .hae-close:hover{color:#e8edf5}
      .hae-auth-modal .hae-logo{text-align:center;font-size:34px}
      .hae-auth-modal h2{font-family:'JetBrains Mono',monospace;font-size:22px;text-align:center;letter-spacing:1px;margin:2px 0}
      .hae-auth-modal h2 span{color:#f38020}
      .hae-auth-modal .hae-sub{text-align:center;font-size:10px;color:#5a6a92;margin-bottom:16px;text-transform:uppercase;letter-spacing:1px}
      .hae-auth-modal .hae-gate-note{text-align:center;font-size:12px;color:#8899c4;margin-bottom:14px;
        background:rgba(243,128,32,.06);border:1px solid rgba(243,128,32,.18);padding:9px 12px;border-radius:8px;line-height:1.5}
      .hae-auth-modal .hae-tab{display:flex;margin-bottom:18px;border-radius:8px;overflow:hidden;border:1px solid #1e2d4a;background:#0a0e17}
      .hae-auth-modal .hae-tab button{flex:1;padding:10px;background:transparent;border:none;color:#8899c4;cursor:pointer;font-size:13px;font-weight:600}
      .hae-auth-modal .hae-tab button.active{background:#f38020;color:#fff}
      .hae-auth-modal .hae-ig{position:relative;margin-bottom:12px}
      .hae-auth-modal .hae-ig .ic{position:absolute;left:12px;top:50%;transform:translateY(-50%);font-size:14px;opacity:.55}
      .hae-auth-modal input{width:100%;padding:11px 12px 11px 38px;background:#0a0e17;border:1px solid #1e2d4a;border-radius:8px;
        color:#e8edf5;font-size:13px;outline:none;font-family:inherit}
      .hae-auth-modal input:focus{border-color:#f38020;box-shadow:0 0 0 3px rgba(243,128,32,.12)}
      .hae-auth-modal .hae-btn{width:100%;padding:12px;background:#f38020;border:none;border-radius:8px;color:#fff;
        font-size:14px;font-weight:700;cursor:pointer;margin-top:4px;font-family:inherit}
      .hae-auth-modal .hae-btn:hover{background:#e07010}
      .hae-auth-modal .hae-btn:disabled{opacity:.5;cursor:not-allowed}
      .hae-auth-modal .hae-err{color:#ff3355;font-size:12px;text-align:center;margin-bottom:12px;display:none;
        background:rgba(255,51,85,.08);padding:8px 14px;border-radius:8px;border:1px solid rgba(255,51,85,.2)}
      .hae-auth-modal .hae-fp{font-size:10px;color:#8899c4;text-align:center;margin-bottom:12px;
        padding:6px 12px;background:rgba(255,215,0,.04);border:1px solid rgba(255,215,0,.12);border-radius:8px}
      .hae-auth-modal .hae-note{text-align:center;font-size:11px;color:#5a6a92;margin-top:12px;line-height:1.7}
      .hae-auth-modal .hae-note a{color:#60cfff;cursor:pointer}
      .hae-hidden{display:none!important}
      /* Sign-in / account button widget */
      .hae-acct-btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:999px;font-size:12px;
        font-weight:700;cursor:pointer;border:1px solid #1e2d4a;background:transparent;color:#8899c4;
        font-family:'Inter',sans-serif;transition:.2s}
      .hae-acct-btn:hover{border-color:#f38020;color:#f38020}
      .hae-acct-btn.in{background:rgba(0,255,65,.08);border-color:rgba(0,255,65,.25);color:#00ff41}
    `;
    document.head.appendChild(style);

    const overlay = document.createElement('div');
    overlay.className = 'hae-auth-overlay';
    overlay.id = 'hae-auth-overlay';
    overlay.innerHTML = `
      <div class="hae-auth-modal">
        <button class="hae-close" id="hae-close-btn" onclick="Auth.close()">✕</button>
        <div class="hae-logo">${BRAND.logo}</div>
        <h2>${BRAND.title} <span>${BRAND.titleAccent}</span></h2>
        <div class="hae-sub">${BRAND.sub}</div>
        <div class="hae-gate-note" id="hae-gate-note">${BRAND.note}</div>
        <div class="hae-err" id="hae-auth-err"></div>
        <div class="hae-tab">
          <button id="hae-tab-login" class="active" onclick="Auth.switch('login')">Sign In</button>
          <button id="hae-tab-signup" onclick="Auth.switch('signup')">Sign Up</button>
        </div>
        <div id="hae-login-form">
          <div class="hae-ig"><span class="ic">✉</span><input id="hae-login-email" type="email" placeholder="Email" autocomplete="off"></div>
          <div class="hae-ig"><span class="ic">🔒</span><input id="hae-login-pass" type="password" placeholder="Password" autocomplete="off"></div>
          <button class="hae-btn" onclick="Auth.login()">Sign In</button>
          <div class="hae-note">New here? <a onclick="Auth.switch('signup')">Create an account</a></div>
        </div>
        <div id="hae-signup-form" class="hae-hidden">
          <div class="hae-fp">🔐 Gmail addresses only (@gmail.com) · Free account</div>
          <div class="hae-ig"><span class="ic">👤</span><input id="hae-signup-username" type="text" placeholder="Username"></div>
          <div class="hae-ig"><span class="ic">✉</span><input id="hae-signup-email" type="email" placeholder="Gmail address"></div>
          <div class="hae-ig"><span class="ic">🔒</span><input id="hae-signup-pass" type="password" placeholder="Password (min 6 characters)"></div>
          <button class="hae-btn" onclick="Auth.signup()">Create Account</button>
          <div class="hae-note">Already registered? <a onclick="Auth.switch('login')">Sign in</a></div>
        </div>
        <!-- Forgot password / Security questions form -->
        <div id="hae-forgot-form" class="hae-hidden">
          <div class="hae-fp">🔐 Admin security questions. Answer both correctly to reset your password.</div>
          <div class="hae-ig"><span class="ic">✉</span><input id="hae-forgot-email" type="email" placeholder="Admin email" autocomplete="off"></div>
          <div id="hae-forgot-q1" style="font-size:12px;color:var(--text-dim);margin:10px 0 4px"></div>
          <div class="hae-ig"><span class="ic">🔍</span><input id="hae-forgot-a1" type="text" placeholder="Answer 1" autocomplete="off"></div>
          <div id="hae-forgot-q2" style="font-size:12px;color:var(--text-dim);margin:10px 0 4px"></div>
          <div class="hae-ig"><span class="ic">🔍</span><input id="hae-forgot-a2" type="text" placeholder="Answer 2" autocomplete="off"></div>
          <div class="hae-ig" style="margin-top:8px"><span class="ic">🔒</span><input id="hae-forgot-newpass" type="password" placeholder="New password (min 6 chars)" autocomplete="off"></div>
          <button class="hae-btn" onclick="Auth.verifySecurity()">Verify & Reset Password</button>
          <div class="hae-note"><a onclick="Auth.switch('login')">← Back to Sign In</a></div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    // Enter-to-submit
    const onEnter = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') fn(); });
    };
    onEnter('hae-login-pass', () => Auth.login());
    onEnter('hae-signup-pass', () => Auth.signup());
  }

  function showErr(msg) {
    const e = document.getElementById('hae-auth-err');
    if (e) { e.textContent = msg; e.style.display = 'block'; }
  }
  function hideErr() {
    const e = document.getElementById('hae-auth-err');
    if (e) e.style.display = 'none';
  }

  // ── Public API ──
  const Auth = {
    get user() { return _user; },
    get token() { return getToken(); },

    isLoggedIn() { return !!getToken(); },

    // Expose a safe way for gated pages to drop a stale/expired token before
    // re-prompting login (used by the Spotify Downloader's 401 recovery UX).
    clearToken() { clearToken(); _user = null; _verified = false; },

    // Programmatically install a session (token + user) WITHOUT a login form.
    // Used by the admin "Login as user" (impersonation) flow so the admin can
    // adopt a server-issued token for another account. Writes through the same
    // storage + cookie mirror that normal login uses.
    setSession(t, user) {
      setToken(t);
      _user = user || null;
      _verified = true;
      try { this._renderButton && this._renderButton(); } catch (e) {}
    },

    switch(mode) {
      document.getElementById('hae-tab-login').className = mode === 'login' ? 'active' : '';
      document.getElementById('hae-tab-signup').className = mode === 'signup' ? 'active' : '';
      document.getElementById('hae-login-form').classList.toggle('hae-hidden', mode !== 'login');
      document.getElementById('hae-signup-form').classList.toggle('hae-hidden', mode !== 'signup');
      document.getElementById('hae-forgot-form').classList.toggle('hae-hidden', mode !== 'forgot');
      if (mode === 'login') document.getElementById('hae-tab-login').parentElement.style.display = 'flex';
      if (mode === 'signup') document.getElementById('hae-tab-login').parentElement.style.display = 'flex';
      if (mode === 'forgot') document.getElementById('hae-tab-login').parentElement.style.display = 'none';
      hideErr();
    },
    async showForgot() {
      injectUI();
      // Open the modal overlay (non-gated so close works)
      const closeBtn = document.getElementById('hae-close-btn');
      if (closeBtn) closeBtn.style.display = 'block';
      document.getElementById('hae-auth-overlay').classList.add('show');
      this.switch('forgot');
      // Load security questions
      try {
        const r = await fetch(API + '/api/auth/security-questions');
        const d = await r.json();
        if (d.ok && d.questions) {
          document.getElementById('hae-forgot-q1').textContent = '❓ ' + d.questions[0].text;
          document.getElementById('hae-forgot-q2').textContent = '❓ ' + d.questions[1].text;
        }
      } catch(e) { showErr('Failed to load security questions'); }
    },
    async verifySecurity() {
      const email = document.getElementById('hae-forgot-email').value;
      const answer1 = document.getElementById('hae-forgot-a1').value;
      const answer2 = document.getElementById('hae-forgot-a2').value;
      const newPassword = document.getElementById('hae-forgot-newpass').value;
      hideErr();
      if (!email || !answer1 || !answer2) { showErr('All fields required'); return; }
      if (newPassword && newPassword.length < 6) { showErr('New password must be at least 6 characters'); return; }
      const btn = document.querySelector('#hae-forgot-form .hae-btn');
      btn.disabled = true; btn.textContent = 'Verifying...';
      try {
        const r = await fetch(API + '/api/auth/verify-security', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, answer1, answer2, newPassword: newPassword || undefined })
        });
        const d = await r.json();
        if (!r.ok) { showErr(d.error || 'Verification failed'); return; }
        if (newPassword) {
          showErr(''); // clear error
          const errDiv = document.getElementById('hae-auth-err');
          if (errDiv) { errDiv.textContent = '✅ ' + d.message; errDiv.style.display = 'block'; errDiv.style.color = '#00ff41'; }
          // Switch to login after 2 seconds
          setTimeout(() => { this.switch('login'); }, 2500);
        } else {
          alert('✅ ' + d.message);
          this.switch('login');
        }
      } catch (e) { showErr('Network error'); }
      finally { btn.disabled = false; btn.textContent = 'Verify & Reset Password'; }
    },

    open(opts) {
      injectUI();
      opts = opts || {};
      const note = document.getElementById('hae-gate-note');
      if (opts.note && note) note.textContent = opts.note;
      // When the page is gated, the close button shouldn't dismiss into a usable page.
      const closeBtn = document.getElementById('hae-close-btn');
      if (closeBtn) closeBtn.style.display = _gateActive ? 'none' : 'block';
      document.getElementById('hae-auth-overlay').classList.add('show');
      hideErr();
    },

    close() {
      if (_gateActive && !_verified) {
        // On a gated page with no valid session, bounce home instead of exposing the feature.
        window.location.href = '/';
        return;
      }
      const ov = document.getElementById('hae-auth-overlay');
      if (ov) ov.classList.remove('show');
    },

    async login() {
      const email = document.getElementById('hae-login-email').value;
      const password = document.getElementById('hae-login-pass').value;
      hideErr();
      if (!email || !password) { showErr('Email and password required'); return; }
      const btn = document.querySelector('#hae-login-form .hae-btn');
      btn.disabled = true; btn.textContent = 'Signing in...';
      try {
        const r = await fetch(API + '/api/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        const d = await r.json();
        if (!r.ok) { showErr(d.error || 'Login failed'); return; }
        setToken(d.token); _user = d.user; _verified = true;
        _afterAuth();
      } catch (e) { showErr('Network error'); }
      finally { btn.disabled = false; btn.textContent = 'Sign In'; }
    },

    async signup() {
      const username = document.getElementById('hae-signup-username').value;
      const email = document.getElementById('hae-signup-email').value;
      const password = document.getElementById('hae-signup-pass').value;
      hideErr();
      if (!username || !email || !password || password.length < 6) { showErr('All fields required, password min 6 chars'); return; }
      if (!email.toLowerCase().endsWith('@gmail.com')) { showErr('Only @gmail.com addresses allowed'); return; }
      const btn = document.querySelector('#hae-signup-form .hae-btn');
      btn.disabled = true; btn.textContent = 'Creating account...';
      try {
        const r = await fetch(API + '/api/auth/signup', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, username, fingerprint: getFingerprint(), device_id: getDeviceId() })
        });
        const d = await r.json();
        if (!r.ok) { showErr(d.error || 'Signup failed'); return; }
        setToken(d.token); _user = d.user; _verified = true;
        _afterAuth();
      } catch (e) { showErr('Network error'); }
      finally { btn.disabled = false; btn.textContent = 'Create Account'; }
    },

    logout() {
      clearToken(); _user = null; _verified = false;
      this._renderButton();
      // If the current page is gated, send the user home.
      if (_gateActive) { window.location.href = '/'; return; }
      this._renderButton();
    },

    // Verify the stored token against the backend (Supabase-backed /api/auth/me)
    async verify() {
      const t = getToken();
      if (!t) { _verified = false; _user = null; return false; }
      try {
        const r = await fetch(API + '/api/auth/me', { headers: { 'Authorization': 'Bearer ' + t } });
        if (r.status === 401 || r.status === 403) { clearToken(); _verified = false; _user = null; return false; }
        if (!r.ok) { _verified = false; return false; }
        const d = await r.json();
        if (d && d.user) { _user = d.user; _verified = true; return true; }
        _verified = false; return false;
      } catch (e) {
        // Network hiccup — don't lock a legit user out permanently, but treat as unverified for gating.
        _verified = false; return false;
      }
    },

    /* Gate a members-only page. If no valid session, show the auth wall
       and keep the feature blocked. Optional onAuthed() runs once logged in. */
    async requireLogin(opts) {
      opts = opts || {};
      _gateActive = true;
      _onAuthed = typeof opts.onAuthed === 'function' ? opts.onAuthed : null;
      injectUI();
      const ok = await this.verify();
      if (ok) { this._renderButton(); if (_onAuthed) _onAuthed(_user); return true; }
      this.open({ note: opts.note });
      this._renderButton();
      return false;
    },

    /* Free pages: just mount a Sign In / account button, no gate. */
    async mountButton(targetSelector) {
      injectUI();
      _gateActive = false;
      this._buttonTarget = targetSelector || null;
      await this.verify();
      this._renderButton();
    },

    _renderButton() {
      let host = this._buttonTarget ? document.querySelector(this._buttonTarget) : null;
      let btn = document.getElementById('hae-acct-btn');
      if (!host && !btn) return;
      if (!btn) {
        btn = document.createElement('button');
        btn.id = 'hae-acct-btn';
        btn.className = 'hae-acct-btn';
        host.appendChild(btn);
      }
      if (this.isLoggedIn() && _user) {
        btn.className = 'hae-acct-btn in';
        btn.textContent = '👤 ' + (_user.username || 'Account');
        btn.onclick = () => Auth.logout();
        btn.title = 'Click to sign out';
      } else {
        btn.className = 'hae-acct-btn';
        btn.textContent = '🔑 Sign In';
        btn.onclick = () => Auth.open({ note: 'Sign in or create a free account.' });
      }
    }
  };

  function _afterAuth() {
    Auth.close();
    Auth._renderButton();
    if (_gateActive) {
      // Reveal the gated feature.
      const ov = document.getElementById('hae-auth-overlay');
      if (ov) ov.classList.remove('show');
      if (_onAuthed) _onAuthed(_user);
      else window.location.reload();
    }
  }

  // ── Admin impersonation banner ─────────────────────────────────────────────
  // When the admin "logs in as" a user, the admin token is stashed under
  // `hae_admin_token` and a flag under `hae_impersonating`. On every page load
  // we detect that and show a persistent banner letting the admin return to
  // their own session at any time. This is the "Return to admin" exit hatch.
  function mountImpersonationBanner() {
    let info = null;
    try { info = JSON.parse(localStorage.getItem('hae_impersonating') || 'null'); } catch (e) {}
    const adminTok = (function(){ try { return localStorage.getItem('hae_admin_token'); } catch(e){ return null; } })();
    if (!info || !adminTok) return;
    if (document.getElementById('hae-imp-banner')) return;

    const bar = document.createElement('div');
    bar.id = 'hae-imp-banner';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;'+
      'background:#7b1fa2;color:#fff;font:600 13px/1.3 system-ui,Segoe UI,Roboto,monospace;'+
      'padding:9px 14px;display:flex;align-items:center;justify-content:center;gap:12px;'+
      'box-shadow:0 2px 10px rgba(0,0,0,.4);flex-wrap:wrap';
    bar.innerHTML =
      '<span>👤 Admin view: you are signed in as <b>'+
        String(info.email||'user').replace(/</g,'&lt;')+'</b></span>'+
      '<button id="hae-imp-exit" style="background:#fff;color:#7b1fa2;border:none;'+
        'border-radius:6px;padding:6px 14px;font-weight:700;cursor:pointer">⬅ Return to admin</button>';
    document.body.appendChild(bar);
    // Nudge the page down so the banner doesn't cover fixed headers.
    try { document.body.style.paddingTop = (parseInt(getComputedStyle(document.body).paddingTop)||0) + 40 + 'px'; } catch(e){}

    document.getElementById('hae-imp-exit').onclick = function () {
      try {
        setToken(adminTok);
        localStorage.removeItem('hae_admin_token');
        localStorage.removeItem('hae_impersonating');
      } catch (e) {}
      window.location.href = '/admin.html';
    };
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountImpersonationBanner);
  } else {
    mountImpersonationBanner();
  }

  window.Auth = Auth;
})();
