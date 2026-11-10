/**
 * AIProvider — provider-independent interface.
 *
 * All model providers (LM Studio today, Zara tomorrow) implement:
 *   sendMessage(), streamMessage(), getModels(), checkConnection()
 *
 * The UI and /api/chat route must only depend on this interface,
 * never on a concrete provider.
 */

class AIProvider {
  constructor(name) {
    this.name = name;
  }

  /**
   * @param {{ messages: Array<{role:string,content:string}>, model?: string, temperature?: number, max_tokens?: number, signal?: AbortSignal }} opts
   * @returns {Promise<{ content: string, model: string }>}
   */
  async sendMessage() {
    throw new Error('sendMessage() not implemented');
  }

  /**
   * @param {{ messages: Array, model?: string, temperature?: number, max_tokens?: number, signal?: AbortSignal, onToken?: (t:string)=>void }} opts
   * @returns {Promise<{ content: string, model: string }>}
   */
  async streamMessage() {
    throw new Error('streamMessage() not implemented');
  }

  /** @returns {Promise<Array<{id:string, name:string}>>} */
  async getModels() {
    throw new Error('getModels() not implemented');
  }

  /** @returns {Promise<{ online: boolean, latencyMs?: number, error?: string }>} */
  async checkConnection() {
    throw new Error('checkConnection() not implemented');
  }
}

module.exports = { AIProvider };
