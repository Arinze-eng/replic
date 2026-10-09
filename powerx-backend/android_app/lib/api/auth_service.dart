import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:uuid/uuid.dart';
import 'package:device_info_plus/device_info_plus.dart';
import 'api_config.dart';

/// Holds the signed-in user + JWT, and exposes auth operations.
/// Wires to /api/auth/signup, /api/auth/login, /api/auth/me.
class AuthService extends ChangeNotifier {
  static final AuthService instance = AuthService._();
  AuthService._();

  final _storage = const FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  static const _kToken = 'hae_token';
  static const _kDevice = 'hae_device';
  static const _kUser = 'hae_user';

  String? _token;
  Map<String, dynamic>? _user;
  bool _booted = false;

  String? get token => _token;
  Map<String, dynamic>? get user => _user;
  bool get isLoggedIn => _token != null && _token!.isNotEmpty;
  bool get booted => _booted;

  String get username => (_user?['username'] ?? 'user').toString();
  String get email => (_user?['email'] ?? '').toString();
  String get tier {
    final s = (_user?['subscription_status'] ?? 'free').toString();
    if (s == 'active') {
      final p = (_user?['subscription_plan'] ?? '').toString();
      return p.isEmpty ? 'Active' : p[0].toUpperCase() + p.substring(1);
    }
    return s[0].toUpperCase() + s.substring(1);
  }

  /// Load any persisted session at startup.
  Future<void> boot() async {
    _token = await _storage.read(key: _kToken);
    final u = await _storage.read(key: _kUser);
    if (u != null) {
      try {
        _user = jsonDecode(u) as Map<String, dynamic>;
      } catch (_) {}
    }
    _booted = true;
    notifyListeners();
    // Best-effort refresh of the profile (validates the token too).
    if (isLoggedIn) {
      refreshMe().catchError((_) {});
    }
  }

  /// Strong, STABLE per-device id used for "1 account per device" anti-loot.
  ///
  /// This mirrors the website's anti-loot guarantee ("one account per physical
  /// device"), but hardens it for Android: instead of a purely random UUID that
  /// a looter could reset by clearing app data / reinstalling, we DERIVE the id
  /// from a stable hardware identifier (Android `id`, i.e. Settings.Secure
  /// ANDROID_ID). That value survives app reinstalls and data wipes and only
  /// changes on a factory reset — so the SAME physical phone stays anchored,
  /// while a genuine NEW device produces a different id and is never blocked.
  ///
  /// SAFETY (never lock out a legitimate user):
  ///   • The derived id is cached in secure storage. Once a phone has an id it
  ///     keeps it, so a transient failure to read hardware info never changes
  ///     the device identity for an existing install.
  ///   • If we have no cached id AND cannot read a usable hardware id (very old
  ///     OS, emulator quirk, permission edge case), we fall back to a random
  ///     UUID — exactly the old behaviour — so signup still works. The backend
  ///     `DEVICE_LIMIT_ENABLED` kill-switch can also disable the check instantly.
  Future<String> deviceId() async {
    // 1) Reuse the already-anchored id if this install has one.
    final cached = await _storage.read(key: _kDevice);
    if (cached != null && cached.isNotEmpty) return cached;

    // 2) Derive a stable id from the device hardware so clearing app data /
    //    reinstalling does NOT mint a fresh device (anti-loot, same as web).
    String? id;
    try {
      final info = DeviceInfoPlugin();
      final android = await info.androidInfo;
      // ANDROID_ID: stable per device+signing-key, survives reinstall, resets
      // only on factory reset. Combine with a couple of immutable hardware
      // fields to further reduce any chance of cross-device collision.
      final hw = (android.id).trim();
      final fingerprintBits = [
        hw,
        android.fingerprint,
        android.hardware,
        android.model,
      ].where((s) => s.trim().isNotEmpty).join('|');
      // Treat empty / known-bad emulator values as "no usable hardware id".
      final bad = hw.isEmpty ||
          hw == 'unknown' ||
          hw == '0000000000000000' ||
          hw == '9774d56d682e549c'; // legacy buggy emulator ANDROID_ID
      if (!bad && fingerprintBits.isNotEmpty) {
        // Deterministic UUIDv5 in a fixed namespace → same phone => same id,
        // different phone => different id. Never reversible to the raw hw id.
        const ns = 'hae-anti-loot-v1';
        id = const Uuid().v5(Namespace.url.value, '$ns:$fingerprintBits');
      }
    } catch (_) {
      // Ignore — fall through to the random fallback below.
    }

    // 3) Fallback: genuine random UUID (old behaviour). Guarantees a legit user
    //    can ALWAYS sign up even if hardware info is unavailable.
    id ??= const Uuid().v4();

    await _storage.write(key: _kDevice, value: id);
    return id;
  }

