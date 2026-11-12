/**
 * Daily AI token accounting — server-side, per source (`zara` | `sales`).
 *
 * Why: the Command Centre page needs real "token usage today" numbers for the
 * Zara and Sales cards. Providers report `usage` when the API returns it
 * (non-streaming responses); streaming replies fall back to a chars/4
 * estimate so the number is still meaningful (labelled ≈ upstream).
 *
 * Storage: flat JSON `data/ai-usage.json` (same pattern as the rest of data/):
 *   { "2026-11-12": { zara: { prompt, completion, calls },
 *                     sales: { prompt, completion, calls } } }
 * Writes are debounced (1.5s) through temp-file + rename so every completion
 * doesn't hit the disk. Only the last 30 days are kept.
 *
 * Source tagging uses AsyncLocalStorage: server.js wraps its provider calls
 * with `withSource('sales', …)` — everything not tagged defaults to `zara`,
 * so the research pipeline, tool agent and mail drafts count as Zara usage.
 */
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();
const MAX_DAYS = 30;
const FLUSH_DELAY_MS = 1500;

/** Run `fn` with the usage source it should be billed to ('zara' | 'sales'). */
function withSource(source, fn) {
  return als.run(source === 'sales' ? 'sales' : 'zara', fn);
}

function currentSource() {
  const s = als.getStore();
  return s === 'sales' ? 'sales' : 'zara';
}

/** ~tokens for a string (chars/4, rounded up, min 1). */
function estimateTokens(text) {
  const s = typeof text === 'string' ? text : '';
  return s ? Math.max(1, Math.ceil(s.length / 4)) : 0;
}

function promptEstimate(messages) {
  if (!Array.isArray(messages)) return 0;
  let n = 0;
  for (const m of messages) {
    const c = m && m.content;
    n += estimateTokens(typeof c === 'string' ? c : JSON.stringify(c || ''));
  }
  return n;
}

function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dataDir() {
  return process.env.ACULYZE_DATA_DIR || path.join(process.cwd(), 'data');
}

function fileFor(dir) {
  return path.join(dir, 'ai-usage.json');
}

let cache = null;
let cacheFile = '';
let dirty = false;
let flushTimer = null;

function ensureLoaded(dir) {
  const f = fileFor(dir);
  if (cache && cacheFile === f) return cache;
  cache = {};
  cacheFile = f;
  try {
    if (fs.existsSync(f)) {
      const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (parsed && typeof parsed === 'object') cache = parsed;
    }
  } catch {
    cache = {};
  }
  return cache;
}

function prune(store) {
  const cutoff = dayKey(new Date(Date.now() - MAX_DAYS * 864e5));
  for (const k of Object.keys(store)) {
    if (k < cutoff) delete store[k];
  }
}

function scheduleFlush(dir) {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush(dir);
  }, FLUSH_DELAY_MS);
}

function flush(dir) {
  if (!dirty || !cache) return;
  dirty = false;
  try {
    const f = fileFor(dir);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, f);
  } catch (err) {
    dirty = true; // retry on the next record
    console.warn('[usage] flush failed:', String(err.message || err).slice(0, 140));
  }
}

/** Add one request's tokens for the active source. Never throws. */
function record({ prompt = 0, completion = 0, source } = {}) {
  try {
    const dir = dataDir();
    const store = ensureLoaded(dir);
    const day = dayKey();
    if (!store[day] || typeof store[day] !== 'object') store[day] = {};
    const src = source === 'sales' ? 'sales' : 'zara';
    const cell = store[day][src] || (store[day][src] = { prompt: 0, completion: 0, calls: 0 });
    cell.prompt += Math.max(0, Math.round(prompt));
    cell.completion += Math.max(0, Math.round(completion));
    cell.calls += 1;
    prune(store);
    dirty = true;
    scheduleFlush(dir);
  } catch (err) {
    console.warn('[usage] record failed:', String(err.message || err).slice(0, 140));
  }
}

/**
 * Record a provider response. Uses the API's exact `usage` when present,
 * otherwise estimates from the message array and the completion text.
 */
function recordResponse({ usage, messages, content } = {}) {
  const prompt = Number(usage && usage.prompt_tokens) || promptEstimate(messages);
  const completion = Number(usage && usage.completion_tokens) || estimateTokens(content || '');
  if (!prompt && !completion) return;
  record({ prompt, completion, source: currentSource() });
}

/** Today's numbers for the Command Centre. */
function today() {
  const dir = dataDir();
  const store = ensureLoaded(dir);
  const day = dayKey();
  const empty = () => ({ prompt: 0, completion: 0, calls: 0 });
  const dayRec = (store[day] && typeof store[day] === 'object') ? store[day] : {};
  const zara = { ...empty(), ...(dayRec.zara || {}) };
  const sales = { ...empty(), ...(dayRec.sales || {}) };
  const total = {
    prompt: zara.prompt + sales.prompt,
    completion: zara.completion + sales.completion,
    calls: zara.calls + sales.calls,
  };
  total.tokens = total.prompt + total.completion;
  return {
    day,
    zara: { ...zara, tokens: zara.prompt + zara.completion },
    sales: { ...sales, tokens: sales.prompt + sales.completion },
    total,
  };
}

module.exports = {
  withSource,
  currentSource,
  record,
  recordResponse,
  today,
  dayKey,
  estimateTokens,
  promptEstimate,
};
