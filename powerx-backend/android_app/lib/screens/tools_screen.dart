import 'package:flutter/material.dart';
import '../theme.dart';
import 'webview_screen.dart';
import '../api/music/ultra_music_launcher.dart';
import 'phone_guard_screen.dart';
import 'dialer_screen.dart';
import 'browser_screen.dart';
import 'super_local_sandbox_screen.dart'; // 🐧 Super Local Sandbox AI
import 'local_agent_screen.dart'; // 🐧 Local Brain Agent (FUSION brain + Alpine)

class _Tool {
  final String emoji;
  final String name;
  final String desc;
  final String path; // website page, or special prefix
  final bool isNative; // true = use native screen, false = webview
  const _Tool(this.emoji, this.name, this.desc, this.path, {this.isNative = false});
}

class ToolsScreen extends StatelessWidget {
  const ToolsScreen({super.key});

  static const _tools = <_Tool>[
    // 🐧 Super Local Sandbox AI — RezeAI-style Alpine Linux inside Android
    _Tool('🐧', 'Super Local Sandbox AI', 'Full Alpine Linux · run commands · install packages · process files', '__sandbox__', isNative: true),
    // 🧠 Local Brain Agent — FUSION brain (HotBot+Gemini) drives the LOCAL Alpine
    // sandbox, with image / audio / file understanding, all on-device.
    _Tool('🧠', 'Local Brain Agent', 'FUSION brain runs tasks in the on-device Alpine sandbox · vision · audio · files', '__local_agent__', isNative: true),
    _Tool('🥷', 'Stealth Browser', 'Undetectable browser · change location · 80+ tools (Free 15/day · Pro unlimited)', '__browser__'),
    _Tool('🔥', 'WormGPT Ultra V🔥🔥', 'Unlimited music streaming · search & play anything (works offline of Render)', '__ultra__'),
    _Tool('📞', 'Dialer', 'Make calls · see who is calling (Caller ID)', '__dialer__'),
    _Tool('📵', 'Phone Guard', 'Block calls & WhatsApp · contacts · anti-kill', '__phoneguard__'),
    _Tool('🎵', 'Spotify Downloader', 'Spotify → MP3 (Free 2/day · Pro unlimited)', 'spotify.html'),
    _Tool('🤖', 'Agent Chat', 'Conversational agent workspace', 'agent-chat.html'),
    _Tool('😈', 'EvilGPT', 'Uncensored AI chat', 'evilgpt.html'),
    _Tool('🪱', 'WormGPT', 'WormGPT web console', 'wormgpt.html'),
    _Tool('🔥', 'HotBot V1', 'GPT-5 powered assistant', 'hotbotv1.html'),
    _Tool('🗣️', 'AI Debate', 'Watch two AIs debate', 'debate.html'),
    _Tool('🏠', 'Home', 'Full website home', 'index.html'),
    _Tool('🧰', 'All Tools', 'Website tools hub', 'tools.html'),
    _Tool('🩹', 'Patcher', 'App patcher / deeplink', 'patcher.html'),
    _Tool('⚽', 'Football', 'Live scores & fixtures', 'football.html'),
    _Tool('📺', 'AvoStream', 'Live TV & streaming', 'avostream.html'),
    _Tool('🌐', 'Reverse IP', 'Find domains on an IP', 'revip.html'),
    _Tool('🕵️', 'Session Sniffer', 'Inspect web sessions', 'session-sniffer.html'),
    _Tool('📧', 'Temp Email', 'Disposable inbox', 'tempemail.html'),
    _Tool('📱', 'Temp Phone', 'Disposable numbers', 'tempphone.html'),
    _Tool('➕', 'TG Joiner', 'Telegram group joiner', 'tgjoiner.html'),
    _Tool('⏱️', 'Uptime', 'Website uptime monitor', 'uptime.html'),
    _Tool('💬', 'WA Tracker', 'WhatsApp tracker', 'watracker.html'),
    _Tool('🧩', 'WWeb', 'WhatsApp web tools', 'wweb.html'),
    _Tool('🛡️', 'Privacy Test', 'Check your privacy', 'privacy-test.html'),
    _Tool('🔑', 'API Key Test', 'Validate API keys', 'apikeytest.html'),
  ];

  void _open(BuildContext context, _Tool t) {
    if (t.isNative) {
      if (t.path == '__sandbox__') {
        Navigator.of(context).push(MaterialPageRoute(
          builder: (_) => const SuperLocalSandboxScreen(),
        ));
        return;
      }
      if (t.path == '__local_agent__') {
        Navigator.of(context).push(MaterialPageRoute(
          builder: (_) => const LocalAgentScreen(),
        ));
        return;
      }
    }
    if (t.path == '__browser__') {
      Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => const BrowserScreen(),
      ));
      return;
    }
    if (t.path == '__ultra__') {
      UltraMusicLauncher.open().then((ok) {
        if (!ok && context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('Could not open WormGPT Ultra music.'),
              duration: Duration(seconds: 2),
            ),
          );
        }
      });
      return;
    }
    if (t.path == '__phoneguard__') {
      Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => const PhoneGuardScreen(),
      ));
      return;
    }
    if (t.path == '__dialer__') {
      Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => const DialerScreen(),
      ));
      return;
    }
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => WebViewScreen(title: t.name, page: t.path),
    ));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Tools')),
      body: GridView.builder(
        padding: const EdgeInsets.all(14),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 2,
          mainAxisSpacing: 12,
          crossAxisSpacing: 12,
          childAspectRatio: 1.02,
        ),
        itemCount: _tools.length,
        itemBuilder: (c, i) {
          final t = _tools[i];
          return InkWell(
            borderRadius: BorderRadius.circular(16),
            onTap: () => _open(context, t),
            child: Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: t.isNative ? const Color(0xFF1B5E20).withOpacity(0.3) : AppTheme.surface,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(
                  color: t.isNative ? Colors.green.withOpacity(0.4) : AppTheme.border,
                  width: t.isNative ? 1.5 : 1,
                ),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(t.emoji, style: const TextStyle(fontSize: 30)),
                  const Spacer(),
                  Text(t.name,
                      style: const TextStyle(
                          fontSize: 15.5, fontWeight: FontWeight.w800)),
                  const SizedBox(height: 4),
                  Text(t.desc,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style:
                          const TextStyle(fontSize: 12, color: AppTheme.muted)),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}