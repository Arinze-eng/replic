---
name: output-verifier
description: Meta-skill: objectively verify the final artifact exists, is complete, and meets the request before finishing (file present, non-empty, correct format).
---

# Output Verifier

Before `finish`:
- `list_files` / `read_file` the deliverable → it exists and is non-empty.
- Format matches the request (PDF opens, code runs, report has all sections).
- No raw error text, no placeholder "TODO", no split fragments.
- If verification fails, go back and fix — do not finish.
