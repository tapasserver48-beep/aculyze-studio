/**
 * NVIDIAProvider — AI provider for NVIDIA's OpenAI-compatible API.
 * Uses the same AIProvider interface as LMStudioProvider for seamless switching.
 *
 * API base: https://integrate.api.nvidia.com/v1
 *
 * Model selection: NVIDIA's /v1/models catalog contains many models that are
 * NOT servable for this account (404 "Function not found for account"),
 * EOL (410 Gone), or hang indefinitely. We therefore keep a verified candidate
 * chain (probed 2026-11: all respond < 1.5s on chat + streaming) and fail over
 * at runtime:
 *
 *   explicit model → cached working model → candidates → error
 *
 * The first model that answers a real request is cached as `activeModel` so
 * subsequent calls skip dead models entirely.
 */
const { AIProvider } = require('./provider');

// Verified-working models for this account (probe order = preference order).
// super-vl-120b: strong quality, ~700ms first token (reasons briefly).
// bolt-e4b: no reasoning overhead, ~300ms — best latency/quality balance.
const VERIFIED_MODELS = [
  'nvidia/nemotron-3.5-super-vl-120b-a12b',
  'nvidia/nemotron-3.5-bolt-e4b',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
  'nvidia/nemotron-3.5-lightning-30b-a3b',
];

// Errors where trying another model can help (dead model / hang / bad request
// for that model). 401/403 mean the key itself is wrong — no point retrying.
const FAILOVER_STATUSES = /\b(400|404|408|410|429|5\d\d)\b/;

class NVIDIAProvider extends AIProvider {
  constructor(config = {}) {
    super('nvidia');
    this.apiKey = config.apiKey || process.env.NVIDIA_API_KEY || '';
    this.baseUrl = (config.baseUrl || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, '');
    this.defaultModel = config.defaultModel || VERIFIED_MODELS[0];
    this.timeoutMs = config.timeoutMs || 15000;
    this.activeModel = null; // first model proven to answer a real request
    this._probed = false;

    if (!this.apiKey) {
      console.warn('[NVIDIA AI] Warning: NVIDIA_API_KEY not configured');
    }
  }

  get isConfigured() {
    return !!this.apiKey;
  }

  _buildHeaders() {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
  }

