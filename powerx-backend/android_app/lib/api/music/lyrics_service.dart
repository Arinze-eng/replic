// lyrics_service.dart — synced lyrics from LRCLIB (same provider Spotui uses).
//
// LRCLIB is a free, key-less lyrics database that returns LRC-formatted synced
// lyrics. We parse the [mm:ss.xx] timestamps into LyricLine objects so the Now
// Playing screen can highlight the current line as the song plays.
import 'dart:convert';
import 'package:http/http.dart' as http;
import 'music_models.dart';

class LyricsService {
  LyricsService._();
  static final LyricsService instance = LyricsService._();

  final Map<String, Lyrics> _cache = {};

  Future<Lyrics> fetch({
    required String title,
    required String artist,
    int durationSec = 0,
  }) async {
    final key = '$title|$artist';
    if (_cache.containsKey(key)) return _cache[key]!;

    Lyrics result = const Lyrics();
    try {
      // 1) Try the precise /get endpoint first (best match).
      final getUri = Uri.parse('https://lrclib.net/api/get').replace(
        queryParameters: {
          'track_name': title,
          'artist_name': artist,
          if (durationSec > 0) 'duration': '$durationSec',
        },
      );
      var r = await http.get(getUri, headers: {
        'User-Agent': 'WormUltraMusic v1 (github.com/Spotui)'
      }).timeout(const Duration(seconds: 12));

      Map<String, dynamic>? hit;
      if (r.statusCode == 200) {
        hit = jsonDecode(r.body) as Map<String, dynamic>;
      } else {
        // 2) Fall back to fuzzy search.
        final sUri = Uri.parse('https://lrclib.net/api/search').replace(
          queryParameters: {'track_name': title, 'artist_name': artist},
        );
        r = await http.get(sUri, headers: {
          'User-Agent': 'WormUltraMusic v1 (github.com/Spotui)'
        }).timeout(const Duration(seconds: 12));
        if (r.statusCode == 200) {
          final list = jsonDecode(r.body);
          if (list is List && list.isNotEmpty && list.first is Map) {
            hit = (list.first as Map).cast<String, dynamic>();
          }
        }
      }

      if (hit != null) {
        final synced = hit['syncedLyrics']?.toString() ?? '';
        final plain = hit['plainLyrics']?.toString() ?? '';
        result = Lyrics(synced: _parseLrc(synced), plain: plain);
      }
    } catch (_) {/* leave empty */}

    _cache[key] = result;
    return result;
  }

  List<LyricLine> _parseLrc(String lrc) {
    if (lrc.trim().isEmpty) return const [];
    final lines = <LyricLine>[];
    final tagRe = RegExp(r'\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]');
    for (final raw in lrc.split('\n')) {
      final matches = tagRe.allMatches(raw).toList();
      if (matches.isEmpty) continue;
      final text = raw.replaceAll(tagRe, '').trim();
      for (final m in matches) {
        final min = int.parse(m.group(1)!);
        final sec = int.parse(m.group(2)!);
        final frac = m.group(3);
        var ms = 0;
        if (frac != null) {
          ms = int.parse(frac.padRight(3, '0').substring(0, 3));
        }
        lines.add(LyricLine(
          Duration(minutes: min, seconds: sec, milliseconds: ms),
          text,
        ));
      }
    }
    lines.sort((a, b) => a.time.compareTo(b.time));
    return lines;
  }
}
