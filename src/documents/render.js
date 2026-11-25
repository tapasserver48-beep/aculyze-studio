/**
 * Document renderers: block model (see markdown.js) → PDF / DOCX / PPTX buffers.
 * Pure JavaScript (pdfkit, docx, pptxgenjs), so they run the same locally and on
 * Render; no LibreOffice or headless browser is needed.
 */
const PDFDocument = require('pdfkit');
const docx = require('docx');
const PptxGenJS = require('pptxgenjs');
const { parseMarkdown, splitTitle, runsText, fileStem } = require('./markdown');

// Aurora theme: indigo primary.
const C = {
  primary: '4F46E5',
  primaryDark: '312E81',
  ink: '1F2937',
  muted: '6B7280',
  line: 'E5E7EB',
  soft: 'EEF2FF',
  code: 'F3F4F6',
};

const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function today() {
  return new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: process.env.APP_TIMEZONE || undefined });
}

/* ============================== PDF ============================== */

// pdfkit's built-in fonts only cover WinAnsi (Latin-1 + a few symbols).
// Map the common extras and drop anything else instead of printing garbage.
const PDF_MAP = { '₹': 'Rs.', '→': '->', '←': '<-', '⇒': '=>', '≥': '>=', '≤': '<=', '≠': '!=', '✓': '[x]', '✔': '[x]', '✗': '[ ]', '✘': '[ ]', '★': '*', '·': '·', '​': '', '­': '' };
const WINANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
function pdfSafe(s) {
  let out = '';
  for (const ch of String(s || '')) {
    if (PDF_MAP[ch] !== undefined) { out += PDF_MAP[ch]; continue; }
    const c = ch.codePointAt(0);
    if (c === 9) out += '    ';
    else if (c === 10 || (c >= 32 && c <= 126) || (c >= 160 && c <= 255) || WINANSI_EXTRA.includes(ch)) out += ch;
  }
  return out;
}

function pdfFont(run, base = {}) {
  if (run.code) return 'Courier';
  const bold = run.bold || base.bold;
  const italic = run.italic || base.italic;
  if (bold && italic) return 'Helvetica-BoldOblique';
  if (bold) return 'Helvetica-Bold';
  if (italic) return 'Helvetica-Oblique';
  return 'Helvetica';
}

