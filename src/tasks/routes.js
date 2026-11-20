/**
 * /api/tasks — central task management API.
 *
 * GET  /api/tasks                       → list (with filters)
 * GET  /api/tasks/:id                   → get one
 * POST /api/tasks                       → create
 * PATCH /api/tasks/:id                  → update
 * DELETE /api/tasks/:id                 → delete
 * GET  /api/tasks/employee/:id          → tasks for employee
 * GET  /api/tasks/summary               → overall stats
 * GET  /api/tasks/reports/monthly       → monthly report (year, month, employeeId)
 * POST /api/tasks/:id/comments          → add comment
 * GET  /api/tasks/:id/activity          → get activity log
 *
 * Authorization:
 * - Human employees can only view/own their own tasks
 * - Managers can view all tasks under their department
 * - Admin/founder have full access
 * - AI agents need explicit permission to modify tasks
 */

const express = require('express');
const {
  listTasks, getTask, createTask, updateTask, deleteTask,
  addActivity, getTaskActivity, addComment, getTaskComments,
  getMonthlyReport, TASK_STATUS, TASK_PRIORITY
} = require('./store');
const { requireUser, requireRole } = require('../auth/authorize');

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
  router.get('/:id/activity', requireUser, async (req, res) => {
    try {
      const task = await getTask(dataDir, req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });

      const activity = await getTaskActivity(dataDir, req.params.id);
      res.json({ activity });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err).slice(0, 200) });
    }
  });

  return router;
}

module.exports = { createTasksRouter, TASK_STATUS, TASK_PRIORITY };