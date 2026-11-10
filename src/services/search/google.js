/**
 * GoogleProvider implements SearchProvider via Google Custom Search API.
 * Needs a free API key + Search Engine ID (100 queries/day free).
 * Used where keyless endpoints are unreachable.
 */
const { SearchProvider } = require('./provider');

class GoogleProvider extends SearchProvider {
  constructor({ apiKey = '', engineId = '', timeoutMs = 12000 } = {}) {
    super('google');
    this.apiKey = apiKey;
    this.engineId = engineId;
    this.timeoutMs = timeoutMs;
  }

  get configured() {
    return !!(this.apiKey && this.engineId);
  }

  async search(query, { count = 5, signal } = {}) {
    const q = String(query || '').trim().slice(0, 400);
    if (!q) return [];
    if (!this.configured) throw new Error('Google search is not configured (GOOGLE_SEARCH_KEY / GOOGLE_SEARCH_CX).');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const url =
        `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(this.apiKey)}` +
        `&cx=${encodeURIComponent(this.engineId)}&q=${encodeURIComponent(q)}&num=${Math.min(Math.max(count, 1), 10)}`;
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`Google search responded with HTTP ${res.status}`);
      const data = await res.json();
      return (Array.isArray(data.items) ? data.items : []).map((r) => ({
        title: String(r.title || '').slice(0, 200),
        url: String(r.link || ''),
        snippet: String(r.snippet || '').slice(0, 500),
      })).filter((r) => r.url);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
}

module.exports = { GoogleProvider };
