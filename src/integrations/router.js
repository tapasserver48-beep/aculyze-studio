/**
 * Integration router — turns a plain-language request + the user's *connected*
 * apps into a tool plan (§10–§11).
 *
 * Deterministic heuristics (no model round-trip): pick the apps the message
 * needs, extract search terms / dates, and choose read tools. Write intents
 * (send mail, create events, post to Teams) are returned as a confirmation
 * request — never executed silently (§12).
 *
 * Returns:
 *   { reads: [{ tool, args, after? }], write: { tool, args } | null,
 *     notice: string | null }
 */

const { TOOLS } = require('./tools');
const { classifyLmsIntent } = require('../lms/intents');

const MAX_APPS = 3;
const MAX_READS = 4;

// --------------------------- text helpers ---------------------------

function extractQuery(message) {
  let s = String(message || '');
  s = s.replace(/https?:\/\/\S+/g, ' ');
  s = s.replace(/["“”']/g, ' ');
  s = s.replace(/[\/\\]+/g, ' '); // "/customers" → "customers"
  const patterns = [
    /^\s*(please\s+)?(can|could|would|will)\s+(you\s+)?/i,
    /\b(search|find|look\s*up|check|show|show me|get|fetch|read|give me|list|retrieve|open|summarize|summarise|spot|locate|grab)\b/gi,
    /\b(my|me|the|a|an|in|from|for|of|to|on|about|with|into|that|which|whose|is|are|any|some|all|and|or|if|was|were|there|it|its|this|these|those|has|have|had|by|at|as|be|been|will|would|should|today|tomorrow|yesterday|week|month|year|next|this)\b/gi,
    /\b(gmail|google\s*calendar|calendar|schedule|agenda|google\s*drive|drive|google\s*docs?|docs?|google\s*sheets?|sheets?|spreadsheets?|outlook|mailbox|mail|emails?|inbox|microsoft|teams|onedrive|one\s*drive|sharepoint|canva|designs?|lms|aculyze|slack|notion|salesforce|hubspot)\b/gi,
    /\b(latest|recent|recently|newest|important|urgent|today'?s?|yesterday'?s?)\b/gi,
  ];
  for (const p of patterns) s = s.replace(p, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, 80);
}

function extractEmail(message) {
  const m = String(message || '').match(/[^\s@,;<>"]+@[^\s@,;<>"]+\.[a-z]{2,}/i);
  return m ? m[0] : '';
}

function mailArgs(message) {
  const to = extractEmail(message);
  let subject = '';
  const sm = message.match(/\b(?:about|regarding|subject(?:\s+is)?)\s+["“']?([^"”'.!?]{3,100})/i);
  if (sm) subject = sm[1].trim();
  let body = '';
  const bm = message.match(/\b(?:saying|that says|that reads|message(?:\s+body)?(?:\s+is)?|with (?:the )?(?:message|text))\s*[:=]?\s*["“']?([^"”']+)$/i);
  if (bm && bm[1].trim().length > 1) body = bm[1].trim();
  const quoted = message.match(/["“']([^"”']{5,})["”']/);
  if (!body && quoted) body = quoted[1];
  if (!body) body = String(message || '').trim();
  return {
    to,
    subject: subject ? subject.slice(0, 120) : 'Message from Zara',
    body: body.slice(0, 1500),
  };
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function parseWhen(message) {
  const now = new Date();
  let dayOffset = null;
  if (/day after tomorrow/i.test(message)) dayOffset = 2;
  else if (/\btomorrow\b/i.test(message)) dayOffset = 1;
  else if (/\btoday\b/i.test(message)) dayOffset = 0;
  else {
    const wd = message.match(/\b(?:next\s+|on\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
    if (wd) {
      const target = WEEKDAYS.indexOf(wd[1].toLowerCase());
      dayOffset = (target - now.getDay() + 7) % 7;
      if (dayOffset === 0) dayOffset = 7;
      if (/next\s/i.test(wd[0]) && dayOffset < 7) dayOffset += 7;
    }
  }
  let hour = null;
  let minute = 0;
  const t = message.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i)
    || message.match(/\b(\d{1,2})(?::(\d{2}))\s*(am|pm)\b/i);
  if (t) {
    hour = Number(t[1]);
    minute = t[2] ? Number(t[2]) : 0;
    const mer = (t[3] || '').toLowerCase();
    if (mer === 'pm' && hour < 12) hour += 12;
    if (mer === 'am' && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return null;
  }
  if (dayOffset === null && hour === null) return null;
  if (dayOffset === null) {
    // Time given without a day → today if still ahead, otherwise tomorrow.
    const probe = new Date(now); probe.setHours(hour || 9, minute || 0, 0, 0);
    dayOffset = probe > now ? 0 : 1;
  }
  const start = new Date(now);
  start.setDate(start.getDate() + dayOffset);
  start.setHours(hour === null ? 9 : hour, hour === null ? 0 : minute, 0, 0);
  const end = new Date(start.getTime() + 30 * 60000);
  return { start: start.toISOString(), end: end.toISOString(), label: start.toString().slice(0, 24) };
}

/** Calendar window from relative date words (defaults to the next 7 days). */
function calendarWindow(message) {
  const now = new Date();
  const day = (d) => { const x = new Date(now); x.setDate(x.getDate() + d); return x.toISOString(); };
  if (/\btoday\b/i.test(message)) return { from: day(0), to: day(0).slice(0, 10) + 'T23:59:59Z' };
  if (/\btomorrow\b/i.test(message)) return { from: day(1), to: day(1).slice(0, 10) + 'T23:59:59Z' };
  if (/\bnext week\b/i.test(message)) return { from: day(0), to: day(7) };
  if (/\byesterday\b/i.test(message)) return { from: day(-1), to: day(-1).slice(0, 10) + 'T23:59:59Z' };
  if (/\bthis week\b/i.test(message)) return { from: day(0), to: day(4) };
  return { from: day(0), to: day(7) };
}

function eventArgs(message) {
  const when = parseWhen(message);
  if (!when) return { error: "When should that be? Include a day or time — e.g. \"tomorrow at 3 PM\"." };
  let summary = '';
  const sm = message.match(/\b(?:meeting|appointment|event|call|demo|session|interview)\s+(?:with\s+)?([^]+?)(?=\s+(?:tomorrow|today|on\s+(?:next\s+)?\w+day|at\s+\d)|[.,!?]|$)/i);
  if (sm && sm[1].trim().length > 1) {
    const kind = (message.match(/\b(meeting|appointment|event|call|demo|session|interview)\b/i) || ['Meeting'])[1];
    summary = `${kind.charAt(0).toUpperCase()}${kind.slice(1)} with ${sm[1].trim()}`.slice(0, 100);
  } else {
    const kind = (message.match(/\b(meeting|appointment|event|call|demo|session|interview)\b/i) || ['Event'])[1];
    summary = kind.charAt(0).toUpperCase() + kind.slice(1);
  }
  return { summary, start: when.start, end: when.end };
}

function teamsArgs(message) {
  let chatQuery = '';
  const cm = message.match(/\b(?:teams\s+)?(?:to|in|on|for)\s+(?:the\s+)?(?:chat\s+|channel\s+)?["“']?([^"”.',:!?]{2,60})/i);
  if (cm && !/^(me|my|a|an|this|it)\b/i.test(cm[1].trim())) chatQuery = cm[1].trim();
  let text = '';
  const tm = message.match(/\b(?:saying|that says|message(?:\s+is)?|text(?:\s+is)?)\s*[:=]?\s*["“']?([^"”']+)$/i);
  if (tm && tm[1].trim().length > 1) text = tm[1].trim();
  const quoted = message.match(/["“']([^"”']{3,})["”']/);
  if (!text && quoted) text = quoted[1];
  if (!text) text = `Message from Zara: ${extractQuery(message) || 'Hello!'}`;
  return { chatQuery, text: text.slice(0, 1000) };
}

// --------------------------- rules ---------------------------

function docIdFromMessage(message) {
  const u = String(message || '').match(/docs\.google\.com\/(?:document|spreadsheets)\/d\/([a-zA-Z0-9_-]{10,})/);
  return u ? u[1] : '';
}

/** Write intents — checked first; always confirmed before execution. */
function detectWrite(message, connected) {
  const m = String(message || '');
  const has = (id) => connected[id] && connected[id].status === 'connected';

  if (has('teams') && /\bteams\b/i.test(m) && /\b(send|post|share|message)\b/i.test(m)) {
    const args = teamsArgs(m);
    return { tool: 'teams.send_message', args };
  }
  // "email john@x.com …" (bare verb) must count, not only "send/mail/draft …"
  const wantsMail = /\b(send|mail|draft|write|compose|email)\b/i.test(m) && /\b(email|e-mail|mail|message to)\b/i.test(m);
  const recipient = extractEmail(m) || /\bto\b/i.test(m);
  if (wantsMail && recipient) {
    const isDraft = /\bdraft\b/i.test(m) && !/\bsend\b/i.test(m);
    if (has('gmail')) return { tool: isDraft ? 'gmail.create_draft' : 'gmail.send_message', args: mailArgs(m) };
    if (has('outlook')) return { tool: isDraft ? 'outlook.create_draft' : 'outlook.send_mail', args: mailArgs(m) };
    return { notice: 'Connect Gmail or Outlook in Settings → Apps & Integrations to send email.' };
  }
  const wantsEvent = /\b(schedule|create|add|book|set\s*up|make|plan)\b/i.test(m)
    && /\b(meeting|appointment|event|call|demo|session|interview)\b/i.test(m);
  if (wantsEvent) {
    const args = eventArgs(m);
    if (args.error) return { notice: args.error };
    if (has('gcal')) return { tool: 'calendar.create_event', args };
    if (has('mscal')) return { tool: 'mscalendar.create_event', args };
    return { notice: 'Connect Google Calendar or Microsoft Calendar in Settings → Apps & Integrations first.' };
  }
  return null;
}

/** Read intents per connected app (keyword-gated, so plain chat does nothing). */
function detectReads(message, connected) {
  const m = String(message || '');
  const low = m.toLowerCase();
  const has = (id) => connected[id] && connected[id].status === 'connected';
  const picks = [];

  const q = extractQuery(m);
  const wantsContent = /\b(read|summarize|summarise|open|contents?|what does|says|full text|expand)\b/i.test(m);
  const id = docIdFromMessage(m);

  if (has('gmail') && /\bgmail\b|\binbox\b|\bemails?\b|\bmail\b/.test(low)) {
    picks.push({ app: 'gmail', tools: [{ tool: 'gmail.search', args: { q } }] });
  }
  if (has('outlook') && /\boutlook\b|\bmailbox\b|\bemails?\b|\bmail\b/.test(low)) {
    picks.push({ app: 'outlook', tools: [{ tool: 'outlook.search_mail', args: { q } }] });
  }
  const wantsCalendar = /\bcalendar\b|\bschedule\b|\bagenda\b|\bappointment\b/.test(low)
    || /\bwhat'?s on\b|\bdo i have\b|\bmeetings?\b.*\b(tomorrow|today|week|day)\b/.test(low);
  if (has('gcal') && wantsCalendar) {
    const win = calendarWindow(m);
    picks.push({
      app: 'gcal',
      tools: [q
        ? { tool: 'calendar.search_events', args: { q, from: win.from, to: win.to } }
        : { tool: 'calendar.list_events', args: { from: win.from, to: win.to } }],
    });
  }
  if (has('mscal') && wantsCalendar) {
    const win = calendarWindow(m);
    picks.push({
      app: 'mscal',
      tools: [q
        ? { tool: 'mscalendar.search_events', args: { q, from: win.from, to: win.to } }
        : { tool: 'mscalendar.list_events', args: { from: win.from, to: win.to } }],
    });
  }
  if (has('gdrive') && /\bdrive\b|\bfiles?\b|\bdocuments?\b|\bdoc\b|\bsheets?\b|\bspreadsheets?\b|\bppts?\b|\bpresentation\b/.test(low)) {
    const tools = [{ tool: 'drive.search_files', args: { q } }];
    if (wantsContent && q) tools.push({ tool: 'drive.get_file', args: { q, after: 'drive.search_files' } });
    picks.push({ app: 'gdrive', tools });
  }
  if (has('gdocs') && id && /docs\.google\.com\/document/.test(low)) {
    picks.push({ app: 'gdocs', tools: [{ tool: 'docs.get_document', args: { id } }] });
  } else if (has('gsheets') && id && /docs\.google\.com\/spreadsheets/.test(low)) {
    picks.push({ app: 'gsheets', tools: [{ tool: 'sheets.get_values', args: { id } }] });
  }
  if (has('teams') && /\bteams\b/.test(low)) {
    picks.push({ app: 'teams', tools: [{ tool: 'teams.search_messages', args: { q } }] });
  }
  if (has('onedrive') && /\bonedrive\b|\bone drive\b/.test(low)) {
    picks.push({ app: 'onedrive', tools: [{ tool: 'onedrive.search_files', args: { q } }] });
  }
  if (has('sharepoint') && /\bsharepoint\b/.test(low)) {
    picks.push({ app: 'sharepoint', tools: [{ tool: 'sharepoint.search_files', args: { q } }] });
  }
  if (has('canva') && /\bcanva\b|\bdesigns?\b/.test(low)) {
    picks.push({ app: 'canva', tools: [{ tool: 'canva.search_designs', args: { q } }] });
  }
  // Shared classifier (server.js Sales Agent uses the same one) — D9 fix.
  const lmsIntent = classifyLmsIntent(message);
  const wantsLms = /\blms\b|\baculyze\b/.test(low)
    || (lmsIntent.isEmployee && has('aculyze-lms'))
    || (lmsIntent.isLead && has('aculyze-lms'))
    || (lmsIntent.isCustomer && has('aculyze-lms'))
    || (/\bproposals?\b/.test(low) && has('aculyze-lms'))
    || (lmsIntent.isSale && /\b(report|reports|this month|last month|month|team|figures|pipeline|data|performance|summary|totals?|revenue|how)\b/.test(low) && has('aculyze-lms'));
  if (has('aculyze-lms') && wantsLms) {
    const tools = [];
    // A real search term: the query minus generic nouns ("customers", "leads"…) so
    // e.g. "Find steel customers" → q=steel, while "Show all customers" → q=''.
    // Only pass short, digit-free terms — a sentence fragment as `q` would filter
    // the API to zero results (e.g. "first 5 their industries").
    const cleaned = q
      .replace(/\b(customers?|companies|prospects|leads?|sales|records?|list|all|show|me|find|search|get|fetch|from|the|in|lms|aculyze|please|everything|first|next|top|their|them|with|and|or|number|ones|who|what|which|give|need|want|see|looking|data|details|info|information|industries|industry|dates?|status|statuses)\b/gi, ' ')
      .replace(/\s+/g, ' ').trim().slice(0, 60);
    const cleanedTokens = cleaned ? cleaned.split(' ').filter(Boolean) : [];
    const realQ = (cleaned && cleanedTokens.length <= 3 && !/\d/.test(cleaned)) ? cleaned : '';
    if (/\b(employee|employees|staff|team members?|headcount)\b/.test(low)) tools.push({ tool: 'employees.getEmployees', args: {} });
    if (/\bleads?\b/.test(low)) tools.push({ tool: 'leads.getLeads', args: realQ ? { q: realQ } : {} });
    if (/\b(customers?|companies|prospects)\b/.test(low)) tools.push({ tool: 'customers.search', args: realQ ? { q: realQ } : {} });
    if (/\b(sales?|revenue|orders?|proposals?)\b/.test(low)) {
      const wantsSummary = /\b(summary|totals?|this month|last month|month|performance|figures|how)\b/.test(low);
      tools.push(wantsSummary ? { tool: 'sales.getSummary', args: {} } : { tool: 'sales.getSales', args: {} });
    }
    if (/\b(snapshot|overview|status|health)\b/.test(low) && !tools.length) tools.push({ tool: 'lms.getSummary', args: {} });
    if (!tools.length) tools.push({ tool: 'lms.getSummary', args: {} });
    picks.push({ app: 'aculyze-lms', tools: tools.slice(0, 2) });
  }

  // Capability guard: never plan a tool the catalog doesn't define.
  return picks
    .filter((p) => p.tools.some((t) => TOOLS[t.tool]))
    .slice(0, MAX_APPS)
    .flatMap((p) => p.tools.filter((t) => TOOLS[t.tool]).map((t) => ({ ...t, app: p.app })))
    .slice(0, MAX_READS);
}

/** Friendly nudge when an explicitly named app isn't connected. */
function missingNotice(message, connected) {
  const m = String(message || '').toLowerCase();
  const candidates = [
    ['gmail', ['gmail'], 'Gmail'],
    ['outlook', ['outlook', 'mailbox'], 'Outlook'],
    ['teams', ['teams'], 'Microsoft Teams'],
    ['gdrive', ['google drive', 'drive'], 'Google Drive'],
    ['gcal', ['google calendar'], 'Google Calendar'],
    ['onedrive', ['onedrive'], 'OneDrive'],
    ['sharepoint', ['sharepoint'], 'SharePoint'],
    ['canva', ['canva'], 'Canva'],
    ['aculyze-lms', ['lms', 'aculyze lms'], 'Aculyze LMS'],
  ];
  for (const [id, aliases, name] of candidates) {
    if (connected[id]) continue;
    if (aliases.some((a) => m.includes(a))) {
      return `Connect ${name} in Settings → Apps & Integrations and I can use it here.`;
    }
  }
  return null;
}

// --------------------------- entry ---------------------------

function plan(message, connected) {
  const write = detectWrite(message, connected);
  if (write) return { reads: [], write, notice: write.notice || null };
  const reads = detectReads(message, connected);
  if (reads.length) return { reads, write: null, notice: null };
  return { reads: [], write: null, notice: missingNotice(message, connected) };
}

module.exports = {
  plan,
  extractQuery,
  parseWhen,
  calendarWindow,
  mailArgs,
  teamsArgs,
  eventArgs,
};
