import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';
import '../api/api_config.dart';
import '../api/auth_service.dart';
import '../theme.dart';

/// 🔥 WormGPT Ultra V🔥🔥 — opens the gated Ultra agent in a REAL in-app
/// browser (a full-screen WebView), NOT an iframe and NOT a new tab.
///
/// Flow:
///   1. Load our own `/lemon` page with the user's JWT injected into
///      localStorage (key `hae_token`). That page enforces the launch quota
///      (Free=1 / Basic=10 / Pro=unlimited) via /api/ultra/launch.
///   2. When the quota allows, `/lemon` does a TOP-LEVEL navigation to the real
///      agent (https://capy-agent.codebanana.app). Because this WebView is a
///      real browser, the agent's own first-party session cookie works, so its
///      sign-up / sign-in actually logs the user in (an iframe blocked that
///      cookie, which is why it previously "did nothing" / showed a white
///      screen). The address bar is never shown, so the agent URL stays hidden.
class UltraScreen extends StatefulWidget {
  const UltraScreen({super.key});

  @override
  State<UltraScreen> createState() => _UltraScreenState();
}

class _UltraScreenState extends State<UltraScreen> {
  late final WebViewController _controller;
  bool _loading = true;

  // Our own site host — we only inject the auth token while on this host, never
  // on the external agent's pages.
  late final String _ownHost;

  @override
  void initState() {
    super.initState();
    final token = AuthService.instance.token ?? '';
    final gateUrl = '${ApiConfig.baseUrl}/lemon';
    _ownHost = Uri.parse(ApiConfig.baseUrl).host;

    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(AppTheme.bg)
      // A standard mobile user-agent so the agent (a Next.js web app) renders
      // exactly as it would in Chrome — avoids the blank/white screen some
      // sites show to the default WebView UA.
      ..setUserAgent(
        'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 '
        '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      )
      ..setNavigationDelegate(
        NavigationDelegate(
          // Keep EVERY navigation inside this same WebView (no new tab / popup).
          onNavigationRequest: (req) => NavigationDecision.navigate,
          onPageStarted: (url) async {
            if (mounted) setState(() => _loading = true);
            // Only inject the token on OUR site (the gate), not on the agent.
            try {
              if (Uri.parse(url).host == _ownHost && token.isNotEmpty) {
                await _controller.runJavaScript(
                  "try{localStorage.setItem('hae_token','$token');}catch(e){}",
                );
              }
            } catch (_) {/* best effort */}
          },
          onPageFinished: (_) {
            if (mounted) setState(() => _loading = false);
          },
          onWebResourceError: (_) {
            if (mounted) setState(() => _loading = false);
          },
        ),
      )
      ..loadRequest(Uri.parse(gateUrl));
  }

  // Hardware/AppBar back: step back through WebView history (agent → gate),
  // and only leave the screen when there's nowhere left to go back to.
  Future<void> _handlePop() async {
    if (await _controller.canGoBack()) {
      await _controller.goBack();
      return;
    }
    if (!mounted) return;
    Navigator.of(context).maybePop();
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        await _handlePop();
      },
      child: Scaffold(
        appBar: AppBar(
          leading: IconButton(
            tooltip: 'Back',
            icon: const Icon(Icons.arrow_back),
            onPressed: _handlePop,
          ),
          title: Row(
            children: const [
              Text('🔥', style: TextStyle(fontSize: 20)),
              SizedBox(width: 8),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('WormGPT Ultra V🔥🔥',
                        style:
                            TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
                    Text('Our most powerful autonomous AI',
                        style: TextStyle(fontSize: 11, color: AppTheme.muted)),
                  ],
                ),
              ),
            ],
          ),
          actions: [
            IconButton(
              tooltip: 'Reload',
              icon: const Icon(Icons.refresh),
              onPressed: () => _controller.reload(),
            ),
          ],
        ),
        body: Stack(
          children: [
            WebViewWidget(controller: _controller),
            if (_loading)
              const Center(
                child: CircularProgressIndicator(color: AppTheme.accent),
              ),
          ],
        ),
      ),
    );
  }
}
