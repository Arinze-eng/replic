import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'api_config.dart';
import 'auth_service.dart';

/// A single streamed event from the agent SSE endpoint.
class AgentEvent {
  final String type; // start | step | done | error
  final Map<String, dynamic> data;
  AgentEvent(this.type, this.data);
}

/// A file returned by the agent (decoded + saved to disk, OR hosted by URL).
class AgentFile {
  final String name;
  final int size;
  final String? localPath; // set once downloaded to device
  final String? url;       // durable Supabase Storage URL (survives reopen)
  final bool tooLarge;
  AgentFile({required this.name, required this.size, this.localPath, this.url, this.tooLarge = false});

  Map<String, dynamic> toJson() => {
        'name': name,
        'size': size,
        if (url != null) 'url': url,
        'tooLarge': tooLarge,
      };

  factory AgentFile.fromJson(Map m) => AgentFile(
        name: (m['name'] ?? 'file').toString(),
        size: (m['size'] is int) ? m['size'] as int : 0,
        url: m['url']?.toString(),
        tooLarge: m['tooLarge'] == true,
      );
}

/// Streams the sandbox-synced AI agent (/api/agent/run or /api/lemon/run).
///
/// The backend responds with Server-Sent Events:
///   event: start  data: {tier, ok}
///   event: step   data: {note}
///   event: done   data: {message, files:[{name,size,b64}|{name,tooLarge,size}], steps}
///   event: error  data: {error}
///
/// This mirrors EXACTLY what the website + Telegram bot use, so the app's agent
/// runs inside the SAME persistent sandbox.
class AgentService {
  // ── 🦫 Admin-controlled stream timeout ──────────────────────────────────────
  // The OLD client hard-capped the agent stream at a fixed 13 minutes, so a long
  // Capy task was killed by the APP even when the admin raised the Capy timeout
  // (capy_timeout_ms) on the server — the run would "time out at ~900s and fall
  // back to another bot". We now resolve the timeout from the SERVER's
  // admin-settable Capy ceiling (GET /api/capy → pollCeilingSeconds) and add a
  // generous safety margin, so the client NEVER aborts before the server-side
  // Capy poll finishes. This makes the timeout fully admin-controlled with NO
  // further APK rebuild: change it in the admin panel and the app follows.
  //
  // The value is fetched lazily, cached for the session, and re-fetched if the
  // cache is older than 5 minutes — so an admin change is picked up quickly.
  //
  // FALLBACK POLICY: if the server config CANNOT be fetched (offline, error),
  // we fall back to a safe 1 HOUR window — long enough for most real tasks, but
  // not an indefinite hang. When the fetch SUCCEEDS the admin's value is used
  // (clamped to the 60s … 6h window), so it is fully admin-controlled.
  static const Duration _fallbackTimeout = Duration(hours: 1); // when config fetch fails
  static Duration _cachedStreamTimeout = _fallbackTimeout;
  static DateTime? _cachedAt;
  static const Duration _cacheTtl = Duration(minutes: 5);
  // Extra headroom added on top of the server's Capy ceiling so the client is
  // always the LAST thing to give up (sandbox spin-up, file harvest, upload…).
  static const Duration _timeoutMargin = Duration(minutes: 5);
  // Absolute clamps mirroring the server (60s floor, 6h ceiling) for the
  // admin-set value when the config fetch succeeds.
  static const Duration _minTimeout = Duration(seconds: 60);
  static const Duration _maxTimeout = Duration(hours: 6);

