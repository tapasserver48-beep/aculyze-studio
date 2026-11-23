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
 * AI employee task operations:
 *   - Executed server-side through /api/agents/:employeeId/execute
 *   - Trusted execution context created after human validation
 *   - Never trust X-AI-Employee-Id from browser
 *
 * AI employee identity validation:
 *   - All AI operations happen through trusted internal execution context
 *   - Employee identity validated server-side
 *   - Task assignment validated before execution
 *   - All actions logged with verified actor identity
 */

const express = require('express');
const {
  listTasks, getTask, createTask, updateTask, deleteTask,
  addActivity, getTaskActivity, addComment, getTaskComments,
  getMonthlyReport, TASK_STATUS, TASK_PRIORITY
} = require('./store');
const { requireUser, requireRole } = require('../auth/authorize');

const MANAGER_ROLES = ['admin', 'founder', 'manager'];
const isManager = (user) => !!user && MANAGER_ROLES.includes(user.role);
/** The human who asked for the task (assigned it, or started its AI run). */
const isRequester = (task, user) => !!user && !!task
  && ((task.assigned_by_type !== 'ai' && task.assigned_by_id === user.id) || task.initiating_user_id === user.id);

// Fields a PATCH /:id may change. Assignees may only move their own work
// forward; managers may also re-plan and reassign.
const OWNER_EDITABLE = ['status', 'progress', 'description', 'pending_reason'];
const MANAGER_EDITABLE = [...OWNER_EDITABLE, 'title', 'priority', 'start_date', 'due_date',
  'assigned_to_type', 'assigned_to_id', 'expected_deliverable'];
const VALID_STATUSES = Object.values(TASK_STATUS);
const VALID_PRIORITIES = Object.values(TASK_PRIORITY);
const VALID_PENDING_REASONS = ['waiting_for_info', 'awaiting_approval', 'blocked', 'deferred'];

/** Pick and validate allowed PATCH fields. Returns { updates } or { error }. */
function pickTaskUpdates(body, allowed) {
  const updates = {};
  for (const key of allowed) {
    if (body[key] !== undefined) updates[key] = body[key];
  }
  if ('status' in updates && !VALID_STATUSES.includes(updates.status)) return { error: 'Invalid status' };
  if ('priority' in updates && !VALID_PRIORITIES.includes(updates.priority)) return { error: 'Invalid priority' };
  if ('pending_reason' in updates && updates.pending_reason !== null && !VALID_PENDING_REASONS.includes(updates.pending_reason)) {
    return { error: 'Invalid pending_reason' };
  }
  if ('assigned_to_type' in updates && !['human', 'ai'].includes(updates.assigned_to_type)) return { error: 'Invalid assigned_to_type' };
  if ('progress' in updates) updates.progress = Math.max(0, Math.min(100, Number(updates.progress) || 0));
  if ('description' in updates) updates.description = String(updates.description ?? '').slice(0, 5000);
  if ('title' in updates) {
    updates.title = String(updates.title ?? '').trim().slice(0, 300);
    if (!updates.title) return { error: 'title cannot be empty' };
  }
  for (const k of ['start_date', 'due_date']) {
    if (k in updates && updates[k] !== null) {
      const n = Number(updates[k]);
      if (!Number.isFinite(n)) return { error: `Invalid ${k}` };
      updates[k] = n;
    }
  }
  if (updates.status === 'completed') updates.completed_at = Date.now();
  return { updates };
}

