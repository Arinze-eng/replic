// ─────────────────────────────────────────────────────────────────────────────
// liveScreen.js — LIVE / VNC-style screen streaming for the WormGPT Agent.
//
// WHAT IT DOES
//   Gives users a REAL-TIME view of the agent's screen as it browses the web and
//   operates a desktop INSIDE the sandbox — exactly like watching a remote VNC
//   session. It works on EVERY sandbox backend (HopX / Runloop / Daytona / local)
//   because it relies ONLY on the universal `fsx` surface the agent already has:
//   `fsx.sh()` to run shell commands inside the box and `fsx.downloadBuffer()` to
//   pull bytes out. No special port exposure, no backend-specific tunnels — so an
//   admin can pin ANY backend and live view keeps working.
//
// HOW IT WORKS (the robust, backend-agnostic recipe)
//   1. Inside the sandbox we boot a headed graphical stack on a VIRTUAL display:
//        Xvfb  (virtual X11 framebuffer, :99)
//        + a lightweight window manager (fluxbox/openbox if present)
//        + Chromium/Chrome started with --display=:99 (a REAL, visible browser)
//      A tiny x11vnc + (optional) websockify/noVNC are also started when present,
//      so a power user can attach a native VNC client too — but the PRIMARY,
//      always-works path is the frame pump below.
//   2. A capture loop grabs the framebuffer (`scrot`/`import`/`ffmpeg`) to a JPEG
//      a few times per second, writes it to a known file in the workdir.
//   3. The Node side polls that file via `fsx.downloadBuffer()`, base64-encodes it
//      and emits it to the UI over the SAME SSE channel the agent already uses:
//        event: screen   data: { frame: "<b64 jpeg>", w, h, ts, url? }
//      The web app and the Flutter app both render these frames into a live canvas.
//
// WHY FRAMES-OVER-SSE (not raw VNC to the client)
//   • Universangle: every backend supports exec + file download; not all expose a
//     public TCP port for VNC. Frames-over-SSE therefore works EVERYWHERE.
//   • Zero extra client deps: the existing SSE plumbing carries it; the Flutter
//     app just decodes base64 JPEG into an Image widget. No websocket lib needed.
//   • Mobile/proxy friendly: survives Render's proxy + mobile networks like the
//     rest of the agent stream.
//
// PUBLIC API
//   const live = require('./liveScreen');
//   const session = await live.start(fsx, { onFrame, onStep, fps, quality, width, height });
//   await session.openUrl('https://example.com');     // navigate the live browser
//   await session.exec('xdotool key Return');          // optional desktop control
//   const url = await session.directUrl();             // best-effort noVNC URL (HopX)
//   await session.stop();
//
// 100% ADDITIVE: if the graphical stack can't be installed (rare), start() throws
// and the caller silently falls back to the existing headless browse — the agent
// is never left broken.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// Where inside the sandbox workdir we keep the live-view runtime + current frame.
const LIVE_DIR = '.wormgpt_live';
const FRAME_FILE = `${LIVE_DIR}/frame.jpg`;
const STATE_FILE = `${LIVE_DIR}/state.json`;
const DISPLAY = ':99';
const SCREEN_W_DEFAULT = 1280;
const SCREEN_H_DEFAULT = 800;

