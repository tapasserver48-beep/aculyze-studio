/**
 * In-memory registry of AI employee runs, for live progress (Phase 04.1b).
 *
 * A run is started in the background; the browser polls
 * GET /api/agents/runs/:id (or ?taskId=) and sees each step as it lands.
 * The runtime pushes into the SAME `steps` array held here, so no copying.
 *
 * Memory only: after a server restart the history is still in the task's
 * activity log and comments; only the live view is lost.
 */

const crypto = require('crypto');

const MAX_RUNS = 300;
const runs = new Map();        // executionId → run
const latestByTask = new Map(); // taskId → executionId

function newExecutionId() {
  return `exec-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

function prune() {
  if (runs.size <= MAX_RUNS) return;
  const done = [...runs.values()].filter((r) => r.status !== 'running').sort((a, b) => a.startedAt - b.startedAt);
  for (const r of done.slice(0, runs.size - MAX_RUNS)) {
    runs.delete(r.id);
    if (latestByTask.get(r.taskId) === r.id) latestByTask.delete(r.taskId);
  }
}

/** Is a run for this task still going? */
function runningForTask(taskId) {
  const id = latestByTask.get(taskId);
  const r = id && runs.get(id);
  return r && r.status === 'running' ? r : null;
}

/**
 * Start `work(run)` in the background. `work` receives the run record and
 * must resolve to the runtime's outcome object.
 */
function start({ taskId, employeeId, userId, kind = 'execute' }, work) {
  const run = {
    id: newExecutionId(),
    taskId,
    employeeId,
    userId,
    kind,
    status: 'running',
    phase: 'Starting…',
    steps: [],
    startedAt: Date.now(),
    finishedAt: null,
    outcome: null,
  };
  runs.set(run.id, run);
  latestByTask.set(taskId, run.id);
  prune();

  Promise.resolve()
    .then(() => work(run))
    .then((out) => {
      Object.assign(run, {
        status: 'done',
        phase: null,
        finishedAt: Date.now(),
        outcome: out.outcome,
        summary: out.summary,
        result: out.result,
        question: out.question,
        approval: out.approval,
        error: out.error,
      });
    })
    .catch((err) => {
      Object.assign(run, { status: 'done', phase: null, finishedAt: Date.now(), outcome: 'failed', error: String((err && err.message) || err) });
    });
  return run;
}

function get(id) { return runs.get(id) || null; }

function latestForTask(taskId) {
  const id = latestByTask.get(taskId);
  return id ? runs.get(id) || null : null;
}

/** What the browser may see (no internals). */
function view(run) {
  if (!run) return null;
  return {
    executionId: run.id,
    taskId: run.taskId,
    employeeId: run.employeeId,
    kind: run.kind,
    status: run.status,
    phase: run.phase,
    steps: run.steps,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    outcome: run.outcome,
    summary: run.summary,
    result: run.result,
    question: run.question,
    approval: run.approval,
    error: run.error,
  };
}

module.exports = { newExecutionId, start, get, latestForTask, runningForTask, view };
