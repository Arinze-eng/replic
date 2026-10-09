'use strict';

// Per-chat Cloudflare Quick Tunnel lifecycle for sandbox Internet egress.
// Transport: Cloudflare WebSocket -> wstunnel -> loopback-only TinyProxy.
// A secret WebSocket path authenticates the transport and TinyProxy also uses
// per-session BasicAuth. /stopcloudflare kills all processes before suspending
// the sandbox. No Cloudflare account, zone, DNS record, or inbound sandbox port
// is required.

const crypto = require('crypto');
const db = require('../db');
const sandboxPool = require('./sandboxPool');

const SUPPORTED = new Set(['novita', 'upstashbox', 'runloop', 'tensorlake']);
const DEFAULT_PORT = clampPort(process.env.CLOUDFLARE_PROXY_PORT, 8888);
const WS_PORT = clampPort(process.env.CLOUDFLARE_WS_PORT, 8080);
const CLIENT_PORT = clampPort(process.env.CLOUDFLARE_CLIENT_PORT, 18888);
const START_TIMEOUT = Math.max(60, parseInt(process.env.CLOUDFLARE_TUNNEL_START_TIMEOUT_SEC || '300', 10));
const STATE_PREFIX = 'cloudflare_tunnel:';
const activeStarts = new Map();

function clampPort(value, fallback) {
  const parsed = parseInt(value || String(fallback), 10);
  return Math.min(65535, Math.max(1024, Number.isFinite(parsed) ? parsed : fallback));
}
function stateKey(sessionKey) { return STATE_PREFIX + String(sessionKey); }
function cleanProvider(value) {
  const v = String(value || '').trim().toLowerCase().replace(/[-_ ]/g, '');
  return ({ novita: 'novita', upstash: 'upstashbox', upstashbox: 'upstashbox', runloop: 'runloop', tensorlake: 'tensorlake' })[v] || '';
}
function quote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }
function randomSecret(bytes = 18) { return crypto.randomBytes(bytes).toString('base64url'); }
function parseUrl(output) {
  const matches = String(output || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/ig) || [];
  return matches.length ? matches[matches.length - 1] : '';
}
async function readState(sessionKey) {
  try {
    const raw = await db.getSetting(stateKey(sessionKey));
    if (!raw) return null;
    const state = JSON.parse(raw);
    return state && state.provider && state.sandboxId ? state : null;
  } catch (_) { return null; }
}
async function writeState(sessionKey, state) {
  await db.setSetting(stateKey(sessionKey), state ? JSON.stringify(state) : '');
}
async function providerAvailable(name) {
  const mod = sandboxPool.BACKENDS[name];
  if (!mod || !SUPPORTED.has(name)) return false;
  try {
    if (mod.enabledAsync) return !!(await mod.enabledAsync());
    if (mod.enabled) return !!mod.enabled();
  } catch (_) {}
  return false;
}
async function selectProvider(requested) {
  const explicit = cleanProvider(requested);
  if (explicit) {
    if (!(await providerAvailable(explicit))) throw new Error(`${sandboxPool.labelOf(explicit)} is not configured or is unavailable.`);
    return explicit;
  }
  for (const name of ['novita', 'upstashbox', 'runloop', 'tensorlake']) {
    if (await providerAvailable(name)) return name;
  }
  throw new Error('No supported sandbox provider is configured.');
}

