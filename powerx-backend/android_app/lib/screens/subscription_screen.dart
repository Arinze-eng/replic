import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';
import '../api/auth_service.dart';
import '../api/payment_service.dart';
import '../theme.dart';

/// Subscription / upgrade screen — Free, Basic (₦20,000) and Pro (₦40,000).
/// Mirrors the website's account.html purchase flow but native:
///   create payment → open Flutterwave checkout in-app → recheck → unlock.
class SubscriptionScreen extends StatefulWidget {
  const SubscriptionScreen({super.key});
  @override
  State<SubscriptionScreen> createState() => _SubscriptionScreenState();
}

class _SubscriptionScreenState extends State<SubscriptionScreen> {
  bool _busy = false;
  String? _busyPlan;
  PaymentStart? _last;

  // 🎟️ Pay-as-you-go catalog + the user's active passes.
  List<PaygProduct> _payg = [];
  Map<String, int> _passes = {};
  bool _paygLoading = true;

  @override
  void initState() {
    super.initState();
    _loadPayg();
  }

  Future<void> _loadPayg() async {
    try {
      final cat = await PaymentService.fetchCatalog();
      Map<String, int> passes = {};
      if (AuthService.instance.isLoggedIn) {
        try { passes = await PaymentService.fetchPasses(); } catch (_) {}
      }
      if (!mounted) return;
      setState(() {
        _payg = cat;
        _passes = passes;
        _paygLoading = false;
      });
    } catch (_) {
      if (mounted) setState(() => _paygLoading = false);
    }
  }

  String get _currentPlan {
    final t = AuthService.instance.tier.toLowerCase();
    return t;
  }

