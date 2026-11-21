/**
 * Chief of Staff — staff monitoring and follow-ups.
 *
 * Adds a company-wide view on top of the per-plan monitoring in index.js:
 *   - workload and health for every employee (AI and human) the viewer has
 *     authority over,
 *   - an attention list of overdue, stalled and blocked tasks with a
 *     suggested follow-up,
 *   - applying follow-ups — but only the ones a human picked (nothing here
 *     acts on its own, matching the approval rule in index.js).
 *
 * Deterministic: no model call, so it is cheap to poll and easy to test.
 * Reads and writes only through the existing task store.
 */

const { listTasks, getTask, updateTask, addActivity, addComment } = require('../tasks/store');
const { getChiefId, buildRegistry, checkDelegationAuthority } = require('./index');

const DAY_MS = 86400000;
const OPEN_STATUSES = ['todo', 'in_progress', 'pending', 'under_review'];
/** An open task with no update for this long is "stalled". */
const STALL_MS = 3 * DAY_MS;
/** At or above this many open tasks an employee is "busy". */
const BUSY_THRESHOLD = 5;
const MAX_FOLLOWUPS = 50;

function isOpen(t) { return OPEN_STATUSES.includes(t.status); }
function isOverdue(t, now) { return isOpen(t) && t.due_date && Number(t.due_date) < now; }
function isStalled(t, now) {
  const last = Number(t.updated_at || t.created_at || 0);
  return isOpen(t) && t.status !== 'pending' && last > 0 && now - last > STALL_MS;
}

/** Open-task counts per assignee id, for workload-aware planning. */
async function workloadById(dataDir) {
  const tasks = await listTasks(dataDir, { limit: 10000 });
  const load = {};
  for (const t of tasks) {
    if (isOpen(t)) load[t.assigned_to_id] = (load[t.assigned_to_id] || 0) + 1;
  }
  return load;
}

/**
 * at_risk  — something is late or blocked: needs a decision.
 * check_in — work has gone quiet: a nudge is enough.
 */
function employeeHealth({ open, overdue, stalled, blocked }) {
  if (overdue || blocked) return 'at_risk';
  if (stalled) return 'check_in';
  if (open === 0) return 'idle';
  if (open >= BUSY_THRESHOLD) return 'busy';
  return 'on_track';
}

/** Least-loaded colleague of the same kind (AI/human), excluding `exceptId`. */
function suggestAssignee(staff, kind, exceptId) {
  const pool = staff
    .filter(s => s.kind === kind && s.id !== exceptId && s.health !== 'at_risk')
    .sort((a, b) => a.open - b.open);
  return pool[0] && pool[0].open < BUSY_THRESHOLD ? { id: pool[0].id, name: pool[0].name } : null;
}

async function resolveScope(dataDir, userId) {
  const authority = await checkDelegationAuthority(dataDir, userId);
  if (!authority.ok) {
    const err = new Error(authority.reason);
    err.status = authority.status;
    err.code = 'not_authorized';
    throw err;
  }
  const chiefId = await getChiefId(dataDir);
  const registry = await buildRegistry(dataDir, chiefId, authority.role);
  return { chiefId, registry };
}

/**
 * Staff overview for the viewer: one row per employee in their authority,
 * plus the tasks that need attention.
 */
