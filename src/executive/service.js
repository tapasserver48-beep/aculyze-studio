/**
 * Executive Agent — daily check-ins over the Inbox (Phase 04.2a).
 *
 * Flow for one check-in (e.g. "Daily sales & calls", ask 15:00, deadline 16:00):
 *   15:00  ask      → Inbox message from the Executive Agent to everyone in the audience
 *   reply           → the person answers in chat ("sales 5, calls 20"); the agent reads the
 *                     numbers, confirms, and asks again for anything missing
 *   all in          → summary with totals + Excel link to the managers
 *   16:00  deadline → people who haven't answered get a reminder; their "reports to"
 *                     person (acting TL) and every manager get the list of who is
 *                     missing, plus the summary so far
 *
 * The clock is checked by tick() once a minute (server.js). Times use
 * APP_TIMEZONE when set, otherwise the server's local time zone.
 */

const store = require('./store');
const authStore = require('../auth/store');
const { sendMessage } = require('../inbox/store');
const { findByCode, initializeEmployee, EMPLOYEE_CODES } = require('../employees/store');

const MANAGER_ROLES = ['manager', 'admin', 'founder'];

/* ---------------- time ---------------- */

function timeZone(env = process.env) {
  return String(env.APP_TIMEZONE || '').trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** { date: 'YYYY-MM-DD', hm: 'HH:MM', weekday: 0-6 } in the app time zone. */
function localParts(now = Date.now(), tz = timeZone()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hm: `${parts.hour}:${parts.minute}`, weekday };
}

