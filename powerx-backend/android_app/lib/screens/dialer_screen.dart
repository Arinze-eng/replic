import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../theme.dart';
import '../api/call_guard_service.dart';

/// 📞 Dialer — a normal phone dial pad. Type a number, see who it is
/// (Truecaller-style caller-ID as you type), and tap the green button to call.
class DialerScreen extends StatefulWidget {
  const DialerScreen({super.key});
  @override
  State<DialerScreen> createState() => _DialerScreenState();
}

class _DialerScreenState extends State<DialerScreen> {
  final _g = CallGuardService.instance;
  String _number = '';
  Map<String, dynamic>? _info;
  bool _looking = false;
  int _lookupSeq = 0;

  void _press(String key) {
    HapticFeedback.lightImpact();
    setState(() => _number += key);
    _maybeLookup();
  }

  void _backspace() {
    if (_number.isEmpty) return;
    HapticFeedback.selectionClick();
    setState(() => _number = _number.substring(0, _number.length - 1));
    _maybeLookup();
  }

  void _clearAll() {
    setState(() { _number = ''; _info = null; });
  }

  // Debounced caller-ID lookup once the number looks dial-able.
  Future<void> _maybeLookup() async {
    final digits = _number.replaceAll(RegExp(r'[^0-9+]'), '');
    if (digits.replaceAll('+', '').length < 6) {
      setState(() { _info = null; _looking = false; });
      return;
    }
    final seq = ++_lookupSeq;
    setState(() => _looking = true);
    await Future.delayed(const Duration(milliseconds: 550));
    if (seq != _lookupSeq) return; // a newer keystroke superseded this one
    final r = await _g.lookup(digits);
    if (!mounted || seq != _lookupSeq) return;
    setState(() { _info = r; _looking = false; });
  }

  Future<void> _call() async {
    final n = _number.trim();
    if (n.isEmpty) return;
    HapticFeedback.mediumImpact();
    final direct = await _g.placeCall(n);
    if (!mounted) return;
    if (!direct) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        backgroundColor: AppTheme.surfaceAlt,
        content: Text('Opening dialer… tap the green call button to ring. '
            '(Allow the Phone permission to call from inside the app.)'),
      ));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('📞 Dialer')),
      body: SafeArea(
        child: Column(
          children: [
            const SizedBox(height: 8),
            _display(),
            _callerCard(),
            const Spacer(),
            _pad(),
            const SizedBox(height: 8),
            _actionRow(),
            const SizedBox(height: 18),
          ],
        ),
      ),
    );
  }

  Widget _display() {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 8),
      child: Text(
        _number.isEmpty ? 'Enter a number' : _number,
        textAlign: TextAlign.center,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          fontSize: _number.isEmpty ? 22 : 34,
          fontWeight: FontWeight.w700,
          color: _number.isEmpty ? AppTheme.muted : AppTheme.text,
          letterSpacing: 1.2,
        ),
      ),
    );
  }

  Widget _callerCard() {
    if (_looking) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 4),
        child: Text('Looking up…', style: TextStyle(color: AppTheme.muted, fontSize: 12.5)),
      );
    }
    final r = _info;
    if (r == null) return const SizedBox(height: 22);
    final name = (r['name'] ?? '').toString();
    final carrier = (r['carrier'] ?? '').toString();
    final country = (r['country'] ?? '').toString();
    final spam = (r['spamScore'] ?? 0);
    final isSpam = (r['isSpam'] == true) || (spam is num && spam >= 1);
    final source = (r['source'] ?? '').toString();
    final bits = [
      if (carrier.isNotEmpty) carrier,
      if (country.isNotEmpty) country,
    ].join(' · ');
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 20),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
      decoration: BoxDecoration(
        color: isSpam ? AppTheme.danger.withOpacity(0.12) : AppTheme.surfaceAlt,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: isSpam ? AppTheme.danger : AppTheme.border),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(isSpam ? Icons.report : Icons.person,
              size: 18, color: isSpam ? AppTheme.danger : AppTheme.accent),
          const SizedBox(width: 8),
          Flexible(
            child: Text(
              isSpam
                  ? '☠️ Likely spam${name.isNotEmpty ? ' · $name' : ''}'
                  : (name.isNotEmpty
                      ? '$name${bits.isNotEmpty ? '  ·  $bits' : ''}'
                      : (bits.isNotEmpty ? bits : 'Unknown')),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w700,
                color: isSpam ? AppTheme.danger : AppTheme.text,
              ),
            ),
          ),
          if (source == 'truecaller') ...[
            const SizedBox(width: 6),
            const Icon(Icons.verified, size: 14, color: AppTheme.accent),
          ],
        ],
      ),
    );
  }

  Widget _pad() {
    const keys = [
      ['1', ''], ['2', 'ABC'], ['3', 'DEF'],
      ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
      ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'],
      ['*', ''], ['0', '+'], ['#', ''],
    ];
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 30),
      child: GridView.count(
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        crossAxisCount: 3,
        childAspectRatio: 1.35,
        children: keys.map((k) {
          final digit = k[0];
          final sub = k[1];
          return InkWell(
            borderRadius: BorderRadius.circular(50),
            onTap: () => _press(digit),
            onLongPress: digit == '0' ? () => _press('+') : null,
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Text(digit,
                    style: const TextStyle(
                        fontSize: 30, fontWeight: FontWeight.w600, color: AppTheme.text)),
                if (sub.isNotEmpty)
                  Text(sub,
                      style: const TextStyle(
                          fontSize: 10, letterSpacing: 1.5, color: AppTheme.muted)),
              ],
            ),
          );
        }).toList(),
      ),
    );
  }

  Widget _actionRow() {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 40),
      child: Row(
        children: [
          const SizedBox(width: 56), // balance the backspace on the right
          const Spacer(),
          // Big green call button
          GestureDetector(
            onTap: _call,
            child: Container(
              width: 68,
              height: 68,
              decoration: const BoxDecoration(
                shape: BoxShape.circle,
                gradient: LinearGradient(
                  colors: [AppTheme.accent, Color(0xFF00B070)],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
              ),
              child: const Icon(Icons.call, color: Color(0xFF04130C), size: 30),
            ),
          ),
          const Spacer(),
          // Backspace
          SizedBox(
            width: 56,
            child: _number.isEmpty
                ? const SizedBox()
                : GestureDetector(
                    onLongPress: _clearAll,
                    child: IconButton(
                      onPressed: _backspace,
                      icon: const Icon(Icons.backspace_outlined, color: AppTheme.muted),
                    ),
                  ),
          ),
        ],
      ),
    );
  }
}
