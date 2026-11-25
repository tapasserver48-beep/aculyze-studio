/**
 * Website crawler for the Customer Executive (Phase 04.4 Stage A).
 *
 * Replaces the Playwright crawler, which never awaited its page extraction
 * (so every page failed), did nothing without Postgres, launched a browser per
 * page, followed links to other sites and ran inside one HTTP request.
 *
 * This one downloads HTML directly (no browser, works on Render):
 *   - same site only (www. and bare domain count as the same site)
 *   - seeds from sitemap.xml, follows links breadth-first, honours robots.txt
 *   - SSRF safe: https only, and every connection's resolved IP is checked at
 *     connect time (custom DNS lookup), including after redirects
 *   - limits: pages, bytes per page, time per page, 3 requests at a time
 *   - drops lines repeated on most pages (menus, footers) except on the first page
 */

const https = require('https');
const dns = require('dns');
const zlib = require('zlib');
const { validateUrl, isPrivateIp } = require('./crawler');

const DEFAULT_MAX_PAGES = 30;
const HARD_MAX_PAGES = 80;
const PAGE_TIMEOUT_MS = 12000;
const MAX_BYTES = 2 * 1024 * 1024;
const CONCURRENCY = 3;
const USER_AGENT = 'AculyzeStudioBot/1.0 (+website assistant knowledge crawler)';
const SKIP_EXT = /\.(jpe?g|png|gif|webp|svg|ico|bmp|tiff?|mp4|mov|avi|webm|mp3|wav|ogg|pdf|zip|rar|7z|gz|tar|exe|dmg|apk|css|js|json|xml|rss|woff2?|ttf|eot|docx?|xlsx?|pptx?|csv)$/i;
const SKIP_PATH = /\/(wp-admin|wp-login|cart|checkout|my-account|account|login|signin|sign-in|logout|register|feed|tag|author)(\/|$)/i;

/** DNS lookup that refuses private / reserved addresses (checked per connection). */
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
    const bad = list.find((a) => isPrivateIp(a.address));
    if (bad || !list.length) return callback(new Error(`Blocked address for ${hostname}`));
    if (options && options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

function siteKey(hostname) {
  return String(hostname || '').toLowerCase().replace(/^www\./, '');
}

/** GET one URL (no redirects followed here). Resolves { status, headers, body, url }. */
function rawGet(url, { timeoutMs = PAGE_TIMEOUT_MS, maxBytes = MAX_BYTES, lookup = safeLookup } = {}) {
  return new Promise((resolve, reject) => {
    const v = validateUrl(url);
    if (!v.valid) return reject(new Error(v.error));
    const req = https.get(url, {
      lookup,
      timeout: timeoutMs,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,application/xml;q=0.5', 'Accept-Encoding': 'gzip, deflate, br' },
    }, (res) => {
      const chunks = [];
      let size = 0;
      let stream = res;
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      stream.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(); stream.destroy(); resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), url, truncated: true }); return; }
        chunks.push(c);
      });
      stream.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), url }));
      stream.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
  });
}

/** GET with up to 5 redirects, each hop re-validated and kept on the same site. */
async function fetchPage(url, opts = {}) {
  let current = url;
  const startSite = siteKey(new URL(url).hostname);
  for (let hop = 0; hop < 6; hop++) {
    const r = await rawGet(current, opts);
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      const next = new URL(r.headers.location, current);
      if (next.protocol !== 'https:') throw new Error('Redirected to a non-HTTPS address');
      if (opts.sameSite !== false && siteKey(next.hostname) !== startSite) throw new Error(`Redirected to another site (${next.hostname})`);
      current = next.toString();
      continue;
    }
    return { ...r, url: current };
  }
  throw new Error('Too many redirects');
}

/* ---------------- HTML → text ---------------- */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™', rupee: '₹' };
function decode(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&([a-z]+);/gi, (m, n) => (ENTITIES[n.toLowerCase()] !== undefined ? ENTITIES[n.toLowerCase()] : m));
}
const clean = (s) => decode(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? '') : '';
}

/**
 * HTML page → { title, metaDescription, headings, lines, links, emails, phones }.
 * `lines` are the visible text blocks in reading order.
 */
