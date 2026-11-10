/**
 * IntegrationManager — one façade for the whole app-integration system:
 *
 *   Zara UI → Zara Backend → IntegrationManager → Provider Adapter → External API
 *
 * Responsibilities:
 *  - OAuth connect/callback/test/disconnect lifecycle per user
 *  - Token refresh (auto, serialized), encrypted at rest, never serialized out
 *  - Tool execution with permission gating (§16) and confirmation for writes (§12)
 *  - Chat bridge: message → tool plan → normalized data → context + steps + sources
 *
 * The frontend never sees provider logic — it receives a ready-to-send system
 * context, display steps and a compact source list.
 */
const { loadUser, saveUser, encrypt, decrypt, signState, verifyState } = require('./store');
const { getApp, APPS, CATEGORIES, FEATURED } = require('./catalog');
const { getTool } = require('./tools');
const { createRegistry } = require('./registry');
const { plan } = require('./router');
const { draftMail } = require('./mailDraft');
const { IntegrationError } = require('./providers/base');
const crypto = require('crypto');

const APP_CAP = 6000;      // per-app context slice
const CONTEXT_CAP = 16000; // total context cap (web/erp contexts keep their own budget)
const TOOL_TIMEOUT_MS = 20000;

function makeVerifier() { return crypto.randomBytes(48).toString('base64url'); }
function challenge(v) { return crypto.createHash('sha256').update(v).digest('base64url'); }

class IntegrationManager {
  constructor({ dataDir, env = process.env, provider = null } = {}) {
    if (!dataDir) throw new Error('IntegrationManager requires dataDir');
    this.dataDir = dataDir;
    this.env = env;
    // AI brain for Tier 2 (LLM tool-calling). Optional — without it
    // resolve() stays Tier 1 only.
    this.provider = provider || null;
    this.registry = createRegistry(env);
    this._refreshing = new Map(); // uid:app -> Promise (serialize token refresh)
  }

  // ==================== catalog / status ====================

  providerFor(appId) { return this.registry.providerFor(appId); }

  connFor(uid, appId) { return loadUser(this.dataDir, uid).connections[appId] || null; }

  appView(uid, appId) {
    const app = getApp(appId);
    if (!app) return null;
    const provider = this.registry.providerFor(appId);
    const conn = this.connFor(uid, appId);
    // Effective credentials = the same rule the Sales dashboard uses
    // (server.js lmsCredentials): per-user connection, else the env fallback.
    // Apps must never disagree with Sales about whether we're connected.
    const envKey = appId === 'aculyze-lms' ? String(process.env.LMS_API_KEY || '').trim() : '';
    const envBaseUrl = appId === 'aculyze-lms'
      ? String(process.env.ACULYZE_LMS_BASE_URL || '').trim() || 'https://lm.aculyze.in/api/v1'
      : '';
    const hasStoredKey = !!(conn && conn.apiKey);
    const effectiveKey = hasStoredKey || !!envKey;

    let status = 'not_connected';
    if (app.state === 'soon') status = 'coming_soon';
    else if (app.auth && !provider) status = 'coming_soon'; // catalog app without an adapter
    else if (app.auth === 'oauth' && !provider.configured) status = 'not_configured';
    else if (conn) status = conn.status || 'not_connected';
    // API-key app backed only by env → still a usable connection.
    if (status === 'not_connected' && app.auth === 'apikey' && envKey) status = 'connected';

    return {
      id: app.id, name: app.name, icon: app.icon, category: app.category,
      desc: app.desc, state: app.state, featured: FEATURED.includes(app.id),
      auth: app.auth || null, provider: provider ? provider.id : null,
      connectLabel: app.connectLabel || 'Connect',
      consent: app.consent || [], permissions: app.permissions || [],
      tools: app.tools || [], link: app.link || null,
      status,
      account: (conn && conn.account) || '',
      granted: (conn && conn.granted) || [],
      connectedAt: (conn && conn.connectedAt) || null,
      lastTest: (conn && conn.lastTest) || null,
      // API-key apps only: a "saved" indicator + base URL. The key itself —
      // and any part of it — never leaves the server (no prefix/suffix chars).
      mask: effectiveKey ? '••••••••••••' : '',
      baseUrl: (conn && conn.baseUrl) || envBaseUrl,
      hasKey: effectiveKey,
    };
  }

