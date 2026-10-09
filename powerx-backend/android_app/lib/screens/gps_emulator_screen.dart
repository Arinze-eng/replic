// gps_emulator_screen.dart — 🛰️ GPS Emulator for the Stealth Browser.
//
// Modelled on the standalone GPS Emulator app's search → select → "change my
// location" flow, re-implemented for the in-app browser: search ANY place /
// address / landmark, pick a match (or tap the live map), preview the exact
// coordinates, then ACTIVATE the emulator. Once active, every page opened in
// the Stealth Browser reports that exact GPS spot for both
// getCurrentPosition AND continuous watchPosition (live tracking), so a site
// that checks your location shows the emulated place — consistently.
//
// The map is the OS WebView (flutter_inappwebview) rendering a tiny Leaflet +
// OpenStreetMap page; tapping it reverse-geocodes to a place name. No API key,
// no extra backend load.

import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import '../theme.dart';
import '../api/browser_service.dart';

class GpsEmulatorScreen extends StatefulWidget {
  const GpsEmulatorScreen({super.key});

  @override
  State<GpsEmulatorScreen> createState() => _GpsEmulatorScreenState();
}

class _GpsEmulatorScreenState extends State<GpsEmulatorScreen> {
  final s = BrowserSettings.instance;
  final _searchCtrl = TextEditingController();

  InAppWebViewController? _map;
  Timer? _debounce;

  bool _searching = false;
  List<GeoResult> _results = [];

  // Currently-selected (not yet applied) point.
  double? _selLat;
  double? _selLon;
  String _selLabel = '';
  String _selCc = '';
  // Default ON: the user's core need is that picking a place actually changes
  // what "what is my IP" reports — which only happens when we relocate the exit
  // IP through a proxy in that country. (Pure GPS spoofing can't move the IP.)
  bool _matchIp = true;
  // E2E verification state shown after applying (proves the IP truly changed).
  bool _verifying = false;
  String? _verifyResult; // human summary line
  bool _verifyOk = false;

  @override
  void initState() {
    super.initState();
    // Pre-fill with whatever is currently active so the user can fine-tune.
    if (s.gpsEmulatorActive) {
      _selLat = s.gpsLat;
      _selLon = s.gpsLon;
      _selLabel = s.gpsLabel;
      _selCc = s.gpsCountryCode;
      _matchIp = s.gpsMatchIp;
    }
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _searchCtrl.dispose();
    super.dispose();
  }

