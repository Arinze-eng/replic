// browser_screen.dart — the Stealth Browser UI.
//
// A full, tabbed, undetectable browser built on flutter_inappwebview. It applies
// the StealthEngine JS at document-start, exposes 80+ settings, REAL per-country
// proxy routing, a downloads manager, a cookie EDITOR, a request/response
// interceptor (capture · edit · replay), and a JS DevTools console. Usage is
// gated by the backend quota (Free 15/day · Basic/Pro unlimited).

import 'dart:async';
import 'dart:collection';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import '../theme.dart';
import '../api/browser_service.dart';
import 'browser_settings_screen.dart';
import 'browser_tools_screens.dart';
import 'browser_capture.dart';
import 'gps_emulator_screen.dart';

class _Tab {
  InAppWebViewController? controller;
  PullToRefreshController? pullRefresh;
  String title = 'New Tab';
  String url = '';
  double progress = 0;
  bool incognito;
  bool anonymous; // 🕶️ true = no history, ephemeral, max stealth this tab
  bool canGoBack = false;
  bool canGoForward = false;
  // The key is regenerated whenever settings that require a fresh WebView change
  // (e.g. desktop mode / UA / incognito) so the new InAppWebViewSettings apply.
  Key key = UniqueKey();
  _Tab({this.incognito = false, this.anonymous = false});
}

class BrowserScreen extends StatefulWidget {
  const BrowserScreen({super.key});
  @override
  State<BrowserScreen> createState() => _BrowserScreenState();
}

class _BrowserScreenState extends State<BrowserScreen> {
  final _settings = BrowserSettings.instance;
  final _urlCtrl = TextEditingController();
  final _urlFocus = FocusNode();

  final List<_Tab> _tabs = [];
  int _active = 0;
  bool _booting = true;
  String? _blockedMessage; // set when quota is exhausted
  BrowserQuotaResult? _quota;
  bool _showFind = false;
  final _findCtrl = TextEditingController();

  // Shared capture store (requests/responses) for the interceptor screen.
  final CaptureStore _capture = CaptureStore();

  // Active proxy status (for the chip + applying to the WebView).
  ProxyEntry? _activeProxy;
  List<ProxyEntry> _activePool = []; // live pool for the current country (rotate on death)
  bool _proxyBusy = false;
  String? _proxyNote;
  // 🔄 Proactive auto-rotate timer — when the user enables Auto-rotate we switch
  // to the next live proxy on a fixed interval (separate from the on-death
  // rotation in onReceivedError) so an IP is never used too long.
  Timer? _rotateTimer;

  _Tab get tab => _tabs[_active];

  @override
  void initState() {
    super.initState();
    _boot();
  }

  Future<void> _boot() async {
    if (!_settings.loaded) await _settings.load();
    // Auto-sync the supported-country list with the live iplocate pool so the
    // settings screen only ever offers countries that can truly connect. Fire-
    // and-forget — the settings screen reads SupportedCountries.cached.
    SupportedCountries.sync();
    // Quota gate: consume one session. Unlimited tiers are free.
    final q = await BrowserQuota.use();
    if (!mounted) return;
    setState(() {
      _quota = q;
      if (!q.allowed) {
        _blockedMessage = q.message ??
            "You've used all your free Stealth Browser sessions for today.";
        _booting = false;
        return;
      }
      _tabs.add(_Tab(incognito: _settings.incognitoDefault));
      _urlCtrl.text = '';
    });
    if (q.allowed) {
      // Apply the proxy BEFORE the first page loads so the very first request
      // already goes through the foreign IP (consistent with geo spoof).
      await _applyProxy(initial: true);
      if (mounted) setState(() => _booting = false);
    }
  }

  // ── Proxy: resolve & apply a live proxy via the platform ProxyController ──
  Future<void> _applyProxy({bool initial = false}) async {
    // Use the unified decision so the GPS Emulator's "also relocate my IP"
    // path is honored too (it stores its country in gpsCountryCode, NOT in
    // geoPresetId — which is exactly why the IP never used to change).
    if (!_settings.shouldRouteProxy()) {
      await _clearProxy();
      return;
    }
    setState(() => _proxyBusy = true);
    try {
      ProxyEntry? chosen;
      // 1) Manual proxy wins when host+port are set.
      if (_settings.proxyHost.trim().isNotEmpty && _settings.proxyPort > 0) {
        chosen = ProxyEntry(
            _settings.proxyHost.trim(), _settings.proxyPort, 'http', 0);
        _proxyNote = 'Manual proxy';
      } else {
        // 2) Auto: resolve the country to relocate to, honoring precedence:
        //      🛰️ GPS Emulator (match-IP) → country preset.
        //    Fetch a LIVE free proxy pool for that country, then pick the first
        //    HTTP(S) one (Android ProxyController can't do SOCKS). The backend
        //    already health-checked + geo-verified the exit IPs, so any of
        //    these genuinely relocate the IP. We keep the rest as fallbacks.
        final cc = _settings.effectiveProxyCountryCode();
        if (cc.isNotEmpty) {
          final pool = await ProxyPool.forCountryCode(cc, limit: 12);
          final httpProxies =
              pool.proxies.where((p) => p.proto == 'http').toList();
          if (httpProxies.isNotEmpty) {
            chosen = httpProxies.first; // fastest first
            _activePool = httpProxies;
            final src = (_settings.gpsEmulatorActive && _settings.gpsMatchIp)
                ? '🛰️'
                : 'Auto';
            _proxyNote =
                '$src · ${pool.country} · ${chosen.latencyMs}ms · ${httpProxies.length} live';
          } else {
            _proxyNote = pool.proxies.isNotEmpty
                ? 'Only SOCKS available — JS geo only'
                : 'No live proxy — JS geo only';
          }
        }
      }

      if (chosen != null && chosen.proto == 'http') {
        final settings = ProxySettings(
          proxyRules: [ProxyRule(url: '${chosen.ip}:${chosen.port}')],
          bypassRules: [],
        );
        await ProxyController.instance().setProxyOverride(settings: settings);
        _activeProxy = chosen;
      } else {
        // No usable proxy → make sure none is left applied.
        await _clearProxy();
      }
    } catch (e) {
      _proxyNote = 'Proxy error';
      await _clearProxy();
    } finally {
      if (mounted) setState(() => _proxyBusy = false);
      // (Re)arm the proactive rotation timer to match the current settings.
      _syncRotateTimer();
    }
  }


