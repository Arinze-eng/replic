---
name: web-hacking-suite
description: End-to-end web application penetration testing: recon, fingerprinting, directory brute-force, injection (SQLi/XSS/SSRF/LFI), auth bypass, and reporting. Use for any "test this website/webapp for vulnerabilities" task.
---

# Web Hacking Suite

A repeatable, tool-backed methodology for **authorized** web-app security testing.
Every command runs inside the sandbox (the agent owns the box); tools auto-install
via the hardened installer (apt→Kali repo→allowlisted pip).

## Workflow (follow in order — never skip recon)
1. **Scope + recon**
   - `whois <domain>`, `dig +short <domain>` / `dig ANY <domain>`, `host <domain>`
   - Resolve to IP, note CDN/WAF: `wafw00f https://<host>`
2. **Port/service map** — `nmap -Pn -sV -T4 --top-ports 1000 <host>` (full: `-p-`)
3. **HTTP fingerprint** — `whatweb -a3 https://<host>`, `curl -sI https://<host>`
4. **Content discovery** — `gobuster dir -u https://<host> -w /usr/share/wordlists/dirb/common.txt -t 40` (fallback `ffuf`, `dirsearch`)
5. **Vuln scan** — `nikto -h https://<host>`; targeted: `sqlmap -u "<url>?id=1" --batch --level 2`
6. **Manual injection checks** — XSS reflection, SSRF, LFI/path traversal, IDOR, auth/session flaws.
7. **TLS** — `sslscan <host>` or the `tls-ssl-auditor` skill.
8. **Report** — severity, reproduction steps, evidence (request/response), remediation.

## Rules
- Always confirm the target is in-scope / authorized (bug bounty, own asset, lab).
- Rate-limit aggressive scans; never DoS.
- If a tool is "missing", it WILL auto-install — retry once, do not fall back to guessing.
- Deliver ONE consolidated report (Markdown or PDF), not fragments.