async function getStaffOverview({ dataDir, userId, now = Date.now() }) {
  const { registry } = await resolveScope(dataDir, userId);
  const tasks = await listTasks(dataDir, { limit: 10000 });
  const byAssignee = new Map();
  for (const t of tasks) {
    if (!byAssignee.has(t.assigned_to_id)) byAssignee.set(t.assigned_to_id, []);
    byAssignee.get(t.assigned_to_id).push(t);
  }

  const since30 = now - 30 * DAY_MS;
  const staff = registry.candidates.map((c) => {
    const mine = byAssignee.get(c.id) || [];
    const done = mine.filter(t => t.status === 'completed');
    const done30 = done.filter(t => Number(t.completed_at || t.updated_at) >= since30);
    const onTime = done30.filter(t => !t.due_date || Number(t.completed_at || t.updated_at) <= Number(t.due_date));
    const row = {
      id: c.id,
      name: c.name,
      role: c.role,
      kind: c.kind,
      open: mine.filter(isOpen).length,
      in_progress: mine.filter(t => t.status === 'in_progress').length,
      blocked: mine.filter(t => t.status === 'pending').length,
      overdue: mine.filter(t => isOverdue(t, now)).length,
      stalled: mine.filter(t => isStalled(t, now)).length,
      completed_30d: done30.length,
      on_time_rate: done30.length ? Math.round((onTime.length / done30.length) * 100) : null,
      last_activity: mine.reduce((m, t) => Math.max(m, Number(t.updated_at || 0)), 0) || null,
      // Each open task counted once, late first — matches the UI workload bar.
      load: mine.filter(isOpen).reduce((acc, t) => {
        const k = isOverdue(t, now) ? 'late' : t.status === 'pending' ? 'blocked'
          : t.status === 'under_review' ? 'review' : t.status;
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, { late: 0, blocked: 0, in_progress: 0, review: 0, todo: 0 }),
    };
    row.health = employeeHealth(row);
    return row;
  });

  const staffById = new Map(staff.map(s => [s.id, s]));
  const attention = [];
  for (const t of tasks) {
    const who = staffById.get(t.assigned_to_id);
    if (!who || !isOpen(t)) continue;
    const reasons = [];
    if (isOverdue(t, now)) reasons.push('overdue');
    if (t.status === 'pending') reasons.push('blocked');
    if (isStalled(t, now)) reasons.push('stalled');
    if (!reasons.length) continue;

    const lateDays = t.due_date ? Math.floor((now - Number(t.due_date)) / DAY_MS) : 0;
    const replacement = suggestAssignee(staff, who.kind, who.id);
    // Reassign only when the work is badly stuck and someone has room;
    // otherwise a nudge to the current assignee is the right first step.
    const reassign = replacement && (t.status === 'pending' || lateDays >= 3);
    attention.push({
      task_id: t.id,
      title: t.title,
      priority: t.priority,
      status: t.status,
      pending_reason: t.pending_reason || null,
      due_date: t.due_date ? Number(t.due_date) : null,
      last_update: Number(t.updated_at || t.created_at || 0) || null,
      assignee: { id: who.id, name: who.name, kind: who.kind },
      reasons,
      suggestion: reassign
        ? { type: 'reassign', assignee: replacement }
        : { type: 'nudge' },
    });
  }
  const rank = { urgent: 0, high: 1, medium: 2, low: 3 };
  attention.sort((a, b) =>
    (b.reasons.includes('overdue') - a.reasons.includes('overdue'))
    || ((rank[a.priority] ?? 9) - (rank[b.priority] ?? 9))
    || ((a.due_date || Infinity) - (b.due_date || Infinity)));

  const totals = {
    employees: staff.length,
    open: staff.reduce((n, s) => n + s.open, 0),
    overdue: staff.reduce((n, s) => n + s.overdue, 0),
    blocked: staff.reduce((n, s) => n + s.blocked, 0),
    stalled: staff.reduce((n, s) => n + s.stalled, 0),
    at_risk: staff.filter(s => s.health === 'at_risk').length,
    check_in: staff.filter(s => s.health === 'check_in').length,
    idle: staff.filter(s => s.health === 'idle').length,
  };

  return { generated_at: now, thresholds: { stall_days: STALL_MS / DAY_MS, busy_open_tasks: BUSY_THRESHOLD }, totals, staff, attention };
}

function nudgeText(task, reasons) {
  const why = reasons.includes('overdue') ? 'is past its due date'
    : reasons.includes('blocked') ? `is blocked (${task.pending_reason || 'no reason given'})`
    : 'has had no update for a few days';
  return `Chief of Staff follow-up: "${task.title}" ${why}. Please post an update, `
    + 'the expected completion date, and anything you need to unblock it.';
}

/**
 * Apply follow-ups a human selected. Each action is re-validated against the
 * viewer's authority — the browser's choice of task or assignee is not trusted.
 * actions: [{ taskId, type: 'nudge' | 'reassign', assigneeId? }]
 */
async function applyFollowups({ dataDir, userId, actions, now = Date.now() }) {
  if (!Array.isArray(actions) || !actions.length) {
    const err = new Error('Choose at least one follow-up.');
    err.status = 400;
    throw err;
  }
  const { chiefId, registry } = await resolveScope(dataDir, userId);
  const roster = new Map(registry.candidates.map(c => [c.id, c]));
  const results = [];

  for (const a of actions.slice(0, MAX_FOLLOWUPS)) {
    const taskId = String(a?.taskId || '');
    const fail = (error) => results.push({ taskId, ok: false, error });
    const task = taskId ? await getTask(dataDir, taskId) : null;
    if (!task) { fail('Task not found'); continue; }
    if (!roster.has(task.assigned_to_id)) { fail('Task is outside your authority'); continue; }
    if (!isOpen(task)) { fail('Task is already closed'); continue; }

    const reasons = [];
    if (isOverdue(task, now)) reasons.push('overdue');
    if (task.status === 'pending') reasons.push('blocked');
    if (isStalled(task, now)) reasons.push('stalled');

    if (a.type === 'nudge') {
      await addComment(dataDir, { taskId, authorType: 'ai', authorId: chiefId, content: nudgeText(task, reasons) });
      await addActivity(dataDir, {
        taskId, actorType: 'human', actorId: userId, action: 'chief_followup_nudge',
        details: { reasons, via: 'chief_of_staff' },
      });
      results.push({ taskId, ok: true, type: 'nudge' });
    } else if (a.type === 'reassign') {
      const target = roster.get(String(a.assigneeId || ''));
      if (!target || target.id === chiefId) { fail('Choose a valid new assignee'); continue; }
      if (target.id === task.assigned_to_id) { fail('Task is already assigned to that person'); continue; }
      const from = { type: task.assigned_to_type, id: task.assigned_to_id };
      const updates = { assigned_to_type: target.kind, assigned_to_id: target.id };
      // A blocked task restarts for its new owner.
      if (task.status === 'pending') { updates.status = 'todo'; updates.pending_reason = null; }
      await updateTask(dataDir, taskId, updates);
      await addActivity(dataDir, {
        taskId, actorType: 'human', actorId: userId, action: 'chief_followup_reassign',
        details: { from, to: { type: target.kind, id: target.id }, reasons, via: 'chief_of_staff' },
      });
      await addComment(dataDir, {
        taskId, authorType: 'ai', authorId: chiefId,
        content: `Chief of Staff follow-up: reassigned to ${target.name} (${reasons.join(', ') || 'rebalancing'}).`,
      });
      results.push({ taskId, ok: true, type: 'reassign', assignee: { id: target.id, name: target.name } });
    } else {
      fail('Unknown follow-up type');
    }
  }
  return { results, applied: results.filter(r => r.ok).length };
}

module.exports = { getStaffOverview, applyFollowups, workloadById, STALL_MS, BUSY_THRESHOLD };