function installAndStartScript({ port, wsPort, username, password, pathSecret }) {
  return `set -eu
BASE="$HOME/.powerx-cloudflare"
mkdir -p "$BASE/bin"
command -v curl >/dev/null 2>&1 || { command -v apt-get >/dev/null 2>&1 || { echo "INSTALL_ERROR: curl and apt-get unavailable"; exit 20; }; SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo"; $SUDO apt-get update -qq; $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates; }
command -v tinyproxy >/dev/null 2>&1 || { command -v apt-get >/dev/null 2>&1 || { echo "INSTALL_ERROR: apt-get is required for tinyproxy"; exit 20; }; SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo"; $SUDO apt-get update -qq; $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tinyproxy ca-certificates; }
ARCH="$(uname -m)"
case "$ARCH" in x86_64|amd64) CFARCH=amd64; WSARCH=amd64;; aarch64|arm64) CFARCH=arm64; WSARCH=arm64;; *) echo "INSTALL_ERROR: unsupported architecture $ARCH"; exit 21;; esac
if ! command -v cloudflared >/dev/null 2>&1 && [ ! -x "$BASE/bin/cloudflared" ]; then
  curl -fsSL --retry 4 --retry-delay 2 "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$CFARCH" -o "$BASE/bin/cloudflared"
  chmod 700 "$BASE/bin/cloudflared"
fi
if ! command -v wstunnel >/dev/null 2>&1 && [ ! -x "$BASE/bin/wstunnel" ]; then
  WS_URL="$(curl -fsSL --retry 4 https://api.github.com/repos/erebe/wstunnel/releases/latest | grep -Eo 'https://[^\" ]+linux_'"$WSARCH"'\\.tar\\.gz' | head -1)"
  [ -n "$WS_URL" ] || { echo "INSTALL_ERROR: compatible wstunnel release not found"; exit 25; }
  curl -fsSL --retry 4 --retry-delay 2 "$WS_URL" | tar -xz -C "$BASE/bin" wstunnel
  chmod 700 "$BASE/bin/wstunnel"
fi
CFBIN="$(command -v cloudflared || true)"; [ -n "$CFBIN" ] || CFBIN="$BASE/bin/cloudflared"
WSBIN="$(command -v wstunnel || true)"; [ -n "$WSBIN" ] || WSBIN="$BASE/bin/wstunnel"
cat > "$BASE/blocked" <<'FILTER'
(^|\\.|/)(localhost|localhost\\.localdomain)(:|/|$)
(^|/)(127\\.|10\\.|0\\.|169\\.254\\.|192\\.168\\.)
(^|/)(172\\.(1[6-9]|2[0-9]|3[01])\\.)
(^|/)(metadata\\.google\\.internal|metadata\\.azure\\.internal)(:|/|$)
FILTER
cat > "$BASE/tinyproxy.conf" <<CONF
Port ${port}
Listen 127.0.0.1
Timeout 60
MaxClients 20
StartServers 2
MinSpareServers 1
MaxSpareServers 4
MaxRequestsPerChild 100
BasicAuth ${username} ${password}
LogFile "$BASE/tinyproxy.log"
LogLevel Notice
PidFile "$BASE/tinyproxy.pid"
DisableViaHeader Yes
ViaProxyName "PowerX"
ConnectPort 443
ConnectPort 80
Filter "$BASE/blocked"
FilterURLs On
FilterExtended On
FilterCaseSensitive Off
FilterDefaultDeny No
CONF
# Best-effort network-layer SSRF defense. URL filters remain the fallback when
# a provider does not grant firewall privileges.
if command -v iptables >/dev/null 2>&1; then
  SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo"
  for NET in 0.0.0.0/8 10.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16; do
    $SUDO iptables -C OUTPUT -m owner --uid-owner "$(id -u)" -d "$NET" -j REJECT 2>/dev/null || $SUDO iptables -I OUTPUT -m owner --uid-owner "$(id -u)" -d "$NET" -j REJECT 2>/dev/null || true
  done
fi
for f in cloudflared wstunnel-client wstunnel-server tinyproxy; do [ -f "$BASE/$f.pid" ] && kill "$(cat "$BASE/$f.pid")" 2>/dev/null || true; done
rm -f "$BASE/"*.pid "$BASE/cloudflared.log" "$BASE/wstunnel-server.log"
nohup tinyproxy -d -c "$BASE/tinyproxy.conf" > "$BASE/tinyproxy.stdout" 2>&1 & echo $! > "$BASE/tinyproxy.pid"
for i in $(seq 1 30); do curl -fsS --max-time 2 -x "http://${username}:${password}@127.0.0.1:${port}" http://example.com/ >/dev/null 2>&1 && break; sleep 1; done
curl -fsS --max-time 5 -x "http://${username}:${password}@127.0.0.1:${port}" http://example.com/ >/dev/null || { echo "PROXY_ERROR"; tail -40 "$BASE/tinyproxy.stdout"; exit 22; }
nohup "$WSBIN" server --restrict-to "127.0.0.1:${port}" --restrict-http-upgrade-path-prefix ${quote(pathSecret)} "ws://127.0.0.1:${wsPort}" > "$BASE/wstunnel-server.log" 2>&1 & echo $! > "$BASE/wstunnel-server.pid"
for i in $(seq 1 20); do (echo >/dev/tcp/127.0.0.1/${wsPort}) >/dev/null 2>&1 && break; kill -0 "$(cat "$BASE/wstunnel-server.pid")" 2>/dev/null || { echo "WSTUNNEL_ERROR"; tail -60 "$BASE/wstunnel-server.log"; exit 26; }; sleep 1; done
nohup "$CFBIN" tunnel --no-autoupdate --protocol http2 --url "http://127.0.0.1:${wsPort}" > "$BASE/cloudflared.log" 2>&1 & echo $! > "$BASE/cloudflared.pid"
for i in $(seq 1 90); do
  URL="$(grep -Eo 'https://[a-z0-9-]+\\.trycloudflare\\.com' "$BASE/cloudflared.log" | tail -1 || true)"
  READY="$(grep -E 'Registered tunnel connection|Connection [^ ]+ registered' "$BASE/cloudflared.log" | tail -1 || true)"
  [ -n "$URL" ] && [ -n "$READY" ] && { echo "TUNNEL_URL=$URL"; echo "LOCAL_PORT=${port}"; exit 0; }
  kill -0 "$(cat "$BASE/cloudflared.pid")" 2>/dev/null || { echo "TUNNEL_ERROR"; tail -80 "$BASE/cloudflared.log"; exit 23; }
  sleep 2
done
echo "TUNNEL_TIMEOUT"; tail -80 "$BASE/cloudflared.log"; exit 24`;
}

