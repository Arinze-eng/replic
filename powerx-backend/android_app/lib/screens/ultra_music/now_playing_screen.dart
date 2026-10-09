// now_playing_screen.dart — full-screen Spotify-style player with big artwork,
// seek bar, transport controls, shuffle/repeat, up-next queue, and live SYNCED
// LYRICS (from LRCLIB, exactly like Spotui) that highlight the current line.
import 'package:flutter/material.dart' hide RepeatMode;
import 'package:just_audio/just_audio.dart';
import '../../api/music/player_service.dart';
import '../../api/music/music_models.dart';
import '../../api/music/lyrics_service.dart';
import '../../theme.dart';

class NowPlayingScreen extends StatefulWidget {
  const NowPlayingScreen({super.key});

  @override
  State<NowPlayingScreen> createState() => _NowPlayingScreenState();
}

class _NowPlayingScreenState extends State<NowPlayingScreen> {
  bool _showLyrics = false;
  Lyrics? _lyrics;
  String? _lyricsForKey;
  final ScrollController _lyricScroll = ScrollController();

  final _player = PlayerService.instance;

  @override
  void initState() {
    super.initState();
    _player.addListener(_onPlayerChange);
    _maybeLoadLyrics();
  }

  @override
  void dispose() {
    _player.removeListener(_onPlayerChange);
    _lyricScroll.dispose();
    super.dispose();
  }

  void _onPlayerChange() {
    if (mounted) {
      setState(() {});
      _maybeLoadLyrics();
    }
  }

  Future<void> _maybeLoadLyrics() async {
    final t = _player.current;
    if (t == null) return;
    if (_lyricsForKey == t.uniqueKey) return;
    _lyricsForKey = t.uniqueKey;
    _lyrics = null;
    final lyr = await LyricsService.instance.fetch(
      title: t.title,
      artist: t.artist,
      durationSec: t.durationSec,
    );
    if (mounted && _lyricsForKey == t.uniqueKey) {
      setState(() => _lyrics = lyr);
    }
  }

