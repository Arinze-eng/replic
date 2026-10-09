import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../theme.dart';
import '../api/call_guard_service.dart';
import '../widgets/contact_picker_sheet.dart';

/// Phone Guard — call screening, contact-based blocking, WhatsApp call/audio
/// blocking, and an anti-background-kill foreground service.
///
/// Three tabs:
///   📞 Calls     — caller-ID, block lists, allow-list (whitelist) mode.
///   💬 WhatsApp  — block WhatsApp calls/voice-notes by contact or "unknown".
///   🛡️ Background — keep the guard alive so the OS can't silently kill it.
class PhoneGuardScreen extends StatefulWidget {
  const PhoneGuardScreen({super.key});
  @override
  State<PhoneGuardScreen> createState() => _PhoneGuardScreenState();
}

class _PhoneGuardScreenState extends State<PhoneGuardScreen>
    with SingleTickerProviderStateMixin {
  final _g = CallGuardService.instance;
  late final TabController _tabs;

  bool _loading = true;

  // Calls
  bool _roleHeld = false;
  bool _enabled = false;
  bool _blockPrivate = false;
  bool _allowlistEnabled = false;
  List<String> _exact = [];
  List<String> _prefix = [];
  List<String> _regex = [];
  List<String> _allowExact = [];

  // WhatsApp
  bool _notifAccess = false;
  bool _waEnabled = false;
  bool _waBlockCalls = true;
  bool _waBlockAudio = false;
  bool _waBlockUnknown = false;
  List<String> _waBlockNames = [];
  List<String> _waAllowNames = [];

  // Background
  bool _guardPersistent = false;
  bool _batteryUnrestricted = true;

  @override
  void initState() {
    super.initState();
    _tabs = TabController(length: 3, vsync: this);
    _refresh();
  }

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  Future<void> _refresh() async {
    final results = await Future.wait([
      _g.isRoleHeld(),
      _g.isEnabled(),
      _g.isBlockPrivate(),
      _g.isAllowlistEnabled(),
      _g.getExact(),
      _g.getPrefix(),
      _g.getRegex(),
      _g.getAllowExact(),
      _g.isNotifAccessGranted(),
      _g.isWaEnabled(),
      _g.isWaBlockCalls(),
      _g.isWaBlockAudio(),
      _g.isWaBlockUnknown(),
      _g.getWaBlockNames(),
      _g.getWaAllowNames(),
      _g.isGuardPersistent(),
      _g.isBatteryUnrestricted(),
    ]);
    if (!mounted) return;
    setState(() {
      _roleHeld = results[0] as bool;
      _enabled = results[1] as bool;
      _blockPrivate = results[2] as bool;
      _allowlistEnabled = results[3] as bool;
      _exact = results[4] as List<String>;
      _prefix = results[5] as List<String>;
      _regex = results[6] as List<String>;
      _allowExact = results[7] as List<String>;
      _notifAccess = results[8] as bool;
      _waEnabled = results[9] as bool;
      _waBlockCalls = results[10] as bool;
      _waBlockAudio = results[11] as bool;
      _waBlockUnknown = results[12] as bool;
      _waBlockNames = results[13] as List<String>;
      _waAllowNames = results[14] as List<String>;
      _guardPersistent = results[15] as bool;
      _batteryUnrestricted = results[16] as bool;
      _loading = false;
    });
  }

  void _snack(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(m), backgroundColor: AppTheme.surfaceAlt));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('📵 Phone Guard'),
        bottom: TabBar(
          controller: _tabs,
          indicatorColor: AppTheme.accent,
          labelColor: AppTheme.accent,
          unselectedLabelColor: AppTheme.muted,
          tabs: const [
            Tab(text: '📞 Calls'),
            Tab(text: '💬 WhatsApp'),
            Tab(text: '🛡️ Background'),
          ],
        ),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : TabBarView(
              controller: _tabs,
              children: [
                _callsTab(),
                _whatsappTab(),
                _backgroundTab(),
              ],
            ),
    );
  }

  Widget _section(Widget child) => Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: AppTheme.surface,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: AppTheme.border),
        ),
        child: child,
      );

  Widget _statusRow(bool ok, String okText, String badText) => Row(children: [
        Icon(ok ? Icons.verified_user : Icons.shield_outlined,
            color: ok ? AppTheme.accent : AppTheme.danger),
        const SizedBox(width: 8),
        Expanded(
          child: Text(ok ? okText : badText,
              style: TextStyle(
                  fontWeight: FontWeight.w800,
                  color: ok ? AppTheme.accent : AppTheme.danger)),
        ),
      ]);

  // ══════════════════════════════════════════════════════════════════════
  // 📞 CALLS TAB
  // ══════════════════════════════════════════════════════════════════════
  Widget _callsTab() {
    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _roleCard(),
          const SizedBox(height: 14),
          _togglesCard(),
          const SizedBox(height: 14),
          _allowlistCard(),
          const SizedBox(height: 14),
          _lookupCard(),
          const SizedBox(height: 14),
          _blockExactCard(),
          const SizedBox(height: 14),
          _listCard(
            title: '🔢 Block by prefix',
            hint: '23480  (blocks all starting with…)',
            items: _prefix,
            onSave: (v) async { await _g.setPrefix(v); setState(() => _prefix = v); },
          ),
          const SizedBox(height: 14),
          _regexCard(),
          const SizedBox(height: 14),
          _logButton(),
          const SizedBox(height: 28),
        ],
      ),
    );
  }

  Widget _roleCard() {
    return _section(Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _statusRow(_roleHeld, 'Call screening: ACTIVE', 'Call screening: not granted'),
        const SizedBox(height: 8),
        const Text(
          'To identify, label and block calls, WormGPT must be set as your '
          'call-screening app. Android shows EVERY incoming call to the guard '
          'before it rings.',
          style: TextStyle(color: AppTheme.muted, fontSize: 12.5),
        ),
        const SizedBox(height: 12),
        SizedBox(
          width: double.infinity,
          child: ElevatedButton(
            onPressed: () async {
              await _g.requestRole();
              await Future.delayed(const Duration(milliseconds: 600));
              await _refresh();
            },
            child: Text(_roleHeld ? 'Re-check permission' : 'Grant call-screening'),
          ),
        ),
      ],
    ));
  }

  Widget _togglesCard() {
    return _section(Column(
      children: [
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          activeColor: AppTheme.accent,
          title: const Text('Enable Phone Guard',
              style: TextStyle(fontWeight: FontWeight.w700)),
          subtitle: const Text('Master switch for screening & blocking',
              style: TextStyle(color: AppTheme.muted, fontSize: 12)),
          value: _enabled,
          onChanged: (v) async {
            await _g.setEnabled(v);
            setState(() => _enabled = v);
          },
        ),
        const Divider(color: AppTheme.border, height: 1),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          activeColor: AppTheme.accent,
          title: const Text('Block private / unknown numbers',
              style: TextStyle(fontWeight: FontWeight.w700)),
          subtitle: const Text(
              'Auto-reject withheld "Private number" calls. (Android never '
              'reveals a carrier-hidden number — so we block it instead.)',
              style: TextStyle(color: AppTheme.muted, fontSize: 12)),
          value: _blockPrivate,
          onChanged: (v) async {
            await _g.setBlockPrivate(v);
            setState(() => _blockPrivate = v);
          },
        ),
      ],
    ));
  }

  // ── ✅ Allow-list (whitelist) mode — "only these people can call me" ─────
  Widget _allowlistCard() {
    return _section(Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          activeColor: AppTheme.accent,
          title: const Text('✅ Allow-list mode (only allowed numbers ring)',
              style: TextStyle(fontWeight: FontWeight.w800, fontSize: 14.5)),
          subtitle: const Text(
              'STRONGEST blocking: every call is rejected EXCEPT the numbers '
              'you allow below. Great for "do not disturb except my people".',
              style: TextStyle(color: AppTheme.muted, fontSize: 12)),
          value: _allowlistEnabled,
          onChanged: (v) async {
            await _g.setAllowlistEnabled(v);
            setState(() => _allowlistEnabled = v);
            if (v) _snack('Allow-list ON — only allowed numbers can call you.');
          },
        ),
        const SizedBox(height: 8),
        Row(children: [
          Expanded(
            child: Text(
              _allowlistEnabled
                  ? 'Allowed callers (${_allowExact.length})'
                  : 'Allowed callers (turn the switch on to enforce)',
              style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13),
            ),
          ),
          TextButton.icon(
            onPressed: () async {
              final picked = await ContactPickerSheet.show(context,
                  returnNumbers: true, title: 'Allow these callers');
              if (picked == null || picked.isEmpty) return;
              final next = [..._allowExact];
              for (final p in picked) { if (!next.contains(p)) next.add(p); }
              await _g.setAllowExact(next);
              setState(() => _allowExact = next);
              _snack('Added ${picked.length} to allow-list.');
            },
            icon: const Icon(Icons.person_add_alt_1, size: 18),
            label: const Text('From contacts'),
          ),
        ]),
        _manualAddRow(
          hint: '+2348012345678',
          digitsOnly: true,
          onAdd: (v) async {
            final next = [..._allowExact];
            if (!next.contains(v)) next.add(v);
            await _g.setAllowExact(next);
            setState(() => _allowExact = next);
          },
        ),
        const SizedBox(height: 10),
        _chips(_allowExact, (e) async {
          final next = [..._allowExact]..remove(e);
          await _g.setAllowExact(next);
          setState(() => _allowExact = next);
        }, empty: 'No allowed numbers yet.'),
      ],
    ));
  }

  Widget _blockExactCard() {
    return _section(Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(children: [
          const Expanded(
            child: Text('🚫 Block exact numbers',
                style: TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
          ),
          TextButton.icon(
            onPressed: () async {
              final picked = await ContactPickerSheet.show(context,
                  returnNumbers: true, title: 'Block these callers');
              if (picked == null || picked.isEmpty) return;
              final next = [..._exact];
              for (final p in picked) { if (!next.contains(p)) next.add(p); }
              await _g.setExact(next);
              setState(() => _exact = next);
              _snack('Blocked ${picked.length} contact(s).');
            },
            icon: const Icon(Icons.person_off, size: 18),
            label: const Text('From contacts'),
          ),
        ]),
        const SizedBox(height: 6),
        _manualAddRow(
          hint: '+2348012345678',
          digitsOnly: true,
          onAdd: (v) async {
            final next = [..._exact];
            if (!next.contains(v)) next.add(v);
            await _g.setExact(next);
            setState(() => _exact = next);
          },
        ),
        const SizedBox(height: 10),
        _chips(_exact, (e) async {
          final next = [..._exact]..remove(e);
          await _g.setExact(next);
          setState(() => _exact = next);
        }, empty: 'No blocked numbers yet.'),
      ],
    ));
  }

  // ── Truecaller-style lookup ─────────────────────────────────────────────
  final _lookupCtl = TextEditingController();
  bool _lookingUp = false;
  Map<String, dynamic>? _result;

  Widget _lookupCard() {
    return _section(Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('🔎 Who called? (Caller ID)',
            style: TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
        const SizedBox(height: 10),
        Row(children: [
          Expanded(
            child: TextField(
              controller: _lookupCtl,
              keyboardType: TextInputType.phone,
              decoration: const InputDecoration(hintText: '+2348012345678'),
            ),
          ),
          const SizedBox(width: 10),
          ElevatedButton(
            onPressed: _lookingUp
                ? null
                : () async {
                    final n = _lookupCtl.text.trim();
                    if (n.isEmpty) return;
                    setState(() { _lookingUp = true; _result = null; });
                    final r = await _g.lookup(n);
                    if (!mounted) return;
                    setState(() { _lookingUp = false; _result = r; });
                    if (r == null) _snack('Lookup failed — check connection.');
                  },
            child: _lookingUp
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Text('Lookup'),
          ),
        ]),
        if (_result != null) ...[
          const SizedBox(height: 12),
          _resultView(_result!),
        ],
      ],
    ));
  }

  Widget _resultView(Map<String, dynamic> r) {
    final name = (r['name'] ?? '').toString();
    final country = (r['country'] ?? '').toString();
    final carrier = (r['carrier'] ?? '').toString();
    final type = (r['type'] ?? '').toString();
    final spam = (r['spamScore'] ?? 0);
    final spamType = (r['spamType'] ?? '').toString();
    final image = (r['image'] ?? '').toString();
    final address = (r['address'] ?? '').toString();
    final source = (r['source'] ?? '').toString();
    final isSpam = (r['isSpam'] == true) || ((spam is num) && spam >= 1) || spamType.isNotEmpty;
    final reports = (r['reports'] ?? 0);
    final number = (r['number'] ?? _lookupCtl.text).toString();

    String line(String label, String v) => v.isEmpty ? '' : '$label: $v\n';

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppTheme.surfaceAlt,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: isSpam ? AppTheme.danger : AppTheme.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              CircleAvatar(
                radius: 24,
                backgroundColor: AppTheme.surface,
                backgroundImage: image.isNotEmpty ? NetworkImage(image) : null,
                child: image.isEmpty
                    ? Icon(isSpam ? Icons.report : Icons.person,
                        color: isSpam ? AppTheme.danger : AppTheme.accent)
                    : null,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(name.isEmpty ? 'Unknown caller' : name,
                        style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
                    if (source.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Text(
                          source == 'truecaller'
                              ? '✓ Identified by Truecaller'
                              : 'Identified via $source',
                          style: TextStyle(
                              fontSize: 11,
                              color: source == 'truecaller' ? AppTheme.accent : AppTheme.muted,
                              fontWeight: FontWeight.w600),
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
          if (isSpam) ...[
            const SizedBox(height: 10),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: AppTheme.danger.withOpacity(0.15),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(
                '☠️ Spam${spamType.isNotEmpty ? ' · $spamType' : ''}'
                '${(spam is num && spam > 0) ? ' · score $spam' : ''}',
                style: const TextStyle(color: AppTheme.danger, fontWeight: FontWeight.w700, fontSize: 12.5),
              ),
            ),
          ],
          const SizedBox(height: 10),
          Text(
            [
              line('Number', number),
              line('Type', type),
              line('Location', address.isNotEmpty ? address : country),
              line('Carrier', carrier),
              'Reports: $reports',
            ].join().trim(),
            style: const TextStyle(color: AppTheme.muted, fontSize: 12.5, height: 1.5),
          ),
          const SizedBox(height: 12),
          Wrap(spacing: 8, runSpacing: 8, children: [
            OutlinedButton.icon(
              onPressed: () async {
                final ok = await _g.report(number, spam: true);
                _snack(ok ? 'Reported as spam — thanks!' : 'Report failed.');
              },
              icon: const Icon(Icons.report, size: 18, color: AppTheme.danger),
              label: const Text('Report spam', style: TextStyle(color: AppTheme.danger)),
            ),
            OutlinedButton.icon(
              onPressed: () async {
                final next = [..._exact];
                if (!next.contains(number)) next.add(number);
                await _g.setExact(next);
                setState(() => _exact = next);
                _snack('Added to block list.');
              },
              icon: const Icon(Icons.block, size: 18),
              label: const Text('Block this number'),
            ),
          ]),
        ],
      ),
    );
  }

  // ── Generic editable list card (prefix) ─────────────────────────────────
  Widget _listCard({
    required String title,
    required String hint,
    required List<String> items,
    required Future<void> Function(List<String>) onSave,
  }) {
    return _section(Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
        const SizedBox(height: 6),
        _manualAddRow(
          hint: hint,
          digitsOnly: true,
          onAdd: (v) async {
            final next = [...items];
            if (!next.contains(v)) next.add(v);
            await onSave(next);
          },
        ),
        const SizedBox(height: 10),
        _chips(items, (e) async {
          final next = [...items]..remove(e);
          await onSave(next);
        }, empty: 'No entries yet.'),
      ],
    ));
  }

  // ── 🧬 "Block by pattern" card ───────────────────────────────────────────
  Widget _regexCard() {
    final ctl = TextEditingController();

    Future<void> add(String pattern) async {
      final v = pattern.trim();
      if (v.isEmpty) return;
      final next = [..._regex];
      if (!next.contains(v)) next.add(v);
      await _g.setRegex(next);
      setState(() => _regex = next);
    }

    Widget preset(String label, String pattern) => OutlinedButton(
          style: OutlinedButton.styleFrom(
            side: const BorderSide(color: AppTheme.border),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          ),
          onPressed: () async {
            await add(pattern);
            _snack('Rule added — calls like that are now blocked.');
          },
          child: Text(label, style: const TextStyle(fontSize: 12.5, color: AppTheme.text)),
        );

    return _section(Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('🧬 Block by pattern',
            style: TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
        const SizedBox(height: 4),
        const Text(
          'Block whole GROUPS of numbers in one tap. Pick a ready-made rule below — '
          'no tech knowledge needed.',
          style: TextStyle(color: AppTheme.muted, fontSize: 12.5),
        ),
        const SizedBox(height: 12),
        Wrap(spacing: 8, runSpacing: 8, children: [
          preset('Block all toll-free (0800…)', r'^0?800\d+'),
          preset('Block international (+…)', r'^(?!234)\d{7,}'),
          preset('Block 5-digit short codes', r'^\d{3,6}$'),
          preset('Block numbers with 0000', r'0000'),
        ]),
        const SizedBox(height: 14),
        const Text('Advanced: type your own pattern',
            style: TextStyle(color: AppTheme.muted, fontSize: 12, fontWeight: FontWeight.w700)),
        const SizedBox(height: 8),
        Row(children: [
          Expanded(
            child: TextField(
              controller: ctl,
              decoration: const InputDecoration(hintText: r'e.g. ^234(70|80|81)\d+'),
            ),
          ),
          const SizedBox(width: 10),
          ElevatedButton(
            onPressed: () async {
              final v = ctl.text.trim();
              if (v.isEmpty) return;
              await add(v);
              ctl.clear();
            },
            child: const Text('Add'),
          ),
        ]),
        const SizedBox(height: 12),
        _chips(_regex, (e) async {
          final next = [..._regex]..remove(e);
          await _g.setRegex(next);
          setState(() => _regex = next);
        }, empty: 'No pattern rules yet.'),
      ],
    ));
  }

  Widget _logButton() {
    return SizedBox(
      width: double.infinity,
      child: OutlinedButton.icon(
        onPressed: () async {
          final log = await _g.getLog();
          if (!mounted) return;
          showModalBottomSheet(
            context: context,
            backgroundColor: AppTheme.surface,
            isScrollControlled: true,
            builder: (_) => _CallLogSheet(log: log, onClear: () async {
              await _g.clearLog();
              if (mounted) Navigator.pop(context);
            }),
          );
        },
        icon: const Icon(Icons.history),
        label: const Text('View screened-call log'),
      ),
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // 💬 WHATSAPP TAB
  // ══════════════════════════════════════════════════════════════════════
  Widget _whatsappTab() {
    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _waAccessCard(),
          const SizedBox(height: 14),
          _waTogglesCard(),
          const SizedBox(height: 14),
          _waContactsCard(
            title: '🚫 Block WhatsApp from these contacts',
            names: _waBlockNames,
            onSave: (v) async { await _g.setWaBlockNames(v); setState(() => _waBlockNames = v); },
            empty: 'No blocked WhatsApp contacts yet.',
          ),
          const SizedBox(height: 14),
          _waUnknownCard(),
          const SizedBox(height: 14),
          _waLogButton(),
          const SizedBox(height: 28),
        ],
      ),
    );
  }

  Widget _waAccessCard() {
    return _section(Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _statusRow(_notifAccess, 'Notification access: GRANTED',
            'Notification access: not granted'),
        const SizedBox(height: 8),
        const Text(
          'WhatsApp calls do NOT go through the phone line, so the only way to '
          'catch them is to watch WhatsApp\'s notifications. Grant Notification '
          'Access and the guard sees every WhatsApp call / voice-note the moment '
          'it arrives and dismisses the ones you blocked.',
          style: TextStyle(color: AppTheme.muted, fontSize: 12.5),
        ),
        const SizedBox(height: 12),
        SizedBox(
          width: double.infinity,
          child: ElevatedButton(
            onPressed: () async {
              await _g.requestNotifAccess();
              await Future.delayed(const Duration(milliseconds: 400));
              await _refresh();
            },
            child: Text(_notifAccess ? 'Re-check access' : 'Grant notification access'),
          ),
        ),
      ],
    ));
  }

  Widget _waTogglesCard() {
    return _section(Column(children: [
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        activeColor: AppTheme.accent,
        title: const Text('Enable WhatsApp Guard',
            style: TextStyle(fontWeight: FontWeight.w700)),
        subtitle: const Text('Master switch for WhatsApp call/audio blocking',
            style: TextStyle(color: AppTheme.muted, fontSize: 12)),
        value: _waEnabled,
        onChanged: (v) async {
          await _g.setWaEnabled(v);
          setState(() => _waEnabled = v);
          if (v && !_notifAccess) _snack('Grant notification access above to enforce.');
        },
      ),
      const Divider(color: AppTheme.border, height: 1),
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        activeColor: AppTheme.accent,
        title: const Text('Block WhatsApp calls (voice & video)',
            style: TextStyle(fontWeight: FontWeight.w700)),
        value: _waBlockCalls,
        onChanged: (v) async {
          await _g.setWaBlockCalls(v);
          setState(() => _waBlockCalls = v);
        },
      ),
      const Divider(color: AppTheme.border, height: 1),
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        activeColor: AppTheme.accent,
        title: const Text('Block WhatsApp voice-notes (audio)',
            style: TextStyle(fontWeight: FontWeight.w700)),
        subtitle: const Text('Dismiss incoming voice-message notifications',
            style: TextStyle(color: AppTheme.muted, fontSize: 12)),
        value: _waBlockAudio,
        onChanged: (v) async {
          await _g.setWaBlockAudio(v);
          setState(() => _waBlockAudio = v);
        },
      ),
    ]));
  }

  Widget _waUnknownCard() {
    return _section(Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          activeColor: AppTheme.accent,
          title: const Text('🛑 Block unknown WhatsApp callers',
              style: TextStyle(fontWeight: FontWeight.w800, fontSize: 14.5)),
          subtitle: const Text(
              'Block EVERYONE on WhatsApp except the contacts you allow below. '
              'Anyone not on the allow-list is treated as "unknown" and blocked.',
              style: TextStyle(color: AppTheme.muted, fontSize: 12)),
          value: _waBlockUnknown,
          onChanged: (v) async {
            await _g.setWaBlockUnknown(v);
            setState(() => _waBlockUnknown = v);
          },
        ),
        const SizedBox(height: 6),
        Row(children: [
          const Expanded(
            child: Text('✅ Allowed WhatsApp contacts',
                style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13)),
          ),
          TextButton.icon(
            onPressed: () async {
              final picked = await ContactPickerSheet.show(context,
                  returnNumbers: false, title: 'Allow on WhatsApp');
              if (picked == null || picked.isEmpty) return;
              final next = [..._waAllowNames];
              for (final p in picked) { if (!next.contains(p)) next.add(p); }
              await _g.setWaAllowNames(next);
              setState(() => _waAllowNames = next);
            },
            icon: const Icon(Icons.person_add_alt_1, size: 18),
            label: const Text('From contacts'),
          ),
        ]),
        _manualAddRow(
          hint: 'Contact name (as shown in WhatsApp)',
          digitsOnly: false,
          onAdd: (v) async {
            final next = [..._waAllowNames];
            if (!next.contains(v)) next.add(v);
            await _g.setWaAllowNames(next);
            setState(() => _waAllowNames = next);
          },
        ),
        const SizedBox(height: 10),
        _chips(_waAllowNames, (e) async {
          final next = [..._waAllowNames]..remove(e);
          await _g.setWaAllowNames(next);
          setState(() => _waAllowNames = next);
        }, empty: 'No allowed WhatsApp contacts yet.'),
      ],
    ));
  }

  Widget _waContactsCard({
    required String title,
    required List<String> names,
    required Future<void> Function(List<String>) onSave,
    required String empty,
  }) {
    return _section(Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(children: [
          Expanded(
            child: Text(title,
                style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 14.5)),
          ),
          TextButton.icon(
            onPressed: () async {
              final picked = await ContactPickerSheet.show(context,
                  returnNumbers: false, title: 'Block on WhatsApp');
              if (picked == null || picked.isEmpty) return;
              final next = [...names];
              for (final p in picked) { if (!next.contains(p)) next.add(p); }
              await onSave(next);
              _snack('Blocked ${picked.length} on WhatsApp.');
            },
            icon: const Icon(Icons.person_off, size: 18),
            label: const Text('From contacts'),
          ),
        ]),
        const SizedBox(height: 4),
        const Text('We match the caller name WhatsApp shows in its notification.',
            style: TextStyle(color: AppTheme.muted, fontSize: 11.5)),
        const SizedBox(height: 6),
        _manualAddRow(
          hint: 'Contact name (as shown in WhatsApp)',
          digitsOnly: false,
          onAdd: (v) async {
            final next = [...names];
            if (!next.contains(v)) next.add(v);
            await onSave(next);
          },
        ),
        const SizedBox(height: 10),
        _chips(names, (e) async {
          final next = [...names]..remove(e);
          await onSave(next);
        }, empty: empty),
      ],
    ));
  }

  Widget _waLogButton() {
    return SizedBox(
      width: double.infinity,
      child: OutlinedButton.icon(
        onPressed: () async {
          final log = await _g.getWaLog();
          if (!mounted) return;
          showModalBottomSheet(
            context: context,
            backgroundColor: AppTheme.surface,
            isScrollControlled: true,
            builder: (_) => _WaLogSheet(log: log, onClear: () async {
              await _g.clearWaLog();
              if (mounted) Navigator.pop(context);
            }),
          );
        },
        icon: const Icon(Icons.history),
        label: const Text('View WhatsApp guard log'),
      ),
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // 🛡️ BACKGROUND TAB
  // ══════════════════════════════════════════════════════════════════════
  Widget _backgroundTab() {
    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _section(Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _statusRow(_guardPersistent, 'Anti-kill guard: RUNNING',
                  'Anti-kill guard: OFF'),
              const SizedBox(height: 8),
              const Text(
                'Keeps the call + WhatsApp guard alive as a foreground service so '
                'Android and phone-maker battery managers CANNOT silently stop it. '
                'It survives reboots and you swiping the app away — it only stops '
                'when YOU turn it off here.',
                style: TextStyle(color: AppTheme.muted, fontSize: 12.5),
              ),
              const SizedBox(height: 12),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                activeColor: AppTheme.accent,
                title: const Text('Keep guard running in background',
                    style: TextStyle(fontWeight: FontWeight.w800)),
                subtitle: const Text('Shows a small ongoing "Phone Guard is active" notification',
                    style: TextStyle(color: AppTheme.muted, fontSize: 12)),
                value: _guardPersistent,
                onChanged: (v) async {
                  if (v) {
                    await _g.startPersistentGuard();
                    _snack('Guard pinned — it will keep running in the background.');
                  } else {
                    await _g.stopPersistentGuard();
                    _snack('Guard unpinned. (You turned it off — as designed.)');
                  }
                  await Future.delayed(const Duration(milliseconds: 400));
                  await _refresh();
                },
              ),
            ],
          )),
          const SizedBox(height: 14),
          _section(Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _statusRow(_batteryUnrestricted, 'Battery: unrestricted ✓',
                  'Battery: restricted (may get killed)'),
              const SizedBox(height: 8),
              const Text(
                'For the anti-kill guard to be bullet-proof, also let WormGPT '
                'ignore battery optimisation. Otherwise Doze mode may still pause '
                'it after long idle periods.',
                style: TextStyle(color: AppTheme.muted, fontSize: 12.5),
              ),
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: _batteryUnrestricted
                      ? null
                      : () async {
                          await _g.requestBatteryUnrestricted();
                          await Future.delayed(const Duration(milliseconds: 600));
                          await _refresh();
                        },
                  child: Text(_batteryUnrestricted
                      ? 'Already unrestricted'
                      : 'Allow unrestricted battery'),
                ),
              ),
              const SizedBox(height: 8),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  onPressed: () => _g.openAppSettings(),
                  icon: const Icon(Icons.settings),
                  label: const Text('Open app settings (autostart / battery)'),
                ),
              ),
            ],
          )),
          const SizedBox(height: 14),
          _section(const Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('💡 OEM tip',
                  style: TextStyle(fontWeight: FontWeight.w800, fontSize: 14.5)),
              SizedBox(height: 6),
              Text(
                'Some phones (Xiaomi/MIUI, Oppo/ColorOS, Vivo, Samsung, Huawei) have '
                'an extra "Autostart" or "Don\'t kill" setting per app. If the guard '
                'ever stops on your phone, open the app settings above and enable '
                'Autostart / set battery to "No restrictions".',
                style: TextStyle(color: AppTheme.muted, fontSize: 12.5, height: 1.5),
              ),
            ],
          )),
          const SizedBox(height: 28),
        ],
      ),
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // Shared little widgets
  // ══════════════════════════════════════════════════════════════════════
  Widget _manualAddRow({
    required String hint,
    required bool digitsOnly,
    required Future<void> Function(String) onAdd,
  }) {
    final ctl = TextEditingController();
    return Row(children: [
      Expanded(
        child: TextField(
          controller: ctl,
          decoration: InputDecoration(hintText: hint),
          inputFormatters: digitsOnly
              ? [FilteringTextInputFormatter.allow(RegExp(r'[0-9+]'))]
              : null,
        ),
      ),
      const SizedBox(width: 10),
      ElevatedButton(
        onPressed: () async {
          final v = ctl.text.trim();
          if (v.isEmpty) return;
          await onAdd(v);
          ctl.clear();
        },
        child: const Text('Add'),
      ),
    ]);
  }

  Widget _chips(List<String> items, Future<void> Function(String) onDelete,
      {required String empty}) {
    if (items.isEmpty) {
      return Text(empty, style: const TextStyle(color: AppTheme.muted, fontSize: 12));
    }
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: items
          .map((e) => Chip(
                label: Text(e, style: const TextStyle(fontSize: 12.5)),
                backgroundColor: AppTheme.surfaceAlt,
                side: const BorderSide(color: AppTheme.border),
                deleteIcon: const Icon(Icons.close, size: 16),
                onDeleted: () => onDelete(e),
              ))
          .toList(),
    );
  }
}

