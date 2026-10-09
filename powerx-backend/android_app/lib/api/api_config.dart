// API configuration for the WormGPT Agent app.
// Points at the already-deployed HackerX backend (Render).
class ApiConfig {
  // Base URL of the live backend. Override at build time with:
  //   flutter build apk --dart-define=API_BASE=https://your-host
  static const String baseUrl = String.fromEnvironment(
    'API_BASE',
    defaultValue: 'https://hackerx-v7-d5s4.onrender.com',
  );

  // 🛟 Always-on Supabase Edge Function CHAT fallback. Render's free tier
  // suspends the dyno after ~15 min idle, so the first request after a nap eats
  // a ~30–50s cold start. This Supabase function (independent of Render) answers
  // a plain chat turn via the same keyless upstreams, so the app can fall over
  // to it the moment Render is slow/down and the user still gets an instant
  // reply. Override at build time with:
  //   --dart-define=SUPABASE_FALLBACK_URL=https://<ref>.supabase.co/functions/v1/ai-fallback
  // Empty string disables the fallback entirely.
  static const String supabaseFallbackUrl = String.fromEnvironment(
    'SUPABASE_FALLBACK_URL',
    defaultValue:
        'https://hmlbprleoohibdwktdoz.supabase.co/functions/v1/ai-fallback',
  );

  // Anon key for the Supabase project (safe to embed — it is the PUBLIC anon
  // key, not the service key). Sent as the apikey/Authorization header the
  // Supabase gateway expects. Override with --dart-define=SUPABASE_ANON_KEY=...
  static const String supabaseAnonKey = String.fromEnvironment(
    'SUPABASE_ANON_KEY',
    defaultValue: '',
  );

  // Auth
  static const String signup = '/api/auth/signup';
  static const String login = '/api/auth/login';
  static const String me = '/api/auth/me';

  // AI
  static const String chat = '/api/chat';          // HotBot / GPT-5
  static const String wormgptChat = '/api/wormgpt/chat'; // uncensored
  static const String agentRun = '/api/agent/run';  // SSE — sandbox-synced
  // 🦫 Capy health/config — reports the ADMIN-SETTABLE long-poll ceiling
  // (pollCeilingSeconds). The app reads this so its stream timeout tracks the
  // admin's chosen Capy timeout with NO further APK rebuild.
  static const String capyConfig = '/api/capy';
  // 🔥 WormGPT Ultra V🔥🔥 — launch gate for the external capy-agent web app.
  //   POST launch consumes one use (limited tiers) & returns the agent URL.
  //   GET  status reports the remaining quota without consuming a use.
  static const String ultraLaunch = '/api/ultra/launch';
  static const String ultraStatus = '/api/ultra/status';

  // 🌐 Stealth Browser quota (Free 15/day · Basic/Pro unlimited). Admin-tunable.
  //   GET  /api/browser/status → remaining quota WITHOUT consuming a session.
  //   POST /api/browser/use    → consumes ONE session (Free tier) & returns quota.
  static const String browserStatus = '/api/browser/status';
  static const String browserUse = '/api/browser/use';
  // 🌍 Live free-proxy pool (per country) — server fetches + health-checks free
  //   proxies on demand and returns only the ones alive RIGHT NOW (fastest first),
  //   so the in-app browser can route traffic through a real foreign IP without
  //   shipping a stale list. GET /api/browser/proxies?country=us&limit=8
  static const String browserProxies = '/api/browser/proxies';
  // 🛰️ Exit-IP verifier — GET /api/browser/myip[?host=&port=&proto=]
  //   No params → the phone's REAL exit IP + geo (what sites see now).
  //   With proxy params → server routes a test through that proxy and returns the
  //   resulting exit IP + country, so the user can SEE their location changed.
  static const String browserMyIp = '/api/browser/myip';
  // Live list of countries the proxy pool supports (iplocate). The app fetches
  // this on launch to auto-sync its country presets — no rebuild needed when
  // iplocate adds/drops a country.
  static const String browserProxiesCountries = '/api/browser/proxies/countries';
  // Legacy Lemon endpoint constant — the local Lemon agent was removed and
  // replaced by WormGPT Ultra (external WebView). Kept only so existing scope
  // checks compile; it is no longer hit by any active code path.
  static const String lemonRun = '/api/lemon/run';
  static const String evilgptStatus = '/api/evilgpt/status';

  // Payments (Flutterwave — Free / Basic / Pro)
  static const String paymentCreate = '/api/payment/create';
  static const String paymentRequery = '/api/payment/requery';
  static const String paymentConfirm = '/api/payment/confirm';

  // 🎟️ Pay-as-you-go (single shared Flutterwave link, server-verified):
  //   GET /api/payg/products → catalog (id, kind, amount, label, days/credits)
  //   GET /api/payg/status   → the current user's active feature passes
  // Buying a product reuses paymentCreate with plan = the product id.
  static const String paygProducts = '/api/payg/products';
  static const String paygStatus = '/api/payg/status';

  // APK chat history (Supabase-persisted, auto-wipes after 2 days). Used so
  // conversations survive the app being closed/reopened.
  static const String apkChatHistory = '/api/apk/chat-history';

  static Uri uri(String path) => Uri.parse('$baseUrl$path');
}
