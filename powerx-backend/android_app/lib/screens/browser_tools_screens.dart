// browser_tools_screens.dart — power-user tooling for the Stealth Browser:
//   • BrowserDownloads — download manager (handles onDownloadStartRequest)
//   • DownloadsScreen  — list of completed downloads
//   • CookiesScreen    — inspect / copy / delete cookies for a site
//   • DevToolsScreen   — run arbitrary JavaScript and see the result (console)

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:open_filex/open_filex.dart';
import 'package:share_plus/share_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../theme.dart';
import '../api/browser_service.dart';

// ─────────────────────────────────────────────────────────────────────────────
// ⬇️  Download manager — with REAL-TIME progress + share
// ─────────────────────────────────────────────────────────────────────────────
class DownloadRecord {
  final String name;
  final String path;
  int size;
  final int ts;
  DownloadRecord(this.name, this.path, this.size, this.ts);
  Map<String, dynamic> toJson() =>
      {'name': name, 'path': path, 'size': size, 'ts': ts};
  factory DownloadRecord.fromJson(Map<String, dynamic> j) => DownloadRecord(
      (j['name'] ?? '').toString(),
      (j['path'] ?? '').toString(),
      (j['size'] ?? 0) is int ? j['size'] : 0,
      (j['ts'] ?? 0) is int ? j['ts'] : 0);
}

/// A live, in-progress download the UI can watch in real time.
class ActiveDownload {
  final String id;
  final String name;
  String url;
  int received = 0;
  int total = 0; // 0 = unknown (no content-length)
  bool done = false;
  bool failed = false;
  String? path;
  ActiveDownload(this.id, this.name, this.url);

  double get progress => total > 0 ? (received / total).clamp(0.0, 1.0) : 0.0;
}

/// Singleton that owns active downloads + completed records and broadcasts
/// progress so the Downloads screen and snackbars update in real time.
class DownloadManager extends ChangeNotifier {
  static final DownloadManager instance = DownloadManager._();
  DownloadManager._();

  static const _kKey = 'browser_downloads_v1';
  final List<ActiveDownload> active = [];
  int _seq = 0;

  Future<List<DownloadRecord>> list() async {
    final p = await SharedPreferences.getInstance();
    final raw = p.getStringList(_kKey) ?? [];
    return raw
        .map((e) {
          try {
            return DownloadRecord.fromJson(
                jsonDecode(e) as Map<String, dynamic>);
          } catch (_) {
            return null;
          }
        })
        .whereType<DownloadRecord>()
        .toList()
      ..sort((a, b) => b.ts.compareTo(a.ts));
  }

  Future<void> _add(DownloadRecord r) async {
    final p = await SharedPreferences.getInstance();
    final raw = p.getStringList(_kKey) ?? [];
    raw.add(jsonEncode(r.toJson()));
    await p.setStringList(_kKey, raw);
  }

  Future<void> clear() async {
    final p = await SharedPreferences.getInstance();
    await p.remove(_kKey);
    notifyListeners();
  }

  /// Start a streamed download with live progress updates.
  Future<void> start(String url, String name,
      {bool autoOpen = false, void Function(String msg)? onToast}) async {
    final id = 'd${_seq++}';
    final dl = ActiveDownload(id, name, url);
    active.insert(0, dl);
    notifyListeners();
    onToast?.call('⬇️ Downloading $name…');

    try {
      final dir = await getApplicationDocumentsDirectory();
      final downloadsDir = Directory('${dir.path}/downloads');
      if (!await downloadsDir.exists()) {
        await downloadsDir.create(recursive: true);
      }
      final file = File('${downloadsDir.path}/$name');
      final sink = file.openWrite();

      final req = http.Request('GET', Uri.parse(url));
      final resp = await http.Client().send(req);
      dl.total = resp.contentLength ?? 0;
      notifyListeners();

      await for (final chunk in resp.stream) {
        sink.add(chunk);
        dl.received += chunk.length;
        notifyListeners();
      }
      await sink.close();

      dl.done = true;
      dl.path = file.path;
      final len = await file.length();
      notifyListeners();

      await _add(DownloadRecord(
          name, file.path, len, DateTime.now().millisecondsSinceEpoch));
      onToast?.call('✅ Saved $name');

      if (autoOpen) await OpenFilex.open(file.path);
      // Drop the active entry after a short grace so users see "done".
      Future.delayed(const Duration(seconds: 2), () {
        active.removeWhere((a) => a.id == id);
        notifyListeners();
      });
    } catch (e) {
      dl.failed = true;
      notifyListeners();
      onToast?.call('❌ Download failed: $e');
    }
  }
}