// ── Screened-call log sheet ───────────────────────────────────────────────
class _CallLogSheet extends StatelessWidget {
  final List<Map<String, dynamic>> log;
  final Future<void> Function() onClear;
  const _CallLogSheet({required this.log, required this.onClear});

  @override
  Widget build(BuildContext context) {
    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.6,
      maxChildSize: 0.9,
      builder: (_, ctl) => Column(
        children: [
          const SizedBox(height: 12),
          Container(width: 44, height: 4, decoration: BoxDecoration(
              color: AppTheme.border, borderRadius: BorderRadius.circular(4))),
          Padding(
            padding: const EdgeInsets.all(14),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                const Text('Screened calls',
                    style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
                TextButton(onPressed: onClear, child: const Text('Clear')),
              ],
            ),
          ),
          Expanded(
            child: log.isEmpty
                ? const Center(child: Text('No screened calls yet.',
                    style: TextStyle(color: AppTheme.muted)))
                : ListView.separated(
                    controller: ctl,
                    padding: const EdgeInsets.symmetric(horizontal: 14),
                    itemCount: log.length,
                    separatorBuilder: (_, __) =>
                        const Divider(color: AppTheme.border, height: 1),
                    itemBuilder: (_, i) {
                      final e = log[i];
                      final priv = e['private'] == true;
                      final blocked = e['blocked'] == true;
                      final num = (e['number'] ?? '').toString();
                      final label = (e['label'] ?? '').toString();
                      return ListTile(
                        leading: Icon(
                          blocked ? Icons.block : Icons.call_received,
                          color: blocked ? AppTheme.danger : AppTheme.accent,
                        ),
                        title: Text(
                          priv ? 'Private / Unknown' : (num.isEmpty ? 'Unknown' : num),
                          style: const TextStyle(fontWeight: FontWeight.w700),
                        ),
                        subtitle: Text(
                          [
                            if (label.isNotEmpty && label != 'Private / Unknown') label,
                            blocked ? 'Blocked' : 'Allowed',
                          ].join(' · '),
                          style: const TextStyle(color: AppTheme.muted, fontSize: 12),
                        ),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}

// ── WhatsApp guard log sheet ──────────────────────────────────────────────
class _WaLogSheet extends StatelessWidget {
  final List<Map<String, dynamic>> log;
  final Future<void> Function() onClear;
  const _WaLogSheet({required this.log, required this.onClear});

  @override
  Widget build(BuildContext context) {
    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.6,
      maxChildSize: 0.9,
      builder: (_, ctl) => Column(
        children: [
          const SizedBox(height: 12),
          Container(width: 44, height: 4, decoration: BoxDecoration(
              color: AppTheme.border, borderRadius: BorderRadius.circular(4))),
          Padding(
            padding: const EdgeInsets.all(14),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                const Text('WhatsApp guard log',
                    style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
                TextButton(onPressed: onClear, child: const Text('Clear')),
              ],
            ),
          ),
          Expanded(
            child: log.isEmpty
                ? const Center(child: Text('No WhatsApp events yet.',
                    style: TextStyle(color: AppTheme.muted)))
                : ListView.separated(
                    controller: ctl,
                    padding: const EdgeInsets.symmetric(horizontal: 14),
                    itemCount: log.length,
                    separatorBuilder: (_, __) =>
                        const Divider(color: AppTheme.border, height: 1),
                    itemBuilder: (_, i) {
                      final e = log[i];
                      final blocked = e['blocked'] == true;
                      final name = (e['name'] ?? '').toString();
                      final kind = (e['kind'] ?? '').toString();
                      return ListTile(
                        leading: Icon(
                          blocked ? Icons.block : Icons.check_circle_outline,
                          color: blocked ? AppTheme.danger : AppTheme.accent,
                        ),
                        title: Text(name.isEmpty ? 'Unknown' : name,
                            style: const TextStyle(fontWeight: FontWeight.w700)),
                        subtitle: Text(
                          '${kind == 'call' ? 'WhatsApp call' : 'WhatsApp audio'} · '
                          '${blocked ? 'Blocked' : 'Allowed'}',
                          style: const TextStyle(color: AppTheme.muted, fontSize: 12),
                        ),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}