  /// Resolve the admin-controlled stream timeout. Reads the server's effective
  /// Capy ceiling (pollCeilingSeconds) + a safety margin. Cached; never throws.
  /// On any failure it returns the safe 1-hour fallback.
  static Future<Duration> _resolveStreamTimeout() async {
    final now = DateTime.now();
    if (_cachedAt != null && now.difference(_cachedAt!) < _cacheTtl) {
      return _cachedStreamTimeout;
    }
    try {
      final auth = AuthService.instance;
      final resp = await http
          .get(ApiConfig.uri(ApiConfig.capyConfig), headers: auth.authHeaders())
          .timeout(const Duration(seconds: 12));
      if (resp.statusCode == 200) {
        final j = jsonDecode(resp.body) as Map<String, dynamic>;
        num? secs;
        if (j['pollCeilingSeconds'] is num) {
          secs = j['pollCeilingSeconds'] as num;
        } else if (j['pollCeilingMs'] is num) {
          secs = (j['pollCeilingMs'] as num) / 1000.0;
        }
        if (secs != null && secs > 0) {
          var d = Duration(seconds: secs.round()) + _timeoutMargin;
          if (d < _minTimeout) d = _minTimeout;
          if (d > _maxTimeout) d = _maxTimeout;
          _cachedStreamTimeout = d; // ✅ admin-controlled value
          _cachedAt = now;
          return d;
        }
      }
    } catch (_) {
      // Network/parse failure → fall through to the safe fallback below.
    }
    // Fetch failed or returned no usable value → use the 1-hour fallback.
    _cachedStreamTimeout = _fallbackTimeout;
    _cachedAt = now; // avoid hammering the endpoint on repeated failures
    return _cachedStreamTimeout;
  }

  /// Public accessor for the admin-controlled stream timeout, used by the UI's
  /// background job resumer so a reopened app polls a long-running task for the
  /// SAME window the live stream would have allowed (instead of a fixed cap).
  static Future<Duration> resumePollBudget() => _resolveStreamTimeout();

  /// Run a task. [endpoint] is ApiConfig.agentRun (WormGPT) or lemonRun (Lemon).
  /// [files] are local file paths to upload as multipart `files[]`.
  /// [mode] selects the backend behaviour:
  ///   • 'heavy'  → Capy heavy-task agent (Capy's own cloud sandbox, files, long-running)
  ///   • 'fusion' → uncensored hotbot/Gemini/racers fusion brain in the in-house sandbox
  static Stream<AgentEvent> run({
    required String task,
    String endpoint = ApiConfig.agentRun,
    List<String> files = const [],
    String? clientMsgId,
    String mode = 'heavy',
  }) async* {
    final auth = AuthService.instance;
    final req = http.MultipartRequest('POST', ApiConfig.uri(endpoint));
    req.headers.addAll(auth.authHeaders());
    req.fields['task'] = task;
    req.fields['mode'] = mode;
    if (clientMsgId != null) req.fields['client_msg_id'] = clientMsgId;
    for (final p in files) {
      try {
        req.files.add(await http.MultipartFile.fromPath('files', p));
      } catch (_) {}
    }

    // 🦫 Admin-controlled: never cut the stream before the server's Capy ceiling.
    final streamTimeout = await _resolveStreamTimeout();

    final client = http.Client();
    try {
      final streamed = await client.send(req).timeout(streamTimeout);

      if (streamed.statusCode == 401 || streamed.statusCode == 403) {
        yield AgentEvent('error', {'error': 'Session expired — please sign in again.'});
        await auth.logout();
        return;
      }
      if (streamed.statusCode >= 400) {
        yield AgentEvent('error', {'error': 'Agent error (HTTP ${streamed.statusCode}).'});
        return;
      }

      // SSE parser: accumulate lines, dispatch on blank-line frame boundary.
      String currentEvent = 'message';
      final dataBuffer = StringBuffer();

      final lines = streamed.stream
          .transform(utf8.decoder)
          .transform(const LineSplitter());

      await for (final line in lines) {
        if (line.isEmpty) {
          // Frame complete.
          if (dataBuffer.isNotEmpty) {
            final raw = dataBuffer.toString();
            dataBuffer.clear();
            Map<String, dynamic> parsed;
            try {
              parsed = jsonDecode(raw) as Map<String, dynamic>;
            } catch (_) {
              parsed = {'raw': raw};
            }
            yield AgentEvent(currentEvent, parsed);
            if (currentEvent == 'done' || currentEvent == 'error') {
              return;
            }
          }
          currentEvent = 'message';
          continue;
        }
        if (line.startsWith('event:')) {
          currentEvent = line.substring(6).trim();
        } else if (line.startsWith('data:')) {
          if (dataBuffer.isNotEmpty) dataBuffer.write('\n');
          dataBuffer.write(line.substring(5).trim());
        }
        // ignore comments / other fields
      }
    } on TimeoutException {
      yield AgentEvent('error', {'error': 'The task took too long — the sandbox may be busy. Try again.'});
    } catch (e) {
      yield AgentEvent('error', {'error': 'Connection failed: $e'});
    } finally {
      client.close();
    }
  }