function extractPage(html, pageUrl) {
  const src = String(html || '');
  const title = clean((src.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  let metaDescription = '';
  for (const m of src.matchAll(/<meta\b[^>]*>/gi)) {
    const name = (attr(m[0], 'name') || attr(m[0], 'property')).toLowerCase();
    if (name === 'description' || name === 'og:description') { metaDescription = attr(m[0], 'content').trim(); if (name === 'description') break; }
  }

  // Links (before stripping) — absolute, same-page anchors removed.
  const links = [];
  const emails = new Set();
  for (const m of src.matchAll(/<a\b[^>]*>/gi)) {
    const href = attr(m[0], 'href').trim();
    if (!href) continue;
    if (/^mailto:/i.test(href)) { emails.add(href.replace(/^mailto:/i, '').split('?')[0].trim()); continue; }
    if (/^(javascript|tel|sms|whatsapp):/i.test(href) || href.startsWith('#')) continue;
    try { const u = new URL(href, pageUrl); u.hash = ''; links.push(u.toString()); } catch { /* bad href */ }
  }

  let body = src
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|canvas|form|select)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, ' ');
  const bodyMatch = body.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch) body = bodyMatch[1];

  const headings = [];
  for (const m of body.matchAll(/<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const t = clean(m[2]);
    if (t && t.length <= 160) headings.push(t);
  }

  // Block-level tags become line breaks; list items get a bullet.
  const text = decode(body
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|section|article|header|footer|main|aside|h[1-6]|ul|ol|li|tr|table|dd|dt|dl|blockquote|figcaption|address)\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, ' '));
  const lines = text.split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').replace(/(\s*\|\s*)+$/, '').trim())
    .filter((l) => l.length >= 3 && /[\p{L}\p{N}]/u.test(l));

  for (const m of text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) emails.add(m[0]);
  const phones = new Set();
  for (const m of text.matchAll(/(?:\+\d{1,3}[\s-]?)?(?:\(?\d{2,5}\)?[\s-]?)\d{3,5}[\s-]?\d{3,5}/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 13) phones.add(m[0].trim());
  }

  return {
    title: title.slice(0, 200),
    metaDescription: metaDescription.slice(0, 400),
    headings: headings.slice(0, 40),
    lines,
    links,
    emails: [...emails].slice(0, 10),
    phones: [...phones].slice(0, 10),
  };
}

/* ---------------- robots.txt + sitemap ---------------- */

function parseRobots(txt) {
  const rules = [];
  let applies = false;
  let sawAgent = false;
  for (const raw of String(txt || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (sawAgent && rules.length) { /* new group */ }
      applies = val === '*' || /aculyze/i.test(val);
      sawAgent = true;
    } else if (applies && key === 'disallow' && val) rules.push(val);
  }
  return (pathname) => !rules.some((r) => pathname.startsWith(r.replace(/\*.*$/, '')));
}

function sitemapUrls(xml) {
  return [...String(xml || '').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decode(m[1]));
}

function normalise(u) {
  const url = new URL(u);
  url.hash = '';
  // Drop tracking parameters; keep the rest (some sites route pages by query).
  for (const k of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$|mc_)/i.test(k)) url.searchParams.delete(k);
  let s = url.toString();
  if (url.pathname !== '/' && s.endsWith('/') && !url.search) s = s.slice(0, -1);
  return s;
}

/**
 * Crawl a website.
 * @param {string} startUrl
 * @param {{ maxPages?, onProgress?, signal?, fetcher? }} opts  fetcher is for tests
 * @returns {Promise<{ pages: Array, errors: Array, skipped: number }>}
 */
