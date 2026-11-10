/**
 * Research engine — pipeline orchestrator.
 *
 * Wires the whole research/reasoning flow together behind one call:
 *
 *   understand → plan → research → collect → filter → verify → gap-check
 *       → (research again if needed, bounded) → reason → synthesize
 *
 * It drives the explicit ResearchStateMachine so every run is traceable and
 * terminates in a declared terminal state. The LLM is used ONLY for the final
 * synthesis (and optionally to phrase queries) via the injected provider — the
 * orchestrator never hard-codes a model.
 *
 * Degrades gracefully: if the model is unavailable the pipeline still returns
 * the structured ANSWER_CONTEXT and evidence (flagged `synthesized:false`) so
 * the caller can present an honest, evidence-grounded partial answer.
 */

const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { readLimits } = require('./limits');
const { ResearchStateMachine, STATES } = require('./stateMachine');
const intent = require('./intent');
const planner = require('./planner');
const { ToolRegistry } = require('./toolRegistry');
const { research, extractClaims, isSubstantiveVulnerabilityClaim } = require('./researcher');
const { verifyEvidence, detectConflicts, detectGaps, isSoleSource } = require('./verifier');
const { computeConfidence, computePerSubtaskConfidence } = require('./confidence');
const { reason } = require('./reasoning');
const { buildAnswerContext, buildSynthesisPrompt } = require('./synthesis');
const evidenceMod = require('./evidence');

const LIMITS = readLimits();

/**
 * Run a full research pass.
 * @param {string} question
 * @param {{ searchProvider, llm?: { sendMessage(fn) }, limits?: object, onProgress?: function }} deps
 *   searchProvider — the existing search provider (search + fetchPage).
 *   llm            — optional; used only for final synthesis.
 * @returns {Promise<object>} trace + answerContext + answer (if llm provided).
 */