  listApps(uid) {
    return APPS.map((a) => this.appView(uid, a.id)).filter(Boolean);
  }

  listCatalog() {
    return {
      categories: CATEGORIES,
      featured: FEATURED,
      apps: this.listApps(null).map((v) => {
        // unauthenticated shapes (no per-user fields) for pure catalog info
        const app = getApp(v.id);
        return { ...v, consent: app.consent, permissions: app.permissions };
      }),
    };
  }

  permissionsView(uid, appId) {
    const view = this.appView(uid, appId);
    if (!view) return null;
    const granted = new Set(view.granted);
    return {
      app: view.id, name: view.name, status: view.status,
      scopes: view.granted,
      permissions: (view.permissions || []).map((p) => ({ ...p, granted: granted.has(p.id) })),
      writeConfirmationRequired: true,
    };
  }

  // ==================== OAuth lifecycle ====================

  redirectUri(appId, redirectBase) { return `${redirectBase}/api/integrations/${appId}/callback`; }

  async startConnect(uid, appId, { redirectBase, body = {} } = {}) {
    const app = getApp(appId);
    if (!app) throw new IntegrationError('Unknown app.', { code: 'not_found' });
    const provider = this.registry.providerFor(appId);
    if (!provider) throw new IntegrationError(`${app.name} isn't implemented yet — coming soon.`, { code: 'unsupported' });

    if (app.auth === 'apikey') return this.saveApiConnection(uid, appId, body);

    if (!provider.configured) {
      const envNames = {
        google: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET',
        microsoft: 'MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET',
        canva: 'CANVA_CLIENT_ID / CANVA_CLIENT_SECRET',
      }[provider.id] || 'OAuth credentials';
      throw new IntegrationError(`${app.name} isn't configured yet — add ${envNames} to .env and restart Zara.`, {
        code: 'not_configured',
      });
    }

    const verifier = makeVerifier();
    const state = signState(this.dataDir, uid);
    const user = loadUser(this.dataDir, uid);
    // keep a bounded pending map (15 min TTL, refreshed on each attempt)
    const cutoff = Date.now() - 15 * 60 * 1000;
    user.pending = Object.fromEntries(Object.entries(user.pending || {}).filter(([, v]) => (v.createdAt || 0) > cutoff));
    user.pending[state] = { app: appId, verifier, createdAt: Date.now() };
    saveUser(this.dataDir, uid, user);

    const redirectUri = this.redirectUri(appId, redirectBase);
    const authorizationUrl = provider.buildAuthUrl({
      appId, redirectUri, state, codeChallenge: challenge(verifier),
    });
    return { authorizationUrl, redirectUri, scopes: provider.scopesFor ? provider.scopesFor(appId) : [] };
  }

