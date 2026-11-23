/**
 * AI Agent Runtime — shared execution engine for all AI employees (Phase 04.1).
 *
 * Server-side only. A human with authority starts a run for a task assigned
 * to an AI employee; the employee then works in a bounded tool-calling loop:
 *
 *   load employee (registry instructions) + task + allowed tools
 *   loop ≤ maxSteps rounds within a wall-clock budget:
 *     model call with tools
 *     read tool          → IntegrationManager.runTool(initiating user)
 *     task__* tool       → progress / request info / submit result
 *     write tool         → save an approval request + run state, STOP
 *
 * Safety invariants:
 *   • The agent acts on behalf of the INITIATING human and can only reach apps
 *     that human connected and authorized (runTool re-checks).
 *   • Tools are filtered by the employee's capabilities (toolPolicy), and the
 *     filter is re-applied at execution time.
 *   • Write tools never run without that human's explicit approval.
 *   • The agent never marks a task completed — it submits for human review.
 *   • Every tool call is written to the task activity log.
 */

const { createRouterFromEnv } = require('../services/ai/router');
const { resolveEmployee, validateTaskAssignment } = require('./context');
const { getTask, updateTask, addActivity, addComment, getTaskComments } = require('../tasks/store');
const { sendMessage } = require('../inbox/store');
const { getTool } = require('../integrations/tools');
const { NAME_TO_ID } = require('../agent/schemas');
const policy = require('./toolPolicy');
const approvals = require('./approvals');

const DEFAULT_MAX_STEPS = 10;
const HARD_MAX_STEPS = 20;
const RUN_BUDGET_MS = 240000;     // whole run
const MODEL_TIMEOUT_MS = 60000;   // one model call
const TOOL_RESULT_CAP = 6000;     // chars of a tool result fed back to the model

const OUTCOME = {
  SUBMITTED: 'submitted',
  NEEDS_APPROVAL: 'needs_approval',
  NEEDS_INFO: 'needs_info',
  FAILED: 'failed',
};

/** Fallback personas — used only when the registry has no system_instructions. */
const ROLE_DEFAULTS = {
  'AI-CHIEF-001': 'You are the Aculyze Chief of Staff AI. Lead the AI workforce, coordinate tasks, prepare reports, and serve as the primary interface between human managers and AI agents.',
  'AI-CUSTOMER-001': 'You are the Aculyze Customer Executive AI. You build and run customer-facing chatbots and work with company knowledge and leads.',
  'AI-EXEC-001': 'You are the Aculyze Executive AI. Manage task follow-up, communicate clearly, and produce operational reports.',
  default: 'You are an AI employee of Aculyze Studio. Execute your assigned task efficiently and clearly.',
};

const RUNTIME_RULES = `
How you work:
- You are executing ONE assigned task. Use your tools to gather real data; never invent facts, numbers, names or emails.
- Call only tools from the provided list. If a tool errors, adjust once or move on.
- Tools that send or create things (email, events, messages) pause for human approval — call them only when the task requires that action.
- Use task__report_progress for notable milestones (optional).
- If you are blocked on information only the requester has, call task__request_info.
- Be efficient: you have a limited number of steps. Prefer one or two well-aimed searches over many similar ones.
- Email search results include each message's [id: …] and a short preview. Previews are usually enough to summarize; open a message (get_message) only when you need its full text, and always pass the exact id from the results.
- Gmail search syntax examples: "newer_than:3d -category:promotions -category:social", "from:name@company.com", "is:unread".
- When done, ALWAYS call task__submit_result with a one-line summary and the full deliverable.`;

const WRAP_UP = 'You have no steps left. Do not gather more data. Call task__submit_result now with the best deliverable you can make from what you already found, and mention any gaps.';

/* ------------------------------------------------------------------ *
 * Prompt
 * ------------------------------------------------------------------ */

function systemPromptFor(employee) {
  const own = String((employee && employee.system_instructions) || '').trim();
  const persona = own || ROLE_DEFAULTS[employee && employee.employee_code] || ROLE_DEFAULTS.default;
  return `${persona}\n${RUNTIME_RULES}`;
}

