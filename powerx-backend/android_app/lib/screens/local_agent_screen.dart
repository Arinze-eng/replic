// local_agent_screen.dart — chat UI for the FUSION brain driving the LOCAL
// Alpine Linux sandbox, with image / audio / file attachments.
//
// This is the on-device counterpart to the server agent: reasoning + vision +
// audio + file understanding come from the FUSION brain (/api/brain), while all
// execution (code, ffmpeg, package installs, file processing) runs inside the
// local Alpine sandbox on the phone.

import 'dart:io';
import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:image_picker/image_picker.dart';
import 'package:open_filex/open_filex.dart';
import 'package:share_plus/share_plus.dart';
import '../api/local_brain_agent.dart';
import '../api/super_local_sandbox.dart';
import '../theme.dart';

class LocalAgentScreen extends StatefulWidget {
  const LocalAgentScreen({super.key});
  @override
  State<LocalAgentScreen> createState() => _LocalAgentScreenState();
}

class _LocalAgentScreenState extends State<LocalAgentScreen> {
  final _sandbox = SuperLocalSandbox();
  late final LocalBrainAgent _agent = LocalBrainAgent(sandbox: _sandbox);
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final _events = <LocalAgentEvent>[];
  final _attachments = <LocalAgentAttachment>[];
  final _outputs = <File>[];
  bool _running = false;

  @override
  void initState() {
    super.initState();
    _sandbox.initialise().then((_) async {
      final files = (await _sandbox.sharedFiles()).whereType<File>().toList();
      if (mounted) setState(() { _outputs..clear()..addAll(files); });
    });
  }

