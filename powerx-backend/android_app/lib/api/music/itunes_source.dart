// itunes_source.dart — universal fallback source.
//
// The Apple iTunes Search API needs no key, is always up, and returns clean
// metadata + high-res artwork + a 30-second AAC preview stream for virtually
// every commercial song. We use it to (a) enrich search with mainstream titles
// Audius may not have, and (b) guarantee there is ALWAYS something playable.
import 'dart:convert';
import 'package:http/http.dart' as http;
import 'music_models.dart';

class ItunesSource {
  ItunesSource._();
  static final ItunesSource instance = ItunesSource._();

  Future<List<Track>> search(String query, {int limit = 20}) async {
    if (query.trim().isEmpty) return [];
    try {
      final uri = Uri.parse('https://itunes.apple.com/search').replace(
        queryParameters: {
          'term': query,
          'media': 'music',
          'entity': 'song',
          'limit': '$limit',
        },
      );
      final r = await http.get(uri).timeout(const Duration(seconds: 15));
      if (r.statusCode != 200) return [];
      final data = jsonDecode(r.body);
      final list = (data['results'] as List?) ?? const [];
      final out = <Track>[];
      for (final e in list) {
        if (e is! Map) continue;
        final m = e.cast<String, dynamic>();
        final preview = m['previewUrl']?.toString();
        if (preview == null || preview.isEmpty) continue;
        // Upgrade the 100x100 thumb to a crisp 512px cover.
        var art = m['artworkUrl100']?.toString();
        if (art != null) art = art.replaceFirst('100x100bb', '512x512bb');
        final ms = (m['trackTimeMillis'] is int)
            ? m['trackTimeMillis'] as int
            : int.tryParse('${m['trackTimeMillis']}') ?? 0;
        out.add(Track(
          id: (m['trackId'] ?? preview).toString(),
          source: MusicSource.itunes,
          title: (m['trackName'] ?? 'Unknown').toString(),
          artist: (m['artistName'] ?? 'Unknown').toString(),
          album: m['collectionName']?.toString(),
          artworkUrl: art,
          // iTunes previews are 30s; show real track length as metadata.
          durationSec: ms > 0 ? ms ~/ 1000 : 30,
          directStreamUrl: preview, // already directly playable
        ));
      }
      return out;
    } catch (_) {
      return [];
    }
  }
}
