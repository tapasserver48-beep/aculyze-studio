/**
 * Research engine — confidence (§15).
 *
 * Practical, honest confidence. NOT a fake mathematical guarantee. It combines
 * source quality, count of supporting sources, cross-source agreement, freshness
 * and directness into a numeric 0..1 plus a HIGH/MEDIUM/LOW band. It deliberately
 * penalizes unresolved conflicts and single-source answers so Zara never
 * overstates certainty.
 */

const BANDS = Object.freeze({ HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW', UNVERIFIED: 'UNVERIFIED' });

function bandFor(score) {
  if (score >= 0.72) return BANDS.HIGH;
  if (score >= 0.45) return BANDS.MEDIUM;
  return BANDS.LOW;
}

/**
 * Per sub-task confidence (§15) — computed ONLY from the Verifier's results.
 *   verified + official source (rank 1/2) → HIGH
 *   verified + secondary source (rank 3)  → MEDIUM
 *   anything else (low-rank alone, partial, unverified) → UNVERIFIED
 * This is what gates synthesis per item: an UNVERIFIED sub-task must render as
 * "I couldn't verify this" and may never be stated as fact.
 * @returns {{ subtaskId, entity, status, band, value, source, asOf, reason }}
 */
function computeSubtaskConfidence(subtask, evidenceList) {
  const mine = (evidenceList || []).filter((e) => (e.supports || []).includes(subtask.id));
  const passing = mine.filter((e) => e.verification === 'VERIFIED');
  const base = {
    subtaskId: subtask.id,
    entity: subtask.entity || subtask.objective,
    value: null,
    source: null,
    asOf: null,
  };

  // Prefer the best passing evidence: official/primary first, then by rank.
  const best = passing.sort((a, b) => (a.sourceRank - b.sourceRank) || (b.authority - a.authority))[0];
  if (!best) {
    // No passing evidence for this sub-task → unverified, no value.
    return { ...base, status: 'unverified', band: BANDS.UNVERIFIED, reason: 'no passing evidence' };
  }
  // A version/fact item with NO concrete value is NOT verified — a passing
  // record that carries no value cannot be presented as an answer for it.
  if (subtask.entity && !best.claimedValue) {
    return { ...base, status: 'unverified', band: BANDS.UNVERIFIED, reason: 'no concrete value verified' };
  }
  if (best.sourceRank <= 2) {
    return { ...base, status: 'verified', band: BANDS.HIGH, value: best.claimedValue, source: best.source, asOf: best.fetchedAt, reason: 'verified from official/primary source' };
  }
  return { ...base, status: 'verified', band: BANDS.MEDIUM, value: best.claimedValue, source: best.source, asOf: best.fetchedAt, reason: 'verified from secondary source' };
}

/**
 * Compute per-sub-task confidence for every sub-task in the plan.
 * @returns {{ perSubtask: Array, band: string, anyVerified: boolean, allUnverified: boolean }}
 */
function computePerSubtaskConfidence(plan, evidenceList) {
  const subtasks = (plan && plan.subtasks) || [];
  const perSubtask = subtasks.map((st) => computeSubtaskConfidence(st, evidenceList));
  const verified = perSubtask.filter((s) => s.status === 'verified');
  let band = BANDS.UNVERIFIED;
  if (verified.length === perSubtask.length && perSubtask.length > 0) {
    band = perSubtask.every((s) => s.band === BANDS.HIGH) ? BANDS.HIGH : BANDS.MEDIUM;
  } else if (verified.length > 0) {
    band = BANDS.MEDIUM; // partially verified overall
  }
  return {
    perSubtask,
    band,
    anyVerified: verified.length > 0,
    allUnverified: verified.length === 0,
  };
}

/**
 * @param {{ evidenceList:Array, conflicts:Array }} input
 * @returns {{ score:number, band:string, factors:object }}
 */
function computeConfidence({ evidenceList = [], conflicts = [] } = {}) {
  const usable = evidenceList.filter((e) => e.verification === 'VERIFIED' || e.verification === 'PARTIALLY_VERIFIED');
  if (!usable.length) return { score: 0, band: BANDS.LOW, factors: { note: 'no usable evidence' } };

  // Source quality (mean authority of usable evidence).
  const authority = usable.reduce((s, e) => s + (e.authority || 0), 0) / usable.length;

  // Number of independent supporting sources (distinct hosts).
  const hosts = new Set();
  usable.forEach((e) => { try { hosts.add(new URL(e.source).hostname.replace(/^www\./, '')); } catch { /* ignore */ } });
  const independent = hosts.size;
  const support = Math.min(1, independent / 3); // 3+ independent sources saturate

  // Agreement: penalize unresolved conflicts proportionally.
  const unresolved = conflicts.filter((c) => !c.resolved).length;
  const agreement = Math.max(0, 1 - unresolved * 0.35);

  // Freshness (mean).
  const freshness = usable.reduce((s, e) => s + (e.freshness || 0), 0) / usable.length;

  // Directness: share of VERIFIED (fully supported) evidence.
  const direct = usable.filter((e) => e.verification === 'VERIFIED').length / usable.length;

  const score = Number((
    authority * 0.3
    + support * 0.2
    + agreement * 0.2
    + freshness * 0.15
    + direct * 0.15
  ).toFixed(3));

  return {
    score,
    band: bandFor(score),
    factors: {
      authority: Number(authority.toFixed(3)),
      independentSources: independent,
      support: Number(support.toFixed(3)),
      agreement: Number(agreement.toFixed(3)),
      freshness: Number(freshness.toFixed(3)),
      directness: Number(direct.toFixed(3)),
      unresolvedConflicts: unresolved,
    },
  };
}

module.exports = { computeConfidence, computeSubtaskConfidence, computePerSubtaskConfidence, bandFor, BANDS };
