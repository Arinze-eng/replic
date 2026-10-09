// ultra_music_screen.dart — the entry screen for the "WormGPT Ultra" tool.
//
// A self-contained, Spotify-style music client (the "Spotui" experience) that
// streams from Audius / YouTube Music / iTunes entirely on-device, so it works
// even when the Render backend is asleep. Two tabs — Home (trending) and Search
// — with a docked mini-player that opens the full Now Playing screen.
import 'package:flutter/material.dart';
import '../../api/music/music_models.dart';
import '../../api/music/music_repository.dart';
import '../../api/music/player_service.dart';
import '../../widgets/mini_player.dart';
import '../../theme.dart';

class UltraMusicScreen extends StatefulWidget {
  const UltraMusicScreen({super.key});

  @override
  State<UltraMusicScreen> createState() => _UltraMusicScreenState();
}

class _UltraMusicScreenState extends State<UltraMusicScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabs;

  final _searchCtl = TextEditingController();
  List<Track> _home = [];
  List<Track> _results = [];
  bool _loadingHome = true;
  bool _searching = false;
  String _lastQuery = '';

  @override
  void initState() {
    super.initState();
    PlayerService.instance.init();
    _tabs = TabController(length: 2, vsync: this);
    _loadHome();
  }

  @override
  void dispose() {
    _tabs.dispose();
    _searchCtl.dispose();
    super.dispose();
  }

  Future<void> _loadHome() async {
    setState(() => _loadingHome = true);
    final tracks = await MusicRepository.instance.home();
    if (!mounted) return;
    setState(() {
      _home = tracks;
      _loadingHome = false;
    });
  }

  Future<void> _runSearch(String q) async {
    q = q.trim();
    if (q.isEmpty) return;
    _lastQuery = q;
    setState(() => _searching = true);
    final res = await MusicRepository.instance.search(q);
    if (!mounted || _lastQuery != q) return;
    setState(() {
      _results = res;
      _searching = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Row(
          children: const [
            Text('🎧', style: TextStyle(fontSize: 20)),
            SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('WormGPT Ultra V🔥🔥',
                      style:
                          TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
                  Text('Unlimited music · stream anything',
                      style: TextStyle(fontSize: 11, color: AppTheme.muted)),
                ],
              ),
            ),
          ],
        ),
        bottom: TabBar(
          controller: _tabs,
          indicatorColor: AppTheme.accent,
          labelColor: AppTheme.accent,
          unselectedLabelColor: AppTheme.muted,
          tabs: const [
            Tab(text: 'Home', icon: Icon(Icons.home_rounded, size: 20)),
            Tab(text: 'Search', icon: Icon(Icons.search_rounded, size: 20)),
          ],
        ),
      ),
      body: Column(
        children: [
          Expanded(
            child: TabBarView(
              controller: _tabs,
              children: [
                _homeTab(),
                _searchTab(),
              ],
            ),
          ),
          const MiniPlayer(),
        ],
      ),
    );
  }

  Widget _homeTab() {
    if (_loadingHome) {
      return const Center(
          child: CircularProgressIndicator(color: AppTheme.accent));
    }
    if (_home.isEmpty) {
      return _empty(
        icon: Icons.wifi_off_rounded,
        text: 'Could not load trending music.\nCheck your connection and retry.',
        action: TextButton(onPressed: _loadHome, child: const Text('Retry')),
      );
    }
    return RefreshIndicator(
      color: AppTheme.accent,
      onRefresh: _loadHome,
      child: ListView(
        padding: const EdgeInsets.symmetric(vertical: 8),
        children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(16, 8, 16, 4),
            child: Text('🔥 Trending now',
                style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
          ),
          ..._home.asMap().entries.map((e) => _trackTile(
                e.value,
                context: _home,
              )),
          const SizedBox(height: 8),
        ],
      ),
    );
  }

  Widget _searchTab() {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 8),
          child: TextField(
            controller: _searchCtl,
            textInputAction: TextInputAction.search,
            onSubmitted: _runSearch,
            decoration: InputDecoration(
              hintText: 'Songs, artists, albums…',
              prefixIcon: const Icon(Icons.search_rounded),
              suffixIcon: IconButton(
                icon: const Icon(Icons.arrow_forward_rounded),
                onPressed: () => _runSearch(_searchCtl.text),
              ),
            ),
          ),
        ),
        Expanded(
          child: _searching
              ? const Center(
                  child: CircularProgressIndicator(color: AppTheme.accent))
              : _results.isEmpty
                  ? _empty(
                      icon: Icons.library_music_rounded,
                      text: _lastQuery.isEmpty
                          ? 'Search millions of tracks across\nAudius, YouTube Music & more.'
                          : 'No results for “$_lastQuery”.',
                    )
                  : ListView.builder(
                      padding: const EdgeInsets.symmetric(vertical: 6),
                      itemCount: _results.length,
                      itemBuilder: (context, i) =>
                          _trackTile(_results[i], context: _results),
                    ),
        ),
      ],
    );
  }

  Widget _trackTile(Track t, {required List<Track> context}) {
    final player = PlayerService.instance;
    return AnimatedBuilder(
      animation: player,
      builder: (ctx, _) {
        final isCurrent = player.current?.uniqueKey == t.uniqueKey;
        return ListTile(
          leading: ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: _art(t.artworkUrl, 48),
          ),
          title: Text(t.title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontWeight: FontWeight.w700,
                color: isCurrent ? AppTheme.accent : AppTheme.text,
              )),
          subtitle: Text('${t.artist} · ${t.source.label}',
              maxLines: 1, overflow: TextOverflow.ellipsis),
          trailing: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(t.durationLabel,
                  style: const TextStyle(color: AppTheme.muted, fontSize: 12)),
              PopupMenuButton<String>(
                color: AppTheme.surfaceAlt,
                icon: const Icon(Icons.more_vert_rounded, color: AppTheme.muted),
                onSelected: (v) {
                  if (v == 'queue') {
                    player.addToQueue(t);
                    ScaffoldMessenger.of(ctx).showSnackBar(
                      SnackBar(
                        content: Text('Added “${t.title}” to queue'),
                        duration: const Duration(seconds: 1),
                      ),
                    );
                  }
                },
                itemBuilder: (_) => const [
                  PopupMenuItem(value: 'queue', child: Text('Add to queue')),
                ],
              ),
            ],
          ),
          onTap: () => player.playTrack(t, context: context),
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
        child: const Icon(Icons.music_note, color: AppTheme.muted),
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
        child: const Icon(Icons.music_note, color: AppTheme.muted),
      ),
    );
  }

  Widget _empty({required IconData icon, required String text, Widget? action}) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 54, color: AppTheme.muted),
          const SizedBox(height: 14),
          Text(text,
              textAlign: TextAlign.center,
              style: const TextStyle(color: AppTheme.muted)),
          if (action != null) ...[const SizedBox(height: 8), action],
        ],
      ),
    );
  }
}
