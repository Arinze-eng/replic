// Super Local Sandbox AI Screen — RezeAI-style Alpine Linux inside Android
// 
// This tool gives the app a FULL Linux environment using proot + Alpine.
// Users can install packages, run commands, process files, etc.
// Same architecture as RezeAI's linux_setup / linux_exec / linux_install.

import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:open_filex/open_filex.dart';
import 'package:share_plus/share_plus.dart';
import '../api/super_local_sandbox.dart';
import '../theme.dart';

class SuperLocalSandboxScreen extends StatefulWidget {
  const SuperLocalSandboxScreen({super.key});
  @override
  State<SuperLocalSandboxScreen> createState() => _SuperLocalSandboxScreenState();
}

class _SuperLocalSandboxScreenState extends State<SuperLocalSandboxScreen> {
  final _sandbox = SuperLocalSandbox();
  final _commandController = TextEditingController();
  final _outputController = TextEditingController();
  final _pkgController = TextEditingController();
  final _sharedFiles = <File>[];
  
  @override
  void initState() {
    super.initState();
    _sandbox.addListener(_onSandboxChanged);
    _sandbox.initialise().then((_) => _refreshFiles());
  }
  
  @override
  void dispose() {
    _sandbox.removeListener(_onSandboxChanged);
    _commandController.dispose();
    _outputController.dispose();
    _pkgController.dispose();
    super.dispose();
  }
  
  void _onSandboxChanged() {
    if (mounted) setState(() {});
  }
  
  Future<void> _setup() async {
    _outputController.text = '🔄 Setting up Alpine Linux...\n';
    try {
      final result = await _sandbox.setup();
      _outputController.text += '\n✅ $result\n';
    } catch (e) {
      _outputController.text += '\n❌ Setup failed: $e\n';
    }
  }
  
  Future<void> _exec() async {
    final cmd = _commandController.text.trim();
    if (cmd.isEmpty) return;
    _outputController.text += '\n⚡ \$ $cmd\n';
    setState(() {});
    final result = await _sandbox.exec(cmd, timeoutSeconds: 900);
    _outputController.text += '$result\n';
    _commandController.clear();
    await _refreshFiles();
  }

  Future<void> _pickFiles() async {
    final picked = await FilePicker.platform.pickFiles(allowMultiple: true, withData: false);
    if (picked == null) return;
    for (final f in picked.files) {
      if (f.path != null) await _sandbox.stageFile(f.path!, f.name);
    }
    await _refreshFiles();
    _outputController.text += '\n📎 ${picked.files.length} file(s) added under /shared.\n';
  }

  Future<void> _refreshFiles() async {
    final files = (await _sandbox.sharedFiles()).whereType<File>().toList();
    if (mounted) setState(() { _sharedFiles..clear()..addAll(files); });
  }

  Future<void> _stop() async {
    if (await _sandbox.cancelActive()) {
      _outputController.text += '\n🛑 Command stopped.\n';
      if (mounted) setState(() {});
    }
  }
  
  Future<void> _install() async {
    final pkg = _pkgController.text.trim();
    if (pkg.isEmpty) return;
    
    _outputController.text += '\n📦 Installing: $pkg\n';
    final result = await _sandbox.install(pkg);
    _outputController.text += '$result\n';
    _pkgController.clear();
  }
  
