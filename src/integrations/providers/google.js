/**
 * GoogleProvider — OAuth 2.0 (authorization code + PKCE) for Gmail,
 * Google Calendar, Google Drive, Google Docs and Google Sheets.
 *
 * Endpoint overrides (GOOGLE_AUTH_URL / GOOGLE_TOKEN_URL / GOOGLE_API_BASE)
 * exist for automated testing against local fakes — production defaults are
 * Google's official endpoints. Scopes are minimal and per app (§4).
 */
const crypto = require('crypto');
const { http, request, IntegrationError } = require('./base');

const REAL = {
  gmail: 'https://gmail.googleapis.com/gmail/v1',
  calendar: 'https://www.googleapis.com/calendar/v3',
  drive: 'https://www.googleapis.com/drive/v3',
  docs: 'https://docs.googleapis.com/v1',
  sheets: 'https://sheets.googleapis.com/v4',
  oauth: 'https://www.googleapis.com/oauth2/v3',
};
// When GOOGLE_API_BASE is set (tests), every service lives under one root.
const PATH = {
  gmail: '/gmail/v1', calendar: '/calendar/v3', drive: '/drive/v3',
  docs: '/docs/v1', sheets: '/sheets/v4', oauth: '/oauth2/v3',
};

const SCOPES = {
  gmail: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.send', 'email'],
  gcal: ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events', 'email'],
  gdrive: ['https://www.googleapis.com/auth/drive.readonly', 'email'],
  gdocs: ['https://www.googleapis.com/auth/documents.readonly', 'email'],
  gsheets: ['https://www.googleapis.com/auth/spreadsheets.readonly', 'email'],
};

const SCOPE_PERMISSIONS = [
  [/gmail\.readonly$/, 'READ_EMAIL'],
  [/gmail\.metadata$/, 'READ_EMAIL'],
  [/gmail\.compose$/, 'CREATE_DRAFT'],
  [/gmail\.send$/, 'SEND_EMAIL'],
  [/calendar\.readonly$/, 'READ_CALENDAR'],
  [/calendar\.events$/, 'CREATE_EVENT'],
  [/^drive\.readonly$/, 'READ_FILES'],
  [/^documents\.readonly$/, 'READ_DOCS'],
  [/^spreadsheets\.readonly$/, 'READ_SHEETS'],
];

function b64urlDecode(s) {
  return Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

/** Minimal MIME builder for drafts/sends. */
function buildRaw({ to, subject, body }) {
  const mime = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    String(body || ''),
  ].join('\r\n');
  return Buffer.from(mime, 'utf8').toString('base64url');
}

