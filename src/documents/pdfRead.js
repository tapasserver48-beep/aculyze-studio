/**
 * PDF → Markdown (Phase 04.3). Pure JavaScript (unpdf = serverless pdf.js),
 * so it runs on Render without native builds.
 *
 * pdf.js only gives positioned text runs, so structure is rebuilt with simple
 * layout rules:
 *   - runs on the same baseline form a line
 *   - lines much larger than the body text become headings (#, ##, ###)
 *   - lines starting with •, -, ▪ … become bullets; "1." / "a)" stay numbered
 *   - a vertical gap or a change of line type starts a new paragraph
 *   - text repeated at the top/bottom of most pages (headers, footers,
 *     "Page 3 of 9") is dropped
 * Inspired by advanced_llm_apps/chat_with_X_tutorials/chat_with_pdf in
 * Shubhamsaboo/awesome-llm-apps (Apache-2.0); no code copied.
 */

const MAX_PAGES = 300;
const MAX_CHARS = 400_000;

let unpdfPromise = null;
function loadUnpdf() {
  // unpdf is ESM-only; this project is CommonJS.
  if (!unpdfPromise) unpdfPromise = import('unpdf');
  return unpdfPromise;
}

const BULLET_RE = /^[•▪◦●○■□➢➤►▸‣⁃·*–-]\s+/;
const NUMBER_RE = /^(\(?\d{1,3}[.)]|\(?[a-z][.)])\s+/i;
const PAGE_NO_RE = /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i;
const PAGE_FOOTER_RE = /\bpage\s+\d{1,4}\s*(of|\/)\s*\d{1,4}\b/i;

/** Positioned text items of one page → lines (top to bottom). */
function itemsToLines(items) {
  const runs = items
    // Whitespace-only items are dropped: spaces are re-derived from the gaps, and
    // pdf.js sometimes reports a whole column gap as one wide " " item.
    .filter((it) => typeof it.str === 'string' && it.str.trim().length && it.transform)
    .map((it) => ({
      str: it.str,
      x: it.transform[4],
      y: it.transform[5],
      w: it.width || 0,
      size: Math.abs(it.height || it.transform[3] || 0) || Math.abs(it.transform[0]) || 10,
    }));
  runs.sort((a, b) => b.y - a.y || a.x - b.x);

  const lines = [];
  for (const r of runs) {
    const tol = Math.max(2, r.size * 0.35);
    const line = lines.find((l) => Math.abs(l.y - r.y) <= tol);
    if (line) line.runs.push(r);
    else lines.push({ y: r.y, runs: [r] });
  }
  return lines
    .sort((a, b) => b.y - a.y)
    .map((l) => {
      l.runs.sort((a, b) => a.x - b.x);
      // Wide gaps split the line into cells (table columns); small gaps are spaces.
      const cells = [{ x: l.runs[0].x, text: '' }];
      let end = null;
      for (const r of l.runs) {
        const cell = cells[cells.length - 1];
        if (end !== null) {
          const gap = r.x - end;
          if (gap > r.size * 1.5) {
            cells.push({ x: r.x, text: r.str });
            end = r.x + r.w;
            continue;
          }
          // A visible gap between runs means a space (pdf.js often omits it).
          if (gap > r.size * 0.2 && !cell.text.endsWith(' ') && !r.str.startsWith(' ')) cell.text += ' ';
        }
        cell.text += r.str;
        end = r.x + r.w;
      }
      cells.forEach((c) => { c.text = c.text.trim(); });
      const kept = cells.filter((c) => c.text);
      const size = Math.max(...l.runs.map((r) => r.size));
      return { y: l.y, x: l.runs[0].x, size, cells: kept, text: kept.map((c) => c.text).join(' ') };
    })
    .filter((l) => l.text);
}

/** Most common font size, weighted by characters = body text size. */
function bodySize(pages) {
  const weight = new Map();
  for (const lines of pages) {
    for (const l of lines) {
      const k = Math.round(l.size * 2) / 2;
      weight.set(k, (weight.get(k) || 0) + l.text.length);
    }
  }
  let best = 10;
  let max = -1;
  for (const [k, w] of weight) if (w > max) { max = w; best = k; }
  return best;
}

/** Lines repeated at the top or bottom of most pages (headers / footers). */
function repeatedEdges(pages) {
  if (pages.length < 3) return new Set();
  const norm = (s) => s.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const counts = new Map();
  for (const lines of pages) {
    const edge = new Set([...lines.slice(0, 2), ...lines.slice(-2)].map((l) => norm(l.text)));
    for (const k of edge) counts.set(k, (counts.get(k) || 0) + 1);
  }
  const out = new Set();
  for (const [k, c] of counts) if (c >= Math.max(3, pages.length * 0.5)) out.add(k);
  return out;
}

function classify(line, body) {
  const t = line.text;
  const ratio = line.size / body;
  const short = t.length <= 120 && !/[.:;,]$/.test(t);
  if (ratio >= 1.6 && short) return { kind: 'h1', text: t };
  if (ratio >= 1.25 && short) return { kind: 'h2', text: t };
  if (ratio >= 1.1 && short && t.length <= 80) return { kind: 'h3', text: t };
  if (BULLET_RE.test(t)) return { kind: 'bullet', text: t.replace(BULLET_RE, '') };
  if (NUMBER_RE.test(t)) return { kind: 'number', text: t };
  return { kind: 'text', text: t };
}

