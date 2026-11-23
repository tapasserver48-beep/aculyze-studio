/**
 * Automations engine (Phase 04.2).
 *
 * Every minute tick() looks at each active automation:
 *   schedule  daily at HH:MM on chosen weekdays, or every N hours in working hours
 *   overdue   open tasks past their due date (managers/admins only)
 *   email     new Gmail messages matching a filter (polled every 5 minutes)
 * and the 'lead.created' event fires "new website lead" automations.
 *
 * Firing = create a task for the AI employee (instruction + trigger details),
 * then start the normal agent run in the background. The run uses the
 * automation OWNER's connected apps, and external writes wait for the owner's
 * approval, exactly like Run with AI.
 */

const store = require('./store');
const { bus } = require('./events');
const runs = require('../execution/runs');
const { executeTask } = require('../execution/agentRuntime');
const { createTask, listTasks, addActivity } = require('../tasks/store');
const { findById: findEmployee } = require('../employees/store');
const authStore = require('../auth/store');
const { localParts } = require('../executive/service');

const MANAGER_ROLES = ['founder', 'admin', 'manager'];
const EMAIL_POLL_MS = 5 * 60 * 1000;
const MAX_FIRES_PER_TICK = 3;   // per automation, so a backlog trickles in
const LATE_WINDOW_MIN = 120;    // a schedule slot missed by more than this is skipped
const OPEN = ['todo', 'in_progress', 'pending', 'under_review'];

/* ---------------- configuration (tests inject fakes) ---------------- */

const config = { manager: null, provider: null, dataDir: null };
function configure(opts = {}) { Object.assign(config, opts); }

function getManager(dataDir) {
  if (!config.manager) {
    const { IntegrationManager } = require('../integrations/manager');
    config.manager = new IntegrationManager({ dataDir, env: process.env });
  }
  return config.manager;
}

/* ---------------- helpers ---------------- */

