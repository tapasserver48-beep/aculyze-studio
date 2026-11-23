/**
 * Automations page (Phase 04.2): "when X happens → an AI employee does Y".
 * Templates, create/edit form, list with on/off, Test now and run history.
 */

import {
  automationsList, automationsOptions, automationsCreate, automationsUpdate,
  automationsDelete, automationsTest, automationsHistory,
} from './api.js';
import { escapeHtml as esc, relativeTime, dateTime } from './work-ui.js';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TRIGGER_LABEL = {
  schedule: 'On a schedule',
  email: 'When a new email arrives',
  lead: 'When a website lead comes in',
  overdue: 'When a task becomes overdue',
};
const OUTCOME = {
  submitted: ['Result ready', 'ok'],
  needs_approval: ['Needs your approval', 'warn'],
  needs_info: ['Asked a question', 'warn'],
  failed: ['Stopped', 'err'],
};

/** Ready-made starting points. `code` picks the AI employee. */
const TEMPLATES = [
  {
    id: 'briefing', code: 'AI-CHIEF-001', title: 'Morning briefing', blurb: 'Every weekday at 9:00, a summary of new emails and today\'s priorities in your Inbox.',
    data: { name: 'Morning briefing', trigger: { type: 'schedule', mode: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] }, instruction: 'Summarize my important emails from the last 24 hours (skip newsletters and promotions) and list today\'s calendar events. Finish with the top 3 things I should do first today.' },
  },
  {
    id: 'client-email', code: 'AI-CHIEF-001', title: 'Reply drafts for client emails', blurb: 'When a client writes, summarize it and prepare a reply draft for you to approve.',
    data: { name: 'Client email replies', trigger: { type: 'email', from: '', subject: '', words: '' }, instruction: 'Read the new email, summarize what the client wants in 2-3 lines, and create a polite reply draft in Gmail. Do not send it.' },
  },
  {
    id: 'lead', code: 'AI-CUSTOMER-001', manager: true, title: 'Welcome website leads', blurb: 'When the website chatbot captures a lead, line up a follow-up call for a salesperson.',
    data: { name: 'Welcome website leads', trigger: { type: 'lead' }, instruction: 'Create a follow-up task for the sales team to call this lead within 1 day, including the lead\'s details. Then draft a short welcome email to the lead for my approval.' },
  },
  {
    id: 'overdue', code: 'AI-EXEC-001', manager: true, title: 'Chase overdue tasks', blurb: 'When a task is overdue, nudge the person in the Inbox and tell the person they report to.',
    data: { name: 'Chase overdue tasks', trigger: { type: 'overdue', assignee: 'human' }, instruction: 'Send the person a short, friendly Inbox message asking for an update on the overdue task and a new expected date. Also tell the person they report to (if any) that the task is late.' },
  },
];

function agentKey(code, name) {
  const hay = `${code || ''} ${name || ''}`.toLowerCase();
  return /chief/.test(hay) ? 'chief' : /customer/.test(hay) ? 'customer' : /exec/.test(hay) ? 'exec' : /sales/.test(hay) ? 'sales' : 'chief';
}

function daysText(days) {
  const d = (days || []).slice().sort().join();
  if (d === '1,2,3,4,5') return 'Mon–Fri';
  if (d === '1,2,3,4,5,6') return 'Mon–Sat';
  if ((days || []).length === 7) return 'every day';
  return (days || []).map((x) => DAY_NAMES[x]).join(', ');
}

function whenText(t) {
  if (!t) return '';
  if (t.type === 'schedule') {
    return t.mode === 'interval'
      ? `Every ${t.everyHours} hour${t.everyHours === 1 ? '' : 's'} from ${t.from} to ${t.to}, ${daysText(t.days)}`
      : `At ${t.time}, ${daysText(t.days)}`;
  }
  if (t.type === 'email') {
    const parts = [t.from && `from ${t.from}`, t.subject && `subject “${t.subject}”`, t.words && `mentioning “${t.words}”`].filter(Boolean);
    return `New email ${parts.join(', ')}`;
  }
  if (t.type === 'lead') return 'New website lead';
  return `A task assigned to ${t.assignee === 'ai' ? 'an AI employee' : t.assignee === 'any' ? 'anyone' : 'a person'} becomes overdue`;
}

