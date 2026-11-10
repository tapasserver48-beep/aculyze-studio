/**
 * Research engine — Research Manager (§6).
 *
 * A bounded, deterministic research loop. Executes the plan's subtasks by
 * searching + fetching through the ToolRegistry, extracts evidence, and decides
 * (via the verifier's gap detection) whether another round is required — always
 * inside the hard limits. It NEVER loops forever: MAX_RESEARCH_ROUNDS,
 * MAX_TOOL_CALLS, MAX_SOURCES and MAX_SUBTASKS are absolute.
 *
 * The loop does not call the LLM (query formulation is deterministic here; the
 * planner may optionally use the model to phrase queries upstream). This keeps
 * research termination deterministic and testable without a model.
 */

const { readLimits } = require('./limits');
const { performance } = require('perf_hooks');
const { makeEvidence, dedupeKey, relevance, rankSource, RANK_LOW } = require('./evidence');
const { officialSourceFor } = require('./toolRegistry');
const { isVulnerabilityResearch } = require('./planner');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Max times a failing official-source/fetch for one item is retried.
const MAX_RETRIES_PER_TOOL = 2;

/** Order search hits by source rank (official first, blogs/forums last). */
function rankCandidates(candidates) {
  return [...candidates].sort((a, b) => rankSource(a.url) - rankSource(b.url));
}

/**
 * Best-effort extraction of a version-like value from a fallback claim (used
 * only when the official source failed). Deterministic regex; returns null if
 * no version pattern is present (never invents a value).
 */
function guessValue(claim, entity) {
  const re = /(\d+\.\d+(?:\.\d+)?)/;
  const m = re.exec(String(claim || ''));
  return m ? m[1] : null;
}

/**
 * Extract candidate claims from a fetched page. Deterministic: we pull the
 * sentences that overlap the question tokens most (a cheap relevance proxy),
 * anchored to the real source URL — no fabrication.
 */
function isSubstantiveVulnerabilityClaim(claim) {
  const text = String(claim || '').trim();
  if (!text || text.length < 45) return false;
  if (/^(?:wednesday|thursday|friday|monday|tuesday|saturday|sunday),?\s+[a-z]+\s+\d{1,2},?\s+20\d{2}\s+security releases?\.?$/i.test(text)) return false;
  if (/^(?:this|the) security release includes the following .* vulnerabilities\.?$/i.test(text)) return false;
  const hasId = /\bCVE-\d{4}-\d{3,}\b/i.test(text);
  const hasSubstance = /\b(?:vulnerabilit\w*|affected|affects|fixed|patched|severity|CVSS|CWE|exploit|arbitrary|denial of service|code execution|privilege|bypass|impact|security flaw|security issue)\b/i.test(text);
  const hasDetail = /\b(?:affects?|affecting|affected|fixed|patched|upgrade|versions?|severity|CVSS|CWE|allows?|enables?|could|may|results? in|causes?|impact|vulnerabilit\w*)\b/i.test(text);
  return (hasId && hasDetail) || (hasSubstance && hasDetail && text.split(/\s+/).length >= 9);
}

function extractClaims(pageText, question, maxClaims = 3, { vulnerability = isVulnerabilityResearch(question) } = {}) {
  const qTokens = new Set(String(question || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4));
  const sentences = String(pageText || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 40 && s.length <= 400);
  const scored = sentences.map((s) => {
    const words = s.toLowerCase().split(/[^a-z0-9]+/);
    let hits = 0;
    for (const w of words) if (qTokens.has(w)) hits += 1;
    let quality = 0;
    if (/\bCVE-\d{4}-\d{3,}\b/i.test(s)) quality += 12;
    if (/\b(?:vulnerabilit\w*|security flaw|security issue|advisory)\b/i.test(s)) quality += 4;
    if (/\b(?:affected|affects|fixed|patched|severity|CVSS|CWE|exploit|arbitrary|denial of service|code execution|privilege|bypass|impact)\b/i.test(s)) quality += 5;
    if (/\b(?:affected|fixed|patched)\s+versions?\b/i.test(s)) quality += 3;
    if (/\b(?:this security release includes the following|click here|read more|table of contents)\b/i.test(s)) quality -= 10;
    if (/^(?:wednesday|thursday|friday|monday|tuesday|saturday|sunday),?\s+[a-z]+\s+\d{1,2},?\s+20\d{2}\s+security releases?\.?$/i.test(s)) quality -= 12;
    if (vulnerability && !isSubstantiveVulnerabilityClaim(s)) quality -= 20;
    return { s, hits, quality };
  }).sort((a, b) => (b.quality - a.quality) || (b.hits - a.hits));
  const eligible = vulnerability ? scored.filter((x) => isSubstantiveVulnerabilityClaim(x.s)) : scored.filter((x) => x.hits > 0);
  const chosen = eligible.slice(0, maxClaims).map((x) => x.s);
  // If nothing matched, fall back to the first couple of substantive sentences.
  return chosen.length ? chosen : vulnerability ? [] : sentences.slice(0, Math.min(2, maxClaims));
}

