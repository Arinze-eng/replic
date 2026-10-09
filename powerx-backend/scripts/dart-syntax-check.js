'use strict';

// Portable Dart syntax validation for minimal/ARM sandboxes where Google does
// not publish a standalone Dart SDK archive. Prefer `dart analyze` or
// `flutter analyze` whenever available; this parser is the deterministic syntax
// fallback, not a replacement for semantic analysis on capable providers.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function walk(root, out = []) {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (['.git', '.dart_tool', 'build', 'node_modules'].includes(e.name)) continue;
    const p = path.join(root, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith('.dart')) out.push(p);
  }
  return out;
}

const root = path.resolve(process.argv[2] || '.');
if (!fs.existsSync(root)) throw new Error(`Path does not exist: ${root}`);
const files = fs.statSync(root).isDirectory() ? walk(root) : [root];
if (!files.length) throw new Error(`No Dart files found under ${root}`);

// Native analyzer remains authoritative when installed.
for (const candidate of [['dart', ['analyze', root]], ['flutter', ['analyze', root]]]) {
  try {
    execFileSync(candidate[0], candidate[1], { stdio: 'inherit' });
    console.log(`DART_NATIVE_ANALYZER_PASSED=${candidate[0]}`);
    process.exit(0);
  } catch (e) {
    if (e && e.code !== 'ENOENT') process.exit(Number.isInteger(e.status) ? e.status : 1);
  }
}

let Parser, Dart;
try {
  Parser = require('tree-sitter');
  Dart = require('tree-sitter-dart');
} catch (_) {
  console.error('Native Dart/Flutter analyzer unavailable. Install fallback dependencies: npm install --no-save tree-sitter@0.20.6 tree-sitter-dart@1.0.0');
  process.exit(2);
}
const parser = new Parser();
parser.setLanguage(Dart);
let errors = 0;
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const tree = parser.parse(source);
  if (tree.rootNode.hasError()) {
    errors++;
    console.error(`${path.relative(root, file) || path.basename(file)}: Dart syntax error`);
    console.error(tree.rootNode.toString().slice(0, 2000));
  }
}
if (errors) {
  console.error(`DART_SYNTAX_CHECK_FAILED=${errors}`);
  process.exit(1);
}
console.log(`DART_SYNTAX_FALLBACK_PASSED=${files.length}`);