function prettyDate(date) {
  const d = new Date(`${date}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/* ---------------- people ---------------- */

async function executiveAgent(dataDir) {
  let emp = await findByCode(dataDir, EMPLOYEE_CODES.EXECUTIVE);
  if (!emp) {
    const created = await initializeEmployee(dataDir, EMPLOYEE_CODES.EXECUTIVE);
    emp = created && created.employee;
  }
  return emp && emp.status === 'active' ? emp : null;
}

async function users(dataDir) {
  return (await authStore.listUsers(dataDir)) || [];
}

function audienceOf(checkin, all) {
  if (checkin.audienceRole === 'all') return all.filter((u) => u.role !== 'founder');
  return all.filter((u) => (u.role || 'employee') === checkin.audienceRole);
}

async function post(dataDir, agent, userId, body) {
  try {
    return await sendMessage(dataDir, {
      from: agent.id,
      fromName: agent.name,
      to: `usr-${userId}`,
      toName: '',
      peerRole: agent.designation || 'Executive Agent',
      body: String(body).slice(0, 3800),
      generated: true,
    });
  } catch (err) {
    console.warn(`[executive] inbox post failed: ${err.message}`);
    return null;
  }
}

/* ---------------- report ---------------- */

/** Who answered, their numbers, totals, and who is missing — for one day. */
async function buildReport(dataDir, checkin, date, allUsers = null) {
  const everyone = allUsers || await users(dataDir);
  const run = store.getRun(dataDir, checkin.id, date);
  // Audience = who was actually asked that day (falls back to current audience).
  const askedIds = run && run.audience && run.audience.length ? run.audience : audienceOf(checkin, everyone).map((u) => u.id);
  const byId = new Map(everyone.map((u) => [u.id, u]));
  const responses = new Map(store.listResponses(dataDir, { checkinId: checkin.id, date }).map((r) => [r.userId, r]));
  const totals = Object.fromEntries(checkin.fields.map((f) => [f.key, 0]));
  const rows = askedIds.map((uid) => {
    const u = byId.get(uid) || { id: uid, name: 'Former user' };
    const r = responses.get(uid);
    const complete = !!r && checkin.fields.every((f) => typeof r.values[f.key] === 'number');
    if (r) for (const f of checkin.fields) if (typeof r.values[f.key] === 'number') totals[f.key] += r.values[f.key];
    return {
      userId: uid,
      name: u.name || u.email || 'Unnamed',
      managerId: u.managerId || null,
      status: complete ? (r.late ? 'late' : 'submitted') : r ? 'partial' : 'missing',
      values: r ? r.values : {},
      submittedAt: r ? r.submittedAt : null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const submitted = rows.filter((r) => r.status === 'submitted' || r.status === 'late').length;
  return {
    checkinId: checkin.id,
    title: checkin.title,
    fields: checkin.fields,
    date,
    asked: !!(run && run.askedAt),
    askedAt: run ? run.askedAt : null,
    escalatedAt: run ? run.escalatedAt : null,
    rows,
    totals,
    submitted,
    total: rows.length,
    missing: rows.filter((r) => r.status === 'missing' || r.status === 'partial'),
  };
}

function totalsLine(report) {
  return report.fields.map((f) => `**${f.label}: ${report.totals[f.key]}**`).join(' · ');
}

/* ---------------- ask / escalate / summarize ---------------- */

async function askNow(dataDir, checkin, date, { force = false } = {}) {
  const agent = await executiveAgent(dataDir);
  if (!agent) return { asked: 0, reason: 'Executive Agent is not active' };
  const run = store.getRun(dataDir, checkin.id, date);
  if (run && run.askedAt && !force) return { asked: 0, reason: 'already asked' };
  const audience = audienceOf(checkin, await users(dataDir));
  const example = checkin.fields.map((f, i) => `${f.label} ${[5, 20, 3, 10][i % 4]}`).join(', ');
  for (const u of audience) {
    await post(dataDir, agent, u.id,
      `📋 **${checkin.title}** (${prettyDate(date)})\n\n${checkin.question}\n\nJust reply here with your numbers, for example: "${example}". Please answer by ${checkin.deadlineTime}.`);
  }
  store.saveRun(dataDir, checkin.id, date, { askedAt: Date.now(), audience: audience.map((u) => u.id) });
  return { asked: audience.length };
}

/** Summary (+ Excel link token) to the check-in's creator and every manager. */
async function sendSummary(dataDir, checkin, report, { headline } = {}) {
  const agent = await executiveAgent(dataDir);
  if (!agent) return 0;
  const everyone = await users(dataDir);
  const recipients = new Set(everyone.filter((u) => MANAGER_ROLES.includes(u.role) && u.role !== 'founder').map((u) => u.id));
  if (checkin.createdBy) recipients.add(checkin.createdBy);
  const missingNames = report.missing.map((r) => r.name);
  const body = [
    `📊 **${checkin.title}**, ${prettyDate(report.date)}`,
    headline || '',
    `${report.submitted} of ${report.total} submitted. ${totalsLine(report)}`,
    missingNames.length ? `Not submitted yet: ${missingNames.join(', ')}` : '✅ Everyone has submitted.',
    `[checkin:${checkin.id}:${report.date}]`,
  ].filter(Boolean).join('\n\n');
  for (const uid of recipients) await post(dataDir, agent, uid, body);
  store.saveRun(dataDir, checkin.id, report.date, { summaryAt: Date.now() });
  return recipients.size;
}

/**
 * Deadline passed: remind each person who hasn't answered, tell each one's
 * "reports to" person (acting TL) and every manager who is missing.
 */
async function escalate(dataDir, checkin, date) {
  const agent = await executiveAgent(dataDir);
  if (!agent) return { reminded: 0, notified: 0 };
  const everyone = await users(dataDir);
  const report = await buildReport(dataDir, checkin, date, everyone);
  const missing = report.missing;

  for (const m of missing) {
    await post(dataDir, agent, m.userId,
      `⏰ Reminder: you haven't sent today's **${checkin.title}** yet (it was due at ${checkin.deadlineTime}).\n\n${checkin.question}\n\nReply here with your numbers.`);
  }

  // Acting TLs: the "reports to" person of each missing employee (if not a manager — they get the full summary).
  const managerIds = new Set(everyone.filter((u) => MANAGER_ROLES.includes(u.role) && u.role !== 'founder').map((u) => u.id));
  const byTl = new Map();
  for (const m of missing) {
    if (m.managerId && !managerIds.has(m.managerId) && m.managerId !== checkin.createdBy) {
      if (!byTl.has(m.managerId)) byTl.set(m.managerId, []);
      byTl.get(m.managerId).push(m.name);
    }
  }
  for (const [tlId, names] of byTl) {
    await post(dataDir, agent, tlId,
      `⚠️ **${checkin.title}**, ${prettyDate(date)}: your team members who haven't submitted yet: ${names.join(', ')}.\n\n[checkin:${checkin.id}:${date}]`);
  }

  const notified = await sendSummary(dataDir, checkin, report, {
    headline: missing.length ? `⏰ The ${checkin.deadlineTime} deadline has passed.` : '',
  });
  store.saveRun(dataDir, checkin.id, date, { escalatedAt: Date.now() });
  return { reminded: missing.length, notified: notified + byTl.size };
}

