import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart' show MarkdownStyleSheet;
import 'package:image_picker/image_picker.dart';
import '../api/api_config.dart';
import '../api/chat_service.dart';
import '../api/chat_history_service.dart';
import '../widgets/math_markdown.dart';
import '../theme.dart';

class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key});
  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _CMsg {
  final bool isUser;
  String text;
  bool error;
  // For user messages: an optional attached image (base64 JPEG, no prefix) so
  // the bubble can show a thumbnail of what was sent.
  final String? imageB64;
  _CMsg(this.isUser, this.text, {this.error = false, this.imageB64});
}

class _ChatScreenState extends State<ChatScreen>
    with AutomaticKeepAliveClientMixin {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final _picker = ImagePicker();
  final List<_CMsg> _msgs = [];
  bool _busy = false;
  bool _uncensored = false; // false = HotBot/GPT-5, true = WormGPT uncensored
  bool _examMode = false; // 🎓 CBT exam mode → fast, answer-first, LaTeX
  bool _loadingHistory = true;

  // Pending image (base64 JPEG, no data-URL prefix) staged for the next send.
  String? _pendingImageB64;

  // Persisted per-mode so the two conversations don't mix. These map to the
  // server-side `scope` column (auto-wipes after 2 days).
  String get _scope => _uncensored ? 'wormgpt' : 'chat';

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _loadHistory();
  }

  @override
  void dispose() {
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  // Pull the saved conversation for the current mode from the backend so it
  // survives the app being closed/reopened.
  Future<void> _loadHistory() async {
    setState(() => _loadingHistory = true);
    final rows = await ChatHistoryService.load(_scope);
    if (!mounted) return;
    setState(() {
      _msgs
        ..clear()
        ..addAll(rows.map((r) => _CMsg(
              (r['role'] ?? '') == 'user',
              (r['content'] ?? '').toString(),
              error: r['is_error'] == true,
            )));
      _loadingHistory = false;
    });
    _down();
  }

  void _down() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent,
            duration: const Duration(milliseconds: 220), curve: Curves.easeOut);
      }
    });
  }

  Future<void> _switchMode(bool v) async {
    setState(() {
      _uncensored = v;
      _msgs.clear();
      // Vision/exam only make sense on the default HotBot endpoint, so drop any
      // staged image when jumping into the uncensored WormGPT conversation.
      if (v) _pendingImageB64 = null;
    });
    // Load the OTHER mode's saved history instead of wiping permanently.
    await _loadHistory();
  }

  Future<void> _clear() async {
    final scope = _scope;
    setState(() {
      _msgs.clear();
      _pendingImageB64 = null;
    });
    await ChatHistoryService.clear(scope);
  }

  // ── Image attach / camera capture ─────────────────────────────────────────
  Future<void> _pickImage(ImageSource source) async {
    try {
      final XFile? file = await _picker.pickImage(
        source: source,
        // Downscale + compress so uploads stay fast (crucial in exam mode) and
        // well under any request-size limits, while staying readable for OCR.
        maxWidth: 1600,
        maxHeight: 1600,
        imageQuality: 82,
      );
      if (file == null) return;
      final bytes = await File(file.path).readAsBytes();
      if (!mounted) return;
      setState(() => _pendingImageB64 = base64Encode(bytes));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Could not load image: $e')),
      );
    }
  }

  void _showAttachSheet() {
    if (_uncensored) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Switch off Uncensored to attach images.'),
        ),
      );
      return;
    }
    showModalBottomSheet(
      context: context,
      backgroundColor: AppTheme.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
      ),
      builder: (c) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.photo_camera_outlined,
                  color: AppTheme.accent),
              title: const Text('Take a photo',
                  style: TextStyle(color: AppTheme.text)),
              subtitle: const Text('Snap a CBT / exam question',
                  style: TextStyle(color: AppTheme.muted, fontSize: 12)),
              onTap: () {
                Navigator.pop(c);
                _pickImage(ImageSource.camera);
              },
            ),
            ListTile(
              leading:
                  const Icon(Icons.image_outlined, color: AppTheme.accent),
              title: const Text('Upload from gallery',
                  style: TextStyle(color: AppTheme.text)),
              onTap: () {
                Navigator.pop(c);
                _pickImage(ImageSource.gallery);
              },
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _send() async {
    final msg = _input.text.trim();
    final img = _pendingImageB64;
    // Allow sending an image with no text (common in exam mode — just snap it).
    if ((msg.isEmpty && img == null) || _busy) return;
    _input.clear();
    final scope = _scope;
    // In exam mode with only an image, give the model a light nudge.
    final effectiveMsg = msg.isEmpty
        ? (_examMode
            ? 'Solve this exam question. Give the answer first, then a short explanation.'
            : 'Describe / analyze this image.')
        : msg;
    final reply = _CMsg(false, '');
    setState(() {
      _msgs.add(_CMsg(true, msg.isEmpty ? '📷 Image' : msg, imageB64: img));
      _msgs.add(reply);
      _busy = true;
      _pendingImageB64 = null; // consumed
    });
    _down();
    // Persist the user message immediately so it survives an app close even
    // while the reply is still streaming back.
    ChatHistoryService.save(
        scope: scope, role: 'user', content: msg.isEmpty ? '📷 Image' : msg);
    try {
      final text = await ChatService.send(
        message: effectiveMsg,
        endpoint: _uncensored ? ApiConfig.wormgptChat : ApiConfig.chat,
        imageDataUrl:
            img == null ? null : 'data:image/jpeg;base64,$img',
        examMode: _examMode && !_uncensored,
      );
      setState(() => reply.text = text);
      ChatHistoryService.save(scope: scope, role: 'assistant', content: text);
    } catch (e) {
      setState(() {
        reply.text = e.toString();
        reply.error = true;
      });
      ChatHistoryService.save(
          scope: scope, role: 'assistant', content: e.toString(), isError: true);
    } finally {
      setState(() => _busy = false);
      _down();
    }
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    return Scaffold(
      appBar: AppBar(
        // ── Exam Mode toggle — top LEFT (leading) ──
        leadingWidth: 96,
        leading: Padding(
          padding: const EdgeInsets.only(left: 6),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Tooltip(
                message: _examMode
                    ? 'Exam Mode ON — fast CBT answers'
                    : 'Exam Mode OFF',
                child: Icon(
                  Icons.school,
                  size: 20,
                  color: _examMode ? AppTheme.accent : AppTheme.muted,
                ),
              ),
              Transform.scale(
                scale: 0.78,
                child: Switch(
                  value: _examMode,
                  activeColor: AppTheme.accent,
                  onChanged: _busy
                      ? null
                      : (v) => setState(() => _examMode = v),
                ),
              ),
            ],
          ),
        ),
        title: Text(_uncensored
            ? 'WormGPT'
            : (_examMode ? 'AI Chat · Exam' : 'AI Chat')),
        titleSpacing: 0,
        actions: [
          IconButton(
            tooltip: 'Clear',
            icon: const Icon(Icons.delete_sweep_outlined),
            onPressed: _busy ? null : _clear,
          ),
          Row(
            children: [
              const Text('Uncensored',
                  style: TextStyle(fontSize: 11, color: AppTheme.muted)),
              Transform.scale(
                scale: 0.85,
                child: Switch(
                  value: _uncensored,
                  activeColor: AppTheme.danger,
                  onChanged: _busy ? null : _switchMode,
                ),
              ),
            ],
          ),
        ],
      ),
      body: Column(
        children: [
          if (_examMode)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
              color: AppTheme.accent.withValues(alpha: 0.12),
              child: const Text(
                '🎓 Exam Mode: snap a CBT question — fast answer first, short explanation.',
                style: TextStyle(color: AppTheme.accent, fontSize: 12),
              ),
            ),
          Expanded(
            child: _loadingHistory
                ? const Center(
                    child: CircularProgressIndicator(
                        strokeWidth: 2, color: AppTheme.accent))
                : _msgs.isEmpty
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.all(30),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(_uncensored ? '😈' : (_examMode ? '🎓' : '💬'),
                              style: const TextStyle(fontSize: 50)),
                          const SizedBox(height: 12),
                          Text(
                            _uncensored
                                ? 'WormGPT — uncensored chat.\nAsk anything.'
                                : _examMode
                                    ? 'Exam Mode.\nSnap a CBT / maths question — get\na fast answer + short explanation.'
                                    : 'Chat with HotBot (GPT-5).\nFast, smart answers. Attach an image too.',
                            textAlign: TextAlign.center,
                            style: const TextStyle(
                                color: AppTheme.muted, fontSize: 15),
                          ),
                        ],
                      ),
                    ),
                  )
                : ListView.builder(
                    controller: _scroll,
                    padding: const EdgeInsets.all(12),
                    itemCount: _msgs.length,
                    itemBuilder: (c, i) {
                      final m = _msgs[i];
                      if (m.isUser) {
                        return Align(
                          alignment: Alignment.centerRight,
                          child: Container(
                            margin:
                                const EdgeInsets.only(bottom: 12, left: 48),
                            padding: const EdgeInsets.symmetric(
                                horizontal: 14, vertical: 11),
                            decoration: BoxDecoration(
                              color: AppTheme.accent2,
                              borderRadius: BorderRadius.circular(16),
                            ),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.end,
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                if (m.imageB64 != null)
                                  Padding(
                                    padding: const EdgeInsets.only(bottom: 6),
                                    child: ClipRRect(
                                      borderRadius: BorderRadius.circular(10),
                                      child: Image.memory(
                                        base64Decode(m.imageB64!),
                                        width: 180,
                                        fit: BoxFit.cover,
                                      ),
                                    ),
                                  ),
                                Text(m.text,
                                    style: const TextStyle(
                                        color: Colors.white, fontSize: 14.5)),
                              ],
                            ),
                          ),
                        );
                      }
                      return Align(
                        alignment: Alignment.centerLeft,
                        child: Container(
                          margin: const EdgeInsets.only(bottom: 12, right: 32),
                          padding: const EdgeInsets.all(13),
                          decoration: BoxDecoration(
                            color: AppTheme.surface,
                            borderRadius: BorderRadius.circular(16),
                            border: Border.all(color: AppTheme.border),
                          ),
                          child: m.text.isEmpty
                              ? const SizedBox(
                                  width: 16,
                                  height: 16,
                                  child: CircularProgressIndicator(
                                      strokeWidth: 2, color: AppTheme.accent),
                                )
                              : MathMarkdown(
                                  data: m.text,
                                  selectable: true,
                                  mathColor: m.error
                                      ? AppTheme.danger
                                      : AppTheme.text,
                                  styleSheet: MarkdownStyleSheet(
                                    p: TextStyle(
                                        color: m.error
                                            ? AppTheme.danger
                                            : AppTheme.text,
                                        fontSize: 14.5,
                                        height: 1.45),
                                  ),
                                ),
                        ),
                      );
                    },
                  ),
          ),
          // ── Staged-image preview strip ──
          if (_pendingImageB64 != null)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
              color: AppTheme.surface,
              child: Row(
                children: [
                  ClipRRect(
                    borderRadius: BorderRadius.circular(8),
                    child: Image.memory(
                      base64Decode(_pendingImageB64!),
                      width: 54,
                      height: 54,
                      fit: BoxFit.cover,
                    ),
                  ),
                  const SizedBox(width: 10),
                  const Expanded(
                    child: Text('Image attached',
                        style:
                            TextStyle(color: AppTheme.muted, fontSize: 13)),
                  ),
                  IconButton(
                    icon: const Icon(Icons.close, color: AppTheme.muted),
                    onPressed: () =>
                        setState(() => _pendingImageB64 = null),
                  ),
                ],
              ),
            ),
          Container(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
            decoration: const BoxDecoration(
              color: AppTheme.surface,
              border: Border(top: BorderSide(color: AppTheme.border)),
            ),
            child: SafeArea(
              top: false,
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  // ── Attach image / camera button ──
                  GestureDetector(
                    onTap: _busy ? null : _showAttachSheet,
                    child: Container(
                      width: 46,
                      height: 46,
                      margin: const EdgeInsets.only(right: 6),
                      decoration: BoxDecoration(
                        color: AppTheme.bg,
                        borderRadius: BorderRadius.circular(14),
                        border: Border.all(color: AppTheme.border),
                      ),
                      child: Icon(
                        Icons.add_photo_alternate_outlined,
                        color: _uncensored ? AppTheme.muted : AppTheme.accent,
                      ),
                    ),
                  ),
                  Expanded(
                    child: TextField(
                      controller: _input,
                      minLines: 1,
                      maxLines: 5,
                      textInputAction: TextInputAction.send,
                      onSubmitted: (_) => _send(),
                      decoration: InputDecoration(
                          hintText: _examMode
                              ? 'Snap a question or type it…'
                              : 'Type a message…'),
                    ),
                  ),
                  const SizedBox(width: 8),
                  GestureDetector(
                    onTap: _busy ? null : _send,
                    child: Container(
                      width: 50,
                      height: 50,
                      decoration: BoxDecoration(
                        color: _busy ? AppTheme.border : AppTheme.accent,
                        borderRadius: BorderRadius.circular(14),
                      ),
                      child: const Icon(Icons.arrow_upward,
                          color: Color(0xFF04130C)),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