  Map<String, String> authHeaders({bool json = false}) {
    return {
      if (_token != null) 'Authorization': 'Bearer $_token',
      if (json) 'Content-Type': 'application/json',
      // Identifies this client as the native Android APK so the backend can
      // tag the user's platform and surface them in the admin "APK Users" tab.
      'X-Client-Platform': 'apk',
    };
  }

  Future<void> _persist(String token, Map<String, dynamic> user) async {
    _token = token;
    _user = user;
    await _storage.write(key: _kToken, value: token);
    await _storage.write(key: _kUser, value: jsonEncode(user));
    notifyListeners();
  }

  /// A coarse, non-unique hardware fingerprint string for admin analytics only.
  /// (The authoritative anti-loot anchor is `deviceId()`, NOT this value.)
  /// Best-effort — returns the device_id as a safe fallback so the field is
  /// never empty and signup never breaks.
  Future<String> _fingerprint(String fallback) async {
    try {
      final info = DeviceInfoPlugin();
      final a = await info.androidInfo;
      final fp = [a.brand, a.model, a.device, a.version.sdkInt.toString()]
          .where((s) => s.trim().isNotEmpty)
          .join('|');
      return fp.isNotEmpty ? fp : fallback;
    } catch (_) {
      return fallback;
    }
  }

  /// Sign up. Throws [AuthException] with a friendly message on failure.
  Future<void> signup({
    required String email,
    required String password,
    required String username,
  }) async {
    final dev = await deviceId();
    final fp = await _fingerprint(dev);
    final res = await http
        .post(
          ApiConfig.uri(ApiConfig.signup),
          headers: {'Content-Type': 'application/json', 'X-Client-Platform': 'apk'},
          body: jsonEncode({
            'email': email.trim(),
            'password': password,
            'username': username.trim(),
            // Stable per-physical-device anchor → backend enforces
            // "1 account per device" (same anti-loot method as the website).
            'device_id': dev,
            'fingerprint': fp,
          }),
        )
        .timeout(const Duration(seconds: 40));
    final body = _decode(res.body);
    if (res.statusCode == 200 && body['ok'] == true && body['token'] != null) {
      await _persist(body['token'].toString(),
          (body['user'] as Map).cast<String, dynamic>());
      return;
    }
    throw AuthException(body['error']?.toString() ?? 'Signup failed (${res.statusCode}).');
  }

  /// Log in.
  Future<void> login({required String email, required String password}) async {
    final res = await http
        .post(
          ApiConfig.uri(ApiConfig.login),
          headers: {'Content-Type': 'application/json', 'X-Client-Platform': 'apk'},
          body: jsonEncode({'email': email.trim(), 'password': password}),
        )
        .timeout(const Duration(seconds: 40));
    final body = _decode(res.body);
    if (res.statusCode == 200 && body['ok'] == true && body['token'] != null) {
      await _persist(body['token'].toString(),
          (body['user'] as Map).cast<String, dynamic>());
      return;
    }
    throw AuthException(body['error']?.toString() ?? 'Invalid email or password.');
  }

  /// Refresh the profile from /api/auth/me.
  Future<void> refreshMe() async {
    if (!isLoggedIn) return;
    final res = await http
        .get(ApiConfig.uri(ApiConfig.me), headers: authHeaders())
        .timeout(const Duration(seconds: 30));
    if (res.statusCode == 401 || res.statusCode == 403) {
      await logout();
      return;
    }
    final body = _decode(res.body);
    if (res.statusCode == 200 && body['user'] != null) {
      _user = (body['user'] as Map).cast<String, dynamic>();
      await _storage.write(key: _kUser, value: jsonEncode(_user));
      notifyListeners();
    }
  }

  Future<void> logout() async {
    _token = null;
    _user = null;
    await _storage.delete(key: _kToken);
    await _storage.delete(key: _kUser);
    notifyListeners();
  }

  Map<String, dynamic> _decode(String s) {
    try {
      final d = jsonDecode(s);
      return d is Map<String, dynamic> ? d : {'raw': d};
    } catch (_) {
      return {};
    }
  }
}

class AuthException implements Exception {
  final String message;
  AuthException(this.message);
  @override
  String toString() => message;
}
