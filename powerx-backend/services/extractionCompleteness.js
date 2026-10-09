'use strict';

// Deterministic guardrails for multi-image OCR. The vision model may interpret
// content, but it is never trusted to decide whether every uploaded page was
// actually represented. These helpers preserve source order, score each page,
// identify weak/failed pages for a second pass, and build an explicit manifest
// that the synthesis model must reconcile before answering.

const QUESTION_RE = /(?:^|\n)\s*(?:question\s*)?(?:\d{1,3}|[ivxlcdm]{1,8})\s*[.)\]:-]|\b(?:solve|calculate|evaluate|find|determine|prove|show that|simplify)\b/gi;
const MATH_RE = /(?:[=+\-×÷*/^√∫∑πθ]|\b(?:sin|cos|tan|log|ln|matrix|equation|differentiate|integrate)\b)/gi;
const GARBLED_RE = /(?:\[\?\]|�|\?{3,}|[_|]{5,})/g;

function naturalKey(name) {
  return String(name || '').toLowerCase().split(/(\d+)/).map(part => /^\d+$/.test(part) ? Number(part) : part);
}

function compareNatural(a, b) {
  const aa = naturalKey(a && a.name); const bb = naturalKey(b && b.name);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    if (aa[i] === bb[i]) continue;
    if (aa[i] === undefined) return -1;
    if (bb[i] === undefined) return 1;
    if (typeof aa[i] === 'number' && typeof bb[i] === 'number') return aa[i] - bb[i];
    return String(aa[i]).localeCompare(String(bb[i]));
  }
  return 0;
}

function orderImages(images) {
  // Preserve upload order by default because it is authoritative. Natural-name
  // order is used only when every item carries an explicit sourceIndex gap-free.
  const rows = (images || []).map((image, uploadIndex) => ({ ...image, uploadIndex }));
  if (rows.every(x => Number.isInteger(x.sourceIndex))) return rows.sort((a, b) => a.sourceIndex - b.sourceIndex || compareNatural(a, b));
  return rows;
}

function normalizeText(text) {
  return String(text || '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
}

function assessPage({ name, text, confidence, engine, error } = {}) {
  const clean = normalizeText(text);
  const words = clean.match(/\S+/g) || [];
  const alnum = (clean.match(/[\p{L}\p{N}]/gu) || []).length;
  const questionCount = (clean.match(QUESTION_RE) || []).length;
  const mathTokenCount = (clean.match(MATH_RE) || []).length;
  const garbledCount = (clean.match(GARBLED_RE) || []).length;
  const conf = Number.isFinite(Number(confidence)) ? Number(confidence) : null;
  const weakReasons = [];
  if (error) weakReasons.push('extraction-error');
  if (words.length < 4 || alnum < 12) weakReasons.push('too-little-text');
  if (conf !== null && conf > 0 && conf < 55) weakReasons.push('low-confidence');
  if (garbledCount >= 3 || (clean.length && garbledCount / clean.length > 0.02)) weakReasons.push('garbled-text');
  if (/no readable content|no text extracted|no meaningful text/i.test(clean)) weakReasons.push('explicit-empty-result');
  return {
    name: String(name || ''), text: clean, engine: engine || 'unknown', confidence: conf,
    chars: clean.length, words: words.length, questionCount, mathTokenCount, garbledCount,
    weak: weakReasons.length > 0, weakReasons,
  };
}

function buildManifest(pages) {
  const assessed = (pages || []).map(assessPage);
  const missing = assessed.map((p, i) => ({ p, i })).filter(x => !x.p.text).map(x => x.i + 1);
  const weak = assessed.map((p, i) => ({ p, i })).filter(x => x.p.weak).map(x => x.i + 1);
  return {
    expectedPages: assessed.length,
    representedPages: assessed.filter(p => !!p.text).length,
    missingPages: missing,
    weakPages: weak,
    totalChars: assessed.reduce((n, p) => n + p.chars, 0),
    detectedQuestions: assessed.reduce((n, p) => n + p.questionCount, 0),
    mathPages: assessed.map((p, i) => p.mathTokenCount ? i + 1 : null).filter(Boolean),
    complete: assessed.length > 0 && missing.length === 0 && weak.length === 0,
    pages: assessed,
  };
}

function renderPageReport(pages) {
  const manifest = buildManifest(pages);
  const blocks = manifest.pages.map((p, i) =>
    `=== SOURCE IMAGE ${i + 1}/${manifest.expectedPages}: ${p.name || `image-${i + 1}`} ===\n` +
    `[extraction: ${p.weak ? `WEAK (${p.weakReasons.join(', ')})` : 'OK'}; chars=${p.chars}; words=${p.words}; questions≈${p.questionCount}; math_tokens=${p.mathTokenCount}; engine=${p.engine}]\n` +
    (p.text || '[NO TEXT EXTRACTED]'));
  return { manifest, report: blocks.join('\n\n') };
}

function completenessInstruction(manifest) {
  return `EXTRACTION MANIFEST (deterministic): expected=${manifest.expectedPages}; represented=${manifest.representedPages}; weak_pages=${manifest.weakPages.join(',') || 'none'}; missing_pages=${manifest.missingPages.join(',') || 'none'}; detected_question_markers≈${manifest.detectedQuestions}; math_pages=${manifest.mathPages.join(',') || 'none'}.\n` +
    `Do not claim completeness unless every source image is represented. Build a numbered question ledger before solving. Include every question and sub-question exactly once, preserve page order, join only clearly continued questions, and explicitly flag unreadable fragments instead of silently dropping them.`;
}

module.exports = { orderImages, normalizeText, assessPage, buildManifest, renderPageReport, completenessInstruction };
