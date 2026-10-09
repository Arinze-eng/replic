// scripts/test-brain-pipeline.js
//
// End-to-end regression test for the canonical "DeepSeek as the brain"
// pipeline (services/brain.js + /api/brain endpoint).
//
// What this proves:
//   1. plain text         →  DeepSeek
//   2. PDF                →  OmniOCR (or pdf-parse)            → DeepSeek
//   3. image-with-text    →  OmniOCR Tesseract                 → DeepSeek
//   4. pure picture       →  Gemini vision                     → DeepSeek
//   5. DOCX               →  OmniOCR (or mammoth)              → DeepSeek
//   6. XLSX               →  OmniOCR (or xlsx)                 → DeepSeek
//   7. multi-file (PDF+image) → both extractors merged into one DeepSeek call
//
// Requires: tesseract-ocr, poppler-utils, python3 with the OmniOCR deps.
// Reads DEEPSEEK_TOKEN from env (or uses the configured admin/db token).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const brain = require('../services/brain');

function genFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain_pipe_'));
  const pdf = path.join(dir, 'sample.pdf');
  const imgT = path.join(dir, 'invoice.png');
  const imgP = path.join(dir, 'gradient.png');
  const docx = path.join(dir, 'memo.docx');
  const xlsx = path.join(dir, 'sales.xlsx');

  // Lazy: install reportlab if missing (test-only, never invoked in prod).
  try { execSync('python3 -c "import reportlab" 2>/dev/null'); }
  catch (_) { try { execSync('python3 -m pip install -q reportlab', { stdio: 'pipe' }); } catch (_) {} }

  execSync(`python3 -c "
from reportlab.pdfgen import canvas
c = canvas.Canvas('${pdf}')
c.drawString(72, 760, 'Q4 2026 Sales Report')
c.drawString(72, 730, 'Region: West')
c.drawString(72, 710, 'Total Revenue: USD 4,287,500')
c.drawString(72, 690, 'Top Product: Banana Pi 5 Cluster')
c.drawString(72, 670, 'Submitted by Arinze, CFO')
c.save()"`, { stdio: 'pipe' });

  execSync(`python3 -c "
from PIL import Image, ImageDraw, ImageFont
img = Image.new('RGB', (700, 200), 'white'); d = ImageDraw.Draw(img)
try: font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 28)
except: font = ImageFont.load_default()
d.text((20, 30), 'INVOICE #INV-2026-0420', fill='black', font=font)
d.text((20, 80), 'Customer: Arinze Industries', fill='black', font=font)
d.text((20, 130), 'Amount Due: 1,295.00 USD', fill='black', font=font)
img.save('${imgT}')"`, { stdio: 'pipe' });

  execSync(`python3 -c "
from PIL import Image
img = Image.new('RGB', (300, 300))
for y in range(300):
  for x in range(300): img.putpixel((x,y), (x%256, y%256, (x+y)%256))
img.save('${imgP}')"`, { stdio: 'pipe' });

  execSync(`python3 -c "
from docx import Document
d = Document(); d.add_heading('Project Banana Memorandum', 0)
d.add_paragraph('Subject: Quarterly review of operations.')
d.add_paragraph('Author: Arinze, Chief Banana Officer')
d.add_paragraph('Status: Active. Budget: 12,500,000 NGN.')
d.save('${docx}')"`, { stdio: 'pipe' });

  execSync(`python3 -c "
from openpyxl import Workbook
wb = Workbook(); ws = wb.active; ws.title = 'Sales'
ws.append(['Region','Q1','Q2','Q3','Q4'])
ws.append(['North',100,150,200,250])
ws.append(['South',80,90,110,140])
ws.append(['East',60,75,85,95])
wb.save('${xlsx}')"`, { stdio: 'pipe' });

  return { pdf, imgT, imgP, docx, xlsx };
}

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`✅ ${name}` + (detail ? ' — ' + detail : '')); }
  else    { fail++; console.log(`❌ ${name}` + (detail ? ' — ' + detail : '')); }
}

