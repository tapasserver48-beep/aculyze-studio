/**
 * Phase 04.1 — AI employee runtime tests (tool loop, policy, approvals).
 *
 * Uses a scripted fake model and a fake IntegrationManager — no network.
 *
 * Run with: node test/agent-runtime.test.js
 */

const assert = require('assert');
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Keep any real DATABASE_URL out of this test: JSON stores only.
delete process.env.DATABASE_URL;

const authStore = require('../src/auth/store');
const tasksStore = require('../src/tasks/store');
const employeesStore = require('../src/employees/store');
const inbox = require('../src/inbox/store');
const runtime = require('../src/execution/agentRuntime');
const approvals = require('../src/execution/approvals');
const policy = require('../src/execution/toolPolicy');
const { createAgentsRouter } = require('../src/agents/routes');
const { attachAuth } = require('../src/auth/session');
const { createAuthRouter } = require('../src/auth/routes');

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`PASS ${name}`);
  else { failures += 1; console.log(`FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

/* ---------------- fakes ---------------- */

function call(name, args = {}, id) {
  return { id: id || `call-${name}-${Math.random().toString(36).slice(2, 7)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

/** Scripted model: each entry is a response object or fn(messages, tools) → response. */
function fakeProvider(script) {
  const seen = [];
  return {
    name: 'fake',
    seen,
    async sendMessage({ messages, tools }) {
      seen.push({ messages: JSON.parse(JSON.stringify(messages)), tools: (tools || []).map((t) => t.function.name) });
      const next = script.shift();
      if (next === undefined) throw new Error('script exhausted');
      const r = typeof next === 'function' ? next(messages, tools) : next;
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

function fakeManager({ connected = ['gmail'] } = {}) {
  const granted = {
    gmail: ['READ_EMAIL', 'CREATE_DRAFT', 'SEND_EMAIL'],
    gcal: ['READ_CALENDAR', 'CREATE_EVENT', 'UPDATE_EVENT'],
  };
  const m = {
    reads: [],
    executed: [],
    listApps() {
      return connected.map((id) => ({ id, status: 'connected', granted: granted[id] || [] }));
    },
    async runTool(uid, toolId, args) {
      m.reads.push({ uid, toolId, args });
      return { count: 2, summary: 'Found 2 emails', text: 'Email 1: Invoice from Orbinox\nEmail 2: Meeting notes' };
    },
    async buildConfirmation(uid, { tool, args }) {
      return { confirm: { tool, title: 'Send this email?', preview: [{ label: 'To', value: args.to }], args } };
    },
    async execute(uid, { tool, args, confirm }) {
      assert.strictEqual(confirm, true);
      m.executed.push({ uid, tool, args });
      return { ok: true, summary: `Email sent to ${args.to}` };
    },
  };
  return m;
}

/* ---------------- main ---------------- */

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-'));
  const PW = 'TestPass-12345!';
  const founder = await authStore.createUser(dir, { name: 'Founder', email: 'founder@test.com', password: PW, role: 'founder' });
  const other = await authStore.createUser(dir, { name: 'Other Manager', email: 'other@test.com', password: PW, role: 'manager' });

  await employeesStore.initializeEmployee(dir, 'AI-CHIEF-001');
  await employeesStore.initializeEmployee(dir, 'AI-EXEC-001');
  const emps = await employeesStore.listEmployees(dir);
  const chief = emps.find((e) => e.employee_code === 'AI-CHIEF-001');
  const exec = emps.find((e) => e.employee_code === 'AI-EXEC-001');

  const newTask = (assignee, title = 'Summarize client emails') => tasksStore.createTask(dir, {
    title,
    description: 'Look at recent Orbinox emails and summarize.',
    assignedTo: { type: 'ai', id: assignee.id },
    assignedBy: { type: 'human', id: founder.id },
    priority: 'medium',
    initiatingUserId: founder.id,
  });

  const run = (employee, task, provider, manager, extra = {}) => runtime.executeTask(dir, {
    employeeId: employee.id, taskId: task.id, initiatingUserId: founder.id, provider, manager, ...extra,
  });

  try {
    console.log('\n=== 1. Prompt uses registry instructions ===');
    {
      const task = await newTask(chief);
      const p = fakeProvider([{ toolCalls: [call('task__submit_result', { summary: 'done', result: 'ok' })] }]);
      await run(chief, task, p, fakeManager());
      const sys = p.seen[0].messages[0].content;
      check('system prompt contains registry system_instructions', sys.includes(chief.system_instructions.slice(0, 60)));
      check('system prompt contains runtime rules', sys.includes('task__submit_result'));
      check('user message contains task title', p.seen[0].messages[1].content.includes(task.title));
    }

    console.log('\n=== 2. Read tool → submit → under_review ===');
    {
      const task = await newTask(chief);
      const mgr = fakeManager();
      const p = fakeProvider([
        { toolCalls: [call('gmail__search', { q: 'orbinox' })] },
        (msgs) => {
          const last = msgs[msgs.length - 1];
          assert.strictEqual(last.role, 'tool');
          return { toolCalls: [call('task__submit_result', { summary: 'Two Orbinox emails', result: 'Invoice + meeting notes.' })] };
        },
      ]);
      const out = await run(chief, task, p, mgr);
      check('outcome is submitted', out.outcome === runtime.OUTCOME.SUBMITTED, out.outcome);
      check('read tool ran as initiating user', mgr.reads.length === 1 && mgr.reads[0].uid === founder.id);
      check('tool result was fed back to model', p.seen[1].messages.some((m) => m.role === 'tool' && m.content.includes('Orbinox')));
      const t = await tasksStore.getTask(dir, task.id);
      check('task is under_review', t.status === 'under_review', t.status);
      check('progress is 100', Number(t.progress) === 100);
      const comments = await tasksStore.getTaskComments(dir, task.id);
      check('result comment added', comments.some((c) => c.content.includes('Two Orbinox emails')));
      const activity = await tasksStore.getTaskActivity(dir, task.id);
      check('tool call logged in activity', activity.some((a) => a.action === 'agent_tool_call'));
      const threads = await inbox.listThreads(dir, `usr-${founder.id}`);
      check('requester got an inbox message', threads.some((th) => th.peerId === chief.id || th.peer_id === chief.id || JSON.stringify(th).includes(chief.id)));
    }

    console.log('\n=== 3. Capability policy ===');
    {
      const execTools = policy.buildEmployeeTools(exec, fakeManager().listApps()).map((t) => t.function.name);
      check('exec is offered gmail__search', execTools.includes('gmail__search'));
      check('exec is NOT offered gmail__send_message', !execTools.includes('gmail__send_message'));
      const task = await newTask(exec);
      const mgr = fakeManager();
      const p = fakeProvider([
        { toolCalls: [call('gmail__send_message', { to: 'x@y.com', subject: 's', body: 'b' })] },
        { toolCalls: [call('task__submit_result', { summary: 'could not send', result: 'n/a' })] },
      ]);
      const out = await run(exec, task, p, mgr);
      check('forbidden tool call refused at execution time', mgr.executed.length === 0 && approvals.listApprovals(dir, { taskId: task.id }).length === 0);
      check('model was told the tool is unavailable', p.seen[1].messages.some((m) => m.role === 'tool' && m.content.includes('not available')));
      check('run still finished', out.outcome === runtime.OUTCOME.SUBMITTED);
    }

    console.log('\n=== 4. Unconnected apps are never offered ===');
    {
      const tools = policy.buildEmployeeTools(chief, fakeManager({ connected: ['gmail'] }).listApps()).map((t) => t.function.name);
      check('chief has calendar capability but calendar is not offered', !tools.some((n) => n.startsWith('calendar__')));
      const withCal = policy.buildEmployeeTools(chief, fakeManager({ connected: ['gmail', 'gcal'] }).listApps()).map((t) => t.function.name);
      check('calendar offered once connected', withCal.includes('calendar__list_events'));
    }

    // HTTP app for approval flows
    const approveScript = [];
    const httpProvider = fakeProvider(approveScript);
    const mgr = fakeManager();
    const app = express();
    app.use(express.json());
    app.use(attachAuth(dir));
    app.use('/api/auth', createAuthRouter({ dataDir: dir }));
    app.use('/api/agents', createAgentsRouter({ dataDir: dir, manager: mgr, runtimeProvider: httpProvider }));
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    let cookie = '';
    async function client(method, url, body) {
      const res = await fetch(base + url, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        const pair = c.split(';')[0];
        if (pair.startsWith('zara_session=')) cookie = pair;
      }
      let data = null;
      try { data = await res.json(); } catch { /* ignore */ }
      return { status: res.status, data };
    }
    async function login(email) {
      cookie = '';
      const r = await client('POST', '/api/auth/login', { email, password: PW });
      if (r.status !== 200) throw new Error('login failed');
    }

    try {
      console.log('\n=== 5. Write tool pauses for approval ===');
      await login(founder.email);
      const task = await newTask(chief, 'Email Orbinox the summary');
      approveScript.push(
        { toolCalls: [call('gmail__send_message', { to: 'ceo@orbinox.com', subject: 'Summary', body: 'Hi' }, 'send-1')] },
      );
      let r = await client('POST', `/api/agents/${chief.id}/execute`, { taskId: task.id });
      check('execute returns needs_approval', r.status === 200 && r.data.outcome === 'needs_approval', JSON.stringify(r.data));
      const apprId = r.data.approval && r.data.approval.id;
      check('approval has preview, no saved state leaked', !!apprId && r.data.approval.confirm && r.data.approval.state === undefined);
      check('nothing was sent yet', mgr.executed.length === 0);
      let t = await tasksStore.getTask(dir, task.id);
      check('task pending / awaiting_approval', t.status === 'pending' && t.pending_reason === 'awaiting_approval', `${t.status}/${t.pending_reason}`);

      r = await client('GET', '/api/agents/approvals');
      check('approval listed for requester', r.status === 200 && r.data.approvals.some((a) => a.id === apprId));

      r = await client('POST', `/api/agents/${chief.id}/execute`, { taskId: task.id });
      check('re-running while approval pending → 409', r.status === 409, String(r.status));

      console.log('\n=== 6. Only the requester can approve ===');
      await login(other.email);
      r = await client('POST', `/api/agents/approvals/${apprId}/approve`);
      check('other manager gets 403', r.status === 403, String(r.status));
      check('still not sent', mgr.executed.length === 0);

      console.log('\n=== 7. Approve → action runs → run resumes ===');
      await login(founder.email);
      approveScript.push((msgs) => {
        const toolMsg = msgs.find((m) => m.role === 'tool' && m.tool_call_id === 'send-1');
        assert.ok(toolMsg && toolMsg.content.includes('Email sent'), 'resume sees action result');
        return { toolCalls: [call('task__submit_result', { summary: 'Summary emailed to Orbinox', result: 'Sent.' })] };
      });
      r = await client('POST', `/api/agents/approvals/${apprId}/approve`);
      check('approve → submitted', r.status === 200 && r.data.outcome === 'submitted', JSON.stringify(r.data));
      check('email executed once as requester', mgr.executed.length === 1 && mgr.executed[0].uid === founder.id);
      t = await tasksStore.getTask(dir, task.id);
      check('task under_review after resume', t.status === 'under_review', t.status);
      r = await client('POST', `/api/agents/approvals/${apprId}/approve`);
      check('double approve → 409 (no double send)', r.status === 409 && mgr.executed.length === 1, String(r.status));
      check('saved conversation cleared', approvals.getApproval(dir, apprId).state === null);

      console.log('\n=== 8. Reject → reason reaches the agent ===');
      const task2 = await newTask(chief, 'Email the team');
      approveScript.push({ toolCalls: [call('gmail__send_message', { to: 'team@x.com', subject: 's', body: 'b' }, 'send-2')] });
      r = await client('POST', `/api/agents/${chief.id}/execute`, { taskId: task2.id });
      const appr2 = r.data.approval.id;
      approveScript.push((msgs) => {
        const toolMsg = msgs.find((m) => m.role === 'tool' && m.tool_call_id === 'send-2');
        assert.ok(toolMsg && toolMsg.content.includes('wrong recipients'));
        return { content: 'Drafted only; not sent per your feedback.' };
      });
      r = await client('POST', `/api/agents/approvals/${appr2}/reject`, { reason: 'wrong recipients' });
      check('reject → run resumes and submits', r.status === 200 && r.data.outcome === 'submitted', JSON.stringify(r.data));
      check('rejected action never executed', mgr.executed.length === 1);
    } finally {
      server.close();
    }

    console.log('\n=== 9. request_info pauses with waiting_for_info ===');
    {
      const task = await newTask(chief);
      const p = fakeProvider([{ toolCalls: [call('task__request_info', { question: 'Which quarter?' })] }]);
      const out = await run(chief, task, p, fakeManager());
      const t = await tasksStore.getTask(dir, task.id);
      check('outcome needs_info', out.outcome === 'needs_info');
      check('task pending / waiting_for_info', t.status === 'pending' && t.pending_reason === 'waiting_for_info');
    }

    console.log('\n=== 10. Step limit and model failure ===');
    {
      const task = await newTask(chief);
      const loop = () => ({ toolCalls: [call('task__report_progress', { note: 'working', percent: 10 })] });
      const p = fakeProvider([loop, loop, loop, loop]);
      const out = await run(chief, task, p, fakeManager(), { maxSteps: 2 });
      check('stops after maxSteps model calls', p.seen.length === 2, String(p.seen.length));
      check('no result → failed + blocked', out.outcome === 'failed' && (await tasksStore.getTask(dir, task.id)).pending_reason === 'blocked');

      const task2 = await newTask(chief);
      const out2 = await run(chief, task2, fakeProvider([new Error('LM Studio offline')]), fakeManager());
      const t2 = await tasksStore.getTask(dir, task2.id);
      check('model error → failed, task blocked', out2.outcome === 'failed' && t2.status === 'pending' && t2.pending_reason === 'blocked');
    }
  } catch (err) {
    failures += 1;
    console.error('FAIL (exception)', err);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (failures) {
    console.log(`\nRESULT: ${failures} failed`);
    process.exit(1);
  }
  console.log('\nRESULT: OK - All Phase 04.1 runtime tests passed');
}

main();
