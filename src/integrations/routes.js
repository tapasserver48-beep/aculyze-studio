/**
 * /api/integrations — the backend surface for Apps & Integrations (§24,
 * adapted to this codebase's single-router Express style).
 *
 *   GET    /api/integrations                 → catalog + per-user status
 *   POST   /api/integrations/resolve        → NL plan → read tools (chat bridge)
 *   POST   /api/integrations/tools/execute  → run one tool (writes need confirm)
 *   GET    /api/integrations/:app           → connection detail
 *   GET    /api/integrations/:app/permissions
 *   POST   /api/integrations/:app/connect   → OAuth URL / API-key save+test
 *   GET    /api/integrations/:app/callback  → OAuth callback (server-side)
 *   POST   /api/integrations/:app/test
 *   POST   /api/integrations/:app/disconnect
 *
 * Tokens/keys never appear in any response; errors are friendly with the
 * technical detail logged server-side only.
 */
const express = require('express');
const path = require('path');
const { ensureUid } = require('./store');
const { IntegrationManager } = require('./manager');
const { getApp, CATEGORIES, FEATURED } = require('./catalog');
const { IntegrationError } = require('./providers/base');

function statusFor(err) {
  switch (err && err.code) {
    case 'not_found': return 404;
    case 'bad_args': return 400;
    case 'forbidden': return 403;
    case 'not_configured': return 503;
    case 'unsupported': return 501;
    case 'rate_limited': return 429;
    case 'not_connected':
    case 'reauth': return 409;
    default: return 502;
  }
}

function redirectBase(req) {
  const envBase = String(process.env.INTEGRATIONS_REDIRECT_BASE || '').trim().replace(/\/$/, '');
  if (envBase) return envBase;
  return `${req.protocol}://${req.get('host')}`;
}

function createIntegrationsRouter(options = {}) {
  const router = express.Router();
  const dataDir = options.dataDir || path.join(__dirname, '..', '..', 'data');
  // provider = AI brain for Tier 2 (LLM tool-calling); optional.
  const manager = new IntegrationManager({
    dataDir,
    env: options.env || process.env,
    provider: options.provider || null,
  });

  // Every request is bound to this browser's (future: this login's) user id.
  router.use((req, res, next) => {
    req.zaraUid = ensureUid(req, res);
    next();
  });

  const wrap = (handler) => (req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      const code = (err && err.code) || 'failed';
      const message = err instanceof IntegrationError || (err && err.message)
        ? String(err.message).slice(0, 300)
        : 'Something went wrong.';
      if (!(err instanceof IntegrationError)) {
        console.warn(`[integrations] ${req.method} ${req.originalUrl}: ${String(err && err.message || err).slice(0, 200)}`);
      }
      res.status(statusFor({ code })).json({ error: message, code });
    });
  };

  // ---------- catalog ----------
  router.get('/', wrap(async (req, res) => {
    res.json({
      categories: CATEGORIES,
      featured: FEATURED,
      apps: manager.listApps(req.zaraUid),
    });
  }));

  // ---------- chat bridge ----------
  router.post('/resolve', wrap(async (req, res) => {
    const message = String(req.body?.message || '').slice(0, 4000).trim();
    if (!message) return res.status(400).json({ error: '"message" is required.', code: 'bad_args' });
    res.json(await manager.resolve(req.zaraUid, message));
  }));

  router.post('/tools/execute', wrap(async (req, res) => {
    const tool = String(req.body?.tool || '').trim();
    if (!tool) return res.status(400).json({ error: '"tool" is required.', code: 'bad_args' });
    const args = (req.body?.args && typeof req.body.args === 'object') ? req.body.args : {};
    const confirm = req.body?.confirm === true;
    res.json(await manager.execute(req.zaraUid, { tool, args, confirm }));
  }));

  // ---------- per-app lifecycle ----------
  router.get('/:app/permissions', wrap(async (req, res) => {
    const appId = req.params.app;
    if (!getApp(appId)) return res.status(404).json({ error: 'Unknown app.', code: 'not_found' });
    res.json(manager.permissionsView(req.zaraUid, appId));
  }));

  router.get('/:app', wrap(async (req, res) => {
    const appId = req.params.app;
    const view = manager.appView(req.zaraUid, appId);
    if (!view) return res.status(404).json({ error: 'Unknown app.', code: 'not_found' });
    res.json({ ...view, permissionInfo: manager.permissionsView(req.zaraUid, appId) });
  }));

  router.post('/:app/connect', wrap(async (req, res) => {
    const appId = req.params.app;
    if (!getApp(appId)) return res.status(404).json({ error: 'Unknown app.', code: 'not_found' });
    const result = await manager.startConnect(req.zaraUid, appId, {
      redirectBase: redirectBase(req),
      body: req.body || {},
    });
    res.json(result);
  }));

  router.get('/:app/callback', wrap(async (req, res) => {
    const appId = req.params.app;
    if (!getApp(appId)) return res.status(404).json({ error: 'Unknown app.', code: 'not_found' });
    const location = await manager.handleCallback(appId, req.query, redirectBase(req));
    res.redirect(302, location);
  }));

  router.post('/:app/test', wrap(async (req, res) => {
    const appId = req.params.app;
    if (!getApp(appId)) return res.status(404).json({ error: 'Unknown app.', code: 'not_found' });
    const test = await manager.test(req.zaraUid, appId);
    res.json({ test, app: manager.appView(req.zaraUid, appId) });
  }));

  router.post('/:app/disconnect', wrap(async (req, res) => {
    const appId = req.params.app;
    if (!getApp(appId)) return res.status(404).json({ error: 'Unknown app.', code: 'not_found' });
    res.json(await manager.disconnect(req.zaraUid, appId));
  }));

  return router;
}

module.exports = { createIntegrationsRouter };
