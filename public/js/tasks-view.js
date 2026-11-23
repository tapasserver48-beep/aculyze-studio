/**
 * Tasks page — workload bar, filterable table / board, task side panel
 * (details, comments, activity), new task, exports and monthly report.
 *
 * Talks only to the existing /api/tasks endpoints. Permissions are enforced
 * server-side; the UI just avoids offering what the server would refuse.
 */

import {
  tasksList, tasksCreate, tasksUpdate, tasksDelete, tasksMonthlyReport,
  tasksAddComment, tasksActivity, tasksPeople, tasksComments,
  agentExecute, agentApprovals, agentDecide,
} from './api.js';
import {
  STATUS_LABEL, PRIORITY_LABEL, PENDING_REASON_LABEL, LOAD_STATES,
  isOpen, isLate, loadState, countLoad, workloadBarHtml, dueText,
  shortDate, dateTime, relativeTime, toDateInput, fromDateInput, initials,
  escapeHtml as esc,
} from './work-ui.js';

const MANAGER_ROLES = ['admin', 'founder', 'manager'];
const DELETE_ROLES = ['admin', 'founder'];
const BOARD_COLUMNS = ['todo', 'in_progress', 'pending', 'under_review', 'completed'];
const LAYOUT_KEY = 'aculyze.tasks.layout';

const ACTIVITY_LABEL = {
  create: 'created the task',
  acknowledge: 'started work',
  progress_update: 'updated progress',
  status_change: 'changed the status',
  report_blocker: 'reported a blocker',
  add_comment: 'commented',
  chief_followup_nudge: 'asked for an update (Chief of Staff)',
  chief_followup_reassign: 'reassigned the task (Chief of Staff)',
  execution_started: 'started working on the task',
  execution_failed: 'got stuck and needs help',
  agent_tool_call: 'used a connected app',
  agent_tool_error: 'hit an error in a connected app',
  agent_tool_refused: 'tried a tool it is not allowed to use',
  agent_progress: 'reported progress',
  agent_requested_info: 'asked a question',
  agent_approval_requested: 'asked for approval',
  agent_action_approved: 'ran an approved action',
  agent_action_rejected: 'had an action rejected',
  agent_submitted: 'submitted a result for review',
};

const AI_OUTCOME_TEXT = {
  submitted: 'Result submitted for your review. See the comments below.',
  needs_approval: 'Waiting for your approval before it continues.',
  needs_info: 'The AI employee asked a question. See the comments below.',
  failed: 'The run stopped before finishing.',
};

