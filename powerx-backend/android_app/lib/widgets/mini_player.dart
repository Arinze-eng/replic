// mini_player.dart — the persistent bar at the bottom of the Ultra music
// screen showing the current track with a play/pause + progress line. Tapping
// it opens the full Now Playing screen (Spotify-style).
import 'package:flutter/material.dart';
import '../api/music/music_models.dart';
import '../api/music/player_service.dart';
import '../screens/ultra_music/now_playing_screen.dart';
import '../theme.dart';

class MiniPlayer extends StatelessWidget {
  const MiniPlayer({super.key});

  @override
  Widget build(BuildContext context) {
    final player = PlayerService.instance;
    return AnimatedBuilder(
      animation: player,
      builder: (context, _) {
        final track = player.current;
        if (track == null) return const SizedBox.shrink();
        return Material(
          color: AppTheme.surfaceAlt,
          child: InkWell(
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => const NowPlayingScreen()),
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                StreamBuilder<Duration>(
                  stream: player.positionStream,
                  builder: (context, snap) {
                    final pos = snap.data ?? Duration.zero;
                    final dur = player.duration ?? Duration.zero;
                    final v = (dur.inMilliseconds == 0)
                        ? 0.0
                        : (pos.inMilliseconds / dur.inMilliseconds)
                            .clamp(0.0, 1.0);
                    return LinearProgressIndicator(
                      value: player.isPreparing ? null : v,
                      minHeight: 2,
                      backgroundColor: AppTheme.border,
                      color: AppTheme.accent,
                    );
                  },
                ),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                  child: Row(
                    children: [
                      ClipRRect(
                        borderRadius: BorderRadius.circular(8),
                        child: _art(track.artworkUrl, 42),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(track.title,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                    fontWeight: FontWeight.w700, fontSize: 13.5)),
                            Text('${track.artist} · ${track.source.label}',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                    color: AppTheme.muted, fontSize: 11.5)),
                          ],
                        ),
                      ),
                      IconButton(
                        icon: Icon(player.isPlaying
                            ? Icons.pause_rounded
                            : Icons.play_arrow_rounded),
                        iconSize: 30,
                        color: AppTheme.text,
                        onPressed: player.togglePlay,
                      ),
                      IconButton(
                        icon: const Icon(Icons.skip_next_rounded),
                        iconSize: 26,
                        color: AppTheme.text,
                        onPressed: () => player.next(),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _art(String? url, double size) {
    if (url == null || url.isEmpty) {
      return Container(
        width: size,
        height: size,
        color: AppTheme.surface,
        child: const Icon(Icons.music_note, color: AppTheme.muted, size: 22),
      );
    }
    return Image.network(
      url,
      width: size,
      height: size,
      fit: BoxFit.cover,
      errorBuilder: (_, __, ___) => Container(
        width: size,
        height: size,
        color: AppTheme.surface,
        child: const Icon(Icons.music_note, color: AppTheme.muted, size: 22),
      ),
    );
  }
}
