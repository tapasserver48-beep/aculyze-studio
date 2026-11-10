/**
 * Research engine — intent understanding (§4).
 *
 * Decides WHETHER a message needs the research pipeline at all. This is a
 * separate, additive layer: it runs alongside the existing deterministic
 * intentRouter (which still owns computer/browser/youtube routing) and never
 * mutates it. Research is the expensive path, so the default is "no research" —
 * only clearly research-shaped questions are promoted.
 *
 * Deterministic heuristics only (no model call, no side effects). Categories:
 *   conversation | knowledge | research | comparison | recommendation
 *   | technical_research | current | calculation | internal | interaction
 *
 * Interaction (computer/browser/youtube) is never claimed here — the existing
 * routers own those. This layer only answers: "does answering this require
 * gathering fresh external evidence?"
 */

// Phrases that imply the answer depends on the present moment / recent state.
const CURRENT_RE = /\b(latest|recent|current|now|today|tonight|this\s+(?:year|month|week)|as\s+of|newest|v?[\d.]+\s+is\s+out|what'?s\s+new|breaking|20\d{2}|prices?|pricing|costs?|news|weather|forecasts?|security\s+advisories|vulnerabilit(?:y|ies)|cves?|exchange\s+rates?|stock\s+quotes?|release\s+notes|changelogs?)\b/i;

// Comparison framing.
const COMPARE_RE = /\b(compare|versus|vs\.?|difference\s+between|better\s+than|which\s+(?:is\s+)?(?:better|faster|cheaper|safer)|pros\s+and\s+cons|stack\s+up)\b/i;

// Recommendation / decision framing.
const RECOMMEND_RE = /\b(should\s+(?:i|we|you)|recommend|advice|worth\s+(?:it|using|switching)|do\s+you\s+suggest|is\s+it\s+a\s+good\s+idea|evaluate|assess|decide)\b/i;

// Explicit research framing.
const RESEARCH_RE = /\b(research|investigate|find\s+out|look\s+into|dig\s+into|study\s+the|sources?|evidence|verify|confirm\s+whether|is\s+it\s+true)\b/i;
const WEB_RE = /\b(?:search|browse|look\s+up|find)\s+(?:the\s+)?(?:web|internet|online|browser)\b|\bonline\s+(?:search|research)\b|\bweb\s+search\b|\bsearch\s+for\b/i;

// Technical-research framing.
const TECHNICAL_RE = /\b(licen[cs]e|self-?host|deploy|compatib|integrat|api|sdk|benchmark|performance|overhead|architecture|dependency|dependencies|protocol|implementation|spec)\b/i;

// Calculation framing (handled deterministically elsewhere; not web research).
const CALC_RE = /^\s*(?:what\s+is\s+)?-?[\d.,]+\s*[-+*/^%]\s*[\d.,(].*$/i;

// Questions a small local model can answer from parametric knowledge (no web).
const KNOWLEDGE_RE = /^\s*(?:what\s+is|who\s+is|who\s+was|define|explain|meaning\s+of|capital\s+of|how\s+does)\b/i;

// Internal data / API (not web research — belongs to integrations/LMS).
const INTERNAL_RE = /\b(my\s+(?:sales|orders?|customers?|revenue|inventory|erp|lms|dashboard|data)|from\s+our\s+(?:api|database|erp)|internal\s+(?:api|data))\b/i;

// "latest/current/newest version" framing → a version_lookup fact question.
const VERSION_RE = /\b(?:latest|current|newest|most\s+recent)\s+(?:stable\s+)?versions?\b|\bversions?\s+(?:of|for)\b|\bwhat(?:'s|\s+is)\s+the\s+(?:latest|current)\b/i;

// Leading verbs/framing stripped before pulling named entities out.
const LEAD_STRIP_RE = /^\s*(?:hey\s+|ok\s+)?(?:zara\s*[,.]?\s*)?(?:please\s+)?(?:give\s+me\s+|list\s+|show\s+|tell\s+me\s+|what\s+are\s+|what'?s\s+|whats\s+|find\s+|get\s+)+/i;

// Words that look capitalized but are not named entities.
const NOT_ENTITY = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'latest', 'current', 'newest', 'stable', 'versions', 'version', 'stable', 'where', 'you', 'confirmed', 'each', 'every', 'all', 'my', 'our', 'their', 'latest']);

/**
 * Extract named entities (proper-noun items) from a multi-item question.
 * Deterministic: strip leading verbs, split on commas/"and"/"&", keep segments
 * that look like proper nouns (capitalised or a known tech token).
 * @returns {string[]} entity names (cleaned, capped).
 */
function extractEntities(message) {
  const m = LEAD_STRIP_RE.exec(String(message || ''));
  let s = String(message || '').trim();
  if (m) s = s.slice(m[0].length);
  // Cut at framing that ends the item list ("…and tell me where you confirmed").
  s = s.replace(/\s+(?:and\s+)?(?:tell\s+me|let\s+me\s+know|show\s+me|include|with\s+their|where\s+you)\b[\s\S]*$/i, '');
  // Keep the segment after the first list keyword if present ("versions of X, Y and Z").
  const ofMatch = /\b(?:versions?|release|support)\s+(?:of|for)\s+/i.exec(s);
  if (ofMatch) s = s.slice(ofMatch.index + ofMatch[0].length);

  const parts = s
    .split(/\s*,\s*|\s+(?:and|&)\s+|\s+vs\.?\s+|\s+versus\s+/i)
    .map((p) => p.replace(/[?.!]+$/g, '').replace(/^(?:the|a|an)\s+/i, '').trim())
    .filter(Boolean);

  const entities = [];
  const seen = new Set();
  for (const p of parts) {
    if (!p || p.length > 40) continue;
    const first = p.split(/\s+/)[0];
    if (NOT_ENTITY.has(first.toLowerCase())) continue;
    // Proper-noun heuristic: starts with uppercase, or a known tech token.
    const looksNamed = /^[A-Z0-9]/.test(p) || /^(?:php|laravel|react|vue|django|rails|node(?:\.js)?|express|laravel|symfony|angular|svelte)$/i.test(p);
    if (!looksNamed) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entities.push(p);
    if (entities.length >= 6) break;
  }
  return entities;
}

/**
 * classify(message) → {
 *   category,             // one of the categories above
 *   requiresResearch,     // boolean — should the pipeline run?
 *   signals: [],          // which heuristics fired (for logs/tests)
 *   reason,               // short human-readable note
 *   type,                 // 'version_lookup' | null — live-fact sub-type
 *   entities,             // named items when a multi-item question is detected
 * }
 */
function classify(message) {
  const m = String(message || '').trim();
  const signals = [];

  if (!m) {
    return { category: 'conversation', requiresResearch: false, signals, reason: 'empty message', type: null, entities: [] };
  }

  // Explicit non-research categories win first.
  if (CALC_RE.test(m)) {
    return { category: 'calculation', requiresResearch: false, signals: ['calculation'], reason: 'arithmetic — no web research', type: null, entities: [] };
  }
  if (INTERNAL_RE.test(m)) {
    return { category: 'internal', requiresResearch: false, signals: ['internal-data'], reason: 'internal data/API — not web research', type: null, entities: [] };
  }

  if (CURRENT_RE.test(m)) signals.push('current');
  if (COMPARE_RE.test(m)) signals.push('comparison');
  if (RECOMMEND_RE.test(m)) signals.push('recommendation');
  if (RESEARCH_RE.test(m)) signals.push('research');
  if (WEB_RE.test(m)) signals.push('web');
  if (TECHNICAL_RE.test(m)) signals.push('technical');

  // Version-lookup fact questions ("latest stable versions of PHP, Laravel and
  // React"). Tagged so the planner emits one official-source subtask per item.
  const entities = extractEntities(m);
  const isVersionLookup = VERSION_RE.test(m) && (entities.length >= 1);
  const type = isVersionLookup ? 'version_lookup' : null;
  if (isVersionLookup) signals.push('version_lookup');

  const isQuestion = m.endsWith('?') || /^(?:why|how|what|when|where|which|who|can|does|do|is|are|should)\b/i.test(m);

  // Strong signals always require research.
  if (signals.includes('current')) {
    return { category: 'current', requiresResearch: true, signals, reason: 'depends on present/recent information', type, entities };
  }
  if (signals.includes('research')) {
    return { category: 'research', requiresResearch: true, signals, reason: 'explicit research/verification request', type, entities };
  }
  if (signals.includes('web')) {
    return { category: 'research', requiresResearch: true, signals, reason: 'explicit web search request', type, entities };
  }
  // Comparison of two concrete things requires gathering evidence on both —
  // whether phrased as a question ("A vs B?") or a command ("Compare A and B").
  if (signals.includes('comparison')) {
    return { category: 'comparison', requiresResearch: true, signals, reason: 'comparison needs evidence on each subject', type, entities };
  }
  // Recommendation on a concrete, non-generic subject requires evidence.
  if (signals.includes('recommendation') && (signals.includes('technical') || signals.includes('comparison')) && isQuestion) {
    return { category: 'recommendation', requiresResearch: true, signals, reason: 'decision needs current technical evidence', type, entities };
  }
  // A technical how/what question that is NOT a plain definition → research.
  if (signals.includes('technical') && isQuestion && !KNOWLEDGE_RE.test(m)) {
    return { category: 'technical_research', requiresResearch: true, signals, reason: 'technical question needs a current source', type, entities };
  }

  // Plain knowledge question → answer from the model, no research.
  if (KNOWLEDGE_RE.test(m)) {
    return { category: 'knowledge', requiresResearch: false, signals, reason: 'general knowledge — answer directly', type, entities };
  }

  // Default: conversation (the LLM answers without web research).
  return { category: 'conversation', requiresResearch: false, signals, reason: 'no research trigger matched', type, entities };
}

module.exports = { classify, extractEntities };