async function crawlSite(startUrl, { maxPages = DEFAULT_MAX_PAGES, onProgress = () => {}, signal = null, fetcher = fetchPage } = {}) {
  const v = validateUrl(startUrl);
  if (!v.valid) throw new Error(v.error);
  const start = normalise(startUrl);
  const origin = new URL(start).origin;
  const site = siteKey(new URL(start).hostname);
  const limit = Math.max(1, Math.min(HARD_MAX_PAGES, Number(maxPages) || DEFAULT_MAX_PAGES));

  let allowed = () => true;
  try {
    const r = await fetcher(`${origin}/robots.txt`, { maxBytes: 200000 });
    if (r.status === 200) allowed = parseRobots(r.body);
  } catch { /* no robots.txt */ }

  const queue = [start];
  const seen = new Set([start]);
  const enqueue = (u) => {
    let n;
    try { n = normalise(u); } catch { return; }
    const url = new URL(n);
    if (url.protocol !== 'https:' || siteKey(url.hostname) !== site) return;
    if (SKIP_EXT.test(url.pathname) || SKIP_PATH.test(url.pathname) || !allowed(url.pathname)) return;
    if (seen.has(n) || seen.size > limit * 6) return;
    seen.add(n);
    queue.push(n);
  };
  try {
    const sm = await fetcher(`${origin}/sitemap.xml`, { maxBytes: 1500000 });
    if (sm.status === 200) {
      let locs = sitemapUrls(sm.body);
      // A sitemap index points at more sitemaps: read the first few.
      const nested = locs.filter((l) => /\.xml(\?|$)/i.test(l)).slice(0, 3);
      for (const n of nested) {
        try { const r = await fetcher(n, { maxBytes: 1500000 }); if (r.status === 200) locs = locs.concat(sitemapUrls(r.body)); } catch { /* skip */ }
      }
      locs.filter((l) => !/\.xml(\?|$)/i.test(l)).slice(0, limit * 3).forEach(enqueue);
    }
  } catch { /* no sitemap */ }

  const pages = [];
  const errors = [];
  let active = 0;
  let done = 0;

  await new Promise((resolve) => {
    const pump = () => {
      if (signal && signal.aborted) { if (!active) resolve(); return; }
      while (active < CONCURRENCY && queue.length && pages.length + active < limit) {
        const url = queue.shift();
        active++;
        onProgress({ phase: 'crawling', current: url, done, saved: pages.length, queued: queue.length });
        fetcher(url)
          .then((r) => {
            const type = String(r.headers && r.headers['content-type'] || 'text/html');
            if (r.status !== 200) { errors.push({ url, error: `HTTP ${r.status}` }); return; }
            if (!/text\/html|application\/xhtml|text\/plain/i.test(type)) return;
            const page = extractPage(r.body, r.url || url);
            if (/noindex/i.test((r.body.match(/<meta[^>]+name=["']robots["'][^>]*>/i) || [''])[0])) return;
            page.links.forEach(enqueue);
            // Some sites serve "not found" pages with status 200.
            if (/^(404\b|page not found|not found|error 404)/i.test(page.title)) return;
            if (page.lines.length || page.title) pages.push({ url: r.url || url, ...page });
          })
          .catch((err) => { errors.push({ url, error: err.message }); })
          .finally(() => {
            active--;
            done++;
            if ((!queue.length || pages.length >= limit) && !active) resolve();
            else pump();
          });
      }
      if (!active && (!queue.length || pages.length >= limit)) resolve();
    };
    pump();
  });

  // Boilerplate: lines on more than 60% of pages (3+ pages) are kept only on the first page.
  if (pages.length >= 3) {
    const freq = new Map();
    for (const p of pages) for (const l of new Set(p.lines)) freq.set(l, (freq.get(l) || 0) + 1);
    const common = new Set([...freq].filter(([, n]) => n >= Math.max(3, pages.length * 0.6)).map(([l]) => l));
    pages.forEach((p, i) => { if (i > 0) p.lines = p.lines.filter((l) => !common.has(l)); });
  }
  onProgress({ phase: 'done', done, saved: pages.length, queued: queue.length });
  return { pages, errors: errors.slice(0, 50), skipped: queue.length };
}

/** Crawled page → knowledge content (shape used by knowledge.addKnowledge). */
function toKnowledgeContent(page) {
  return {
    title: page.title,
    metaDescription: page.metaDescription,
    headings: [page.title, ...page.headings.filter((h) => h !== page.title)].filter(Boolean).slice(0, 30),
    paragraphs: page.lines.slice(0, 400),
    links: page.links.slice(0, 50).map((href) => ({ href })),
    contact_emails: page.emails,
    contact_phones: page.phones,
  };
}

module.exports = { crawlSite, extractPage, parseRobots, sitemapUrls, normalise, fetchPage, safeLookup, toKnowledgeContent, DEFAULT_MAX_PAGES, HARD_MAX_PAGES };
