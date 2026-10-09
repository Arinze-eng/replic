---
name: tls-ssl-auditor
description: Audit TLS/SSL configuration of a host: protocols, ciphers, certificate validity, known weaknesses (Heartbleed, POODLE, weak DH).
---

# TLS/SSL Auditor

## Commands
- `sslscan <host>:443` — protocols + cipher suites + cert.
- `echo | openssl s_client -connect <host>:443 -servername <host> 2>/dev/null | openssl x509 -noout -dates -issuer -subject`
- `sslyze <host>` (deep) if available.

## Check for
- SSLv2/SSLv3/TLS1.0/1.1 enabled (fail), TLS1.2/1.3 support.
- Weak ciphers (RC4, 3DES, NULL, EXPORT), weak DH (<2048).
- Cert: expiry, chain, hostname match, self-signed.
- Known bugs: Heartbleed, POODLE, ROBOT, BEAST.

## Output
Grade (A–F) + prioritized remediation.
