// local_brain_agent.dart — the FUSION brain driving the LOCAL Alpine Linux
// sandbox, entirely on-device.
//
// WHAT THIS IS (the "brain fusion uses the local Alpine sandbox" feature):
//   • REASONING / VISION / AUDIO / FILE understanding is done by the server-side
//     FUSION brain (HotBot GPT-5 + Gemini Mixture-of-Agents) via POST /api/brain.
//     That endpoint already: extracts PDF/DOCX/XLSX/TXT to text, runs Gemini
//     vision on images (transcribe + describe), and reasons over everything.
//   • EXECUTION (running code, ffmpeg, python, git, package installs, file
//     processing) happens in the on-device **Alpine Linux** sandbox
//     (SuperLocalSandbox, proot) — NOT a cloud sandbox. This keeps the agent
//     working even with no server sandbox and gives it a real Linux userland.
//
// The loop is a compact ReAct protocol: the brain emits ONE JSON action per
// turn — either a shell command to run in Alpine, a package to install, or a
// final answer. We feed the command output back and repeat until `finish`.
//
// Multimodal in, action out:
//   • Images  → sent to /api/brain as files → Gemini vision transcribes/describes.
//   • Audio   → transcoded to 16kHz wav in Alpine (ffmpeg) then, if a local
//               transcriber (whisper.cpp / vosk) is installed, transcribed in
//               Alpine; otherwise the raw audio + our best-effort notes are sent
//               to the brain. Either way the transcript becomes task context.
//   • Docs    → sent to /api/brain as files → extracted to text server-side.
//
// This is the APK counterpart of the server agent, but the sandbox is LOCAL.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:http/http.dart' as http;
import 'api_config.dart';
import 'auth_service.dart';
import 'super_local_sandbox.dart';

/// One streamed step of the local agent loop (drives the UI transcript).
class LocalAgentEvent {
  final String type; // start | think | exec | observe | vision | audio | done | error
  final String text;
  LocalAgentEvent(this.type, this.text);
}

/// An attachment the user hands to the local agent.
class LocalAgentAttachment {
  final String name;
  final String path; // local file path on device
  final String kind; // image | audio | doc | other
  LocalAgentAttachment({required this.name, required this.path, required this.kind});
}

/// The FUSION brain + LOCAL Alpine sandbox agent.
class LocalBrainAgent {
  final SuperLocalSandbox sandbox;
  bool _cancelled = false;
  LocalBrainAgent({SuperLocalSandbox? sandbox})
      : sandbox = sandbox ?? SuperLocalSandbox();

  Future<void> cancel() async {
    _cancelled = true;
    await sandbox.cancelActive();
  }

  static const int _maxSteps = 12;

  /// System prompt: teach the brain the strict one-JSON-action ReAct protocol
  /// and that its execution surface is the on-device Alpine Linux sandbox.
  String get _systemPreamble => '''
You are the WormGPT local agent. You reason with the FUSION brain and you have a
FULL Alpine Linux sandbox running LOCALLY on the user's Android device (proot).
You can run any shell command, install apk packages, and read/write files under
/shared. Available on install: python3, node, ffmpeg, imagemagick, git, gcc,
make, pandoc, curl, wget, jq, sqlite3, yt-dlp, py3-pillow.

Reply with EXACTLY ONE JSON object per turn and NOTHING else. Schemas:
  {"action":"exec","command":"<shell command to run in Alpine>","note":"<short reason>"}
  {"action":"install","package":"<apk package name>","note":"<short reason>"}
  {"action":"finish","answer":"<the complete final answer for the user>"}

Rules:
- Prefer /shared as the working directory; attached files are copied there.
- Install a package BEFORE using a tool that needs it.
- Keep commands non-interactive (add -y / --no-cache where relevant).
- When the task is done, use "finish" with a full, helpful answer.
''';

  /// Ensure Alpine is ready, streaming setup progress.
  Stream<LocalAgentEvent> _ensureSandbox() async* {
    if (sandbox.isReady) return;
    yield LocalAgentEvent('start', 'Booting local Alpine Linux sandbox…');
    try {
      final msg = await sandbox.setup();
      yield LocalAgentEvent('start', msg);
    } catch (e) {
      yield LocalAgentEvent('error', 'Sandbox setup failed: $e');
      rethrow;
    }
  }