function shquote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// The one-shot bootstrap script. It is IDEMPOTENT (sentinel-guarded) and tries
// hard to install a graphical stack with whatever package manager exists, then
// launches Xvfb + a WM + Chromium on the virtual display and a frame-capture
// loop. Everything is best-effort; the capture loop falls back across scrot →
// ImageMagick `import` → ffmpeg so at least one always produces frames.
function bootstrapScript(width, height, fps, quality) {
  const w = parseInt(width, 10) || SCREEN_W_DEFAULT;
  const h = parseInt(height, 10) || SCREEN_H_DEFAULT;
  const interval = Math.max(0.1, 1 / (parseInt(fps, 10) || 3)).toFixed(2);
  const q = Math.min(95, Math.max(30, parseInt(quality, 10) || 60));
  // Installs are wrapped so a missing package manager never aborts the script.
  return `
set +e
export DEBIAN_FRONTEND=noninteractive
LIVE_DIR=${shquote(LIVE_DIR)}
mkdir -p "$LIVE_DIR"
SENTINEL="$LIVE_DIR/.installed"

log(){ echo "[live] $*"; }

install_pkgs(){
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -y >/dev/null 2>&1 || apt-get update -y >/dev/null 2>&1
    PKGS="xvfb x11-utils x11vnc fluxbox scrot imagemagick ffmpeg xdotool wmctrl chromium chromium-browser novnc websockify python3-websockify"
    sudo apt-get install -y $PKGS >/dev/null 2>&1 || apt-get install -y $PKGS >/dev/null 2>&1
  elif command -v apk >/dev/null 2>&1; then
    sudo apk add --no-cache xvfb x11vnc fluxbox scrot imagemagick ffmpeg xdotool chromium chromium-chromedriver novnc websockify >/dev/null 2>&1 || \
      apk add --no-cache xvfb x11vnc fluxbox scrot imagemagick ffmpeg xdotool chromium chromium-chromedriver novnc websockify >/dev/null 2>&1
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y xorg-x11-server-Xvfb x11vnc fluxbox scrot ImageMagick ffmpeg xdotool chromium novnc python3-websockify >/dev/null 2>&1
  fi
  # noVNC sometimes ships without a websockify launcher on PATH — pip is the
  # universal fallback so the web-VNC bridge ALWAYS comes up.
  if ! command -v websockify >/dev/null 2>&1; then
    sudo pip3 install --quiet websockify >/dev/null 2>&1 || pip3 install --quiet --user websockify >/dev/null 2>&1 || true
  fi
}

if [ ! -f "$SENTINEL" ]; then
  log "installing graphical stack (first run)…"
  install_pkgs
  touch "$SENTINEL"
fi

# Resolve a chromium binary (names vary by distro/snap).
CHROME=""
for c in chromium chromium-browser google-chrome google-chrome-stable chrome; do
  if command -v "$c" >/dev/null 2>&1; then CHROME="$c"; break; fi
done

# Start Xvfb on ${DISPLAY} if not already up.
export DISPLAY=${DISPLAY}
if ! (command -v xdpyinfo >/dev/null 2>&1 && xdpyinfo -display ${DISPLAY} >/dev/null 2>&1); then
  pkill -f "Xvfb ${DISPLAY}" >/dev/null 2>&1
  nohup Xvfb ${DISPLAY} -screen 0 ${w}x${h}x24 -ac +extension RANDR >/dev/null 2>&1 &
  sleep 1.5
fi

# Lightweight window manager (best-effort, makes windows render/decorate sanely).
if command -v fluxbox >/dev/null 2>&1 && ! pgrep -x fluxbox >/dev/null 2>&1; then
  nohup fluxbox >/dev/null 2>&1 &
  sleep 0.5
fi

# x11vnc (the VNC server the web bridge connects to). Bound to all interfaces
# inside the ISOLATED sandbox so the in-sandbox websockify can reach it; the
# sandbox itself is network-isolated and the public exposure is gated by the
# backend's signed preview-URL token, so this is safe.
if command -v x11vnc >/dev/null 2>&1 && ! pgrep -x x11vnc >/dev/null 2>&1; then
  nohup x11vnc -display ${DISPLAY} -forever -shared -nopw -quiet -rfbport 5900 -listen 0.0.0.0 >/dev/null 2>&1 &
  sleep 0.5
fi

# noVNC/websockify (web-VNC) — exposes 0.0.0.0:6080 → localhost:5900 and serves
# the noVNC web client. Binding 0.0.0.0 is REQUIRED so the backend's public
# preview proxy (e.g. Daytona's https://6080-<id>.proxy…) can reach it; that is
# the reliable live path the mobile APK loads in a WebView.
if command -v websockify >/dev/null 2>&1 && ! pgrep -f "websockify.*6080" >/dev/null 2>&1; then
  NOVNC_WEB=""
  for d in /usr/share/novnc /usr/share/webapps/novnc /opt/novnc /usr/share/novnc/utils; do
    [ -d "$d" ] && NOVNC_WEB="$d" && break
  done
  if [ -n "$NOVNC_WEB" ]; then
    nohup websockify --web "$NOVNC_WEB" 0.0.0.0:6080 localhost:5900 >/dev/null 2>&1 &
  else
    nohup websockify 0.0.0.0:6080 localhost:5900 >/dev/null 2>&1 &
  fi
  sleep 0.5
fi

# Launch the visible browser on the virtual display (kiosk-ish, big window).
# HARDENED against bot-detection: a realistic desktop UA + window size, the
# automation flags disabled (no "Chrome is being controlled by automated
# software" banner / navigator.webdriver=true), and language/UA-hint defaults
# that match a normal user — so sites don't bounce clicks or redirect back as if
# they detected a headless/automated browser.
if [ -n "$CHROME" ] && ! pgrep -f "$CHROME .*--user-data-dir=$LIVE_DIR/profile" >/dev/null 2>&1; then
  REAL_UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  "$CHROME" \
    --no-sandbox --disable-gpu --disable-dev-shm-usage \
    --no-first-run --no-default-browser-check --start-maximized \
    --window-position=0,0 --window-size=${w},${h} \
    --user-data-dir="$LIVE_DIR/profile" \
    --remote-debugging-port=9222 \
    --remote-allow-origins=* \
    --disable-blink-features=AutomationControlled \
    --exclude-switches=enable-automation \
    --disable-automation \
    --disable-infobars \
    --disable-features=IsolateOrigins,site-per-process,Translate,AutomationControlled \
    --disable-popup-blocking \
    --no-sandbox \
    --lang=en-US --accept-lang=en-US,en \
    --user-agent="$REAL_UA" \
    --password-store=basic --use-mock-keychain \
    "about:blank" >/dev/null 2>&1 &
  sleep 2
  # 🥷 STEALTH: patch the most common automation tells via CDP so click-driven
  # sites stop bouncing/redirecting us as a bot. Applied to every NEW document
  # (Page.addScriptToEvaluateOnNewDocument) so it survives navigations:
  #   • navigator.webdriver → undefined
  #   • a realistic navigator.languages / plugins / chrome object
  STEALTH_JS='Object.defineProperty(navigator,"webdriver",{get:()=>undefined});window.chrome={runtime:{}};Object.defineProperty(navigator,"languages",{get:()=>["en-US","en"]});Object.defineProperty(navigator,"plugins",{get:()=>[1,2,3,4,5]});const _q=window.navigator.permissions&&window.navigator.permissions.query;if(_q){window.navigator.permissions.query=(p)=>p&&p.name==="notifications"?Promise.resolve({state:Notification.permission}):_q(p);}'
  WS=$(curl -s --max-time 5 http://127.0.0.1:9222/json | tr ',' '\\n' | grep -m1 '"webSocketDebuggerUrl"' | sed -E 's/.*"(ws[^"]+)".*/\\1/')
  if [ -n "$WS" ] && command -v python3 >/dev/null 2>&1; then
    STEALTH_JS="$STEALTH_JS" WS="$WS" python3 - <<'PYEOF' >/dev/null 2>&1 || true
import json,os,socket,base64,hashlib
try:
    import websocket  # optional; skip silently if missing
except Exception:
    raise SystemExit(0)
ws=os.environ.get("WS"); js=os.environ.get("STEALTH_JS")
try:
    c=websocket.create_connection(ws,timeout=5)
    c.send(json.dumps({"id":1,"method":"Page.enable"}))
    c.send(json.dumps({"id":2,"method":"Page.addScriptToEvaluateOnNewDocument","params":{"source":js}}))
    c.close()
except Exception:
    pass
PYEOF
  fi
fi

# Capture loop: grab the framebuffer → JPEG, a few fps. Best capturer wins.
# Guarded by a pidfile so we only ever run one loop.
PIDF="$LIVE_DIR/capture.pid"
if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF" 2>/dev/null)" 2>/dev/null; then
  log "capture already running"
else
  capture_once(){
    if command -v scrot >/dev/null 2>&1; then
      scrot -q ${q} -o "$LIVE_DIR/frame.tmp.jpg" >/dev/null 2>&1 && return 0
    fi
    if command -v import >/dev/null 2>&1; then
      import -window root -quality ${q} "$LIVE_DIR/frame.tmp.jpg" >/dev/null 2>&1 && return 0
    fi
    if command -v ffmpeg >/dev/null 2>&1; then
      ffmpeg -y -f x11grab -draw_mouse 1 -video_size ${w}x${h} -i ${DISPLAY} -frames:v 1 -q:v 5 "$LIVE_DIR/frame.tmp.jpg" >/dev/null 2>&1 && return 0
    fi
    return 1
  }
  ( 
    echo $$ > "$PIDF"
    while [ -f "$PIDF" ]; do
      if capture_once; then mv -f "$LIVE_DIR/frame.tmp.jpg" "$LIVE_DIR/frame.jpg" 2>/dev/null; fi
      sleep ${interval}
    done
  ) >/dev/null 2>&1 &
  log "capture loop started"
fi

echo "LIVE_READY chrome=$CHROME display=${DISPLAY} ${w}x${h}"
`;
}

