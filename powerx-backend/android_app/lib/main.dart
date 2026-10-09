import 'package:flutter/material.dart';
import 'package:just_audio_background/just_audio_background.dart';
import 'api/auth_service.dart';
import 'api/remote_config_service.dart';
import 'api/browser_service.dart';
import 'theme.dart';
import 'app_gate.dart';
import 'screens/auth_screen.dart';
import 'screens/home_screen.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // 🎧 Initialise the background media session for the Worm Ultra music player
  // so playback continues (and shows on the lock screen / notification) when
  // the app is backgrounded. Wrapped so a failure here never blocks app boot.
  try {
    await JustAudioBackground.init(
      androidNotificationChannelId: 'com.hackerx.wormgpt_agent.audio',
      androidNotificationChannelName: 'WormGPT Ultra Music',
      androidNotificationOngoing: true,
    );
  } catch (_) {/* non-fatal: player still works in-foreground */}
  runApp(const WormGptApp());
}

class WormGptApp extends StatefulWidget {
  const WormGptApp({super.key});
  @override
  State<WormGptApp> createState() => _WormGptAppState();
}

class _WormGptAppState extends State<WormGptApp> {
  @override
  void initState() {
    super.initState();
    AuthService.instance.boot();
    // Preload Stealth Browser settings so the browser opens instantly.
    BrowserSettings.instance.load();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'WormGPT Agent',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.dark,
      home: AppGate(
        child: AnimatedBuilder(
          animation: Listenable.merge(
              [AuthService.instance, RemoteConfigService.instance]),
          builder: (context, _) {
            final auth = AuthService.instance;
            if (!auth.booted) {
              return const _Splash();
            }
            return auth.isLoggedIn ? const HomeScreen() : const AuthScreen();
          },
        ),
      ),
    );
  }
}

class _Splash extends StatelessWidget {
  const _Splash();
  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('🪱', style: TextStyle(fontSize: 56)),
            SizedBox(height: 16),
            Text('WormGPT Agent',
                style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
            SizedBox(height: 24),
            SizedBox(
              width: 26,
              height: 26,
              child: CircularProgressIndicator(strokeWidth: 2.4),
            ),
          ],
        ),
      ),
    );
  }
}