const toMin = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));
const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function startOfToday(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function runsToday(dataDir, automationId, now) {
  return store.listHistory(dataDir, { automationId, since: startOfToday(now), limit: 1000 })
    .filter((h) => h.status === 'started').length;
}

function triggerSummary(t) {
  if (!t) return '';
  if (t.type === 'schedule') {
    return t.mode === 'interval' ? `every ${t.everyHours}h between ${t.from} and ${t.to}` : `daily at ${t.time}`;
  }
  if (t.type === 'email') {
    return `new email${t.from ? ` from ${t.from}` : ''}${t.subject ? ` with subject "${t.subject}"` : ''}${t.words ? ` containing "${t.words}"` : ''}`;
  }
  if (t.type === 'lead') return 'new website lead';
  return 'task overdue';
}

/* ---------------- firing ---------------- */

/**
 * Create the task and start the run. Returns { taskId, executionId } or
 * { skipped: reason }. `key` is recorded so the same thing never fires twice.
 */
async function fire(dataDir, automation, { key, title, context, now = Date.now(), test = false }) {
  const a = store.get(dataDir, automation.id) || automation;
  const skip = (reason) => {
    store.addHistory(dataDir, { automationId: a.id, key, status: 'skipped', reason, title, at: now });
    return { skipped: reason };
  };
  if (!a.active && !test) return { skipped: 'paused' };
  if (key && store.hasSeen(dataDir, a.id, key)) return { skipped: 'already handled' };
  if (key) store.markSeen(dataDir, a.id, key);
  if (runsToday(dataDir, a.id, now) >= a.maxRunsPerDay) return skip(`daily limit of ${a.maxRunsPerDay} runs reached`);

  const owner = await authStore.findById(dataDir, a.ownerId);
  if (!owner) return skip('the owner no longer exists');
  if (store.MANAGER_ONLY_TRIGGERS.includes(a.trigger.type) && !MANAGER_ROLES.includes(owner.role)) {
    return skip('only managers and admins can run this trigger');
  }
  const employee = await findEmployee(dataDir, a.employeeId);
  if (!employee || employee.status !== 'active') return skip('the AI employee is not active');

  const description = [
    a.instruction,
    '',
    '---',
    `Started automatically by the automation "${a.name}" (${test ? 'test run' : triggerSummary(a.trigger)}).`,
    context ? `\nDETAILS:\n${context}` : '',
  ].join('\n').slice(0, 8000);

  const task = await createTask(dataDir, {
    title: `${a.name}: ${title}`.slice(0, 160),
    description,
    assignedTo: { type: 'ai', id: employee.id },
    assignedBy: { type: 'human', id: owner.id },
    priority: 'medium',
    initiatingUserId: owner.id,
  });
  await addActivity(dataDir, { taskId: task.id, actorType: 'human', actorId: owner.id, action: 'create', details: { source: 'automation', automationId: a.id } });

  const hist = store.addHistory(dataDir, { automationId: a.id, key, status: 'started', title, taskId: task.id, test, at: now });
  const run = runs.start({ taskId: task.id, employeeId: employee.id, userId: owner.id, kind: 'automation' }, (r) => executeTask(dataDir, {
    employeeId: employee.id,
    taskId: task.id,
    initiatingUserId: owner.id,
    manager: getManager(dataDir),
    provider: config.provider || undefined,
    executionId: r.id,
    steps: r.steps,
    onPhase: (p) => { r.phase = p; },
  }).then((out) => {
    store.updateHistory(dataDir, hist.id, { outcome: out.outcome, finishedAt: Date.now() });
    return out;
  }, (err) => {
    store.updateHistory(dataDir, hist.id, { outcome: 'failed', error: String(err.message || err).slice(0, 300), finishedAt: Date.now() });
    throw err;
  }));
  store.updateHistory(dataDir, hist.id, { executionId: run.id });
  store.patch(dataDir, a.id, { lastRunAt: now, lastError: null });
  return { taskId: task.id, executionId: run.id, historyId: hist.id };
}

/* ---------------- triggers ---------------- */

async function checkSchedule(dataDir, a, now) {
  const t = a.trigger;
  const { date, hm, weekday } = localParts(now);
  if (!t.days.includes(weekday)) return [];
  const nowMin = toMin(hm);
  let slot = null;
  if (t.mode === 'daily') {
    slot = t.time;
  } else {
    for (let m = toMin(t.from); m < toMin(t.to); m += t.everyHours * 60) if (m <= nowMin) slot = fromMin(m);
  }
  if (!slot || nowMin < toMin(slot) || nowMin - toMin(slot) > LATE_WINDOW_MIN) return [];
  const key = `slot:${date} ${slot}`;
  if (store.hasSeen(dataDir, a.id, key)) return [];
  return [await fire(dataDir, a, { key, title: `${date} ${slot}`, context: `Scheduled run for ${date} at ${slot}.`, now })];
}

async function checkOverdue(dataDir, a, now) {
  const tasks = await listTasks(dataDir, { limit: 10000 });
  const due = tasks.filter((t) => OPEN.includes(t.status) && t.due_date && Number(t.due_date) < now
    && (a.trigger.assignee === 'any' || t.assigned_to_type === a.trigger.assignee)
    && !(t.assigned_to_type === 'ai' && t.assigned_to_id === a.employeeId)
    && !store.hasSeen(dataDir, a.id, `task:${t.id}`))
    .sort((x, y) => Number(x.due_date) - Number(y.due_date))
    .slice(0, MAX_FIRES_PER_TICK);
  if (!due.length) return [];
  const users = new Map(((await authStore.listUsers(dataDir)) || []).map((u) => [u.id, u]));
  const out = [];
  for (const t of due) {
    const assignee = users.get(t.assigned_to_id);
    const lead = assignee && assignee.managerId ? users.get(assignee.managerId) : null;
    const days = Math.max(1, Math.round((now - Number(t.due_date)) / 86400000));
    const context = [
      `Overdue task: "${t.title}" (${t.task_code || t.id})`,
      `Status: ${t.status}${t.pending_reason ? ` (${t.pending_reason})` : ''}, due ${new Date(Number(t.due_date)).toISOString().slice(0, 10)} (${days} day${days === 1 ? '' : 's'} late)`,
      `Assigned to: ${assignee ? `${assignee.name} <${assignee.email}>` : t.assigned_to_id} (${t.assigned_to_type})`,
      lead ? `Reports to: ${lead.name} <${lead.email}>` : 'Reports to: nobody set',
      t.description ? `Task details: ${String(t.description).slice(0, 600)}` : '',
    ].filter(Boolean).join('\n');
    out.push(await fire(dataDir, a, { key: `task:${t.id}`, title: `overdue "${t.title}"`.slice(0, 100), context, now }));
  }
  return out;
}

function emailQuery(t) {
  return [
    t.from ? `from:${t.from}` : '',
    t.subject ? `subject:(${t.subject})` : '',
    t.words || '',
    'newer_than:2d', '-category:promotions', '-category:social',
  ].filter(Boolean).join(' ');
}

async function checkEmail(dataDir, a, now, { force = false } = {}) {
  if (!force && a.lastCheckedAt && now - a.lastCheckedAt < EMAIL_POLL_MS) return [];
  store.patch(dataDir, a.id, { lastCheckedAt: now });
  let res;
  try {
    res = await getManager(dataDir).runTool(a.ownerId, 'gmail.search', { q: emailQuery(a.trigger), max: 8 });
  } catch (err) {
    const msg = err.code === 'not_connected' ? 'Gmail is not connected for the owner of this automation. Connect it in Apps.' : String(err.message || err).slice(0, 200);
    store.patch(dataDir, a.id, { lastError: msg });
    return [];
  }
  const msgs = (res && res.messages) || [];
  if (!a.baselined) {
    // First check after switching on: everything already in the inbox is "old".
    if (msgs.length) store.markSeen(dataDir, a.id, msgs.map((m) => `email:${m.id}`));
    store.patch(dataDir, a.id, { baselined: true, lastError: null });
    return [];
  }
  const fresh = msgs.filter((m) => !store.hasSeen(dataDir, a.id, `email:${m.id}`)).reverse().slice(0, MAX_FIRES_PER_TICK);
  const out = [];
  for (const m of fresh) {
    const context = `New email\nFrom: ${m.from}\nSubject: ${m.subject}\nDate: ${m.date}\nPreview: ${m.snippet}\nGmail message id: ${m.id} (open it with gmail.get_message for the full text)`;
    out.push(await fire(dataDir, a, { key: `email:${m.id}`, title: `email "${m.subject}"`.slice(0, 100), context, now }));
  }
  if (!out.length) store.patch(dataDir, a.id, { lastError: null });
  return out;
}

async function onLead(dataDir, lead, now = Date.now()) {
  const out = [];
  for (const a of store.list(dataDir)) {
    if (!a.active || a.trigger.type !== 'lead') continue;
    if (a.trigger.chatbotId && a.trigger.chatbotId !== lead.chatbot_id) continue;
    const context = [
      'New lead from the website chatbot',
      `Name: ${lead.name || 'not given'}`,
      `Email: ${lead.email || 'not given'}`,
      `Phone: ${lead.phone || 'not given'}`,
      `Company: ${lead.company || 'not given'}`,
      `Chatbot: ${lead.chatbot_id}`,
      `Captured: ${new Date(lead.created_at || now).toISOString()}`,
    ].join('\n');
    out.push(await fire(dataDir, a, { key: `lead:${lead.id}`, title: `lead ${lead.name || lead.email || lead.id}`.slice(0, 100), context, now }));
  }
  return out;
}

/** One pass over every active automation. Returns what fired (for tests/logs). */
async function tick(dataDir, now = Date.now()) {
  const done = [];
  for (const a of store.list(dataDir)) {
    if (!a.active) continue;
    try {
      let out = [];
      if (a.trigger.type === 'schedule') out = await checkSchedule(dataDir, a, now);
      else if (a.trigger.type === 'overdue') out = await checkOverdue(dataDir, a, now);
      else if (a.trigger.type === 'email') out = await checkEmail(dataDir, a, now);
      for (const r of out) done.push({ id: a.id, ...r });
    } catch (err) {
      store.patch(dataDir, a.id, { lastError: String(err.message || err).slice(0, 200) });
    }
  }
  return done;
}

/** "Test now": fire once immediately with sample details. */
async function testNow(dataDir, a) {
  const samples = {
    schedule: 'This is a test run of a scheduled automation.',
    email: 'Test run. In a real run this section holds the new email\'s sender, subject and preview.',
    lead: 'Test run. Sample lead:\nName: Test Lead\nEmail: lead@example.com\nPhone: +91 90000 00000\nCompany: Example Pvt Ltd',
    overdue: 'Test run. In a real run this section names the overdue task, its assignee and who they report to.',
  };
  return fire(dataDir, a, { key: `test:${Date.now()}`, title: 'test run', context: samples[a.trigger.type], test: true });
}

let timer = null;
let leadListener = null;
function startScheduler(dataDir, { intervalMs = 60000 } = {}) {
  config.dataDir = dataDir;
  if (!leadListener) {
    leadListener = ({ dataDir: dir, lead }) => onLead(dir || dataDir, lead).catch((err) => console.warn(`[automations] lead trigger failed: ${err.message}`));
    bus.on('lead.created', leadListener);
  }
  if (timer) return;
  const run = () => tick(dataDir).catch((err) => console.warn(`[automations] tick failed: ${err.message}`));
  timer = setInterval(run, intervalMs);
  if (timer.unref) timer.unref();
}

module.exports = {
  configure, fire, tick, testNow, onLead, startScheduler,
  checkSchedule, checkOverdue, checkEmail, emailQuery, triggerSummary,
};
