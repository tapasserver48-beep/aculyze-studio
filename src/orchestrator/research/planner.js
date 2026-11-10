/**
 * Research engine — task planner (§5).
 *
 * Turns a research question + intent category into a bounded, structured plan
 * of subtasks. Each subtask has:
 *   { id, objective, query, requiredEvidence, status, dependsOn, result }
 *
 * The plan is deterministic (template + heuristics + optional LLM-formed
 * queries). It is capped at MAX_SUBTASKS and every subtask declares the kind of
 * evidence that would satisfy it, which the verifier/gap-detector later uses to
 * decide whether the question is actually answerable.
 */

const { readLimits } = require('./limits');

let seq = 0;
function nextId(prefix) { seq += 1; return `${prefix}-${String(seq).padStart(3, '0')}`; }
function resetIds() { seq = 0; } // exported for deterministic tests

/**
 * Extract concrete comparison subjects ("A vs B", "difference between A and B").
 * Returns [A, B] or null.
 */
function comparisonSubjects(m) {
  const vs = /\b(.{2,60}?)\s+(?:vs\.?|versus)\s+(.{2,60}?)(?:\s+for\b|[?,.]|$)/i.exec(m);
  if (vs) return [vs[1].trim(), vs[2].trim()];
  const between = /\bdifference\s+between\s+(.{2,60}?)\s+and\s+(.{2,60}?)(?:\s+for\b|[?,.]|$)/i.exec(m);
  if (between) return [between[1].trim(), between[2].trim()];
  return null;
}

/** The main noun/subject of a question (best-effort, deterministic). */
function mainSubject(m) {
  let s = normalizeResearchSubject(m);
  if (s.length > 80) s = s.slice(0, 80).trim();
  return s || m.trim().slice(0, 80);
}

