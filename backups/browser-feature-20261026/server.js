/**
 * Zara AI — server
 * Serves the chat UI and provides a provider-independent Chat API
 * that proxies to the configured Model Provider (LM Studio today, Zara later).
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { createRouterFromEnv } = require('./src/services/ai/router');
const { createObservability } = require('./src/services/observability/langfuse');
const { DuckDuckGoProvider } = require('./src/services/search/duckduckgo');
const { GoogleProvider } = require('./src/services/search/google');
const { PlaywrightProvider } = require('./src/services/search/playwright');
const { MCPBridge } = require('./src/services/mcp/manager');
const { OmniVoiceProvider } = require('./src/services/voice/omnivoice');
const { createIntegrationsRouter } = require('./src/integrations/routes');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DEFAULT_TEMPERATURE = Number(process.env.DEFAULT_TEMPERATURE ?? 0.7);
const DEFAULT_MAX_TOKENS = Number(process.env.DEFAULT_MAX_TOKENS ?? 2048);
const SYSTEM_PROMPT =
  process.env.ZARA_SYSTEM_PROMPT ||
  'You are Zara AI, a helpful assistant by Aculyze. Answer clearly and concisely using markdown when it helps readability.';

const router = createRouterFromEnv(process.env);
const provider = router.active;
const observability = createObservability(process.env);

// Search router: SEARCH_PROVIDER=playwright (keyless headless browser,
// default), duckduckgo (direct API, keyless), or google (Custom Search API
// key). Playwright bypasses endpoint blocks by driving real browser pages.
const searchProviderName = String(process.env.SEARCH_PROVIDER || 'playwright').toLowerCase();
const searchProvider =
  searchProviderName === 'google'
    ? new GoogleProvider({ apiKey: process.env.GOOGLE_SEARCH_KEY || '', engineId: process.env.GOOGLE_SEARCH_CX || '' })
    : searchProviderName === 'duckduckgo'
      ? new DuckDuckGoProvider()
      : new PlaywrightProvider({ timeoutMs: Number(process.env.SEARCH_TIMEOUT_MS || 25000) });

// Gmail-over-MCP bridge. Disabled unless MCP_ENABLED=true and a server
// command is configured. OAuth credentials belong to the MCP server process
// (its own env/config files) — Zara only passes the command to spawn it.
const mcpEnabled = String(process.env.MCP_ENABLED || 'false').toLowerCase() === 'true';
const gmailBridge = new MCPBridge({
  command: mcpEnabled ? (process.env.GMAIL_MCP_COMMAND || '') : '',
  args: process.env.GMAIL_MCP_ARGS || '',
  timeoutMs: Number(process.env.MCP_TIMEOUT_MS || 60000),
});
const gmailSendTool = process.env.GMAIL_SEND_TOOL || 'send_email';

// AI voice (TTS): OmniVoice local service. VOICE_PROVIDER=omnivoice enables
// server-side synthesis; browser speechSynthesis remains the client fallback.
const voiceProviderName = String(process.env.VOICE_PROVIDER || 'omnivoice').toLowerCase();
const voiceProvider =
  voiceProviderName === 'omnivoice'
    ? new OmniVoiceProvider({
        baseUrl: process.env.OMNIVOICE_BASE_URL || 'http://127.0.0.1:8091',
        timeoutMs: Number(process.env.OMNIVOICE_TIMEOUT_MS || 90000),
      })
    : null;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function sanitizeMessages(messages) {
  return sanitizeMessagesImpl(messages);
}

/** Friendly hint: auth failures point at the API key, everything else at the server. */
function hintFor(detail) {
  const d = String(detail || '');
  if (d.includes('401') || /unauthorized|api key/i.test(d)) {
    return 'LM Studio rejected the API key. Check LM_STUDIO_API_KEY in .env matches the key shown in LM Studio.';
  }
  return null;
}

function sanitizeMessagesImpl(messages) {
  if (!Array.isArray(messages)) return null;
  const allowed = new Set(['user', 'assistant', 'system']);
  const out = [];
  for (const m of messages) {
    if (!m || typeof m.content !== 'string') return null;
    const role = allowed.has(m.role) ? m.role : 'user';
    const content = m.content.slice(0, 32000);
    if (!content.trim() && role === 'user') continue;
    out.push({ role, content });
  }
  return out;
}

