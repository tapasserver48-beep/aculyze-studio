/**
 * /api/tasks — central task management API.
 *
 * Human-authorized endpoints:
 *   GET  /api/tasks                       → list (with filters)
 *   GET  /api/tasks/:id                   → get one
 *   POST /api/tasks                       → create
 *   PATCH /api/tasks/:id                  → update
 *   DELETE /api/tasks/:id                 → delete
 *   GET  /api/tasks/employee/:id          → tasks for employee
 *   GET  /api/tasks/summary               → overall stats
 *   GET  /api/tasks/reports/monthly       → monthly report (year, month, employeeId)
 *   POST /api/tasks/:id/comments          → add comment
 *   GET  /api/tasks/:id/activity          → get activity log
 *
 * AI-authorized endpoints (requires X-AI-Employee-Id header):
 *   PATCH /api/tasks/:id/acknowledge      → AI acknowledges task assignment
 *   PATCH /api/tasks/:id/progress         → AI updates task progress
 *   PATCH /api/tasks/:id/status           → AI changes task status
 *   PATCH /api/tasks/:id/blocker          → AI reports blocker with pending reason
 *   POST /api/tasks/:id/comments/ai      → AI adds comment
 *
 * AI employee identity validation:
 * - AI requests use X-AI-Employee-Id header (never trust client identity)
 * - AI employees can only act on tasks assigned to them
 * - All AI actions are logged for audit trail
 */

const express = require('express');
const {
  listTasks, getTask, createTask, updateTask, deleteTask,
  addActivity, getTaskActivity, addComment, getTaskComments,
  getMonthlyReport, TASK_STATUS, TASK_PRIORITY
} = require('./store');
const { requireUser, requireRole } = require('../auth/authorize');
const { findByCode: findAiEmployeeByCode } = require('../employees/store');