function renderPdf({ title, blocks }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 64, bottom: 64, left: 60, right: 60 }, bufferPages: true, info: { Title: title, Creator: 'Zara AI by Aculyze' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const fullWidth = doc.page.width - left - doc.page.margins.right;
    const bottomLimit = () => doc.page.height - doc.page.margins.bottom;
    const ensure = (h) => { if (doc.y + h > bottomLimit()) doc.addPage(); };

    const writeRuns = (runs, { x, width, size = 11, color = C.ink, base = {}, lineGap = 3 }) => {
      const list = runs && runs.length ? runs : [{ text: ' ' }];
      list.forEach((run, i) => {
        const last = i === list.length - 1;
        doc.font(pdfFont(run, base)).fontSize(run.code ? size - 1 : size).fillColor('#' + color);
        const opts = { width, continued: !last, lineGap };
        if (i === 0) doc.text(pdfSafe(run.text), x, doc.y, opts);
        else doc.text(pdfSafe(run.text), opts);
      });
    };

    // Title block
    doc.font('Helvetica-Bold').fontSize(24).fillColor('#' + C.primaryDark).text(pdfSafe(title), left, doc.y, { width: fullWidth });
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9.5).fillColor('#' + C.muted).text(today(), { width: fullWidth });
    doc.moveDown(0.4);
    doc.moveTo(left, doc.y).lineTo(left + fullWidth, doc.y).lineWidth(2).strokeColor('#' + C.primary).stroke();
    doc.moveDown(1);

    let prev = null;
    for (const b of blocks) {
      if (b.type === 'heading') {
        const size = b.level <= 2 ? 16 : b.level === 3 ? 13 : 11.5;
        ensure(size * 3);
        if (prev) doc.moveDown(0.6);
        writeRuns(b.runs, { x: left, width: fullWidth, size, color: b.level <= 2 ? C.primaryDark : C.ink, base: { bold: true } });
        doc.moveDown(0.35);
      } else if (b.type === 'paragraph') {
        ensure(30);
        writeRuns(b.runs, { x: left, width: fullWidth });
        doc.moveDown(0.6);
      } else if (b.type === 'bullet' || b.type === 'number') {
        ensure(20);
        const indent = 16 + b.level * 18;
        const marker = b.type === 'bullet' ? (b.level ? '–' : '•') : `${b.n}.`;
        const y = doc.y;
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#' + C.primary).text(marker, left + indent - 16, y, { width: 16, lineBreak: false });
        doc.y = y;
        writeRuns(b.runs, { x: left + indent + 2, width: fullWidth - indent - 2 });
        doc.moveDown(0.25);
        const next = blocks[blocks.indexOf(b) + 1];
        if (!next || (next.type !== 'bullet' && next.type !== 'number')) doc.moveDown(0.4);
      } else if (b.type === 'code') {
        doc.font('Courier').fontSize(9.5);
        const text = pdfSafe(b.text) || ' ';
        const h = doc.heightOfString(text, { width: fullWidth - 20 }) + 16;
        ensure(Math.min(h, 200));
        const y = doc.y;
        doc.roundedRect(left, y, fullWidth, h, 4).fill('#' + C.code);
        doc.fillColor('#' + C.ink).text(text, left + 10, y + 8, { width: fullWidth - 20 });
        doc.y = y + h;
        doc.moveDown(0.6);
      } else if (b.type === 'quote') {
        ensure(30);
        const y = doc.y;
        writeRuns(b.runs, { x: left + 14, width: fullWidth - 14, color: C.muted, base: { italic: true } });
        doc.moveTo(left + 3, y).lineTo(left + 3, doc.y).lineWidth(3).strokeColor('#' + C.primary).stroke();
        doc.moveDown(0.6);
      } else if (b.type === 'rule') {
        ensure(20);
        doc.moveTo(left, doc.y).lineTo(left + fullWidth, doc.y).lineWidth(0.8).strokeColor('#' + C.line).stroke();
        doc.moveDown(0.8);
      } else if (b.type === 'table') {
        const cols = Math.max(...b.rows.map((r) => r.length));
        const colW = fullWidth / cols;
        const pad = 6;
        b.rows.forEach((row, ri) => {
          const header = ri === 0;
          doc.fontSize(10);
          const heights = Array.from({ length: cols }, (_, ci) => {
            doc.font(header ? 'Helvetica-Bold' : 'Helvetica');
            return doc.heightOfString(pdfSafe(runsText(row[ci] || [])) || ' ', { width: colW - pad * 2 });
          });
          const h = Math.max(...heights) + pad * 2;
          ensure(h);
          const y = doc.y;
          if (header) doc.rect(left, y, fullWidth, h).fill('#' + C.soft);
          else if (ri % 2 === 0) doc.rect(left, y, fullWidth, h).fill('#FAFAFB');
          for (let ci = 0; ci < cols; ci++) {
            doc.font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor('#' + (header ? C.primaryDark : C.ink));
            doc.text(pdfSafe(runsText(row[ci] || [])), left + ci * colW + pad, y + pad, { width: colW - pad * 2 });
          }
          doc.moveTo(left, y + h).lineTo(left + fullWidth, y + h).lineWidth(0.5).strokeColor('#' + C.line).stroke();
          doc.y = y + h;
        });
        doc.x = left;
        doc.moveDown(0.8);
      }
      prev = b;
    }

    // Footer: page numbers
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(8.5).fillColor('#' + C.muted)
        .text(`${pdfSafe(title)}  ·  Page ${i + 1} of ${range.count}`, left, doc.page.height - 40, { width: fullWidth, align: 'center', lineBreak: false });
      doc.page.margins.bottom = bottom;
    }
    doc.end();
  });
}

/* ============================== DOCX ============================== */

function docxRuns(runs, base = {}) {
  const list = runs && runs.length ? runs : [{ text: '' }];
  return list.map((r) => new docx.TextRun({
    text: r.text,
    bold: r.bold || base.bold,
    italics: r.italic || base.italic,
    font: r.code ? 'Consolas' : undefined,
    color: base.color,
    size: base.size,
  }));
}

