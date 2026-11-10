/**
 * Research engine — explicit state machine + trace/observability.
 *
 * Every orchestrated research request walks a small, finite set of states.
 * There is no hidden loop and no implicit state: each transition is recorded
 * as an event so a run can be replayed/audited. Terminal states are explicit.
 *
 * States (§19):
 *   RECEIVED → UNDERSTANDING → PLANNING → RESEARCHING → COLLECTING → FILTERING
 *     → VERIFYING → GAP_CHECK → (RESEARCHING if more needed) → REASONING
 *     → SYNTHESIS → COMPLETED
 *
 * Terminal states: COMPLETED | FAILED | REFUSED | NEEDS_CLARIFICATION
 *                  | INSUFFICIENT_EVIDENCE
 *
 * The trace never includes raw page content or secrets — only counts, ids,
 * labels and short reasons, so it is safe to surface in logs/API metadata.
 */

const STATES = Object.freeze({
  RECEIVED: 'RECEIVED',
  UNDERSTANDING: 'UNDERSTANDING',
  PLANNING: 'PLANNING',
  RESEARCHING: 'RESEARCHING',
  COLLECTING: 'COLLECTING',
  FILTERING: 'FILTERING',
  VERIFYING: 'VERIFYING',
  UNVERIFIED: 'UNVERIFIED',   // a fetch/verification failed for ≥1 item
  GAP_CHECK: 'GAP_CHECK',
  REASONING: 'REASONING',
  SYNTHESIS: 'SYNTHESIS',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  REFUSED: 'REFUSED',
  NEEDS_CLARIFICATION: 'NEEDS_CLARIFICATION',
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE',
  CANCELLED: 'CANCELLED',
});

const TERMINAL = new Set([
  STATES.COMPLETED,
  STATES.FAILED,
  STATES.REFUSED,
  STATES.NEEDS_CLARIFICATION,
  STATES.INSUFFICIENT_EVIDENCE,
  STATES.CANCELLED,
]);

// Legal forward transitions (a research loop may re-enter RESEARCHING from
// GAP_CHECK or UNVERIFIED, which are backward-ish edges still bounded by
// MAX_RESEARCH_ROUNDS and the per-tool retry cap of 2).
//
// The UNVERIFIED state is the guard: a failed fetch or failed verification MUST
// pass through UNVERIFIED — it can never jump straight to REASONING/SYNTHESIS.
const TRANSITIONS = Object.freeze({
  RECEIVED: [STATES.UNDERSTANDING, STATES.REFUSED, STATES.NEEDS_CLARIFICATION],
  UNDERSTANDING: [STATES.PLANNING, STATES.REFUSED, STATES.NEEDS_CLARIFICATION],
  PLANNING: [STATES.RESEARCHING, STATES.INSUFFICIENT_EVIDENCE, STATES.FAILED],
  RESEARCHING: [STATES.COLLECTING, STATES.UNVERIFIED, STATES.FAILED],
  COLLECTING: [STATES.FILTERING, STATES.UNVERIFIED, STATES.FAILED],
  FILTERING: [STATES.VERIFYING, STATES.UNVERIFIED, STATES.FAILED],
  VERIFYING: [STATES.GAP_CHECK, STATES.UNVERIFIED, STATES.FAILED],
  // UNVERIFIED → retry (bounded) or continue to the gap check with honest marks.
  UNVERIFIED: [STATES.RESEARCHING, STATES.GAP_CHECK, STATES.INSUFFICIENT_EVIDENCE],
  GAP_CHECK: [STATES.RESEARCHING, STATES.REASONING, STATES.INSUFFICIENT_EVIDENCE],
  REASONING: [STATES.SYNTHESIS, STATES.FAILED],
  SYNTHESIS: [STATES.COMPLETED, STATES.FAILED],
});

// Max retries per tool key (version-lookup / fetch). Hard cap of 2.
const MAX_RETRIES_PER_TOOL = 2;

class ResearchStateMachine {
  constructor(requestId, onEvent = null) {
    this.requestId = requestId;
    this.onEvent = typeof onEvent === 'function' ? onEvent : null;
    this.state = STATES.RECEIVED;
    this.startedAt = new Date().toISOString();
    this.startedMono = process.hrtime.bigint();
    this.events = [];
    this.mark('request_started');
  }

  /** Record a structured trace event (§20). Safe — no raw content. */
  emit(type, data = {}) {
    const event = {
      requestId: this.requestId,
      state: this.state,
      type,
      at: new Date().toISOString(),
      elapsed_ms: Number((process.hrtime.bigint() - this.startedMono) / 1000000n),
      ...data,
    };
    this.events.push(event);
    if (this.onEvent) {
      try { this.onEvent(event); } catch { /* Progress reporting must never interrupt research. */ }
    }
  }

  /** Move to a new state, validating the transition. */
  to(next, eventData = {}) {
    if (TERMINAL.has(this.state)) {
      throw new Error(`Research run ${this.requestId} already terminal at ${this.state}; cannot move to ${next}.`);
    }
    const allowed = TRANSITIONS[this.state] || [];
    if (!allowed.includes(next)) {
      throw new Error(`Illegal research transition ${this.state} → ${next}.`);
    }
    this.state = next;
    this.emit(`state_${next.toLowerCase()}`, eventData);
    return this.state;
  }

  /** Record a domain event without changing state. */
  mark(type, data) { this.emit(type, data); return this; }

  isTerminal() { return TERMINAL.has(this.state); }

  /** Compact trace summary safe to return over the API. */
  summary() {
    return {
      requestId: this.requestId,
      state: this.state,
      terminal: this.isTerminal(),
      startedAt: this.startedAt,
      events: this.events.map((e) => ({ type: e.type, state: e.state, at: e.at, ...e })),
    };
  }
}

module.exports = { STATES, TERMINAL, MAX_RETRIES_PER_TOOL, ResearchStateMachine };
