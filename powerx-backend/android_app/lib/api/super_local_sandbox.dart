// Android-native Alpine Linux runtime backed by a bundled PRoot executable.
// No Termux installation or root access is required. The rootfs and user files
// live in app-private persistent storage; /shared is the explicit interchange
// directory for picked files and generated outputs.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:archive/archive.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';

enum SandboxPhase { idle, settingUp, ready, error }

class SandboxCommandResult {
  final int exitCode;
  final String stdout;
  final String stderr;
  final bool cancelled;
  final bool timedOut;
  const SandboxCommandResult({
    required this.exitCode,
    required this.stdout,
    required this.stderr,
    this.cancelled = false,
    this.timedOut = false,
  });
  String get output {
    final text = [stdout, stderr].where((v) => v.trim().isNotEmpty).join('\n').trim();
    if (cancelled) return text.isEmpty ? 'Task stopped.' : '$text\nTask stopped.';
    if (timedOut) return text.isEmpty ? 'Command timed out.' : '$text\nCommand timed out.';
    return text.isEmpty ? '(no output)' : text;
  }
}

class SuperLocalSandbox extends ChangeNotifier {
  static const _native = MethodChannel('com.hackerx.wormgpt_agent/linux');
  static const _alpineVersion = '3.20.3';
  static const _runtimeRevision = '2';

  SandboxPhase phase = SandboxPhase.idle;
  double setupProgress = 0.0;
  String? error;
  String? _alpineRoot;
  String? _sharedPath;
  String? _prootPath;
  String? _loaderPath;
  String? _nativeLibraryDir;
  String? _runtimeTmpDir;
  String? _rootfsArchivePath;
  Process? _activeProcess;
  bool _installed = false;
  bool _initialised = false;

  bool get isReady => _installed && phase == SandboxPhase.ready;
  bool get isBusy => phase == SandboxPhase.settingUp || _activeProcess != null;
  String? get sharedPath => _sharedPath;

  Future<void> initialise({bool retry = false}) async {
    if (_initialised && !retry) return;
    _initialised = true;
    try {
      final docs = await getApplicationDocumentsDirectory();
      _alpineRoot = '${docs.path}/linux/alpine';
      _sharedPath = '${docs.path}/linux/shared';
      final nativeInfo = await _native.invokeMapMethod<String, dynamic>('prepareRuntime');
      _prootPath = nativeInfo?['proot']?.toString();
      _loaderPath = nativeInfo?['loader']?.toString();
      _nativeLibraryDir = nativeInfo?['libraryDir']?.toString();
      _runtimeTmpDir = nativeInfo?['tmpDir']?.toString();
      _rootfsArchivePath = nativeInfo?['rootfs']?.toString();
      if (_prootPath == null || _prootPath!.isEmpty ||
          _loaderPath == null || _loaderPath!.isEmpty ||
          _nativeLibraryDir == null || _nativeLibraryDir!.isEmpty ||
          _runtimeTmpDir == null || _runtimeTmpDir!.isEmpty ||
          _rootfsArchivePath == null || _rootfsArchivePath!.isEmpty) {
        throw StateError('The APK runtime manifest is incomplete.');
      }
      final marker = File('${_alpineRoot!}/.powerx-installed');
      _installed = await marker.exists() &&
          (await marker.readAsString()).trim() == '$_alpineVersion+$_runtimeRevision';
      phase = _installed ? SandboxPhase.ready : SandboxPhase.idle;
      error = null;
    } catch (e) {
      _installed = false;
      phase = SandboxPhase.error;
      error = 'Linux runtime unavailable: $e';
    }
    notifyListeners();
  }

