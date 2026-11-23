/**
 * Chat API Layer — the ONLY way the UI talks to models.
 * Never calls LM Studio directly; all requests go through our /api/* backend,
 * which routes to the configured Model Provider (LM Studio today, Zara later).
 */

export async function fetchConfig() {
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error('config failed');
  return res.json();
}

export async function fetchStatus() {
  const res = await fetch('/api/status');
  if (!res.ok) throw new Error('status failed');
  return res.json();
}

export async function fetchModels() {
  const res = await fetch('/api/models');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Unable to reach the model server.');
    err.hint = data.hint;
    err.detail = data.detail;
    throw err;
  }
  return data; // { provider, models: [{id,name}] }
}

/**
 * Streams a chat completion. Calls onToken for each chunk.
 * Returns { content, model, stopped }.
 * Throws { friendly, hint } shaped errors for UI display.
 */export async function streamChat({ messages, model, temperature, max_tokens, signal, onToken, onReasoning, onModel, agent }) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ messages, model, temperature, max_tokens, stream: true, agent }),
    signal,
  });

  if (!res.ok || !res.body) {
    let hint = '';
    try {
      const data = await res.json();
      hint = data.hint || '';
    } catch { /* ignore */ }
    const err = new Error('Something went wrong.');
    err.hint = hint || "LM Studio isn't connected. Start the local model server and try again.";
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let lastModel = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      const lines = part.split('\n');
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return { content: full, model: lastModel, stopped: signal?.aborted };
        if (!data || data.startsWith(':')) continue;
        try {
          const json = JSON.parse(data);
          if (json.error) {
            const err = new Error(json.error);
            err.hint = json.hint || '';
            throw err;
          }
          const token = json?.choices?.[0]?.delta?.content ?? '';
          if (token) {
            full += token;
            if (onToken) onToken(token, full);
          }
          if (onReasoning) {
            const reasoning = json?.choices?.[0]?.delta?.reasoning_content ?? '';
            if (reasoning) onReasoning(reasoning);
          }
          if (json.model) {
            lastModel = json.model;
            if (onModel) onModel(json.model);
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          try { await reader.cancel(); } catch { /* noop */ }
          throw e;
        }
      }
    }
    if (signal?.aborted) {
      try { await reader.cancel(); } catch { /* noop */ }
      break;
    }
  }
  return { content: full, model: lastModel, stopped: signal?.aborted };
}

/** Keyless web search. Returns { provider, query, results: [{title,url,snippet}] }. */
export async function searchWeb(query, count = 5) {
  const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&n=${count}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Web search failed.');
    err.hint = data.hint;
    throw err;
  }
  return data;
}

