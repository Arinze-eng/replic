#!/usr/bin/env node
'use strict';
const assert = require('assert');
const mathQuality = require('../services/mathQuality');
const qualityGate = require('../services/qualityGate');

const cases = [
  {
    name: 'quadratic equation',
    task: 'Solve x^2 - 5x + 6 = 0 and show all steps.',
    shallow: 'The answer is x = 2 or x = 3.',
    full: `### Given and target\nGiven \\(x^2-5x+6=0\\). Find every real root.\n\n### Formula and steps\nUse factoring because two integers must multiply to \\(6\\) and add to \\(-5\\).\n\\[x^2-5x+6=x^2-2x-3x+6\\]\n\\[=x(x-2)-3(x-2)=(x-2)(x-3)=0\\]\nBy the zero-product rule, \\(x-2=0\\) or \\(x-3=0\\), so \\(x=2\\) or \\(x=3\\).\n\n### Verification\nSubstitute back: \\(2^2-5(2)+6=4-10+6=0\\) and \\(3^2-5(3)+6=9-15+6=0\\). Both check.\n\n**Final answer:** \\(\\boxed{x=2,3}\\).`,
  },
  {
    name: 'definite integral',
    task: 'Evaluate the integral from 0 to 2 of (3x^2 + 2x) dx with full working.',
    shallow: 'Answer: 12.',
    full: `### Given and target\nGiven \\(I=\\int_0^2(3x^2+2x)\\,dx\\). Find \\(I\\).\n\n### Governing rule and substitution\nUse the power rule \\(\\int x^n dx=x^{n+1}/(n+1)\\):\n\\[I=\\left[x^3+x^2\\right]_0^2\\]\n\\[I=(2^3+2^2)-(0^3+0^2)=8+4-0=12\\]\n\n### Verification\nDifferentiate the antiderivative: \\(d(x^3+x^2)/dx=3x^2+2x\\), which reproduces the integrand.\n\n**Final answer:** \\(\\boxed{I=12}\\).`,
  },
  {
    name: 'probability',
    task: 'A fair die is rolled twice. Find the probability that the sum is 8. Break it down fully.',
    shallow: '5/36',
    full: `### Given and target\nA fair six-sided die is rolled twice, giving \\(6\\times6=36\\) equally likely ordered outcomes. Find \\(P(S=8)\\).\n\n### Counting steps\nThe favorable ordered pairs are \\((2,6),(3,5),(4,4),(5,3),(6,2)\\), so the favorable count is \\(5\\).\n\\[P(S=8)=\\frac{\\text{favorable}}{\\text{total}}=\\frac{5}{36}\\]\nThe fraction is already in lowest terms because \\(\\gcd(5,36)=1\\).\n\n### Verification\nConvolution counts for sums 2 through 12 are \\(1,2,3,4,5,6,5,4,3,2,1\\); the counts total \\(36\\), and sum 8 has count \\(5\\).\n\n**Final answer:** \\(\\boxed{5/36}\\).`,
  },
];

for (const c of cases) {
  const bad = mathQuality.assess(c.task, c.shallow);
  assert(bad.applicable && !bad.ok, `${c.name}: answer-only response must fail`);
  const good = mathQuality.assess(c.task, c.full);
  assert(good.ok, `${c.name}: full response should pass: ${good.reasons.join(', ')}`);
  assert.match(qualityGate.evaluate(c.task, [], c.shallow), /MATH COMPLETENESS GATE/);
  assert.equal(qualityGate.evaluate(c.task, [], c.full), null);
}

const multiTask = `Solve all questions with full derivations:\n1. Solve x^2-5x+6=0.\n2. Evaluate integral 0 to 2 of (3x^2+2x) dx.\n3. Find P(sum=8) for two fair dice.`;
const multiShallow = `1. x=2,3\n2. 12\n3. 5/36`;
assert(!mathQuality.assess(multiTask, multiShallow).ok, 'multi-question answer list must fail');

console.log(`✅ math completeness: ${cases.length} domains plus multi-question answer-only regression passed`);
