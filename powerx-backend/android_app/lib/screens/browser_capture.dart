// browser_capture.dart — power features for the Stealth Browser:
//
//   • CaptureStore           — in-memory log of requests/responses the WebView made
//   • NetworkInspectorScreen — view captured traffic, inspect headers/body, and
//                              EDIT + REPLAY any request (method/url/headers/body)
//                              then load the response back into the page.
//   • CookieEditorScreen     — full cookie editor: view, add, edit, delete, and
//                              PASTE a cookie JSON (Chrome "Cookie-Editor" export
//                              format) to import a session and log in instantly.
//
// All HTTP for replay goes through the device (http package) so it honors the
// same network path as the browser; results are shown raw so you can debug.

import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:http/http.dart' as http;
import '../theme.dart';

// ─────────────────────────────────────────────────────────────────────────────
// 📡 Capture store
// ─────────────────────────────────────────────────────────────────────────────
class CapturedRequest {
  final String id;
  String method;
  String url;
  Map<String, String> headers;
  String? body;
  final int ts;
  // Response — filled either by a live capture (JS hook) or by a manual replay.
  int? status;
  String? responseBody;
  Map<String, String>? responseHeaders;
  String? responseType; // 'json' | 'html' | 'text' | etc (best-effort)
  int? durationMs;
  bool live; // true when captured from the real page (not a manual replay)

  CapturedRequest({
    required this.id,
    required this.method,
    required this.url,
    required this.headers,
    this.body,
    required this.ts,
    this.status,
    this.responseBody,
    this.responseHeaders,
    this.responseType,
    this.durationMs,
    this.live = false,
  });

  String get host => Uri.tryParse(url)?.host ?? url;
  String get path => Uri.tryParse(url)?.path ?? '';
  bool get hasResponse => status != null;
}

class CaptureStore extends ChangeNotifier {
  final List<CapturedRequest> _items = [];
  static const int _max = 400;

  List<CapturedRequest> get items => List.unmodifiable(_items.reversed);

  int _seq = 0;

  void recordRequest(WebResourceRequest req) {
    try {
      final url = req.url.toString();
      // Skip noise: data URIs, blobs.
      if (url.startsWith('data:') || url.startsWith('blob:')) return;
      final headers = <String, String>{};
      (req.headers ?? {}).forEach((k, v) => headers[k] = v.toString());
      _items.add(CapturedRequest(
        id: 'r${_seq++}',
        method: (req.method ?? 'GET').toUpperCase(),
        url: url,
        headers: headers,
        body: null,
        ts: DateTime.now().millisecondsSinceEpoch,
      ));
      if (_items.length > _max) _items.removeRange(0, _items.length - _max);
      notifyListeners();
    } catch (_) {}
  }

  /// Record a FULL request+response captured live from the page (via the
  /// injected fetch/XHR hook). This is what powers the rich request/response
  /// body sections — real traffic, not a re-fetch.
  void recordLive(Map<String, dynamic> j) {
    try {
      final url = (j['url'] ?? '').toString();
      if (url.isEmpty || url.startsWith('data:') || url.startsWith('blob:')) {
        return;
      }
      final reqHeaders = <String, String>{};
      final rh = j['reqHeaders'];
      if (rh is Map) rh.forEach((k, v) => reqHeaders['$k'] = '$v');
      final respHeaders = <String, String>{};
      final sh = j['respHeaders'];
      if (sh is Map) sh.forEach((k, v) => respHeaders['$k'] = '$v');
      _items.add(CapturedRequest(
        id: 'l${_seq++}',
        method: (j['method'] ?? 'GET').toString().toUpperCase(),
        url: url,
        headers: reqHeaders,
        body: (j['reqBody'] ?? '').toString().isEmpty
            ? null
            : j['reqBody'].toString(),
        ts: DateTime.now().millisecondsSinceEpoch,
        status: j['status'] is int
            ? j['status']
            : int.tryParse('${j['status']}'),
        responseBody: (j['respBody'] ?? '').toString(),
        responseHeaders: respHeaders,
        responseType: (j['respType'] ?? '').toString(),
        durationMs: j['ms'] is int ? j['ms'] : int.tryParse('${j['ms']}'),
        live: true,
      ));
      if (_items.length > _max) _items.removeRange(0, _items.length - _max);
      notifyListeners();
    } catch (_) {}
  }

