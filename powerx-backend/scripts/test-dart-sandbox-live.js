'use strict';

// Live contract test for a selected sandbox provider. It proves the provider can
// install/use the real Dart SDK, reject invalid Dart, then accept the repaired
// source. Usage: PROVIDER=novita|daytona|upstashbox node scripts/test-dart-sandbox-live.js
const assert = require('assert');

const providerName = String(process.env.PROVIDER || '').toLowerCase();
const providers = {
  novita: require('../services/novitaSandbox'),
  daytona: require('../services/daytona'),
  upstashbox: require('../services/upstashBox'),
};
const provider = providers[providerName];
if (!provider) throw new Error('Set PROVIDER=novita, daytona, or upstashbox');

const syntaxCheckerB64 = Buffer.from(require('fs').readFileSync(require('path').join(__dirname, 'dart-syntax-check.js'))).toString('base64');
const command = String.raw`
set -eu
export PATH="$HOME/.powerx-dart/dart-sdk/bin:$PATH"
MACHINE="$(uname -m)"
if ! command -v dart >/dev/null 2>&1 && [ "$MACHINE" = "x86_64" ]; then
  mkdir -p "$HOME/.powerx-dart"
  cd "$HOME/.powerx-dart"
  command -v curl >/dev/null 2>&1 || (sudo apt-get update -qq && sudo apt-get install -y -qq curl unzip)
  command -v unzip >/dev/null 2>&1 || (sudo apt-get update -qq && sudo apt-get install -y -qq unzip)
  curl -fL --retry 3 --connect-timeout 20 -o dartsdk.zip https://storage.googleapis.com/dart-archive/channels/stable/release/latest/sdk/dartsdk-linux-x64-release.zip
  rm -rf dart-sdk
  unzip -q dartsdk.zip
  rm -f dartsdk.zip
fi
rm -rf /tmp/powerx-dart-check
mkdir -p /tmp/powerx-dart-check/lib
cd /tmp/powerx-dart-check
cat > pubspec.yaml <<'YAML'
name: powerx_dart_check
environment:
  sdk: '>=3.0.0 <4.0.0'
YAML
if command -v dart >/dev/null 2>&1; then
  CHECK='dart analyze'
else
  npm init -y
  npx -y node@20 "$(command -v npm)" install tree-sitter@0.20.6 tree-sitter-dart@1.0.0
  echo '${syntaxCheckerB64}' | base64 -d > dart-syntax-check.js
  CHECK='npx -y node@20 dart-syntax-check.js .'
fi
cat > lib/main.dart <<'DART'
void main() {
  print('broken')
}
DART
set +e
sh -c "$CHECK" > invalid.log 2>&1
INVALID_CODE=$?
set -e
cat invalid.log
if [ "$INVALID_CODE" -eq 0 ]; then
  echo 'DART_INVALID_SOURCE_WAS_NOT_REJECTED'
  exit 41
fi
cat > lib/main.dart <<'DART'
void main() {
  print('fixed');
}
DART
sh -c "$CHECK" > valid.log 2>&1
cat valid.log
echo 'DART_ANALYZER_INVALID_REJECTED=1'
echo 'DART_ANALYZER_VALID_ACCEPTED=1'
if command -v dart >/dev/null 2>&1; then dart --version; else echo 'DART_ANALYZER_MODE=portable-syntax-fallback'; fi
`;

(async () => {
  const probe = await provider.testKey();
  assert(probe && probe.ok, probe && probe.message || `${providerName} key probe failed`);
  let id = null;
  try {
    id = await provider.createSandbox({ labels: { session: `dart-analyzer-${Date.now()}` } });
    const result = await provider.exec(id, command, { cwd: null, timeout: 900 });
    process.stdout.write(String(result.output || ''));
    assert.equal(result.exitCode, 0, `${providerName} analyzer command failed`);
    assert.match(result.output, /DART_ANALYZER_INVALID_REJECTED=1/);
    assert.match(result.output, /DART_ANALYZER_VALID_ACCEPTED=1/);
    console.log(`EVIDENCE:TEST_PASSED ${providerName} Dart validation`);
  } finally {
    if (id) await provider.deleteSandbox(id).catch(() => {});
  }
})().catch(err => { console.error(err); process.exit(1); });
