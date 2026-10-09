import 'package:flutter/material.dart';
import '../theme.dart';
import '../api/call_guard_service.dart';

/// A bottom-sheet that lets the user search & multi-select device contacts.
///
/// Used by Phone Guard to pick who to BLOCK or who is ALLOWED (whitelist),
/// for both normal calls (returns phone numbers) and WhatsApp (returns names).
class ContactPickerSheet extends StatefulWidget {
  /// When true the sheet returns the picked NUMBERS; otherwise the NAMES.
  final bool returnNumbers;
  final String title;
  const ContactPickerSheet({
    super.key,
    required this.returnNumbers,
    this.title = 'Pick contacts',
  });

  /// Opens the picker. Returns the chosen values (numbers or names), or null.
  static Future<List<String>?> show(
    BuildContext context, {
    required bool returnNumbers,
    String title = 'Pick contacts',
  }) {
    return showModalBottomSheet<List<String>>(
      context: context,
      backgroundColor: AppTheme.surface,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => ContactPickerSheet(returnNumbers: returnNumbers, title: title),
    );
  }

  @override
  State<ContactPickerSheet> createState() => _ContactPickerSheetState();
}

class _ContactPickerSheetState extends State<ContactPickerSheet> {
  final _g = CallGuardService.instance;
  final _searchCtl = TextEditingController();
  bool _loading = true;
  bool _denied = false;
  List<Map<String, String>> _all = [];
  final Set<String> _selected = {}; // stores the value (number or name)

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    var granted = await _g.hasContactsPermission();
    if (!granted) {
      await _g.requestContactsPermission();
      await Future.delayed(const Duration(milliseconds: 700));
      granted = await _g.hasContactsPermission();
    }
    if (!granted) {
      if (mounted) setState(() { _loading = false; _denied = true; });
      return;
    }
    final c = await _g.readContacts();
    if (!mounted) return;
    setState(() { _all = c; _loading = false; });
  }

  List<Map<String, String>> get _filtered {
    final q = _searchCtl.text.trim().toLowerCase();
    if (q.isEmpty) return _all;
    return _all.where((e) =>
        (e['name'] ?? '').toLowerCase().contains(q) ||
        (e['number'] ?? '').toLowerCase().contains(q)).toList();
  }

  String _valueOf(Map<String, String> c) =>
      widget.returnNumbers ? (c['number'] ?? '') : (c['name'] ?? '');

  @override
  Widget build(BuildContext context) {
    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.85,
      maxChildSize: 0.95,
      minChildSize: 0.5,
      builder: (_, ctl) => Column(
        children: [
          const SizedBox(height: 12),
          Container(width: 44, height: 4, decoration: BoxDecoration(
              color: AppTheme.border, borderRadius: BorderRadius.circular(4))),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 8),
            child: Row(
              children: [
                Expanded(
                  child: Text(widget.title,
                      style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 17)),
                ),
                Text('${_selected.length} selected',
                    style: const TextStyle(color: AppTheme.muted, fontSize: 12)),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: TextField(
              controller: _searchCtl,
              onChanged: (_) => setState(() {}),
              decoration: const InputDecoration(
                hintText: 'Search name or number…',
                prefixIcon: Icon(Icons.search, color: AppTheme.muted),
              ),
            ),
          ),
          const SizedBox(height: 8),
          Expanded(child: _body(ctl)),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Row(children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => Navigator.pop(context),
                    child: const Text('Cancel'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: ElevatedButton(
                    onPressed: _selected.isEmpty
                        ? null
                        : () => Navigator.pop(
                            context, _selected.where((e) => e.isNotEmpty).toList()),
                    child: Text('Add ${_selected.length}'),
                  ),
                ),
              ]),
            ),
          ),
        ],
      ),
    );
  }

  Widget _body(ScrollController ctl) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_denied) {
      return Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.contacts_outlined, size: 40, color: AppTheme.muted),
            const SizedBox(height: 12),
            const Text('Contacts permission denied',
                textAlign: TextAlign.center,
                style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 6),
            const Text('Grant Contacts access to pick people from your phonebook. '
                'You can still add numbers/names manually.',
                textAlign: TextAlign.center,
                style: TextStyle(color: AppTheme.muted, fontSize: 12.5)),
            const SizedBox(height: 14),
            ElevatedButton(onPressed: () { setState(() { _loading = true; _denied = false; }); _load(); },
                child: const Text('Try again')),
            TextButton(onPressed: () => _g.openAppSettings(),
                child: const Text('Open app settings')),
          ],
        ),
      );
    }
    final list = _filtered;
    if (list.isEmpty) {
      return const Center(child: Text('No contacts found.',
          style: TextStyle(color: AppTheme.muted)));
    }
    return ListView.builder(
      controller: ctl,
      itemCount: list.length,
      itemBuilder: (_, i) {
        final c = list[i];
        final value = _valueOf(c);
        final checked = _selected.contains(value);
        return CheckboxListTile(
          activeColor: AppTheme.accent,
          value: checked,
          onChanged: value.isEmpty
              ? null
              : (v) => setState(() {
                    if (v == true) {
                      _selected.add(value);
                    } else {
                      _selected.remove(value);
                    }
                  }),
          title: Text(c['name']?.isNotEmpty == true ? c['name']! : (c['number'] ?? ''),
              style: const TextStyle(fontWeight: FontWeight.w600)),
          subtitle: widget.returnNumbers
              ? Text(c['number'] ?? '', style: const TextStyle(color: AppTheme.muted, fontSize: 12))
              : (c['number']?.isNotEmpty == true
                  ? Text(c['number']!, style: const TextStyle(color: AppTheme.muted, fontSize: 12))
                  : null),
        );
      },
    );
  }
}