  Future<void> _checkStatus() async {
    final status = await _sandbox.status();
    _outputController.text += '\n$status\n';
  }
  
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('🐧 Super Local Sandbox AI'),
        actions: [
          if (_sandbox.isReady)
            IconButton(
              icon: const Icon(Icons.attach_file),
              onPressed: _sandbox.isBusy ? null : _pickFiles,
              tooltip: 'Add files to /shared',
            ),
          if (_sandbox.isReady)
            IconButton(
              icon: const Icon(Icons.info_outline),
              onPressed: _checkStatus,
              tooltip: 'Status',
            ),
        ],
      ),
      body: Column(
        children: [
          // Status bar
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            color: _sandbox.isReady
                ? Colors.green.withOpacity(0.15)
                : AppTheme.surface,
            child: Row(
              children: [
                Icon(
                  _sandbox.isReady ? Icons.check_circle : Icons.hourglass_empty,
                  color: _sandbox.isReady ? Colors.green : Colors.grey,
                  size: 20,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    _sandbox.isReady
                        ? 'Alpine Linux ready — install anything with apk'
                        : 'Alpine Linux not set up',
                    style: const TextStyle(fontSize: 13),
                  ),
                ),
                if (!_sandbox.isReady && !_sandbox.isBusy)
                  TextButton(
                    onPressed: _setup,
                    child: const Text('Setup Now'),
                  ),
                if (_sandbox.isBusy)
                  const SizedBox(
                    width: 20, height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
              ],
            ),
          ),
          
          // Output
          Expanded(
            child: Container(
              margin: const EdgeInsets.all(12),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.black87,
                borderRadius: BorderRadius.circular(12),
              ),
              child: SingleChildScrollView(
                child: SelectableText(
                  _outputController.text.isEmpty
                      ? 'Alpine Linux Terminal\n\n'
                          'Commands available:\n'
                          '  • python3, node, ffmpeg, imagemagick\n'
                          '  • git, gcc, make, pandoc, curl, wget\n'
                          '  • jq, sqlite3, yt-dlp, py3-pillow\n\n'
                          'Tap "Setup Now" above to install Alpine Linux (~4MB download).\n'
                          'Then run any Linux command!\n\n'
                          'Examples:\n'
                          '  python3 -c "print(\'hello\')"\n'
                          '  apk add ffmpeg\n'
                          '  curl -s https://example.com'
                      : _outputController.text,
                  style: const TextStyle(
                    fontFamily: 'monospace',
                    fontSize: 13,
                    color: Colors.greenAccent,
                  ),
                ),
              ),
            ),
          ),
          
          if (_sharedFiles.isNotEmpty)
            Container(
              constraints: const BoxConstraints(maxHeight: 96),
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: ListView(
                children: _sharedFiles.map((f) => Row(children: [
                  const Icon(Icons.insert_drive_file, size: 16),
                  const SizedBox(width: 6),
                  Expanded(child: Text(f.uri.pathSegments.last, maxLines: 1, overflow: TextOverflow.ellipsis)),
                  IconButton(tooltip: 'Open', icon: const Icon(Icons.open_in_new, size: 17), onPressed: () => OpenFilex.open(f.path)),
                  IconButton(tooltip: 'Share', icon: const Icon(Icons.share, size: 17), onPressed: () => Share.shareXFiles([XFile(f.path)])),
                ])).toList(),
              ),
            ),

          // Quick actions
          if (_sandbox.isReady)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _pkgController,
                      decoration: const InputDecoration(
                        hintText: 'apk package name...',
                        isDense: true,
                        border: OutlineInputBorder(),
                        contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      ),
                      style: const TextStyle(fontSize: 14),
                      onSubmitted: (_) => _install(),
                    ),
                  ),
                  const SizedBox(width: 8),
                  IconButton(
                    icon: const Icon(Icons.download),
                    onPressed: _install,
                    tooltip: 'Install package',
                  ),
                ],
              ),
            ),
          
          // Command input
          Padding(
            padding: const EdgeInsets.all(12),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _commandController,
                    decoration: InputDecoration(
                      hintText: _sandbox.isReady
                          ? 'Enter command...'
                          : 'Setup Alpine first...',
                      isDense: true,
                      border: const OutlineInputBorder(),
                      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                    ),
                    style: const TextStyle(fontFamily: 'monospace', fontSize: 14),
                    enabled: _sandbox.isReady,
                    onSubmitted: (_) => _exec(),
                  ),
                ),
                const SizedBox(width: 8),
                IconButton(
                  icon: Icon(_sandbox.isBusy ? Icons.stop_rounded : Icons.play_arrow),
                  color: _sandbox.isBusy ? AppTheme.danger : null,
                  onPressed: !_sandbox.isReady ? null : (_sandbox.isBusy ? _stop : _exec),
                  tooltip: _sandbox.isBusy ? 'Stop command' : 'Run command',
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}