async function verifyPublicProxy(mod, sandboxId, url, username, password, pathSecret, clientPort = CLIENT_PORT) {
  const wss = String(url).replace(/^https:/, 'wss:');
  const cmd = `set -eu
BASE="$HOME/.powerx-cloudflare"; WSBIN="$(command -v wstunnel || true)"; [ -n "$WSBIN" ] || WSBIN="$BASE/bin/wstunnel"
nohup "$WSBIN" client --http-upgrade-path-prefix ${quote(pathSecret)} -L "tcp://127.0.0.1:${clientPort}:127.0.0.1:${DEFAULT_PORT}" ${quote(wss)} > "$BASE/wstunnel-client.log" 2>&1 & echo $! > "$BASE/wstunnel-client.pid"
for i in $(seq 1 20); do (echo >/dev/tcp/127.0.0.1/${clientPort}) >/dev/null 2>&1 && break; kill -0 "$(cat "$BASE/wstunnel-client.pid")" 2>/dev/null || { tail -60 "$BASE/wstunnel-client.log"; exit 30; }; sleep 1; done
code=$(curl -sS -o /tmp/powerx_cf_probe -w '%{http_code}' --max-time 30 --proxy http://127.0.0.1:${clientPort} --proxy-user ${quote(`${username}:${password}`)} https://example.com/ || true)
kill "$(cat "$BASE/wstunnel-client.pid")" 2>/dev/null || true; rm -f "$BASE/wstunnel-client.pid"
grep -qi 'Example Domain' /tmp/powerx_cf_probe 2>/dev/null && [ "$code" = 200 ] && echo VERIFIED || { echo "VERIFY_FAILED:$code"; tail -60 "$BASE/wstunnel-client.log"; head -c 300 /tmp/powerx_cf_probe 2>/dev/null || true; }`;
  const result = await mod.exec(sandboxId, cmd, { cwd: null, timeout: 70 });
  if (!result || result.exitCode !== 0 || !/VERIFIED/.test(result.output || '')) {
    throw new Error(`The Cloudflare URL was created but failed its end-to-end proxy check: ${String(result && result.output || '').slice(-500)}`);
  }
  return true;
}

async function stopProcesses(mod, sandboxId) {
  if (!mod || !sandboxId) return;
  await mod.exec(sandboxId, `BASE="$HOME/.powerx-cloudflare"; for f in cloudflared wstunnel-client wstunnel-server tinyproxy; do [ -f "$BASE/$f.pid" ] && kill "$(cat "$BASE/$f.pid")" 2>/dev/null || true; done; pkill -f '[c]loudflared tunnel.*127.0.0.1' 2>/dev/null || true; pkill -f '[w]stunnel server.*127.0.0.1' 2>/dev/null || true; rm -f "$BASE/"*.pid`, { cwd: null, timeout: 30 }).catch(() => {});
}
async function sleepSandbox(mod, sandboxId) {
  if (!mod || !sandboxId) return false;
  const fn = mod.pauseSandbox || mod.suspendSandbox;
  if (typeof fn !== 'function') return false;
  return !!(await fn.call(mod, sandboxId));
}