  Future<void> _buy(String plan) async {
    if (_busy) return;
    final auth = AuthService.instance;
    if (!auth.isLoggedIn) {
      _toast('Please sign in first.');
      return;
    }
    setState(() {
      _busy = true;
      _busyPlan = plan;
    });
    try {
      final start = await PaymentService.start(plan);
      _last = start;
      if (!mounted) return;
      // Open the Flutterwave checkout in an in-app WebView and wait for return.
      final returned = await Navigator.of(context).push<bool>(
        MaterialPageRoute(
          builder: (_) => _CheckoutWebView(start: start),
        ),
      );
      // Whether the user tapped done or the page auto-closed, recheck the payment.
      _toast('Verifying payment…');
      final ok = await PaymentService.pollUntilActive(
        paymentId: start.paymentId,
        txRef: start.txRef,
        attempts: returned == true ? 8 : 4,
      );
      if (!mounted) return;
      if (ok) {
        _toast('🎉 Upgraded to ${plan == 'pro' ? 'Pro' : 'Basic'}!');
        setState(() {});
      } else {
        _toast('Payment not confirmed yet. If you paid, tap "I\'ve paid — recheck".');
      }
    } catch (e) {
      _toast('⚠️ $e');
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
          _busyPlan = null;
        });
      }
    }
  }

  // 🎟️ Buy a pay-as-you-go product — same checkout/recheck flow as _buy().
  Future<void> _buyPayg(PaygProduct p) async {
    if (_busy) return;
    final auth = AuthService.instance;
    if (!auth.isLoggedIn) {
      _toast('Please sign in first.');
      return;
    }
    setState(() {
      _busy = true;
      _busyPlan = p.id;
    });
    try {
      final start = await PaymentService.start(p.id);
      _last = start;
      if (!mounted) return;
      final returned = await Navigator.of(context).push<bool>(
        MaterialPageRoute(
          builder: (_) => _CheckoutWebView(start: start),
        ),
      );
      _toast('Verifying payment…');
      final ok = await PaymentService.pollUntilActive(
        paymentId: start.paymentId,
        txRef: start.txRef,
        attempts: returned == true ? 8 : 4,
      );
      if (!mounted) return;
      if (ok) {
        _toast('🎉 Unlocked ${p.label}!');
        await _loadPayg();
        setState(() {});
      } else {
        _toast('Payment not confirmed yet. If you paid, tap "I\'ve paid — recheck".');
      }
    } catch (e) {
      _toast('⚠️ $e');
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
          _busyPlan = null;
        });
      }
    }
  }

  Future<void> _recheck() async {
    if (_last == null) {
      _toast('No recent payment to recheck.');
      return;
    }
    setState(() => _busy = true);
    try {
      final ok = await PaymentService.recheck(
          paymentId: _last!.paymentId, txRef: _last!.txRef);
      if (!mounted) return;
      _toast(ok ? '🎉 Subscription active!' : 'Still pending — try again shortly.');
      if (ok) setState(() {});
    } catch (e) {
      _toast('⚠️ $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _toast(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(m), behavior: SnackBarBehavior.floating));
  }

  @override
  Widget build(BuildContext context) {
    final plan = _currentPlan;
    return Scaffold(
      appBar: AppBar(title: const Text('Subscription')),
      body: ListView(
        padding: const EdgeInsets.all(18),
        children: [
          Text('Current plan: ${AuthService.instance.tier}',
              style: const TextStyle(
                  fontSize: 15, color: AppTheme.muted, fontWeight: FontWeight.w600)),
          const SizedBox(height: 18),
          _PlanCard(
            emoji: '🆓',
            name: 'Free',
            price: '₦0',
            cadence: 'forever',
            features: const [
              '900 WormGPT credits / day 🪙',
              'Access to core tools',
              'Standard response speed',
            ],
            active: plan == 'free',
            highlight: false,
            buttonLabel: plan == 'free' ? 'Current plan' : 'Included',
            onTap: null,
          ),
          const SizedBox(height: 14),
          _PlanCard(
            emoji: '⚡',
            name: 'Basic',
            price: '₦20,000',
            cadence: '/ 30 days',
            features: const [
              '5,000 WormGPT credits / day 🪙',
              'File & image uploads',
              'All tools unlocked',
              'Priority over Free tier',
            ],
            active: plan == 'basic',
            highlight: false,
            loading: _busy && _busyPlan == 'basic',
            buttonLabel: plan == 'basic' ? 'Active' : 'Upgrade to Basic',
            onTap: (plan == 'basic' || _busy) ? null : () => _buy('basic'),
          ),
          const SizedBox(height: 14),
          _PlanCard(
            emoji: '👑',
            name: 'Pro',
            price: '₦40,000',
            cadence: '/ 30 days',
            features: const [
              'Unlimited WormGPT credits 🪙',
              'File & image uploads',
              'All tools unlocked',
              'Highest priority + fastest sandbox',
            ],
            active: plan == 'pro' || plan == 'active',
            highlight: true,
            loading: _busy && _busyPlan == 'pro',
            buttonLabel: (plan == 'pro') ? 'Active' : 'Upgrade to Pro',
            onTap: (plan == 'pro' || _busy) ? null : () => _buy('pro'),
          ),
          const SizedBox(height: 26),
          // ── 🎟️ Pay as you go ──────────────────────────────────────────────
          const Text('🎟️  Pay as you go',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.w900)),
          const SizedBox(height: 4),
          const Text(
            "Can't do a full subscription? Unlock just the feature you need, in Naira.",
            style: TextStyle(color: AppTheme.muted, fontSize: 12.5, height: 1.4),
          ),
          const SizedBox(height: 12),
          if (_paygLoading)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 18),
              child: Center(child: CircularProgressIndicator(color: AppTheme.accent)),
            )
          else
            ..._payg.map((p) {
              final activeUntil = p.isPass ? _passes[p.feature] : null;
              int? daysLeft;
              if (activeUntil != null) {
                daysLeft = ((activeUntil - DateTime.now().millisecondsSinceEpoch) / 86400000).ceil();
                if (daysLeft < 0) daysLeft = 0;
              }
              return _PaygCard(
                product: p,
                daysLeft: daysLeft,
                loading: _busy && _busyPlan == p.id,
                onTap: _busy ? null : () => _buyPayg(p),
              );
            }),
          const SizedBox(height: 22),
          if (_last != null)
            OutlinedButton.icon(
              style: OutlinedButton.styleFrom(
                foregroundColor: AppTheme.accent,
                side: const BorderSide(color: AppTheme.accent),
                padding: const EdgeInsets.symmetric(vertical: 14),
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(14)),
              ),
              icon: const Icon(Icons.refresh),
              label: const Text("I've paid — recheck",
                  style: TextStyle(fontWeight: FontWeight.w800)),
              onPressed: _busy ? null : _recheck,
            ),
          const SizedBox(height: 16),
          const Center(
            child: Text(
              'Payments are processed securely via Flutterwave.\nSubscription auto-reverts to Free when it expires.',
              textAlign: TextAlign.center,
              style: TextStyle(color: AppTheme.muted, fontSize: 11.5, height: 1.5),
            ),
          ),
        ],
      ),
    );
  }
}

