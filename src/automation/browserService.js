/**
 * BrowserService — Zara's Node-side client for the local Python Playwright
 * service (browser_automation/server.py on 127.0.0.1:8735).
 *
 *  * Spawns the service on demand (once), health-checks it, restarts on demand.
 *  * Exposes ONLY the whitelisted action set — no arbitrary code, no shell,
 *    no Python execution ever crosses this boundary.
 *  * Logs use the [BROWSER] prefix; typed text/cookies/tokens are never logged.
 */
const { spawn } = require('child_process');
const path = require('path');

const PORT = Number(process.env.ZARA_BROWSER_PORT || 8735);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..', '..');
const SERVICE = path.join(ROOT, 'browser_automation', 'server.py');
const START_TIMEOUT_MS = Number(process.env.ZARA_BROWSER_START_TIMEOUT_MS || 30000);

let child = null;
let starting = null;

function log(msg) { console.log(`[BROWSER] ${msg}`); }

class BrowserToolError extends Error {
  constructor(message, code = 'failed') { super(message); this.code = code; }
}

/** Health probe — returns the service's /health JSON or null when down. */
async function status(timeoutMs = 1500) {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function pythonCmd() {
  return process.platform === 'win32' ? 'python' : 'python3';
}

/** Ensure the Python service is running (spawn once, poll /health). */
async function ensureService() {
  const live = await status();
  if (live && live.ok) return live;
  if (starting) return starting;

  starting = (async () => {
    log('starting local browser automation service (Python + Playwright)…');
    const proc = spawn(pythonCmd(), [SERVICE], {
      cwd: ROOT,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    const forward = (stream, out) => stream.on('data', (d) => {
      String(d).split(/\r?\n/).filter(Boolean).forEach((line) => out(line));
    });
    forward(proc.stdout, (l) => console.log(l));          // already "[BROWSER] …"
    forward(proc.stderr, (l) => console.error(`[browser-svc] ${l}`));
    proc.on('exit', (code) => {
      log(`service exited (code ${code == null ? 'killed' : code})`);
      child = null;
      starting = null;
    });
    child = proc;

    const t0 = Date.now();
    while (Date.now() - t0 < START_TIMEOUT_MS) {
      const hs = await status();
      if (hs && hs.ok) { log('service ready'); return hs; }
      await new Promise((r) => setTimeout(r, 400));
    }
    starting = null;
    throw new BrowserToolError(
      'The browser automation service did not start. It may not be installed — '
      + 'run: pip install playwright && python -m playwright install chromium',
      'not_running',
    );
  })();

  try { return await starting; } catch (err) { starting = null; throw err; }
}

/**
 * Call one whitelisted action on the Python service.
 * Returns the service JSON: { ok: true, ... } | { ok: false, error, code }.
 */
async function call(action, args = {}, timeoutMs = 45000, { signal } = {}) {
  await ensureService();
  let res;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  let callSignal = timeoutSignal;
  if (signal && AbortSignal.any) callSignal = AbortSignal.any([signal, timeoutSignal]);
  else if (signal) {
    const linked = new AbortController();
    for (const item of [signal, timeoutSignal]) {
      if (item.aborted) linked.abort(item.reason);
      else item.addEventListener('abort', () => linked.abort(item.reason), { once: true });
    }
    callSignal = linked.signal;
  }
  try {
    res = await fetch(`${BASE}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, args }),
      signal: callSignal,
    });
  } catch {
    throw new BrowserToolError(
      'The browser automation service stopped responding — please try again.', 'unreachable',
    );
  }
  return res.json().catch(() => ({ ok: false, error: 'Bad response from the browser service.', code: 'bad_response' }));
}

/** Kill the spawned service when Zara shuts down (no orphan python.exe). */
function shutdown() {
  if (child) {
    log('stopping browser automation service');
    try { child.kill(); } catch { /* already gone */ }
    child = null;
  }
}
process.on('exit', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });

module.exports = { ensureService, call, status, shutdown, BrowserToolError, PORT };
