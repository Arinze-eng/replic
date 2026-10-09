import 'dart:convert';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';
import 'api_config.dart';
import 'auth_service.dart';

/// Bridge to the native Phone Guard (CallScreeningService) + the backend
/// caller-ID lookup. All native calls are no-ops on platforms without the
/// channel (so the app never crashes on iOS / web).
class CallGuardService {
  CallGuardService._();
  static final CallGuardService instance = CallGuardService._();

  static const _ch = MethodChannel('com.hackerx.wormgpt_agent/callguard');

  Future<T?> _invoke<T>(String m, [Map<String, dynamic>? args]) async {
    try {
      return await _ch.invokeMethod<T>(m, args);
    } on MissingPluginException {
      return null; // not Android / channel absent
    } catch (_) {
      return null;
    }
  }

  // ── Role / master toggles ─────────────────────────────────────────────
  Future<bool> isRoleHeld() async => (await _invoke<bool>('isScreeningRoleHeld')) ?? false;
  Future<void> requestRole() async => _invoke('requestScreeningRole');

  Future<bool> isEnabled() async => (await _invoke<bool>('isEnabled')) ?? false;
  Future<void> setEnabled(bool v) async => _invoke('setEnabled', {'value': v});

  Future<bool> isBlockPrivate() async => (await _invoke<bool>('isBlockPrivate')) ?? false;
  Future<void> setBlockPrivate(bool v) async => _invoke('setBlockPrivate', {'value': v});

  // ── Block lists ───────────────────────────────────────────────────────
  Future<List<String>> getExact() async =>
      (await _invoke<List<dynamic>>('getExact'))?.cast<String>() ?? [];
  Future<void> setExact(List<String> v) async => _invoke('setExact', {'items': v});

  Future<List<String>> getPrefix() async =>
      (await _invoke<List<dynamic>>('getPrefix'))?.cast<String>() ?? [];
  Future<void> setPrefix(List<String> v) async => _invoke('setPrefix', {'items': v});

  Future<List<String>> getRegex() async =>
      (await _invoke<List<dynamic>>('getRegex'))?.cast<String>() ?? [];
  Future<void> setRegex(List<String> v) async => _invoke('setRegex', {'items': v});

  // ── Screened-call log ─────────────────────────────────────────────────
  Future<List<Map<String, dynamic>>> getLog() async {
    final raw = await _invoke<String>('getLog');
    if (raw == null) return [];
    try {
      final a = jsonDecode(raw) as List<dynamic>;
      return a.map((e) => Map<String, dynamic>.from(e as Map)).toList();
    } catch (_) {
      return [];
    }
  }

  Future<void> clearLog() async => _invoke('clearLog');

  // ── Generic flags & lists (allowlist_enabled, wa_*, …) ─────────────────
  Future<bool> getFlag(String key, {bool def = false}) async =>
      (await _invoke<bool>('getFlag', {'key': key, 'def': def})) ?? def;
  Future<void> setFlag(String key, bool value) async =>
      _invoke('setFlag', {'key': key, 'value': value});

  Future<List<String>> getList(String key) async =>
      (await _invoke<List<dynamic>>('getList', {'key': key}))?.cast<String>() ?? [];
  Future<void> setList(String key, List<String> items) async =>
      _invoke('setList', {'key': key, 'items': items});

  // ── 📞 Normal-call allow-list (whitelist mode) ─────────────────────────
  Future<bool> isAllowlistEnabled() async => getFlag('allowlist_enabled');
  Future<void> setAllowlistEnabled(bool v) async => setFlag('allowlist_enabled', v);
  Future<List<String>> getAllowExact() async => getList('allow_exact');
  Future<void> setAllowExact(List<String> v) async => setList('allow_exact', v);

  // ── 💬 WhatsApp Guard ──────────────────────────────────────────────────
  Future<bool> isNotifAccessGranted() async =>
      (await _invoke<bool>('isNotifAccessGranted')) ?? false;
  Future<void> requestNotifAccess() async => _invoke('requestNotifAccess');
  Future<bool> isWaListenerConnected() async =>
      (await _invoke<bool>('isWaListenerConnected')) ?? false;

  Future<bool> isWaEnabled() async => getFlag('wa_enabled');
  Future<void> setWaEnabled(bool v) async => setFlag('wa_enabled', v);
  Future<bool> isWaBlockCalls() async => getFlag('wa_block_calls', def: true);
  Future<void> setWaBlockCalls(bool v) async => setFlag('wa_block_calls', v);
  Future<bool> isWaBlockAudio() async => getFlag('wa_block_audio');
  Future<void> setWaBlockAudio(bool v) async => setFlag('wa_block_audio', v);
  Future<bool> isWaBlockUnknown() async => getFlag('wa_block_unknown');
  Future<void> setWaBlockUnknown(bool v) async => setFlag('wa_block_unknown', v);
  Future<List<String>> getWaBlockNames() async => getList('wa_block_names');
  Future<void> setWaBlockNames(List<String> v) async => setList('wa_block_names', v);
  Future<List<String>> getWaAllowNames() async => getList('wa_allow_names');
  Future<void> setWaAllowNames(List<String> v) async => setList('wa_allow_names', v);

