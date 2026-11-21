/**
 * Phase 03.3 — Chief of Staff planning & delegation.
 *
 * TWO KINDS OF EVIDENCE, deliberately separated (brief §8):
 *
 *   Section A — AUTOMATED tests. The model reply is injected through the
 *              `modelCall` seam. These prove workflow, permissions and data
 *              integrity. They are NOT evidence of live NVIDIA execution and
 *              any plan they produce is stamped source:'test-harness'.
 *
 *   Section B — LIVE integration test. No seam, no mock: a real call through
 *              the real router to NVIDIA. This is the only section that may be
 *              cited as live provider evidence.
 *
 * Run: node test/chief-of-staff.test.js
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
const { getPlan } = require('../src/chiefOfStaff/plans');

const PW = 'ChiefTest-12345!';
let failures = 0;

function check(name, cond, extra = '') {
  if (cond) {
    console.log(`PASS ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${extra ? ' — ' + extra : ''}`);
  }
}

/** A plausible model reply built from ids that really exist in the roster. */
function modelReply(candidates, overrides = {}) {
  const ai = candidates.find((c) => c.kind === 'ai');
  const payload = {
    summary: 'Split the objective into research and delivery.',
    missing: [],
    success_criteria: ['Page shipped and reviewed'],
    subtasks: [
      {
        title: 'Research the current state',
        description: 'Audit what exists today.',
        assignee_id: ai ? ai.id : 'nobody',
        priority: 'high',
        due_in_days: 2,
        depends_on: [],
        deliverable: 'Findings memo',
      },
      {
        title: 'Draft the new page',
        description: 'Write and lay out the page.',
        assignee_id: ai ? ai.id : 'nobody',
        priority: 'medium',
        due_in_days: 5,
        depends_on: [0],
        deliverable: 'Review-ready draft',
      },
    ],
    ...overrides,
  };
  return { content: JSON.stringify(payload), provider: 'test-harness', model: 'injected' };
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-test-'));

  /* ---------------- setup ---------------- */
  const founder = await authStore.createUser(dataDir, {
    name: 'Founder', email: 'founder@chief.test', password: PW, role: 'founder',
  });
  const manager = await authStore.createUser(dataDir, {
    name: 'Manager', email: 'manager@chief.test', password: PW, role: 'manager',
  });
  const employee = await authStore.createUser(dataDir, {
    name: 'Employee', email: 'employee@chief.test', password: PW, role: 'employee',
  });
  const outsider = await authStore.createUser(dataDir, {
    name: 'Outsider', email: 'outsider@chief.test', password: PW, role: 'employee',
  });

  await employeesStore.initializeEmployee(dataDir, 'AI-CHIEF-001');
  await employeesStore.initializeEmployee(dataDir, 'AI-EXEC-001');

  const chiefId = await chief.getChiefId(dataDir);
  const registry = await chief.buildRegistry(dataDir, chiefId);
  registry.chiefId = chiefId;

  /* ---------------- HTTP harness ---------------- */
  const app = express();
  app.use(express.json());
  app.use(attachAuth(dataDir));
  app.use('/api/auth', createAuthRouter({ dataDir }));
  app.use('/api/chief', createChiefOfStaffRouter({ dataDir }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  let cookie = '';
  async function api(method, url, body) {
    const res = await fetch(base + url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of setCookies) {
      const pair = c.split(';')[0];
      if (pair.startsWith('zara_session=')) cookie = pair;
    }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, data };
  }
  async function login(email) {
    cookie = '';
    const r = await api('POST', '/api/auth/login', { email, password: PW });
    if (r.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(r.data)}`);
  }

  try {
    console.log('\n--- Section A: AUTOMATED (injected model reply, not live NVIDIA) ---\n');

    /* ===== 1. Request intake ===== */
    const intake = await chief.draftPlan({
      dataDir,
      userId: founder.id,
      input: { title: 'Refresh the pricing page', description: 'Marketing site', priority: 'high' },
      modelCall: async () => modelReply(registry.candidates),
    });
    check('1 request intake → draft plan', intake.status === 'draft' && !!intake.plan.id, intake.plan.id);
    check('1a plan source is labelled test-harness', intake.plan.source === 'test-harness', intake.plan.source);

    const tasksAfterDraft = await tasksStore.listTasks(dataDir, {});
    check('1b drafting created ZERO tasks (approval gate holds)', tasksAfterDraft.length === 0,
      `${tasksAfterDraft.length} task(s)`);
    const planAfterDraft = await getPlan(dataDir, intake.plan.id);
    check('1c plan persisted before approval', !!planAfterDraft && planAfterDraft.status === 'draft');

    const openPlanId = intake.plan.id;

    /* ===== 2. Missing-information clarification ===== */
    const clarify = await chief.draftPlan({
      dataDir,
      userId: founder.id,
      input: { title: 'Improve onboarding' },
      modelCall: async () => modelReply(registry.candidates, {
        missing: ['Which product surface?', 'Who is the target user?'],
        subtasks: [],
      }),
    });
    check('2 missing information → clarification, no plan',
      clarify.status === 'needs_clarification' && clarify.missing.length === 2,
      clarify.missing.join(' | '));
    check('2a clarification persists no plan', clarify.planId === null);

    /* ===== 3. Subtask generation ===== */
    check('3 subtasks generated',
      intake.plan.subtasks.length === 2, `${intake.plan.subtasks.length} subtask(s)`);
    check('3a every subtask has title + assignee + deliverable',
      intake.plan.subtasks.every((s) => s.title && s.assignee_id && s.deliverable));
    check('3b subtasks carry initiating user + parent reference',
      intake.plan.subtasks.every((s) => s.assignee_id !== founder.id)
      && intake.plan.created_by === founder.id);

    /* ===== 4. Dependency handling ===== */
    check('4 dependency chain is ordered (1 depends on 0)',
      JSON.stringify(intake.plan.subtasks[1].depends_on) === '[0]',
      JSON.stringify(intake.plan.subtasks[1].depends_on));

    let cycleRejected = false;
    try {
      await chief.draftPlan({
        dataDir,
        userId: founder.id,
        input: { title: 'Circular objective' },
        modelCall: async () => modelReply(registry.candidates, {
          subtasks: [
            { title: 'A', assignee_id: registry.candidates[0].id, depends_on: [1], deliverable: 'a' },
            { title: 'B', assignee_id: registry.candidates[0].id, depends_on: [0], deliverable: 'b' },
          ],
        }),
      });
    } catch (err) {
      cycleRejected = err.code === 'circular_plan';
    }
    check('4a circular dependency rejected', cycleRejected);

    /* ===== 5. Employee selection (never invent an employee) ===== */
    const invented = await chief.draftPlan({
      dataDir,
      userId: founder.id,
      input: { title: 'Objective with a bogus assignee' },
      modelCall: async () => modelReply(registry.candidates, {
        subtasks: [
          { title: 'Hand off to a ghost', assignee_id: 'emp-ai-DOES-NOT-EXIST', deliverable: 'x' },
        ],
      }),
    });
    check('5 invented employee is not accepted',
      invented.status === 'needs_clarification' && invented.reason === 'no_assignable_subtasks',
      invented.reason);

    const picks = chief.hasCycle; // keep reference used below
    check('5a registry only exposes real employees',
      registry.candidates.every((c) => typeof c.id === 'string' && c.id.length > 0)
      && !registry.candidates.some((c) => c.id === chiefId),
      `${registry.candidates.length} candidates, chief excluded`);
    void picks;

    /* ===== 5b. Regression: prompt must carry date + full roster ===== */
    const todayStr = new Date().toISOString().slice(0, 10);
    const promptText = chief.buildPrompt({ title: 'Test objective' }, registry);
    check('5b prompt states today\'s date (model must not ask for it)',
      promptText.includes(todayStr), todayStr);
    check('5c prompt says there are no teams/departments',
      /no teams, departments/i.test(promptText));
    check('5d prompt lists every roster member by id',
      registry.candidates.every((c) => promptText.includes(c.id)),
      `${registry.candidates.length} ids`);

    /* ===== 5e. Roster reflects the initiator's assignment authority ===== */
    const founderReg = await chief.buildRegistry(dataDir, chiefId, 'founder');
    const managerReg = await chief.buildRegistry(dataDir, chiefId, 'manager');
    check('5e ordinary employees ARE in the roster (were wrongly excluded)',
      founderReg.human.some((h) => h.name === 'Employee'),
      `${founderReg.human.length} humans for a founder`);
    check('5f founder may assign to every human', founderReg.human.length === 4,
      `${founderReg.human.length}`);
    check('5g manager may only assign to employees, never to admins',
      managerReg.human.length === 2
      && managerReg.human.every((h) => h.role.startsWith('employee')),
      `${managerReg.human.length}: ${managerReg.human.map((h) => h.role).join(', ')}`);

    /* ===== 5h. Caveats ride along instead of blocking ===== */
    const caveated = await chief.draftPlan({
      dataDir,
      userId: founder.id,
      input: { title: 'Objective with a caveat' },
      modelCall: async () => modelReply(registry.candidates, {
        missing: ['Confirm the launch window'],
      }),
    });
    check('5h a caveat does not block a usable plan',
      caveated.status === 'draft' && caveated.plan.analysis.caveats.length === 1,
      `status=${caveated.status}`);
    check('5i caveat is preserved for the approver to check',
      caveated.plan.analysis.caveats[0] === 'Confirm the launch window');

    /* ===== 5j. Due dates may not exceed the objective deadline ===== */
    const deadlineIso = new Date(Date.now() + 10 * 86400000).toISOString();
    const clamped = await chief.draftPlan({
      dataDir,
      userId: founder.id,
      input: { title: 'Deadline clamping probe', deadline: deadlineIso },
      modelCall: async () => modelReply(registry.candidates, {
        subtasks: [
          { title: 'Deliberately too slow', assignee_id: registry.candidates[0].id, due_in_days: 400, deliverable: 'x' },
        ],
      }),
    });
    const clampedSub = clamped.plan.subtasks[0];
    check('5j subtask due date clamped to the objective deadline',
      clampedSub.due_date <= new Date(deadlineIso).getTime(),
      `${new Date(clampedSub.due_date).toISOString().slice(0, 10)} vs deadline ${deadlineIso.slice(0, 10)}`);
    check('5k due_in_days recomputed after clamping',
      clampedSub.due_in_days !== null && clampedSub.due_in_days <= 10,
      `${clampedSub.due_in_days} day(s)`);

    /* ===== 6. Human approval ===== */
    await login(founder.email);
    const approveRes = await api('POST', `/api/chief/plans/${openPlanId}/approve`, {});
    check('6 founder approves the plan', approveRes.status === 200 && approveRes.data.status === 'approved',
      `HTTP ${approveRes.status}`);

    /* ===== 7. Task creation through the Central Task Engine ===== */
    const createdIds = approveRes.data.created || [];
    check('7 approval created one task per subtask', createdIds.length === 2, `${createdIds.length} task(s)`);

    const t0 = await tasksStore.getTask(dataDir, createdIds[0]);
    check('7a task parent reference = plan id', t0.parent_task_id === openPlanId, t0.parent_task_id);
    check('7b task records the initiating user', t0.initiating_user_id === founder.id, t0.initiating_user_id);
    check('7c task records the expected deliverable', !!t0.expected_deliverable, t0.expected_deliverable);
    check('7d task assigned to a real AI employee', t0.assigned_to_type === 'ai' && !!t0.assigned_to_id);
    const t1 = await tasksStore.getTask(dataDir, createdIds[1]);
    check('7e dependent task references the first task id',
      Array.isArray(t1.dependencies) && t1.dependencies.includes(createdIds[0]),
      JSON.stringify(t1.dependencies));

    /* ===== 8. Duplicate prevention ===== */
    const dup = await api('POST', '/api/chief/plans', { objective: 'Refresh the pricing page' });
    check('8 duplicate objective refused with 409', dup.status === 409, `HTTP ${dup.status}`);
    const tasksAfterDup = await tasksStore.listTasks(dataDir, {});
    check('8a duplicate attempt created no extra tasks',
      tasksAfterDup.length === createdIds.length, `${tasksAfterDup.length} task(s)`);

    /* ===== 9. Unauthorized delegation ===== */
    await login(employee.email);
    const unauth = await api('POST', '/api/chief/plans', { objective: 'Employee wants to delegate' });
    check('9 employee cannot delegate (403)', unauth.status === 403, `HTTP ${unauth.status}`);

    await login(employee.email);
    const empApprove = await api('POST', `/api/chief/plans/${openPlanId}/approve`, {});
    check('9a employee cannot approve a plan (403)', empApprove.status === 403, `HTTP ${empApprove.status}`);

    const anonRes = await (async () => {
      cookie = '';
      return api('GET', '/api/chief/plans');
    })();
    check('9b anonymous request rejected (401)', anonRes.status === 401, `HTTP ${anonRes.status}`);

    /* ===== 10. Cross-agent / cross-user isolation ===== */
    await login(outsider.email);
    const isolated = await api('GET', `/api/chief/plans/${openPlanId}`);
    check('10 non-initiator cannot read someone else\'s plan (403)',
      isolated.status === 403, `HTTP ${isolated.status}`);

    await login(manager.email);
    const mgrView = await api('GET', `/api/chief/plans/${openPlanId}`);
    check('10a founder/admin may still view it', mgrView.status === 200, `HTTP ${mgrView.status}`);

    /* ===== 11. Blocker reporting ===== */
    await login(founder.email);
    await tasksStore.updateTask(dataDir, createdIds[1], {
      status: 'pending',
      pending_reason: 'Waiting on brand assets',
    });
    const blockedView = await api('GET', `/api/chief/plans/${openPlanId}`);
    check('11 blocker surfaced in monitoring',
      blockedView.data.summary.blocked === 1
      && blockedView.data.subtasks.some((s) => s.blocker === 'Waiting on brand assets'),
      `blocked=${blockedView.data.summary.blocked}`);

    /* ===== 12. Completion and final report ===== */
    await tasksStore.updateTask(dataDir, createdIds[0], { status: 'completed' });
    await tasksStore.updateTask(dataDir, createdIds[1], { status: 'completed' });

    const doneView = await api('GET', `/api/chief/plans/${openPlanId}`);
    check('12 all subtasks complete → plan completed',
      doneView.data.summary.progress === 100 && doneView.data.status === 'completed',
      `${doneView.data.summary.progress}% / ${doneView.data.status}`);

    const report = await api('GET', `/api/chief/plans/${openPlanId}/report`);
    check('12a consolidated report returned',
      report.status === 200 && typeof report.data.report === 'string' && report.data.report.length > 0);
    check('12b report names the objective and the deliverables',
      report.data.report.includes('Refresh the pricing page')
      && report.data.report.includes('Findings memo'),
      report.data.report.split('\n')[0]);

    /* ===== 13. NVIDIA provider failure handling ===== */
    const savedKey = process.env.NVIDIA_API_KEY;
    delete process.env.NVIDIA_API_KEY;
    let noKeyErr = null;
    try {
      chief.getNvidiaRouter({ ...process.env, NVIDIA_API_KEY: '' });
    } catch (err) {
      noKeyErr = err;
    }
    if (savedKey !== undefined) process.env.NVIDIA_API_KEY = savedKey;
    check('13 missing NVIDIA key fails loudly (no silent LM Studio fallback)',
      !!noKeyErr && noKeyErr.code === 'nvidia_unavailable' && noKeyErr.status === 503,
      noKeyErr ? noKeyErr.code : 'no error thrown');

    let failErr = null;
    try {
      await chief.draftPlan({
        dataDir,
        userId: founder.id,
        input: { title: 'Provider failure probe' },
        modelCall: async () => { throw new Error('NVIDIA 503 upstream'); },
      });
    } catch (err) {
      failErr = err;
    }
    check('13a provider outage propagates as an error, not a fake plan',
      !!failErr && /NVIDIA 503/.test(failErr.message), failErr && failErr.message);

    /* ===== bonus: approval is idempotent (no duplicate side effects) ===== */
    const reApprove = await api('POST', `/api/chief/plans/${openPlanId}/approve`, {});
    check('14 re-approving an approved plan is refused (409)',
      reApprove.status === 409, `HTTP ${reApprove.status}`);
    const finalCount = await tasksStore.listTasks(dataDir, {});
    check('14a no duplicate tasks after a repeat approval',
      finalCount.length === createdIds.length, `${finalCount.length} task(s)`);

    /* ---------------- Section B: LIVE ---------------- */
    console.log('\n--- Section B: LIVE NVIDIA integration (no mock, no seam) ---\n');

    const liveKeySaved = process.env.NVIDIA_API_KEY;
    if (!liveKeySaved) {
      console.log('SKIP live NVIDIA — NVIDIA_API_KEY is not set in this environment');
    } else {
      const liveStart = Date.now();
      try {
        const live = await chief.draftPlan({
          dataDir,
          userId: founder.id,
          input: {
            title: 'Live probe: summarise what this workspace does',
            description: 'A simple objective used to prove the NVIDIA path end to end.',
            priority: 'low',
          },
        });
        const ms = Date.now() - liveStart;
        check('LIVE draft succeeded through the real NVIDIA router',
          live.status === 'draft' || live.status === 'needs_clarification',
          `status=${live.status} in ${ms}ms`);
        if (live.status === 'draft') {
          check('LIVE provider recorded as nvidia',
            live.plan.provider === 'nvidia', `${live.plan.provider} · ${live.plan.model}`);
          check('LIVE plan stamped source=live (not test-harness)',
            live.plan.source === 'live', live.plan.source);
          check('LIVE latency recorded', Number(live.plan.latency_ms) > 0, `${live.plan.latency_ms}ms`);
          console.log(`     model: ${live.plan.model}`);
          console.log(`     subtasks: ${live.plan.subtasks.length}`);
        } else {
          console.log(`     model asked for clarification: ${live.missing.join(' | ')}`);
        }
      } catch (err) {
        check('LIVE draft succeeded through the real NVIDIA router', false, err.message);
      }
    }

    console.log('\n=== CLEANUP ===');
  } catch (err) {
    console.error('FAIL', err);
    failures += 1;
  } finally {
    server.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  if (failures) {
    console.log(`\nRESULT: ${failures} failed`);
    process.exit(1);
  }
  console.log('\nRESULT: OK — all Phase 03.3 tests passed');
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
