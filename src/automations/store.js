/**
 * Automations storage (Phase 04.2).
 *
 *   automations  "when X → AI employee does Y" rules
 *   history      one entry per firing (trigger, task created, outcome)
 *   seen         per-automation keys already handled (email ids, lead ids,
 *                task ids, schedule slots) so nothing fires twice
 *
 * Storage: data/automations/*.json (JSON only for now, like the rest of 04.x).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TRIGGERS = ['schedule', 'email', 'lead', 'overdue'];
const MANAGER_ONLY_TRIGGERS = ['lead', 'overdue'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_HISTORY = 2000;
const MAX_SEEN = 1000;

const dirOf = (dataDir) => path.join(dataDir, 'automations');
const fileOf = (dataDir, name) => path.join(dirOf(dataDir), `${name}.json`);

function read(dataDir, name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(fileOf(dataDir, name), 'utf8'));
  } catch {
    return fallback;
  }
}

function write(dataDir, name, doc) {
  fs.mkdirSync(dirOf(dataDir), { recursive: true });
  const file = fileOf(dataDir, name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, file);
}

const fail = (msg) => { throw Object.assign(new Error(msg), { status: 422 }); };

/* ---------------- validation ---------------- */

function normalizeTrigger(t) {
  const type = String((t && t.type) || '');
  if (!TRIGGERS.includes(type)) fail('Choose when the automation should run.');
  if (type === 'schedule') {
    const mode = t.mode === 'interval' ? 'interval' : 'daily';
    const days = Array.isArray(t.days) && t.days.length ? [...new Set(t.days.map(Number).filter((d) => d >= 0 && d <= 6))].sort() : [1, 2, 3, 4, 5];
    if (!days.length) fail('Pick at least one day.');
    if (mode === 'daily') {
      const time = String(t.time || '09:00');
      if (!TIME_RE.test(time)) fail('Time must look like 09:00.');
      return { type, mode, time, days };
    }
    const everyHours = Math.round(Number(t.everyHours) || 0);
    if (everyHours < 1 || everyHours > 12) fail('Run every 1 to 12 hours.');
    const from = TIME_RE.test(String(t.from || '')) ? t.from : '09:00';
    const to = TIME_RE.test(String(t.to || '')) ? t.to : '19:00';
    if (to <= from) fail('The working hours must end after they start.');
    return { type, mode, everyHours, from, to, days };
  }
  if (type === 'email') {
    const clean = (v, n) => String(v || '').replace(/["\n\r]/g, ' ').trim().slice(0, n);
    const out = { type, from: clean(t.from, 120), subject: clean(t.subject, 120), words: clean(t.words, 160) };
    if (!out.from && !out.subject && !out.words) fail('Add at least one email filter (sender, subject or words), so not every email starts a run.');
    return out;
  }
  if (type === 'lead') return { type, chatbotId: t.chatbotId ? String(t.chatbotId).slice(0, 80) : '' };
  const assignee = ['human', 'ai', 'any'].includes(t.assignee) ? t.assignee : 'human';
  return { type, assignee };
}

function normalize(input, prev = {}) {
  const out = { ...prev };
  if (input.name !== undefined || !prev.name) {
    out.name = String(input.name || '').trim().slice(0, 120);
    if (!out.name) fail('Give the automation a name.');
  }
  if (input.instruction !== undefined || !prev.instruction) {
    out.instruction = String(input.instruction || '').trim().slice(0, 3000);
    if (out.instruction.length < 10) fail('Write what the AI employee should do (at least a sentence).');
  }
  if (input.employeeId !== undefined || !prev.employeeId) {
    out.employeeId = String(input.employeeId || '');
    if (!out.employeeId.startsWith('emp-ai-')) fail('Choose which AI employee does the work.');
  }
  if (input.trigger !== undefined || !prev.trigger) out.trigger = normalizeTrigger(input.trigger);
  if (input.maxRunsPerDay !== undefined || !prev.maxRunsPerDay) {
    out.maxRunsPerDay = Math.max(1, Math.min(50, Math.round(Number(input.maxRunsPerDay) || 10)));
  }
  if (input.active !== undefined) out.active = !!input.active;
  return out;
}

/* ---------------- automations ---------------- */

function list(dataDir) {
  return read(dataDir, 'automations', { items: [] }).items || [];
}

function get(dataDir, id) {
  return list(dataDir).find((a) => a.id === id) || null;
}

function save(dataDir, items) {
  write(dataDir, 'automations', { items });
}

function create(dataDir, input, ownerId) {
  const items = list(dataDir);
  const a = {
    id: `auto-${crypto.randomUUID().slice(0, 10)}`,
    ...normalize(input),
    active: input.active === undefined ? true : !!input.active,
    ownerId,
    created_at: Date.now(),
    updated_at: Date.now(),
    lastRunAt: null,
    lastError: null,
    lastCheckedAt: null,
    baselined: false,
  };
  items.push(a);
  save(dataDir, items);
  return a;
}

function update(dataDir, id, input) {
  const items = list(dataDir);
  const idx = items.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  const next = { ...normalize(input, items[idx]), updated_at: Date.now() };
  // A changed email filter starts from "now" again.
  if (input.trigger && JSON.stringify(next.trigger) !== JSON.stringify(items[idx].trigger)) next.baselined = false;
  if (input.active === true && !items[idx].active) next.lastError = null;
  items[idx] = next;
  save(dataDir, items);
  return next;
}

/** Internal bookkeeping fields (lastRunAt, lastError, baselined…), no validation. */
function patch(dataDir, id, fields) {
  const items = list(dataDir);
  const idx = items.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  items[idx] = { ...items[idx], ...fields };
  save(dataDir, items);
  return items[idx];
}

function remove(dataDir, id) {
  const items = list(dataDir);
  const next = items.filter((a) => a.id !== id);
  if (next.length === items.length) return false;
  save(dataDir, next);
  const seen = read(dataDir, 'seen', {});
  delete seen[id];
  write(dataDir, 'seen', seen);
  return true;
}

/* ---------------- seen keys ---------------- */

function hasSeen(dataDir, id, key) {
  const seen = read(dataDir, 'seen', {});
  return Array.isArray(seen[id]) && seen[id].includes(key);
}

function markSeen(dataDir, id, keys) {
  const seen = read(dataDir, 'seen', {});
  const list_ = Array.isArray(seen[id]) ? seen[id] : [];
  for (const k of [].concat(keys)) if (!list_.includes(k)) list_.push(k);
  seen[id] = list_.slice(-MAX_SEEN);
  write(dataDir, 'seen', seen);
}

/* ---------------- history ---------------- */

function addHistory(dataDir, entry) {
  const doc = read(dataDir, 'history', { items: [] });
  const item = { id: `hist-${crypto.randomUUID().slice(0, 10)}`, at: Date.now(), ...entry };
  doc.items = [...(doc.items || []), item].slice(-MAX_HISTORY);
  write(dataDir, 'history', doc);
  return item;
}

function updateHistory(dataDir, histId, fields) {
  const doc = read(dataDir, 'history', { items: [] });
  const idx = (doc.items || []).findIndex((h) => h.id === histId);
  if (idx === -1) return null;
  doc.items[idx] = { ...doc.items[idx], ...fields };
  write(dataDir, 'history', doc);
  return doc.items[idx];
}

function listHistory(dataDir, { automationId, since, limit = 50 } = {}) {
  return (read(dataDir, 'history', { items: [] }).items || [])
    .filter((h) => (!automationId || h.automationId === automationId) && (!since || h.at >= since))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}

module.exports = {
  TRIGGERS, MANAGER_ONLY_TRIGGERS,
  normalize, list, get, create, update, patch, remove,
  hasSeen, markSeen, addHistory, updateHistory, listHistory,
};
