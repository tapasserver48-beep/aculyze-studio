/**
 * Markdown rendering with sanitization + code highlighting.
 * Uses CDN libs (marked, DOMPurify, hljs) when available,
 * falls back to a minimal safe renderer otherwise.
 */

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** GFM-style pipe table (already HTML-escaped) → <table>. */
function renderTable(block) {
  const rows = block.trim().split('\n').filter((r) => r.trim());
  const cells = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const head = cells(rows[0]);
  const body = rows.slice(2).map(cells);
  return `<div class="md-table"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>`
    + `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>\n`;
}

function fallbackRender(md) {
  // Escape first, so everything below only ever produces our own tags.
  let html = escapeHtml(String(md).replace(/\r\n?/g, '\n'));

  // Code blocks are stashed so no later rule (or <br/>) touches their contents.
  const stash = [];
  html = html.replace(/```(\w*)\n([\s\S]*?)(```|$)/g, (m, lang, code) => {
    stash.push(`<pre><code class="language-${lang || 'text'}">${code.replace(/&lt;\/code&gt;|&lt;\/pre&gt;/g, '')}</code></pre>`);
    return `\u0000${stash.length - 1}\u0000\n`;
  });

  // Tables: header row, separator row (|---|:--:|), then body rows.
  html = html.replace(/^\|.*\|[ \t]*\n\|[ \t:|-]+\|[ \t]*\n(?:\|.*\|[ \t]*(?:\n|$))*/gm, renderTable);

  html = html.replace(/^#### (.*)$/gm, '<h4>$1</h4>')
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '<hr/>')
    .replace(/^&gt; ?(.*)$/gm, '<blockquote>$1</blockquote>')
    // Lists before italics, so a "* item" bullet is never read as emphasis.
    .replace(/^[ \t]*(?:[-*•]) (.*)$/gm, '<uli>$1</uli>')
    .replace(/^[ \t]*\d+[.)] (.*)$/gm, '<oli>$1</oli>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Group consecutive list items into one list each.
  html = html.replace(/(?:<uli>.*<\/uli>\n?)+/g, (m) => `<ul>${m.replace(/\n/g, '').replace(/<(\/?)uli>/g, '<$1li>')}</ul>\n`)
    .replace(/(?:<oli>.*<\/oli>\n?)+/g, (m) => `<ol>${m.replace(/\n/g, '').replace(/<(\/?)oli>/g, '<$1li>')}</ol>\n`);

  // No line breaks next to block elements (they already break), then text breaks.
  const BLOCK = '(?:h1|h2|h3|h4|ul|ol|pre|blockquote|div|table)';
  html = html.replace(new RegExp(`(</${BLOCK}>|<hr/>|\\u0000\\d+\\u0000)\\n+`, 'g'), '$1')
    .replace(new RegExp(`\\n+(<${BLOCK}[ >]|<hr/>|\\u0000\\d+\\u0000)`, 'g'), '$1')
    .replace(/\n{2,}/g, '<br/><br/>')
    .replace(/\n/g, '<br/>');

  return html.replace(/\u0000(\d+)\u0000/g, (m, i) => stash[Number(i)]);
}

export function renderMarkdown(md) {
  const text = md || '';
  try {
    if (window.marked) {
      window.marked.setOptions({ breaks: true, gfm: true });
      const raw = window.marked.parse(text);
      if (window.DOMPurify) {
        return window.DOMPurify.sanitize(raw, { ADD_ATTR: ['target'] });
      }
      return raw;
    }
  } catch { /* fall through */ }
  return fallbackRender(text);
}

export function highlightAll(root) {
  try {
    if (!window.hljs) return;
    root.querySelectorAll('pre code').forEach((el) => {
      try { window.hljs.highlightElement(el); } catch { /* noop */ }
    });
  } catch { /* noop */ }
}

/** Adds copy buttons to code blocks. */
export function enhanceCodeBlocks(root, onToast) {
  root.querySelectorAll('pre').forEach((pre) => {
    if (pre.previousElementSibling?.classList?.contains('code-head')) return;
    const code = pre.querySelector('code');
    const lang = (code?.className.match(/language-(\w+)/) || [])[1] || 'code';
    const head = document.createElement('div');
    head.className = 'code-head';
    const label = document.createElement('span');
    label.textContent = lang;
    const btn = document.createElement('button');
    btn.textContent = 'Copy';
    btn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(code ? code.innerText : pre.innerText);
        btn.textContent = 'Copied ✓';
        setTimeout(() => (btn.textContent = 'Copy'), 1500);
      } catch {
        if (onToast) onToast('Copy failed');
      }
    };
    head.append(label, btn);
    pre.parentNode.insertBefore(head, pre);
  });
}
