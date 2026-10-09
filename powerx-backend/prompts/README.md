# prompts/ — Externalized Agent Brain

The WormGPT/EvilGPT agent's behavior is now driven by **editable files** here, not a
hard-coded string in `services/agentEngine.js`.

## Files

| File | Purpose |
|------|---------|
| `agent_system_prompt.md` | The full COMP-MODE v3 system prompt + tool protocol. Edit this to change how the agent thinks/behaves — no code change needed. Contains the `{{SKILLS_INDEX}}` placeholder. |
| `skills_index.md` | Auto-describable catalog of every skill under `.codebanana/.skills/**/SKILL.md`. Injected into the prompt at `{{SKILLS_INDEX}}` at load time. |

## How it works

1. On boot, `services/agentEngine.js` → `_loadAgentSystemPrompt()` reads
   `agent_system_prompt.md`, substitutes `{{SKILLS_INDEX}}` with `skills_index.md`,
   and uses the result as `AGENT_SYSTEM_PROMPT`. If the files are missing it falls
   back to a minimal inline prompt so the agent never boots prompt-less.

2. The **SKILL-FIRST DOCTRINE** (top of the prompt) forces the agent, at the start of
   every non-trivial task, to **`read_skill`** the matching `SKILL.md` *before* doing
   the work — so it executes with the expert method, not from raw memory.

3. Two new tools back this (host-side, defined in `agentEngine.js`):
   - `list_skills` — enumerate every available skill (name + description + path).
   - `read_skill {"path": "..."}` or `{"name": "..."}` — load a skill's full SKILL.md.
     Path access is sandboxed to `.codebanana/.skills` (traversal is blocked).

## Editing

- **Change behavior** → edit `agent_system_prompt.md`, commit, redeploy.
- **Add/remove a skill** → add/remove the folder under `.codebanana/.skills/`, then
  regenerate `skills_index.md` (a simple walk of `*/SKILL.md` reading the YAML
  front-matter `name`/`description`).

## Current skill set

28 skills (sourced from `skillultra.zip`): the 7 `skills/` design skills
(ui-ux-pro-max, ui-styling, design, design-system, brand, banner-design, slides)
and the `agents/` skills (developing-with-streamlit + its sub-skills, research,
research-and-write, write-post).
