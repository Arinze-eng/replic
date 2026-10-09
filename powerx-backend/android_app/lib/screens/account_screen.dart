import 'package:flutter/material.dart';
import '../api/auth_service.dart';
import '../api/chat_service.dart';
import '../theme.dart';
import 'subscription_screen.dart';

class AccountScreen extends StatefulWidget {
  const AccountScreen({super.key});
  @override
  State<AccountScreen> createState() => _AccountScreenState();
}

class _AccountScreenState extends State<AccountScreen>
    with AutomaticKeepAliveClientMixin {
  Map<String, dynamic>? _status;
  bool _loading = true;

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    await AuthService.instance.refreshMe();
    final s = await ChatService.status();
    if (mounted) {
      setState(() {
        _status = s;
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final auth = AuthService.instance;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Account'),
        actions: [
          IconButton(
              icon: const Icon(Icons.refresh),
              onPressed: _loading ? null : _load),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        color: AppTheme.accent,
        child: ListView(
          padding: const EdgeInsets.all(18),
          children: [
            Center(
              child: Column(
                children: [
                  Container(
                    width: 84,
                    height: 84,
                    decoration: BoxDecoration(
                      gradient: const LinearGradient(
                          colors: [AppTheme.accent, AppTheme.accent2]),
                      borderRadius: BorderRadius.circular(24),
                    ),
                    child: Center(
                      child: Text(
                        auth.username.isNotEmpty
                            ? auth.username[0].toUpperCase()
                            : '?',
                        style: const TextStyle(
                            fontSize: 36,
                            fontWeight: FontWeight.w900,
                            color: Color(0xFF04130C)),
                      ),
                    ),
                  ),
                  const SizedBox(height: 14),
                  Text(auth.username,
                      style: const TextStyle(
                          fontSize: 21, fontWeight: FontWeight.w800)),
                  const SizedBox(height: 4),
                  Text(auth.email,
                      style: const TextStyle(color: AppTheme.muted)),
                ],
              ),
            ),
            const SizedBox(height: 24),
            _card([
              _row('Plan / Tier', auth.tier),
              _row('Status', (_status?['tier'] ?? auth.tier).toString()),
            ]),
            const SizedBox(height: 14),
            _card([
              _row('WormGPT credits',
                  _status?['isPro'] == true
                      ? 'Unlimited ∞'
                      : '${_status?['credits'] ?? _status?['remaining'] ?? '–'}'),
              _row('Daily credit cap',
                  _status?['isPro'] == true
                      ? '∞'
                      : '${_status?['creditCap'] ?? _status?['maxFree'] ?? '–'}'),
              _row('Lifetime credits spent',
                  '${_status?['lifetimeSpent'] ?? '–'}'),
            ]),
            const SizedBox(height: 28),
            ElevatedButton.icon(
              style: ElevatedButton.styleFrom(
                backgroundColor: AppTheme.accent,
                foregroundColor: const Color(0xFF04130C),
                padding: const EdgeInsets.symmetric(vertical: 15),
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(14)),
              ),
              icon: const Icon(Icons.workspace_premium),
              label: Text(
                  auth.tier.toLowerCase() == 'pro'
                      ? 'Manage Subscription'
                      : 'Upgrade Plan',
                  style: const TextStyle(fontWeight: FontWeight.w800)),
              onPressed: () async {
                await Navigator.of(context).push(MaterialPageRoute(
                    builder: (_) => const SubscriptionScreen()));
                _load();
              },
            ),
            const SizedBox(height: 14),
            OutlinedButton.icon(
              style: OutlinedButton.styleFrom(
                foregroundColor: AppTheme.danger,
                side: const BorderSide(color: AppTheme.danger),
                padding: const EdgeInsets.symmetric(vertical: 15),
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(14)),
              ),
              icon: const Icon(Icons.logout),
              label: const Text('Sign Out',
                  style: TextStyle(fontWeight: FontWeight.w800)),
              onPressed: () => AuthService.instance.logout(),
            ),
            const SizedBox(height: 30),
            const Center(
              child: Text('WormGPT Agent · v1.1.0',
                  style: TextStyle(color: AppTheme.muted, fontSize: 12)),
            ),
          ],
        ),
      ),
    );
  }

  Widget _card(List<Widget> children) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        decoration: BoxDecoration(
          color: AppTheme.surface,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: AppTheme.border),
        ),
        child: Column(children: children),
      );

  Widget _row(String k, String v) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 12),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(k, style: const TextStyle(color: AppTheme.muted)),
            Text(v,
                style: const TextStyle(fontWeight: FontWeight.w700)),
          ],
        ),
      );
}
