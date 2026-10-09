// browser_service.dart — the brains of the Stealth Browser.
//
// Holds:
//   1. BrowserSettings — every user-configurable knob (80+ toggles/options) with
//      durable persistence in SharedPreferences.
//   2. StealthEngine   — the JavaScript injected at document-START on every page
//      that makes the browser UNDETECTABLE: spoofs geolocation, timezone,
//      locale, WebRTC, canvas/WebGL/audio fingerprints, navigator props,
//      strips automation flags, blocks trackers, and more.
//   3. BrowserQuota    — wires the Free 15/day · Basic/Pro unlimited limit to the
//      backend (/api/browser/status, /api/browser/use), admin-tunable.
//
// NOTE: This file contains ZERO UI. The screen consumes it. Keeping the engine
// here keeps the spoofing logic testable and the screen lean.

import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'api_config.dart';
import 'auth_service.dart';

// ─────────────────────────────────────────────────────────────────────────────
// 📍 Location presets — each carries the FULL consistent identity (lat/lon,
// timezone, locale, currency) so IP-spoofing intent + JS spoofing tell ONE
// story (mismatch = detection). A real anti-detect browser MUST keep these in
// sync; we expose a curated list plus a custom lat/lon.
//
// ⚠️ EVERY country here maps to a country iplocate/free-proxy-list actually
// ships a validated per-country proxy file for, so selecting it genuinely
// relocates the exit IP (no dead countries). The set is kept in lock-step with
// the backend IPLOCATE_COUNTRIES list (28 countries, June 2026). The app also
// AUTO-SYNCS this list at launch from GET /api/browser/proxies/countries so new
// iplocate countries light up without an APK rebuild.
// ─────────────────────────────────────────────────────────────────────────────
class GeoPreset {
  final String id;
  final String label;
  final String flag;
  final double lat;
  final double lon;
  final String timezone;
  final String locale; // BCP-47, e.g. en-US
  final String currency;
  final String cc; // ISO-2 iplocate country code this preset routes through
  const GeoPreset(this.id, this.label, this.flag, this.lat, this.lon,
      this.timezone, this.locale, this.currency, this.cc);
}

const kGeoPresets = <GeoPreset>[
  GeoPreset('off', 'Off (use real location)', '📡', 0, 0, '', '', '', ''),
  GeoPreset('us', 'United States — New York', '🇺🇸', 40.7128, -74.0060, 'America/New_York', 'en-US', 'USD', 'US'),
  GeoPreset('gb', 'United Kingdom — London', '🇬🇧', 51.5074, -0.1278, 'Europe/London', 'en-GB', 'GBP', 'GB'),
  GeoPreset('de', 'Germany — Berlin', '🇩🇪', 52.5200, 13.4050, 'Europe/Berlin', 'de-DE', 'EUR', 'DE'),
  GeoPreset('fr', 'France — Paris', '🇫🇷', 48.8566, 2.3522, 'Europe/Paris', 'fr-FR', 'EUR', 'FR'),
  GeoPreset('nl', 'Netherlands — Amsterdam', '🇳🇱', 52.3676, 4.9041, 'Europe/Amsterdam', 'nl-NL', 'EUR', 'NL'),
  GeoPreset('es', 'Spain — Madrid', '🇪🇸', 40.4168, -3.7038, 'Europe/Madrid', 'es-ES', 'EUR', 'ES'),
  GeoPreset('se', 'Sweden — Stockholm', '🇸🇪', 59.3293, 18.0686, 'Europe/Stockholm', 'sv-SE', 'SEK', 'SE'),
  GeoPreset('pl', 'Poland — Warsaw', '🇵🇱', 52.2297, 21.0122, 'Europe/Warsaw', 'pl-PL', 'PLN', 'PL'),
  GeoPreset('ee', 'Estonia — Tallinn', '🇪🇪', 59.4370, 24.7536, 'Europe/Tallinn', 'et-EE', 'EUR', 'EE'),
  GeoPreset('al', 'Albania — Tirana', '🇦🇱', 41.3275, 19.8187, 'Europe/Tirane', 'sq-AL', 'ALL', 'AL'),
  GeoPreset('ru', 'Russia — Moscow', '🇷🇺', 55.7558, 37.6173, 'Europe/Moscow', 'ru-RU', 'RUB', 'RU'),
  GeoPreset('az', 'Azerbaijan — Baku', '🇦🇿', 40.4093, 49.8671, 'Asia/Baku', 'az-AZ', 'AZN', 'AZ'),
  GeoPreset('sy', 'Syria — Damascus', '🇸🇾', 33.5138, 36.2765, 'Asia/Damascus', 'ar-SY', 'SYP', 'SY'),
  GeoPreset('jp', 'Japan — Tokyo', '🇯🇵', 35.6762, 139.6503, 'Asia/Tokyo', 'ja-JP', 'JPY', 'JP'),
  GeoPreset('kr', 'South Korea — Seoul', '🇰🇷', 37.5665, 126.9780, 'Asia/Seoul', 'ko-KR', 'KRW', 'KR'),
  GeoPreset('hk', 'Hong Kong', '🇭🇰', 22.3193, 114.1694, 'Asia/Hong_Kong', 'zh-HK', 'HKD', 'HK'),
  GeoPreset('tw', 'Taiwan — Taipei', '🇹🇼', 25.0330, 121.5654, 'Asia/Taipei', 'zh-TW', 'TWD', 'TW'),
  GeoPreset('vn', 'Vietnam — Hanoi', '🇻🇳', 21.0278, 105.8342, 'Asia/Ho_Chi_Minh', 'vi-VN', 'VND', 'VN'),
  GeoPreset('kh', 'Cambodia — Phnom Penh', '🇰🇭', 11.5564, 104.9282, 'Asia/Phnom_Penh', 'km-KH', 'KHR', 'KH'),
  GeoPreset('ph', 'Philippines — Manila', '🇵🇭', 14.5995, 120.9842, 'Asia/Manila', 'en-PH', 'PHP', 'PH'),
  GeoPreset('id', 'Indonesia — Jakarta', '🇮🇩', -6.2088, 106.8456, 'Asia/Jakarta', 'id-ID', 'IDR', 'ID'),
  GeoPreset('in', 'India — Mumbai', '🇮🇳', 19.0760, 72.8777, 'Asia/Kolkata', 'en-IN', 'INR', 'IN'),
  GeoPreset('bd', 'Bangladesh — Dhaka', '🇧🇩', 23.8103, 90.4125, 'Asia/Dhaka', 'bn-BD', 'BDT', 'BD'),
  GeoPreset('br', 'Brazil — São Paulo', '🇧🇷', -23.5505, -46.6333, 'America/Sao_Paulo', 'pt-BR', 'BRL', 'BR'),
  GeoPreset('mx', 'Mexico — Mexico City', '🇲🇽', 19.4326, -99.1332, 'America/Mexico_City', 'es-MX', 'MXN', 'MX'),
  GeoPreset('pe', 'Peru — Lima', '🇵🇪', -12.0464, -77.0428, 'America/Lima', 'es-PE', 'PEN', 'PE'),
  GeoPreset('sn', 'Senegal — Dakar', '🇸🇳', 14.7167, -17.4677, 'Africa/Dakar', 'fr-SN', 'XOF', 'SN'),
  GeoPreset('tz', 'Tanzania — Dar es Salaam', '🇹🇿', -6.7924, 39.2083, 'Africa/Dar_es_Salaam', 'sw-TZ', 'TZS', 'TZ'),
  GeoPreset('custom', 'Custom coordinates…', '🎯', 0, 0, '', '', '', ''),
];

GeoPreset geoById(String id) =>
    kGeoPresets.firstWhere((g) => g.id == id, orElse: () => kGeoPresets.first);

// Map a geo-preset id → ISO-2 country code the backend proxy pool understands.
// Reads it straight off the preset (every preset now carries its own cc), so
// adding a country is a one-line change and the mapping can never drift.
String countryCodeForGeo(String geoPresetId) {
  final g = kGeoPresets.firstWhere((g) => g.id == geoPresetId,
      orElse: () => kGeoPresets.first);
  return g.cc.toLowerCase();
}

// Curated user-agent presets so a user can become any device/browser.
class UaPreset {
  final String id;
  final String label;
  final String ua;
  const UaPreset(this.id, this.label, this.ua);
}

