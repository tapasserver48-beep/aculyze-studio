/**
 * MicrosoftProvider — Microsoft identity OAuth 2.0 + Microsoft Graph (v1.0).
 *
 * Graph is the primary integration layer for Microsoft 365 (§5). Only stable
 * v1.0 endpoints are used. Endpoint overrides (MS_AUTH_URL / MS_TOKEN_URL /
 * MS_GRAPH_BASE) exist for automated testing against local fakes.
 */
const { http, request, IntegrationError, stripHtml } = require('./base');

const SCOPES = {
  outlook: ['Mail.Read', 'Mail.ReadWrite', 'Mail.Send', 'offline_access', 'User.Read'],
  mscal: ['Calendars.Read', 'Calendars.ReadWrite', 'offline_access', 'User.Read'],
  teams: ['Team.ReadBasic.All', 'Channel.ReadBasic.All', 'Chat.Read', 'Chat.ReadWrite', 'offline_access', 'User.Read'],
  onedrive: ['Files.Read', 'offline_access', 'User.Read'],
  sharepoint: ['Sites.Read.All', 'offline_access', 'User.Read'],
};

const SCOPE_PERMISSIONS = [
  [/^Mail\.Read$/, 'READ_EMAIL'], [/^Mail\.ReadWrite$/, 'CREATE_DRAFT'], [/^Mail\.Send$/, 'SEND_EMAIL'],
  [/^Calendars\.Read$/, 'READ_CALENDAR'], [/^Calendars\.ReadWrite$/, 'CREATE_EVENT'],
  [/^Chat\.Read$/, 'READ_MESSAGES'], [/^ChannelMessage\.Read\.All$/, 'READ_MESSAGES'],
  [/^Chat\.ReadWrite$/, 'SEND_MESSAGES'], [/^ChannelMessage\.ReadWrite$/, 'SEND_MESSAGES'],
  [/^Files\.Read/, 'READ_FILES'], [/^Sites\.Read/, 'READ_SITES'],
];

class MicrosoftProvider {
  constructor(env = process.env) {
    this.id = 'microsoft';
    this.clientId = env.MICROSOFT_CLIENT_ID || '';
    this.clientSecret = env.MICROSOFT_CLIENT_SECRET || '';
    const tenant = env.MICROSOFT_TENANT || 'common';
    this.authUrl = env.MS_AUTH_URL || `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;
    this.tokenUrl = env.MS_TOKEN_URL || `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
    this.graph = (env.MS_GRAPH_BASE || 'https://graph.microsoft.com/v1.0').replace(/\/$/, '');
  }

  get configured() { return !!(this.clientId && this.clientSecret); }

  scopesFor(appId) { return SCOPES[appId] || []; }

  permissionsFromScopes(scopes) {
    const perms = new Set();
    for (const s of scopes) {
      for (const [rx, perm] of SCOPE_PERMISSIONS) if (rx.test(String(s))) perms.add(perm);
    }
    if (perms.has('CREATE_EVENT')) perms.add('UPDATE_EVENT');
    return [...perms];
  }

  buildAuthUrl({ appId, redirectUri, state, codeChallenge }) {
    const u = new URL(this.authUrl);
    u.searchParams.set('client_id', this.clientId);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('scope', this.scopesFor(appId).join(' '));
    u.searchParams.set('state', state);
    u.searchParams.set('response_mode', 'query');
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    return u.toString();
  }

  async exchangeCode({ code, redirectUri, codeVerifier }) {
    const form = {
      client_id: this.clientId, client_secret: this.clientSecret, code,
      redirect_uri: redirectUri, grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    };
    const r = await request(this.tokenUrl, { method: 'POST', form });
    if (!r.ok) {
      throw new IntegrationError('Microsoft rejected the authorization code — try connecting again.', {
        code: 'exchange_failed', status: r.status,
      });
    }
    return this.readTokens(r.json);
  }

