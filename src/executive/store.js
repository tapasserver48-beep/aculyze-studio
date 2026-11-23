/**
 * Executive Agent — storage for daily check-ins (Phase 04.2a).
 *
 *   checkins   what to ask, whom, when (e.g. "Daily sales & calls" at 15:00)
 *   runs       one per check-in per day: when it was asked / escalated / summarized
 *   responses  one per person per check-in per day: the numbers they reported
 *
 * Storage: data/executive/*.json (JSON only for now; Postgres is a follow-up,
 * same as agent approvals).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dirOf = (dataDir) => path.join(dataDir, 'executive');
const fileOf = (dataDir, name) => path.join(dirOf(dataDir), `${name}.json`);

function readList(dataDir, name) {
  try {
    const doc = JSON.parse(fs.readFileSync(fileOf(dataDir, name), 'utf8'));
    return Array.isArray(doc.items) ? doc.items : [];
  } catch {
    return [];
  }
}

function writeList(dataDir, name, items) {
  fs.mkdirSync(dirOf(dataDir), { recursive: true });
  const file = fileOf(dataDir, name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ items }, null, 2));
  fs.renameSync(tmp, file);
}

const id = (prefix) => `${prefix}-${crypto.randomUUID().substring(0, 10)}`;

/* ---------------- check-ins ---------------- */

const DEFAULT_FIELDS = [{ key: 'sales', label: 'Sales' }, { key: 'calls', label: 'Calls' }];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function slug(label) {
  return String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'value';
}

/** Validate + normalize user input for a check-in. Throws {status:422}. */
function normalizeCheckin(input, prev = {}) {
  const fail = (msg) => { throw Object.assign(new Error(msg), { status: 422 }); };
  const out = { ...prev };
  if (input.title !== undefined || !prev.title) {
    out.title = String(input.title || '').trim().slice(0, 120);
    if (!out.title) fail('Give the check-in a name.');
  }
  if (input.question !== undefined || !prev.question) {
    out.question = String(input.question || '').trim().slice(0, 600);
    if (!out.question) fail('Write the question employees will answer.');
  }
  if (input.fields !== undefined || !prev.fields) {
    let labels = input.fields;
    if (typeof labels === 'string') labels = labels.split(',');
    if (!Array.isArray(labels)) labels = DEFAULT_FIELDS.map((f) => f.label);
    const fields = [];
    for (const l of labels) {
      const label = String((l && l.label) || l || '').trim().slice(0, 40);
      if (!label) continue;
      const key = slug(label);
      if (!fields.some((f) => f.key === key)) fields.push({ key, label });
    }
    if (!fields.length) fail('Add at least one number to collect, for example Sales, Calls.');
    if (fields.length > 8) fail('Collect at most 8 numbers per check-in.');
    out.fields = fields;
  }
  for (const k of ['askTime', 'deadlineTime']) {
    if (input[k] !== undefined || !prev[k]) {
      const v = String(input[k] || (k === 'askTime' ? '15:00' : '16:00')).trim();
      if (!TIME_RE.test(v)) fail(`${k === 'askTime' ? 'Ask time' : 'Deadline'} must look like 15:00.`);
      out[k] = v;
    }
  }
  if (out.deadlineTime <= out.askTime) fail('The deadline must be later in the day than the ask time.');
  if (input.days !== undefined || !prev.days) {
    const days = Array.isArray(input.days) ? input.days.map(Number).filter((d) => d >= 0 && d <= 6) : [1, 2, 3, 4, 5, 6];
    if (!days.length) fail('Pick at least one day.');
    out.days = [...new Set(days)].sort();
  }
  if (input.audienceRole !== undefined || !prev.audienceRole) {
    const role = String(input.audienceRole || 'employee');
    if (!['employee', 'manager', 'all'].includes(role)) fail('Unknown audience.');
    out.audienceRole = role;
  }
  if (input.active !== undefined) out.active = !!input.active;
  return out;
}

function listCheckins(dataDir) {
  return readList(dataDir, 'checkins').sort((a, b) => a.created_at - b.created_at);
}

function getCheckin(dataDir, checkinId) {
  return listCheckins(dataDir).find((c) => c.id === checkinId) || null;
}

function createCheckin(dataDir, input, createdBy) {
  const items = readList(dataDir, 'checkins');
  const checkin = { id: id('chk'), ...normalizeCheckin(input), active: input.active === undefined ? true : !!input.active, createdBy, created_at: Date.now(), updated_at: Date.now() };
  items.push(checkin);
  writeList(dataDir, 'checkins', items);
  return checkin;
}

function updateCheckin(dataDir, checkinId, input) {
  const items = readList(dataDir, 'checkins');
  const idx = items.findIndex((c) => c.id === checkinId);
  if (idx === -1) return null;
  items[idx] = { ...normalizeCheckin(input, items[idx]), updated_at: Date.now() };
  writeList(dataDir, 'checkins', items);
  return items[idx];
}

function deleteCheckin(dataDir, checkinId) {
  const items = readList(dataDir, 'checkins');
  const next = items.filter((c) => c.id !== checkinId);
  if (next.length === items.length) return false;
  writeList(dataDir, 'checkins', next);
  return true;
}

/* ---------------- runs (one per check-in per day) ---------------- */

function getRun(dataDir, checkinId, date) {
  return readList(dataDir, 'runs').find((r) => r.checkinId === checkinId && r.date === date) || null;
}

function listRuns(dataDir, checkinId) {
  return readList(dataDir, 'runs').filter((r) => !checkinId || r.checkinId === checkinId).sort((a, b) => (a.date < b.date ? 1 : -1));
}

function saveRun(dataDir, checkinId, date, patch) {
  const items = readList(dataDir, 'runs');
  const idx = items.findIndex((r) => r.checkinId === checkinId && r.date === date);
  const base = idx === -1 ? { checkinId, date, askedAt: null, audience: [], escalatedAt: null, summaryAt: null } : items[idx];
  const run = { ...base, ...patch };
  if (idx === -1) items.push(run); else items[idx] = run;
  writeList(dataDir, 'runs', items);
  return run;
}

/* ---------------- responses ---------------- */

function listResponses(dataDir, { checkinId, date, userId, since } = {}) {
  return readList(dataDir, 'responses').filter((r) => (!checkinId || r.checkinId === checkinId)
    && (!date || r.date === date)
    && (!userId || r.userId === userId)
    && (!since || r.date >= since));
}

/** Merge values into a person's response for that day (partial answers allowed). */
function upsertResponse(dataDir, { checkinId, date, userId, values, raw, late }) {
  const items = readList(dataDir, 'responses');
  const idx = items.findIndex((r) => r.checkinId === checkinId && r.date === date && r.userId === userId);
  const now = Date.now();
  const prev = idx === -1 ? null : items[idx];
  const merged = {
    checkinId, date, userId,
    values: { ...((prev && prev.values) || {}), ...values },
    raw: [...((prev && prev.raw) || []), String(raw || '').slice(0, 500)].slice(-5),
    submittedAt: (prev && prev.submittedAt) || now,
    updatedAt: now,
    late: prev ? prev.late && late : !!late,
  };
  if (idx === -1) items.push(merged); else items[idx] = merged;
  writeList(dataDir, 'responses', items);
  return { response: merged, updated: !!prev };
}

module.exports = {
  DEFAULT_FIELDS,
  normalizeCheckin,
  listCheckins, getCheckin, createCheckin, updateCheckin, deleteCheckin,
  getRun, listRuns, saveRun,
  listResponses, upsertResponse,
};
