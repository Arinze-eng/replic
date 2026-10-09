// Supabase Edge Function: pay-redirect
// ─────────────────────────────────────────────────────────────────────────────
// Flutterwave redirects the user's BROWSER here after a checkout, e.g.:
//   https://<project>.functions.supabase.co/pay-redirect?plan=basic
//      &payment_id=<id>&tx_ref=<ref>&transaction_id=<flwTxnId>&status=successful
//      &app_callback=https://hackerx-v7.onrender.com/api/payment/callback
//
// This function does NOT verify anything itself — verification is the app's job
// (it re-checks the transaction with Flutterwave's API, enforces amount /
// currency / tx_ref binding, and only THEN flips the user to active). All we do
// here is forward the browser to the app's authoritative callback, preserving
// every query param so the app can reconcile and auto-detect the payment.
//
// Why route through Supabase at all? The project's Flutterwave payment links
// are configured to redirect to this stable Supabase Functions URL. Keeping a
// thin forwarder here means the payment links never need to change even if the
// app's host URL changes — we just update APP_CALLBACK_BASE here (or rely on
// the app_callback query param the app already sends).
// ─────────────────────────────────────────────────────────────────────────────

// Fallback app callback base if the `app_callback` query param is missing.
// Override at deploy time:  supabase secrets set APP_CALLBACK_BASE=...
const DEFAULT_APP_CALLBACK =
  Deno.env.get("APP_CALLBACK_BASE") ||
  "https://hackerx-v7.onrender.com/api/payment/callback";

function htmlRedirect(target: string, message: string): Response {
  // A tiny HTML page that immediately forwards (meta + JS) — friendlier than a
  // bare 302 if any param breaks, and lets us show a "verifying…" splash.
  const safe = target.replace(/"/g, "&quot;");
  const body = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=${safe}">
<title>Verifying payment…</title>
<style>body{font-family:monospace;background:#212121;color:#00ff41;display:flex;
align-items:center;justify-content:center;height:100vh;flex-direction:column;margin:0}
.card{background:#2f2f2f;border:1px solid #424242;border-radius:16px;padding:32px;
max-width:380px;text-align:center}a{color:#10a37f}</style></head>
<body><div class="card"><div style="font-size:40px">⏳</div>
<h2 style="font-size:18px">${message}</h2>
<p style="color:#9e9e9e;font-size:13px">Redirecting… If nothing happens,
<a href="${safe}">tap here</a>.</p>
<script>location.replace("${safe}")</script></div></body></html>`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

Deno.serve((req: Request) => {
  try {
    const url = new URL(req.url);
    const q = url.searchParams;

    // Where to forward. Prefer the app_callback the app passed (so it always
    // matches the host that created the payment), else the deploy default.
    let appCallback = q.get("app_callback") || DEFAULT_APP_CALLBACK;
    // Strip any trailing slash / existing query off the base callback.
    appCallback = appCallback.split("?")[0].replace(/\/+$/, "");

    // Forward EVERY param Flutterwave + the app gave us so the app can
    // reconcile the payment (payment_id, tx_ref, transaction_id, status, plan…).
    const fwd = new URLSearchParams();
    for (const [k, v] of q.entries()) {
      if (k === "app_callback") continue; // not needed downstream
      if (v != null && v !== "") fwd.set(k, v);
    }

    const target = `${appCallback}?${fwd.toString()}`;
    return htmlRedirect(target, "Verifying your payment…");
  } catch (e) {
    // On any error, still try to get the user back to the app.
    const fallback = (Deno.env.get("APP_CALLBACK_BASE") ||
      "https://hackerx-v7.onrender.com/api/payment/callback");
    return htmlRedirect(fallback, "Returning to HackerX…");
  }
});
