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
const { ensureUid, loadUser, decrypt } = require('./src/integrations/store');
const lms = require('./src/lms/client');
const { classifyLmsIntent, formatLmsAnswer, isGeneralKnowledge } = require('./src/lms/intents');
const { createBrowserRouter } = require('./src/automation/routes');
const { createComputerRouter } = require('./src/computer/routes');
const { createOrchestratorRouter } = require('./src/orchestrator/routes');
const { createAuthRouter } = require('./src/auth/routes');
const { attachAuth } = require('./src/auth/session');
const { createInboxRouter } = require('./src/inbox/routes');
const { createChatRouter } = require('./src/chat/routes');
const { attachChatRealtime } = require('./src/chat/realtime');

// Dual-stack hosts (e.g. Render) can hand an outbound fetch a broken IPv6
// route first, which surfaces as a bare "fetch failed". Prefer IPv4; Node's
// Happy Eyeballs still falls back to IPv6 when IPv4 is unavailable.
const dns = require('dns');
if (typeof dns.setDefaultResultOrder === 'function') dns.setDefaultResultOrder('ipv4first');

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
app.use(express.json({ limit: '32mb' })); // image data URLs ride in message content
app.use(express.static(path.join(__dirname, 'public')));

// Server state lives in flat JSON files under data/ (no database).
const DATA_DIR = path.join(__dirname, 'data');
// Command Centre token accounting reads/writes data/ai-usage.json.
process.env.ACULYZE_DATA_DIR = DATA_DIR;
const aiUsage = require('./src/services/ai/usage');

// ============ AUTH (signed httpOnly session cookie) ============
// Mounted as early as possible so req.user / req.authUid exist before any
// route — or any sub-router's ensureUid() — resolves an identity. It never
// rejects: anonymous requests simply stay anonymous (the login screen and
// /api/status keep working while signed out).
app.use(attachAuth(DATA_DIR));

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

/**
 * Accept messages whose content is a plain string OR an OpenAI-style array of
 * parts ({type:'text'} / {type:'image_url'}). Vision parts are validated hard:
 * only http(s)/data URLs within size/count caps get through, so a client can
 * never smuggle local paths. Plain string content behaves exactly as before.
 */
const VISION_MAX_IMAGES = 4;
const VISION_MAX_PART_CHARS = 32_000;
const VISION_MAX_IMAGE_URL_CHARS = 10_000_000; // ~7.5MB decoded base64

function sanitizeImageUrl(raw) {
  const url = String(raw || '');
  if (!url) return null;
  if (/^data:image\/(png|jpe?g|webp|gif|bmp);base64,[A-Za-z0-9+/=]+$/.test(url)) {
    return url.length <= VISION_MAX_IMAGE_URL_CHARS ? url : null;
  }
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    const host = parsed.hostname.toLowerCase();
    if (/(^|\.)(localhost|local|internal|test)$/.test(host) || /^(127\.|10\.|192\.168\.|169\.254\.)/.test(host)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function sanitizeContent(content) {
  if (typeof content === 'string') return { role: 'ok', content: content.slice(0, VISION_MAX_PART_CHARS) };
  if (!Array.isArray(content)) return { role: 'invalid' };
  const parts = [];
  let images = 0;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text') {
      const text = String(part.text ?? '').slice(0, VISION_MAX_PART_CHARS);
      if (text.trim()) parts.push({ type: 'text', text });
    } else if (part.type === 'image_url') {
      if (images >= VISION_MAX_IMAGES) continue;
      const clean = sanitizeImageUrl(part.image_url?.url ?? part.image_url);
      if (!clean) continue;
      images += 1;
      parts.push({ type: 'image_url', image_url: { url: clean } });
    }
  }
  if (!parts.length) return { role: 'invalid' };
  return { role: 'ok', content: parts };
}