/** Fetch a page's readable text. Returns { title, url, text }. */
export async function fetchPageText(url) {
  const res = await fetch(`/api/page?url=${encodeURIComponent(url)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Could not read that page.');
    err.hint = data.hint;
    throw err;
  }
  return data;
}

/** Gmail MCP bridge status. Returns { enabled, configured, tools }. */
export async function emailStatus() {
  const res = await fetch('/api/email/status');
  return res.json().catch(() => ({ enabled: false, configured: false, tools: [] }));
}

/** Send an email through the Gmail MCP bridge. */
export async function sendEmail({ to, subject, body }) {
  const res = await fetch('/api/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, subject, body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Sending failed.');
    err.hint = data.hint;
    err.detail = data.detail;
    throw err;
  }
  return data;
}

/** Sales AI agent — SAP / ERP plugin connection (key lives server-side). */
export async function salesStatus() {
  const res = await fetch('/api/sales/status');
  return res.json().catch(() => ({ connected: false, inUse: false, providerName: '', baseUrl: '', hasKey: false }));
}

/** Save the plugin connection { providerName, baseUrl, apiKey?, inUse } and test it. */
export async function salesConnect(payload) {
  const res = await fetch('/api/sales/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Could not save the plugin connection.');
    err.hint = data.hint;
    throw err;
  }
  return data;
}

/** Ask the Sales agent's server for live ERP data. Returns { provider, data }. */
export async function salesQuery(question) {
  const res = await fetch('/api/sales/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ question: String(question || '').slice(0, 500) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Sales plugin request failed.');
    err.hint = data.hint;
    throw err;
  }
  return data;
}

/** Sales Agent dedicated chat — streams SSE from /api/sales/chat.
 *  Returns { content, model, stopped } like streamChat. */
export async function salesChat({ messages, model, temperature, max_tokens, signal, onToken, onReasoning, onModel }) {
  const res = await fetch('/api/sales/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ messages, model, temperature, max_tokens, stream: true, agent: 'sales' }),
    signal,
  });

  if (!res.ok || !res.body) {
    let hint = '';
    try {
      const data = await res.json();
      hint = data.hint || '';
    } catch { /* ignore */ }
    const err = new Error('Something went wrong.');
    err.hint = hint || 'Sales Agent chat is unavailable.';
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let lastModel = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      const lines = part.split('\n');
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return { content: full, model: lastModel, stopped: signal?.aborted };
        if (!data || data.startsWith(':')) continue;
        try {
          const json = JSON.parse(data);
          if (json.error) {
            const err = new Error(json.error);
            err.hint = json.hint || '';
            throw err;
          }
          const token = json?.choices?.[0]?.delta?.content ?? '';
          if (token) {
            full += token;
            if (onToken) onToken(token, full);
          }
          if (onReasoning) {
            const reasoning = json?.choices?.[0]?.delta?.reasoning_content ?? '';
            if (reasoning) onReasoning(reasoning);
          }
          if (json.model) {
            lastModel = json.model;
            if (onModel) onModel(json.model);
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          try { await reader.cancel(); } catch { /* noop */ }
          throw e;
        }
      }
    }
  }
  return { content: full, model: lastModel, stopped: signal?.aborted };
}

/** Aculyze LMS integration status — never exposes the API key. */
export async function lmsStatus() {
  const res = await fetch('/api/lms/status');
  return res.json().catch(() => ({ configured: false, provider: 'Aculyze LMS', baseUrl: '', status: 'Server unreachable' }));
}

/** Fetch employees from Aculyze LMS for the inbox. Returns { employees, provider, count }. */
export async function loadEmployees() {
  const res = await fetch('/api/employees');
  const data = await res.json().catch(() => ({ employees: [], provider: 'Aculyze LMS', count: 0 }));
  if (!res.ok) {
    const err = new Error(data.error || 'Could not load employees.');
    throw err;
  }
  return data;
}

/** Today's AI token usage — Command Centre. Returns { day, zara:{…}, sales:{…}, total:{…} }. */
export async function loadTokenUsage() {
  const res = await fetch('/api/usage/today');
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new Error('Could not load token usage.');
  return data;
}

/** AI voice status. Returns { provider, enabled, online, model }. */
export async function voiceStatus() {
  const res = await fetch('/api/voice/status');
  return res.json().catch(() => ({ provider: 'browser', enabled: false, online: false }));
}

// ============ APPS & INTEGRATIONS ============
// The UI stays provider-agnostic: every call goes to our own backend, which
// routes through the IntegrationManager → provider adapter → external API.
// Tokens/keys are server-side only and never appear in these payloads.

/** Catalog + this user's connection status. Returns { categories, featured, apps }. */
export async function listIntegrations() {
  const res = await fetch('/api/integrations');
  const data = await res.json().catch(() => ({ categories: [], featured: [], apps: [] }));
  if (!res.ok) {
    const err = new Error(data.error || 'Could not load apps.');
    err.code = data.code;
    throw err;
  }
  return data;
}

/** One app's connection detail (status, account, permissions, masked key). */
export async function integrationDetail(appId) {
  const res = await fetch(`/api/integrations/${encodeURIComponent(appId)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Could not load that app.');
    err.code = data.code;
    throw err;
  }
  return data;
}

/**
 * Start connecting. OAuth apps → { authorizationUrl } (redirect the browser);
 * API-key apps → { view, test } after saving the credentials you passed in.
 */
export async function integrationConnect(appId, payload = {}) {
  const res = await fetch(`/api/integrations/${encodeURIComponent(appId)}/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Could not start connecting.');
    err.code = data.code;
    throw err;
  }
  return data;
}

/** Live connection test. Returns { test: { ok, ms, detail }, app }. */
export async function integrationTest(appId) {
  const res = await fetch(`/api/integrations/${encodeURIComponent(appId)}/test`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Connection test failed.');
    err.code = data.code;
    throw err;
  }
  return data;
}

/** Disconnect + (best-effort) revoke. Returns { status: 'not_connected' }. */
export async function integrationDisconnect(appId) {
  const res = await fetch(`/api/integrations/${encodeURIComponent(appId)}/disconnect`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Could not disconnect.');
    err.code = data.code;
    throw err;
  }
  return data;
}

/** Declared + granted permissions for an app. */
export async function integrationPermissions(appId) {
  const res = await fetch(`/api/integrations/${encodeURIComponent(appId)}/permissions`);
  return res.json().catch(() => ({ permissions: [] }));
}

/**
 * Chat bridge: message → tool plan → { steps, context, sources, notice?, confirm? }.
 * Reads run server-side; writes come back as a confirmation request.
 */
export async function resolveIntegrations(message) {
  const res = await fetch('/api/integrations/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: String(message || '').slice(0, 4000) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Could not check your connected apps.');
    err.code = data.code;
    throw err;
  }
  return data;
}

/** Execute one tool. Writes require { confirm: true } after the user approves. */
export async function executeIntegration({ tool, args = {}, confirm = false }) {
  const res = await fetch('/api/integrations/tools/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, args, confirm }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'That action could not be completed.');
    err.code = data.code;
    throw err;
  }
  return data;
}

/** Gmail convenience functions (alias for executeIntegration with tool paths). */
export async function gmailSearch({ q, max = 10 }) {
  return executeIntegration({ tool: 'gmail.search', args: { q: String(q || '').trim(), max } });
}

export async function gmailGetMessage(id) {
  return executeIntegration({ tool: 'gmail.get_message', args: { id } });
}

export async function gmailCreateDraft({ to, subject, body }) {
  return executeIntegration({ tool: 'gmail.create_draft', args: { to, subject, body } }, true);
}

export async function gmailSendMessage({ to, subject, body }) {
  return executeIntegration({ tool: 'gmail.send_message', args: { to, subject, body } }, true);
}

/** Plan-only browser check for a chat message (never executes anything). */
export async function resolveBrowser(message) {
  const res = await fetch('/api/browser/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: String(message || '').slice(0, 400) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Could not check your browser request.');
    err.code = data.code;
    throw err;
  }
  return data;
}

/**
 * Execute the browser plan derived from the message (server-side, whitelisted
 * actions only). Sensitive plans return { confirm } — re-call with confirm:true
 * after the user approves in the modal.
 */
export async function executeBrowser({ message, confirm = false }) {
  const res = await fetch('/api/browser/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: String(message || '').slice(0, 400), confirm }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'The browser action could not be completed.');
    err.code = data.code;
    throw err;
  }
  return data;
}

/** Local browser automation status (service up? browser open?). */
export async function browserToolStatus() {
  const res = await fetch('/api/browser/status');
  const data = await res.json().catch(() => ({}));
  return res.ok ? data : { service: false, browser: 'unknown' };
}

// ---------------------------------------------------------------------------
// Zara Orchestrator — central intent routing + the YouTube/visual workflow.
// ---------------------------------------------------------------------------

/** Classify a chat message (plan only, never executes). Returns { intent, ... }. */
export async function classifyOrchestrator(message) {
  const res = await fetch('/api/orchestrator/classify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: String(message || '').slice(0, 400) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Could not classify that request.');
    err.code = data.code;
    throw err;
  }
  return data;
}

/**
 * Run the capability that owns a message. YouTube/visual workflows execute
 * here; browser intents return steps to render. Returns
 * { intent, steps?, context?, confirm?, workflow?, query?, ok }.
 */
export async function runOrchestrator(message, { signal } = {}) {
  const res = await fetch('/api/orchestrator/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: String(message || '').slice(0, 400) }),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'That request could not be completed.');
    err.code = data.code;
    throw err;
  }
  return data;
}

/** Classify whether Zara needs fresh external evidence for a request. */
export async function classifyResearch(message, { signal } = {}) {
  const res = await fetch('/api/orchestrator/research/classify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: String(message || '').slice(0, 400) }),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not classify the research request.');
  return data;
}

/** Run verified web research and stream actual pipeline events as they happen. */
export async function researchQuestion(message, { signal, onProgress } = {}) {
  const res = await fetch('/api/orchestrator/research', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ question: String(message || '').slice(0, 400), stream: true }), signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || data.hint || 'Web research could not start.');
  }
  const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let result = null;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n'); buffer = events.pop() || '';
    for (const raw of events) {
      const lines = raw.split('\n'); const type = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
      const payload = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
      if (!payload || payload === '[DONE]') continue;
      let data; try { data = JSON.parse(payload); } catch { continue; }
      if (type === 'progress' && onProgress) onProgress(data);
      else if (type === 'result') result = data;
      else if (type === 'error') throw new Error(data.error || 'Web research failed.');
    }
    if (signal?.aborted) { try { await reader.cancel(); } catch { /* noop */ } break; }
  }
  if (signal?.aborted) return { stopped: true };
  if (!result) throw new Error('Research ended before an answer was returned.');
  return result;
}

// ---------------------------------------------------------------------------
// Computer control (Zara Desktop Agent) — token-authenticated local agent.
// ---------------------------------------------------------------------------

let computerToken = null;

async function computerHeaders() {
  if (!computerToken) {
    const res = await fetch('/api/computer/session');
    const data = await res.json().catch(() => ({}));
    computerToken = data.token || '';
  }
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${computerToken}` };
}

/** Plan-only computer check for a chat message (never executes anything). */
export async function resolveComputer(message) {
  const res = await fetch('/api/computer/resolve', {
    method: 'POST',
    headers: await computerHeaders(),
    body: JSON.stringify({ message: String(message || '').slice(0, 400) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Could not check your computer request.');
    err.code = data.code;
    throw err;
  }
  return data;
}

/**
 * Execute the computer plan derived from the message (server-side, whitelisted
 * Level-1 operations only). Deterministic app questions come back as
 * { direct: { text } } — rendered verbatim, no model involved.
 */
export async function executeComputer({ message }) {
  const res = await fetch('/api/computer/execute', {
    method: 'POST',
    headers: await computerHeaders(),
    body: JSON.stringify({ message: String(message || '').slice(0, 400) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'The computer action could not be completed.');
    err.code = data.code;
    throw err;
  }
  return data;
}

/** Desktop-agent status (service up? platform?). */
export async function computerToolStatus() {
  const res = await fetch('/api/computer/status', { headers: await computerHeaders() });
  const data = await res.json().catch(() => ({}));
  return res.ok ? data : { service: false, platform: 'unknown' };
}

/**
 * Synthesize speech with Zara's AI voice (OmniVoice).
 * Returns an object URL for an <audio> element; throws {message,hint} on failure.
 */
export async function synthesizeVoice(text, { instruct, speed, signal } = {}) {
  const res = await fetch('/api/voice/synthesize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, instruct, speed }),
    signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || 'Voice synthesis failed.');
    err.hint = data.hint;
    err.detail = data.detail;
    throw err;
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

// ============ AUTH (local login � signed httpOnly session cookie) ============
// Every call carries credentials: 'include' so the session cookie rides along;
// the cookie itself is httpOnly, so JS never sees the token.

async function authRequest(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Request failed.');
    err.code = data.code || '';
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Current session. Always succeeds ? { user: {id,name,email} | null }. */
export async function authMe() {
  return authRequest('/api/auth/me');
}

/** POST /api/auth/login ? { user }. Throws { message, code }. */
export async function authLogin({ email, password }) {
  return authRequest('/api/auth/login', { method: 'POST', body: { email, password } });
}

/** POST /api/auth/register ? { user } (201). */
export async function authRegister({ name, email, password }) {
  return authRequest('/api/auth/register', { method: 'POST', body: { name, email, password } });
}

/** POST /api/auth/logout ? { ok: true }. */
export async function authLogout() {
  return authRequest('/api/auth/logout', { method: 'POST', body: {} });
}

/** GET /api/auth/setup ? { needed, codeSource } — first-admin window open? */
export async function authSetupStatus() {
  return authRequest('/api/auth/setup');
}

/** POST /api/auth/setup ? { user } (201) — only while zero admins exist. */
export async function authSetup({ name, email, password, code }) {
  return authRequest('/api/auth/setup', {
    method: 'POST',
    body: { name, email, password, code },
  });
}

// ============ ADMIN (users, roles, per-page permissions) ============
// All admin endpoints are server-gated to admin/founder — a non-admin
// session gets a 403 with { error, code: 'forbidden' }.

/** GET /api/auth/users ? { users: [...] }. */
export async function adminListUsers() {
  return authRequest('/api/auth/users');
}

/** GET /api/auth/pages ? { pages, roles } — matrix catalogue. */
export async function adminPages() {
  return authRequest('/api/auth/pages');
}

/** POST /api/auth/users ? { user } (201). */
export async function adminCreateUser({ name, email, password, role }) {
  return authRequest('/api/auth/users', { method: 'POST', body: { name, email, password, role } });
}

/** PATCH /api/auth/users/:id ? { user }. */
export async function adminUpdateUser(id, updates) {
  return authRequest(`/api/auth/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: updates });
}

/** DELETE /api/auth/users/:id ? { deleted, ok }. */
export async function adminDeleteUser(id) {
  return authRequest(`/api/auth/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** GET /api/auth/users/:id/permissions ? { role, permissions, pages }. */
export async function adminGetPermissions(id) {
  return authRequest(`/api/auth/users/${encodeURIComponent(id)}/permissions`);
}

/** PUT /api/auth/users/:id/permissions ? { user, permissions, pages }. */
export async function adminSetPermissions(id, permissions) {
  return authRequest(`/api/auth/users/${encodeURIComponent(id)}/permissions`, {
    method: 'PUT',
    body: { permissions },
  });
}

// ============ INBOX (server-persisted messages, signed-in only) ============

/** Conversation summaries with unread counts. ? { threads, me }. */
export async function inboxThreads() {
  return authRequest('/api/inbox/threads');
}

/** Registered local accounts usable as recipients. ? { contacts }. */
export async function inboxContacts() {
  return authRequest('/api/inbox/contacts');
}

/**
 * Poll one conversation. `since` is a ms timestamp cursor � pass the ts of
 * the newest message already rendered to fetch only what is new.
 * ? { peerId, messages, readTs }
 */
export async function inboxMessages({ peer, since = 0 } = {}) {
  const q = `peer=${encodeURIComponent(peer)}${since ? `&since=${Number(since) || 0}` : ''}`;
  return authRequest(`/api/inbox/messages?${q}`);
}

/**
 * Deliver a message. `attachments` is an optional list of inline files
 * ({ kind: 'image'|'audio', mime, data, name, dur }) for photos and voice
 * notes. ? { message: { id, from, to, body, ts, generated, attachments } }.
 */
export async function inboxSend({ to, body, generated = false, toName = '', toRole = '', attachments = [] }) {
  return authRequest('/api/inbox/messages', {
    method: 'POST',
    body: { to, body, generated, toName, toRole, attachments },
  });
}

/**
 * Delete a message. `scope` 'everyone' (sender only — both sides get the
 * tombstone) or 'me'. ? { id, scope }.
 */
export async function inboxDelete({ id, scope = 'everyone' }) {
  return authRequest('/api/inbox/messages/delete', {
    method: 'POST',
    body: { id, scope },
  });
}

/** Mark a conversation read. ? { readTs }. */
export async function inboxRead(peer) {
  return authRequest('/api/inbox/read', { method: 'POST', body: { peer } });
}

// ============ CHAT (departments + channels — Slack-style group messaging) ============
// All bound to the signed-in account; ids are numeric SQLite rowids.

/** My departments (with joined flag + member counts). ? { departments }. */
export async function chatDepartments() {
  return authRequest('/api/chat/departments');
}

/** Create a department (admin/founder). ? { department }. */
export async function chatCreateDepartment(name) {
  return authRequest('/api/chat/departments', { method: 'POST', body: { name } });
}

/** Join a department (also joins its channel). ? { department }. */
export async function chatJoinDepartment(id) {
  return authRequest(`/api/chat/departments/${id}/join`, { method: 'POST', body: {} });
}

/** Leave a department (also leaves its channel). ? { department }. */
export async function chatLeaveDepartment(id) {
  return authRequest(`/api/chat/departments/${id}/leave`, { method: 'POST', body: {} });
}

/** My channels with unread badges + last-message previews. ? { channels }. */
export async function chatChannels() {
  return authRequest('/api/chat/channels');
}

/** Create a group channel (manager+). ? { channel }. */
export async function chatCreateChannel(name) {
  return authRequest('/api/chat/channels', { method: 'POST', body: { name } });
}

/** Channel detail: members, roles, counts. ? { channel }. */
export async function chatChannel(id) {
  return authRequest(`/api/chat/channels/${id}`);
}

/** Join a channel. ? { channel }. */
export async function chatJoinChannel(id) {
  return authRequest(`/api/chat/channels/${id}/join`, { method: 'POST', body: {} });
}

/** Leave a channel. ? { channel }. */
export async function chatLeaveChannel(id) {
  return authRequest(`/api/chat/channels/${id}/leave`, { method: 'POST', body: {} });
}

/** Channel history. `since` is a ms cursor. ? { channelId, messages, count }. */
export async function chatMessages(id, { since = 0, limit = 100 } = {}) {
  const q = new URLSearchParams();
  if (since) q.set('since', String(Number(since) || 0));
  if (limit) q.set('limit', String(limit));
  const qs = q.toString();
  return authRequest(`/api/chat/channels/${id}/messages${qs ? `?${qs}` : ''}`);
}

/** Post to a channel. ? { message: { id, channel, from, fromName, body, ts } }. */
export async function chatSend(id, body) {
  return authRequest(`/api/chat/channels/${id}/messages`, { method: 'POST', body: { body } });
}

/** Mark a channel read up to `ts`. ? { readTs }. */
export async function chatRead(id, ts = Date.now()) {
  return authRequest(`/api/chat/channels/${id}/read`, { method: 'POST', body: { ts } });
}

/** Signed-in accounts (member picker / AI search). ? { people }. */
export async function chatPeople() {
  return authRequest('/api/chat/people');
}

/** Invite someone into a channel. ? { channel }. */
export async function chatAddMember(id, uid) {
  return authRequest(`/api/chat/channels/${id}/members`, { method: 'POST', body: { uid } });
}

/** Remove someone (owner) — or yourself (leave). ? { channel } | { left, deleted }. */
export async function chatRemoveMember(id, uid) {
  return authRequest(`/api/chat/channels/${id}/members/${encodeURIComponent(uid)}`, { method: 'DELETE' });
}

/**
 * AI-assisted directory search: "who handles billing?" → people/channels.
 * ? { query, people, channels, departments, answer, ai }
 */
export async function chatFind(q) {
  return authRequest(`/api/chat/find?q=${encodeURIComponent(q)}`);
}

/** Total unread across my channels. ? { unread }. */
export async function chatUnread() {
  return authRequest('/api/chat/unread');
}

// ============ AI EMPLOYEES REGISTRY ============================

/** List all AI employees. ? { employees: [{id, employee_code, name, designation, status,...}] } */
export async function employeesList() {
  return fetch('/api/employees').then(r => r.json());
}

/** Get AI employee by ID. ? { employee } */
export async function employeesGet(id) {
  return fetch(`/api/employees/${id}`).then(r => r.json());
}

/** Get AI employee status. ? { id, employee_code, status } */
export async function employeesStatus(id) {
  return fetch(`/api/employees/${id}/status`).then(r => r.json());
}

/** Get AI employee profile. ? { employee } */
export async function employeesProfile(id) {
  return employeesGet(id);
}

/** Initialize AI employee from template. codes=['AI-CHIEF-001', ...]. ? { results } */
export async function employeesInitialize(codes) {
  return fetch('/api/employees/initialize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ codes: Array.isArray(codes) ? codes : [codes] })
  }).then(r => r.json());
}

/** Update AI employee. ? { employee } */
export async function employeesUpdate(id, updates) {
  return fetch(`/api/employees/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(updates)
  }).then(r => r.json());
}

/** Update AI employee permissions. ? { employee } */
export async function employeesUpdatePermissions(id, permissions) {
  return fetch(`/api/employees/${id}/permissions`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ permissions })
  }).then(r => r.json());
}

/** Delete AI employee. ? { deleted } */
export async function employeesDelete(id) {
  return fetch(`/api/employees/${id}`, {
    method: 'DELETE',
    credentials: 'include'
  }).then(r => r.json());
}

// ============ TASK MANAGEMENT ============================

/** List tasks (filters: assignedTo, status, priority, employeeType, limit, offset). */
export async function tasksList(filters = {}) {
  const params = new URLSearchParams();
  if (filters.assignedTo) params.set('assignedTo', filters.assignedTo);
  if (filters.status) params.set('status', filters.status);
  if (filters.priority) params.set('priority', filters.priority);
  if (filters.employeeType) params.set('employeeType', filters.employeeType);
  if (filters.limit) params.set('limit', String(filters.limit));
  if (filters.offset) params.set('offset', String(filters.offset));
  const qs = params.toString();
  return authRequest(`/api/tasks${qs ? `?${qs}` : ''}`);
}

/** Get specific task. */
export async function tasksGet(id) {
  return authRequest(`/api/tasks/${id}`);
}

/** Create a task. */
export async function tasksCreate({ title, description, assignedTo, assignedBy, priority, dueDate }) {
  return authRequest('/api/tasks', {
    method: 'POST',
    body: { title, description, assignedTo, assignedBy, priority, dueDate }
  });
}

/** Update task. */
export async function tasksUpdate(id, updates) {
  return authRequest(`/api/tasks/${id}`, {
    method: 'PATCH',
    body: updates
  });
}

/** Delete task. */
export async function tasksDelete(id) {
  return authRequest(`/api/tasks/${id}`, { method: 'DELETE' });
}

/** Get tasks for a specific employee. */
export async function tasksForEmployee(employeeId) {
  return authRequest(`/api/tasks/employee/${encodeURIComponent(employeeId)}`);
}

/** Get overall task summary. */
export async function tasksSummary() {
  return authRequest('/api/tasks/summary');
}

/** Get monthly report. */
export async function tasksMonthlyReport({ year, month, employeeId, employeeType }) {
  const params = new URLSearchParams();
  if (year) params.set('year', String(year));
  if (month) params.set('month', String(month));
  if (employeeId) params.set('employeeId', employeeId);
  if (employeeType) params.set('employeeType', employeeType);
  return authRequest(`/api/tasks/reports/monthly?${params.toString()}`);
}

/** Add comment to task. */
export async function tasksAddComment(taskId, content) {
  return authRequest(`/api/tasks/${taskId}/comments`, {
    method: 'POST',
    body: { content }
  });
}

/** People tasks can be assigned to: [{ id, name, kind: 'human'|'ai', role }]. */
export async function tasksPeople() {
  return authRequest('/api/tasks/people');
}

/** Comments on a task, oldest first. */
export async function tasksComments(taskId) {
  return authRequest(`/api/tasks/${encodeURIComponent(taskId)}/comments`);
}

/** Get task activity. */
export async function tasksActivity(taskId) {
  return authRequest(`/api/tasks/${taskId}/activity`);
}

// ============ AI TASK OPERATIONS ============

/** List tasks assigned to an AI employee (requires X-AI-Employee-Id header via API call options). */
export async function tasksListAi(filters = {}, aiEmployeeId) {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.priority) params.set('priority', filters.priority);
  if (filters.limit) params.set('limit', String(filters.limit));
  if (filters.offset) params.set('offset', String(filters.offset));
  const qs = params.toString();
  const res = await fetch(`/api/tasks/ai${qs ? `?${qs}` : ''}`, {
    headers: { 'X-AI-Employee-Id': aiEmployeeId }
  });
  return res.json();
}

/** Get AI employee's own task (requires X-AI-Employee-Id header). */
export async function tasksGetAi(taskId, aiEmployeeId) {
  const res = await fetch(`/api/tasks/ai/${taskId}`, {
    headers: { 'X-AI-Employee-Id': aiEmployeeId }
  });
  return res.json();
}

/** AI employee acknowledges a task (requires X-AI-Employee-Id header). */
export async function tasksAcknowledge(taskId, aiEmployeeId) {
  const res = await fetch(`/api/tasks/${taskId}/acknowledge`, {
    method: 'PATCH',
    headers: { 'X-AI-Employee-Id': aiEmployeeId }
  });
  return res.json();
}

/** AI employee updates task progress (requires X-AI-Employee-Id header). */
export async function tasksUpdateProgress(taskId, progress, description, aiEmployeeId) {
  const res = await fetch(`/api/tasks/${taskId}/progress`, {
    method: 'PATCH',
    headers: { 
      'X-AI-Employee-Id': aiEmployeeId,
      'Content-Type': 'application/json' 
    },
    body: JSON.stringify({ progress, description })
  });
  return res.json();
}

/** AI employee changes task status (requires X-AI-Employee-Id header). */
export async function tasksChangeStatus(taskId, status, pendingReason, aiEmployeeId) {
  const res = await fetch(`/api/tasks/${taskId}/status`, {
    method: 'PATCH',
    headers: { 
      'X-AI-Employee-Id': aiEmployeeId,
      'Content-Type': 'application/json' 
    },
    body: JSON.stringify({ status, pendingReason })
  });
  return res.json();
}

/** AI employee reports a blocker (requires X-AI-Employee-Id header). */
export async function tasksReportBlocker(taskId, reason, description, aiEmployeeId) {
  const res = await fetch(`/api/tasks/${taskId}/blocker`, {
    method: 'PATCH',
    headers: { 
      'X-AI-Employee-Id': aiEmployeeId,
      'Content-Type': 'application/json' 
    },
    body: JSON.stringify({ reason, description })
  });
  return res.json();
}

/** AI employee adds a comment to a task (requires X-AI-Employee-Id header). */
export async function tasksAddAiComment(taskId, content, aiEmployeeId) {
  const res = await fetch(`/api/tasks/${taskId}/comments/ai`, {
    method: 'POST',
    headers: { 
      'X-AI-Employee-Id': aiEmployeeId,
      'Content-Type': 'application/json' 
    },
    body: JSON.stringify({ content })
  });
  return res.json();
}

// ============ AGENT EXECUTION (Secure Human-to-AI Request Flow) ============

/**
 * Execute a task with an AI employee.
 * This is the secure entry point - human validates, employee identity resolved server-side.
 * Returns { executionId, status, employee, task, provider, model, startTime }
 */
export async function agentExecute(employeeId, taskId) {
  const res = await fetch(`/api/agents/${encodeURIComponent(employeeId)}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId })
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || 'Agent execution failed.');
    err.code = data.code;
    throw err;
  }
  return data;
}

async function agentJson(url, init) {
  const res = await fetch(url, init);
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong.');
    err.status = res.status;
    throw err;
  }
  return data;
}
const postJson = (url, body = {}) => agentJson(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

/** Live view of one AI run: { run: { status, phase, steps, outcome, … } }. */
export function agentRun(executionId) {
  return agentJson(`/api/agents/runs/${encodeURIComponent(executionId)}`);
}

/** Latest AI run for a task (or { run: null }). */
export function agentRunForTask(taskId) {
  return agentJson(`/api/agents/runs?taskId=${encodeURIComponent(taskId)}`);
}

/** Accept a submitted AI result: the task becomes completed. */
export function agentAccept(taskId) {
  return postJson(`/api/agents/tasks/${encodeURIComponent(taskId)}/accept`);
}

/** Ask the AI employee to revise its result; starts a new run. */
export function agentRevise(taskId, feedback) {
  return postJson(`/api/agents/tasks/${encodeURIComponent(taskId)}/revise`, { feedback });
}

/** Quick request → new task for an AI employee (Chief of Staff by default) + run. */
export function agentAsk({ text, employeeId, source, priority } = {}) {
  return postJson('/api/agents/ask', { text, employeeId, source, priority });
}

/* ---------------- Executive Agent (daily check-ins + team performance) ---------------- */
export const executiveDashboard = () => agentJson('/api/executive/dashboard');
export const executiveCheckins = () => agentJson('/api/executive/checkins');
export const executiveCreateCheckin = (body) => postJson('/api/executive/checkins', body);
export const executiveUpdateCheckin = (id, body) => agentJson(`/api/executive/checkins/${encodeURIComponent(id)}`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
export const executiveDeleteCheckin = (id) => agentJson(`/api/executive/checkins/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const executiveReport = (id, date) => agentJson(`/api/executive/checkins/${encodeURIComponent(id)}/report${date ? `?date=${encodeURIComponent(date)}` : ''}`);
export const executiveAsk = (id, force = false) => postJson(`/api/executive/checkins/${encodeURIComponent(id)}/ask`, { force });
export const executiveRemind = (id) => postJson(`/api/executive/checkins/${encodeURIComponent(id)}/remind`);

/** Pending AI actions waiting for my approval (optionally for one task). */
export async function agentApprovals(taskId) {
  const qs = taskId ? `?taskId=${encodeURIComponent(taskId)}` : '';
  const res = await fetch(`/api/agents/approvals${qs}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not load approvals.');
  return data;
}

/** Approve or reject a paused AI action; the run resumes server-side. */
export async function agentDecide(approvalId, approve, reason = '') {
  const res = await fetch(`/api/agents/approvals/${encodeURIComponent(approvalId)}/${approve ? 'approve' : 'reject'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(approve ? {} : { reason }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'That decision could not be saved.');
  return data;
}

/** Get AI employee status. */
export async function agentStatus(employeeId) {
  const res = await fetch(`/api/agents/${encodeURIComponent(employeeId)}/status`);
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || 'Could not get agent status.');
    err.code = data.code;
    throw err;
  }
  return data;
}

/** Get tasks assigned to an AI employee (requires manager access). */
export async function agentTasks(employeeId) {
  const res = await fetch(`/api/agents/${encodeURIComponent(employeeId)}/tasks`);
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || 'Could not get agent tasks.');
    err.code = data.code;
    throw err;
  }
  return data;
}

// ============ CHIEF OF STAFF (planning & delegation) ============

async function chiefFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'The Chief of Staff could not complete that.');
    err.code = data.code;
    err.planId = data.planId;
    throw err;
  }
  return data;
}

/**
 * Draft a plan. Creates NO tasks.
 * Resolves to { status: 'draft', planId, plan } or
 * { status: 'needs_clarification', missing: [...] } when information is short.
 */
export function chiefDraftPlan(payload) {
  return chiefFetch('/api/chief/plans', { method: 'POST', body: JSON.stringify(payload) });
}

export function chiefPlans(status) {
  const q = status ? `?status=${encodeURIComponent(status)}` : '';
  return chiefFetch(`/api/chief/plans${q}`);
}

export function chiefPlan(planId) {
  return chiefFetch(`/api/chief/plans/${encodeURIComponent(planId)}`);
}

/** Approve the draft — this is the call that creates the subtasks. */
export function chiefApprove(planId) {
  return chiefFetch(`/api/chief/plans/${encodeURIComponent(planId)}/approve`, { method: 'POST', body: '{}' });
}

export function chiefReject(planId, reason) {
  return chiefFetch(`/api/chief/plans/${encodeURIComponent(planId)}/reject`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export function chiefReport(planId) {
  return chiefFetch(`/api/chief/plans/${encodeURIComponent(planId)}/report`);
}

/** Staff monitor: { totals, staff[], attention[] } for employees in your authority. */
export function chiefStaff() {
  return chiefFetch('/api/chief/staff');
}

/** Apply chosen follow-ups: actions = [{ taskId, type: 'nudge'|'reassign', assigneeId? }]. */
export function chiefFollowups(actions) {
  return chiefFetch('/api/chief/staff/followups', { method: 'POST', body: JSON.stringify({ actions }) });
}
