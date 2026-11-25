/**
 * Tiny Markdown → block model shared by the PDF, DOCX and PPTX renderers.
 *
 * Zara (and the user) write documents as Markdown. Every renderer works from
 * the same blocks, so a document looks the same in each format:
 *   { type: 'heading', level: 1-6, runs }
 *   { type: 'paragraph', runs }
 *   { type: 'bullet' | 'number', level: 0-2, runs, n? }
 *   { type: 'code', text }
 *   { type: 'quote', runs }
 *   { type: 'table', rows: [[runs, ...], ...] }   (first row = header)
 *   { type: 'rule' }
 * A run is { text, bold?, italic?, code? }.
 */

/** Strip model chatter: <think> blocks and a wrapping ```markdown fence. */
function cleanModelMarkdown(raw) {
  let s = String(raw || '').replace(/\r\n?/g, '\n');
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '');
  const fence = s.match(/^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fence) s = fence[1];
  return s.trim();
}

/** Inline Markdown → runs. Handles **bold**, *italic*, _italic_, `code`, [text](url). */
function parseInline(text) {
  const src = String(text || '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images → alt text
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)') // links → "text (url)"
    .replace(/<br\s*\/?>/gi, ' ');
  const runs = [];
  const re = /(\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|`[^`]+`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m.index > last) runs.push({ text: src.slice(last, m.index) });
    const tok = m[0];
    if (tok.startsWith('***')) runs.push({ text: tok.slice(3, -3), bold: true, italic: true });
    else if (tok.startsWith('**') || tok.startsWith('__')) runs.push({ text: tok.slice(2, -2), bold: true });
    else if (tok.startsWith('`')) runs.push({ text: tok.slice(1, -1), code: true });
    else runs.push({ text: tok.slice(1, -1), italic: true });
    last = m.index + tok.length;
  }
  if (last < src.length) runs.push({ text: src.slice(last) });
  return runs.filter((r) => r.text);
}

function runsText(runs) {
  return (runs || []).map((r) => r.text).join('');
}

function isTableRow(line) {
  return /^\s*\|.*\|\s*$/.test(line);
}
function isTableDivider(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}
function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => parseInline(c.trim()));
}

function parseMarkdown(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  const flush = () => {
    if (para.length) {
      blocks.push({ type: 'paragraph', runs: parseInline(para.join(' ')) });
      para = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();

    if (!t) { flush(); continue; }

    // Fenced code
    if (/^```/.test(t)) {
      flush();
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }

    // Table: header row followed by a divider row
    if (isTableRow(line) && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      flush();
      const rows = [splitRow(line)];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) rows.push(splitRow(lines[i++]));
      i--;
      blocks.push({ type: 'table', rows });
      continue;
    }

    let m;
    if ((m = t.match(/^(#{1,6})\s+(.*?)\s*#*$/))) {
      flush();
      blocks.push({ type: 'heading', level: m[1].length, runs: parseInline(m[2]) });
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flush(); blocks.push({ type: 'rule' }); continue; }

    const indent = line.match(/^\s*/)[0].replace(/\t/g, '  ').length;
    const level = Math.min(2, Math.floor(indent / 2));
    if ((m = line.match(/^\s*[-*+•]\s+(.*)$/))) {
      flush();
      blocks.push({ type: 'bullet', level, runs: parseInline(m[1].replace(/^\[[ xX]\]\s*/, '')) });
      continue;
    }
    if ((m = line.match(/^\s*(\d+)[.)]\s+(.*)$/))) {
      flush();
      blocks.push({ type: 'number', level, n: Number(m[1]), runs: parseInline(m[2]) });
      continue;
    }
    if ((m = t.match(/^>\s?(.*)$/))) {
      flush();
      blocks.push({ type: 'quote', runs: parseInline(m[1]) });
      continue;
    }
    para.push(t);
  }
  flush();
  return blocks;
}

/** Title = first H1 (removed from the body), else the given fallback. */
function splitTitle(blocks, fallback = 'Document') {
  const idx = blocks.findIndex((b) => b.type === 'heading' && b.level === 1);
  if (idx === -1) return { title: fallback, blocks };
  const title = runsText(blocks[idx].runs).trim() || fallback;
  return { title, blocks: blocks.filter((_, i) => i !== idx) };
}

/** Safe file name stem from a title. */
function fileStem(title) {
  const s = String(title || 'document')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
    .replace(/-+$/, '');
  return s || 'document';
}

module.exports = { cleanModelMarkdown, parseInline, parseMarkdown, runsText, splitTitle, fileStem };
