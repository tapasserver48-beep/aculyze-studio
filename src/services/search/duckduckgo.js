/**
 * DuckDuckGoProvider implements SearchProvider.
 * Keyless — no API key or account needed.
 * Uses the `duck-duck-scrape` package (loaded lazily so the server boots
 * even if the optional dependency is missing).
 */
const { SearchProvider } = require('./provider');

class DuckDuckGoProvider extends SearchProvider {
  constructor({ timeoutMs = 12000 } = {}) {
    super('duckduckgo');
    this.timeoutMs = timeoutMs;
  }

  async search(query, { count = 5, signal } = {}) {
    const q = String(query || '').trim().slice(0, 400);
    if (!q) return [];
    let ddg;
    try {
      ddg = await import('duck-duck-scrape');
    } catch (err) {
      throw new Error(`Search backend unavailable: ${err.message || err}`);
    }
    const searchFn = ddg.search || (ddg.default && ddg.default.search);
    if (typeof searchFn !== 'function') throw new Error('Search backend unavailable.');
    const SafeSearch = ddg.SafeSearchType || (ddg.default && ddg.default.SafeSearchType) || {};
    const data = await searchFn(q, {
      safeSearch: typeof SafeSearch.MODERATE === 'number' ? SafeSearch.MODERATE : -1,
    }, { signal, open_timeout: this.timeoutMs, read_timeout: this.timeoutMs, response_timeout: this.timeoutMs });
    const results = Array.isArray(data.results) ? data.results : [];
    return results.slice(0, Math.min(count, 10)).map((r) => ({
      title: String(r.title || r.url || 'Untitled').slice(0, 200),
      url: String(r.url || ''),
      snippet: String(r.description || r.snippet || '').slice(0, 500),
    })).filter((r) => r.url);
  }
}

module.exports = { DuckDuckGoProvider };
