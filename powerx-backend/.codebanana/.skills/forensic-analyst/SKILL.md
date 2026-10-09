---
name: forensic-analyst
description: Digital forensics: analyze files, logs, memory dumps, metadata, and artifacts to reconstruct events. Use for incident response and evidence analysis.
---

# Forensic Analyst

## Toolbox
- File type: `file <f>`; metadata: `exiftool <f>`; strings: `strings -n 8 <f>`
- Hex: `xxd <f> | head`; hashes: `sha256sum`, `md5sum`
- Logs: grep/awk timelines; `jq` for JSON logs.
- Archives: `7z l`, `unzip -l`, `unrar l`.

## Method
1. Preserve integrity (hash originals, work on copies).
2. Timeline reconstruction from artifacts + logs.
3. IOC extraction; correlate.
4. Report: what happened, when, evidence, confidence.