/** Remove request framing while retaining the complete topic and qualifiers. */
function normalizeResearchSubject(input) {
  let s = String(input || '').replace(/\s+/g, ' ').trim();
  s = s.replace(/^(?:(?:hey|ok)\s+)?(?:zara\s*[,.:]?\s*)?(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?/i, '');
  const prefixes = [
    /^(?:search\s+(?:(?:the\s+)?(?:web|internet|online|browser))(?:\s+for)?|search\s+(?:online\s+)?for)\s+/i,
    /^(?:check\s+online\s+for|look\s+up|look\s+for|browse\s+for|browse|research|investigate|find\s+out|find|verify|tell\s+me\s+about)\s+/i,
    /^(?:what\s+are|what\s+is|what's|whats)\s+(?:the\s+)?(?:latest|most\s+recent|current)\s+/i,
    /^(?:what\s+happened\s+with|what's\s+happening\s+with|what\s+is\s+happening\s+with)\s+/i,
    /^and\s+tell\s+me\s+(?:what\s+)?(?:happened\s+with\s+)?/i,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of prefixes) {
      const next = s.replace(re, '');
      if (next !== s) { s = next; changed = true; break; }
    }
  }
  // Temporal framing at the start describes freshness, not the subject.
  s = s.replace(/^(?:the\s+)?(?:latest|most\s+recent|current|today's|today\s+)?\s*/i, '');
  // Remove common request tails without stripping useful modifiers in the middle.
  s = s.replace(/\s+(?:and\s+)?(?:summarize|explain|describe)\s+(?:(?:it|them|this|these)\b)?[\s\S]*$/i, '');
  s = s.replace(/\s+and\s+tell\s+me(?:\s+what)?[\s\S]*$/i, '');
  s = s.replace(/[?.!]+$/g, '').replace(/\s+/g, ' ').trim();
  return s;
}

function isVulnerabilityResearch(text) {
  return /\b(?:security\s+vulnerabilit(?:y|ies)|vulnerabilit(?:y|ies)|\bCVEs?\b|security\s+advisories|security\s+releases|exploits?|affected\s+versions|fixed\s+versions)\b/i.test(String(text || ''));
}

/**
 * Build a plan. `llmFormQueries` is an OPTIONAL async hook that lets the model
 * phrase better search queries (semantic task). If absent (or fails) we fall
 * back to deterministic query strings — planning never depends on the LLM.
 *
 * @returns {Promise<{ question, category, subtasks: [] }>}
 */
async function buildPlan(question, category, { llmFormQueries = null, limits = readLimits(), entities = [], type = null } = {}) {
  const q = String(question || '').trim();
  const subtasks = [];
  const push = (objective, query, requiredEvidence, dependsOn = [], extra = {}) => {
    if (subtasks.length >= limits.MAX_SUBTASKS) return;
    subtasks.push({
      id: nextId('subtask'),
      objective,
      query: String(query || '').slice(0, 200),
      requiredEvidence,
      status: 'pending',
      dependsOn,
      result: null,
      // Per-item evidence slot (version_lookup / multi-item questions).
      entity: extra.entity || null,
      toolPreference: extra.toolPreference || null,
      evidenceSlot: extra.entity ? { value: null, source: null, asOf: null, status: 'pending' } : null,
    });
  };

  // 1) Version-lookup / multi-item: ONE subtask per named item, each with its
  //    own official-source-first tool plan and its own evidence slot. This is
  //    what stops items from being collapsed into one blob.
  if (entities && entities.length >= 1 && (type === 'version_lookup' || category === 'version' || category === 'current')) {
    for (const ent of entities) {
      push(`Determine the latest stable version of ${ent}`, `${ent} latest stable version`, ['version'], [], {
        entity: ent,
        toolPreference: 'official_source',
      });
    }
    return { question: q, category, type, entities, subtasks };
  }

  // 2) Establish what the subject is.
  const subject = mainSubject(q);
  const vulnerabilityResearch = isVulnerabilityResearch(`${q} ${subject}`);

  if (vulnerabilityResearch) {
    const cleanSubject = subject.replace(/\b(?:latest|most\s+recent|current)\b/ig, '').replace(/\s+/g, ' ').trim();
    const node = /\bnode(?:\.js)?\b/i.test(cleanSubject);
    push(`Identify recent ${cleanSubject} vulnerabilities, affected versions, fixes, and impact.`, `${cleanSubject} CVE vulnerability affected versions fixed versions severity official advisory`, ['vulnerability_details', 'cve', 'affected_versions', 'fixed_versions', 'severity']);
    push(`Find official security advisories for ${cleanSubject}.`, `${node ? 'site:nodejs.org/en/blog/vulnerability Node.js' : cleanSubject} security advisory CVE affected fixed versions severity impact`, ['official_advisory', 'vulnerability_details', 'cve']);
    return { question: q, category, type, entities, subject: cleanSubject, vulnerabilityResearch: true, subtasks };
  }

  push(`Establish what ${subject} is`, `${subject} official overview`, ['definition', 'official_source']);

  // 2) Category-specific subtasks.
  if (category === 'comparison') {
    const subs = comparisonSubjects(q);
    if (subs) {
      const [a, b] = subs;
      push(`Establish key facts about ${a}`, `${a} official site features licensing`, ['facts'], [], { entity: a });
      push(`Establish key facts about ${b}`, `${b} official site features licensing`, ['facts'], [], { entity: b });
      push(`Compare ${a} vs ${b} on relevant dimensions`, `${a} vs ${b} comparison`, ['comparison'], [2, 3]);
    } else {
      push('Identify the alternatives to compare', `${subject} alternatives comparison`, ['comparison']);
    }
  } else if (category === 'recommendation') {
    push(`Determine current licensing for ${subject}`, `${subject} license official`, ['licensing']);
    push(`Determine self-hosting / local availability for ${subject}`, `${subject} self-hosted local install`, ['deployment']);
    push(`Determine limitations and compatibility for ${subject}`, `${subject} limitations compatibility`, ['limitations']);
    push(`Map ${subject} to the stated requirements`, `${subject} requirements fit`, ['fit'], [1, 2, 3]);
  } else if (category === 'current') {
    push(`Find the most recent authoritative statement on ${subject}`, `${subject} latest official announcement`, ['freshness']);
  } else if (category === 'technical_research') {
    push(`Verify the technical detail for ${subject}`, `${subject} official documentation`, ['technical_detail']);
  }

  // Optional: let the model improve the query phrasing (semantic), keeping ids
  // and structure intact. Never required.
  if (typeof llmFormQueries === 'function') {
    try {
      const better = await llmFormQueries({ question: q, category, objectives: subtasks.map((s) => s.objective) });
      if (Array.isArray(better)) {
        better.forEach((query, i) => { if (subtasks[i] && query) subtasks[i].query = String(query).slice(0, 200); });
      }
    } catch { /* planning must never fail because the model did */ }
  }

  return { question: q, category, subject, vulnerabilityResearch: false, subtasks };
}

module.exports = { buildPlan, comparisonSubjects, mainSubject, normalizeResearchSubject, isVulnerabilityResearch, resetIds };
