# BRAIN — HotBot (GPT-5) is the brain, Gemini is the image/vision fallback

This doc describes `services/brain.js` and the `/api/brain` HTTP endpoint.
It is the canonical implementation of the **"HotBot (GPT-5) is the brain,
Gemini is the fallback / pure-picture vision engine"** architecture.

## Precise image editing (FLUX.2)

The `edit_image` tool now does **precise, instruction-based editing** for free
via **FLUX.2 [dev]** on Cloudflare Workers AI
(`@cf/black-forest-labs/flux-2-dev`, `services/cloudflare.js → editImageFlux2()`).

This is the engine that powers requests like *"change the name BECKY to DAVID"*,
*"remove the person on the left"* or *"swap the red shirt for a blue one"* — it
makes a **localized** change while keeping the rest of the image (layout, fonts,
faces, logos, colors, background) identical. Unlike the old SD-1.5 img2img
engine (a global denoiser that mangled text and faces), FLUX.2 preserves the
untouched regions and renders text far more accurately.

Engine fallback chain for `edit_image` (`services/manusTools.js → toolEditImage`):

1. **Cloudflare FLUX.2 [dev]** — free, precise (DEFAULT). Override the slug with
   `CF_FLUX2_EDIT_MODEL` (e.g. `@cf/black-forest-labs/flux-2-klein-9b` for a
   faster 4-step distilled variant).
2. **Cloudflare SD-1.5 img2img** — free, lower-fidelity restyle fallback.
3. **Replicate FLUX-Kontext** — paid, only if `REPLICATE_API_TOKEN` is set.

API specifics (verified live against Workers AI): FLUX.2 takes
`multipart/form-data` with `prompt`, `input_image_0..3` (binary, each ≤512×512),
`steps`, `guidance`, `width`, `height`, `seed`, and returns
`{ result: { image: <base64> } }`. The source image is auto-resized to ≤512px
and the output keeps the source aspect ratio (long side 1024px). A preservation
prompt wrapper is appended automatically (disable with `{"raw":true}`).

## The brain (text)

The MAIN BRAIN is **HotBot (GPT-5)** served by **HotBot.com** (no API key):

1. **HotBot (GPT-5)** — `services/hotbot.js` -> `hotbotReal.chat()`. The frontier
   model that understands the task, reasons, and writes the answer. It also
   drives the autonomous agent loop (`services/agentEngine.js`): plan -> think ->
   call tools -> reflect -> finish.
2. **Gemini gateway** — automatic text fallback if HotBot fails, AND the
   dedicated **vision** engine for images.
3. **Cloudflare Workers AI** (`@cf/moonshotai/kimi-k2.7-code`) — last-resort
   text safety net so the brain never goes fully offline.

`AGENT_SOLO=hotbot|gemini|cloudflare|deepseek` forces a single brain.
`HOTBOT_SOLO=hotbot|gemini` forces the chat-race brain.

### FUSION mode (Mixture-of-Agents) — the default quality path

For ordinary chat (everything that is **not** the agent's strict-JSON ReAct
loop), `services/hotbot.js → chatWithMeta()` now defaults to **FUSION mode**, a
Mixture-of-Agents pipeline that delivers Claude-Opus-class answers without any
paid frontier API:

1. **Proposers (parallel).** Several independent keyless brains draft an answer
   at the same time — HotBot (GPT-5), the Gemini gateway, and the keyless text
   brains (Unitool, StudentAI, Pollinations, eqing). Each candidate is tagged
   with the brain that produced it.
2. **Aggregator (synthesiser).** The strongest available brain — HotBot (GPT-5),
   falling back to Gemini — reads **all** the candidates, independently verifies
   every claim/calculation, keeps the strongest reasoning and most complete
   coverage from each, fixes mistakes, fills gaps, and writes **one** final
   answer. It never reveals that multiple drafts existed. The synthesiser is
   **retried with jittered backoff** (`FUSION_SYNTH_RETRIES`) so a transient
   HotBot `403` / `rate_limit_guest` blip never silently collapses the answer to
   a weaker fallback brain.
