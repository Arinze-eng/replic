// Supabase Edge Function: ai-fallback
// ─────────────────────────────────────────────────────────────────────────────
// 🛟 RESILIENCE FALLBACK for the WormGPT / HackerX Flutter app.
//
// The main brain (HotBot → Gemini → Pollinations cascade, Capy sandbox, tools)
// lives in the Node monolith on Render (branch `evilgpt`). On Render's FREE tier
// the dyno is suspended after ~15 min idle, so the first request after a nap
// eats a ~30–50s cold start — the Flutter user feels the app "hang".
//
// This Edge Function runs on Supabase's always-on infra (independent of Render)
// and answers a plain CHAT turn directly, using the SAME keyless upstreams the
// Node app already trusts:
//     1) Gemini gateway  (huymq-it.workers.dev, hardcoded Bearer — keyless)
//     2) Pollinations     (text.pollinations.ai/openai — keyless)
// so when Render is asleep/5xx/timing-out, the app transparently falls over here
// and the user STILL gets an instant answer. No API key or secret is required.
//
// ⚠️ SCOPE (intentional): this is a CHAT fallback ONLY. Heavy agent work —
// the Capy sandbox, code execution, file generation, browsing, OCR — stays on
// Render (it cannot run in a short-lived edge function). For those, the app
// still waits for / wakes Render. This function keeps the *conversational*
// experience alive during a spin-down, which is what users feel most.
//
// Request  (POST, application/json):
//   { "message": "hello", "history"?: [{role, content}], "uncensored"?: bool,
//     "system"?: "…custom system prompt…" }
// Response (200, application/json):
//   { "message": "…", "reply": "…", "brain": "gemini|pollinations",
//     "source": "supabase-fallback" }
//   On total upstream failure → 503 { "error": "…", "source": "supabase-fallback" }
//
// Deploy:  supabase functions deploy ai-fallback --no-verify-jwt
// (No secrets needed. Optional overrides via `supabase secrets set`:
//    GEMINI_GATEWAY_URL, GEMINI_GATEWAY_AUTH, POLLINATIONS_TEXT_BASE,
//    POLLINATIONS_TEXT_MODEL, AI_FALLBACK_SYSTEM.)
// ─────────────────────────────────────────────────────────────────────────────

const GEMINI_URL =
  Deno.env.get("GEMINI_GATEWAY_URL") ||
  "https://gemini-gateway.huymq-it.workers.dev/api/generate";
const GEMINI_AUTH = Deno.env.get("GEMINI_GATEWAY_AUTH") || "Bearer 12345678";

const POLL_BASE =
  Deno.env.get("POLLINATIONS_TEXT_BASE") || "https://text.pollinations.ai";
const POLL_MODEL = Deno.env.get("POLLINATIONS_TEXT_MODEL") || "openai";

// Kept short & neutral; the app's own persona/system prompt still governs the
// primary (Render) path. This is only used when the app doesn't pass one.
const DEFAULT_SYSTEM =
  Deno.env.get("AI_FALLBACK_SYSTEM") ||
  "You are WormGPT — a helpful, direct, expert AI assistant. Answer completely and concisely.";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}

// Build an OpenAI-style messages array from message + optional history + system.
function buildMessages(
  message: string,
  history: Array<{ role: string; content: string }> | undefined,
  system: string,
) {
  const msgs: Array<{ role: string; content: string }> = [];
  if (system) msgs.push({ role: "system", content: system });
  if (Array.isArray(history)) {
    for (const h of history.slice(-10)) {
      if (h && h.content && (h.role === "user" || h.role === "assistant")) {
        msgs.push({ role: h.role, content: String(h.content).slice(0, 6000) });
      }
    }
  }
  msgs.push({ role: "user", content: message });
  return msgs;
}

// Flatten messages to a single prompt (Gemini gateway takes a `prompt` string).
function flatten(msgs: Array<{ role: string; content: string }>): string {
  return msgs
    .map((m) =>
      m.role === "system"
        ? `[System]\n${m.content}`
        : m.role === "assistant"
        ? `Assistant: ${m.content}`
        : `User: ${m.content}`
    )
    .join("\n\n") + "\n\nAssistant:";
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  const ctrl = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error("timeout")), ms)
  );
  return await Promise.race([p, ctrl]) as T;
}

// ── Upstream 1: Gemini gateway (keyless) ─────────────────────────────────────
async function askGemini(msgs: Array<{ role: string; content: string }>) {
  const prompt = flatten(msgs);
  const resp = await withTimeout(
    fetch(GEMINI_URL, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: GEMINI_AUTH },
      body: JSON.stringify({ prompt }),
    }),
    30000,
  );
  if (!resp.ok) throw new Error(`gemini ${resp.status}`);
  const data = await resp.json().catch(() => null);
  // The gateway returns { response|text|message|... } shapes; be liberal.
  const reply =
    (data && (data.response || data.text || data.message || data.reply ||
      data.output || (data.candidates?.[0]?.content?.parts?.[0]?.text))) || "";
  const s = String(reply || "").trim();
  if (!s) throw new Error("gemini empty");
  return s;
}

// ── Upstream 2: Pollinations OpenAI-compatible (keyless) ─────────────────────
async function askPollinations(msgs: Array<{ role: string; content: string }>) {
  const resp = await withTimeout(
    fetch(`${POLL_BASE}/openai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: POLL_MODEL, messages: msgs }),
    }),
    30000,
  );
  if (!resp.ok) throw new Error(`pollinations ${resp.status}`);
  const data = await resp.json().catch(() => null);
  const reply = data?.choices?.[0]?.message?.content || "";
  const s = String(reply || "").trim();
  if (!s) throw new Error("pollinations empty");
  return s;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") {
    // Lightweight health probe so an external monitor can confirm the fallback
    // is alive independently of Render.
    return json({ ok: true, service: "ai-fallback", source: "supabase-fallback" });
  }
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let payload: any = {};
  try { payload = await req.json(); } catch (_) { payload = {}; }

  const message = String(payload.message || payload.prompt || "").trim();
  if (!message) return json({ error: "message is required", source: "supabase-fallback" }, 400);

  const system = String(payload.system || DEFAULT_SYSTEM);
  const msgs = buildMessages(message, payload.history, system);

  // Try Gemini first (matches the Node cascade order), then Pollinations.
  const errors: string[] = [];
  try {
    const reply = await askGemini(msgs);
    return json({ message: reply, reply, brain: "gemini", source: "supabase-fallback" });
  } catch (e) { errors.push("gemini: " + (e as Error).message); }

  try {
    const reply = await askPollinations(msgs);
    return json({ message: reply, reply, brain: "pollinations", source: "supabase-fallback" });
  } catch (e) { errors.push("pollinations: " + (e as Error).message); }

  return json(
    {
      error:
        "The fallback AI is temporarily unavailable. Please try again in a moment.",
      detail: errors.join(" | "),
      source: "supabase-fallback",
    },
    503,
  );
});