// Drive the live browser via the Chrome DevTools Protocol over the in-sandbox
// debugging port (127.0.0.1:9222). We do it with a tiny inline node/curl call so
// we need no extra deps. Falls back to xdotool URL typing if CDP is unavailable.
function openUrlScript(url) {
  const u = url.replace(/'/g, '');
  return `
set +e
export DISPLAY=${DISPLAY}
TARGET=$(curl -s --max-time 5 http://127.0.0.1:9222/json | tr ',' '\\n' | grep -m1 '"webSocketDebuggerUrl"' )
# Prefer the simple /json/new?<url> activation endpoint (creates/navigates a tab).
if curl -s --max-time 5 "http://127.0.0.1:9222/json/new?${u}" >/dev/null 2>&1; then
  echo "NAV_OK_NEWTAB"
else
  # Fallback: focus the window and type the URL via xdotool.
  if command -v xdotool >/dev/null 2>&1; then
    xdotool search --onlyvisible --class chromium windowactivate >/dev/null 2>&1
    xdotool key ctrl+l >/dev/null 2>&1
    xdotool type --delay 30 '${u}' >/dev/null 2>&1
    xdotool key Return >/dev/null 2>&1
    echo "NAV_OK_XDOTOOL"
  else
    echo "NAV_FAILED"
  fi
fi
`;
}

/**
 * Start a live-screen session inside an already-provisioned sandbox `fsx`.
 *
 * @param {object} fsx   the agentEngine fsx object (sh + downloadBuffer + sandboxId/backend)
 * @param {object} opts  { onFrame(fn b64,meta), onStep(fn note), fps, quality, width, height,
 *                         maxMs (auto-stop safety), idleStopMs }
 * @returns {object} session { openUrl, exec, directUrl, stop, isRunning }
 */
async function start(fsx, opts = {}) {
  if (!fsx || typeof fsx.sh !== 'function') {
    throw new Error('liveScreen.start: fsx with sh() is required');
  }
  const onFrame = typeof opts.onFrame === 'function' ? opts.onFrame : () => {};
  const onStep = typeof opts.onStep === 'function' ? opts.onStep : () => {};
  const fps = Math.min(8, Math.max(1, parseInt(opts.fps, 10) || 3));
  const quality = opts.quality || 60;
  const width = opts.width || SCREEN_W_DEFAULT;
  const height = opts.height || SCREEN_H_DEFAULT;
  const maxMs = parseInt(opts.maxMs, 10) || 8 * 60 * 1000; // hard safety cap
  const pollMs = Math.max(120, Math.round(1000 / fps));

  onStep('🖥️ booting live screen (virtual display + browser) inside the sandbox…');
  const boot = await fsx.sh(bootstrapScript(width, height, fps, quality));
  const bootOut = (boot && (boot.output || boot)) || '';
  if (!/LIVE_READY/.test(String(bootOut))) {
    throw new Error('live screen failed to boot: ' + String(bootOut).slice(-300));
  }
  onStep('🟢 live screen is up — streaming the agent\'s view in real time.');

  let running = true;
  let lastSig = '';
  const startedAt = Date.now();
  let frameCount = 0;

  // The frame pump: poll the JPEG file, emit changed frames as base64 over onFrame.
  const loop = (async () => {
    while (running) {
      if (Date.now() - startedAt > maxMs) { running = false; break; }
      try {
        const buf = await fsx.downloadBuffer(FRAME_FILE);
        if (buf && buf.length > 256) {
          // Cheap change-detection: size + a few bytes. Avoids spamming identical frames.
          const sig = buf.length + ':' + buf[100] + ':' + buf[buf.length - 1];
          if (sig !== lastSig) {
            lastSig = sig;
            frameCount++;
            onFrame(buf.toString('base64'), { w: width, h: height, ts: Date.now(), n: frameCount });
          }
        }
      } catch (_) { /* frame not ready yet — keep polling */ }
      await new Promise(r => setTimeout(r, pollMs));
    }
  })();

  const session = {
    isRunning: () => running,
    backend: fsx.backend,
    sandboxId: fsx.sandboxId,

    // Navigate the live browser to a URL (visible on the stream).
    async openUrl(url) {
      if (!url) return;
      const full = /^https?:\/\//i.test(url) ? url : 'https://' + url;
      onStep('🌐 opening ' + full + ' in the live browser…');
      try { await fsx.sh(openUrlScript(full)); } catch (_) {}
    },

    // Run an arbitrary X command inside the live session (e.g. xdotool clicks).
    async exec(cmd) {
      try { return await fsx.sh(`export DISPLAY=${DISPLAY}; ${cmd}`); }
      catch (e) { return { output: '[live exec error] ' + e.message }; }
    },

    // Best-effort public web-VNC URL. The PRIMARY reliable live path on mobile:
    // Daytona (and any backend exposing getPreviewUrl) turns the in-sandbox
    // noVNC port (6080) into a public HTTPS URL we can load in a WebView. We
    // prefer the backend's native preview proxy; fall back to a raw publicHost
    // when the backend exposes one directly. The returned URL is click-free
    // (noVNC autoconnect + scale + embedded auth token).
    async directUrl() {
      // 1) Native backend preview proxy (Daytona) — the robust path.
      try {
        const mod = fsx.backendMod || (fsx.backend === 'Daytona' ? require('./daytona') : null);
        if (mod && typeof mod.getPreviewUrl === 'function' && fsx.sandboxId) {
          const pv = await mod.getPreviewUrl(fsx.sandboxId, 6080, { novnc: true });
          if (pv && pv.url) return pv.url;
        }
      } catch (_) {}
      // 2) Raw public host fallback (backends that expose a host directly).
      try {
        const host = fsx.publicHost || (fsx.backendMod && fsx.backendMod._publicHostFor &&
          await fsx.backendMod._publicHostFor(fsx.sandboxId));
        if (host) return String(host).replace(/\/+$/, '') + ':6080/vnc.html?autoconnect=true&resize=scale';
      } catch (_) {}
      return null;
    },

    // Stop the pump and tear down the in-sandbox capture loop (keeps the browser
    // so a follow-up live action is instant; the sandbox lifecycle handles the rest).
    async stop() {
      running = false;
      try { await loop; } catch (_) {}
      try {
        await fsx.sh(`rm -f ${shquote(LIVE_DIR + '/capture.pid')} >/dev/null 2>&1; true`);
      } catch (_) {}
      onStep('🛑 live screen stopped (' + frameCount + ' frames streamed).');
    },
  };

  return session;
}

module.exports = { start, LIVE_DIR, FRAME_FILE, DISPLAY };
