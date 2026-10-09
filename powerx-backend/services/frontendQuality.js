'use strict';
// Objective pre-deploy frontend QA. It blocks bare/inert/broken pages while
// remaining framework-agnostic and deterministic across every sandbox backend.
const path = require('path');

function count(re, text) { return (String(text).match(re) || []).length; }
function refs(html) {
  const out = [];
  for (const m of String(html).matchAll(/<(?:img|script|link)\b[^>]*(?:src|href)=["']([^"']+)["']/gi)) out.push(m[1]);
  return out;
}
function inspectHtml(html, { task = '', filename = 'index.html' } = {}) {
  html = String(html || ''); const issues = [], warnings = [];
  const lower = html.toLowerCase(); const css = (html.match(/<style\b[\s\S]*?<\/style>/gi) || []).join('\n');
  const scripts = (html.match(/<script\b[\s\S]*?<\/script>/gi) || []).join('\n');
  const externalCss = /<link\b[^>]*rel=["']stylesheet["']/i.test(html);
  const semantic = count(/<(header|nav|main|section|article|footer)\b/gi, html);
  const interactive = count(/<(button|a|input|select|textarea|details)\b/gi, html);
  const images = count(/<(img|picture|svg|video|canvas)\b/gi, html);
  const headings = count(/<h[1-6]\b/gi, html);
  const mediaQueries = count(/@media\b/gi, css);
  const animations = count(/(@keyframes|transition\s*:|animation\s*:)/gi, css);
  const variables = count(/--[\w-]+\s*:/g, css);
  const gradients = count(/(?:linear|radial)-gradient\(/gi, css);
  const grids = count(/display\s*:\s*(?:grid|flex)/gi, css);
  const focus = count(/:focus(?:-visible)?/gi, css);
  const altMissing = count(/<img\b(?![^>]*\balt=)[^>]*>/gi, html);
  const labels = count(/<(label\b|input\b[^>]*aria-label=|button\b[^>]*aria-label=)/gi, html);
  const localRefs = refs(html).filter(x => !/^(?:https?:|data:|#|mailto:|tel:|javascript:)/i.test(x));

  if (!/<!doctype html>/i.test(html)) issues.push('missing HTML doctype');
  if (!/<meta\b[^>]*name=["']viewport["']/i.test(html)) issues.push('missing responsive viewport');
  if (!/<title>[^<]{2,}<\/title>/i.test(html)) issues.push('missing meaningful page title');
  if (html.length < 1500) issues.push('page is too thin for a complete frontend');
  if (!css.trim() && !externalCss) issues.push('no visual styling is attached');
  if (semantic < 3) issues.push('insufficient semantic page structure');
  if (headings < 2) issues.push('weak information hierarchy');
  if (grids < 1) issues.push('no responsive grid or flex layout');
  if (mediaQueries < 1 && !/tailwindcss|bootstrap/i.test(html)) issues.push('no mobile breakpoint strategy');
  if (variables < 3 && !/tailwindcss|bootstrap/i.test(html)) warnings.push('design tokens are sparse');
  if (interactive && !scripts.trim() && !/href=["'](?!#)/i.test(html)) issues.push('interactive controls have no visible behavior');
  if (interactive && animations < 1) warnings.push('interactive elements lack motion feedback');
  if (interactive && focus < 1 && !/tailwindcss|bootstrap/i.test(html)) warnings.push('keyboard focus styling is not explicit');
  if (images && altMissing) issues.push(`${altMissing} image(s) lack alt text`);
  if (/<form\b/i.test(html) && labels < 1) issues.push('form controls lack accessible labels');
  if (/TODO|lorem ipsum|placeholder text|your (?:logo|company|content) here/i.test(html)) issues.push('placeholder content remains');
  if (/<script\b[^>]*src=["']["']/i.test(html) || /<link\b[^>]*href=["']["']/i.test(html)) issues.push('empty asset reference');
  const frontendIntent = /\b(frontend|website|landing page|web app|dashboard|portfolio|ui|ux)\b/i.test(task);
  if (frontendIntent && images < 1 && gradients < 1) warnings.push('no imagery or graphic visual treatment');
  const score = Math.max(0, Math.min(100, 100 - issues.length * 18 - warnings.length * 4));
  return { ok: issues.length === 0 && score >= 72, score, issues, warnings, metrics: { bytes: Buffer.byteLength(html), semantic, interactive, images, headings, mediaQueries, animations, variables, gradients, grids, localRefs: localRefs.length }, filename: path.basename(filename) };
}
module.exports = { inspectHtml, refs };
