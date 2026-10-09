import 'package:flutter/material.dart';
import '../theme.dart';
import 'agent_screen.dart';
import 'chat_screen.dart';
import 'tools_screen.dart';
import 'account_screen.dart';
import '../api/api_config.dart';
import '../api/remote_config_service.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    final cfg = RemoteConfigService.instance.config;

    // Build the tab set honoring the admin's remote feature flags. Account is
    // always present so a user can never be locked out of their subscription.
    final pages = <Widget>[];
    final dests = <NavigationDestination>[];

    if (cfg == null || cfg.agent) {
      pages.add(const AgentScreen(
        title: 'WormGPT Agent',
        endpoint: ApiConfig.agentRun,
        emoji: '🪱',
        tagline: 'Autonomous AI — synced to a live sandbox',
      ));
      dests.add(const NavigationDestination(
          icon: Icon(Icons.smart_toy_outlined),
          selectedIcon: Icon(Icons.smart_toy),
          label: 'Agent'));
    }
    if (cfg == null || cfg.chat) {
      pages.add(const ChatScreen());
      dests.add(const NavigationDestination(
          icon: Icon(Icons.chat_bubble_outline),
          selectedIcon: Icon(Icons.chat_bubble),
          label: 'Chat'));
    }
    if (cfg == null || cfg.tools) {
      pages.add(const ToolsScreen());
      dests.add(const NavigationDestination(
          icon: Icon(Icons.grid_view_outlined),
          selectedIcon: Icon(Icons.grid_view),
          label: 'Tools'));
    }
    // Account always last + always present.
    pages.add(const AccountScreen());
    dests.add(const NavigationDestination(
        icon: Icon(Icons.person_outline),
        selectedIcon: Icon(Icons.person),
        label: 'Account'));

    if (_index >= pages.length) _index = 0;

    return Scaffold(
      body: IndexedStack(index: _index, children: pages),
      bottomNavigationBar: Container(
        decoration: const BoxDecoration(
          border: Border(top: BorderSide(color: AppTheme.border)),
        ),
        child: NavigationBar(
          selectedIndex: _index,
          onDestinationSelected: (i) => setState(() => _index = i),
          backgroundColor: AppTheme.surface,
          indicatorColor: AppTheme.accent.withOpacity(0.18),
          destinations: dests,
        ),
      ),
    );
  }
}
