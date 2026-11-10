/**
 * OmniVoiceProvider implements VoiceProvider.
 * Talks to the local OmniVoice microservice (voice-service/server.py) over
 * http://127.0.0.1:8091 — a Python process that keeps the model warm.
 */
const { VoiceProvider } = require('./provider');

class OmniVoiceProvider extends VoiceProvider {
  constructor({ baseUrl = 'http://127.0.0.1:8091', timeoutMs = 90000 } = {}) {
    super('omnivoice');
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  async synthesize(text, { instruct, speed, signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const res = await fetch(`${this.baseUrl}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, instruct, speed }),
        signal: controller.signal,
      });
      if (!res.ok) {
        let detail = '';
        try { detail = JSON.stringify(await res.json()); } catch { /* ignore */ }
        throw new Error(`OmniVoice synthesis failed (HTTP ${res.status}) ${detail}`.slice(0, 300));
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      return { buffer, contentType: 'audio/wav' };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  async checkConnection() {
    try {
      const res = await fetch(`${this.baseUrl}/status`, {
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return { online: false, error: data.error || `HTTP ${res.status}` };
      }
      const data = await res.json();
      return { online: !!data.ok, model: data.model, error: data.ok ? undefined : data.error };
    } catch (err) {
      return { online: false, error: 'OmniVoice service is not running.' };
    }
  }
}

module.exports = { OmniVoiceProvider };