function linesToMarkdown(pages, body) {
  const edges = repeatedEdges(pages);
  const norm = (s) => s.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const out = [];
  let para = null; // { kind, text, lastY, size, x }
  const flush = () => {
    if (!para) return;
    const t = para.text.trim();
    if (t) {
      if (para.kind === 'h1') out.push(`# ${t}`);
      else if (para.kind === 'h2') out.push(`## ${t}`);
      else if (para.kind === 'h3') out.push(`### ${t}`);
      else if (para.kind === 'bullet') out.push(`${para.indent ? '  ' : ''}- ${t}`);
      else if (para.kind === 'number') out.push(t);
      else out.push(t);
    }
    para = null;
  };

  // Same number of cells (2+) with matching column positions on consecutive lines = a table.
  const sameColumns = (a, b) => a.cells.length === b.cells.length
    && a.cells.every((c, i) => Math.abs(c.x - b.cells[i].x) <= Math.max(12, a.size));

  pages.forEach((lines, pi) => {
    const leftMargin = lines.length ? Math.min(...lines.map((l) => l.x)) : 0;
    let skipTo = -1;
    lines.forEach((line, li) => {
      if (li <= skipTo) return;
      const atEdge = li < 2 || li >= lines.length - 2;
      if (atEdge && (edges.has(norm(line.text)) || PAGE_NO_RE.test(line.text) || (PAGE_FOOTER_RE.test(line.text) && line.text.length < 120))) return;
      if (line.cells.length >= 2 && line.cells.length <= 8) {
        let end = li;
        while (end + 1 < lines.length && sameColumns(line, lines[end + 1]) && lines[end].y - lines[end + 1].y < line.size * 4) end++;
        if (end > li) {
          flush();
          const rows = lines.slice(li, end + 1).map((l) => l.cells.map((c) => c.text.replace(/\|/g, '/')));
          out.push([`| ${rows[0].join(' | ')} |`, `|${rows[0].map(() => '---').join('|')}|`, ...rows.slice(1).map((r) => `| ${r.join(' | ')} |`)].join('\n'));
          skipTo = end;
          return;
        }
      }
      const c = classify(line, body);
      const gap = para && para.page === pi ? para.lastY - line.y : Infinity;
      const lineH = Math.max(line.size, para ? para.size : 0) * 1.25;
      const continues = para
        && gap < lineH * 1.45
        && (para.kind === c.kind || ((para.kind === 'bullet' || para.kind === 'number') && c.kind === 'text' && line.x > para.x + 2))
        && !(c.kind === 'bullet' || c.kind === 'number'); // each list marker starts a new item
      // A paragraph can also carry over a page break when the last line had no ending punctuation.
      const carries = para && para.page !== pi && para.kind === 'text' && c.kind === 'text' && !/[.!?:"”)]$/.test(para.text);
      if ((continues || carries) && !c.kind.startsWith('h')) {
        para.text = para.text.endsWith('-') && /^[a-z]/.test(c.text) ? para.text.slice(0, -1) + c.text : `${para.text} ${c.text}`;
        para.lastY = line.y;
        para.page = pi;
        return;
      }
      if (continues && c.kind.startsWith('h') && para.kind === c.kind) {
        para.text += ` ${c.text}`; // heading wrapped onto two lines
        para.lastY = line.y;
        return;
      }
      flush();
      para = { kind: c.kind, text: c.text, lastY: line.y, size: line.size, x: line.x, page: pi, indent: c.kind === 'bullet' && line.x > leftMargin + 12 };
    });
  });
  flush();

  // Blank line between blocks, list items kept together.
  const md = [];
  out.forEach((l, i) => {
    const item = /^\s*(- |\(?\d{1,3}[.)] |\(?[a-z][.)] )/i.test(l);
    const prevItem = i > 0 && /^\s*(- |\(?\d{1,3}[.)] |\(?[a-z][.)] )/i.test(out[i - 1]);
    if (i > 0 && !(item && prevItem)) md.push('');
    md.push(l);
  });
  return md.join('\n');
}

/**
 * @param {Buffer} buffer PDF bytes
 * @param {string} fallbackTitle used when the PDF has no title heading
 * @returns {Promise<{ markdown, title, pages, chars, truncated }>}
 */
async function pdfToMarkdown(buffer, fallbackTitle = 'Document') {
  const { getDocumentProxy } = await loadUnpdf();
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buffer));
  } catch (err) {
    if (/password/i.test(`${err && err.name} ${err && err.message}`)) throw new Error('This PDF is password-protected. Remove the password and attach it again.');
    throw new Error('This file could not be read as a PDF. It may be damaged.');
  }

  const total = pdf.numPages;
  const count = Math.min(total, MAX_PAGES);
  const pages = [];
  let chars = 0;
  for (let i = 1; i <= count; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const lines = itemsToLines(tc.items);
    pages.push(lines);
    chars += lines.reduce((n, l) => n + l.text.length, 0);
    if (chars > MAX_CHARS) break;
  }
  if (typeof pdf.destroy === 'function') pdf.destroy().catch(() => {});

  if (chars < 20) {
    throw new Error('This PDF has no readable text: it looks like a scanned image. Scanned PDFs (OCR) are not supported yet.');
  }

  let markdown = linesToMarkdown(pages, bodySize(pages));
  const truncated = pages.length < total;
  if (truncated) markdown += `\n\n> Only the first ${pages.length} of ${total} pages were read.`;
  if (markdown.length > MAX_CHARS) markdown = markdown.slice(0, MAX_CHARS);

  const firstLine = markdown.trim().split('\n')[0] || '';
  const title = /^#\s/.test(firstLine) ? firstLine.replace(/^#\s+/, '').trim() : fallbackTitle;
  if (!/^#\s/.test(firstLine)) markdown = `# ${fallbackTitle}\n\n${markdown}`;
  return { markdown, title, pages: total, chars, truncated };
}

module.exports = { pdfToMarkdown, itemsToLines, linesToMarkdown, bodySize };
