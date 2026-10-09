// app_gate.dart — wraps the whole app and enforces the admin's remote control:
//   • Maintenance mode  → full-screen block.
//   • Forced update     → blocking dialog (cannot dismiss).
//   • Optional update   → dismissible dialog (once per launch).
//   • Announcement      → top banner.
// It fetches RemoteConfig on launch, then renders `child` underneath.
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'api/app_updater.dart';
import 'api/remote_config_service.dart';
import 'theme.dart';

class AppGate extends StatefulWidget {
  final Widget child;
  const AppGate({super.key, required this.child});
  @override
  State<AppGate> createState() => _AppGateState();
}

class _AppGateState extends State<AppGate> {
  bool _checked = false;
  bool _updateDialogShown = false;

  @override
  void initState() {
    super.initState();
    _boot();
  }

  Future<void> _boot() async {
    await RemoteConfigService.instance.fetch();
    if (!mounted) return;
    setState(() => _checked = true);
    WidgetsBinding.instance.addPostFrameCallback((_) => _maybeShowUpdate());
  }

  Future<void> _maybeShowUpdate() async {
    final cfg = RemoteConfigService.instance.config;
    if (cfg == null || _updateDialogShown) return;
    // ── Anti-flash guard ──────────────────────────────────────────────────
    // ONLY prompt when the server's latest build is STRICTLY NEWER than the
    // build THIS app was compiled as (kCurrentBuild). We deliberately don't
    // trust the server's `updateAvailable` flag alone: if the released APK's
    // kCurrentBuild ever lags behind the DB's apk_latest_build, the server
    // would keep saying "update available" and the dialog would flash on every
    // launch even though the user is already on the newest version. The device
    // knows its own build for certain, so this comparison is the source of
    // truth and makes a false/looping prompt impossible.
    final bool reallyNewer = cfg.latestBuild > kCurrentBuild;
    if (!reallyNewer) return;
    final prefs = await SharedPreferences.getInstance();
    final handledBuild = prefs.getInt('update_handled_build') ?? 0;
    if (!cfg.updateRequired && handledBuild >= cfg.latestBuild) return;
    if (!mounted) return;
    // A real update also needs a usable direct download link.
    if (cfg.downloadUrl.trim().isEmpty) return;
    _updateDialogShown = true;
    showDialog(
      context: context,
      barrierDismissible: !cfg.updateRequired,
      builder: (ctx) => _UpdateDialog(
        cfg: cfg,
        onHandled: () => prefs.setInt('update_handled_build', cfg.latestBuild),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final cfg = RemoteConfigService.instance.config;

    // Maintenance mode → block everything.
    if (_checked && cfg != null && cfg.maintenanceActive) {
      return _MaintenanceScreen(message: cfg.maintenanceMessage);
    }

    return Stack(
      children: [
        widget.child,
        if (_checked && cfg != null && cfg.announcementActive)
          Positioned(
            top: 0, left: 0, right: 0,
            child: SafeArea(
              bottom: false,
              child: _AnnouncementBanner(message: cfg.announcementMessage),
            ),
          ),
      ],
    );
  }
}

class _AnnouncementBanner extends StatefulWidget {
  final String message;
  const _AnnouncementBanner({required this.message});
  @override
  State<_AnnouncementBanner> createState() => _AnnouncementBannerState();
}

class _AnnouncementBannerState extends State<_AnnouncementBanner> {
  bool _dismissed = false;
  @override
  Widget build(BuildContext context) {
    if (_dismissed) return const SizedBox.shrink();
    return Material(
      color: Colors.transparent,
      child: Container(
        margin: const EdgeInsets.all(8),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: AppTheme.accent.withOpacity(0.95),
          borderRadius: BorderRadius.circular(10),
          boxShadow: const [BoxShadow(color: Colors.black38, blurRadius: 8)],
        ),
        child: Row(
          children: [
            const Text('📢 ', style: TextStyle(fontSize: 15)),
            Expanded(
              child: Text(widget.message,
                  style: const TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w600)),
            ),
            InkWell(
              onTap: () => setState(() => _dismissed = true),
              child: const Padding(
                padding: EdgeInsets.only(left: 8),
                child: Icon(Icons.close, size: 18, color: Colors.white),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _UpdateDialog extends StatefulWidget {
  final RemoteConfig cfg;
  final Future<void> Function() onHandled;
  const _UpdateDialog({required this.cfg, required this.onHandled});
  @override
  State<_UpdateDialog> createState() => _UpdateDialogState();
}

class _UpdateDialogState extends State<_UpdateDialog> {
  final AppUpdater _updater = AppUpdater();

  RemoteConfig get cfg => widget.cfg;

  @override
  void initState() {
    super.initState();
    _updater.addListener(_onUpdate);
  }

  @override
  void dispose() {
    _updater.removeListener(_onUpdate);
    _updater.dispose();
    super.dispose();
  }

  void _onUpdate() {
    if (mounted) setState(() {});
  }

  Future<void> _startDownload() async {
    final ok = await _updater.download(cfg.downloadUrl);
    // As soon as the download lands, auto-launch the system installer so the
    // user immediately sees Android's "Install" prompt (one less tap). They can
    // also re-tap Install if they dismissed it.
    if (ok != null) {
      final launched = await _updater.install();
      if (launched) await widget.onHandled();
    }
  }

  @override
  Widget build(BuildContext context) {
    final phase = _updater.phase;
    final busy = _updater.isBusy;

    // Primary action label changes with the phase so the button always tells the
    // user exactly what tapping it does.
    String actionLabel;
    IconData actionIcon;
    switch (phase) {
      case UpdatePhase.downloading:
        actionLabel = 'Downloading…';
        actionIcon = Icons.downloading;
        break;
      case UpdatePhase.downloaded:
      case UpdatePhase.installing:
        actionLabel = 'Install';
        actionIcon = Icons.install_mobile;
        break;
      case UpdatePhase.error:
        actionLabel = 'Retry';
        actionIcon = Icons.refresh;
        break;
      case UpdatePhase.idle:
        actionLabel = 'Download & install';
        actionIcon = Icons.download;
        break;
    }

    return PopScope(
      canPop: !cfg.updateRequired && !busy, // can't dismiss while working / forced
      child: AlertDialog(
        backgroundColor: AppTheme.surface,
        title: Row(children: [
          const Text('🚀 ', style: TextStyle(fontSize: 20)),
          Expanded(child: Text(cfg.updateTitle, style: const TextStyle(fontSize: 17))),
        ]),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(cfg.updateMessage),
              const SizedBox(height: 10),
              Text('New version: ${cfg.latestVersion} (build ${cfg.latestBuild})',
                  style: const TextStyle(fontSize: 12, color: Colors.white70)),
              if (cfg.changelog.trim().isNotEmpty) ...[
                const SizedBox(height: 12),
                const Text("What's new", style: TextStyle(fontWeight: FontWeight.w700)),
                const SizedBox(height: 4),
                Text(cfg.changelog, style: const TextStyle(fontSize: 12, color: Colors.white70)),
              ],
              if (cfg.updateRequired) ...[
                const SizedBox(height: 12),
                const Text('⚠️ This update is required to keep using the app.',
                    style: TextStyle(fontSize: 12, color: Colors.orangeAccent)),
              ],

              // ── Download progress ──
              if (phase == UpdatePhase.downloading) ...[
                const SizedBox(height: 16),
                LinearProgressIndicator(
                  value: _updater.total > 0 ? _updater.progress : null,
                  backgroundColor: Colors.white12,
                  color: AppTheme.accent,
                ),
                const SizedBox(height: 6),
                Text(
                  _updater.total > 0
                      ? 'Downloading ${(_updater.progress * 100).toStringAsFixed(0)}% · ${_updater.progressLabel}'
                      : 'Downloading… ${_updater.progressLabel}',
                  style: const TextStyle(fontSize: 12, color: Colors.white70),
                ),
              ],
              if (phase == UpdatePhase.downloaded) ...[
                const SizedBox(height: 14),
                Row(children: const [
                  Icon(Icons.check_circle, color: Colors.greenAccent, size: 18),
                  SizedBox(width: 6),
                  Expanded(child: Text('Download complete — tap Install to update.',
                      style: TextStyle(fontSize: 12, color: Colors.white70))),
                ]),
              ],
              if (phase == UpdatePhase.installing) ...[
                const SizedBox(height: 14),
                Row(children: const [
                  SizedBox(width: 16, height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2)),
                  SizedBox(width: 8),
                  Expanded(child: Text('Opening the installer…',
                      style: TextStyle(fontSize: 12, color: Colors.white70))),
                ]),
              ],
              if (phase == UpdatePhase.error && _updater.error != null) ...[
                const SizedBox(height: 14),
                Text(_updater.error!,
                    style: const TextStyle(fontSize: 12, color: Colors.redAccent)),
              ],
            ],
          ),
        ),
        actions: [
          if (!cfg.updateRequired && !busy)
            TextButton(
              onPressed: () async {
                await widget.onHandled();
                if (context.mounted) Navigator.of(context).pop();
              },
              child: const Text('Later'),
            ),
          ElevatedButton.icon(
            onPressed: busy
                ? null
                : () async {
                    if (phase == UpdatePhase.downloaded) {
                      final launched = await _updater.install();
                      if (launched) await widget.onHandled();
                    } else {
                      await _startDownload();
                    }
                  },
            icon: Icon(actionIcon, size: 18),
            label: Text(actionLabel),
          ),
        ],
      ),
    );
  }
}

class _MaintenanceScreen extends StatelessWidget {
  final String message;
  const _MaintenanceScreen({required this.message});
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppTheme.bg,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Text('🛠️', style: TextStyle(fontSize: 64)),
                const SizedBox(height: 18),
                const Text('Under maintenance',
                    style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
                const SizedBox(height: 12),
                Text(message,
                    textAlign: TextAlign.center,
                    style: const TextStyle(fontSize: 14, color: Colors.white70)),
                const SizedBox(height: 24),
                OutlinedButton.icon(
                  onPressed: () => RemoteConfigService.instance.fetch(),
                  icon: const Icon(Icons.refresh),
                  label: const Text('Retry'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