async function runResearch(question, { searchProvider, llm = null, limits = LIMITS, onProgress = null, onToken = null, signal = null } = {}) {
  const requestId = crypto.randomUUID ? crypto.randomUUID() : `req-${Date.now()}`;
  const sm = new ResearchStateMachine(requestId, onProgress);
  evidenceMod.resetEvidenceIds();
  planner.resetIds();

  const result = {
    requestId,
    state: null,
    intent: null,
    plan: null,
    evidenceCount: 0,
    conflicts: [],
    gaps: [],
    confidence: null,
    answerContext: null,
    answer: null,
    synthesized: false,
    trace: null,
  };

  try {
    throwIfAborted(signal);
    sm.to(STATES.UNDERSTANDING);
    const cls = intent.classify(question);
    result.intent = { category: cls.category, requiresResearch: cls.requiresResearch, signals: cls.signals, reason: cls.reason, type: cls.type || null, entities: cls.entities || [] };
    sm.mark('intent_detected', { category: cls.category, requiresResearch: cls.requiresResearch, intentType: cls.type, entities: cls.entities });

    // Non-research intents short-circuit (no tool calls, no model).
    if (!cls.requiresResearch) {
      sm.to(STATES.PLANNING); // understanding done
      // No research needed — record and finish.
      sm.state = STATES.COMPLETED;
      sm.mark('request_completed', { state: STATES.COMPLETED, elapsed_ms: Number((process.hrtime.bigint() - sm.startedMono) / 1000000n) });
      sm.mark('completed', { note: 'no research required' });
      result.state = sm.state;
      result.trace = sm.summary();
      return result;
    }

    sm.to(STATES.PLANNING);
    // Pass entities + type so multi-item version questions get one subtask per item.
    const plan = await planner.buildPlan(question, cls.category, { limits, entities: cls.entities || [], type: cls.type || null });
    result.plan = { category: plan.category, subject: plan.subject || planner.mainSubject(question), vulnerabilityResearch: !!plan.vulnerabilityResearch, subtasks: plan.subtasks.map((s) => ({ id: s.id, objective: s.objective, query: s.query, status: s.status, entity: s.entity })) };
    sm.mark('plan_created', { subtasks: plan.subtasks.length, subject: result.plan.subject, vulnerabilityResearch: result.plan.vulnerabilityResearch });

    // Research loop with verification + gap re-check between rounds.
    const tool = new ToolRegistry({ searchProvider, limits, signal });
    let evidenceList = [];
    let conflicts = [];
    let gaps = [];
    let round = 0;
    let enough = false;
    let sawUnverified = false;
    let analysisStarted = 0;

    while (round < limits.MAX_RESEARCH_ROUNDS) {
      throwIfAborted(signal);
      round += 1;
      sm.to(STATES.RESEARCHING, { round });
      const { evidenceList: newEvidence } = await research({ plan, tool, question, sm, limits, signal });
      throwIfAborted(signal);

      sm.to(STATES.COLLECTING);
      evidenceList = dedupeById([...evidenceList, ...newEvidence]);

      sm.to(STATES.FILTERING);
      evidenceList = evidenceList.filter((e) => e.relevanceLabel !== 'IRRELEVANT');

      sm.to(STATES.VERIFYING);
      analysisStarted = performance.now();
      sm.mark('analysis_started');
      // THE FIX: verify each claim against the REAL fetched text of the URL it
      // cites (e.fetchedText) — never against the claim itself.
      evidenceList = evidenceList.map((e) => verifyEvidence(e, e.fetchedText || ''));
      // A low-rank domain acting alone for a version may not count as verified.
      evidenceList = evidenceList.map((e) => {
        if (e.verification === 'VERIFIED' && isSoleSource(e, evidenceList)) {
          return { ...e, verification: 'PARTIALLY_VERIFIED', verifyReason: 'low-rank source acting alone' };
        }
        return e;
      });
      sm.mark('evidence_verified', { verified: evidenceList.filter((e) => e.verification === 'VERIFIED').length, unverified: evidenceList.filter((e) => e.verification === 'UNVERIFIED').length });

      conflicts = detectConflicts(evidenceList);

      // Route through the UNVERIFIED state when any fetch/verification failed,
      // so a failed item never flows silently onward to SYNTHESIS as fact.
      const anyFailed = evidenceList.some((e) => e.verification === 'UNVERIFIED' && (e.fetchStatus === 'failed' || e.fetchStatus === 'empty'));
      if (anyFailed || !evidenceList.length) {
        sawUnverified = true;
        sm.to(STATES.UNVERIFIED, { reason: 'a fetch or verification failed' });
        sm.mark('item_unverified', { count: evidenceList.filter((e) => e.verification === 'UNVERIFIED').length });
        sm.to(STATES.GAP_CHECK, { from: 'UNVERIFIED' });
      } else {
        sm.to(STATES.GAP_CHECK);
      }

      const requiredTypes = requiredTypesFor(cls.category);
      const gapResult = detectGaps({ plan, evidenceList, conflicts, requiredTypes });
      gaps = gapResult.gaps;
      if (gaps.length) sm.mark('gap_detected', { gaps: gaps.length, high: gaps.filter((g) => g.severity === 'high').length });

      enough = gapResult.hasEnough;
      if (enough) break;
      // If we cannot fetch more (budget/caps/retries), stop and answer honestly.
      if (!tool.canCall()) break;
      // Otherwise loop back to RESEARCHING for another bounded round.
    }

    // Per-sub-task confidence (gates synthesis) + aggregate confidence.
    const perSubtaskConfidence = computePerSubtaskConfidence(plan, evidenceList);
    const vulnerabilityResearch = planner.isVulnerabilityResearch(question);
    const substantiveVulnerabilityEvidence = evidenceList.filter((e) => e.researchKind === 'vulnerability' && e.verification === 'VERIFIED' && isSubstantiveVulnerabilityClaim(e.claim));
    const qualityPassed = !vulnerabilityResearch || substantiveVulnerabilityEvidence.length > 0;
    sm.mark('research_quality', {
      passed: qualityPassed,
      kind: vulnerabilityResearch ? 'vulnerability' : 'general',
      substantive_verified_evidence: substantiveVulnerabilityEvidence.length,
    });
    if (!qualityPassed) {
      gaps.push({ type: 'insufficient_vulnerability_evidence', detail: 'No substantive vulnerability advisory claims passed verification.', severity: 'high' });
      enough = false;
    }
    const confidence = computeConfidence({ evidenceList, conflicts });
    result.confidence = { ...confidence, perSubtask: perSubtaskConfidence.perSubtask, band: perSubtaskConfidence.band === 'UNVERIFIED' ? confidence.band : confidence.band };
    result.perSubtask = perSubtaskConfidence.perSubtask;

    sm.to(STATES.REASONING);
    const reasoning = reason({ question, intent: cls, plan, evidenceList, conflicts, gaps, confidence, subtaskConfidence: perSubtaskConfidence });
    sm.mark('analysis_completed', { duration_ms: Math.round(performance.now() - analysisStarted), verified_count: evidenceList.filter((e) => e.verification === 'VERIFIED').length });

    sm.to(STATES.SYNTHESIS);
    const answerContext = buildAnswerContext({ question, reasoning, confidence, gaps, intent: cls, asOf: new Date().toISOString() });
    result.answerContext = answerContext;
    result.evidenceCount = evidenceList.length;
    result.conflicts = conflicts;
    result.gaps = gaps;
    result.evidence = evidenceList.slice(0, limits.MAX_EVIDENCE);

    // SYNTHESIS GATE: if every item is unverified, we never present facts —
    // terminal state is INSUFFICIENT_EVIDENCE and the answer says so plainly.
    const allUnverified = perSubtaskConfidence.allUnverified && perSubtaskConfidence.perSubtask.length > 0;

    // Deterministic answer for version lookups — rendered from the VERIFIED
    // per-item lines, NOT from model memory. This is the authoritative answer.
    const deterministicAnswer = buildDeterministicAnswer(answerContext, reasoning, cls);

    // Final synthesis via the injected provider (never hard-coded). The model is
    // only a rephraser of the deterministic, verifier-gated context.
    if (!qualityPassed) {
      result.answer = "I couldn't verify substantive vulnerability details from the fetched sources, so I can't safely summarize the vulnerabilities yet.";
      result.synthesized = false;
      sm.mark('generation_skipped', { reason: 'research quality gate failed' });
    } else if (!allUnverified && llm && (typeof llm.streamMessage === 'function' || typeof llm.sendMessage === 'function')) {
      const { system, context } = buildSynthesisPrompt(answerContext);
      const generationStarted = performance.now();
      sm.mark('generation_started');
      try {
        const request = {
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: context },
          ],
          temperature: 0.3,
          max_tokens: 900,
          signal,
        };
        const resp = typeof llm.streamMessage === 'function'
          ? await llm.streamMessage({ ...request, onToken: (token) => onToken?.(token) })
          : await llm.sendMessage(request);
        throwIfAborted(signal);
        result.answer = resp?.content || null;
        result.synthesized = !!result.answer;
        sm.mark('generation_completed', { duration_ms: Math.round(performance.now() - generationStarted), streamed: typeof llm.streamMessage === 'function' });
      } catch (err) {
        if (signal?.aborted || err.name === 'AbortError') throw err;
        // Honest degradation — evidence context still returned.
        result.answer = null;
        result.synthesized = false;
        sm.mark('generation_failed', { error: String(err.message || err).slice(0, 120), duration_ms: Math.round(performance.now() - generationStarted) });
        sm.mark('synthesis_failed', { error: String(err.message || err).slice(0, 120) });
      }
    } else {
      sm.mark('generation_started', { mode: 'verified deterministic answer' });
      sm.mark('generation_completed', { mode: 'verified deterministic answer', duration_ms: 0 });
    }
    // Always expose the deterministic, verifier-gated answer (no model memory).
    result.answerDeterministic = deterministicAnswer;
    if (!result.answer) result.answer = deterministicAnswer;

    // Terminal state: completed if enough, INSUFFICIENT_EVIDENCE if all unverified
    // or nothing verified; never claim success for facts we could not verify.
    const finalState = (!qualityPassed || allUnverified || !perSubtaskConfidence.anyVerified) ? STATES.INSUFFICIENT_EVIDENCE
      : enough ? STATES.COMPLETED : STATES.INSUFFICIENT_EVIDENCE;
    sm.state = finalState;
    sm.mark('request_completed', { state: finalState, evidence_count: evidenceList.length, source_count: new Set(evidenceList.map((item) => item.source).filter(Boolean)).size, elapsed_ms: Number((process.hrtime.bigint() - sm.startedMono) / 1000000n) });
    sm.mark('completed', { enough, evidence: evidenceList.length, confidence: confidence.band, allUnverified, sawUnverified });
    result.state = sm.state;
  } catch (err) {
    if (signal?.aborted || err.name === 'AbortError') {
      sm.state = STATES.CANCELLED;
      sm.mark('request_cancelled');
      result.state = STATES.CANCELLED;
      result.cancelled = true;
      result.trace = sm.summary();
      return result;
    }
    sm.state = STATES.FAILED;
    sm.mark('failed', { error: String(err.message || err).slice(0, 160) });
    result.state = STATES.FAILED;
    result.error = String(err.message || err).slice(0, 200);
  }

  result.trace = sm.summary();
  return result;
}