export function initAutomationsView({ toast, confirm, getUser, openTask }) {
  const $ = (id) => document.getElementById(id);
  const root = $('view-automations');
  if (!root) return { onOpen: () => {} };

  const state = { items: [], options: null, editingId: null, historyOpen: null };
  const me = () => (getUser() || {}).id;

  /* ---------------- load ---------------- */
  async function loadOptions() {
    if (state.options) return state.options;
    try { state.options = await automationsOptions(); } catch { state.options = { employees: [], chatbots: [], canUseManagerTriggers: false }; }
    return state.options;
  }

  async function load() {
    const list = $('auList');
    let data;
    try {
      [data] = await Promise.all([automationsList(), loadOptions()]);
    } catch (err) {
      list.innerHTML = `<li class="work-empty">${esc(err.message || 'Automations could not be loaded.')}</li>`;
      return;
    }
    state.items = data.automations || [];
    renderTemplates();
    renderList();
  }

  /* ---------------- templates ---------------- */
  function renderTemplates() {
    const canManager = state.options && state.options.canUseManagerTriggers;
    $('auTemplates').innerHTML = TEMPLATES.filter((t) => !t.manager || canManager).map((t) => `
      <li><button type="button" class="au-template" data-au-template="${t.id}" data-agent="${agentKey(t.code)}">
        <span class="au-template-ico" aria-hidden="true">${esc(TRIGGER_ICON[t.data.trigger.type])}</span>
        <span class="au-template-title">${esc(t.title)}</span>
        <span class="au-template-blurb">${esc(t.blurb)}</span>
      </button></li>`).join('');
  }
  const TRIGGER_ICON = { schedule: '⏰', email: '✉', lead: '🌐', overdue: '⚠' };

  /* ---------------- list ---------------- */
  function renderList() {
    const list = $('auList');
    $('auSummary').textContent = state.items.length
      ? `${state.items.filter((a) => a.active).length} of ${state.items.length} automation${state.items.length === 1 ? '' : 's'} on. Results arrive in your Inbox; anything that sends email waits for your approval.`
      : 'Your AI employees start work on their own, at a set time or when something happens.';
    if (!state.items.length) {
      list.innerHTML = '<li class="ex-empty"><p><strong>No automations yet.</strong></p><p>Start from a template above, or create your own.</p></li>';
      return;
    }
    const emp = new Map(((state.options && state.options.employees) || []).map((e) => [e.id, e]));
    list.innerHTML = state.items.map((a) => {
      const e = emp.get(a.employeeId) || { name: 'AI employee' };
      const status = a.lastError ? ['Needs attention', 'err'] : a.active ? ['On', 'ok'] : ['Paused', 'muted'];
      const last = a.lastHistory;
      const lastText = !last ? 'Not run yet'
        : last.status === 'skipped' ? `Last trigger skipped: ${last.reason}`
          : `Last run ${relativeTime(last.at)}${last.outcome ? ` · ${(OUTCOME[last.outcome] || [last.outcome])[0]}` : ' · running'}`;
      const mine = a.ownerId === me();
      return `<li class="au-card${a.active ? '' : ' is-paused'}" data-agent="${agentKey(e.code, e.name)}">
        <span class="au-ava" aria-hidden="true">${esc((e.name || 'A').charAt(0))}</span>
        <div class="au-main">
          <p class="au-title">${esc(a.name)} <span class="ex-chip is-${status[1]}">${esc(status[0])}</span></p>
          <p class="au-when"><strong>When:</strong> ${esc(whenText(a.trigger))}</p>
          <p class="au-who"><strong>${esc(e.name)}</strong>: ${esc(a.instruction.length > 140 ? `${a.instruction.slice(0, 137)}…` : a.instruction)}</p>
          ${a.lastError ? `<p class="tm-ai-error">${esc(a.lastError)}</p>` : ''}
          <p class="au-meta">${esc(lastText)} · ${a.runsToday} of ${a.maxRunsPerDay} runs today${mine ? '' : ` · owner: ${esc(a.ownerName)}`}</p>
          <ol class="au-history" id="auHist-${esc(a.id)}" hidden></ol>
        </div>
        <div class="au-actions">
          <label class="au-switch" title="${a.active ? 'Pause' : 'Turn on'}">
            <input type="checkbox" data-au-toggle="${esc(a.id)}" ${a.active ? 'checked' : ''} aria-label="${esc(a.name)} is ${a.active ? 'on' : 'paused'}">
            <span aria-hidden="true"></span>
          </label>
          ${mine || ['founder', 'admin'].includes((getUser() || {}).role) ? `<button type="button" class="utility-secondary" data-au-act="test" data-id="${esc(a.id)}">Test now</button>` : ''}
          <button type="button" class="utility-secondary" data-au-act="history" data-id="${esc(a.id)}" aria-expanded="false">History</button>
          ${mine || ['founder', 'admin'].includes((getUser() || {}).role) ? `<details class="work-menu">
            <summary class="utility-secondary" aria-label="More actions for ${esc(a.name)}">More</summary>
            <div class="work-menu-pop" role="menu">
              <button type="button" role="menuitem" data-au-act="edit" data-id="${esc(a.id)}">Edit</button>
              <button type="button" role="menuitem" data-au-act="delete" data-id="${esc(a.id)}">Delete</button>
            </div>
          </details>` : ''}
        </div>
      </li>`;
    }).join('');
  }

  async function showHistory(id, btn) {
    const box = $(`auHist-${id}`);
    if (!box) return;
    if (!box.hidden) { box.hidden = true; btn.setAttribute('aria-expanded', 'false'); return; }
    box.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    box.innerHTML = '<li class="tm-loading">Loading…</li>';
    try {
      const { history } = await automationsHistory(id);
      box.innerHTML = history.length ? history.map((h) => {
        const [label, tone] = h.status === 'skipped' ? ['Skipped', 'muted'] : (OUTCOME[h.outcome] || ['Running', 'busy']);
        return `<li><time title="${esc(dateTime(h.at))}">${esc(relativeTime(h.at))}</time>
          <span>${esc(h.title || '')}${h.test ? ' (test)' : ''}${h.reason ? `: ${esc(h.reason)}` : ''}</span>
          <span class="ex-chip is-${tone}">${esc(label)}</span>
          ${h.taskId ? `<button type="button" class="link-btn" data-au-open-task="${esc(h.taskId)}">Open task</button>` : ''}</li>`;
      }).join('') : '<li class="tm-loading">Nothing has run yet.</li>';
    } catch (err) {
      box.innerHTML = `<li class="tm-ai-error">${esc(err.message)}</li>`;
    }
  }

  root.addEventListener('click', async (e) => {
    const tpl = e.target.closest('[data-au-template]');
    if (tpl) { openForm(TEMPLATES.find((t) => t.id === tpl.dataset.auTemplate)); return; }
    const openT = e.target.closest('[data-au-open-task]');
    if (openT) { openTask(openT.dataset.auOpenTask); return; }
    const btn = e.target.closest('[data-au-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    const a = state.items.find((x) => x.id === id);
    btn.closest('details')?.removeAttribute('open');
    try {
      if (btn.dataset.auAct === 'history') { await showHistory(id, btn); return; }
      if (btn.dataset.auAct === 'edit') { openForm(null, a); return; }
      if (btn.dataset.auAct === 'test') {
        btn.disabled = true;
        await automationsTest(id);
        toast('Test started. The result will appear in your Inbox and on the Tasks page.', 'success');
      } else if (btn.dataset.auAct === 'delete') {
        const ok = await confirm({ title: 'Delete this automation?', detail: `"${a ? a.name : 'This automation'}" stops running. Tasks it already created stay on the Tasks page.`, okLabel: 'Delete', cancelLabel: 'Keep it' });
        if (!ok) return;
        await automationsDelete(id);
        toast('Automation deleted', 'info');
      }
      await load();
    } catch (err) {
      toast(err.message || 'That did not work', 'error');
      btn.disabled = false;
    }
  });

  root.addEventListener('change', async (e) => {
    const sw = e.target.closest('[data-au-toggle]');
    if (sw) {
      try {
        await automationsUpdate(sw.dataset.auToggle, { active: sw.checked });
        toast(sw.checked ? 'Automation on' : 'Automation paused', 'info');
        await load();
      } catch (err) {
        sw.checked = !sw.checked;
        toast(err.message || 'Could not change it', 'error');
      }
      return;
    }
    if (e.target.name === 'triggerType' || e.target.name === 'mode') syncTriggerFields();
  });

  /* ---------------- form ---------------- */
  function syncTriggerFields() {
    const form = $('auForm');
    const type = form.triggerType.value;
    form.querySelectorAll('[data-au-for]').forEach((el) => { el.hidden = !el.dataset.auFor.split(' ').includes(type); });
    const interval = form.mode.value === 'interval';
    form.querySelectorAll('[data-au-mode]').forEach((el) => { el.hidden = type !== 'schedule' || el.dataset.auMode !== (interval ? 'interval' : 'daily'); });
  }

  async function openForm(template, existing) {
    const opts = await loadOptions();
    const form = $('auForm');
    form.reset();
    $('auFormError').hidden = true;
    state.editingId = existing ? existing.id : null;
    $('auFormTitle').textContent = existing ? `Edit “${existing.name}”` : template ? template.title : 'New automation';
    form.employeeId.innerHTML = opts.employees.map((e) => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('');
    form.chatbotId.innerHTML = '<option value="">Any chatbot</option>' + (opts.chatbots || []).map((b) => `<option value="${esc(b.id)}">${esc(b.name)}${b.workspace ? ` (${esc(b.workspace)})` : ''}</option>`).join('');
    form.querySelectorAll('[data-manager-only]').forEach((o) => { o.disabled = !opts.canUseManagerTriggers; });
    const src = existing || (template && template.data) || {};
    const t = src.trigger || { type: 'schedule', mode: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] };
    form.auName.value = src.name || '';
    form.instruction.value = src.instruction || '';
    form.maxRunsPerDay.value = src.maxRunsPerDay || 10;
    form.triggerType.value = t.type;
    form.mode.value = t.mode || 'daily';
    form.time.value = t.time || '09:00';
    form.everyHours.value = t.everyHours || 2;
    form.from.value = t.from || '09:00';
    form.to.value = t.to || '19:00';
    form.emailFrom.value = t.from && t.type === 'email' ? t.from : '';
    form.emailSubject.value = t.subject || '';
    form.emailWords.value = t.words || '';
    form.assignee.value = t.assignee || 'human';
    form.chatbotId.value = t.chatbotId || '';
    const days = t.days || [1, 2, 3, 4, 5];
    form.querySelectorAll('[name="days"]').forEach((c) => { c.checked = days.includes(Number(c.value)); });
    const wanted = existing ? existing.employeeId : template ? (opts.employees.find((e) => e.code === template.code) || {}).id : '';
    if (wanted) form.employeeId.value = wanted;
    syncTriggerFields();
    form.hidden = false;
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    form.auName.focus({ preventScroll: true });
  }

  function triggerFromForm(form) {
    const type = form.triggerType.value;
    if (type === 'schedule') {
      const days = [...form.querySelectorAll('[name="days"]:checked')].map((c) => Number(c.value));
      return form.mode.value === 'interval'
        ? { type, mode: 'interval', everyHours: Number(form.everyHours.value), from: form.from.value, to: form.to.value, days }
        : { type, mode: 'daily', time: form.time.value, days };
    }
    if (type === 'email') return { type, from: form.emailFrom.value.trim(), subject: form.emailSubject.value.trim(), words: form.emailWords.value.trim() };
    if (type === 'lead') return { type, chatbotId: form.chatbotId.value };
    return { type, assignee: form.assignee.value };
  }

  $('auNewBtn').addEventListener('click', () => openForm(null));
  $('auFormCancel').addEventListener('click', () => { $('auForm').hidden = true; });
  $('auForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const body = {
      name: form.auName.value.trim(),
      instruction: form.instruction.value.trim(),
      employeeId: form.employeeId.value,
      maxRunsPerDay: Number(form.maxRunsPerDay.value) || 10,
      trigger: triggerFromForm(form),
    };
    const err = $('auFormError');
    err.hidden = true;
    $('auFormSave').disabled = true;
    try {
      if (state.editingId) await automationsUpdate(state.editingId, body);
      else await automationsCreate(body);
      form.hidden = true;
      toast(state.editingId ? 'Automation saved' : 'Automation created and switched on', 'success');
      await load();
    } catch (ex) {
      err.textContent = ex.message || 'The automation could not be saved.';
      err.hidden = false;
    } finally {
      $('auFormSave').disabled = false;
    }
  });

  return { onOpen: load };
}