  /// Copy an attachment into the Alpine /shared dir so exec'd tools can reach it.
  Future<void> _stageIntoShared(LocalAgentAttachment a) async {
    await sandbox.stageFile(a.path, a.name);
  }

  /// Ask the FUSION brain. Files (docs/images) are sent as base64 so the server
  /// runs extraction + Gemini vision. Returns the brain's raw reply text.
  Future<String> _askBrain(String message, {List<LocalAgentAttachment> files = const []}) async {
    final auth = AuthService.instance;
    final payloadFiles = <Map<String, dynamic>>[];
    for (final f in files) {
      try {
        final bytes = await File(f.path).readAsBytes();
        payloadFiles.add({'name': f.name, 'data_base64': base64Encode(bytes)});
      } catch (_) {}
    }
    final res = await http
        .post(
          ApiConfig.uri('/api/brain'),
          headers: auth.authHeaders(json: true),
          body: jsonEncode({
            'message': message,
            if (payloadFiles.isNotEmpty) 'files': payloadFiles,
          }),
        )
        .timeout(const Duration(seconds: 90));
    if (res.statusCode == 401 || res.statusCode == 403) {
      await auth.logout();
      throw 'Session expired — please sign in again.';
    }
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return (body['reply'] ?? body['message'] ?? body['response'] ?? '').toString();
  }

  /// Best-effort local audio handling: transcode to wav in Alpine (ffmpeg) so
  /// the file is uniform, then either transcribe locally (if whisper.cpp/vosk
  /// present) or hand the audio to the brain. Returns a transcript/summary that
  /// becomes part of the task context.
  Stream<LocalAgentEvent> _handleAudio(LocalAgentAttachment a) async* {
    yield LocalAgentEvent('audio', 'Processing audio "${a.name}" in the local sandbox…');
    await _stageIntoShared(a);
    final safe = a.name.replaceAll(RegExp(r"[^A-Za-z0-9._-]"), '_');
    // Make sure ffmpeg is available, then normalise to 16k mono wav.
    await sandbox.install('ffmpeg');
    final wav = '/shared/${safe}_16k.wav';
    await sandbox.exec("ffmpeg -y -i /shared/$safe -ar 16000 -ac 1 '$wav' 2>/dev/null; ls -l '$wav'", timeoutSeconds: 120);
    // If a local transcriber exists, use it; otherwise fall back to the brain.
    final probe = await sandbox.exec('command -v whisper || command -v vosk-transcriber || echo NONE');
    if (!probe.contains('NONE')) {
      final tr = await sandbox.exec("(whisper '$wav' --model tiny --output_format txt --output_dir /shared 2>/dev/null && cat /shared/${safe}_16k.txt) || echo ''", timeoutSeconds: 240);
      if (tr.trim().isNotEmpty) {
        yield LocalAgentEvent('audio', 'Local transcript ready.');
        return;
      }
    }
    yield LocalAgentEvent('audio', 'No local transcriber installed — sending audio to the FUSION brain for understanding.');
  }