async function renderDocx({ title, blocks }) {
  const { Paragraph, HeadingLevel, Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle, AlignmentType, Footer, PageNumber, TextRun } = docx;
  const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5];
  const children = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: title })] }),
    new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: today(), color: C.muted, size: 19 })], border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: C.primary, space: 6 } } }),
  ];

  let numberInstance = 0;
  let prevType = null;
  for (const b of blocks) {
    if (b.type === 'heading') {
      children.push(new Paragraph({ heading: HEADINGS[Math.min(b.level, 5) - 1] || HeadingLevel.HEADING_3, children: docxRuns(b.runs) }));
    } else if (b.type === 'paragraph') {
      children.push(new Paragraph({ spacing: { after: 160 }, children: docxRuns(b.runs) }));
    } else if (b.type === 'bullet') {
      children.push(new Paragraph({ bullet: { level: b.level }, children: docxRuns(b.runs) }));
    } else if (b.type === 'number') {
      if (prevType !== 'number' && prevType !== 'bullet') numberInstance++;
      children.push(new Paragraph({ numbering: { reference: 'zara-numbers', level: b.level, instance: numberInstance }, children: docxRuns(b.runs) }));
    } else if (b.type === 'code') {
      for (const line of String(b.text).split('\n')) {
        children.push(new Paragraph({ shading: { type: ShadingType.CLEAR, fill: C.code, color: 'auto' }, spacing: { after: 0 }, children: [new TextRun({ text: line || ' ', font: 'Consolas', size: 19 })] }));
      }
      children.push(new Paragraph({ children: [] }));
    } else if (b.type === 'quote') {
      children.push(new Paragraph({ indent: { left: 360 }, border: { left: { style: BorderStyle.SINGLE, size: 18, color: C.primary, space: 8 } }, children: docxRuns(b.runs, { italic: true, color: C.muted }) }));
    } else if (b.type === 'rule') {
      children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C.line, space: 4 } }, children: [] }));
    } else if (b.type === 'table') {
      const cols = Math.max(...b.rows.map((r) => r.length));
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: b.rows.map((row, ri) => new TableRow({
          tableHeader: ri === 0,
          children: Array.from({ length: cols }, (_, ci) => new TableCell({
            width: { size: Math.floor(100 / cols), type: WidthType.PERCENTAGE },
            shading: ri === 0 ? { type: ShadingType.CLEAR, fill: C.soft, color: 'auto' } : undefined,
            margins: { top: 80, bottom: 80, left: 100, right: 100 },
            children: [new Paragraph({ children: docxRuns(row[ci] || [], ri === 0 ? { bold: true, color: C.primaryDark } : {}) })],
          })),
        })),
      }));
      children.push(new Paragraph({ children: [] }));
    }
    prevType = b.type;
  }

  const numberLevels = [0, 1, 2].map((level) => ({
    level,
    format: ['decimal', 'lowerLetter', 'lowerRoman'][level],
    text: `%${level + 1}.`,
    alignment: AlignmentType.START,
    style: { paragraph: { indent: { left: 720 + level * 360, hanging: 360 } } },
  }));

  const document = new docx.Document({
    creator: 'Zara AI by Aculyze',
    title,
    styles: {
      default: { document: { run: { font: 'Calibri', size: 22, color: C.ink } } },
      paragraphStyles: [
        { id: 'Title', name: 'Title', basedOn: 'Normal', next: 'Normal', run: { size: 48, bold: true, color: C.primaryDark }, paragraph: { spacing: { after: 80 } } },
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 32, bold: true, color: C.primaryDark }, paragraph: { spacing: { before: 320, after: 120 } } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 26, bold: true, color: C.primary }, paragraph: { spacing: { before: 240, after: 100 } } },
        { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 23, bold: true, color: C.ink }, paragraph: { spacing: { before: 200, after: 80 } } },
      ],
    },
    numbering: { config: [{ reference: 'zara-numbers', levels: numberLevels }] },
    sections: [{
      properties: {},
      footers: {
        default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [`${title}  ·  Page `, PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], size: 17, color: C.muted })] })] }),
      },
      children,
    }],
  });
  return docx.Packer.toBuffer(document);
}