async function start(sessionKey, options = {}) {
  if (!sessionKey) throw new Error('A session key is required.');
  const existing = await readState(sessionKey);
  if (existing) await stop(sessionKey).catch(() => {});
  const provider = await selectProvider(options.provider);
  const mod = sandboxPool.BACKENDS[provider];
  const username = `px_${crypto.createHash('sha256').update(String(sessionKey)).digest('hex').slice(0, 10)}`;
  const password = randomSecret();
  const pathSecret = `px-${randomSecret(24)}`;
  const acquired = await mod.getOrCreateSessionSandbox(sessionKey, { labels: { purpose: 'cloudflare-proxy' } });
  const sandboxId = acquired && (acquired.id || acquired);
  if (!sandboxId) throw new Error(`${sandboxPool.labelOf(provider)} did not return a sandbox.`);
  activeStarts.set(String(sessionKey), { provider, sandboxId: String(sandboxId) });
  try {
    const command = installAndStartScript({ port: DEFAULT_PORT, wsPort: WS_PORT, username, password, pathSecret });
    const result = await mod.exec(sandboxId, command, { cwd: null, timeout: START_TIMEOUT });
    const url = parseUrl(result && result.output);
    // TUNNEL_URL is printed only after cloudflared confirms edge registration.
    // Some provider SDKs report a stale/non-zero process status after package
    // post-install hooks even though the guarded script reached this success
    // marker, so the marker is the authoritative startup result.
    if (!result || !url) throw new Error(`Tunnel startup failed: ${String(result && result.output || '').slice(-900)}`);
    await verifyPublicProxy(mod, sandboxId, url, username, password, pathSecret, CLIENT_PORT);
    const state = {
      provider, sandboxId: String(sandboxId), url, wssUrl: url.replace(/^https:/, 'wss:'),
      localPort: DEFAULT_PORT, clientPort: CLIENT_PORT, publicPort: 443,
      startedAt: new Date().toISOString(), verifiedAt: new Date().toISOString(),
    };
    // Persist only lifecycle metadata. One-time proxy and WebSocket credentials
    // are returned to the requesting chat but never stored in the database.
    await writeState(sessionKey, state);
    return { ...state, username, password, pathSecret, reusedSandbox: !!(acquired && acquired.reused), verified: true };
  } catch (error) {
    await stopProcesses(mod, sandboxId).catch(() => {});
    await sleepSandbox(mod, sandboxId).catch(() => {});
    throw error;
  } finally {
    activeStarts.delete(String(sessionKey));
  }
}

async function stop(sessionKey) {
  const state = await readState(sessionKey) || activeStarts.get(String(sessionKey));
  if (!state) return { stopped: false, slept: false };
  const mod = sandboxPool.BACKENDS[state.provider];
  let slept = false;
  if (mod) {
    await stopProcesses(mod, state.sandboxId);
    slept = await sleepSandbox(mod, state.sandboxId).catch(() => false);
  }
  await writeState(sessionKey, null);
  return { stopped: true, slept, provider: state.provider };
}

function commandProvider(text) {
  const match = String(text || '').trim().match(/^\/(?:cloudflare|startcloudflare)(?:@\w+)?(?:\s+([\w-]+))?\s*$/i);
  if (!match) return null;
  if (!match[1]) return '';
  const provider = cleanProvider(match[1]);
  if (!provider) throw new Error('Unsupported provider. Use novita, upstash, runloop, or tensorlake.');
  return provider;
}
function isStartCommand(text) { return /^\/(?:cloudflare|startcloudflare)(?:@\w+)?(?:\s|$)/i.test(String(text || '').trim()); }
function isStopCommand(text) { return /^\/stopcloudflare(?:@\w+)?(?:\s|$)/i.test(String(text || '').trim()); }
function clientCommand(state, binary = 'wstunnel') {
  return `${binary} client --http-upgrade-path-prefix ${state.pathSecret} -L tcp://127.0.0.1:${state.clientPort}:127.0.0.1:${state.localPort} ${state.wssUrl}`;
}

module.exports = {
  SUPPORTED, DEFAULT_PORT, WS_PORT, CLIENT_PORT, cleanProvider, parseUrl, commandProvider,
  isStartCommand, isStopCommand, clientCommand, start, stop,
  _private: { installAndStartScript, verifyPublicProxy, selectProvider, readState, writeState, stopProcesses, sleepSandbox },
};