  async refreshToken(refreshToken) {
    const r = await request(this.tokenUrl, {
      method: 'POST',
      form: {
        client_id: this.clientId, client_secret: this.clientSecret,
        refresh_token: refreshToken, grant_type: 'refresh_token',
        scope: SCOPES.outlook.concat(SCOPES.mscal, SCOPES.teams, SCOPES.onedrive, SCOPES.sharepoint)
          .filter((s, i, a) => a.indexOf(s) === i).join(' '),
      },
    });
    if (!r.ok) throw new IntegrationError('session expired', { code: 'reauth', status: r.status });
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
      const r = await http('Microsoft', `${this.graph}/me?$select=displayName,userPrincipalName,mail`, {
        headers: { Authorization: `Bearer ${accessToken}` }, timeoutMs: 8000,
      });
      return (r.json && (r.json.mail || r.json.userPrincipalName)) || '';
    } catch { return ''; }
  }

  async test(conn) {
    const r = await request(`${this.graph}/me?$select=displayName`, {
      headers: { Authorization: `Bearer ${conn.__token}` }, timeoutMs: 8000,
    });
    if (r.ok) return { ok: true, detail: (r.json && r.json.displayName) || 'signed in' };
    return { ok: false, detail: `HTTP ${r.status}` };
  }

  get(path, token, opts = {}) {
    return http('Microsoft', `${this.graph}${path}`, {
      headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
      timeoutMs: opts.timeoutMs || 15000,
      ...(opts.method ? { method: opts.method } : {}),
      ...(opts.json !== undefined ? { json: opts.json } : {}),
    });
  }

  async call(toolId, conn, args, token) {
    const fn = this[`tool_${toolId.replace(/\./g, '_')}`];
    if (!fn) throw new IntegrationError(`Tool ${toolId} is not available.`, { code: 'unsupported' });
    return fn.call(this, conn, args || {}, token);
  }

  async prepareWrite(toolId, conn, args) {
    if (toolId === 'outlook.send_mail' || toolId === 'outlook.create_draft') {
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
    if (toolId === 'teams.send_message') {
      // Resolve which chat this will land in *before* asking for confirmation.
      const resolved = await this.resolveChat(args.chatQuery, conn.__token);
      if (!resolved) {
        throw new IntegrationError(
          args.chatQuery
            ? `Couldn't find a Teams chat matching "${args.chatQuery}".`
            : 'No Teams chats are available to send to.',
          { code: 'not_found' },
        );
      }
      return {
        args: { ...args, chatId: resolved.id },
        preview: [
          { label: 'Chat', value: resolved.label },
          { label: 'Message', value: String(args.text || '').slice(0, 400) },
        ],
      };
    }
    if (toolId.includes('create_event') || toolId.includes('update_event')) {
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

  // ---------------- Outlook ----------------

  async searchMail(q, token, max = 6) {
    const top = Math.min(Number(max) || 6, 10);
    let path = `/me/messages?$top=${top}&$select=id,subject,from,receivedDateTime,bodyPreview`;
    if (q) path += `&$search="${encodeURIComponent(q).replace(/%22/g, '')}"`;
    let r;
    try {
      r = await this.get(path, token, { headers: { ConsistencyLevel: 'eventual' } });
    } catch (err) {
      // $search needs advanced querying on some tenants — fall back to subject filter.
      if (q && err.status === 400) {
        r = await this.get(
          `/me/messages?$top=${top}&$select=id,subject,from,receivedDateTime,bodyPreview&$filter=${encodeURIComponent(`contains(subject,'${q.replace(/'/g, "''")}')`)}`,
          token, { headers: { ConsistencyLevel: 'eventual' } },
        );
      } else throw err;
    }
    const msgs = (r.json && r.json.value) || [];
    return msgs.map((m) => ({
      id: m.id,
      title: m.subject || '(no subject)',
      meta: `${(m.from && m.from.emailAddress && m.from.emailAddress.address) || ''}${m.receivedDateTime ? ` · ${m.receivedDateTime.slice(0, 10)}` : ''}`,
      body: stripHtml(m.bodyPreview || '').slice(0, 400),
    }));
  }

  async tool_outlook_search_mail(conn, args, token) {
    const items = await this.searchMail(String(args.q || '').trim(), token, args.max);
    return {
      count: items.length,
      items: items.map(({ title, meta }) => ({ title, meta })),
      text: items.map((it, i) => `${i + 1}. ${it.title}${it.meta ? ` — ${it.meta}` : ''}${it.body ? `\n   ${it.body}` : ''}`).join('\n'),
      raw: items,
    };
  }

  async tool_outlook_get_mail(conn, args, token) {
    const r = await this.get(`/me/messages/${encodeURIComponent(args.id || '')}?$select=subject,from,to,receivedDateTime,body,bodyPreview`, token);
    const m = r.json || {};
    const body = stripHtml(m.body && m.body.content ? m.body.content : m.bodyPreview).slice(0, 2500);
    return {
      count: 1,
      items: [{ title: m.subject || '(no subject)', meta: (m.from && m.from.emailAddress && m.from.emailAddress.address) || '' }],
      text: `From: ${(m.from && m.from.emailAddress && m.from.emailAddress.address) || '?'}\nDate: ${m.receivedDateTime || ''}\nSubject: ${m.subject || ''}\n\n${body}`,
    };
  }

  mailBody(args) {
    return {
      subject: args.subject || '(no subject)',
      body: { contentType: 'Text', content: String(args.body || '') },
      toRecipients: [{ emailAddress: { address: args.to } }],
    };
  }

  async tool_outlook_create_draft(conn, args, token) {
    const r = await this.get('/me/messages', token, { method: 'POST', json: this.mailBody(args) });
    return { summary: `Draft created for ${args.to} — "${(args.subject || '').slice(0, 80)}"`, data: { id: r.json && r.json.id } };
  }

  async tool_outlook_send_mail(conn, args, token) {
    await this.get('/me/send', token, { method: 'POST', json: { message: this.mailBody(args) } });
    return { summary: `Email sent to ${args.to} — "${(args.subject || '').slice(0, 80)}"` };
  }

  // ---------------- Calendar ----------------

  async fetchEvents(args, token, q = '') {
    const now = new Date();
    const start = args.from || now.toISOString();
    const end = args.to || new Date(now.getTime() + 7 * 86400000).toISOString();
    let r = await this.get(
      `/me/calendarView?startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}`
      + `&$top=${Math.min(Number(args.max) || 10, 20)}&$select=id,subject,start,end,location,organizer`,
      token, { headers: { Prefer: 'outlook.timezone="UTC"' } },
    );
    let events = (r.json && r.json.value) || [];
    if (q) {
      const needle = q.toLowerCase();
      events = events.filter((e) => `${e.subject || ''} ${((e.location || {}).displayName) || ''}`.toLowerCase().includes(needle));
    }
    const items = events.map((e) => ({
      id: e.id, title: e.subject || '(untitled event)',
      meta: `${(e.start && e.start.dateTime) || ''}${e.end ? ` → ${e.end.dateTime || ''}` : ''}`,
    }));
    return {
      count: items.length, items,
      text: items.map((it, i) => `${i + 1}. ${it.title}${it.meta ? ` — ${it.meta}` : ''}`).join('\n'),
      raw: events,
    };
  }

  async tool_mcalendar_list_events(conn, args, token) { return this.fetchEvents(args, token, ''); }
  async tool_mcalendar_search_events(conn, args, token) {
    return this.fetchEvents({ ...args, from: args.from || new Date(Date.now() - 30 * 86400000).toISOString() }, token, String(args.q || ''));
  }

  async tool_mcalendar_create_event(conn, args, token) {
    const start = new Date(args.start);
    const end = new Date(args.end || (start.getTime() + 30 * 60000));
    const r = await this.get('/me/events', token, {
      method: 'POST',
      json: {
        subject: args.summary,
        body: { contentType: 'Text', content: args.description || 'Created by Zara AI' },
        start: { dateTime: start.toISOString(), timeZone: 'UTC' },
        end: { dateTime: end.toISOString(), timeZone: 'UTC' },
        ...(args.location ? { location: { displayName: args.location } } : {}),
      },
    });
    return { summary: `Event "${args.summary}" created at ${args.start}`, data: { id: r.json && r.json.id } };
  }

  async tool_mcalendar_update_event(conn, args, token) {
    const body = {};
    if (args.summary) body.subject = args.summary;
    if (args.start) body.start = { dateTime: new Date(args.start).toISOString(), timeZone: 'UTC' };
    if (args.end) body.end = { dateTime: new Date(args.end).toISOString(), timeZone: 'UTC' };
    const r = await this.get(`/me/events/${encodeURIComponent(args.id || '')}`, token, { method: 'PATCH', json: body });
    return { summary: `Event "${args.summary || ''}" updated`, data: r.json };
  }

  // ---------------- Teams ----------------

  async listChats(token, top = 10) {
    const r = await this.get(`/me/chats?$top=${top}&$select=id,topic,chatType`, token);
    return (r.json && r.json.value) || [];
  }

  async resolveChat(query, token) {
    const chats = await this.listChats(token);
    const q = String(query || '').trim().toLowerCase();
    if (q) {
      const hit = chats.find((c) => String(c.topic || '').toLowerCase().includes(q));
      if (hit) return { id: hit.id, label: hit.topic || 'Direct message' };
    }
    const first = chats[0];
    return first ? { id: first.id, label: first.topic || 'Most recent chat' } : null;
  }

  async chatMessages(chatId, token, top = 25) {
    const r = await this.get(`/me/chats/${encodeURIComponent(chatId)}/messages?$top=${top}&$select=id,body,createdDateTime,from`, token)
      .catch((err) => {
        // Some tenants disallow history reads — surface a clear, friendly error.
        if (err.status === 403) throw new IntegrationError("Microsoft Teams doesn't allow Zara to read this chat's history.", { code: 'forbidden', status: 403 });
        throw err;
      });
    return (r.json && r.json.value) || [];
  }

  async tool_teams_search_messages(conn, args, token) {
    const q = String(args.q || '').trim().toLowerCase();
    const chats = await this.listChats(token, 8);
    const items = [];
    for (const c of chats.slice(0, 6)) {
      if (q && String(c.topic || '').toLowerCase().includes(q)) {
        items.push({ title: c.topic || 'Direct message', meta: 'chat matches your search', body: '' });
        continue;
      }
      let msgs = [];
      try { msgs = await this.chatMessages(c.id, token, 25); } catch { continue; }
      for (const m of msgs) {
        const text = stripHtml((m.body && m.body.content) || '');
        if (q && !text.toLowerCase().includes(q)) continue;
        items.push({
          title: c.topic || 'Direct message',
          meta: `${(m.createdDateTime || '').slice(0, 16).replace('T', ' ')} UTC`,
          body: text.slice(0, 300),
        });
        if (items.length >= 8) break;
      }
      if (items.length >= 8) break;
    }
    return {
      count: items.length,
      items: items.map(({ title, meta }) => ({ title, meta })),
      text: items.map((it, i) => `${i + 1}. [${it.title}] ${it.meta}${it.body ? `\n   ${it.body}` : ''}`).join('\n'),
    };
  }

  async tool_teams_get_messages(conn, args, token) {
    const chatId = args.chatId || (await this.resolveChat(args.chatQuery, token)).id;
    const msgs = await this.chatMessages(chatId, token, Math.min(Number(args.max) || 15, 30));
    const items = msgs.map((m) => ({
      title: stripHtml((m.body && m.body.content) || '').slice(0, 200) || '(empty)',
      meta: (m.createdDateTime || '').slice(0, 16).replace('T', ' '),
      body: stripHtml((m.body && m.body.content) || '').slice(0, 300),
    }));
    return {
      count: items.length,
      items: items.map(({ title, meta }) => ({ title, meta })),
      text: items.map((it, i) => `${i + 1}. ${it.title} — ${it.meta}`).join('\n'),
    };
  }

  async tool_teams_send_message(conn, args, token) {
    const chatId = args.chatId || (await this.resolveChat(args.chatQuery, token)).id;
    if (!chatId) throw new IntegrationError('No Teams chat available to send to.', { code: 'not_found' });
    const r = await this.get(`/me/chats/${encodeURIComponent(chatId)}/messages`, token, {
      method: 'POST', json: { body: { contentType: 'text', content: String(args.text || '') } },
    });
    return { summary: `Message sent to ${args.chatQuery || 'your most recent chat'}`, data: r.json };
  }

  // ---------------- OneDrive / SharePoint ----------------

  async tool_onedrive_search_files(conn, args, token) {
    const q = String(args.q || '').trim().replace(/'/g, "''");
    const r = await this.get(`/me/drive/root/search(q='${q}')?$top=10&$select=id,name,webUrl,lastModifiedDateTime,size`, token);
    const files = (r.json && r.json.value) || [];
    const items = files.map((f) => ({ title: f.name, meta: (f.lastModifiedDateTime || '').slice(0, 10), url: f.webUrl || '' }));
    return {
      count: items.length,
      items: items.map(({ title, meta }) => ({ title, meta })),
      text: items.map((it, i) => `${i + 1}. ${it.title}${it.meta ? ` — ${it.meta}` : ''}`).join('\n'),
    };
  }

  async tool_sharepoint_search_files(conn, args, token) {
    const q = String(args.q || '').trim();
    const r = await this.get('/search/query', token, {
      method: 'POST',
      json: {
        requests: [{
          entityTypes: ['driveItem', 'site'],
          query: { queryString: q },
          from: 0, size: 12,
        }],
      },
    });
    const hits = [];
    for (const container of (r.json && r.json.value) || []) {
      for (const hit of (container.hitsContainers || []) || []) {
        for (const h of hit.hits || []) {
          const res = h.resource || {};
          hits.push({ title: res.name || res.webUrl || 'result', meta: res.siteUrl || res.webUrl || '', url: res.webUrl || '' });
        }
      }
    }
    const items = hits.slice(0, 12);
    return {
      count: items.length,
      items: items.map(({ title, meta }) => ({ title, meta })),
      text: items.map((it, i) => `${i + 1}. ${it.title}${it.meta ? ` — ${it.meta}` : ''}`).join('\n'),
    };
  }
}

module.exports = { MicrosoftProvider };