/** Extract text/plain (or first text) part from a Gmail `full` payload. */
function payloadText(payload) {
  if (!payload) return '';
  if (payload.body && payload.body.data) return b64urlDecode(payload.body.data);
  const parts = payload.parts || [];
  const plain = parts.find((p) => p.mimeType === 'text/plain') || parts.find((p) => /^text\//.test(p.mimeType || ''));
  for (const p of parts) {
    const found = payloadText(p);
    if (found) return found;
  }
  if (plain && plain.body && plain.body.data) return b64urlDecode(plain.body.data);
  return '';
}

function headerMap(payload) {
  const out = {};
  for (const h of (payload && payload.headers) || []) out[h.name.toLowerCase()] = h.value;
  return out;
}

function isoDay(d) { return d.toISOString().slice(0, 10); }

class GoogleProvider {
  constructor(env = process.env) {
    this.id = 'google';
    this.clientId = env.GOOGLE_CLIENT_ID || '';
    this.clientSecret = env.GOOGLE_CLIENT_SECRET || '';
    this.authUrl = env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
    this.tokenUrl = env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
    this.apiOverride = env.GOOGLE_API_BASE || '';
  }

  get configured() { return !!(this.clientId && this.clientSecret); }

  scopesFor(appId) { return SCOPES[appId] || []; }

  permissionsFromScopes(scopes) {
    const perms = new Set();
    for (const s of scopes) {
      const str = String(s);
      for (const [rx, perm] of SCOPE_PERMISSIONS) if (rx.test(str)) perms.add(perm);
      // calendar.events scope both creates and updates events
      if (/calendar\.events$/.test(str)) perms.add('UPDATE_EVENT');
    }
    return [...perms];
  }

  base(svc) { return this.apiOverride ? `${this.apiOverride}${PATH[svc]}` : REAL[svc]; }

  buildAuthUrl({ appId, redirectUri, state, codeChallenge }) {
    const u = new URL(this.authUrl);
    u.searchParams.set('client_id', this.clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', this.scopesFor(appId).join(' '));
    u.searchParams.set('state', state);
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('include_granted_scopes', 'true');
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    return u.toString();
  }

  async exchangeCode({ code, redirectUri, codeVerifier }) {
    const form = {
      code, client_id: this.clientId, client_secret: this.clientSecret,
      redirect_uri: redirectUri, grant_type: 'authorization_code',
    };
    if (codeVerifier) form.code_verifier = codeVerifier;
    const r = await request(this.tokenUrl, { method: 'POST', form });
    if (!r.ok) {
      throw new IntegrationError('Google rejected the authorization code — try connecting again.', {
        code: 'exchange_failed', status: r.status,
      });
    }
    return this.readTokens(r.json);
  }

  async refreshToken(refreshToken) {
    const r = await request(this.tokenUrl, {
      method: 'POST',
      form: { refresh_token: refreshToken, client_id: this.clientId, client_secret: this.clientSecret, grant_type: 'refresh_token' },
    });
    if (!r.ok) {
      throw new IntegrationError('session expired', { code: 'reauth', status: r.status });
    }
    return this.readTokens(r.json, refreshToken);
  }

  readTokens(json, prevRefresh = '') {
    const j = json || {};
    return {
      accessToken: j.access_token || '',
      refreshToken: j.refresh_token || prevRefresh,
      expiresIn: Number(j.expires_in) || 3600,
      scope: j.scope || '',
    };
  }

  async fetchAccount(accessToken) {
    try {
      const r = await http('Google', `${this.base('oauth')}/userinfo`, {
        headers: { Authorization: `Bearer ${accessToken}` }, timeoutMs: 8000,
      });
      return (r.json && (r.json.email || r.json.name)) || '';
    } catch { return ''; }
  }

  /** Best-effort token revocation on disconnect (Google OAuth2 revoke). */
  async revoke(token) {
    await request('https://oauth2.googleapis.com/revoke', {
      method: 'POST', form: { token }, timeoutMs: 6000,
    }).catch(() => null);
  }

  /** Lightweight connection test used by "Test connection". */
  async test(conn) {
    const r = await request(`${this.base('gmail')}/users/me/profile`, {
      headers: { Authorization: `Bearer ${conn.__token}` }, timeoutMs: 8000,
    });
    if (r.ok) return { ok: true, detail: (r.json && r.json.emailAddress) || 'profile ok' };
    return { ok: false, detail: `HTTP ${r.status}` };
  }

  // ============================ TOOLS ============================

  async call(toolId, conn, args, token) {
    const fn = this[`tool_${toolId.replace(/\./g, '_')}`];
    if (!fn) throw new IntegrationError(`Tool ${toolId} is not available.`, { code: 'unsupported' });
    return fn.call(this, conn, args || {}, token);
  }

  /** Prepare a write before asking for confirmation (preview only). */
  async prepareWrite(toolId, conn, args) {
    if (toolId === 'gmail.send_message' || toolId === 'gmail.create_draft') {
      if (!args.to || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(args.to)) {
        throw new IntegrationError("I need a full email address to send to (e.g. john@example.com).", { code: 'bad_args' });
      }
      return {
        args,
        preview: [
          { label: 'To', value: args.to },
          { label: 'Subject', value: (args.subject || '(no subject)').slice(0, 120) },
          { label: 'Message', value: String(args.body || '').slice(0, 400) },
        ],
      };
    }
    if (toolId === 'calendar.create_event' || toolId === 'calendar.update_event') {
      if (!args.summary || !args.start) {
        throw new IntegrationError('An event needs a title and a start time (e.g. "tomorrow at 3 PM").', { code: 'bad_args' });
      }
      return {
        args,
        preview: [
          { label: 'Title', value: args.summary },
          { label: 'Start', value: new Date(args.start).toString().slice(0, 40) },
          { label: 'End', value: args.end ? new Date(args.end).toString().slice(0, 40) : '30 minutes later' },
        ],
      };
    }
    return { args, preview: [{ label: 'Details', value: JSON.stringify(args).slice(0, 300) }] };
  }

  // ---- Gmail ----
  async tool_gmail_search(conn, args, token) {
    const q = String(args.q || '').trim();
    const max = Math.min(Number(args.max) || 5, 8);
    const listUrl = `${this.base('gmail')}/users/me/messages?maxResults=${max}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
    const list = await http('Gmail', listUrl, { headers: { Authorization: `Bearer ${token}` } });
    const ids = ((list.json && list.json.messages) || []).map((m) => m.id);
    const msgs = await Promise.all(ids.map((id) =>
      request(`${this.base('gmail')}/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${token}` }, timeoutMs: 10000 })
        .then((r) => (r.ok ? r.json : null))
        .catch(() => null)));
    const items = msgs.filter(Boolean).map((m) => {
      const h = headerMap(m.payload);
      return {
        title: h.subject || '(no subject)',
        meta: `${h.from || ''}${h.date ? ` · ${h.date}` : ''}`.replace(/^ · /, ''),
        body: '', id: m.id,
      };
    });
    return {
      count: items.length,
      items: items.map(({ title, meta }) => ({ title, meta })),
      text: items.map((it, i) => `${i + 1}. ${it.title}${it.meta ? ` — ${it.meta}` : ''}`).join('\n'),
    };
  }

  async tool_gmail_get_message(conn, args, token) {
    const r = await http('Gmail', `${this.base('gmail')}/users/me/messages/${encodeURIComponent(args.id || '')}?format=full`,
      { headers: { Authorization: `Bearer ${token}` } });
    const m = r.json || {};
    const h = headerMap(m.payload);
    const body = payloadText(m.payload).slice(0, 2500);
    return {
      count: 1,
      items: [{ title: h.subject || '(no subject)', meta: h.from || '' }],
      text: `From: ${h.from || '?'}\nDate: ${h.date || ''}\nSubject: ${h.subject || ''}\n\n${body}`,
    };
  }

  async tool_gmail_create_draft(conn, args, token) {
    const r = await http('Gmail', `${this.base('gmail')}/users/me/drafts`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
      json: { message: { raw: buildRaw(args) } },
    });
    return { summary: `Draft created for ${args.to} — "${(args.subject || '').slice(0, 80)}"`, data: r.json };
  }

  async tool_gmail_send_message(conn, args, token) {
    const r = await http('Gmail', `${this.base('gmail')}/users/me/messages/send`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
      json: { raw: buildRaw(args) },
    });
    return { summary: `Email sent to ${args.to} — "${(args.subject || '').slice(0, 80)}"`, data: r.json };
  }

  // ---- Calendar ----
  async fetchEvents(args, token, q = '') {
    const now = new Date();
    const from = args.from || isoDay(now);
    const to = args.to || isoDay(new Date(now.getTime() + 7 * 86400000));
    let url = `${this.base('calendar')}/users/me/calendars/primary/events?`
      + `timeMin=${encodeURIComponent(from.length === 10 ? `${from}T00:00:00Z` : from)}`
      + `&timeMax=${encodeURIComponent(to.length === 10 ? `${to}T23:59:59Z` : to)}`
      + `&maxResults=${Math.min(Number(args.max) || 10, 20)}&singleEvents=true&orderBy=startTime`;
    if (q) url += `&q=${encodeURIComponent(q)}`;
    const r = await http('Google Calendar', url, { headers: { Authorization: `Bearer ${token}` } });
    const events = (r.json && r.json.items) || [];
    const items = events.map((e) => ({
      title: e.summary || '(untitled event)',
      meta: `${(e.start && (e.start.dateTime || e.start.date)) || ''}${e.end ? ` → ${(e.end.dateTime || e.end.date) || ''}` : ''}`,
    }));
    return {
      count: items.length,
      items,
      text: items.map((it, i) => `${i + 1}. ${it.title}${it.meta ? ` — ${it.meta}` : ''}`).join('\n'),
      raw: events,
    };
  }

  async tool_calendar_list_events(conn, args, token) {
    return this.fetchEvents(args, token, '');
  }

  async tool_calendar_search_events(conn, args, token) {
    return this.fetchEvents({ ...args, from: args.from || isoDay(new Date(Date.now() - 30 * 86400000)) }, token, String(args.q || ''));
  }

  async tool_calendar_create_event(conn, args, token) {
    const startIso = new Date(args.start).toISOString();
    const endIso = new Date(args.end || (new Date(args.start).getTime() + 3600000)).toISOString();
    const r = await http('Google Calendar', `${this.base('calendar')}/users/me/calendars/primary/events`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
      json: {
        summary: args.summary,
        description: args.description || 'Created by Zara AI',
        start: { dateTime: startIso },
        end: { dateTime: endIso },
      },
    });
    const ev = r.json || {};
    return { summary: `Event "${args.summary}" created at ${args.start}`, data: { id: ev.id, htmlLink: ev.htmlLink } };
  }

  async tool_calendar_update_event(conn, args, token) {
    const body = {};
    if (args.summary) body.summary = args.summary;
    if (args.start) body.start = { dateTime: new Date(args.start).toISOString() };
    if (args.end) body.end = { dateTime: new Date(args.end).toISOString() };
    const r = await http('Google Calendar',
      `${this.base('calendar')}/users/me/calendars/primary/events/${encodeURIComponent(args.id || '')}`,
      { method: 'PATCH', headers: { Authorization: `Bearer ${token}` }, json: body });
    return { summary: `Event "${args.summary || ''}" updated`, data: r.json };
  }

  // ---- Drive ----
  async tool_drive_search_files(conn, args, token) {
    const q = String(args.q || '').trim();
    const max = Math.min(Number(args.max) || 8, 15);
    const queries = q
      ? [`name contains '${q.replace(/'/g, "\\'")}' and trashed = false`, `fullText contains '${q.replace(/'/g, "\\'")}' and trashed = false`]
      : ['trashed = false'];
    let files = [];
    for (const qq of queries) {
      const r = await http('Google Drive',
        `${this.base('drive')}/files?q=${encodeURIComponent(qq)}&pageSize=${max}&fields=files(id,name,mimeType,modifiedTime,webViewLink)`,
        { headers: { Authorization: `Bearer ${token}` } });
      files = (r.json && r.json.files) || [];
      if (files.length) break;
    }
    const items = files.map((f) => ({
      title: f.name, meta: `${(f.mimeType || '').replace('application/vnd.google-apps.', 'Google ')}`,
      id: f.id, url: f.webViewLink || '', raw: f,
    }));
    return {
      count: items.length,
      items: items.map(({ title, meta }) => ({ title, meta })),
      text: items.map((it, i) => `${i + 1}. ${it.title}${it.meta ? ` — ${it.meta}` : ''}`).join('\n'),
      raw: items,
    };
  }

  async tool_drive_get_file(conn, args, token) {
    const id = encodeURIComponent(args.id || '');
    const metaR = await http('Google Drive', `${this.base('drive')}/files/${id}?fields=id,name,mimeType,modifiedTime,webViewLink,description`,
      { headers: { Authorization: `Bearer ${token}` } });
    const f = metaR.json || {};
    let content = '';
    if (/google-apps\.(document|text)/.test(f.mimeType || '')) {
      const exp = await request(`${this.base('drive')}/files/${id}/export?mimeType=text/plain`,
        { headers: { Authorization: `Bearer ${token}` }, timeoutMs: 12000 })
        .catch(() => null);
      if (exp && exp.ok) content = exp.text.slice(0, 4000);
    } else {
      const dl = await request(`${this.base('drive')}/files/${id}?alt=media`,
        { headers: { Authorization: `Bearer ${token}` }, timeoutMs: 12000 })
        .catch(() => null);
      if (dl && dl.ok) content = dl.text.slice(0, 4000);
    }
    return {
      count: 1,
      items: [{ title: f.name || 'file', meta: f.mimeType || '' }],
      text: `File: ${f.name || id}\nType: ${f.mimeType || '?'}\nModified: ${f.modifiedTime || '?'}\n${f.description ? `\n${f.description}\n` : ''}\n${content}`.slice(0, 5000),
    };
  }

  // ---- Docs / Sheets ----
  async tool_docs_get_document(conn, args, token) {
    const r = await http('Google Docs', `${this.base('docs')}/documents/${encodeURIComponent(args.id || '')}`,
      { headers: { Authorization: `Bearer ${token}` } });
    const doc = r.json || {};
    const parts = [];
    for (const c of doc.content || []) {
      for (const el of c.paragraph ? c.paragraph.elements || [] : []) {
        if (el.textRun && el.textRun.content) parts.push(el.textRun.content);
      }
    }
    const text = parts.join('').replace(/\n{3,}/g, '\n\n').slice(0, 5000);
    return {
      count: 1,
      items: [{ title: doc.title || 'Google Doc', meta: 'document' }],
      text: `Document: ${doc.title || args.id}\n\n${text}`,
    };
  }

  async tool_sheets_get_values(conn, args, token) {
    const id = encodeURIComponent(args.id || '');
    const range = encodeURIComponent(String(args.range || 'A1:Z60'));
    const r = await http('Google Sheets', `${this.base('sheets')}/spreadsheets/${id}/values/${range}?valueRenderOption=FORMATTED_VALUE`,
      { headers: { Authorization: `Bearer ${token}` } });
    const values = (r.json && r.json.values) || [];
    const text = values.slice(0, 40).map((row) => row.join(' | ')).join('\n').slice(0, 5000);
    return {
      count: values.length,
      items: [{ title: `Spreadsheet ${args.id}`, meta: `${values.length} rows` }],
      text,
    };
  }
}

module.exports = { GoogleProvider, makeCodeVerifier: () => crypto.randomBytes(48).toString('base64url'),
  makeChallenge: (v) => crypto.createHash('sha256').update(v).digest('base64url') };
