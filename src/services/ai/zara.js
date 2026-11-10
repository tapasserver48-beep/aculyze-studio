/**
 * ZaraProvider — FUTURE placeholder for the native Zara model/API.
 * Implements the same AIProvider interface so the UI and /api/chat
 * route can switch providers via configuration without redesign.
 *
 * DO NOT implement model logic here yet.
 */
const { AIProvider } = require('./provider');

class ZaraProvider extends AIProvider {
  constructor(options = {}) {
    super('zara');
    this.options = options;
  }

  async sendMessage() {
    throw new Error('ZaraProvider is not implemented yet. Set AI_PROVIDER=lmstudio.');
  }

  async streamMessage() {
    throw new Error('ZaraProvider is not implemented yet. Set AI_PROVIDER=lmstudio.');
  }

  async getModels() {
    return [];
  }

  async checkConnection() {
    return { online: false, error: 'Zara provider is not configured yet.' };
  }
}

module.exports = { ZaraProvider };
