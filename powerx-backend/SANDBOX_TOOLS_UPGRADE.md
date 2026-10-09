# SANDBOX_TOOLS_UPGRADE.md — In-sandbox tool + document upgrades

This round fixes the four issues reported for the WormGPT autonomous agent, all
in the **in-sandbox worker** (`agent_worker/agent.py`) and the pure-python PDF
engine (`agent_worker/latex_render.py`). Every change is validated by an offline
E2E suite: `npm run test:sandbox-tools` (no sandbox / API keys needed).

## 1 & 4 — The 50+ tools now REALLY work inside the sandbox

**Root cause:** the enterprise tool registry (`tool_registry.py` + the 17 tools
under `agent_worker/tools/`) was uploaded into every sandbox by
`sandboxAgent.js`, **but `agent.py` never imported or used it**. Worse, tools
like `grep`, `bash`, `read`, `write`, `edit`, `glob`, `gitclone`, `gitdiff`,
`sql`, `webshell`, `todo`, `http`, `coding` were listed in `HOST_TOOLS` — so
when the agent called `grep`/`cat`/`bash`, the worker **proxied them back to the
Render host** and ran them against the HOST filesystem, which does not contain
the sandbox's files. That is exactly why "the tools didn't work in the sandbox."

**Fix (`agent.py`):**
- Import `tool_registry` and lazily build a `ToolRegistry` bound to the sandbox
  `WORK` dir (`_get_local_registry()`).
- New `LOCAL_REGISTRY_TOOLS` map + `_run_registry_tool()` dispatcher so those 17
  tools now execute **locally inside the sandbox**, on the sandbox's own files.
- Removed the locally-runnable tools from `HOST_TOOLS` (document/OCR tools and
  the `deepseek` LLM call stay host-side because they need host libraries).
- Files a registry tool writes are auto-captured for delivery (snapshot diff).
- **Boot self-test:** on startup the worker logs the discovered tools and runs a
  `write→grep→bash` smoke test, printing `tool self-test: PASSED ✅` to
  `worker.log` — so you can PROVE the tools are alive in each sandbox (Novita,
  Daytona, CodeSandbox, Runloop, HopX, LocalAlpine — all use the same worker).

The existing robust dependency installer (`_ensure_pkg` ladder: pip → apt → npm
with import/CLI verification) and the background office/OCR/cyber pre-warm
(`sandboxAgent.prewarmTools`) remain — so packages install without errors and
long commands run (900s per-step ceiling, 3h task ceiling).

## 2 — Coding quality (understand → structure → test → verify)

The host system prompt (`prompts/agent_system_prompt.md`) already enforces the
senior-engineer loop (Understand → Plan → write-in-full → run/verify → fix). We
added explicit guidance that the file/shell/git tools now run **locally** and
that `coding` + `bash` + `run_code` should be used to build, run and TEST code
in the sandbox before finishing. The `quality_gate.py` correctness gate still
bounces a "finish" on a coding task that has no successful test/build evidence.

## 3 — One document, not split; and no raw LaTeX

**Consolidation (new `consolidate` tool in `agent.py`):** merges split chunk
files (chapter1.md, part2.md, …) into ONE document — auto-discovering the chunk
set and sorting it naturally (chapter2 before chapter10), or taking an explicit
ordered `sources` list. If `output` ends in `.pdf` it renders straight to a
validated PDF; otherwise one merged `.md`. It de-queues the individual chunks so
the user receives ONE clean file, never a pile of fragments. Aliases:
`merge_docs`, `combine`, `merge_files`. The system prompt now instructs the
model to consolidate instead of splitting.

**Raw-LaTeX fix (`latex_render.py`):** the engine tried `pdflatex` first and
fell back to the pure-python renderer. On sandboxes with a partial/broken TeX
install, pdflatex could emit the raw source (`\int \frac{...}`) into the PDF.
Now:
- `LATEX_FORCE_PURE=1` forces the always-available pure-python renderer (which
  typesets math into real vector primitives — verified to leak NO raw LaTeX).
- `_run_pdflatex` inspects the compile log and REJECTS a compile that reported a
  fatal LaTeX error, so it cleanly falls back to the pure-python renderer instead
  of shipping garbled output.

## Tests

- `npm run test:sandbox-tools` → offline E2E (this round): registry tools run
  locally (write/bash/grep/glob/read), consolidate merges + de-queues chunks,
  and the PDF renderer leaks no raw LaTeX. ALL PASSED ✅.
- `npm run test:latex-pdf` → existing LaTeX/PDF E2E still passes.
