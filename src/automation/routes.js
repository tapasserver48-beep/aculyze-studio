/**
 * /api/browser — Zara's browser-automation tool endpoints.
 *
 *  POST /resolve  { message }      → plan only (never executes, never spawns
 *                                    Python — pure local heuristic, ~0 cost).
 *  POST /execute  { message, confirm } → server re-plans from the SAME message
 *                                    and executes the whitelisted actions.
 *                                    Sensitive plans are refused without
 *                                    confirm:true (user clicked the modal).
 *  GET  /status                    → { service, browser, url, title, port }.
 *
 * Security: the client can never send arbitrary actions — actions are always
 * derived server-side from the user's message via the deterministic router,
 * and the Python service only accepts the fixed whitelist (open, navigate,
 * search, type, click, press, back, read, close, status).
 */

const express = require('express');
const { plan } = require('./browserRouter');
const svc = require('./browserService');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function buildContext(steps, ctxParts, failed, failedError) {
  const ok = steps.filter((s) => s.ok);
  if (failed && !ok.length) {
    return 'A LOCAL BROWSER ACTION FAILED. Tell the user honestly and briefly what did not work '
      + '(e.g. "I couldn\'t open Chrome — the browser automation service may not be running"). '
      + 'Do NOT claim any browsing happened.';
  }
  const lines = [
    'A LOCAL BROWSER TOOL just ran these actions on the user\'s own computer:',
    ...ok.map((s, i) => `  ${i + 1}. ${s.text.replace(/^[✓●]\s*/, '')}`),
  ];
  if (failed) lines.push(`  ⚠ The next action failed: ${failedError || 'unknown error'} — mention it if relevant.`);
  lines.push(
    'Rules: (1) Reply with a SHORT confirmation in the user\'s own phrasing, e.g. '
    + '"Done — I searched Google for ind vs wi." or "Done — I opened aculyze.in."',
    '(2) NEVER claim actions that are not listed above; never invent page content.',
    '(3) If page text is included below, answer the user\'s question from it — never dump the raw text.',
  );
  const body = ctxParts.join('\n\n').slice(0, 6000);
  if (body) lines.push('', '<browser>', body, '</browser>');
  return lines.join('\n');
}

function createBrowserRouter() {
  const router = express.Router();

  // Planning only — safe to call for every chat message (no Python, no side effects).
  router.post('/resolve', (req, res) => {
    const p = plan(req.body?.message);
    res.json({
      actions: p.actions.map((a) => ({ id: a.id, tool: a.tool, label: a.label, progress: a.progress })),
      sensitive: p.sensitive,
      notice: p.notice,
    });
  });

  // Execute the plan derived from the message (server-side, whitelist-only).
  router.post('/execute', wrap(async (req, res) => {
    const p = plan(req.body?.message);
    const confirm = !!req.body?.confirm;

    if (!p.actions.length) {
      return res.json({ steps: [], context: null, notice: p.notice });
    }
    if (p.sensitive && !confirm) {
      return res.json({
        confirm: {
          title: p.sensitive.title,
          detail: p.sensitive.detail,
          preview: p.sensitive.preview,
          verb: p.sensitive.verb,
          actions: p.actions.map((a) => a.label),
        },
        steps: [],
        context: null,
      });
    }

    const steps = [];
    const ctxParts = [];
    let failed = false;
    let failedError = null;

    for (const a of p.actions) {
      let r;
      try {
        r = await svc.call(a.tool, a.args);
      } catch (err) {
        r = { ok: false, error: err.message, code: err.code };
      }
      if (!r || !r.ok) {
        const msg = (r && r.error) || 'The action failed.';
        steps.push({ id: a.id, text: `${a.progress} — ${msg}`, ok: false });
        failed = true;
        failedError = msg;
        break; // stop the chain: don't search after a failed open, etc.
      }
      steps.push({ id: a.id, text: a.done(r), ok: true });
      if (a.context) ctxParts.push(a.context(r));
    }

    res.json({
      steps,
      context: buildContext(steps, ctxParts, failed, failedError),
      notice: p.notice,
      ranActions: steps.filter((s) => s.ok).length,
    });
  }));

  router.get('/status', wrap(async (req, res) => {
    const hs = await svc.status();
    res.json({
      service: !!(hs && hs.ok),
      browser: (hs && hs.browser) || 'unknown',
      port: svc.PORT,
      url: (hs && hs.url) || null,
      title: (hs && hs.title) || null,
      profile: (hs && hs.profile) || null,
      profileFallback: (hs && hs.profile_fallback) || null,
    });
  }));

  return router;
}

module.exports = { createBrowserRouter };