  /// The JS injected at document-start that hooks fetch + XMLHttpRequest and
  /// reports each completed request/response (with bodies + headers + timing)
  /// back to Flutter via the 'captureXhr' handler. Lightweight + body-capped.
  static String captureHookJs() {
    return r'''
      (function(){try{
        if(window.__capHooked)return; window.__capHooked=true;
        var CAP=2000000; // 2 MB body cap so we never blow memory
        var clip=function(s){try{if(typeof s!=='string')s=String(s);return s.length>CAP?s.slice(0,CAP)+'\n…[truncated]':s;}catch(e){return '';}};
        var send=function(o){try{window.flutter_inappwebview&&window.flutter_inappwebview.callHandler('captureXhr',o);}catch(e){}};
        // ── fetch ──
        try{
          var _f=window.fetch;
          window.fetch=function(input,init){
            var t0=Date.now();
            var url=(typeof input==='string')?input:(input&&input.url)||'';
            var method=(init&&init.method)||(input&&input.method)||'GET';
            var reqBody=(init&&init.body)?clip(init.body):'';
            var reqHeaders={};
            try{if(init&&init.headers){if(init.headers.forEach){init.headers.forEach(function(v,k){reqHeaders[k]=v;});}else{for(var k in init.headers){reqHeaders[k]=init.headers[k];}}}}catch(e){}
            return _f.apply(this,arguments).then(function(resp){
              try{
                var clone=resp.clone();
                var respHeaders={};
                try{clone.headers.forEach(function(v,k){respHeaders[k]=v;});}catch(e){}
                var ct=respHeaders['content-type']||'';
                clone.text().then(function(txt){
                  send({url:url,method:method,status:resp.status,reqBody:reqBody,reqHeaders:reqHeaders,respHeaders:respHeaders,respBody:clip(txt),respType:ct,ms:Date.now()-t0});
                }).catch(function(){send({url:url,method:method,status:resp.status,reqBody:reqBody,reqHeaders:reqHeaders,respHeaders:respHeaders,respBody:'',respType:ct,ms:Date.now()-t0});});
              }catch(e){}
              return resp;
            });
          };
        }catch(e){}
        // ── XMLHttpRequest ──
        try{
          var _open=XMLHttpRequest.prototype.open;
          var _xsend=XMLHttpRequest.prototype.send;
          var _setH=XMLHttpRequest.prototype.setRequestHeader;
          XMLHttpRequest.prototype.open=function(m,u){this.__cap={method:m,url:u,t0:Date.now(),headers:{}};return _open.apply(this,arguments);};
          XMLHttpRequest.prototype.setRequestHeader=function(k,v){try{if(this.__cap)this.__cap.headers[k]=v;}catch(e){}return _setH.apply(this,arguments);};
          XMLHttpRequest.prototype.send=function(body){
            var self=this;
            try{
              self.addEventListener('loadend',function(){
                try{
                  if(!self.__cap)return;
                  var respHeaders={};
                  try{(self.getAllResponseHeaders()||'').trim().split(/[\r\n]+/).forEach(function(line){var i=line.indexOf(':');if(i>0)respHeaders[line.slice(0,i).trim()]=line.slice(i+1).trim();});}catch(e){}
                  var rt='';try{rt=(self.responseType==='' || self.responseType==='text')?self.responseText:('['+self.responseType+']');}catch(e){}
                  send({url:self.__cap.url,method:self.__cap.method,status:self.status,reqBody:body?clip(body):'',reqHeaders:self.__cap.headers,respHeaders:respHeaders,respBody:clip(rt),respType:respHeaders['content-type']||'',ms:Date.now()-self.__cap.t0});
                }catch(e){}
              });
            }catch(e){}
            return _xsend.apply(this,arguments);
          };
        }catch(e){}
      }catch(e){}})();
    ''';
  }

