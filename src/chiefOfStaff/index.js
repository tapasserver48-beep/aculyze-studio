/**
 * Chief of Staff — planning and delegation (Phase 03.3).
 *
 * Workflow (brief §3):
 *   receive request → analyze → clarify if essential info is missing →
 *   decompose into subtasks → resolve dependencies → recommend verified
 *   employees → draft plan → HUMAN APPROVAL → create tasks → monitor →
 *   consolidate a report for the initiating user.
 *
 * Hard rules honoured here:
 *  - Drafting never creates a task. Tasks appear only inside approvePlan()
 *    (brief §6: approval precedes any assignment).
 *  - Employees come from the verified registry only; the model may only pick
 *    ids we handed it, and we re-validate every pick (brief §4).
 *  - Delegating user authority is checked server-side against the auth store,
 *    never from anything the browser says about an AI identity (brief §4).
 *  - NVIDIA only. No LM Studio, no second router (brief §2).
 *  - No autonomous firing of approved tasks — a human triggers execution
 *    separately, per the Phase 03.2B architectural review gate.
 */

const { createRouterFromEnv } = require('../services/ai/router');
const { listEmployees, initializeEmployee, EMPLOYEE_CODES } = require('../employees/store');
const authStore = require('../auth/store');
const { canAssignRole } = require('../auth/roles');
const { createTask, getTask, addActivity } = require('../tasks/store');
const { generatePlanId, savePlan, getPlan, listPlans, findOpenPlanForObjective } = require('./plans');

/** Roles that may submit or approve a delegation plan (brief §4, §6). */
const DELEGATION_ROLES = ['founder', 'admin', 'manager'];

const MAX_SUBTASKS = 12;

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

async function getChiefId(dataDir) {
  const employees = await listEmployees(dataDir);
  const chief = employees.find(e => e.employee_code === EMPLOYEE_CODES.CHIEF_OF_STAFF);
  if (chief) return chief.id;

  const created = await initializeEmployee(dataDir, EMPLOYEE_CODES.CHIEF_OF_STAFF);
  if (created && created.employee) return created.employee.id;
  throw new Error('Chief of Staff is not available in the employee registry');
}

/**
 * NVIDIA-only router. We reuse the existing router factory rather than
 * building a second one, but pin AI_PROVIDER=nvidia so this feature can never
 * silently drop to LM Studio (brief §2).
 */
function getNvidiaRouter(env = process.env) {
  const router = createRouterFromEnv({ ...env, AI_PROVIDER: 'nvidia' });
  if (router.providerName !== 'nvidia' || !router.providers.nvidia.isConfigured) {
    const err = new Error(
      'NVIDIA is not configured. Set NVIDIA_API_KEY to use Chief of Staff planning.'
    );
    err.code = 'nvidia_unavailable';
    err.status = 503;
    throw err;
  }
  return router;
}

/* ------------------------------------------------------------------ *
 * Authority
 * ------------------------------------------------------------------ */

async function checkDelegationAuthority(dataDir, userId) {
  const user = await authStore.findById(dataDir, userId);
  if (!user) return { ok: false, status: 404, reason: 'Initiating user not found' };
  const role = user.role || 'employee';
  if (!DELEGATION_ROLES.includes(role)) {
    return {
      ok: false,
      status: 403,
      reason: `Role "${role}" cannot delegate work. Founder, admin and manager can.`,
    };
  }
  return { ok: true, user, role };
}

/* ------------------------------------------------------------------ *
 * Verified employee registry
 * ------------------------------------------------------------------ */

/**
 * Build the candidate roster the model is allowed to choose from. Every entry
 * is read from a real store — nothing here is invented (brief §4).
 *
 * Two different questions, two different rules:
 *   - WHO MAY INITIATE/APPROVE → delegation roles only (checked separately).
 *   - WHO MAY RECEIVE WORK     → anyone the initiator holds authority over.
 * Filtering assignees by delegation role was wrong: a manager delegating to an
 * employee is exactly the normal case, so every assignable human is listed.
 */
