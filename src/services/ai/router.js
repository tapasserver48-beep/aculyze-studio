/**
 * Model Router — selects the active AIProvider based on configuration.
 * UI and API layers depend only on the router, never on LM Studio directly.
 * 
 * Supports multiple modes:
 * - 'lmstudio' (or 'hybrid'): LM Studio primary with NVIDIA fallback
 * - 'nvidia': NVIDIA API primary (requires NVIDIA_API_KEY)
 * - 'zara': placeholder for future native model
 */
const { LMStudioProvider } = require('./lmstudio');
const { ZaraProvider } = require('./zara');
const { NVIDIAProvider, VERIFIED_MODELS } = require('./nvidia');

function createRouterFromEnv(env = process.env) {
  const providerName = (env.AI_PROVIDER || 'lmstudio').toLowerCase();
  const useHybrid = providerName === 'hybrid' || providerName === 'lmstudio';
  
  // Initialize all providers
  const lmstudio = new LMStudioProvider({
    baseUrl: env.LM_STUDIO_BASE_URL || 'http://127.0.0.1:1234',
    defaultModel: env.LM_STUDIO_MODEL || '',
    timeoutMs: Number(env.LM_STUDIO_TIMEOUT_MS || 15000),
    apiKey: env.LM_STUDIO_API_KEY || '',
  });
  
  const nvidia = new NVIDIAProvider({
    apiKey: env.NVIDIA_API_KEY || '',
    baseUrl: env.NVIDIA_API_BASE_URL || 'https://integrate.api.nvidia.com/v1',
    defaultModel: env.NVIDIA_MODEL || VERIFIED_MODELS[0],
    timeoutMs: Number(env.NVIDIA_TIMEOUT_MS || 15000),
  });
  
  const zara = new ZaraProvider({});

  // Determine which provider to use
  let active;
  let effectiveProviderName;
  
  if (providerName === 'nvidia' && nvidia.isConfigured) {
    // NVIDIA mode: use NVIDIA as primary (if configured)
    active = nvidia;
    effectiveProviderName = 'nvidia';
  } else if (useHybrid && nvidia.isConfigured) {
    // Hybrid mode: try NVIDIA first, fallback to LM Studio
    active = new HybridProvider({
      primary: nvidia,
      fallback: lmstudio,
      providerName: 'hybrid'
    });
    effectiveProviderName = 'hybrid';
  } else {
    // Default to LM Studio
    active = lmstudio;
    effectiveProviderName = 'lmstudio';
  }

  return {
    active,
    providers: { lmstudio, nvidia, zara },
    providerName: effectiveProviderName,
    lmstudioBaseUrl: lmstudio.baseUrl,
    nvidiaConfigured: nvidia.isConfigured,
  };
}

/**
 * HybridProvider wraps two providers and implements fallback logic.
 * Tries primary, falls back to secondary on failure.
 */
class HybridProvider {
  constructor(config = {}) {
    this.name = 'hybrid';
    this.primary = config.primary;
    this.fallback = config.fallback;
    this.providerName = config.providerName || 'hybrid';
  }

  async sendMessage(options = {}) {
    // First try primary with short timeout
    try {
      return await this.primary.sendMessage({ 
        ...options, 
        timeoutMs: 5000,
        maxTokens: options.maxTokens || 500
      });
    } catch (primaryError) {
      // Check if error is retryable (400, 404, 500+) or just timeout/connection
      const isRetryable = primaryError && (
        primaryError.message.includes('400') ||
        primaryError.message.includes('404') ||
        primaryError.message.includes('500') ||
        primaryError.message.includes('timeout')
      );
      
      if (!isRetryable && options._skipFallback !== true) {
        console.warn(`[AI] Primary provider (${this.primary.name}) failed, falling back to ${this.fallback.name}`);
      }
      
      try {
        const result = await this.fallback.sendMessage(options);
        return { ...result, provider: 'fallback', fallback: true, originalError: primaryError.message };
      } catch (fallbackError) {
        // If both fail and it's a 404-like error, provide helpful message
        if (primaryError.message.includes('404')) {
          throw new Error(`NVIDIA endpoints unavailable (404) - falling back to LM Studio.\nError: ${primaryError.message}`);
        }
        throw primaryError; 
      }
    }
  }

  async streamMessage(options = {}) {
    try {
      return await this.primary.streamMessage(options);
    } catch (primaryError) {
      console.warn(`[AI] Primary streaming failed, falling back to ${this.fallback.name}`);
      try {
        const result = await this.fallback.streamMessage(options);
        return { ...result, provider: 'fallback', fallback: true };
      } catch (fallbackError) {
        throw primaryError;
      }
    }
  }

  async getModels() {
    const models = new Map();
    
    if (this.primary && typeof this.primary.getModels === 'function') {
      try {
        const primaryModels = await this.primary.getModels();
        primaryModels.forEach(m => models.set(`${m.id}:primary`, m));
      } catch (e) { /* ignore */ }
    }
    
    if (this.fallback && typeof this.fallback.getModels === 'function') {
      try {
        const fallbackModels = await this.fallback.getModels();
        fallbackModels.forEach(m => models.set(`${m.id}:fallback`, { ...m, provider: 'fallback' }));
      } catch (e) { /* ignore */ }
    }
    
    return Array.from(models.values());
  }

  async checkConnection() {
    const results = {
      primary: await this.primary.checkConnection(),
      fallback: await this.fallback.checkConnection()
    };
    
    return {
      online: results.primary.online || results.fallback.online,
      primary: results.primary,
      fallback: results.fallback
    };
  }
}

module.exports = { createRouterFromEnv };