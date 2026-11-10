/**
 * /api/computer — the Zara Desktop Agent surface (Phase 1, in-process).
 *
 * Security model:
 *   • binds whatever the Zara server binds, but every call needs the
 *     per-install Bearer token (agentService), except /session which is
 *     guarded by a same-Origin check and exists only to hand the token to
 *     this app's own web UI;
 *   • the client NEVER sends tool calls — only the raw chat message; the
 *     server re-plans it deterministically and runs only whitelisted,
 *     explicitly-implemented operations (no shell.execute exists at all);
 *   • app names travel as validated spawn arguments / script parameters,
 *     never as code.
 */

const express = require('express');
const { plan } = require('./computerRouter');
const { createResolver } = require('./resolver');
const { getAgentToken, verifyToken, logOperation } = require('./agentService');
const { ALLOWED_TOOLS } = require('./permissions');

async function runAction(resolver, a) {
  try {
    if (toolIs(a, 'desktop.show')) {
      const r = await resolver.showDesktop();
      return { ok: !!r.done, error: r.error };
    }
    if (toolIs(a, 'screen.capture')) {
      const r = await resolver.captureScreen();
      return { ok: !!r.ok, path: r.path, error: r.error };
    }
    if (toolIs(a, 'app.list')) {
      return listAnswer(resolver, a.args || {});
    }

    const entry = await resolver.resolveApp((a.args && a.args.app) || '');
    if (!entry) return { missing: true };
    const name = entry.name;

    if (toolIs(a, 'app.open')) {
      const r = await resolver.launch(entry);
      return { ok: !!r.launched, name, error: r.error };
    }
    if (toolIs(a, 'app.close')) {
      const r = await resolver.close(entry);
      return { closed: !!r.closed, wasRunning: r.wasRunning, note: r.note, name, error: r.error };
    }
    if (toolIs(a, 'app.focus')) {
      const r = await resolver.windowOp(entry, 'focus');
      return { found: !!r.found, ok: !!r.found, name, error: r.error };
    }
    // window.minimize / window.maximize / window.restore
    const op = String(a.tool).split('.')[1];
    const r = await resolver.windowOp(entry, op);
    return { found: !!r.found, name, error: r.error };
  } catch (err) {
    return { error: String(err.message || err).slice(0, 200) };
  }
}

function toolIs(a, tool) { return a.tool === tool; }

/** Deterministic answers for app questions — nothing reaches the model. */
async function listAnswer(resolver, args) {
  if (args.kind === 'browsers') {
    const b = await resolver.installedBrowsers();
    return {
      direct: b.length
        ? `Installed browsers: ${b.join(', ')}.`
        : "You don't have Chrome, Edge, Firefox, Brave or Opera installed on this computer.",
      found: b.length > 0,
    };
  }
  if (args.kind === 'check' && args.app) {
    const entry = await resolver.resolveApp(args.app);
    return entry
      ? { direct: `Yes — ${entry.name} is installed on this computer.`, found: true, name: entry.name }
      : { direct: `No — I couldn't find ${args.app} on this computer.`, missing: true };
  }
  const apps = await resolver.listApps();
  const names = apps.map((e) => e.name);
  const shown = names.slice(0, 40);
  const more = names.length - shown.length;
  return {
    direct: names.length
      ? `You have ${names.length} apps installed, including: ${shown.join(', ')}${more > 0 ? `, and ${more} more.` : '.'}`
      : "I couldn't read your installed-apps list on this computer.",
    found: names.length > 0,
  };
}

function createComputerRouter({ dataDir }) {
  const router = express.Router();
  const resolver = createResolver({ dataDir });
  const token = getAgentToken(dataDir);

  // --- auth: every route except /session needs the Bearer token ------------
  router.use((req, res, next) => {
    if (req.path === '/session') return next();
    const h = String(req.headers.authorization || '');
    const presented = h.startsWith('Bearer ') ? h.slice(7) : String(req.headers['x-zara-computer-token'] || '');
    if (!verifyToken(presented, token)) {
      return res.status(401).json({
        error: 'Unauthorized — the local computer-agent token is required.',
        code: 'unauthorized',
      });
    }
    next();
  });

  // --- bootstrap for the Zara web UI (same-Origin only) --------------------
  router.get('/session', (req, res) => {
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return res.status(403).json({ error: 'Forbidden', code: 'bad-origin' });
    }
    res.json({ token, platform: resolver.platform });
  });

  // --- plan-only (never executes anything) ---------------------------------
  router.post('/resolve', (req, res) => {
    const p = plan(req.body && req.body.message);
    res.json({
      actions: (p.actions || [])
        .filter((a) => ALLOWED_TOOLS.has(a.tool))
        .map((a) => ({ id: a.id, tool: a.tool, label: a.label, progress: a.progress })),
      notice: p.notice,
    });
  });

  // --- execute: server re-plans from the message; whitelisted ops only -----
  router.post('/execute', async (req, res) => {
    const message = String((req.body && req.body.message) || '').slice(0, 400);
    const p = plan(message);
    const actions = (p.actions || []).filter((a) => ALLOWED_TOOLS.has(a.tool));

    const steps = [];
    const contextParts = [];
    let direct = null;

    for (const a of actions) {
      const r = await runAction(resolver, a);
      const ok = !!(r.ok || r.found || r.closed || r.wasRunning === false || r.direct);
      steps.push({ id: a.id, text: a.done(r), ok });
      const c = a.context(r);
      if (c) contextParts.push(`  ${steps.length}. ${c}`);
      if (r.direct) direct = r.direct;

      logOperation(dataDir, {
        op: a.tool,
        application: (r && r.name) || (a.args && a.args.app) || '-',
        platform: resolver.platform,
        result: r.missing ? 'not-found' : ok ? 'success' : (r.error ? 'failed' : 'done'),
        ...(r && r.error ? { detail: String(r.error).slice(0, 120) } : {}),
      });
    }

    let context = null;
    if (direct) {
      context = `ANSWER (use it exactly, do not invent anything): ${direct}`;
    } else if (contextParts.length) {
      context = "A LOCAL COMPUTER-CONTROL TOOL just ran these actions on the user's own computer:\n"
        + contextParts.join('\n')
        + '\nRules: (1) Reply with a SHORT confirmation in the user\'s own phrasing, e.g. "Done — Visual Studio Code is open."'
        + '\n(2) NEVER claim actions that are not listed above; never invent app names or results.'
        + '\n(3) If the app was not found, say briefly "I couldn\'t find <app> on this computer."';
    }

    res.json({ steps, context, direct: direct ? { text: direct } : null, notice: p.notice || null });
  });

  // --- status ---------------------------------------------------------------
  router.get('/status', (req, res) => {
    res.json({
      service: true,
      agent: 'ready',
      platform: resolver.platform,
      supported: resolver.supported,
    });
  });

  return router;
}

module.exports = { createComputerRouter };
