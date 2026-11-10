/**
 * Research engine — evidence collection, source quality, relevance, dedup (§7–9).
 *
 * Raw search results / page text are NOT passed to the model. They are converted
 * into structured, scored EVIDENCE records that each trace back to a real tool
 * result (source URL). Nothing here invents facts: a claim must be anchored to a
 * source we actually retrieved.
 *
 * Source quality is deterministic and transparent (§8): official docs / repos /
 * primary sources score highest, search snippets lowest. Relevance (§9) is a
 * token-overlap heuristic that labels each candidate RELEVANT / PARTIALLY_RELEVANT
 * / IRRELEVANT / DUPLICATE so only useful evidence is promoted.
 */

let evSeq = 0;
function nextEvidenceId() { evSeq += 1; return `evidence-${String(evSeq).padStart(3, '0')}`; }
function resetEvidenceIds() { evSeq = 0; }

// --- Source ranking (§8) — ordered tiers for version/fact lookups -----------
// Official project domains & registries first; blogs/forums/reddit last and
// NEVER allowed to be the sole evidence for a version.
const RANK_OFFICIAL = 1;
const RANK_PRIMARY = 2;
const RANK_SECONDARY = 3;
const RANK_LOW = 4;

const OFFICIAL_HOSTS = /(^|\.)(php\.net|laravel\.com|react\.dev|github\.com|npmjs\.(?:com|org)|packagist\.org|endoflife\.date)$/i;
const LOW_HOSTS = /reddit\.com|medium\.com|dev\.to|hashnode\.dev|stackoverflow\.com|(^|\.)blog\.|agency|wix\.com|squarepace|yourstory|geeksforgeeks|javatpoint|tutorial|course|medium\.|substack\.com/i;

/**
 * Rank a source URL into a numeric tier (lower = better). Deterministic.
 * RANK_OFFICIAL (1) → official docs/registries; RANK_LOW (4) → blogs/forums.
 */
function rankSource(url) {
  let host = '';
  try { host = new URL(String(url)).hostname.replace(/^www\./, '').toLowerCase(); } catch { return RANK_LOW; }
  if (OFFICIAL_HOSTS.test(host)) return RANK_OFFICIAL;
  if (/(^|\.)github\.com$|(^|\.)gitlab\.com$|(^|\.)readthedocs\.(io|org)$|(^|\.)w3\.org$|(^|\.)ietf\.org$/i.test(host)) return RANK_PRIMARY;
  if (LOW_HOSTS.test(host)) return RANK_LOW;
  return RANK_SECONDARY;
}

const RANK_LABEL = { 1: 'official', 2: 'primary', 3: 'secondary', 4: 'low' };

// --- Source-type classification (deterministic) ------------------------------
const HOST_PATTERNS = [
  { re: /(^|\.)github\.com$|(^|\.)gitlab\.com$|(^|\.)codeberg\.org$/i, type: 'official_repository', authority: 0.92, primary: true },
  { re: /(^|\.)readthedocs\.(io|org)$/i, type: 'official_documentation', authority: 0.9, primary: true },
  { re: /(^|\.)developer\./i, type: 'official_documentation', authority: 0.88, primary: true },
  { re: /(^|\.)w3\.org$|(^|\.)ietf\.org$|(^|\.)ecma-international\.org$/i, type: 'specification', authority: 0.95, primary: true },
  { re: /(^|\.)arxiv\.org$/i, type: 'primary_research', authority: 0.85, primary: true },
  { re: /stackoverflow\.com$|(^|\.)stackexchange\.com$/i, type: 'community_discussion', authority: 0.6, primary: false },
  { re: /reddit\.com$|(^|\.)news\.ycombinator\.com$/i, type: 'community_discussion', authority: 0.45, primary: false },
  { re: /medium\.com$|dev\.to$|hashnode\.dev$/i, type: 'technical_blog', authority: 0.55, primary: false },
  { re: /(^|\.)wikipedia\.org$/i, type: 'encyclopedia', authority: 0.65, primary: false },
];

/** Classify a URL into a source type + base authority (0..1). */
function classifySource(url) {
  let host = '';
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch { host = ''; }
  for (const p of HOST_PATTERNS) {
    if (host && p.re.test(host)) return { host, type: p.type, authority: p.authority, primary: p.primary };
  }
  // A project's own domain is often its official site — treat bare domains as
  // semi-official (we cannot prove ownership, so authority stays moderate).
  if (host) return { host, type: 'project_website', authority: 0.6, primary: true };
  return { host: '', type: 'unknown', authority: 0.3, primary: false };
}

// --- Relevance (§9) ----------------------------------------------------------
const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'what', 'who', 'when', 'where', 'why', 'how', 'does', 'do', 'did', 'for', 'and', 'or', 'of', 'in', 'on', 'to', 'it', 'this', 'that', 'with', 'about', 'should', 'can', 'you', 'i', 'we']);

function tokens(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t));
}

