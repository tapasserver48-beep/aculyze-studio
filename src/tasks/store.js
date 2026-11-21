/**
 * Task Management Registry — central task engine for AI and human employees.
 *
 * Tasks are assigned to either a human user (id: usr-*) or an AI employee (id: emp-ai-*).
 *
 * Storage: data/tasks/ directory (JSON) or PostgreSQL table when DATABASE_URL is set.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pg = require('../db/pg');

const TASK_STATUS = {
  TODO: 'todo',
  IN_PROGRESS: 'in_progress',
  PENDING: 'pending',
  UNDER_REVIEW: 'under_review',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

const TASK_PRIORITY = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  URGENT: 'urgent',
};

const ASSIGNMENT_TYPES = {
  HUMAN: 'human',
  AI: 'ai',
};

const PENDING_REASONS = {
  WAITING_FOR_INFO: 'waiting_for_info',
  AWAITING_APPROVAL: 'awaiting_approval',
  BLOCKED: 'blocked',
  DEFERRED: 'deferred',
};

function generateTaskId() {
  return 'task-' + crypto.randomUUID().substring(0, 12);
}

const tasksDir = (dataDir) => path.join(dataDir, 'tasks');
const taskFile = (dataDir, status) => path.join(dataDir, 'tasks', `${status}.json`);

function readTasksFile(dataDir) {
  try {
    const file = path.join(dataDir, 'tasks', 'all.json');
    const content = fs.readFileSync(file, 'utf8');
    return JSON.parse(content);
  } catch {
    return { tasks: [] };
  }
}

function writeTasksFile(dataDir, doc) {
  const dir = tasksDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'all.json');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ---------- PostgreSQL Support ----------

async function ensureSchema() {
  if (!pg.enabled()) {
    const dataDir = process.env.ACULYZE_DATA_DIR;
    const file = path.join(dataDir, 'tasks', 'all.json');
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ tasks: [] }, null, 2), 'utf8');
    }
    return;
  }

  await pg.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id                    TEXT PRIMARY KEY,
      task_code             TEXT NOT NULL,
      title                 TEXT NOT NULL,
      description           TEXT,
      assigned_to_type      TEXT NOT NULL CHECK (assigned_to_type IN ('human', 'ai')),
      assigned_to_id        TEXT NOT NULL,
      assigned_by_type      TEXT NOT NULL CHECK (assigned_by_type IN ('human', 'ai')),
      assigned_by_id        TEXT NOT NULL,
      priority              TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
      status                TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'pending', 'under_review', 'completed', 'cancelled')),
      start_date            BIGINT,
      due_date              BIGINT,
      completed_at          BIGINT,
      pending_reason        TEXT,
      parent_task_id        TEXT,
      initiating_user_id    TEXT,
      expected_deliverable  TEXT,
      dependencies          JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at            BIGINT NOT NULL,
      updated_at            BIGINT NOT NULL
    )
  `);

  // Phase 03.3 — delegation metadata on the existing tasks table (no new
  // task system). ALTER ... IF NOT EXISTS keeps idempotent boot safe.
  await pg.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_task_id TEXT');
  await pg.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS initiating_user_id TEXT');
  await pg.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS expected_deliverable TEXT');
  await pg.query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS dependencies JSONB NOT NULL DEFAULT '[]'::jsonb");

  // Indexes for efficient querying
  await pg.query('CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks (assigned_to_type, assigned_to_id)');
  await pg.query('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status)');
  await pg.query('CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks (due_date)');
  await pg.query('CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks (priority)');
  await pg.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_code ON tasks (task_code)');
  await pg.query('CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks (created_at DESC)');

  // Activity table
  await pg.query(`
    CREATE TABLE IF NOT EXISTS task_activity (
      id            TEXT PRIMARY KEY,
      task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      actor_type    TEXT NOT NULL CHECK (actor_type IN ('human', 'ai')),
      actor_id      TEXT NOT NULL,
      action        TEXT NOT NULL,
      details       JSONB,
      created_at    BIGINT NOT NULL
    )
  `);
  await pg.query('CREATE INDEX IF NOT EXISTS idx_task_activity_task ON task_activity (task_id)');

  // Comments table
  await pg.query(`
    CREATE TABLE IF NOT EXISTS task_comments (
      id          TEXT PRIMARY KEY,
      task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      author_type TEXT NOT NULL CHECK (author_type IN ('human', 'ai')),
      author_id   TEXT NOT NULL,
      content     TEXT NOT NULL,
      created_at  BIGINT NOT NULL
    )
  `);
  await pg.query('CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments (task_id)');

  // Migrate from JSON if tables are empty
  const { rows: taskCount } = await pg.query('SELECT COUNT(*) AS cnt FROM tasks');
  if (taskCount[0].cnt === 0) {
    const dataDir = process.env.ACULYZE_DATA_DIR;
    const jsonData = readTasksFile(dataDir);
    for (const t of jsonData.tasks || []) {
      await pg.query(
        `INSERT INTO tasks (id, task_code, title, description, assigned_to_type, assigned_to_id,
          assigned_by_type, assigned_by_id, priority, status, start_date, due_date, completed_at,
          pending_reason, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [t.id, t.task_code, t.title, t.description, t.assigned_to_type, t.assigned_to_id,
         t.assigned_by_type, t.assigned_by_id, t.priority, t.status, t.start_date, t.due_date,
         t.completed_at, t.pending_reason, t.created_at, t.updated_at]
      );
    }
  }
}

// ---------- Main Functions ----------

const now = () => Date.now();

function calcOverdue(task) {
  if (task.status === 'completed') return false;
  if (!task.due_date) return false;
  return Number(task.due_date) < Date.now();
}

async function listTasks(dataDir, filters = {}) {
  const { assignedTo, status, priority, employeeType, limit = 100, offset = 0 } = filters;

  if (pg.enabled()) {
    const params = [];
    const conditions = [];
    let idx = 1;

    if (assignedTo) {
      conditions.push(`(assigned_to_type = 'human' AND assigned_to_id = $${idx++}) OR (assigned_to_type = 'ai' AND assigned_to_id = $${idx++})`);
    }
    if (status) {
      conditions.push(`status = $${idx++}`);
    }
    if (priority) {
      conditions.push(`priority = $${idx++}`);
    }
    if (employeeType) {
      conditions.push(`assigned_to_type = $${idx++}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pg.query(
      `SELECT * FROM tasks ${where} ORDER BY due_date NULLS LAST, created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...(typeof assignedTo === 'object' ? [assignedTo.human, assignedTo.ai] : assignedTo ? [assignedTo, assignedTo] : []),
       status, priority, employeeType, limit, offset].filter(x => x !== undefined)
    );
    return rows.map(r => ({ ...r, created_at: Number(r.created_at), updated_at: Number(r.updated_at), start_date: r.start_date ? Number(r.start_date) : null, due_date: r.due_date ? Number(r.due_date) : null, completed_at: r.completed_at ? Number(r.completed_at) : null }));
  }

  const doc = readTasksFile(dataDir);
  let tasks = doc.tasks || [];

  if (assignedTo) {
    tasks = tasks.filter(t => t.assigned_to_id === assignedTo || t.assigned_to_id === assignedTo);
  }
  if (status) {
    tasks = tasks.filter(t => t.status === status);
  }
  if (priority) {
    tasks = tasks.filter(t => t.priority === priority);
  }
  if (employeeType) {
    tasks = tasks.filter(t => t.assigned_to_type === employeeType);
  }

  return tasks.slice(offset, offset + limit);
}

async function getTask(dataDir, id) {
  if (pg.enabled()) {
    const { rows } = await pg.query('SELECT * FROM tasks WHERE id = $1', [id]);
    if (!rows.length) return null;
    const r = rows[0];
    return { ...r, created_at: Number(r.created_at), updated_at: Number(r.updated_at), start_date: r.start_date ? Number(r.start_date) : null, due_date: r.due_date ? Number(r.due_date) : null, completed_at: r.completed_at ? Number(r.completed_at) : null };
  }
  const doc = readTasksFile(dataDir);
  return doc.tasks.find(t => t.id === id) || null;
}

async function createTask(dataDir, { title, description, assignedTo, assignedBy, priority = 'medium', dueDate, parentTaskId = null, initiatingUserId = null, expectedDeliverable = '', dependencies = [] }) {
  const ts = now();
  const id = generateTaskId();
  const assignedToObj = typeof assignedTo === 'object' ? assignedTo : { type: 'human', id: assignedTo };
  const assignedByObj = typeof assignedBy === 'object' ? assignedBy : { type: 'human', id: assignedBy };

  const task = {
    id,
    task_code: id,
    title: title || 'Untitled',
    description: description || '',
    assigned_to_type: assignedToObj.type,
    assigned_to_id: assignedToObj.id,
    assigned_by_type: assignedByObj.type,
    assigned_by_id: assignedByObj.id,
    priority: priority || 'medium',
    status: 'todo',
    start_date: null,
    due_date: dueDate ? Date.parse(dueDate) : null,
    completed_at: null,
    // Phase 03.3 delegation metadata (§5)
    parent_task_id: parentTaskId || null,
    initiating_user_id: initiatingUserId || null,
    expected_deliverable: expectedDeliverable || '',
    dependencies: Array.isArray(dependencies) ? dependencies : [],
    created_at: ts,
    updated_at: ts,
  };

  // Log activity
  await addActivity(dataDir, { taskId: id, actorType: assignedByObj.type, actorId: assignedByObj.id, action: 'assigned', details: { assignedTo: assignedToObj.id } });

  if (pg.enabled()) {
    await pg.query(
      `INSERT INTO tasks (id, task_code, title, description, assigned_to_type, assigned_to_id,
        assigned_by_type, assigned_by_id, priority, status, start_date, due_date, completed_at,
        pending_reason, parent_task_id, initiating_user_id, expected_deliverable, dependencies,
        created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [task.id, task.task_code, task.title, task.description, task.assigned_to_type, task.assigned_to_id,
       task.assigned_by_type, task.assigned_by_id, task.priority, task.status, task.start_date, task.due_date,
       task.completed_at, task.pending_reason ?? null, task.parent_task_id, task.initiating_user_id,
       task.expected_deliverable, JSON.stringify(task.dependencies), task.created_at, task.updated_at]
    );
    return task;
  }

  const doc = readTasksFile(dataDir);
  doc.tasks.push(task);
  writeTasksFile(dataDir, doc);
  return task;
}

async function updateTask(dataDir, id, updates) {
  const nowTs = now();
  const updatesWithTs = { ...updates, updated_at: nowTs };

  if (pg.enabled()) {
    const fields = [];
    const params = [];
    let idx = 1;
    for (const [k, v] of Object.entries(updatesWithTs)) {
      if (k === 'id') continue;
      fields.push(`${k} = $${idx++}`);
      params.push(v);
    }
    params.push(id);

    const result = await pg.query(`UPDATE tasks SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`, [...params, id]);
    if (!result.rows.length) return null;
    const r = result.rows[0];
    return { ...r, created_at: Number(r.created_at), updated_at: Number(r.updated_at), start_date: r.start_date ? Number(r.start_date) : null, due_date: r.due_date ? Number(r.due_date) : null, completed_at: r.completed_at ? Number(r.completed_at) : null };
  }

  const doc = readTasksFile(dataDir);
  const idx = doc.tasks.findIndex(t => t.id === id);
  if (idx === -1) return null;
  doc.tasks[idx] = { ...doc.tasks[idx], ...updatesWithTs };
  writeTasksFile(dataDir, doc);
  return doc.tasks[idx];
}

async function deleteTask(dataDir, id) {
  if (pg.enabled()) {
    const result = await pg.query('DELETE FROM tasks WHERE id = $1 RETURNING id', [id]);
    return result.rows.length > 0;
  }
  const doc = readTasksFile(dataDir);
  const idx = doc.tasks.findIndex(t => t.id === id);
  if (idx === -1) return false;
  doc.tasks.splice(idx, 1);
  writeTasksFile(dataDir, doc);
  return true;
}

// ---------- Activity & Comments ----------

async function addActivity(dataDir, { taskId, actorType, actorId, action, details }) {
  if (!pg.enabled()) {
    const activity = {
      id: crypto.randomUUID(),
      task_id: taskId,
      actor_type: actorType,
      actor_id: actorId,
      action,
      details,
      created_at: Date.now(),
    };
    const file = path.join(dataDir, 'tasks', 'activity.json');
    const acts = { activities: [] };
    try { acts.activities = JSON.parse(fs.readFileSync(file, 'utf8')).activities; } catch {}
    acts.activities.push(activity);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(acts, null, 2), 'utf8');
    return activity;
  }

  const activity = {
    id: crypto.randomUUID(),
    task_id: taskId,
    actor_type: actorType,
    actor_id: actorId,
    action,
    details: JSON.stringify(details || {}),
    created_at: Date.now(),
  };
  await pg.query(
    `INSERT INTO task_activity (id, task_id, actor_type, actor_id, action, details, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [activity.id, activity.task_id, activity.actor_type, activity.actor_id, activity.action, activity.details, activity.created_at]
  );
  return activity;
}

async function getTaskActivity(dataDir, taskId) {
  if (pg.enabled()) {
    const { rows } = await pg.query('SELECT * FROM task_activity WHERE task_id = $1 ORDER BY created_at ASC', [taskId]);
    return rows.map(r => ({ ...r, created_at: Number(r.created_at) }));
  }
  const file = path.join(dataDir, 'tasks', 'activity.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (data.activities || []).filter(a => a.task_id === taskId).sort((a, b) => a.created_at - b.created_at);
  } catch {
    return [];
  }
}

async function addComment(dataDir, { taskId, authorType, authorId, content }) {
  const comment = {
    id: crypto.randomUUID(),
    task_id: taskId,
    author_type: authorType,
    author_id: authorId,
    content,
    created_at: Date.now(),
  };

  if (pg.enabled()) {
    await pg.query(
      `INSERT INTO task_comments (id, task_id, author_type, author_id, content, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [comment.id, comment.task_id, comment.author_type, comment.author_id, comment.content, comment.created_at]
    );
    return comment;
  }

  const file = path.join(dataDir, 'tasks', 'comments.json');
  const data = { comments: [] };
  try { data.comments = JSON.parse(fs.readFileSync(file, 'utf8')).comments; } catch {}
  data.comments.push(comment);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  return comment;
}

async function getTaskComments(dataDir, taskId) {
  if (pg.enabled()) {
    const { rows } = await pg.query('SELECT * FROM task_comments WHERE task_id = $1 ORDER BY created_at ASC', [taskId]);
    return rows.map(r => ({ ...r, created_at: Number(r.created_at) }));
  }
  const file = path.join(dataDir, 'tasks', 'comments.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (data.comments || []).filter(c => c.task_id === taskId).sort((a, b) => a.created_at - b.created_at);
  } catch {
    return [];
  }
}

// ---------- Reports ----------

async function getMonthlyReport(dataDir, { employeeId, employeeType, year, month }) {
  const from = new Date(year, month, 1).getTime();
  const to = new Date(year, month + 1, 0).getTime() + 86399999;

  const tasks = await listTasks(dataDir, { limit: 10000 });
  const filtered = tasks.filter(t => Number(t.created_at) >= from && Number(t.created_at) <= to);

  if (employeeId) {
    filtered = filtered.filter(t => t.assigned_to_id === employeeId);
  }
  if (employeeType) {
    filtered = filtered.filter(t => t.assigned_to_type === employeeType);
  }

  const stats = {
    total: filtered.length,
    completed: filtered.filter(t => t.status === 'completed').length,
    pending: filtered.filter(t => t.status === 'pending').length,
    in_progress: filtered.filter(t => t.status === 'in_progress').length,
    overdue: filtered.filter(t => calcOverdue(t)).length,
    todo: filtered.filter(t => t.status === 'todo').length,
    under_review: filtered.filter(t => t.status === 'under_review').length,
    cancelled: filtered.filter(t => t.status === 'cancelled').length,
    by_priority: {
      low: filtered.filter(t => t.priority === 'low').length,
      medium: filtered.filter(t => t.priority === 'medium').length,
      high: filtered.filter(t => t.priority === 'high').length,
      urgent: filtered.filter(t => t.priority === 'urgent').length,
    },
    by_employee: {},
  };

  for (const t of filtered) {
    const key = t.assigned_to_type + ':' + t.assigned_to_id;
    if (!stats.by_employee[key]) stats.by_employee[key] = { total: 0, completed: 0, overdue: 0 };
    stats.by_employee[key].total++;
    if (t.status === 'completed') stats.by_employee[key].completed++;
    if (calcOverdue(t)) stats.by_employee[key].overdue++;
  }

  return { stats, period: { year, month, start: from, end: to } };
}

module.exports = {
  TASK_STATUS,
  TASK_PRIORITY,
  ASSIGNMENT_TYPES,
  PENDING_REASONS,
  generateTaskId,
  calcOverdue,
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  addActivity,
  getTaskActivity,
  addComment,
  getTaskComments,
  getMonthlyReport,
  ensureSchema,
};