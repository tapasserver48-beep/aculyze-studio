/**
 * Document store: durable home for the small JSON documents that used to live
 * only as files under data/ (automations, approvals, Executive check-ins,
 * app connections, chief plans, usage stats, and the session/encryption keys).
 *
 * Why: on Render the disk is wiped on every deploy/restart, so those files
 * vanished: people were logged out, had to reconnect Gmail, and lost their
 * automations and check-ins.
 *
 * How it works (one table, a write-through memory cache):
 *   - JSON mode (no DATABASE_URL): plain atomic file reads/writes, as before.
 *   - Postgres mode: every document is a row in app_documents keyed by its
 *     path relative to data/ (e.g. "automations/automations.json"). All rows
 *     are loaded into memory at boot, so reads stay synchronous and fast;
 *     writes update memory immediately and are persisted to Postgres in order
 *     in the background (one queue, so the last write always wins).
 *   - First boot against Postgres imports any existing file once.
 *
 * Single web instance assumed (Render starter). If the process dies within a
 * few milliseconds of a write, that one write can be lost; this store is not
 * used for accounts, tasks or Inbox messages (those have their own tables).
 */

const fs = require('fs');
const path = require('path');
const pg = require('./pg');

const cache = new Map(); // relPath → serialized JSON string (or raw text)
let queue = Promise.resolve();
let pending = 0;
let ready = false;

function rel(dataDir, file) {
  return path.relative(dataDir, file).split(path.sep).join('/');
}

/** Create the table and load every document (Postgres mode only). */
async function init(dataDir) {
  if (!pg.enabled()) return { mode: 'files' };
  // Probe first, create only when missing (also keeps pg-mem tests happy).
  let exists = true;
  try { await pg.query('SELECT path FROM app_documents LIMIT 1'); } catch { exists = false; }
  if (!exists) {
    await pg.query(`CREATE TABLE app_documents (
      path        TEXT PRIMARY KEY,
      body        TEXT NOT NULL,
      updated_at  BIGINT NOT NULL
    )`);
  }
  const { rows } = await pg.query('SELECT path, body FROM app_documents');
  for (const r of rows) cache.set(r.path, r.body);
  ready = true;
  const imported = await importFiles(dataDir);
  return { mode: 'postgres', documents: cache.size, imported };
}

/** One-time import of legacy files that have no row yet. */
async function importFiles(dataDir) {
  const roots = ['automations', 'executive', 'integrations', 'delegation', 'chief'];
  const singles = ['agent-approvals.json', 'ai-usage.json', '.auth-key', '.integrations-key'];
  const files = [];
  for (const s of singles) files.push(path.join(dataDir, s));
  for (const r of roots) {
    const dir = path.join(dataDir, r);
    try {
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) files.push(path.join(dir, f));
    } catch { /* missing folder */ }
  }
  let n = 0;
  for (const file of files) {
    const key = rel(dataDir, file);
    if (cache.has(key)) continue;
    let body;
    try { body = fs.readFileSync(file, 'utf8'); } catch { continue; }
    cache.set(key, body);
    await pg.query('INSERT INTO app_documents (path, body, updated_at) VALUES ($1, $2, $3) ON CONFLICT (path) DO NOTHING', [key, body, Date.now()]);
    n += 1;
  }
  return n;
}

function persist(key, body) {
  pending += 1;
  queue = queue
    .then(() => (body === null
      ? pg.query('DELETE FROM app_documents WHERE path = $1', [key])
      : pg.query(`INSERT INTO app_documents (path, body, updated_at) VALUES ($1, $2, $3)
                  ON CONFLICT (path) DO UPDATE SET body = EXCLUDED.body, updated_at = EXCLUDED.updated_at`, [key, body, Date.now()])))
    .catch((err) => console.error(`[docstore] failed to save ${key}: ${err.message}`))
    .finally(() => { pending -= 1; });
}

const usePg = () => pg.enabled() && ready;

/* ---------------- text (keys) ---------------- */

/** Read a small text document (e.g. a key file). Returns null when missing. */
function readText(dataDir, file) {
  if (usePg()) {
    const v = cache.get(rel(dataDir, file));
    return v === undefined ? null : v;
  }
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function writeText(dataDir, file, text, { mode } = {}) {
  if (usePg()) {
    const key = rel(dataDir, file);
    cache.set(key, String(text));
    persist(key, String(text));
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(text), mode ? { mode } : undefined);
}

/* ---------------- JSON ---------------- */

/** Read a JSON document; returns `fallback` when missing or unreadable. */
function readJson(dataDir, file, fallback) {
  const text = readText(dataDir, file);
  if (text === null) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

/** Write a JSON document (atomic rename in file mode). */
function writeJson(dataDir, file, doc) {
  const text = JSON.stringify(doc, null, 2);
  if (usePg()) {
    const key = rel(dataDir, file);
    cache.set(key, text);
    persist(key, text);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function remove(dataDir, file) {
  if (usePg()) {
    const key = rel(dataDir, file);
    cache.delete(key);
    persist(key, null);
    return;
  }
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

/** Resolves once every queued Postgres write has finished (shutdown, tests). */
async function flush() {
  while (pending > 0) await queue;
}

module.exports = { init, readText, writeText, readJson, writeJson, remove, flush };
