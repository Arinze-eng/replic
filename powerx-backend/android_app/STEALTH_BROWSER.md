# 🥷 Stealth Browser — WormGPT Agent APK

An **undetectable, super-powered in-app browser** built into the WormGPT Agent
Android app. The browser engine runs **entirely on the user's phone** (OS
WebView via `flutter_inappwebview`), so it adds **zero** load to the Render
backend — the server only handles the lightweight usage-quota check.

## What it does

A normal browser leaks your identity through many independent signals. The
Stealth Browser spoofs **all of them consistently** so no website can detect
your real location or fingerprint:

| Signal | Stealth handling |
|--------|------------------|
| **Geolocation API** | Overridden to the chosen country's lat/long |
| **🛰️ GPS Emulator** | Search ANY place / tap a live map → the browser reports that EXACT GPS spot for `getCurrentPosition` **and** continuous `watchPosition` (live tracking) — like a hardware GPS spoofer |
| **Timezone** | Spoofed to match the chosen country |
| **Language / locale** | Spoofed to match |
| **WebRTC** | Blocked (stops the #1 real-IP leak) |
| **Canvas / WebGL / Audio** | Per-session noise so the fingerprint never matches |
| **navigator.webdriver / automation** | Stripped (looks like a real human) |
| **Hardware (CPU/RAM) / Battery / Screen** | Spoofed to common values |
| **Trackers / ads** | Neutered client-side |
| **User-Agent** | Switch to any device/browser (Chrome, Safari iPhone, Googlebot…) |
| **IP country** | Optional proxy routing |

> The browser keeps IP, timezone, locale, GPS and fingerprint telling **one
> consistent story** — mismatches are what detection systems flag.

> **🛰️ GPS ≠ IP — how relocation actually works.** The GPS Emulator spoofs the
> JavaScript geolocation API (`navigator.geolocation`). But "what is my IP"
> sites do **not** read GPS — they geolocate your **exit IP**. So to change
> what those sites show you **must relocate the IP through a proxy**. The GPS
> Emulator's **"Also relocate my IP to this country"** toggle (ON by default)
> does exactly that: it fetches a live, geo-verified proxy for the selected
> country, routes the browser through it, and then runs an **end-to-end check**
> (server-side request through the proxy) to **prove the exit IP truly landed
> in that country** before you start browsing. GPS-only spoofing still works
> for sites that read `navigator.geolocation`, but only the proxy moves the IP.


## Features (90+ tools & settings)

- **Tabs** (incognito **and** 🕶️ anonymous tabs), URL/search bar, full navigation,
  swipe gestures, pull-to-refresh
- **🕶️ Anonymous mode** — open a tab that leaves NO trace: no history, no cookies
  (incognito storage), every stealth spoof forced to MAX (ultra payload), and
  cookies/cache wiped when the tab closes. "Like I was never there."
- **🕘 Browsing history** — durable, searchable history so you can see where you
  went and revisit any page (tap to reopen). Incognito/anonymous visits are
  NEVER recorded; can be disabled entirely in settings.
- **🛰️ GPS Emulator** — a dedicated "search → select → relocate" mode (modelled
  on the standalone GPS Emulator app): type any city / address / landmark (or
  **tap a live OpenStreetMap map**), pick the exact spot, then **Change my
  location**. From then on every page in the browser reports that point for both
  `getCurrentPosition` AND continuous `watchPosition` (live tracking with a tiny
  realistic jitter), `clearWatch` is honored, and the position objects are
  frozen so site code can't tell they're emulated. Optionally **also relocate
  the IP** to the selected country (auto-proxy) so IP + GPS + timezone + locale
  tell ONE story. Search & select again to instantly move.
- **Stealth & anti-detect** — 18+ spoofing toggles plus a **⚡ Ultra stealth**
  master that forces every spoof ON and adds advanced hardening: a
  toString-proxy so site code can't tell our APIs are patched, iframe
  re-injection so spoofs survive in sub-frames, navigator.permissions
  consistency, WebGL debug-renderer extension, and a believable enumerateDevices
  set. 16 location presets + custom coordinates, 8 user-agent presets + custom UA
- **User-Agent** — switch device/browser identity; the change now rebuilds the
  WebView immediately so the new UA truly applies (no stale session)
- **Privacy** — block trackers/ads (NATIVE content-blockers at the WebView layer
  + JS fallback), popups/3rd-party cookies, HTTPS-only, clear-on-exit,
  incognito-by-default, force-dark, reader mode
- **Rendering** — JS toggle, **fixed desktop mode** — toggling Desktop site now
  FULLY recreates the WebView (desktop UA + content-mode + viewport override +
  UA-Client-Hints) so sites truly render desktop instead of staying mobile,
  image loading, text zoom, search engine, custom homepage
- **Network** — REAL per-country proxy routing with live, health-checked,
  geo-verified free proxies and transparent rotation; manual proxy; DoH hint
- **🛰️ Verify my IP / location** — built-in real-vs-proxy exit-IP checker
- **⬇️ Downloads manager** — REAL-TIME streamed progress (live %/bytes bar),
  completed list, **share** any downloaded file to other apps, open-on-tap
- **🍪 Cookie EDITOR** — view / add / edit / delete, export + paste-to-import a
  session (Cookie-Editor JSON)
- **🔎 Network inspector** — captures REAL request+response traffic live (method,
  URL, headers, body, status, latency, content-type) via an injected fetch/XHR
  hook, shown in rich, clearly-separated **REQUEST** and **RESPONSE** sections
  with pretty-print + copy; **edit & REPLAY** any request and **render the
  edited response back** into the page
- **DevTools console**, **Find in page**, copy link, privacy/leak test shortcut

### Proxies that "won't die"

Free public proxies die constantly and most are HTTP-only. Instead of shipping a
stale list, the backend `GET /api/browser/proxies?country=us` pulls candidates
from several free sources on demand, **health-checks them with a real HTTPS
request through each proxy**, and returns ONLY the ones alive right now (fastest
first, 5-min cache). The app fetches this each session and routes through the
fastest live proxy; if none is alive it falls back to JS-only geo spoofing (still
strong). This is the "fetch method" so a dead proxy is transparently skipped.

**Live proxy source (June 2026 — single source of truth):**

- **ONLY — [iplocate/free-proxy-list](https://github.com/iplocate/free-proxy-list)**
  — validated **every 30 minutes**, organised **per country**
  (`countries/XX/proxies.txt`) and per protocol. The country files give an exact
  geo match for the chosen preset, so the relocation is real. The backend fetches
  the requested country file first (exact geo), tops up from the protocol-wide
  pools, prioritises Android-usable HTTP/HTTPS proxies, then geo-verifies every
  exit IP. **ALL other sources removed** (proxyscrape, TheSpeedX, proxifly,
  clarketm, geonode, monosans) — the pool is 100% iplocate.

**🌍 Supported countries (28, auto-synced).** Every selectable country maps to a
country iplocate actually ships a file for, so a chosen country always has a live
pool behind it (no dead countries — the old root cause of "I picked a country but
it never connected"). The exact set:

```
AL AZ BD BR DE EE ES FR GB HK ID IN JP KH KR MX NL PE PH PL RU SE SN SY TW TZ US VN
```

The app fetches `GET /api/browser/proxies/countries` on launch and auto-syncs its
country presets, so when iplocate adds/drops a country the picker updates without
an APK rebuild.

**🔄 Auto-rotate.** A new "Auto-rotate IP" toggle (interval 1–60 min, default 5)
proactively hops to the next live, geo-verified proxy on a timer — on top of the
existing transparent on-death rotation — so a single IP is never used too long
and a silently-degrading proxy is swapped before the user notices.

**🌍 Geo-verified for TRUE stealth.** Every live proxy's **exit IP is verified**
(ip-api.com batch) to confirm it actually resolves to the requested country
before it's offered. Verified matches are ranked first, so IP + timezone + locale
+ GPS all tell **one consistent story**. The app rotates through up to **12**
live, geo-verified proxies per session.


## Usage limits (admin-controlled)

| Tier | Sessions / day |
|------|----------------|
| **Free** | **15 / day** (resets at midnight) |
| **Basic** | Unlimited |
| **Pro / Admin** | Unlimited |

The limit is **enforced server-side** and **tunable from the admin panel** via
`/api/admin/limits` (keys `limit_browser_free`, `limit_browser_basic`) — no
redeploy needed.

## Architecture

```
Phone (APK)                              Render backend
┌────────────────────────────┐          ┌──────────────────────┐
│ Stealth Browser (WebView)  │          │ GET  /api/browser/status │
│  + StealthEngine JS        │  quota   │ POST /api/browser/use    │
│    (geo/tz/locale/WebRTC/  │ ───────► │  → tier + daily counter  │
│     canvas/webgl spoof)    │          │    in app_settings       │
└────────────────────────────┘          └──────────────────────┘
        ▲ browsing traffic NEVER touches Render (phone-side only)
```

### Files

**APK (`wormgpt-apk` branch)**
- `lib/api/browser_service.dart` — settings model, StealthEngine JS (incl. the
  GPS-Emulator-grade geolocation override), `GeoSearch` geocoder, quota client
- `lib/screens/browser_screen.dart` — the tabbed browser UI
- `lib/screens/gps_emulator_screen.dart` — 🛰️ the search-and-select GPS map UI
- `lib/screens/browser_settings_screen.dart` — the 80+ settings
- `lib/screens/browser_tools_screens.dart` — downloads / cookies / devtools
- wired into `lib/screens/tools_screen.dart`

**Backend (`evilgpt` branch)**
- `db.js` — `browserDailyLimit` / `browserTierName` / `getBrowserUseCountToday` / `saveBrowserUse`
- `server.js` — `limit_browser_free` / `limit_browser_basic` defaults +
  `/api/browser/status` & `/api/browser/use` endpoints

## Build

The APK is built by **GitHub Actions** (`.github/workflows/build-apk.yml`) on
push to `wormgpt-apk`, signed with the **persistent release keystore** (same
signature as every prior build — installs/updates stay consistent). Output is an
arm64-v8a APK published to GitHub Releases.

APK size stays **well under 60 MB** — the heavy browser engine is the OS
WebView (shipped with Android), so the Stealth Browser code adds only a few MB.
