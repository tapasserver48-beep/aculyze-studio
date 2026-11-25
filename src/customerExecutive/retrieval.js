/**
 * Customer Executive retrieval (Phase 04.4 Stage A).
 *
 * Replaces "does the page contain the word" matching with passage-level BM25:
 *   - each crawled page is split into ~140-word passages (30-word overlap)
 *   - words are lower-cased, stop words dropped, and lightly stemmed
 *   - passages are ranked with BM25; words that also appear in the page title,
 *     headings or URL get a boost
 *   - at most 2 passages per page, so one long page can't crowd out the rest
 *   - a coverage check flags weak results, so the bot can say "I don't know"
 *     instead of answering from an unrelated passage (corrective RAG)
 *
 * Ideas from rag_tutorials/corrective_rag and hybrid_search_rag in
 * Shubhamsaboo/awesome-llm-apps (Apache-2.0); no code copied. Keyword-only on
 * purpose: no embedding model is guaranteed to be configured.
 */

const PASSAGE_WORDS = 140;
const PASSAGE_OVERLAP = 30;
const K1 = 1.4;
const B = 0.75;

const STOP = new Set(('a an and are as at be but by can could did do does for from had has have how i if in into is it its '
  + 'me my of on or our so than that the their them then there these they this to too us was we were what when where '
  + 'which who whom why will with would you your yours about any also just more most much not no only other over own '
  + 'same some such very s t don should now get got tell please want need know like give show find').split(/\s+/));