/* ============================== PPTX ============================== */

const MAX_ITEMS_PER_SLIDE = 7;

/** Group blocks into slides: every H2 starts one; H3 becomes a bold bullet. */
function blocksToSlides(blocks) {
  const slides = [];
  let subtitle = '';
  let cur = null;
  const hasH2 = blocks.some((b) => b.type === 'heading' && b.level === 2);

  for (const b of blocks) {
    const startsSlide = b.type === 'heading' && (hasH2 ? b.level === 2 : b.level <= 3);
    if (startsSlide) {
      cur = { title: runsText(b.runs), items: [], notes: [] };
      slides.push(cur);
      continue;
    }
    if (!cur) {
      if (!subtitle && b.type === 'paragraph') { subtitle = runsText(b.runs); continue; }
      cur = { title: '', items: [], notes: [] };
      slides.push(cur);
    }
    if (b.type === 'paragraph' && /^(speaker\s+)?notes?\s*:/i.test(runsText(b.runs))) {
      cur.notes.push(runsText(b.runs).replace(/^(speaker\s+)?notes?\s*:\s*/i, ''));
      continue;
    }
    cur.items.push(b);
  }

  // Split crowded slides; untitled ones get a numbered title.
  const out = [];
  for (const s of slides) {
    const textItems = s.items.filter((b) => b.type !== 'table' && b.type !== 'code' && b.type !== 'rule');
    const special = s.items.filter((b) => b.type === 'table' || b.type === 'code');
    if (textItems.length <= MAX_ITEMS_PER_SLIDE) {
      out.push({ ...s, items: textItems, special });
      continue;
    }
    for (let i = 0; i < textItems.length; i += MAX_ITEMS_PER_SLIDE) {
      out.push({ title: i ? `${s.title} (cont.)` : s.title, items: textItems.slice(i, i + MAX_ITEMS_PER_SLIDE), notes: i ? [] : s.notes, special: i ? [] : special });
    }
  }
  out.forEach((s, i) => { if (!s.title) s.title = `Slide ${i + 2}`; });
  return { subtitle, slides: out.filter((s) => s.items.length || s.special.length || s.title) };
}

