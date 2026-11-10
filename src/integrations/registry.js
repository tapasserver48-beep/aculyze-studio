/**
 * IntegrationRegistry (§25) — the provider registry the whole system hangs on.
 *
 *   registry.register('gmail', googleProvider)
 *   registry.register('teams', microsoftProvider)
 *
 * Adding Slack/Notion/Salesforce later means: write one adapter, add its apps
 * to catalog.js, register them here — the chat system, tool layer and UI all
 * pick them up with no core changes.
 */
const { APPS, getApp, CATEGORIES, FEATURED } = require('./catalog');
const { GoogleProvider } = require('./providers/google');
const { MicrosoftProvider } = require('./providers/microsoft');
const { CanvaProvider } = require('./providers/canva');
const { AculyzeLMSProvider } = require('./providers/aculyze-lms');

class IntegrationRegistry {
  constructor() {
    this.providers = new Map(); // appId -> provider adapter instance
  }

  register(appId, provider) {
    if (!getApp(appId)) throw new Error(`Unknown app "${appId}" — add it to catalog.js first.`);
    this.providers.set(appId, provider);
  }

  /** Register one adapter for several apps (e.g. one Google OAuth app family). */
  registerFamily(provider, appIds) {
    for (const id of appIds) this.register(id, provider);
  }

  providerFor(appId) {
    return this.providers.get(appId) || null;
  }

  /** Apps that have a registered adapter (i.e. not "coming soon" stubs). */
  implemented() {
    return [...this.providers.keys()];
  }
}

function createRegistry(env = process.env) {
  const reg = new IntegrationRegistry();
  const google = new GoogleProvider(env);
  const microsoft = new MicrosoftProvider(env);
  const canva = new CanvaProvider(env);
  const lms = new AculyzeLMSProvider(env);

  reg.registerFamily(google, APPS.filter((a) => a.provider === 'google').map((a) => a.id));
  reg.registerFamily(microsoft, APPS.filter((a) => a.provider === 'microsoft').map((a) => a.id));
  if (getApp('canva')) reg.register('canva', canva);
  if (getApp('aculyze-lms')) reg.register('aculyze-lms', lms);
  return reg;
}

module.exports = { IntegrationRegistry, createRegistry, CATEGORIES, FEATURED };