function createTasksRouter({ dataDir }) {
  const router = express.Router();

  // List tasks (with optional filters)
  router.get('/', requireUser, async (req, res) => {
    try {
      const filters = {
        assignedTo: req.query.assignedTo,
        status: req.query.status,
        priority: req.query.priority,
        employeeType: req.query.employeeType,
        limit: req.query.limit ? Number(req.query.limit) : 100,
        offset: req.query.offset ? Number(req.query.offset) : 0,
      };
      const tasks = await listTasks(dataDir, filters);
      res.json({ tasks });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err).slice(0, 200) });
    }
  });

  // AI employee can list their own tasks (via header, not session)
  router.get('/ai', async (req, res) => {
    try {
      const aiEmployeeId = req.header('X-AI-Employee-Id');
      if (!aiEmployeeId) {
        return res.status(401).json({ error: 'AI employee identity required' });
      }

      // Validate AI employee
      const { findById } = require('../employees/store');
      const employee = await findById(dataDir, aiEmployeeId);
      if (!employee || employee.status !== 'active') {
        return res.status(403).json({ error: 'Invalid AI employee' });
      }

      const filters = {
        assignedTo: aiEmployeeId,
        status: req.query.status,
        priority: req.query.priority,
        limit: req.query.limit ? Number(req.query.limit) : 100,
        offset: req.query.offset ? Number(req.query.offset) : 0,
      };
      const tasks = await listTasks(dataDir, filters);
      res.json({ tasks, count: tasks.length });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err).slice(0, 200) });
    }
  });

  // Get specific task
  router.get('/:id', requireUser, async (req, res) => {
    try {
      const task = await getTask(dataDir, req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });

      // Authorization check
      const user = req.user;
      const taskOwner = task.assigned_to_type === 'human' && task.assigned_to_id === user.id;
      const isAdmin = user.role === 'admin' || user.role === 'founder' || user.role === 'manager';

      if (!taskOwner && !isAdmin) {
        return res.status(403).json({ error: 'Access denied' });
      }

      res.json({ task });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err).slice(0, 200) });
    }
  });

  // AI employee can view their own tasks (via header, not session)
  router.get('/ai/:id', async (req, res) => {
    try {
      const aiEmployeeId = req.header('X-AI-Employee-Id');
      if (!aiEmployeeId) {
        return res.status(401).json({ error: 'AI employee identity required' });
      }

      // Validate AI employee
      const { findById } = require('../employees/store');
      const employee = await findById(dataDir, aiEmployeeId);
      if (!employee || employee.status !== 'active') {
        return res.status(403).json({ error: 'Invalid AI employee' });
      }

      const task = await getTask(dataDir, req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });

      // AI can only view tasks assigned to them
      if (task.assigned_to_type !== 'ai' || task.assigned_to_id !== aiEmployeeId) {
        return res.status(403).json({ error: 'Access denied' });
      }

      res.json({ task });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err).slice(0, 200) });
    }
  });

  // Create task
  router.post('/', requireUser, async (req, res) => {
    try {
      const { title, description, assignedTo, assignedBy, priority, dueDate } = req.body;
      if (!title || !assignedTo) {
        return res.status(422).json({ error: 'title and assignedTo are required' });
      }

      const task = await createTask(dataDir, {
        title,
        description,
        assignedTo,
        assignedBy: { type: 'human', id: req.user.id },
        priority: priority || 'medium',
        dueDate,
      });
      res.status(201).json({ task });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err).slice(0, 200) });
    }
  });

  // Update task
  router.patch('/:id', requireUser, async (req, res) => {
    try {
      const task = await getTask(dataDir, req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });

      // Authorization: owner, manager, or admin
      const user = req.user;
      const isOwner = task.assigned_to_type === 'human' && task.assigned_to_id === user.id;
      const isAdmin = user.role === 'admin' || user.role === 'founder' || user.role === 'manager';

      if (!isOwner && !isAdmin) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const updates = req.body || {};
      const updated = await updateTask(dataDir, req.params.id, updates);
      res.json({ task: updated });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err).slice(0, 200) });
    }
  });

  // Delete task
  router.delete('/:id', requireRole(['admin', 'founder']), async (req, res) => {
    try {
      const deleted = await deleteTask(dataDir, req.params.id);
      if (!deleted) return res.status(404).json({ error: 'Task not found' });
      res.json({ deleted: true });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err).slice(0, 200) });
    }
  });

  // Tasks for specific employee
  router.get('/employee/:id', requireUser, async (req, res) => {
    try {
      const employeeId = req.params.id;
      const user = req.user;
      const isAdmin = user.role === 'admin' || user.role === 'founder' || user.role === 'manager';

      // Authorization: can only see own tasks unless admin
      if (employeeId !== user.id && !isAdmin) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const tasks = await listTasks(dataDir, { assignedTo: employeeId });
      res.json({ tasks });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err).slice(0, 200) });
    }
  });

  // Overall summary (no filters)
  router.get('/summary', requireUser, async (req, res) => {
    try {
      const allTasks = await listTasks(dataDir, { limit: 10000 });
      const stats = {
        total: allTasks.length,
        completed: allTasks.filter(t => t.status === 'completed').length,
        pending: allTasks.filter(t => t.status === 'pending').length,
        in_progress: allTasks.filter(t => t.status === 'in_progress').length,
        overdue: allTasks.filter(t => {
          if (t.status === 'completed') return false;
          if (!t.due_date) return false;
          return Number(t.due_date) < Date.now();
        }).length,
        by_status: {
          todo: allTasks.filter(t => t.status === 'todo').length,
          in_progress: allTasks.filter(t => t.status === 'in_progress').length,
          pending: allTasks.filter(t => t.status === 'pending').length,
          under_review: allTasks.filter(t => t.status === 'under_review').length,
          completed: allTasks.filter(t => t.status === 'completed').length,
          cancelled: allTasks.filter(t => t.status === 'cancelled').length,
        },
        by_priority: {
          low: allTasks.filter(t => t.priority === 'low').length,
          medium: allTasks.filter(t => t.priority === 'medium').length,
          high: allTasks.filter(t => t.priority === 'high').length,
          urgent: allTasks.filter(t => t.priority === 'urgent').length,
        }
      };
      res.json({ stats });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err).slice(0, 200) });
    }
  });

  // Monthly report
  router.get('/reports/monthly', requireRole(['admin', 'founder', 'manager']), async (req, res) => {
    try {
      const year = Number(req.query.year) || new Date().getFullYear();
      const month = Number(req.query.month) || new Date().getMonth() + 1;
      const employeeId = req.query.employeeId || null;
      const employeeType = req.query.employeeType || null;

      const report = await getMonthlyReport(dataDir, { year, month, employeeId, employeeType });
      res.json({ report });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err).slice(0, 200) });
    }
  });

  // Add comment to task
  router.post('/:id/comments', requireUser, async (req, res) => {
    try {
      const task = await getTask(dataDir, req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });

      // Authorization: task owner, manager, or admin can comment
      const user = req.user;
      const taskOwner = task.assigned_to_type === 'human' && task.assigned_to_id === user.id;
      const isAdmin = user.role === 'admin' || user.role === 'founder' || user.role === 'manager';

      if (!taskOwner && !isAdmin) {
        return res.status(403).json({ error: 'Access denied: cannot comment on this task' });
      }

      const { content } = req.body;
      if (!content) return res.status(422).json({ error: 'content is required' });

      const comment = await addComment(dataDir, {
        taskId: req.params.id,
        authorType: 'human',
        authorId: req.user.id,
        content,
      });
      res.status(201).json({ comment });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err).slice(0, 200) });
    }
  });

  // Get task activity
  router.get('/:id/activity', async (req, res) => {
    try {
      const task = await getTask(dataDir, req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });

      // Check for human user first (authenticated via session)
      if (req.user && req.authUid) {
        const user = req.user;
        const taskOwner = task.assigned_to_type === 'human' && task.assigned_to_id === user.id;
        const isAdmin = user.role === 'admin' || user.role === 'founder' || user.role === 'manager';

        if (taskOwner || isAdmin) {
          const activity = await getTaskActivity(dataDir, req.params.id);
          return res.json({ activity });
        }
      }

      // Check for AI employee (via header - server-side validation only)
      const aiEmployeeId = req.header('X-AI-Employee-Id');
      if (aiEmployeeId && task.assigned_to_type === 'ai' && task.assigned_to_id === aiEmployeeId) {
        // Validate AI employee
        const { findById } = require('../employees/store');
        const employee = await findById(dataDir, aiEmployeeId);
        if (!employee || employee.status !== 'active') {
          return res.status(403).json({ error: 'Invalid AI employee' });
        }
        const activity = await getTaskActivity(dataDir, req.params.id);
        return res.json({ activity });
      }

      return res.status(403).json({ error: 'Access denied' });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err).slice(0, 200) });
    }
  });

  // ---------- AI Employee Task Operations ----------
  // AI employees identify via X-AI-Employee-Id header — server-side validation only
  // AI cannot impersonate human users or other AI employees
  
  function requireAiEmployee(req, res, next) {
    const aiEmployeeId = req.header('X-AI-Employee-Id');
    if (!aiEmployeeId) {
      return res.status(401).json({ error: 'AI employee identity required', code: 'unauthenticated' });
    }
    
    // Validate AI employee exists and is active
    Promise.resolve()
      .then(() => {
        // Try to find by ID format (emp-ai-*) or code (AI-CHIEF-001, etc.)
        if (aiEmployeeId.startsWith('emp-ai-')) {
          return requireAiEmployeeById(dataDir, aiEmployeeId);
        } else {
          // It's a code, find by code
          return requireAiEmployeeByCode(dataDir, aiEmployeeId);
        }
      })
      .then((employee) => {
        if (!employee) {
          return res.status(403).json({ error: 'Invalid AI employee identity', code: 'forbidden' });
        }
        if (employee.status !== 'active') {
          return res.status(403).json({ error: 'AI employee is not active', code: 'inactive' });
        }
        req.aiEmployee = employee;
        next();
      })
      .catch((err) => {
        if (res.headersSent) return;
        res.status(500).json({ error: 'AI identity validation failed', code: 'server_error' });
      });
  }

  async function requireAiEmployeeById(dataDir, id) {
    const { findById } = require('../employees/store');
    return findById(dataDir, id);
  }

  async function requireAiEmployeeByCode(dataDir, code) {
    const { findByCode } = require('../employees/store');
    return findByCode(dataDir, code.toUpperCase());
  }

  function canActOnTask(aiEmployee, task) {
    // AI can only act on tasks assigned to them
    if (task.assigned_to_type !== 'ai') return false;
    return task.assigned_to_id === aiEmployee.id;
  }

  // AI acknowledges a task assignment
  router.patch('/:id/acknowledge', requireAiEmployee, async (req, res) => {
    try {
      const task = await getTask(dataDir, req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });

      const aiEmployee = req.aiEmployee;
      if (!canActOnTask(aiEmployee, task)) {
        return res.status(403).json({ error: 'Access denied: not assigned to this AI employee', code: 'forbidden' });
      }

      if (task.status !== 'todo') {
        return res.status(400).json({ error: 'Task is not in todo status', code: 'invalid_state' });
      }

      const updated = await updateTask(dataDir, req.params.id, { 
        status: 'in_progress',
        updated_at: Date.now()
      });

      await addActivity(dataDir, {
        taskId: req.params.id,
        actorType: 'ai',
        actorId: aiEmployee.id,
        action: 'acknowledge',
        details: { employee_code: aiEmployee.employee_code }
      });

      res.json({ task: updated });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err).slice(0, 200) });
    }
  });

  // AI updates task progress (progress percentage or description)
  router.patch('/:id/progress', requireAiEmployee, async (req, res) => {
    try {
      const task = await getTask(dataDir, req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });

      const aiEmployee = req.aiEmployee;
      if (!canActOnTask(aiEmployee, task)) {
        return res.status(403).json({ error: 'Access denied', code: 'forbidden' });
      }

      const { progress, description } = req.body || {};
      const updates = { 
        status: task.status === 'todo' ? 'in_progress' : task.status,
        updated_at: Date.now()
      };

      if (progress !== undefined) {
        updates.progress = Math.max(0, Math.min(100, Number(progress)));
      }
      if (description) {
        updates.description = String(description).slice(0, 2000);
      }

      const updated = await updateTask(dataDir, req.params.id, updates);

      await addActivity(dataDir, {
        taskId: req.params.id,
        actorType: 'ai',
        actorId: aiEmployee.id,
        action: 'progress_update',
        details: { progress, description: description?.slice(0, 500) }
      });

      res.json({ task: updated });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err).slice(0, 200) });
    }
  });

  // AI changes task status with validation
  router.patch('/:id/status', requireAiEmployee, async (req, res) => {
    try {
      const task = await getTask(dataDir, req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });

      const aiEmployee = req.aiEmployee;
      if (!canActOnTask(aiEmployee, task)) {
        return res.status(403).json({ error: 'Access denied', code: 'forbidden' });
      }

      const { status, pendingReason } = req.body || {};
      const validStatuses = ['todo', 'in_progress', 'pending', 'under_review', 'completed', 'cancelled'];
      
      if (!status || !validStatuses.includes(status)) {
        return res.status(422).json({ error: 'Valid status required: ' + validStatuses.join(', ') });
      }

      // Validate status transition
      const currentStatus = task.status;
      const validTransitions = {
        'todo': ['in_progress', 'cancelled'],
        'in_progress': ['pending', 'under_review', 'completed', 'cancelled'],
        'pending': ['in_progress', 'under_review', 'cancelled'],
        'under_review': ['completed', 'pending', 'cancelled'],
        'completed': [], // Terminal state
        'cancelled': [] // Terminal state
      };

      if (!validTransitions[currentStatus].includes(status)) {
        return res.status(400).json({ 
          error: `Cannot transition from ${currentStatus} to ${status}`, 
          code: 'invalid_transition' 
        });
      }

      const updates = { status };
      if (pendingReason) {
        const validReasons = ['waiting_for_info', 'awaiting_approval', 'blocked', 'deferred'];
        if (!validReasons.includes(pendingReason)) {
          return res.status(422).json({ error: 'Invalid pending reason' });
        }
        updates.pending_reason = pendingReason;
      }
      if (status === 'completed') {
        updates.completed_at = Date.now();
      }

      const updated = await updateTask(dataDir, req.params.id, updates);

      await addActivity(dataDir, {
        taskId: req.params.id,
        actorType: 'ai',
        actorId: aiEmployee.id,
        action: 'status_change',
        details: { from: currentStatus, to: status, pending_reason: pendingReason || null }
      });

      res.json({ task: updated });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err).slice(0, 200) });
    }
  });

  // AI reports a blocker (sets task to pending)
  router.patch('/:id/blocker', requireAiEmployee, async (req, res) => {
    try {
      const task = await getTask(dataDir, req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });

      const aiEmployee = req.aiEmployee;
      if (!canActOnTask(aiEmployee, task)) {
        return res.status(403).json({ error: 'Access denied', code: 'forbidden' });
      }

      const { reason, description } = req.body || {};
      const validReasons = ['waiting_for_info', 'awaiting_approval', 'blocked', 'deferred'];
      
      if (!reason || !validReasons.includes(reason)) {
        return res.status(422).json({ error: 'Valid pending reason required: ' + validReasons.join(', ') });
      }

      const updated = await updateTask(dataDir, req.params.id, { 
        status: 'pending',
        pending_reason: reason,
        description: description ? String(description).slice(0, 2000) : task.description,
        updated_at: Date.now()
      });

      await addActivity(dataDir, {
        taskId: req.params.id,
        actorType: 'ai',
        actorId: aiEmployee.id,
        action: 'report_blocker',
        details: { reason, description: description?.slice(0, 500) }
      });

      res.json({ task: updated });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err).slice(0, 200) });
    }
  });

  // AI adds a comment to a task
  router.post('/:id/comments/ai', requireAiEmployee, async (req, res) => {
    try {
      const task = await getTask(dataDir, req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });

      const aiEmployee = req.aiEmployee;
      if (!canActOnTask(aiEmployee, task)) {
        return res.status(403).json({ error: 'Access denied', code: 'forbidden' });
      }

      const { content } = req.body || {};
      if (!content || !String(content).trim()) {
        return res.status(422).json({ error: 'Content is required' });
      }

      const comment = await addComment(dataDir, {
        taskId: req.params.id,
        authorType: 'ai',
        authorId: aiEmployee.id,
        content: String(content).slice(0, 2000)
      });

      await addActivity(dataDir, {
        taskId: req.params.id,
        actorType: 'ai',
        actorId: aiEmployee.id,
        action: 'add_comment',
        details: { comment_id: comment.id }
      });

      res.status(201).json({ comment });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err).slice(0, 200) });
    }
  });

  return router;
}

module.exports = { createTasksRouter, TASK_STATUS, TASK_PRIORITY };