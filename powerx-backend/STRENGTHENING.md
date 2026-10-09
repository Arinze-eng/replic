# STRENGTHENING — OCR multi-image + heavy coding deliberation

This change hardens two capabilities the platform is judged on, additively and
safely (light tasks and existing flows are untouched; everything is env-gated
and never throws).

## 1) OCR / multi-image understanding (read 9+ images, understand, solve)

**File:** `services/agentEngine.js` (`toolAnalyzeImage`)

Before: each attached image was analyzed in ISOLATION and returned as a pile of
per-image transcriptions. The model never saw the images *together*, so it could
not answer a question split across pages or reassemble a multi-page document.

Now:
- **Auto-scaling concurrency** for big albums — 9+ images run 5-wide (was a
  fixed 3), 5–8 run 4-wide. Override with `VISION_CONCURRENCY`.
- **Cross-image SYNTHESIS pass** (`crossSynthesize`): after every image is
  transcribed/described, the combined per-image text is fed back to the brain as
  ONE document/problem set. It reassembles pages in order, cross-references
  across images, and — if the images contain questions / past-questions / an
  exam / a task — SOLVES them with full working and a clear final answer.
- Output = `COMBINED UNDERSTANDING` (the solved/understood whole) followed by the
  raw `PER-IMAGE EXTRACTION` (nothing is ever discarded).
- Best-effort & safe: synthesis failure falls back to the full per-image report.
  Disable with `VISION_SYNTHESIS=off`; cap payload with `VISION_SYNTHESIS_MAX_CHARS`.

Document extraction (PDF/DOCX/XLSX) continues through `simpleOcr` (pure-Node,
no sandbox), verified by round-trip e2e tests.

## 2) Heavy coding abilities — deliberate mode (delay, think, self-test)

**New file:** `services/heavyTask.js`  •  **wired into:** `services/agentGraph.js`
**strengthened:** `services/qualityGate.js`

- **Heavy-task detection** (`classify`): distinguishes HEAVY engineering/coding
  work (refactors, whole-repo changes, multi-file builds, deep bug hunts, e2e,
  deploys, security) from LIGHT work (quick Q&A, one-line fixes). Light tasks
  stay fast — no interference.
- **Deliberate mode**: on a heavy task, a one-time DELIBERATION BRIEF is injected
  before the first step, steering the brain to slow down and work in disciplined
  passes: Understand → Plan → Explore (read before edit) → Implement in full →
  Think in multiple passes + PROOF-READ → Self-test (run it) → Verify → finish.
- **Finish guard** (`finishGuard`): a heavy CODING task cannot `finish` until it
  has actually (a) explored the code, (b) implemented the change, and
  (c) successfully self-tested/ran it. Bounded retry budget so it never stalls.
- **qualityGate**: coding path now also enforces **read/explore before edit** on
  fix/refactor tasks (editing a file you never read is guessing), on top of the
  existing "must run/verify" check.
- Disable the whole heavy layer with `HEAVY_MODE=off`.

## Tests (no external API keys required)

- `scripts/test-strengthen-e2e.js` — 21 checks: classification, finish guard,
  quality gate coding path, real PDF/DOCX/XLSX extraction round-trips, graph +
  engine load.  → `node scripts/test-strengthen-e2e.js`
- `scripts/test-heavy-loop-e2e.js` — integration: scripted-brain run proving the
  heavy loop rejects premature `finish` until explore→implement→self-test, while
  a light task finishes immediately.  → `node scripts/test-heavy-loop-e2e.js`

Both pass; `server.js` boots clean and `/health` returns ok.

## Env flags (all optional; safe defaults)

| Flag | Default | Effect |
|------|---------|--------|
| `VISION_CONCURRENCY` | auto (3/4/5 by album size) | parallel image analysis |
| `VISION_SYNTHESIS` | on | cross-image understand/solve pass (`off` to disable) |
| `VISION_SYNTHESIS_MAX_CHARS` | 48000 | synthesis payload cap |
| `HEAVY_MODE` | on | heavy-task deliberate mode (`off` to disable) |
