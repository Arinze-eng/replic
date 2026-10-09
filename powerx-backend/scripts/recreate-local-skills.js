#!/usr/bin/env node
/**
 * recreate-local-skills.js
 * Recreates the local "power-skills" that were referenced by prompts/skills_index.md
 * but were never committed to git (so read_skill always failed with "skill not
 * found" / "skill index inaccessible"). These are authored specifically for the
 * WormGPT security/autonomous agent. After writing them, run
 *   node scripts/regen-skills-index.js
 * to rebuild the index from the on-disk SKILL.md files (single source of truth).
 *
 * Idempotent: overwrites each SKILL.md with the canonical content below.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKILLS = path.join(ROOT, '.codebanana', '.skills');

function skill(rel, name, description, body) {
  const dir = path.join(SKILLS, rel);
  fs.mkdirSync(dir, { recursive: true });
  const md = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), md, 'utf8');
  process.stdout.write('.');
}

// ── SECURITY SUITE ───────────────────────────────────────────────────────────
skill('web-hacking-suite', 'web-hacking-suite',
  'End-to-end web application penetration testing: recon, fingerprinting, directory brute-force, injection (SQLi/XSS/SSRF/LFI), auth bypass, and reporting. Use for any "test this website/webapp for vulnerabilities" task.',
`# Web Hacking Suite

A repeatable, tool-backed methodology for **authorized** web-app security testing.
Every command runs inside the sandbox (the agent owns the box); tools auto-install
via the hardened installer (apt→Kali repo→allowlisted pip).

## Workflow (follow in order — never skip recon)
1. **Scope + recon**
   - \`whois <domain>\`, \`dig +short <domain>\` / \`dig ANY <domain>\`, \`host <domain>\`
   - Resolve to IP, note CDN/WAF: \`wafw00f https://<host>\`
2. **Port/service map** — \`nmap -Pn -sV -T4 --top-ports 1000 <host>\` (full: \`-p-\`)
3. **HTTP fingerprint** — \`whatweb -a3 https://<host>\`, \`curl -sI https://<host>\`
4. **Content discovery** — \`gobuster dir -u https://<host> -w /usr/share/wordlists/dirb/common.txt -t 40\` (fallback \`ffuf\`, \`dirsearch\`)
5. **Vuln scan** — \`nikto -h https://<host>\`; targeted: \`sqlmap -u "<url>?id=1" --batch --level 2\`
6. **Manual injection checks** — XSS reflection, SSRF, LFI/path traversal, IDOR, auth/session flaws.
7. **TLS** — \`sslscan <host>\` or the \`tls-ssl-auditor\` skill.
8. **Report** — severity, reproduction steps, evidence (request/response), remediation.

## Rules
- Always confirm the target is in-scope / authorized (bug bounty, own asset, lab).
- Rate-limit aggressive scans; never DoS.
- If a tool is "missing", it WILL auto-install — retry once, do not fall back to guessing.
- Deliver ONE consolidated report (Markdown or PDF), not fragments.`);

skill('fullstack-pentest', 'fullstack-pentest',
  'Full-stack penetration test covering network, web, API, and auth layers with a structured kill-chain and consolidated report.',
`# Full-Stack Pentest

Combines network + web + API testing into one engagement.

## Phases
1. **Discovery** — subdomain enum (\`sublist3r\`, \`dnsrecon -d <domain>\`), live host check.
2. **Network** — \`nmap -Pn -sV -sC -T4 <targets>\`, service versions → known CVEs.
3. **Web** — use the \`web-hacking-suite\` methodology per host.
4. **API** — enumerate endpoints, test authz (IDOR/BOLA), input validation, rate limits, JWT flaws (\`arjun\` for params).
5. **Auth** — password policy, brute-force resistance (\`hydra\` where authorized), session/cookie security, MFA bypass.
6. **Report** — executive summary + technical findings (CVSS), prioritized remediation.

## Quality bar
- Every finding: impact + reproduction + evidence + fix.
- Consolidate into a single deliverable.`);

skill('full-recon', 'full-recon',
  'Passive + active reconnaissance: WHOIS, DNS, subdomain enumeration, port/service discovery, tech fingerprinting. First step before any offensive testing.',
`# Full Recon

## Passive
- \`whois <domain>\`; DNS: \`dig +short A/AAAA/MX/TXT/NS <domain>\`, \`dnsrecon -d <domain>\`
- Subdomains: \`sublist3r -d <domain>\`, cert transparency (crt.sh via curl).
- OSINT: \`theHarvester -d <domain> -b all\`

## Active
- \`nmap -Pn -sn <cidr>\` (host discovery) → \`nmap -Pn -sV -T4 <live hosts>\`
- HTTP: \`whatweb\`, \`curl -sI\`, \`wafw00f\`

## Output
A clean asset inventory: domains, IPs, open ports, services+versions, tech stack, WAF/CDN.`);

skill('tls-ssl-auditor', 'tls-ssl-auditor',
  'Audit TLS/SSL configuration of a host: protocols, ciphers, certificate validity, known weaknesses (Heartbleed, POODLE, weak DH).',
`# TLS/SSL Auditor

## Commands
- \`sslscan <host>:443\` — protocols + cipher suites + cert.
- \`echo | openssl s_client -connect <host>:443 -servername <host> 2>/dev/null | openssl x509 -noout -dates -issuer -subject\`
- \`sslyze <host>\` (deep) if available.

## Check for
- SSLv2/SSLv3/TLS1.0/1.1 enabled (fail), TLS1.2/1.3 support.
- Weak ciphers (RC4, 3DES, NULL, EXPORT), weak DH (<2048).
- Cert: expiry, chain, hostname match, self-signed.
- Known bugs: Heartbleed, POODLE, ROBOT, BEAST.

## Output
Grade (A–F) + prioritized remediation.`);

skill('webshell-master', 'webshell-master',
  'Manage and interact with a deployed web shell for authorized post-exploitation: command execution, file transfer, and cleanup.',
`# Webshell Master

For **authorized** post-exploitation / red-team labs only.

## Interaction
- Execute commands via the shell endpoint, capture stdout/stderr.
- Prefer the sandbox's own \`bash\`/\`run_code\` tools to build payloads and parse responses.
- Stage → execute → collect → **clean up** artifacts.

## Rules
- Never touch systems outside the authorized scope.
- Log every action for the report; remove uploaded files when done.`);

skill('forensic-analyst', 'forensic-analyst',
  'Digital forensics: analyze files, logs, memory dumps, metadata, and artifacts to reconstruct events. Use for incident response and evidence analysis.',
`# Forensic Analyst

## Toolbox
- File type: \`file <f>\`; metadata: \`exiftool <f>\`; strings: \`strings -n 8 <f>\`
- Hex: \`xxd <f> | head\`; hashes: \`sha256sum\`, \`md5sum\`
- Logs: grep/awk timelines; \`jq\` for JSON logs.
- Archives: \`7z l\`, \`unzip -l\`, \`unrar l\`.

## Method
1. Preserve integrity (hash originals, work on copies).
2. Timeline reconstruction from artifacts + logs.
3. IOC extraction; correlate.
4. Report: what happened, when, evidence, confidence.`);

// ── AUTONOMY / META SKILLS ───────────────────────────────────────────────────
skill('self-reflection', 'self-reflection',
  'Meta-skill: plan → act → critique your own output → improve → verify, looping until a self-grade of 9/10. Apply around every non-trivial task.',
`# Self-Reflection (Manus-style)

Wrap EVERY non-trivial task in this loop:
1. **Plan** the concrete steps + success criteria.
2. **Act** — do the work with real tools (no simulation).
3. **Critique** your own output honestly against the criteria: what's missing, wrong, half-done?
4. **Improve** — fix the gaps.
5. **Verify** — objectively check (run it, open the file, re-read the requirement).
6. Repeat until you'd self-grade ≥ 9/10. Only then finish.

Never finish on a half-empty or untested result.`);

skill('persistent-execution', 'persistent-execution',
  'Meta-skill: never stop early. Keep working through obstacles (missing tools auto-install, errors get fixed) until the task is truly complete.',
`# Persistent Execution

- A missing tool is NOT a dead end — it auto-installs; retry the step.
- An error is a step to fix, not a reason to give up or ask the user.
- Do not report "I couldn't" for anything the sandbox can do (it can install/run anything).
- Only stop when the deliverable is complete and verified, or when you genuinely need a user decision.`);

skill('output-verifier', 'output-verifier',
  'Meta-skill: objectively verify the final artifact exists, is complete, and meets the request before finishing (file present, non-empty, correct format).',
`# Output Verifier

Before \`finish\`:
- \`list_files\` / \`read_file\` the deliverable → it exists and is non-empty.
- Format matches the request (PDF opens, code runs, report has all sections).
- No raw error text, no placeholder "TODO", no split fragments.
- If verification fails, go back and fix — do not finish.`);

skill('sandbox-warrior', 'sandbox-warrior',
  'Meta-skill: treat the sandbox as a full VPS you fully own — install anything, run long jobs, use apt/pip/npm/go freely, and never claim a limitation the box does not have.',
`# Sandbox Warrior

The sandbox is YOUR machine (Debian + Kali repos, sudo, apt/pip/npm/go, 900s/step).
- Install any tool on demand — it will resolve via the hardened installer.
- Run long scans/builds; stream output.
- Write/compile/execute code freely.
- Never say "not supported" — find the command that does it.`);

skill('coding-master', 'coding-master',
  'Senior-engineer coding loop: understand → design → write in full → run/test → fix → verify. Produce complete, runnable code, never stubs.',
`# Coding Master

1. **Understand** the requirement + existing code.
2. **Design** the structure.
3. **Write in full** — complete files, no "// ... rest here" stubs.
4. **Run & test** in the sandbox (\`run_code\`, \`bash\`, build commands).
5. **Fix** every error until it runs clean.
6. **Verify** against the requirement, then deliver.`);

console.log('\n[recreate] local power-skills written under .codebanana/.skills');
