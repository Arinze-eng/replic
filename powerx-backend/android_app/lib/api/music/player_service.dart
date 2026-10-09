// player_service.dart — the playback engine for Worm Ultra music.
//
// Built on just_audio (which uses ExoPlayer/media3 on Android — the SAME native
// engine Spotui uses) + just_audio_background for a lock-screen/notification
// media session and background playback. It owns the queue, resolves stream
// URLs through the MusicRepository (with cross-source fallback), and exposes a
// ChangeNotifier so every screen (mini-player, now-playing) stays in sync.
import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:just_audio/just_audio.dart';
import 'package:just_audio_background/just_audio_background.dart';
import 'music_models.dart';
import 'music_repository.dart';

enum RepeatMode { off, all, one }

class PlayerService extends ChangeNotifier {
  PlayerService._();
  static final PlayerService instance = PlayerService._();

  final AudioPlayer _player = AudioPlayer();
  AudioPlayer get raw => _player;

  final List<Track> _queue = [];
  int _index = -1;
  bool _initialized = false;
  bool _preparing = false;
  String? _lastError;

  RepeatMode _repeat = RepeatMode.off;
  bool _shuffle = false;

  List<Track> get queue => List.unmodifiable(_queue);
  int get index => _index;
  Track? get current => (_index >= 0 && _index < _queue.length) ? _queue[_index] : null;
  bool get isPreparing => _preparing;
  String? get lastError => _lastError;
  RepeatMode get repeat => _repeat;
  bool get shuffle => _shuffle;

  bool get isPlaying => _player.playing;
  Stream<PlayerState> get playerStateStream => _player.playerStateStream;
  Stream<Duration> get positionStream => _player.positionStream;
  Stream<Duration?> get durationStream => _player.durationStream;
  Duration get position => _player.position;
  Duration? get duration => _player.duration;

  void init() {
    if (_initialized) return;
    _initialized = true;
    // Auto-advance when a track finishes.
    _player.processingStateStream.listen((state) {
      if (state == ProcessingState.completed) {
        _onCompleted();
      }
    });
    _player.playerStateStream.listen((_) => notifyListeners());
  }

  Future<void> _onCompleted() async {
    if (_repeat == RepeatMode.one) {
      await _player.seek(Duration.zero);
      await _player.play();
      return;
    }
    await next(auto: true);
  }

  /// Replace the queue and start playing at [startIndex].
  Future<void> playQueue(List<Track> tracks, {int startIndex = 0}) async {
    init();
    _queue
      ..clear()
      ..addAll(tracks);
    _index = startIndex.clamp(0, tracks.isEmpty ? 0 : tracks.length - 1);
    notifyListeners();
    await _loadCurrent(autoplay: true);
  }

  /// Play a single track immediately (used from search/home taps). Keeps the
  /// rest of the list as an up-next queue.
  Future<void> playTrack(Track track, {List<Track>? context}) async {
    init();
    if (context != null && context.isNotEmpty) {
      final i = context.indexWhere((t) => t.uniqueKey == track.uniqueKey);
      await playQueue(context, startIndex: i < 0 ? 0 : i);
    } else {
      await playQueue([track], startIndex: 0);
    }
  }

  void addToQueue(Track t) {
    _queue.add(t);
    if (_index < 0) _index = 0;
    notifyListeners();
  }

  Future<void> _loadCurrent({bool autoplay = true}) async {
    final track = current;
    if (track == null) return;
    _preparing = true;
    _lastError = null;
    notifyListeners();
    try {
      final url = await MusicRepository.instance.resolveStreamUrl(track);
      if (url == null) {
        _lastError = 'No playable stream found for “${track.title}”.';
        _preparing = false;
        notifyListeners();
        // Skip a dead track automatically if we're in a queue.
        if (_queue.length > 1) await next(auto: true);
        return;
      }
      final source = AudioSource.uri(
        Uri.parse(url),
        tag: MediaItem(
          id: track.uniqueKey,
          title: track.title,
          artist: track.artist,
          album: track.album ?? track.source.label,
          artUri: (track.artworkUrl != null && track.artworkUrl!.isNotEmpty)
              ? Uri.parse(track.artworkUrl!)
              : null,
          duration: track.durationSec > 0
              ? Duration(seconds: track.durationSec)
              : null,
        ),
      );
      await _player.setAudioSource(source);
      _preparing = false;
      notifyListeners();
      if (autoplay) await _player.play();
    } catch (e) {
      _preparing = false;
      _lastError = 'Playback error: $e';
      notifyListeners();
      if (_queue.length > 1) await next(auto: true);
    }
  }

  Future<void> togglePlay() async {
    if (_player.playing) {
      await _player.pause();
    } else {
      await _player.play();
    }
  }

  Future<void> seek(Duration d) => _player.seek(d);

  Future<void> next({bool auto = false}) async {
    if (_queue.isEmpty) return;
    if (_shuffle && _queue.length > 1) {
      var n = _index;
      while (n == _index) {
        n = (DateTime.now().microsecondsSinceEpoch) % _queue.length;
      }
      _index = n;
    } else if (_index < _queue.length - 1) {
      _index++;
    } else if (_repeat == RepeatMode.all) {
      _index = 0;
    } else {
      // End of queue.
      if (auto) await _player.pause();
      return;
    }
    notifyListeners();
    await _loadCurrent(autoplay: true);
  }

  Future<void> previous() async {
    if (_queue.isEmpty) return;
    // Restart current track if we're >3s in (standard music-player behaviour).
    if (_player.position > const Duration(seconds: 3)) {
      await _player.seek(Duration.zero);
      return;
    }
    if (_index > 0) {
      _index--;
    } else if (_repeat == RepeatMode.all) {
      _index = _queue.length - 1;
    }
    notifyListeners();
    await _loadCurrent(autoplay: true);
  }

  void cycleRepeat() {
    _repeat = RepeatMode.values[(_repeat.index + 1) % RepeatMode.values.length];
    notifyListeners();
  }

  void toggleShuffle() {
    _shuffle = !_shuffle;
    notifyListeners();
  }

  Future<void> retryCurrent() => _loadCurrent(autoplay: true);
}