/** Safe public config — never leak secrets. */
app.get('/api/config', (req, res) => {
  res.json({
    provider: router.providerName,
    defaultTemperature: DEFAULT_TEMPERATURE,
    defaultMaxTokens: DEFAULT_MAX_TOKENS,
    observability: { langfuse: observability.status() },
    search: { provider: searchProvider.name },
    email: { enabled: mcpEnabled, configured: gmailBridge.configured },
    voice: { provider: voiceProviderName, enabled: !!voiceProvider },
    branding: { product: 'Zara AI', company: 'Aculyze' },
  });
});

/** Connection status for the status indicator + settings panel. */
app.get('/api/status', async (req, res) => {
  const result = await provider.checkConnection();
  res.json({
    provider: router.providerName,
    server: router.providerName === 'lmstudio' ? router.lmstudioBaseUrl : null,
    status: result.online ? 'connected' : 'offline',
    latencyMs: result.latencyMs,
    error: result.error || null,
    modelCount: Array.isArray(result.models) ? result.models.length : 0,
  });
});

/** Available models — UI populates the model selector from this. */
app.get('/api/models', async (req, res) => {
  try {
    const models = await provider.getModels();
    res.json({ provider: router.providerName, models });
  } catch (err) {
    const detail = String(err.message || err).slice(0, 300);
    res.status(502).json({
      error: 'Unable to reach the model server.',
      hint: hintFor(detail) || 'Make sure LM Studio is running and its local server is enabled.',
      detail,
    });
  }
});

/**
 * POST /api/chat — provider-independent chat endpoint.
 * Body: { conversationId?, messages: [{role, content}], model?, temperature?, max_tokens?, stream? }
 * Streams OpenAI-style SSE: `data: {"choices":[{"delta":{"content":"..."}}]}` ... `data: [DONE]`
 * If stream === false, returns JSON { content, model }.
 */