/** Light stemmer: price / prices / priced / pricing → "pric"; plans → "plan". */
function stem(w) {
  if (w.length <= 4 || /\d/.test(w)) return w;
  let s = w;
  if (s.endsWith('ies') && s.length > 5) s = s.slice(0, -3) + 'y';
  else if (s.endsWith('ing') && s.length > 6) s = s.slice(0, -3);
  else if (s.endsWith('ed') && s.length > 5) s = s.slice(0, -2);
  else if (/(ss|x|ch|sh)es$/.test(s) && s.length > 5) s = s.slice(0, -2);
  else if (s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
  if (/([b-df-hj-np-tv-z])\1$/.test(s) && !/(ll|ss|zz)$/.test(s)) s = s.slice(0, -1); // running → run
  if (s.length > 4 && s.endsWith('e')) s = s.slice(0, -1);
  return s;
}

/** Text → index terms. Keeps numbers ("2024", "24x7") and non-Latin letters. */
function tokenize(text) {
  const words = String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const out = [];
  for (const w of words) {
    if (w.length < 2 || STOP.has(w)) continue;
    out.push(stem(w));
  }
  return out;
}

/** Lower-case words separated by single spaces (for phrase matching). */
function plain(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Phrases worth matching in order: the whole question and its word pairs (not stop-word pairs). */
function queryPhrases(query) {
  const words = plain(query).split(' ').filter(Boolean);
  const out = [];
  if (words.length >= 2 && words.length <= 12) out.push({ text: words.join(' '), weight: 2.5 });
  for (let i = 0; i + 1 < words.length; i++) {
    if (STOP.has(words[i]) && STOP.has(words[i + 1])) continue;
    out.push({ text: `${words[i]} ${words[i + 1]}`, weight: 0.6 });
  }
  return out;
}

function splitPassages(text) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (words.length <= PASSAGE_WORDS) return words.length ? [words.join(' ')] : [];
  const out = [];
  for (let i = 0; i < words.length; i += PASSAGE_WORDS - PASSAGE_OVERLAP) {
    out.push(words.slice(i, i + PASSAGE_WORDS).join(' '));
    if (i + PASSAGE_WORDS >= words.length) break;
  }
  return out;
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
}

function pageTitle(item) {
  const heads = asArray(item.content_headings);
  if (heads.length) return String(heads[0]).slice(0, 120);
  try {
    const u = new URL(item.source_url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last).replace(/[-_]+/g, ' ') : u.hostname;
  } catch { return String(item.source_url || 'Page'); }
}

/** Knowledge items (pages) → BM25 index over passages. */
function buildIndex(items) {
  const passages = [];
  for (const item of items || []) {
    const text = String(item.content_content || '').trim();
    if (!text) continue;
    const title = pageTitle(item);
    let urlWords = '';
    try { urlWords = new URL(item.source_url).pathname.replace(/[/_.-]+/g, ' '); } catch { /* not a URL */ }
    const boostTerms = new Set(tokenize(`${asArray(item.content_headings).join(' ')} ${urlWords}`));
    splitPassages(text).forEach((p, i) => {
      const terms = tokenize(p);
      const tf = new Map();
      for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
      passages.push({ knowledgeId: item.id, url: item.source_url, title, index: i, text: p, norm: ` ${plain(p)} `, len: terms.length || 1, tf, boostTerms });
    });
  }
  const df = new Map();
  for (const p of passages) for (const t of p.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const avgLen = passages.reduce((n, p) => n + p.len, 0) / (passages.length || 1);
  return { passages, df, avgLen, N: passages.length };
}

/**
 * @returns {{ results: Array<{ knowledgeId, url, title, text, score }>, coverage: number, weak: boolean, terms: string[] }}
 */
function search(index, query, { limit = 5, perPage = 2 } = {}) {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !index.N) return { results: [], coverage: 0, weak: true, terms };

  const phrases = queryPhrases(query);
  const idfs = terms.map((t) => { const n = index.df.get(t) || 0; return Math.log(1 + (index.N - n + 0.5) / (n + 0.5)); });
  // Phrase bonuses scale with the query's strongest word, but never vanish:
  // a word on every page ("xampp" on an XAMPP site) has almost no IDF.
  const phraseUnit = Math.max(1, ...idfs);

  const scored = [];
  for (const p of index.passages) {
    let score = 0;
    terms.forEach((t, i) => {
      const f = p.tf.get(t);
      if (!f) return;
      const idf = idfs[i];
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (p.len / index.avgLen))));
      if (p.boostTerms.has(t)) score += idf * 0.6;
    });
    if (score <= 0) continue;
    // Same words in the same order ("what is xampp") → strong signal, e.g. FAQ pages.
    for (const ph of phrases) if (p.norm.includes(` ${ph.text} `)) score += phraseUnit * ph.weight;
    // A page's opening passage usually holds the summary / definition.
    if (p.index === 0) score *= 1.1;
    scored.push({ p, score });
  }
  scored.sort((a, b) => b.score - a.score);

  const perUrl = new Map();
  const seenText = new Set(); // same text on several pages (translations, print views)
  const results = [];
  for (const { p, score } of scored) {
    const n = perUrl.get(p.url) || 0;
    if (n >= perPage) continue;
    const sig = p.norm.slice(0, 240);
    if (seenText.has(sig)) continue;
    seenText.add(sig);
    perUrl.set(p.url, n + 1);
    results.push({ knowledgeId: p.knowledgeId, url: p.url, title: p.title, text: p.text, score: Math.round(score * 100) / 100 });
    if (results.length >= limit) break;
  }

  // Corrective check: how many of the question's words the top passages contain.
  const found = new Set();
  for (const r of results.slice(0, 3)) for (const t of tokenize(r.text)) found.add(t);
  const covered = terms.filter((t) => found.has(t)).length;
  const coverage = covered / terms.length;
  const weak = !results.length || coverage < (terms.length <= 2 ? 0.5 : 0.34);
  return { results, coverage: Math.round(coverage * 100) / 100, weak, terms };
}

// Indexes are rebuilt only when a workspace's knowledge changes.
const cache = new Map(); // workspaceId → { sig, index }
function indexFor(workspaceId, items) {
  const sig = `${items.length}:${items.reduce((m, k) => Math.max(m, Number(k.extracted_at) || 0), 0)}:${items.reduce((n, k) => n + (Number(k.version) || 0), 0)}`;
  const hit = cache.get(workspaceId);
  if (hit && hit.sig === sig) return hit.index;
  const index = buildIndex(items);
  cache.set(workspaceId, { sig, index });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return index;
}

module.exports = { tokenize, splitPassages, buildIndex, search, indexFor, pageTitle };