/* ---------------- the clock ---------------- */

/** Called every minute. Asks at askTime, escalates at deadlineTime (once per day each). */
async function tick(dataDir, now = Date.now()) {
  const { date, hm, weekday } = localParts(now);
  const done = [];
  for (const c of store.listCheckins(dataDir)) {
    if (!c.active || !c.days.includes(weekday)) continue;
    const run = store.getRun(dataDir, c.id, date);
    if (hm >= c.askTime && !(run && run.askedAt) && hm < c.deadlineTime) {
      done.push({ id: c.id, action: 'ask', ...(await askNow(dataDir, c, date)) });
    }
    const after = store.getRun(dataDir, c.id, date);
    if (hm >= c.deadlineTime && after && after.askedAt && !after.escalatedAt) {
      done.push({ id: c.id, action: 'escalate', ...(await escalate(dataDir, c, date)) });
    }
  }
  return done;
}

let timer = null;
function startScheduler(dataDir, { intervalMs = 60000 } = {}) {
  if (timer) return;
  const run = () => tick(dataDir).catch((err) => console.warn(`[executive] tick failed: ${err.message}`));
  timer = setInterval(run, intervalMs);
  if (timer.unref) timer.unref();
  setTimeout(run, 5000).unref?.();
}

/* ---------------- replies ---------------- */

const WORD_NUMBERS = { zero: 0, no: 0, none: 0, nil: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const NUM = '(\\d+(?:\\.\\d+)?|zero|no|none|nil|one|two|three|four|five|six|seven|eight|nine|ten)';

function toNumber(s) {
  const k = String(s).toLowerCase();
  return k in WORD_NUMBERS ? WORD_NUMBERS[k] : Number(k);
}

/**
 * Pull each field's number out of free text: "sales 5, calls 20",
 * "5 sales and 20 calls", "no sales today, 12 calls".
 * Each field mention is paired with its NEAREST number (before or after),
 * closest pairs first, each number used once, and never across another
 * number — so "5 sales and 20 calls" gives sales 5, calls 20.
 */
function parseValues(text, fields) {
  const out = {};
  const t = String(text || '').toLowerCase();
  const numbers = [];
  for (const m of t.matchAll(new RegExp(`\\b${NUM}\\b`, 'g'))) {
    numbers.push({ start: m.index, end: m.index + m[0].length, value: toNumber(m[1]) });
  }
  const pairs = [];
  fields.forEach((f, fi) => {
    const words = [...new Set([f.label, f.key.replace(/_/g, ' ')].map((w) => w.toLowerCase().trim().replace(/s$/, '')))]
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 's?');
    for (const m of t.matchAll(new RegExp(`\\b(?:${words.join('|')})\\b`, 'g'))) {
      const ws = m.index;
      const we = m.index + m[0].length;
      numbers.forEach((n, ni) => {
        const [a, b] = n.end <= ws ? [n.end, ws] : n.start >= we ? [we, n.start] : [0, -1];
        if (b < a) return;
        const gap = t.slice(a, b);
        if (gap.length > 25 || /\d/.test(gap) || /[\n;]/.test(gap)) return;
        pairs.push({ fi, ni, dist: gap.length });
      });
    }
  });
  pairs.sort((x, y) => x.dist - y.dist);
  const usedF = new Set();
  const usedN = new Set();
  for (const p of pairs) {
    if (usedF.has(p.fi) || usedN.has(p.ni)) continue;
    const n = numbers[p.ni].value;
    if (!Number.isFinite(n) || n < 0 || n >= 1e9) continue;
    out[fields[p.fi].key] = n;
    usedF.add(p.fi);
    usedN.add(p.ni);
  }
  // Keep the caller's field order in the result.
  const ordered = {};
  for (const f of fields) if (out[f.key] !== undefined) ordered[f.key] = out[f.key];
  Object.keys(out).forEach((k) => delete out[k]);
  Object.assign(out, ordered);
  // A single field and a single bare number: "15".
  if (fields.length === 1 && out[fields[0].key] === undefined) {
    const nums = t.match(/\b\d+(?:\.\d+)?\b/g);
    if (nums && nums.length === 1) out[fields[0].key] = Number(nums[0]);
  }
  return out;
}