/**
 * Run the bounded research loop.
 * @param {{ plan, tool, question, requiredTypes?, sm?, limits? }} deps
 *   plan   — from planner.buildPlan
 *   tool   — a ToolRegistry instance
 *   sm     — optional ResearchStateMachine for tracing
 * @returns {Promise<{ evidenceList, conflicts, tool, rounds, trace }>}
 */
async function research({ plan, tool, question, requiredTypes = [], sm = null, limits = readLimits() }) {
  const evidenceList = [];
  const seen = new Set();
  let rounds = 0;
  const collectEvidence = [];

  async function runSubtask(subtask) {
    subtask.status = 'running';
    subtask.attempts = (subtask.attempts || 0);
    const isVersion = !!subtask.entity && subtask.toolPreference === 'official_source';

    // --- 1) Official source FIRST for version lookups (10s timeout, JSON) ---
    if (isVersion && officialSourceFor(subtask.entity)) {
      subtask.attempts += 1;
      sm?.mark('official_source_started', { subtask: subtask.id, entity: subtask.entity });
      sm?.mark('fetch_started', { subtask: subtask.id, url: officialSourceFor(subtask.entity).url, kind: 'official' });
      const officialStarted = performance.now();
      const off = await tool.officialSource(subtask.entity);
      sm?.mark('fetch_completed', { subtask: subtask.id, url: off.url, kind: 'official', ok: off.ok, duration_ms: Math.round(performance.now() - officialStarted) });
      sm?.mark('source_collected', { subtask: subtask.id, kind: 'official_source', ok: off.ok, url: off.url, error: off.error });
      if (off.ok && off.value) {
        const ev = makeEvidence({
          claim: `The latest stable version of ${subtask.entity} is ${off.value}.`,
          sourceUrl: off.url,
          sourceTitle: `Official ${subtask.entity} release endpoint`,
          question,
          claimedValue: off.value,
          fetchedText: off.rawText,       // real payload — verifier checks the value is in it
          fetchedAt: off.fetchedAt,
          fetchStatus: 'ok',
          pageRelevance: { label: 'RELEVANT', score: 1 },
        });
        ev.supports = [subtask.id];
        ev.supportsType = subtask.requiredEvidence || [];
        evidenceList.push(ev);
        subtask.status = 'done';
        subtask.result = { value: off.value, source: off.url, via: 'official_source' };
        if (subtask.evidenceSlot) subtask.evidenceSlot = { value: off.value, source: off.url, asOf: off.fetchedAt, status: 'verified' };
        sm?.mark('evidence_extracted', { id: ev.id, subtask: subtask.id, value: off.value, sourceRank: ev.sourceRank });
        return;
      }
      // Official source failed — record it as a failed fetch (unverified path)
      // and fall through to search. Mark a failed-fetch evidence record so the
      // verifier/state machine see the failure honestly.
      const failEv = makeEvidence({
        claim: `Could not retrieve the official ${subtask.entity} version (official source failed: ${off.error}).`,
        sourceUrl: off.url || `official:${subtask.entity}`,
        sourceTitle: `Official ${subtask.entity} release endpoint`,
        question,
        claimedValue: null,
        fetchedText: off.rawText || null,
        fetchedAt: off.fetchedAt || null,
        fetchStatus: 'failed',
        pageRelevance: { label: 'RELEVANT', score: 1 },
      });
      if (failEv) { failEv.supports = [subtask.id]; failEv.supportsType = subtask.requiredEvidence || []; evidenceList.push(failEv); }
      if (subtask.evidenceSlot) subtask.evidenceSlot = { value: null, source: off.url || null, asOf: null, status: 'failed' };
      // If we already retried twice, stop here and leave it unverified.
      if (subtask.attempts >= MAX_RETRIES_PER_TOOL) { subtask.status = 'unverified'; subtask.result = { error: off.error, attempts: subtask.attempts }; return; }
    }

    // --- 2) Search fallback (ranked candidates, full-page fetch) ---
    sm?.mark('source_search_started', { subtask: subtask.id, query: subtask.query });
    sm?.mark('search_started', { subtask: subtask.id });
    sm?.mark('search_query', { subtask: subtask.id, query: subtask.query });
    subtask.attempts += 1;
    const searchStarted = performance.now();
    const s = await tool.search(subtask.query);
    sm?.mark('search_completed', { subtask: subtask.id, ok: s.ok, result_count: s.results?.length || 0, error: s.error ? String(s.error).slice(0, 160) : undefined, duration_ms: Math.round(performance.now() - searchStarted) });
    if (s.ok) sm?.mark('search_result', { subtask: subtask.id, result_count: s.results?.length || 0 });
    if (!s.ok) {
      subtask.status = subtask.attempts >= MAX_RETRIES_PER_TOOL ? 'unverified' : 'failed';
      subtask.result = { error: s.error };
      sm?.mark('source_collected', { subtask: subtask.id, ok: false, error: s.error });
      return;
    }
    // Rank by source quality so official domains are fetched first and
    // blogs/forums/reddit last (never the only thing tried).
    const candidates = rankCandidates(s.results).slice(0, limits.MAX_CANDIDATES_PER_QUERY);
    let gotPage = false;
    for (const c of candidates) {
      if (!tool.canCall()) break;
      sm?.mark('source_fetch_started', { subtask: subtask.id, url: c.url, title: c.title || '' });
      sm?.mark('fetch_started', { subtask: subtask.id, url: c.url, title: c.title || '' });
      const fetchStarted = performance.now();
      const f = await tool.fetch(c.url);
      sm?.mark('fetch_completed', { subtask: subtask.id, url: c.url, title: c.title || '', ok: f.ok, duration_ms: Math.round(performance.now() - fetchStarted) });
      sm?.mark('source_collected', { subtask: subtask.id, ok: f.ok, url: c.url, rank: rankSource(c.url) });
      if (!f.ok) continue;
      gotPage = true;
      // Compute relevance at the PAGE level (title + snippet + opening text)
      // so a page about the subject keeps all its extracted claims.
      const fullText = f.page?.text || '';
      const pageRelevance = relevance(
        `${c.title || ''} ${c.snippet || ''} ${fullText.slice(0, 600)}`,
        question,
      );
      const vulnerability = isVulnerabilityResearch(`${question} ${subtask.objective} ${subtask.query}`);
      const extractionQuestion = vulnerability ? `${subtask.objective} ${subtask.query}` : question;
      const claims = extractClaims(fullText, extractionQuestion, 5, { vulnerability });
      let usefulCount = 0;
      const fetchedAt = new Date().toISOString();
      for (const claim of claims) {
        const ev = makeEvidence({
          claim,
          sourceUrl: c.url,
          sourceTitle: c.title || f.page?.title || '',
          snippet: c.snippet || '',
          question,
          pageRelevance,
          claimedValue: subtask.entity ? guessValue(claim, subtask.entity) : null,
          fetchedText: fullText,   // full page text — the verifier checks against it
          fetchedAt,
          fetchStatus: 'ok',
        });
        if (!ev) continue;
        const key = dedupeKey(ev.source, ev.claim);
        if (seen.has(key)) continue; // duplicate evidence
        seen.add(key);
        ev.supports = [subtask.id];
        ev.supportsType = subtask.requiredEvidence || [];
        if (vulnerability) ev.researchKind = 'vulnerability';
        evidenceList.push(ev);
        collectEvidence.push(ev);
        usefulCount += 1;
        sm?.mark('evidence_extracted', { id: ev.id, subtask: subtask.id, authority: ev.authority, relevance: ev.relevance, sourceRank: ev.sourceRank });
      }
      // Fetch a couple of sources for corroboration (official + one backup),
      // but never treat a single low-rank page as enough on its own.
      if (gotPage && rankSource(c.url) !== RANK_LOW && !isVersion && (!vulnerability || usefulCount > 0)) break;
    }
    const hasUsefulEvidence = evidenceList.some((item) => item.supports.includes(subtask.id));
    const isVulnerability = isVulnerabilityResearch(`${question} ${subtask.objective} ${subtask.query}`);
    subtask.status = gotPage && (!isVulnerability || hasUsefulEvidence) ? 'done' : (subtask.attempts >= MAX_RETRIES_PER_TOOL ? 'unverified' : 'no-source');
    if (isVulnerability && !hasUsefulEvidence && subtask.attempts < MAX_RETRIES_PER_TOOL) {
      const node = /\bnode(?:\.js)?\b/i.test(`${question} ${subtask.objective}`) ? 'Node.js ' : '';
      subtask.query = `${subtask.query} ${node}security advisory CVE affected fixed versions`;
    }
    subtask.result = { evidence: evidenceList.filter((e) => e.supports.includes(subtask.id)).length };
  }

  // Outer bounded loop: run pending subtasks, then re-run if gaps demand it.
  // Retries are capped (MAX_RETRIES_PER_TOOL = 2) so a failing item stops.
  while (rounds < limits.MAX_RESEARCH_ROUNDS && tool.canCall()) {
    rounds += 1;
    sm?.mark('research_round', { round: rounds });
    const pending = plan.subtasks.filter((st) =>
      (st.status === 'pending' || st.status === 'failed' || st.status === 'no-source')
      && (st.attempts || 0) < MAX_RETRIES_PER_TOOL);
    if (!pending.length) break;
    for (const st of pending) {
      if (!tool.canCall()) break;
      await runSubtask(st);
    }
    // If every subtask that produced nothing has been retried, stop.
    const stillPending = plan.subtasks.some((st) =>
      (st.status === 'pending' || st.status === 'failed' || st.status === 'no-source')
      && (st.attempts || 0) < MAX_RETRIES_PER_TOOL);
    if (!stillPending) break;
  }

  return { evidenceList, tool, rounds, collectEvidence };
}

module.exports = { research, extractClaims, isSubstantiveVulnerabilityClaim, rankCandidates, guessValue };
