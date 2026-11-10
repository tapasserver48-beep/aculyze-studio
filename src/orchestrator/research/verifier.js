/**
 * Research engine — verification, contradiction detection, gap detection (§10–12,16).
 *
 * Before reasoning, every evidence record is verified. Verification answers:
 *   1. Is the source real (a URL we actually fetched)?
 *   2. Is the evidence related to the claim/question?
 *   3. Is the source authoritative enough?
 *   4. Is it current enough?
 *   5. Is the claim supported by the source text?
 *   6. Is there conflicting evidence?
 *
 * Statuses: VERIFIED | PARTIALLY_VERIFIED | UNVERIFIED | CONFLICTED.
 * UNVERIFIED evidence is never presented as fact.
 *
 * Contradictions are recorded as explicit conflict records — we never silently
 * pick a winner. Gaps ("do I actually have enough to answer?") drive whether the
 * researcher runs another round.
 */

const { tokens, RANK_LOW } = require('./evidence');

// --- Verification (§12) ------------------------------------------------------
/**
 * Verify one evidence record against the ACTUAL fetched text of the URL it
 * cites. This is the fix for the "unverified claims reached the answer" bug:
 * we no longer verify a claim against itself. A claim passes only when its
 * claimed value literally appears in the fetched text of the cited source.
 *
 * Rules:
 *  - failed / empty fetch         → UNVERIFIED
 *  - no fetched text to check     → UNVERIFIED
 *  - claimed value absent from the fetched text → UNVERIFIED
 *  - a LOW-rank domain acting alone for a version → PARTIALLY_VERIFIED only
 *    (the caller then refuses to treat it as the sole source — see isSoleSource)
 *
 * @param {object} evidence  record from evidence.makeEvidence
 * @param {string} [sourceText] optional override of the fetched text; defaults
 *        to the evidence's own stored fetchedText (the real page text).
 */
function verifyEvidence(evidence, sourceText) {
  const ev = { ...evidence };

  // 1) A failed or empty fetch is never verified.
  if (ev.fetchStatus && ev.fetchStatus !== 'ok') { ev.verification = 'UNVERIFIED'; ev.verifyReason = `fetch ${ev.fetchStatus}`; return ev; }

  // 2) Use the real fetched text (the URL's own page), NOT the claim itself.
  const page = String(sourceText != null ? sourceText : (ev.fetchedText || ''));
  if (!page.trim()) { ev.verification = 'UNVERIFIED'; ev.verifyReason = 'no fetched text'; return ev; }
  const pageLower = page.toLowerCase();

  // 3) Is the source real (a URL we actually fetched)?
  const hasSource = /^https?:\/\//i.test(ev.source || '');
  if (!hasSource) { ev.verification = 'UNVERIFIED'; ev.verifyReason = 'no source URL'; return ev; }

  if (ev.researchKind === 'vulnerability') {
    const claim = String(ev.claim || '').trim();
    const substantive = claim.length >= 45
      && /\b(?:CVE-\d{4}-\d{3,}|vulnerabilit\w*|security flaw|security issue)\b/i.test(claim)
      && /\b(?:affects?|affected|fixed|patched|versions?|severity|CVSS|CWE|exploit|arbitrary|denial of service|code execution|privilege|bypass|impact|allows?|enables?)\b/i.test(claim);
    const normalizedClaim = claim.toLowerCase().replace(/\s+/g, ' ').trim();
    const normalizedPage = pageLower.replace(/\s+/g, ' ');
    if (!substantive) { ev.verification = 'UNVERIFIED'; ev.verifyReason = 'not substantive vulnerability evidence'; return ev; }
    if (!normalizedPage.includes(normalizedClaim)) { ev.verification = 'UNVERIFIED'; ev.verifyReason = 'vulnerability claim is not present as a source statement'; return ev; }
    ev.verification = 'VERIFIED';
    ev.verifyReason = 'substantive vulnerability statement appears in fetched source';
    ev.supportRatio = 1;
    return ev;
  }

  // 4) Literal-value check: if we have a claimed value (version lookups), it
  //    must literally appear in the fetched text of the cited URL.
  if (ev.claimedValue) {
    const present = pageLower.includes(String(ev.claimedValue).toLowerCase());
    ev.valuePresent = present;
    if (!present) { ev.verification = 'UNVERIFIED'; ev.verifyReason = 'claimed value not present in source'; return ev; }
    // A low-rank domain alone is at best PARTIALLY verified for a hard fact.
    ev.verification = ev.sourceRank === RANK_LOW ? 'PARTIALLY_VERIFIED' : 'VERIFIED';
    ev.verifyReason = ev.sourceRank === RANK_LOW ? 'value present but low-rank source' : 'value present in source';
    return ev;
  }

  // 5) Non-value claims: token-support check against the real fetched text.
  const claimTokens = tokens(ev.claim).filter((t) => t.length >= 4);
  if (!claimTokens.length) { ev.verification = 'UNVERIFIED'; ev.verifyReason = 'no checkable tokens'; return ev; }
  let present = 0;
  for (const t of claimTokens) if (pageLower.includes(t)) present += 1;
  const support = present / claimTokens.length;

  const authoritative = ev.authority >= 0.5;
  if (support >= 0.6 && authoritative) { ev.verification = 'VERIFIED'; }
  else if (support >= 0.4) { ev.verification = 'PARTIALLY_VERIFIED'; }
  else { ev.verification = 'UNVERIFIED'; ev.verifyReason = 'claim not supported by source text'; }
  ev.supportRatio = Number(support.toFixed(3));
  return ev;
}