/** Model fallback for phrasing the regex can't read. Never throws. */
async function parseWithModel(text, fields, provider) {
  if (!provider) return {};
  try {
    const res = await provider.sendMessage({
      messages: [
        { role: 'system', content: 'Extract numbers from an employee\'s daily report. Reply with JSON only.' },
        { role: 'user', content: `Fields: ${fields.map((f) => `"${f.key}" (${f.label})`).join(', ')}.\nMessage: """${String(text).slice(0, 800)}"""\nReturn {"<key>": number or null} for every field. Use null when the message does not state it.` },
      ],
      temperature: 0, max_tokens: 200, thinking: false, timeoutMs: 20000,
    });
    const raw = String(res && res.content || '');
    const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    const out = {};
    for (const f of fields) if (typeof j[f.key] === 'number' && j[f.key] >= 0) out[f.key] = j[f.key];
    return out;
  } catch {
    return {};
  }
}

/** Today's asked check-ins this person belongs to. */
function openCheckinsFor(dataDir, userId, now = Date.now()) {
  const { date } = localParts(now);
  return store.listCheckins(dataDir)
    .map((c) => ({ c, run: store.getRun(dataDir, c.id, date) }))
    .filter(({ run }) => run && run.askedAt && (run.audience || []).includes(userId))
    .map(({ c, run }) => ({ checkin: c, run, date }));
}

/**
 * A person messaged the Executive Agent. If they owe a check-in today, read
 * their numbers and reply. Returns true when handled (so the normal chat
 * reply is skipped), false otherwise.
 */
async function handleReply(dataDir, { employeeId, userId, text, provider = null, now = Date.now() }) {
  const open = openCheckinsFor(dataDir, userId, now);
  if (!open.length) return false;
  const agent = await executiveAgent(dataDir);
  if (!agent || (employeeId && agent.id !== employeeId)) return false;
  const { hm } = localParts(now);

  // Prefer a check-in this person hasn't completed yet.
  const pick = open.find(({ checkin, date }) => {
    const r = store.listResponses(dataDir, { checkinId: checkin.id, date, userId })[0];
    return !r || !checkin.fields.every((f) => typeof r.values[f.key] === 'number');
  }) || open[0];
  const { checkin, date } = pick;

  let values = parseValues(text, checkin.fields);
  const hasDigits = /\d|\b(zero|none|nil)\b/i.test(text);
  if (Object.keys(values).length < checkin.fields.length && hasDigits) {
    values = { ...(await parseWithModel(text, checkin.fields, provider)), ...values };
  }
  if (!Object.keys(values).length) {
    if (!hasDigits) return false; // ordinary chat — let the normal chat reply handle it
    await post(dataDir, agent, userId,
      `I couldn't read the numbers. Please reply like: "${checkin.fields.map((f) => `${f.label} 5`).join(', ')}".`);
    return true;
  }

  const late = hm >= checkin.deadlineTime;
  const before = store.listResponses(dataDir, { checkinId: checkin.id, date, userId })[0];
  const wasComplete = !!before && checkin.fields.every((f) => typeof before.values[f.key] === 'number');
  const { response } = store.upsertResponse(dataDir, { checkinId: checkin.id, date, userId, values, raw: text, late });
  const missingFields = checkin.fields.filter((f) => typeof response.values[f.key] !== 'number');
  const got = checkin.fields.filter((f) => typeof response.values[f.key] === 'number').map((f) => `${f.label}: **${response.values[f.key]}**`).join(', ');

  if (missingFields.length) {
    await post(dataDir, agent, userId, `Got ${got}. What about **${missingFields.map((f) => f.label).join(' and ')}**?`);
    return true;
  }
  await post(dataDir, agent, userId,
    `✅ ${wasComplete ? 'Updated' : 'Thanks, recorded'}: ${got}${late ? ' (after the deadline)' : ''}. You can send new numbers any time today to correct them.`);

  // Everyone in before the deadline → send the managers the summary right away.
  const report = await buildReport(dataDir, checkin, date);
  const run = store.getRun(dataDir, checkin.id, date);
  if (!report.missing.length && run && !run.summaryAt && !late) {
    await sendSummary(dataDir, checkin, report, { headline: '✅ Everyone submitted before the deadline.' });
  }
  return true;
}

