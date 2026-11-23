/**
 * /api/agents — Human-facing API for AI employee task execution.
 * 
 * This API provides secure, authenticated access to AI employee execution.
 * 
 * All endpoints:
 * - Require signed-in human session
 * - Validate human permissions
 * - Validate task and AI employee authorization
 * - Create trusted server-side execution context
 * - Never expose AI identity credentials
 * 
 * POST /api/agents/:employeeId/execute - Request AI employee to execute a task
 * GET  /api/agents/:employeeId/status  - Get AI employee status
 * GET  /api/agents/:employeeId/tasks   - Get tasks assigned to AI employee (filtered by requester permissions)
 * GET  /api/agents/approvals           - Pending write actions awaiting the signed-in user
 * POST /api/agents/approvals/:id/approve|reject - Decide, then resume the run
 */

const express = require('express');
const { requireUser } = require('../auth/authorize');
const { employee } = require('./store');
const { executeTask, decideAndResume } = require('../execution/agentRuntime');
const approvals = require('../execution/approvals');
const { IntegrationManager } = require('../integrations/manager');

function createAgentsRouter(options = {}) {
  const { dataDir } = options;
  const router = express.Router();
  
  // All routes require authenticated human user
  router.use(requireUser);

  // One IntegrationManager per router: AI employees act through the
  // initiating human's own app connections.
  let manager = options.manager || null;
  const getManager = () => {
    if (!manager) manager = new IntegrationManager({ dataDir, env: process.env, provider: options.provider || null });
    return manager;
  };

  /**
   * Pending write actions waiting for the signed-in user's decision.
   * GET /api/agents/approvals?taskId=&status=
   */
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
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * Approve / reject a paused action, then resume the agent run.
   * POST /api/agents/approvals/:id/approve
   * POST /api/agents/approvals/:id/reject   { reason? }
   */
  for (const verb of ['approve', 'reject']) {
    router.post(`/approvals/:id/${verb}`, async (req, res) => {
      try {
        const out = await decideAndResume(dataDir, {
          approvalId: String(req.params.id),
          userId: req.user.id,
          approve: verb === 'approve',
          reason: req.body && req.body.reason,
          manager: getManager(),
          provider: options.runtimeProvider,
        });
        res.json({
          executionId: out.executionId,
          task: out.taskId,
          outcome: out.outcome,
          status: out.outcome,
          approval: out.outcome === 'needs_approval' ? out.approval : undefined,
          decided: out.outcome === 'needs_approval' ? undefined : out.approval,
          summary: out.summary,
          result: out.result,
          question: out.question,
          error: out.error,
          steps: out.steps || [],
        });
      } catch (err) {
        if (!err.status) console.error(`[Agents] ${verb} error:`, err);
        res.status(err.status || 500).json({ error: err.message || 'Failed' });
      }
    });
  }
  
  /**
   * Execute a task with an AI employee
   * POST /api/agents/:employeeId/execute
   */
  router.post('/:employeeId/execute', async (req, res) => {
    try {
      const { employeeId } = req.params;
      const { taskId } = req.body;
      const user = req.user;
      
      // Validate employee ID format
      if (!employeeId || !employeeId.startsWith('emp-ai-')) {
        return res.status(400).json({ error: 'Invalid employee ID' });
      }
      
      // Verify employee exists and is active
      const empResult = await employee.validate(dataDir, employeeId);
      if (!empResult.valid) {
        return res.status(403).json({ error: empResult.reason });
      }
      
      // Validate task ownership/access
      if (!taskId) {
        return res.status(400).json({ error: 'Task ID required' });
      }
      
      const taskResult = await employee.validateTaskAssignment(dataDir, employeeId, taskId, user);
      if (!taskResult.valid) {
        return res.status(403).json({ error: taskResult.reason });
      }
      
      // Check human has permission to request this execution
      const permissionCheck = await employee.checkExecutionPermission(dataDir, user, employeeId, taskResult.task);
      if (!permissionCheck.allowed) {
        return res.status(403).json({ error: permissionCheck.reason });
      }
      
      // Trigger server-side execution (Phase 04.1 tool loop).
      const result = await executeTask(dataDir, {
        employeeId,
        taskId,
        initiatingUserId: user.id,
        manager: getManager(),
        provider: options.runtimeProvider,
        maxSteps: req.body && req.body.maxSteps,
      });

      res.json({
        executionId: result.executionId,
        status: result.outcome,
        outcome: result.outcome,
        employee: result.employeeCode,
        task: taskId,
        provider: result.provider,
        model: result.model,
        startedAt: result.startTime,
        elapsedMs: result.elapsedMs,
        summary: result.summary,
        result: result.result,
        question: result.question,
        approval: result.approval,
        error: result.error,
        steps: result.steps || [],
      });
    } catch (err) {
      if (!err.status) console.error('[Agents] Execution error:', err);
      res.status(err.status || 500).json({ error: err.message || 'Execution failed' });
    }
  });

  /**
   * Get AI employee status
   * GET /api/agents/:employeeId/status
   */
  router.get('/:employeeId/status', async (req, res) => {
    try {
      const { employeeId } = req.params;
      
      if (!employeeId || !employeeId.startsWith('emp-ai-')) {
        return res.status(400).json({ error: 'Invalid employee ID' });
      }
      
      const { findById } = require('../employees/store');
      const emp = await findById(dataDir, employeeId);
      
      if (!emp) {
        return res.status(404).json({ error: 'Employee not found' });
      }
      
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
  
  /**
   * Get tasks assigned to an AI employee
   * GET /api/agents/:employeeId/tasks
   * Only accessible to the AI employee's team/manager
   */
  router.get('/:employeeId/tasks', async (req, res) => {
    try {
      const { employeeId } = req.params;
      const user = req.user;
      
      if (!employeeId || !employeeId.startsWith('emp-ai-')) {
        return res.status(400).json({ error: 'Invalid employee ID' });
      }
      
      // Verify employee exists
      const empResult = await employee.validate(dataDir, employeeId);
      if (!empResult.valid) {
        return res.status(404).json({ error: 'Employee not found' });
      }
      
      // Check human permissions - managers and admins can see their team's AI tasks
      const { role, managerId } = user;
      const isAdmin = role === 'admin' || role === 'founder' || role === 'manager';
      
      if (!isAdmin) {
        return res.status(403).json({ error: 'Access denied' });
      }
      
      // Get tasks assigned to this employee
      const { listTasks } = require('../tasks/store');
      const tasks = await listTasks(dataDir, { assignedTo: employeeId });
      
      res.json({ tasks, count: tasks.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  
  return router;
}

module.exports = { createAgentsRouter };