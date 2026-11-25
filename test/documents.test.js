/**
 * Phase 04.3 — Zara documents: Markdown parsing, PDF / DOCX / PPTX rendering,
 * reading files back (PDF, DOCX, PPTX, CSV, TXT) and the /api/documents routes.
 * Run with: node test/documents.test.js
 */

const assert = require('assert');
const express = require('express');

const { parseMarkdown, splitTitle, cleanModelMarkdown, fileStem } = require('../src/documents/markdown');
const { renderDocument, blocksToSlides, pdfSafe } = require('../src/documents/render');
const { fileToMarkdown } = require('../src/documents/extract');
const { createDocumentsRouter } = require('../src/documents/routes');

const SAMPLE = `# Quarterly Plan

A short plan for the quarter.

## Goals

- Grow **revenue** by 20%
- Hire *two* reps
  - one in Chennai

1. First
2. Second

## Numbers

| Region | Target |
|---|---|
| South | 40 |
| North | 25 |

Notes: open strong

## Next steps

Talk to the team.`;

const asFile = (name, buffer) => ({ name, dataUrl: `data:application/octet-stream;base64,${buffer.toString('base64')}` });

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.stack}`);
    process.exitCode = 1;
  }
}

(async () => {
  console.log('markdown');
  await test('parses headings, lists, tables and inline styles', () => {
    const blocks = parseMarkdown(SAMPLE);
    const types = blocks.map((b) => b.type);
    assert.deepStrictEqual(types.slice(0, 4), ['heading', 'paragraph', 'heading', 'bullet']);
    const bullet = blocks.find((b) => b.type === 'bullet');
    assert.deepStrictEqual(bullet.runs.map((r) => !!r.bold), [false, true, false]);
    assert.strictEqual(blocks.find((b) => b.type === 'bullet' && b.level === 1).runs[0].text, 'one in Chennai');
    const table = blocks.find((b) => b.type === 'table');
    assert.strictEqual(table.rows.length, 3);
  });
  await test('splits the title and cleans model output', () => {
    const { title, blocks } = splitTitle(parseMarkdown(SAMPLE));
    assert.strictEqual(title, 'Quarterly Plan');
    assert.ok(!blocks.some((b) => b.type === 'heading' && b.level === 1));
    assert.strictEqual(cleanModelMarkdown('<think>x</think>```markdown\n# Hi\n```'), '# Hi');
    assert.strictEqual(fileStem('Q4: Sales / Plan!'), 'Q4-Sales-Plan');
  });
  await test('PDF text keeps WinAnsi characters and maps the rest', () => {
    assert.strictEqual(pdfSafe('₹100 → “ok” 😀'), 'Rs.100 -> “ok” ');
  });
  await test('slides: one per H2, notes extracted, crowded slides split', () => {
    const { subtitle, slides } = blocksToSlides(splitTitle(parseMarkdown(SAMPLE)).blocks);
    assert.strictEqual(subtitle, 'A short plan for the quarter.');
    assert.deepStrictEqual(slides.map((s) => s.title), ['Goals', 'Numbers', 'Next steps']);
    assert.deepStrictEqual(slides[1].notes, ['open strong']);
    const many = Array.from({ length: 10 }, (_, i) => `- item ${i}`).join('\n');
    const split = blocksToSlides(parseMarkdown(`## Big\n\n${many}`)).slides;
    assert.deepStrictEqual(split.map((s) => s.title), ['Big', 'Big (cont.)']);
  });

  console.log('render + read back');
  const files = {};
  for (const format of ['pdf', 'docx', 'pptx']) {
    await test(`renders ${format}`, async () => {
      const r = await renderDocument({ markdown: SAMPLE, format });
      assert.strictEqual(r.filename, `Quarterly-Plan.${format}`);
      assert.ok(r.buffer.length > 1000);
      const magic = r.buffer.slice(0, 4).toString('latin1');
      assert.strictEqual(magic, format === 'pdf' ? '%PDF' : 'PK\u0003\u0004');
      files[format] = r.buffer;
    });
  }
  await test('rejects unknown formats', async () => {
    await assert.rejects(renderDocument({ markdown: '# x', format: 'xls' }), /Unsupported format/);
  });
  await test('reads a PDF back: title, headings, lists, table, no footer', async () => {
    const r = await fileToMarkdown(asFile('plan.pdf', files.pdf));
    assert.strictEqual(r.kind, 'pdf');
    assert.strictEqual(r.title, 'Quarterly Plan');
    assert.strictEqual(r.pages, 1);
    assert.match(r.markdown, /^## Goals$/m);
    assert.match(r.markdown, /^- Grow revenue by 20%$/m);
    assert.match(r.markdown, /^ {2}- one in Chennai$/m);
    assert.match(r.markdown, /^\| Region \| Target \|$/m);
    assert.match(r.markdown, /^\| North \| 25 \|$/m);
    assert.doesNotMatch(r.markdown, /Page 1 of 1/);
  });
  await test('PDF → Word round trip', async () => {
    const md = (await fileToMarkdown(asFile('plan.pdf', files.pdf))).markdown;
    const r = await renderDocument({ markdown: md, format: 'docx' });
    const back = await fileToMarkdown(asFile('plan.docx', r.buffer));
    assert.match(back.markdown, /Grow revenue by 20%/);
    assert.match(back.markdown, /\| South \| 40 \|/);
  });
  await test('drops headers/footers repeated on many pages and joins paragraphs across pages', async () => {
    const long = Array.from({ length: 40 }, (_, i) => `## Section ${i + 1}\n\n${'This sentence repeats to fill the page with text. '.repeat(8)}`).join('\n\n');
    const r = await renderDocument({ markdown: `# Long Report\n\n${long}`, format: 'pdf' });
    const back = await fileToMarkdown(asFile('long.pdf', r.buffer));
    assert.ok(back.pages >= 3, `expected 3+ pages, got ${back.pages}`);
    assert.doesNotMatch(back.markdown, /Page \d+ of \d+/);
    assert.match(back.markdown, /^## Section 40$/m);
  });
  await test('blank / scanned PDF gives a clear error', async () => {
    // A page with no text at all, like a scanned image.
    const PDFDocument = require('pdfkit');
    const empty = await new Promise((resolve) => {
      const d = new PDFDocument();
      const chunks = [];
      d.on('data', (c) => chunks.push(c));
      d.on('end', () => resolve(Buffer.concat(chunks)));
      d.end();
    });
    await assert.rejects(fileToMarkdown(asFile('scan.pdf', empty)), /scanned image/);
  });
  await test('damaged PDF gives a clear error', async () => {
    await assert.rejects(fileToMarkdown(asFile('bad.pdf', Buffer.from('not a pdf at all'))), /could not be read as a PDF/);
  });
  await test('reads DOCX, PPTX, CSV and TXT', async () => {
    const docx = await fileToMarkdown(asFile('plan.docx', files.docx));
    assert.match(docx.markdown, /^# Quarterly Plan/);
    assert.match(docx.markdown, /^1\. First$/m);
    const pptx = await fileToMarkdown(asFile('deck.pptx', files.pptx));
    assert.match(pptx.markdown, /^## Goals$/m);
    const csv = await fileToMarkdown(asFile('t.csv', Buffer.from('a,b\n1,2')));
    assert.match(csv.markdown, /\| 1 \| 2 \|/);
    const txt = await fileToMarkdown(asFile('note.txt', Buffer.from('hello')));
    assert.strictEqual(txt.markdown, '# note\n\nhello');
  });
  await test('old .doc files are refused with a hint', async () => {
    await assert.rejects(fileToMarkdown(asFile('a.doc', Buffer.from('x'))), /Save it as \.docx/);
  });

  console.log('routes');
  const llm = { sendMessage: async () => ({ content: '```markdown\n# AI Deck\n\nSubtitle.\n\n## One\n\n- a\n- b\n```' }) };
  const app = express();
  app.use(express.json({ limit: '32mb' }));
  app.use((req, _res, next) => { if (req.headers['x-anon'] !== '1') { req.user = { id: 'u1' }; req.authUid = 'u1'; } next(); });
  app.use('/api/documents', createDocumentsRouter({ llm }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/documents`;
  const post = async (p, body, headers = {}) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  await test('POST /create renders the model output', async () => {
    const r = await post('/create', { format: 'pptx', prompt: 'a deck about AI' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.filename, 'AI-Deck.pptx');
    assert.ok(Buffer.from(r.body.data, 'base64').length === r.body.size);
  });
  await test('POST /convert turns an attached PDF into Word', async () => {
    const r = await post('/convert', { format: 'docx', file: asFile('plan.pdf', files.pdf) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.filename, 'Quarterly-Plan.docx');
  });
  await test('POST /extract returns markdown and page count for a PDF', async () => {
    const r = await post('/extract', { file: asFile('plan.pdf', files.pdf) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.pages, 1);
    assert.match(r.body.markdown, /## Numbers/);
  });
  await test('validation and sign-in', async () => {
    assert.strictEqual((await post('/convert', { format: 'xls', text: 'x' })).status, 400);
    assert.strictEqual((await post('/create', { format: 'pdf', prompt: '' })).status, 400);
    assert.strictEqual((await post('/convert', { format: 'pdf' })).status, 400);
    assert.strictEqual((await post('/create', { format: 'pdf', prompt: 'x' }, { 'x-anon': '1' })).status, 401);
  });
  server.close();

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