class BrowserDownloads {
  static Future<List<DownloadRecord>> list() => DownloadManager.instance.list();
  static Future<void> clear() => DownloadManager.instance.clear();

  // Handle a download triggered by the WebView (streamed + live progress).
  static Future<void> handle(BuildContext context, DownloadStartRequest req,
      BrowserSettings settings) async {
    final url = req.url.toString();
    var name =
        req.suggestedFilename ?? url.split('/').last.split('?').first;
    if (name.isEmpty) {
      name = 'download_${DateTime.now().millisecondsSinceEpoch}';
    }
    final messenger = ScaffoldMessenger.of(context);
    await DownloadManager.instance.start(
      url,
      name,
      autoOpen: settings.autoOpenDownloads,
      onToast: (m) => messenger.showSnackBar(
          SnackBar(content: Text(m), duration: const Duration(seconds: 2))),
    );
  }
}

class DownloadsScreen extends StatefulWidget {
  const DownloadsScreen({super.key});
  @override
  State<DownloadsScreen> createState() => _DownloadsScreenState();
}

class _DownloadsScreenState extends State<DownloadsScreen> {
  List<DownloadRecord> _items = [];
  bool _loading = true;
  final _dm = DownloadManager.instance;

  @override
  void initState() {
    super.initState();
    _dm.addListener(_onChange);
    _load();
  }

  void _onChange() {
    if (mounted) _load();
  }

  @override
  void dispose() {
    _dm.removeListener(_onChange);
    super.dispose();
  }

  Future<void> _load() async {
    final l = await BrowserDownloads.list();
    if (mounted) {
      setState(() {
        _items = l;
        _loading = false;
      });
    }
  }

  String _fmtSize(int b) {
    if (b <= 0) return '—';
    if (b < 1024) return '$b B';
    if (b < 1024 * 1024) return '${(b / 1024).toStringAsFixed(1)} KB';
    return '${(b / (1024 * 1024)).toStringAsFixed(1)} MB';
  }

  IconData _icon(String name) {
    final n = name.toLowerCase();
    if (n.endsWith('.pdf')) return Icons.picture_as_pdf;
    if (RegExp(r'\.(png|jpe?g|gif|webp|bmp)$').hasMatch(n)) return Icons.image;
    if (RegExp(r'\.(mp4|mkv|mov|webm|avi)$').hasMatch(n)) return Icons.movie;
    if (RegExp(r'\.(mp3|wav|m4a|ogg)$').hasMatch(n)) return Icons.audiotrack;
    if (RegExp(r'\.(zip|rar|7z|tar|gz)$').hasMatch(n)) return Icons.folder_zip;
    if (n.endsWith('.apk')) return Icons.android;
    return Icons.insert_drive_file;
  }

