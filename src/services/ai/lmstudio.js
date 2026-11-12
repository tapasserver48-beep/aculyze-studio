/**
 * LMStudioProvider implements AIProvider.
 * Talks to LM Studio's OpenAI-compatible API:
 *   GET  {baseUrl}/v1/models
 *   POST {baseUrl}/v1/chat/completions  (stream: true/false)
 *
 * No model name is hard-coded. The model id is resolved in order:
 *   1. explicit `model` passed per-request (from UI selector)
 *   2. LM_STUDIO_MODEL env var
 *   3. first model returned by /v1/models
 */
const { AIProvider } = require('./provider');

function stripTrailingSlash(s) {
  return (s || '').replace(/\/+$/, '');
}

class LMStudioProvider extends AIProvider {
  constructor({ baseUrl, defaultModel = '', timeoutMs = 15000, apiKey = '' } = {}) {
    super('lmstudio');
    this.baseUrl = stripTrailingSlash(baseUrl || 'http://127.0.0.1:1234');
    this.defaultModel = defaultModel || '';
    this.timeoutMs = timeoutMs;
    this.apiKey = apiKey || '';
  }

  _authHeaders() {
    // API key stays server-side only — never sent to the frontend.
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
  }

  async _fetchWithTimeout(url, options = {}, timeoutMs = this.timeoutMs) {
    const controller = new AbortController();
    const external = options.signal;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', onExternalAbort, { once: true });
    }
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      return res;
    } finally {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', onExternalAbort);
    }
  }

  async getModels() {
    const res = await this._fetchWithTimeout(`${this.baseUrl}/v1/models`, {
      method: 'GET',
      headers: { Accept: 'application/json', ...this._authHeaders() },
    });
    if (!res.ok) throw new Error(`LM Studio responded with HTTP ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data.data) ? data.data : [];
    return list
      // Chat completions only: LM Studio also serves embedding / reranker /
      // TTS models which cannot chat. Filter by naming convention.
      .filter((m) => !/embed|rerank|tts|whisper|clip/i.test(m.id || ''))
      .map((m) => ({ id: m.id, name: m.id }));
  }

  async resolveModel(explicit) {
    if (explicit) return explicit;
    if (this.defaultModel) return this.defaultModel;
    try {
      const models = await this.getModels();
      if (models.length > 0) return models[0].id;
    } catch {
      // ignore — caller will surface connection error
    }
    return '';
  }

  _buildPayload({ messages, model, temperature, max_tokens, tools }) {
    const payload = {
      // Content passes through unchanged: a plain string OR the sanitized
      // OpenAI-style array (text + image_url parts) from server.js.
      // Tier 2 protocol fields (assistant tool_calls, tool results) are kept
      // verbatim when present — dropping tool_call_id breaks the loop.
      messages: (messages || []).map((m) => {
        const out = { role: m.role, content: m.content };
        if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
        if (m.tool_calls) out.tool_calls = m.tool_calls;
        if (m.name) out.name = m.name;
        return out;
      }),
      stream: false,
    };
    if (model) payload.model = model;
    if (typeof temperature === 'number') payload.temperature = temperature;
    if (typeof max_tokens === 'number') payload.max_tokens = max_tokens;
    if (Array.isArray(tools) && tools.length) payload.tools = tools;
    return payload;
  }

  async sendMessage({ messages, model, temperature, max_tokens, signal, tools } = {}) {
    const resolved = await this.resolveModel(model);
    const payload = this._buildPayload({ messages, model: resolved, temperature, max_tokens, tools });
    // LM Studio requires a model field; if we still have none, let server error surface cleanly
    if (!payload.model) delete payload.model;
    const res = await this._fetchWithTimeout(
      `${this.baseUrl}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...this._authHeaders() },
        body: JSON.stringify(payload),
        signal,
      },
      120000
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LM Studio request failed (HTTP ${res.status}) ${text.slice(0, 200)}`.trim());
    }
    const data = await res.json();
    const msg = data?.choices?.[0]?.message || {};
    const content = msg.content ?? '';
    // Command Centre token accounting (exact when the API reports usage).
    require('./usage').recordResponse({ usage: data.usage, messages, content });
    return {
      content,
      model: resolved || data?.model || '',
      toolCalls: Array.isArray(msg.tool_calls) && msg.tool_calls.length ? msg.tool_calls : undefined,
    };
  }

  /**
   * Streams tokens via onToken callback. Returns full text when done.
   * Parses OpenAI SSE chunks: lines starting with "data:".
   */
  async streamMessage({ messages, model, temperature, max_tokens, signal, onToken, onReasoningToken } = {}) {
    const resolved = await this.resolveModel(model);
    const payload = this._buildPayload({ messages, model: resolved, temperature, max_tokens });
    payload.stream = true;
    if (!payload.model) delete payload.model;

    const res = await this._fetchWithTimeout(
      `${this.baseUrl}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...this._authHeaders() },
        body: JSON.stringify(payload),
        signal,
      },
      120000
    );
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`LM Studio request failed (HTTP ${res.status}) ${text.slice(0, 200)}`.trim());
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    let lastUsage = null;
    const abortStream = () => { reader.cancel().catch(() => {}); };
    signal?.addEventListener('abort', abortStream, { once: true });

    const pump = async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') return full;
          try {
            const json = JSON.parse(data);
            if (json && json.usage) lastUsage = json.usage;
            const delta = json?.choices?.[0]?.delta;
            // Reasoning models (e.g. GLM/DeepSeek-style) stream thinking in
            // `delta.reasoning_content` before the final `content`. Forward the
            // two separately so callers never present reasoning as the answer.
            const reasoning = delta?.reasoning_content ?? '';
            if (reasoning && onReasoningToken) onReasoningToken(reasoning);
            const token = delta?.content ?? json?.choices?.[0]?.text ?? '';
            if (token) {
              full += token;
              if (onToken) onToken(token);
            }
          } catch {
            // ignore malformed keep-alive chunks
          }
        }
        if (signal && signal.aborted) {
          try { await reader.cancel(); } catch { /* noop */ }
          break;
        }
      }
      return full;
    };

    try {
      full = await pump();
      // Command Centre token accounting (estimate when no usage chunk).
      try {
        require('./usage').recordResponse({ usage: lastUsage, messages, content: full });
      } catch { /* accounting must never break a reply */ }
      return { content: full, model: resolved };
    } finally {
      signal?.removeEventListener('abort', abortStream);
      if (signal?.aborted) await reader.cancel().catch(() => {});
    }
  }

  async checkConnection() {
    const started = Date.now();
    try {
      const models = await this.getModels();
      return { online: true, latencyMs: Date.now() - started, models };
    } catch (err) {
      const isAbort = err && err.name === 'AbortError';
      return {
        online: false,
        latencyMs: Date.now() - started,
        error: isAbort ? 'Connection timed out.' : (err.message || 'Unable to reach LM Studio.'),
      };
    }
  }
}

module.exports = { LMStudioProvider };