function createTasksRouter({ dataDir }) {
  const router = express.Router();

  /**
   * Resolve the AI employee a human is acting for on an AI-assigned task.
   * Identity comes from the task's server-side assignment — never from a
   * browser header. Only managers or the user who initiated the task may act.
   */
  async function resolveAiActor(req, res, next) {
    try {
      const task = await getTask(dataDir, req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      if (task.assigned_to_type !== 'ai') {
        return res.status(403).json({ error: 'Access denied: task is not assigned to an AI employee', code: 'forbidden' });
      }
      if (!isManager(req.user) && task.initiating_user_id !== req.user.id) {
        return res.status(403).json({ error: 'Access denied', code: 'forbidden' });
      }
      const { resolveEmployee } = require('../execution/context');
      const resolved = await resolveEmployee(dataDir, task.assigned_to_id);
      if (!resolved.valid) return res.status(403).json({ error: resolved.reason, code: 'forbidden' });
      req.aiEmployee = resolved.employee;
      next();
    } catch (err) {
      res.status(500).json({ error: String(err.message || err).slice(0, 200) });
    }
  }

  // Overall summary — declared before /:id so it is not shadowed by it.
  // Non-managers only see stats for tasks assigned to them.
  router.get('/summary', requireUser, async (req, res) => {
    try {
      const filters = { limit: 10000 };
      if (!isManager(req.user)) filters.assignedTo = req.user.id;
      const allTasks = await listTasks(dataDir, filters);
      const count = (pred) => allTasks.filter(pred).length;
      const stats = {
        total: allTasks.length,
        completed: count(t => t.status === 'completed'),
        pending: count(t => t.status === 'pending'),
        in_progress: count(t => t.status === 'in_progress'),
        overdue: count(t => t.status !== 'completed' && t.due_date && Number(t.due_date) < Date.now()),
        by_status: Object.fromEntries(VALID_STATUSES.map(s => [s, count(t => t.status === s)])),
        by_priority: Object.fromEntries(VALID_PRIORITIES.map(p => [p, count(t => t.priority === p)])),
      };
      res.json({ stats });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err).slice(0, 200) });
    }
  });

  // People tasks can be assigned to: humans + active AI employees, by name.
  // Lets the UI show names instead of raw ids. Declared before /:id.
  router.get('/people', requireUser, async (req, res) => {
    try {
      const authStore = require('../auth/store');
      const { listEmployees } = require('../employees/store');
      const users = await authStore.listUsers(dataDir);
      const employees = await listEmployees(dataDir);
      const people = [
        ...users.map(u => ({ id: u.id, name: u.name || u.email || 'Unnamed', kind: 'human', role: u.role || 'employee' })),
        ...employees
          .filter(e => e.employee_type === 'ai' && e.status === 'active')
          .map(e => ({ id: e.id, name: e.name, kind: 'ai', role: e.designation || 'AI employee', code: e.employee_code })),
      ];
      res.json({ people });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err).slice(0, 200) });
    }
  });

  // List tasks (with optional filters). Non-managers only see their own tasks.
  router.get('/', requireUser, async (req, res) => {
    try {
      const filters = {
        assignedTo: isManager(req.user) ? req.query.assignedTo : undefined,
        // Non-managers see tasks assigned to them plus tasks they asked for.
        visibleTo: isManager(req.user) ? undefined : req.user.id,
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

  // Get specific task
  router.get('/:id', requireUser, async (req, res) => {
    try {
      const task = await getTask(dataDir, req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });

      // Authorization check
      const user = req.user;
      const taskOwner = task.assigned_to_type === 'human' && task.assigned_to_id === user.id;
      const isAdmin = user.role === 'admin' || user.role === 'founder' || user.role === 'manager';

      if (!taskOwner && !isAdmin && !isRequester(task, user)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      res.json({ task });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err).slice(0, 200) });
    }
  });

  // AI employee can view their own tasks (via header, not session)
  // NOTE: This endpoint is kept for backward compatibility but requires
  // trusted server-side validation. Browser clients should use /api/agents/:id/tasks
  router.get('/ai/:id', async (req, res) => {
    try {
      const task = await getTask(dataDir, req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });

      // This endpoint is deprecated - use /api/agents/:employeeId/tasks instead
      // For now, require authentication for basic access
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      // Human can access tasks they're assigned to
      const isOwner = task.assigned_to_type === 'human' && task.assigned_to_id === req.user.id;
      const isAdmin = req.user.role === 'admin' || req.user.role === 'founder' || req.user.role === 'manager';
      
      // X-AI-Employee-Id is never trusted: a browser could forge it.
      if (!isOwner && !isAdmin) {
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

      const picked = pickTaskUpdates(req.body || {}, isAdmin ? MANAGER_EDITABLE : OWNER_EDITABLE);
      if (picked.error) return res.status(422).json({ error: picked.error });
      if (!Object.keys(picked.updates).length) return res.status(422).json({ error: 'No editable fields supplied' });
      const updated = await updateTask(dataDir, req.params.id, picked.updates);
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

      if (!taskOwner && !isAdmin && !isRequester(task, user)) {
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

  // Get task comments (same access rule as reading the task)
  router.get('/:id/comments', requireUser, async (req, res) => {
    try {
      const task = await getTask(dataDir, req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      const isOwner = task.assigned_to_type === 'human' && task.assigned_to_id === req.user.id;
      if (!isOwner && !isManager(req.user) && !isRequester(task, req.user)) return res.status(403).json({ error: 'Access denied' });
      res.json({ comments: await getTaskComments(dataDir, req.params.id) });
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

        if (taskOwner || isAdmin || isRequester(task, user)) {
          const activity = await getTaskActivity(dataDir, req.params.id);
          return res.json({ activity });
        }
      }

      // AI access to activity requires authenticated user with proper authorization
      if (req.user) {
        const user = req.user;
        const taskOwner = task.assigned_to_type === 'human' && task.assigned_to_id === user.id;
        const isAdmin = user.role === 'admin' || user.role === 'founder' || user.role === 'manager';
        
        if (taskOwner || isAdmin || isRequester(task, user)) {
          const activity = await getTaskActivity(dataDir, req.params.id);
          return res.json({ activity });
        }
      }

      return res.status(403).json({ error: 'Access denied' });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err).slice(0, 200) });
    }
  });

  // Internal task operations for AI employee execution
  // These endpoints are used by the trusted agent runtime, not browser clients
  
  // AI acknowledges a task assignment (internal use)
  router.patch('/:id/acknowledge', requireUser, resolveAiActor, async (req, res) => {
    try {
      const task = await getTask(dataDir, req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });

      const aiEmployee = req.aiEmployee;
      if (!aiEmployee) {
        return res.status(401).json({ error: 'AI employee identity required' });
      }

      // AI can only act on tasks assigned to them
      if (task.assigned_to_type !== 'ai' || task.assigned_to_id !== aiEmployee.id) {
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

  // AI updates task progress (progress percentage or description) - internal use
  router.patch('/:id/progress', requireUser, resolveAiActor, async (req, res) => {
    try {
      const task = await getTask(dataDir, req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });

      const aiEmployee = req.aiEmployee;
      if (!aiEmployee) {
        return res.status(401).json({ error: 'AI employee identity required' });
      }

      // AI can only act on tasks assigned to them
      if (task.assigned_to_type !== 'ai' || task.assigned_to_id !== aiEmployee.id) {
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

  // AI changes task status with validation - internal use
  router.patch('/:id/status', requireUser, resolveAiActor, async (req, res) => {
    try {
      const task = await getTask(dataDir, req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });

      const aiEmployee = req.aiEmployee;
      if (!aiEmployee) {
        return res.status(401).json({ error: 'AI employee identity required' });
      }

      // AI can only act on tasks assigned to them
      if (task.assigned_to_type !== 'ai' || task.assigned_to_id !== aiEmployee.id) {
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

  // AI reports a blocker (sets task to pending) - internal use
  router.patch('/:id/blocker', requireUser, resolveAiActor, async (req, res) => {
    try {
      const task = await getTask(dataDir, req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });

      const aiEmployee = req.aiEmployee;
      if (!aiEmployee) {
        return res.status(401).json({ error: 'AI employee identity required' });
      }

      // AI can only act on tasks assigned to them
      if (task.assigned_to_type !== 'ai' || task.assigned_to_id !== aiEmployee.id) {
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

  // AI adds a comment to a task - internal use
  router.post('/:id/comments/ai', requireUser, resolveAiActor, async (req, res) => {
    try {
      const task = await getTask(dataDir, req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });

      const aiEmployee = req.aiEmployee;
      if (!aiEmployee) {
        return res.status(401).json({ error: 'AI employee identity required' });
      }

      // AI can only act on tasks assigned to them
      if (task.assigned_to_type !== 'ai' || task.assigned_to_id !== aiEmployee.id) {
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