import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:open_filex/open_filex.dart';
import 'package:share_plus/share_plus.dart';
import 'package:image_picker/image_picker.dart';
import 'package:file_picker/file_picker.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../api/agent_service.dart';
import '../api/api_config.dart';
import '../api/chat_history_service.dart';
import '../api/chat_service.dart';
import '../widgets/math_markdown.dart';
import 'ultra_screen.dart';
import '../theme.dart';

/// Reusable agent chat screen (used by WormGPT Agent and Lemon Agent).
/// Streams /api/agent/run (or /api/lemon/run) SSE — the SAME persistent
/// sandbox the website + Telegram bot use.
///
/// The screen exposes a "Capy Heavy" toggle:
///   • ON  → heavy autonomous task via Capy's cloud sandbox (files, long-runs).
///   • OFF → fast, uncensored answer from the hotbot/Gemini/racers fusion brain.
class AgentScreen extends StatefulWidget {
  final String title;
  final String endpoint;
  final String emoji;
  final String tagline;
  const AgentScreen({
    super.key,
    required this.title,
    required this.endpoint,
    required this.emoji,
    required this.tagline,
  });

  @override
  State<AgentScreen> createState() => _AgentScreenState();
}

class _Msg {
  final bool isUser;
  String text;
  final List<String> steps;
  List<AgentFile> files;
  final List<String> attachmentNames; // user-uploaded attachment names
  bool running;
  bool error;
  String? clientMsgId; // client id for matching the persisted row on update
  String? jobId;       // durable backend job id (for reconnect after reopen)
  bool finalized = false; // true once a terminal result (done/error) has been applied
  _Msg({
    required this.isUser,
    this.text = '',
    List<String>? steps,
    this.files = const [],
    List<String>? attachmentNames,
    this.running = false,
    this.error = false,
    this.clientMsgId,
    this.jobId,
  })  : steps = steps ?? [],
        attachmentNames = attachmentNames ?? [];
}

/// A pending attachment the user picked before sending.
class _Attachment {
  final String path;
  final String name;
  final bool isImage;
  _Attachment({required this.path, required this.name, required this.isImage});
}

