// music_repository.dart — the single brain that unifies all music sources.
//
// Mirrors Spotui's design: many independent providers feed one catalog, and the
// player asks the repository for a playable URL for any track. The repository
// picks the most reliable stream and, crucially, FALLS BACK across sources so a
// tap on a song essentially never dead-ends — the whole point of "works even
// when the backend is down".
import 'music_models.dart';
import 'audius_source.dart';
import 'ytmusic_source.dart';
import 'itunes_source.dart';

class MusicRepository {
  MusicRepository._();
  static final MusicRepository instance = MusicRepository._();

  /// Curated home feed. Audius trending is the backbone (full-length, reliable).
  Future<List<Track>> home() async {
    final t = await AudiusSource.instance.trending(limit: 30);
    return t;
  }

  /// Genre shelf for the home screen.
  Future<List<Track>> genre(String g) =>
      AudiusSource.instance.trending(genre: g, limit: 20);

  /// Unified search: query every source in parallel and merge, de-duplicating
  /// obvious repeats by "title + artist". Audius (full songs) is ranked first,
  /// then YouTube Music, then iTunes previews as a guaranteed fallback.
  Future<List<Track>> search(String query) async {
    final results = await Future.wait([
      AudiusSource.instance.search(query, limit: 25),
      YtMusicSource.instance.search(query, limit: 20),
      ItunesSource.instance.search(query, limit: 15),
    ]);

    final merged = <Track>[];
    final seen = <String>{};
    // Interleave a little so the list isn't 25 Audius then everything else.
    final buckets = results;
    var added = true;
    var idx = 0;
    while (added) {
      added = false;
      for (final b in buckets) {
        if (idx < b.length) {
          added = true;
          final t = b[idx];
          final dedupKey =
              '${t.title.toLowerCase().trim()}|${t.artist.toLowerCase().trim()}';
          if (seen.add(dedupKey)) merged.add(t);
        }
      }
      idx++;
    }
    return merged;
  }

  /// Resolve a directly-playable URL for a track, trying its own source first
  /// and then degrading gracefully to another source's version of the song.
  Future<String?> resolveStreamUrl(Track track) async {
    // 1) Already have a direct URL (iTunes preview, or a cached Audius url).
    if (track.directStreamUrl != null && track.directStreamUrl!.isNotEmpty) {
      return track.directStreamUrl;
    }

    // 2) Native resolution by the track's own source.
    switch (track.source) {
      case MusicSource.audius:
        final u = await AudiusSource.instance.streamUrl(track.id);
        if (u != null) return u;
        break;
      case MusicSource.ytmusic:
        final u = await YtMusicSource.instance.streamUrl(track.id);
        if (u != null) return u;
        break;
      case MusicSource.itunes:
        // handled above
        break;
    }

    // 3) Cross-source fallback: find the same song somewhere that will play.
    final q = '${track.title} ${track.artist}'.trim();
    // Try Audius first (full length).
    final ax = await AudiusSource.instance.search(q, limit: 3);
    if (ax.isNotEmpty) {
      final u = await AudiusSource.instance.streamUrl(ax.first.id);
      if (u != null) return u;
    }
    // Then a YouTube Music match (on-device).
    final yx = await YtMusicSource.instance.search(q, limit: 3);
    if (yx.isNotEmpty) {
      final u = await YtMusicSource.instance.streamUrl(yx.first.id);
      if (u != null) return u;
    }
    // Finally an iTunes preview — guaranteed to exist for mainstream songs.
    final ix = await ItunesSource.instance.search(q, limit: 3);
    if (ix.isNotEmpty && ix.first.directStreamUrl != null) {
      return ix.first.directStreamUrl;
    }
    return null;
  }
}