  async handleCallback(appId, query, redirectBase) {
    const app = getApp(appId);
    const back = (params) => `${redirectBase}/?${new URLSearchParams(params).toString()}`;
    if (!app) return back({ app: '', status: 'error', reason: 'unknown_app' });
    if (query.error) {
      const denied = /access_denied|consent/i.test(String(query.error));
      return back({ app: appId, status: denied ? 'denied' : 'error', reason: denied ? 'denied' : 'oauth_error' });
    }
    const uid = verifyState(this.dataDir, String(query.state || ''));
    if (!uid || !query.code) return back({ app: appId, status: 'error', reason: 'bad_state' });

    const user = loadUser(this.dataDir, uid);
    const pending = (user.pending || {})[String(query.state)];
    if (!pending || pending.app !== appId) return back({ app: appId, status: 'error', reason: 'bad_state' });
    delete user.pending[String(query.state)];
    saveUser(this.dataDir, uid, user);

    const provider = this.registry.providerFor(appId);
    try {
      const redirectUri = this.redirectUri(appId, redirectBase);
      const tokens = await provider.exchangeCode({
        code: String(query.code), redirectUri, codeVerifier: pending.verifier,
      });
      const prev = (user.connections && user.connections[appId]) || {};
      const account = tokens.accessToken ? (await provider.fetchAccount(tokens.accessToken)) : '';
      const scopes = tokens.scope ? String(tokens.scope).split(/\s+/) : provider.scopesFor(appId);
      const granted = provider.permissionsFromScopes(scopes);
      user.connections = user.connections || {};
      user.connections[appId] = {
        ...prev,
        account: account || prev.account || '',
        scopes,
        granted,
        accessToken: encrypt(this.dataDir, tokens.accessToken),
        // Keep a previously stored refresh token if the provider didn't rotate it.
        refreshToken: tokens.refreshToken
          ? encrypt(this.dataDir, tokens.refreshToken)
          : prev.refreshToken || null,
        tokenExpiresAt: Date.now() + Math.max(60, tokens.expiresIn) * 1000,
        status: 'connected',
        connectedAt: new Date().toISOString(),
        lastTest: null,
      };
      saveUser(this.dataDir, uid, user);
      return back({ app: appId, status: 'connected' });
    } catch (err) {
      // Technical detail stays server-side; the browser only gets a code.
      console.warn(`[integrations] ${appId} callback failed: ${String(err.message || err).slice(0, 200)}`);
      return back({ app: appId, status: 'error', reason: 'exchange_failed' });
    }
  }

  async saveApiConnection(uid, appId, body = {}) {
    const app = getApp(appId);
    const user = loadUser(this.dataDir, uid);
    const cur = user.connections[appId] || {};
    const baseUrl = String(body.baseUrl !== undefined ? body.baseUrl : cur.baseUrl || '').trim().slice(0, 500);
    const apiKey = String(body.apiKey !== undefined && String(body.apiKey).trim()
      ? body.apiKey : cur.apiKey ? decrypt(this.dataDir, cur.apiKey) : '').trim().slice(0, 500);
    if (!baseUrl || !apiKey) {
      throw new IntegrationError('An API base URL and API key are required.', { code: 'bad_args' });
    }
    if (!/^https?:\/\//i.test(baseUrl)) {
      throw new IntegrationError('API base URL must start with http:// or https://', { code: 'bad_args' });
    }
    const provider = this.registry.providerFor(appId);
    const conn = {
      ...cur, baseUrl, apiKey: encrypt(this.dataDir, apiKey),
      granted: provider.permissionsFromScopes([]),
      status: 'connected', connectedAt: new Date().toISOString(),
    };
    user.connections[appId] = conn;
    saveUser(this.dataDir, uid, user);
    const test = await this.test(uid, appId);
    return { view: this.appView(uid, appId), test };
  }

  async test(uid, appId) {
    const app = getApp(appId);
    const provider = this.registry.providerFor(appId);
    const conn = this.connFor(uid, appId);
    if (!app || !provider) throw new IntegrationError('Unknown app.', { code: 'not_found' });
    // API-key apps may be backed by the server env (LMS_API_KEY) instead of a
    // per-user connection — test with whichever credential the app uses.
    const envKey = appId === 'aculyze-lms' ? String(process.env.LMS_API_KEY || '').trim() : '';
    const envBaseUrl = appId === 'aculyze-lms'
      ? String(process.env.ACULYZE_LMS_BASE_URL || '').trim() || 'https://lm.aculyze.in/api/v1'
      : '';
    if ((!conn || conn.status === 'not_connected') && !(app.auth === 'apikey' && envKey)) {
      throw new IntegrationError(`${app.name} isn't connected yet.`, { code: 'not_connected' });
    }
    const t0 = Date.now();
    let result;
    try {
      if (app.auth === 'apikey') {
        const key = conn && conn.apiKey ? decrypt(this.dataDir, conn.apiKey) : envKey;
        const baseUrl = (conn && conn.baseUrl) || envBaseUrl;
        result = await provider.test({ ...conn, baseUrl, __key: key });
      } else {
        const token = await this.getToken(uid, appId);
        result = await provider.test({ ...conn, __token: token });
      }
      if (result && result.ms === undefined) result.ms = Date.now() - t0;
    } catch (err) {
      result = { ok: false, ms: Date.now() - t0, error: friendlyOf(err) };
    }
    const user = loadUser(this.dataDir, uid);
    if (user.connections[appId]) {
      user.connections[appId].lastTest = {
        ok: !!result.ok, ms: result.ms || Date.now() - t0,
        detail: result.detail || result.error || '', at: new Date().toISOString(),
        // Machine-readable outcome for the UI status (Connected / Invalid API
        // key / Permission denied / Server unavailable / Rate limited …).
        status: result.status !== undefined ? result.status : 0,
        category: result.category || (result.ok ? 'connected' : ''),
      };
      saveUser(this.dataDir, uid, user);
      return user.connections[appId].lastTest;
    }
    // Env-backed connection — no per-user record to persist to.
    return {
      ok: !!result.ok, ms: result.ms || Date.now() - t0,
      detail: result.detail || result.error || '', at: new Date().toISOString(),
      status: result.status !== undefined ? result.status : 0,
      category: result.category || (result.ok ? 'connected' : ''),
    };
  }