/**
 * Deterministic, verifier-gated answer — the authoritative output for version
 * lookups. Built ONLY from items that PASSED verification (value + source +
 * as-of). Unverified items render as "I couldn't verify this". Never uses model
 * memory. This is what guarantees the answer cannot drift to stale training data.
 */
function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Research was cancelled.');
  error.name = 'AbortError';
  throw error;
}

function buildDeterministicAnswer(answerContext, reasoning, cls) {
  const lines = [];
  const asOf = answerContext.asOf;
  if (cls.type === 'version_lookup') {
    lines.push('Here are the latest stable versions I could verify:');
    for (const it of (answerContext.items || [])) {
      lines.push(it.verified ? it.line : `${it.entity} — I couldn't verify this.`);
    }
    const anyVerified = (answerContext.items || []).some((it) => it.verified);
    if (anyVerified) lines.push(`\nas of ${asOf}`);
    return lines.join('\n');
  }
  // Generic research: only verified conclusions, else honest statement.
  if (reasoning.conclusions && reasoning.conclusions.length) {
    lines.push(...reasoning.conclusions);
    lines.push(`\nas of ${asOf}`);
    return lines.join('\n');
  }
  return "I couldn't find reliable, verifiable information to answer this.";
}

function dedupeById(list) {
  const seen = new Set();
  return list.filter((e) => {
    if (!e || !e.id) return false;
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
}

function requiredTypesFor(category) {
  if (category === 'recommendation') return ['licensing', 'deployment'];
  if (category === 'comparison') return ['features'];
  return [];
}

module.exports = { runResearch, extractClaims };