  void clear() {
    _items.clear();
    notifyListeners();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 🔎 Network inspector — capture · inspect · edit · replay
// ─────────────────────────────────────────────────────────────────────────────
class NetworkInspectorScreen extends StatefulWidget {
  final CaptureStore store;
  final InAppWebViewController? controller;
  const NetworkInspectorScreen(
      {super.key, required this.store, required this.controller});
  @override
  State<NetworkInspectorScreen> createState() => _NetworkInspectorScreenState();
}

class _NetworkInspectorScreenState extends State<NetworkInspectorScreen> {
  String _filter = '';
  // Hosts the user has collapsed. Default = expanded so traffic is visible
  // per-site as it streams in (most-recently-active site at the top).
  final Set<String> _collapsed = <String>{};

  @override
  void initState() {
    super.initState();
    widget.store.addListener(_onChange);
  }

  void _onChange() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    widget.store.removeListener(_onChange);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final items = widget.store.items
        .where((r) =>
            _filter.isEmpty ||
            r.url.toLowerCase().contains(_filter.toLowerCase()))
        .toList();
    return Scaffold(
      appBar: AppBar(
        title: const Text('Network'),
        actions: [
          IconButton(
            tooltip: 'New request',
            icon: const Icon(Icons.add),
            onPressed: () => _openEditor(null),
          ),
          IconButton(
            tooltip: 'Clear',
            icon: const Icon(Icons.delete_sweep),
            onPressed: () => widget.store.clear(),
          ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
            child: TextField(
              decoration: const InputDecoration(
                isDense: true,
                prefixIcon: Icon(Icons.filter_alt, size: 18),
                hintText: 'Filter by URL…',
              ),
              onChanged: (v) => setState(() => _filter = v),
            ),
          ),
          Expanded(
            child: items.isEmpty
                ? const Center(
                    child: Text('No requests captured yet',
                        style: TextStyle(color: AppTheme.muted)))
                : _buildPerSiteList(items),
          ),
        ],
      ),
    );
  }

  // ── Per-website grouping ──────────────────────────────────────────────────
  // Group captured requests by host so each website's traffic lives in its own
  // collapsible section (request + response visible, editable, replayable) —
  // instead of one jam-packed flat list. Hosts are ordered by their most-recent
  // activity so the site you're on bubbles to the top.
  Widget _buildPerSiteList(List<CapturedRequest> items) {
    // A plain Dart Map preserves insertion order, so the first-seen host stays
    // first and we don't need dart:collection.
    final byHost = <String, List<CapturedRequest>>{};
    for (final r in items) {
      (byHost[r.host] ??= <CapturedRequest>[]).add(r);
    }
    final hosts = byHost.keys.toList();
    return ListView.builder(
      itemCount: hosts.length,
      itemBuilder: (c, i) {
        final host = hosts[i];
        final reqs = byHost[host]!;
        final expanded = !_collapsed.contains(host);
        final errors =
            reqs.where((r) => r.status != null && r.status! >= 400).length;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Website header row.
            InkWell(
              onTap: () => setState(() {
                if (expanded) {
                  _collapsed.add(host);
                } else {
                  _collapsed.remove(host);
                }
              }),
              child: Container(
                color: AppTheme.surface,
                padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
                child: Row(children: [
                  Icon(expanded ? Icons.expand_more : Icons.chevron_right,
                      size: 20, color: AppTheme.muted),
                  const SizedBox(width: 4),
                  const Icon(Icons.public, size: 16, color: AppTheme.accent),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(host,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                            fontSize: 13.5, fontWeight: FontWeight.w800)),
                  ),
                  if (errors > 0)
                    Container(
                      margin: const EdgeInsets.only(right: 6),
                      padding: const EdgeInsets.symmetric(
                          horizontal: 6, vertical: 2),
                      decoration: BoxDecoration(
                          color: AppTheme.danger.withOpacity(0.18),
                          borderRadius: BorderRadius.circular(6)),
                      child: Text('$errors err',
                          style: const TextStyle(
                              fontSize: 10,
                              fontWeight: FontWeight.w800,
                              color: AppTheme.danger)),
                    ),
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                    decoration: BoxDecoration(
                        color: AppTheme.accent.withOpacity(0.15),
                        borderRadius: BorderRadius.circular(10)),
                    child: Text('${reqs.length}',
                        style: const TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w800,
                            color: AppTheme.accent)),
                  ),
                ]),
              ),
            ),
            // Requests for this site.
            if (expanded)
              ...reqs.map(_rowTile),
            const Divider(height: 1, color: AppTheme.border),
          ],
        );
      },
    );
  }

  // A single request row (request line + status), tapping opens the full
  // request/response editor where the body can be viewed, edited & replayed.
  Widget _rowTile(CapturedRequest r) {
    return ListTile(
      dense: true,
      contentPadding: const EdgeInsets.only(left: 28, right: 12),
      leading: _methodBadge(r.method),
      title: Row(children: [
        Flexible(
          child: Text(r.path.isEmpty ? r.url : r.path,
              maxLines: 1, overflow: TextOverflow.ellipsis),
        ),
        if (r.live)
          Container(
            margin: const EdgeInsets.only(left: 6),
            padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
            decoration: BoxDecoration(
                color: AppTheme.accent.withOpacity(0.18),
                borderRadius: BorderRadius.circular(5)),
            child: const Text('LIVE',
                style: TextStyle(
                    fontSize: 8,
                    fontWeight: FontWeight.w800,
                    color: AppTheme.accent)),
          ),
      ]),
      subtitle: r.durationMs != null
          ? Text('${r.durationMs}ms',
              style: const TextStyle(fontSize: 10.5, color: AppTheme.muted))
          : null,
      trailing: r.status == null
          ? const Icon(Icons.chevron_right, size: 18)
          : Text('${r.status}',
              style: TextStyle(
                  fontWeight: FontWeight.w700,
                  color: (r.status! >= 200 && r.status! < 400)
                      ? AppTheme.accent
                      : AppTheme.danger)),
      onTap: () => _openEditor(r),
    );
  }

  Widget _methodBadge(String m) {
    Color col;
    switch (m) {
      case 'POST':
        col = Colors.orange;
        break;
      case 'PUT':
      case 'PATCH':
        col = Colors.purple;
        break;
      case 'DELETE':
        col = AppTheme.danger;
        break;
      default:
        col = AppTheme.accent;
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
      decoration: BoxDecoration(
          color: col.withOpacity(0.18),
          borderRadius: BorderRadius.circular(6)),
      child: Text(m,
          style: TextStyle(
              fontSize: 10, fontWeight: FontWeight.w800, color: col)),
    );
  }

  void _openEditor(CapturedRequest? r) {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => RequestEditorScreen(
        original: r,
        controller: widget.controller,
        onReplayed: (status, body, headers, ms) {
          if (r != null) {
            r.status = status;
            r.responseBody = body;
            r.responseHeaders = headers;
            r.durationMs = ms;
            setState(() {});
          }
        },
      ),
    ));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ✏️ Request editor — edit method/url/headers/body, REPLAY, view + edit response,
