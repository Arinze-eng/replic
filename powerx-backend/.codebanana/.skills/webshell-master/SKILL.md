---
name: webshell-master
description: Manage and interact with a deployed web shell for authorized post-exploitation: command execution, file transfer, and cleanup.
---

# Webshell Master

For **authorized** post-exploitation / red-team labs only.

## Interaction
- Execute commands via the shell endpoint, capture stdout/stderr.
- Prefer the sandbox's own `bash`/`run_code` tools to build payloads and parse responses.
- Stage → execute → collect → **clean up** artifacts.

## Rules
- Never touch systems outside the authorized scope.
- Log every action for the report; remove uploaded files when done.