async function buildRegistry(dataDir, chiefId, initiatorRole = 'founder') {
  const employees = await listEmployees(dataDir);
  const humans = await authStore.listUsers(dataDir);

  const ai = employees
    .filter(e => e.status === 'active' && e.employee_type === 'ai' && e.id !== chiefId)
    .map(e => ({
      id: e.id,
      code: e.employee_code,
      name: e.name,
      role: e.designation || 'AI employee',
      kind: 'ai',
      about: e.description || '',
      // Present in JSON mode, absent from the PG list query — use when we have it.
      skills: Array.isArray(e.capabilities) ? e.capabilities : [],
    }));

  // Brief §4: never assign outside the initiating user's authority.
  const human = humans
    .filter(u => canAssignRole(initiatorRole, u.role || 'employee'))
    .map(u => ({
      id: u.id,
      code: null,
      name: u.name,
      role: `${u.role || 'employee'} (human)`,
      kind: 'human',
      about: '',
      skills: [],
    }));

  return { candidates: [...human, ...ai], human, ai, initiatorRole };
}

/* ------------------------------------------------------------------ *
 * Model I/O helpers
 * ------------------------------------------------------------------ */

/** The model is asked for strict JSON; be forgiving about fences/prose. */
function parseModelJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function buildPrompt(input, registry) {
  const today = new Date().toISOString().slice(0, 10);
  const roster = registry.candidates
    .map((c) => {
      const bits = [`- id=${c.id}`, c.code ? `code=${c.code}` : null, c.name, c.role];
      if (c.skills && c.skills.length) bits.push(`skills: ${c.skills.join(', ')}`);
      if (c.about) bits.push(c.about);
      return bits.filter(Boolean).join(' | ');
    })
    .join('\n');

  return [
    'You are the Chief of Staff of a company. Decompose the objective below into a small set of subtasks that real employees can complete.',
    '',
    `Today's date is ${today}. Use it to convert due_in_days into calendar dates. Never ask for the date.`,
    '',
    'Rules:',
    '- assignee_id MUST be copied exactly from the roster. Never invent an id, skill or person.',
    '- The roster below is the complete company and everyone you may assign to. Do not ask for an employee list — it is printed below.',
    '- This company has NO teams, departments or reporting groups. There is no field that identifies "the sales team" or any other team. Assign by role and skill instead, and never put team identification in missing.',
    '- Only include a subtask you can assign to someone in the roster. If nobody fits, leave subtasks empty and explain in missing.',
    `- Never assign more than ${MAX_SUBTASKS} subtasks.`,
    '- depends_on is an array of 0-based indexes of earlier subtasks in your own list. A subtask may only depend on a lower index. No cycles.',
    '- due_in_days is an integer number of days from today, or null when there is no deadline.',
    '- priority is one of: low, medium, high, urgent.',
    '- missing is ONLY for information the human author must supply — for example the target audience, a budget, or which product. It must never contain the date, the roster, or anything printed in this prompt.',
    '- If the objective is clear enough to break into work, return an empty missing array and plan it. Do not stall on information you can infer.',
    '',
    'Reply with JSON only, no prose, in this exact shape:',
    '{',
    '  "summary": "one sentence restating the objective",',
    '  "missing": ["essential info the human must supply"],',
    '  "success_criteria": ["how we know this is done"],',
    '  "subtasks": [',
    '    {',
    '      "title": "short imperative title",',
    '      "description": "what to do and any constraint",',
    '      "assignee_id": "id from the roster",',
    '      "priority": "medium",',
    '      "due_in_days": 3,',
    '      "depends_on": [0],',
    '      "deliverable": "the concrete output expected"',
    '    }',
    '  ]',
    '}',
    '',
    `Roster (${registry.candidates.length} people — this is everyone):`,
    roster || '(empty — no employees available)',
    '',
    'Objective:',
    input.title,
    input.description ? `Detail: ${input.description}` : '',
    input.constraints?.length ? `Constraints: ${input.constraints.join('; ')}` : '',
    input.stakeholders?.length ? `Stakeholders: ${input.stakeholders.join(', ')}` : '',
    input.deadline ? `Deadline: ${new Date(input.deadline).toISOString().slice(0, 10)}` : 'Deadline: none given',
    `Priority requested: ${input.priority || 'medium'}`,
  ].filter(Boolean).join('\n');
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

function hasCycle(subtasks) {
  const state = new Array(subtasks.length).fill(0); // 0 unvisited, 1 visiting, 2 done
  const visit = (i) => {
    if (state[i] === 1) return true;
    if (state[i] === 2) return false;
    state[i] = 1;
    for (const dep of subtasks[i].depends_on || []) {
      if (dep > i) return true;      // forward edge → would be a cycle/ordering break
      if (dep < 0 || dep >= subtasks.length) return true; // dangling
      if (visit(dep)) return true;
    }
    state[i] = 2;
    return false;
  };
  return subtasks.some((_, i) => visit(i));
}

/**
 * Accept only picks that exist in the roster. Anything else is dropped rather
 * than trusted — the model never gets to introduce an employee (brief §4).
 */
function validatePicks(subtasks, registry) {
  const known = new Set(registry.candidates.map(c => c.id));
  const chief = registry.chiefId;
  const kept = [];
  const dropped = [];

  for (const s of subtasks) {
    if (!s.title || typeof s.title !== 'string') continue;
    if (!known.has(s.assignee_id) || s.assignee_id === chief) {
      dropped.push({ title: s.title, assignee_id: s.assignee_id || null });
      continue;
    }
    kept.push(s);
    if (kept.length >= MAX_SUBTASKS) break;
  }
  return { kept, dropped };
}

/* ------------------------------------------------------------------ *
 * Drafting
 * ------------------------------------------------------------------ */

/**
 * Turn the model's due_in_days into a timestamp, never later than the
 * objective's deadline and never before now. Due dates are a hard constraint
 * the model may not waive, so this is enforced here rather than trusted.
 */
function resolveDueDate(dueInDays, deadline, nowTs) {
  if (!Number.isFinite(dueInDays)) return null;
  let ts = nowTs + dueInDays * 86400000;
  if (deadline) ts = Math.min(ts, deadline);
  if (ts < nowTs) ts = nowTs;
  return ts;
}

async function draftPlan({ dataDir, input, userId, modelCall = null }) {
  const authority = await checkDelegationAuthority(dataDir, userId);
  if (!authority.ok) {
    const err = new Error(authority.reason);
    err.status = authority.status;
    err.code = 'not_authorized';
    throw err;
  }

  const title = String(input.title || '').trim();
  if (!title) {
    const err = new Error('An objective is required.');
    err.status = 400;
    err.code = 'objective_required';
    throw err;
  }

  const existing = await findOpenPlanForObjective(dataDir, title);
  if (existing) {
    const err = new Error(
      `An open plan already exists for this objective (${existing.id}). Review or close it first.`
    );
    err.status = 409;
    err.code = 'duplicate_objective';
    err.planId = existing.id;
    throw err;
  }

  const chiefId = await getChiefId(dataDir);
  const registry = await buildRegistry(dataDir, chiefId, authority.role);
  registry.chiefId = chiefId;

  const startedAt = Date.now();

  const normalized = {
    title,
    description: String(input.description || '').trim(),
    constraints: Array.isArray(input.constraints) ? input.constraints.slice(0, 20) : [],
    stakeholders: Array.isArray(input.stakeholders) ? input.stakeholders.slice(0, 20) : [],
    deadline: input.deadline ? new Date(input.deadline).getTime() : null,
    priority: ['low', 'medium', 'high', 'urgent'].includes(input.priority) ? input.priority : 'medium',
  };

  const messages = [
    { role: 'system', content: 'You plan work for a company. Output strict JSON only.' },
    { role: 'user', content: buildPrompt(normalized, registry) },
  ];

  // `modelCall` exists so automated tests can drive the workflow without a
  // network round trip. It is never passed by a route, and results produced
  // through it are labelled 'test-harness' so they can never be mistaken for
  // live NVIDIA evidence (brief §8).
  let result;
  let usingHarness = false;
  if (typeof modelCall === 'function') {
    usingHarness = true;
    result = await modelCall({ messages, max_tokens: 2200, temperature: 0.2 });
    result = { provider: 'test-harness', model: 'injected', ...result };
  } else {
    const router = getNvidiaRouter();
    result = await router.active.sendMessage({ messages, max_tokens: 2200, temperature: 0.2 });
  }

  const latencyMs = Date.now() - startedAt;
  const parsed = parseModelJson(result.content);

  if (!parsed) {
    // Model output wasn't parseable JSON. Check if it's prose that essentially
    // said "I need more info" (common with shorter prompts or team-based objectives).
    const rawContent = typeof result.content === 'string' 
      ? result.content.slice(0, 2000).toLowerCase() 
      : String(result.content).slice(0, 2000).toLowerCase();
    
    const canPlan = !rawContent.includes('cannot') 
      && !rawContent.includes('cant')
      && !rawContent.includes('unable to')
      && !rawContent.includes('not enough')
      && !rawContent.includes('need more information')
      && !rawContent.includes('insufficient')
      && !rawContent.includes('do not have enough');
    
    if (!canPlan || rawContent.includes('please provide') || rawContent.includes('i need')) {
      // Model is essentially asking for clarification in prose form.
      // Extract a readable reason from the raw output.
      const reasonMatch = rawContent.match(/(i need|please provide|cannot \w+|unable to \w+)[^.]*[\s\S]{0,200}/i);
      const reason = reasonMatch ? reasonMatch[0].trim() : 'insufficient information to plan';
      const err = new Error(`The Chief of Staff returned unparseable output, which appears to be a clarification request: "${reason}". Try again with more detail.`);
      err.status = 422;
      err.code = 'unparseable_clarification';
      err.rawContent = result.content?.slice(0, 500);
      throw err;
    }
    
    const err = new Error(`The Chief of Staff returned an unparseable plan. Try again. Raw response (truncated): ${rawContent.slice(0, 200)}`);
    err.status = 502;
    err.code = 'bad_model_output';
    err.rawContent = result.content?.slice(0, 500);
    throw err;
  }

  const missing = Array.isArray(parsed.missing) ? parsed.missing.filter(Boolean).map(String) : [];
  const rawSubs = Array.isArray(parsed.subtasks) ? parsed.subtasks : [];
  const { kept, dropped } = validatePicks(rawSubs, registry);

  // Brief §3 step 3 — ask when essential information is missing. But the
  // question is "is there anything a human could approve?", not "did the model
  // have a doubt". Blocking on a caveat while holding three concrete subtasks
  // would trap the author on items they cannot supply (the date, the roster),
  // so we only stop when there is nothing to put in front of them. Anything
  // the model was unsure about travels with the plan as a caveat to confirm
  // at approval — which is the human checkpoint anyway (brief §6).
  if (kept.length === 0) {
    return {
      status: 'needs_clarification',
      reason: missing.length
        ? 'essential_information_missing'
        : 'no_assignable_subtasks',
      missing,
      summary: String(parsed.summary || ''),
      successCriteria: Array.isArray(parsed.success_criteria) ? parsed.success_criteria.map(String) : [],
      provider: result.provider,
      model: result.model,
      latencyMs,
      planId: null,
    };
  }

  if (hasCycle(kept)) {
    const err = new Error('The generated plan had circular dependencies and was discarded.');
    err.status = 502;
    err.code = 'circular_plan';
    throw err;
  }

  const nowTs = Date.now();
  const plan = {
    id: generatePlanId(),
    status: 'draft',
    objective: normalized,
    analysis: {
      summary: String(parsed.summary || ''),
      successCriteria: Array.isArray(parsed.success_criteria) ? parsed.success_criteria.map(String) : [],
      droppedAssignees: dropped,
      // Non-blocking: things the model wanted confirmed before approval.
      caveats: missing,
    },
    subtasks: kept.map((s, i) => {
      // The model routinely overshoots: a live probe returned a subtask due 41
      // days out against a 10-day deadline. Clamp so no subtask can fall due
      // after the objective it belongs to, and never before today.
      const dueDateTs = resolveDueDate(s.due_in_days, normalized.deadline, nowTs);
      return {
        key: `s${i + 1}`,
        title: String(s.title).slice(0, 200),
        description: String(s.description || ''),
        assignee_id: s.assignee_id,
        assignee_name: registry.candidates.find(c => c.id === s.assignee_id)?.name || '',
        assignee_kind: registry.candidates.find(c => c.id === s.assignee_id)?.kind || 'ai',
        priority: ['low', 'medium', 'high', 'urgent'].includes(s.priority) ? s.priority : normalized.priority,
        due_in_days: dueDateTs ? Math.round((dueDateTs - nowTs) / 86400000) : null,
        due_date: dueDateTs,
        depends_on: Array.isArray(s.depends_on) ? s.depends_on.filter(n => Number.isInteger(n)) : [],
        deliverable: String(s.deliverable || ''),
        status: 'planned',
        task_id: null,
      };
    }),
    chief_id: chiefId,
    created_by: userId,
    created_by_role: authority.role,
    approved_by: null,
    approved_at: null,
    task_ids: [],
    // 'test-harness' means the model reply was injected by a test, never a
    // live NVIDIA call. Kept on the record so the two can never be confused.
    source: usingHarness ? 'test-harness' : 'live',
    audit: [
      {
        at: nowTs,
        actor: 'human',
        actor_id: userId,
        action: 'plan_drafted',
        detail: { subtasks: kept.length, provider: result.provider, model: result.model, latencyMs, source: usingHarness ? 'test-harness' : 'live' },
      },
    ],
    provider: result.provider,
    model: result.model,
    latency_ms: latencyMs,
    created_at: nowTs,
    updated_at: nowTs,
  };

  await savePlan(dataDir, plan);
  return { status: 'draft', plan };
}

/* ------------------------------------------------------------------ *
 * Approval / rejection
 * ------------------------------------------------------------------ */

async function approvePlan({ dataDir, planId, approverId }) {
  const plan = await getPlan(dataDir, planId);
  if (!plan) {
    const err = new Error('Plan not found.');
    err.status = 404;
    throw err;
  }
  // Authorise BEFORE inspecting state: an unprivileged caller must not be
  // able to learn a plan's status by probing for a 409 vs 403.
  const authority = await checkDelegationAuthority(dataDir, approverId);
  if (!authority.ok) {
    const err = new Error(authority.reason);
    err.status = authority.status;
    err.code = 'not_authorized';
    throw err;
  }

  if (plan.status !== 'draft') {
    const err = new Error(`Plan is already ${plan.status}; only a draft can be approved.`);
    err.status = 409;
    err.code = 'invalid_state';
    throw err;
  }

  // Create every subtask through the Central Task Engine (brief §5).
  const created = [];
  try {
    for (const sub of plan.subtasks) {
      const task = await createTask(dataDir, {
        title: sub.title,
        description: sub.description,
        assignedTo: { type: sub.assignee_kind === 'human' ? 'human' : 'ai', id: sub.assignee_id },
        assignedBy: { type: 'human', id: plan.created_by },
        priority: sub.priority,
        dueDate: sub.due_date ? new Date(sub.due_date).toISOString() : undefined,
        parentTaskId: plan.id,
        initiatingUserId: plan.created_by,
        expectedDeliverable: sub.deliverable,
        // Map draft indexes to the real ids of tasks created earlier in this
        // loop — dependencies are resolved in creation order.
        dependencies: sub.depends_on.map(i => plan.subtasks[i]?.key).filter(Boolean),
      });
      sub.task_id = task.id;
      sub.status = task.status || 'todo';
      created.push(task.id);
    }
  } catch (err) {
    // Roll back partial assignments so a failed approval never leaves a
    // half-created plan (no duplicate side effects on retry).
    for (const id of created) {
      try { require('../tasks/store').deleteTask(dataDir, id); } catch { /* best effort */ }
    }
    const e = new Error(`Approval failed and no tasks were kept: ${err.message}`);
    e.status = 500;
    e.code = 'approval_failed';
    throw e;
  }

  // Second pass: rewrite dependencies now that every task id is known.
  for (const sub of plan.subtasks) {
    if (!sub.task_id) continue;
    const depIds = sub.depends_on
      .map(i => plan.subtasks[i]?.task_id)
      .filter(Boolean);
    if (depIds.length) {
      try { await require('../tasks/store').updateTask(dataDir, sub.task_id, { dependencies: depIds }); }
      catch { /* non-fatal — dependency metadata is advisory */ }
    }
  }

  plan.status = 'approved';
  plan.approved_by = approverId;
  plan.approved_at = Date.now();
  plan.task_ids = created;
  plan.audit.push({
    at: plan.approved_at,
    actor: 'human',
    actor_id: approverId,
    action: 'plan_approved',
    detail: { tasks: created.length },
  });

  await savePlan(dataDir, plan);
  return { plan, created };
}

async function rejectPlan({ dataDir, planId, approverId, reason }) {
  const plan = await getPlan(dataDir, planId);
  if (!plan) {
    const err = new Error('Plan not found.');
    err.status = 404;
    throw err;
  }
  // Authorise before revealing state (same reason as approvePlan).
  const authority = await checkDelegationAuthority(dataDir, approverId);
  if (!authority.ok) {
    const err = new Error(authority.reason);
    err.status = authority.status;
    err.code = 'not_authorized';
    throw err;
  }
  if (plan.status !== 'draft') {
    const err = new Error(`Plan is already ${plan.status}; only a draft can be rejected.`);
    err.status = 409;
    err.code = 'invalid_state';
    throw err;
  }

  plan.status = 'rejected';
  plan.rejected_by = approverId;
  plan.rejected_at = Date.now();
  plan.rejection_reason = String(reason || '').slice(0, 500);
  plan.audit.push({
    at: plan.rejected_at,
    actor: 'human',
    actor_id: approverId,
    action: 'plan_rejected',
    detail: { reason: plan.rejection_reason },
  });

  await savePlan(dataDir, plan);
  return { plan };
}

/* ------------------------------------------------------------------ *
 * Monitoring
 * ------------------------------------------------------------------ */

const OVERDUE_STATUSES = ['todo', 'in_progress', 'pending', 'under_review'];

async function getPlanStatus({ dataDir, planId }) {
  const plan = await getPlan(dataDir, planId);
  if (!plan) {
    const err = new Error('Plan not found.');
    err.status = 404;
    throw err;
  }

  const subtasks = [];
  let completed = 0;
  let overdue = 0;
  let blocked = 0;
  const deliverables = [];

  for (const sub of plan.subtasks) {
    const task = sub.task_id ? await getTask(dataDir, sub.task_id) : null;
    const status = task ? task.status : sub.status;
    const isOverdue = !!task && OVERDUE_STATUSES.includes(status)
      && task.due_date && Number(task.due_date) < Date.now();

    if (status === 'completed') {
      completed += 1;
      if (sub.deliverable) deliverables.push({ title: sub.title, deliverable: sub.deliverable });
    }
    if (isOverdue) overdue += 1;
    if (status === 'pending') blocked += 1;

    subtasks.push({
      key: sub.key,
      title: sub.title,
      assignee_id: sub.assignee_id,
      assignee_name: sub.assignee_name,
      assignee_kind: sub.assignee_kind,
      priority: sub.priority,
      due_date: sub.due_date,
      deliverable: sub.deliverable,
      depends_on: sub.depends_on,
      task_id: sub.task_id,
      status,
      overdue: isOverdue,
      progress: status === 'completed' ? 100 : status === 'in_progress' ? 50 : 0,
      blocker: task && task.status === 'pending' ? task.pending_reason || 'Blocked' : null,
    });
  }

  const total = plan.subtasks.length;
  const progress = total ? Math.round((completed / total) * 100) : 0;
  const done = plan.status === 'rejected' || (total > 0 && completed === total);

  if (plan.status === 'approved' && done) {
    plan.status = 'completed';
    plan.completed_at = Date.now();
    plan.audit.push({ at: plan.completed_at, actor: 'system', actor_id: 'chief', action: 'plan_completed', detail: {} });
    await savePlan(dataDir, plan);
  }

  return {
    planId: plan.id,
    status: plan.status,
    objective: plan.objective,
    analysis: plan.analysis,
    created_by: plan.created_by,
    approved_by: plan.approved_by,
    created_at: plan.created_at,
    approved_at: plan.approved_at,
    provider: plan.provider,
    model: plan.model,
    latency_ms: plan.latency_ms,
    source: plan.source || 'live',
    summary: {
      total,
      completed,
      overdue,
      blocked,
      progress,
      remaining: total - completed,
    },
    subtasks,
    deliverables,
    audit: plan.audit,
  };
}

/* ------------------------------------------------------------------ *
 * Consolidated report
 * ------------------------------------------------------------------ */

async function buildReport({ dataDir, planId }) {
  const status = await getPlanStatus({ dataDir, planId });
  const plan = await getPlan(dataDir, planId);

  const lines = [];
  lines.push(`Objective: ${status.objective.title}`);
  if (status.analysis?.summary) lines.push(status.analysis.summary);
  lines.push('');
  lines.push(`Status: ${status.status}`);
  lines.push(
    `Subtasks: ${status.summary.completed} of ${status.summary.total} complete · ` +
    `${status.summary.overdue} overdue · ${status.summary.blocked} blocked`
  );

  if (status.deliverables.length) {
    lines.push('');
    lines.push('Completed deliverables:');
    for (const d of status.deliverables) lines.push(`- ${d.title}: ${d.deliverable}`);
  }

  const outstanding = status.subtasks.filter(s => s.status !== 'completed');
  if (outstanding.length) {
    lines.push('');
    lines.push('Still outstanding:');
    for (const s of outstanding) {
      const late = s.overdue ? ' (overdue)' : '';
      lines.push(`- ${s.title} — ${s.assignee_name} — ${s.status}${late}`);
    }
  }

  if (status.summary.progress < 100 && status.status !== 'rejected') {
    lines.push('');
    lines.push('This objective is not finished yet. Approve outstanding subtasks or reassign blocked work.');
  }

  return {
    planId,
    status: status.status,
    generated_at: Date.now(),
    report: lines.join('\n'),
    summary: status.summary,
    subtasks: status.subtasks,
    deliverables: status.deliverables,
    audit: plan ? plan.audit : [],
  };
}

async function getPlans(dataDir, filters) {
  return listPlans(dataDir, filters);
}

module.exports = {
  DELEGATION_ROLES,
  getChiefId,
  getNvidiaRouter,
  checkDelegationAuthority,
  buildRegistry,
  draftPlan,
  approvePlan,
  rejectPlan,
  getPlanStatus,
  buildReport,
  getPlans,
  getPlan,
  hasCycle,
  parseModelJson,
  buildPrompt,
};