  Future<void> _share(String path, String name) async {
    try {
      await Share.shareXFiles([XFile(path)], text: name);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Share failed: $e')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final active = _dm.active;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Downloads'),
        actions: [
          if (_items.isNotEmpty)
            IconButton(
              icon: const Icon(Icons.delete_sweep),
              onPressed: () async {
                await BrowserDownloads.clear();
                _load();
              },
            ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AppTheme.accent))
          : (active.isEmpty && _items.isEmpty)
              ? const Center(
                  child: Text('No downloads yet',
                      style: TextStyle(color: AppTheme.muted)))
              : ListView(
                  children: [
                    // ── Active (in-progress) downloads with live progress ──
                    if (active.isNotEmpty) ...[
                      const Padding(
                        padding: EdgeInsets.fromLTRB(16, 12, 16, 6),
                        child: Text('In progress',
                            style: TextStyle(
                                fontWeight: FontWeight.w800,
                                color: AppTheme.accent)),
                      ),
                      ...active.map(_activeTile),
                      const Divider(color: AppTheme.border),
                    ],
                    // ── Completed downloads ──
                    ..._items.map((d) => ListTile(
                          leading: Icon(_icon(d.name), color: AppTheme.accent),
                          title: Text(d.name,
                              maxLines: 1, overflow: TextOverflow.ellipsis),
                          subtitle: Text(_fmtSize(d.size),
                              style: const TextStyle(fontSize: 12)),
                          onTap: () => OpenFilex.open(d.path),
                          trailing: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              IconButton(
                                tooltip: 'Share',
                                icon: const Icon(Icons.share, size: 20),
                                onPressed: () => _share(d.path, d.name),
                              ),
                              IconButton(
                                tooltip: 'Open',
                                icon: const Icon(Icons.open_in_new, size: 20),
                                onPressed: () => OpenFilex.open(d.path),
                              ),
                            ],
                          ),
                        )),
                  ],
                ),
    );
  }

  Widget _activeTile(ActiveDownload a) {
    final pct = a.total > 0 ? '${(a.progress * 100).round()}%' : '';
    final sub = a.failed
        ? 'Failed'
        : a.done
            ? 'Completed'
            : a.total > 0
                ? '${_fmtSize(a.received)} / ${_fmtSize(a.total)} · $pct'
                : '${_fmtSize(a.received)} downloaded…';
    return ListTile(
      leading: Icon(
          a.failed
              ? Icons.error
              : a.done
                  ? Icons.check_circle
                  : _icon(a.name),
          color: a.failed
              ? AppTheme.danger
              : a.done
                  ? AppTheme.accent
                  : AppTheme.accent2),
      title: Text(a.name, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const SizedBox(height: 4),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(
              value: a.total > 0 ? a.progress : null,
              minHeight: 4,
              backgroundColor: AppTheme.surfaceAlt,
              color: a.failed ? AppTheme.danger : AppTheme.accent,
            ),
          ),
          const SizedBox(height: 4),
          Text(sub, style: const TextStyle(fontSize: 11)),
        ],
      ),
      trailing: (a.done && a.path != null)
          ? IconButton(
              tooltip: 'Share',
              icon: const Icon(Icons.share, size: 20),
              onPressed: () => _share(a.path!, a.name),
            )
          : null,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 🍪 Cookie inspector
// ─────────────────────────────────────────────────────────────────────────────
class CookiesScreen extends StatefulWidget {
  final String url;
  const CookiesScreen({super.key, required this.url});
  @override
  State<CookiesScreen> createState() => _CookiesScreenState();
}

