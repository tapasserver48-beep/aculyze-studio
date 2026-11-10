/**
 * VoiceProvider — provider-independent TTS interface for Zara.
 *
 *   OmniVoiceProvider  → local OmniVoice service (AI voice, 24 kHz WAV)
 *   (browser TTS lives client-side in js/voice.js as the fallback)
 *
 * The UI only ever talks to POST /api/voice/synthesize; the concrete
 * provider is chosen by configuration.
 */
class VoiceProvider {
  constructor(name) {
    this.name = name;
  }

  /**
   * @param {string} text
   * @param {{ instruct?: string, speed?: number }} opts
   * @returns {Promise<{ buffer: Buffer, contentType: string }>}
   */
  async synthesize() {
    throw new Error('synthesize() not implemented');
  }

  /** @returns {Promise<{ online: boolean, model?: string, error?: string }>} */
  async checkConnection() {
    throw new Error('checkConnection() not implemented');
  }
}

module.exports = { VoiceProvider };
