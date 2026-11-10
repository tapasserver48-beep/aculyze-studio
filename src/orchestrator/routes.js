/**
 * /api/orchestrator — the Zara Orchestrator surface.
 *
 *   POST /classify { message } → { intent, workflow, query, reason } (plan only)
 *   POST /run      { message } → runs the right capability for the message:
 *                                 • youtube  → the visual/YouTube workflow
 *                                 • computer → existing /api/computer logic
 *                                 • browser  → existing /api/browser logic
 *                                 • conversation → { intent:'conversation' } (no tool)
 *
 * This does NOT replace the existing browser/computer routers — it composes
 * them. The frontend still calls /api/browser and /api/computer directly for
 * their own flows; the orchestrator is the central entry that decides which
 * capability (if any) owns a request, and hosts the new YouTube workflow.
 *
 * Security: the client sends only the raw message. Actions are derived
 * server-side from fixed, whitelisted sequences. No shell, no arbitrary code.
 */

const express = require('express');
const net = require('net');
const { plan } = require('./intentRouter');
const youtubeWorkflow = require('./youtubeWorkflow');
const browserRouter = require('../automation/browserRouter');
const computerRouter = require('../computer/computerRouter');
const svc = require('../automation/browserService');
const { runResearch } = require('./research');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function safeResearchUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const privateV6 = net.isIP(host) === 6 && /^(?:::1|fc|fd|fe80:|::ffff:)/i.test(host);
    if (/(^|\.)(localhost|local|internal|test)$/.test(host) || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || privateV6) return undefined;
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:api.?key|access.?token|auth|credential|password|secret|session|signature|^key$|^token$)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    return url.href;
  } catch { return undefined; }
}

function sanitizeResearchPayload(value, key = '') {
  if (/(?:fetchedText|authorization|cookie|api.?key|access.?token|password|secret)/i.test(key)) return undefined;
  if (Array.isArray(value)) return value.map((item) => sanitizeResearchPayload(item)).filter((item) => item !== undefined);
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && (key === 'url' || key === 'source')) return safeResearchUrl(value);
    if (typeof value === 'string' && key === 'error') return value.replace(/((?:api.?key|access.?token|auth|password|secret|token|key)=)[^&\s]+/gi, '$1[redacted]').slice(0, 240);
    return value;
  }
  const output = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const safe = sanitizeResearchPayload(childValue, childKey);
    if (safe !== undefined) output[childKey] = safe;
  }
  return output;
}

// The research pipeline reaches the web ONLY through this existing search
// provider. It is injected here (not hard-coded inside the engine) so the
// engine stays provider-independent and testable. `searchProviderInstance` is
// set by the server at mount time via createOrchestratorRouter({ searchProvider }).
let researchSearchProvider = null;
let researchLLM = null;

/** Run the existing browser plan (same logic as /api/browser/execute). */
async function runBrowserPlan(p, { signal } = {}) {
  const steps = [];
  const ctxParts = [];
  let failed = false;
  let failedError = null;
  for (const a of p.actions) {
    if (signal?.aborted) throw Object.assign(new Error('Browser action cancelled.'), { name: 'AbortError' });
    let r;
    try { r = await svc.call(a.tool, a.args, 45000, { signal }); } catch (err) { if (signal?.aborted || err.name === 'AbortError') throw err; r = { ok: false, error: err.message }; }
    if (!r || !r.ok) {
      const msg = (r && r.error) || 'The action failed.';
      steps.push({ id: a.id, text: `${a.progress} — ${msg}`, ok: false });
      failed = true; failedError = msg; break;
    }
    steps.push({ id: a.id, text: a.done(r), ok: true });
    if (a.context) ctxParts.push(a.context(r));
  }
  const okLines = steps.filter((s) => s.ok);
  const context = failed && !okLines.length
    ? 'A LOCAL BROWSER ACTION FAILED. Tell the user honestly and briefly what did not work. Do NOT claim any browsing happened.'
    : 'A LOCAL BROWSER TOOL just ran these actions on the user\'s own computer:\n'
      + okLines.map((s, i) => `  ${i + 1}. ${s.text.replace(/^[✓●]\s*/, '')}`).join('\n')
      + (failed ? `\n  ⚠ The next action failed: ${failedError}` : '')
      + '\nReply with a SHORT confirmation in the user\'s own phrasing. Never invent page content.';
  return { steps, context, ok: !failed && okLines.length > 0 };
}

