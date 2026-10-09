// remote_config_service.dart — pulls the admin-controlled config from the
// backend (GET /api/apk/config) so the admin has live control over the app.
//
// FIXED: Falls back to GitHub API when Render backend is asleep/down,
// so the in-app updater still works even when the server is cold-booting.

import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'api_config.dart';

// Keep in sync with pubspec.yaml `version: x.y.z+BUILD`.
const int kCurrentBuild = 69;
const String kCurrentVersion = '1.5.1';

const String _kGithubRepo = 'Arinze-eng/powerx';
const String _kApkAssetName = 'wormgpt-agent-arm64-v8a.apk';

class RemoteConfig {
  final Map<String, dynamic> raw;
  RemoteConfig(this.raw);

  // JSON responses normally provide Map<String, dynamic>, while tests and
  // defensive defaults can produce Map<dynamic, dynamic>. Normalize instead of
  // using an unsafe runtime cast that can crash the app gate during startup.
  Map<String, dynamic> _section(String key) {
    final value = raw[key];
    if (value is Map<String, dynamic>) return value;
    if (value is Map) {
      return value.map((k, v) => MapEntry(k.toString(), v));
    }
    return const <String, dynamic>{};
  }

  Map<String, dynamic> get _branding => _section('branding');
  Map<String, dynamic> get _features => _section('features');
  Map<String, dynamic> get _announcement => _section('announcement');
  Map<String, dynamic> get _maintenance => _section('maintenance');
  Map<String, dynamic> get _update => _section('update');
  Map<String, dynamic> get _limits => _section('limits');

  String get appName => (_branding['app_name'] ?? 'WormGPT Agent').toString();
  String get tagline => (_branding['tagline'] ?? '').toString();
  String get primaryColor => (_branding['primary_color'] ?? '#7c3aed').toString();
  bool get announcementActive => _announcement['active'] == true;
  String get announcementMessage => (_announcement['message'] ?? '').toString();
  bool get maintenanceActive => _maintenance['active'] == true;
  String get maintenanceMessage => (_maintenance['message'] ?? '').toString();

  bool feature(String key) => _features[key] != false;
  bool get chat => feature('chat');
  bool get wormgpt => feature('wormgpt');
  bool get agent => feature('agent');
  bool get lemon => feature('lemon');
  bool get tools => feature('tools');
  bool get payments => feature('payments');
  bool get signup => feature('signup');
  bool get imageGen => feature('image_gen');
  bool get fileUpload => feature('file_upload');

  int get freeDailyLimit => (_limits['free_daily_limit'] ?? 20) as int;
  int get maxUploadMb => (_limits['max_upload_mb'] ?? 25) as int;

  bool get updateAvailable => _update['available'] == true;
  bool get updateRequired => _update['required'] == true;
  bool get updateForced => _update['forced'] == true;
  String get latestVersion => (_update['latest_version'] ?? '').toString();
  int get latestBuild => (_update['latest_build'] ?? 0) as int;
  String get downloadUrl => (_update['download_url'] ?? '').toString();
  String get updateTitle => (_update['title'] ?? 'Update available').toString();
  String get updateMessage => (_update['message'] ?? '').toString();
  String get changelog => (_update['changelog'] ?? '').toString();
}

class RemoteConfigService extends ChangeNotifier {
  RemoteConfigService._();
  static final RemoteConfigService instance = RemoteConfigService._();

  RemoteConfig? config;
  bool loaded = false;
  String? error;