  @override
  void dispose() {
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _add(LocalAgentEvent e) {
    if (!mounted) return;
    setState(() => _events.add(e));
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent,
            duration: const Duration(milliseconds: 200), curve: Curves.easeOut);
      }
    });
  }

  String _kindFor(String path) {
    final p = path.toLowerCase();
    if (RegExp(r'\.(png|jpe?g|gif|webp|bmp|heic)$').hasMatch(p)) return 'image';
    if (RegExp(r'\.(mp3|wav|m4a|aac|ogg|opus|flac)$').hasMatch(p)) return 'audio';
    if (RegExp(r'\.(pdf|docx?|xlsx?|txt|md|csv|json|pptx?)$').hasMatch(p)) return 'doc';
    return 'other';
  }

  Future<void> _pickImage() async {
    final x = await ImagePicker().pickImage(source: ImageSource.gallery);
    if (x != null) {
      setState(() => _attachments.add(
          LocalAgentAttachment(name: x.name, path: x.path, kind: 'image')));
    }
  }

  Future<void> _pickFile() async {
    final r = await FilePicker.platform.pickFiles(allowMultiple: true, withData: false);
    if (r != null) {
      for (final f in r.files) {
        if (f.path == null) continue;
        setState(() => _attachments.add(LocalAgentAttachment(
            name: f.name, path: f.path!, kind: _kindFor(f.path!))));
      }
    }
  }

  Future<void> _send() async {
    final task = _input.text.trim();
    if (task.isEmpty || _running) return;
    setState(() {
      _running = true;
      _events.add(LocalAgentEvent('you', task));
      _input.clear();
    });
    final atts = List<LocalAgentAttachment>.from(_attachments);
    setState(() => _attachments.clear());
    try {
      await for (final e in _agent.run(task, attachments: atts)) {
        _add(e);
      }
    } finally {
      final files = (await _sandbox.sharedFiles()).whereType<File>().toList();
      if (mounted) setState(() {
        _running = false;
        _outputs
          ..clear()
          ..addAll(files);
      });
    }
  }

  Future<void> _stop() async {
    if (!_running) return;
    await _agent.cancel();
    if (mounted) setState(() => _running = false);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('🐧 Local Brain Agent'),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(22),
          child: Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Text(
              _sandbox.isReady
                  ? 'FUSION brain · local Alpine sandbox ready'
                  : 'FUSION brain · Alpine boots on first run',
              style: const TextStyle(fontSize: 11, color: Colors.white70),
            ),
          ),
        ),
      ),
      body: Column(
        children: [
          Expanded(
            child: ListView.builder(
              controller: _scroll,
              padding: const EdgeInsets.all(12),
              itemCount: _events.length,
              itemBuilder: (_, i) => _bubble(_events[i]),
            ),
          ),
          if (_outputs.isNotEmpty)
            Container(
              width: double.infinity,
              constraints: const BoxConstraints(maxHeight: 110),
              padding: const EdgeInsets.fromLTRB(12, 6, 12, 2),
              child: ListView(
                children: _outputs.map((f) => Row(
                  children: [
                    const Icon(Icons.insert_drive_file, size: 17),
                    const SizedBox(width: 6),
                    Expanded(child: Text(f.uri.pathSegments.last, maxLines: 1, overflow: TextOverflow.ellipsis)),
                    IconButton(tooltip: 'Open', icon: const Icon(Icons.open_in_new, size: 18), onPressed: () => OpenFilex.open(f.path)),
                    IconButton(tooltip: 'Share', icon: const Icon(Icons.share, size: 18), onPressed: () => Share.shareXFiles([XFile(f.path)])),
                  ],
                )).toList(),
              ),
            ),
          if (_attachments.isNotEmpty)
            SizedBox(
              height: 42,
              child: ListView(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 12),
                children: _attachments
                    .map((a) => Padding(
                          padding: const EdgeInsets.only(right: 8),
                          child: Chip(
                            label: Text(a.name, overflow: TextOverflow.ellipsis),
                            avatar: Text(_emojiFor(a.kind)),
                            onDeleted: () => setState(() => _attachments.remove(a)),
                          ),
                        ))
                    .toList(),
              ),
            ),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.all(10),
              child: Row(
                children: [
                  IconButton(
                    icon: const Icon(Icons.image_outlined),
                    tooltip: 'Add image',
                    onPressed: _running ? null : _pickImage,
                  ),
                  IconButton(
                    icon: const Icon(Icons.attach_file),
                    tooltip: 'Add file / audio',
                    onPressed: _running ? null : _pickFile,
                  ),
                  Expanded(
                    child: TextField(
                      controller: _input,
                      minLines: 1,
                      maxLines: 4,
                      decoration: const InputDecoration(
                        hintText: 'Ask the local agent to do something…',
                        border: OutlineInputBorder(),
                        isDense: true,
                        contentPadding:
                            EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      ),
                      onSubmitted: (_) => _send(),
                    ),
                  ),
                  const SizedBox(width: 8),
                  IconButton(
                    tooltip: _running ? 'Stop task' : 'Send',
                    style: IconButton.styleFrom(
                      backgroundColor: _running ? AppTheme.danger : AppTheme.accent,
                      foregroundColor: Colors.white,
                    ),
                    icon: Icon(_running ? Icons.stop_rounded : Icons.send),
                    onPressed: _running ? _stop : _send,
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  String _emojiFor(String kind) {
    switch (kind) {
      case 'image':
        return '🖼️';
      case 'audio':
        return '🎧';
      case 'doc':
        return '📄';
      default:
        return '📎';
    }
  }

  Widget _bubble(LocalAgentEvent e) {
    final isYou = e.type == 'you';
    final isDone = e.type == 'done';
    final isErr = e.type == 'error';
    final isExec = e.type == 'exec';
    Color bg;
    String label;
    switch (e.type) {
      case 'you':
        bg = AppTheme.accent.withOpacity(0.25);
        label = 'You';
        break;
      case 'done':
        bg = Colors.green.withOpacity(0.15);
        label = '✅ Answer';
        break;
      case 'error':
        bg = Colors.red.withOpacity(0.15);
        label = '❌ Error';
        break;
      case 'exec':
        bg = Colors.black87;
        label = '⚡ Alpine';
        break;
      case 'observe':
        bg = Colors.black54;
        label = '📤 Output';
        break;
      case 'vision':
        bg = Colors.blue.withOpacity(0.12);
        label = '👁️ Understanding';
        break;
      case 'audio':
        bg = Colors.purple.withOpacity(0.12);
        label = '🎧 Audio';
        break;
      case 'think':
        bg = AppTheme.surface;
        label = '💭 Plan';
        break;
      default:
        bg = AppTheme.surface;
        label = '•';
    }
    return Align(
      alignment: isYou ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.all(10),
        constraints: BoxConstraints(
            maxWidth: MediaQuery.of(context).size.width * 0.85),
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label,
                style: const TextStyle(
                    fontSize: 11, fontWeight: FontWeight.bold, color: Colors.white70)),
            const SizedBox(height: 4),
            SelectableText(
              e.text,
              style: TextStyle(
                fontSize: (isExec || e.type == 'observe') ? 12.5 : 14,
                fontFamily:
                    (isExec || e.type == 'observe') ? 'monospace' : null,
                color: (isExec || e.type == 'observe')
                    ? Colors.greenAccent
                    : (isErr ? Colors.redAccent : Colors.white),
                fontWeight: isDone ? FontWeight.w500 : FontWeight.normal,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