  /// Convert the `files` array of a `done` event (or a job row) into AgentFile
  /// objects. Prefers the durable Supabase Storage `url` (survives app reopen);
  /// falls back to inline base64 by writing it to local storage for older
  /// payloads. URL-only files are downloaded lazily on tap (see _FileChip).
  static Future<List<AgentFile>> saveFiles(List<dynamic> rawFiles) async {
    final out = <AgentFile>[];
    if (rawFiles.isEmpty) return out;
    Directory? outDir;

    for (final f in rawFiles) {
      if (f is! Map) continue;
      final name = (f['name'] ?? 'file').toString();
      final size = (f['size'] is int) ? f['size'] as int : 0;
      final url = f['url']?.toString();

      // Preferred path: durable hosted URL. Keep it; download happens on tap.
      if (url != null && url.isNotEmpty) {
        out.add(AgentFile(name: name, size: size, url: url, tooLarge: false));
        continue;
      }

      if (f['tooLarge'] == true) {
        out.add(AgentFile(name: name, size: size, tooLarge: true));
        continue;
      }

      // Legacy path: inline base64 → write to device immediately.
      final b64 = f['b64']?.toString();
      if (b64 == null || b64.isEmpty) continue;
      try {
        outDir ??= await _ensureDir();
        final bytes = base64Decode(b64);
        final safe = name.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_');
        final ts = DateTime.now().millisecondsSinceEpoch;
        final path = '${outDir.path}/${ts}_$safe';
        await File(path).writeAsBytes(bytes, flush: true);
        out.add(AgentFile(name: name, size: bytes.length, localPath: path));
      } catch (_) {}
    }
    return out;
  }

  static Future<Directory> _ensureDir() async {
    final dir = await getApplicationDocumentsDirectory();
    final outDir = Directory('${dir.path}/agent_files');
    if (!await outDir.exists()) await outDir.create(recursive: true);
    return outDir;
  }

  /// Download a hosted file to local storage so it can be opened/shared.
  /// Returns the local path, or null on failure.
  static Future<String?> downloadToDevice(AgentFile file) async {
    if (file.url == null || file.url!.isEmpty) return file.localPath;
    try {
      final res = await http
          .get(Uri.parse(file.url!))
          .timeout(const Duration(seconds: 60));
      if (res.statusCode != 200) return null;
      final outDir = await _ensureDir();
      final safe = file.name.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_');
      final ts = DateTime.now().millisecondsSinceEpoch;
      final path = '${outDir.path}/${ts}_$safe';
      await File(path).writeAsBytes(res.bodyBytes, flush: true);
      return path;
    } catch (_) {
      return null;
    }
  }

