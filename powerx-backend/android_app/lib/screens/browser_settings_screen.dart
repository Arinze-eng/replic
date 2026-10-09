// browser_settings_screen.dart — the 80+ configuration knobs for the Stealth
// Browser, grouped into clear sections. Every change persists instantly via
// BrowserSettings and applies on the next page load.

import 'package:flutter/material.dart';
import '../theme.dart';
import '../api/browser_service.dart';
import 'gps_emulator_screen.dart';

class BrowserSettingsScreen extends StatefulWidget {
  const BrowserSettingsScreen({super.key});
  @override
  State<BrowserSettingsScreen> createState() => _BrowserSettingsScreenState();
}

class _BrowserSettingsScreenState extends State<BrowserSettingsScreen> {
  final s = BrowserSettings.instance;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: s,
      builder: (context, _) {
        return Scaffold(
          appBar: AppBar(title: const Text('Browser Settings')),
          body: ListView(
            padding: const EdgeInsets.only(bottom: 40),
            children: [
              _header('🥷 Stealth & Anti-Detect',
                  'Make this browser invisible to fingerprinting & geo-detection'),
              _switch('Master stealth mode', s.stealthMode,
                  (v) => s.setBool('stealthMode', v),
                  sub: 'Turns ALL spoofing on/off at once'),
              _switch('⚡ Ultra stealth (maximum)', s.ultraStealth,
                  (v) => s.applyUltra(v),
                  sub:
                      'Forces EVERY spoof on + advanced hardening (toString-proxy, iframe re-inject, permissions, device list). Hardest to detect.'),
              _locationTile(),
              _gpsEmulatorTile(),
              _switch('Spoof timezone', s.spoofTimezone,
                  (v) => s.setBool('spoofTimezone', v),
                  sub: 'Match the chosen country\'s timezone'),
              _switch('Spoof language / locale', s.spoofLocale,
                  (v) => s.setBool('spoofLocale', v)),
              _switch('Block WebRTC (stops IP leak)', s.blockWebRTC,
                  (v) => s.setBool('blockWebRTC', v),
                  sub: 'The #1 way VPNs/browsers leak your real IP'),
              _switch('Spoof Canvas fingerprint', s.spoofCanvas,
                  (v) => s.setBool('spoofCanvas', v)),
              _switch('Spoof WebGL fingerprint', s.spoofWebGL,
                  (v) => s.setBool('spoofWebGL', v)),
              _switch('Spoof Audio fingerprint', s.spoofAudio,
                  (v) => s.setBool('spoofAudio', v)),
              _switch('Spoof font enumeration', s.spoofFonts,
                  (v) => s.setBool('spoofFonts', v)),
              _switch('Hide automation flags', s.hideAutomation,
                  (v) => s.setBool('hideAutomation', v),
                  sub: 'Removes navigator.webdriver & headless markers'),
              _switch('Spoof hardware (CPU/RAM)', s.spoofHardware,
                  (v) => s.setBool('spoofHardware', v)),
              _switch('Spoof battery status', s.spoofBattery,
                  (v) => s.setBool('spoofBattery', v)),
              _switch('Spoof screen metrics', s.spoofScreen,
                  (v) => s.setBool('spoofScreen', v)),
              _switch('Send Do-Not-Track', s.doNotTrack,
                  (v) => s.setBool('doNotTrack', v)),
              _switch('Per-session fingerprint noise', s.antiFingerprintNoise,
                  (v) => s.setBool('antiFingerprintNoise', v)),
              _userAgentTile(),

              _header('🛡️ Privacy', 'Trackers, ads, cookies & sessions'),
              _switch('Block trackers', s.blockTrackers,
                  (v) => s.setBool('blockTrackers', v)),
              _switch('Block ads', s.blockAds, (v) => s.setBool('blockAds', v)),
              _switch('Block third-party cookies', s.blockThirdPartyCookies,
                  (v) => s.setBool('blockThirdPartyCookies', v)),
              _switch('Block pop-ups', s.blockPopups,
                  (v) => s.setBool('blockPopups', v)),
              _switch('HTTPS-only mode', s.httpsOnly,
                  (v) => s.setBool('httpsOnly', v)),
              _switch('Clear data on exit', s.clearOnExit,
                  (v) => s.setBool('clearOnExit', v),
                  sub: 'Wipe cookies + cache when the browser closes'),
              _switch('Open new tabs in incognito', s.incognitoDefault,
                  (v) => s.setBool('incognitoDefault', v)),
              _switch('Save browsing history', s.saveHistory,
                  (v) => s.setBool('saveHistory', v),
                  sub:
                      'When off, no history is recorded. Anonymous tabs never record history regardless.'),

              _header('🌐 Browsing & Rendering', null),
              _switch('JavaScript enabled', s.javascriptEnabled,
                  (v) => s.setBool('javascriptEnabled', v)),
              _switch('Desktop site (default)', s.desktopMode,
                  (v) => s.setBool('desktopMode', v)),
              _switch('Load images', s.loadImages,
                  (v) => s.setBool('loadImages', v)),
              _switch('Force dark on websites', s.darkWebsites,
                  (v) => s.setBool('darkWebsites', v)),
              _switch('Reader mode (declutter pages)', s.readerHint,
                  (v) => s.setBool('readerHint', v),
                  sub: 'Hide sidebars/ads & widen article text'),
              _zoomTile(),
              _searchEngineTile(),
              _homepageTile(),

              _header('🔌 Network', null),
              _switch('Use proxy', s.useProxy, (v) => s.setBool('useProxy', v),
                  sub: 'Route traffic through a proxy to change your IP country'),
              if (s.useProxy)
                _switch('Auto free proxy (match location)', s.autoProxy,
                    (v) => s.setBool('autoProxy', v),
                    sub:
                        'Fetch a LIVE free proxy in the spoofed country so your IP matches'),
              if (s.useProxy)
                _switch('🔄 Auto-rotate IP', s.autoRotate,
                    (v) => s.setBool('autoRotate', v),
                    sub:
                        'Hop to a fresh live proxy on a timer so one IP is never used too long'),
              if (s.useProxy && s.autoRotate) _rotateIntervalTile(),
              if (s.useProxy) _proxyTile(),
              _switch('DNS over HTTPS', s.dnsOverHttps,
                  (v) => s.setBool('dnsOverHttps', v),
                  sub: 'Resolve domains over encrypted DNS where supported'),
              _switch('Capture requests/responses', s.captureTraffic,
                  (v) => s.setBool('captureTraffic', v),
                  sub: 'Log network traffic for the inspector (edit & replay)'),

              _header('⬇️ Downloads', null),
              _switch('Ask where to save', s.askDownloadLocation,
                  (v) => s.setBool('askDownloadLocation', v)),
              _switch('Auto-open after download', s.autoOpenDownloads,
                  (v) => s.setBool('autoOpenDownloads', v)),

              _header('🧰 Power User', null),
              _switch('DevTools console', s.devToolsEnabled,
                  (v) => s.setBool('devToolsEnabled', v)),
              _switch('Gestures (swipe nav)', s.gesturesEnabled,
                  (v) => s.setBool('gesturesEnabled', v)),
              _switch('Pull to refresh', s.pullToRefresh,
                  (v) => s.setBool('pullToRefresh', v)),
              const SizedBox(height: 16),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: OutlinedButton.icon(
                  icon: const Icon(Icons.restore),
                  label: const Text('Reset all to defaults'),
                  onPressed: _resetAll,
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  // ── Section header ──
  Widget _header(String title, String? sub) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 22, 16, 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title,
                style: const TextStyle(
                    fontSize: 15.5,
                    fontWeight: FontWeight.w800,
                    color: AppTheme.accent)),
            if (sub != null)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(sub,
                    style:
                        const TextStyle(fontSize: 12, color: AppTheme.muted)),
              ),
          ],
        ),
      );

