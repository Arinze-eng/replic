// ultra_music_launcher.dart — bridges the "WormGPT Ultra" tool tile to the
// bundled NATIVE Spotui music client (real Spotify login, streaming, downloads,
// lyrics, canvas) that lives in the app's Android host as the :spotuiengine
// module. Tapping the tile launches its Compose Activity via a MethodChannel.
import 'package:flutter/services.dart';

class UltraMusicLauncher {
  UltraMusicLauncher._();
  static const _channel =
      MethodChannel('com.hackerx.wormgpt_agent/ultramusic');

  /// Opens the native WormGPT Ultra (Spotui) music screen. Returns true when
  /// the native Activity was launched.
  static Future<bool> open() async {
    try {
      final ok = await _channel.invokeMethod<bool>('openUltraMusic');
      return ok ?? false;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }
}
