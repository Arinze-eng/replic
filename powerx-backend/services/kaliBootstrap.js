// ─────────────────────────────────────────────────────────────────────────────
// kaliBootstrap.js — ONE-TIME "Kali slim" security toolchain bootstrap for the
// agent sandboxes (Novita, Daytona, and every other backend that exposes the
// standard `exec(id, cmd)` contract).
//
// WHY THIS EXISTS
// ---------------
// The user's #1 pain point: the agent occasionally reports "a tool couldn't
// install / is missing" during a cybersecurity or vulnerability-testing task.
// Root cause, verified LIVE on a real Novita sandbox (Debian 12 "bookworm"):
//   • The base image only enables the apt `main` component, so classic pentest
//     packages (sqlmap, nikto, hydra, whois, …) resolve to
//     "E: Unable to locate package".
//   • Once `contrib non-free non-free-firmware` are enabled they install fine,
//     and adding the Kali `kali-rolling` repo (pinned LOW) makes the entire
//     Kali arsenal (seclists, wpscan, latest sqlmap, …) reachable on demand.
//   • pip installs (dnsrecon, wafw00f, wapiti3, …) work flawlessly with
//     `--break-system-packages`.
//
// THE DESIGN (no Docker needed — sandboxes are UNPRIVILEGED containers, so a
// nested Kali *image* can't run; instead we graft "Kali slim" onto the existing
// Debian userland, which IS Kali's own base):
//   1. Enable Debian contrib + non-free + non-free-firmware.
//   2. Add the Kali `kali-rolling` repo, pinned to priority 50 so it NEVER
//      silently upgrades Debian packages — it only supplies a package when the
//      user (or the agent) explicitly wants the Kali version or Debian lacks it.
//   3. Install a slim, high-value core arsenal via apt (from the now-reachable
//      Debian+Kali repos).
//   4. Install the pip-only tools via `pip --break-system-packages` (PRIMARY
//      installer per the user's instruction — pip is the most reliable path in
//      these sandboxes).
//   5. Drop a sentinel file so the whole thing runs EXACTLY ONCE per sandbox
//      disk. Re-invocations are instant (a single `test -f` probe).
//
// This module is backend-agnostic: pass in any object that has
// `exec(id, command, { timeout })` returning `{ exitCode, output }` (that's the
// shared contract daytona.js / novitaSandbox.js / runloop.js / hopx.js all
// implement) plus the sandbox `id`.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// Sentinel marks a fully-bootstrapped disk. Kept in the user's HOME (survives
// pause/resume — Novita & Daytona both preserve the disk across pause).
const SENTINEL = '.kali_slim_ready';

// Slim, high-signal apt arsenal. Deliberately NOT the full ~600-package
// `kali-linux-everything` metapackage (that would be gigabytes and "stress the
// sandbox"). These are the tools the agent reaches for most in recon / web /
// password / network work, and they all resolve once contrib+non-free+Kali are
// enabled (verified live: sqlmap, nikto, hydra, whois, nc, dig install cleanly).
const APT_ARSENAL = [
  // recon / DNS / net
  'nmap', 'masscan', 'dnsutils', 'whois', 'netcat-openbsd', 'net-tools',
  'iputils-ping', 'traceroute', 'tcpdump', 'openssl', 'socat',
  // web
  'nikto', 'sqlmap', 'whatweb', 'wafw00f', 'gobuster', 'dirb', 'wfuzz',
  'feroxbuster', 'ffuf', 'wapiti',
  // passwords / hashes
  'hydra', 'john', 'hashcat', 'hashid', 'crowbar', 'medusa',
  // wordlists / misc
  'seclists', 'wordlists', 'jq', 'git', 'curl', 'wget', 'python3-pip',
  'rsync', 'zip', 'unzip', 'samba-common',
];