function sanitizeMessagesImpl(messages) {
  if (!Array.isArray(messages)) return null;
  const allowed = new Set(['user', 'assistant', 'system']);
  let hasUser = false;
  const out = [];
  for (const m of messages) {
    if (!m) return null;
    const role = allowed.has(m.role) ? m.role : 'user';
    const content = sanitizeContent(m.content);
    if (content.role === 'invalid') return null;
    if (role === 'user' && (typeof content.content === 'string' ? content.content.trim() : content.content.some((p) => p.type === 'text' || p.type === 'image_url'))) hasUser = true;
    out.push({ role, content: content.content });
  }
  if (!hasUser) return null;
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
    branding: { product: 'Aculyze Studio', assistant: 'Zara', company: 'Aculyze' },
  });
});

/** Connection status for the status indicator + settings panel. */
app.get('/api/status', async (req, res) => {
  const result = await provider.checkConnection();
  const response = {
    provider: router.providerName,
    status: result.online ? 'connected' : 'offline',
    latencyMs: result.latencyMs,
    error: result.error || null,
  };

  // Special handling for different modes
  if (router.providerName === 'hybrid') {
    // Hybrid mode: NVIDIA primary, LM Studio fallback
    response.server = router.lmstudioBaseUrl;
    response.nvidiaConfigured = router.nvidiaConfigured;
    response.primaryStatus = result.primary || {};
    response.fallbackStatus = result.fallback || {};
    response.modelCount = result.primary?.modelCount || 0;
  } else if (router.providerName === 'lmstudio') {
    response.server = router.lmstudioBaseUrl;
    response.modelCount = result.models?.length || 0;
  } else if (router.providerName === 'nvidia') {
    response.nvidiaConfigured = true;
    response.modelCount = result.modelCount || 0;
  } else {
    response.modelCount = Array.isArray(result.models) ? result.models.length : 0;
  }

  res.json(response);
});

/**
 * GET /api/vision/status — honest capability probe for image attachment UI.
 * Reads LM Studio's richer /api/v0 models endpoint (which reports `type: vlm`
 * and capability tags). The frontend must hide image tools when this says no.
 */