function createOrchestratorRouter({ searchProvider = null, llm = null } = {}) {
  if (searchProvider) researchSearchProvider = searchProvider;
  if (llm) researchLLM = llm;
  const router = express.Router();

  // Plan only — safe, no side effects.
  router.post('/classify', (req, res) => {
    const p = plan(req.body?.message);
    res.json({
      intent: p.intent,
      workflow: p.workflow,
      query: p.query,
      reason: p.reason,
      browserActions: (p.browser?.actions || []).map((a) => ({ id: a.id, tool: a.tool, label: a.label })),
      computerActions: (p.computer?.actions || []).map((a) => ({ id: a.id, tool: a.tool, label: a.label })),
      sensitive: p.browser?.sensitive || null,
      notice: p.browser?.notice || p.computer?.notice || null,
    });
  });

  // Execute the capability that owns the message.
  router.post('/run', wrap(async (req, res) => {
    const message = String(req.body?.message || '').slice(0, 400);
    const p = plan(message);
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });

    if (p.intent === 'youtube') {
      const r = await youtubeWorkflow.run(message, { workflow: p.workflow, query: p.query });
      return res.json({ intent: 'youtube', workflow: p.workflow, query: p.query, ...r });
    }

    if (p.intent === 'browser') {
      if (!p.browser.actions.length) {
        return res.json({ intent: 'browser', steps: [], context: null, notice: p.browser.notice });
      }
      if (p.browser.sensitive) {
        return res.json({
          intent: 'browser',
          confirm: {
            title: p.browser.sensitive.title, detail: p.browser.sensitive.detail,
            preview: p.browser.sensitive.preview, verb: p.browser.sensitive.verb,
          },
          steps: [], context: null,
        });
      }
      const r = await runBrowserPlan(p.browser, { signal: abort.signal });
      return res.json({ intent: 'browser', ...r });
    }

    if (p.intent === 'computer') {
      // Delegate to the same plan the computer router produced; the actual
      // execution stays behind /api/computer's token + whitelist. Here we just
      // hand back the classified plan so the caller can run it there.
      return res.json({
        intent: 'computer',
        steps: (p.computer.actions || []).map((a) => ({ id: a.id, text: a.progress, ok: null })),
        notice: p.computer.notice || null,
        delegate: 'computer',
      });
    }

    return res.json({ intent: 'conversation', steps: [], context: null });
  }));

  // Research/reasoning pipeline (§2–§20). Runs the bounded understand→plan→
  // research→verify→gap-check→reason→synthesize flow. Degrades gracefully if
  // the model is offline (still returns the evidence-grounded ANSWER_CONTEXT).
  router.post('/research', wrap(async (req, res) => {
    const question = String(req.body?.question || req.body?.message || '').slice(0, 400);
    if (!question.trim()) return res.status(400).json({ error: 'A "question" is required.' });
    if (!researchSearchProvider) return res.status(503).json({ error: 'Research is not configured (no search provider).' });
    if (req.body?.stream !== true) {
      const out = await runResearch(question, { searchProvider: researchSearchProvider, llm: researchLLM });
      return res.json(sanitizeResearchPayload(out));
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const abort = new AbortController();
    const requestStarted = process.hrtime.bigint();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });
    try {
      const out = await runResearch(question, {
        searchProvider: researchSearchProvider,
        llm: researchLLM,
        signal: abort.signal,
        onProgress: (event) => send('progress', sanitizeResearchPayload(event)),
        onToken: (token) => send('progress', { type: 'token', token, at: new Date().toISOString(), elapsed_ms: Number((process.hrtime.bigint() - requestStarted) / 1000000n) }),
      });
      if (!abort.signal.aborted) send('result', sanitizeResearchPayload(out));
      if (!abort.signal.aborted) res.write('event: done\ndata: [DONE]\n\n');
    } catch (err) {
      if (!abort.signal.aborted) send('error', sanitizeResearchPayload({ error: String(err.message || err).slice(0, 240) }));
    } finally {
      if (!res.writableEnded) res.end();
    }
  }));

  // Classify-only (no research, no tool calls): does this need research?
  router.post('/research/classify', (req, res) => {
    const { classify } = require('./research');
    const question = String(req.body?.question || req.body?.message || '').slice(0, 400);
    res.json(classify(question));
  });

  router.get('/status', (req, res) => {
    res.json({ orchestrator: true, capabilities: ['llm', 'computer', 'browser', 'youtube', 'visual', 'research'] });
  });

  return router;
}

module.exports = { createOrchestratorRouter, safeResearchUrl, sanitizeResearchPayload };