  /// FIXED: Falls back to GitHub API when Render backend is down
  Future<RemoteConfig?> fetch() async {
    try {
      // Try Render backend first
      final uri = ApiConfig.uri('/api/apk/config?build=$kCurrentBuild');
      final r = await http
          .get(uri, headers: {
            'X-Client-Platform': 'apk',
            'X-Client-Build': '$kCurrentBuild'
          })
          .timeout(const Duration(seconds: 10));
      
      if (r.statusCode == 200) {
        final data = jsonDecode(r.body) as Map<String, dynamic>;
        config = RemoteConfig(data);
        error = null;
        loaded = true;
        notifyListeners();
        return config;
      }
    } catch (e) {
      if (kDebugMode) debugPrint('RemoteConfig backend failed, trying GitHub API: $e');
    }
    
    // Fallback: resolve via GitHub API directly (Render-independent)
    try {
      final ghConfig = await _fetchFromGithub();
      if (ghConfig != null) {
        config = ghConfig;
        error = null;
        loaded = true;
        notifyListeners();
        return config;
      }
    } catch (e) {
      if (kDebugMode) debugPrint('RemoteConfig GitHub fallback also failed: $e');
    }
    
    // Ultimate fallback: create a minimal config that just allows the app to run
    config = RemoteConfig({
      'update': {
        'available': false,
        'required': false,
        'forced': false,
        'latest_version': kCurrentVersion,
        'latest_build': kCurrentBuild,
        'client_build': kCurrentBuild,
        'download_url': 'https://github.com/$_kGithubRepo/releases/latest/download/$_kApkAssetName',
      },
      'features': {
        'chat': true, 'wormgpt': true, 'agent': true, 'tools': true,
        'payments': true, 'signup': true, 'image_gen': true, 'file_upload': true,
      },
      'branding': {
        'app_name': 'WormGPT Agent',
        'tagline': 'All-in-one AI',
        'primary_color': '#7c3aed',
      },
    });
    error = 'Could not reach server';
    loaded = true;
    notifyListeners();
    return config;
  }
  
  /// Fetch the latest release info from GitHub API directly
  Future<RemoteConfig?> _fetchFromGithub() async {
    try {
      final r = await http.get(
        Uri.parse('https://api.github.com/repos/$_kGithubRepo/releases/latest'),
        headers: {
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'wormgpt-agent',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      ).timeout(const Duration(seconds: 10));
      
      if (r.statusCode != 200) return null;
      
      final data = jsonDecode(r.body) as Map<String, dynamic>;
      final tagName = (data['tag_name'] ?? '').toString();
      final assets = (data['assets'] as List?) ?? [];
      
      // Parse version and build from tag (e.g. v1.5.0+68)
      final tagMatch = RegExp(r'v?(\d+\.\d+\.\d+)\+?(\d+)?').firstMatch(tagName);
      final ghVersion = tagMatch?.group(1) ?? kCurrentVersion;
      final ghBuild = int.tryParse(tagMatch?.group(2) ?? '') ?? kCurrentBuild;
      
      // Find the APK asset
      String? downloadUrl;
      for (final asset in assets) {
        final name = (asset['name'] ?? '').toString().toLowerCase();
        if (name == _kApkAssetName.toLowerCase() || name.endsWith('.apk')) {
          downloadUrl = asset['browser_download_url']?.toString();
          if (downloadUrl != null && downloadUrl.isNotEmpty) break;
        }
      }
      
      // Fallback to static URL
      downloadUrl ??= 'https://github.com/$_kGithubRepo/releases/latest/download/$_kApkAssetName';
      
      final available = ghBuild > kCurrentBuild;
      
      return RemoteConfig({
        'update': {
          'available': available,
          'required': false,
          'forced': false,
          'latest_version': ghVersion,
          'latest_build': ghBuild,
          'client_build': kCurrentBuild,
          'download_url': downloadUrl,
          'title': 'Update available',
          'message': 'A new version of the app is available.',
          'changelog': (data['body'] ?? '').toString(),
        },
        'features': {
          'chat': true, 'wormgpt': true, 'agent': true, 'tools': true,
          'payments': true, 'signup': true, 'image_gen': true, 'file_upload': true,
        },
        'branding': {
          'app_name': 'WormGPT Agent',
          'tagline': 'All-in-one AI',
          'primary_color': '#7c3aed',
        },
      });
    } catch (_) {
      return null;
    }
  }
}