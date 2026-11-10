/**
 * Research engine — public surface.
 *
 * Exposes the pipeline and the individual stages so tests (and future agents)
 * can exercise each stage in isolation. The orchestrator route uses runResearch.
 */

const intent = require('./intent');
const planner = require('./planner');
const evidence = require('./evidence');
const verifier = require('./verifier');
const confidence = require('./confidence');
const { ToolRegistry, officialSourceFor, OFFICIAL_SOURCES } = require('./toolRegistry');
const { research, extractClaims, rankCandidates, guessValue } = require('./researcher');
const { reason } = require('./reasoning');
const { buildAnswerContext, buildSynthesisPrompt } = require('./synthesis');
const { runResearch } = require('./pipeline');
const { readLimits } = require('./limits');
const { STATES, TERMINAL, MAX_RETRIES_PER_TOOL, ResearchStateMachine } = require('./stateMachine');

module.exports = {
  runResearch,
  classify: intent.classify,
  extractEntities: intent.extractEntities,
  buildPlan: planner.buildPlan,
  makeEvidence: evidence.makeEvidence,
  classifySource: evidence.classifySource,
  relevance: evidence.relevance,
  dedupeKey: evidence.dedupeKey,
  rankSource: evidence.rankSource,
  RANK_OFFICIAL: evidence.RANK_OFFICIAL,
  RANK_PRIMARY: evidence.RANK_PRIMARY,
  RANK_SECONDARY: evidence.RANK_SECONDARY,
  RANK_LOW: evidence.RANK_LOW,
  verifyEvidence: verifier.verifyEvidence,
  detectConflicts: verifier.detectConflicts,
  detectGaps: verifier.detectGaps,
  isSoleSource: verifier.isSoleSource,
  computeConfidence: confidence.computeConfidence,
  computeSubtaskConfidence: confidence.computeSubtaskConfidence,
  computePerSubtaskConfidence: confidence.computePerSubtaskConfidence,
  ToolRegistry,
  officialSourceFor,
  OFFICIAL_SOURCES,
  research,
  extractClaims,
  rankCandidates,
  guessValue,
  reason,
  buildAnswerContext,
  buildSynthesisPrompt,
  readLimits,
  STATES,
  TERMINAL,
  MAX_RETRIES_PER_TOOL,
  ResearchStateMachine,
};