// pip-only tools (or tools where pip is the most reliable install path). pip is
// the PRIMARY installer per the user's directive — these never touch apt.
const PIP_ARSENAL = [
  'dnsrecon', 'wafw00f', 'wapiti3', 'dirsearch', 'sublist3r',
  'arjun', 'droopescan', 'theHarvester', 'shodan', 'requests', 'httpx',
  'shodan', 'censys', 'vulners', 'python-nmap', 'pwntools',
  'requests-html', 'beautifulsoup4', 'selenium', 'colorama',
  'tldextract', 'toml', 'yaml', 'urllib3', 'certifi',
];

// feroxbuster is a Go tool — install via apt (Kali repo) or Go binary.
// The apt install includes it from the Kali repo if available.
const GO_ARSENAL = [
  'github.com/ffuf/ffuf/v2@latest',
];

// Build the idempotent bootstrap shell script. It is fully self-healing: every
// stage is best-effort (`|| true`) so one unavailable package can never abort
// the rest, and it ALWAYS ends by writing the sentinel + printing a marker.
function buildScript(sentinelPath) {
  const apt = APT_ARSENAL.join(' ');
  const pip = PIP_ARSENAL.join(' ');
  const goPkgs = GO_ARSENAL.join(' ');
  return `
set +e
export DEBIAN_FRONTEND=noninteractive
SU=""; [ "$(id -u)" = "0" ] || SU="sudo"

echo "[kali-slim] 1/5 enabling Debian contrib + non-free…"
# Debian 12 uses the deb822 .sources format; older images use sources.list.
if [ -f /etc/apt/sources.list.d/debian.sources ]; then
  $SU sed -i 's/^Components:.*/Components: main contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources || true
elif [ -f /etc/apt/sources.list ]; then
  $SU sed -i 's/ main$/ main contrib non-free non-free-firmware/' /etc/apt/sources.list || true
fi

echo "[kali-slim] 2/5 adding Kali repo (pinned low, on-demand only)…"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL https://archive.kali.org/archive-key.asc 2>/dev/null | $SU gpg --dearmor -o /usr/share/keyrings/kali.gpg 2>/dev/null || true
  echo 'deb [signed-by=/usr/share/keyrings/kali.gpg] http://http.kali.org/kali kali-rolling main contrib non-free non-free-firmware' | $SU tee /etc/apt/sources.list.d/kali.list >/dev/null || true
  # Priority 50 (< 100) => apt will NEVER auto-pull/upgrade from Kali; it is used
  # only when a package is missing from Debian or explicitly pinned by the user.
  printf 'Package: *\\nPin: release o=Kali\\nPin-Priority: 50\\n' | $SU tee /etc/apt/preferences.d/kali-pin >/dev/null || true
fi

echo "[kali-slim] 3/5 apt-get update…"
$SU apt-get update -y >/dev/null 2>&1 || true

echo "[kali-slim] 4/5 installing slim apt arsenal (best-effort, per-package)…"
# Install per-package so one missing name can't abort the batch.
for p in ${apt}; do
  $SU apt-get install -y --no-install-recommends "$p" >/dev/null 2>&1 || true
done

echo "[kali-slim] 5/5 installing pip arsenal (PRIMARY installer)…"
# pip first with --break-system-packages (PEP 668 override), plain pip fallback.
python3 -m pip install -q --break-system-packages ${pip} >/dev/null 2>&1 \
  || python3 -m pip install -q ${pip} >/dev/null 2>&1 || true
# Also install each individually so one bad wheel can't sink the whole set.
for p in ${pip}; do
  python3 -m pip install -q --break-system-packages "$p" >/dev/null 2>&1 || true
done

echo "[kali-slim] 6/6 installing Go tools…"
if command -v go >/dev/null 2>&1; then
  for pkg in ${goPkgs}; do
    go install "$pkg" >/dev/null 2>&1 || true
  done
  echo 'export PATH=$PATH:$(go env GOPATH 2>/dev/null)/bin' | $SU tee /etc/profile.d/go_bin.sh >/dev/null 2>&1 || true
fi

# Never write the durable marker after a partial install. The next task must be
# able to retry and self-heal instead of trusting a false-positive sentinel.
missing=""
for t in nmap dig whois nc curl wget git jq openssl unzip zip python3 pip3; do
  command -v "$t" >/dev/null 2>&1 || missing="$missing $t"
done
if [ -n "$missing" ]; then
  rm -f ${sentinelPath} 2>/dev/null || true
  echo "KALI_SLIM_INCOMPLETE missing:$missing"
  exit 1
fi
touch ${sentinelPath}
echo "KALI_SLIM_DONE"
`.trim();
}