app.get('/api/vision/status', async (req, res) => {
  const envOverride = String(process.env.LM_STUDIO_VISION_MODEL || '').trim();
  try {
    const baseUrl = router.providerName === 'lmstudio' ? `${router.lmstudioBaseUrl.replace(/\/+$/, '')}/api/v0/models` : null;
    if (!baseUrl) return res.json({ available: false, reason: 'vision_endpoint_unavailable' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const raw = await fetch(baseUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (!raw.ok) throw new Error(`HTTP ${raw.status}`);
    const data = await raw.json();
    const models = Array.isArray(data?.data) ? data.data : [];
    const match = envOverride ? models.find((m) => (m.id || '') === envOverride) : null;
    const visionModel =
      match ||
      models.find((m) => m.type === 'vlm' || (Array.isArray(m.capabilities) && m.capabilities.some((c) => /vision|image/i.test(String(c))))) ||
      null;
    if (visionModel) return res.json({ available: true, model: visionModel.id, reason: 'vision_model_loaded' });
    return res.json({ available: false, reason: 'no_vision_model', model: null });
  } catch (err) {
    return res.json({ available: false, reason: 'probe_failed', error: String(err.message || err).slice(0, 200) });
  }
});

/** Available models — UI populates the model selector from this. */
app.get('/api/models', async (req, res) => {  try {
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
  const { conversationId, model, temperature, max_tokens, maxTokens, stream, agent } = req.body || {};
  const messages = sanitizeMessages(req.body?.messages);

  if (!messages || messages.length === 0) {
    return res.status(400).json({ error: 'Messages are required.' });
  }
  const hasUser = messages.some((m) =>
    m.role === 'user' && (typeof m.content === 'string' ? Boolean(m.content.trim()) : Array.isArray(m.content))
  );
  if (!hasUser) {
    return res.status(400).json({ error: 'At least one user message is required.' });
  }

  const temp = typeof temperature === 'number' ? temperature : DEFAULT_TEMPERATURE;
  const tokens =
    typeof max_tokens === 'number' ? max_tokens : typeof maxTokens === 'number' ? maxTokens : DEFAULT_MAX_TOKENS;

  // Provider-independent identity: the model answers as Zara AI by default.
  // If the caller already supplied a Sales Agent system prompt, or agent is 'sales',
  // do NOT prepend Zara's identity — Sales Agent must remain a separate agent.
  const IDENTITY_MARKER = 'You are Zara AI';
  const SALES_IDENTITY_MARKER = 'Sales Agent';
  const hasSalesSystem = messages.some((m) => m.role === 'system' && String(m.content).includes(SALES_IDENTITY_MARKER));
  const hasZaraSystem = messages.some((m) => m.role === 'system' && String(m.content).includes(IDENTITY_MARKER));
  const isSalesAgent = agent === 'sales' || hasSalesSystem;
  if (SYSTEM_PROMPT && !isSalesAgent && !hasZaraSystem) {
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
      const result = await aiUsage.withSource(isSalesAgent ? 'sales' : 'zara', () =>
        provider.sendMessage({
          messages,
          model,
          temperature: temp,
          max_tokens: tokens,
        })
      );
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
  // Reasoning models stream thinking separately — keep it off the answer path.
  const sendReasoning = (token) => {
    if (clientClosed) return;
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: token } }] })}\n\n`);
  };

  try {
    const result = await aiUsage.withSource(isSalesAgent ? 'sales' : 'zara', () =>
      provider.streamMessage({
        messages,
        model,
        temperature: temp,
        max_tokens: tokens,
        signal: abort.signal,
        onToken: sendToken,
        onReasoningToken: sendReasoning,
      })
    );
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
  // Live test through the single shared LMS client (path '' = the configured
  // base URL itself) so there is exactly one implementation of LMS requests.
  const v = await lms.verifyConnection({ baseUrl: next.baseUrl, apiKey: next.apiKey, path: '', timeoutMs: 8000 });
  next.lastTest = {
    ok: !!v.ok, status: v.status || 0, ms: v.ms, at: new Date().toISOString(),
    category: v.category || '', error: v.ok ? '' : String(v.detail || v.label || '').slice(0, 200),
  };
  saveSalesPlugin(next);
  // Saved either way — the UI shows the mapped result (including failures).
  res.json({ saved: true, test: next.lastTest, ...salesConfigView(next) });
});

/**
 * ACULYZE LMS — read-only REST access for the Sales agent, its dashboard and
 * the Inbox employee list. All transport lives in src/lms/client.js (auth,
 * error mapping, pagination, normalization) — there is no second LMS client.
 *
 * Credentials resolve per request, server-side only:
 *   1. the Aculyze LMS integration connection (Apps → Aculyze LMS, encrypted)
 *   2. the LMS_API_KEY / ACULYZE_LMS_BASE_URL env vars as a fallback
 * The key is never included in any response.
 */
function lmsCredentials(req, res) {
  let key = '';
  let baseUrl = '';
  try {
    const uid = ensureUid(req, res);
    const conn = (loadUser(DATA_DIR, uid).connections || {})['aculyze-lms'];
    if (conn && conn.apiKey) {
      key = decrypt(DATA_DIR, conn.apiKey) || '';
      baseUrl = conn.baseUrl || '';
    }
  } catch { /* fall through to env */ }
  if (!key) key = String(process.env.LMS_API_KEY || '').trim();
  if (!baseUrl) baseUrl = String(process.env.ACULYZE_LMS_BASE_URL || '').trim() || lms.LMS_DEFAULT_BASE_URL;
  return { key, baseUrl };
}

/** Mapped LMS error → our API's status + { error, category, label }. */
function sendLmsError(res, err) {
  const category = (err && err.category) || 'server_unavailable';
  const status = {
    invalid_key: 401,
    permission: 403,
    not_found: 404,
    validation: 422,
    rate_limited: 429,
    not_connected: 409,
  }[category] || 502;
  // Safe diagnostics: endpoint + mapped category + upstream status only.
  // Never logs the API key or the Authorization header.
  console.warn(`[lms] ${res.req ? res.req.method + ' ' + res.req.path : 'unknown'} → ${status} ${category}` +
    (err && err.status ? ` (upstream ${err.status})` : '') +
    (err && err.message ? ` — ${String(err.message).slice(0, 160)}` : ''));
  res.status(status).json({
    error: (err && err.message) || `Aculyze LMS: ${lms.labelOf(category)}.`,
    category,
    label: lms.labelOf(category),
  });
}

/** Pick the read endpoint that matches a Sales Agent question (GET only). */
function routeLmsEndpoint(question) {
  const q = (question || '').toLowerCase();
  if (q.includes('summary') && q.includes('sales')) return '/sales/summary';
  if (q.includes('summary')) return '/lms/summary';
  if (q.includes('sales') || q.includes('revenue') || q.includes('order') || q.includes('proposal')) return '/sales';
  if (q.includes('customer')) return '/customers';
  if (q.includes('employee')) return '/employees';
  if (q.includes('lead') || q.includes('pipeline')) return '/leads';
  return '/leads'; // default fallback
}

/**
 * LMS connection status — never exposes the API key.
 * Verified with GET /lms/summary through the shared client; the response
 * carries the mapped category/label (Connected / Invalid API key /
 * Permission denied / Server unavailable / Rate limited …).
 */
app.get('/api/lms/status', async (req, res) => {
  const { key, baseUrl } = lmsCredentials(req, res);
  if (!key) {
    return res.json({
      configured: false,
      provider: 'Aculyze LMS',
      baseUrl: lms.LMS_DEFAULT_BASE_URL,
      status: 'Not configured',
      category: 'not_connected',
      label: 'Not connected',
    });
  }
  const v = await lms.verifyConnection({ baseUrl, apiKey: key });
  res.json({
    configured: true,
    provider: 'Aculyze LMS',
    baseUrl,
    status: v.ok ? 'Connected' : v.label,
    category: v.category,
    label: v.label,
    ms: v.ms,
    // Transport cause (e.g. "fetch failed (ETIMEDOUT)") — never the API key.
    detail: v.ok ? '' : String(v.detail || '').slice(0, 300),
  });
});

/**
 * Ask the LMS a data question → routed to the matching read endpoint.
 * Returns { provider, data, endpoint } — data is JSON (pretty-printed) or
 * raw text, capped so a small model can still read it. Key stays server-side.
 */
app.post('/api/sales/query', async (req, res) => {
  const { question } = req.body || {};
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'Missing question.' });
  }
  const { key, baseUrl } = lmsCredentials(req, res);
  if (!key) {
    return res.status(409).json({
      error: 'Sales Agent is not connected to Aculyze LMS.',
      hint: 'Add your API key in Apps → Aculyze LMS, or set LMS_API_KEY on the server.',
      category: 'not_connected',
      label: 'Not connected',
    });
  }
  try {
    const endpoint = routeLmsEndpoint(question);
    const r = await lms.lmsRequest(endpoint, { baseUrl, apiKey: key });
    let dataText = r.text;
    if (r.json !== null && r.json !== undefined) {
      try { dataText = JSON.stringify(r.json, null, 1); } catch { /* keep raw text */ }
    }
    res.json({ provider: 'Aculyze LMS', data: dataText.slice(0, 12000), bytes: r.text.length, endpoint });
  } catch (err) {
    sendLmsError(res, err);
  }
});

/**
 * POST /api/sales/chat — Sales Agent dedicated chat endpoint.
 * Tool-calling architecture: detects business intent, fetches live LMS data
 * server-side, extracts structured facts, and answers from real data only.
 * Never exposes the API key. Completely separate from Zara.
 */
app.post('/api/sales/chat', async (req, res) => {
  const { messages, model, temperature, max_tokens, stream } = req.body || {};
  const userMsg = messages && Array.isArray(messages) ? messages[messages.length - 1] : null;
  const question = userMsg && userMsg.role === 'user' ? String(userMsg.content || '') : '';
  if (!question.trim()) {
    return res.status(400).json({ error: 'User message is required.' });
  }

  const { key, baseUrl } = lmsCredentials(req, res);
  if (!key) {
    return res.status(409).json({
      error: 'Aculyze LMS is not connected.',
      hint: 'Add your API key in Apps → Aculyze LMS, or set LMS_API_KEY on the server.',
      category: 'not_connected',
      label: 'Not connected',
    });
  }

  const qLower = question.toLowerCase();

  // ---------- Intent classification (shared with integrations/router.js) ----------
  const intent = classifyLmsIntent(question);
  const IS_GENERAL_KNOWLEDGE = isGeneralKnowledge(question);

  // ---------- General knowledge (no LMS query) ----------
  if (IS_GENERAL_KNOWLEDGE) {
    const salesSystemPrompt = `You are the Sales Agent of Aculyze Studio, a Business Intelligence agent. The user is asking a general knowledge question (not about their company's specific business data). Answer helpfully using your own knowledge. Do not claim to have accessed Aculyze LMS data. Be concise and professional.`;
    const finalMessages = [
      { role: 'system', content: salesSystemPrompt },
      ...messages.slice(-10).filter(Boolean),
    ];
    const temp = typeof temperature === 'number' ? temperature : DEFAULT_TEMPERATURE;
    const tokens = typeof max_tokens === 'number' ? max_tokens : typeof maxTokens === 'number' ? maxTokens : DEFAULT_MAX_TOKENS;
    if (stream !== false) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`: connected ${Date.now()}\n\n`);
      let clientClosed = false;
      const abort = new AbortController();
      res.on('close', () => { if (!res.writableFinished) { clientClosed = true; abort.abort(); } });
      const sendToken = (token) => {
        if (clientClosed) return;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`);
      };
      try {
        const result = await aiUsage.withSource('sales', () =>
          provider.streamMessage({
            messages: finalMessages, model, temperature: temp, max_tokens: tokens, signal: abort.signal, onToken: sendToken,
          })
        );
        if (!clientClosed) {
          if (!result.content) {
            res.write(`data: ${JSON.stringify({ error: 'Empty response from model.', hint: 'The model returned no text.' })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ model: result.model || model || '' })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      } catch (err) {
        if (!clientClosed) {
          res.write(`data: ${JSON.stringify({ error: err.message || 'Something went wrong.', hint: 'Sales Agent chat failed.' })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }
      return;
    }
    try {
      const result = await aiUsage.withSource('sales', () =>
        provider.sendMessage({ messages: finalMessages, model, temperature: temp, max_tokens: tokens })
      );
      return res.json({ content: result.content || '', model: result.model || model });
    } catch (err) {
      return res.status(502).json({ error: err.message || 'Something went wrong.', hint: 'Sales Agent chat failed.' });
    }
  }

  // ---------- Business questions — extract direct answers from LMS data ----------
  let directAnswer = ''; // pre-computed answer, LLM only formats it
  let lmsFacts = '';     // supporting facts for LLM context

  try {
    const fetched = {};
    const wantLeads = intent.isLead || intent.isEmpty;
    const wantSales = intent.isSale || intent.isSummary;
    const wantSummary = intent.isEmployee || intent.isSummary;

    // Fetch only what the intent needs (all calls hit the 60s LMS cache).
    if (wantLeads) {
      const rec = await lms.getRecords('leads', { baseUrl, apiKey: key, query: { per_page: 50 } });
      fetched.leads = { rows: rec.rows || [], total: rec.pagination?.total ?? (rec.rows || []).length };
    }
    if (intent.isCustomer) {
      const rec = await lms.getRecords('customers', { baseUrl, apiKey: key, query: { per_page: 50 } });
      fetched.customers = { rows: rec.rows || [], total: rec.pagination?.total ?? (rec.rows || []).length };
    }
    if (wantSales) {
      const rec = await lms.getRecords('sales', { baseUrl, apiKey: key, query: { per_page: 50 } });
      fetched.sales = { rows: rec.rows || [] };
    }
    if (wantSummary) {
      fetched.summary = await lms.getSalesSummary({ baseUrl, apiKey: key, query: {} });
    }

    ({ directAnswer, lmsFacts } = formatLmsAnswer(intent, qLower, fetched));
  } catch (err) {
    sendLmsError(res, err);
    return;
  }

  // If we have a direct answer, use LLM only to format it naturally
  // If no direct answer, fall back to facts + LLM
  const salesSystemPrompt = directAnswer
    ? `You are the Sales Agent of Aculyze Studio. The direct answer has been pre-computed from live Aculyze LMS data below. Your job is to rephrase it naturally and concisely. Do NOT add information not in the pre-computed answer. Do NOT say you don't have access to data. Just present the answer clearly.\n\nPRE-COMPUTED ANSWER: ${directAnswer}`
    : `You are the Sales Agent of Aculyze Studio, a Business Intelligence agent. You answer business questions using ONLY the Aculyze LMS facts provided below. Never use general knowledge for business questions. Never invent revenue, customer, lead, employee, or conversion statistics. If the facts don't contain the answer, say so plainly — never invent numbers. Always say "according to Aculyze LMS" when referencing data. Be concise and professional.\n\nAculyze LMS facts:\n${lmsFacts}`;

  const finalMessages = [
    { role: 'system', content: salesSystemPrompt },
    ...messages.slice(-10).filter(Boolean),
  ];

  const temp = typeof temperature === 'number' ? temperature : DEFAULT_TEMPERATURE;
  const tokens = typeof max_tokens === 'number' ? max_tokens : typeof maxTokens === 'number' ? maxTokens : DEFAULT_MAX_TOKENS;

  if (stream !== false) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`: connected ${Date.now()}\n\n`);
    let clientClosed = false;
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) { clientClosed = true; abort.abort(); } });
    const sendToken = (token) => {
      if (clientClosed) return;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`);
    };
    try {
      const result = await aiUsage.withSource('sales', () =>
        provider.streamMessage({
          messages: finalMessages, model, temperature: temp, max_tokens: tokens, signal: abort.signal, onToken: sendToken,
        })
      );
      if (!clientClosed) {
        if (!result.content) {
          res.write(`data: ${JSON.stringify({ error: 'Empty response from model.', hint: 'The model returned no text.' })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ model: result.model || model || '' })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } catch (err) {
      if (!clientClosed) {
        const errMsg = err && err.message ? String(err.message).slice(0, 300) : 'Unknown error';
        console.error('[Sales Agent] Streaming error:', errMsg);
        res.write(`data: ${JSON.stringify({ error: 'AI generation failed.', hint: errMsg || 'Sales Agent chat failed.' })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }
    return;
  }

  try {
    const result = await aiUsage.withSource('sales', () =>
      provider.sendMessage({ messages: finalMessages, model, temperature: temp, max_tokens: tokens })
    );
    console.log('[Sales Agent] Response from:', result.provider || 'unknown', '- model:', result.model || model);
    return res.json({ content: result.content || '', model: result.model || model });
  } catch (err) {
    const errMsg = err && err.message ? String(err.message).slice(0, 300) : 'Something went wrong';
    console.error('[Sales Agent] Error:', errMsg);
    
    // Check for NVIDIA-specific errors and provide fallback hint
    const isNVIDIARelated = errMsg.includes('400') || errMsg.includes('404') || errMsg.includes('401');
    
    if (isNVIDIARelated) {
      return res.status(502).json({ 
        error: 'AI model unavailable.',
        hint: 'Switching to fallback model.',
        detail: errMsg
      });
    }
    
    return res.status(502).json({ 
      error: err.message || 'Something went wrong.', 
      hint: !navigator ? 'Sales Agent chat failed.' : 'Please try again.',
      detail: errMsg
    });
  }
});

/** Get employees from Aculyze LMS for the inbox (envelope-normalized). */
// ============ COMMAND CENTRE — today's AI token usage ============
// Powers the Zara / Sales token cards on the Command Centre page.
// → { day, zara: { prompt, completion, tokens, calls }, sales: {…}, total: {…} }
app.get('/api/usage/today', (req, res) => {
  res.json(aiUsage.today());
});

app.get('/api/employees', async (req, res) => {
  const { key, baseUrl } = lmsCredentials(req, res);
  if (!key) {
    return res.json({ employees: [], status: 'Not configured', provider: 'Aculyze LMS', count: 0 });
  }
  try {
    const rec = await lms.getRecords('employees', {
      baseUrl,
      apiKey: key,
      query: { page: req.query.page, per_page: req.query.per_page || lms.MAX_PER_PAGE },
    });
    res.json({
      employees: rec.rows,
      provider: 'Aculyze LMS',
      count: rec.rows.length,
      pagination: rec.pagination,
    });
  } catch (err) {
    // LMS unreachable? Try cached data.
    try {
      const f = path.join(DATA_DIR, 'lms-cache.json');
      if (fs.existsSync(f)) {
        const cached = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (cached['/employees'] && cached['/employees'].ok) {
          const env = lms.normalizeEnvelope(cached['/employees'].json);
          return res.json({
            employees: env.rows || [],
            provider: 'Aculyze LMS (cached)',
            cached: true,
            count: env.rows?.length || 0,
            pagination: env.pagination || { currentPage: 1, perPage: 100, total: 0, lastPage: 1 },
          });
        }
      }
    } catch { /* no usable cache */ }
    sendLmsError(res, err); // Inbox falls back to its existing empty state
  }
});

/**
 * Sales Agent dashboard — KPIs + chart data from GET /sales/summary.
 * Query: date_from=YYYY-MM-DD, date_to=YYYY-MM-DD (both optional).
 * Response: { period, summary, byMonth, byEmployee, byStatus, currency }.
 * Includes a cached fallback when LMS is unreachable (e.g. Render egress blocked).
 */
app.get('/api/sales/summary', async (req, res) => {
  const { key, baseUrl } = lmsCredentials(req, res);
  if (!key) {
    return res.status(409).json({ error: 'Aculyze LMS is not connected.', category: 'not_connected', label: 'Not connected' });
  }
  try {
    const summary = await lms.getSalesSummary({
      baseUrl,
      apiKey: key,
      query: { date_from: req.query.date_from, date_to: req.query.date_to },
    });
    res.json({ provider: 'Aculyze LMS', ...summary });
  } catch (err) {
    // LMS unreachable? Try cached data so the dashboard doesn't go blank.
    try {
      const f = path.join(DATA_DIR, 'lms-cache.json');
      if (fs.existsSync(f)) {
        const cached = JSON.parse(fs.readFileSync(f, 'utf8'));
        const pathKey = '/sales/summary';
        if (cached[pathKey] && cached[pathKey].ok) {
          const env = lms.normalizeEnvelope(cached[pathKey].json);
          const data = env.data || {};
          const list = (v) => (Array.isArray(v) ? v.filter(Boolean) : []);
          return res.json({
            provider: 'Aculyze LMS (cached)',
            cached: true,
            period: data.period || null,
            summary: data.summary || { total_sales: 0, orders: 0, customers: 0, currency: null },
            byMonth: list(data.by_month),
            byEmployee: list(data.by_employee),
            byStatus: list(data.by_status),
            currency: null,
          });
        }
      }
    } catch { /* no usable cache */ }
    sendLmsError(res, err);
  }
});

/**
 * Sales Agent dashboard tables — GET /sales | /leads | /customers | /employees.
 * Query: page, per_page (≤100) + the endpoint's own whitelisted filters
 * (q, city, industry, employee, status, date_from, date_to).
 * Response: { resource, rows, pagination, period }.
 */
const DASHBOARD_RESOURCES = new Set(['sales', 'leads', 'customers', 'employees']);
app.get('/api/sales/records', async (req, res) => {
  const resource = String(req.query.resource || '');
  if (!DASHBOARD_RESOURCES.has(resource)) {
    return res.status(400).json({ error: 'Unknown LMS resource.', category: 'validation', label: 'Validation error' });
  }
  const { key, baseUrl } = lmsCredentials(req, res);
  if (!key) {
    return res.status(409).json({ error: 'Aculyze LMS is not connected.', category: 'not_connected', label: 'Not connected' });
  }
  try {
    const query = {};
    for (const p of ['page', 'per_page', 'q', 'city', 'industry', 'employee', 'status', 'date_from', 'date_to']) {
      if (req.query[p] !== undefined && req.query[p] !== '') query[p] = req.query[p];
    }
    const rec = await lms.getRecords(resource, { baseUrl, apiKey: key, query });
    res.json({
      provider: 'Aculyze LMS',
      resource: rec.resource,
      rows: rec.rows,
      pagination: rec.pagination,
      period: rec.period,
    });
  } catch (err) {
    // Try cached data for disaster recovery when LMS is unreachable from the host.
    try {
      const f = path.join(DATA_DIR, 'lms-cache.json');
      if (fs.existsSync(f)) {
        const cached = JSON.parse(fs.readFileSync(f, 'utf8'));
        const pathKey = `/${resource}`;
        if (cached[pathKey] && cached[pathKey].ok) {
          const env = lms.normalizeEnvelope(cached[pathKey].json);
          return res.json({
            provider: 'Aculyze LMS (cached)',
            cached: true,
            resource,
            rows: env.rows || [],
            pagination: env.pagination || { currentPage: 1, perPage: 100, total: 0, lastPage: 1 },
            period: null,
          });
        }
      }
    } catch { /* no usable cache */ }
    sendLmsError(res, err);
  }
});

// ============ AUTH + INBOX (local login, human-to-human messaging) ============
// /api/auth → register/login/logout/me + signed httpOnly session cookie.
// /api/inbox → threads/messages/read, all bound to the signed-in account.
// /api/chat  → departments/channels/messages (SQLite) + /ws/chat push layer.
app.use('/api/auth', createAuthRouter({ dataDir: DATA_DIR }));
app.use('/api/inbox', createInboxRouter({ dataDir: DATA_DIR }));
// The broadcast hook is filled in once the HTTP server exists (see below).
let chatBroadcast = null;
app.use('/api/chat', createChatRouter({ dataDir: DATA_DIR, broadcast: (...a) => chatBroadcast && chatBroadcast(...a) }));

// ============ APPS & INTEGRATIONS (OAuth / API-key app connections) ============
// UI → backend → IntegrationManager → provider adapter → external API.
// Tokens are stored encrypted server-side; none of them ever reach the browser.
app.use('/api/integrations', createIntegrationsRouter({ dataDir: DATA_DIR, provider }));

// ============ LOCAL BROWSER AUTOMATION (Python + Playwright, 127.0.0.1:8735) ============
// Deterministic NL routing → whitelisted browser actions only. The Python
// service is spawned on demand and never accepts arbitrary code/commands.
app.use('/api/browser', createBrowserRouter());

// ============ LOCAL COMPUTER CONTROL (Zara Desktop Agent, Phase 1) ============
// Token-authenticated, loopback-facing agent surface. Deterministic NL routing
// → whitelisted Level-1 operations (open/close/focus/list apps, window
// minimize/maximize/restore, show desktop, screen capture) via native OS
// adapters. No shell execution exists — Windows uses resolved .exe spawns +
// fixed user32 scripts, macOS uses `open -a` + fixed AppleScript templates.
app.use('/api/computer', createComputerRouter({ dataDir: path.join(__dirname, 'data') }));

// ============ ZARA ORCHESTRATOR (central intent routing) ============
// Composes the existing browser + computer routers (never duplicates them) and
// adds the YouTube/visual workflow. Decides whether a message is normal
// conversation, computer control, browser interaction, or a YouTube workflow.
// Also mounts the research/reasoning pipeline, which reaches the web through
// the SAME existing search provider and synthesizes via the existing LLM provider.
app.use('/api/orchestrator', createOrchestratorRouter({ searchProvider, llm: provider }));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(PORT, () => {
  // WebSocket layer for the group chat (authenticated by the session cookie).
  chatBroadcast = attachChatRealtime(server, { dataDir: DATA_DIR }).broadcast;
  console.log(`Aculyze Studio server running on http://localhost:${PORT}`);
  console.log(`  Provider : ${router.providerName}`);
  if (router.providerName === 'lmstudio') console.log(`  LM Studio: ${router.lmstudioBaseUrl}`);
  console.log(`  Langfuse : ${observability.configured ? 'tracing enabled' : 'disabled'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (searchProvider.shutdown) await searchProvider.shutdown();
    await observability.shutdown();
    try { require('./src/chat/db').closeDb(); } catch { /* not open */ }
    process.exit(0);
  });
}
