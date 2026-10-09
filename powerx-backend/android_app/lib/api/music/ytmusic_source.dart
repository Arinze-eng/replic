// ytmusic_source.dart — YouTube Music via the InnerTube API.
//
// This mirrors Spotui/Metrolist's core source. Search runs everywhere (no key);
// stream resolution runs ON THE PHONE, where the residential/mobile IP is NOT
// datacenter-blocked, so YouTube returns direct audio URLs to the ANDROID_VR /
// IOS clients (the same trick Metrolist uses). If YouTube ever refuses, the
// repository silently falls back to Audius/iTunes so playback never dead-ends.
import 'dart:convert';
import 'package:http/http.dart' as http;
import 'music_models.dart';

class YtMusicSource {
  YtMusicSource._();
  static final YtMusicSource instance = YtMusicSource._();

  static const _ytmHost = 'https://music.youtube.com';
  static const _ytHost = 'https://www.youtube.com';

  // ANDROID_MUSIC context — the client YT Music itself uses for search.
  Map<String, dynamic> get _musicContext => {
        'client': {
          'clientName': 'ANDROID_MUSIC',
          'clientVersion': '6.42.52',
          'androidSdkVersion': 30,
          'hl': 'en',
          'gl': 'US',
        }
      };

  // ANDROID_VR context — returns unciphered direct audio URLs on-device.
  Map<String, dynamic> get _vrContext => {
        'client': {
          'clientName': 'ANDROID_VR',
          'clientVersion': '1.62.27',
          'deviceMake': 'Oculus',
          'deviceModel': 'Quest 3',
          'androidSdkVersion': 32,
          'osName': 'Android',
          'osVersion': '12L',
          'hl': 'en',
          'gl': 'US',
        }
      };

  Map<String, dynamic> get _iosContext => {
        'client': {
          'clientName': 'IOS',
          'clientVersion': '19.45.4',
          'deviceModel': 'iPhone16,2',
          'osVersion': '18.1.0.22B83',
          'hl': 'en',
          'gl': 'US',
        }
      };

  // Recursively collect every string value for a key anywhere in the tree.
  void _collect(dynamic node, String key, List<dynamic> out) {
    if (node is Map) {
      for (final e in node.entries) {
        if (e.key == key) out.add(e.value);
        _collect(e.value, key, out);
      }
    } else if (node is List) {
      for (final v in node) {
        _collect(v, key, out);
      }
    }
  }

  String _runsText(dynamic runsHolder) {
    try {
      final runs = runsHolder['runs'] as List?;
      if (runs == null) return '';
      return runs.map((r) => (r['text'] ?? '').toString()).join();
    } catch (_) {
      return '';
    }
  }

