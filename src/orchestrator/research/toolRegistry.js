/**
 * Research engine — ToolRegistry (§21).
 *
 * The ONLY way the research layer reaches the web. It wraps the EXISTING
 * search provider (Playwright/DuckDuckGo/Google) behind a small, bounded,
 * auditable interface: search() and fetch(). No new browser code, no shell,
 * no arbitrary code execution — just the two capabilities the provider already
 * exposes, capped by the shared research limits and counted for the run.
 *
 * This is the seam where a future "Browser Agent → Lightpanda | Chrome" split
 * plugs in, without the research engine ever knowing which engine ran.
 */

const { readLimits } = require('./limits');

const OFFICIAL_SOURCE_TIMEOUT_MS = 10000;
function combineSignals(...signals) {
  const active = signals.filter(Boolean);
  if (AbortSignal.any) return AbortSignal.any(active);
  const controller = new AbortController();
  for (const signal of active) {
    if (signal.aborted) { controller.abort(signal.reason); break; }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/**
 * Official version endpoints (deterministic, registry-driven). Used FIRST for
 * version_lookup intents; search/browser is only the fallback if these fail.
 * Each entry knows how to pull the version out of the JSON payload.
 */
const OFFICIAL_SOURCES = [
  {
    match: /^(?:php)$/i,
    url: 'https://www.php.net/releases/active.php?json',
    // Real payload is NESTED by major: { "8": { "8.2": {version:"8.2.35"}, "8.3": {...}, "8.4": {...} } }.
    // Some shapes are flat: { "8.4": {version:"8.4.12"} }. Handle both: collect
    // every minor branch that carries a `version`, then take the highest.
    parse(json) {
      const branches = [];
      const scan = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        for (const [k, v] of Object.entries(obj)) {
          if (/^\d+\.\d+$/.test(k) && v && typeof v === 'object' && v.version) {
            branches.push({ branch: k, version: String(v.version) });
          } else if (v && typeof v === 'object' && !Array.isArray(v)) {
            scan(v); // one level deeper (nested-by-major shape)
          }
        }
      };
      scan(json);
      if (!branches.length) return null;
      // Highest minor branch (8.4 > 8.3 > 7.4), return its latest patch version.
      branches.sort((a, b) => Number(b.branch.split('.')[0]) - Number(a.branch.split('.')[0]) || Number(b.branch.split('.')[1]) - Number(a.branch.split('.')[1]));
      return branches[0].version;
    },
  },
  {
    match: /^(?:laravel)$/i,
    url: 'https://api.github.com/repos/laravel/framework/releases/latest',
    // Payload: { tag_name: "v13.0.0", ... }
    parse(json) {
      const tag = json && json.tag_name ? String(json.tag_name) : null;
      return tag ? tag.replace(/^v/i, '') : null;
    },
  },
  {
    match: /^(?:react)$/i,
    url: 'https://registry.npmjs.org/react/latest',
    // Payload: { version: "19.2.0", ... }
    parse(json) {
      return json && json.version ? String(json.version) : null;
    },
  },
];

/** Find the official JSON source for an item name (or null). */
function officialSourceFor(name) {
  const n = String(name || '').trim();
  return OFFICIAL_SOURCES.find((s) => s.match.test(n)) || null;
}

class ToolRegistry {
  /**
   * @param {{ searchProvider: { search(fn), fetchPage?(fn) }, limits?: object, fetchImpl?: fn }} deps
   */
  constructor({ searchProvider, limits = readLimits(), fetchImpl = null, signal = null } = {}) {
    if (!searchProvider) throw new Error('ToolRegistry requires a searchProvider.');
    this.provider = searchProvider;
    this.limits = limits;
    // Node's global fetch is used for the official JSON endpoints (no new dep).
    this.fetchImpl = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    this.signal = signal;
    this.toolCalls = 0;
    this.fetchedUrls = new Set();
    this.log = [];
    this.retries = new Map(); // key → attempt count (capped at 2)
  }

  /** @returns {boolean} whether another tool call is within budget. */
  canCall() { return this.toolCalls < this.limits.MAX_TOOL_CALLS; }

  _throwIfAborted() {
    if (!this.signal?.aborted) return;
    const error = new Error('Research was cancelled.');
    error.name = 'AbortError';
    throw error;
  }

  _record(kind, detail) {
    this.toolCalls += 1;
    this.log.push({ kind, detail, at: new Date().toISOString(), calls: this.toolCalls });
  }

  /**
   * Official-source lookup for a named item (version_lookup). Reads a known
   * JSON endpoint with a hard 10s timeout and parses the version out. Returns a
   * structured result the evidence layer can anchor to — the raw fetched text is
   * preserved so the verifier can confirm the value literally appears in it.
   * @returns {Promise<{ ok:boolean, value?:string, url?:string, rawText?:string, fetchedAt?:string, error?:string }>}
   */
  async officialSource(name) {
    this._throwIfAborted();
    const src = officialSourceFor(name);
    if (!src) return { ok: false, error: `no official source registered for "${name}"` };
    if (!this.canCall()) return { ok: false, error: 'tool-call budget exhausted' };
    if (!this.fetchImpl) return { ok: false, error: 'fetch is not available' };

    this._record('official_source', src.url);
    const fetchedAt = new Date().toISOString();
    try {
      const timeout = AbortSignal.timeout(OFFICIAL_SOURCE_TIMEOUT_MS);
      const signal = combineSignals(this.signal, timeout);
      const res = await this.fetchImpl(src.url, { signal });
      if (!res.ok) return { ok: false, url: src.url, error: `HTTP ${res.status}` };
      const rawText = await res.text();
      let json;
      try { json = JSON.parse(rawText); } catch { return { ok: false, url: src.url, rawText, fetchedAt, error: 'response was not valid JSON' }; }
      const value = src.parse(json);
      if (!value) return { ok: false, url: src.url, rawText, fetchedAt, error: 'could not parse a version from the payload' };
      return { ok: true, value, url: src.url, rawText, fetchedAt };
    } catch (err) {
      if (this.signal?.aborted) this._throwIfAborted();
      return { ok: false, url: src.url, error: String(err.message || err).slice(0, 200) };
    }
  }

  /**
   * Web search. Returns candidate hits (never throws — failures are returned
   * as { ok:false, error } so the researcher can record and continue).
   * @returns {Promise<{ ok:boolean, results:[], error?:string }>}
   */
  async search(query) {
    this._throwIfAborted();
    if (!this.canCall()) return { ok: false, results: [], error: 'tool-call budget exhausted' };
    this._record('search', String(query).slice(0, 120));
    try {
      const results = await this.provider.search(query, { count: this.limits.MAX_CANDIDATES_PER_QUERY, signal: this.signal });
      return { ok: true, results: Array.isArray(results) ? results : [] };
    } catch (err) {
      if (this.signal?.aborted || err.name === 'AbortError') throw err;
      return { ok: false, results: [], error: String(err.message || err).slice(0, 200) };
    }
  }

  /**
   * Fetch a page's readable text. Enforces the per-run source cap and dedupes
   * URLs. Also refuses non-http(s) and internal hosts (no SSRF), mirroring the
   * existing /api/page guard.
   * @returns {Promise<{ ok:boolean, page?:{url,title,text}, error?:string }>}
   */
  async fetch(url) {
    this._throwIfAborted();
    if (typeof this.provider.fetchPage !== 'function') {
      return { ok: false, error: 'page fetching is not supported by this search provider' };
    }
    let parsed;
    try { parsed = new URL(String(url)); } catch { return { ok: false, error: 'invalid URL' }; }
    if (!/^https?:$/.test(parsed.protocol)) return { ok: false, error: 'only http/https can be fetched' };
    const host = parsed.hostname.toLowerCase();
    if (/^(localhost|127\.|0\.0\.0\.0|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1)/.test(host)) {
      return { ok: false, error: 'internal addresses cannot be fetched' };
    }
    if (this.fetchedUrls.has(parsed.href)) return { ok: false, error: 'already fetched' };
    if (this.fetchedUrls.size >= this.limits.MAX_SOURCES) return { ok: false, error: 'source cap reached' };
    if (!this.canCall()) return { ok: false, error: 'tool-call budget exhausted' };

    this._record('fetch', parsed.href.slice(0, 120));
    this.fetchedUrls.add(parsed.href);
    try {
      const page = await this.provider.fetchPage(parsed.href, { maxChars: this.limits.PAGE_MAX_CHARS, signal: this.signal });
      return { ok: true, page };
    } catch (err) {
      if (this.signal?.aborted || err.name === 'AbortError') throw err;
      return { ok: false, error: String(err.message || err).slice(0, 200) };
    }
  }

  /**
   * Retry accounting — capped at 2 attempts per key (tool). Returns true while
   * another attempt is allowed, false once the cap is hit.
   */
  attemptRetry(key) {
    const n = (this.retries.get(key) || 0) + 1;
    this.retries.set(key, n);
    return n <= 2;
  }

  retryCount(key) { return this.retries.get(key) || 0; }
}

module.exports = { ToolRegistry, officialSourceFor, OFFICIAL_SOURCES };
