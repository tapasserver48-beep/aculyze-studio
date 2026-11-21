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
 */

const express = require('express');
const { requireUser } = require('../auth/authorize');
const { employee } = require('./store');

function createAgentsRouter({ dataDir }) {
  const router = express.Router();
  
  // All routes require authenticated human user
  router.use(requireUser);
  
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
      
      // Trigger server-side execution
      const { executeTask } = require('../execution/agentRuntime');
      const result = await executeTask(dataDir, {
        employeeId,
        taskId,
        initiatingUserId: user.id,
        maxSteps: 20,
        timeoutMs: 300000
      });
      
      res.json({ 
        executionId: result.executionId,
        status: result.status,
        employee: result.employeeCode,
        task: taskId,
        provider: result.provider,
        model: result.model,
        startedAt: result.startTime
      });
    } catch (err) {
      console.error('[Agents] Execution error:', err);
      res.status(500).json({ error: err.message || 'Execution failed' });
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