// Is the Kali-slim arsenal already installed on this sandbox disk?
async function isReady(sb, id, home) {
  const sentinel = `${home}/${SENTINEL}`;
  try {
    const r = await sb.exec(id, `test -f ${sentinel} && echo READY || echo TODO`, { timeout: 20 });
    return /READY/.test((r && r.output) || '');
  } catch (_) { return false; }
}

// Run the one-time bootstrap. Returns { ok, alreadyReady, log }.
//   • sb    — the backend module (must expose exec(id, cmd, {timeout}))
//   • id    — sandbox id
//   • home  — the sandbox HOME dir (Novita/Runloop: /home/user, Daytona:
//             /home/daytona, CodeSandbox/LocalAlpine: /root)
//   • opts.background — if true (default), launch detached so it NEVER blocks
//             the first task; the arsenal finishes filling in while the agent
//             already works (any tool it needs early still self-installs).
//   • opts.onStep — progress callback for the UI.
async function bootstrap(sb, id, home, { background = true, onStep } = {}) {
  if (!sb || !id) return { ok: false, alreadyReady: false, log: 'missing sb/id' };
  const sentinel = `${home}/${SENTINEL}`;

  if (await isReady(sb, id, home)) {
    return { ok: true, alreadyReady: true, log: 'already installed' };
  }

  if (onStep) onStep('🐉 installing Kali-slim security toolchain (one-time, pip-first)…');

  const script = buildScript(sentinel);
  const b64 = Buffer.from(script, 'utf-8').toString('base64');

  if (background) {
    // Detached: write the script, run under setsid+nohup, log to a file. exec
    // returns immediately so the task proceeds; the arsenal fills in behind it.
    const launch =
      `mkdir -p ${home} && printf %s '${b64}' | base64 -d > ${home}/.kali_slim.sh && ` +
      `setsid bash -c 'nohup flock -n ${home}/.kali_slim.lock bash ${home}/.kali_slim.sh > ${home}/.kali_slim.log 2>&1 </dev/null &' ; echo launched`;
    try {
      await sb.exec(id, launch, { timeout: 30 });
      return { ok: true, alreadyReady: false, log: 'launched (background)' };
    } catch (e) {
      return { ok: false, alreadyReady: false, log: `launch failed: ${e.message}` };
    }
  }

  // Foreground (used by tests / the admin "warm now" button): wait for it.
  try {
    const r = await sb.exec(
      id,
      `printf %s '${b64}' | base64 -d > ${home}/.kali_slim.sh && bash ${home}/.kali_slim.sh 2>&1; rm -f ${home}/.kali_slim.sh`,
      { timeout: 900 }
    );
    const out = (r && r.output) || '';
    return { ok: /KALI_SLIM_DONE/.test(out), alreadyReady: false, log: out.slice(-3000) };
  } catch (e) {
    return { ok: false, alreadyReady: false, log: `bootstrap failed: ${e.message}` };
  }
}

// Quick capability report: which core tools are present right now. Handy for the
// admin panel / tests to prove the bootstrap worked.
async function report(sb, id) {
  const tools = ['nmap', 'sqlmap', 'nikto', 'hydra', 'whois', 'nc', 'dig',
                 'dnsrecon', 'wafw00f', 'wapiti', 'gobuster', 'whatweb'];
  const probe = tools.map(t => `printf '%s=' ${t}; command -v ${t} >/dev/null 2>&1 && echo OK || echo NO`).join('; ');
  try {
    const r = await sb.exec(id, probe, { timeout: 40 });
    return (r && r.output) || '';
  } catch (e) { return `report failed: ${e.message}`; }
}

module.exports = {
  SENTINEL, APT_ARSENAL, PIP_ARSENAL,
  buildScript, isReady, bootstrap, report,
};
