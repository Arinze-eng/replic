// math_markdown.dart — drop-in replacement for MarkdownBody that ALSO renders
// LaTeX math/equations beautifully.
//
// Why: flutter_markdown alone shows `$x^2$`, `\frac{a}{b}`, `$$...$$`, `\(...\)`
// and `\[...\]` as raw text. This widget splits the incoming text into math and
// non-math runs, renders math with flutter_math_fork's Math.tex(), and renders
// everything else with the existing MarkdownBody — so normal markdown (code
// blocks, bold, lists, links) keeps working exactly as before.
//
// Designed to be conservative so it can NEVER crash the chat: any malformed
// LaTeX falls back to showing the raw source text instead of throwing.
import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_math_fork/flutter_math.dart';

class _Segment {
  final String text;
  final bool isMath;
  final bool display; // block (centered, own line) vs inline
  _Segment(this.text, this.isMath, this.display);
}

class MathMarkdown extends StatelessWidget {
  final String data;
  final MarkdownStyleSheet styleSheet;
  final bool selectable;
  final Color mathColor;
  final double fontSize;

  const MathMarkdown({
    super.key,
    required this.data,
    required this.styleSheet,
    this.selectable = true,
    this.mathColor = const Color(0xFFE8EDF5),
    this.fontSize = 14.5,
  });

  // Split `src` into ordered math / non-math segments.
  // Supported delimiters (checked longest-first to avoid ambiguity):
  //   $$ ... $$   → display math
  //   \[ ... \]   → display math
  //   \( ... \)   → inline math
  //   $ ... $     → inline math (with currency guard)
  static List<_Segment> _tokenize(String src) {
    final segs = <_Segment>[];
    final buf = StringBuffer();
    int i = 0;
    final n = src.length;

    void flushText() {
      if (buf.isNotEmpty) {
        segs.add(_Segment(buf.toString(), false, false));
        buf.clear();
      }
    }

    // Try to match a math span starting at `i`. Returns the index AFTER the
    // closing delimiter, or -1 if no match.
    int tryMatch(String open, String close, bool display) {
      if (!src.startsWith(open, i)) return -1;
      final contentStart = i + open.length;
      final end = src.indexOf(close, contentStart);
      if (end < 0) return -1;
      final content = src.substring(contentStart, end).trim();
      if (content.isEmpty) return -1;
      // Currency guard for single-$ inline: skip "$5" / "$ 5" style money.
      if (open == r'$') {
        final firstCh = src[contentStart];
        if (firstCh == ' ' || firstCh == '\n') return -1;
        // Reject if the "math" is purely a number (likely a price).
        if (RegExp(r'^\d[\d.,]*$').hasMatch(content)) return -1;
      }
      flushText();
      segs.add(_Segment(content, true, display));
      return end + close.length;
    }

    while (i < n) {
      int next = -1;
      next = tryMatch(r'$$', r'$$', true);
      if (next < 0) next = tryMatch(r'\[', r'\]', true);
      if (next < 0) next = tryMatch(r'\(', r'\)', false);
      if (next < 0) next = tryMatch(r'$', r'$', false);
      if (next >= 0) {
        i = next;
      } else {
        buf.write(src[i]);
        i++;
      }
    }
    flushText();
    return segs;
  }

  Widget _mathWidget(_Segment s) {
    final tex = Math.tex(
      s.text,
      textStyle: TextStyle(color: mathColor, fontSize: fontSize),
      mathStyle: s.display ? MathStyle.display : MathStyle.text,
      // Never throw — fall back to the raw LaTeX as plain text.
      onErrorFallback: (err) => Text(
        s.display ? '\$\$${s.text}\$\$' : '\$${s.text}\$',
        style: TextStyle(color: mathColor, fontSize: fontSize),
      ),
    );
    if (s.display) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: tex,
        ),
      );
    }
    return tex;
  }

  @override
  Widget build(BuildContext context) {
    final segs = _tokenize(data);

    // Fast path: no math at all → behave exactly like the old MarkdownBody.
    if (!segs.any((s) => s.isMath)) {
      return MarkdownBody(
        data: data,
        selectable: selectable,
        styleSheet: styleSheet,
      );
    }

    // Build a vertical flow. Consecutive inline runs (markdown + inline math)
    // are grouped into a Wrap so they sit on the same line; display math gets
    // its own full-width row.
    final children = <Widget>[];
    final inlineRun = <Widget>[];

    void flushInline() {
      if (inlineRun.isEmpty) return;
      children.add(Wrap(
        crossAxisAlignment: WrapCrossAlignment.center,
        children: List.of(inlineRun),
      ));
      inlineRun.clear();
    }

    for (final s in segs) {
      if (s.isMath && s.display) {
        flushInline();
        children.add(_mathWidget(s));
      } else if (s.isMath) {
        inlineRun.add(_mathWidget(s));
      } else {
        // Non-math text → render with MarkdownBody (keeps all markdown intact).
        inlineRun.add(MarkdownBody(
          data: s.text,
          selectable: selectable,
          styleSheet: styleSheet,
          shrinkWrap: true,
          fitContent: true,
        ));
      }
    }
    flushInline();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: children,
    );
  }
}