class _PlanCard extends StatelessWidget {
  final String emoji;
  final String name;
  final String price;
  final String cadence;
  final List<String> features;
  final bool active;
  final bool highlight;
  final bool loading;
  final String buttonLabel;
  final VoidCallback? onTap;
  const _PlanCard({
    required this.emoji,
    required this.name,
    required this.price,
    required this.cadence,
    required this.features,
    required this.active,
    required this.highlight,
    required this.buttonLabel,
    required this.onTap,
    this.loading = false,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: AppTheme.surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
            color: highlight ? AppTheme.accent : AppTheme.border,
            width: highlight ? 1.6 : 1),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(emoji, style: const TextStyle(fontSize: 26)),
              const SizedBox(width: 10),
              Text(name,
                  style: const TextStyle(
                      fontSize: 19, fontWeight: FontWeight.w900)),
              const Spacer(),
              if (active)
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    color: AppTheme.accent.withOpacity(0.14),
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: const Text('ACTIVE',
                      style: TextStyle(
                          color: AppTheme.accent,
                          fontSize: 11,
                          fontWeight: FontWeight.w900)),
                ),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Text(price,
                  style: const TextStyle(
                      fontSize: 26, fontWeight: FontWeight.w900)),
              const SizedBox(width: 6),
              Text(cadence,
                  style: const TextStyle(color: AppTheme.muted, fontSize: 13)),
            ],
          ),
          const SizedBox(height: 14),
          ...features.map((f) => Padding(
                padding: const EdgeInsets.symmetric(vertical: 3),
                child: Row(
                  children: [
                    const Icon(Icons.check_circle,
                        color: AppTheme.accent, size: 17),
                    const SizedBox(width: 9),
                    Expanded(
                        child: Text(f,
                            style: const TextStyle(
                                fontSize: 13.5, color: AppTheme.text))),
                  ],
                ),
              )),
          const SizedBox(height: 16),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton(
              style: ElevatedButton.styleFrom(
                backgroundColor:
                    highlight ? AppTheme.accent : AppTheme.surfaceAlt,
                foregroundColor:
                    highlight ? const Color(0xFF04130C) : AppTheme.text,
              ),
              onPressed: onTap,
              child: loading
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(
                          strokeWidth: 2.2, color: Color(0xFF04130C)),
                    )
                  : Text(buttonLabel),
            ),
          ),
        ],
      ),
    );
  }
}

/// In-app Flutterwave checkout. Watches the URL for the app callback / success
/// markers, then pops back so the caller can recheck the payment.
class _CheckoutWebView extends StatefulWidget {
  final PaymentStart start;
  const _CheckoutWebView({required this.start});
  @override
  State<_CheckoutWebView> createState() => _CheckoutWebViewState();
}

class _CheckoutWebViewState extends State<_CheckoutWebView> {
  late final WebViewController _controller;
  bool _loading = true;
  bool _popped = false;

