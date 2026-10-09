// app_updater.dart — in-app APK updater for Android.
//
// The OLD updater just opened the download URL in a browser (launchUrl), which
// dumped the user into a confusing external download + manual install flow (and
// broke entirely when the configured URL pointed at a GitHub Actions *run* page
// instead of a direct .apk). This updater does it PROPERLY, all in-app:
//
//   1. DOWNLOAD the .apk straight from the backend-provided direct URL
//      (RemoteConfig.downloadUrl → stable GitHub Release asset) into the app's
//      cache dir, streaming bytes so we can show a live progress bar.
//   2. INSTALL by opening the downloaded file with OpenFilex, which hands the
//      .apk to Android's system Package Installer via our FileProvider. The user
//      just taps "Install" on the system prompt — no browser, no file manager.
//
// Requires (configured in AndroidManifest.xml):
//   • REQUEST_INSTALL_PACKAGES permission
//   • a <provider> FileProvider (authority "<applicationId>.fileprovider")
//   • res/xml/file_paths.xml exposing the cache dir
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:open_filex/open_filex.dart';
import 'package:path_provider/path_provider.dart';

/// Phase of the in-app update flow (drives the dialog UI).
enum UpdatePhase { idle, downloading, downloaded, installing, error }

/// GitHub repo that publishes the APK release (used for the RENDER-INDEPENDENT
/// fallback so updates keep working even when the Render backend is asleep).
///
/// FIX: this MUST match the repo the build-apk workflow publishes releases to
/// (Arinze-eng/powerx) and the repo used by remote_config_service.dart. It was
/// previously pointing at the stale 'Arinze-eng/Netlify' repo, so the updater's
/// Render-independent fallback resolved the APK from the WRONG repo and the
/// in-app update failed with "server returned a web page, not an APK" / 404
/// whenever the admin released a new build. Keeping it in sync with
/// remote_config_service.dart is what lets users download updates without errors.
const String _kGithubRepo = 'Arinze-eng/powerx';
const String _kApkAssetName = 'wormgpt-agent-arm64-v8a.apk';

/// The stable, public, static GitHub Release URL for the latest APK. This works
/// with NO backend at all — GitHub 302-redirects it to the signed CDN asset.
const String kStaticGithubApkUrl =
    'https://github.com/$_kGithubRepo/releases/latest/download/$_kApkAssetName';

/// Streams download progress + drives the install step. One per update attempt.
class AppUpdater extends ChangeNotifier {
  UpdatePhase phase = UpdatePhase.idle;
  double progress = 0.0; // 0..1 (may stay 0 if server sends no Content-Length)
  int received = 0;
  int total = 0;
  String? error;
  String? _apkPath;

  bool get isBusy =>
      phase == UpdatePhase.downloading || phase == UpdatePhase.installing;

  String get progressLabel {
    if (total > 0) {
      final mb = (received / (1024 * 1024));
      final tmb = (total / (1024 * 1024));
      return '${mb.toStringAsFixed(1)} / ${tmb.toStringAsFixed(1)} MB';
    }
    final mb = (received / (1024 * 1024));
    return '${mb.toStringAsFixed(1)} MB';
  }

  /// Whether [url] is something we can actually download an APK from. We accept:
  ///   • any direct `.apk` URL (CDN, GitHub signed asset, …)
  ///   • our backend resolver endpoint  …/api/apk/download  (302 → signed .apk)
  ///   • the static GitHub Release URL   github.com/…/releases/…/download/….apk
  /// (These last two don't literally end in ".apk" but resolve to one, which is
  /// exactly why the OLD `.endsWith('.apk')` check wrongly rejected the update.)
  bool _isAcceptableUrl(String url) {
    final s = url.trim().toLowerCase();
    if (!s.startsWith('http://') && !s.startsWith('https://')) return false;
    if (s.contains('/actions/runs/') || s.contains('/suites/')) return false; // CI pages
    if (s.contains('/api/apk/download')) return true; // backend resolver → 302 to .apk
    if (s.contains('github.com/') && s.contains('/releases/')) return true; // release URL
    return RegExp(r'\.apk(\?|#|$)').hasMatch(s);
  }