  /// Search YouTube Music. `params` filters to Songs only.
  Future<List<Track>> search(String query, {int limit = 20}) async {
    if (query.trim().isEmpty) return [];
    try {
      final uri = Uri.parse('$_ytmHost/youtubei/v1/search?prettyPrint=false');
      final body = jsonEncode({
        'context': _musicContext,
        'query': query,
        // Filter: Songs
        'params': 'EgWKAQIIAWoKEAoQAxAEEAkQBQ%3D%3D',
      });
      final r = await http
          .post(uri,
              headers: {
                'Content-Type': 'application/json',
                'User-Agent':
                    'com.google.android.apps.youtube.music/6.42.52 (Linux; U; Android 11)',
                'X-Goog-Api-Format-Version': '1',
              },
              body: body)
          .timeout(const Duration(seconds: 15));
      if (r.statusCode != 200) return [];
      final data = jsonDecode(r.body);

      // Pull every musicResponsiveListItemRenderer (a song row) from the tree.
      final rows = <dynamic>[];
      _collect(data, 'musicResponsiveListItemRenderer', rows);

      final out = <Track>[];
      final seen = <String>{};
      for (final row in rows) {
        try {
          // videoId lives on a playlistItemData or a watch navigationEndpoint.
          final ids = <dynamic>[];
          _collect(row, 'videoId', ids);
          final videoId = ids.isNotEmpty ? ids.first?.toString() : null;
          if (videoId == null || videoId.isEmpty || !seen.add(videoId)) continue;

          // flexColumns[0] = title, others carry artist/album/duration text.
          final flex = row['flexColumns'] as List? ?? const [];
          String title = '';
          final subtitleParts = <String>[];
          for (var i = 0; i < flex.length; i++) {
            final txt = _runsText(flex[i]
                    ['musicResponsiveListItemFlexColumnRenderer']?['text'] ??
                const {});
            if (i == 0) {
              title = txt;
            } else if (txt.isNotEmpty) {
              subtitleParts.add(txt);
            }
          }
          if (title.isEmpty) continue;

          // The subtitle is like "Song • Artist • Album • 3:21".
          final joined = subtitleParts.join(' ');
          final segs = joined.split('•').map((s) => s.trim()).toList();
          String artist = '';
          int dur = 0;
          for (final s in segs) {
            final m = RegExp(r'^(\d+):(\d{2})$').firstMatch(s);
            if (m != null) {
              dur = int.parse(m.group(1)!) * 60 + int.parse(m.group(2)!);
            } else if (s.isNotEmpty &&
                s.toLowerCase() != 'song' &&
                artist.isEmpty) {
              artist = s;
            }
          }

          // thumbnail: last (largest) entry.
          final thumbs = <dynamic>[];
          _collect(row, 'thumbnails', thumbs);
          String? art;
          if (thumbs.isNotEmpty && thumbs.first is List && (thumbs.first as List).isNotEmpty) {
            art = (thumbs.first as List).last['url']?.toString();
          }

          out.add(Track(
            id: videoId,
            source: MusicSource.ytmusic,
            title: title,
            artist: artist.isEmpty ? 'YouTube Music' : artist,
            artworkUrl: art,
            durationSec: dur,
          ));
          if (out.length >= limit) break;
        } catch (_) {/* skip malformed row */}
      }
      return out;
    } catch (_) {
      return [];
    }
  }

  /// Resolve a direct audio stream URL for a videoId, ON DEVICE.
  /// Tries ANDROID_VR first, then IOS. Returns null if YouTube refuses (the
  /// repository then falls back to another source so playback never breaks).
  Future<String?> streamUrl(String videoId) async {
    for (final ctx in [_vrContext, _iosContext]) {
      try {
        final uri = Uri.parse('$_ytHost/youtubei/v1/player?prettyPrint=false');
        final body = jsonEncode({
          'context': ctx,
          'videoId': videoId,
          'contentCheckOk': true,
          'racyCheckOk': true,
        });
        final ua = (ctx['client'] as Map)['clientName'] == 'IOS'
            ? 'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1 like Mac OS X;)'
            : 'com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12L) gzip';
        final r = await http
            .post(uri,
                headers: {
                  'Content-Type': 'application/json',
                  'User-Agent': ua,
                  'X-Goog-Api-Format-Version': '2',
                },
                body: body)
            .timeout(const Duration(seconds: 15));
        if (r.statusCode != 200) continue;
        final data = jsonDecode(r.body);
        final status = data['playabilityStatus']?['status']?.toString();
        if (status != null && status != 'OK') continue;
        final formats =
            (data['streamingData']?['adaptiveFormats'] as List?) ?? const [];
        // Pick the highest-bitrate audio-only format that already has a URL.
        Map<String, dynamic>? best;
        int bestBr = -1;
        for (final f in formats) {
          if (f is! Map) continue;
          final mime = (f['mimeType'] ?? '').toString();
          if (!mime.contains('audio')) continue;
          if (f['url'] == null) continue; // ciphered → skip (VR/IOS aren't)
          final br = (f['bitrate'] is int)
              ? f['bitrate'] as int
              : int.tryParse('${f['bitrate']}') ?? 0;
          if (br > bestBr) {
            bestBr = br;
            best = f.cast<String, dynamic>();
          }
        }
        if (best != null) return best['url']?.toString();
      } catch (_) {/* try next client */}
    }
    return null;
  }
}
