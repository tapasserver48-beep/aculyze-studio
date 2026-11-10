/**
 * Research engine — Reasoning Engine (§13).
 *
 * Receives the original question, intent, plan, verified evidence, conflicts and
 * gaps. It does NOT browse (the orchestrator decides further research). It
 * produces structured reasoning METADATA and conclusions — never hidden
 * chain-of-thought. The output is a structured record the synthesizer turns into
 * the final answer context.
 */

/**
 * @param {{ question, intent, plan, evidenceList, conflicts, gaps, confidence, subtaskConfidence }} input
 * @returns {object} structured reasoning metadata
 */
function reason({ question, intent = {}, plan = null, evidenceList = [], conflicts = [], gaps = [], confidence = {}, subtaskConfidence = null }) {
  // ONLY evidence that PASSED the verifier may be used. Partial/unverified are
  // excluded from what we assert — they may only inform the "couldn't verify"
  // list, never a fact.
  const verified = evidenceList.filter((e) => e.verification === 'VERIFIED');
  const unverified = evidenceList.filter((e) => e.verification !== 'VERIFIED');

  // Per-sub-task verdicts (the source of truth for the final answer lines).
  const perSubtask = (subtaskConfidence && subtaskConfidence.perSubtask) || [];
  const verifiedItems = perSubtask.filter((s) => s.status === 'verified');
  const unverifiedItems = perSubtask.filter((s) => s.status !== 'verified');

  // What do we know — only VERIFIED evidence.
  const known = verified.map((e) => ({ claim: e.claim, source: e.source, value: e.claimedValue, asOf: e.fetchedAt, confidence: e.confidence }));

  // What do we NOT know — unverified sub-tasks + high-severity gaps.
  const unknown = [
    ...unverifiedItems.map((s) => `Could not verify: ${s.entity}`),
    ...gaps.filter((g) => g.severity === 'high').map((g) => g.detail),
  ];

  // Conclusions that follow — only from VERIFIED evidence.
  const conclusions = known.slice(0, 6).map((k) => k.claim);

  // Conclusions that do NOT follow — unverified claims are explicitly excluded.
  const notConcluded = unverified.slice(0, 3).map((e) => ({ claim: e.claim, why: e.verifyReason || 'unverified evidence' }));
  conflicts.forEach((c) => notConcluded.push({ claim: c.claimA, why: `conflicts with ${c.sourceB}` }));

  // Recommendation — only if we have enough verified items and no blocking gaps.
  const enough = confidence.band === 'HIGH' || confidence.band === 'MEDIUM';
  const recommendation = enough && conclusions.length
    ? buildRecommendation({ question, intent, conclusions, conflicts })
    : null;

  return {
    known,
    unknown,
    conclusions,
    notConcluded,
    conflicts: conflicts.map((c) => ({ topic: c.topic, a: c.sourceA, b: c.sourceB })),
    recommendation,
    // Per-item verdicts drive the "one line per item" answer format.
    items: perSubtask,
    verifiedItems,
    unverifiedItems,
    counts: {
      total: evidenceList.length,
      verified: verified.length,
      unverified: unverified.length,
      itemsVerified: verifiedItems.length,
      itemsUnverified: unverifiedItems.length,
    },
  };
}

/** Deterministic recommendation template — grounded, hedged, honest. */
function buildRecommendation({ question, intent, conclusions, conflicts }) {
  const cat = intent.category || 'research';
  if (cat === 'comparison') {
    return 'Based on the verified sources, the two options differ as summarized above; weigh the dimensions that matter most to your use case.';
  }
  if (cat === 'recommendation') {
    return 'Based on the verified technical evidence and its fit to your stated requirements, the evidence supports the direction described above — with the noted limitations.';
  }
  return 'Based on the verified evidence, the points above are supported by the strongest sources.';
}

module.exports = { reason };
