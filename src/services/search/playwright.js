/**
 * PlaywrightProvider implements SearchProvider — keyless web search by
 * driving a real headless browser (Chromium) instead of calling APIs.
 *
 * Engine order (empirically verified on this network):
 *   1. Brave Search   — works, high-quality results
 *   2. Bing           — works but can return SEO spam for niche queries;
 *                       results are relevance-filtered against the query
 *   3. DuckDuckGo     — often network-blocked here; kept as last resort
 *
 * Also exposes fetchPage() to read a page's main text — used by the chat
 * API layer to ground answers in real page content, not just snippets.
 */
const { SearchProvider } = require('./provider');

// Query tokens used to filter spam results (e.g. "run games" spam for an
// obscure brand query). Short/stop words are ignored.
function queryTokens(q) {
  const stop = new Set(['the', 'a', 'an', 'is', 'are', 'what', 'who', 'when', 'where', 'why', 'how', 'of', 'in', 'on', 'to', 'for', 'and', 'or', 'do', 'does', 'it', 'with', 'about', 'latest', 'today']);
  return String(q).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !stop.has(t));
}

function isRelevant(text, tokens) {
  if (!tokens.length) return true;
  const hay = String(text).toLowerCase();
  return tokens.some((t) => hay.includes(t));
}

class PlaywrightProvider extends SearchProvider {
  constructor({ timeoutMs = 20000 } = {}) {
    super('playwright');
    this.timeoutMs = timeoutMs;
    this.browser = null;
    this.browserPromise = null;
    this.engines = [
      { name: 'brave', url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}` },
      { name: 'bing', url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en` },
      { name: 'duckduckgo', url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}` },
    ];
  }

  async _getBrowser() {
    if (this.browser) return this.browser;
    if (!this.browserPromise) {
      this.browserPromise = (async () => {
        const { chromium } = require('playwright');
        const b = await chromium.launch({
          headless: true,
          args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
        });
        this.browser = b;
        return b;
      })().catch((err) => {
        this.browserPromise = null;
        throw err;
      });
    }
    return this.browserPromise;
  }

  async _closeBrowser() {
    try {
      if (this.browser) await this.browser.close();
    } catch { /* noop */ }
    this.browser = null;
    this.browserPromise = null;
  }

  async _withPage(fn, { signal } = {}) {
    if (signal?.aborted) throw Object.assign(new Error('Search cancelled.'), { name: 'AbortError' });
    const browser = await this._getBrowser();
    if (signal?.aborted) throw Object.assign(new Error('Search cancelled.'), { name: 'AbortError' });
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      locale: 'en-US',
    });
    const page = await context.newPage();
    const abortPage = () => { page.close().catch(() => {}); };
    signal?.addEventListener('abort', abortPage, { once: true });
    try {
      return await fn(page);
    } catch (err) {
      if (signal?.aborted) throw Object.assign(new Error('Search cancelled.'), { name: 'AbortError' });
      throw err;
    } finally {
      signal?.removeEventListener('abort', abortPage);
      await context.close().catch(() => {});
    }
  }

  /** Generic result extraction: external http(s) anchors with real text. */
  async _extractResults(page) {
    return page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const out = [];
      const seen = new Set();
      for (const a of document.querySelectorAll('a[href^="http"]')) {
        const href = a.href || '';
        let host = '';
        try { host = new URL(href).hostname; } catch { continue; }
        if (/(^|\.)brave\.com$|(^|\.)bing\.com$|(^|\.)duckduckgo\.com$|(^|\.)google\.com$|poki\.com|chrome\.google/i.test(host)) continue;
        const title = clean(a.textContent);
        if (title.length < 12 || title.length > 200) continue;
        // Walk up to a container with a snippet
        let node = a.parentElement, depth = 0, snippet = '';
        while (node && depth < 6) {
          const txt = clean(node.innerText);
          if (txt.length > 120) { snippet = txt.slice(0, 400); break; }
          node = node.parentElement; depth++;
        }
        const key = host + title.slice(0, 40);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ title, url: href, snippet });
        if (out.length >= 16) break;
      }
      return out;
    });
  }

  /** Pass Brave's lightweight "verify you're not a bot" interstitial. */
  async _passBotCheck(page) {
    const body = await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 300) : '')).catch(() => '');
    if (!/not a bot|Verify/i.test(body)) return false;
    const clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button, a, div[role="button"], input[type="button"]')]
        .find((el) => /verify/i.test((el.textContent || el.value || '').trim()));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (clicked) {
      try {
        await page.waitForSelector('a[href^="http"]', { timeout: 15000 });
      } catch { /* stay on whatever page we have */ }
    }
    return clicked;
  }

  async _searchOnce(engine, query, tokens, { signal } = {}) {
    return this._withPage(async (page) => {
      await page.goto(engine.url(query), { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
      if (signal?.aborted) throw Object.assign(new Error('Search cancelled.'), { name: 'AbortError' });
      await page.waitForTimeout(1500); // allow JS-rendered results
      await this._passBotCheck(page); // no-op unless a bot check is shown
      const items = await this._extractResults(page);
      // Relevance filter drops obvious SEO spam (e.g. game/movie sites for a
      // brand query). Keep unfiltered results only if filtering empties it.
      const relevant = items.filter((r) => isRelevant(`${r.title} ${r.snippet}`, tokens));
      return relevant.length ? relevant : items;
    }, { signal });
  }

  /**
   * @param {string} query
   * @param {{ count?: number }} opts
   * @returns {Promise<Array<{ title: string, url: string, snippet: string }>>}
   */
  async search(query, { count = 5, signal } = {}) {
    const q = String(query || '').trim().slice(0, 400);
    if (!q) return [];
    const tokens = queryTokens(q);
    const errors = [];
    for (const engine of this.engines) {
      if (signal?.aborted) throw Object.assign(new Error('Search cancelled.'), { name: 'AbortError' });
      try {
        const results = await this._searchOnce(engine, q, tokens, { signal });
        if (results.length) return results.slice(0, Math.min(count, 10));
        errors.push(`${engine.name}: no results`);
      } catch (err) {
        if (signal?.aborted || err.name === 'AbortError') throw err;
        errors.push(`${engine.name}: ${(err.message || err).slice(0, 80)}`);
        await this._closeBrowser(); // restart browser after a crash/timeout
      }
    }
    throw new Error(`All engines failed (${errors.join(' | ')})`);
  }

  /**
   * Fetch a web page and return its readable text — lets the model answer
   * from real page content instead of a one-line snippet.
   * @returns {Promise<{ title: string, url: string, text: string }>}
   */
  async fetchPage(url, { maxChars = 6000, signal } = {}) {
    let parsed;
    try { parsed = new URL(String(url)); } catch { throw new Error('Invalid URL.'); }
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http/https pages can be fetched.');
    const result = await this._withPage(async (page) => {
      await page.goto(parsed.href, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
      await page.waitForTimeout(800);
      const title = await page.title();
      const text = await page.evaluate(() => {
        for (const junk of document.querySelectorAll('script, style, noscript, svg, iframe, nav, footer, header')) {
          junk.remove();
        }
        return (document.body && document.body.innerText ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n');
      });
      return { title: String(title || '').slice(0, 300), text: String(text || '').slice(0, maxChars) };
    }, { signal });
    return { url: parsed.href, ...result };
  }

  /** Graceful teardown (called on server shutdown). */
  async shutdown() {
    await this._closeBrowser();
  }
}

module.exports = { PlaywrightProvider };