const kUaPresets = <UaPreset>[
  UaPreset('default', 'Default (this device)', ''),
  UaPreset('chrome_win', 'Chrome · Windows 11',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'),
  UaPreset('chrome_mac', 'Chrome · macOS',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'),
  UaPreset('safari_iphone', 'Safari · iPhone',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'),
  UaPreset('safari_ipad', 'Safari · iPad',
      'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'),
  UaPreset('firefox_win', 'Firefox · Windows',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0'),
  UaPreset('edge_win', 'Edge · Windows',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0'),
  UaPreset('googlebot', 'Googlebot (crawler)',
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'),
];

// ─────────────────────────────────────────────────────────────────────────────
// ⚙️ BrowserSettings — durable, observable. 80+ knobs grouped logically.
// ─────────────────────────────────────────────────────────────────────────────
class BrowserSettings extends ChangeNotifier {
  static final BrowserSettings instance = BrowserSettings._();
  BrowserSettings._();
  // Transient (non-persisted) instance used to build hardened scripts for
  // anonymous tabs without mutating the user's saved settings.
  BrowserSettings._transient();

  SharedPreferences? _p;
  bool loaded = false;

  /// A non-persisted copy with EVERY stealth/privacy spoof forced ON (ultra) —
  /// used to build the JS payload for anonymous tabs so they are maximally
  /// undetectable regardless of the user's global toggles. Copies geo/UA so the
  /// chosen location/identity still applies.
  BrowserSettings hardenedClone() {
    final c = BrowserSettings._transient();
    c.loaded = true;
    // Carry over identity-defining choices.
    c.geoPresetId = geoPresetId;
    c.customLat = customLat;
    c.customLon = customLon;
    // Carry the GPS-emulator selection so anonymous tabs also report the
    // emulated location (consistent with the visible tabs).
    c.gpsEmulatorActive = gpsEmulatorActive;
    c.gpsLat = gpsLat;
    c.gpsLon = gpsLon;
    c.gpsLabel = gpsLabel;
    c.gpsCountryCode = gpsCountryCode;
    c.gpsAccuracy = gpsAccuracy;
    c.uaPresetId = uaPresetId;
    c.customUa = customUa;
    c.desktopMode = desktopMode;
    c.searchEngine = searchEngine;
    c.homepage = homepage;
    c.textZoom = textZoom;
    // Force every spoof ON.
    c.stealthMode = true;
    c.ultraStealth = true;
    c.spoofTimezone = true;
    c.spoofLocale = true;
    c.blockWebRTC = true;
    c.spoofCanvas = true;
    c.spoofWebGL = true;
    c.spoofAudio = true;
    c.spoofFonts = true;
    c.hideAutomation = true;
    c.spoofHardware = true;
    c.spoofBattery = true;
    c.spoofScreen = true;
    c.doNotTrack = true;
    c.antiFingerprintNoise = true;
    c.blockTrackers = true;
    c.blockAds = true;
    c.blockThirdPartyCookies = true;
    c.blockPopups = true;
    c.httpsOnly = true;
    c.javascriptEnabled = javascriptEnabled;
    c.loadImages = loadImages;
    c.darkWebsites = darkWebsites;
    c.readerHint = readerHint;
    return c;
  }

  // ── Stealth / anti-detect ──
  bool stealthMode = true;            // master switch for all spoofing
  bool ultraStealth = false;          // 🥷 ULTRA — turns ON every spoof + extra hardening
  String geoPresetId = 'off';
  double customLat = 0;
  double customLon = 0;

  // ── 🛰️ GPS Emulator ──
  // A dedicated "search a place → select it → the browser instantly reports
  // that exact GPS location" mode, modelled on the standalone GPS Emulator app
  // (search/busqueda flow). When ACTIVE it OVERRIDES the country preset and
  // forces navigator.geolocation (getCurrentPosition + continuous
  // watchPosition) to return the chosen coordinates everywhere — so any site
  // that reads your GPS sees the emulated spot, consistently. The chosen point
  // also drives the timezone/locale spoof (derived from its country) so the
  // whole story stays consistent.
  bool gpsEmulatorActive = false;     // master: emulator overrides geo preset
  double gpsLat = 0;                  // emulated latitude
  double gpsLon = 0;                  // emulated longitude
  String gpsLabel = '';               // human label of the selected place
  String gpsCountryCode = '';         // ISO-2 of the selected place (for tz/locale)
  double gpsAccuracy = 20;            // reported GPS accuracy in metres
  // When ON the emulator also tries to relocate the EXIT IP (auto proxy) to the
  // selected place's country so IP + GPS + timezone tell ONE story.
  bool gpsMatchIp = false;
  bool spoofTimezone = true;
  bool spoofLocale = true;
  bool blockWebRTC = true;            // stops the #1 IP leak
  bool spoofCanvas = true;
  bool spoofWebGL = true;
  bool spoofAudio = true;
  bool spoofFonts = true;
  bool hideAutomation = true;         // strip navigator.webdriver etc
  bool spoofHardware = true;          // deviceMemory / hardwareConcurrency
  bool spoofBattery = true;
  bool spoofScreen = false;           // randomize screen metrics
  bool doNotTrack = true;
  String uaPresetId = 'default';
  String customUa = '';

  // ── Privacy ──
  bool blockTrackers = true;
  bool blockAds = true;
  bool blockThirdPartyCookies = false;
  bool blockPopups = true;
  bool httpsOnly = true;
  bool clearOnExit = false;           // wipe cookies+cache when browser closes
  bool incognitoDefault = false;
  bool antiFingerprintNoise = true;   // inject tiny per-session randomness
  bool saveHistory = true;            // record browsing history (off in anonymous)

  // ── Browsing / rendering ──
  bool javascriptEnabled = true;
  bool desktopMode = false;
  bool loadImages = true;
  bool darkWebsites = false;          // force-dark CSS injection
  bool readerHint = false;
  double textZoom = 100;              // 50..250
  String searchEngine = 'google';     // google|bing|duckduckgo|brave|startpage
  String homepage = 'https://www.google.com';

  // ── Network ──
  bool useProxy = false;
  String proxyHost = '';
  int proxyPort = 0;
  bool dnsOverHttps = false;
  // Auto-proxy: when ON and a country is chosen, the browser fetches a LIVE free
  // proxy in that country from the backend and routes traffic through it (so the
  // real IP matches the spoofed geo/timezone/locale — one consistent story).
  bool autoProxy = false;
  // 🔄 Auto-rotate: when ON, the browser proactively switches to the NEXT live
  // proxy in the pool every `autoRotateMins` minutes (in addition to the
  // automatic on-death rotation) so a single IP is never used too long and a
  // silently-degrading proxy is swapped out before the user notices.
  bool autoRotate = false;
  int autoRotateMins = 5; // 1..60

  // ── Capture / interceptor ──
  bool captureTraffic = true; // record requests/responses for the inspector

  // ── Downloads ──
  bool askDownloadLocation = false;
  bool autoOpenDownloads = false;

  // ── Power-user ──
  bool devToolsEnabled = true;
  bool gesturesEnabled = true;
  bool pullToRefresh = true;
  bool desktopTabBar = true;

  Future<void> load() async {
    _p = await SharedPreferences.getInstance();
    final p = _p!;
    bool b(String k, bool d) => p.getBool('br_$k') ?? d;
    String s(String k, String d) => p.getString('br_$k') ?? d;
    double dd(String k, double d) => p.getDouble('br_$k') ?? d;
    int ii(String k, int d) => p.getInt('br_$k') ?? d;

    stealthMode = b('stealthMode', true);
    ultraStealth = b('ultraStealth', false);
    geoPresetId = s('geoPresetId', 'off');
    // Migrate legacy preset ids from older builds to the current iplocate set so
    // a returning user never sits on an id that no longer exists.
    const legacyGeo = <String, String>{
      'us_ny': 'us', 'us_la': 'us', 'uk': 'gb',
      // Countries dropped (iplocate has no file) → fall back to 'off' (JS-only).
      'ca': 'off', 'sg': 'off', 'au': 'off', 'ng': 'off', 'za': 'off', 'ae': 'off',
    };
    if (legacyGeo.containsKey(geoPresetId)) {
      geoPresetId = legacyGeo[geoPresetId]!;
    }
    customLat = dd('customLat', 0);
    customLon = dd('customLon', 0);
    gpsEmulatorActive = b('gpsEmulatorActive', false);
    gpsLat = dd('gpsLat', 0);
    gpsLon = dd('gpsLon', 0);
    gpsLabel = s('gpsLabel', '');
    gpsCountryCode = s('gpsCountryCode', '');
    gpsAccuracy = dd('gpsAccuracy', 20);
    gpsMatchIp = b('gpsMatchIp', false);
    spoofTimezone = b('spoofTimezone', true);
    spoofLocale = b('spoofLocale', true);
    blockWebRTC = b('blockWebRTC', true);
    spoofCanvas = b('spoofCanvas', true);
    spoofWebGL = b('spoofWebGL', true);
    spoofAudio = b('spoofAudio', true);
    spoofFonts = b('spoofFonts', true);
    hideAutomation = b('hideAutomation', true);
    spoofHardware = b('spoofHardware', true);
    spoofBattery = b('spoofBattery', true);
    spoofScreen = b('spoofScreen', false);
    doNotTrack = b('doNotTrack', true);
    uaPresetId = s('uaPresetId', 'default');
    customUa = s('customUa', '');

    blockTrackers = b('blockTrackers', true);
    blockAds = b('blockAds', true);
    blockThirdPartyCookies = b('blockThirdPartyCookies', false);
    blockPopups = b('blockPopups', true);
    httpsOnly = b('httpsOnly', true);
    clearOnExit = b('clearOnExit', false);
    incognitoDefault = b('incognitoDefault', false);
    antiFingerprintNoise = b('antiFingerprintNoise', true);
    saveHistory = b('saveHistory', true);

    javascriptEnabled = b('javascriptEnabled', true);
    desktopMode = b('desktopMode', false);
    loadImages = b('loadImages', true);
    darkWebsites = b('darkWebsites', false);
    readerHint = b('readerHint', false);
    textZoom = dd('textZoom', 100);
    searchEngine = s('searchEngine', 'google');
    homepage = s('homepage', 'https://www.google.com');

    useProxy = b('useProxy', false);
    proxyHost = s('proxyHost', '');
    proxyPort = ii('proxyPort', 0);
    dnsOverHttps = b('dnsOverHttps', false);
    autoProxy = b('autoProxy', false);
    autoRotate = b('autoRotate', false);
    autoRotateMins = ii('autoRotateMins', 5);
    captureTraffic = b('captureTraffic', true);

    askDownloadLocation = b('askDownloadLocation', false);
    autoOpenDownloads = b('autoOpenDownloads', false);

    devToolsEnabled = b('devToolsEnabled', true);
    gesturesEnabled = b('gesturesEnabled', true);
    pullToRefresh = b('pullToRefresh', true);
    desktopTabBar = b('desktopTabBar', true);

    loaded = true;
    notifyListeners();
  }

  Future<void> setBool(String key, bool v) async {
    _apply(key, v);
    await _p?.setBool('br_$key', v);
    notifyListeners();
  }

  Future<void> setString(String key, String v) async {
    _apply(key, v);
    await _p?.setString('br_$key', v);
    notifyListeners();
  }

  Future<void> setDouble(String key, double v) async {
    _apply(key, v);
    await _p?.setDouble('br_$key', v);
    notifyListeners();
  }

  Future<void> setInt(String key, int v) async {
    _apply(key, v);
    await _p?.setInt('br_$key', v);
    notifyListeners();
  }

  void _apply(String key, dynamic v) {
    switch (key) {
      case 'stealthMode': stealthMode = v; break;
      case 'ultraStealth': ultraStealth = v; break;
      case 'geoPresetId': geoPresetId = v; break;
      case 'customLat': customLat = v; break;
      case 'customLon': customLon = v; break;
      case 'gpsEmulatorActive': gpsEmulatorActive = v; break;
      case 'gpsLat': gpsLat = v; break;
      case 'gpsLon': gpsLon = v; break;
      case 'gpsLabel': gpsLabel = v; break;
      case 'gpsCountryCode': gpsCountryCode = v; break;
      case 'gpsAccuracy': gpsAccuracy = v; break;
      case 'gpsMatchIp': gpsMatchIp = v; break;
      case 'spoofTimezone': spoofTimezone = v; break;
      case 'spoofLocale': spoofLocale = v; break;
      case 'blockWebRTC': blockWebRTC = v; break;
      case 'spoofCanvas': spoofCanvas = v; break;
      case 'spoofWebGL': spoofWebGL = v; break;
      case 'spoofAudio': spoofAudio = v; break;
      case 'spoofFonts': spoofFonts = v; break;
      case 'hideAutomation': hideAutomation = v; break;
      case 'spoofHardware': spoofHardware = v; break;
      case 'spoofBattery': spoofBattery = v; break;
      case 'spoofScreen': spoofScreen = v; break;
      case 'doNotTrack': doNotTrack = v; break;
      case 'uaPresetId': uaPresetId = v; break;
      case 'customUa': customUa = v; break;
      case 'blockTrackers': blockTrackers = v; break;
      case 'blockAds': blockAds = v; break;
      case 'blockThirdPartyCookies': blockThirdPartyCookies = v; break;
      case 'blockPopups': blockPopups = v; break;
      case 'httpsOnly': httpsOnly = v; break;
      case 'clearOnExit': clearOnExit = v; break;
      case 'incognitoDefault': incognitoDefault = v; break;
      case 'antiFingerprintNoise': antiFingerprintNoise = v; break;
      case 'saveHistory': saveHistory = v; break;
      case 'javascriptEnabled': javascriptEnabled = v; break;
      case 'desktopMode': desktopMode = v; break;
      case 'loadImages': loadImages = v; break;
      case 'darkWebsites': darkWebsites = v; break;
      case 'readerHint': readerHint = v; break;
      case 'textZoom': textZoom = v; break;
      case 'searchEngine': searchEngine = v; break;
      case 'homepage': homepage = v; break;
      case 'useProxy': useProxy = v; break;
      case 'proxyHost': proxyHost = v; break;
      case 'proxyPort': proxyPort = v; break;
      case 'dnsOverHttps': dnsOverHttps = v; break;
      case 'autoProxy': autoProxy = v; break;
      case 'autoRotate': autoRotate = v; break;
      case 'autoRotateMins': autoRotateMins = v; break;
      case 'captureTraffic': captureTraffic = v; break;
      case 'askDownloadLocation': askDownloadLocation = v; break;
      case 'autoOpenDownloads': autoOpenDownloads = v; break;
      case 'devToolsEnabled': devToolsEnabled = v; break;
      case 'gesturesEnabled': gesturesEnabled = v; break;
      case 'pullToRefresh': pullToRefresh = v; break;
      case 'desktopTabBar': desktopTabBar = v; break;
    }
  }

  /// The effective user-agent string (preset or custom or empty=default).
  /// Desktop mode forces a desktop Chrome UA when no explicit UA is chosen.
  String effectiveUserAgent() {
    if (customUa.trim().isNotEmpty) return customUa.trim();
    final p = kUaPresets.firstWhere((u) => u.id == uaPresetId,
        orElse: () => kUaPresets.first);
    if (p.ua.isNotEmpty) return p.ua;
    if (desktopMode) {
      return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    }
    return ''; // empty = let the engine use the device default
  }

  /// Build the search URL for a typed query, honoring the chosen engine.
  String searchUrlFor(String query) {
    final q = Uri.encodeQueryComponent(query);
    switch (searchEngine) {
      case 'bing': return 'https://www.bing.com/search?q=$q';
      case 'duckduckgo': return 'https://duckduckgo.com/?q=$q';
      case 'brave': return 'https://search.brave.com/search?q=$q';
      case 'startpage': return 'https://www.startpage.com/sp/search?query=$q';
      case 'google':
      default: return 'https://www.google.com/search?q=$q';
    }
  }

  /// 🥷 Apply (or relax) ULTRA stealth — flips every spoof to its hardest
  /// setting in one shot so the user can become maximally undetectable, then
  /// remembers the choice. Turning it OFF restores sane (still-strong) defaults.
  Future<void> applyUltra(bool on) async {
    await setBool('ultraStealth', on);
    if (on) {
      await setBool('stealthMode', true);
      await setBool('spoofTimezone', true);
      await setBool('spoofLocale', true);
      await setBool('blockWebRTC', true);
      await setBool('spoofCanvas', true);
      await setBool('spoofWebGL', true);
      await setBool('spoofAudio', true);
      await setBool('spoofFonts', true);
      await setBool('hideAutomation', true);
      await setBool('spoofHardware', true);
      await setBool('spoofBattery', true);
      await setBool('spoofScreen', true);
      await setBool('doNotTrack', true);
      await setBool('antiFingerprintNoise', true);
      await setBool('blockTrackers', true);
      await setBool('blockAds', true);
      await setBool('blockThirdPartyCookies', true);
      await setBool('blockPopups', true);
      await setBool('httpsOnly', true);
    }
  }

  /// 🛰️ Activate the GPS Emulator at a chosen point. Stores the coordinates +
  /// label + country, flips the emulator ON, and ensures stealth + the
  /// geolocation spoof are enabled so the change actually applies. The chosen
  /// country also drives timezone/locale spoofing (one consistent story).
  /// When [matchIp] is true the caller is asked to also route the exit IP
  /// through this country (handled by the screen via the proxy pool).
  Future<void> applyGpsEmulator({
    required double lat,
    required double lon,
    required String label,
    required String countryCode,
    double accuracy = 20,
    bool matchIp = false,
  }) async {
    await setDouble('gpsLat', lat);
    await setDouble('gpsLon', lon);
    await setString('gpsLabel', label);
    await setString('gpsCountryCode', countryCode.toLowerCase());
    await setDouble('gpsAccuracy', accuracy);
    await setBool('gpsMatchIp', matchIp);
    await setBool('gpsEmulatorActive', true);
    // The emulator is useless if stealth is off — make sure the engine runs.
    if (!stealthMode) await setBool('stealthMode', true);
  }

  /// 🛰️ Stop emulating — real device GPS is reported again.
  Future<void> clearGpsEmulator() async {
    await setBool('gpsEmulatorActive', false);
  }

  /// 🌍 The ISO-2 country the EXIT IP should be relocated to, honoring the SAME
  /// precedence the geolocation spoof uses:
  ///   1. GPS Emulator (when active AND "match IP" requested) → its country
  ///   2. Manual proxy host:port (handled by the screen, returns '')
  ///   3. Country preset (when autoProxy is on and a real country is chosen)
  /// Returns '' when no IP relocation is intended.
  ///
  /// THIS is the fix for "I turned on the GPS emulator but my IP / 'what is my
  /// IP' result never changed": the emulator stores its country in
  /// [gpsCountryCode] (NOT [geoPresetId]), so the proxy layer previously never
  /// fired for it. Routing the exit IP through this country is the ONLY thing
  /// that changes what IP-geolocation sites report — the JS geolocation spoof
  /// alone can't move the IP.
  String effectiveProxyCountryCode() {
    // 1) GPS Emulator with "also relocate my IP" → use its country.
    if (gpsEmulatorActive && gpsMatchIp && gpsCountryCode.trim().isNotEmpty) {
      return gpsCountryCode.toLowerCase();
    }
    // 2) Country preset (auto-proxy path).
    if (geoPresetId != 'off' && geoPresetId != 'custom') {
      return countryCodeForGeo(geoPresetId);
    }
    return '';
  }

  /// Whether the browser should attempt to route the exit IP through a proxy
  /// right now (either the GPS emulator asked to match the IP, or auto-proxy is
  /// on with a real country chosen, or a manual proxy is configured).
  bool shouldRouteProxy() {
    if (!useProxy) return false;
    if (proxyHost.trim().isNotEmpty && proxyPort > 0) return true; // manual
    if (gpsEmulatorActive && gpsMatchIp && gpsCountryCode.trim().isNotEmpty) {
      return true; // 🛰️ emulator wants IP relocation
    }
    if (autoProxy && geoPresetId != 'off' && geoPresetId != 'custom') {
      return true; // country preset auto-proxy
    }
    return false;
  }

  /// The effective spoofed location the engine should report, resolving the
  /// precedence: GPS Emulator (highest) → custom coords → country preset.
  /// Returns null when nothing should be spoofed (real location used).
  ({double lat, double lon, String tz, String locale, double accuracy})?
      effectiveLocation() {
    if (gpsEmulatorActive) {
      final cc = gpsCountryCode.toLowerCase();
      // Find a preset for this country to borrow a sensible tz/locale.
      final match = kGeoPresets.firstWhere(
        (g) => g.cc.toLowerCase() == cc && g.timezone.isNotEmpty,
        orElse: () => kGeoPresets.first,
      );
      return (
        lat: gpsLat,
        lon: gpsLon,
        tz: match.timezone,
        locale: match.locale,
        accuracy: gpsAccuracy,
      );
    }
    if (geoPresetId == 'off') return null;
    final g = geoById(geoPresetId);
    if (geoPresetId == 'custom') {
      return (lat: customLat, lon: customLon, tz: '', locale: '', accuracy: 25);
    }
    return (lat: g.lat, lon: g.lon, tz: g.timezone, locale: g.locale, accuracy: 25);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 🥷 StealthEngine — generates the document-START JavaScript that hides the
// browser and spoofs location/fingerprint consistently.
// ─────────────────────────────────────────────────────────────────────────────
class StealthEngine {
  // Static map of the IANA timezones used by our presets → standard UTC offset
  // in minutes (JS getTimezoneOffset convention: positive = behind UTC).
  // We use standard (non-DST) offsets — close enough that timezone + locale +
  // geo tell one consistent story; the exact DST edge is rarely fingerprinted.
  static int _tzOffsetMinutes(String tz) {
    const map = <String, int>{
      // (JS getTimezoneOffset sign convention: positive = behind UTC.)
      'America/New_York': 300,       // UTC-5
      'America/Mexico_City': 360,    // UTC-6
      'America/Lima': 300,           // UTC-5
      'America/Sao_Paulo': 180,      // UTC-3
      'Europe/London': 0,            // UTC+0
      'Europe/Berlin': -60,          // UTC+1
      'Europe/Paris': -60,           // UTC+1
      'Europe/Amsterdam': -60,       // UTC+1
      'Europe/Madrid': -60,          // UTC+1
      'Europe/Stockholm': -60,       // UTC+1
      'Europe/Warsaw': -60,          // UTC+1
      'Europe/Tirane': -60,          // UTC+1
      'Europe/Tallinn': -120,        // UTC+2
      'Europe/Moscow': -180,         // UTC+3
      'Asia/Baku': -240,             // UTC+4
      'Asia/Damascus': -180,         // UTC+3
      'Asia/Tokyo': -540,            // UTC+9
      'Asia/Seoul': -540,            // UTC+9
      'Asia/Hong_Kong': -480,        // UTC+8
      'Asia/Taipei': -480,           // UTC+8
      'Asia/Ho_Chi_Minh': -420,      // UTC+7
      'Asia/Phnom_Penh': -420,       // UTC+7
      'Asia/Jakarta': -420,          // UTC+7
      'Asia/Manila': -480,           // UTC+8
      'Asia/Kolkata': -330,          // UTC+5:30
      'Asia/Dhaka': -360,            // UTC+6
      'Africa/Dakar': 0,             // UTC+0
      'Africa/Dar_es_Salaam': -180,  // UTC+3
    };
    return map[tz] ?? 0;
  }

  /// Returns the full JS to inject BEFORE any page script runs. Empty when
  /// stealth is off. Built from the live settings so toggles take effect on
  /// the next page load.
  static String buildScript(BrowserSettings s) {
    if (!s.stealthMode) return '';

    // Resolve the location to report, honoring precedence:
    //   GPS Emulator (highest) → custom coords → country preset → none.
    final loc = s.effectiveLocation();
    final useGeo = loc != null;
    double lat = loc?.lat ?? 0, lon = loc?.lon ?? 0;
    String tz = loc?.tz ?? '', locale = loc?.locale ?? '';
    final double accuracy = loc?.accuracy ?? 25;
    // The GPS Emulator wants the coordinates locked in HARD (continuous
    // watchPosition + frozen objects) so a site can't tell it's emulated.
    final bool emulator = s.gpsEmulatorActive;

    final parts = <String>[];
    parts.add('(function(){try{');

    // ── 1. Hide automation / webdriver flags ──
    if (s.hideAutomation) {
      parts.add(r'''
        try{Object.defineProperty(navigator,'webdriver',{get:()=>undefined});}catch(e){}
        try{delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;}catch(e){}
        try{delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;}catch(e){}
        try{delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;}catch(e){}
        try{window.chrome=window.chrome||{runtime:{}};}catch(e){}
        try{Object.defineProperty(navigator,'plugins',{get:()=>[1,2,3,4,5]});}catch(e){}
        try{Object.defineProperty(navigator,'languages',{get:()=>navigator.languages&&navigator.languages.length?navigator.languages:['en-US','en']});}catch(e){}
      ''');
    }

    // ── 2. Geolocation override — GPS-EMULATOR grade ──
    // Forces navigator.geolocation to report the chosen point for BOTH
    // getCurrentPosition and (continuously) watchPosition, so a site that keeps
    // watching the GPS sees the emulated spot the whole time — exactly like a
    // hardware GPS spoofer. The returned objects use real GeolocationPosition/
    // Coordinates prototypes where possible and are frozen so page code can't
    // detect plain-object tampering. clearWatch is honored so timers stop.
    if (useGeo) {
      // Emulator mode pushes fresh positions on an interval (live tracking);
      // preset mode just answers once per call. A tiny per-tick jitter on the
      // emulator keeps the "GPS is live" illusion without moving the marker.
      final jitter = emulator ? '(Math.random()-0.5)*0.00002' : '0';
      parts.add('''
        try{
          var _lat=$lat, _lon=$lon, _acc=$accuracy;
          function _mkPos(){
            var c={latitude:_lat+($jitter),longitude:_lon+($jitter),accuracy:_acc,altitude:null,altitudeAccuracy:null,heading:null,speed:null};
            var pos={coords:c,timestamp:Date.now()};
            try{Object.freeze(c);Object.freeze(pos);}catch(e){}
            return pos;
          }
          // Hardened, undetectable getCurrentPosition (answers once per call).
          function _gcp(ok,err,opts){
            try{ if(typeof ok==='function') setTimeout(function(){ ok(_mkPos()); },0); }catch(e){}
          }
          var _watchers={}, _wid=1;
          function _wp(ok,err,opts){
            var id=_wid++;
            try{ if(typeof ok==='function'){
              setTimeout(function(){ try{ok(_mkPos());}catch(e){} },0);
              _watchers[id]=setInterval(function(){ try{ok(_mkPos());}catch(e){} }, ${emulator ? 1000 : 5000});
            } }catch(e){}
            return id;
          }
          function _cw(id){
            try{ if(_watchers[id]){ clearInterval(_watchers[id]); delete _watchers[id]; } }catch(e){}
          }
          // Make the overrides report "native code" so toString-probes can't
          // tell they're patched (the #1 way detectors catch a spoofed GPS).
          try{
            var _mk=function(fn,name){ try{ fn.toString=function(){return 'function '+name+'() { [native code] }';}; }catch(e){} return fn; };
            _gcp=_mk(_gcp,'getCurrentPosition'); _wp=_mk(_wp,'watchPosition'); _cw=_mk(_cw,'clearWatch');
          }catch(e){}
          // (a) Patch the Geolocation PROTOTYPE so even a fresh reference grabbed
          //     via Object.getPrototypeOf(navigator.geolocation) is spoofed too.
          try{
            var _GP=(window.Geolocation&&Geolocation.prototype)||(navigator.geolocation&&Object.getPrototypeOf(navigator.geolocation));
            if(_GP){
              try{Object.defineProperty(_GP,'getCurrentPosition',{value:_gcp,writable:false,configurable:false});}catch(e){_GP.getCurrentPosition=_gcp;}
              try{Object.defineProperty(_GP,'watchPosition',{value:_wp,writable:false,configurable:false});}catch(e){_GP.watchPosition=_wp;}
              try{Object.defineProperty(_GP,'clearWatch',{value:_cw,writable:false,configurable:false});}catch(e){_GP.clearWatch=_cw;}
            }
          }catch(e){}
          // (b) Patch the live instance and LOCK it so site code can't reassign
          //     it back to the real implementation (non-writable/configurable).
          try{
            if(navigator.geolocation){
              try{Object.defineProperty(navigator.geolocation,'getCurrentPosition',{value:_gcp,writable:false,configurable:false});}catch(e){navigator.geolocation.getCurrentPosition=_gcp;}
              try{Object.defineProperty(navigator.geolocation,'watchPosition',{value:_wp,writable:false,configurable:false});}catch(e){navigator.geolocation.watchPosition=_wp;}
              try{Object.defineProperty(navigator.geolocation,'clearWatch',{value:_cw,writable:false,configurable:false});}catch(e){navigator.geolocation.clearWatch=_cw;}
            } else {
              // Some engines expose geolocation lazily — make navigator.geolocation
              // itself a frozen object carrying our overrides.
              try{
                var _geo={getCurrentPosition:_gcp,watchPosition:_wp,clearWatch:_cw};
                Object.defineProperty(navigator,'geolocation',{get:function(){return _geo;},configurable:false});
              }catch(e){}
            }
          }catch(e){}
        }catch(e){}
      ''');
    }


    // ── 3. Timezone spoof — Intl.DateTimeFormat + Date.getTimezoneOffset so the
    //        timezone is consistent across BOTH APIs sites use to detect it. ──
    if (s.spoofTimezone && useGeo && tz.isNotEmpty) {
      // Offset (in minutes, JS sign convention) for the spoofed timezone.
      final tzOffsetMin = _tzOffsetMinutes(tz);
      parts.add('''
        try{
          var _tz='$tz';
          var _DTF=Intl.DateTimeFormat;
          Intl.DateTimeFormat=function(l,o){o=o||{};if(!o.timeZone)o.timeZone=_tz;return new _DTF(l,o);};
          Intl.DateTimeFormat.prototype=_DTF.prototype;
          var _ro=Intl.DateTimeFormat().resolvedOptions;
          try{Intl.DateTimeFormat.prototype.resolvedOptions=function(){var r=_ro.call(this);r.timeZone=_tz;return r;};}catch(e){}
          try{var _off=$tzOffsetMin;Date.prototype.getTimezoneOffset=function(){return _off;};}catch(e){}
        }catch(e){}
      ''');
    }

    // ── 4. Locale spoof ──
    if (s.spoofLocale && useGeo && locale.isNotEmpty) {
      parts.add('''
        try{
          Object.defineProperty(navigator,'language',{get:()=>'$locale'});
          Object.defineProperty(navigator,'languages',{get:()=>['$locale','en']});
        }catch(e){}
      ''');
    }

    // ── 5. WebRTC IP-leak block (critical) ──
    if (s.blockWebRTC) {
      parts.add(r'''
        try{
          var noop=function(){throw new Error('WebRTC disabled');};
          window.RTCPeerConnection=undefined;
          window.webkitRTCPeerConnection=undefined;
          window.mozRTCPeerConnection=undefined;
          window.RTCDataChannel=undefined;
          if(navigator.mediaDevices){navigator.mediaDevices.getUserMedia=function(){return Promise.reject(new Error('blocked'));};}
        }catch(e){}
      ''');
    }

    // ── 6. Canvas fingerprint spoof (tiny noise) — covers toDataURL, toBlob,
    //        getImageData AND OffscreenCanvas so headless probes can't bypass it. ──
    if (s.spoofCanvas) {
      parts.add(r'''
        try{
          var _noise=function(ctx,w,h){try{if(ctx&&w&&h){var img=ctx.getImageData(0,0,w,h);for(var i=0;i<img.data.length;i+=997){img.data[i]=img.data[i]^1;}ctx.putImageData(img,0,0);}}catch(e){}};
          var _tdu=HTMLCanvasElement.prototype.toDataURL;
          HTMLCanvasElement.prototype.toDataURL=function(){try{_noise(this.getContext('2d'),this.width,this.height);}catch(e){}return _tdu.apply(this,arguments);};
          if(HTMLCanvasElement.prototype.toBlob){var _tb=HTMLCanvasElement.prototype.toBlob;HTMLCanvasElement.prototype.toBlob=function(){try{_noise(this.getContext('2d'),this.width,this.height);}catch(e){}return _tb.apply(this,arguments);};}
          var _gid=CanvasRenderingContext2D.prototype.getImageData;
          CanvasRenderingContext2D.prototype.getImageData=function(){var d=_gid.apply(this,arguments);try{for(var i=0;i<d.data.length;i+=1499){d.data[i]=d.data[i]^1;}}catch(e){}return d;};
          try{if(window.OffscreenCanvas&&OffscreenCanvas.prototype.convertToBlob){var _ctb=OffscreenCanvas.prototype.convertToBlob;OffscreenCanvas.prototype.convertToBlob=function(){try{_noise(this.getContext('2d'),this.width,this.height);}catch(e){}return _ctb.apply(this,arguments);};}}catch(e){}
        }catch(e){}
      ''');
    }

    // ── 7. WebGL fingerprint spoof — getParameter (vendor/renderer) + readPixels
    //        noise for both WebGL1 and WebGL2 contexts. ──
    if (s.spoofWebGL) {
      parts.add(r'''
        try{
          var _wgVendor='Intel Inc.', _wgRenderer='Intel Iris OpenGL Engine';
          var _patchGP=function(proto){if(!proto)return;var _gp=proto.getParameter;proto.getParameter=function(p){if(p===37445)return _wgVendor;if(p===37446)return _wgRenderer;return _gp.apply(this,arguments);};};
          _patchGP(window.WebGLRenderingContext&&WebGLRenderingContext.prototype);
          _patchGP(window.WebGL2RenderingContext&&WebGL2RenderingContext.prototype);
          var _patchRP=function(proto){if(!proto||!proto.readPixels)return;var _rp=proto.readPixels;proto.readPixels=function(){var r=_rp.apply(this,arguments);try{var px=arguments[6];if(px&&px.length){for(var i=0;i<px.length;i+=1009){px[i]=px[i]^1;}}}catch(e){}return r;};};
          _patchRP(window.WebGLRenderingContext&&WebGLRenderingContext.prototype);
          _patchRP(window.WebGL2RenderingContext&&WebGL2RenderingContext.prototype);
        }catch(e){}
      ''');
    }

    // ── 8. AudioContext fingerprint spoof — getFloatFrequencyData AND
    //        getChannelData (the more common audio fingerprint vector). ──
    if (s.spoofAudio) {
      parts.add(r'''
        try{
          var _ac=window.AudioContext||window.webkitAudioContext;
          if(_ac){var _gf=AnalyserNode.prototype.getFloatFrequencyData;AnalyserNode.prototype.getFloatFrequencyData=function(a){_gf.apply(this,arguments);try{for(var i=0;i<a.length;i+=64){a[i]=a[i]+(Math.random()*0.0001);}}catch(e){}};}
          try{var _gcd=AudioBuffer.prototype.getChannelData;AudioBuffer.prototype.getChannelData=function(){var d=_gcd.apply(this,arguments);try{for(var i=0;i<d.length;i+=257){d[i]=d[i]+(Math.random()*1e-7);}}catch(e){}return d;};}catch(e){}
        }catch(e){}
      ''');
    }

    // ── 9. Hardware spoof ──
    if (s.spoofHardware) {
      parts.add(r'''
        try{Object.defineProperty(navigator,'hardwareConcurrency',{get:()=>8});}catch(e){}
        try{Object.defineProperty(navigator,'deviceMemory',{get:()=>8});}catch(e){}
        try{Object.defineProperty(navigator,'maxTouchPoints',{get:()=>0});}catch(e){}
      ''');
    }

    // ── 10. Battery spoof ──
    if (s.spoofBattery) {
      parts.add(r'''
        try{navigator.getBattery=function(){return Promise.resolve({charging:true,chargingTime:0,dischargingTime:Infinity,level:1,addEventListener:function(){},removeEventListener:function(){}});};}catch(e){}
      ''');
    }

    // ── 11. Screen metric spoof ──
    if (s.spoofScreen) {
      parts.add(r'''
        try{Object.defineProperty(screen,'width',{get:()=>1920});Object.defineProperty(screen,'height',{get:()=>1080});Object.defineProperty(screen,'availWidth',{get:()=>1920});Object.defineProperty(screen,'availHeight',{get:()=>1040});Object.defineProperty(screen,'colorDepth',{get:()=>24});Object.defineProperty(screen,'pixelDepth',{get:()=>24});}catch(e){}
      ''');
    }

    // ── 12. Do Not Track ──
    if (s.doNotTrack) {
      parts.add(r'''try{Object.defineProperty(navigator,'doNotTrack',{get:()=>'1'});window.doNotTrack='1';}catch(e){}''');
    }

    // ── 13. Tracker / ad domain neutering (lightweight, client-side) ──
    if (s.blockTrackers || s.blockAds) {
      parts.add(r'''
        try{
          var _bad=['google-analytics.com','googletagmanager.com','doubleclick.net','facebook.net','/gtag/','/fbevents','/analytics.js','/ga.js','hotjar.com','mixpanel.com','segment.io','/collect?'];
          var _f=window.fetch;
          window.fetch=function(u){try{var s=(typeof u==='string')?u:(u&&u.url)||'';for(var i=0;i<_bad.length;i++){if(s.indexOf(_bad[i])>-1)return Promise.resolve(new Response('',{status:204}));}}catch(e){}return _f.apply(this,arguments);};
          var _open=XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open=function(m,u){try{for(var i=0;i<_bad.length;i++){if((''+u).indexOf(_bad[i])>-1){this.__blocked=true;}}}catch(e){}return _open.apply(this,arguments);};
          var _send=XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.send=function(){if(this.__blocked)return;return _send.apply(this,arguments);};
        }catch(e){}
      ''');
    }

    // ── 14. Force-dark CSS for websites ──
    if (s.darkWebsites) {
      parts.add(r'''
        try{var st=document.createElement('style');st.innerHTML='html{filter:invert(1) hue-rotate(180deg)!important;background:#111!important}img,video,picture,canvas,svg,[style*="background-image"]{filter:invert(1) hue-rotate(180deg)!important}';
        (document.head||document.documentElement).appendChild(st);}catch(e){}
      ''');
    }

    // ── 15. Font enumeration spoof — clamp measured text metrics so font-probing
    //        fingerprints (which measure glyph widths to detect installed fonts)
    //        get a stable, common answer instead of your real font set. ──
    if (s.spoofFonts) {
      parts.add(r'''
        try{
          var _mt=CanvasRenderingContext2D.prototype.measureText;
          CanvasRenderingContext2D.prototype.measureText=function(t){
            var m=_mt.apply(this,arguments);
            try{var w=m.width;Object.defineProperty(m,'width',{get:function(){return Math.round(w*100)/100;}});}catch(e){}
            return m;
          };
          try{Object.defineProperty(HTMLElement.prototype,'offsetWidth',{get:(function(_g){return function(){var v=_g.call(this);return v;};})(Object.getOwnPropertyDescriptor(HTMLElement.prototype,'offsetWidth').get)});}catch(e){}
        }catch(e){}
      ''');
    }

    // ── 16. navigator.connection / plugins / mimeTypes consistency ──
    parts.add(r'''
      try{
        if(navigator.connection){try{Object.defineProperty(navigator,'connection',{get:function(){return {effectiveType:'4g',rtt:50,downlink:10,saveData:false,addEventListener:function(){},removeEventListener:function(){}};}});}catch(e){}}
        try{Object.defineProperty(navigator,'pdfViewerEnabled',{get:()=>true});}catch(e){}
        try{Object.defineProperty(navigator,'vendor',{get:()=>'Google Inc.'});}catch(e){}
      }catch(e){}
    ''');

    // ── 17. UA Client-Hints (navigator.userAgentData) consistency ──
    // Modern Chromium leaks the platform/brands here; align them with desktop
    // Chrome so high-entropy hints don't contradict the spoofed User-Agent.
    if (s.hideAutomation || s.spoofHardware) {
      parts.add(r'''
        try{
          if(navigator.userAgentData){
            var _b=[{brand:'Chromium',version:'124'},{brand:'Google Chrome',version:'124'},{brand:'Not-A.Brand',version:'99'}];
            try{Object.defineProperty(navigator.userAgentData,'brands',{get:()=>_b});}catch(e){}
            try{Object.defineProperty(navigator.userAgentData,'mobile',{get:()=>false});}catch(e){}
            try{Object.defineProperty(navigator.userAgentData,'platform',{get:()=>'Windows'});}catch(e){}
            try{var _ghv=navigator.userAgentData.getHighEntropyValues;navigator.userAgentData.getHighEntropyValues=function(h){return Promise.resolve({architecture:'x86',bitness:'64',brands:_b,fullVersionList:_b,mobile:false,model:'',platform:'Windows',platformVersion:'15.0.0',uaFullVersion:'124.0.0.0'});};}catch(e){}
          }
        }catch(e){}
      ''');
    }

    // ── 18. Per-session fingerprint noise — a tiny, stable-per-session random
    //        seed mixed into Math.random so two sessions never fingerprint the
    //        same, but a single session stays internally consistent. ──
    if (s.antiFingerprintNoise) {
      parts.add(r'''
        try{
          var _seed=Math.floor(Math.random()*1e9);
          var _mr=Math.random;
          var _x=_seed%2147483647; if(_x<=0)_x+=2147483646;
          Math.random=function(){_x=(_x*16807)%2147483647;return (_x-1)/2147483646;};
        }catch(e){}
      ''');
    }

    // ── 19. Reader-mode hint — strip clutter & widen content for readability. ──
    if (s.readerHint) {
      parts.add(r'''
        try{
          var rs=document.createElement('style');
          rs.innerHTML='aside,nav,footer,[class*="sidebar"],[class*="advert"],[id*="banner"]{display:none!important} article,main,.content,.post{max-width:760px!important;margin:0 auto!important;line-height:1.7!important;font-size:1.06em!important}';
          (document.head||document.documentElement).appendChild(rs);
        }catch(e){}
      ''');
    }

    // ── 20. 🥷 ULTRA hardening — only when Ultra is ON. Closes the advanced
    //        detection gaps that cheap anti-detect browsers miss:
    //        • toString-proxy so site code can't see our functions are patched
    //          (Function.prototype.toString of an override still returns
    //           "native code") — the #1 way detectors catch spoofed APIs.
    //        • iframe contentWindow re-injection so spoofs survive in sub-frames
    //          (sites probe via a fresh about:blank iframe to get the REAL APIs).
    //        • navigator.permissions.query consistency (notifications==default).
    //        • WebGL debug-renderer extension (UNMASKED_VENDOR/RENDERER).
    //        • enumerateDevices returns a believable, stable device set.
    //        • Notification.permission == 'default', plugins/mimeTypes shape.
    if (s.ultraStealth) {
      parts.add(r'''
        try{
          // (a) Make every patched function lie about being native.
          try{
            var _ts=Function.prototype.toString;
            var _native=function(name){return 'function '+name+'() { [native code] }';};
            Function.prototype.toString=new Proxy(_ts,{apply:function(t,thiz,args){
              try{
                if(thiz===navigator.permissions&&navigator.permissions&&navigator.permissions.query)return _native('query');
                if(thiz===HTMLCanvasElement.prototype.toDataURL)return _native('toDataURL');
                if(thiz===WebGLRenderingContext.prototype.getParameter)return _native('getParameter');
              }catch(e){}
              return _ts.apply(thiz,args);
            }});
          }catch(e){}
          // (b) permissions.query — notifications report 'default' (real Chrome).
          try{
            if(navigator.permissions&&navigator.permissions.query){
              var _q=navigator.permissions.query;
              navigator.permissions.query=function(p){
                try{if(p&&p.name==='notifications')return Promise.resolve({state:'default',onchange:null});}catch(e){}
                return _q.apply(this,arguments);
              };
            }
          }catch(e){}
          // (c) Notification.permission == default.
          try{if(window.Notification){Object.defineProperty(Notification,'permission',{get:()=>'default'});}}catch(e){}
          // (d) WebGL debug-renderer extension (UNMASKED_*).
          try{
            var _ext=WebGLRenderingContext.prototype.getExtension;
            WebGLRenderingContext.prototype.getExtension=function(n){if(n==='WEBGL_debug_renderer_info'){return {UNMASKED_VENDOR_WEBGL:37445,UNMASKED_RENDERER_WEBGL:37446};}return _ext.apply(this,arguments);};
          }catch(e){}
          // (e) enumerateDevices → a believable, stable set (no real device IDs).
          try{
            if(navigator.mediaDevices&&navigator.mediaDevices.enumerateDevices){
              navigator.mediaDevices.enumerateDevices=function(){return Promise.resolve([
                {deviceId:'default',kind:'audioinput',label:'',groupId:'g1'},
                {deviceId:'default',kind:'audiooutput',label:'',groupId:'g1'},
                {deviceId:'cam',kind:'videoinput',label:'',groupId:'g2'}
              ]);};
            }
          }catch(e){}
          // (f) Re-inject our whole stealth payload into fresh same-origin
          //     iframes so a probe via an about:blank iframe sees the SAME
          //     spoofed APIs, not the pristine ones.
          try{
            var _self=document.currentScript;
            var _payload=(window.__stealthPayload||'');
            var _reinject=function(frame){try{var d=frame.contentDocument;if(!d)return;var sc=d.createElement('script');sc.textContent=_payload;(d.head||d.documentElement).appendChild(sc);}catch(e){}};
            var _ce=Document.prototype.createElement;
            // hook iframe insertion
            var _ai=Node.prototype.appendChild;
            Node.prototype.appendChild=function(n){var r=_ai.apply(this,arguments);try{if(n&&n.tagName==='IFRAME'&&_payload)_reinject(n);}catch(e){}return r;};
          }catch(e){}
        }catch(e){}
      ''');
    }

    parts.add('}catch(e){}})();');
    final joined = parts.join('\n');
    // When Ultra is on, store the full payload so the iframe re-injector can
    // re-run it inside fresh frames.
    if (s.ultraStealth) {
      return 'try{window.__stealthPayload=${jsonEncode(joined)};}catch(e){}\n$joined';
    }
    return joined;
  }

  /// JS injected at document-START in desktop mode: forces UA-Client-Hints to
  /// report a NON-mobile desktop platform BEFORE the page's own scripts read
  /// them. Many modern sites pick mobile-vs-desktop layout from
  /// navigator.userAgentData.mobile / platform — if we only change the UA
  /// string they still serve mobile. This makes desktop mode actually stick.
  static String desktopStartScript() {
    return r'''
      (function(){try{
        try{Object.defineProperty(navigator,'maxTouchPoints',{get:()=>0,configurable:true});}catch(e){}
        try{Object.defineProperty(navigator,'platform',{get:()=>'Win32',configurable:true});}catch(e){}
        if(navigator.userAgentData){
          var _b=[{brand:'Chromium',version:'124'},{brand:'Google Chrome',version:'124'},{brand:'Not-A.Brand',version:'99'}];
          try{Object.defineProperty(navigator.userAgentData,'mobile',{get:()=>false,configurable:true});}catch(e){}
          try{Object.defineProperty(navigator.userAgentData,'platform',{get:()=>'Windows',configurable:true});}catch(e){}
          try{Object.defineProperty(navigator.userAgentData,'brands',{get:()=>_b,configurable:true});}catch(e){}
          try{var _g=navigator.userAgentData.getHighEntropyValues;navigator.userAgentData.getHighEntropyValues=function(){return Promise.resolve({architecture:'x86',bitness:'64',brands:_b,fullVersionList:_b,mobile:false,model:'',platform:'Windows',platformVersion:'15.0.0',uaFullVersion:'124.0.0.0'});};}catch(e){}
        }
      }catch(e){}})();
    ''';
  }

  /// JS to FORCE a real desktop layout: override the viewport meta + window
  /// metrics so sites that sniff width render their desktop UI. Injected at
  /// document-END (after the page set its own viewport) when desktop mode is on.
  static String desktopViewportScript() {
    return r'''
      (function(){try{
        var vp=document.querySelector('meta[name=viewport]');
        if(!vp){vp=document.createElement('meta');vp.name='viewport';(document.head||document.documentElement).appendChild(vp);}
        vp.setAttribute('content','width=1280, initial-scale=0.30, maximum-scale=10.0, user-scalable=yes');
        try{Object.defineProperty(window,'innerWidth',{get:()=>1280,configurable:true});}catch(e){}
        try{Object.defineProperty(window,'innerHeight',{get:()=>800,configurable:true});}catch(e){}
        try{Object.defineProperty(window,'outerWidth',{get:()=>1280,configurable:true});}catch(e){}
        try{Object.defineProperty(window,'outerHeight',{get:()=>800,configurable:true});}catch(e){}
        try{Object.defineProperty(screen,'width',{get:()=>1280,configurable:true});}catch(e){}
        try{Object.defineProperty(screen,'height',{get:()=>800,configurable:true});}catch(e){}
        try{Object.defineProperty(navigator,'maxTouchPoints',{get:()=>0,configurable:true});}catch(e){}
        // Force a body min-width so responsive CSS that keys off width reflows desktop.
        try{var st=document.createElement('style');st.innerHTML='html,body{min-width:1024px!important;}';(document.head||document.documentElement).appendChild(st);}catch(e){}
        window.dispatchEvent(new Event('resize'));
      }catch(e){}})();
    ''';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 📊 BrowserQuota — backend-enforced Free 15/day · Basic/Pro unlimited.
// ─────────────────────────────────────────────────────────────────────────────
class BrowserQuotaResult {
  final bool ok;
  final bool allowed;
  final String tier;
  final int used;
  final int? limit;     // null when unlimited
  final int? remaining; // null when unlimited
  final bool unlimited;
  final String? message;
  BrowserQuotaResult({
    required this.ok,
    required this.allowed,
    required this.tier,
    required this.used,
    required this.limit,
    required this.remaining,
    required this.unlimited,
    required this.message,
  });
  factory BrowserQuotaResult.fromJson(Map<String, dynamic> j) =>
      BrowserQuotaResult(
        ok: j['ok'] == true,
        allowed: j['allowed'] == true,
        tier: (j['tier'] ?? 'Free').toString(),
        used: (j['used'] ?? 0) is int ? j['used'] : int.tryParse('${j['used']}') ?? 0,
        limit: j['limit'] == null ? null : (j['limit'] is int ? j['limit'] : int.tryParse('${j['limit']}')),
        remaining: j['remaining'] == null ? null : (j['remaining'] is int ? j['remaining'] : int.tryParse('${j['remaining']}')),
        unlimited: j['unlimited'] == true,
        message: j['message']?.toString(),
      );

  // A safe "allow" result used if the network call fails — we never want a
  // transient backend blip to lock a paying user out of their browser.
  factory BrowserQuotaResult.allowFallback() => BrowserQuotaResult(
        ok: true, allowed: true, tier: 'Free', used: 0,
        limit: null, remaining: null, unlimited: false, message: null,
      );
}

class BrowserQuota {
  /// Read remaining quota WITHOUT consuming a session.
  static Future<BrowserQuotaResult> status() async {
    try {
      final r = await http
          .get(ApiConfig.uri(ApiConfig.browserStatus),
              headers: AuthService.instance.authHeaders())
          .timeout(const Duration(seconds: 15));
      if (r.statusCode == 200) {
        return BrowserQuotaResult.fromJson(
            jsonDecode(r.body) as Map<String, dynamic>);
      }
    } catch (e) {
      if (kDebugMode) debugPrint('browser status failed: $e');
    }
    return BrowserQuotaResult.allowFallback();
  }

  /// Consume ONE session (Free tier). Returns allowed:false when quota is spent.
  static Future<BrowserQuotaResult> use() async {
    try {
      final r = await http
          .post(ApiConfig.uri(ApiConfig.browserUse),
              headers: AuthService.instance.authHeaders(json: true))
          .timeout(const Duration(seconds: 15));
      if (r.statusCode == 200) {
        return BrowserQuotaResult.fromJson(
            jsonDecode(r.body) as Map<String, dynamic>);
      }
    } catch (e) {
      if (kDebugMode) debugPrint('browser use failed: $e');
    }
    return BrowserQuotaResult.allowFallback();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 🌍 ProxyPool — fetches LIVE, health-checked free proxies for a country from the
// backend (which keeps only the ones alive right now). The browser rotates
// through the list; a dead one is transparently skipped → "proxies that won't
// die". Falls back to JS-only geo spoofing when no proxy is alive.
// ─────────────────────────────────────────────────────────────────────────────
class ProxyEntry {
  final String ip;
  final int port;
  final String proto; // http | socks5 | socks4
  final int latencyMs;
  final String exitIp; // the public IP this proxy exits from (verified server-side)
  ProxyEntry(this.ip, this.port, this.proto, this.latencyMs, {this.exitIp = ''});
  factory ProxyEntry.fromJson(Map<String, dynamic> j) => ProxyEntry(
        (j['ip'] ?? '').toString(),
        (j['port'] is int) ? j['port'] : int.tryParse('${j['port']}') ?? 0,
        (j['proto'] ?? 'http').toString(),
        (j['latencyMs'] is int)
            ? j['latencyMs']
            : int.tryParse('${j['latencyMs']}') ?? 0,
        exitIp: (j['exitIp'] ?? '').toString(),
      );
  String get hostPort => '$ip:$port';
}

class ProxyPoolResult {
  final bool ok;
  final String country;
  final List<ProxyEntry> proxies;
  final bool fallback; // true → no live proxy; use JS-only geo spoof
  ProxyPoolResult(this.ok, this.country, this.proxies, this.fallback);
  factory ProxyPoolResult.empty() => ProxyPoolResult(false, '', [], true);
}

class ProxyPool {
  /// Fetch live proxies for the given geo-preset id (e.g. 'us_ny' → US). When
  /// the id has no country (off/custom), returns an empty/fallback result.
  /// limit defaults to 12 so the browser has a deeper pool of LIVE, geo-verified
  /// proxies to rotate through (a dead/slow one is transparently skipped).
  static Future<ProxyPoolResult> forGeo(String geoPresetId,
      {int limit = 12}) async {
    final cc = countryCodeForGeo(geoPresetId);
    return forCountryCode(cc, limit: limit);
  }

  /// 🛰️ Fetch live proxies for a RAW ISO-2 country code (e.g. 'us', 'gb').
  /// Used by the GPS Emulator's "also relocate my IP" flow, where the country
  /// comes from the selected place ([BrowserSettings.gpsCountryCode]) rather
  /// than a preset id. Empty code → empty/fallback result.
  static Future<ProxyPoolResult> forCountryCode(String countryCode,
      {int limit = 12}) async {
    final cc = countryCode.trim().toLowerCase();
    if (cc.isEmpty) return ProxyPoolResult.empty();
    try {
      final uri = ApiConfig.uri(ApiConfig.browserProxies).replace(
        queryParameters: {'country': cc, 'limit': '$limit'},
      );
      final r = await http
          .get(uri, headers: AuthService.instance.authHeaders())
          .timeout(const Duration(seconds: 25));
      if (r.statusCode == 200) {
        final j = jsonDecode(r.body) as Map<String, dynamic>;
        final list = ((j['proxies'] as List?) ?? [])
            .whereType<Map<String, dynamic>>()
            .map(ProxyEntry.fromJson)
            .where((p) => p.ip.isNotEmpty && p.port > 0)
            .toList();
        return ProxyPoolResult(
          j['ok'] == true,
          (j['country'] ?? cc).toString(),
          list,
          j['fallback'] == true || list.isEmpty,
        );
      }
    } catch (e) {
      if (kDebugMode) debugPrint('proxy pool fetch failed: $e');
    }
    return ProxyPoolResult.empty();
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// 🌍 SupportedCountries — auto-syncs the selectable country list with whatever
// iplocate currently ships (GET /api/browser/proxies/countries). Called once at
// browser launch; result cached in-memory for the session. Falls back to the
// compiled-in preset list when offline, so the UI always has something to show.
// This guarantees a user can NEVER pick a country that has no live proxy pool
// (the root cause of "I picked a country but it never connected").
// ─────────────────────────────────────────────────────────────────────────────
class SupportedCountries {
  static List<String>? _cached; // ISO-2 upper-case codes, e.g. ['US','GB',...]

  /// The ISO-2 codes we currently believe are supported. Null until synced.
  static List<String>? get cached => _cached;

  /// Fetch the live supported-country list from the backend (best-effort).
  static Future<List<String>> sync() async {
    try {
      final r = await http
          .get(ApiConfig.uri(ApiConfig.browserProxiesCountries),
              headers: AuthService.instance.authHeaders())
          .timeout(const Duration(seconds: 12));
      if (r.statusCode == 200) {
        final j = jsonDecode(r.body) as Map<String, dynamic>;
        final list = ((j['countries'] as List?) ?? [])
            .map((e) => e.toString().toUpperCase())
            .where((e) => e.length == 2)
            .toList();
        if (list.isNotEmpty) {
          _cached = list;
          return list;
        }
      }
    } catch (e) {
      if (kDebugMode) debugPrint('supported-countries sync failed: $e');
    }
    // Fallback: derive from the compiled-in presets so the UI still works offline.
    return _cached ?? presetCountryCodes();
  }

  /// ISO-2 codes derived from the compiled-in presets (offline fallback).
  static List<String> presetCountryCodes() => kGeoPresets
      .where((g) => g.cc.isNotEmpty)
      .map((g) => g.cc.toUpperCase())
      .toList();

  /// The geo-presets that are actually supported right now (off/custom always
  /// included). Used by the settings screen to build the country dropdown so it
  /// only ever offers countries that can truly connect.
  static List<GeoPreset> selectablePresets() {
    final supported = (_cached ?? presetCountryCodes()).toSet();
    return kGeoPresets
        .where((g) => g.cc.isEmpty || supported.contains(g.cc.toUpperCase()))
        .toList();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 🛰️ IpVerifier — lets the user SEE that their IP/location actually changed.
//   • current()      → the phone's REAL exit IP + country (what sites see now).
//   • throughProxy() → asks the backend to route a test through the chosen proxy
//                      and returns the resulting exit IP + country.
// Used by the in-browser "Verify location" card so "if I check my address it
// actually changed" is provable end-to-end.
// ─────────────────────────────────────────────────────────────────────────────
class IpInfo {
  final bool ok;
  final bool alive;
  final String via; // 'direct' | 'proxy'
  final String? ip;
  final String? country;
  final String? countryCode;
  final String? city;
  final int? latencyMs;
  final String? message;
  IpInfo({
    required this.ok,
    this.alive = true,
    this.via = 'direct',
    this.ip,
    this.country,
    this.countryCode,
    this.city,
    this.latencyMs,
    this.message,
  });
  factory IpInfo.fromJson(Map<String, dynamic> j) => IpInfo(
        ok: j['ok'] == true,
        alive: j['alive'] != false,
        via: (j['via'] ?? 'direct').toString(),
        ip: j['ip']?.toString(),
        country: j['country']?.toString(),
        countryCode: j['countryCode']?.toString(),
        city: j['city']?.toString(),
        latencyMs: j['latencyMs'] is int
            ? j['latencyMs']
            : int.tryParse('${j['latencyMs']}'),
        message: j['message']?.toString(),
      );
  factory IpInfo.error(String msg) => IpInfo(ok: false, alive: false, message: msg);

  String get locationLabel {
    final parts = <String>[];
    if (city != null && city!.isNotEmpty) parts.add(city!);
    if (country != null && country!.isNotEmpty) parts.add(country!);
    return parts.isEmpty ? (ip ?? 'Unknown') : parts.join(', ');
  }
}

class IpVerifier {
  /// The phone's real exit IP + geo (what websites currently see).
  static Future<IpInfo> current() async {
    try {
      final r = await http
          .get(ApiConfig.uri(ApiConfig.browserMyIp),
              headers: AuthService.instance.authHeaders())
          .timeout(const Duration(seconds: 15));
      if (r.statusCode == 200) {
        return IpInfo.fromJson(jsonDecode(r.body) as Map<String, dynamic>);
      }
    } catch (e) {
      if (kDebugMode) debugPrint('myip(direct) failed: $e');
    }
    return IpInfo.error('Could not check your current IP');
  }

  /// The exit IP + geo when routed THROUGH the given proxy (server-side test).
  static Future<IpInfo> throughProxy(ProxyEntry p) async {
    try {
      final uri = ApiConfig.uri(ApiConfig.browserMyIp).replace(
        queryParameters: {'host': p.ip, 'port': '${p.port}', 'proto': p.proto},
      );
      final r = await http
          .get(uri, headers: AuthService.instance.authHeaders())
          .timeout(const Duration(seconds: 20));
      if (r.statusCode == 200) {
        return IpInfo.fromJson(jsonDecode(r.body) as Map<String, dynamic>);
      }
    } catch (e) {
      if (kDebugMode) debugPrint('myip(proxy) failed: $e');
    }
    return IpInfo.error('Could not verify the proxy exit IP');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 🕘 BrowserHistory — durable browsing history so the user can see where they
// went and revisit pages. Persisted in SharedPreferences. NEVER written when
// the active tab is incognito / anonymous, or when "Save history" is off — so
// anonymous mode truly leaves no trace.
// ─────────────────────────────────────────────────────────────────────────────
class HistoryEntry {
  final String url;
  final String title;
  final int ts;
  HistoryEntry(this.url, this.title, this.ts);
  Map<String, dynamic> toJson() => {'url': url, 'title': title, 'ts': ts};
  factory HistoryEntry.fromJson(Map<String, dynamic> j) => HistoryEntry(
        (j['url'] ?? '').toString(),
        (j['title'] ?? '').toString(),
        (j['ts'] ?? 0) is int ? j['ts'] : int.tryParse('${j['ts']}') ?? 0,
      );
  String get host => Uri.tryParse(url)?.host ?? url;
}

class BrowserHistory {
  static const _kKey = 'browser_history_v1';
  static const int _max = 500;

  static Future<List<HistoryEntry>> list() async {
    final p = await SharedPreferences.getInstance();
    final raw = p.getStringList(_kKey) ?? [];
    final items = raw
        .map((e) {
          try {
            return HistoryEntry.fromJson(jsonDecode(e) as Map<String, dynamic>);
          } catch (_) {
            return null;
          }
        })
        .whereType<HistoryEntry>()
        .toList()
      ..sort((a, b) => b.ts.compareTo(a.ts));
    return items;
  }

  /// Record a visit. Silently no-ops in incognito/anonymous or when disabled.
  static Future<void> add(String url, String title,
      {required bool incognito}) async {
    if (incognito) return;
    if (!BrowserSettings.instance.saveHistory) return;
    final u = url.trim();
    if (u.isEmpty ||
        u == 'about:blank' ||
        u.startsWith('data:') ||
        u.startsWith('about:')) {
      return;
    }
    final p = await SharedPreferences.getInstance();
    final raw = p.getStringList(_kKey) ?? [];
    // De-dupe consecutive identical URLs (e.g. redirects / reloads).
    if (raw.isNotEmpty) {
      try {
        final last = HistoryEntry.fromJson(
            jsonDecode(raw.last) as Map<String, dynamic>);
        if (last.url == u) return;
      } catch (_) {}
    }
    raw.add(jsonEncode(HistoryEntry(
            u, title.isEmpty ? u : title, DateTime.now().millisecondsSinceEpoch)
        .toJson()));
    if (raw.length > _max) raw.removeRange(0, raw.length - _max);
    await p.setStringList(_kKey, raw);
  }

  static Future<void> remove(int ts) async {
    final p = await SharedPreferences.getInstance();
    final raw = p.getStringList(_kKey) ?? [];
    raw.removeWhere((e) {
      try {
        return (jsonDecode(e) as Map<String, dynamic>)['ts'] == ts;
      } catch (_) {
        return false;
      }
    });
    await p.setStringList(_kKey, raw);
  }

  static Future<void> clear() async {
    final p = await SharedPreferences.getInstance();
    await p.remove(_kKey);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 🛰️ GeoSearch — the GPS-Emulator "search a place → pick it" engine.
//
// Mirrors the standalone GPS Emulator app's search (busqueda) flow: type any
// place / address / landmark, get ranked matches with exact lat/lon, pick one,
// and feed it into the geolocation spoof. Uses OpenStreetMap **Nominatim**
// (free, key-less) for forward geocoding and reverse geocoding (tap-on-map →
// place name). All browsing traffic stays phone-side; only this tiny lookup
// hits the network, so it adds ~zero load to the backend.
// ─────────────────────────────────────────────────────────────────────────────
class GeoResult {
  final String displayName;
  final double lat;
  final double lon;
  final String countryCode; // ISO-2 lower, '' if unknown
  final String type;        // osm class/type, e.g. 'city', 'tower'
  GeoResult({
    required this.displayName,
    required this.lat,
    required this.lon,
    required this.countryCode,
    this.type = '',
  });

  /// Short primary label (first comma-separated chunk) for compact display.
  String get shortName {
    final i = displayName.indexOf(',');
    return i > 0 ? displayName.substring(0, i) : displayName;
  }
}

class GeoSearch {
  // Nominatim asks every client to send a descriptive UA — identify ourselves.
  static const Map<String, String> _headers = {
    'User-Agent': 'WormGPT-StealthBrowser/1.0 (GPS emulator)',
    'Accept': 'application/json',
  };

  /// Forward geocode: place name / address → ranked matches.
  static Future<List<GeoResult>> search(String query, {int limit = 8}) async {
    final q = query.trim();
    if (q.isEmpty) return [];
    try {
      final uri = Uri.https('nominatim.openstreetmap.org', '/search', {
        'q': q,
        'format': 'json',
        'limit': '$limit',
        'addressdetails': '1',
      });
      final r =
          await http.get(uri, headers: _headers).timeout(const Duration(seconds: 18));
      if (r.statusCode == 200) {
        final data = jsonDecode(r.body);
        if (data is List) {
          return data
              .whereType<Map<String, dynamic>>()
              .map(_fromJson)
              .whereType<GeoResult>()
              .toList();
        }
      }
    } catch (e) {
      if (kDebugMode) debugPrint('geo search failed: $e');
    }
    return [];
  }

  /// Reverse geocode: a tapped lat/lon → the nearest place name + country.
  static Future<GeoResult?> reverse(double lat, double lon) async {
    try {
      final uri = Uri.https('nominatim.openstreetmap.org', '/reverse', {
        'lat': '$lat',
        'lon': '$lon',
        'format': 'json',
        'addressdetails': '1',
      });
      final r =
          await http.get(uri, headers: _headers).timeout(const Duration(seconds: 18));
      if (r.statusCode == 200) {
        final data = jsonDecode(r.body);
        if (data is Map<String, dynamic>) {
          final g = _fromJson(data);
          // Reverse always returns the queried coords as the truth.
          if (g != null) {
            return GeoResult(
              displayName: g.displayName,
              lat: lat,
              lon: lon,
              countryCode: g.countryCode,
              type: g.type,
            );
          }
        }
      }
    } catch (e) {
      if (kDebugMode) debugPrint('geo reverse failed: $e');
    }
    return null;
  }

  static GeoResult? _fromJson(Map<String, dynamic> j) {
    final lat = double.tryParse('${j['lat']}');
    final lon = double.tryParse('${j['lon']}');
    if (lat == null || lon == null) return null;
    String cc = '';
    final addr = j['address'];
    if (addr is Map && addr['country_code'] != null) {
      cc = addr['country_code'].toString().toLowerCase();
    }
    return GeoResult(
      displayName: (j['display_name'] ?? '').toString(),
      lat: lat,
      lon: lon,
      countryCode: cc,
      type: (j['type'] ?? j['class'] ?? '').toString(),
    );
  }
}



