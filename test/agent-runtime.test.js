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
const { createTasksRouter } = require('../src/tasks/routes');
const { createInboxRouter } = require('../src/inbox/routes');
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
  const staff = await authStore.createUser(dir, { name: 'Staff Member', email: 'staff@test.com', password: PW, role: 'employee' });

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
    app.use('/api/tasks', createTasksRouter({ dataDir: dir }));
    const chatScript = [];
    const chatProvider = fakeProvider(chatScript);
    app.use('/api/inbox', createInboxRouter({ dataDir: dir, aiProvider: chatProvider }));
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
      let r = await client('POST', `/api/agents/${chief.id}/execute`, { taskId: task.id, wait: true });
      check('execute returns needs_approval', r.status === 200 && r.data.outcome === 'needs_approval', JSON.stringify(r.data));
      const apprId = r.data.approval && r.data.approval.id;
      check('approval has preview, no saved state leaked', !!apprId && r.data.approval.confirm && r.data.approval.state === undefined);
      check('nothing was sent yet', mgr.executed.length === 0);
      let t = await tasksStore.getTask(dir, task.id);
      check('task pending / awaiting_approval', t.status === 'pending' && t.pending_reason === 'awaiting_approval', `${t.status}/${t.pending_reason}`);

      r = await client('GET', '/api/agents/approvals');
      check('approval listed for requester', r.status === 200 && r.data.approvals.some((a) => a.id === apprId));

      r = await client('POST', `/api/agents/${chief.id}/execute`, { taskId: task.id, wait: true });
      check('re-running while approval pending → 409', r.status === 409, String(r.status));

      console.log('\n=== 6. Only the requester can approve ===');
      await login(other.email);
      r = await client('POST', `/api/agents/approvals/${apprId}/approve`, { wait: true });
      check('other manager gets 403', r.status === 403, String(r.status));
      check('still not sent', mgr.executed.length === 0);

      console.log('\n=== 7. Approve → action runs → run resumes ===');
      await login(founder.email);
      approveScript.push((msgs) => {
        const toolMsg = msgs.find((m) => m.role === 'tool' && m.tool_call_id === 'send-1');
        assert.ok(toolMsg && toolMsg.content.includes('Email sent'), 'resume sees action result');
        return { toolCalls: [call('task__submit_result', { summary: 'Summary emailed to Orbinox', result: 'Sent.' })] };
      });
      r = await client('POST', `/api/agents/approvals/${apprId}/approve`, { wait: true });
      check('approve → submitted', r.status === 200 && r.data.outcome === 'submitted', JSON.stringify(r.data));
      check('email executed once as requester', mgr.executed.length === 1 && mgr.executed[0].uid === founder.id);
      t = await tasksStore.getTask(dir, task.id);
      check('task under_review after resume', t.status === 'under_review', t.status);
      r = await client('POST', `/api/agents/approvals/${apprId}/approve`, { wait: true });
      check('double approve → 409 (no double send)', r.status === 409 && mgr.executed.length === 1, String(r.status));
      check('saved conversation cleared', approvals.getApproval(dir, apprId).state === null);

      console.log('\n=== 8. Reject → reason reaches the agent ===');
      const task2 = await newTask(chief, 'Email the team');
      approveScript.push({ toolCalls: [call('gmail__send_message', { to: 'team@x.com', subject: 's', body: 'b' }, 'send-2')] });
      r = await client('POST', `/api/agents/${chief.id}/execute`, { taskId: task2.id, wait: true });
      const appr2 = r.data.approval.id;
      approveScript.push((msgs) => {
        const toolMsg = msgs.find((m) => m.role === 'tool' && m.tool_call_id === 'send-2');
        assert.ok(toolMsg && toolMsg.content.includes('wrong recipients'));
        return { content: 'Drafted only; not sent per your feedback.' };
      });
      r = await client('POST', `/api/agents/approvals/${appr2}/reject`, { reason: 'wrong recipients', wait: true });
      check('reject → run resumes and submits', r.status === 200 && r.data.outcome === 'submitted', JSON.stringify(r.data));
      check('rejected action never executed', mgr.executed.length === 1);

      // Poll a background run until it finishes.
      async function waitRun(executionId) {
        for (let i = 0; i < 100; i++) {
          const pr = await client('GET', `/api/agents/runs/${executionId}`);
          if (pr.data && pr.data.run && pr.data.run.status === 'done') return pr.data.run;
          await new Promise((res) => setTimeout(res, 30));
        }
        throw new Error('run did not finish');
      }

      console.log('\n=== 11. Background run with live steps ===');
      const task3 = await newTask(chief, 'Background summary');
      let release;
      const gate = new Promise((res) => { release = res; });
      approveScript.push(
        { toolCalls: [call('gmail__search', { q: 'x' })] },
        async () => { await gate; return { toolCalls: [call('task__submit_result', { summary: 'BG done', result: 'Background result.' })] }; },
      );
      r = await client('POST', `/api/agents/${chief.id}/execute`, { taskId: task3.id });
      check('execute without wait → 202 + executionId', r.status === 202 && !!r.data.executionId, JSON.stringify(r.data));
      const execId = r.data.executionId;
      await new Promise((res) => setTimeout(res, 80));
      let live = (await client('GET', `/api/agents/runs/${execId}`)).data.run;
      check('run is visible while running, with live steps', live.status === 'running' && live.steps.some((s) => s.tool === 'gmail.search'), JSON.stringify(live));
      r = await client('POST', `/api/agents/${chief.id}/execute`, { taskId: task3.id });
      check('second run on same task while running → 409', r.status === 409, String(r.status));
      release();
      const doneRun = await waitRun(execId);
      check('background run finishes as submitted', doneRun.outcome === 'submitted' && doneRun.summary === 'BG done', JSON.stringify(doneRun));
      r = await client('GET', `/api/agents/runs?taskId=${task3.id}`);
      check('latest run is found by taskId', r.data.run && r.data.run.executionId === execId);
      await login(other.email);
      r = await client('GET', `/api/agents/runs/${execId}`);
      check('managers may view runs; route stays authenticated', r.status === 200);
      await login(founder.email);

      console.log('\n=== 12. Accept result ===');
      r = await client('POST', `/api/agents/tasks/${task3.id}/accept`);
      check('accept → completed', r.status === 200 && r.data.task.status === 'completed', JSON.stringify(r.data));
      r = await client('POST', `/api/agents/tasks/${task3.id}/accept`);
      check('accept twice → 409', r.status === 409, String(r.status));

      console.log('\n=== 13. Ask for changes ===');
      const task4 = await newTask(chief, 'Draft summary');
      approveScript.push({ toolCalls: [call('task__submit_result', { summary: 'v1', result: 'Long version.' })] });
      await client('POST', `/api/agents/${chief.id}/execute`, { taskId: task4.id, wait: true });
      approveScript.push((msgs) => {
        assert.ok(msgs.some((m) => m.role === 'user' && /Changes requested:\*\* make it shorter/.test(m.content)), 'feedback reaches the agent');
        return { toolCalls: [call('task__submit_result', { summary: 'v2', result: 'Short.' })] };
      });
      r = await client('POST', `/api/agents/tasks/${task4.id}/revise`, { feedback: 'make it shorter' });
      check('revise → 202 run', r.status === 202, JSON.stringify(r.data));
      const revRun = await waitRun(r.data.executionId);
      check('revised result submitted', revRun.outcome === 'submitted' && revRun.summary === 'v2', JSON.stringify(revRun));
      r = await client('POST', `/api/agents/tasks/${task4.id}/revise`, { feedback: '' });
      check('empty feedback → 422', r.status === 422);

      console.log('\n=== 14. Quick ask creates a task and runs it ===');
      approveScript.push({ toolCalls: [call('task__submit_result', { summary: 'Asked', result: 'Done from ask.' })] });
      r = await client('POST', '/api/agents/ask', { text: 'Check my inbox for anything urgent\nfocus on clients' });
      check('ask → 202 with a task for the Chief of Staff', r.status === 202 && r.data.task.assigned_to_id === chief.id && r.data.task.title === 'Check my inbox for anything urgent', JSON.stringify(r.data));
      const askRun = await waitRun(r.data.executionId);
      check('ask run finishes', askRun.outcome === 'submitted');
      const askTask = await tasksStore.getTask(dir, r.data.task.id);
      check('ask task records who asked', askTask.initiating_user_id === founder.id && askTask.status === 'under_review');

      console.log('\n=== 15. Employees can use AI on tasks they asked for ===');
      await login(staff.email);
      approveScript.push({ toolCalls: [call('task__submit_result', { summary: 'Staff result', result: 'For staff.' })] });
      r = await client('POST', '/api/agents/ask', { text: 'Summarize my week' });
      check('employee can ask the Chief of Staff', r.status === 202, JSON.stringify(r.data));
      const staffTaskId = r.data.task.id;
      await waitRun(r.data.executionId);
      r = await client('GET', '/api/tasks');
      check('employee sees the AI task they asked for', r.status === 200 && r.data.tasks.some((x) => x.id === staffTaskId));
      check('employee does not see other people\'s AI tasks', !r.data.tasks.some((x) => x.id === task4.id));
      r = await client('GET', `/api/tasks/${staffTaskId}/comments`);
      check('employee can read comments on their AI task', r.status === 200 && r.data.comments.some((c) => /Staff result/.test(c.content)));
      r = await client('POST', `/api/agents/${chief.id}/execute`, { taskId: task4.id, wait: true });
      check('employee cannot run AI on someone else\'s task', r.status === 403, String(r.status));
      r = await client('POST', `/api/agents/tasks/${staffTaskId}/accept`);
      check('employee can accept their own result', r.status === 200 && r.data.task.status === 'completed');

      console.log('\n=== 16. Inbox: chat reply + make it a task ===');
      chatScript.push((msgs) => {
        assert.ok(/cannot open apps/i.test(msgs[0].content), 'chat rules in system prompt');
        return { content: 'Happy to help! Click "Make this a task" and I will check your email.' };
      });
      r = await client('POST', '/api/inbox/messages', { to: chief.id, body: 'Can you check my email?' });
      check('message to AI employee accepted', r.status === 201, JSON.stringify(r.data));
      let reply = null;
      for (let i = 0; i < 60 && !reply; i++) {
        await new Promise((res) => setTimeout(res, 30));
        const { messages } = await inbox.listMessages(dir, `usr-${staff.id}`, chief.id, 0);
        reply = messages.find((m) => m.from === chief.id && /Make this a task/.test(m.body));
      }
      check('AI employee replies in the thread', !!reply);
      check('chat reply used no tools', chatProvider.seen.every((s) => s.tools.length === 0));

      approveScript.push({ toolCalls: [call('task__submit_result', { summary: 'Inbox task done', result: 'From inbox.' })] });
      r = await client('POST', '/api/agents/ask', { text: 'Can you check my email?', source: 'inbox', employeeId: chief.id });
      check('make-this-a-task → 202', r.status === 202);
      await waitRun(r.data.executionId);
      const { messages: thread } = await inbox.listMessages(dir, `usr-${staff.id}`, chief.id, 0);
      check('thread gets an "On it" message with a task link', thread.some((m) => /On it/.test(m.body) && m.body.includes(`[task:${r.data.task.id}]`)));
      check('thread gets the finished result with a task link', thread.some((m) => /Finished/.test(m.body) && m.body.includes(`[task:${r.data.task.id}]`)));
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
      check('maxSteps rounds + one tool-free wrap-up call', p.seen.length === 3, String(p.seen.length));
      check('last round offers only submit_result', p.seen[1].tools.length === 1 && p.seen[1].tools[0] === 'task__submit_result', JSON.stringify(p.seen[1].tools));
      check('wrap-up call offers no tools', p.seen[2].tools.length === 0);
      check('no result → failed + blocked', out.outcome === 'failed' && (await tasksStore.getTask(dir, task.id)).pending_reason === 'blocked');

      const taskW = await newTask(chief);
      const search = () => ({ toolCalls: [call('gmail__search', { q: 'x' })] });
      const pw = fakeProvider([search, search, (msgs) => {
        assert.ok(msgs.some((m) => m.role === 'user' && /no steps left/i.test(m.content)), 'wrap-up nudge sent');
        return { toolCalls: [call('task__submit_result', { summary: 'Wrapped up', result: 'From what I found…' })] };
      }]);
      const outW = await run(chief, taskW, pw, fakeManager(), { maxSteps: 3 });
      check('model that keeps searching is made to submit on the last round', outW.outcome === 'submitted', outW.outcome);

      const taskF = await newTask(chief);
      const pf = fakeProvider([search, search, { content: 'Here is the summary from the emails found.' }]);
      const outF = await run(chief, taskF, pf, fakeManager(), { maxSteps: 2 });
      check('ignored last round → tool-free wrap-up text is submitted', outF.outcome === 'submitted' && /summary/.test(outF.result || ''), outF.outcome);

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
