/**
 * Chief of Staff page — three tabs:
 *   Team       what is late, blocked or quiet, and follow-ups to send
 *   Plan work  objective → plan → approval → report (nothing is assigned
 *              until "Approve and create tasks" is pressed)
 *   Plans      every objective handed over so far
 */

import {
  chiefDraftPlan, chiefPlans, chiefPlan, chiefApprove, chiefReject, chiefReport,
  chiefStaff, chiefFollowups,
} from './api.js';
import { STATUS_LABEL, workloadBarHtml, dueText, shortDate, dateTime, initials, relativeTime, escapeHtml as esc } from './work-ui.js';

const STEPS = ['objective', 'plan', 'approval', 'report'];
const PLAN_STATUS = {
  draft: 'Waiting for your approval',
  approved: 'Approved, tasks created',
  rejected: 'Rejected',
  executing: 'In progress',
  completed: 'Completed',
  needs_clarification: 'Needs more detail',
};
const HEALTH = {
  at_risk: { label: 'Needs a decision', tone: 'late' },
  check_in: { label: 'Check in', tone: 'blocked' },
  busy: { label: 'Busy', tone: 'review' },
  on_track: { label: 'On track', tone: 'ok' },
  idle: { label: 'Free', tone: 'idle' },
};
const REASON = { overdue: 'Late', blocked: 'Blocked', stalled: 'No update in 3+ days' };

