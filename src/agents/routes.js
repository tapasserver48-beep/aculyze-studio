/**
 * /api/agents — Human-facing API for AI employee task execution.
 *
 * All endpoints require a signed-in human. AI identity is resolved server-side
 * and never accepted from the browser.
 *
 * Runs (Phase 04.1b: background + live progress)
 *   POST /api/agents/:employeeId/execute     { taskId, wait? } → 202 { executionId } (or full result with wait:true)
 *   GET  /api/agents/runs/:executionId       live run view (steps, phase, outcome)
 *   GET  /api/agents/runs?taskId=            latest run for a task
 *
 * Results
 *   POST /api/agents/tasks/:taskId/accept    under_review → completed
 *   POST /api/agents/tasks/:taskId/revise    { feedback } → comment + new run
 *
 * Quick requests
 *   POST /api/agents/ask                     { text, employeeId?, source? } → new task + run
 *
 * Approvals
 *   GET  /api/agents/approvals               pending write actions for the signed-in user
 *   POST /api/agents/approvals/:id/approve|reject  decide, then resume the run
 *
 * Who may run an AI employee on a task: founders/admins/managers on any AI
 * task; anyone else only on tasks they asked for (they assigned it or started
 * it). A run always uses the RUNNER's own connected apps, and write actions
 * wait for the runner's approval.
 */

const express = require('express');
const { requireUser } = require('../auth/authorize');
const { employee } = require('./store');
const { executeTask, decideAndResume } = require('../execution/agentRuntime');
const approvals = require('../execution/approvals');
const runs = require('../execution/runs');
const { IntegrationManager } = require('../integrations/manager');
const { getTask, updateTask, addActivity, addComment, createTask, listTasks } = require('../tasks/store');
const { findById, findByCode, EMPLOYEE_CODES } = require('../employees/store');
const { postFromEmployee } = require('../execution/inboxChat');

const MANAGER_ROLES = ['admin', 'founder', 'manager'];
const isManager = (user) => !!user && MANAGER_ROLES.includes(user.role);
const isRequester = (task, user) => !!user && !!task
  && ((task.assigned_by_type !== 'ai' && task.assigned_by_id === user.id) || task.initiating_user_id === user.id);

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function resultView(out, extra = {}) {
  return {
    executionId: out.executionId,
    status: out.outcome,
    outcome: out.outcome,
    summary: out.summary,
    result: out.result,
    question: out.question,
    approval: out.approval,
    error: out.error,
    steps: out.steps || [],
    ...extra,
  };
}

