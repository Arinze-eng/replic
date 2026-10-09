# LangGraph Agent Core

The WormGPT Agent's autonomous loop runs on a **[LangGraph](https://langchain-ai.github.io/langgraphjs/) `StateGraph`** (`@langchain/langgraph`).

## Architecture

```
                ┌───────────────────────────────────────┐
                │                                         ▼
   START ──▶ agent ──(routeAfterAgent)──▶ tools ──▶ (back to agent)
                 │
                 └──(finish / final answer / brain error)──▶ END
```

| Node    | File / fn                       | Responsibility |
|---------|---------------------------------|----------------|
| `agent` | `services/agentGraph.js` `agentNode` | Calls the AI brain (`geminiComplete` — GPT-5 HotBot + Gemini gateway race), parses the JSON action via `parseAction`, decides tool-vs-finish. |
| `tools` | `services/agentGraph.js` `toolsNode` | Runs the chosen tool through `executeTool()` inside the **Daytona** sandbox (Runloop/HopX/Novita/local fallback), appends the `OBSERVATION` back into state. |
| edge    | `routeAfterAgent`               | Conditional: `finish`/final answer/error → `END`; otherwise → `tools`. |

State is a typed `Annotation.Root` with channels: `conversation` (append-only transcript), `pendingAction`, `finalMessage`, `step`, `done`. The old `MAX_STEPS=80` budget is enforced as the graph **recursion limit** (`MAX_STEPS*2 + 4`).

## Why a graph?

The previous engine was a hand-rolled `for` loop. The LangGraph version makes the control-flow **explicit, inspectable, and extensible** (easy to add planner/critic/parallel nodes later) while preserving the exact public contract:

```js
runAgent({ task, onStep, history, sessionKey, attachments })
  → { message, files, steps, workdir }
```

All callers (Telegram / WhatsApp / web UI in `server.js`) are unchanged. Every existing tool and sandbox backend is reused as-is.

## Tests

```bash
npm test            # deterministic control-flow tests (no network)
LIVE=1 npm test     # + real end-to-end run against the AI brain + Daytona sandbox
```

The live test verifies the agent plans, runs Python in the Daytona sandbox, produces a file, and returns it as a deliverable.

## Files

- `services/agentGraph.js` — the LangGraph state machine (new)
- `services/agentEngine.js` — `runAgent()` now delegates its loop to the graph; holds the shared `executeTool()` + all tool implementations
- `scripts/test-langgraph.js` — control-flow + live e2e tests