app.post('/api/chat', async (req, res) => {
  const { conversationId, model, temperature, max_tokens, maxTokens, stream } = req.body || {};
  const messages = sanitizeMessages(req.body?.messages);

  if (!messages || messages.length === 0) {
    return res.status(400).json({ error: 'Messages are required.' });
  }
  const hasUser = messages.some((m) => m.role === 'user' && m.content.trim());
  if (!hasUser) {
    return res.status(400).json({ error: 'At least one user message is required.' });
  }

  const temp = typeof temperature === 'number' ? temperature : DEFAULT_TEMPERATURE;
  const tokens =
    typeof max_tokens === 'number' ? max_tokens : typeof maxTokens === 'number' ? maxTokens : DEFAULT_MAX_TOKENS;

  // Provider-independent identity: the model answers as Zara AI.
  // A caller-supplied system message (e.g. web-search context) is kept,
  // and the identity is still prepended ahead of it.
  const IDENTITY_MARKER = 'You are Zara AI';
  if (SYSTEM_PROMPT && !messages.some((m) => m.role === 'system' && String(m.content).includes(IDENTITY_MARKER))) {
    messages.unshift({ role: 'system', content: SYSTEM_PROMPT });
  }

  const useStream = stream !== false; // default to streaming
  const startedAt = Date.now();
  const traceBase = {
    conversationId: conversationId || undefined,
    provider: router.providerName,
    messages,
    temperature: temp,
    maxTokens: tokens,
  };

  if (!useStream) {
    try {
      const result = await provider.sendMessage({
        messages,
        model,
        temperature: temp,
        max_tokens: tokens,
      });
      observability.traceChat({
        ...traceBase,
        model: result.model || model,
        output: result.content,
        streamed: false,
        latencyMs: Date.now() - startedAt,
      });
      return res.json({ conversationId: conversationId || null, content: result.content, model: result.model });
    } catch (err) {
      const detail = String(err.message || err).slice(0, 300);
      observability.traceChat({
        ...traceBase,
        model: model,
        output: '',
        streamed: false,
        latencyMs: Date.now() - startedAt,
        error: detail,
      });
      return res.status(502).json({
        error: 'Something went wrong.',
        hint: hintFor(detail) || "LM Studio isn't connected. Start the local model server and try again.",
        detail,
      });
    }
  }

  // --- Streaming (SSE) ---
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`: connected ${Date.now()}\n\n`);

  let clientClosed = false;
  const abort = new AbortController();
  // NOTE: use the *response* close event (request 'close' fires as soon as
  // the inbound body is received, even while we are still streaming out).
  res.on('close', () => {
    if (!res.writableFinished) {
      clientClosed = true;
      abort.abort();
    }
  });

  const sendToken = (token) => {
    if (clientClosed) return;
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`);
  };

  try {
    const result = await provider.streamMessage({
      messages,
      model,
      temperature: temp,
      max_tokens: tokens,
      signal: abort.signal,
      onToken: sendToken,
    });
    if (!clientClosed) {
      if (!result.content) {
        res.write(
          `data: ${JSON.stringify({ error: 'Empty response from model.', hint: "The model returned no text. Try again." })}\n\n`
        );
      }
      res.write(`data: ${JSON.stringify({ model: result.model || model || '' })}\n\n`);
      res.write('data: [DONE]\n\n');
    }
    observability.traceChat({
      ...traceBase,
      model: result.model || model,
      output: result.content,
      streamed: true,
      latencyMs: Date.now() - startedAt,
    });
  } catch (err) {
    if (!clientClosed) {
      let msg = "LM Studio isn't connected. Start the local model server and try again.";
      if (err && err.name === 'AbortError') {
        msg = 'Generation stopped.';
      } else if (err && err.hint) {
        msg = err.hint;
      } else if (hintFor(err && err.message)) {
        msg = hintFor(err.message);
      }
      res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
      res.write('data: [DONE]\n\n');
      if (err && err.name !== 'AbortError') {
        observability.traceChat({
          ...traceBase,
          model: model,
          output: '',
          streamed: true,
          latencyMs: Date.now() - startedAt,
          error: msg,
        });
      }
    }
  } finally {
    res.end();
  }
});

/**
 * GET /api/search?q=...&n=5 — keyless web search (DuckDuckGo).
 * Used by the UI's web toggle to ground replies in fresh results.
 */
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const n = Math.min(Math.max(Number(req.query.n) || 5, 1), 10);
  if (!q) return res.status(400).json({ error: 'Query parameter "q" is required.' });
  try {
    const results = await searchProvider.search(q, { count: n });
    res.json({ provider: searchProvider.name, query: q, results });
  } catch (err) {
    res.status(502).json({
      error: 'Web search failed.',
      hint: 'Check your internet connection and try again.',
      detail: String(err.message || err).slice(0, 300),
    });
  }
});

/**
 * GET /api/email/status — is the Gmail MCP bridge usable?
 * Lists the MCP server's tools (proves OAuth is working) when configured.
 */
app.get('/api/email/status', async (req, res) => {
  if (!gmailBridge.configured) {
    return res.json({ enabled: mcpEnabled, configured: false, tools: [] });
  }
  try {
    const tools = await gmailBridge.listTools();
    res.json({ enabled: true, configured: true, tools });
  } catch (err) {
    res.status(502).json({
      enabled: true,
      configured: true,
      tools: [],
      error: 'Gmail MCP server is not reachable.',
      hint: 'Check GMAIL_MCP_COMMAND/ARGS and that the MCP server OAuth credentials are set up.',
      detail: String(err.message || err).slice(0, 300),
    });
  }
});

function isValidEmail(address) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(address || '').trim());
}

/**
 * POST /api/email/send { to, subject, body } — send mail via Gmail MCP.
 * Argument names ({to, subject, body}) match common Gmail MCP servers;
 * override the tool with GMAIL_SEND_TOOL if yours differs.
 */
app.post('/api/email/send', async (req, res) => {
  if (!gmailBridge.configured) {
    return res.status(503).json({
      error: 'Email is not configured.',
      hint: 'Set MCP_ENABLED=true and GMAIL_MCP_COMMAND in .env, then restart.',
    });
  }
  const to = String(req.body?.to || '').trim();
  const subject = String(req.body?.subject || '').trim().slice(0, 200);
  const body = String(req.body?.body || '').slice(0, 20000);
  if (!isValidEmail(to)) return res.status(400).json({ error: 'A valid "to" email address is required.' });
  if (!subject) return res.status(400).json({ error: '"subject" is required.' });
  if (!body.trim()) return res.status(400).json({ error: '"body" is required.' });
  try {
    const result = await gmailBridge.callTool(gmailSendTool, { to, subject, body });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(502).json({
      error: 'Sending failed.',
      hint: 'The Gmail MCP server reported an error — it may need (re)authentication.',
      detail: String(err.message || err).slice(0, 300),
    });
  }
});

/**
 * GET /api/page?url=... — fetch a page's readable text (Playwright).
 * Used by the UI to ground answers in real content, not just snippets.
 * Blocks private/localhost addresses (no SSRF).
 */
app.get('/api/page', async (req, res) => {
  const url = String(req.query.url || '');
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) {
      return res.status(400).json({ error: 'Only http/https URLs are allowed.' });
    }
    const host = parsed.hostname.toLowerCase();
    if (/^(localhost|127\.|0\.0\.0\.0|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1)/.test(host)) {
      return res.status(400).json({ error: 'Internal addresses cannot be fetched.' });
    }
    if (typeof searchProvider.fetchPage !== 'function') {
      return res.status(501).json({ error: 'Page fetching is not supported by this search provider.' });
    }
    const pageData = await searchProvider.fetchPage(url, { maxChars: 6000 });
    res.json(pageData);
  } catch (err) {
    res.status(502).json({
      error: 'Could not read that page.',
      hint: 'The site may be slow, blocked, or require JavaScript.',
      detail: String(err.message || err).slice(0, 300),
    });
  }
});

/**
 * GET /api/voice/status — is the local AI voice service up?
 */
app.get('/api/voice/status', async (req, res) => {
  if (!voiceProvider) {
    return res.json({ provider: 'browser', enabled: false, online: false, model: null });
  }
  const r = await voiceProvider.checkConnection();
  res.json({
    provider: voiceProviderName,
    enabled: true,
    online: r.online,
    model: r.model || null,
    error: r.error || null,
  });
});

/**
 * POST /api/voice/synthesize { text, instruct?, speed? } → audio/wav
 * Zara's AI voice (OmniVoice) speaking Zara's replies.
 */
app.post('/api/voice/synthesize', async (req, res) => {
  if (!voiceProvider) {
    return res.status(503).json({
      error: 'AI voice is not enabled.',
      hint: 'VOICE_PROVIDER=omnivoice in .env (browser voice still works).',
    });
  }
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: '"text" is required.' });
  // CPU synthesis runs ~14x slower than real time — cap how much we speak
  // in one go so read-aloud never turns into a multi-minute wait.
  const spoken = text.length > 600 ? `${text.slice(0, 600)}…` : text;
  if (text.length > 600) console.log('[voice] text trimmed to 600 chars for CPU synthesis');
  try {
    const { buffer, contentType } = await voiceProvider.synthesize(spoken, {
      instruct: typeof req.body?.instruct === 'string' ? req.body.instruct.slice(0, 300) : undefined,
      speed: typeof req.body?.speed === 'number' ? req.body.speed : undefined,
      signal: req.destroyed ? AbortSignal.abort() : undefined,
    });
    res.set('Content-Type', contentType);
    res.set('Content-Length', String(buffer.length));
    res.send(buffer);
  } catch (err) {
    const detail = String(err.message || err).slice(0, 300);
    const isDown = /not running|fetch failed|ECONNREFUSED|abort/i.test(detail);
    res.status(502).json({
      error: isDown ? "Zara's AI voice isn't running." : 'Voice synthesis failed.',
      hint: isDown
        ? 'Start the voice service: cd voice-service && python server.py'
        : detail,
      detail,
    });
  }
});

// ============ SALES AI AGENT — SAP / ERP plugin ============
// The plugin connection (provider name, base URL, API key) is stored
// server-side in data/sales-plugin.json — the key is NEVER sent to the UI.
const SALES_PLUGIN_FILE = path.join(__dirname, 'data', 'sales-plugin.json');

function loadSalesPlugin() {
  try { return JSON.parse(fs.readFileSync(SALES_PLUGIN_FILE, 'utf8')); } catch { return {}; }
}
function saveSalesPlugin(cfg) {
  fs.mkdirSync(path.dirname(SALES_PLUGIN_FILE), { recursive: true });
  fs.writeFileSync(SALES_PLUGIN_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}
function salesConfigView(p) {
  return {
    connected: !!(p.providerName && p.baseUrl && p.apiKey),
    inUse: !!p.inUse,
    providerName: p.providerName || '',
    baseUrl: p.baseUrl || '',
    hasKey: !!p.apiKey,           // never expose the key itself
    lastTest: p.lastTest || null,
  };
}
function salesHeaders(p) {
  return {
    Authorization: `Bearer ${p.apiKey}`,
    'X-API-Key': p.apiKey,
    Accept: 'application/json, text/plain, */*',
  };
}

/** Plugin status for the Settings panel (no secret in the response). */
app.get('/api/sales/status', (req, res) => {
  res.json(salesConfigView(loadSalesPlugin()));
});

/**
 * Save / update the plugin connection and run a live connection test.
 * Body: { providerName?, baseUrl?, apiKey?, inUse? } — omitted fields keep
 * their stored value; an empty apiKey keeps the saved key.
 */
app.post('/api/sales/connect', async (req, res) => {
  const cur = loadSalesPlugin();
  const body = req.body || {};
  const next = {
    providerName: String(body.providerName !== undefined ? body.providerName : cur.providerName || '').trim().slice(0, 80),
    baseUrl: String(body.baseUrl !== undefined ? body.baseUrl : cur.baseUrl || '').trim().slice(0, 500),
    apiKey: String(body.apiKey !== undefined && String(body.apiKey).trim() ? body.apiKey : cur.apiKey || '').trim().slice(0, 500),
    inUse: body.inUse !== undefined ? !!body.inUse : !!cur.inUse,
    lastTest: cur.lastTest || null,
  };
  if (next.baseUrl && !/^https?:\/\//i.test(next.baseUrl)) {
    return res.status(400).json({ error: 'API base URL must start with http:// or https://' });
  }
  if (next.apiKey !== cur.apiKey) next.lastTest = null;
  saveSalesPlugin(next);

  if (!next.providerName || !next.baseUrl || !next.apiKey) {
    return res.json({ saved: true, test: null, ...salesConfigView(next) });
  }
  // Live test: does the ERP answer with our key?
  const t0 = Date.now();
  try {
    const r = await fetch(next.baseUrl, { headers: salesHeaders(next), signal: AbortSignal.timeout(8000) });
    next.lastTest = { ok: r.ok, status: r.status, ms: Date.now() - t0, at: new Date().toISOString() };
    saveSalesPlugin(next);
    res.json({ saved: true, test: next.lastTest, ...salesConfigView(next) });
  } catch (err) {
    next.lastTest = {
      ok: false, status: 0, ms: Date.now() - t0, at: new Date().toISOString(),
      error: String(err.message || err).slice(0, 200),
    };
    saveSalesPlugin(next);
    // Saved, but the endpoint didn't answer — report it so the UI can show why.
    res.json({ saved: true, test: next.lastTest, ...salesConfigView(next) });
  }
});

/**
 * Fetch live data from the connected ERP/SAP endpoint for the Sales agent.
 * Returns { provider, data } — data is JSON (pretty-printed) or raw text,
 * capped so a tiny model can still read it.
 */
app.post('/api/sales/query', async (req, res) => {
  const p = loadSalesPlugin();
  if (!p.inUse) {
    return res.status(400).json({
      error: 'Sales plugin is not switched on.',
      hint: 'Settings → Sales Agent Plugin → enable "Use this plugin".',
    });
  }
  if (!(p.providerName && p.baseUrl && p.apiKey)) {
    return res.status(400).json({
      error: 'Sales plugin is not connected.',
      hint: 'Settings → Sales Agent Plugin → add provider, URL and API key.',
    });
  }
  try {
    const r = await fetch(p.baseUrl, { headers: salesHeaders(p), signal: AbortSignal.timeout(15000) });
    if (!r.ok) {
      return res.status(502).json({ error: `${p.providerName} answered HTTP ${r.status}.`, hint: 'Check the API key and URL in Settings.' });
    }
    const text = await r.text();
    let dataText = text;
    try { dataText = JSON.stringify(JSON.parse(text), null, 1); } catch { /* plain text */ }
    if (p.apiKey) dataText = dataText.split(p.apiKey).join('•••'); // never echo the key
    res.json({ provider: p.providerName, data: dataText.slice(0, 12000), bytes: text.length });
  } catch (err) {
    const detail = String(err.message || err).slice(0, 200);
    res.status(502).json({ error: `Could not reach ${p.providerName}.`, hint: detail });
  }
});

// ============ APPS & INTEGRATIONS (OAuth / API-key app connections) ============
// UI → backend → IntegrationManager → provider adapter → external API.
// Tokens are stored encrypted server-side; none of them ever reach the browser.
app.use('/api/integrations', createIntegrationsRouter({ dataDir: path.join(__dirname, 'data') }));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Zara AI server running on http://localhost:${PORT}`);
  console.log(`  Provider : ${router.providerName}`);
  if (router.providerName === 'lmstudio') console.log(`  LM Studio: ${router.lmstudioBaseUrl}`);
  console.log(`  Langfuse : ${observability.configured ? 'tracing enabled' : 'disabled'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (searchProvider.shutdown) await searchProvider.shutdown();
    await observability.shutdown();
    process.exit(0);
  });
}
