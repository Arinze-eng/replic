// Local unit test for the long-form detectors (no network). Extracts the pure
// functions from services/hotbot.js by regex and evals them in isolation.
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../services/hotbot.js', 'utf8');

function grab(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('not found: ' + name);
  // Bound by the start of the NEXT top-level `function ` declaration (each
  // helper is followed by another function/const in the source).
  const after = src.indexOf('\nfunction ', start + 1);
  const afterConst = src.indexOf('\nconst ', start + 1);
  let end = src.length;
  if (after > 0) end = Math.min(end, after);
  if (afterConst > 0) end = Math.min(end, afterConst);
  return src.slice(start, end);
}

eval(grab('isLongFormWrite'));
eval(grab('looksTruncated'));

const T = [
  ['Write a 20-page story about a hacker', true],
  ['write a complete 5-chapter short story about Zero', true],
  ['Answer ALL 5 questions: 1) a 2) b 3) c 4) d 5) e', true],
  ['Do not summarize, write the full essay on climate change', true],
  ['1. what is tcp 2. what is udp 3. what is dns 4. what is http', true],
  ['write a 2000 word article about AI', true],
  ['what is the capital of france', false],
  ['hi', false],
  ['explain how tcp works', false],
  ['compose a poem with 6 stanzas', true],
];

let ok = 0;
for (const [q, exp] of T) {
  const got = isLongFormWrite(q);
  const pass = got === exp;
  ok += pass ? 1 : 0;
  console.log((pass ? 'PASS' : 'FAIL'), JSON.stringify(q), '=>', got, '(exp', exp + ')');
}

console.log('--- truncation ---');
const tr = [
  // Short bodies never trigger continuation (safe — avoids false positives on
  // normal short chat). Truncation only fires on LONG bodies (>400 chars).
  ['The hacker sat down and then he', false],
  ['The end. It was over.', false],
  ['here is code:\n```js\nlet x=1', true],
  ['This is a full paragraph that ends properly with a period.', false],
  // A long body that ends mid-sentence IS flagged as truncated.
  ['x'.repeat(450) + ' and then he walked into the', true],
];
for (const [s, exp] of tr) {
  const got = looksTruncated(s);
  const pass = got === exp;
  ok += pass ? 1 : 0;
  console.log((pass ? 'PASS' : 'FAIL'), JSON.stringify(s.slice(0, 30)), '=>', got, '(exp', exp + ')');
}

const total = T.length + tr.length;
console.log('\nSCORE', ok + '/' + total);
process.exit(ok === total ? 0 : 1);
