---
name: full-recon
description: Passive + active reconnaissance: WHOIS, DNS, subdomain enumeration, port/service discovery, tech fingerprinting. First step before any offensive testing.
---

# Full Recon

## Passive
- `whois <domain>`; DNS: `dig +short A/AAAA/MX/TXT/NS <domain>`, `dnsrecon -d <domain>`
- Subdomains: `sublist3r -d <domain>`, cert transparency (crt.sh via curl).
- OSINT: `theHarvester -d <domain> -b all`

## Active
- `nmap -Pn -sn <cidr>` (host discovery) → `nmap -Pn -sV -T4 <live hosts>`
- HTTP: `whatweb`, `curl -sI`, `wafw00f`

## Output
A clean asset inventory: domains, IPs, open ports, services+versions, tech stack, WAF/CDN.