  _fetchWithTimeout(url, options = {}, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
        reject(new Error('Request timed out'));
      }, timeoutMs);

      fetch(url, { ...options, signal: controller.signal })
        .then(res => {
          clearTimeout(timeout);
          resolve(res);
        })
        .catch(err => {
          clearTimeout(timeout);
          reject(err);
        });
    });
  }

  /** Extract a readable message from an NVIDIA error body (handles
   *  {error}, {detail}, {title}, {message} shapes and nested objects). */
  async _readError(res) {
    const head = `NVIDIA API HTTP ${res.status}`;
    try {
      const data = await res.json().catch(() => null);
      if (typeof data === 'string') return `${head}: ${data.slice(0, 300)}`;
      if (data && typeof data === 'object') {
        const detail = data.error ?? data.detail ?? data.message ?? data.title;
        if (typeof detail === 'string') return `${head}: ${detail.slice(0, 400)}`;
        if (detail && typeof detail === 'object') {
          const inner = detail.message || detail.detail || detail.type;
          if (inner) return `${head}: ${typeof inner === 'string' ? inner.slice(0, 400) : JSON.stringify(inner).slice(0, 400)}`;
        }
        try { return `${head}: ${JSON.stringify(data).slice(0, 400)}`; } catch { /* keep head */ }
      }
    } catch { /* ignore parse errors */ }
    return head;
  }

  _shouldFailOver(err) {
    const msg = err && err.message ? String(err.message) : '';
    if (FAILOVER_STATUSES.test(msg)) return true;
    return /timed out|abort|network|ECONN|fetch failed/i.test(msg);
  }

  async getModels() {
    if (!this.isConfigured) {
      throw new Error('NVIDIA API key not configured');
    }

    try {
      const res = await this._fetchWithTimeout(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: this._buildHeaders()
      });

      if (!res.ok) {
        throw new Error(`NVIDIA API returned HTTP ${res.status}: ${await res.text().catch(() => '')}`);
      }

      const data = await res.json();
      return (data.data || [])
        .filter(m => m.id && typeof m.id === 'string')
        .map(m => ({ id: m.id, name: m.id }));
    } catch (error) {
      throw new Error(`Failed to fetch NVIDIA models: ${error.message}`);
    }
  }

  /**
   * Ordered model chain for one request:
   *   explicit → cached active → default → remaining verified candidates
   */
  _modelChain(explicit) {
    const chain = [];
    const push = (m) => { if (m && !chain.includes(m)) chain.push(m); };
    push(explicit);
    push(this.activeModel);
    push(this.defaultModel);
    VERIFIED_MODELS.forEach(push);
    return chain;
  }

  async resolveModel(explicit) {
    if (explicit) return explicit;
    if (this.activeModel) return this.activeModel;
    if (this.defaultModel) return this.defaultModel;

    try {
      const models = await this.getModels();
      if (models.length > 0) return models[0].id;
    } catch {
      // ignore
    }
    return '';
  }

  _buildPayload(messages, model, temperature, max_tokens, tools) {
    // Nemotron 3.x models emit reasoning_content before content — with a tiny
    // max_tokens the budget is eaten by reasoning and `content` comes back
    // empty. Enforce a floor so answers are never blank.
    const requested = Number(max_tokens) > 0 ? Number(max_tokens) : 2048;
    const payload = {
      model: model || this.defaultModel,
      messages: messages || [],
      temperature: temperature !== undefined ? temperature : 0.7,
      top_p: 1.0,
      max_tokens: Math.max(requested, 512),
      stream: false
    };
    // OpenAI function-calling (Tier 2 tool agent) — only sent when provided.
    if (Array.isArray(tools) && tools.length) payload.tools = tools;
    return payload;
  }

  _remember(model) {
    if (model && model !== this.activeModel) {
      if (this.activeModel) {
        console.log(`[NVIDIA AI] Switching working model: ${this.activeModel} → ${model}`);
      } else {
        console.log(`[NVIDIA AI] Working model confirmed: ${model}`);
      }
      this.activeModel = model;
    }
  }

  async sendMessage({ messages, model, temperature, max_tokens, timeoutMs, tools } = {}) {
    if (!this.isConfigured) {
      throw new Error('NVIDIA API key not configured');
    }

    const chain = this._modelChain(model);
    let lastError = null;

    for (const candidate of chain) {
      const payload = this._buildPayload(messages, candidate, temperature, max_tokens, tools);
      try {
        const res = await this._fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: this._buildHeaders(),
          body: JSON.stringify(payload)
        }, timeoutMs || this.timeoutMs);

        if (!res.ok) {
          const errMsg = await this._readError(res);
          const err = new Error(`NVIDIA API error: ${errMsg}`);
          err.status = res.status;
          if (!this._shouldFailOver(err)) throw new Error(`NVIDIA sendMessage failed: ${errMsg}`);
          lastError = err;
          console.warn(`[NVIDIA AI] Model "${candidate}" failed (${res.status}), trying next…`);
          continue;
        }

        const data = await res.json();
        const message = data?.choices?.[0]?.message || {};
        const content = message.content || '';
        this._remember(candidate);
        return {
          content,
          model: candidate,
          provider: 'nvidia',
          // Tier 2 tool agent: native function calls (empty when unused)
          toolCalls: Array.isArray(message.tool_calls) && message.tool_calls.length
            ? message.tool_calls
            : undefined,
        };
      } catch (error) {
        if (error.message && error.message.startsWith('NVIDIA sendMessage failed')) throw error;
        if (!this._shouldFailOver(error)) {
          throw new Error(`NVIDIA sendMessage failed: ${error.message}`);
        }
        lastError = error;
        console.warn(`[NVIDIA AI] Model "${candidate}" failed (${error.message}), trying next…`);
      }
    }

    throw new Error(
      `NVIDIA sendMessage failed: all ${chain.length} model(s) failed. ` +
      `Last error: ${lastError ? lastError.message : 'unknown'}`
    );
  }

  async streamMessage({ messages, model, temperature, max_tokens, onToken, timeoutMs } = {}) {
    if (!this.isConfigured) {
      throw new Error('NVIDIA API key not configured');
    }

    const chain = this._modelChain(model);
    let lastError = null;

    for (const candidate of chain) {
      const payload = this._buildPayload(messages, candidate, temperature, max_tokens);
      payload.stream = true;

      try {
        const result = await this._streamOnce(candidate, payload, onToken, timeoutMs || this.timeoutMs);
        this._remember(candidate);
        return result;
      } catch (error) {
        // If tokens already reached the client, do NOT retry — the answer
        // would restart mid-stream. Propagate instead.
        if (error && error.partialOutput) throw error;
        if (!this._shouldFailOver(error)) {
          throw error;
        }
        lastError = error;
        console.warn(`[NVIDIA AI] Model "${candidate}" failed (${error.message}), trying next…`);
      }
    }

    throw new Error(
      `NVIDIA streamMessage failed: all ${chain.length} model(s) failed. ` +
      `Last error: ${lastError ? lastError.message : 'unknown'}`
    );
  }

  _streamOnce(candidate, payload, onToken, timeoutMs) {
    return new Promise((resolve, reject) => {
      this._fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this._buildHeaders(),
        body: JSON.stringify(payload)
      }, timeoutMs)
        .then(async res => {
          if (!res.ok) {
            const errMsg = await this._readError(res);
            const err = new Error(`NVIDIA API error: ${errMsg}`);
            err.status = res.status;
            reject(err);
            return;
          }

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let full = '';
          let emitted = false;

          const fail = (err) => {
            if (emitted) {
              const e = new Error(`${err.message} (mid-stream after output began)`);
              e.partialOutput = true;
              reject(e);
            } else {
              reject(err);
            }
          };

          const pump = async () => {
            try {
              const { done, value } = await reader.read();

              if (done) {
                resolve({ content: full, model: candidate, provider: 'nvidia' });
                return;
              }

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;

                const data = trimmed.slice(5).trim();
                if (data === '[DONE]') {
                  resolve({ content: full, model: candidate, provider: 'nvidia' });
                  return;
                }

                try {
                  const json = JSON.parse(data);
                  const delta = json?.choices?.[0]?.delta?.content;
                  if (delta) {
                    full += delta;
                    emitted = true;
                    if (onToken) onToken(delta);
                  }
                } catch {
                  // ignore malformed chunks
                }
              }

              pump();
            } catch (err) {
              fail(err);
            }
          };

          pump();
        })
        .catch(err => reject(new Error(`NVIDIA API error: ${err.message}`)));
    });
  }

  async checkConnection() {
    if (!this.isConfigured) {
      return {
        online: false,
        latencyMs: 0,
        error: 'NVIDIA API key not configured'
      };
    }

    const start = Date.now();
    try {
      const models = await this.getModels();
      return {
        online: true,
        latencyMs: Date.now() - start,
        modelCount: models.length,
        activeModel: this.activeModel || this.defaultModel
      };
    } catch (error) {
      return {
        online: false,
        latencyMs: Date.now() - start,
        error: error.message
      };
    }
  }
}

module.exports = { NVIDIAProvider, VERIFIED_MODELS };