function createAgentsRouter(options = {}) {
  const { dataDir } = options;
  const router = express.Router();

  // All routes require authenticated human user
  router.use(requireUser);

  // AI employees act through the runner's own app connections.
  let manager = options.manager || null;
  const getManager = () => {
    if (!manager) manager = new IntegrationManager({ dataDir, env: process.env, provider: options.provider || null });
    return manager;
  };

  /* ------------------------------------------------------------------ *
   * Shared checks + background start
   * ------------------------------------------------------------------ */

  /** Validate employee + task + the human's right to run it. Returns the task. */
  async function checkRunnable(user, employeeId, taskId) {
    if (!employeeId || !String(employeeId).startsWith('emp-ai-')) throw httpError(400, 'Invalid employee ID');
    const empResult = await employee.validate(dataDir, employeeId);
    if (!empResult.valid) throw httpError(403, empResult.reason);
    if (!taskId) throw httpError(400, 'Task ID required');
    const taskResult = await employee.validateTaskAssignment(dataDir, employeeId, taskId, user);
    if (!taskResult.valid) throw httpError(403, taskResult.reason);
    const perm = await employee.checkExecutionPermission(dataDir, user, employeeId, taskResult.task);
    if (!perm.allowed) throw httpError(403, perm.reason);
    if (runs.runningForTask(taskId)) throw httpError(409, 'The AI employee is already working on this task.');
    if (approvals.listApprovals(dataDir, { taskId, status: approvals.STATUS.PENDING }).length) {
      throw httpError(409, 'This task has an action waiting for approval. Approve or reject it first.');
    }
    return taskResult.task;
  }

  /** Start a run in the background; returns the live run record. */
  function startRun(user, employeeId, taskId, kind = 'execute') {
    return runs.start({ taskId, employeeId, userId: user.id, kind }, (run) => executeTask(dataDir, {
      employeeId,
      taskId,
      initiatingUserId: user.id,
      manager: getManager(),
      provider: options.runtimeProvider,
      executionId: run.id,
      steps: run.steps,
      onPhase: (p) => { run.phase = p; },
    }));
  }

  async function checkResultAccess(user, taskId) {
    const task = await getTask(dataDir, taskId);
    if (!task) throw httpError(404, 'Task not found');
    if (task.assigned_to_type !== 'ai') throw httpError(422, 'This task is not assigned to an AI employee.');
    if (!isManager(user) && !isRequester(task, user)) throw httpError(403, 'Only the person who asked for this task, or a manager, can do that.');
    return task;
  }

  const send = (res, err, fallback) => {
    if (!err.status) console.error(`[Agents] ${fallback}:`, err);
    res.status(err.status || 500).json({ error: err.message || fallback });
  };

  /* ------------------------------------------------------------------ *
   * Approvals
   * ------------------------------------------------------------------ */

  router.get('/approvals', async (req, res) => {
    try {
      const status = req.query.status ? String(req.query.status) : approvals.STATUS.PENDING;
      const items = approvals.listApprovals(dataDir, {
        userId: req.user.id,
        taskId: req.query.taskId ? String(req.query.taskId) : undefined,
        status: status === 'all' ? undefined : status,
      }).map(approvals.publicView);
      res.json({ approvals: items, count: items.length });
    } catch (err) {
      send(res, err, 'Could not load approvals');
    }
  });

  for (const verb of ['approve', 'reject']) {
    router.post(`/approvals/:id/${verb}`, async (req, res) => {
      try {
        const approvalId = String(req.params.id);
        const pending = approvals.getApproval(dataDir, approvalId);
        if (!pending) throw httpError(404, 'Approval not found');
        if (pending.initiatingUserId !== req.user.id) throw httpError(403, 'Only the person who started this run can decide on it.');
        if (pending.status !== approvals.STATUS.PENDING) throw httpError(409, 'This approval was already decided.');

        const decide = (extra = {}) => decideAndResume(dataDir, {
          approvalId,
          userId: req.user.id,
          approve: verb === 'approve',
          reason: req.body && req.body.reason,
          manager: getManager(),
          provider: options.runtimeProvider,
          ...extra,
        });

        if (req.body && req.body.wait) {
          const out = await decide();
          return res.json(resultView(out, {
            task: out.taskId,
            approval: out.outcome === 'needs_approval' ? out.approval : undefined,
            decided: out.outcome === 'needs_approval' ? undefined : out.approval,
          }));
        }
        const run = runs.start(
          { taskId: pending.taskId, employeeId: pending.employeeId, userId: req.user.id, kind: verb },
          (r) => decide({ steps: r.steps, onPhase: (p) => { r.phase = p; } }),
        );
        res.status(202).json({ executionId: run.id, task: pending.taskId, status: 'running' });
      } catch (err) {
        send(res, err, `${verb} failed`);
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * Live runs
   * ------------------------------------------------------------------ */

  router.get('/runs/:executionId', async (req, res) => {
    const run = runs.get(String(req.params.executionId));
    if (!run) return res.status(404).json({ error: 'Run not found (it may have finished before a server restart).' });
    if (run.userId !== req.user.id && !isManager(req.user)) return res.status(403).json({ error: 'Access denied' });
    res.json({ run: runs.view(run) });
  });

  router.get('/runs', async (req, res) => {
    const taskId = String(req.query.taskId || '');
    if (!taskId) return res.status(400).json({ error: 'taskId required' });
    const run = runs.latestForTask(taskId);
    if (!run || (run.userId !== req.user.id && !isManager(req.user))) return res.json({ run: null });
    res.json({ run: runs.view(run) });
  });

  /* ------------------------------------------------------------------ *
   * Accept / ask for changes
   * ------------------------------------------------------------------ */

  router.post('/tasks/:taskId/accept', async (req, res) => {
    try {
      const task = await checkResultAccess(req.user, String(req.params.taskId));
      if (task.status !== 'under_review') throw httpError(409, 'Only a result that is under review can be accepted.');
      const updated = await updateTask(dataDir, task.id, { status: 'completed', completed_at: Date.now(), pending_reason: null, progress: 100 });
      await addActivity(dataDir, { taskId: task.id, actorType: 'human', actorId: req.user.id, action: 'result_accepted', details: {} });
      res.json({ task: updated });
    } catch (err) {
      send(res, err, 'Could not accept the result');
    }
  });

  router.post('/tasks/:taskId/revise', async (req, res) => {
    try {
      const feedback = String((req.body && req.body.feedback) || '').trim().slice(0, 2000);
      if (!feedback) throw httpError(422, 'Say what should change.');
      const task = await checkResultAccess(req.user, String(req.params.taskId));
      if (['completed', 'cancelled'].includes(task.status)) throw httpError(409, 'This task is closed.');
      await checkRunnable(req.user, task.assigned_to_id, task.id);
      await addComment(dataDir, { taskId: task.id, authorType: 'human', authorId: req.user.id, content: `**Changes requested:** ${feedback}` });
      await addActivity(dataDir, { taskId: task.id, actorType: 'human', actorId: req.user.id, action: 'changes_requested', details: {} });
      const run = startRun(req.user, task.assigned_to_id, task.id, 'revise');
      res.status(202).json({ executionId: run.id, task: task.id, status: 'running' });
    } catch (err) {
      send(res, err, 'Could not request changes');
    }
  });

  /* ------------------------------------------------------------------ *
   * Quick request → task → run  (Tasks "Ask" box, Inbox "Make this a task")
   * ------------------------------------------------------------------ */

  router.post('/ask', async (req, res) => {
    try {
      const text = String((req.body && req.body.text) || '').trim();
      if (text.length < 3) throw httpError(422, 'Describe what you need.');
      if (text.length > 4000) throw httpError(422, 'That request is too long (max 4000 characters).');

      let emp = null;
      const wanted = req.body && req.body.employeeId;
      if (wanted) emp = await findById(dataDir, String(wanted));
      else emp = await findByCode(dataDir, EMPLOYEE_CODES.CHIEF_OF_STAFF);
      if (!emp || emp.status !== 'active' || emp.employee_type !== 'ai') throw httpError(404, 'That AI employee is not available.');

      const firstLine = text.split('\n').map((l) => l.trim()).find(Boolean) || text;
      const title = firstLine.length > 90 ? `${firstLine.slice(0, 87).trim()}…` : firstLine;
      const priority = ['low', 'medium', 'high', 'urgent'].includes(req.body && req.body.priority) ? req.body.priority : 'medium';
      const task = await createTask(dataDir, {
        title,
        description: text,
        assignedTo: { type: 'ai', id: emp.id },
        assignedBy: { type: 'human', id: req.user.id },
        priority,
        initiatingUserId: req.user.id,
      });
      await addActivity(dataDir, { taskId: task.id, actorType: 'human', actorId: req.user.id, action: 'create', details: { source: req.body && req.body.source === 'inbox' ? 'inbox' : 'ask' } });

      if (req.body && req.body.source === 'inbox') {
        await postFromEmployee(dataDir, emp, req.user.id,
          `📋 On it. I made this a task: **${title}**. I'll post the result here when it's ready.\n\n[task:${task.id}]`);
      }

      await checkRunnable(req.user, emp.id, task.id);
      const run = startRun(req.user, emp.id, task.id, 'ask');
      res.status(202).json({ task, executionId: run.id, status: 'running' });
    } catch (err) {
      send(res, err, 'Could not create the task');
    }
  });

  /* ------------------------------------------------------------------ *
   * Execute
   * ------------------------------------------------------------------ */

  router.post('/:employeeId/execute', async (req, res) => {
    try {
      const { employeeId } = req.params;
      const { taskId } = req.body || {};
      await checkRunnable(req.user, employeeId, taskId);

      if (req.body && req.body.wait) {
        const result = await executeTask(dataDir, {
          employeeId,
          taskId,
          initiatingUserId: req.user.id,
          manager: getManager(),
          provider: options.runtimeProvider,
          maxSteps: req.body.maxSteps,
        });
        return res.json(resultView(result, {
          employee: result.employeeCode,
          task: taskId,
          provider: result.provider,
          model: result.model,
          startedAt: result.startTime,
          elapsedMs: result.elapsedMs,
        }));
      }

      const run = startRun(req.user, employeeId, taskId);
      res.status(202).json({ executionId: run.id, task: taskId, status: 'running' });
    } catch (err) {
      send(res, err, 'Execution failed');
    }
  });

  /* ------------------------------------------------------------------ *
   * Employee info
   * ------------------------------------------------------------------ */

  router.get('/:employeeId/status', async (req, res) => {
    try {
      const { employeeId } = req.params;
      if (!employeeId || !employeeId.startsWith('emp-ai-')) {
        return res.status(400).json({ error: 'Invalid employee ID' });
      }
      const emp = await findById(dataDir, employeeId);
      if (!emp) return res.status(404).json({ error: 'Employee not found' });
      res.json({
        id: emp.id,
        employee_code: emp.employee_code,
        name: emp.name,
        status: emp.status,
        capabilities: emp.capabilities || [],
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/:employeeId/tasks', async (req, res) => {
    try {
      const { employeeId } = req.params;
      if (!employeeId || !employeeId.startsWith('emp-ai-')) {
        return res.status(400).json({ error: 'Invalid employee ID' });
      }
      const empResult = await employee.validate(dataDir, employeeId);
      if (!empResult.valid) return res.status(404).json({ error: 'Employee not found' });
      if (!isManager(req.user)) return res.status(403).json({ error: 'Access denied' });
      const tasks = await listTasks(dataDir, { assignedTo: employeeId });
      res.json({ tasks, count: tasks.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createAgentsRouter };