  Widget _switch(String title, bool value, ValueChanged<bool> onChanged,
      {String? sub}) {
    return SwitchListTile(
      title: Text(title, style: const TextStyle(fontSize: 14.5)),
      subtitle: sub == null
          ? null
          : Text(sub, style: const TextStyle(fontSize: 11.5)),
      value: value,
      activeColor: AppTheme.accent,
      dense: true,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16),
      onChanged: onChanged,
    );
  }

  Widget _locationTile() {
    final g = geoById(s.geoPresetId);
    return ListTile(
      leading: const Icon(Icons.public, color: AppTheme.accent),
      title: const Text('Spoof location', style: TextStyle(fontSize: 14.5)),
      subtitle: Text('${g.flag} ${g.label}',
          style: const TextStyle(fontSize: 12, color: AppTheme.muted)),
      trailing: const Icon(Icons.chevron_right),
      onTap: _pickLocation,
    );
  }

  // 🛰️ GPS Emulator — search a place / tap the map → the browser reports that
  // exact GPS spot (overrides the country preset above while active).
  Widget _gpsEmulatorTile() {
    final active = s.gpsEmulatorActive;
    return ListTile(
      leading: const Icon(Icons.satellite_alt, color: AppTheme.accent),
      title: const Text('🛰️ GPS Emulator', style: TextStyle(fontSize: 14.5)),
      subtitle: Text(
        active
            ? 'LIVE · ${s.gpsLabel.isEmpty ? "${s.gpsLat.toStringAsFixed(4)}, ${s.gpsLon.toStringAsFixed(4)}" : s.gpsLabel}'
            : 'Search & select any place — the browser reports that exact GPS',
        style: TextStyle(
            fontSize: 12,
            color: active ? AppTheme.accent : AppTheme.muted),
      ),
      trailing: const Icon(Icons.chevron_right),
      onTap: () async {
        await Navigator.of(context).push(
            MaterialPageRoute(builder: (_) => const GpsEmulatorScreen()));
        if (mounted) setState(() {});
      },
    );
  }

  // Slider for the auto-rotate interval (1..60 min).
  Widget _rotateIntervalTile() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Rotate every ${s.autoRotateMins} min',
              style: const TextStyle(fontSize: 13, color: AppTheme.muted)),
          Slider(
            value: s.autoRotateMins.toDouble().clamp(1, 60),
            min: 1,
            max: 60,
            divisions: 59,
            activeColor: AppTheme.accent,
            label: '${s.autoRotateMins} min',
            onChanged: (v) => s.setInt('autoRotateMins', v.round()),
          ),
        ],
      ),
    );
  }

  Future<void> _pickLocation() async {
    final chosen = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: AppTheme.surface,
      isScrollControlled: true,
      builder: (c) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 14, 16, 6),
              child: Text(
                'Countries with a LIVE proxy pool (auto-synced from the proxy list, validated every 30 min)',
                style: TextStyle(fontSize: 11.5, color: AppTheme.muted),
              ),
            ),
            ...SupportedCountries.selectablePresets()
                .map((g) => ListTile(
                      leading: Text(g.flag,
                          style: const TextStyle(fontSize: 22)),
                      title: Text(g.label),
                      trailing: s.geoPresetId == g.id
                          ? const Icon(Icons.check, color: AppTheme.accent)
                          : null,
                      onTap: () => Navigator.pop(c, g.id),
                    )),
          ],
        ),
      ),
    );
    if (chosen == null) return;
    await s.setString('geoPresetId', chosen);
    if (chosen == 'custom') await _customCoords();
    // When the user picks a real country, auto-enable proxy routing so their
    // IP actually relocates to match the spoofed geo (one consistent story).
    // Custom coords have no country → proxy can't help, so leave it off.
    if (chosen != 'off' && chosen != 'custom') {
      if (!s.useProxy) await s.setBool('useProxy', true);
      if (!s.autoProxy) await s.setBool('autoProxy', true);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text(
              '🌍 Auto proxy ON — your IP will route through this country so '
              'your real location changes. Reopen the page to apply.'),
          duration: Duration(seconds: 4),
        ));
      }
    }
  }

  Future<void> _customCoords() async {
    final latCtrl = TextEditingController(
        text: s.customLat == 0 ? '' : s.customLat.toString());
    final lonCtrl = TextEditingController(
        text: s.customLon == 0 ? '' : s.customLon.toString());
    await showDialog(
      context: context,
      builder: (c) => AlertDialog(
        backgroundColor: AppTheme.surface,
        title: const Text('Custom coordinates'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(
            controller: latCtrl,
            keyboardType:
                const TextInputType.numberWithOptions(decimal: true, signed: true),
            decoration: const InputDecoration(labelText: 'Latitude'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: lonCtrl,
            keyboardType:
                const TextInputType.numberWithOptions(decimal: true, signed: true),
            decoration: const InputDecoration(labelText: 'Longitude'),
          ),
        ]),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
          ElevatedButton(
            onPressed: () {
              s.setDouble(
                  'customLat', double.tryParse(latCtrl.text.trim()) ?? 0);
              s.setDouble(
                  'customLon', double.tryParse(lonCtrl.text.trim()) ?? 0);
              Navigator.pop(c);
            },
            child: const Text('Save'),
          ),
        ],
      ),
    );
  }

  Widget _userAgentTile() {
    final p = kUaPresets.firstWhere((u) => u.id == s.uaPresetId,
        orElse: () => kUaPresets.first);
    return ListTile(
      leading: const Icon(Icons.devices, color: AppTheme.accent),
      title: const Text('User-Agent', style: TextStyle(fontSize: 14.5)),
      subtitle: Text(
          s.customUa.isNotEmpty ? 'Custom' : p.label,
          style: const TextStyle(fontSize: 12, color: AppTheme.muted)),
      trailing: const Icon(Icons.chevron_right),
      onTap: () async {
        final chosen = await showModalBottomSheet<String>(
          context: context,
          backgroundColor: AppTheme.surface,
          builder: (c) => SafeArea(
            child: ListView(shrinkWrap: true, children: [
              ...kUaPresets.map((u) => ListTile(
                    title: Text(u.label),
                    trailing: s.uaPresetId == u.id && s.customUa.isEmpty
                        ? const Icon(Icons.check, color: AppTheme.accent)
                        : null,
                    onTap: () => Navigator.pop(c, u.id),
                  )),
              ListTile(
                leading: const Icon(Icons.edit),
                title: const Text('Custom user-agent…'),
                onTap: () => Navigator.pop(c, '__custom__'),
              ),
            ]),
          ),
        );
        if (chosen == null) return;
        if (chosen == '__custom__') {
          await _customUa();
        } else {
          await s.setString('uaPresetId', chosen);
          await s.setString('customUa', '');
        }
      },
    );
  }

  Future<void> _customUa() async {
    final ctrl = TextEditingController(text: s.customUa);
    await showDialog(
      context: context,
      builder: (c) => AlertDialog(
        backgroundColor: AppTheme.surface,
        title: const Text('Custom User-Agent'),
        content: TextField(
          controller: ctrl,
          maxLines: 4,
          decoration: const InputDecoration(hintText: 'Mozilla/5.0 …'),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
          ElevatedButton(
            onPressed: () {
              s.setString('customUa', ctrl.text.trim());
              Navigator.pop(c);
            },
            child: const Text('Save'),
          ),
        ],
      ),
    );
  }

  Widget _zoomTile() {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Text zoom: ${s.textZoom.round()}%',
              style: const TextStyle(fontSize: 14.5)),
          Slider(
            value: s.textZoom.clamp(50, 250),
            min: 50,
            max: 250,
            divisions: 20,
            activeColor: AppTheme.accent,
            label: '${s.textZoom.round()}%',
            onChanged: (v) => s.setDouble('textZoom', v),
          ),
        ],
      ),
    );
  }

  Widget _searchEngineTile() {
    const engines = {
      'google': 'Google',
      'bing': 'Bing',
      'duckduckgo': 'DuckDuckGo',
      'brave': 'Brave',
      'startpage': 'Startpage',
    };
    return ListTile(
      leading: const Icon(Icons.search, color: AppTheme.accent),
      title: const Text('Search engine', style: TextStyle(fontSize: 14.5)),
      subtitle: Text(engines[s.searchEngine] ?? 'Google',
          style: const TextStyle(fontSize: 12, color: AppTheme.muted)),
      trailing: const Icon(Icons.chevron_right),
      onTap: () async {
        final chosen = await showModalBottomSheet<String>(
          context: context,
          backgroundColor: AppTheme.surface,
          builder: (c) => SafeArea(
            child: ListView(
              shrinkWrap: true,
              children: engines.entries
                  .map((e) => ListTile(
                        title: Text(e.value),
                        trailing: s.searchEngine == e.key
                            ? const Icon(Icons.check, color: AppTheme.accent)
                            : null,
                        onTap: () => Navigator.pop(c, e.key),
                      ))
                  .toList(),
            ),
          ),
        );
        if (chosen != null) await s.setString('searchEngine', chosen);
      },
    );
  }

  Widget _homepageTile() {
    return ListTile(
      leading: const Icon(Icons.home, color: AppTheme.accent),
      title: const Text('Homepage', style: TextStyle(fontSize: 14.5)),
      subtitle: Text(s.homepage,
          style: const TextStyle(fontSize: 12, color: AppTheme.muted)),
      trailing: const Icon(Icons.edit, size: 18),
      onTap: () async {
        final ctrl = TextEditingController(text: s.homepage);
        await showDialog(
          context: context,
          builder: (c) => AlertDialog(
            backgroundColor: AppTheme.surface,
            title: const Text('Homepage URL'),
            content: TextField(controller: ctrl),
            actions: [
              TextButton(
                  onPressed: () => Navigator.pop(c),
                  child: const Text('Cancel')),
              ElevatedButton(
                onPressed: () {
                  var v = ctrl.text.trim();
                  if (v.isNotEmpty && !v.startsWith('http')) v = 'https://$v';
                  if (v.isNotEmpty) s.setString('homepage', v);
                  Navigator.pop(c);
                },
                child: const Text('Save'),
              ),
            ],
          ),
        );
      },
    );
  }

  Widget _proxyTile() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (s.autoProxy)
            const Padding(
              padding: EdgeInsets.only(bottom: 6),
              child: Text(
                  'Auto mode is ON — a live free proxy in your chosen country is used. Manual host/port below override it.',
                  style: TextStyle(fontSize: 11, color: AppTheme.muted)),
            ),
          Row(children: [
            Expanded(
              flex: 3,
              child: TextField(
                controller: TextEditingController(text: s.proxyHost),
                decoration: const InputDecoration(
                    labelText: 'Manual proxy host (optional)'),
                onChanged: (v) => s.proxyHost = v.trim(),
                onSubmitted: (v) => s.setString('proxyHost', v.trim()),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: TextField(
                controller: TextEditingController(
                    text: s.proxyPort == 0 ? '' : s.proxyPort.toString()),
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(labelText: 'Port'),
                onChanged: (v) => s.proxyPort = int.tryParse(v.trim()) ?? 0,
                onSubmitted: (v) =>
                    s.setInt('proxyPort', int.tryParse(v.trim()) ?? 0),
              ),
            ),
          ]),
          const SizedBox(height: 6),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton.icon(
              icon: const Icon(Icons.save, size: 16),
              label: const Text('Save proxy'),
              onPressed: () async {
                await s.setString('proxyHost', s.proxyHost);
                await s.setInt('proxyPort', s.proxyPort);
                if (mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Proxy saved')),
                  );
                }
              },
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _resetAll() async {
    await s.setBool('stealthMode', true);
    await s.setString('geoPresetId', 'off');
    await s.setBool('spoofTimezone', true);
    await s.setBool('spoofLocale', true);
    await s.setBool('blockWebRTC', true);
    await s.setBool('spoofCanvas', true);
    await s.setBool('spoofWebGL', true);
    await s.setBool('spoofAudio', true);
    await s.setBool('hideAutomation', true);
    await s.setBool('spoofHardware', true);
    await s.setBool('spoofBattery', true);
    await s.setBool('spoofScreen', false);
    await s.setBool('doNotTrack', true);
    await s.setString('uaPresetId', 'default');
    await s.setString('customUa', '');
    await s.setBool('blockTrackers', true);
    await s.setBool('blockAds', true);
    await s.setBool('httpsOnly', true);
    await s.setBool('javascriptEnabled', true);
    await s.setBool('desktopMode', false);
    await s.setBool('loadImages', true);
    await s.setBool('darkWebsites', false);
    await s.setDouble('textZoom', 100);
    await s.setString('searchEngine', 'google');
    await s.setBool('useProxy', false);
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Settings reset to defaults')),
      );
    }
  }
}