  async disconnect(uid, appId) {
    const user = loadUser(this.dataDir, uid);
    if (user.connections && user.connections[appId]) {
      // Best-effort remote revoke for OAuth providers (ignore failures).
      const conn = user.connections[appId];
      const provider = this.registry.providerFor(appId);
      const app = getApp(appId);
      if (provider && app && app.auth === 'oauth' && provider.revoke && conn.accessToken) {
        try { await provider.revoke(decrypt(this.dataDir, conn.accessToken)); } catch { /* best effort */ }
      }
      delete user.connections[appId];
      saveUser(this.dataDir, uid, user);
    }
    return { status: 'not_connected' };
  }

  // ==================== tokens ====================

  async getToken(uid, appId) {
    const conn = this.connFor(uid, appId);
    const provider = this.registry.providerFor(appId);
    if (!conn || conn.status === 'not_connected') {
      throw new IntegrationError(`${getApp(appId).name} isn't connected.`, { code: 'not_connected' });
    }
    if (conn.status === 'reauth') {
      throw new IntegrationError(`${getApp(appId).name} needs to be reconnected.`, { code: 'reauth' });
    }
    const access = decrypt(this.dataDir, conn.accessToken);
    if (!access) throw new IntegrationError(`${getApp(appId).name} needs to be reconnected.`, { code: 'reauth' });

    const expiring = conn.tokenExpiresAt && conn.tokenExpiresAt - Date.now() < 90 * 1000;
    if (expiring && conn.refreshToken) {
      const key = `${uid}:${appId}`;
      if (!this._refreshing.has(key)) {
        this._refreshing.set(key, this.doRefresh(uid, appId, provider).finally(() => this._refreshing.delete(key)));
      }
      await this._refreshing.get(key);
      const fresh = this.connFor(uid, appId);
      if (!fresh || fresh.status !== 'connected') {
        throw new IntegrationError(`${getApp(appId).name} needs to be reconnected.`, { code: 'reauth' });
      }
      return decrypt(this.dataDir, fresh.accessToken);
    }
    return access;
  }

  async doRefresh(uid, appId, provider) {
    const conn = this.connFor(uid, appId);
    const rt = decrypt(this.dataDir, conn.refreshToken);
    if (!rt) return;
    try {
      const tokens = await provider.refreshToken(rt);
      const user = loadUser(this.dataDir, uid);
      const c = user.connections[appId];
      if (!c) return;
      c.accessToken = encrypt(this.dataDir, tokens.accessToken);
      if (tokens.refreshToken) c.refreshToken = encrypt(this.dataDir, tokens.refreshToken);
      c.tokenExpiresAt = Date.now() + Math.max(60, tokens.expiresIn) * 1000;
      c.status = 'connected';
      saveUser(this.dataDir, uid, user);
    } catch (err) {
      console.warn(`[integrations] token refresh failed for ${appId}: ${String(err.message || err).slice(0, 160)}`);
      const user = loadUser(this.dataDir, uid);
      if (user.connections[appId]) {
        user.connections[appId].status = 'reauth';
        saveUser(this.dataDir, uid, user);
      }
    }
  }