  Future<String> setup() async {
    await initialise(retry: phase == SandboxPhase.error);
    if (_prootPath == null || _loaderPath == null || _runtimeTmpDir == null ||
        _nativeLibraryDir == null || _rootfsArchivePath == null) {
      throw StateError(error ?? 'This APK does not include the complete Linux runtime.');
    }
    if (_installed) {
      final probe = await run('apk --version && uname -m', timeoutSeconds: 30);
      if (probe.exitCode == 0) return 'Alpine Linux is installed and verified.';
      await File('${_alpineRoot!}/.powerx-installed').delete().catchError((_) => File(''));
      _installed = false;
    }
    phase = SandboxPhase.settingUp;
    setupProgress = 0.02;
    error = null;
    notifyListeners();

    final root = Directory(_alpineRoot!);
    final shared = Directory(_sharedPath!);
    try {
      final hostProbe = await Process.run(
        _prootPath!,
        const ['--version'],
        environment: {
          'PROOT_LOADER': _loaderPath!,
          'PROOT_TMP_DIR': _runtimeTmpDir!,
          'LD_LIBRARY_PATH': _nativeLibraryDir!,
        },
      );
      if (hostProbe.exitCode != 0) {
        throw StateError('Bundled PRoot self-test failed: ${hostProbe.stderr}');
      }
      if (await root.exists()) await root.delete(recursive: true);
      await root.create(recursive: true);
      await shared.create(recursive: true);
      final arch = await _androidArch();
      final archiveFile = File(_rootfsArchivePath!);
      if (!await archiveFile.exists() || await archiveFile.length() < 1024) {
        throw StateError('The bundled Alpine filesystem is missing or invalid.');
      }
      setupProgress = 0.12;
      notifyListeners();
      await _extractRootfs(archiveFile, root);
      setupProgress = 0.82;
      notifyListeners();

      // PRoot needs writable guest directories plus resolv.conf before the
      // first process starts. Its executable loader and host-side temporary
      // directory are supplied separately by the Android runtime bridge.
      for (final d in ['proc', 'sys', 'dev', 'tmp', 'root']) {
        await Directory('${root.path}/$d').create(recursive: true);
      }
      await File('${root.path}/etc/resolv.conf')
          .writeAsString('nameserver 1.1.1.1\nnameserver 8.8.8.8\n', flush: true);
      // Permit a complete guest command and shared-file round trip before
      // committing the marker. A failed first boot is repaired on retry.
      _installed = true;
      final probe = await run(
        "set -eu; test -x /bin/sh; apk --version; uname -m; "
        "printf 'powerx-runtime-ok\\n' > /shared/.powerx-runtime-test; "
        "grep -qx powerx-runtime-ok /shared/.powerx-runtime-test; "
        "rm -f /shared/.powerx-runtime-test",
        timeoutSeconds: 30,
      );
      if (probe.exitCode != 0) {
        throw StateError('Alpine verification failed: ${probe.output}');
      }
      await File('${root.path}/.powerx-installed')
          .writeAsString('$_alpineVersion+$_runtimeRevision\n', flush: true);
      phase = SandboxPhase.ready;
      setupProgress = 1.0;
      notifyListeners();
      return 'Alpine Linux $_alpineVersion installed and verified ($arch).';
    } catch (e) {
      _installed = false;
      await File('${root.path}/.powerx-installed').delete().catchError((_) => File(''));
      phase = SandboxPhase.error;
      error = e.toString();
      notifyListeners();
      rethrow;
    }
  }

  Future<void> _extractRootfs(File source, Directory root) async {
    final bytes = await source.readAsBytes();
    final archive = TarDecoder().decodeBytes(GZipDecoder().decodeBytes(bytes), verify: true);
    var done = 0;
    for (final entry in archive) {
      final clean = entry.name.replaceAll('\\', '/').replaceFirst(RegExp(r'^\./'), '');
      if (clean.isEmpty || clean.startsWith('/') || clean.split('/').contains('..')) continue;
      final path = '${root.path}/$clean';
      if (entry.isFile) {
        final file = File(path);
        await file.parent.create(recursive: true);
        final content = entry.readBytes();
        if (content == null) continue;
        await file.writeAsBytes(content, flush: false);
        // Android's app-private filesystem does not preserve tar modes. Apply
        // the complete permission mask (not only an executable approximation)
        // so BusyBox, apk, certificates, and package metadata match Alpine.
        final mode = entry.mode & 0x1ff;
        if (mode != 0) {
          final chmod = await Process.run('chmod', [mode.toRadixString(8), path]);
          if (chmod.exitCode != 0) {
            throw FileSystemException('Could not apply Alpine file mode', path);
          }
        }
      } else if (entry.isDirectory) {
        await Directory(path).create(recursive: true);
      } else if (entry.isSymbolicLink) {
        final link = Link(path);
        await link.parent.create(recursive: true);
        final target = entry.symbolicLink;
        if (target != null && target.isNotEmpty) {
          try {
            await link.create(target, recursive: false);
          } on FileSystemException {
            // A retry may leave an entry behind. Replace it deterministically;
            // never silently continue with a missing /bin/sh or /usr/bin/env.
            await File(path).delete().catchError((_) => File(path));
            await link.delete().catchError((_) => link);
            await link.create(target, recursive: false);
          }
        }
      }
      done++;
      if (done % 200 == 0) {
        setupProgress = 0.12 + (done / archive.length).clamp(0.0, 1.0) * 0.68;
        notifyListeners();
        await Future<void>.delayed(Duration.zero);
      }
    }
  }

