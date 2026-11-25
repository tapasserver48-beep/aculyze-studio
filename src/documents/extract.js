/**
 * Read an uploaded file into Markdown so it can be converted to another format
 * (DOCX → PDF, PPTX → DOCX, TXT → PPTX, ...). Supported inputs:
 * .pdf (unpdf), .docx (mammoth), .pptx (slide XML), .md / .markdown, .txt, .csv, .html.
 */
const path = require('path');

const MAX_FILE_BYTES = 15 * 1024 * 1024;

function decodeDataUrl(dataUrl) {
  const m = String(dataUrl || '').match(/^data:([^;,]*)(;base64)?,(.*)$/s);
  if (!m) throw new Error('The file could not be read.');
  const buffer = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  if (buffer.length > MAX_FILE_BYTES) throw new Error('The file is larger than 15 MB.');
  return { mime: m[1] || '', buffer };
}

const xmlText = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

async function pptxToMarkdown(buffer, title) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  const out = [`# ${title}`, ''];
  for (const f of slideFiles) {
    const xml = await zip.file(f).async('string');
    const paras = (xml.match(/<a:p>[\s\S]*?<\/a:p>/g) || [])
      .map((p) => xmlText((p.match(/<a:t>([^<]*)<\/a:t>/g) || []).map((t) => t.replace(/<\/?a:t>/g, '')).join('')).trim())
      .filter(Boolean);
    if (!paras.length) continue;
    out.push(`## ${paras[0]}`, '');
    paras.slice(1).forEach((p) => out.push(`- ${p}`));
    out.push('');
  }
  return out.join('\n');
}

const decodeEntities = (s) => s
  .replace(/&nbsp;/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** Inline HTML → Markdown text (bold/italic kept, other tags dropped). */
function inlineMd(html) {
  return decodeEntities(String(html || '')
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => (t.trim() ? `**${t.trim()}**` : ''))
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => (t.trim() ? `*${t.trim()}*` : ''))
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function tableToMarkdown(tableHtml) {
  const rows = (tableHtml.match(/<tr\b[\s\S]*?<\/tr>/gi) || []).map((tr) =>
    (tr.match(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi) || []).map((td) =>
      inlineMd(td.replace(/^<t[dh]\b[^>]*>|<\/t[dh]>$/gi, '')).replace(/\*\*/g, '').replace(/\|/g, '/')));
  if (!rows.length) return '';
  const cols = Math.max(...rows.map((r) => r.length));
  const line = (r) => `| ${Array.from({ length: cols }, (_, i) => r[i] || '').join(' | ')} |`;
  return `\n\n${line(rows[0])}\n|${Array(cols).fill('---').join('|')}|\n${rows.slice(1).map(line).join('\n')}\n\n`;
}

/** Block-level HTML (mammoth / simple pages) → Markdown, keeping nested and numbered lists. */
function htmlToMarkdown(html) {
  let s = String(html || '')
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<table\b[\s\S]*?<\/table>/gi, (t) => tableToMarkdown(t));

  const out = [];
  const lists = []; // stack of { type: 'ul'|'ol', n }
  const re = /<(\/?)(h[1-6]|p|li|ul|ol|blockquote|pre|div|tr)\b[^>]*>/gi;
  let last = 0;
  let pending = ''; // text of the block being collected
  let blockStart = null; // the opening tag that started `pending`
  const flush = () => {
    const raw = pending;
    pending = '';
    const start = blockStart;
    blockStart = null;
    if (start === 'pre') { if (raw.trim()) out.push('```\n' + decodeEntities(raw.replace(/<[^>]+>/g, '')) + '\n```'); return; }
    // Table Markdown produced above passes through untouched.
    if (/^\s*\|/.test(raw)) { out.push(raw.trim()); return; }
    const text = inlineMd(raw);
    if (!text) return;
    if (start && /^h[1-6]$/.test(start)) out.push(`${'#'.repeat(Number(start[1]))} ${text.replace(/\*\*/g, '')}`);
    else if (start === 'li') {
      const depth = Math.max(0, lists.length - 1);
      const top = lists[lists.length - 1];
      const marker = top && top.type === 'ol' ? `${++top.n}.` : '-';
      out.push(`${'  '.repeat(depth)}${marker} ${text}`);
    } else if (start === 'blockquote') out.push(`> ${text}`);
    else out.push(text);
  };

  let m;
  while ((m = re.exec(s))) {
    pending += s.slice(last, m.index);
    last = m.index + m[0].length;
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (tag === 'ul' || tag === 'ol') {
      flush();
      if (closing) lists.pop(); else lists.push({ type: tag, n: 0 });
      continue;
    }
    if (tag === 'tr') continue;
    flush();
    if (!closing) blockStart = tag;
  }
  pending += s.slice(last);
  flush();

  // Blank line between blocks, but keep list items together.
  const md = [];
  out.forEach((line, i) => {
    const isItem = /^\s*(-|\d+\.)\s/.test(line);
    const prevItem = i > 0 && /^\s*(-|\d+\.)\s/.test(out[i - 1]);
    if (i > 0 && !(isItem && prevItem)) md.push('');
    md.push(line);
  });
  return md.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const MAMMOTH_STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Subtitle'] => h2:fresh",
];

