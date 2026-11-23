/**
 * Executive Agent page (Phase 04.2a) — founders, admins and managers.
 *
 *  Daily check-ins: create / pause / delete, ask now, remind now, and a
 *  per-day report (who answered, numbers, totals, who's missing) with an
 *  Excel download.
 *  Team performance: open / overdue / completed tasks, check-in discipline
 *  and the numbers each person reported over the last 7 days.
 */

import {
  executiveDashboard, executiveCheckins, executiveCreateCheckin, executiveUpdateCheckin,
  executiveDeleteCheckin, executiveReport, executiveAsk, executiveRemind,
} from './api.js';
import { escapeHtml as esc, dateTime, relativeTime } from './work-ui.js';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const AUDIENCE = { employee: 'Employees', manager: 'Managers', all: 'Everyone' };
const STATUS = {
  submitted: ['On time', 'ok'],
  late: ['Late', 'warn'],
  partial: ['Partly answered', 'warn'],
  missing: ['Not submitted', 'err'],
};

function daysText(days) {
  const d = (days || []).slice().sort();
  if (d.join() === '1,2,3,4,5') return 'Mon–Fri';
  if (d.join() === '1,2,3,4,5,6') return 'Mon–Sat';
  if (d.length === 7) return 'Every day';
  return d.map((x) => DAY_NAMES[x]).join(', ');
}

function prettyDay(date) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
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