  @override
  void initState() {
    super.initState();
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(AppTheme.bg)
      ..setNavigationDelegate(
        NavigationDelegate(
          onPageStarted: (_) {
            if (mounted) setState(() => _loading = true);
          },
          onPageFinished: (_) {
            if (mounted) setState(() => _loading = false);
          },
          onNavigationRequest: (req) {
            final url = req.url.toLowerCase();
            // Detect our own callback or a Flutterwave success/cancel return.
            if (url.contains('/api/payment/callback') ||
                url.contains('payment successful') ||
                url.contains('status=successful') ||
                url.contains('status=completed') ||
                url.contains('payment-complete')) {
              _finish(true);
              return NavigationDecision.prevent;
            }
            if (url.contains('status=cancelled') ||
                url.contains('status=failed')) {
              _finish(false);
              return NavigationDecision.prevent;
            }
            return NavigationDecision.navigate;
          },
        ),
      )
      ..loadRequest(Uri.parse(widget.start.checkoutUrl));
  }

  void _finish(bool ok) {
    if (_popped) return;
    _popped = true;
    if (mounted) Navigator.of(context).pop(ok);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('Pay ₦${widget.start.amount}'),
        actions: [
          TextButton(
            onPressed: () => _finish(true),
            child: const Text("I've paid",
                style: TextStyle(
                    color: AppTheme.accent, fontWeight: FontWeight.w800)),
          ),
        ],
      ),
      body: Stack(
        children: [
          WebViewWidget(controller: _controller),
          if (_loading)
            const Center(
                child: CircularProgressIndicator(color: AppTheme.accent)),
        ],
      ),
    );
  }
}

/// A compact pay-as-you-go product row (feature pass or credit pack).
class _PaygCard extends StatelessWidget {
  final PaygProduct product;
  final int? daysLeft; // non-null when the user holds an active pass
  final bool loading;
  final VoidCallback? onTap;
  const _PaygCard({
    required this.product,
    required this.daysLeft,
    required this.loading,
    required this.onTap,
  });

  String get _emoji {
    const m = {
      'spotify': '🎵', 'scam': '🛡️', 'hotbot': '🤖', 'browser': '🌐',
      'phoneguard': '📵', 'uptime': '📈', 'callblock': '📞',
      'credits_500': '🪙', 'credits_1000': '🪙', 'credits_2000': '🪙',
    };
    return m[product.id] ?? '🎟️';
  }

  @override
  Widget build(BuildContext context) {
    final active = daysLeft != null;
    final sub = product.isPass
        ? '${product.days} days'
        : '+${product.credits} credits';
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppTheme.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: active ? AppTheme.accent : AppTheme.border),
      ),
      child: Row(
        children: [
          Text(_emoji, style: const TextStyle(fontSize: 22)),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(product.label.replaceAll(RegExp(r' — .*'), ''),
                    style: const TextStyle(
                        fontSize: 14.5, fontWeight: FontWeight.w800)),
                const SizedBox(height: 2),
                Text('₦${product.amount} · $sub',
                    style: const TextStyle(color: AppTheme.muted, fontSize: 12.5)),
                if (active)
                  Padding(
                    padding: const EdgeInsets.only(top: 3),
                    child: Text(
                      '✓ Active — $daysLeft day${daysLeft == 1 ? '' : 's'} left',
                      style: const TextStyle(
                          color: AppTheme.accent,
                          fontSize: 11.5,
                          fontWeight: FontWeight.w700),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 10),
          SizedBox(
            height: 38,
            child: ElevatedButton(
              style: ElevatedButton.styleFrom(
                backgroundColor: AppTheme.accent,
                foregroundColor: const Color(0xFF04130C),
                padding: const EdgeInsets.symmetric(horizontal: 18),
              ),
              onPressed: onTap,
              child: loading
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(
                          strokeWidth: 2, color: Color(0xFF04130C)),
                    )
                  : Text(active ? 'Renew' : 'Buy'),
            ),
          ),
        ],
      ),
    );
  }
}