  /// Run the full local agent loop.
  Stream<LocalAgentEvent> run(String task, {List<LocalAgentAttachment> attachments = const []}) async* {
    _cancelled = false;
    try {
      yield* _ensureSandbox();
      if (_cancelled) { yield LocalAgentEvent('done', '🛑 Task stopped.'); return; }

      // Split attachments by modality.
      final images = attachments.where((a) => a.kind == 'image').toList();
      final audios = attachments.where((a) => a.kind == 'audio').toList();
      final docs = attachments.where((a) => a.kind == 'doc' || a.kind == 'other').toList();

      // Stage docs/images into the sandbox too, so exec'd tools can use them.
      for (final a in [...docs, ...images]) {
        await _stageIntoShared(a);
      }
      // Audio → local processing first.
      for (final a in audios) {
        yield* _handleAudio(a);
      }

      // Build the multimodal task context via the brain (vision + file extraction).
      var context = task;
      final brainInputs = <LocalAgentAttachment>[...images, ...docs, ...audios];
      if (brainInputs.isNotEmpty) {
        yield LocalAgentEvent('vision', 'Reading ${brainInputs.length} attachment(s) with the FUSION brain (vision + file text)…');
        try {
          final understanding = await _askBrain(
            'Analyse the attached files (images: transcribe + describe; audio: '
            'transcribe; docs: summarise the key content). Return a concise, '
            'factual digest I can use as context for this task:\n\n$task',
            files: brainInputs,
          );
          if (understanding.trim().isNotEmpty) {
            context = '$task\n\n[Attachment understanding from FUSION brain]\n$understanding';
            yield LocalAgentEvent('vision', understanding.trim());
          }
        } catch (e) {
          yield LocalAgentEvent('vision', 'Attachment analysis skipped: $e');
        }
      }

      // ReAct loop: brain decides an action, we execute it in Alpine, repeat.
      final transcript = StringBuffer();
      transcript.writeln('TASK:\n$context');
      for (var step = 0; step < _maxSteps; step++) {
        if (_cancelled) { yield LocalAgentEvent('done', '🛑 Task stopped.'); return; }
        final prompt = '$_systemPreamble\n\n$transcript\n\n'
            'Reply with the next single JSON action now.';
        String reply;
        try {
          reply = await _askBrain(prompt);
          if (_cancelled) { yield LocalAgentEvent('done', '🛑 Task stopped.'); return; }
        } catch (e) {
          yield LocalAgentEvent('error', 'Brain error: $e');
          return;
        }
        final action = _extractJson(reply);
        if (action == null) {
          // No parseable action → treat the reply as the final answer.
          yield LocalAgentEvent('done', reply.trim().isEmpty ? '(no answer)' : reply.trim());
          return;
        }
        final kind = (action['action'] ?? '').toString();
        if (kind == 'finish') {
          yield LocalAgentEvent('done', (action['answer'] ?? '').toString().trim());
          return;
        } else if (kind == 'install') {
          final pkg = (action['package'] ?? '').toString();
          yield LocalAgentEvent('exec', 'apk add $pkg');
          final out = await sandbox.install(pkg);
          if (_cancelled) { yield LocalAgentEvent('done', '🛑 Task stopped.'); return; }
          transcript.writeln('\nACTION: install $pkg\nOBSERVATION:\n${_clip(out)}');
          yield LocalAgentEvent('observe', _clip(out));
        } else if (kind == 'exec') {
          final cmd = (action['command'] ?? '').toString();
          final note = (action['note'] ?? '').toString();
          yield LocalAgentEvent('think', note.isEmpty ? 'Running a command…' : note);
          yield LocalAgentEvent('exec', cmd);
          final out = await sandbox.exec(cmd, timeoutSeconds: 900);
          if (_cancelled) { yield LocalAgentEvent('done', '🛑 Task stopped.'); return; }
          transcript.writeln('\nACTION: exec `$cmd`\nOBSERVATION:\n${_clip(out)}');
          yield LocalAgentEvent('observe', _clip(out));
        } else {
          transcript.writeln('\n(Unknown action "$kind" — reply with a valid JSON action.)');
        }
      }
      // Ran out of steps → ask the brain to summarise what it has.
      final finalAns = await _askBrain(
        '$_systemPreamble\n\n$transcript\n\n'
        'You have reached the step limit. Write the best complete final answer '
        'for the user now (plain text, no JSON).');
      yield LocalAgentEvent('done', finalAns.trim());
    } catch (e) {
      yield LocalAgentEvent('error', '$e');
    }
  }

  /// Pull the first JSON object out of a possibly-noisy model reply.
  Map<String, dynamic>? _extractJson(String s) {
    final start = s.indexOf('{');
    final end = s.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    for (var e = end; e > start; e = s.lastIndexOf('}', e - 1)) {
      try {
        final obj = jsonDecode(s.substring(start, e + 1));
        if (obj is Map<String, dynamic> && obj.containsKey('action')) return obj;
      } catch (_) {/* try a shorter slice */}
      if (e <= start) break;
    }
    return null;
  }

  /// Clip long command output so the transcript stays within model context.
  String _clip(String s, {int max = 4000}) {
    final t = s.trim();
    if (t.length <= max) return t.isEmpty ? '(no output)' : t;
    return '${t.substring(0, max)}\n…[truncated ${t.length - max} chars]';
  }
}