export function initChiefView({ toast, showTasksFor }) {
  const $ = (id) => document.getElementById(id);
  const root = $('view-chief');
  if (!root) return { onOpen: () => {} };

  let planId = null;
  let busy = false;
  let attention = [];
  let staff = [];
  let kindFilter = '';
  let tab = 'team';

  /* ---------------- tabs ---------------- */
  function setTab(next, { focus = false } = {}) {
    tab = next;
    root.querySelectorAll('[data-cs-tab]').forEach((b) => {
      const on = b.dataset.csTab === next;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
    root.querySelectorAll('[data-cs-panel]').forEach((p) => { p.hidden = p.dataset.csPanel !== next; });
    if (next === 'team') loadStaff();
    if (next === 'history') loadHistory();
  }

  /* ---------------- Team ---------------- */
  async function loadStaff() {
    const panel = $('csTeamBody');
    let data;
    try {
      data = await chiefStaff();
    } catch (err) {
      panel.innerHTML = `<p class="work-empty">${esc(err.message || 'The team view could not be loaded.')}</p>`;
      $('csSummary').textContent = 'Hand over objectives and keep work moving.';
      return;
    }
    staff = data.staff || [];
    attention = data.attention || [];
    const t = data.totals;
    const needDecision = staff.filter((s) => s.health === 'at_risk').length;
    const checkIn = staff.filter((s) => s.health === 'check_in').length;
    const free = staff.filter((s) => s.health === 'idle').length;
    const parts = [];
    if (needDecision) parts.push(`${needDecision} need${needDecision === 1 ? 's' : ''} a decision`);
    if (checkIn) parts.push(`${checkIn} could use a check-in`);
    if (free) parts.push(`${free} free for new work`);
    $('csSummary').textContent = `${t.employees} people and AI employees, ${t.open} open tasks. `
      + (parts.length ? `${parts.join(', ')}.` : 'Everyone is on track.');
    $('csAttentionCount').textContent = attention.length ? String(attention.length) : '';
    renderAttention();
    renderPeople();
  }

  function renderAttention() {
    const list = $('csAttention');
    if (!attention.length) {
      list.innerHTML = '<li class="cs-calm">Nothing is late, blocked or quiet. No follow-ups needed.</li>';
      $('csBulk').hidden = true;
      return;
    }
    $('csBulk').hidden = false;
    list.innerHTML = attention.map((a, i) => {
      const due = dueText({ due_date: a.due_date, status: a.status });
      const s = a.suggestion;
      const action = s.type === 'reassign' ? `Reassign to ${s.assignee.name}` : 'Ask for an update';
      return `<li class="cs-item">
        <input type="checkbox" class="cs-check" data-cs-pick="${i}" id="csPick${i}" aria-label="Select: ${esc(a.title)}">
        <div class="cs-item-main">
          <label for="csPick${i}" class="cs-item-title">${esc(a.title)}</label>
          <p class="cs-item-meta">
            <span>${esc(a.assignee.name)}</span>
            ${a.reasons.filter((r) => r !== 'overdue') /* the due text already says "N days late" */
              .map((r) => `<span class="cs-reason cs-reason-${r}">${esc(REASON[r] || r)}</span>`).join('')}
            <span class="tm-due tm-due-${due.tone}">${esc(due.text)}</span>
          </p>
        </div>
        <button type="button" class="utility-secondary cs-act" data-cs-act="${i}">${esc(action)}</button>
      </li>`;
    }).join('');
    syncBulk();
  }

  function renderPeople() {
    const shown = staff.filter((s) => !kindFilter || s.kind === kindFilter);
    const order = { at_risk: 0, check_in: 1, busy: 2, on_track: 3, idle: 4 };
    shown.sort((a, b) => (order[a.health] - order[b.health]) || (b.open - a.open) || a.name.localeCompare(b.name));
    root.querySelectorAll('[data-cs-kind]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.csKind === kindFilter)));
    $('csPeople').innerHTML = shown.map((s) => {
      const h = HEALTH[s.health] || HEALTH.on_track;
      const facts = [];
      facts.push(`${s.open} open`);
      if (s.overdue) facts.push(`${s.overdue} late`);
      if (s.blocked) facts.push(`${s.blocked} blocked`);
      if (s.stalled) facts.push(`${s.stalled} quiet`);
      const done = s.completed_30d
        ? `${s.completed_30d} done this month${s.on_time_rate !== null ? `, ${s.on_time_rate}% on time` : ''}`
        : 'Nothing finished this month';
      return `<li class="cs-person cs-tone-${h.tone}">
        <div class="cs-person-head">
          <span class="tm-avatar tm-avatar-${s.kind}" aria-hidden="true">${esc(initials(s.name))}</span>
          <div class="cs-person-id">
            <h4>${esc(s.name)}</h4>
            <p>${s.kind === 'ai' ? 'AI employee' : esc(String(s.role || '').replace(/\s*\(human\)$/, ''))}</p>
          </div>
          <span class="cs-health">${esc(h.label)}</span>
        </div>
        ${workloadBarHtml(s.load || {}, { label: `${s.name}'s open work`, size: 'sm' })}
        <p class="cs-person-facts">${esc(facts.join(', '))}</p>
        <p class="cs-person-done">${esc(done)}${s.last_activity ? `. Last update ${esc(relativeTime(s.last_activity))}` : ''}</p>
        <button type="button" class="link-btn" data-cs-tasks="${esc(s.id)}">View tasks</button>
      </li>`;
    }).join('') || '<li class="work-empty">No one in this group.</li>';
  }

  function syncBulk() {
    const n = root.querySelectorAll('[data-cs-pick]:checked').length;
    const btn = $('csSendBtn');
    btn.disabled = n === 0;
    btn.textContent = n ? `Send ${n} follow-up${n === 1 ? '' : 's'}` : 'Send selected follow-ups';
  }

  async function sendFollowups(items, btn) {
    if (!items.length) return;
    if (btn) btn.disabled = true;
    try {
      const actions = items.map((a) => (a.suggestion.type === 'reassign'
        ? { taskId: a.task_id, type: 'reassign', assigneeId: a.suggestion.assignee.id }
        : { taskId: a.task_id, type: 'nudge' }));
      const { applied, results } = await chiefFollowups(actions);
      const skipped = results.filter((r) => !r.ok);
      toast(skipped.length
        ? `${applied} sent. ${skipped.length} skipped: ${skipped[0].error}`
        : `${applied} follow-up${applied === 1 ? '' : 's'} sent`, skipped.length ? 'info' : 'success');
    } catch (err) {
      toast(err.message || 'Follow-ups could not be sent', 'error');
    } finally {
      if (btn) btn.disabled = false;
      await loadStaff();
    }
  }

  /* ---------------- Plan work ---------------- */
  function setStep(step) {
    const idx = STEPS.indexOf(step);
    root.querySelectorAll('#chiefSteps .chief-step').forEach((li, i) => {
      li.classList.toggle('is-current', i === idx);
      li.classList.toggle('is-done', i > -1 && i < idx);
      if (i === idx) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });
  }

  function showError(msg) {
    const el = $('chiefError');
    el.hidden = !msg;
    el.textContent = msg || '';
  }

  function clarify(missing, mode = 'blocking') {
    const box = $('chiefClarify');
    const list = $('chiefMissing');
    if (!missing || !missing.length) { box.hidden = true; list.innerHTML = ''; return; }
    const advisory = mode === 'advisory';
    box.dataset.mode = mode;
    $('chiefClarifyTitle').textContent = advisory
      ? 'Confirm these when you review the plan'
      : 'A few details are missing before this can be planned';
    $('chiefClarifyHint').innerHTML = advisory
      ? 'The plan is ready to approve. Check these points first.'
      : 'Add what you can under <strong>Detail and constraints</strong>, then draft again.';
    list.innerHTML = missing.map((m) => `<li>${esc(m)}</li>`).join('');
    box.hidden = false;
  }

  function stepFor(status) {
    if (status === 'draft' || status === 'needs_clarification') return 'plan';
    if (status === 'completed' || status === 'rejected') return 'report';
    return 'approval';
  }

  function renderPlan(plan) {
    planId = plan.planId;
    const chip = $('chiefStatus');
    chip.textContent = PLAN_STATUS[plan.status] || plan.status;
    chip.dataset.state = plan.status;
    $('chiefSummary').hidden = false;
    // Viewing a plan: the plan takes the full width; "Plan new work" brings the form back.
    $('chiefCompose').hidden = true;
    root.querySelector('.cs-plan-layout').classList.add('is-viewing');
    $('chiefPlanTitle').textContent = plan.objective?.title || '';
    $('chiefSummaryText').textContent = plan.analysis?.summary || '';
    clarify(plan.analysis?.caveats, 'advisory');

    const s = plan.summary || { total: 0, completed: 0, blocked: 0, overdue: 0, progress: 0 };
    $('chiefStatTotal').textContent = s.total;
    $('chiefStatDone').textContent = s.completed;
    $('chiefStatBlocked').textContent = s.blocked;
    $('chiefStatOverdue').textContent = s.overdue;
    const pct = Math.max(0, Math.min(100, Number(s.progress) || 0));
    $('chiefProgress').setAttribute('aria-valuenow', String(pct));
    $('chiefProgressFill').style.width = `${pct}%`;
    $('chiefProgressText').textContent = `${pct}% complete`;
    $('chiefProvider').textContent = plan.source === 'test-harness'
      ? 'Drafted by the test harness'
      : plan.model ? `Drafted by ${plan.model}${plan.latency_ms ? ` in ${(plan.latency_ms / 1000).toFixed(1)} s` : ''}` : '';

    const canApprove = plan.status === 'draft';
    $('chiefApprovalActions').hidden = !canApprove;
    $('chiefReportActions').hidden = canApprove;
    renderSubtasks(plan.subtasks || []);
    setStep(stepFor(plan.status));
  }

  function renderSubtasks(subtasks) {
    const wrap = $('chiefSubtasks');
    if (!subtasks.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    const byKey = new Map(subtasks.map((t, i) => [String(t.key ?? i + 1), i + 1]));
    $('chiefSubtaskBody').innerHTML = subtasks.map((t, i) => {
      const deps = (t.depends_on || []).map((d) => `Step ${esc(byKey.get(String(d)) || d)}`).join(', ');
      const due = t.due_date ? shortDate(t.due_date) : 'No due date';
      return `<li class="cs-sub ${t.overdue ? 'is-late' : ''}">
        <span class="cs-sub-num" aria-hidden="true">${i + 1}</span>
        <div class="cs-sub-main">
          <h4>${esc(t.title)}</h4>
          <p class="cs-sub-deliv">${esc(t.deliverable || '')}</p>
          <p class="cs-sub-meta">
            <span>${esc(t.assignee_name)} (${t.assignee_kind === 'human' ? 'person' : 'AI employee'})</span>
            <span>${esc(due)}</span>
            ${deps ? `<span>After ${deps}</span>` : ''}
          </p>
        </div>
        <span class="tm-status tm-status-${esc(t.status)}">${esc(t.overdue ? 'Late' : STATUS_LABEL[t.status] || t.status)}</span>
      </li>`;
    }).join('');
  }

  async function draft() {
    if (busy) return;
    const title = $('chiefObjective').value.trim();
    if (!title) {
      showError('Describe the objective first: what do you want done?');
      $('chiefObjective').focus();
      return;
    }
    busy = true;
    const btn = $('chiefDraftBtn');
    btn.disabled = true;
    btn.textContent = 'Drafting plan…';
    showError('');
    clarify(null);
    try {
      const deadline = $('chiefDeadline').value;
      const result = await chiefDraftPlan({
        objective: title,
        description: $('chiefDescription').value.trim(),
        priority: $('chiefPriority').value,
        deadline: deadline ? new Date(`${deadline}T23:59:59`).toISOString() : null,
        stakeholders: $('chiefStakeholders').value.split(',').map((x) => x.trim()).filter(Boolean),
      });
      if (result.status === 'needs_clarification') {
        clarify(result.missing);
        setStep('objective');
        $('chiefSummary').hidden = true;
        $('chiefSubtasks').hidden = true;
        return;
      }
      toast('Plan drafted. Review it before anything is assigned.', 'success');
      await loadPlan(result.planId);
    } catch (err) {
      showError(err.message || 'The plan could not be drafted.');
    } finally {
      busy = false;
      btn.disabled = false;
      btn.textContent = 'Draft a plan';
    }
  }

  async function loadPlan(id) {
    const plan = await chiefPlan(id);
    renderPlan(plan);
    $('chiefReport').hidden = true;
    return plan;
  }

  async function approve() {
    if (busy || !planId) return;
    busy = true;
    const btn = $('chiefApproveBtn');
    btn.disabled = true;
    btn.textContent = 'Creating tasks…';
    showError('');
    try {
      const result = await chiefApprove(planId);
      toast(`Approved. ${result.created.length} tasks created.`, 'success');
      await loadPlan(planId);
    } catch (err) {
      showError(err.message || 'The plan could not be approved.');
    } finally {
      busy = false;
      btn.disabled = false;
      btn.textContent = 'Approve and create tasks';
    }
  }

  async function reject() {
    if (busy || !planId) return;
    const reason = window.prompt('Why are you rejecting this plan? (optional)', '');
    if (reason === null) return;
    busy = true;
    try {
      await chiefReject(planId, reason);
      toast('Plan rejected', 'info');
      await loadPlan(planId);
    } catch (err) {
      showError(err.message || 'The plan could not be rejected.');
    } finally {
      busy = false;
    }
  }

  async function showReport() {
    if (!planId) return;
    try {
      const data = await chiefReport(planId);
      $('chiefReportBody').textContent = data.report;
      $('chiefReport').hidden = false;
      setStep('report');
      $('chiefReport').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      showError(err.message || 'The report could not be generated.');
    }
  }

  function startNew() {
    planId = null;
    ['chiefObjective', 'chiefDescription', 'chiefDeadline', 'chiefStakeholders'].forEach((id) => { $(id).value = ''; });
    $('chiefPriority').value = 'medium';
    $('chiefSummary').hidden = true;
    $('chiefSubtasks').hidden = true;
    $('chiefReport').hidden = true;
    $('chiefCompose').hidden = false;
    root.querySelector('.cs-plan-layout').classList.remove('is-viewing');
    showError('');
    clarify(null);
    setStep('objective');
    setTab('plan');
    $('chiefObjective').focus();
  }

  /* ---------------- Plans ---------------- */
  async function loadHistory() {
    const body = $('chiefHistoryBody');
    try {
      const { plans } = await chiefPlans();
      $('csPlanCount').textContent = plans.length ? String(plans.length) : '';
      body.innerHTML = plans.length ? plans.map((p) => `<li class="cs-plan">
          <div class="cs-plan-main">
            <h4>${esc(p.objective)}</h4>
            <p>${p.subtasks} step${p.subtasks === 1 ? '' : 's'}, opened ${esc(dateTime(p.created_at))}</p>
          </div>
          <span class="cs-plan-status" data-state="${esc(p.status)}">${esc(PLAN_STATUS[p.status] || p.status)}</span>
          <button class="utility-secondary" type="button" data-chief-open="${esc(p.planId)}">Open</button>
        </li>`).join('')
        : '<li class="work-empty">No objectives yet. Use <strong>Plan new work</strong> to hand one over.</li>';
    } catch (err) {
      body.innerHTML = `<li class="work-empty">${esc(err.message || 'Plans could not be loaded.')}</li>`;
    }
  }

  /* ---------------- wiring ---------------- */
  root.addEventListener('click', async (e) => {
    const tabBtn = e.target.closest('[data-cs-tab]');
    if (tabBtn) { setTab(tabBtn.dataset.csTab); return; }
    if (e.target.closest('#csNewBtn')) { startNew(); return; }
    const kind = e.target.closest('[data-cs-kind]');
    if (kind) { kindFilter = kind.dataset.csKind; renderPeople(); return; }
    const act = e.target.closest('[data-cs-act]');
    if (act) { await sendFollowups([attention[Number(act.dataset.csAct)]].filter(Boolean), act); return; }
    if (e.target.closest('#csSendBtn')) {
      const picked = [...root.querySelectorAll('[data-cs-pick]:checked')].map((b) => attention[Number(b.dataset.csPick)]).filter(Boolean);
      await sendFollowups(picked, $('csSendBtn'));
      return;
    }
    const tasksBtn = e.target.closest('[data-cs-tasks]');
    if (tasksBtn) { showTasksFor?.(tasksBtn.dataset.csTasks); return; }
    const open = e.target.closest('[data-chief-open]');
    if (open) {
      try {
        await loadPlan(open.dataset.chiefOpen);
        setTab('plan');
      } catch (err) {
        toast(err.message || 'That plan could not be opened', 'error');
      }
    }
  });
  root.addEventListener('change', (e) => { if (e.target.matches('[data-cs-pick]')) syncBulk(); });

  // Arrow keys move between tabs (WAI-ARIA tabs pattern).
  root.querySelector('[role="tablist"]')?.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const tabs = [...root.querySelectorAll('[data-cs-tab]')];
    let i = tabs.findIndex((t) => t.dataset.csTab === tab);
    if (e.key === 'ArrowRight') i = (i + 1) % tabs.length;
    if (e.key === 'ArrowLeft') i = (i - 1 + tabs.length) % tabs.length;
    if (e.key === 'Home') i = 0;
    if (e.key === 'End') i = tabs.length - 1;
    e.preventDefault();
    setTab(tabs[i].dataset.csTab, { focus: true });
  });

  $('chiefDraftBtn').addEventListener('click', draft);
  $('chiefApproveBtn').addEventListener('click', approve);
  $('chiefRejectBtn').addEventListener('click', reject);
  $('chiefReportBtn').addEventListener('click', showReport);
  $('chiefReportClose').addEventListener('click', () => { $('chiefReport').hidden = true; });
  $('csRefresh').addEventListener('click', loadStaff);

  function onOpen() {
    setTab(tab);
    loadHistory();
    if (!planId) setStep('objective');
  }

  return { onOpen };
}
