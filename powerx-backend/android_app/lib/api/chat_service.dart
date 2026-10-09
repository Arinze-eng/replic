import 'dart:convert';
import 'package:http/http.dart' as http;
import 'api_config.dart';
import 'auth_service.dart';

/// Simple request/response chat endpoints (non-streaming):
///   /api/chat          → HotBot / GPT-5  (returns {message})
///   /api/wormgpt/chat  → uncensored      (returns {reply|message})
class ChatService {
  static Future<String> send({
    required String message,
    required String endpoint,
    String? imageDataUrl,
    bool examMode = false,
  }) async {
    final auth = AuthService.instance;
    final payload = <String, dynamic>{'message': message};
    // Attach the picture as a data-URL (data:image/jpeg;base64,...) so the
    // backend /api/chat vision path can see it. Only the default (HotBot/GPT-5)
    // endpoint supports vision, so images are only sent there.
    if (imageDataUrl != null && imageDataUrl.isNotEmpty) {
      payload['image'] = imageDataUrl;
    }
    // Exam Mode → backend prepends a fast, answer-first, LaTeX-formatted
    // directive optimised for CBT exams (features.exam === true).
    if (examMode) {
      payload['features'] = {'exam': true};
    }

    // ── Primary: Render backend (full brain + tools + vision) ──────────────
    // We keep the generous 90s window so a heavy task isn't cut off, BUT if the
    // very first bytes never arrive (classic free-tier cold start) OR Render
    // returns a 5xx / connection error, we transparently fall over to the
    // always-on Supabase chat fallback so the user still gets an instant reply.
    try {
      final res = await http
          .post(
            ApiConfig.uri(endpoint),
            headers: auth.authHeaders(json: true),
            body: jsonEncode(payload),
          )
          .timeout(const Duration(seconds: 90));

      if (res.statusCode == 401 || res.statusCode == 403) {
        await auth.logout();
        throw 'Session expired — please sign in again.';
      }
      // 5xx → Render is up but erroring / mid-restart → try the fallback.
      if (res.statusCode >= 500) {
        final fb = await _supabaseFallback(message, examMode: examMode);
        if (fb != null) return fb;
      }
      Map<String, dynamic> body;
      try {
        body = jsonDecode(res.body) as Map<String, dynamic>;
      } catch (_) {
        // Unparseable body (e.g. an HTML 502 from the platform) → fallback.
        final fb = await _supabaseFallback(message, examMode: examMode);
        if (fb != null) return fb;
        throw 'Unexpected server response.';
      }
      if (res.statusCode != 200 || body['error'] != null) {
        // A non-auth error from Render → last-chance fallback before surfacing.
        final fb = await _supabaseFallback(message, examMode: examMode);
        if (fb != null) return fb;
        throw (body['error'] ?? 'Request failed (${res.statusCode}).')
            .toString();
      }
      return (body['message'] ?? body['reply'] ?? body['response'] ?? '…')
          .toString();
    } catch (e) {
      // A thrown auth message must NOT be swallowed by the fallback.
      final msg = e.toString();
      if (msg.contains('Session expired')) rethrow;
      // Timeout / socket error / cold start → the fallback is the whole point.
      final fb = await _supabaseFallback(message, examMode: examMode);
      if (fb != null) return fb;
      rethrow;
    }
  }

  /// 🛟 Ask the always-on Supabase Edge Function (independent of Render) for a
  /// chat reply. Returns null if the fallback is disabled or also fails, so the
  /// caller can surface the original Render error. Chat-only (no tools/vision).
  static Future<String?> _supabaseFallback(String message,
      {bool examMode = false}) async {
    final url = ApiConfig.supabaseFallbackUrl.trim();
    if (url.isEmpty) return null;
    try {
      final headers = <String, String>{'Content-Type': 'application/json'};
      if (ApiConfig.supabaseAnonKey.isNotEmpty) {
        headers['apikey'] = ApiConfig.supabaseAnonKey;
        headers['Authorization'] = 'Bearer ${ApiConfig.supabaseAnonKey}';
      }
      final res = await http
          .post(
            Uri.parse(url),
            headers: headers,
            body: jsonEncode({'message': message}),
          )
          .timeout(const Duration(seconds: 40));
      if (res.statusCode != 200) return null;
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      final reply =
          (body['message'] ?? body['reply'] ?? body['response'])?.toString();
      if (reply == null || reply.trim().isEmpty) return null;
      // A small, honest note so the user knows this came from the standby brain
      // while the main server was waking up.
      return '$reply\n\n_⚡ Answered by the standby AI while the main server was waking up._';
    } catch (_) {
      return null;
    }
  }

  /// Usage / tier status: /api/evilgpt/status
  static Future<Map<String, dynamic>> status() async {
    final auth = AuthService.instance;
    final res = await http
        .get(ApiConfig.uri(ApiConfig.evilgptStatus), headers: auth.authHeaders())
        .timeout(const Duration(seconds: 30));
    try {
      return jsonDecode(res.body) as Map<String, dynamic>;
    } catch (_) {
      return {};
    }
  }
}