export function initTasksView({ toast, confirm, getUser }) {
  const $ = (id) => document.getElementById(id);
  const root = $('view-tasks');
  if (!root) return { refresh: async () => {} };

  const state = {
    tasks: [],
    people: new Map(),
    loaded: false,
    filters: { q: '', assignee: '', status: '', priority: '', kind: '', load: '' },
    layout: readLayout(),
    drawerTaskId: null,
    drawerOpener: null,
  };

  /* ---------------- helpers ---------------- */
  const user = () => getUser() || {};
  const canManage = () => MANAGER_ROLES.includes(user().role);
  const canDelete = () => DELETE_ROLES.includes(user().role);
  const person = (id) => state.people.get(id);
  const personName = (id) => person(id)?.name || 'Unknown person';

  function readLayout() {
    try { return localStorage.getItem(LAYOUT_KEY) === 'board' ? 'board' : 'table'; } catch { return 'table'; }
  }
  function saveLayout(v) { try { localStorage.setItem(LAYOUT_KEY, v); } catch { /* private mode */ } }

  function sortTasks(list) {
    const now = Date.now();
    const rank = (t) => (isLate(t, now) ? 0 : isOpen(t) ? 1 : 2);
    return [...list].sort((a, b) => rank(a) - rank(b)
      || (Number(a.due_date) || Infinity) - (Number(b.due_date) || Infinity)
      || Number(b.created_at || 0) - Number(a.created_at || 0));
  }

  function filtered() {
    const f = state.filters;
    const q = f.q.trim().toLowerCase();
    const now = Date.now();
    return state.tasks.filter((t) => {
      if (f.assignee && t.assigned_to_id !== f.assignee) return false;
      if (f.status && t.status !== f.status) return false;
      if (f.priority && t.priority !== f.priority) return false;
      if (f.kind && t.assigned_to_type !== f.kind) return false;
      if (f.load && loadState(t, now) !== f.load) return false;
      if (q) {
        const hay = `${t.title || ''} ${t.description || ''} ${t.task_code || t.id} ${personName(t.assigned_to_id)}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function activeFilterCount() {
    return Object.values(state.filters).filter(Boolean).length;
  }

  /* ---------------- data ---------------- */
  async function refresh() {
    if (!getUser()) return;
    try {
      const [taskData, peopleData] = await Promise.all([
        tasksList({ limit: 1000 }),
        tasksPeople().catch(() => ({ people: [] })),
      ]);
      state.tasks = taskData.tasks || [];
      state.people = new Map((peopleData.people || []).map((p) => [p.id, p]));
      state.loaded = true;
      fillPeopleSelects();
      render();
      if ($('tmReports')?.open) loadReport();
    } catch (err) {
      $('tmSummary').textContent = 'Tasks could not be loaded. Check your connection and refresh.';
      toast(err.message || 'Tasks could not be loaded', 'error');
    }
  }

  function fillPeopleSelects() {
    const sorted = [...state.people.values()].sort((a, b) => a.name.localeCompare(b.name));
    const opts = (first) => `<option value="">${first}</option>`
      + `<optgroup label="People">${sorted.filter((p) => p.kind === 'human').map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</optgroup>`
      + `<optgroup label="AI employees">${sorted.filter((p) => p.kind === 'ai').map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</optgroup>`;
    const a = $('tmAssignee');
    if (a) { a.innerHTML = opts('Everyone'); a.value = state.filters.assignee; }
    const r = $('tmReportPerson');
    if (r) { const v = r.value; r.innerHTML = opts('Whole company'); r.value = v; }
  }

  /* ---------------- render ---------------- */
  function render() {
    const now = Date.now();
    const counts = countLoad(state.tasks, now);
    const open = LOAD_STATES.reduce((n, s) => n + counts[s.key], 0);

    // Summary sentence: the first thing to read.
    const bits = [];
    if (counts.late) bits.push(`${counts.late} late`);
    if (counts.blocked) bits.push(`${counts.blocked} blocked`);
    $('tmSummary').textContent = !state.tasks.length
      ? 'No tasks yet. Create one to get started.'
      : open === 0
        ? 'Everything is done. Nothing open right now.'
        : `${open} open task${open === 1 ? '' : 's'}${bits.length ? `, ${bits.join(' and ')}` : ', all on schedule'}.`;

    $('tmBar').innerHTML = workloadBarHtml(counts);
    $('tmLegend').innerHTML = LOAD_STATES.map((s) => `
      <button type="button" class="wl-key wl-key-${s.key}" data-tm-load="${s.key}"
        aria-pressed="${state.filters.load === s.key}" ${counts[s.key] ? '' : 'disabled'}>
        <span class="wl-swatch wl-${s.key}" aria-hidden="true"></span>
        <span class="wl-key-label">${s.label}</span>
        <span class="wl-key-count">${counts[s.key]}</span>
      </button>`).join('');

    const list = sortTasks(filtered());
    const count = activeFilterCount();
    $('tmClear').hidden = count === 0;
    $('tmResultCount').textContent = count
      ? `Showing ${list.length} of ${state.tasks.length}`
      : `${state.tasks.length} task${state.tasks.length === 1 ? '' : 's'}`;

    const empty = $('tmEmpty');
    if (!list.length) {
      empty.hidden = false;
      empty.innerHTML = state.tasks.length
        ? 'No tasks match these filters. <button type="button" class="link-btn" data-tm-clear>Clear filters</button>'
        : 'No tasks yet. Use <strong>New task</strong> to assign the first one.';
    } else {
      empty.hidden = true;
    }

    const board = state.layout === 'board';
    $('tmTableWrap').hidden = board || !list.length;
    $('tmBoard').hidden = !board || !state.tasks.length;
    root.querySelectorAll('[data-tm-layout]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tmLayout === state.layout)));

    if (board) renderBoard(filtered()); else renderTable(list);
  }

  function assigneeHtml(t) {
    const p = person(t.assigned_to_id);
    const kind = (p?.kind || t.assigned_to_type) === 'ai' ? 'AI employee' : 'Person';
    return `<span class="tm-who">
      <span class="tm-avatar tm-avatar-${(p?.kind || t.assigned_to_type) === 'ai' ? 'ai' : 'human'}" aria-hidden="true">${esc(initials(p?.name))}</span>
      <span class="tm-who-text"><span class="tm-who-name">${esc(personName(t.assigned_to_id))}</span><span class="tm-who-kind">${kind}</span></span>
    </span>`;
  }

  function statusHtml(t) {
    const reason = t.status === 'pending' && t.pending_reason ? PENDING_REASON_LABEL[t.pending_reason] : '';
    return `<span class="tm-status tm-status-${esc(t.status)}">${esc(STATUS_LABEL[t.status] || t.status)}</span>`
      + (reason && reason !== 'Blocked' ? `<span class="tm-sub">${esc(reason)}</span>` : '');
  }

  function priorityHtml(t) {
    const p = t.priority || 'medium';
    return `<span class="tm-pri tm-pri-${esc(p)}"><span class="tm-pri-mark" aria-hidden="true"></span>${esc(PRIORITY_LABEL[p] || p)}</span>`;
  }

  function dueHtml(t) {
    const d = dueText(t);
    return `<span class="tm-due tm-due-${d.tone}">${esc(d.text)}</span>`;
  }

  function renderTable(list) {
    $('tmRows').innerHTML = list.map((t) => `
      <tr data-tm-open="${esc(t.id)}" tabindex="0" class="${isLate(t) ? 'is-late' : ''} ${isOpen(t) ? '' : 'is-closed'}">
        <td data-label="Task">
          <span class="tm-title">${esc(t.title || 'Untitled')}</span>
          <span class="tm-sub">${esc(t.task_code || t.id)}</span>
        </td>
        <td data-label="Assignee">${assigneeHtml(t)}</td>
        <td data-label="Priority">${priorityHtml(t)}</td>
        <td data-label="Status">${statusHtml(t)}</td>
        <td data-label="Due">${dueHtml(t)}</td>
      </tr>`).join('');
  }

  function renderBoard(list) {
    const now = Date.now();
    const recentDone = (t) => Number(t.completed_at || t.updated_at || 0) > now - 14 * 86400000;
    $('tmBoard').innerHTML = BOARD_COLUMNS.map((status) => {
      let items = sortTasks(list.filter((t) => t.status === status));
      let note = '';
      if (status === 'completed') {
        const all = items.length;
        items = items.filter(recentDone).slice(0, 20);
        if (all > items.length) note = `<p class="tm-col-note">Showing work finished in the last 14 days.</p>`;
      }
      return `<section class="tm-col" data-tm-drop="${status}" aria-label="${STATUS_LABEL[status]}">
        <header class="tm-col-head"><h3>${STATUS_LABEL[status]}</h3><span class="tm-col-count">${items.length}</span></header>
        <div class="tm-col-body">
          ${items.map((t) => `
            <article class="tm-card ${isLate(t) ? 'is-late' : ''}" draggable="true" data-tm-open="${esc(t.id)}" data-tm-drag="${esc(t.id)}" tabindex="0">
              <h4 class="tm-card-title">${esc(t.title || 'Untitled')}</h4>
              <div class="tm-card-meta">${priorityHtml(t)}${dueHtml(t)}</div>
              ${assigneeHtml(t)}
            </article>`).join('') || '<p class="tm-col-empty">Nothing here</p>'}
          ${note}
        </div>
      </section>`;
    }).join('');
  }

  /* ---------------- board drag and drop ---------------- */
  let dragId = null;
  $('tmBoard').addEventListener('dragstart', (e) => {
    const card = e.target.closest('[data-tm-drag]');
    if (!card) return;
    dragId = card.dataset.tmDrag;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
    card.classList.add('is-dragging');
  });
  $('tmBoard').addEventListener('dragend', (e) => {
    e.target.closest('[data-tm-drag]')?.classList.remove('is-dragging');
    root.querySelectorAll('.tm-col.is-over').forEach((c) => c.classList.remove('is-over'));
  });
  $('tmBoard').addEventListener('dragover', (e) => {
    const col = e.target.closest('[data-tm-drop]');
    if (!col || !dragId) return;
    e.preventDefault();
    root.querySelectorAll('.tm-col.is-over').forEach((c) => c !== col && c.classList.remove('is-over'));
    col.classList.add('is-over');
  });
  $('tmBoard').addEventListener('drop', async (e) => {
    const col = e.target.closest('[data-tm-drop]');
    if (!col || !dragId) return;
    e.preventDefault();
    col.classList.remove('is-over');
    const task = state.tasks.find((t) => t.id === dragId);
    const status = col.dataset.tmDrop;
    dragId = null;
    if (!task || task.status === status) return;
    const prev = task.status;
    task.status = status; // optimistic
    render();
    try {
      const { task: saved } = await tasksUpdate(task.id, { status });
      Object.assign(task, saved);
      toast(`Moved to ${STATUS_LABEL[status]}`, 'success');
      render();
    } catch (err) {
      task.status = prev;
      render();
      toast(err.message || 'That task could not be moved', 'error');
    }
  });

  /* ---------------- side panel ---------------- */
  const drawer = $('tmDrawer');
  const scrim = $('tmScrim');
  // The page sits inside containers that break position:fixed, so the panel
  // lives directly under <body> to cover the whole window.
  document.body.append(scrim, drawer);
  // ...which means it must close itself when the user navigates away.
  new MutationObserver(() => {
    if (!root.classList.contains('active') && !drawer.hidden) closeDrawer();
  }).observe(root, { attributes: true, attributeFilter: ['class'] });

  function openDrawer(opener) {
    state.drawerOpener = opener || document.activeElement;
    drawer.hidden = false;
    scrim.hidden = false;
    document.body.classList.add('work-drawer-open');
    requestAnimationFrame(() => drawer.classList.add('is-open'));
    document.addEventListener('keydown', drawerKeys);
  }

  function closeDrawer() {
    drawer.classList.remove('is-open');
    drawer.hidden = true;
    scrim.hidden = true;
    document.body.classList.remove('work-drawer-open');
    state.drawerTaskId = null;
    document.removeEventListener('keydown', drawerKeys);
    state.drawerOpener?.focus?.();
  }

  function drawerKeys(e) {
    if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); return; }
    if (e.key !== 'Tab') return;
    const f = [...drawer.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.disabled && el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function peopleOptions(selected) {
    const sorted = [...state.people.values()].sort((a, b) => a.name.localeCompare(b.name));
    const opt = (p) => `<option value="${esc(p.kind)}:${esc(p.id)}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}</option>`;
    return `<option value="" disabled ${selected ? '' : 'selected'}>Choose someone</option>`
      + `<optgroup label="People">${sorted.filter((p) => p.kind === 'human').map(opt).join('')}</optgroup>`
      + `<optgroup label="AI employees">${sorted.filter((p) => p.kind === 'ai').map(opt).join('')}</optgroup>`;
  }

  function formHtml(t, { isNew }) {
    const manage = isNew || canManage();
    const dis = manage ? '' : 'disabled';
    const status = t.status || 'todo';
    return `
      <form class="tm-form" id="tmForm" novalidate>
        <label class="tm-field">
          <span>Title</span>
          <input name="title" type="text" maxlength="300" required value="${esc(t.title || '')}" ${dis}
            placeholder="What needs to be done">
        </label>
        <label class="tm-field">
          <span>Details</span>
          <textarea name="description" rows="4" maxlength="5000" placeholder="Context, links, what done looks like">${esc(t.description || '')}</textarea>
        </label>
        <div class="tm-field-row">
          <label class="tm-field">
            <span>Assignee</span>
            <select name="assignee" required ${dis}>${peopleOptions(t.assigned_to_id)}</select>
          </label>
          <label class="tm-field">
            <span>Due date</span>
            <input name="due" type="date" value="${toDateInput(t.due_date)}" ${dis}>
          </label>
        </div>
        <div class="tm-field-row">
          <label class="tm-field">
            <span>Priority</span>
            <select name="priority" ${dis}>
              ${Object.entries(PRIORITY_LABEL).map(([k, v]) => `<option value="${k}" ${k === (t.priority || 'medium') ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
          </label>
          ${isNew ? '' : `<label class="tm-field">
            <span>Status</span>
            <select name="status">
              ${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${k === status ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
          </label>`}
        </div>
        ${isNew ? '' : `<label class="tm-field" data-tm-reason ${status === 'pending' ? '' : 'hidden'}>
          <span>What is it waiting on?</span>
          <select name="pending_reason">
            ${Object.entries(PENDING_REASON_LABEL).map(([k, v]) => `<option value="${k}" ${k === t.pending_reason ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
        </label>`}
        ${manage ? '' : '<p class="tm-hint">You can update the status and details of your own task. A manager can change the rest.</p>'}
        <p class="tm-form-error" id="tmFormError" role="alert" hidden></p>
        <div class="tm-form-actions">
          <button type="submit" class="utility-primary" id="tmSave">${isNew ? 'Create task' : 'Save changes'}</button>
          ${!isNew && canDelete() ? '<button type="button" class="tm-danger-link" id="tmDelete">Delete task</button>' : ''}
        </div>
      </form>`;
  }

  function openNew(opener) {
    state.drawerTaskId = null;
    $('tmDrawerTitle').textContent = 'New task';
    $('tmDrawerMeta').textContent = 'Assign work to a person or an AI employee.';
    $('tmDrawerBody').innerHTML = formHtml({}, { isNew: true });
    openDrawer(opener);
    wireForm(null);
    drawer.querySelector('[name="title"]')?.focus();
  }

  async function openTask(id, opener) {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;
    state.drawerTaskId = id;
    $('tmDrawerTitle').textContent = t.title || 'Untitled';
    const by = t.assigned_by_id ? `Assigned by ${personName(t.assigned_by_id)}` : '';
    $('tmDrawerMeta').textContent = [t.task_code || t.id, by, t.created_at ? `created ${shortDate(t.created_at)}` : ''].filter(Boolean).join(', ');
    const aiRunnable = t.assigned_to_type === 'ai' && canManage() && !['completed', 'cancelled'].includes(t.status);
    $('tmDrawerBody').innerHTML = `
      ${formHtml(t, { isNew: false })}
      ${aiRunnable ? `
      <section class="tm-thread tm-ai" aria-labelledby="tmAiHead">
        <h3 id="tmAiHead">AI employee</h3>
        <p class="tm-ai-note">${esc(personName(t.assigned_to_id))} works with the apps you have connected. Anything that sends or creates something waits for your approval.</p>
        <div id="tmAiApproval"></div>
        <div class="tm-ai-actions">
          <button type="button" class="utility-primary" id="tmAiRun">Run with AI</button>
        </div>
        <div id="tmAiResult" aria-live="polite"></div>
      </section>` : ''}
      <section class="tm-thread" aria-labelledby="tmCommentsHead">
        <h3 id="tmCommentsHead">Comments</h3>
        <ol class="tm-comments" id="tmComments"><li class="tm-loading">Loading comments…</li></ol>
        <form class="tm-comment-form" id="tmCommentForm">
          <label class="sr-only" for="tmCommentText">Add a comment</label>
          <textarea id="tmCommentText" rows="2" maxlength="2000" placeholder="Write an update or ask a question"></textarea>
          <button type="submit" class="utility-secondary">Post comment</button>
        </form>
      </section>
      <section class="tm-thread" aria-labelledby="tmActivityHead">
        <h3 id="tmActivityHead">Activity</h3>
        <ol class="tm-activity" id="tmActivity"><li class="tm-loading">Loading activity…</li></ol>
      </section>`;
    openDrawer(opener);
    wireForm(t);
    if (aiRunnable) wireAi(t);
    $('tmDrawerClose').focus();
    loadThread(t.id);
  }

  /* ---------------- AI employee runs (Phase 04.1) ---------------- */
  function aiStepsHtml(steps) {
    if (!steps || !steps.length) return '';
    return `<ol class="tm-ai-steps">${steps.map((s) => `<li class="${s.ok ? 'is-ok' : 'is-err'}">
      <span aria-hidden="true">${s.ok ? '✓' : '⚠'}</span> <code>${esc(s.tool)}</code> ${esc(s.text || '')}</li>`).join('')}</ol>`;
  }

  function showAiOutcome(data) {
    const box = $('tmAiResult');
    if (!box) return;
    const msg = AI_OUTCOME_TEXT[data.outcome] || 'Run finished.';
    const err = data.outcome === 'failed' && data.error ? `<p class="tm-ai-error">${esc(data.error)}</p>` : '';
    box.innerHTML = `<p class="tm-ai-outcome is-${esc(data.outcome || 'unknown')}">${esc(msg)}</p>${err}${aiStepsHtml(data.steps)}`;
  }

  async function loadApproval(task) {
    const slot = $('tmAiApproval');
    const run = $('tmAiRun');
    if (!slot) return;
    let pending = [];
    try { pending = (await agentApprovals(task.id)).approvals || []; } catch { /* leave empty */ }
    if (state.drawerTaskId !== task.id) return;
    const a = pending[0];
    if (run) run.hidden = !!a || task.pending_reason === 'awaiting_approval';
    if (!a) {
      slot.innerHTML = task.pending_reason === 'awaiting_approval'
        ? '<p class="tm-ai-note">An action is waiting for approval by the person who started this run.</p>'
        : '';
      return;
    }
    const c = a.confirm || {};
    const rows = (c.preview || []).map((p) => `<dt>${esc(p.label || '')}</dt><dd>${esc(p.value || '')}</dd>`).join('');
    slot.innerHTML = `<div class="tm-ai-approval" role="group" aria-labelledby="tmAiApprTitle">
        <p class="tm-ai-appr-title" id="tmAiApprTitle">${esc(c.icon || '🔐')} ${esc(c.title || `Run ${a.tool}?`)}</p>
        ${rows ? `<dl class="tm-ai-preview">${rows}</dl>` : `<pre class="tm-ai-args">${esc(JSON.stringify(a.args, null, 2))}</pre>`}
        <label class="sr-only" for="tmAiReason">Reason for rejecting (optional)</label>
        <input id="tmAiReason" type="text" maxlength="300" placeholder="Reason if you reject (optional)">
        <div class="tm-ai-actions">
          <button type="button" class="utility-secondary" data-ai-decide="reject">Reject</button>
          <button type="button" class="utility-primary" data-ai-decide="approve">${esc(c.verb || 'Approve')}</button>
        </div>
      </div>`;
    slot.querySelectorAll('[data-ai-decide]').forEach((btn) => btn.addEventListener('click', async () => {
      const approve = btn.dataset.aiDecide === 'approve';
      slot.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      $('tmAiResult').innerHTML = `<p class="tm-loading">${approve ? 'Running the approved action and continuing…' : 'Sending your feedback and continuing…'}</p>`;
      try {
        const data = await agentDecide(a.id, approve, $('tmAiReason')?.value || '');
        showAiOutcome(data);
        toast(approve ? 'Approved' : 'Rejected', 'success');
      } catch (ex) {
        $('tmAiResult').innerHTML = `<p class="tm-ai-error">${esc(ex.message)}</p>`;
      }
      await afterAiRun(task);
    }));
  }

  async function afterAiRun(task) {
    await refresh();
    const fresh = state.tasks.find((x) => x.id === task.id);
    if (fresh) Object.assign(task, fresh);
    if (state.drawerTaskId !== task.id) return;
    loadThread(task.id);
    loadApproval(task);
  }

  function wireAi(task) {
    loadApproval(task);
    $('tmAiRun')?.addEventListener('click', async () => {
      const btn = $('tmAiRun');
      btn.disabled = true;
      btn.textContent = 'Working…';
      $('tmAiResult').innerHTML = '<p class="tm-loading">The AI employee is working on this task. This can take a minute.</p>';
      try {
        const data = await agentExecute(task.assigned_to_id, task.id);
        showAiOutcome(data);
      } catch (ex) {
        $('tmAiResult').innerHTML = `<p class="tm-ai-error">${esc(ex.message)}</p>`;
      } finally {
        btn.disabled = false;
        btn.textContent = 'Run again';
      }
      await afterAiRun(task);
    });
  }

  async function loadThread(id) {
    const [c, a] = await Promise.all([
      tasksComments(id).catch(() => null),
      tasksActivity(id).catch(() => null),
    ]);
    if (state.drawerTaskId !== id) return;
    const comments = c?.comments || [];
    $('tmComments').innerHTML = c === null
      ? '<li class="tm-loading">Comments could not be loaded.</li>'
      : comments.length
        ? comments.map((m) => `<li class="tm-comment">
            <span class="tm-avatar tm-avatar-${m.author_type === 'ai' ? 'ai' : 'human'}" aria-hidden="true">${esc(initials(personName(m.author_id)))}</span>
            <div><p class="tm-comment-head"><strong>${esc(personName(m.author_id))}</strong> <time datetime="${new Date(Number(m.created_at)).toISOString()}" title="${esc(dateTime(m.created_at))}">${esc(relativeTime(m.created_at))}</time></p>
            <p class="tm-comment-body">${esc(m.content)}</p></div>
          </li>`).join('')
        : '<li class="tm-loading">No comments yet.</li>';
    const activity = (a?.activity || []).slice().sort((x, y) => Number(y.created_at) - Number(x.created_at));
    $('tmActivity').innerHTML = activity.length
      ? activity.map((ev) => `<li><strong>${esc(personName(ev.actor_id))}</strong> ${esc(ACTIVITY_LABEL[ev.action] || String(ev.action).replace(/_/g, ' '))}
          <time title="${esc(dateTime(ev.created_at))}">${esc(relativeTime(ev.created_at))}</time></li>`).join('')
      : '<li class="tm-loading">No activity recorded yet.</li>';
  }

  function wireForm(task) {
    const form = $('tmForm');
    const status = form.querySelector('[name="status"]');
    status?.addEventListener('change', () => {
      const reason = form.querySelector('[data-tm-reason]');
      if (reason) reason.hidden = status.value !== 'pending';
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('tmFormError');
      err.hidden = true;
      const fd = new FormData(form);
      const title = String(fd.get('title') || '').trim();
      const assignee = String(fd.get('assignee') || '');
      if (!task || canManage()) {
        if (!title) { showFormError('Give the task a title.'); form.querySelector('[name="title"]').focus(); return; }
        if (!assignee) { showFormError('Choose who the task is for.'); form.querySelector('[name="assignee"]').focus(); return; }
      }
      const [kind, id] = assignee.split(':');
      const save = $('tmSave');
      save.disabled = true;
      try {
        if (!task) {
          const due = fromDateInput(fd.get('due'));
          await tasksCreate({
            title,
            description: String(fd.get('description') || '').trim(),
            assignedTo: { type: kind, id },
            priority: fd.get('priority'),
            dueDate: due ? new Date(due).toISOString() : undefined,
          });
          toast('Task created', 'success');
          closeDrawer();
        } else {
          const updates = {};
          const desc = String(fd.get('description') || '');
          if (desc !== (task.description || '')) updates.description = desc;
          const st = fd.get('status');
          if (st && st !== task.status) updates.status = st;
          if (st === 'pending') {
            const r = fd.get('pending_reason');
            if (r && r !== task.pending_reason) updates.pending_reason = r;
          }
          if (canManage()) {
            if (title !== task.title) updates.title = title;
            if (id && id !== task.assigned_to_id) { updates.assigned_to_id = id; updates.assigned_to_type = kind; }
            if (fd.get('priority') !== task.priority) updates.priority = fd.get('priority');
            const due = fromDateInput(fd.get('due'));
            if (toDateInput(due) !== toDateInput(task.due_date)) updates.due_date = due;
          }
          if (!Object.keys(updates).length) { toast('No changes to save', 'info'); save.disabled = false; return; }
          const { task: saved } = await tasksUpdate(task.id, updates);
          Object.assign(task, saved);
          toast('Changes saved', 'success');
          $('tmDrawerTitle').textContent = task.title || 'Untitled';
          loadThread(task.id);
        }
        await refresh();
      } catch (ex) {
        showFormError(ex.message || 'That could not be saved.');
      } finally {
        save.disabled = false;
      }
    });

    $('tmDelete')?.addEventListener('click', async () => {
      const ok = await confirm({
        title: 'Delete this task?',
        detail: `"${task.title}" and its comments will be removed for everyone. This cannot be undone.`,
        okLabel: 'Delete task',
        cancelLabel: 'Keep task',
      });
      if (!ok) return;
      try {
        await tasksDelete(task.id);
        toast('Task deleted', 'info');
        closeDrawer();
        await refresh();
      } catch (ex) {
        showFormError(ex.message || 'The task could not be deleted.');
      }
    });

    $('tmCommentForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const box = $('tmCommentText');
      const content = box.value.trim();
      if (!content) { box.focus(); return; }
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      try {
        await tasksAddComment(task.id, content);
        box.value = '';
        loadThread(task.id);
      } catch (ex) {
        toast(ex.message || 'The comment could not be posted', 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }

  function showFormError(msg) {
    const err = $('tmFormError');
    err.textContent = msg;
    err.hidden = false;
  }

  /* ---------------- exports ---------------- */
  function exportRows() {
    return sortTasks(filtered()).map((t) => ({
      Task: t.title,
      ID: t.task_code || t.id,
      Assignee: personName(t.assigned_to_id),
      Type: t.assigned_to_type === 'ai' ? 'AI employee' : 'Person',
      'Assigned by': personName(t.assigned_by_id),
      Priority: PRIORITY_LABEL[t.priority] || t.priority,
      Status: STATUS_LABEL[t.status] || t.status,
      Due: shortDate(t.due_date),
      Completed: shortDate(t.completed_at),
    }));
  }

  function loadXlsx() {
    if (window.XLSX) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('The spreadsheet exporter could not be downloaded. Check your connection and try again.'));
      document.head.appendChild(s);
    });
  }

  async function exportXlsx() {
    try { await loadXlsx(); } catch (err) { toast(err.message, 'error'); return; }
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.json_to_sheet(exportRows()), 'Tasks');
    window.XLSX.writeFile(wb, `tasks-${toDateInput(Date.now())}.xlsx`);
    toast('Spreadsheet downloaded', 'success');
  }

  function exportPdf() {
    const rows = exportRows();
    const w = window.open('', '_blank');
    if (!w) { toast('Allow pop-ups for this site to print the task list.', 'error'); return; }
    const cols = ['Task', 'Assignee', 'Priority', 'Status', 'Due'];
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Tasks, ${esc(shortDate(Date.now()))}</title>
      <style>body{font:13px/1.45 system-ui,sans-serif;color:#111;margin:32px}h1{font-size:20px;margin:0 0 4px}
      p{color:#555;margin:0 0 16px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #ddd}
      th{font-size:12px;color:#444}</style></head><body>
      <h1>Tasks</h1><p>${rows.length} task${rows.length === 1 ? '' : 's'}, printed ${esc(dateTime(Date.now()))}</p>
      <table><thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table>
      </body></html>`);
    w.document.close();
    w.focus();
    w.print();
  }

  /* ---------------- monthly report ---------------- */
  async function loadReport() {
    const monthVal = $('tmReportMonth').value || toDateInput(Date.now()).slice(0, 7);
    const [year, month] = monthVal.split('-').map(Number);
    const employeeId = $('tmReportPerson').value || undefined;
    const body = $('tmReportRows');
    try {
      const { report } = await tasksMonthlyReport({ year, month, employeeId });
      const s = report?.stats;
      const label = new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      if (!s || !s.total) {
        $('tmReportSummary').textContent = `No tasks were created in ${label}${employeeId ? ` for ${personName(employeeId)}` : ''}.`;
        body.innerHTML = '';
        $('tmReportTable').hidden = true;
        return;
      }
      $('tmReportSummary').textContent =
        `${label}: ${s.total} task${s.total === 1 ? '' : 's'} created, ${s.completed} done (${s.completedRate}%), ${s.overdue} late.`;
      $('tmReportTable').hidden = false;
      const rows = Object.entries(s.by_employee || {}).map(([key, v]) => ({ id: key.split(':').slice(1).join(':'), ...v }))
        .sort((a, b) => b.total - a.total);
      body.innerHTML = rows.map((r) => {
        const pct = r.total ? Math.round((r.completed / r.total) * 100) : 0;
        return `<tr>
          <td data-label="Person">${esc(personName(r.id))}</td>
          <td data-label="Assigned" class="num">${r.total}</td>
          <td data-label="Done" class="num">${r.completed}</td>
          <td data-label="Late" class="num">${r.overdue}</td>
          <td data-label="Completion"><span class="tm-rate"><span class="tm-rate-bar"><span style="width:${pct}%"></span></span><span class="num">${pct}%</span></span></td>
        </tr>`;
      }).join('');
    } catch (err) {
      $('tmReportSummary').textContent = err.status === 403
        ? 'Monthly reports are available to managers, admins and founders.'
        : 'The report could not be loaded. Try again.';
      $('tmReportTable').hidden = true;
    }
  }

  /* ---------------- wiring ---------------- */
  const setFilter = (key, value) => { state.filters[key] = value; render(); };
  let searchTimer;
  $('tmSearch').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => setFilter('q', e.target.value), 120);
  });
  $('tmAssignee').addEventListener('change', (e) => setFilter('assignee', e.target.value));
  $('tmStatus').addEventListener('change', (e) => setFilter('status', e.target.value));
  $('tmPriority').addEventListener('change', (e) => setFilter('priority', e.target.value));
  $('tmKind').addEventListener('change', (e) => setFilter('kind', e.target.value));

  function clearFilters() {
    state.filters = { q: '', assignee: '', status: '', priority: '', kind: '', load: '' };
    ['tmSearch', 'tmAssignee', 'tmStatus', 'tmPriority', 'tmKind'].forEach((id) => { $(id).value = ''; });
    render();
  }

  root.addEventListener('click', (e) => {
    const load = e.target.closest('[data-tm-load]');
    if (load) { setFilter('load', state.filters.load === load.dataset.tmLoad ? '' : load.dataset.tmLoad); return; }
    if (e.target.closest('[data-tm-clear]') || e.target.closest('#tmClear')) { clearFilters(); return; }
    const layout = e.target.closest('[data-tm-layout]');
    if (layout) { state.layout = layout.dataset.tmLayout; saveLayout(state.layout); render(); return; }
    const exp = e.target.closest('[data-tm-export]');
    if (exp) {
      exp.closest('details')?.removeAttribute('open');
      if (exp.dataset.tmExport === 'xlsx') exportXlsx(); else exportPdf();
      return;
    }
    if (e.target.closest('#tmNew')) { openNew(e.target.closest('#tmNew')); return; }
    const row = e.target.closest('[data-tm-open]');
    if (row && !drawer.contains(row)) openTask(row.dataset.tmOpen, row);
  });
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('[data-tm-open]');
    if (row && e.target === row) { e.preventDefault(); openTask(row.dataset.tmOpen, row); }
  });
  $('tmDrawerClose').addEventListener('click', closeDrawer);
  scrim.addEventListener('click', closeDrawer);

  $('tmReportMonth').value = toDateInput(Date.now()).slice(0, 7);
  $('tmReports').addEventListener('toggle', () => { if ($('tmReports').open) loadReport(); });
  $('tmReportMonth').addEventListener('change', loadReport);
  $('tmReportPerson').addEventListener('change', loadReport);

  // Close the export menu when clicking elsewhere.
  document.addEventListener('click', (e) => {
    const menu = $('tmExport');
    if (menu?.open && !menu.contains(e.target)) menu.removeAttribute('open');
  });

  /** Show one person's tasks (used by Chief of Staff "View tasks"). */
  function showAssignee(id) {
    clearFilters();
    state.filters.assignee = id;
    $('tmAssignee').value = id;
    render();
  }

  return { refresh, openTask, showAssignee };
}
