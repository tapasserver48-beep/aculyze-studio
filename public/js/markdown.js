/**
 * Markdown rendering with sanitization + code highlighting.
 * Uses CDN libs (marked, DOMPurify, hljs) when available,
 * falls back to a minimal safe renderer otherwise.
 */

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fallbackRender(md) {
  // Minimal: escape, then handle code blocks, inline code, bold, italic, headings, lists, links, tables(plain)
  let html = escapeHtml(md);
  html = html.replace(/```(\w*)\n([\s\S]*?)(```|$)/g, (m, lang, code) =>
    `<pre><code class="language-${lang || 'text'}">${code.replace(/&lt;\/code&gt;|&lt;\/pre&gt;/g, '')}</code></pre>`
  );
  html = html.replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*(.+?)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>')
    .replace(/^(?:-|\*) (.*)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>)/s, (m) => `<ul>${m}</ul>`);
  html = html.replace(/\n{2,}/g, '<br/><br/>').replace(/\n/g, '<br/>');
  return html;
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
