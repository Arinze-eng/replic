import 'dart:convert';
import 'package:http/http.dart' as http;
import 'api_config.dart';
import 'auth_service.dart';

/// Persists chat / agent conversations to the backend (Supabase-backed) so they
/// SURVIVE the app being closed & reopened. Rows auto-expire after 2 days on the
/// server (pg_cron + opportunistic prune), so nothing lingers forever.
///
/// Endpoints (server.js):
///   GET    /api/apk/chat-history?scope=<scope>          → {messages:[...]}
///   POST   /api/apk/chat-history  {scope, role, ...}    → {id}
///   PUT    /api/apk/chat-history  {id|client_msg_id...} → {ok}
///   DELETE /api/apk/chat-history?scope=<scope>          → {ok}
///
/// `scope` is the screen: 'chat' | 'wormgpt' | 'agent' | 'lemon'.
class ChatHistoryService {
  /// Load saved messages for a scope (oldest → newest). Never throws — returns
  /// an empty list on any error so the UI always opens.
  static Future<List<Map<String, dynamic>>> load(String scope) async {
    final auth = AuthService.instance;
    if (!auth.isLoggedIn) return [];
    try {
      final res = await http
          .get(ApiConfig.uri('/api/apk/chat-history?scope=$scope'),
              headers: auth.authHeaders())
          .timeout(const Duration(seconds: 20));
      if (res.statusCode != 200) return [];
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      final list = (body['messages'] as List?) ?? const [];
      return list
          .whereType<Map>()
          .map((m) => m.cast<String, dynamic>())
          .toList();
    } catch (_) {
      return [];
    }
  }

  /// Append a message. Returns the server row id (or null). Never throws.
  static Future<int?> save({
    required String scope,
    required String role, // 'user' | 'assistant'
    String content = '',
    List<String>? steps,
    List<Map<String, dynamic>>? files,
    List<String>? attachments,
    bool isError = false,
    bool running = false,
    String? clientMsgId,
  }) async {
    final auth = AuthService.instance;
    if (!auth.isLoggedIn) return null;
    try {
      final res = await http
          .post(
            ApiConfig.uri('/api/apk/chat-history'),
            headers: auth.authHeaders(json: true),
            body: jsonEncode({
              'scope': scope,
              'role': role,
              'content': content,
              if (steps != null) 'steps': steps,
              if (files != null) 'files': files,
              if (attachments != null) 'attachments': attachments,
              'is_error': isError,
              'running': running,
              if (clientMsgId != null) 'client_msg_id': clientMsgId,
            }),
          )
          .timeout(const Duration(seconds: 20));
      if (res.statusCode != 200) return null;
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      final id = body['id'];
      return id is int ? id : (id is num ? id.toInt() : null);
    } catch (_) {
      return null;
    }
  }

  /// Update an existing message (e.g. fill in an agent task's final result, or
  /// flip `running` → false). Match by [id] or [clientMsgId]+[scope]. Never throws.
  static Future<void> update({
    int? id,
    String? clientMsgId,
    String? scope,
    String? content,
    List<String>? steps,
    List<Map<String, dynamic>>? files,
    bool? isError,
    bool? running,
    String? jobId,
  }) async {
    final auth = AuthService.instance;
    if (!auth.isLoggedIn) return;
    if (id == null && clientMsgId == null) return;
    try {
      await http
          .put(
            ApiConfig.uri('/api/apk/chat-history'),
            headers: auth.authHeaders(json: true),
            body: jsonEncode({
              if (id != null) 'id': id,
              if (clientMsgId != null) 'client_msg_id': clientMsgId,
              if (scope != null) 'scope': scope,
              if (content != null) 'content': content,
              if (steps != null) 'steps': steps,
              if (files != null) 'files': files,
              if (isError != null) 'is_error': isError,
              if (running != null) 'running': running,
              if (jobId != null) 'job_id': jobId,
            }),
          )
          .timeout(const Duration(seconds: 20));
    } catch (_) {}
  }

  /// Clear a scope's saved history (in-app "Clear" button). Never throws.
  static Future<void> clear(String scope) async {
    final auth = AuthService.instance;
    if (!auth.isLoggedIn) return;
    try {
      await http
          .delete(ApiConfig.uri('/api/apk/chat-history?scope=$scope'),
              headers: auth.authHeaders())
          .timeout(const Duration(seconds: 20));
    } catch (_) {}
  }
}