  Future<SandboxCommandResult> run(String command, {int timeoutSeconds = 300}) async {
    await initialise();
    if (!_installed) {
      return const SandboxCommandResult(exitCode: 127, stdout: '', stderr: 'Alpine Linux is not set up.');
    }
    if (_prootPath == null || _loaderPath == null || _nativeLibraryDir == null ||
        _runtimeTmpDir == null) {
      return const SandboxCommandResult(
          exitCode: 126,
          stdout: '',
          stderr: 'Linux runtime is unavailable. Tap Setup to repair it.');
    }
    if (_activeProcess != null) {
      return const SandboxCommandResult(exitCode: 125, stdout: '', stderr: 'Another Linux command is already running.');
    }
    final args = [
      '--kill-on-exit', '--link2symlink', '-L', '-0', '-r', _alpineRoot!,
      '-b', '/dev', '-b', '/proc', '-b', '/sys',
      '-b', '${_sharedPath!}:/shared', '-w', '/shared',
      '/bin/sh', '-lc', command,
    ];
    final env = <String, String>{
      // Both files below live in nativeLibraryDir, which Android extracts with
      // execute permission. Copying the loader into filesDir is rejected by
      // modern Android execute-from-writable-storage policy on many devices.
      'PROOT_LOADER': _loaderPath!,
      'PROOT_TMP_DIR': _runtimeTmpDir!,
      'PROOT_NO_SECCOMP': '1',
      'LD_LIBRARY_PATH': _nativeLibraryDir!,
      'HOME': '/root',
      'USER': 'root',
      'LOGNAME': 'root',
      'SHELL': '/bin/sh',
      'TERM': 'xterm-256color',
      'LANG': 'C.UTF-8',
      'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    };
    Process? process;
    var timedOut = false;
    var cancelled = false;
    try {
      process = await Process.start(_prootPath!, args, environment: env);
      _activeProcess = process;
      notifyListeners();
      final outFuture = process.stdout.transform(utf8.decoder).join();
      final errFuture = process.stderr.transform(utf8.decoder).join();
      int code;
      try {
        code = await process.exitCode.timeout(Duration(seconds: timeoutSeconds));
      } on TimeoutException {
        timedOut = true;
        process.kill(ProcessSignal.sigkill);
        code = await process.exitCode.catchError((_) => 124);
      }
      final out = await outFuture;
      final err = await errFuture;
      cancelled = !timedOut && code == 137;
      return SandboxCommandResult(exitCode: code, stdout: out, stderr: err, cancelled: cancelled, timedOut: timedOut);
    } catch (e) {
      return SandboxCommandResult(exitCode: 126, stdout: '', stderr: 'Linux runtime error: $e');
    } finally {
      if (identical(_activeProcess, process)) _activeProcess = null;
      notifyListeners();
    }
  }

  Future<String> exec(String command, {int timeoutSeconds = 300}) async =>
      (await run(command, timeoutSeconds: timeoutSeconds)).output;

  Future<String> install(String packageName) async {
    final packages = packageName.trim().split(RegExp(r'\s+'))
        .where((p) => RegExp(r'^[A-Za-z0-9+_.@:-]+$').hasMatch(p)).toList();
    if (packages.isEmpty) return 'Invalid package name.';
    return exec('apk add --no-cache ${packages.join(' ')}', timeoutSeconds: 900);
  }

  Future<bool> cancelActive() async {
    final p = _activeProcess;
    if (p == null) return false;
    p.kill(ProcessSignal.sigterm);
    await Future<void>.delayed(const Duration(milliseconds: 500));
    if (_activeProcess != null) p.kill(ProcessSignal.sigkill);
    return true;
  }

  Future<String> stageFile(String sourcePath, String name) async {
    await initialise();
    final safe = name.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_');
    await Directory(_sharedPath!).create(recursive: true);
    final dest = File('${_sharedPath!}/$safe');
    await File(sourcePath).copy(dest.path);
    return '/shared/$safe';
  }

  Future<List<FileSystemEntity>> sharedFiles() async {
    await initialise();
    final dir = Directory(_sharedPath!);
    if (!await dir.exists()) return [];
    return dir.list(recursive: false, followLinks: false).where((e) => e is File).toList();
  }

  Future<String> status() async {
    await initialise();
    if (!_installed) return 'Alpine Linux is not installed.';
    final result = await run("printf 'Version: '; cat /etc/alpine-release; printf 'Packages: '; apk list --installed 2>/dev/null | wc -l", timeoutSeconds: 30);
    return result.exitCode == 0 ? 'Alpine Linux ready\n${result.output}' : 'Status check failed: ${result.output}';
  }

  Future<String> _androidArch() async {
    final abi = (await _native.invokeMethod<String>('primaryAbi') ?? 'arm64-v8a').toLowerCase();
    if (abi.contains('arm64')) return 'aarch64';
    throw UnsupportedError('The bundled Linux runtime currently requires a 64-bit ARM Android device ($abi detected).');
  }
}
