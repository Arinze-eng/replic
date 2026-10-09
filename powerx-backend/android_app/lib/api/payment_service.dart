import 'dart:convert';
import 'package:http/http.dart' as http;
import 'api_config.dart';
import 'auth_service.dart';

/// Result of starting a checkout.
class PaymentStart {
  final String paymentId;
  final String txRef;
  final int amount;
  final String currency;
  final String plan;
  final String checkoutUrl;
  PaymentStart({
    required this.paymentId,
    required this.txRef,
    required this.amount,
    required this.currency,
    required this.plan,
    required this.checkoutUrl,
  });
}

/// Wires the Flutterwave subscription flow used by the website
/// (`/api/payment/create` → open checkout → `/api/payment/requery`).
///
/// Plans (matching the backend PLAN_PRICES):
///   • Free  — default, no payment
///   • Basic — ₦20,000 / 30 days  (plan: "basic")
///   • Pro   — ₦40,000 / 30 days  (plan: "pro", a.k.a "premium")
class PaymentService {
  /// Start a checkout for [plan] ("basic" | "pro"). Returns the Flutterwave
  /// checkout URL to open + the payment id used to recheck later.
  static Future<PaymentStart> start(String plan) async {
    final auth = AuthService.instance;
    final res = await http
        .post(
          ApiConfig.uri(ApiConfig.paymentCreate),
          headers: auth.authHeaders(json: true),
          body: jsonEncode({'plan': plan}),
        )
        .timeout(const Duration(seconds: 40));
    final body = _decode(res.body);
    if (res.statusCode == 200 && body['ok'] == true && body['checkout_url'] != null) {
      return PaymentStart(
        paymentId: (body['payment_id'] ?? '').toString(),
        txRef: (body['tx_ref'] ?? '').toString(),
        amount: (body['amount'] is int) ? body['amount'] as int : 0,
        currency: (body['currency'] ?? 'NGN').toString(),
        plan: (body['plan'] ?? plan).toString(),
        checkoutUrl: body['checkout_url'].toString(),
      );
    }
    throw PaymentException(
        body['error']?.toString() ?? 'Could not start checkout (${res.statusCode}).');
  }

  /// Re-verify a (possibly hanging) payment. Idempotent on the server.
  /// Returns true once the subscription is active.
  static Future<bool> recheck({required String paymentId, String? txRef}) async {
    final auth = AuthService.instance;
    final res = await http
        .post(
          ApiConfig.uri(ApiConfig.paymentRequery),
          headers: auth.authHeaders(json: true),
          body: jsonEncode({
            'payment_id': paymentId,
            if (txRef != null && txRef.isNotEmpty) 'tx_ref': txRef,
          }),
        )
        .timeout(const Duration(seconds: 40));
    final body = _decode(res.body);
    final completed = body['ok'] == true && (body['status'] == 'completed');
    if (completed) {
      // Refresh the profile so the new tier is reflected app-wide.
      await auth.refreshMe();
    }
    return completed;
  }

  /// Poll recheck a few times (used after the user returns from checkout).
  static Future<bool> pollUntilActive({
    required String paymentId,
    String? txRef,
    int attempts = 6,
    Duration gap = const Duration(seconds: 4),
  }) async {
    for (var i = 0; i < attempts; i++) {
      try {
        if (await recheck(paymentId: paymentId, txRef: txRef)) return true;
      } catch (_) {}
      if (i < attempts - 1) await Future.delayed(gap);
    }
    return false;
  }

  static Map<String, dynamic> _decode(String s) {
    try {
      final d = jsonDecode(s);
      return d is Map<String, dynamic> ? d : {'raw': d};
    } catch (_) {
      return {};
    }
  }

  /// Fetch the pay-as-you-go catalog (Spotify pass, credit packs, …).
  /// Public endpoint — no auth required.
  static Future<List<PaygProduct>> fetchCatalog() async {
    final res = await http
        .get(ApiConfig.uri(ApiConfig.paygProducts))
        .timeout(const Duration(seconds: 30));
    final body = _decode(res.body);
    if (res.statusCode == 200 && body['ok'] == true && body['products'] is List) {
      return (body['products'] as List)
          .whereType<Map>()
          .map((m) => PaygProduct.fromJson(Map<String, dynamic>.from(m)))
          .toList();
    }
    throw PaymentException(body['error']?.toString() ?? 'Could not load products (${res.statusCode}).');
  }

  /// Fetch the current user's active feature passes → { feature: expiryMs }.
  static Future<Map<String, int>> fetchPasses() async {
    final auth = AuthService.instance;
    final res = await http
        .get(ApiConfig.uri(ApiConfig.paygStatus), headers: auth.authHeaders())
        .timeout(const Duration(seconds: 30));
    final body = _decode(res.body);
    final out = <String, int>{};
    if (res.statusCode == 200 && body['ok'] == true && body['passes'] is Map) {
      (body['passes'] as Map).forEach((k, v) {
        final n = (v is int) ? v : int.tryParse('$v');
        if (n != null) out['$k'] = n;
      });
    }
    return out;
  }
}

/// A single pay-as-you-go product from the backend catalog.
class PaygProduct {
  final String id;        // e.g. "spotify" | "credits_500"
  final String kind;      // "pass" | "credits"
  final int amount;       // Naira price
  final String currency;  // "NGN"
  final String label;     // human label
  final int? days;        // for passes
  final int? credits;     // for credit packs
  final String? feature;  // canonical feature key (passes only)
  PaygProduct({
    required this.id,
    required this.kind,
    required this.amount,
    required this.currency,
    required this.label,
    this.days,
    this.credits,
    this.feature,
  });
  factory PaygProduct.fromJson(Map<String, dynamic> j) => PaygProduct(
        id: (j['id'] ?? '').toString(),
        kind: (j['kind'] ?? 'pass').toString(),
        amount: (j['amount'] is int) ? j['amount'] as int : int.tryParse('${j['amount']}') ?? 0,
        currency: (j['currency'] ?? 'NGN').toString(),
        label: (j['label'] ?? '').toString(),
        days: (j['days'] is int) ? j['days'] as int : int.tryParse('${j['days']}'),
        credits: (j['credits'] is int) ? j['credits'] as int : int.tryParse('${j['credits']}'),
        feature: j['feature']?.toString(),
      );
  bool get isPass => kind == 'pass';
}

class PaymentException implements Exception {
  final String message;
  PaymentException(this.message);
  @override
  String toString() => message;
}
