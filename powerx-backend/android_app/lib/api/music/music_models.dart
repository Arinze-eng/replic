// music_models.dart — data model for the self-contained Worm Ultra music client.
//
// Mirrors the Spotui/Metrolist architecture (a Track that can come from any of
// several independent sources), but is 100% on-device / server-independent so
// it keeps working even when the Render backend is asleep or down.

/// Where a track's *metadata* came from. The stream URL is resolved lazily so
/// we can pick the most reliable source at play-time (Spotui does the same:
/// metadata from one provider, audio from whichever backend answers first).
enum MusicSource { audius, ytmusic, itunes }

extension MusicSourceX on MusicSource {
  String get label {
    switch (this) {
      case MusicSource.audius:
        return 'Audius';
      case MusicSource.ytmusic:
        return 'YT Music';
      case MusicSource.itunes:
        return 'iTunes';
    }
  }

  String get id {
    switch (this) {
      case MusicSource.audius:
        return 'audius';
      case MusicSource.ytmusic:
        return 'ytmusic';
      case MusicSource.itunes:
        return 'itunes';
    }
  }
}

class Track {
  /// Source-scoped id (Audius track id, YouTube videoId, or iTunes trackId).
  final String id;
  final MusicSource source;
  final String title;
  final String artist;
  final String? album;

  /// Square cover art (highest available). May be null for a few YT items.
  final String? artworkUrl;

  /// Duration in whole seconds (0 = unknown; the player fills it in on load).
  final int durationSec;

  /// A ready-to-play direct URL when the source already gave us one
  /// (Audius/iTunes). For YT Music this stays null and is resolved on demand.
  final String? directStreamUrl;

  const Track({
    required this.id,
    required this.source,
    required this.title,
    required this.artist,
    this.album,
    this.artworkUrl,
    this.durationSec = 0,
    this.directStreamUrl,
  });

  /// Stable cross-source key so the same song from two providers doesn't create
  /// two queue/library entries.
  String get uniqueKey => '${source.id}:$id';

  String get durationLabel {
    if (durationSec <= 0) return '--:--';
    final m = durationSec ~/ 60;
    final s = durationSec % 60;
    return '$m:${s.toString().padLeft(2, '0')}';
  }

  Track copyWith({String? directStreamUrl, int? durationSec, String? artworkUrl}) {
    return Track(
      id: id,
      source: source,
      title: title,
      artist: artist,
      album: album,
      artworkUrl: artworkUrl ?? this.artworkUrl,
      durationSec: durationSec ?? this.durationSec,
      directStreamUrl: directStreamUrl ?? this.directStreamUrl,
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'source': source.id,
        'title': title,
        'artist': artist,
        'album': album,
        'artworkUrl': artworkUrl,
        'durationSec': durationSec,
        'directStreamUrl': directStreamUrl,
      };

  static Track fromJson(Map<String, dynamic> j) => Track(
        id: (j['id'] ?? '').toString(),
        source: MusicSource.values.firstWhere(
          (s) => s.id == j['source'],
          orElse: () => MusicSource.audius,
        ),
        title: (j['title'] ?? 'Unknown').toString(),
        artist: (j['artist'] ?? '').toString(),
        album: j['album']?.toString(),
        artworkUrl: j['artworkUrl']?.toString(),
        durationSec: (j['durationSec'] ?? 0) is int
            ? (j['durationSec'] ?? 0) as int
            : int.tryParse('${j['durationSec']}') ?? 0,
        directStreamUrl: j['directStreamUrl']?.toString(),
      );
}

/// One line of synced lyrics.
class LyricLine {
  final Duration time;
  final String text;
  const LyricLine(this.time, this.text);
}

class Lyrics {
  final List<LyricLine> synced; // empty if only plain text is available
  final String plain;
  const Lyrics({this.synced = const [], this.plain = ''});

  bool get hasSynced => synced.isNotEmpty;
  bool get isEmpty => synced.isEmpty && plain.trim().isEmpty;
}
