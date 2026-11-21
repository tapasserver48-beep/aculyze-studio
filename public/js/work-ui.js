/**
 * Shared building blocks for the Tasks and Chief of Staff pages:
 * labels, relative due dates, and the workload bar.
 *
 * The workload bar is the one visual signature both pages share: open work
 * split by state, so "what is late or stuck" reads at a glance.
 */

export const STATUS_LABEL = {
  todo: 'To do',
  in_progress: 'In progress',
  pending: 'Blocked',
  under_review: 'In review',
  completed: 'Done',
  cancelled: 'Cancelled',
};

export const PRIORITY_LABEL = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };

export const PENDING_REASON_LABEL = {
  waiting_for_info: 'Waiting for information',
  awaiting_approval: 'Waiting for approval',
  blocked: 'Blocked',
  deferred: 'Deferred',
};

/** Workload segments, in the order they are drawn. `late` cuts across statuses. */
export const LOAD_STATES = [
  { key: 'late', label: 'Late' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'review', label: 'In review' },
  { key: 'todo', label: 'To do' },
];

const OPEN = ['todo', 'in_progress', 'pending', 'under_review'];
const DAY = 86400000;

export function isOpen(task) { return OPEN.includes(task.status); }

export function isLate(task, now = Date.now()) {
  return isOpen(task) && !!task.due_date && Number(task.due_date) < now;
}

/** The single state a task counts toward in the workload bar (null = closed). */
export function loadState(task, now = Date.now()) {
  if (!isOpen(task)) return null;
  if (isLate(task, now)) return 'late';
  if (task.status === 'pending') return 'blocked';
  if (task.status === 'under_review') return 'review';
  return task.status; // todo | in_progress
}

export function countLoad(tasks, now = Date.now()) {
  const counts = { late: 0, blocked: 0, in_progress: 0, review: 0, todo: 0 };
  for (const t of tasks) {
    const s = loadState(t, now);
    if (s) counts[s] += 1;
  }
  return counts;
}

/**
 * Stacked bar of open work. `counts` from countLoad(). Segments are plain
 * spans sized by flex-grow, so the bar needs no layout maths.
 */
export function workloadBarHtml(counts, { label = 'Open work by state', size = 'lg' } = {}) {
  const total = LOAD_STATES.reduce((n, s) => n + (counts[s.key] || 0), 0);
  if (!total) {
    return `<div class="wl-bar wl-bar-${size} is-empty" role="img" aria-label="${label}: nothing open"></div>`;
  }
  const parts = LOAD_STATES
    .filter((s) => counts[s.key])
    .map((s) => `<span class="wl-seg wl-${s.key}" style="flex-grow:${counts[s.key]}"></span>`)
    .join('');
  const text = LOAD_STATES.filter((s) => counts[s.key]).map((s) => `${counts[s.key]} ${s.label.toLowerCase()}`).join(', ');
  return `<div class="wl-bar wl-bar-${size}" role="img" aria-label="${label}: ${text}">${parts}</div>`;
}

/** "3 days late", "Due today", "Due tomorrow", "Due in 4 days", or a date. */
export function dueText(task, now = Date.now()) {
  if (!task.due_date) return { text: 'No due date', tone: 'muted' };
  const due = Number(task.due_date);
  if (!isOpen(task)) return { text: shortDate(due), tone: 'muted' };
  const startOf = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const days = Math.round((startOf(due) - startOf(now)) / DAY);
  if (due < now && days <= 0) {
    const late = Math.max(1, -days);
    return { text: days === 0 ? 'Due earlier today' : `${late} day${late === 1 ? '' : 's'} late`, tone: 'late' };
  }
  if (days === 0) return { text: 'Due today', tone: 'soon' };
  if (days === 1) return { text: 'Due tomorrow', tone: 'soon' };
  if (days < 7) return { text: `Due in ${days} days`, tone: 'normal' };
  return { text: `Due ${shortDate(due)}`, tone: 'normal' };
}

export function shortDate(ts) {
  if (!ts) return '';
  return new Date(Number(ts)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function dateTime(ts) {
  if (!ts) return '';
  return new Date(Number(ts)).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function relativeTime(ts, now = Date.now()) {
  if (!ts) return '';
  const mins = Math.round((now - Number(ts)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return shortDate(ts);
}

/** "2026-11-21" for <input type="date"> from a timestamp. */
export function toDateInput(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** End of the chosen day, as a timestamp. */
export function fromDateInput(value) {
  return value ? new Date(`${value}T23:59:59`).getTime() : null;
}

export function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
}

/**
 * Plain HTML escaping for text and attribute values. (The app-wide esc()
 * shows "-" for empty values, which is right for table cells but wrong inside
 * form fields, so these views use this instead.)
 */
export function escapeHtml(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