  String _fmt(Duration d) {
    final m = d.inMinutes;
    final s = d.inSeconds % 60;
    return '$m:${s.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final track = _player.current;
    if (track == null) {
      return const Scaffold(body: Center(child: Text('Nothing playing')));
    }
    return Scaffold(
      appBar: AppBar(
        title: const Text('Now Playing', style: TextStyle(fontSize: 15)),
        leading: IconButton(
          icon: const Icon(Icons.keyboard_arrow_down_rounded, size: 30),
          onPressed: () => Navigator.of(context).maybePop(),
        ),
        actions: [
          IconButton(
            tooltip: 'Queue',
            icon: const Icon(Icons.queue_music_rounded),
            onPressed: _openQueue,
          ),
        ],
      ),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(22, 6, 22, 16),
          child: Column(
            children: [
              Expanded(
                child: _showLyrics ? _lyricsView() : _artworkView(track),
              ),
              const SizedBox(height: 14),
              Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(track.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                                fontSize: 20, fontWeight: FontWeight.w800)),
                        const SizedBox(height: 4),
                        Text('${track.artist} · ${track.source.label}',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                                color: AppTheme.muted, fontSize: 14)),
                      ],
                    ),
                  ),
                  IconButton(
                    tooltip: _showLyrics ? 'Show artwork' : 'Show lyrics',
                    onPressed: () => setState(() => _showLyrics = !_showLyrics),
                    icon: Icon(
                      _showLyrics ? Icons.image_outlined : Icons.lyrics_outlined,
                      color: _showLyrics ? AppTheme.accent : AppTheme.text,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              _seekBar(),
              const SizedBox(height: 4),
              _controls(),
              if (_player.lastError != null)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(_player.lastError!,
                      style: const TextStyle(color: AppTheme.danger, fontSize: 12)),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _artworkView(Track track) {
    return Center(
      child: AspectRatio(
        aspectRatio: 1,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(18),
          child: (track.artworkUrl != null && track.artworkUrl!.isNotEmpty)
              ? Image.network(
                  track.artworkUrl!,
                  fit: BoxFit.cover,
                  errorBuilder: (_, __, ___) => _artPlaceholder(),
                )
              : _artPlaceholder(),
        ),
      ),
    );
  }

  Widget _artPlaceholder() => Container(
        color: AppTheme.surface,
        child: const Center(
            child: Icon(Icons.music_note, size: 90, color: AppTheme.muted)),
      );

  Widget _lyricsView() {
    final lyr = _lyrics;
    if (lyr == null) {
      return const Center(child: CircularProgressIndicator(color: AppTheme.accent));
    }
    if (lyr.isEmpty) {
      return const Center(
        child: Text('No lyrics found for this track.',
            style: TextStyle(color: AppTheme.muted)),
      );
    }
    if (!lyr.hasSynced) {
      return SingleChildScrollView(
        child: Text(lyr.plain,
            style: const TextStyle(fontSize: 16, height: 1.6)),
      );
    }
    // Synced view — highlight the active line and keep it centered.
    return StreamBuilder<Duration>(
      stream: _player.positionStream,
      builder: (context, snap) {
        final pos = snap.data ?? Duration.zero;
        int active = 0;
        for (var i = 0; i < lyr.synced.length; i++) {
          if (lyr.synced[i].time <= pos) {
            active = i;
          } else {
            break;
          }
        }
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (_lyricScroll.hasClients) {
            final target = (active * 44.0) - 120;
            _lyricScroll.animateTo(
              target.clamp(0, _lyricScroll.position.maxScrollExtent),
              duration: const Duration(milliseconds: 350),
              curve: Curves.easeOut,
            );
          }
        });
        return ListView.builder(
          controller: _lyricScroll,
          itemCount: lyr.synced.length,
          itemBuilder: (context, i) {
            final line = lyr.synced[i];
            final isActive = i == active;
            return GestureDetector(
              onTap: () => _player.seek(line.time),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 10),
                child: Text(
                  line.text.isEmpty ? '♪' : line.text,
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontSize: isActive ? 19 : 15.5,
                    height: 1.3,
                    fontWeight: isActive ? FontWeight.w800 : FontWeight.w500,
                    color: isActive ? AppTheme.accent : AppTheme.muted,
                  ),
                ),
              ),
            );
          },
        );
      },
    );
  }

  Widget _seekBar() {
    return StreamBuilder<Duration>(
      stream: _player.positionStream,
      builder: (context, snap) {
        final pos = snap.data ?? Duration.zero;
        final dur = _player.duration ?? Duration.zero;
        final maxMs = dur.inMilliseconds.toDouble();
        final value = maxMs == 0
            ? 0.0
            : pos.inMilliseconds.toDouble().clamp(0.0, maxMs);
        return Column(
          children: [
            SliderTheme(
              data: SliderTheme.of(context).copyWith(
                trackHeight: 3,
                thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 6),
                overlayShape: const RoundSliderOverlayShape(overlayRadius: 14),
                activeTrackColor: AppTheme.accent,
                inactiveTrackColor: AppTheme.border,
                thumbColor: AppTheme.accent,
              ),
              child: Slider(
                min: 0,
                max: maxMs == 0 ? 1 : maxMs,
                value: maxMs == 0 ? 0 : value,
                onChanged: maxMs == 0
                    ? null
                    : (v) => _player.seek(Duration(milliseconds: v.round())),
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 6),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(_fmt(pos),
                      style: const TextStyle(color: AppTheme.muted, fontSize: 12)),
                  Text(dur == Duration.zero ? '--:--' : _fmt(dur),
                      style: const TextStyle(color: AppTheme.muted, fontSize: 12)),
                ],
              ),
            ),
          ],
        );
      },
    );
  }

  Widget _controls() {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceEvenly,
      children: [
        IconButton(
          tooltip: 'Shuffle',
          icon: Icon(Icons.shuffle_rounded,
              color: _player.shuffle ? AppTheme.accent : AppTheme.muted),
          onPressed: _player.toggleShuffle,
        ),
        IconButton(
          iconSize: 40,
          icon: const Icon(Icons.skip_previous_rounded),
          onPressed: _player.previous,
        ),
        StreamBuilder<PlayerState>(
          stream: _player.playerStateStream,
          builder: (context, snap) {
            final playing = snap.data?.playing ?? false;
            final loading = _player.isPreparing ||
                snap.data?.processingState == ProcessingState.loading ||
                snap.data?.processingState == ProcessingState.buffering;
            return Container(
              decoration: const BoxDecoration(
                  color: AppTheme.accent, shape: BoxShape.circle),
              child: IconButton(
                iconSize: 40,
                color: const Color(0xFF04130C),
                icon: loading
                    ? const SizedBox(
                        width: 28,
                        height: 28,
                        child: CircularProgressIndicator(
                            strokeWidth: 3, color: Color(0xFF04130C)),
                      )
                    : Icon(playing
                        ? Icons.pause_rounded
                        : Icons.play_arrow_rounded),
                onPressed: _player.togglePlay,
              ),
            );
          },
        ),
        IconButton(
          iconSize: 40,
          icon: const Icon(Icons.skip_next_rounded),
          onPressed: () => _player.next(),
        ),
        IconButton(
          tooltip: 'Repeat',
          icon: Icon(
            _player.repeat == RepeatMode.one
                ? Icons.repeat_one_rounded
                : Icons.repeat_rounded,
            color: _player.repeat == RepeatMode.off
                ? AppTheme.muted
                : AppTheme.accent,
          ),
          onPressed: _player.cycleRepeat,
        ),
      ],
    );
  }

  void _openQueue() {
    showModalBottomSheet(
      context: context,
      backgroundColor: AppTheme.surface,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
      ),
      builder: (context) {
        return AnimatedBuilder(
          animation: _player,
          builder: (context, _) {
            final q = _player.queue;
            return DraggableScrollableSheet(
              expand: false,
              initialChildSize: 0.6,
              maxChildSize: 0.9,
              builder: (context, scroll) => Column(
                children: [
                  const Padding(
                    padding: EdgeInsets.all(16),
                    child: Text('Up Next',
                        style: TextStyle(
                            fontSize: 16, fontWeight: FontWeight.w800)),
                  ),
                  Expanded(
                    child: ListView.builder(
                      controller: scroll,
                      itemCount: q.length,
                      itemBuilder: (context, i) {
                        final t = q[i];
                        final isCurrent = i == _player.index;
                        return ListTile(
                          leading: Icon(
                            isCurrent
                                ? Icons.equalizer_rounded
                                : Icons.music_note,
                            color: isCurrent ? AppTheme.accent : AppTheme.muted,
                          ),
                          title: Text(t.title,
                              maxLines: 1, overflow: TextOverflow.ellipsis),
                          subtitle: Text('${t.artist} · ${t.source.label}',
                              maxLines: 1, overflow: TextOverflow.ellipsis),
                          onTap: () {
                            Navigator.of(context).pop();
                            _player.playQueue(q, startIndex: i);
                          },
                        );
                      },
                    ),
                  ),
                ],
              ),
            );
          },
        );
      },
    );
  }
}