  Future<List<Map<String, dynamic>>> getWaLog() async {
    final raw = await _invoke<String>('getWaLog');
    if (raw == null) return [];
    try {
      final a = jsonDecode(raw) as List<dynamic>;
      return a.map((e) => Map<String, dynamic>.from(e as Map)).toList();
    } catch (_) {
      return [];
    }
  }

  Future<void> clearWaLog() async => _invoke('clearWaLog');

  // ── 🛡️ Anti-background-kill (persistent foreground guard) ──────────────
  Future<bool> isGuardPersistent() async =>
      (await _invoke<bool>('isGuardPersistent')) ?? false;
  Future<void> startPersistentGuard() async => _invoke('startPersistentGuard');
  Future<void> stopPersistentGuard() async => _invoke('stopPersistentGuard');

  // ── 🔋 Battery-optimisation exemption (improves anti-kill reliability) ──
  Future<bool> isBatteryUnrestricted() async =>
      (await _invoke<bool>('isBatteryUnrestricted')) ?? true;
  Future<void> requestBatteryUnrestricted() async => _invoke('requestBatteryUnrestricted');
  Future<void> openAppSettings() async => _invoke('openAppSettings');

  // ── 📇 Contacts (for picking who to block / allow) ─────────────────────
  Future<bool> hasContactsPermission() async =>
      (await _invoke<bool>('hasContactsPermission')) ?? false;
  Future<void> requestContactsPermission() async => _invoke('requestContactsPermission');

  /// Returns the device contacts as [{name, number}, …] (deduped, sorted).
  Future<List<Map<String, String>>> readContacts() async {
    final raw = await _invoke<String>('readContacts');
    if (raw == null) return [];
    try {
      final a = jsonDecode(raw) as List<dynamic>;
      return a
          .map((e) => {
                'name': (e['name'] ?? '').toString(),
                'number': (e['number'] ?? '').toString(),
              })
          .toList();
    } catch (_) {
      return [];
    }
  }

  Future<void> _cacheName(String number, String name) async =>
      _invoke('cacheName', {'number': number, 'name': name});

  // ── Backend caller-ID lookup (Truecaller-style) ───────────────────────
  /// Returns the lookup map, and caches the name natively so the screening
  /// service can label future calls from this number offline.
  Future<Map<String, dynamic>?> lookup(String number) async {
    try {
      final uri = ApiConfig.uri('/api/caller-id')
          .replace(queryParameters: {'number': number});
      final headers = <String, String>{};
      final tok = AuthService.instance.token;
      if (tok != null && tok.isNotEmpty) headers['Authorization'] = 'Bearer $tok';
      final r = await http.get(uri, headers: headers).timeout(const Duration(seconds: 12));
      if (r.statusCode != 200) return null;
      final data = Map<String, dynamic>.from(jsonDecode(r.body) as Map);
      final name = data['name'];
      if (name is String && name.trim().isNotEmpty) {
        await _cacheName(number, name.trim());
      }
      return data;
    } catch (_) {
      return null;
    }
  }

  /// Report a number to the community DB (spam / name).
  Future<bool> report(String number, {String? name, bool spam = false}) async {
    try {
      final uri = ApiConfig.uri('/api/caller-id/report');
      final headers = {'Content-Type': 'application/json'};
      final tok = AuthService.instance.token;
      if (tok != null && tok.isNotEmpty) headers['Authorization'] = 'Bearer $tok';
      final r = await http
          .post(uri, headers: headers, body: jsonEncode({'number': number, 'name': name, 'spam': spam}))
          .timeout(const Duration(seconds: 12));
      return r.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  // ── 📞 Dialer (outgoing calls) ─────────────────────────────────────────
  /// True when the app holds CALL_PHONE (can place a call without leaving app).
  Future<bool> canDirectCall() async => (await _invoke<bool>('canDirectCall')) ?? false;

  /// Ask the user for the CALL_PHONE permission.
  Future<void> requestCallPermission() async => _invoke('requestCallPermission');

  /// Place a call to [number].
  /// 1) Native direct call (ACTION_CALL) if CALL_PHONE is granted.
  /// 2) Otherwise the native side requests the permission AND opens the system
  ///    dialer pre-filled, so the call still goes through with one tap.
  /// 3) On any platform without the channel, fall back to a `tel:` url_launcher.
  /// Returns true if a DIRECT in-app call was placed.
  Future<bool> placeCall(String number) async {
    final n = number.trim();
    if (n.isEmpty) return false;
    final direct = await _invoke<bool>('placeCall', {'number': n});
    if (direct == true) return true;
    if (direct == false) return false; // native handled fallback (dialer/perm)
    // Channel absent (non-Android) → url_launcher tel: fallback.
    try {
      final uri = Uri(scheme: 'tel', path: n);
      if (await canLaunchUrl(uri)) {
        await launchUrl(uri, mode: LaunchMode.externalApplication);
      }
    } catch (_) {}
    return false;
  }

  /// Open the system dialer pre-filled with [number] (no auto-call).
  Future<void> openDialer(String number) async {
    final n = number.trim();
    if (n.isEmpty) return;
    final ok = await _invoke<bool>('openDialer', {'number': n});
    if (ok == null) {
      // non-Android fallback
      try {
        final uri = Uri(scheme: 'tel', path: n);
        if (await canLaunchUrl(uri)) {
          await launchUrl(uri, mode: LaunchMode.externalApplication);
        }
      } catch (_) {}
    }
  }
}