class _AgentScreenState extends State<AgentScreen>
    with AutomaticKeepAliveClientMixin, WidgetsBindingObserver {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  // Shows the "jump to latest" button only when the user has scrolled up away
  // from the bottom of the conversation. Updated from the scroll listener.
  final ValueNotifier<bool> _showJumpToBottom = ValueNotifier<bool>(false);
  final List<_Msg> _msgs = [];
  final List<_Attachment> _attachments = [];
  final _picker = ImagePicker();
  StreamSubscription? _sub;
  bool _busy = false;
  bool _loadingHistory = true;
  // 🪙 Live WormGPT credit balance (from SSE start/step/done). null = unknown,
  // 'unlimited' for Pro/Admin.
  String? _credits;

  // 🦫 Capy Heavy toggle. ON = heavy Capy sandbox task; OFF = fast uncensored
  // hotbot/Gemini/racers fusion chat. Persisted so the choice survives restarts.
  bool _heavyMode = false;
  static const String _kHeavyPrefKey = 'agent_heavy_mode';

  // Active completion-pollers (one per in-flight send). Cancelled on dispose so
  // we never call setState after the screen is gone.
  final Set<String> _activePolls = {};
  bool _disposed = false;

  // Server-side persistence scope (auto-wipes after 2 days). Derived from the
  // endpoint so WormGPT Agent and Lemon Agent keep separate histories.
  String get _scope => widget.endpoint == ApiConfig.lemonRun ? 'lemon' : 'agent';

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _scroll.addListener(_onScroll);
    _loadHeavyPref();
    _loadHistory();
    _loadCredits();
  }

  Future<void> _loadHeavyPref() async {
    try {
      final p = await SharedPreferences.getInstance();
      final v = p.getBool(_kHeavyPrefKey) ?? false;
      if (mounted) setState(() => _heavyMode = v);
    } catch (_) {}
  }

  Future<void> _setHeavyMode(bool v) async {
    setState(() => _heavyMode = v);
    try {
      final p = await SharedPreferences.getInstance();
      await p.setBool(_kHeavyPrefKey, v);
    } catch (_) {}
  }

  // Track whether the user is near the bottom; toggle the jump-to-latest FAB.
  void _onScroll() {
    if (!_scroll.hasClients) return;
    final pos = _scroll.position;
    final atBottom = pos.pixels >= (pos.maxScrollExtent - 120);
    final shouldShow = !atBottom && pos.maxScrollExtent > 0;
    if (_showJumpToBottom.value != shouldShow) {
      _showJumpToBottom.value = shouldShow;
    }
  }

  // When the app returns to the foreground, re-attach to any task that was still
  // running. The work itself never stopped — it runs server-side in the durable
  // sandbox — but the in-app pollers/SSE were torn down while backgrounded.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _reattachRunningJobsOnResume();
      _loadCredits();
    }
  }

  void _reattachRunningJobsOnResume() {
    if (_disposed) return;
    final running = _msgs.where((m) => !m.isUser && m.running).toList();
    if (mounted && _busy != running.isNotEmpty) {
      setState(() => _busy = running.isNotEmpty);
    }
    for (final m in running) {
      final guardKey = m.clientMsgId ?? 'job:${m.jobId}';
      if (m.jobId != null &&
          m.jobId!.isNotEmpty &&
          !_activePolls.contains(guardKey)) {
        _resumeJob(m);
      }
    }
  }

  // 🪙 Fetch the current WormGPT credit balance so the AppBar badge shows it
  // immediately (also refreshed live via SSE start/step/done). Best-effort.
  Future<void> _loadCredits() async {
    if (widget.endpoint != ApiConfig.agentRun) return;
    try {
      final s = await ChatService.status();
      final c = s['credits'];
      if (mounted && c != null) setState(() => _credits = c.toString());
    } catch (_) {}
  }

  @override
  void dispose() {
    _disposed = true;
    WidgetsBinding.instance.removeObserver(this);
    _scroll.removeListener(_onScroll);
    _activePolls.clear();
    _sub?.cancel();
    _input.dispose();
    _scroll.dispose();
    _showJumpToBottom.dispose();
    super.dispose();
  }

  // Restore the saved conversation so a task's result (and the whole thread)
  // survives the app being closed/reopened.
  Future<void> _loadHistory() async {
    setState(() => _loadingHistory = true);
    final rows = await ChatHistoryService.load(_scope);
    if (!mounted) return;
    final List<_Msg> pendingResume = [];
    setState(() {
      _msgs.clear();
      for (final r in rows) {
        final isUser = (r['role'] ?? '') == 'user';
        final steps = ((r['steps'] as List?) ?? const [])
            .map((e) => e.toString())
            .toList();
        final attachments = ((r['attachments'] as List?) ?? const [])
            .map((e) => e.toString())
            .toList();
        final files = ((r['files'] as List?) ?? const [])
            .whereType<Map>()
            .map((m) => AgentFile.fromJson(m))
            .toList();
        final wasRunning = r['running'] == true;
        final jobId = (r['job_id'] ?? r['jobId'])?.toString();
        final clientMsgId = r['client_msg_id']?.toString();
        var text = (r['content'] ?? '').toString();

        final msg = _Msg(
          isUser: isUser,
          text: text,
          steps: steps,
          files: files,
          attachmentNames: attachments,
          error: r['is_error'] == true,
          running: false,
          clientMsgId: clientMsgId,
          jobId: jobId,
        );

        if (!isUser && wasRunning) {
          if (jobId != null && jobId.isNotEmpty) {
            msg.running = true;
            msg.text = '';
            pendingResume.add(msg);
          } else if (text.isEmpty) {
            msg.text =
                '⏳ This task was still running when you last closed the app. If it finished, reopen or re-run to see the result.';
          }
        }
        _msgs.add(msg);
      }
      _loadingHistory = false;
      _busy = pendingResume.isNotEmpty;
    });
    _scrollDown();

    for (final m in pendingResume) {
      _resumeJob(m);
    }
  }

  // Poll a durable backend job until it finishes, updating the bubble live.
  Future<void> _resumeJob(_Msg msg) async {
    final jobId = msg.jobId;
    if (jobId == null || jobId.isEmpty) return;
    final guardKey = msg.clientMsgId ?? 'job:$jobId';
    if (_activePolls.contains(guardKey)) return;
    _activePolls.add(guardKey);
    try {
      Duration budget;
      try {
        budget = await AgentService.resumePollBudget();
      } catch (_) {
        budget = const Duration(hours: 1);
      }
      final maxPolls = (budget.inSeconds / 3).ceil().clamp(60, 7200);
      var consecutiveMisses = 0;
      for (var i = 0; i < maxPolls; i++) {
        if (!mounted || _disposed) return;
        final job = await AgentService.getJob(jobId);
        if (job == null) {
          consecutiveMisses++;
          // A reopened app commonly encounters a short auth/network gap. Keep
          // the task controllable instead of converting it to a dead bubble on
          // the first failed poll.
          if (consecutiveMisses < 10) {
            await Future.delayed(const Duration(seconds: 3));
            continue;
          }
          if (mounted) {
            setState(() {
              msg.running = false;
              if (msg.text.isEmpty) msg.text = '⚠️ Could not restore this task.';
              _busy = _msgs.any((m) => !m.isUser && m.running && !m.finalized);
            });
          }
          return;
        }
        consecutiveMisses = 0;
        final status = (job['status'] ?? '').toString();
        final steps = ((job['steps'] as List?) ?? const [])
            .map((e) => e.toString())
            .toList();
        if (status == 'running' || status == 'queued') {
          if (mounted && steps.length != msg.steps.length) {
            setState(() { msg.steps
              ..clear()
              ..addAll(steps); });
            _scrollDown();
          }
          await Future.delayed(const Duration(seconds: 3));
          continue;
        }
        final files = await AgentService.saveFiles((job['files'] as List?) ?? const []);
        final msgText = (job['message'] ?? (status == 'error' ? 'Agent failed.' : '✅ Done.')).toString();
        if (mounted) {
          setState(() {
            msg.steps
              ..clear()
              ..addAll(steps);
            msg.text = msgText;
            msg.files = files;
            msg.error = job['is_error'] == true || status == 'error';
            msg.running = false;
            msg.finalized = true;
            _busy = _msgs.any((m) => !m.isUser && m.running && !m.finalized);
          });
          _scrollDown();
        }
        ChatHistoryService.update(
          clientMsgId: msg.clientMsgId,
          scope: _scope,
          content: msgText,
          steps: steps,
          files: files.map((f) => f.toJson()).toList(),
          isError: job['is_error'] == true || status == 'error',
          running: false,
        );
        return;
      }
      if (mounted) {
        setState(() {
          // The polling budget ending does not mean the server task ended.
          // Keep the durable task active and stoppable after any later reopen.
          msg.running = true;
          if (msg.text.isEmpty) {
            msg.text =
                '⏳ Still working in the sandbox. You can close the app and return later.';
          }
          _busy = true;
        });
      }
    } finally {
      _activePolls.remove(guardKey);
    }
  }

  Future<void> _stopRunningTask() async {
    _Msg? running;
    for (final candidate in _msgs.reversed) {
      if (!candidate.isUser && candidate.running) {
        running = candidate;
        break;
      }
    }
    if (running == null || running.finalized) return;
    final runningMsg = running;
    final clientId = runningMsg.clientMsgId;
    String? jobId = runningMsg.jobId;
    if ((jobId == null || jobId.isEmpty) && clientId != null) {
      jobId = await AgentService.findJobByClientMsgId(_scope, clientId);
      runningMsg.jobId = jobId;
    }
    if (jobId == null || jobId.isEmpty) {
      _snack('The task is still starting. Tap stop again in a moment.');
      return;
    }
    final ok = await AgentService.stopJob(jobId);
    if (!mounted) return;
    if (!ok) {
      _snack('Could not send the stop signal. Check your connection.');
      return;
    }
    _sub?.cancel();
    if (clientId != null) _activePolls.remove(clientId);
    setState(() {
      runningMsg.finalized = true;
      runningMsg.running = false;
      runningMsg.error = false;
      runningMsg.text = '🛑 Task stopped.';
      _busy = false;
    });
    ChatHistoryService.update(
      clientMsgId: clientId,
      scope: _scope,
      content: '🛑 Task stopped.',
      running: false,
    );
  }

  // RELIABLE completion path — independent of SSE. The backend runs the task
  // detached and writes the result into a durable agent_jobs row, so we poll
  // that row to completion even when Render/Cloudflare deliver ZERO SSE bytes.
  Future<void> _pollToCompletion({
    required _Msg msg,
    required String scope,
    required String clientMsgId,
  }) async {
    _activePolls.add(clientMsgId);
    final budget = await AgentService.resumePollBudget();
    final maxPolls = (budget.inSeconds / 3).ceil().clamp(60, 7200);
    String? jobId = msg.jobId;
    try {
      for (var i = 0; i < maxPolls; i++) {
        if (_disposed || !_activePolls.contains(clientMsgId)) return;
        if (msg.finalized) return;

        if (jobId == null || jobId.isEmpty) {
          jobId = await AgentService.findJobByClientMsgId(scope, clientMsgId);
          if (jobId != null && jobId.isNotEmpty) {
            msg.jobId = jobId;
            ChatHistoryService.update(
              clientMsgId: clientMsgId, scope: scope, jobId: jobId, running: true);
          } else {
            await Future.delayed(const Duration(seconds: 3));
            continue;
          }
        }

        final job = await AgentService.getJob(jobId);
        if (job == null) {
          await Future.delayed(const Duration(seconds: 3));
          continue;
        }
        final status = (job['status'] ?? '').toString();
        final steps = ((job['steps'] as List?) ?? const [])
            .map((e) => e.toString())
            .toList();

        if (status == 'running' || status == 'queued') {
          if (!msg.finalized && mounted && steps.length > msg.steps.length) {
            setState(() { msg.steps
              ..clear()
              ..addAll(steps); });
            _scrollDown();
          }
          await Future.delayed(const Duration(seconds: 3));
          continue;
        }

        if (msg.finalized) return;
        msg.finalized = true;
        final files = await AgentService.saveFiles((job['files'] as List?) ?? const []);
        final isError = job['is_error'] == true || status == 'error';
        final msgText = (job['message'] ??
                (isError ? '⚠️ The task failed. Please try again.' : '✅ Done.'))
            .toString();
        if (mounted && !_disposed) {
          setState(() {
            msg.steps
              ..clear()
              ..addAll(steps);
            msg.text = msgText;
            msg.files = files;
            msg.error = isError;
            msg.running = false;
            _busy = false;
          });
          _scrollDown();
        }
        ChatHistoryService.update(
          clientMsgId: clientMsgId,
          scope: scope,
          content: msgText,
          steps: steps,
          files: files.map((f) => f.toJson()).toList(),
          isError: isError,
          running: false,
        );
        return;
      }
      if (!msg.finalized && mounted && !_disposed) {
        setState(() {
          msg.running = false;
          _busy = false;
          if (msg.text.isEmpty) {
            msg.text =
                '⏳ This is taking longer than expected. Your task keeps running in the sandbox — reopen the app shortly to see the result.';
          }
        });
        ChatHistoryService.update(
          clientMsgId: clientMsgId, scope: scope, running: false);
      }
    } finally {
      _activePolls.remove(clientMsgId);
    }
  }

  Future<void> _clearHistory() async {
    final scope = _scope;
    setState(() => _msgs.clear());
    await ChatHistoryService.clear(scope);
  }

  void _scrollDown() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent,
            duration: const Duration(milliseconds: 250), curve: Curves.easeOut);
        _showJumpToBottom.value = false;
      }
    });
  }

  void _scrollToBottomFast() {
    void go() {
      if (!_scroll.hasClients) return;
      _scroll.animateTo(_scroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 200), curve: Curves.easeOutCubic);
    }
    go();
    WidgetsBinding.instance.addPostFrameCallback((_) => go());
    _showJumpToBottom.value = false;
  }

  // ── Attachment pickers ─────────────────────────────────────────────────
  Future<void> _pickImage(ImageSource source) async {
    try {
      final x = await _picker.pickImage(source: source, imageQuality: 88);
      if (x == null) return;
      setState(() => _attachments.add(
          _Attachment(path: x.path, name: x.name, isImage: true)));
    } catch (e) {
      _snack('Could not pick image: $e');
    }
  }

  Future<void> _pickFiles() async {
    try {
      final res = await FilePicker.platform.pickFiles(allowMultiple: true);
      if (res == null) return;
      for (final f in res.files) {
        if (f.path == null) continue;
        final isImg = RegExp(r'\.(png|jpe?g|gif|webp|bmp|heic)$', caseSensitive: false)
            .hasMatch(f.name);
        _attachments.add(_Attachment(path: f.path!, name: f.name, isImage: isImg));
      }
      setState(() {});
    } catch (e) {
      _snack('Could not pick file: $e');
    }
  }

  void _openAttachSheet() {
    showModalBottomSheet(
      context: context,
      backgroundColor: AppTheme.surface,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (c) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(height: 8),
            Container(
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                    color: AppTheme.border,
                    borderRadius: BorderRadius.circular(4))),
            ListTile(
              leading: const Icon(Icons.photo_camera, color: AppTheme.accent),
              title: const Text('Take photo'),
              onTap: () {
                Navigator.pop(c);
                _pickImage(ImageSource.camera);
              },
            ),
            ListTile(
              leading: const Icon(Icons.photo_library, color: AppTheme.accent),
              title: const Text('Choose image'),
              onTap: () {
                Navigator.pop(c);
                _pickImage(ImageSource.gallery);
              },
            ),
            ListTile(
              leading:
                  const Icon(Icons.attach_file, color: AppTheme.accent),
              title: const Text('Attach file'),
              onTap: () {
                Navigator.pop(c);
                _pickFiles();
              },
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }

  void _snack(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(m), behavior: SnackBarBehavior.floating));
  }

  Future<void> _send() async {
    final task = _input.text.trim();
    if ((task.isEmpty && _attachments.isEmpty) || _busy) return;
    _input.clear();
    final scope = _scope;
    final pending = List<_Attachment>.from(_attachments);
    final filePaths = pending.map((a) => a.path).toList();
    final attachmentNames = pending.map((a) => a.name).toList();
    final clientMsgId =
        'a_${DateTime.now().millisecondsSinceEpoch}_${_msgs.length}';
    final reply = _Msg(isUser: false, running: true, clientMsgId: clientMsgId);
    // 🦫 Heavy = Capy sandbox agent; otherwise = fast uncensored fusion chat.
    // Lemon Agent always runs heavy (it is the file-returning Ultra agent).
    final mode = (widget.endpoint == ApiConfig.agentRun && !_heavyMode)
        ? 'fusion'
        : 'heavy';
    setState(() {
      _msgs.add(_Msg(
        isUser: true,
        text: task,
        attachmentNames: attachmentNames,
      ));
      _msgs.add(reply);
      _attachments.clear();
      _busy = true;
    });
    _scrollDown();

    // Persist the placeholder before launching the backend job. Previously
    // these writes raced the run request, so a fast job-id update could arrive
    // before its assistant row existed and leave reopen without a controllable
    // task reference.
    await ChatHistoryService.save(
        scope: scope,
        role: 'user',
        content: task,
        attachments: attachmentNames);
    await ChatHistoryService.save(
        scope: scope,
        role: 'assistant',
        content: '',
        running: true,
        clientMsgId: clientMsgId);
    if (!mounted || _disposed) return;

    _sub = AgentService.run(
      task: task,
      endpoint: widget.endpoint,
      files: filePaths,
      clientMsgId: clientMsgId,
      mode: mode,
    ).listen(
      (ev) async {
        switch (ev.type) {
          case 'start':
            setState(() {
              reply.steps.add('🚀 starting…');
              if (ev.data['credits'] != null) _credits = ev.data['credits'].toString();
            });
            break;
          case 'job':
            final jid = (ev.data['jobId'] ?? '').toString();
            if (jid.isNotEmpty) {
              reply.jobId = jid;
              ChatHistoryService.update(
                clientMsgId: clientMsgId,
                scope: scope,
                jobId: jid,
                running: true,
              );
            }
            break;
          case 'step':
            final note = (ev.data['note'] ?? '').toString();
            if (note.isNotEmpty && !reply.finalized) {
              setState(() {
                reply.steps.add(note);
                if (ev.data['credits'] != null) _credits = ev.data['credits'].toString();
              });
            }
            break;
          case 'done':
            if (reply.finalized) break;
            reply.finalized = true;
            final files = await AgentService.saveFiles(
                (ev.data['files'] as List?) ?? const []);
            final msgText = (ev.data['message'] ?? '✅ Done.').toString();
            setState(() {
              reply.text = msgText;
              reply.files = files;
              reply.running = false;
              _busy = false;
              if (ev.data['credits'] != null) _credits = ev.data['credits'].toString();
            });
            ChatHistoryService.update(
              clientMsgId: clientMsgId,
              scope: scope,
              content: msgText,
              steps: List<String>.from(reply.steps),
              files: files.map((f) => f.toJson()).toList(),
              running: false,
            );
            break;
          case 'error':
            if (reply.finalized) break;
            reply.finalized = true;
            final errText = (ev.data['error'] ?? 'Agent failed.').toString();
            setState(() {
              reply.text = errText;
              reply.error = true;
              reply.running = false;
              _busy = false;
            });
            ChatHistoryService.update(
              clientMsgId: clientMsgId,
              scope: scope,
              content: errText,
              isError: true,
              running: false,
            );
            break;
        }
        _scrollDown();
      },
      onError: (e) {
        // SSE dying is EXPECTED on Render/Cloudflare. The durable job keeps
        // running server-side and _pollToCompletion() delivers the result.
      },
      onDone: () {
        if (reply.finalized) {
          setState(() => _busy = false);
        }
        _scrollDown();
      },
    );

    // RELIABILITY: poll the durable job to completion IN PARALLEL with SSE.
    _pollToCompletion(msg: reply, scope: scope, clientMsgId: clientMsgId);
  }

  void _openUltra() {
    Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => const UltraScreen()),
    );
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final isMainAgent = widget.endpoint == ApiConfig.agentRun;
    return Scaffold(
      appBar: AppBar(
        title: Row(
          children: [
            Text(widget.emoji, style: const TextStyle(fontSize: 22)),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(widget.title,
                      style: const TextStyle(
                          fontSize: 17, fontWeight: FontWeight.w800)),
                  Text(widget.tagline,
                      style:
                          const TextStyle(fontSize: 11, color: AppTheme.muted)),
                ],
              ),
            ),
            // 🪙 Live WormGPT credit balance (agent screen only).
            if (isMainAgent && _credits != null)
              Container(
                margin: const EdgeInsets.only(right: 6),
                padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
                decoration: BoxDecoration(
                  color: const Color(0x22FFD24A),
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(color: const Color(0x55FFD24A)),
                ),
                child: Text(
                  _credits == 'unlimited' ? '🪙 ∞' : '🪙 $_credits',
                  style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w800,
                      color: Color(0xFFFFD24A)),
                ),
              ),
          ],
        ),
        actions: [
          // 🔥 ULTRA — only on the WormGPT Agent screen.
          if (isMainAgent)
            Padding(
              padding: const EdgeInsets.only(right: 2),
              child: TextButton.icon(
                style: TextButton.styleFrom(
                  foregroundColor: const Color(0xFFFF7A2B),
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(20),
                    side: const BorderSide(color: Color(0x55FF7A2B)),
                  ),
                ),
                onPressed: _openUltra,
                icon: const Text('🔥', style: TextStyle(fontSize: 14)),
                label: const Text('Ultra',
                    style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w800)),
              ),
            ),
          IconButton(
            tooltip: 'Clear',
            icon: const Icon(Icons.delete_sweep_outlined),
            onPressed: _busy ? null : _clearHistory,
          ),
        ],
      ),
      body: Column(
        children: [
          // 🦫 CAPY HEAVY TOGGLE — WormGPT Agent only. ON = heavy Capy sandbox
          // task (files, long-running). OFF = fast uncensored hotbot/Gemini/
          // racers fusion answer.
          if (isMainAgent)
            _CapyToggleBar(
              heavy: _heavyMode,
              busy: _busy,
              onChanged: _busy ? null : _setHeavyMode,
            ),
          Expanded(
            child: Stack(
              children: [
                _loadingHistory
                ? const Center(
                    child: CircularProgressIndicator(
                        strokeWidth: 2, color: AppTheme.accent))
                : _msgs.isEmpty
                ? _Empty(emoji: widget.emoji, tagline: widget.tagline)
                : ListView.builder(
                    controller: _scroll,
                    padding: const EdgeInsets.fromLTRB(12, 12, 12, 12),
                    itemCount: _msgs.length,
                    itemBuilder: (c, i) => _Bubble(msg: _msgs[i]),
                  ),
                Positioned(
                  right: 12,
                  bottom: 12,
                  child: ValueListenableBuilder<bool>(
                    valueListenable: _showJumpToBottom,
                    builder: (_, show, __) => AnimatedSlide(
                      duration: const Duration(milliseconds: 180),
                      offset: show ? Offset.zero : const Offset(0, 1.6),
                      curve: Curves.easeOut,
                      child: AnimatedOpacity(
                        duration: const Duration(milliseconds: 180),
                        opacity: show ? 1 : 0,
                        child: IgnorePointer(
                          ignoring: !show,
                          child: _JumpToBottomButton(onTap: _scrollToBottomFast),
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
          _Composer(
            controller: _input,
            busy: _busy,
            onSend: _send,
            onStop: _stopRunningTask,
            attachments: _attachments,
            onAttach: _busy ? null : _openAttachSheet,
            onRemoveAttachment: (i) => setState(() => _attachments.removeAt(i)),
          ),
        ],
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 🦫 Capy Heavy toggle bar. Sits above the chat. When ON, tasks run through the
// heavy Capy sandbox agent (files, long jobs). When OFF, the agent answers
// instantly with the uncensored hotbot/Gemini/racers fusion brain.
class _CapyToggleBar extends StatelessWidget {
  final bool heavy;
  final bool busy;
  final ValueChanged<bool>? onChanged;
  const _CapyToggleBar({
    required this.heavy,
    required this.busy,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(14, 10, 12, 10),
      decoration: BoxDecoration(
        color: AppTheme.surface,
        border: const Border(bottom: BorderSide(color: AppTheme.border)),
      ),
      child: Row(
        children: [
          Text(heavy ? '🦫' : '⚡', style: const TextStyle(fontSize: 18)),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  heavy ? 'Capy — heavy task mode' : 'Fusion — fast uncensored mode',
                  style: const TextStyle(
                      fontSize: 13.5, fontWeight: FontWeight.w800),
                ),
                Text(
                  heavy
                      ? 'Capy cloud sandbox: browses, codes & returns files (slower).'
                      : 'Uncensored hotbot/Gemini/racers fusion in the in-house sandbox.',
                  style: const TextStyle(fontSize: 11, color: AppTheme.muted),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Switch(
            value: heavy,
            onChanged: onChanged,
            activeColor: AppTheme.accent,
          ),
        ],
      ),
    );
  }
}

// ⬇️ Compact circular "jump to latest" button shown over the chat list when the
// user has scrolled up. Tapping it fast-scrolls to the newest message.
class _JumpToBottomButton extends StatelessWidget {
  final VoidCallback onTap;
  const _JumpToBottomButton({required this.onTap});
  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(24),
        child: Container(
          width: 44,
          height: 44,
          decoration: BoxDecoration(
            color: AppTheme.accent,
            shape: BoxShape.circle,
            boxShadow: const [
              BoxShadow(
                color: Color(0x55000000),
                blurRadius: 10,
                offset: Offset(0, 3),
              ),
            ],
          ),
          child: const Icon(Icons.keyboard_double_arrow_down_rounded,
              color: Colors.white, size: 26),
        ),
      ),
    );
  }
}

class _Empty extends StatelessWidget {
  final String emoji;
  final String tagline;
  const _Empty({required this.emoji, required this.tagline});
  @override
  Widget build(BuildContext context) {
    final ideas = [
      'Build me a Python script that scrapes a website',
      'Write a professional PDF report on AI security',
      'Analyze this code and find the vulnerabilities',
      'Create an Excel sheet with sample sales data',
    ];
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(emoji, style: const TextStyle(fontSize: 54)),
            const SizedBox(height: 14),
            Text(tagline,
                textAlign: TextAlign.center,
                style: const TextStyle(
                    fontSize: 15.5,
                    color: AppTheme.muted,
                    fontWeight: FontWeight.w600)),
            const SizedBox(height: 22),
            ...ideas.map((t) => Container(
                  margin: const EdgeInsets.only(bottom: 10),
                  padding:
                      const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                  decoration: BoxDecoration(
                    color: AppTheme.surfaceAlt,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: AppTheme.border),
                  ),
                  child: Row(
                    children: [
                      const Icon(Icons.bolt, color: AppTheme.accent, size: 18),
                      const SizedBox(width: 10),
                      Expanded(
                          child: Text(t,
                              style: const TextStyle(
                                  fontSize: 13.5, color: AppTheme.text))),
                    ],
                  ),
                )),
          ],
        ),
      ),
    );
  }
}

class _Bubble extends StatelessWidget {
  final _Msg msg;
  const _Bubble({required this.msg});

  @override
  Widget build(BuildContext context) {
    if (msg.isUser) {
      return Align(
        alignment: Alignment.centerRight,
        child: Container(
          margin: const EdgeInsets.only(bottom: 12, left: 48),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
          decoration: BoxDecoration(
            color: AppTheme.accent2,
            borderRadius: BorderRadius.circular(16),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (msg.text.isNotEmpty)
                Align(
                  alignment: Alignment.centerRight,
                  child: InkWell(
                    onTap: () {
                      Clipboard.setData(ClipboardData(text: msg.text));
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('Prompt copied.')),
                      );
                    },
                    child: const Padding(
                      padding: EdgeInsets.only(bottom: 5),
                      child: Icon(Icons.copy, size: 15, color: Colors.white70),
                    ),
                  ),
                ),
              if (msg.attachmentNames.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    children: msg.attachmentNames
                        .map((n) => Container(
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 8, vertical: 4),
                              decoration: BoxDecoration(
                                color: Colors.white.withOpacity(0.18),
                                borderRadius: BorderRadius.circular(8),
                              ),
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  const Icon(Icons.attachment,
                                      size: 13, color: Colors.white),
                                  const SizedBox(width: 4),
                                  ConstrainedBox(
                                    constraints:
                                        const BoxConstraints(maxWidth: 140),
                                    child: Text(n,
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: const TextStyle(
                                            color: Colors.white,
                                            fontSize: 11.5)),
                                  ),
                                ],
                              ),
                            ))
                        .toList(),
                  ),
                ),
              if (msg.text.isNotEmpty)
                Text(msg.text,
                    style:
                        const TextStyle(color: Colors.white, fontSize: 14.5)),
            ],
          ),
        ),
      );
    }
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: 12, right: 32),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: AppTheme.surface,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: AppTheme.border),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Live sandbox steps
            if (msg.steps.isNotEmpty)
              Container(
                width: double.infinity,
                margin: const EdgeInsets.only(bottom: 10),
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: AppTheme.bg,
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: msg.steps
                      .map((s) => Padding(
                            padding: const EdgeInsets.symmetric(vertical: 1.5),
                            child: Text(s,
                                style: const TextStyle(
                                    fontSize: 12,
                                    color: AppTheme.muted,
                                    height: 1.35)),
                          ))
                      .toList(),
                ),
              ),
            if (msg.running)
              Row(
                children: const [
                  SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(
                          strokeWidth: 2, color: AppTheme.accent)),
                  SizedBox(width: 10),
                  Text('Working…',
                      style: TextStyle(color: AppTheme.accent, fontSize: 13)),
                ],
              ),
            if (msg.text.isNotEmpty) ...[
              Align(
                alignment: Alignment.centerRight,
                child: InkWell(
                  onTap: () {
                    Clipboard.setData(ClipboardData(text: msg.text));
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('Response copied.')),
                    );
                  },
                  child: const Padding(
                    padding: EdgeInsets.only(bottom: 5),
                    child: Icon(Icons.copy, size: 16, color: AppTheme.muted),
                  ),
                ),
              ),
              MathMarkdown(
                data: msg.text,
                selectable: true,
                mathColor: msg.error ? AppTheme.danger : AppTheme.text,
                styleSheet: MarkdownStyleSheet(
                  p: TextStyle(
                      color: msg.error ? AppTheme.danger : AppTheme.text,
                      fontSize: 14.5,
                      height: 1.45),
                  code: const TextStyle(
                      backgroundColor: AppTheme.bg,
                      fontFamily: 'monospace',
                      fontSize: 13),
                  codeblockDecoration: BoxDecoration(
                    color: AppTheme.bg,
                    borderRadius: BorderRadius.circular(8),
                  ),
                ),
              ),
            ],
            if (msg.files.isNotEmpty) ...[
              const SizedBox(height: 8),
              ...msg.files.map((f) => _FileChip(file: f)),
            ],
          ],
        ),
      ),
    );
  }
}

