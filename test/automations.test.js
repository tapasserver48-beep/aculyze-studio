/**
 * Phase 04.2 — Automations (schedule, overdue, new email, new website lead),
 * guardrails, and the new people tools (notify / create follow-up).
 * Run with: node test/automations.test.js
 */

const assert = require('assert');
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

delete process.env.DATABASE_URL;
process.env.APP_TIMEZONE = 'UTC';

const authStore = require('../src/auth/store');
const employeesStore = require('../src/employees/store');
const tasksStore = require('../src/tasks/store');
const inbox = require('../src/inbox/store');
const runs = require('../src/execution/runs');
const store = require('../src/automations/store');
const service = require('../src/automations/service');
const leads = require('../src/customerExecutive/leads');
const { createAutomationsRouter } = require('../src/automations/routes');
const { attachAuth } = require('../src/auth/session');
const { createAuthRouter } = require('../src/auth/routes');

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`PASS ${name}`);
  else { failures += 1; console.log(`FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

// Monday 2026-11-23, UTC
const at = (hm, day = 23) => Date.UTC(2026, 10, day, Number(hm.slice(0, 2)), Number(hm.slice(3)));

/* ---------- fakes ---------- */
const call = (name, args = {}) => ({ id: `c-${name}-${Math.random().toString(36).slice(2, 6)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const script = [];
const seenPrompts = [];
const provider = {
  name: 'fake',
  async sendMessage({ messages, tools }) {
    seenPrompts.push({ messages: JSON.parse(JSON.stringify(messages)), tools: (tools || []).map((t) => t.function.name) });
    const next = script.shift();
    const r = typeof next === 'function' ? next(messages, tools) : next;
    return r || { toolCalls: [call('task__submit_result', { summary: 'done', result: 'ok' })] };
  },
};
let inboxMessages = [];
let gmailConnected = true;
const gmailCalls = [];
const manager = {
  listApps: () => (gmailConnected ? [{ id: 'gmail', status: 'connected', granted: ['READ_EMAIL', 'CREATE_DRAFT', 'SEND_EMAIL'] }] : []),
  async runTool(uid, toolId, args) {
    gmailCalls.push({ uid, toolId, args });
    if (!gmailConnected) throw Object.assign(new Error('Gmail isn\'t connected.'), { code: 'not_connected' });
    return { count: inboxMessages.length, text: '', messages: inboxMessages.slice() };
  },
  async buildConfirmation() { return { confirm: { title: 'Send?' } }; },
  async execute() { return { summary: 'sent' }; },
};
service.configure({ manager, provider });

async function waitRun(id) {
  for (let i = 0; i < 200; i++) {
    const r = runs.get(id);
    if (r && r.status === 'done') return r;
    await new Promise((res) => setTimeout(res, 15));
  }
  throw new Error('run did not finish');
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automations-'));
  const PW = 'TestPass-12345!';
  const mgr = await authStore.createUser(dir, { name: 'Maya Manager', email: 'mgr@t.com', password: PW, role: 'manager' });
  const staff = await authStore.createUser(dir, { name: 'Anu', email: 'anu@t.com', password: PW, role: 'employee' });
  const staff2 = await authStore.createUser(dir, { name: 'Bala', email: 'bala@t.com', password: PW, role: 'employee' });
  await authStore.updateUser(dir, staff.id, { managerId: mgr.id });
  for (const c of ['AI-CHIEF-001', 'AI-EXEC-001', 'AI-CUSTOMER-001']) await employeesStore.initializeEmployee(dir, c);
  const emps = await employeesStore.listEmployees(dir);
  const chief = emps.find((e) => e.employee_code === 'AI-CHIEF-001');
  const exec = emps.find((e) => e.employee_code === 'AI-EXEC-001');
  const customer = emps.find((e) => e.employee_code === 'AI-CUSTOMER-001');

  try {
    console.log('\n=== 1. Validation ===');
    let threw = null;
    try { store.create(dir, { name: 'x', instruction: 'Summarize my emails please', employeeId: chief.id, trigger: { type: 'email' } }, staff.id); } catch (e) { threw = e; }
    check('email trigger without a filter is refused', threw && threw.status === 422);
    threw = null;
    try { store.create(dir, { name: 'x', instruction: 'short', employeeId: chief.id, trigger: { type: 'schedule' } }, staff.id); } catch (e) { threw = e; }
    check('instruction must be a real sentence', threw && threw.status === 422);

    console.log('\n=== 2. Schedule: daily at 09:00 ===');
    const daily = store.create(dir, { name: 'Morning briefing', instruction: 'Summarize my overnight emails and send me the top 3 actions.', employeeId: chief.id, trigger: { type: 'schedule', mode: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] } }, staff.id);
    let done = await service.tick(dir, at('08:59'));
    check('nothing before 09:00', done.length === 0);
    script.push((msgs) => {
      assert.ok(/Summarize my overnight emails/.test(msgs[1].content), 'instruction in task');
      assert.ok(/Started automatically by the automation "Morning briefing"/.test(msgs[1].content));
      return { toolCalls: [call('task__submit_result', { summary: 'Briefing ready', result: 'Top 3 actions…' })] };
    });
    done = await service.tick(dir, at('09:00'));
    check('fires at 09:00', done.length === 1 && done[0].taskId, JSON.stringify(done));
    const r1 = await waitRun(done[0].executionId);
    check('run completes as submitted', r1.outcome === 'submitted', r1.outcome);
    const t1 = await tasksStore.getTask(dir, done[0].taskId);
    check('task is for the AI employee, started by the owner', t1.assigned_to_id === chief.id && t1.initiating_user_id === staff.id && t1.assigned_by_id === staff.id);
    check('owner gets the result in the Inbox', (await inbox.listMessages(dir, `usr-${staff.id}`, chief.id, 0)).messages.some((m) => /Finished/.test(m.body)));
    done = await service.tick(dir, at('09:05'));
    check('fires once per slot', done.length === 0);
    done = await service.tick(dir, at('09:00', 22)); // Sunday
    check('not on days that are off', done.length === 0);
    const h = store.listHistory(dir, { automationId: daily.id });
    check('history records the run with its outcome', h[0] && h[0].taskId === t1.id && h[0].outcome === 'submitted', JSON.stringify(h[0]));

    const late = store.create(dir, { name: 'Late one', instruction: 'Do the scheduled thing for the team.', employeeId: chief.id, trigger: { type: 'schedule', mode: 'daily', time: '06:00', days: [1] } }, staff.id);
    done = await service.tick(dir, at('09:30'));
    check('a slot missed by more than 2 hours is skipped', !done.some((d) => d.id === late.id));
    store.update(dir, late.id, { active: false });

    const every = store.create(dir, { name: 'Every 3h', instruction: 'Check the shared inbox for anything urgent.', employeeId: chief.id, trigger: { type: 'schedule', mode: 'interval', everyHours: 3, from: '09:00', to: '18:00', days: [1] } }, staff.id);
    done = await service.tick(dir, at('12:10'));
    const everyFire = done.find((d) => d.id === every.id);
    check('interval fires the latest due slot (12:00)', everyFire && store.hasSeen(dir, every.id, 'slot:2026-11-23 12:00'));
    if (everyFire) await waitRun(everyFire.executionId);
    store.update(dir, every.id, { active: false });
    store.update(dir, daily.id, { active: false });

    console.log('\n=== 3. Guardrails ===');
    const limited = store.create(dir, { name: 'Limited', instruction: 'Do a small thing every time.', employeeId: chief.id, maxRunsPerDay: 1, trigger: { type: 'schedule', mode: 'interval', everyHours: 1, from: '09:00', to: '18:00', days: [1] } }, staff.id);
    let d1 = await service.tick(dir, at('13:00'));
    const lf = d1.find((d) => d.id === limited.id);
    if (lf && lf.executionId) await waitRun(lf.executionId);
    d1 = await service.tick(dir, at('14:00'));
    check('daily run limit stops further runs', d1.some((d) => d.id === limited.id && /daily limit/.test(d.skipped || '')), JSON.stringify(d1));
    check('skipped run is logged', store.listHistory(dir, { automationId: limited.id }).some((x) => x.status === 'skipped'));
    store.update(dir, limited.id, { active: false });
    d1 = await service.tick(dir, at('15:00'));
    check('paused automation never fires', !d1.some((d) => d.id === limited.id));

    console.log('\n=== 4. Task overdue (managers only) ===');
    const overdueTask = await tasksStore.createTask(dir, { title: 'Send the quote to Orbinox', assignedTo: { type: 'human', id: staff.id }, assignedBy: { type: 'human', id: mgr.id }, dueDate: at('09:00', 21) });
    const od = store.create(dir, { name: 'Chase overdue', instruction: 'Remind the person kindly and tell their manager.', employeeId: exec.id, trigger: { type: 'overdue', assignee: 'human' } }, mgr.id);
    script.push((msgs, tools) => {
      assert.ok(/Overdue task: "Send the quote to Orbinox"/.test(msgs[1].content), 'overdue context');
      assert.ok(/Reports to: Maya Manager/.test(msgs[1].content), 'reports-to in context');
      assert.ok(/PEOPLE IN THE COMPANY/.test(msgs[1].content), 'people list given');
      assert.ok(tools.some((t) => t.function.name === 'task__notify_person'), 'notify tool offered');
      return { toolCalls: [call('task__notify_person', { person: 'Anu', message: 'Your quote task is 2 days late. Can you send it today?' })] };
    });
    script.push({ toolCalls: [call('task__submit_result', { summary: 'Reminded Anu', result: 'Done' })] });
    done = await service.tick(dir, at('10:00'));
    const odFire = done.find((d) => d.id === od.id);
    check('overdue task fires the automation', !!odFire && !!odFire.taskId, JSON.stringify(done));
    if (odFire) await waitRun(odFire.executionId);
    const anuThread = (await inbox.listMessages(dir, `usr-${staff.id}`, exec.id, 0)).messages;
    check('the person got the Inbox nudge from the Executive Agent', anuThread.some((m) => /quote task is 2 days late/.test(m.body)));
    done = await service.tick(dir, at('10:30'));
    check('same overdue task fires only once', !done.some((d) => d.id === od.id));
    store.update(dir, od.id, { active: false });
    void overdueTask;

    console.log('\n=== 5. New email (Gmail, polled) ===');
    inboxMessages = [{ id: 'm-old', from: 'ceo@orbinox.com', subject: 'Old thread', date: 'Mon', snippet: 'old' }];
    const em = store.create(dir, { name: 'Client emails', instruction: 'Summarize the client email and draft a reply.', employeeId: chief.id, trigger: { type: 'email', from: 'orbinox.com' } }, staff.id);
    done = await service.tick(dir, at('11:00'));
    check('first check only records existing emails (no run)', !done.some((d) => d.id === em.id) && store.hasSeen(dir, em.id, 'email:m-old'));
    check('Gmail query uses the filter', /from:orbinox\.com/.test(gmailCalls[gmailCalls.length - 1].args.q) && /newer_than:2d/.test(gmailCalls[gmailCalls.length - 1].args.q));
    inboxMessages = [{ id: 'm-new', from: 'ceo@orbinox.com', subject: 'Invoice question', date: 'Mon', snippet: 'Can you resend the invoice?' }, ...inboxMessages];
    const callsBefore = gmailCalls.length;
    done = await service.tick(dir, at('11:02'));
    check('not polled again within 5 minutes', gmailCalls.length === callsBefore && !done.some((d) => d.id === em.id));
    script.push((msgs) => {
      assert.ok(/Subject: Invoice question/.test(msgs[1].content) && /Gmail message id: m-new/.test(msgs[1].content));
      return { toolCalls: [call('task__submit_result', { summary: 'Summarized', result: 'Customer wants the invoice resent.' })] };
    });
    done = await service.tick(dir, at('11:06'));
    const emFire = done.find((d) => d.id === em.id);
    check('a new matching email fires once', !!emFire && !!emFire.taskId, JSON.stringify(done));
    if (emFire) await waitRun(emFire.executionId);
    done = await service.tick(dir, at('11:12'));
    check('the same email does not fire again', !done.some((d) => d.id === em.id));
    gmailConnected = false;
    await service.tick(dir, at('11:20'));
    check('Gmail not connected → shown as the automation error', /Gmail is not connected/.test(store.get(dir, em.id).lastError || ''));
    gmailConnected = true;
    store.update(dir, em.id, { active: false });

    console.log('\n=== 6. New website lead (event) ===');
    service.startScheduler(dir, { intervalMs: 3600000 });
    const ld = store.create(dir, { name: 'Welcome leads', instruction: 'Create a follow-up task for Bala to call the lead within a day.', employeeId: customer.id, trigger: { type: 'lead' } }, mgr.id);
    script.push((msgs, tools) => {
      assert.ok(/Name: Ravi Kumar/.test(msgs[1].content) && /Phone: \+91 98765 43210/.test(msgs[1].content), 'lead context');
      assert.ok(tools.some((t) => t.function.name === 'task__create_followup'), 'follow-up tool offered');
      return { toolCalls: [call('task__create_followup', { person: 'bala@t.com', title: 'Call Ravi Kumar', details: 'New website lead', due_in_days: 1 })] };
    });
    script.push({ toolCalls: [call('task__submit_result', { summary: 'Follow-up created', result: 'Bala will call.' })] });
    const lead = await leads.createLead(dir, { chatbotId: 'bot-1', email: 'ravi@example.com', name: 'Ravi Kumar', phone: '+91 98765 43210', company: 'Acme', consent: true });
    let leadHist = null;
    for (let i = 0; i < 100 && !leadHist; i++) {
      await new Promise((res) => setTimeout(res, 20));
      leadHist = store.listHistory(dir, { automationId: ld.id }).find((x) => x.executionId);
    }
    check('a captured lead fires the automation', !!leadHist, 'no history');
    if (leadHist) await waitRun(leadHist.executionId);
    const followups = (await tasksStore.listTasks(dir, { limit: 1000 })).filter((t) => t.title === 'Call Ravi Kumar');
    check('the follow-up task was created for Bala', followups.length === 1 && followups[0].assigned_to_id === staff2.id && followups[0].due_date, JSON.stringify(followups[0]));
    check('Bala was told in the Inbox', (await inbox.listMessages(dir, `usr-${staff2.id}`, customer.id, 0)).messages.some((m) => /New task for you: \*\*Call Ravi Kumar\*\*/.test(m.body)));
    await service.onLead(dir, lead);
    check('the same lead never fires twice', store.listHistory(dir, { automationId: ld.id }).filter((x) => x.status === 'started').length === 1);

    console.log('\n=== 7. People tools resolve names safely ===');
    const extra = await authStore.createUser(dir, { name: 'Anu Sharma', email: 'anus@t.com', password: PW, role: 'employee' });
    void extra;
    const amb = store.create(dir, { name: 'Ambiguous', instruction: 'Message Anu about the report please.', employeeId: exec.id, trigger: { type: 'schedule', mode: 'daily', time: '16:00', days: [1] } }, mgr.id);
    script.push({ toolCalls: [call('task__notify_person', { person: 'anu', message: 'hi' })] });
    script.push((msgs) => {
      const toolMsg = msgs.filter((m) => m.role === 'tool').pop();
      assert.ok(/matches several people/.test(toolMsg.content), 'ambiguity explained to the model');
      return { toolCalls: [call('task__submit_result', { summary: 'needs clarity', result: 'Two Anus' })] };
    });
    done = await service.tick(dir, at('16:00'));
    const ambFire = done.find((d) => d.id === amb.id);
    if (ambFire) await waitRun(ambFire.executionId);
    check('an ambiguous name is not guessed', !!ambFire);
    store.update(dir, amb.id, { active: false });

    console.log('\n=== 8. HTTP: permissions, test now, history ===');
    const app = express();
    app.use(express.json());
    app.use(attachAuth(dir));
    app.use('/api/auth', createAuthRouter({ dataDir: dir }));
    app.use('/api/automations', createAutomationsRouter({ dataDir: dir }));
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    let cookie = '';
    const client = async (method, url, body) => {
      const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
      for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) { const p = c.split(';')[0]; if (p.startsWith('zara_session=')) cookie = p; }
      let data = null; try { data = await res.json(); } catch { /* none */ }
      return { status: res.status, data };
    };
    const login = async (email) => { cookie = ''; const r = await client('POST', '/api/auth/login', { email, password: PW }); if (r.status !== 200) throw new Error('login'); };
    try {
      await login(staff.email);
      let r = await client('POST', '/api/automations', { name: 'Lead thing', instruction: 'Do something with each lead.', employeeId: customer.id, trigger: { type: 'lead' } });
      check('employees cannot automate on leads', r.status === 403);
      r = await client('GET', '/api/automations');
      check('employee sees only their own automations', r.status === 200 && r.data.automations.every((a) => a.ownerId === staff.id) && r.data.automations.length >= 1);
      check('list shows a readable summary', r.data.automations.some((a) => a.summary === 'daily at 09:00'));
      r = await client('DELETE', `/api/automations/${od.id}`);
      check('cannot delete someone else\'s automation', r.status === 404);
      r = await client('POST', `/api/automations/${daily.id}/test`);
      check('test now fires even when paused', r.status === 202 && r.data.taskId, JSON.stringify(r.data));
      if (r.data && r.data.executionId) await waitRun(r.data.executionId);
      r = await client('GET', `/api/automations/${daily.id}/history`);
      check('history lists the test run', r.status === 200 && r.data.history.some((x) => x.test));
      r = await client('GET', '/api/automations/options');
      check('options list the AI employees', r.status === 200 && r.data.employees.length === 3 && r.data.canUseManagerTriggers === false);
      await login(mgr.email);
      r = await client('GET', '/api/automations');
      check('managers see everyone\'s automations', r.data.automations.some((a) => a.ownerId === staff.id) && r.data.automations.some((a) => a.ownerId === mgr.id));
      r = await client('PATCH', `/api/automations/${daily.id}`, { active: true });
      check('managers may pause/resume any automation', r.status === 200 && r.data.automation.active === true);
      r = await client('PATCH', `/api/automations/${daily.id}`, { name: 'Renamed' });
      check('…but not edit someone else\'s', r.status === 403);
    } finally {
      server.close();
    }
  } catch (err) {
    failures += 1;
    console.error('FAIL (exception)', err);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (failures) { console.log(`\nRESULT: ${failures} failed`); process.exit(1); }
  console.log('\nRESULT: OK - Automations tests passed');
  process.exit(0);
}

main();
