/**
 * Phase 04.2a — Executive Agent daily check-ins.
 * Run with: node test/executive.test.js
 */

const assert = require('assert');
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

delete process.env.DATABASE_URL;
process.env.APP_TIMEZONE = 'UTC'; // the fake clock below is in UTC

const authStore = require('../src/auth/store');
const employeesStore = require('../src/employees/store');
const inbox = require('../src/inbox/store');
const store = require('../src/executive/store');
const service = require('../src/executive/service');
const { createExecutiveRouter } = require('../src/executive/routes');
const { attachAuth } = require('../src/auth/session');
const { createAuthRouter } = require('../src/auth/routes');

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`PASS ${name}`);
  else { failures += 1; console.log(`FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

// Monday 2026-11-23 in UTC
const at = (hm) => Date.UTC(2026, 10, 23, Number(hm.slice(0, 2)), Number(hm.slice(3)));
const DATE = '2026-11-23';

async function thread(dir, userId, peerId) {
  const { messages } = await inbox.listMessages(dir, `usr-${userId}`, peerId, 0);
  return messages;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'executive-'));
  const PW = 'TestPass-12345!';
  const admin = await authStore.createUser(dir, { name: 'Admin', email: 'admin@t.com', password: PW, role: 'admin' });
  const mgr = await authStore.createUser(dir, { name: 'Maya Manager', email: 'mgr@t.com', password: PW, role: 'manager' });
  const tl = await authStore.createUser(dir, { name: 'Tom Lead', email: 'tl@t.com', password: PW, role: 'employee' });
  const e1 = await authStore.createUser(dir, { name: 'Anu', email: 'e1@t.com', password: PW, role: 'employee' });
  const e2 = await authStore.createUser(dir, { name: 'Bala', email: 'e2@t.com', password: PW, role: 'employee' });
  // "Reports to" is set the way the Admin page does it.
  await authStore.updateUser(dir, e1.id, { managerId: tl.id });
  await authStore.updateUser(dir, e2.id, { managerId: tl.id });
  await employeesStore.initializeEmployee(dir, 'AI-EXEC-001');
  const execAgent = await service.executiveAgent(dir);

  const app = express();
  app.use(express.json());
  app.use(attachAuth(dir));
  app.use('/api/auth', createAuthRouter({ dataDir: dir }));
  app.use('/api/executive', createExecutiveRouter({ dataDir: dir }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  async function client(method, url, body) {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const pair = c.split(';')[0];
      if (pair.startsWith('zara_session=')) cookie = pair;
    }
    let data = null;
    try { data = await res.json(); } catch { /* none */ }
    return { status: res.status, data };
  }
  async function login(email) { cookie = ''; const r = await client('POST', '/api/auth/login', { email, password: PW }); if (r.status !== 200) throw new Error('login'); }

  try {
    console.log('\n=== 1. Reading numbers from replies ===');
    const F = store.DEFAULT_FIELDS;
    const cases = [
      ['sales 5, calls 20', { sales: 5, calls: 20 }],
      ['Sales: 7 / Calls: 30', { sales: 7, calls: 30 }],
      ['5 sales and 20 calls', { sales: 5, calls: 20 }],
      ['Today I did 4 sales and made 25 calls', { sales: 4, calls: 25 }],
      ['no sales today, 12 calls', { sales: 0, calls: 12 }],
      ['1 sale, 9 calls', { sales: 1, calls: 9 }],
      ['calls 15', { calls: 15 }],
    ];
    for (const [text, want] of cases) {
      const got = service.parseValues(text, F);
      check(`parse "${text}"`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
    }

    console.log('\n=== 2. Managers create check-ins; employees cannot ===');
    await login(e1.email);
    let r = await client('GET', '/api/executive/checkins');
    check('employee → 403', r.status === 403);
    await login(mgr.email);
    r = await client('POST', '/api/executive/checkins', { title: 'Daily sales & calls', question: 'How many sales and calls did you do today?', fields: 'Sales, Calls', askTime: '15:00', deadlineTime: '14:00' });
    check('deadline before ask time → 422', r.status === 422);
    r = await client('POST', '/api/executive/checkins', { title: 'Daily sales & calls', question: 'How many sales and calls did you do today?', fields: 'Sales, Calls', askTime: '15:00', deadlineTime: '16:00' });
    check('create → 201', r.status === 201 && r.data.checkin.fields.length === 2, JSON.stringify(r.data));
    const chk = r.data.checkin;

    console.log('\n=== 3. 15:00 — the agent asks every employee ===');
    let done = await service.tick(dir, at('14:59'));
    check('nothing before ask time', done.length === 0);
    done = await service.tick(dir, at('15:00'));
    check('asked 3 employees (not managers/admins)', done[0] && done[0].asked === 3, JSON.stringify(done));
    check('employee got the question', (await thread(dir, e1.id, execAgent.id)).some((m) => /Daily sales & calls/.test(m.body)));
    check('manager was not asked', (await thread(dir, mgr.id, execAgent.id)).length === 0);
    done = await service.tick(dir, at('15:05'));
    check('asks only once a day', done.length === 0);

    console.log('\n=== 4. Answers arrive as chat ===');
    let handled = await service.handleReply(dir, { employeeId: execAgent.id, userId: e1.id, text: 'hi, how are you?', now: at('15:10') });
    check('small talk is not treated as an answer', handled === false);
    handled = await service.handleReply(dir, { employeeId: execAgent.id, userId: e1.id, text: 'sales 3', now: at('15:10') });
    check('partial answer handled', handled === true);
    check('agent asks for the missing number', (await thread(dir, e1.id, execAgent.id)).some((m) => /What about \*\*Calls\*\*/.test(m.body)));
    await service.handleReply(dir, { employeeId: execAgent.id, userId: e1.id, text: '12 calls', now: at('15:11') });
    check('agent confirms the full answer', (await thread(dir, e1.id, execAgent.id)).some((m) => /recorded: Sales: \*\*3\*\*, Calls: \*\*12\*\*/.test(m.body)));
    await service.handleReply(dir, { employeeId: execAgent.id, userId: tl.id, text: 'Sales 2, calls 8', now: at('15:20') });
    await service.handleReply(dir, { employeeId: execAgent.id, userId: e1.id, text: 'sorry, sales 4 calls 12', now: at('15:30') });
    check('correction updates the answer', (await thread(dir, e1.id, execAgent.id)).some((m) => /Updated: Sales: \*\*4\*\*/.test(m.body)));

    r = await client('GET', `/api/executive/checkins/${chk.id}/report?date=${DATE}`);
    const rep = r.data.report;
    check('report: 2 of 3 submitted, totals summed', rep.submitted === 2 && rep.total === 3 && rep.totals.sales === 6 && rep.totals.calls === 20, JSON.stringify(rep.totals));
    check('report lists Bala as missing', rep.missing.length === 1 && rep.missing[0].name === 'Bala');

    console.log('\n=== 5. 16:00 — deadline: reminders, TL and managers told ===');
    done = await service.tick(dir, at('16:00'));
    check('deadline step ran', done.some((d) => d.action === 'escalate' && d.reminded === 1), JSON.stringify(done));
    check('missing employee got a reminder', (await thread(dir, e2.id, execAgent.id)).some((m) => /Reminder: you haven't sent/.test(m.body)));
    check('their "reports to" (TL) got the list', (await thread(dir, tl.id, execAgent.id)).some((m) => /haven't submitted yet: Bala/.test(m.body)));
    const mgrMsgs = await thread(dir, mgr.id, execAgent.id);
    const summary = mgrMsgs.find((m) => /📊/.test(m.body));
    check('manager got the summary with totals', summary && /\*\*Sales: 6\*\*/.test(summary.body) && /\*\*Calls: 20\*\*/.test(summary.body), summary && summary.body);
    check('summary names who is missing', summary && /Not submitted yet: Bala/.test(summary.body));
    check('summary carries the Excel/report link token', summary && summary.body.includes(`[checkin:${chk.id}:${DATE}]`));
    check('admin also gets the summary', (await thread(dir, admin.id, execAgent.id)).some((m) => /📊/.test(m.body)));
    done = await service.tick(dir, at('16:30'));
    check('deadline step only once', done.length === 0);

    await service.handleReply(dir, { employeeId: execAgent.id, userId: e2.id, text: 'sales 1 calls 5', now: at('16:40') });
    r = await client('GET', `/api/executive/checkins/${chk.id}/report?date=${DATE}`);
    check('late answer is recorded and marked late', r.data.report.rows.find((x) => x.name === 'Bala').status === 'late');

    console.log('\n=== 6. Everyone on time → summary right away ===');
    const c2 = store.createCheckin(dir, { title: 'Calls only', question: 'How many calls?', fields: 'Calls', askTime: '10:00', deadlineTime: '11:00' }, mgr.id);
    await service.tick(dir, at('10:00'));
    for (const u of [e1, e2, tl]) await service.handleReply(dir, { employeeId: execAgent.id, userId: u.id, text: '10', now: at('10:30') });
    const early = (await thread(dir, mgr.id, execAgent.id)).find((m) => m.body.includes('Calls only') && /Everyone submitted/.test(m.body));
    check('managers get the summary as soon as everyone answered', !!early && /\*\*Calls: 30\*\*/.test(early.body), early && early.body);
    check('single-number reply works for a one-field check-in', !!early);

    console.log('\n=== 7. Manual controls + dashboard ===');
    r = await client('POST', `/api/executive/checkins/${chk.id}/ask`);
    check('ask again without force → 409', r.status === 409);
    r = await client('PATCH', `/api/executive/checkins/${c2.id}`, { active: false });
    check('pause a check-in', r.status === 200 && r.data.checkin.active === false);
    r = await client('GET', '/api/executive/dashboard');
    const anu = r.data.people.find((p) => p.name === 'Anu');
    check('dashboard: per-person reported totals (last 7 days)', anu && anu.sums.Sales === 4 && anu.sums.Calls === 22, JSON.stringify(anu));
    check('dashboard: check-in discipline counted', anu && anu.checkinsAsked === 2 && anu.checkinsAnswered === 2);
    r = await client('GET', '/api/executive/checkins');
    check('list shows today status', r.status === 200 && r.data.checkins.length === 2);
    r = await client('DELETE', `/api/executive/checkins/${c2.id}`);
    check('delete a check-in', r.status === 200 && store.listCheckins(dir).length === 1);
  } catch (err) {
    failures += 1;
    console.error('FAIL (exception)', err);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (failures) { console.log(`\nRESULT: ${failures} failed`); process.exit(1); }
  console.log('\nRESULT: OK - Executive Agent check-in tests passed');
}

main();