class _FileChip extends StatefulWidget {
  final AgentFile file;
  const _FileChip({required this.file});

  @override
  State<_FileChip> createState() => _FileChipState();
}

class _FileChipState extends State<_FileChip> {
  bool _downloading = false;
  String? _resolvedPath;

  String _human(int b) {
    if (b < 1024) return '$b B';
    if (b < 1024 * 1024) return '${(b / 1024).toStringAsFixed(1)} KB';
    return '${(b / 1024 / 1024).toStringAsFixed(1)} MB';
  }

  Future<String?> _resolve() async {
    final f = widget.file;
    final existing = _resolvedPath ?? f.localPath;
    if (existing != null && await File(existing).exists()) return existing;
    if (f.url == null || f.url!.isEmpty) return null;
    setState(() => _downloading = true);
    final path = await AgentService.downloadToDevice(f);
    if (!mounted) return path;
    setState(() {
      _downloading = false;
      _resolvedPath = path;
    });
    return path;
  }

  Future<void> _share() async {
    final path = await _resolve();
    if (path == null) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Could not download the file to share.')),
      );
      return;
    }
    await Share.shareXFiles([XFile(path)], text: widget.file.name);
  }

  Future<void> _open() async {
    final f = widget.file;
    if (f.tooLarge && (f.url == null || f.url!.isEmpty)) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('File too large to deliver in-app.')));
      }
      return;
    }
    final path = await _resolve();
    if (path != null) {
      await OpenFilex.open(path);
    } else if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Could not download the file. Check your connection.')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final file = widget.file;
    final canOpen = !file.tooLarge || (file.url != null && file.url!.isNotEmpty);

    final isImage =
        RegExp(r'\.(png|jpe?g|gif|webp|bmp)$', caseSensitive: false)
            .hasMatch(file.name);
    final localImg = _resolvedPath ?? file.localPath;
    final hasInlineImage =
        isImage && ((localImg != null) || (file.url != null && file.url!.isNotEmpty));

    Widget chip = InkWell(
      onTap: _downloading ? null : _open,
      child: Container(
        margin: const EdgeInsets.only(top: 6),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: AppTheme.surfaceAlt,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: AppTheme.border),
        ),
        child: Row(
          children: [
            Icon(file.tooLarge ? Icons.warning_amber : Icons.insert_drive_file,
                color: file.tooLarge ? AppTheme.danger : AppTheme.accent,
                size: 20),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(file.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                          fontSize: 13.5, fontWeight: FontWeight.w600)),
                  Text(
                      _downloading
                          ? 'Downloading…'
                          : file.tooLarge && (file.url == null || file.url!.isEmpty)
                              ? 'Too large — ${_human(file.size)}'
                              : 'Tap to open · ${_human(file.size)}',
                      style:
                          const TextStyle(fontSize: 11, color: AppTheme.muted)),
                ],
              ),
            ),
            if (_downloading)
              const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(
                      strokeWidth: 2, color: AppTheme.accent))
            else if (canOpen) ...[
              IconButton(
                tooltip: 'Share',
                visualDensity: VisualDensity.compact,
                icon: const Icon(Icons.share, size: 18, color: AppTheme.muted),
                onPressed: _share,
              ),
              const Icon(Icons.open_in_new, size: 16, color: AppTheme.muted),
            ],
          ],
        ),
      ),
    );

    if (!hasInlineImage) return chip;

    Widget img;
    if (localImg != null) {
      img = Image.file(File(localImg), fit: BoxFit.contain,
          errorBuilder: (_, __, ___) => const SizedBox.shrink());
    } else {
      img = Image.network(file.url!, fit: BoxFit.contain,
          loadingBuilder: (ctx, child, progress) {
        if (progress == null) return child;
        return const Padding(
          padding: EdgeInsets.all(24),
          child: Center(
              child: SizedBox(
                  width: 22,
                  height: 22,
                  child: CircularProgressIndicator(
                      strokeWidth: 2, color: AppTheme.accent))),
        );
      }, errorBuilder: (_, __, ___) => const SizedBox.shrink());
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 6),
        InkWell(
          onTap: _downloading ? null : _open,
          child: ClipRRect(
            borderRadius: BorderRadius.circular(10),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 320, maxWidth: 360),
              child: Container(
                decoration: BoxDecoration(
                  border: Border.all(color: AppTheme.border),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: img,
              ),
            ),
          ),
        ),
        chip,
      ],
    );
  }
}

