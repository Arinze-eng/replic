// Unit test: the authorised-pentest framing must ONLY wrap genuine security
// tasks — NOT ordinary chat / analysis / coding / file tasks. The old code
// framed EVERY first turn, which made Capy refuse innocuous messages as
// "social-engineering / prompt-injection" and DESTROYED conversational memory.
const assert = require('assert');
const c = require('../services/capy.js');

const security = [
  'scan example.com for vulnerabilities',
  'run nmap on 10.0.0.1',
  'find SQL injection in the login form',
  'do a pentest of my site',
  'exploit this CVE',
  'enumerate open ports on 1.2.3.4',
  'crack the wifi password',
  'hack into my server (I own it)',
  'run a security assessment of my app',
  'use sqlmap on the search endpoint',
];
const normal = [
  'remember my passphrase is GREEN-OWL-77 and I live in Lagos',
  'summarise this PDF for me',
  'what is the capital of France',
  'write a python script to sort a list',
  'analyse this sales spreadsheet and make a chart',
  'what are the last 5 things we discussed',
  'translate this paragraph to French',
  'build me a landing page for a coffee shop',
];

let fails = 0;
for (const s of security) {
  if (!c.looksLikeSecurityTask(s)) { console.log('✗ MISS (should frame):', s); fails++; }
}
for (const n of normal) {
  if (c.looksLikeSecurityTask(n)) { console.log('✗ FALSE POSITIVE (should NOT frame):', n); fails++; }
}

assert.strictEqual(fails, 0, fails + ' framing-intent mismatches');
console.log('✓ all', security.length, 'security tasks framed; all', normal.length, 'normal tasks NOT framed');
console.log('\nFRAMING-INTENT TESTS PASSED ✅');