class _CookiesScreenState extends State<CookiesScreen> {
  List<Cookie> _cookies = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      if (widget.url.isNotEmpty) {
        _cookies = await CookieManager.instance().getCookies(
          url: WebUri(widget.url),
        );
      }
    } catch (_) {}
    if (mounted) setState(() => _loading = false);
  }

  @override
  Widget build(BuildContext context) {
    final host = Uri.tryParse(widget.url)?.host ?? widget.url;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Cookies'),
        actions: [
          IconButton(
            icon: const Icon(Icons.copy),
            tooltip: 'Copy all',
            onPressed: () {
              final txt = _cookies
                  .map((c) => '${c.name}=${c.value}')
                  .join('; ');
              Clipboard.setData(ClipboardData(text: txt));
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Cookies copied')));
            },
          ),
          IconButton(
            icon: const Icon(Icons.delete),
            tooltip: 'Delete all for site',
            onPressed: () async {
              if (widget.url.isNotEmpty) {
                await CookieManager.instance()
                    .deleteCookies(url: WebUri(widget.url));
              }
              _load();
            },
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AppTheme.accent))
          : Column(
              children: [
                Padding(
                  padding: const EdgeInsets.all(12),
                  child: Text('$host · ${_cookies.length} cookie(s)',
                      style: const TextStyle(color: AppTheme.muted)),
                ),
                Expanded(
                  child: _cookies.isEmpty
                      ? const Center(
                          child: Text('No cookies for this site',
                              style: TextStyle(color: AppTheme.muted)))
                      : ListView.separated(
                          itemCount: _cookies.length,
                          separatorBuilder: (_, __) =>
                              const Divider(height: 1, color: AppTheme.border),
                          itemBuilder: (c, i) {
                            final ck = _cookies[i];
                            return ListTile(
                              title: Text(ck.name,
                                  style: const TextStyle(
                                      fontWeight: FontWeight.w700,
                                      fontSize: 14)),
                              subtitle: Text('${ck.value}',
                                  maxLines: 3,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(fontSize: 12)),
                              trailing: IconButton(
                                icon: const Icon(Icons.copy, size: 18),
                                onPressed: () {
                                  Clipboard.setData(ClipboardData(
                                      text: '${ck.name}=${ck.value}'));
                                  ScaffoldMessenger.of(context).showSnackBar(
                                    const SnackBar(content: Text('Copied')));
                                },
                              ),
                            );
                          },
                        ),
                ),
              ],
            ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 🧰 DevTools console — run arbitrary JS against the active page
// ─────────────────────────────────────────────────────────────────────────────
class DevToolsScreen extends StatefulWidget {
  final InAppWebViewController? controller;
  const DevToolsScreen({super.key, required this.controller});
  @override
  State<DevToolsScreen> createState() => _DevToolsScreenState();
}

class _DevToolsScreenState extends State<DevToolsScreen> {
  final _ctrl = TextEditingController();
  final _log = <_LogEntry>[];
  final _scroll = ScrollController();

  static const _snippets = {
    'Document title': 'document.title',
    'Page URL': 'location.href',
    'All links': 'Array.from(document.links).map(a=>a.href).join("\\n")',
    'Local storage': 'JSON.stringify(localStorage)',
    'Cookies (JS)': 'document.cookie',
    'User agent': 'navigator.userAgent',
    'Screen size': 'screen.width+"x"+screen.height',
    'Remove ads': 'document.querySelectorAll(\'[class*=ad],[id*=ad],iframe\').forEach(e=>e.remove());"removed"',
  };

  Future<void> _run([String? code]) async {
    final js = (code ?? _ctrl.text).trim();
    if (js.isEmpty || widget.controller == null) return;
    setState(() => _log.add(_LogEntry(js, null, true)));
    try {
      final res = await widget.controller!
          .evaluateJavascript(source: '(function(){try{return ($js);}catch(e){return "Error: "+e.message;}})()');
      setState(() => _log.add(_LogEntry('', res?.toString() ?? 'undefined', false)));
    } catch (e) {
      setState(() => _log.add(_LogEntry('', 'Error: $e', false)));
    }
    _ctrl.clear();
    await Future.delayed(const Duration(milliseconds: 50));
    if (_scroll.hasClients) {
      _scroll.animateTo(_scroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 200), curve: Curves.easeOut);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('DevTools Console'),
        actions: [
          PopupMenuButton<String>(
            icon: const Icon(Icons.bolt),
            color: AppTheme.surfaceAlt,
            onSelected: (k) => _run(_snippets[k]),
            itemBuilder: (c) => _snippets.keys
                .map((k) => PopupMenuItem(value: k, child: Text(k)))
                .toList(),
          ),
          IconButton(
            icon: const Icon(Icons.clear_all),
            onPressed: () => setState(() => _log.clear()),
          ),
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: Container(
              color: const Color(0xFF05070C),
              child: ListView.builder(
                controller: _scroll,
                padding: const EdgeInsets.all(12),
                itemCount: _log.length,
                itemBuilder: (c, i) {
                  final e = _log[i];
                  return Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(e.isInput ? '› ' : '‹ ',
                            style: TextStyle(
                                fontFamily: 'monospace',
                                color: e.isInput
                                    ? AppTheme.accent
                                    : AppTheme.accent2)),
                        Expanded(
                          child: SelectableText(
                            e.isInput ? e.input : (e.output ?? ''),
                            style: TextStyle(
                              fontFamily: 'monospace',
                              fontSize: 12.5,
                              color: e.isInput
                                  ? AppTheme.text
                                  : AppTheme.muted,
                            ),
                          ),
                        ),
                      ],
                    ),
                  );
                },
              ),
            ),
          ),
          Container(
            color: AppTheme.surface,
            padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
            child: Row(children: [
              Expanded(
                child: TextField(
                  controller: _ctrl,
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 13),
                  decoration: const InputDecoration(
                    hintText: 'Enter JavaScript…',
                    isDense: true,
                  ),
                  onSubmitted: (_) => _run(),
                ),
              ),
              IconButton(
                icon: const Icon(Icons.play_arrow, color: AppTheme.accent),
                onPressed: () => _run(),
              ),
            ]),
          ),
        ],
      ),
    );
  }
}