class _Composer extends StatelessWidget {
  final TextEditingController controller;
  final bool busy;
  final VoidCallback onSend;
  final VoidCallback onStop;
  final List<_Attachment> attachments;
  final VoidCallback? onAttach;
  final void Function(int index) onRemoveAttachment;
  const _Composer({
    required this.controller,
    required this.busy,
    required this.onSend,
    required this.onStop,
    required this.attachments,
    required this.onAttach,
    required this.onRemoveAttachment,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
      decoration: const BoxDecoration(
        color: AppTheme.surface,
        border: Border(top: BorderSide(color: AppTheme.border)),
      ),
      child: SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (attachments.isNotEmpty)
              Align(
                alignment: Alignment.centerLeft,
                child: Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: List.generate(attachments.length, (i) {
                      final a = attachments[i];
                      return Container(
                        padding: const EdgeInsets.fromLTRB(10, 6, 6, 6),
                        decoration: BoxDecoration(
                          color: AppTheme.surfaceAlt,
                          borderRadius: BorderRadius.circular(10),
                          border: Border.all(color: AppTheme.border),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(a.isImage ? Icons.image : Icons.insert_drive_file,
                                size: 16, color: AppTheme.accent),
                            const SizedBox(width: 6),
                            ConstrainedBox(
                              constraints: const BoxConstraints(maxWidth: 150),
                              child: Text(a.name,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(fontSize: 12.5)),
                            ),
                            const SizedBox(width: 4),
                            InkWell(
                              onTap: () => onRemoveAttachment(i),
                              child: const Icon(Icons.close,
                                  size: 16, color: AppTheme.muted),
                            ),
                          ],
                        ),
                      );
                    }),
                  ),
                ),
              ),
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                GestureDetector(
                  onTap: onAttach,
                  child: Container(
                    width: 46,
                    height: 50,
                    margin: const EdgeInsets.only(right: 8),
                    decoration: BoxDecoration(
                      color: AppTheme.surfaceAlt,
                      borderRadius: BorderRadius.circular(14),
                      border: Border.all(color: AppTheme.border),
                    ),
                    child: Icon(Icons.add,
                        color: onAttach == null ? AppTheme.border : AppTheme.accent),
                  ),
                ),
                Expanded(
                  child: TextField(
                    controller: controller,
                    minLines: 1,
                    maxLines: 5,
                    textInputAction: TextInputAction.send,
                    onSubmitted: (_) => onSend(),
                    decoration: const InputDecoration(
                      hintText: 'Describe a task or attach files…',
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                GestureDetector(
                  onTap: busy ? onStop : onSend,
                  child: Container(
                    width: 50,
                    height: 50,
                    decoration: BoxDecoration(
                      color: busy ? AppTheme.danger : AppTheme.accent,
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: busy
                        ? const Icon(Icons.stop_rounded, color: Colors.white, size: 28)
                        : const Icon(Icons.arrow_upward,
                            color: Color(0xFF04130C)),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