export function initExecutiveView({ toast, confirm }) {
  const $ = (id) => document.getElementById(id);
  const root = $('view-executive');
  const noop = { onOpen: () => {}, openReport: () => {}, downloadExcel: () => {} };
  if (!root) return noop;

  const state = { tab: 'checkins', checkins: [], report: null, reportId: null, loaded: false };

  /* ---------------- tabs ---------------- */
  function setTab(next) {
    state.tab = next;
    root.querySelectorAll('[data-ex-tab]').forEach((b) => {
      const on = b.dataset.exTab === next;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    root.querySelectorAll('[data-ex-panel]').forEach((p) => { p.hidden = p.dataset.exPanel !== next; });
    if (next === 'performance') loadPerformance();
    else loadCheckins();
  }
  root.querySelectorAll('[data-ex-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.exTab)));

  /* ---------------- check-ins list ---------------- */
  async function loadCheckins() {
    const list = $('exCheckins');
    let data;
    try {
      data = await executiveCheckins();
    } catch (err) {
      list.innerHTML = `<li class="work-empty">${esc(err.message || 'Check-ins could not be loaded.')}</li>`;
      return;
    }
    state.checkins = data.checkins || [];
    state.loaded = true;
    const active = state.checkins.filter((c) => c.active);
    $('exSummary').textContent = active.length
      ? `${active.length} daily check-in${active.length === 1 ? '' : 's'} running. Times are in ${data.timeZone}.`
      : 'Set up a daily check-in and the Executive Agent will collect the numbers in the Inbox.';
    if (!state.checkins.length) {
      list.innerHTML = `<li class="ex-empty">
          <p><strong>No daily check-ins yet.</strong></p>
          <p>Example: every day at 15:00 the Executive Agent asks each employee for their sales and calls, totals them, and at 16:00 tells managers who hasn't answered.</p>
          <button type="button" class="utility-primary" data-ex-new>Create the first check-in</button>
        </li>`;
      return;
    }
    list.innerHTML = state.checkins.map((c) => {
      const t = c.today || {};
      const status = !c.active ? ['Paused', 'muted']
        : !t.asked ? [`Asks at ${c.askTime}`, 'muted']
          : t.submitted === t.total ? [`All ${t.total} submitted`, 'ok']
            : [`${t.submitted} of ${t.total} submitted`, t.escalatedAt ? 'err' : 'busy'];
      const totals = t.asked ? c.fields.map((f) => `<span class="ex-total"><strong>${esc(String((t.totals || {})[f.key] ?? 0))}</strong> ${esc(f.label)}</span>`).join('') : '';
      return `<li class="ex-card${c.active ? '' : ' is-paused'}">
          <div class="ex-card-main">
            <p class="ex-card-title">${esc(c.title)} <span class="ex-chip is-${status[1]}">${esc(status[0])}</span></p>
            <p class="ex-card-meta">${esc(AUDIENCE[c.audienceRole] || 'Employees')} · asks ${esc(c.askTime)}, deadline ${esc(c.deadlineTime)} · ${esc(daysText(c.days))} · collects ${esc(c.fields.map((f) => f.label).join(', '))}</p>
            ${totals ? `<p class="ex-card-totals">Today: ${totals}</p>` : ''}
          </div>
          <div class="ex-card-actions">
            <button type="button" class="utility-primary" data-ex-act="report" data-id="${esc(c.id)}">Report</button>
            ${c.active && !t.asked ? `<button type="button" class="utility-secondary" data-ex-act="ask" data-id="${esc(c.id)}">Ask now</button>` : ''}
            ${c.active && t.asked && t.submitted < t.total ? `<button type="button" class="utility-secondary" data-ex-act="remind" data-id="${esc(c.id)}">Remind now</button>` : ''}
            <details class="work-menu">
              <summary class="utility-secondary" aria-label="More actions for ${esc(c.title)}">More</summary>
              <div class="work-menu-pop" role="menu">
                ${c.active && t.asked ? `<button type="button" role="menuitem" data-ex-act="askagain" data-id="${esc(c.id)}">Ask again today</button>` : ''}
                <button type="button" role="menuitem" data-ex-act="${c.active ? 'pause' : 'resume'}" data-id="${esc(c.id)}">${c.active ? 'Pause' : 'Resume'}</button>
                <button type="button" role="menuitem" data-ex-act="delete" data-id="${esc(c.id)}">Delete</button>
              </div>
            </details>
          </div>
        </li>`;
    }).join('');
    if (state.reportId && state.checkins.some((c) => c.id === state.reportId)) loadReport(state.reportId, $('exReportDate').value || undefined);
  }

  root.addEventListener('click', async (e) => {
    if (e.target.closest('[data-ex-new]')) { openForm(); return; }
    const btn = e.target.closest('[data-ex-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    const c = state.checkins.find((x) => x.id === id);
    btn.closest('details')?.removeAttribute('open');
    try {
      if (btn.dataset.exAct === 'report') { await loadReport(id); $('exReport').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
      if (btn.dataset.exAct === 'ask' || btn.dataset.exAct === 'askagain') {
        btn.disabled = true;
        const out = await executiveAsk(id, btn.dataset.exAct === 'askagain');
        toast(`Asked ${out.asked} ${out.asked === 1 ? 'person' : 'people'} in the Inbox`, 'success');
      } else if (btn.dataset.exAct === 'remind') {
        btn.disabled = true;
        const out = await executiveRemind(id);
        toast(out.reminded ? `Reminded ${out.reminded} and told their leads and managers` : 'Everyone has answered. Summary sent to managers.', 'success');
      } else if (btn.dataset.exAct === 'pause' || btn.dataset.exAct === 'resume') {
        await executiveUpdateCheckin(id, { active: btn.dataset.exAct === 'resume' });
        toast(btn.dataset.exAct === 'pause' ? 'Check-in paused' : 'Check-in resumed', 'info');
      } else if (btn.dataset.exAct === 'delete') {
        const ok = await confirm({
          title: 'Delete this check-in?',
          detail: `"${c ? c.title : 'This check-in'}" stops running. Answers already collected stay in its reports until you delete them from disk.`,
          okLabel: 'Delete', cancelLabel: 'Keep it',
        });
        if (!ok) return;
        await executiveDeleteCheckin(id);
        if (state.reportId === id) { state.reportId = null; $('exReport').hidden = true; }
        toast('Check-in deleted', 'info');
      }
      await loadCheckins();
    } catch (err) {
      toast(err.message || 'That did not work', 'error');
      btn.disabled = false;
    }
  });

  /* ---------------- create form ---------------- */
  function openForm() {
    const form = $('exForm');
    form.reset();
    $('exFormError').hidden = true;
    form.hidden = false;
    form.querySelector('[name="title"]').focus();
  }
  $('exNewBtn').addEventListener('click', () => { setTab('checkins'); openForm(); });
  $('exFormCancel').addEventListener('click', () => { $('exForm').hidden = true; });
  $('exForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const fd = new FormData(form);
    const body = {
      title: String(fd.get('title') || '').trim(),
      question: String(fd.get('question') || '').trim(),
      fields: String(fd.get('fields') || ''),
      askTime: fd.get('askTime'),
      deadlineTime: fd.get('deadlineTime'),
      audienceRole: fd.get('audienceRole'),
      days: fd.getAll('days').map(Number),
    };
    const err = $('exFormError');
    err.hidden = true;
    if (!body.title) { err.textContent = 'Give the check-in a name.'; err.hidden = false; form.querySelector('[name="title"]').focus(); return; }
    if (!body.question) { err.textContent = 'Write the question employees will answer.'; err.hidden = false; form.querySelector('[name="question"]').focus(); return; }
    $('exFormSave').disabled = true;
    try {
      await executiveCreateCheckin(body);
      form.hidden = true;
      toast(`Check-in saved. The Executive Agent will ask at ${body.askTime}.`, 'success');
      await loadCheckins();
    } catch (ex) {
      err.textContent = ex.message || 'The check-in could not be saved.';
      err.hidden = false;
    } finally {
      $('exFormSave').disabled = false;
    }
  });

  /* ---------------- report ---------------- */
  function kpi(label, value, tone = '') {
    return `<div class="ex-kpi${tone ? ` is-${tone}` : ''}"><span class="ex-kpi-value">${esc(String(value))}</span><span class="ex-kpi-label">${esc(label)}</span></div>`;
  }

  async function loadReport(id, date) {
    const data = await executiveReport(id, date);
    const r = data.report;
    state.report = r;
    state.reportId = id;
    const box = $('exReport');
    box.hidden = false;
    $('exReportTitle').textContent = `${r.title}, ${prettyDay(r.date)}`;
    const dates = [...new Set([r.date, ...(data.dates || [])])].sort().reverse();
    $('exReportDate').innerHTML = dates.map((d) => `<option value="${esc(d)}"${d === r.date ? ' selected' : ''}>${esc(prettyDay(d))}</option>`).join('');
    $('exReportKpis').innerHTML = [
      kpi('submitted', `${r.submitted} / ${r.total}`, r.total && r.submitted === r.total ? 'ok' : ''),
      ...r.fields.map((f) => kpi(`total ${f.label.toLowerCase()}`, r.totals[f.key] ?? 0)),
      kpi('not submitted', r.missing.length, r.missing.length ? 'err' : 'ok'),
    ].join('');
    if (!r.asked) {
      $('exReportTable').innerHTML = `<tbody><tr><td class="work-empty">Nobody has been asked for this day yet. The Executive Agent asks at the scheduled time, or click "Ask now".</td></tr></tbody>`;
      return;
    }
    $('exReportTable').innerHTML = `<thead><tr><th scope="col">Person</th>${r.fields.map((f) => `<th scope="col" class="num">${esc(f.label)}</th>`).join('')}<th scope="col">Status</th><th scope="col">Answered</th></tr></thead>
      <tbody>${r.rows.map((row) => {
        const [label, tone] = STATUS[row.status] || [row.status, ''];
        return `<tr><td>${esc(row.name)}</td>${r.fields.map((f) => `<td class="num">${typeof row.values[f.key] === 'number' ? esc(String(row.values[f.key])) : '<span class="ex-dash">–</span>'}</td>`).join('')}
          <td><span class="ex-chip is-${tone}">${esc(label)}</span></td>
          <td>${row.submittedAt ? `<time title="${esc(dateTime(row.submittedAt))}">${esc(relativeTime(row.submittedAt))}</time>` : ''}</td></tr>`;
      }).join('')}</tbody>
      <tfoot><tr><th scope="row">Total</th>${r.fields.map((f) => `<td class="num"><strong>${esc(String(r.totals[f.key] ?? 0))}</strong></td>`).join('')}<td colspan="2">${esc(`${r.submitted} of ${r.total} submitted`)}</td></tr></tfoot>`;
  }
  $('exReportDate').addEventListener('change', () => { if (state.reportId) loadReport(state.reportId, $('exReportDate').value).catch((e) => toast(e.message, 'error')); });

  async function downloadExcel(id = state.reportId, date) {
    try {
      const r = (id === state.reportId && state.report && (!date || date === state.report.date)) ? state.report : (await executiveReport(id, date)).report;
      await loadXlsx();
      const rows = r.rows.map((row) => {
        const out = { Person: row.name };
        for (const f of r.fields) out[f.label] = typeof row.values[f.key] === 'number' ? row.values[f.key] : '';
        out.Status = (STATUS[row.status] || [row.status])[0];
        out['Answered at'] = row.submittedAt ? new Date(row.submittedAt).toLocaleString() : '';
        return out;
      });
      const total = { Person: 'TOTAL' };
      for (const f of r.fields) total[f.label] = r.totals[f.key] ?? 0;
      total.Status = `${r.submitted} of ${r.total} submitted`;
      total['Answered at'] = '';
      rows.push(total);
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.json_to_sheet(rows), r.date);
      const safe = r.title.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'check-in';
      window.XLSX.writeFile(wb, `${safe}-${r.date}.xlsx`);
      toast('Excel sheet downloaded', 'success');
    } catch (err) {
      toast(err.message || 'The Excel sheet could not be created', 'error');
    }
  }
  $('exXlsx').addEventListener('click', () => downloadExcel(state.reportId, state.report && state.report.date));

  /* ---------------- performance ---------------- */
  async function loadPerformance() {
    let d;
    try {
      d = await executiveDashboard();
    } catch (err) {
      $('exPerfTable').innerHTML = `<tbody><tr><td class="work-empty">${esc(err.message || 'Performance could not be loaded.')}</td></tr></tbody>`;
      return;
    }
    const labels = Object.keys(d.fieldTotals || {});
    $('exPerfKpis').innerHTML = [
      kpi('people', d.totals.people),
      kpi('open tasks', d.totals.openTasks),
      kpi('overdue', d.totals.overdue, d.totals.overdue ? 'err' : 'ok'),
      kpi('completed (30 days)', d.totals.completed30d, 'ok'),
      ...labels.map((l) => kpi(`${l.toLowerCase()} (7 days)`, d.fieldTotals[l])),
    ].join('');
    $('exPerfNote').textContent = `Check-ins and reported numbers cover ${prettyDay(d.since)} to ${prettyDay(d.today)}. Tasks completed cover the last 30 days.`;
    const people = d.people.slice().sort((a, b) => a.name.localeCompare(b.name));
    $('exPerfTable').innerHTML = `<thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col" class="num">Open</th><th scope="col" class="num">Overdue</th><th scope="col" class="num">Done (30d)</th><th scope="col" class="num">Check-ins answered</th>${labels.map((l) => `<th scope="col" class="num">${esc(l)} (7d)</th>`).join('')}</tr></thead>
      <tbody>${people.map((p) => {
        const rate = p.checkinsAsked ? Math.round((p.checkinsAnswered / p.checkinsAsked) * 100) : null;
        return `<tr><td>${esc(p.name)}</td><td>${esc(p.role)}</td><td class="num">${p.openTasks}</td>
          <td class="num">${p.overdue ? `<span class="ex-chip is-err">${p.overdue}</span>` : '0'}</td><td class="num">${p.completed30d}</td>
          <td class="num">${rate === null ? '<span class="ex-dash">–</span>' : `<span class="ex-chip is-${rate >= 90 ? 'ok' : rate >= 60 ? 'warn' : 'err'}">${p.checkinsAnswered}/${p.checkinsAsked}</span>`}</td>
          ${labels.map((l) => `<td class="num">${p.sums[l] ?? '<span class="ex-dash">–</span>'}</td>`).join('')}</tr>`;
      }).join('')}</tbody>`;
  }

  $('exRefresh').addEventListener('click', () => setTab(state.tab));

  function onOpen() { setTab(state.tab); }

  /** Open a check-in's report for a day (used by Inbox summary links). */
  async function openReport(id, date) {
    setTab('checkins');
    try {
      await loadReport(id, date);
      $('exReport').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      toast(err.message || 'That report could not be opened', 'error');
    }
  }

  return { onOpen, openReport, downloadExcel };
}
