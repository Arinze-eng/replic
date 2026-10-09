import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';
import '../api/api_config.dart';
import '../api/auth_service.dart';
import '../theme.dart';

/// In-app webview that opens a website tool page WITH the user's JWT injected
/// into localStorage (key `hae_token`) so the page is already authenticated —
/// exactly how the website's auth.js expects it.
class WebViewScreen extends StatefulWidget {
  final String title;
  final String page; // e.g. "revip.html"
  const WebViewScreen({super.key, required this.title, required this.page});

  @override
  State<WebViewScreen> createState() => _WebViewScreenState();
}

class _WebViewScreenState extends State<WebViewScreen> {
  late final WebViewController _controller;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    final token = AuthService.instance.token ?? '';
    final url = '${ApiConfig.baseUrl}/${widget.page}';

    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(AppTheme.bg)
      ..setNavigationDelegate(
        NavigationDelegate(
          onPageStarted: (_) async {
            // Inject the token early so auth.js finds it on load.
            await _controller.runJavaScript(
              "try{localStorage.setItem('hae_token','$token');}catch(e){}",
            );
          },
          onPageFinished: (_) {
            if (mounted) setState(() => _loading = false);
          },
        ),
      )
      ..loadRequest(Uri.parse(url));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.title),
        actions: [
          IconButton(
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
    );
  }
}