/** Make sure the Markdown opens with an H1 title. */
function withTitle(md, title) {
  const firstLine = String(md || '').trim().split('\n')[0] || '';
  return /^#\s/.test(firstLine) ? md : `# ${title}\n\n${md}`;
}

/** Plain text → Markdown: keep the author's line breaks as paragraphs. */
function textToMarkdown(text, title) {
  const body = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (/^#\s/m.test(body)) return body; // already Markdown with a title
  return `# ${title}\n\n${body}`;
}

/**
 * @param {{ name: string, dataUrl: string }} file
 * @returns {Promise<{ markdown: string, title: string, kind: string }>}
 */
async function fileToMarkdown(file) {
  if (!file || !file.dataUrl) throw new Error('No file was attached.');
  const name = String(file.name || 'document');
  const ext = path.extname(name).toLowerCase();
  const title = path.basename(name, ext).replace(/[_-]+/g, ' ').trim() || 'Document';
  const { buffer } = decodeDataUrl(file.dataUrl);

  if (ext === '.docx') {
    const mammoth = require('mammoth');
    const { value } = await mammoth.convertToHtml({ buffer }, { styleMap: MAMMOTH_STYLE_MAP });
    return { markdown: withTitle(htmlToMarkdown(value), title), title, kind: 'docx' };
  }
  if (ext === '.pptx') return { markdown: await pptxToMarkdown(buffer, title), title, kind: 'pptx' };
  if (ext === '.html' || ext === '.htm') return { markdown: withTitle(htmlToMarkdown(buffer.toString('utf8')), title), title, kind: 'html' };
  if (ext === '.csv') {
    const rows = buffer.toString('utf8').trim().split(/\r?\n/).slice(0, 200).map((l) => l.split(',').map((c) => c.replace(/^"|"$/g, '').replace(/\|/g, '/').trim()));
    if (!rows.length) throw new Error('The CSV file is empty.');
    const table = [`| ${rows[0].join(' | ')} |`, `|${rows[0].map(() => '---').join('|')}|`, ...rows.slice(1).map((r) => `| ${r.join(' | ')} |`)];
    return { markdown: `# ${title}\n\n${table.join('\n')}`, title, kind: 'csv' };
  }
  if (['.md', '.markdown', '.txt', '.text', ''].includes(ext)) {
    return { markdown: textToMarkdown(buffer.toString('utf8'), title), title, kind: ext === '.txt' ? 'txt' : 'md' };
  }
  if (ext === '.pdf') {
    const r = await require('./pdfRead').pdfToMarkdown(buffer, title);
    return { markdown: r.markdown, title: r.title, kind: 'pdf', pages: r.pages, truncated: r.truncated };
  }
  if (ext === '.doc' || ext === '.ppt') throw new Error(`Old ${ext} files are not supported. Save it as ${ext}x first.`);
  throw new Error(`Unsupported file type "${ext}". Attach a .pdf, .docx, .pptx, .txt, .md, .csv or .html file.`);
}

module.exports = { fileToMarkdown, textToMarkdown, htmlToMarkdown, decodeDataUrl };