/**
 * Is this evidence a LOW-rank source acting alone for its subtask? A version
 * fact may never rest solely on a blog/forum/reddit. The caller uses this to
 * refuse such evidence as the only answer for an item.
 */
function isSoleSource(evidence, allEvidence) {
  const peers = allEvidence.filter((e) => (e.supports || []).join() === (e.supports || []).join() && (e.supports || []).some((s) => (evidence.supports || []).includes(s)));
  const strongPeers = peers.filter((e) => e.source !== evidence.source && e.sourceRank !== RANK_LOW);
  return evidence.sourceRank === RANK_LOW && strongPeers.length === 0;
}

// --- Contradiction detection (§10) -------------------------------------------
/**
 * Detect claims that disagree on the same topic. Deterministic keyword-signature
 * comparison: two evidence records on the same topic whose polarity/sentinel
 * terms differ (free vs paid, supports vs does not, yes vs no) are conflicting.
 * @returns {Array} conflict records
 */
function detectConflicts(evidenceList) {
  const conflicts = [];
  const NEG = /\b(not|no|never|cannot|can't|doesn't|does not|isn't|is not|unsupported|disallow|forbidden|prohibit)\b/i;
  const AFF = /\b(yes|supports?|compatible|allows?|permits?|free|available|yes,)\b/i;

  for (let i = 0; i < evidenceList.length; i++) {
    for (let j = i + 1; j < evidenceList.length; j++) {
      const a = evidenceList[i]; const b = evidenceList[j];
      const cvesA = [...String(a.claim || '').matchAll(/\bCVE-\d{4}-\d{3,}\b/gi)].map((m) => m[0].toUpperCase());
      const cvesB = [...String(b.claim || '').matchAll(/\bCVE-\d{4}-\d{3,}\b/gi)].map((m) => m[0].toUpperCase());
      const sharedCves = cvesA.filter((id) => cvesB.includes(id));
      if (a.researchKind === 'vulnerability' || b.researchKind === 'vulnerability') {
        if (!sharedCves.length) continue;
        const fixed = (claim) => {
          const m = /\b(?:fixed|patched|resolved)\s+(?:in|by|with)?\s*(?:version\s*)?v?(\d+(?:\.\d+){1,3})\b/i.exec(String(claim || ''));
          return m?.[1] || null;
        };
        const fixedA = fixed(a.claim); const fixedB = fixed(b.claim);
        if (!fixedA || !fixedB || fixedA === fixedB) continue;
        conflicts.push({ topic: sharedCves[0], sourceA: a.source, claimA: a.claim, sourceB: b.source, claimB: b.claim, status: 'conflict', newer: (a.retrievedAt >= b.retrievedAt) ? a.source : b.source, moreAuthoritative: (a.authority >= b.authority) ? a.source : b.source, resolved: false });
        continue;
      }
      // Multiple dated entries on an advisory index are separate releases, not contradictions.
      const datesOnly = (claim) => /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+20\d{2}\b/i.test(String(claim || ''))
        && !/\b(?:CVE-|fixed|patched|affected|severity|CVSS|CWE|version)\b/i.test(String(claim || ''));
      if (a.source === b.source && datesOnly(a.claim) && datesOnly(b.claim)) continue;
      // Only compare evidence about overlapping topics (share a strong token).
      const ta = new Set(tokens(a.claim)); const tb = new Set(tokens(b.claim));
      let shared = 0;
      for (const t of ta) if (tb.has(t)) shared += 1;
      if (shared < 2) continue;

      const aNeg = NEG.test(a.claim); const bNeg = NEG.test(b.claim);
      const aAff = AFF.test(a.claim); const bAff = AFF.test(b.claim);
      const polarityClash = (aNeg && bAff && !bNeg) || (bNeg && aAff && !aNeg);
      // Also flag direct numeric disagreement on the same leading figure.
      const numA = /\b\d+(?:\.\d+)?%?/.exec(a.claim);
      const numB = /\b\d+(?:\.\d+)?%?/.exec(b.claim);
      const numericClash = numA && numB && numA[0] !== numB[0] && shared >= 3;

      if (polarityClash || numericClash) {
        // Newer + more authoritative source is *preferred* but the record stays
        // a conflict — we never claim certainty.
        const newer = (a.retrievedAt >= b.retrievedAt) ? a : b;
        const moreAuthoritative = (a.authority >= b.authority) ? a : b;
        conflicts.push({
          topic: topicOf(a.claim, b.claim),
          sourceA: a.source, claimA: a.claim,
          sourceB: b.source, claimB: b.claim,
          status: 'conflict',
          newer: newer.source,
          moreAuthoritative: moreAuthoritative.source,
          resolved: false,
        });
      }
    }
  }
  return conflicts;
}

function topicOf(claimA, claimB) {
  const ta = tokens(claimA); const tb = new Set(tokens(claimB));
  const shared = ta.filter((t) => tb.has(t));
  return (shared.slice(0, 3).join(' ') || 'topic').slice(0, 60);
}

// --- Gap detection (§11) -----------------------------------------------------
/**
 * Decide whether the collected evidence actually answers the question.
 * Detects: unanswered subtasks, unsupported/weak claims, insufficient freshness,
 * unresolved contradictions, and missing required evidence types.
 * @returns {{ hasEnough:boolean, gaps:[{type,detail,severity}] }}
 */
function detectGaps({ plan, evidenceList, conflicts = [], requiredTypes = [] }) {
  const gaps = [];

  // 1) Unanswered subtasks.
  for (const st of (plan?.subtasks || [])) {
    const covered = evidenceList.some((e) => (e.supports || []).includes(st.id) && e.verification !== 'UNVERIFIED');
    if (!covered) gaps.push({ type: 'unanswered_subtask', detail: st.objective, severity: 'high' });
  }

  // 2) No verified evidence at all.
  const verified = evidenceList.filter((e) => e.verification === 'VERIFIED');
  if (!verified.length && evidenceList.length) {
    gaps.push({ type: 'unsupported_claims', detail: 'no evidence reached VERIFIED status', severity: 'high' });
  }
  if (!evidenceList.length) {
    gaps.push({ type: 'missing_source', detail: 'no evidence was collected', severity: 'high' });
  }

  // 3) Weak authority overall.
  const strong = evidenceList.filter((e) => e.authority >= 0.5);
  if (evidenceList.length && !strong.length) {
    gaps.push({ type: 'missing_source', detail: 'only low-authority sources found', severity: 'medium' });
  }

  // 4) Insufficient freshness (only meaningful for current/latest questions).
  const stale = evidenceList.filter((e) => e.freshness < 0.4);
  if (evidenceList.length && stale.length === evidenceList.length) {
    gaps.push({ type: 'insufficient_freshness', detail: 'all sources look stale', severity: 'medium' });
  }

  // 5) Unresolved contradictions.
  const unresolved = conflicts.filter((c) => !c.resolved);
  if (unresolved.length) {
    gaps.push({ type: 'contradictory_evidence', detail: `${unresolved.length} unresolved conflict(s)`, severity: 'medium' });
  }

  // 6) Missing required evidence types (e.g. licensing, deployment).
  for (const rt of requiredTypes) {
    const present = evidenceList.some((e) => (e.supportsType || []).includes(rt) || new RegExp(rt, 'i').test(e.claim));
    if (!present) gaps.push({ type: 'missing_comparison_dimension', detail: `no evidence about ${rt}`, severity: 'medium' });
  }

  const hasEnough = !gaps.some((g) => g.severity === 'high');
  return { hasEnough, gaps };
}

module.exports = { verifyEvidence, detectConflicts, detectGaps, isSoleSource };
