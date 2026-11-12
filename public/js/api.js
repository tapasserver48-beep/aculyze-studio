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

/** Deliver a message. ? { message: { id, from, to, body, ts, generated } }. */
export async function inboxSend({ to, body, generated = false, toName = '', toRole = '' }) {
  return authRequest('/api/inbox/messages', {
    method: 'POST',
    body: { to, body, generated, toName, toRole },
  });
}

/** Mark a conversation read. ? { readTs }. */
export async function inboxRead(peer) {
  return authRequest('/api/inbox/read', { method: 'POST', body: { peer } });
}