//    optionally load the (edited) response back into the WebView.
// ─────────────────────────────────────────────────────────────────────────────
class RequestEditorScreen extends StatefulWidget {
  final CapturedRequest? original;
  final InAppWebViewController? controller;
  final void Function(int status, String body, Map<String, String> headers,
      int ms)? onReplayed;
  const RequestEditorScreen({
    super.key,
    required this.original,
    required this.controller,
    this.onReplayed,
  });
  @override
  State<RequestEditorScreen> createState() => _RequestEditorScreenState();
}

class _RequestEditorScreenState extends State<RequestEditorScreen> {
  late String _method;
  late TextEditingController _urlCtrl;
  late TextEditingController _headersCtrl;
  late TextEditingController _bodyCtrl;
  final _respCtrl = TextEditingController();
  final _respHeadersCtrl = TextEditingController();
  int? _status;
  int? _ms;
  String? _respType;
  bool _busy = false;

  static const _methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];

  @override
  void initState() {
    super.initState();
    final o = widget.original;
    _method = o?.method ?? 'GET';
    if (!_methods.contains(_method)) _method = 'GET';
    _urlCtrl = TextEditingController(text: o?.url ?? 'https://');
    _headersCtrl = TextEditingController(
        text: _headersToText(o?.headers ?? {'Accept': '*/*'}));
    _bodyCtrl = TextEditingController(text: o?.body ?? '');
    if (o?.responseBody != null && o!.responseBody!.isNotEmpty) {
      _respCtrl.text = _pretty(o.responseBody!);
    }
    if (o?.responseHeaders != null) {
      _respHeadersCtrl.text = _headersToText(o!.responseHeaders!);
    }
    _status = o?.status;
    _ms = o?.durationMs;
    _respType = o?.responseType;
  }

  String _headersToText(Map<String, String> h) =>
      h.entries.map((e) => '${e.key}: ${e.value}').join('\n');

  Map<String, String> _textToHeaders(String t) {
    final m = <String, String>{};
    for (final line in t.split('\n')) {
      final i = line.indexOf(':');
      if (i > 0) {
        final k = line.substring(0, i).trim();
        final v = line.substring(i + 1).trim();
        if (k.isNotEmpty) m[k] = v;
      }
    }
    return m;
  }

  Future<void> _replay() async {
    final url = _urlCtrl.text.trim();
    final uri = Uri.tryParse(url);
    if (uri == null || !uri.hasScheme) {
      _toast('Enter a valid absolute URL');
      return;
    }
    setState(() => _busy = true);
    final headers = _textToHeaders(_headersCtrl.text);
    final body = _bodyCtrl.text;
    final sw = Stopwatch()..start();
    try {
      late http.Response resp;
      final req = http.Request(_method, uri);
      req.headers.addAll(headers);
      if (body.isNotEmpty &&
          _method != 'GET' &&
          _method != 'HEAD') {
        req.body = body;
      }
      final streamed = await http.Client()
          .send(req)
          .timeout(const Duration(seconds: 30));
      resp = await http.Response.fromStream(streamed);
      sw.stop();
      setState(() {
        _status = resp.statusCode;
        _ms = sw.elapsedMilliseconds;
        _respCtrl.text = _pretty(resp.body);
        _respHeadersCtrl.text = _headersToText(resp.headers);
        _respType = resp.headers['content-type'];
        _busy = false;
      });
      widget.onReplayed
          ?.call(resp.statusCode, resp.body, resp.headers, sw.elapsedMilliseconds);
    } catch (e) {
      sw.stop();
      setState(() {
        _status = -1;
        _ms = sw.elapsedMilliseconds;
        _respCtrl.text = 'Error: $e';
        _busy = false;
      });
    }
  }

  String _pretty(String s) {
    try {
      final obj = jsonDecode(s);
      return const JsonEncoder.withIndent('  ').convert(obj);
    } catch (_) {
      return s;
    }
  }

  // Render the (possibly edited) response HTML back into the WebView.
  Future<void> _loadIntoPage() async {
    final c = widget.controller;
    if (c == null) {
      _toast('No active page');
      return;
    }
    try {
      await c.loadData(
        data: _respCtrl.text,
        mimeType: 'text/html',
        encoding: 'utf-8',
        baseUrl: WebUri(_urlCtrl.text.trim()),
      );
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      _toast('Load failed: $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.original == null ? 'New Request' : 'Edit & Replay'),
        actions: [
          IconButton(
            tooltip: 'Copy as cURL',
            icon: const Icon(Icons.copy_all),
            onPressed: _copyCurl,
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(14),
        children: [
          // ── REQUEST section ──
          _sectionTitle('⬆️  REQUEST', AppTheme.accent),
          const SizedBox(height: 10),
          Row(children: [
            DropdownButton<String>(
              value: _method,
              dropdownColor: AppTheme.surfaceAlt,
              items: _methods
                  .map((m) => DropdownMenuItem(value: m, child: Text(m)))
                  .toList(),
              onChanged: (v) => setState(() => _method = v ?? 'GET'),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: TextField(
                controller: _urlCtrl,
                style: const TextStyle(fontSize: 13),
                decoration: const InputDecoration(
                    isDense: true, hintText: 'https://…'),
              ),
            ),
          ]),
          const SizedBox(height: 14),
          _labelWithCopy('Request headers (one per line: Key: Value)',
              () => _copyText(_headersCtrl.text)),
          _mono(_headersCtrl, lines: 5),
          const SizedBox(height: 14),
          _labelWithCopy('Request body', () => _copyText(_bodyCtrl.text)),
          _mono(_bodyCtrl, lines: 5, hint: 'Request body…'),
          const SizedBox(height: 16),
          Row(children: [
            Expanded(
              child: ElevatedButton.icon(
                onPressed: _busy ? null : _replay,
                icon: _busy
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2))
                    : const Icon(Icons.send),
                label: Text(_busy ? 'Sending…' : 'Replay'),
              ),
            ),
            const SizedBox(width: 10),
            OutlinedButton.icon(
              onPressed: _respCtrl.text.isEmpty ? null : _loadIntoPage,
              icon: const Icon(Icons.open_in_browser),
              label: const Text('Render'),
            ),
          ]),

          const SizedBox(height: 22),
          const Divider(color: AppTheme.border),
          const SizedBox(height: 8),

          // ── RESPONSE section ──
          _sectionTitle('⬇️  RESPONSE', AppTheme.accent2),
          const SizedBox(height: 10),
          if (_status != null)
            Row(children: [
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                    color: (_status! >= 200 && _status! < 400)
                        ? AppTheme.accent.withOpacity(0.18)
                        : AppTheme.danger.withOpacity(0.18),
                    borderRadius: BorderRadius.circular(6)),
                child: Text('Status $_status',
                    style: TextStyle(
                        fontWeight: FontWeight.w800,
                        color: (_status! >= 200 && _status! < 400)
                            ? AppTheme.accent
                            : AppTheme.danger)),
              ),
              const SizedBox(width: 10),
              if (_ms != null)
                Text('${_ms}ms',
                    style: const TextStyle(color: AppTheme.muted)),
              const Spacer(),
              if (_respType != null && _respType!.isNotEmpty)
                Flexible(
                  child: Text(_respType!.split(';').first,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                          fontSize: 11, color: AppTheme.muted)),
                ),
            ])
          else
            const Text('No response yet — tap Replay, or open a live capture.',
                style: TextStyle(color: AppTheme.muted, fontSize: 12.5)),
          if (_respHeadersCtrl.text.isNotEmpty) ...[
            const SizedBox(height: 12),
            _labelWithCopy('Response headers',
                () => _copyText(_respHeadersCtrl.text)),
            _mono(_respHeadersCtrl, lines: 4),
          ],
          const SizedBox(height: 12),
          Row(children: [
            const Expanded(
              child: Text('Response body (editable → "Render" to load it back)',
                  style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                      color: AppTheme.muted)),
            ),
            IconButton(
              tooltip: 'Pretty-print JSON',
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints(),
              icon: const Icon(Icons.auto_fix_high, size: 18),
              onPressed: () =>
                  setState(() => _respCtrl.text = _pretty(_respCtrl.text)),
            ),
            const SizedBox(width: 12),
            IconButton(
              tooltip: 'Copy response',
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints(),
              icon: const Icon(Icons.copy, size: 18),
              onPressed: () => _copyText(_respCtrl.text),
            ),
          ]),
          const SizedBox(height: 6),
          _mono(_respCtrl, lines: 14),
          const SizedBox(height: 20),
        ],
      ),
    );
  }

  Widget _sectionTitle(String t, Color c) => Row(children: [
        Container(width: 4, height: 18, color: c),
        const SizedBox(width: 8),
        Text(t,
            style: TextStyle(
                fontSize: 14, fontWeight: FontWeight.w900, color: c)),
      ]);

  Widget _mono(TextEditingController c, {int lines = 4, String? hint}) =>
      TextField(
        controller: c,
        maxLines: lines,
        style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
        decoration: InputDecoration(isDense: true, hintText: hint),
      );

  Widget _labelWithCopy(String t, VoidCallback onCopy) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Row(children: [
          Expanded(
            child: Text(t,
                style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                    color: AppTheme.muted)),
          ),
          InkWell(
            onTap: onCopy,
            child: const Icon(Icons.copy, size: 15, color: AppTheme.muted),
          ),
        ]),
      );

  void _copyText(String t) {
    Clipboard.setData(ClipboardData(text: t));
    _toast('Copied');
  }

  void _copyCurl() {
    final headers = _textToHeaders(_headersCtrl.text);
    final sb = StringBuffer("curl -X $_method '${_urlCtrl.text.trim()}'");
    headers.forEach((k, v) => sb.write(" \\\n  -H '$k: $v'"));
    if (_bodyCtrl.text.isNotEmpty && _method != 'GET') {
      sb.write(" \\\n  --data '${_bodyCtrl.text}'");
    }
    Clipboard.setData(ClipboardData(text: sb.toString()));
    _toast('Copied as cURL');
  }

  void _toast(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(m)));
  }

  @override
  void dispose() {
    _urlCtrl.dispose();
    _headersCtrl.dispose();
    _bodyCtrl.dispose();
    _respCtrl.dispose();
    _respHeadersCtrl.dispose();
    super.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 🍪 Cookie editor — view / add / edit / delete + PASTE cookie JSON to log in.
//
// Import format: the standard "Cookie-Editor" / EditThisCookie export — a JSON
// array of objects: [{ "name":"sid", "value":"abc", "domain":".x.com",
//   "path":"/", "secure":true, "httpOnly":false, "expirationDate":1730000000 }]
// We set each cookie on the live site so you can refresh and be logged in.
// ─────────────────────────────────────────────────────────────────────────────
class CookieEditorScreen extends StatefulWidget {
  final String url;
  const CookieEditorScreen({super.key, required this.url});
  @override
  State<CookieEditorScreen> createState() => _CookieEditorScreenState();
}

class _CookieEditorScreenState extends State<CookieEditorScreen> {
  final _cm = CookieManager.instance();
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
        _cookies = await _cm.getCookies(url: WebUri(widget.url));
      }
    } catch (_) {}
    if (mounted) setState(() => _loading = false);
  }

  String get _host => Uri.tryParse(widget.url)?.host ?? widget.url;

  // ── Export current cookies as Cookie-Editor JSON ──
  void _exportJson() {
    final list = _cookies
        .map((c) => {
              'name': c.name,
              'value': c.value,
              'domain': c.domain ?? _host,
              'path': c.path ?? '/',
              'secure': c.isSecure ?? false,
              'httpOnly': c.isHttpOnly ?? false,
              if (c.expiresDate != null) 'expirationDate': c.expiresDate,
            })
        .toList();
    final json = const JsonEncoder.withIndent('  ').convert(list);
    Clipboard.setData(ClipboardData(text: json));
    _toast('Cookie JSON copied (${list.length})');
  }

  // ── Paste cookie JSON → set on the site → refresh-ready login ──
  Future<void> _importJson() async {
    final ctrl = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        backgroundColor: AppTheme.surface,
        title: const Text('Paste cookie JSON'),
        content: SizedBox(
          width: double.maxFinite,
          child: TextField(
            controller: ctrl,
            maxLines: 10,
            style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
            decoration: const InputDecoration(
              hintText:
                  '[{"name":"sid","value":"…","domain":".site.com","path":"/"}]',
            ),
          ),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(c, false),
              child: const Text('Cancel')),
          ElevatedButton(
              onPressed: () => Navigator.pop(c, true),
              child: const Text('Import & login')),
        ],
      ),
    );
    if (ok != true) return;
    await _applyCookieJson(ctrl.text);
  }

  Future<void> _applyCookieJson(String raw) async {
    int set = 0, failed = 0;
    try {
      final parsed = jsonDecode(raw);
      final List list = parsed is List
          ? parsed
          : (parsed is Map && parsed['cookies'] is List
              ? parsed['cookies']
              : []);
      for (final item in list) {
        if (item is! Map) continue;
        final name = (item['name'] ?? '').toString();
        final value = (item['value'] ?? '').toString();
        if (name.isEmpty) continue;
        var domain = (item['domain'] ?? _host).toString();
        if (domain.startsWith('.')) domain = domain.substring(1);
        final path = (item['path'] ?? '/').toString();
        final secure = item['secure'] == true;
        final httpOnly = item['httpOnly'] == true;
        int? expires;
        final exp = item['expirationDate'] ?? item['expires'];
        if (exp is num) {
          // Cookie-Editor uses seconds; CookieManager wants ms.
          expires = (exp > 1e12 ? exp : exp * 1000).round();
        }
        try {
          await _cm.setCookie(
            url: WebUri('https://$domain$path'),
            name: name,
            value: value,
            domain: domain,
            path: path,
            isSecure: secure,
            isHttpOnly: httpOnly,
            expiresDate: expires,
          );
          set++;
        } catch (_) {
          failed++;
        }
      }
    } catch (e) {
      _toast('Invalid JSON: $e');
      return;
    }
    await _load();
    _toast('Imported $set cookie(s)${failed > 0 ? ' · $failed failed' : ''} — refresh the page to log in');
  }

  Future<void> _editCookie(Cookie? existing) async {
    final nameCtrl = TextEditingController(text: existing?.name ?? '');
    final valueCtrl = TextEditingController(text: existing?.value ?? '');
    final saved = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        backgroundColor: AppTheme.surface,
        title: Text(existing == null ? 'Add cookie' : 'Edit cookie'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(
            controller: nameCtrl,
            enabled: existing == null,
            decoration: const InputDecoration(labelText: 'Name'),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: valueCtrl,
            maxLines: 3,
            decoration: const InputDecoration(labelText: 'Value'),
          ),
        ]),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(c, false),
              child: const Text('Cancel')),
          ElevatedButton(
              onPressed: () => Navigator.pop(c, true),
              child: const Text('Save')),
        ],
      ),
    );
    if (saved != true) return;
    try {
      await _cm.setCookie(
        url: WebUri(widget.url),
        name: nameCtrl.text.trim(),
        value: valueCtrl.text,
        domain: _host,
        path: '/',
      );
    } catch (_) {}
    await _load();
    _toast('Saved');
  }

  Future<void> _deleteCookie(Cookie c) async {
    try {
      await _cm.deleteCookie(url: WebUri(widget.url), name: c.name);
    } catch (_) {}
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Cookie Editor'),
        actions: [
          IconButton(
            tooltip: 'Paste JSON',
            icon: const Icon(Icons.content_paste),
            onPressed: _importJson,
          ),
          IconButton(
            tooltip: 'Export JSON',
            icon: const Icon(Icons.download),
            onPressed: _exportJson,
          ),
          IconButton(
            tooltip: 'Delete all for site',
            icon: const Icon(Icons.delete),
            onPressed: () async {
              if (widget.url.isNotEmpty) {
                await _cm.deleteCookies(url: WebUri(widget.url));
              }
              _load();
            },
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton(
        backgroundColor: AppTheme.accent,
        onPressed: () => _editCookie(null),
        child: const Icon(Icons.add),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AppTheme.accent))
          : Column(
              children: [
                Padding(
                  padding: const EdgeInsets.all(12),
                  child: Row(children: [
                    const Icon(Icons.cookie, size: 16, color: AppTheme.muted),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text('$_host · ${_cookies.length} cookie(s)',
                          style: const TextStyle(color: AppTheme.muted)),
                    ),
                  ]),
                ),
                Expanded(
                  child: _cookies.isEmpty
                      ? const Center(
                          child: Text(
                              'No cookies. Tap ＋ to add, or paste a JSON to import a session.',
                              textAlign: TextAlign.center,
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
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(fontSize: 12)),
                              onTap: () => _editCookie(ck),
                              trailing: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  IconButton(
                                    icon: const Icon(Icons.copy, size: 18),
                                    onPressed: () {
                                      Clipboard.setData(ClipboardData(
                                          text: '${ck.name}=${ck.value}'));
                                      _toast('Copied');
                                    },
                                  ),
                                  IconButton(
                                    icon: const Icon(Icons.delete_outline,
                                        size: 18, color: AppTheme.danger),
                                    onPressed: () => _deleteCookie(ck),
                                  ),
                                ],
                              ),
                            );
                          },
                        ),
                ),
              ],
            ),
    );
  }

  void _toast(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(m), duration: const Duration(seconds: 3)));
  }
}