(async () => {
  console.log('▶ Generating fixtures…');
  const f = genFixtures();
  for (const k of ['pdf', 'imgT', 'imgP', 'docx', 'xlsx']) {
    check('fixture: ' + k, fs.existsSync(f[k]) && fs.statSync(f[k]).size > 0);
  }

  console.log('\n▶ Test 1: text-only → DeepSeek');
  let r = await brain.answer({ message: 'Reply with exactly the literal token PONG-TEXT and nothing else.' });
  check('text→DeepSeek brain', r.brain === 'deepseek');
  check('text→reply contains PONG-TEXT', /PONG-TEXT/i.test(r.reply));

  console.log('\n▶ Test 2: PDF → DeepSeek');
  r = await brain.answer({
    message: 'Who submitted the report and what was the total revenue?',
    files: [{ name: 'sample.pdf', buffer: fs.readFileSync(f.pdf) }],
  });
  check('PDF→extract not vision', r.used[0] && r.used[0].sentToVision === false);
  check('PDF→reply mentions Arinze', /Arinze/i.test(r.reply));
  check('PDF→reply mentions revenue', /4[,.]?287[,.]?500/.test(r.reply));

  console.log('\n▶ Test 3: image-with-text → OmniOCR → DeepSeek');
  r = await brain.answer({
    message: 'What is the invoice number and amount due?',
    files: [{ name: 'invoice.png', buffer: fs.readFileSync(f.imgT) }],
  });
  check('img-text→engine omni_ocr_image', r.used[0] && /omni_ocr_image/.test(r.used[0].engine));
  check('img-text→reply has invoice #', /INV[-]?2026[-]?0420/i.test(r.reply));
  check('img-text→reply has amount', /1[,.]?295/.test(r.reply));

  console.log('\n▶ Test 4: pure image → Gemini vision → DeepSeek');
  r = await brain.answer({
    message: 'Describe this image in one sentence.',
    files: [{ name: 'gradient.png', buffer: fs.readFileSync(f.imgP) }],
  });
  check('pure-img→sentToVision=true', r.used[0] && r.used[0].sentToVision === true);
  check('pure-img→engine gemini_vision', r.used[0] && r.used[0].engine === 'gemini_vision');
  check('pure-img→reply non-empty', r.reply && r.reply.length > 5);

  console.log('\n▶ Test 5: DOCX → DeepSeek');
  r = await brain.answer({
    message: 'Who is the author and what is the budget?',
    files: [{ name: 'memo.docx', buffer: fs.readFileSync(f.docx) }],
  });
  check('docx→reply mentions Banana Officer', /Banana Officer/i.test(r.reply));
  check('docx→reply mentions 12,500,000', /12[,.]?500[,.]?000/.test(r.reply));

  console.log('\n▶ Test 6: XLSX → DeepSeek');
  r = await brain.answer({
    message: 'What is the Q4 number for the South region? Answer with just the number.',
    files: [{ name: 'sales.xlsx', buffer: fs.readFileSync(f.xlsx) }],
  });
  check('xlsx→reply contains 140', /\b140\b/.test(r.reply));

  console.log('\n▶ Test 7: multi-file (PDF + image) → DeepSeek');
  r = await brain.answer({
    message: 'Summarize what each document says. Show total revenue and invoice amount due.',
    files: [
      { name: 'sample.pdf', buffer: fs.readFileSync(f.pdf) },
      { name: 'invoice.png', buffer: fs.readFileSync(f.imgT) },
    ],
  });
  check('multi→both files used', r.used.length === 2);
  check('multi→reply has revenue', /4[,.]?287[,.]?500/.test(r.reply));
  check('multi→reply has invoice', /1[,.]?295/.test(r.reply));

  console.log(`\n${fail === 0 ? '🎉 ALL PASSED' : '⚠️ FAILURES'} — ${pass} passed / ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