async function renderPptx({ title, blocks }) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
  pptx.title = title;
  pptx.author = 'Zara AI by Aculyze';
  const W = 13.33;
  const { subtitle, slides } = blocksToSlides(blocks);

  // Title slide
  const t = pptx.addSlide();
  t.background = { color: C.primaryDark };
  t.addShape(pptx.ShapeType.ellipse, { x: 9.2, y: -1.6, w: 6, h: 6, fill: { color: C.primary, transparency: 35 }, line: { color: C.primary, transparency: 100 } });
  t.addShape(pptx.ShapeType.ellipse, { x: 10.8, y: 4.4, w: 4, h: 4, fill: { color: '818CF8', transparency: 60 }, line: { color: '818CF8', transparency: 100 } });
  t.addShape(pptx.ShapeType.rect, { x: 0.8, y: 3.05, w: 1.1, h: 0.08, fill: { color: 'A5B4FC' }, line: { color: 'A5B4FC', transparency: 100 } });
  t.addText(title, { x: 0.8, y: 1.3, w: 9, h: 1.7, fontSize: 40, bold: true, color: 'FFFFFF', fontFace: 'Calibri', valign: 'bottom', fit: 'shrink' });
  t.addText(subtitle || today(), { x: 0.8, y: 3.3, w: 8.5, h: 1.2, fontSize: 18, color: 'E0E7FF', fontFace: 'Calibri', valign: 'top' });

  slides.forEach((s, idx) => {
    const slide = pptx.addSlide();
    slide.background = { color: 'FFFFFF' };
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.18, h: 7.5, fill: { color: C.primary }, line: { color: C.primary, transparency: 100 } });
    slide.addText(s.title, { x: 0.7, y: 0.4, w: W - 1.4, h: 0.9, fontSize: 28, bold: true, color: C.primaryDark, fontFace: 'Calibri', valign: 'middle', fit: 'shrink' });
    slide.addShape(pptx.ShapeType.rect, { x: 0.7, y: 1.3, w: 0.9, h: 0.06, fill: { color: C.primary }, line: { color: C.primary, transparency: 100 } });

    let y = 1.65;
    const bodyH = 7.5 - y - 0.8;
    const hasSpecial = s.special && s.special.length;
    if (s.items.length) {
      const paras = [];
      s.items.forEach((b) => {
        const isList = b.type === 'bullet' || b.type === 'number';
        const isSub = b.type === 'heading';
        const runs = b.runs && b.runs.length ? b.runs : [{ text: ' ' }];
        // pptxgenjs starts a new paragraph at every run that carries `bullet`,
        // so paragraph-level options go on the first run only.
        runs.forEach((r, ri) => {
          const options = {
            bold: r.bold || isSub,
            italic: r.italic || b.type === 'quote',
            fontFace: r.code ? 'Consolas' : 'Calibri',
            color: isSub ? C.primary : C.ink,
            breakLine: ri === runs.length - 1,
          };
          if (ri === 0) {
            options.paraSpaceAfter = 8;
            if (isList || b.type === 'paragraph') {
              options.bullet = b.type === 'number' ? { type: 'number' } : { code: '25CF', indent: 22 };
              if (isList && b.level) options.indentLevel = b.level;
            }
          }
          paras.push({ text: r.text, options });
        });
      });
      const h = hasSpecial ? bodyH * 0.45 : bodyH;
      slide.addText(paras, { x: 0.7, y, w: W - 1.4, h, fontSize: 20, valign: 'top', fit: 'shrink', lineSpacingMultiple: 1.1 });
      y += h + 0.15;
    }
    (s.special || []).forEach((b) => {
      const h = 7.5 - y - 0.8;
      if (h < 0.6) return;
      if (b.type === 'table') {
        const rows = b.rows.map((row, ri) => row.map((cell) => ({
          text: runsText(cell),
          options: ri === 0 ? { bold: true, color: 'FFFFFF', fill: { color: C.primary } } : { color: C.ink, fill: { color: ri % 2 ? 'FFFFFF' : C.soft } },
        })));
        slide.addTable(rows, { x: 0.7, y, w: W - 1.4, fontSize: 14, fontFace: 'Calibri', border: { type: 'solid', pt: 0.5, color: C.line }, autoPage: false });
      } else {
        slide.addText(b.text, { x: 0.7, y, w: W - 1.4, h, fontSize: 13, fontFace: 'Consolas', color: C.ink, fill: { color: C.code }, valign: 'top', fit: 'shrink', margin: 10 });
      }
      y += h;
    });

    slide.addText(title, { x: 0.7, y: 6.95, w: 8, h: 0.35, fontSize: 10, color: C.muted, fontFace: 'Calibri' });
    slide.addText(String(idx + 2), { x: W - 1.5, y: 6.95, w: 0.8, h: 0.35, fontSize: 10, color: C.muted, fontFace: 'Calibri', align: 'right' });
    if (s.notes && s.notes.length) slide.addNotes(s.notes.join('\n'));
  });

  return pptx.write({ outputType: 'nodebuffer' });
}

/* ============================== entry ============================== */

/**
 * Render Markdown to a file.
 * @returns {Promise<{ buffer, filename, mime, title, format }>}
 */
async function renderDocument({ markdown, format, title: titleHint }) {
  const fmt = String(format || '').toLowerCase();
  if (!MIME[fmt]) throw new Error(`Unsupported format "${format}". Use pdf, docx or pptx.`);
  const parsed = parseMarkdown(markdown);
  const { title, blocks } = splitTitle(parsed, titleHint || 'Document');
  if (!blocks.length && !title) throw new Error('The document is empty.');
  const render = { pdf: renderPdf, docx: renderDocx, pptx: renderPptx }[fmt];
  const buffer = await render({ title, blocks });
  return { buffer, filename: `${fileStem(title)}.${fmt}`, mime: MIME[fmt], title, format: fmt };
}

module.exports = { renderDocument, blocksToSlides, pdfSafe, MIME };