/* ---------------- dashboard ---------------- */

/** Team performance: tasks + check-in discipline + reported totals (last 7 days). */
async function dashboard(dataDir, { listTasks }) {
  const DAY = 86400000;
  const now = Date.now();
  const everyone = (await users(dataDir)).filter((u) => u.role !== 'founder');
  const tasks = await listTasks(dataDir, { limit: 10000 });
  const open = new Set(['todo', 'in_progress', 'pending', 'under_review']);
  const since = localParts(now - 6 * DAY).date;
  const checkins = store.listCheckins(dataDir);
  const runs = store.listRuns(dataDir).filter((r) => r.date >= since && r.askedAt);
  const responses = store.listResponses(dataDir, { since });

  const fieldTotals = {};
  const people = everyone.map((u) => {
    const mine = tasks.filter((t) => t.assigned_to_id === u.id);
    const asked = runs.filter((r) => (r.audience || []).includes(u.id));
    const answered = asked.filter((r) => responses.some((x) => x.checkinId === r.checkinId && x.date === r.date && x.userId === u.id));
    const sums = {};
    for (const x of responses.filter((r) => r.userId === u.id)) {
      const c = checkins.find((k) => k.id === x.checkinId);
      for (const f of (c && c.fields) || []) {
        if (typeof x.values[f.key] !== 'number') continue;
        sums[f.label] = (sums[f.label] || 0) + x.values[f.key];
        fieldTotals[f.label] = (fieldTotals[f.label] || 0) + x.values[f.key];
      }
    }
    return {
      id: u.id,
      name: u.name || u.email,
      role: u.role || 'employee',
      managerId: u.managerId || null,
      openTasks: mine.filter((t) => open.has(t.status)).length,
      overdue: mine.filter((t) => open.has(t.status) && t.due_date && Number(t.due_date) < now).length,
      completed30d: mine.filter((t) => t.status === 'completed' && Number(t.completed_at || 0) > now - 30 * DAY).length,
      checkinsAsked: asked.length,
      checkinsAnswered: answered.length,
      sums,
    };
  });
  return {
    since,
    today: localParts(now).date,
    timeZone: timeZone(),
    people,
    fieldTotals,
    totals: {
      people: people.length,
      openTasks: people.reduce((a, p) => a + p.openTasks, 0),
      overdue: people.reduce((a, p) => a + p.overdue, 0),
      completed30d: people.reduce((a, p) => a + p.completed30d, 0),
    },
  };
}

module.exports = {
  localParts, timeZone, prettyDate,
  executiveAgent, buildReport, askNow, escalate, sendSummary, tick, startScheduler,
  parseValues, handleReply, openCheckinsFor, dashboard,
};