  // ── 🔄 Proactive auto-rotate ──────────────────────────────────────────────
  // Arms a periodic timer that hops to the next live proxy every
  // `autoRotateMins` minutes when Auto-rotate is ON, a proxy is active, and we
  // have at least 2 live proxies to rotate between. Cancels itself otherwise.
  void _syncRotateTimer() {
    _rotateTimer?.cancel();
    _rotateTimer = null;
    if (!_settings.useProxy || !_settings.autoRotate) return;
    if (_activeProxy == null || _activePool.length < 2) return;
    final mins = _settings.autoRotateMins.clamp(1, 60);
    _rotateTimer = Timer.periodic(Duration(minutes: mins), (_) async {
      if (!mounted || !_settings.autoRotate || _activeProxy == null) return;
      final rotated = await _rotateProxy();
      if (rotated && mounted) {
        // Reload the active tab through the fresh IP so the change takes effect.
        final c = tab.controller;
        final u = tab.url;
        if (c != null && u.isNotEmpty && u != 'about:blank') {
          c.loadUrl(urlRequest: URLRequest(url: WebUri(u)));
        }
      }
    });
  }

  // Switch to the NEXT live proxy in the pool (used when one dies mid-session).
  Future<bool> _rotateProxy() async {
    if (_activePool.length < 2 || _activeProxy == null) return false;
    final idx = _activePool.indexWhere((p) => p.hostPort == _activeProxy!.hostPort);
    final next = _activePool[(idx + 1) % _activePool.length];
    try {
      await ProxyController.instance().setProxyOverride(
        settings: ProxySettings(
          proxyRules: [ProxyRule(url: '${next.ip}:${next.port}')],
          bypassRules: [],
        ),
      );
      _activeProxy = next;
      _proxyNote = 'Rotated · ${next.latencyMs}ms';
      if (mounted) setState(() {});
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<void> _clearProxy() async {
    _rotateTimer?.cancel();
    _rotateTimer = null;
    try {
      await ProxyController.instance().clearProxyOverride();
    } catch (_) {}
    _activeProxy = null;
  }

  // Build the InAppWebView settings from the live BrowserSettings.
  InAppWebViewSettings _webSettings(_Tab t) {
    final ua = _settings.effectiveUserAgent();
    return InAppWebViewSettings(
      javaScriptEnabled: _settings.javascriptEnabled,
      userAgent: ua.isNotEmpty ? ua : null,
      preferredContentMode: _settings.desktopMode
          ? UserPreferredContentMode.DESKTOP
          : UserPreferredContentMode.RECOMMENDED,
      incognito: t.incognito || t.anonymous,
      cacheEnabled: !(t.incognito || t.anonymous),
      clearCache: false,
      blockNetworkImage: !_settings.loadImages,
      loadsImagesAutomatically: _settings.loadImages,
      javaScriptCanOpenWindowsAutomatically: !_settings.blockPopups,
      supportMultipleWindows: false,
      thirdPartyCookiesEnabled: !_settings.blockThirdPartyCookies,
      textZoom: _settings.textZoom.round(),
      transparentBackground: true,
      useShouldOverrideUrlLoading: true,
      useShouldInterceptRequest: _settings.captureTraffic,
      useOnDownloadStart: true,
      mediaPlaybackRequiresUserGesture: true,
      allowsInlineMediaPlayback: true,
      disableContextMenu: false,
      supportZoom: true,
      builtInZoomControls: _settings.desktopMode,
      displayZoomControls: false,
      useWideViewPort: _settings.desktopMode,
      loadWithOverviewMode: _settings.desktopMode,
      verticalScrollBarEnabled: true,
      disableHorizontalScroll: false,
      disableVerticalScroll: false,
      // 🛡️ NATIVE ad/tracker blocking — blocks the requests at the WebView
      // layer (not just JS), so trackers/ads never even load. This is what
      // makes "Block ads" actually WORK (the JS neuter is a fallback).
      contentBlockers: _contentBlockers(),
      // 🛰️ Geolocation MUST be enabled at the WebView layer so the page's
      // navigator.geolocation calls actually reach our injected override. If
      // this were false the API would be missing entirely and the GPS Emulator
      // could not report the spoofed point. The real device GPS is never used:
      // our document-start script replaces getCurrentPosition/watchPosition.
      geolocationEnabled: true,
      // Gestures: allow back/forward swipe navigation when enabled.
      allowsBackForwardNavigationGestures: _settings.gesturesEnabled,
    );
  }

  /// Native content-blocker rules. Returns an empty list when both ad &
  /// tracker blocking are off (so nothing is filtered). Each rule BLOCKS any
  /// request whose URL contains the listed ad/tracker domain.
  List<ContentBlocker> _contentBlockers() {
    if (!_settings.blockAds && !_settings.blockTrackers) return [];
    const adHosts = <String>[
      'doubleclick.net',
      'googlesyndication.com',
      'googleadservices.com',
      'adservice.google.com',
      'g.doubleclick.net',
      'pagead2.googlesyndication.com',
      'amazon-adsystem.com',
      'adnxs.com',
      'taboola.com',
      'outbrain.com',
      'criteo.com',
      'pubmatic.com',
      'rubiconproject.com',
      'openx.net',
      'adcolony.com',
      'applovin.com',
      'unityads.unity3d.com',
    ];
    const trackerHosts = <String>[
      'google-analytics.com',
      'googletagmanager.com',
      'analytics.google.com',
      'facebook.net',
      'connect.facebook.net',
      'hotjar.com',
      'mixpanel.com',
      'segment.io',
      'segment.com',
      'fullstory.com',
      'mouseflow.com',
      'clarity.ms',
      'scorecardresearch.com',
      'quantserve.com',
      'newrelic.com',
      'sentry.io',
    ];
    final hosts = <String>[
      if (_settings.blockAds) ...adHosts,
      if (_settings.blockTrackers) ...trackerHosts,
    ];
    return hosts
        .map((h) => ContentBlocker(
              trigger: ContentBlockerTrigger(
                  urlFilter: '.*' + h.replaceAll('.', r'\.') + '.*'),
              action: ContentBlockerAction(
                  type: ContentBlockerActionType.BLOCK),
            ))
        .toList();
  }

  UnmodifiableListView<UserScript> _userScripts(_Tab t) {
    final list = <UserScript>[];
    // Anonymous tabs ALWAYS run the full stealth payload at max strength, even
    // if the user relaxed some global toggles — so "I was never there" holds.
    final effective = t.anonymous ? _anonymousSettings() : _settings;
    final js = StealthEngine.buildScript(effective);
    if (js.isNotEmpty) {
      list.add(UserScript(
        source: js,
        injectionTime: UserScriptInjectionTime.AT_DOCUMENT_START,
      ));
    }
    // 🔎 Live request/response capture hook (powers the rich Network inspector).
    if (_settings.captureTraffic) {
      list.add(UserScript(
        source: CaptureStore.captureHookJs(),
        injectionTime: UserScriptInjectionTime.AT_DOCUMENT_START,
      ));
    }
    if (_settings.desktopMode) {
      // Force desktop UA-Client-Hints BEFORE page scripts read them (start),
      // then override the viewport/metrics AFTER the page set its own (end).
      list.add(UserScript(
        source: StealthEngine.desktopStartScript(),
        injectionTime: UserScriptInjectionTime.AT_DOCUMENT_START,
      ));
      list.add(UserScript(
        source: StealthEngine.desktopViewportScript(),
        injectionTime: UserScriptInjectionTime.AT_DOCUMENT_END,
      ));
    }
    return UnmodifiableListView(list);
  }

  /// A maxed-out copy of the settings used for anonymous tabs: every spoof ON
  /// plus ultra hardening, regardless of the user's global toggles.
  BrowserSettings _anonymousSettings() => _settings.hardenedClone();

  PullToRefreshController? _makePullRefresh(_Tab t) {
    if (!_settings.pullToRefresh) return null;
    return PullToRefreshController(
      settings: PullToRefreshSettings(color: AppTheme.accent),
      onRefresh: () async {
        await t.controller?.reload();
      },
    );
  }

  String _normalizeInput(String raw) {
    final s = raw.trim();
    if (s.isEmpty) return _settings.homepage;
    final looksUrl = s.contains('.') && !s.contains(' ') ||
        s.startsWith('http://') ||
        s.startsWith('https://') ||
        s.startsWith('about:');
    if (looksUrl) {
      if (s.startsWith('http') || s.startsWith('about:')) return s;
      return (_settings.httpsOnly ? 'https://' : 'http://') + s;
    }
    return _settings.searchUrlFor(s);
  }

  void _go([String? input]) {
    final url = _normalizeInput(input ?? _urlCtrl.text);
    _urlFocus.unfocus();
    tab.controller?.loadUrl(urlRequest: URLRequest(url: WebUri(url)));
  }

  void _newTab({bool incognito = false, bool anonymous = false}) {
    setState(() {
      _tabs.add(_Tab(
        incognito: incognito || anonymous || _settings.incognitoDefault,
        anonymous: anonymous,
      ));
      _active = _tabs.length - 1;
      _urlCtrl.text = '';
    });
  }

  void _closeTab(int i) {
    final closing = _tabs[i];
    // 🕶️ Anonymous tab → wipe any trace it might have left when it closes.
    if (closing.anonymous) {
      CookieManager.instance().deleteAllCookies();
      InAppWebViewController.clearAllCache();
    }
    if (_tabs.length == 1) {
      setState(() {
        _tabs[0] = _Tab(incognito: _settings.incognitoDefault);
        _active = 0;
        _urlCtrl.text = '';
      });
      return;
    }
    setState(() {
      _tabs.removeAt(i);
      if (_active >= _tabs.length) _active = _tabs.length - 1;
      _urlCtrl.text = _tabs[_active].url;
    });
  }

  Future<void> _reapplySettings() async {
    // Proxy may have changed; re-apply it, then FULLY RE-CREATE every page so
    // new InAppWebViewSettings (desktop mode, UA, incognito, image loading,
    // zoom, gestures…) actually take effect. Just reloading the URL keeps the
    // OLD InAppWebViewSettings — that was why "Desktop site" appeared stuck in
    // mobile mode. Regenerating each tab's key rebuilds the InAppWebView with
    // the fresh settings + user scripts, then it reloads its current URL.
    await _applyProxy();
    setState(() {
      for (final t in _tabs) {
        // Preserve the current URL so the rebuilt WebView reopens the page.
        if (t.url.isEmpty) t.url = _settings.homepage;
        t.key = UniqueKey();
        t.controller = null;
        t.pullRefresh = null;
        t.progress = 0;
      }
    });
  }

  @override
  void dispose() {
    if (_settings.clearOnExit) {
      CookieManager.instance().deleteAllCookies();
      InAppWebViewController.clearAllCache();
    }
    // Always remove the proxy override when leaving the browser.
    _rotateTimer?.cancel();
    _clearProxy();
    _urlCtrl.dispose();
    _findCtrl.dispose();
    _urlFocus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_booting) {
      return const Scaffold(
        body: Center(child: CircularProgressIndicator(color: AppTheme.accent)),
      );
    }
    if (_blockedMessage != null) return _buildBlocked();

    return Scaffold(
      backgroundColor: AppTheme.bg,
      body: SafeArea(
        child: Column(
          children: [
            _buildTopBar(),
            if (_showFind) _buildFindBar(),
            _buildTabStrip(),
            Expanded(child: _buildWebArea()),
          ],
        ),
      ),
    );
  }

  // ── Quota-exhausted screen ──
  Widget _buildBlocked() {
    return Scaffold(
      appBar: AppBar(title: const Text('Stealth Browser')),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text('🥷', style: TextStyle(fontSize: 64)),
              const SizedBox(height: 18),
              const Text('Daily limit reached',
                  style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
              const SizedBox(height: 12),
              Text(_blockedMessage!,
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: AppTheme.muted, height: 1.5)),
              const SizedBox(height: 24),
              ElevatedButton.icon(
                onPressed: () => Navigator.of(context).maybePop(),
                icon: const Icon(Icons.workspace_premium),
                label: const Text('Upgrade for unlimited'),
              ),
              TextButton(
                onPressed: () => Navigator.of(context).maybePop(),
                child: const Text('Back'),
              ),
            ],
          ),
        ),
      ),
    );
  }

  // ── Top bar: nav buttons + URL field + stealth chip + menu ──
  Widget _buildTopBar() {
    final secure = tab.url.startsWith('https://');
    return Container(
      color: AppTheme.surface,
      padding: const EdgeInsets.fromLTRB(6, 6, 6, 8),
      child: Column(
        children: [
          Row(
            children: [
              IconButton(
                icon: const Icon(Icons.arrow_back, size: 22),
                onPressed: () async {
                  if (await (tab.controller?.canGoBack() ??
                      Future.value(false))) {
                    tab.controller?.goBack();
                  } else {
                    Navigator.of(context).maybePop();
                  }
                },
              ),
              IconButton(
                icon: const Icon(Icons.arrow_forward, size: 22),
                onPressed: () => tab.controller?.goForward(),
              ),
              Expanded(
                child: Container(
                  height: 42,
                  decoration: BoxDecoration(
                    color: AppTheme.surfaceAlt,
                    borderRadius: BorderRadius.circular(22),
                    border: Border.all(color: AppTheme.border),
                  ),
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  child: Row(
                    children: [
                      Icon(
                        tab.incognito
                            ? Icons.visibility_off
                            : (secure ? Icons.lock : Icons.lock_open),
                        size: 16,
                        color: tab.incognito
                            ? AppTheme.accent2
                            : (secure ? AppTheme.accent : AppTheme.muted),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: TextField(
                          controller: _urlCtrl,
                          focusNode: _urlFocus,
                          textInputAction: TextInputAction.go,
                          keyboardType: TextInputType.url,
                          autocorrect: false,
                          style: const TextStyle(fontSize: 14),
                          decoration: const InputDecoration(
                            isDense: true,
                            border: InputBorder.none,
                            hintText: 'Search or type a URL',
                            filled: false,
                            contentPadding: EdgeInsets.zero,
                          ),
                          onSubmitted: (v) => _go(v),
                          onTap: () => _urlCtrl.selection = TextSelection(
                              baseOffset: 0,
                              extentOffset: _urlCtrl.text.length),
                        ),
                      ),
                      if (tab.progress > 0 && tab.progress < 1)
                        const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(
                              strokeWidth: 2, color: AppTheme.accent),
                        )
                      else
                        IconButton(
                          padding: EdgeInsets.zero,
                          constraints: const BoxConstraints(),
                          icon: const Icon(Icons.refresh, size: 18),
                          onPressed: () => tab.controller?.reload(),
                        ),
                    ],
                  ),
                ),
              ),
              _buildProxyChip(),
              _buildQuotaChip(),
              _buildMenu(),
            ],
          ),
          if (tab.progress > 0 && tab.progress < 1)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: LinearProgressIndicator(
                value: tab.progress,
                minHeight: 2,
                backgroundColor: Colors.transparent,
                color: AppTheme.accent,
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildProxyChip() {
    if (!_settings.useProxy) return const SizedBox.shrink();
    final on = _activeProxy != null;
    return GestureDetector(
      onTap: () => _toast(_proxyNote ?? (on ? 'Proxy active' : 'No proxy')),
      child: Container(
        margin: const EdgeInsets.symmetric(horizontal: 2),
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 4),
        decoration: BoxDecoration(
          color: on ? AppTheme.accent.withOpacity(0.18) : AppTheme.surfaceAlt,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: on ? AppTheme.accent : AppTheme.border),
        ),
        child: _proxyBusy
            ? const SizedBox(
                width: 12,
                height: 12,
                child: CircularProgressIndicator(
                    strokeWidth: 2, color: AppTheme.accent))
            : Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(on ? Icons.vpn_lock : Icons.vpn_key_off,
                    size: 12, color: on ? AppTheme.accent : AppTheme.muted),
                const SizedBox(width: 3),
                Text(on ? 'IP' : 'off',
                    style: TextStyle(
                        fontSize: 10,
                        fontWeight: FontWeight.w700,
                        color: on ? AppTheme.accent : AppTheme.muted)),
              ]),
      ),
    );
  }

  Widget _buildQuotaChip() {
    final q = _quota;
    if (q == null || q.unlimited || q.remaining == null) {
      return const SizedBox.shrink();
    }
    final r = q.remaining!;
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 2),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: r <= 3 ? AppTheme.danger.withOpacity(0.18) : AppTheme.surfaceAlt,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: r <= 3 ? AppTheme.danger : AppTheme.border),
      ),
      child: Text('$r left',
          style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w700,
              color: r <= 3 ? AppTheme.danger : AppTheme.muted)),
    );
  }

  Widget _buildMenu() {
    final stealthOn = _settings.stealthMode;
    return PopupMenuButton<String>(
      icon: Stack(
        alignment: Alignment.center,
        children: [
          const Icon(Icons.more_vert),
          if (stealthOn)
            const Positioned(
              right: 4,
              top: 6,
              child: CircleAvatar(radius: 3, backgroundColor: AppTheme.accent),
            ),
        ],
      ),
      color: AppTheme.surfaceAlt,
      onSelected: _onMenu,
      itemBuilder: (c) => [
        _mi('new_tab', Icons.add, 'New tab'),
        _mi('new_incognito', Icons.visibility_off, 'New incognito tab'),
        _mi('new_anonymous', Icons.theater_comedy, 'New anonymous tab 🕶️'),
        const PopupMenuDivider(),
        _mi('stealth', stealthOn ? Icons.shield : Icons.shield_outlined,
            stealthOn ? 'Stealth: ON' : 'Stealth: OFF'),
        _mi('ultra', _settings.ultraStealth ? Icons.bolt : Icons.bolt_outlined,
            _settings.ultraStealth ? 'Ultra stealth ✓' : 'Ultra stealth'),
        _mi('desktop', Icons.computer,
            _settings.desktopMode ? 'Desktop site ✓' : 'Desktop site'),
        _mi(
            'gps_emulator',
            Icons.satellite_alt,
            _settings.gpsEmulatorActive
                ? '🛰️ GPS Emulator ✓'
                : '🛰️ GPS Emulator'),
        _mi('find', Icons.search, 'Find in page'),
        const PopupMenuDivider(),
        _mi('history', Icons.history, 'History'),
        _mi('downloads', Icons.download, 'Downloads'),
        _mi('cookies', Icons.cookie, 'Cookie editor'),
        _mi('network', Icons.swap_vert, 'Network / requests'),
        _mi('devtools', Icons.terminal, 'DevTools console'),
        _mi('privacy_report', Icons.verified_user, 'Privacy / leak test'),
        _mi('verify_ip', Icons.my_location, 'Verify my IP / location'),
        _mi('clear', Icons.cleaning_services, 'Clear data'),
        const PopupMenuDivider(),
        _mi('share', Icons.share, 'Copy link'),
        _mi('settings', Icons.settings, 'Browser settings'),
      ],
    );
  }

  PopupMenuItem<String> _mi(String v, IconData ic, String label) =>
      PopupMenuItem(
        value: v,
        child: Row(children: [
          Icon(ic, size: 19, color: AppTheme.text),
          const SizedBox(width: 12),
          Text(label),
        ]),
      );

  Future<void> _onMenu(String v) async {
    switch (v) {
      case 'new_tab':
        _newTab();
        break;
      case 'new_incognito':
        _newTab(incognito: true);
        break;
      case 'new_anonymous':
        _newTab(anonymous: true);
        _toast('🕶️ Anonymous tab — no history, no cookies, max stealth');
        break;
      case 'stealth':
        await _settings.setBool('stealthMode', !_settings.stealthMode);
        _reapplySettings();
        _toast(
            _settings.stealthMode ? 'Stealth mode ON 🥷' : 'Stealth mode OFF');
        break;
      case 'ultra':
        await _settings.applyUltra(!_settings.ultraStealth);
        _reapplySettings();
        _toast(_settings.ultraStealth
            ? 'Ultra stealth ON ⚡ — maximum undetectability'
            : 'Ultra stealth OFF');
        break;
      case 'desktop':
        await _settings.setBool('desktopMode', !_settings.desktopMode);
        // Desktop mode needs the WebView recreated so UA + viewport apply.
        _reapplySettings();
        _toast(_settings.desktopMode
            ? 'Desktop site ON 🖥️'
            : 'Mobile site');
        break;
      case 'gps_emulator':
        final changed = await Navigator.of(context).push<bool>(
            MaterialPageRoute(builder: (_) => const GpsEmulatorScreen()));
        if (changed == true) {
          // Reapply so the WebView rebuilds with the emulated location and
          // (if "match IP" was chosen) routes through the matching proxy.
          await _reapplySettings();
          _toast(_settings.gpsEmulatorActive
              ? '🛰️ Location set: ${_settings.gpsLabel.isEmpty ? "custom point" : _settings.gpsLabel}'
              : 'GPS Emulator stopped — real location restored');
        }
        break;
      case 'find':
        setState(() => _showFind = true);
        break;
      case 'history':
        final chosen = await Navigator.of(context).push<String>(
            MaterialPageRoute(builder: (_) => const HistoryScreen()));
        if (chosen != null && chosen.isNotEmpty) {
          _go(chosen);
        }
        break;
      case 'downloads':
        Navigator.of(context)
            .push(MaterialPageRoute(builder: (_) => const DownloadsScreen()));
        break;
      case 'cookies':
        Navigator.of(context).push(MaterialPageRoute(
            builder: (_) => CookieEditorScreen(url: tab.url)));
        break;
      case 'network':
        Navigator.of(context).push(MaterialPageRoute(
            builder: (_) => NetworkInspectorScreen(
                store: _capture, controller: tab.controller)));
        break;
      case 'devtools':
        if (!_settings.devToolsEnabled) {
          _toast('Enable DevTools in settings first');
          break;
        }
        Navigator.of(context).push(MaterialPageRoute(
            builder: (_) => DevToolsScreen(controller: tab.controller)));
        break;
      case 'privacy_report':
        _go('https://browserleaks.com/');
        break;
      case 'verify_ip':
        await _verifyIp();
        break;
      case 'clear':
        await CookieManager.instance().deleteAllCookies();
        await InAppWebViewController.clearAllCache();
        _capture.clear();
        _toast('Cookies, cache & captures cleared');
        break;
      case 'share':
        if (tab.url.isNotEmpty) {
          await Clipboard.setData(ClipboardData(text: tab.url));
          _toast('Link copied');
        }
        break;
      case 'settings':
        await Navigator.of(context).push(
            MaterialPageRoute(builder: (_) => const BrowserSettingsScreen()));
        _reapplySettings();
        break;
    }
  }

  Widget _buildFindBar() {
    return Container(
      color: AppTheme.surfaceAlt,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      child: Row(children: [
        const Icon(Icons.search, size: 18, color: AppTheme.muted),
        const SizedBox(width: 8),
        Expanded(
          child: TextField(
            controller: _findCtrl,
            autofocus: true,
            style: const TextStyle(fontSize: 14),
            decoration: const InputDecoration(
              isDense: true,
              border: InputBorder.none,
              filled: false,
              hintText: 'Find in page',
              contentPadding: EdgeInsets.zero,
            ),
            onChanged: (v) => tab.controller?.findAllAsync(find: v),
            onSubmitted: (v) => tab.controller?.findNext(forward: true),
          ),
        ),
        IconButton(
          padding: EdgeInsets.zero,
          constraints: const BoxConstraints(),
          icon: const Icon(Icons.keyboard_arrow_up, size: 22),
          onPressed: () => tab.controller?.findNext(forward: false),
        ),
        IconButton(
          padding: EdgeInsets.zero,
          constraints: const BoxConstraints(),
          icon: const Icon(Icons.keyboard_arrow_down, size: 22),
          onPressed: () => tab.controller?.findNext(forward: true),
        ),
        IconButton(
          padding: EdgeInsets.zero,
          constraints: const BoxConstraints(),
          icon: const Icon(Icons.close, size: 20),
          onPressed: () {
            tab.controller?.clearMatches();
            setState(() => _showFind = false);
            _findCtrl.clear();
          },
        ),
      ]),
    );
  }

  Widget _buildTabStrip() {
    if (_tabs.length <= 1) return const SizedBox.shrink();
    return Container(
      height: 38,
      color: AppTheme.surface,
      child: ListView.builder(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 6),
        itemCount: _tabs.length + 1,
        itemBuilder: (c, i) {
          if (i == _tabs.length) {
            return IconButton(
              icon: const Icon(Icons.add, size: 18),
              onPressed: () => _newTab(),
            );
          }
          final t = _tabs[i];
          final sel = i == _active;
          return GestureDetector(
            onTap: () => setState(() {
              _active = i;
              _urlCtrl.text = _tabs[i].url;
            }),
            child: Container(
              margin: const EdgeInsets.symmetric(vertical: 5, horizontal: 3),
              padding: const EdgeInsets.symmetric(horizontal: 10),
              constraints: const BoxConstraints(maxWidth: 150),
              decoration: BoxDecoration(
                color: sel ? AppTheme.surfaceAlt : Colors.transparent,
                borderRadius: BorderRadius.circular(8),
                border:
                    Border.all(color: sel ? AppTheme.accent : AppTheme.border),
              ),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                if (t.anonymous)
                  const Icon(Icons.theater_comedy,
                      size: 12, color: AppTheme.accent2)
                else if (t.incognito)
                  const Icon(Icons.visibility_off,
                      size: 12, color: AppTheme.accent2),
                if (t.incognito || t.anonymous) const SizedBox(width: 4),
                Flexible(
                  child: Text(
                    t.title.isEmpty ? 'New Tab' : t.title,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                        fontSize: 12,
                        color: sel ? AppTheme.text : AppTheme.muted),
                  ),
                ),
                const SizedBox(width: 6),
                GestureDetector(
                  onTap: () => _closeTab(i),
                  child: const Icon(Icons.close, size: 13),
                ),
              ]),
            ),
          );
        },
      ),
    );
  }

  Widget _buildWebArea() {
    return IndexedStack(
      index: _active,
      children: List.generate(_tabs.length, (i) => _buildOneWeb(_tabs[i])),
    );
  }

  Widget _buildOneWeb(_Tab t) {
    final initial = t.url.isEmpty ? _settings.homepage : t.url;
    t.pullRefresh ??= _makePullRefresh(t);
    return InAppWebView(
      key: t.key,
      initialUrlRequest: URLRequest(url: WebUri(initial)),
      initialSettings: _webSettings(t),
      initialUserScripts: _userScripts(t),
      pullToRefreshController: t.pullRefresh,
      onWebViewCreated: (c) {
        t.controller = c;
        c.addJavaScriptHandler(
          handlerName: 'stealthLog',
          callback: (args) => null,
        );
        // 🔎 Receive live request/response captures from the injected hook.
        c.addJavaScriptHandler(
          handlerName: 'captureXhr',
          callback: (args) {
            try {
              if (_settings.captureTraffic &&
                  args.isNotEmpty &&
                  args.first is Map) {
                _capture.recordLive(
                    Map<String, dynamic>.from(args.first as Map));
              }
            } catch (_) {}
            return null;
          },
        );
      },
      shouldOverrideUrlLoading: (c, action) async {
        final u = action.request.url?.toString() ?? '';
        if (_settings.httpsOnly && u.startsWith('http://')) {
          c.loadUrl(
              urlRequest: URLRequest(
                  url: WebUri(u.replaceFirst('http://', 'https://'))));
          return NavigationActionPolicy.CANCEL;
        }
        return NavigationActionPolicy.ALLOW;
      },
      shouldInterceptRequest: !_settings.captureTraffic
          ? null
          : (c, req) async {
              // Record the request for the inspector. Returning null lets the
              // WebView fetch it normally (we don't block the network here).
              _capture.recordRequest(req);
              return null;
            },
      onLoadStart: (c, url) {
        setState(() {
          t.url = url?.toString() ?? '';
          if (_active == _tabs.indexOf(t)) _urlCtrl.text = t.url;
        });
      },
      onProgressChanged: (c, p) {
        if (p == 100) t.pullRefresh?.endRefreshing();
        setState(() => t.progress = p / 100.0);
      },
      onTitleChanged: (c, title) {
        setState(() => t.title = title ?? t.title);
      },
      onLoadStop: (c, url) async {
        t.pullRefresh?.endRefreshing();
        // DNS-over-HTTPS hint: nudge the page to use secure DNS where supported.
        if (_settings.dnsOverHttps) {
          try {
            await c.evaluateJavascript(
                source:
                    "try{var l=document.createElement('link');l.rel='dns-prefetch';l.href='https://cloudflare-dns.com';document.head&&document.head.appendChild(l);}catch(e){}");
          } catch (_) {}
        }
        final back = await c.canGoBack();
        final fwd = await c.canGoForward();
        final finalUrl = url?.toString() ?? t.url;
        setState(() {
          t.url = finalUrl;
          t.progress = 1;
          t.canGoBack = back;
          t.canGoForward = fwd;
        });
        // 🕘 Record browsing history — skipped for incognito/anonymous tabs and
        // when "Save history" is off, so anonymous mode leaves no trace.
        await BrowserHistory.add(finalUrl, t.title,
            incognito: t.incognito || t.anonymous);
      },
      onDownloadStartRequest: (c, req) async {
        await BrowserDownloads.handle(context, req, _settings);
      },
      onPermissionRequest: (c, req) async {
        if (_settings.blockWebRTC) {
          return PermissionResponse(
              resources: req.resources,
              action: PermissionResponseAction.DENY);
        }
        return PermissionResponse(
            resources: req.resources,
            action: PermissionResponseAction.GRANT);
      },
      // 🛰️ Geolocation permission prompt (Android). When a spoofed location is
      // active we GRANT it WITHOUT a system dialog so the page's
      // navigator.geolocation call proceeds straight into our injected override
      // (which returns the emulated point). If we let the OS deny it, the site
      // would get a permission error instead of our spoofed coordinates — so
      // granting here is what makes the GPS Emulator actually report a position
      // every time. No real device GPS is read: our JS replaced the getters.
      onGeolocationPermissionsShowPrompt: (c, origin) async {
        // Always allow at the OS layer; our injected override decides the value
        // returned to the page (the emulated point), so the site never sees a
        // denial and never reads the real device GPS.
        return GeolocationPermissionShowPromptResponse(
          origin: origin,
          allow: true,
          retain: true,
        );
      },
      onReceivedError: (c, req, err) async {
        t.pullRefresh?.endRefreshing();
        // If a proxy is active and the MAIN frame failed (likely a dead proxy),
        // rotate to the next live proxy and retry once — "proxies that won't die".
        final isMainFrame = req.isForMainFrame ?? true;
        if (isMainFrame && _activeProxy != null && _activePool.length > 1) {
          final rotated = await _rotateProxy();
          if (rotated && mounted) {
            final u = req.url.toString();
            if (u.isNotEmpty && u != 'about:blank') {
              c.loadUrl(urlRequest: URLRequest(url: WebUri(u)));
            }
          }
        }
      },
    );
  }

  // ── Verify IP / location: prove the proxy actually relocated the IP ──
  Future<void> _verifyIp() async {
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (_) => const Center(
          child: CircularProgressIndicator(color: AppTheme.accent)),
    );
    final direct = await IpVerifier.current();
    IpInfo? proxied;
    if (_activeProxy != null) {
      proxied = await IpVerifier.throughProxy(_activeProxy!);
    }
    if (!mounted) return;
    Navigator.of(context).pop(); // dismiss spinner

    // Resolve the country we're CLAIMING to be in, honoring the GPS Emulator
    // first (its country lives in gpsCountryCode), then the geo preset. This is
    // what the verdict compares the proxy's real exit country against.
    String? spoofedCountry;
    if (_settings.gpsEmulatorActive && _settings.gpsCountryCode.isNotEmpty) {
      final cc = _settings.gpsCountryCode.toLowerCase();
      final match = kGeoPresets.firstWhere(
        (g) => g.cc.toLowerCase() == cc,
        orElse: () => kGeoPresets.first,
      );
      spoofedCountry = match.cc.isNotEmpty
          ? match.label
          : (_settings.gpsLabel.isNotEmpty
              ? _settings.gpsLabel
              : cc.toUpperCase());
    } else if (_settings.geoPresetId != 'off') {
      spoofedCountry = geoById(_settings.geoPresetId).label;
    }

    showModalBottomSheet(
      context: context,
      backgroundColor: AppTheme.surface,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
      builder: (c) => Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(children: const [
              Icon(Icons.my_location, color: AppTheme.accent),
              SizedBox(width: 10),
              Text('Location check',
                  style:
                      TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
            ]),
            const SizedBox(height: 16),
            _ipRow('🛰️ Real IP (no proxy)', direct.ip ?? '—',
                direct.locationLabel),
            const SizedBox(height: 12),
            if (_activeProxy != null) ...[
              _ipRow(
                  '🌍 With proxy',
                  (proxied?.alive == true)
                      ? (proxied?.ip ?? '—')
                      : 'Proxy not responding',
                  (proxied?.alive == true) ? proxied!.locationLabel : ''),
              const SizedBox(height: 14),
              _verdict(direct, proxied, spoofedCountry),
            ] else ...[
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: AppTheme.surfaceAlt,
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Text(
                  spoofedCountry == null
                      ? 'No proxy active. Pick a country in Browser Settings → Spoof location (or use the 🛰️ GPS Emulator with "Also relocate my IP") to change your IP.'
                      : (_settings.gpsEmulatorActive
                          ? 'GPS is emulated to $spoofedCountry, but your IP is NOT relocated. In the 🛰️ GPS Emulator turn ON "Also relocate my IP to this country", then reopen the page. (GPS alone does not change what "what is my IP" shows — only a proxy does.)'
                          : 'A country is selected but no live proxy is active yet. Open Settings → Network to enable "Use proxy" + "Auto free proxy", then reopen the page.'),
                  style: const TextStyle(
                      fontSize: 13, color: AppTheme.muted, height: 1.4),
                ),
              ),
            ],
            const SizedBox(height: 18),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: () => Navigator.pop(c),
                child: const Text('Close'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _ipRow(String label, String ip, String location) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label,
            style: const TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w700,
                color: AppTheme.muted)),
        const SizedBox(height: 3),
        Text(ip,
            style: const TextStyle(
                fontSize: 15, fontWeight: FontWeight.w700, fontFamily: 'monospace')),
        if (location.isNotEmpty)
          Text(location, style: const TextStyle(fontSize: 13, color: AppTheme.muted)),
      ],
    );
  }

  Widget _verdict(IpInfo direct, IpInfo? proxied, String? spoofedCountry) {
    final ok = proxied != null &&
        proxied.alive &&
        proxied.ip != null &&
        proxied.ip != direct.ip;
    String message;
    if (ok) {
      final country = proxied.country ?? '';
      final matchesCountry = spoofedCountry != null &&
          country.isNotEmpty &&
          spoofedCountry
              .toLowerCase()
              .contains(country.toLowerCase().split(' ').first);
      message = matchesCountry
          ? '✅ Your IP changed and matches $country. Websites now see you in the new location.'
          : '✅ Your IP changed to ${proxied.locationLabel}. Your real location is hidden.';
    } else {
      message =
          '⚠️ IP did not change — the proxy may have dropped. Reopen the page to pick a fresh live proxy.';
    }
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: (ok ? AppTheme.accent : AppTheme.danger).withOpacity(0.15),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: ok ? AppTheme.accent : AppTheme.danger),
      ),
      child: Row(children: [
        Icon(ok ? Icons.check_circle : Icons.error,
            color: ok ? AppTheme.accent : AppTheme.danger),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            message,
            style: const TextStyle(fontSize: 12.5, height: 1.4),
          ),
        ),
      ]),
    );
  }

  void _toast(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(m), duration: const Duration(seconds: 2)),
    );
  }
}