  /// Poll the LIVE sandbox screen for a job. Returns the latest frame + state.
  ///
  /// This is the RELIABILITY backbone for the live view on mobile: the SSE
  /// `screen` stream is routinely buffered/cut by Render + Cloudflare on mobile
  /// networks, so the app may receive ZERO frames in-band. This plain HTTP GET
  /// (which sails through every proxy) lets the viewer render the agent's screen
  /// regardless of SSE health. Pass [sinceN] = the last frame number you already
  /// have so the server skips re-sending an unchanged (large) frame.
  ///
  /// Returns a map: { found, active, started, ended, w, h, n, ts, frame? }
  /// or null on a transient/network error (caller just retries on its timer).
  static Future<Map<String, dynamic>?> getLiveFrame(String jobId, {int sinceN = -1}) async {
    final auth = AuthService.instance;
    if (!auth.isLoggedIn || jobId.isEmpty) return null;
    try {
      final res = await http
          .get(ApiConfig.uri('/api/agent/live/$jobId?since=$sinceN'),
              headers: auth.authHeaders())
          .timeout(const Duration(seconds: 12));
      if (res.statusCode != 200) return null;
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      return body;
    } catch (_) {
      return null;
    }
  }

  /// Stop a running durable task. The backend enforces job ownership and also
  /// writes the remote sandbox stop flag so an active command halts promptly.
  static Future<bool> stopJob(String jobId) async {
    final auth = AuthService.instance;
    if (!auth.isLoggedIn || jobId.isEmpty) return false;
    try {
      final res = await http
          .post(ApiConfig.uri('/api/agent/jobs/$jobId/stop'), headers: auth.authHeaders())
          .timeout(const Duration(seconds: 20));
      if (res.statusCode != 200) return false;
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      return body['ok'] == true;
    } catch (_) {
      return false;
    }
  }

  /// Poll a single job by id. Returns the job map, or null on error/not-found.
  static Future<Map<String, dynamic>?> getJob(String jobId) async {
    final auth = AuthService.instance;
    if (!auth.isLoggedIn) return null;
    try {
      final res = await http
          .get(ApiConfig.uri('/api/agent/job/$jobId'), headers: auth.authHeaders())
          .timeout(const Duration(seconds: 20));
      if (res.statusCode != 200) return null;
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      final job = body['job'];
      return job is Map ? job.cast<String, dynamic>() : null;
    } catch (_) {
      return null;
    }
  }

  /// Find the durable job created for a specific [clientMsgId] in [scope].
  ///
  /// This is the RELIABILITY backbone: the backend creates the agent_jobs row
  /// (with our client_msg_id) the instant a task starts, BEFORE any SSE data is
  /// flushed. Render/Cloudflare frequently buffer or cut the SSE stream so the
  /// app may receive ZERO live events — meaning the in-band `job` event (which
  /// carries the jobId) never arrives and the task looks "stuck in the sandbox".
  /// By querying the jobs list and matching on client_msg_id we recover the
  /// jobId WITHOUT depending on SSE at all, then poll it to completion.
  ///
  /// Returns the matching job's id, or null if not found yet (caller retries).
  static Future<String?> findJobByClientMsgId(String scope, String clientMsgId) async {
    if (clientMsgId.isEmpty) return null;
    final jobs = await getJobs(scope);
    for (final j in jobs) {
      final cid = (j['client_msg_id'] ?? '').toString();
      if (cid.isNotEmpty && cid == clientMsgId) {
        final id = (j['id'] ?? '').toString();
        if (id.isNotEmpty) return id;
      }
    }
    return null;
  }

  /// List recent jobs for a scope ('agent' | 'lemon'), newest first.
  static Future<List<Map<String, dynamic>>> getJobs(String scope, {String? status}) async {
    final auth = AuthService.instance;
    if (!auth.isLoggedIn) return [];
    try {
      var path = '/api/agent/jobs?scope=$scope';
      if (status != null) path += '&status=$status';
      final res = await http
          .get(ApiConfig.uri(path), headers: auth.authHeaders())
          .timeout(const Duration(seconds: 20));
      if (res.statusCode != 200) return [];
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      final list = (body['jobs'] as List?) ?? const [];
      return list.whereType<Map>().map((m) => m.cast<String, dynamic>()).toList();
    } catch (_) {
      return [];
    }
  }
}
