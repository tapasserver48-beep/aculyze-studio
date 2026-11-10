/**
 * Research engine — hard limits.
 *
 * Every research run MUST terminate deterministically. These bounds are the
 * guard-rails that make the loop finite: no autonomous infinite research, no
 * unbounded tool calls, no runaway token spend. They are intentionally small
 * and conservative; tune via env but never set to Infinity.
 */

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function readLimits(env = process.env) {
  return {
    // Outer research loop rounds (a round = execute the ready subtasks once).
    MAX_RESEARCH_ROUNDS: clampInt(env.ZARA_RESEARCH_MAX_ROUNDS, 1, 8, 3),
    // Total research subtasks that may be created for one question.
    MAX_SUBTASKS: clampInt(env.ZARA_RESEARCH_MAX_SUBTASKS, 1, 20, 8),
    // Distinct sources (pages) that may be fetched for one question.
    MAX_SOURCES: clampInt(env.ZARA_RESEARCH_MAX_SOURCES, 1, 30, 10),
    // Total tool calls (search + fetch combined) for one question.
    MAX_TOOL_CALLS: clampInt(env.ZARA_RESEARCH_MAX_TOOL_CALLS, 1, 60, 18),
    // Candidate search hits considered per query (pre-filter).
    MAX_CANDIDATES_PER_QUERY: clampInt(env.ZARA_RESEARCH_MAX_CANDIDATES, 1, 20, 6),
    // Evidence items kept for reasoning (post-filter, strongest first).
    MAX_EVIDENCE: clampInt(env.ZARA_RESEARCH_MAX_EVIDENCE, 1, 40, 14),
    // Characters of page text pulled per source.
    PAGE_MAX_CHARS: clampInt(env.ZARA_RESEARCH_PAGE_CHARS, 500, 20000, 6000),
  };
}

module.exports = { readLimits };
