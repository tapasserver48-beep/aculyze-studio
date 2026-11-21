/**
 * Chief of Staff — staff monitoring and follow-ups.
 * Deterministic (no model calls). Run: node test/chief-staff-monitor.test.js
 */

const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const authStore = require('../src/auth/store');
const employeesStore = require('../src/employees/store');
const tasksStore = require('../src/tasks/store');
const { attachAuth } = require('../src/auth/session');
const { createAuthRouter } = require('../src/auth/routes');
const { createChiefOfStaffRouter } = require('../src/chiefOfStaff/routes');
const chief = require('../src/chiefOfStaff/index');
const monitor = require('../src/chiefOfStaff/monitor');

const PW = 'StaffTest-12345!';
const DAY = 86400000;
let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures += 1;
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-staff-'));

  const founder = await authStore.createUser(dataDir, { name: 'Founder', email: 'founder@staff.test', password: PW, role: 'founder' });
  const employee = await authStore.createUser(dataDir, { name: 'Employee', email: 'employee@staff.test', password: PW, role: 'employee' });
  await employeesStore.initializeEmployee(dataDir, 'AI-CHIEF-001');
  await employeesStore.initializeEmployee(dataDir, 'AI-EXEC-001');
  await employeesStore.initializeEmployee(dataDir, 'AI-CUSTOMER-001');
  const chiefId = await chief.getChiefId(dataDir);
  const execAi = await employeesStore.findByCode(dataDir, 'AI-EXEC-001');
  const custAi = await employeesStore.findByCode(dataDir, 'AI-CUSTOMER-001');

  const by = { type: 'human', id: founder.id };
  const overdue = await tasksStore.createTask(dataDir, {
    title: 'Overdue report', assignedTo: { type: 'ai', id: execAi.id }, assignedBy: by,
    priority: 'high', dueDate: new Date(Date.now() - 5 * DAY).toISOString(),
  });
  const blocked = await tasksStore.createTask(dataDir, {
    title: 'Blocked integration', assignedTo: { type: 'ai', id: execAi.id }, assignedBy: by,
  });
  await tasksStore.updateTask(dataDir, blocked.id, { status: 'pending', pending_reason: 'waiting_for_info' });
  const fresh = await tasksStore.createTask(dataDir, {
    title: 'Fresh task', assignedTo: { type: 'human', id: employee.id }, assignedBy: by,
    dueDate: new Date(Date.now() + 5 * DAY).toISOString(),
  });

  /* ---- overview ---- */
  const ov = await monitor.getStaffOverview({ dataDir, userId: founder.id });
  const execRow = ov.staff.find(s => s.id === execAi.id);
  const custRow = ov.staff.find(s => s.id === custAi.id);
  check('1 chief is not listed as staff', !ov.staff.some(s => s.id === chiefId));
  check('2 exec AI counts open/overdue/blocked', execRow && execRow.open === 2 && execRow.overdue === 1 && execRow.blocked === 1,
    JSON.stringify(execRow && { open: execRow.open, overdue: execRow.overdue, blocked: execRow.blocked }));
  check('3 exec AI is at risk', execRow && execRow.health === 'at_risk');
  check('4 customer AI with no work is idle', custRow && custRow.health === 'idle');
  check('5 attention lists overdue + blocked, not the fresh task',
    ov.attention.length === 2 && !ov.attention.some(a => a.task_id === fresh.id));
  check('6 overdue sorted first', ov.attention[0].task_id === overdue.id);
  const blockedItem = ov.attention.find(a => a.task_id === blocked.id);
  check('7 blocked task suggests reassign to idle AI colleague',
    blockedItem && blockedItem.suggestion.type === 'reassign' && blockedItem.suggestion.assignee.id === custAi.id);

  // Stalled: same data viewed 4 days later — the fresh task has gone quiet.
  const later = await monitor.getStaffOverview({ dataDir, userId: founder.id, now: Date.now() + 4 * DAY });
  check('8 untouched task becomes stalled', later.attention.some(a => a.task_id === fresh.id && a.reasons.includes('stalled')));
  const empLater = later.staff.find(s => s.id === employee.id);
  check('8b stalled-only employee needs a check-in, not "at risk"', empLater && empLater.health === 'check_in');

  /* ---- workload-aware prompt ---- */
  const reg = await chief.buildRegistry(dataDir, chiefId, 'founder');
  const prompt = chief.buildPrompt({ title: 'x' }, reg);
  check('9 prompt carries open task counts', prompt.includes('open tasks: 2'));

  /* ---- HTTP: authority + follow-ups ---- */
  const app = express();
  app.use(express.json());
  app.use(attachAuth(dataDir));
  app.use('/api/auth', createAuthRouter({ dataDir }));
  app.use('/api/chief', createChiefOfStaffRouter({ dataDir }));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  async function api(method, url, body) {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const pair = c.split(';')[0];
      if (pair.startsWith('zara_session=')) cookie = pair;
    }
    let data = null; try { data = await res.json(); } catch { /* */ }
    return { status: res.status, data };
  }
  const login = (email) => api('POST', '/api/auth/login', { email, password: PW });

  try {
    check('10 anonymous gets 401', (await api('GET', '/api/chief/staff')).status === 401);
    await login('employee@staff.test');
    check('11 employee role gets 403', (await api('GET', '/api/chief/staff')).status === 403);
    cookie = '';
    await login('founder@staff.test');
    const r = await api('GET', '/api/chief/staff');
    check('12 founder sees overview', r.status === 200 && r.data.totals.overdue === 1);

    const apply = await api('POST', '/api/chief/staff/followups', {
      actions: [
        { taskId: overdue.id, type: 'nudge' },
        { taskId: blocked.id, type: 'reassign', assigneeId: custAi.id },
        { taskId: fresh.id, type: 'reassign', assigneeId: chiefId },
        { taskId: 'task-nope', type: 'nudge' },
      ],
    });
    check('13 two follow-ups applied, two refused', apply.status === 200 && apply.data.applied === 2,
      JSON.stringify(apply.data && apply.data.results.map(x => x.ok)));

    const moved = await tasksStore.getTask(dataDir, blocked.id);
    check('14 reassigned task moved and reset to todo',
      moved.assigned_to_id === custAi.id && moved.assigned_to_type === 'ai' && moved.status === 'todo');
    const comments = await tasksStore.getTaskComments(dataDir, overdue.id);
    check('15 nudge left a Chief of Staff comment',
      comments.some(c => c.author_id === chiefId && /follow-up/.test(c.content)));
    const stillFresh = await tasksStore.getTask(dataDir, fresh.id);
    check('16 cannot reassign work to the Chief itself', stillFresh.assigned_to_id === employee.id);
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(failures ? `\nRESULT: ${failures} FAILED` : '\nRESULT: OK — staff monitor tests passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
void assert;