function taskBrief(task, comments = []) {
  const lines = [
    'TASK ASSIGNED TO YOU',
    `Title: ${task.title}`,
    `Description: ${task.description || 'No description'}`,
  ];
  if (task.expected_deliverable) lines.push(`Expected deliverable: ${task.expected_deliverable}`);
  lines.push(`Priority: ${task.priority || 'medium'}`);
  lines.push(`Due: ${task.due_date ? new Date(Number(task.due_date)).toISOString() : 'Not set'}`);
  lines.push(`Today: ${new Date().toISOString().slice(0, 10)}`);
  const recent = (comments || []).slice(-5);
  if (recent.length) {
    lines.push('', 'RECENT COMMENTS (oldest first):');
    for (const c of recent) lines.push(`- [${c.author_type || 'user'}] ${String(c.content || '').slice(0, 600)}`);
  }
  return lines.join('\n');
}

/** Kept for compatibility with earlier callers/tests. */
function buildPrompt(employee, task, comments = []) {
  return [
    { role: 'system', content: systemPromptFor(employee) },
    { role: 'user', content: task ? taskBrief(task, comments) : 'No task context.' },
  ];
}

/** NVIDIA for complex work when configured, otherwise the active provider's default. */
function selectModel(router, employee, task) {
  const text = `${task.title || ''} ${task.description || ''}`.toLowerCase();
  const isComplex = task.priority === 'urgent' || task.priority === 'high'
    || /\b(analy[sz]e|research|complex|report)\b/.test(text);
  if (isComplex && router.providers.nvidia && router.providers.nvidia.isConfigured) {
    return { provider: router.providers.nvidia, model: router.providers.nvidia.defaultModel };
  }
  return { provider: router.active, model: (router.active && router.active.defaultModel) || undefined };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function toolPayload(res) {
  const out = {
    count: typeof res.count === 'number' ? res.count : undefined,
    summary: res.summary || undefined,
    text: res.text ? String(res.text).slice(0, TOOL_RESULT_CAP) : undefined,
    items: Array.isArray(res.items) ? res.items.slice(0, 5) : undefined,
    error: res.error || undefined,
  };
  try {
    return JSON.stringify(out).slice(0, TOOL_RESULT_CAP + 500);
  } catch {
    return '{"error":"unserializable tool result"}';
  }
}

async function notify(dataDir, employee, userId, body) {
  if (!userId) return;
  try {
    await sendMessage(dataDir, {
      from: employee.id,
      fromName: employee.name || 'AI Employee',
      to: `usr-${userId}`,
      toName: '',
      peerRole: employee.designation || 'AI Employee',
      body: String(body).slice(0, 3800),
      generated: true,
    });
  } catch (err) {
    console.warn(`[AI Runtime] inbox notify failed: ${err.message}`);
  }
}

async function log(dataDir, taskId, employeeId, action, details) {
  try {
    await addActivity(dataDir, { taskId, actorType: 'ai', actorId: employeeId, action, details });
  } catch (err) {
    console.warn(`[AI Runtime] activity log failed: ${err.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * The loop
 * ------------------------------------------------------------------ */

/**
 * Run (or resume) the tool loop. Returns an outcome object; never throws for
 * model/tool failures — those become OUTCOME.FAILED with the task blocked.
 */
async function runLoop(ctx) {
  const { dataDir, employee, task, uid, manager, provider, model, executionId, maxSteps } = ctx;
  const messages = ctx.messages;
  const steps = ctx.steps || [];
  const tools = policy.buildEmployeeTools(employee, manager ? manager.listApps(uid) : []);
  const deadline = Date.now() + RUN_BUDGET_MS;
  let lastText = '';

  for (let round = ctx.round || 0; round < maxSteps; round++) {
    if (Date.now() > deadline) break;

    // Last round: no more data gathering — only submitting is allowed.
    const lastRound = round === maxSteps - 1;
    const roundTools = lastRound ? tools.filter((t) => t.function.name === 'task__submit_result') : tools;
    if (lastRound) messages.push({ role: 'user', content: WRAP_UP });

    let res;
    try {
      res = await provider.sendMessage({
        messages,
        tools: roundTools,
        model,
        temperature: 0.2,
        max_tokens: 3000,
        thinking: false, // NVIDIA: hidden reasoning can eat the budget → empty answer
        timeoutMs: Math.min(MODEL_TIMEOUT_MS, Math.max(1000, deadline - Date.now())),
      });
    } catch (err) {
      return fail(ctx, steps, `Model call failed: ${err.message}`);
    }

    const calls = Array.isArray(res && res.toolCalls) ? res.toolCalls : [];
    if (res && res.content) lastText = String(res.content);
    if (!calls.length) {
      // No tools → the model's text is its deliverable.
      if (lastText.trim()) {
        return submit(ctx, steps, { summary: lastText.split('\n')[0].slice(0, 160), result: lastText });
      }
      return fail(ctx, steps, 'The model returned neither a result nor a tool call.');
    }

    messages.push({ role: 'assistant', content: res.content || null, tool_calls: calls });

    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      const name = (call && call.function && call.function.name) || '';
      const args = parseArgs(call && call.function && call.function.arguments);
      const callId = (call && call.id) || `${name}-${round}-${i}`;
      const reply = (content) => messages.push({ role: 'tool', tool_call_id: callId, content });

      // Only tools offered this round may run (the last round offers submit only).
      if (!roundTools.some((t) => t.function.name === name)) {
        steps.push({ tool: name, ok: false, text: lastRound ? 'out of steps' : 'not allowed' });
        if (!lastRound) await log(dataDir, task.id, employee.id, 'agent_tool_refused', { executionId, tool: name });
        reply(JSON.stringify({ error: lastRound ? 'No steps left. Call task__submit_result now.' : `Tool "${name}" is not available to you.` }));
        continue;
      }

      // ---- built-in task tools ----
      if (policy.TASK_TOOL_NAMES.has(name)) {
        if (name === 'task__submit_result') {
          return submit(ctx, steps, args);
        }
        if (name === 'task__request_info') {
          return requestInfo(ctx, steps, String(args.question || '').trim() || 'I need more information to continue.');
        }
        // report_progress
        const pct = Number.isFinite(Number(args.percent)) ? Math.max(0, Math.min(99, Math.round(Number(args.percent)))) : null;
        const note = String(args.note || '').slice(0, 1000);
        await log(dataDir, task.id, employee.id, 'agent_progress', { executionId, note, percent: pct });
        if (pct !== null) await updateTask(dataDir, task.id, { progress: pct });
        steps.push({ tool: name, ok: true, text: note });
        reply('{"ok":true}');
        continue;
      }

      // ---- integration tools ----
      const toolId = NAME_TO_ID.get(name);
      const def = toolId ? getTool(toolId) : null;
      if (!def || !policy.isAllowed(employee, toolId)) {
        steps.push({ tool: name, ok: false, text: 'not allowed' });
        await log(dataDir, task.id, employee.id, 'agent_tool_refused', { executionId, tool: name });
        reply(JSON.stringify({ error: `Tool "${name}" is not available to you.` }));
        continue;
      }

      if (def.kind === 'write') {
        // Answer any remaining calls in this round so the saved transcript is valid.
        for (let j = i + 1; j < calls.length; j++) {
          messages.push({
            role: 'tool',
            tool_call_id: (calls[j] && calls[j].id) || `skipped-${j}`,
            content: JSON.stringify({ error: 'Skipped: waiting for approval of an earlier action.' }),
          });
        }
        return requestApproval(ctx, steps, { toolId, args, callId, round: round + 1 });
      }

      try {
        const out = await manager.runTool(uid, toolId, args);
        const count = typeof out.count === 'number' ? out.count : null;
        steps.push({ tool: toolId, ok: true, text: out.summary || (count !== null ? `${count} ${def.unit || 'results'}` : def.done || 'done') });
        await log(dataDir, task.id, employee.id, 'agent_tool_call', { executionId, tool: toolId, count });
        reply(toolPayload(out));
      } catch (err) {
        const msg = String((err && err.message) || 'tool failed').slice(0, 300);
        steps.push({ tool: toolId, ok: false, text: msg });
        await log(dataDir, task.id, employee.id, 'agent_tool_error', { executionId, tool: toolId, error: msg });
        reply(JSON.stringify({ error: msg }));
      }
    }
  }

  // Out of steps: one final tool-free call asking for the deliverable from
  // everything gathered so far, so a run that collected data still finishes.
  if (!lastText.trim() && Date.now() < deadline) {
    try {
      messages.push({ role: 'user', content: `${WRAP_UP} Reply with the deliverable as plain text.` });
      const res = await provider.sendMessage({
        messages: messages.filter((m) => !m.tool_calls).map((m) => (m.role === 'tool' ? { role: 'user', content: `Tool result: ${m.content}` } : m)),
        model,
        temperature: 0.2,
        max_tokens: 3000,
        thinking: false,
        timeoutMs: Math.min(MODEL_TIMEOUT_MS, Math.max(1000, deadline - Date.now())),
      });
      const text = String((res && res.content) || '').trim();
      if (text && !(res.toolCalls && res.toolCalls.length)) {
        return submit(ctx, steps, { summary: text.split('\n')[0].slice(0, 160), result: text });
      }
    } catch (err) {
      console.warn(`[AI Runtime] final wrap-up call failed: ${err.message}`);
    }
  }

  // Out of steps/time: submit whatever the model last said, else block.
  if (lastText.trim()) {
    return submit(ctx, steps, { summary: 'Partial result (step limit reached)', result: lastText });
  }
  return fail(ctx, steps, 'Step limit reached without a result.');
}

async function submit(ctx, steps, { summary, result }) {
  const { dataDir, employee, task, executionId, initiatingUserId } = ctx;
  const sum = String(summary || 'Task result').slice(0, 200);
  const body = String(result || summary || '').slice(0, 20000);
  await addComment(dataDir, { taskId: task.id, authorType: 'ai', authorId: employee.id, content: `**Result submitted for review:** ${sum}\n\n${body}` });
  await updateTask(dataDir, task.id, { status: 'under_review', pending_reason: null, progress: 100 });
  await log(dataDir, task.id, employee.id, 'agent_submitted', { executionId, summary: sum, steps: steps.length });
  await notify(dataDir, employee, initiatingUserId, `✅ I finished "${task.title}" and submitted it for your review.\n\n${sum}`);
  return { outcome: OUTCOME.SUBMITTED, summary: sum, result: body, steps };
}

async function requestInfo(ctx, steps, question) {
  const { dataDir, employee, task, executionId, initiatingUserId } = ctx;
  await addComment(dataDir, { taskId: task.id, authorType: 'ai', authorId: employee.id, content: `**Question:** ${question}` });
  await updateTask(dataDir, task.id, { status: 'pending', pending_reason: 'waiting_for_info' });
  await log(dataDir, task.id, employee.id, 'agent_requested_info', { executionId, question: question.slice(0, 500) });
  await notify(dataDir, employee, initiatingUserId, `❓ I need information to continue "${task.title}":\n\n${question}\n\nReply in the task comments, then run the task again.`);
  return { outcome: OUTCOME.NEEDS_INFO, question, steps };
}

async function requestApproval(ctx, steps, { toolId, args, callId, round }) {
  const { dataDir, employee, task, executionId, initiatingUserId, manager, uid } = ctx;
  let confirm = null;
  try {
    const conf = await manager.buildConfirmation(uid, { tool: toolId, args });
    if (conf && conf.confirm) confirm = conf.confirm;
    else if (conf && conf.notice) {
      // Not connected/authorized → tell the model and keep going is not possible
      // after we've returned; treat as a failed step the human can fix.
      return fail(ctx, steps, conf.notice);
    }
  } catch (err) {
    return fail(ctx, steps, `Could not prepare ${toolId}: ${err.message}`);
  }
  const approval = approvals.createApproval(dataDir, {
    taskId: task.id,
    employeeId: employee.id,
    initiatingUserId,
    executionId,
    tool: toolId,
    args: (confirm && confirm.args) || args,
    toolCallId: callId,
    confirm,
    state: { messages: ctx.messages, steps, round, model: ctx.model, providerKey: ctx.providerKey },
  });
  steps.push({ tool: toolId, ok: true, text: 'waiting for approval' });
  await updateTask(dataDir, task.id, { status: 'pending', pending_reason: 'awaiting_approval' });
  await log(dataDir, task.id, employee.id, 'agent_approval_requested', { executionId, tool: toolId, approvalId: approval.id });
  await notify(dataDir, employee, initiatingUserId,
    `🔐 Approval needed for "${task.title}": ${(confirm && confirm.title) || toolId}\nOpen the task to approve or reject.`);
  return { outcome: OUTCOME.NEEDS_APPROVAL, approval: approvals.publicView(approval), steps };
}

async function fail(ctx, steps, reason) {
  const { dataDir, employee, task, executionId } = ctx;
  await updateTask(dataDir, task.id, { status: 'pending', pending_reason: 'blocked' });
  await log(dataDir, task.id, employee.id, 'execution_failed', { executionId, error: String(reason).slice(0, 500) });
  return { outcome: OUTCOME.FAILED, error: String(reason), steps };
}

/* ------------------------------------------------------------------ *
 * Public entry points
 * ------------------------------------------------------------------ */

function pickProvider(opts, employee, task) {
  if (opts.provider) {
    return { provider: opts.provider, model: opts.model, providerKey: 'injected', providerName: opts.provider.name || 'injected' };
  }
  const router = createRouterFromEnv(process.env);
  const sel = selectModel(router, employee, task);
  const providerKey = sel.provider === router.providers.nvidia ? 'nvidia' : 'active';
  return { provider: sel.provider, model: sel.model, providerKey, providerName: providerKey === 'nvidia' ? 'nvidia' : router.providerName };
}

function providerFromKey(opts, key) {
  if (opts.provider) return opts.provider;
  const router = createRouterFromEnv(process.env);
  return key === 'nvidia' ? router.providers.nvidia : router.active;
}

/**
 * Execute a task for an AI employee.
 *
 * @param {string} dataDir
 * @param {object} o
 * @param {string} o.employeeId        verified AI employee id
 * @param {string} o.taskId
 * @param {string} o.initiatingUserId  the human who started the run (their app connections are used)
 * @param {object} [o.manager]         IntegrationManager (none → task tools only)
 * @param {object} [o.provider]        AI provider override (tests)
 * @param {number} [o.maxSteps]
 */
async function executeTask(dataDir, opts) {
  const { employeeId, taskId, initiatingUserId, manager = null } = opts;
  const startTime = Date.now();
  const executionId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const empResult = await resolveEmployee(dataDir, employeeId);
  if (!empResult.valid) throw new Error(`Invalid employee: ${empResult.reason}`);
  const employee = empResult.employee;

  const taskResult = await validateTaskAssignment(dataDir, employeeId, taskId);
  if (!taskResult.valid) throw new Error(`Task validation failed: ${taskResult.reason}`);
  const task = taskResult.task;

  if (approvals.listApprovals(dataDir, { taskId, status: approvals.STATUS.PENDING }).length) {
    const err = new Error('This task has an action waiting for approval. Approve or reject it first.');
    err.status = 409;
    throw err;
  }

  const sel = pickProvider(opts, employee, task);
  const comments = await getTaskComments(dataDir, taskId).catch(() => []);
  const maxSteps = Math.max(1, Math.min(HARD_MAX_STEPS, Number(opts.maxSteps) || DEFAULT_MAX_STEPS));

  await updateTask(dataDir, taskId, { status: 'in_progress', pending_reason: null });
  await log(dataDir, taskId, employeeId, 'execution_started', { executionId, provider: sel.providerName, model: sel.model, initiatingUserId });

  const out = await runLoop({
    dataDir, employee, task, manager,
    uid: initiatingUserId, initiatingUserId,
    provider: sel.provider, model: sel.model, providerKey: sel.providerKey,
    executionId, maxSteps,
    messages: buildPrompt(employee, task, comments),
    steps: [], round: 0,
  });

  return {
    executionId,
    employeeId,
    employeeCode: employee.employee_code,
    taskId,
    provider: sel.providerName,
    model: sel.model,
    startTime,
    elapsedMs: Date.now() - startTime,
    ...out,
  };
}

/**
 * Approve or reject a paused write action, then resume the run.
 * Only the human who started the run may decide (it runs on their account).
 */
async function decideAndResume(dataDir, opts) {
  const { approvalId, userId, approve, reason = '', manager } = opts;
  const pending = approvals.getApproval(dataDir, approvalId);
  if (!pending) throw Object.assign(new Error('Approval not found'), { status: 404 });
  if (pending.initiatingUserId !== userId) {
    throw Object.assign(new Error('Only the person who started this run can decide on it.'), { status: 403 });
  }
  const decided = approvals.decideApproval(dataDir, approvalId, {
    status: approve ? approvals.STATUS.APPROVED : approvals.STATUS.REJECTED,
    userId,
    reason: reason ? String(reason).slice(0, 500) : null,
  });
  if (!decided) throw Object.assign(new Error('This approval was already decided.'), { status: 409 });

  const empResult = await resolveEmployee(dataDir, decided.employeeId);
  if (!empResult.valid) throw Object.assign(new Error(`Invalid employee: ${empResult.reason}`), { status: 409 });
  const employee = empResult.employee;
  const task = await getTask(dataDir, decided.taskId);
  if (!task || ['completed', 'cancelled'].includes(task.status)) {
    approvals.clearState(dataDir, approvalId);
    throw Object.assign(new Error('The task is no longer open.'), { status: 409 });
  }

  const state = decided.state || { messages: [], steps: [], round: 0 };
  const messages = state.messages || [];
  let toolContent;
  if (approve) {
    try {
      const res = await manager.execute(userId, { tool: decided.tool, args: decided.args, confirm: true });
      toolContent = JSON.stringify({ ok: true, summary: res.summary || 'done' });
      await log(dataDir, task.id, employee.id, 'agent_action_approved', { executionId: decided.executionId, tool: decided.tool, approvalId, summary: res.summary });
      (state.steps || []).push({ tool: decided.tool, ok: true, text: `approved — ${res.summary || 'done'}` });
    } catch (err) {
      const msg = String((err && err.message) || 'action failed').slice(0, 300);
      approvals.clearState(dataDir, approvalId, { status: approvals.STATUS.FAILED, reason: msg });
      toolContent = JSON.stringify({ error: `Approved, but the action failed: ${msg}` });
      await log(dataDir, task.id, employee.id, 'agent_tool_error', { executionId: decided.executionId, tool: decided.tool, error: msg });
      (state.steps || []).push({ tool: decided.tool, ok: false, text: msg });
    }
  } else {
    toolContent = JSON.stringify({ error: `The requester rejected this action.${reason ? ` Reason: ${String(reason).slice(0, 300)}` : ''} Do not retry it; adjust or submit what you have.` });
    await log(dataDir, task.id, employee.id, 'agent_action_rejected', { executionId: decided.executionId, tool: decided.tool, approvalId, reason });
    (state.steps || []).push({ tool: decided.tool, ok: false, text: 'rejected' });
  }
  messages.push({ role: 'tool', tool_call_id: decided.toolCallId || decided.tool, content: toolContent });
  approvals.clearState(dataDir, approvalId);

  await updateTask(dataDir, task.id, { status: 'in_progress', pending_reason: null });
  const provider = providerFromKey(opts, state.providerKey);
  const out = await runLoop({
    dataDir, employee, task, manager,
    uid: userId, initiatingUserId: userId,
    provider, model: opts.provider ? opts.model : state.model, providerKey: state.providerKey,
    executionId: decided.executionId,
    maxSteps: Math.max(1, Math.min(HARD_MAX_STEPS, Number(opts.maxSteps) || DEFAULT_MAX_STEPS)),
    messages, steps: state.steps || [], round: state.round || 0,
  });
  return { executionId: decided.executionId, taskId: task.id, approval: approvals.publicView(approvals.getApproval(dataDir, approvalId)), ...out };
}

/** Manual completion by the owning AI (kept for compatibility). */
async function completeTask(dataDir, { employeeId, taskId, result }) {
  const task = await getTask(dataDir, taskId);
  if (!task) throw new Error('Task not found');
  if (task.assigned_to_type !== 'ai' || task.assigned_to_id !== employeeId) {
    throw new Error('Not authorized to complete this task');
  }
  await updateTask(dataDir, taskId, { status: 'completed', completed_at: Date.now() });
  await log(dataDir, taskId, employeeId, 'completed', { result });
  await addComment(dataDir, { taskId, authorType: 'ai', authorId: employeeId, content: `Task completed.\n\n${result}` });
  return { success: true, taskId };
}

module.exports = {
  OUTCOME,
  executeTask,
  decideAndResume,
  completeTask,
  buildPrompt,
  systemPromptFor,
  selectModel,
};