  // ── Search ────────────────────────────────────────────────────────────────
  void _onQueryChanged(String v) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 550), () => _runSearch(v));
  }

  Future<void> _runSearch(String v) async {
    final q = v.trim();
    if (q.isEmpty) {
      setState(() => _results = []);
      return;
    }
    setState(() => _searching = true);
    final res = await GeoSearch.search(q);
    if (!mounted) return;
    setState(() {
      _results = res;
      _searching = false;
    });
  }

  // ── Selection ───────────────────────────────────────────────────────────
  void _selectResult(GeoResult g) {
    setState(() {
      _selLat = g.lat;
      _selLon = g.lon;
      _selLabel = g.shortName;
      _selCc = g.countryCode;
      _results = [];
      _searchCtrl.text = g.shortName;
    });
    _moveMap(g.lat, g.lon, label: g.shortName);
  }

  Future<void> _onMapTap(double lat, double lon) async {
    // Optimistically drop a pin, then reverse-geocode to a real place name.
    setState(() {
      _selLat = lat;
      _selLon = lon;
      _selLabel = 'Locating…';
    });
    final g = await GeoSearch.reverse(lat, lon);
    if (!mounted) return;
    setState(() {
      _selLabel = g?.shortName ?? '${lat.toStringAsFixed(5)}, ${lon.toStringAsFixed(5)}';
      _selCc = g?.countryCode ?? '';
    });
  }

  void _moveMap(double lat, double lon, {String? label}) {
    _map?.evaluateJavascript(
      source: 'window.__setPin && window.__setPin($lat,$lon,'
          '${jsonEncode(label ?? '')});',
    );
  }

  // ── Apply / stop ──────────────────────────────────────────────────────────
  Future<void> _apply() async {
    if (_selLat == null || _selLon == null) return;
    await s.applyGpsEmulator(
      lat: _selLat!,
      lon: _selLon!,
      label: _selLabel,
      countryCode: _selCc,
      accuracy: s.gpsAccuracy,
      matchIp: _matchIp,
    );
    // If "match IP" is requested and we know the country, turn on auto-proxy so
    // the exit IP relocates too (the browser screen reads these on reapply).
    if (_matchIp && _selCc.isNotEmpty) {
      if (!s.useProxy) await s.setBool('useProxy', true);
      if (!s.autoProxy) await s.setBool('autoProxy', true);
      // 🛰️ END-TO-END PROOF: fetch a live, geo-verified proxy for the chosen
      // country and route a server-side test request through it to confirm the
      // exit IP REALLY lands in that country BEFORE we hand control back to the
      // browser. This is what guarantees "if I check my address it actually
      // changed" — the #1 thing the user said was broken.
      final proved = await _verifyRelocation(_selCc);
      if (!mounted) return;
      if (!proved) {
        // Couldn't prove it (no live proxy right now). Tell the user plainly so
        // they aren't misled into thinking the IP changed when it didn't, and
        // let them decide whether to continue with GPS-only spoofing.
        final goOn = await _showRelocationFailedDialog();
        if (goOn != true) return; // stay on screen to retry
      }
    }
    if (mounted) Navigator.pop(context, true); // signal: reapply + rebuild
  }

  /// Verifies the exit IP truly relocates to [cc] by routing a test through a
  /// live proxy server-side. Updates the on-screen verification banner and
  /// returns true when the IP genuinely changed to the target country.
  Future<bool> _verifyRelocation(String cc) async {
    setState(() {
      _verifying = true;
      _verifyResult = null;
      _verifyOk = false;
    });
    try {
      // 1) What is the phone's REAL exit IP right now (baseline)?
      final direct = await IpVerifier.current();
      // 2) Pull a live, geo-verified proxy pool for the target country.
      final pool = await ProxyPool.forCountryCode(cc, limit: 12);
      final httpProxies =
          pool.proxies.where((p) => p.proto == 'http').toList();
      // 3) Try proxies in order until one proves the IP changed to the country.
      for (final p in httpProxies.take(5)) {
        final via = await IpVerifier.throughProxy(p);
        final changed = via.alive &&
            via.ip != null &&
            via.ip!.isNotEmpty &&
            via.ip != direct.ip;
        final countryOk = (via.countryCode ?? '').toLowerCase() ==
            cc.toLowerCase();
        if (changed && countryOk) {
          if (!mounted) return true;
          setState(() {
            _verifying = false;
            _verifyOk = true;
            _verifyResult =
                '✅ IP relocated to ${via.locationLabel} (${via.ip}). Real IP ${direct.ip ?? "?"} is hidden.';
          });
          return true;
        }
      }
      if (!mounted) return false;
      setState(() {
        _verifying = false;
        _verifyOk = false;
        _verifyResult = httpProxies.isEmpty
            ? '⚠️ No live proxy for ${cc.toUpperCase()} right now — GPS is spoofed but the IP is unchanged.'
            : '⚠️ Could not confirm an IP in ${cc.toUpperCase()} yet — proxies were unreachable. GPS is spoofed; try again to relocate the IP.';
      });
      return false;
    } catch (_) {
      if (!mounted) return false;
      setState(() {
        _verifying = false;
        _verifyOk = false;
        _verifyResult = '⚠️ Verification failed — GPS spoofed, IP may be unchanged.';
      });
      return false;
    }
  }

  Future<bool?> _showRelocationFailedDialog() {
    return showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        backgroundColor: AppTheme.surface,
        title: const Text('IP not relocated'),
        content: Text(
          _verifyResult ??
              'Your GPS is now emulated, but a live proxy for this country '
                  'could not be reached, so your exit IP (what "what is my IP" '
                  'shows) has NOT changed yet.\n\nContinue with GPS-only spoofing, '
                  'or stay and try again to relocate the IP?',
          style: const TextStyle(fontSize: 13.5, height: 1.4),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(c, false),
            child: const Text('Stay & retry'),
          ),
          ElevatedButton(
            onPressed: () => Navigator.pop(c, true),
            child: const Text('Continue (GPS only)'),
          ),
        ],
      ),
    );
  }

  Future<void> _stop() async {
    await s.clearGpsEmulator();
    if (mounted) Navigator.pop(context, true);
  }

  // ── Map HTML (Leaflet + OSM tiles) ─────────────────────────────────────────
  String _mapHtml() {
    final lat = _selLat ?? s.gpsLat;
    final lon = _selLon ?? s.gpsLon;
    final hasPoint = (_selLat != null) || s.gpsEmulatorActive;
    final startLat = hasPoint ? lat : 20.0;
    final startLon = hasPoint ? lon : 0.0;
    final startZoom = hasPoint ? 13 : 2;
    return '''
<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>html,body,#map{height:100%;margin:0;background:#0e0f13}</style>
</head><body>
<div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  var map = L.map('map',{zoomControl:true,attributionControl:false})
              .setView([$startLat,$startLon],$startZoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(map);
  var marker=null;
  window.__setPin=function(lat,lon,label){
    if(marker){map.removeLayer(marker);}
    marker=L.marker([lat,lon]).addTo(map);
    if(label){marker.bindPopup(label).openPopup();}
    map.setView([lat,lon], Math.max(map.getZoom(),13));
  };
  ${hasPoint ? 'window.__setPin($startLat,$startLon,"");' : ''}
  // Tap-to-pick: send the tapped coords back to Flutter.
  map.on('click', function(e){
    window.__setPin(e.latlng.lat, e.latlng.lng, '');
    try{ window.flutter_inappwebview.callHandler('mapTap', e.latlng.lat, e.latlng.lng); }catch(err){}
  });
</script>
</body></html>
''';
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: s,
      builder: (context, _) {
        final active = s.gpsEmulatorActive;
        return Scaffold(
          appBar: AppBar(
            title: const Text('🛰️ GPS Emulator'),
            actions: [
              if (active)
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: Center(
                    child: Container(
                      padding:
                          const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                      decoration: BoxDecoration(
                        color: AppTheme.accent.withValues(alpha: 0.18),
                        borderRadius: BorderRadius.circular(20),
                      ),
                      child: const Text('LIVE',
                          style: TextStyle(
                              color: AppTheme.accent,
                              fontWeight: FontWeight.w800,
                              fontSize: 12)),
                    ),
                  ),
                ),
            ],
          ),
          body: Column(
            children: [
              _intro(),
              _searchBar(),
              if (_results.isNotEmpty) _resultsList() else _map_(),
              _selectionPanel(active),
            ],
          ),
        );
      },
    );
  }

  Widget _intro() => Container(
        width: double.infinity,
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
        child: const Text(
          'Search a place (or tap the map), select it, then "Change my '
          'location". Every page in the Stealth Browser will report that exact '
          'GPS spot — search & select again to move.',
          style: TextStyle(fontSize: 12.5, color: AppTheme.muted),
        ),
      );

  Widget _searchBar() => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: TextField(
          controller: _searchCtrl,
          textInputAction: TextInputAction.search,
          decoration: InputDecoration(
            hintText: 'Search city, address or landmark…',
            prefixIcon: const Icon(Icons.search),
            suffixIcon: _searching
                ? const Padding(
                    padding: EdgeInsets.all(12),
                    child: SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2)),
                  )
                : (_searchCtrl.text.isNotEmpty
                    ? IconButton(
                        icon: const Icon(Icons.clear),
                        onPressed: () {
                          _searchCtrl.clear();
                          setState(() => _results = []);
                        },
                      )
                    : null),
            filled: true,
            fillColor: AppTheme.surface,
            border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
                borderSide: BorderSide.none),
          ),
          onChanged: (v) {
            setState(() {});
            _onQueryChanged(v);
          },
          onSubmitted: _runSearch,
        ),
      );

  Widget _resultsList() => Expanded(
        child: ListView.separated(
          padding: const EdgeInsets.only(top: 8),
          itemCount: _results.length,
          separatorBuilder: (_, __) => const Divider(height: 1),
          itemBuilder: (c, i) {
            final g = _results[i];
            return ListTile(
              leading: const Icon(Icons.place, color: AppTheme.accent),
              title: Text(g.shortName,
                  maxLines: 1, overflow: TextOverflow.ellipsis),
              subtitle: Text(g.displayName,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 11.5)),
              trailing: g.countryCode.isEmpty
                  ? null
                  : Text(g.countryCode.toUpperCase(),
                      style: const TextStyle(
                          color: AppTheme.muted, fontSize: 11)),
              onTap: () => _selectResult(g),
            );
          },
        ),
      );

  Widget _map_() => Expanded(
        child: Container(
          margin: const EdgeInsets.all(12),
          clipBehavior: Clip.antiAlias,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: AppTheme.surfaceAlt),
          ),
          child: InAppWebView(
            initialData: InAppWebViewInitialData(
                data: _mapHtml(), mimeType: 'text/html', encoding: 'utf-8'),
            initialSettings: InAppWebViewSettings(
              transparentBackground: true,
              javaScriptEnabled: true,
              // The map needs the REAL network — never spoof THIS WebView.
              clearCache: false,
            ),
            onWebViewCreated: (c) {
              _map = c;
              c.addJavaScriptHandler(
                handlerName: 'mapTap',
                callback: (args) {
                  if (args.length >= 2) {
                    final la = (args[0] as num).toDouble();
                    final lo = (args[1] as num).toDouble();
                    _onMapTap(la, lo);
                  }
                  return null;
                },
              );
            },
          ),
        ),
      );

  Widget _selectionPanel(bool active) {
    final hasSel = _selLat != null && _selLon != null;
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
      decoration: const BoxDecoration(
        color: AppTheme.surface,
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
      ),
      child: SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.my_location, color: AppTheme.accent, size: 20),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    hasSel
                        ? (_selLabel.isEmpty ? 'Selected point' : _selLabel)
                        : (active
                            ? s.gpsLabel
                            : 'No location selected yet'),
                    style: const TextStyle(
                        fontSize: 15, fontWeight: FontWeight.w700),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                if (_selCc.isNotEmpty)
                  Text(_selCc.toUpperCase(),
                      style:
                          const TextStyle(color: AppTheme.muted, fontSize: 12)),
              ],
            ),
            if (hasSel)
              Padding(
                padding: const EdgeInsets.only(top: 4, left: 28),
                child: Text(
                  '${_selLat!.toStringAsFixed(5)}, ${_selLon!.toStringAsFixed(5)}',
                  style: const TextStyle(color: AppTheme.muted, fontSize: 12),
                ),
              ),
            const SizedBox(height: 8),
            // Match-IP toggle (only meaningful when the point has a country).
            if (hasSel && _selCc.isNotEmpty)
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                dense: true,
                activeColor: AppTheme.accent,
                title: const Text('Also relocate my IP to this country',
                    style: TextStyle(fontSize: 13.5)),
                subtitle: const Text(
                    'Routes through a live proxy so IP + GPS + timezone all match '
                    '— this is what changes "what is my IP"',
                    style: TextStyle(fontSize: 11)),
                value: _matchIp,
                onChanged: (v) => setState(() => _matchIp = v),
              ),
            // 🛰️ E2E verification banner — proves the exit IP actually changed.
            if (_verifying || _verifyResult != null)
              Container(
                margin: const EdgeInsets.only(top: 4, bottom: 8),
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: (_verifyOk ? AppTheme.accent : AppTheme.muted)
                      .withValues(alpha: 0.14),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(
                      color: _verifyOk ? AppTheme.accent : AppTheme.surfaceAlt),
                ),
                child: Row(
                  children: [
                    if (_verifying)
                      const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(
                            strokeWidth: 2, color: AppTheme.accent),
                      )
                    else
                      Icon(_verifyOk ? Icons.verified : Icons.info_outline,
                          size: 18,
                          color: _verifyOk ? AppTheme.accent : AppTheme.muted),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        _verifying
                            ? 'Verifying your new IP through a live proxy…'
                            : (_verifyResult ?? ''),
                        style: const TextStyle(fontSize: 12, height: 1.35),
                      ),
                    ),
                  ],
                ),
              ),
            Row(
              children: [
                Expanded(
                  child: ElevatedButton.icon(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppTheme.accent,
                      padding: const EdgeInsets.symmetric(vertical: 14),
                    ),
                    icon: _verifying
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(
                                strokeWidth: 2, color: Colors.white),
                          )
                        : const Icon(Icons.gps_fixed),
                    label: Text(_verifying
                        ? 'Relocating…'
                        : (active ? 'Update location' : 'Change my location')),
                    onPressed: (hasSel && !_verifying) ? _apply : null,
                  ),
                ),
                if (active) ...[
                  const SizedBox(width: 10),
                  OutlinedButton.icon(
                    style: OutlinedButton.styleFrom(
                      padding: const EdgeInsets.symmetric(
                          vertical: 14, horizontal: 12),
                    ),
                    icon: const Icon(Icons.location_off),
                    label: const Text('Stop'),
                    onPressed: _verifying ? null : _stop,
                  ),
                ],
              ],
            ),
          ],
        ),
      ),
    );
  }
}