  // ==================== tool execution ====================

  /** Env-key fallback for apikey apps (Aculyze LMS): the app shows as
   *  "connected" via LMS_API_KEY without a stored per-user connection — so
   *  tool execution must accept it too, granting the catalog permissions. */
  _envConnFor(uid, appId) {
    const envKey = appId === 'aculyze-lms' ? String(process.env.LMS_API_KEY || '').trim() : '';
    if (!envKey) return null;
    const appDef = getApp(appId);
    if (!appDef || appDef.auth !== 'apikey') return null;
    return {
      status: 'connected',
      granted: (appDef.permissions || []).map((p) => p.id),
      apiKey: '', // secret comes from env, below
      baseUrl: String(process.env.ACULYZE_LMS_BASE_URL || '').trim() || 'https://lm.aculyze.in/api/v1',
      __envKey: envKey,
    };
  }

  async runTool(uid, toolId, args) {
    const def = getTool(toolId);
    if (!def) throw new IntegrationError(`Unknown tool "${toolId}".`, { code: 'unsupported' });
    const appDef = getApp(def.app);
    const provider = this.registry.providerFor(def.app);
    let conn = this.connFor(uid, def.app);
    if (!conn || conn.status === 'not_connected') {
      conn = this._envConnFor(uid, def.app);
      if (!conn) {
        throw new IntegrationError(`${appDef.name} isn't connected.`, { code: 'not_connected' });
      }
    }
    const granted = new Set(conn.granted || []);
    for (const p of def.requires) {
      if (!granted.has(p)) {
        throw new IntegrationError(`${appDef.name} isn't authorized for that — reconnect it from Settings → Apps.`, {
          code: 'forbidden',
        });
      }
    }
    let secret = '';
    if (appDef.auth === 'apikey') {
      secret = conn.__envKey || (conn.apiKey ? decrypt(this.dataDir, conn.apiKey) : '');
      if (!secret) throw new IntegrationError('Your Aculyze LMS API key is missing — reconnect it in Settings → Apps.', { code: 'reauth' });
    } else {
      secret = await this.getToken(uid, def.app);
    }
    const connView = { ...conn, __token: secret, __key: secret };
    let timer;
    try {
      const call = provider.call(toolId, connView, args || {}, secret);
      const timeout = new Promise((_, rej) => {
        timer = setTimeout(() => rej(new IntegrationError(`${appDef.name} took too long to answer — try again.`, { code: 'timeout' })), TOOL_TIMEOUT_MS);
      });
      return await Promise.race([call, timeout]);
    } catch (err) {
      if (err.code === 'reauth' || err.status === 401) {
        const user = loadUser(this.dataDir, uid);
        if (user.connections[def.app]) {
          user.connections[def.app].status = 'reauth';
          saveUser(this.dataDir, uid, user);
        }
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // ==================== chat bridge (§10–§12) ====================

  /**
   * Message → plan → execute reads (or request confirmation for writes).
   * Returns { steps, context, sources, notice? , confirm? }.
   */
  async resolve(uid, message) {
    const views = this.listApps(uid);
    const connected = {};
    for (const v of views) if (v.status === 'connected') connected[v.id] = v;
    if (!Object.keys(connected).length) return { steps: [], context: null, sources: [] };

    const planned = plan(String(message || ''), connected);
    if (planned.notice) return { steps: [], context: null, sources: [], notice: planned.notice };

    if (planned.write) {
      // Mail writes: let the brain draft subject/body instead of the regex
      // fallback (which stuffs the raw message into the body). Shown in the
      // confirm modal — user still approves and can edit (§12).
      if (/\.send_message$|\.send_mail$|\.create_draft$/.test(planned.write.tool)) {
        planned.write = {
          ...planned.write,
          args: { ...planned.write.args, ...(await draftMail(String(message || ''), planned.write.args)) },
        };
      }
      return this.buildConfirmation(uid, planned.write);
    }

    if (!planned.reads.length) {
      // ---- Tier 2: LLM tool-calling for phrasing the regex gate missed ----
      const t2 = await this._resolveTier2(uid, message);
      if (t2) return t2;
      return { steps: [], context: null, sources: [] };
    }

    const steps = [];
    const sources = [];
    const sections = [];
    const done = new Map();

    for (const read of planned.reads) {
      const def = getTool(read.tool);
      const appDef = getApp(def.app);
      let args = { ...(read.args || {}) };
      if (read.after) {
        const prev = done.get(read.after);
        const first = prev && prev.raw && prev.raw[0];
        if (!first || !first.id) continue; // nothing found upstream → skip quietly
        args = { ...args, id: first.id };
        delete args.q;
        delete args.after;
      }
      try {
        const res = await this.runTool(uid, read.tool, args);
        done.set(read.tool, res);
        const count = typeof res.count === 'number' ? res.count : 0;
        steps.push({
          id: `${def.app}:${read.tool}`,
          text: `${appDef.icon} ${appDef.name} — ${count ? `✓ Found ${count} ${def.done}` : `✓ No ${def.done} matched`}`,
          ok: true,
        });
        if (res.text && String(res.text).trim()) {
          sections.push(`## ${appDef.name}\n${String(res.text).slice(0, APP_CAP)}`);
        }
        if (res.items && res.items.length) {
          sources.push({
            app: appDef.name, icon: appDef.icon, count: count || res.items.length,
            unit: def.unit, items: res.items.slice(0, 5),
          });
        }
      } catch (err) {
        steps.push({ id: `${def.app}:${read.tool}:err`, text: `${appDef.icon} ${appDef.name} — ${friendlyOf(err)}`, ok: false });
      }
    }

    if (!sections.length) {
      const failedAll = steps.length > 0 && steps.every((s) => !s.ok);
      return { steps, context: null, sources: [], notice: failedAll ? null : undefined };
    }
    return {
      steps,
      context: buildAppsContext(sections, String(message || '')),
      sources: dedupeSources(sources),
      usedApps: [...new Set(sections.map((s) => s.split('\n')[0].replace('## ', '')))],
    };
  }

  /**
   * Tier 2 — when the regex gate (Tier 1) finds nothing, let the brain pick
   * tools itself via native function-calling. Returns null when Tier 2 can't
   * help (no provider / no connected tools / model failed) so resolve() can
   * fall back to the empty Tier-1 shape. Lazy-requires the agent to avoid a
   * circular module dependency (toolAgent → manager → toolAgent).
   */
  async _resolveTier2(uid, message) {
    if (!this.provider) return null;
    try {
      const toolAgent = require('../agent/toolAgent');
      const res = await toolAgent.run({
        provider: this.provider,
        manager: this,
        uid,
        message: String(message || ''),
      });
      if (!res || res.used === false) return null;
      // normalize to resolve()'s contract (notice/confirm short-circuit)
      return {
        steps: res.steps || [],
        context: res.context || null,
        sources: res.sources || [],
        notice: res.notice,
        confirm: res.confirm,
        tier: 2,
      };
    } catch (err) {
      console.warn('[integrations] Tier 2 failed:', String(err && err.message || err).slice(0, 300));
      return null;
    }
  }

  /** Prepare a write's confirmation (with previews / resolved targets). */
  async buildConfirmation(uid, { tool, args }) {
    const def = getTool(tool);
    const appDef = getApp(def.app);
    const provider = this.registry.providerFor(def.app);
    const conn = this.connFor(uid, def.app);
    if (!conn || conn.status === 'not_connected') {
      return { notice: `${appDef.name} isn't connected.`, steps: [], context: null, sources: [] };
    }
    const granted = new Set(conn.granted || []);
    for (const p of def.requires) {
      if (!granted.has(p)) {
        return { notice: `${appDef.name} isn't authorized for that — reconnect it from Settings → Apps.`, steps: [], context: null, sources: [] };
      }
    }
    try {
      let secret = '';
      if (appDef.auth === 'apikey') throw new IntegrationError('This action isn’t supported for API-key connections.', { code: 'unsupported' });
      secret = await this.getToken(uid, def.app);
      const prep = await provider.prepareWrite(tool, { ...conn, __token: secret }, args || {});
      const titles = {
        'gmail.send_message': 'Send this email?', 'outlook.send_mail': 'Send this email?',
        'gmail.create_draft': 'Create this draft?', 'outlook.create_draft': 'Create this draft?',
        'teams.send_message': 'Send this Teams message?',
        'calendar.create_event': 'Create this event?', 'mscalendar.create_event': 'Create this event?',
        'calendar.update_event': 'Update this event?', 'mscalendar.update_event': 'Update this event?',
      };
      return {
        confirm: {
          tool, app: def.app, appName: appDef.name, icon: appDef.icon,
          title: titles[tool] || `Run this action with ${appDef.name}?`,
          detail: `${appDef.icon} Zara will use ${appDef.name} — nothing happens until you confirm.`,
          verb: def.verb || 'Confirm',
          preview: prep.preview || [],
          args: prep.args,
        },
        steps: [], context: null, sources: [],
      };
    } catch (err) {
      return { notice: friendlyOf(err), steps: [], context: null, sources: [] };
    }
  }

  /** Execute a tool from the UI. Writes require { confirm: true }. */
  async execute(uid, { tool, args, confirm }) {
    const def = getTool(tool);
    if (!def) throw new IntegrationError('Unknown tool.', { code: 'unsupported' });
    const appDef = getApp(def.app);
    if (def.kind === 'write' && !confirm) {
      const conf = await this.buildConfirmation(uid, { tool, args });
      if (conf.confirm) return { confirm: conf.confirm };
      throw new IntegrationError(conf.notice || 'This action cannot be confirmed.', { code: 'failed' });
    }
    const res = await this.runTool(uid, tool, args || {});
    const summary = res.summary || `${def.done}`;
    return {
      ok: true,
      summary,
      step: { id: `action:${tool}`, text: `${appDef.icon} ${appDef.name} — ✓ ${def.done}`, ok: true },
      context: [
        'The assistant just completed an action in a connected app.',
        'Confirm it to the user briefly and naturally — do not invent extra details.',
        `Action performed: ${summary}`,
      ].join('\n'),
      sources: [{
        app: appDef.name, icon: appDef.icon, count: 1, unit: 'action',
        items: [{ title: summary, meta: 'completed just now' }],
      }],
    };
  }

  featuredIds() { return FEATURED.slice(); }
}

// ---------------- helpers ----------------

function friendlyOf(err) {
  if (err instanceof IntegrationError || (err && err.message && err.code)) return String(err.message);
  return 'Something went wrong talking to that app.';
}

function dedupeSources(sources) {
  const seen = new Map();
  for (const s of sources) {
    const key = `${s.app}:${s.unit}`;
    if (seen.has(key)) {
      const prev = seen.get(key);
      prev.count += s.count;
      prev.items = [...prev.items, ...s.items].slice(0, 5);
    } else seen.set(key, { ...s });
  }
  return [...seen.values()];
}

/** Normalized data → system context with the same never-print rules as web/erp. */
function buildAppsContext(sections, question) {
  const parts = [
    'DATA retrieved live from the user’s connected apps is provided below between <apps> tags.',
    'Rules: (1) Answer using the REAL values from this data — exact names, amounts, dates, statuses.',
    '(2) When the user asks to SEE, LIST, FIND or COUNT records, reply with the actual records from the data'
    + ' as concise lines (e.g. "1. Name: Acme — city: Pune — industry: Steel"). Do NOT describe what the app can do instead of showing data.',
    '(3) Do not print the <apps> tags, the === markers, or long raw JSON — quote the values cleanly in your own words.',
    '(4) Mention which app a fact came from when useful (e.g. "in Gmail", "on your calendar", "from your LMS").',
    '(5) If the data does not contain the answer, say plainly what is missing — never invent records, names, numbers or features.\n',
    '<apps>',
    sections.join('\n\n===\n\n'),
    '</apps>',
  ];
  if (question) parts.push('', `Question: ${question}`, 'Answer:');
  return parts.join('\n').slice(0, CONTEXT_CAP);
}

module.exports = { IntegrationManager, buildAppsContext };
