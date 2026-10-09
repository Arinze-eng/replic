#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const prompt = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'agent_system_prompt.md'), 'utf8');
const gate = fs.readFileSync(path.join(__dirname, '..', 'agent_worker', 'quality_gate.py'), 'utf8');

for (const phrase of [
  'source ledger listing every question and sub-question',
  'substitution with units',
  'every algebraic and arithmetic transformation',
  'Independently verify every final result',
  'reproduce the bug where possible',
  'targeted tests, the broader regression suite',
  'inspect the diff for secrets/placeholders/unrelated changes',
]) assert(prompt.includes(phrase), `missing reasoning contract: ${phrase}`);
assert(gate.includes('This substantial coding task has only one verification layer'));
assert(gate.includes('len(verifications) < 2'));
console.log('✅ reasoning contract: full calculations and layered coding verification enforced');
