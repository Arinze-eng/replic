# TOOLS_INSTALL_FIX.md — Making the sandbox behave like a full VPS (no failed installs)

This round fixes the user's #1 pain point: *"tools/Kali tools don't work, tools
don't install and fall back"* — with the exact symptom in the reported screenshot:

```
[auto-install] installed missing CLI 'dig'
bash _step.sh 2>&1
File "/usr/local/bin/dig", line 5, in <module>   ← broken python script, not dig
...the skill index is inaccessible...
```

## Root causes found (3)

### 1. 🔴 Blind `pip install <binary>` fallback → junk PyPI squatter (THE screenshot bug)
`agent_worker/agent.py` `_ensure_pkg(kind="apt")` had a last-rung ladder step
`pip install <toolname>`. When apt couldn't get `dig` yet, it ran `pip install dig`
— a real junk PyPI package literally named `dig` that drops a broken
`/usr/local/bin/dig` **python script**. Running it → the `line 5` traceback.

**Fix:** the pip fallback for CLIs is now **allowlist-only** (`_CLI_PIP_ALLOW`) and
a hard **blocklist** (`_CLI_PIP_BLOCK`: dig, host, nc, nmap, whois, hydra, gcc, …)
guarantees we NEVER pip-install a system binary. Success is proven by
`command -v` (the tool is actually runnable), never by parsing installer chatter.
Applied to BOTH `agent_worker/agent.py` and the mirror
`desktop_agent/src/agent_worker/agent.py`.

### 2. 🔴 `.codebanana/.skills/` was never committed → "skill index inaccessible"
`prompts/skills_index.md` advertised 125 skills to the agent, but the
`.codebanana/.skills/` directory did not exist in the repo at all (not gitignored
— simply never committed). So every `read_skill` failed → the screenshot's
*"skill index is inaccessible"*.

**Fix:**
- `scripts/install-cowhub-skills.js` re-fetches the 66 CowAgent hub skills.
- `scripts/recreate-local-skills.js` (new) recreates the lost local power-skills
  (web-hacking-suite, fullstack-pentest, full-recon, tls-ssl-auditor,
  webshell-master, forensic-analyst, self-reflection, persistent-execution,
  output-verifier, sandbox-warrior, coding-master).
- `scripts/regen-skills-index.js` rebuilds the index from on-disk SKILL.md
  (single source of truth). Result: index count == on-disk count (104).
- The whole `.codebanana/.skills/` tree (591 files) is now committed.

### 3. 🟠 Debian base only had `main` → pentest packages "Unable to locate"
The sandbox base image only enables the apt `main` component; sqlmap/nikto/hydra/
seclists live in contrib/non-free/Kali. `kaliBootstrap.js` enables them but runs
in the background, so an early tool call could hit apt before the repos were ready.

**Fix:** a new `_enable_extra_repos()` in agent.py enables Debian
contrib/non-free + the Kali repo (pinned priority 50 so it never auto-upgrades
Debian) inline, the first time an apt install is attempted — mirroring
`kaliBootstrap.js`. Idempotent, once per process. Plus `_APT_NAME_MAP` was
greatly expanded (dig/host/nslookup→dnsutils, nc→netcat-openbsd,
ifconfig/netstat→net-tools, gcc/g++/make→build-essential, etc.).

## Verification — LIVE on a real Novita sandbox

`npm run test:novita-tools` (new, `scripts/test-novita-tools-live.js`) — creates a
real Novita sandbox, runs the repo-enable + Kali bootstrap, then:

- **`dig` resolves to `/usr/bin/dig`, an ELF binary from dnsutils** (never a
  `/usr/local/bin` python squatter) — the exact regression is dead.
- **505-command battery: 100% success** (coreutils, arithmetic, file I/O,
  python, node, text pipelines).
- **35 core security/dev tools** present or installable (nmap, sqlmap, nikto,
  hydra, whois, dnsrecon, sslscan, ffmpeg, …).
- Functional smoke: dig/curl/python/node/nmap/openssl/git/base64 all run.
- Anti-squatter sweep: no CLI resolves to a python-script binary.

Result: **48 passed, 0 failed, 0 skipped.**

Offline suites still green: `npm run test:sandbox-tools` (ALL PASSED),
`npm run test:skills` (15/15).

## New npm scripts
- `npm run test:novita-tools` — live 500+ command/tool verification (needs NOVITA_API_KEY).
- `npm run skills:recreate-local` — recreate local power-skills + regen index.