// Framing words that carry no topical meaning — removed before scoring so
// proper nouns/subjects dominate. (Complements `STOP` which is for tokenizing.)
const FRAMING = new Set(['should', 'would', 'could', 'need', 'needs', 'want', 'use', 'using', 'used', 'for', 'with', 'about', 'into', 'good', 'better', 'best', 'right', 'way', 'fit', 'fits', 'suit', 'suitable', 'recommend', 'recommendation', 'advice', 'consider', 'please', 'tell', 'give', 'make', 'does', 'really', 'actually', 'zara', 'studio', 'aculyze']);

function contentTokens(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t) && !FRAMING.has(t));
}

/**
 * Label a candidate's relevance to the question.
 * Computed best at the SOURCE/PAGE level (title + snippet + opening text): a
 * page that is about the subject makes all its extracted claims relevant.
 * @returns {{ label:'RELEVANT'|'PARTIALLY_RELEVANT'|'IRRELEVANT', score:number }}
 */
function relevance(text, question) {
  const qt = contentTokens(question);
  if (!qt.length) return { label: 'PARTIALLY_RELEVANT', score: 0.5 };
  const hay = new Set(tokens(text));
  let hits = 0;
  for (const t of qt) if (hay.has(t)) hits += 1;
  const score = hits / qt.length;
  if (score >= 0.34) return { label: 'RELEVANT', score };
  if (score >= 0.15) return { label: 'PARTIALLY_RELEVANT', score };
  return { label: 'IRRELEVANT', score };
}

// --- Freshness ---------------------------------------------------------------
/** Freshness from a last-updated hint if present, else a neutral default. */
function freshness(pageText) {
  const m = /(last\s+(?:updated|modified)|published|updated)\D{0,10}((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,4},?\s+20\d{2}|20\d{2}[-/]\d{2}[-/]\d{2})/i.exec(String(pageText || ''));
  if (!m) return 0.7; // neutral: unknown but not stale by default
  const yr = /20\d{2}/.exec(m[2]);
  if (!yr) return 0.7;
  const year = Number(yr[0]);
  const thisYear = new Date().getFullYear();
  const age = Math.max(0, thisYear - year);
  return Math.max(0.2, 1 - age * 0.15); // decays ~0.15/yr
}

// --- Dedup (§9) --------------------------------------------------------------
function dedupeKey(sourceUrl, claim) {
  const host = (() => { try { return new URL(sourceUrl).hostname.replace(/^www\./, ''); } catch { return String(sourceUrl); } })();
  const sig = String(claim || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);
  return `${host}|${sig}`;
}

/**
 * Build a structured evidence record from a real tool result.
 * @param {{ claim, sourceUrl, sourceTitle?, snippet?, question, sourceTypeOverride? }} input
 * @returns {object|null} evidence record, or null if the claim is empty.
 */
function makeEvidence({ claim, sourceUrl, sourceTitle = '', snippet = '', question, sourceTypeOverride = null, pageRelevance = null, claimedValue = null, fetchedText = null, fetchedAt = null, fetchStatus = 'ok' }) {
  const text = String(claim || '').trim();
  if (!text) return null;
  const src = sourceTypeOverride
    ? { type: sourceTypeOverride.type, authority: sourceTypeOverride.authority, primary: sourceTypeOverride.primary, host: classifySource(sourceUrl).host }
    : classifySource(sourceUrl);

  // Relevance is computed at the SOURCE/PAGE level upstream (a page about the
  // subject makes all its claims relevant). Fall back to claim-level only when
  // no page-level value is supplied.
  const rel = pageRelevance || relevance(`${sourceTitle} ${text}`, question);
  const fresh = freshness(`${sourceTitle} ${snippet} ${text}`);

  // Composite confidence = weighted blend (transparent, deterministic).
  const authority = src.authority;
  const confidence = Number((authority * 0.45 + rel.score * 0.35 + fresh * 0.2).toFixed(3));

  const rank = rankSource(sourceUrl);

  return {
    id: nextEvidenceId(),
    claim: text.slice(0, 500),
    source: String(sourceUrl || ''),
    sourceTitle: String(sourceTitle || '').slice(0, 200),
    sourceType: src.type,
    primary: !!src.primary,
    retrievedAt: new Date().toISOString(),
    relevance: Number(rel.score.toFixed(3)),
    relevanceLabel: rel.label,
    authority: Number(authority.toFixed(3)),
    freshness: Number(fresh.toFixed(3)),
    confidence,
    verification: 'UNVERIFIED', // set by the verifier
    supports: [],               // filled by the researcher (objective ids)
    // Structured fact fields (version lookups / verified values).
    claimedValue: claimedValue != null ? String(claimedValue) : null,
    sourceRank: rank,
    sourceRankLabel: RANK_LABEL[rank] || 'secondary',
    // The actual fetched text (or an excerpt containing the value) — the
    // verifier confirms the claimed value literally appears here.
    fetchedText: fetchedText != null ? String(fetchedText).slice(0, 4000) : null,
    fetchedAt: fetchedAt || null,     // UTC ISO timestamp of the fetch
    fetchStatus,                       // 'ok' | 'failed' | 'empty'
  };
}

module.exports = {
  classifySource,
  relevance,
  freshness,
  makeEvidence,
  dedupeKey,
  tokens,
  resetEvidenceIds,
  rankSource,
  RANK_OFFICIAL,
  RANK_PRIMARY,
  RANK_SECONDARY,
  RANK_LOW,
};