  /// Ask GitHub's public API for the latest release's APK asset and return a
  /// working, unauthenticated direct-download URL — with NO backend involved.
  /// This keeps updates working even when the Render backend is asleep/down.
  Future<String?> _resolveGithubApkUrl() async {
    try {
      final r = await http.get(
        Uri.parse('https://api.github.com/repos/$_kGithubRepo/releases/latest'),
        headers: {
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'wormgpt-agent',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      ).timeout(const Duration(seconds: 15));
      if (r.statusCode != 200) return null;
      final data = jsonDecode(r.body) as Map<String, dynamic>;
      final assets = (data['assets'] as List?) ?? const [];
      Map? chosen;
      for (final a in assets) {
        final name = (a['name'] ?? '').toString().toLowerCase();
        if (name == _kApkAssetName.toLowerCase()) {
          chosen = a as Map;
          break;
        }
      }
      chosen ??= assets
          .cast<Map?>()
          .firstWhere(
            (a) => (a?['name'] ?? '').toString().toLowerCase().endsWith('.apk'),
            orElse: () => null,
          );
      final url = chosen?['browser_download_url']?.toString();
      return (url != null && url.isNotEmpty) ? url : null;
    } catch (_) {
      return null;
    }
  }

  /// Download the APK, streaming progress. [url] is the backend-provided URL
  /// (may be our resolver endpoint). Returns the local file path on success.
  ///
  /// Resilience: we try the given URL first, then — so updates never depend on
  /// Render being awake — fall back to resolving the latest APK straight from
  /// the GitHub Releases API, then to the static GitHub Release URL.
  Future<String?> download(String url) async {
    // Build an ordered, de-duplicated list of candidate URLs to try.
    final candidates = <String>[];
    void add(String? u) {
      if (u == null) return;
      final t = u.trim();
      if (t.isNotEmpty && _isAcceptableUrl(t) && !candidates.contains(t)) {
        candidates.add(t);
      }
    }

    add(url);
    // Render-independent fallbacks (resolved lazily below).
    final ghDirect = await _resolveGithubApkUrl();
    add(ghDirect);
    add(kStaticGithubApkUrl);

    if (candidates.isEmpty) {
      phase = UpdatePhase.error;
      error = 'No valid update link available. Please try again later.';
      notifyListeners();
      return null;
    }

    Object? lastErr;
    for (final candidate in candidates) {
      final path = await _downloadOne(candidate);
      if (path != null) return path;
      lastErr = error;
    }

    phase = UpdatePhase.error;
    error = 'Download failed${lastErr != null ? ': $lastErr' : '.'}';
    notifyListeners();
    return null;
  }

  /// Attempt a single download from [url]. Returns the local path or null and
  /// leaves [error] set on failure (so the caller can try the next candidate).
  Future<String?> _downloadOne(String url) async {
    phase = UpdatePhase.downloading;
    progress = 0;
    received = 0;
    total = 0;
    error = null;
    notifyListeners();

    final client = http.Client();
    try {
      final req = http.Request('GET', Uri.parse(url));
      // GitHub release assets / our resolver 302-redirect to a CDN; http follows.
      final resp = await client.send(req).timeout(const Duration(minutes: 5));
      if (resp.statusCode != 200) {
        throw 'HTTP ${resp.statusCode}';
      }
      final ctype = (resp.headers['content-type'] ?? '').toLowerCase();
      // Guard against getting an HTML error page instead of the APK bytes.
      if (ctype.contains('text/html')) {
        throw 'server returned a web page, not an APK';
      }
      total = resp.contentLength ?? 0;

      final dir = await getApplicationCacheDirectory();
      final outDir = Directory('${dir.path}/updates');
      if (!await outDir.exists()) await outDir.create(recursive: true);
      // Fresh filename each time so an interrupted/old download can't be reused.
      final ts = DateTime.now().millisecondsSinceEpoch;
      final path = '${outDir.path}/wormgpt-agent-$ts.apk';
      final file = File(path);
      final sink = file.openWrite();

      await for (final chunk in resp.stream) {
        sink.add(chunk);
        received += chunk.length;
        if (total > 0) progress = (received / total).clamp(0.0, 1.0);
        notifyListeners();
      }
      await sink.flush();
      await sink.close();

      if (received <= 0) throw 'downloaded an empty file';

      _apkPath = path;
      phase = UpdatePhase.downloaded;
      progress = 1.0;
      notifyListeners();
      return path;
    } on TimeoutException {
      error = 'timed out';
      if (kDebugMode) debugPrint('AppUpdater timeout on $url');
      return null;
    } catch (e) {
      error = '$e';
      if (kDebugMode) debugPrint('AppUpdater download error on $url: $e');
      return null;
    } finally {
      client.close();
    }
  }

  /// Open the downloaded APK with the system Package Installer (via FileProvider).
  /// The user confirms the install on Android's native prompt.
  Future<bool> install() async {
    if (_apkPath == null) return false;
    phase = UpdatePhase.installing;
    notifyListeners();
    try {
      final result = await OpenFilex.open(
        _apkPath!,
        type: 'application/vnd.android.package-archive',
      );
      // result.type: done | fileNotFound | noAppToOpen | permissionDenied | error
      if (result.type == ResultType.done) {
        phase = UpdatePhase.downloaded; // installer launched; keep button usable
        notifyListeners();
        return true;
      }
      phase = UpdatePhase.error;
      error = _installErrorFor(result.type, result.message);
      notifyListeners();
      return false;
    } catch (e) {
      phase = UpdatePhase.error;
      error = 'Could not open the installer: $e';
      notifyListeners();
      return false;
    }
  }

  String _installErrorFor(ResultType type, String message) {
    switch (type) {
      case ResultType.permissionDenied:
        return 'Please allow "Install unknown apps" for WormGPT Agent, then tap Install again.';
      case ResultType.noAppToOpen:
        return 'No package installer found on this device.';
      case ResultType.fileNotFound:
        return 'The downloaded update was not found. Tap Download again.';
      default:
        return message.isNotEmpty ? message : 'Install failed. Please try again.';
    }
  }
}
