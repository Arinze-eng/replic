// audius_source.dart — PRIMARY music source for Worm Ultra.
//
// Audius is a fully open, decentralised music network with a public HTTP API
// that needs NO API key and returns FULL-LENGTH, directly-streamable MP3s.
// This is the backbone that guarantees the player works even when Render is
// asleep — everything here talks straight to the Audius network from the phone.
//
// Docs: https://docs.audius.org/developers/api/
import 'dart:convert';
import 'dart:math';
import 'package:http/http.dart' as http;
import 'music_models.dart';

class AudiusSource {
  AudiusSource._();
  static final AudiusSource instance = AudiusSource._();

  static const String _appName = 'WormUltraMusic';

  // Some Audius edge gateways reject requests without a real UA (returning 403).
  // The Dart http client sets one by default, but we send an explicit browser-
  // like UA everywhere to be bulletproof across all discovery nodes.
  static const Map<String, String> _headers = {
    'User-Agent':
        'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) '
            'Chrome/120.0.0.0 Mobile Safari/537.36 WormUltraMusic/1.0',
    'Accept': 'application/json',
  };

  // Discovery nodes are picked dynamically from https://api.audius.co so we are
  // never tied to one host that might go down. We cache the chosen host and
  // rotate to another on failure.
  final List<String> _hosts = [];
  String? _host;
  final _rng = Random();

  Future<void> _ensureHost() async {
    if (_host != null) return;
    if (_hosts.isEmpty) {
      try {
        final r = await http
            .get(Uri.parse('https://api.audius.co'), headers: _headers)
            .timeout(const Duration(seconds: 12));
        if (r.statusCode == 200) {
          final data = jsonDecode(r.body);
          final list = (data['data'] as List?)?.cast<String>() ?? const [];
          _hosts
            ..clear()
            ..addAll(list.where((h) => h.startsWith('http')));
        }
      } catch (_) {/* fall through to hard-coded fallbacks */}
    }
    if (_hosts.isEmpty) {
      _hosts.addAll(const [
        'https://discoveryprovider.audius.co',
        'https://discoveryprovider2.audius.co',
        'https://discoveryprovider3.audius.co',
        'https://audius-discovery-1.altego.net',
      ]);
    }
    _host = _hosts[_rng.nextInt(_hosts.length)];
  }

  void _rotateHost() {
    if (_hosts.length <= 1) {
      _host = null;
      return;
    }
    final current = _host;
    final others = _hosts.where((h) => h != current).toList();
    _host = others[_rng.nextInt(others.length)];
  }

  Uri _u(String path, [Map<String, String>? q]) {
    final params = {'app_name': _appName, ...?q};
    return Uri.parse('$_host$path')
        .replace(queryParameters: params);
  }

  Track _toTrack(Map<String, dynamic> t) {
    final artwork = t['artwork'];
    String? art;
    if (artwork is Map) {
      art = (artwork['480x480'] ?? artwork['150x150'] ?? artwork['1000x1000'])
          ?.toString();
    }
    final user = t['user'];
    final artist = (user is Map ? user['name'] : null)?.toString() ?? 'Unknown';
    return Track(
      id: t['id'].toString(),
      source: MusicSource.audius,
      title: (t['title'] ?? 'Unknown').toString(),
      artist: artist,
      album: null,
      artworkUrl: art,
      durationSec: (t['duration'] is int)
          ? t['duration'] as int
          : int.tryParse('${t['duration']}') ?? 0,
      // Resolve the stream URL lazily via streamUrl() so it's always fresh.
      directStreamUrl: null,
    );
  }

  /// Full-text search across the Audius catalog.
  Future<List<Track>> search(String query, {int limit = 25}) async {
    if (query.trim().isEmpty) return [];
    for (var attempt = 0; attempt < 3; attempt++) {
      await _ensureHost();
      try {
        final r = await http
            .get(_u('/v1/tracks/search', {'query': query, 'limit': '$limit'}),
                headers: _headers)
            .timeout(const Duration(seconds: 15));
        if (r.statusCode == 200) {
          final data = jsonDecode(r.body);
          final list = (data['data'] as List?) ?? const [];
          return list
              .whereType<Map>()
              .map((e) => _toTrack(e.cast<String, dynamic>()))
              .toList();
        }
        _rotateHost();
      } catch (_) {
        _rotateHost();
      }
    }
    return [];
  }

  /// Curated "home" feed — the network's currently trending tracks.
  Future<List<Track>> trending({String genre = '', int limit = 30}) async {
    for (var attempt = 0; attempt < 3; attempt++) {
      await _ensureHost();
      try {
        final q = {'limit': '$limit', if (genre.isNotEmpty) 'genre': genre};
        final r = await http
            .get(_u('/v1/tracks/trending', q), headers: _headers)
            .timeout(const Duration(seconds: 15));
        if (r.statusCode == 200) {
          final data = jsonDecode(r.body);
          final list = (data['data'] as List?) ?? const [];
          return list
              .whereType<Map>()
              .map((e) => _toTrack(e.cast<String, dynamic>()))
              .toList();
        }
        _rotateHost();
      } catch (_) {
        _rotateHost();
      }
    }
    return [];
  }

  /// Resolve a directly-playable stream URL for an Audius track id.
  /// The endpoint 302-redirects to a signed CDN MP3; just_audio follows it.
  Future<String?> streamUrl(String trackId) async {
    await _ensureHost();
    // The stream endpoint itself is a stable, directly playable URL (it
    // redirects to the CDN). We hand this straight to the player.
    return _u('/v1/tracks/$trackId/stream', {'skip_play_count': 'false'})
        .toString();
  }
}
