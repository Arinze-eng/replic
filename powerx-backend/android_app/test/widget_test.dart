import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:wormgpt_agent/main.dart';

void main() {
  testWidgets('App boots to splash/auth', (WidgetTester tester) async {
    await tester.pumpWidget(const WormGptApp());
    await tester.pump();
    // The app renders without throwing.
    expect(find.byType(WormGptApp), findsOneWidget);
  });
}
