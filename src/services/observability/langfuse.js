/**
 * Langfuse observability for Zara AI.
 *
 * Traces every chat request (input messages, model output, latency, model,
 * provider, sampling params) so generations can be inspected, debugged and
 * evaluated in Langfuse — Cloud or self-hosted.
 *
 * Strictly optional: when LANGFUSE_ENABLED is not "true" (or keys are
 * missing) every method is a silent no-op and chat works with zero overhead.
 * Tracing failures are swallowed — observability must never break chat.
 */
const { Langfuse } = require('langfuse');

class LangfuseObservability {
  constructor(env = process.env) {
    this.enabled = String(env.LANGFUSE_ENABLED || 'false').toLowerCase() === 'true';
    this.client = null;
    if (this.enabled && env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY) {
      try {
        this.client = new Langfuse({
          publicKey: env.LANGFUSE_PUBLIC_KEY,
          secretKey: env.LANGFUSE_SECRET_KEY,
          baseUrl: env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
          flushAt: 1, // send traces immediately; chat volume is low
        });
      } catch {
        this.client = null;
      }
    }
  }

  get configured() {
    return !!this.client;
  }

  status() {
    // Safe for /api/config — never includes keys.
    return { enabled: this.enabled, configured: this.configured };
  }

  /**
   * Trace one completed chat turn. Fire-and-forget from the API route.
   * @param {{ conversationId?: string, model?: string, provider?: string,
   *   messages: Array, output?: string, temperature?: number, maxTokens?: number,
   *   streamed?: boolean, latencyMs?: number, error?: string }} t
   */
  async traceChat(t = {}) {
    if (!this.client) return;
    try {
      const inputText = (t.messages || []).map((m) => `${m.role}: ${m.content}`).join('\n');
      const trace = this.client.trace({
        name: 'zara-chat',
        sessionId: t.conversationId || undefined,
        input: inputText.slice(0, 20000),
        output: (t.output || '').slice(0, 20000),
        metadata: {
          provider: t.provider || 'lmstudio',
          model: t.model || '',
          temperature: t.temperature,
          maxTokens: t.maxTokens,
          streamed: !!t.streamed,
          latencyMs: t.latencyMs,
          promptChars: inputText.length,
          completionChars: (t.output || '').length,
          error: t.error || null,
        },
      });
      trace.generation({
        name: 'llm-response',
        model: t.model || 'unknown',
        input: (t.messages || []).map((m) => ({ role: m.role, content: String(m.content).slice(0, 8000) })),
        output: (t.output || '').slice(0, 20000),
        metadata: { provider: t.provider || 'lmstudio', latencyMs: t.latencyMs },
        level: t.error ? 'ERROR' : 'DEFAULT',
        statusMessage: t.error || undefined,
      });
      await this.client.flushAsync();
    } catch {
      // never break chat for observability
    }
  }

  async shutdown() {
    try {
      if (this.client) await this.client.shutdownAsync();
    } catch { /* noop */ }
  }
}

function createObservability(env = process.env) {
  return new LangfuseObservability(env);
}

module.exports = { LangfuseObservability, createObservability };