3. **Verify / refine pass (hard questions).** For math / multi-step reasoning /
   coding / analysis prompts, after synthesis the strongest brain runs ONE quick
   critique-and-refine pass: it re-derives every calculation, hunts for errors
   and gaps, fixes them, and tightens the answer — the "think, then double-check
   before you answer" behaviour that separates Opus-class output from a single
   forward pass. Trivial chat skips this and stays fast. The pass is time-boxed
   (`FUSION_VERIFY_MS`) and any failure keeps the un-refined synthesis. When it
   runs, the brain tag gains a `+verify` marker (e.g.
   `fusion[hotbot+verify:hotbot+gemini+studentai]`).
4. **Adaptive panel.** Hard questions wait for one extra strong draft
   (`FUSION_ENOUGH_HARD`, default 4) before synthesising; easy questions use the
   normal panel (`FUSION_ENOUGH`, default 3). Proposers launch with a tiny
   stagger (`FUSION_PROPOSER_STAGGER_MS`) to avoid tripping per-IP rate limits.
5. **Graceful fallback.** If synthesis fails it ships the best single candidate;
   if no candidate succeeds it falls back to the Gemini safety net.

The reported `brain` becomes e.g. `fusion[hotbot+verify:hotbot+gemini+studentai]`
so you can see which brains proposed, which one synthesised, and whether the
verify pass ran.

Controls:
- `FUSION_MODE=0` disables fusion (falls back to persistence single-brain).
- `FUSION_MIN_CANDIDATES` (default 2) — below this, ship the best single answer.
- `FUSION_PROPOSER_MS` (default 28000) / `FUSION_AGG_MS` (default 18000) budgets.
- `FUSION_VERIFY=1` (default on) / `FUSION_VERIFY_MS` (default 8000) — the
  hard-question verify/refine pass and its time budget.
- `FUSION_SYNTH_RETRIES` (default 1) — synthesiser retries on transient 403s.
- `FUSION_ENOUGH` (3) / `FUSION_ENOUGH_HARD` (4) — proposer panel size.
- `FUSION_PROPOSER_STAGGER_MS` (250) — stagger between parallel proposers.
- Budgets are tuned so the full hard path (proposers → synth → verify ≈ 28+18+8s)
  fits inside Render's ~50s free-tier HTTP gateway; with early exits it is
  usually far faster (~10-25s observed).
- Fusion auto-disables when `HOTBOT_SPEED=1`, `HOTBOT_SOLO` is set, or for the
  agent's `_agentLoop` JSON path (which must stay single-brain GPT-5).

### LONG-FORM mode (big writing tasks — never shortened, never skipped)

The single biggest quality complaint was that FUSION would **shorten** big
writing deliverables (a 20-page story, a full multi-chapter book, a long essay)
and **skip parts** when many questions were asked at once — because the
aggregator "merges" candidates and the verify pass "removes padding", both of
which collapse a long deliverable into a summary. When the pipeline detects a
**long-form / multi-part** request it switches to a COMPLETION-FIRST strategy
(`services/hotbot.js → isLongFormWrite()`):

1. **Detection.** Triggers on writing verbs + a long-form noun
   (write/compose a story/novel/chapter/essay/report/script/…), explicit length
   targets ("20 pages", "5 chapters", "2000 words"), completeness phrasing
   ("answer ALL questions", "do not summarise", "in full", "the whole story"),
   or many numbered/bulleted sub-questions (≥4).
2. **Bypasses the single-brain Sakana head** and goes straight to FUSION, which
   is the only path with the length-preserving synthesis + continuation loop.