class _LogEntry {
  final String input;
  final String? output;
  final bool isInput;
  _LogEntry(this.input, this.output, this.isInput);
}

// ─────────────────────────────────────────────────────────────────────────────
// 🕘 History screen — see where you went & revisit. Tap an item to open it;
// returns the chosen URL to the browser. Anonymous/incognito visits never
// appear here (they are never recorded).
// ─────────────────────────────────────────────────────────────────────────────
class HistoryScreen extends StatefulWidget {
  const HistoryScreen({super.key});
  @override
  State<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends State<HistoryScreen> {
  List<HistoryEntry> _items = [];
  bool _loading = true;
  String _filter = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final l = await BrowserHistory.list();
    if (mounted) {
      setState(() {
        _items = l;
        _loading = false;
      });
    }
  }

  String _when(int ts) {
    final d = DateTime.fromMillisecondsSinceEpoch(ts);
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final day = DateTime(d.year, d.month, d.day);
    final hm =
        '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
    if (day == today) return 'Today · $hm';
    if (day == today.subtract(const Duration(days: 1))) {
      return 'Yesterday · $hm';
    }
    return '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')} · $hm';
  }

  @override
  Widget build(BuildContext context) {
    final items = _items
        .where((e) =>
            _filter.isEmpty ||
            e.url.toLowerCase().contains(_filter.toLowerCase()) ||
            e.title.toLowerCase().contains(_filter.toLowerCase()))
        .toList();
    return Scaffold(
      appBar: AppBar(
        title: const Text('History'),
        actions: [
          if (_items.isNotEmpty)
            IconButton(
              tooltip: 'Clear all history',
              icon: const Icon(Icons.delete_sweep),
              onPressed: () async {
                await BrowserHistory.clear();
                _load();
              },
            ),
        ],
      ),
      body: _loading
          ? const Center(
              child: CircularProgressIndicator(color: AppTheme.accent))
          : Column(
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
                  child: TextField(
                    decoration: const InputDecoration(
                      isDense: true,
                      prefixIcon: Icon(Icons.search, size: 18),
                      hintText: 'Search history…',
                    ),
                    onChanged: (v) => setState(() => _filter = v),
                  ),
                ),
                Expanded(
                  child: items.isEmpty
                      ? const Center(
                          child: Text(
                              'No history yet.\nAnonymous visits are never recorded.',
                              textAlign: TextAlign.center,
                              style: TextStyle(color: AppTheme.muted)))
                      : ListView.separated(
                          itemCount: items.length,
                          separatorBuilder: (_, __) => const Divider(
                              height: 1, color: AppTheme.border),
                          itemBuilder: (c, i) {
                            final e = items[i];
                            return ListTile(
                              dense: true,
                              leading: const Icon(Icons.public,
                                  color: AppTheme.accent, size: 20),
                              title: Text(e.title,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis),
                              subtitle: Text('${e.host} · ${_when(e.ts)}',
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(fontSize: 11)),
                              onTap: () => Navigator.pop(context, e.url),
                              trailing: IconButton(
                                icon: const Icon(Icons.close, size: 16),
                                onPressed: () async {
                                  await BrowserHistory.remove(e.ts);
                                  _load();
                                },
                              ),
                            );
                          },
                        ),
                ),
              ],
            ),
    );
  }
}