3. **Length-PRESERVING synthesis.** The aggregator uses a dedicated long-form
   system prompt: deliver the ENTIRE thing, never summarise/abbreviate, honour
   the exact number of chapters/pages/sections and EVERY sub-question, and be at
   least as long as the longest candidate (expand, don't compress). Best-single
   selection prefers the **most complete (longest)** draft over brain rank.
4. **Expand-only verify pass.** The verify reviewer only fixes errors and fills
   gaps — it must never shorten. A safety net rejects any verify result that
   comes back <85% of the draft length (that would mean it summarised).
5. **Bounded continuation loop.** If the deliverable still looks cut off
   (`looksTruncated()`) or is under `FUSION_LONGFORM_MIN_CHARS`, the winning
   brain is asked to CONTINUE exactly where it stopped and the continuation is
   appended — repeated up to `FUSION_CONTINUE_MAX` times — so a big story
   actually finishes end-to-end instead of stopping mid-chapter.
6. **Bigger budgets** so a long stream isn't chopped by a timeout.

All of this is env-gated and backward-compatible — normal short chat is
unchanged.

Long-form controls (all optional, safe defaults):
- `FUSION_LONGFORM=1` (DEFAULT) — enable long-form completion mode; `0` disables.
- `FUSION_LONGFORM_PROPOSER_MS` (110000) / `FUSION_LONGFORM_AGG_MS` (120000) /
  `FUSION_LONGFORM_VERIFY_MS` (90000) — expanded time budgets for big writing.
- `FUSION_CONTINUE_MAX` (4) — max continuation passes for one deliverable.
- `FUSION_CONTINUE_MS` (110000) — per-continuation time budget.
- `FUSION_LONGFORM_MIN_CHARS` (2500) — treat shorter output as "not yet done".

The reported `brain` tag gains a `+longform` marker (e.g.
`fusion[hotbot+verify+longform:hotbot+gemini+studentai]`) when this path runs.

### Why HotBot first?


HotBot (GPT-5) is a frontier reasoning + tool-use model: it follows the strict
ReAct JSON protocol, reads the skill library, plans deliberately and self-tests
its work — exactly the "thinking, understanding, tool-using" behaviour the
system prompt demands. Gemini and Cloudflare are kept as resilient fallbacks so
a single provider outage (e.g. Cloudflare free-tier neuron exhaustion) never
takes the brain down.

## Files -> text -> brain (the analyser)

The analyser converts every attached file to TEXT and hands it to HotBot:

- **Plain text** -> straight to HotBot.
- **PDF / DOCX / XLSX / TXT** -> extracted to text (pdf-parse / mammoth / xlsx /
  utf-8) -> text given to HotBot as CONTEXT.
- **Image (any)** -> Gemini vision is the analyser: it TRANSCRIBES any visible
  text verbatim AND describes the picture; that text becomes CONTEXT HotBot
  reasons over and writes the answer from.
- **Pure picture** -> Gemini vision (per spec); the description is fed to HotBot.

If text extraction fails on an image/PDF/DOCX, the request falls back to Gemini
vision (for images) so the user still gets an answer.

### Extraction engines

| Source           | Primary               | Fallback                     |
|------------------|-----------------------|------------------------------|
| PDF              | pdf-parse (digital)   | OmniOCR / simpleOcr          |
| DOCX             | mammoth               | OmniOCR / simpleOcr          |
| XLSX/CSV         | xlsx                  | OmniOCR / simpleOcr          |
| TXT/MD/etc       | UTF-8                 | —                            |
| Image w/ text    | Gemini vision         | (transcribes verbatim)       |
| Pure image       | Gemini vision         | —                            |

The extracted text is always handed to **HotBot** (the brain) — only pure
pictures / image fallbacks are handled by **Gemini**.

## HTTP

### POST /api/brain

```bash
curl -X POST https://hackerx-v7.onrender.com/api/brain \
  -H 'Content-Type: application/json' \
  -d '{
    "message": "Who is the author and what is the budget?",
    "files": [ { "name": "memo.docx", "data_base64": "<base64 bytes>" } ]
  }'
```

Response:
```jsonc
{
  "ok": true,
  "reply": "Author: Arinze. Budget: 12,500,000 NGN.",
  "brain": "hotbot",
  "extractedChars": 215,
  "used": [ { "name": "memo.docx", "kind": "doc", "engine": "mammoth", "sentToVision": false } ]
}
```

### POST /v1/chat/completions  (OpenAI-compat)

Set `model: "deepseek"` / `"brain"` (or any name starting with `deepseek`) to
route through this pipeline. The reported `model` reflects the brain that
actually answered (e.g. `hotbot-gpt-5 (hotbot)`).

## Verification

```bash
node scripts/test-hotbot-primary-e2e.js   # HotBot-primary architecture
node scripts/test-cf-brain-e2e.js         # Cloudflare last-resort fallback
node scripts/test-brain-pipeline.js       # full file -> text -> brain pipeline
```

`test-hotbot-primary-e2e.js` runs the full regression: a live GPT-5 text reply,
the agent-loop JSON brain, a DOCX extracted-to-text-then-answered-by-HotBot
case, and a pure-picture -> Gemini vision route. Passing means HotBot is the
brain, files are read as text and fed to it, and Gemini correctly handles pure
pictures.
