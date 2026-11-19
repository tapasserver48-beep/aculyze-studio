/**
 * PostgreSQL access — Phase 1 storage backend for accounts and inbox messages.
 *
 * The app talks to Postgres ONLY when `DATABASE_URL` is set (Render provisions
 * one and links it into the service automatically). Without it, every store
 * keeps using the flat JSON files under `data/`, so local development and any
 * deployment without a database behave exactly as before.
 *
 * Rules that keep the two backends from ever splitting writes:
 *  - `init()` is awaited once during boot, before the server listens.
 *  - If DATABASE_URL is set but unreachable, boot FAILS. Silently falling back
 *    to the JSON files would write accounts to a different place than logins
 *    read from.
 *  - `enabled()` is the only switch the stores branch on.
 *  - Schema is created here (idempotent DDL); each store owns its own rows and
 *    its own one-time import from the legacy files.
 */
let pool = null;

/** True once a reachable PostgreSQL pool exists. */
function enabled() {
  return pool !== null;
}

/**
 * Open the pool and create the schema. Returns null in JSON mode.
 * @param {string} [url] defaults to process.env.DATABASE_URL
 */
async function init(url = process.env.DATABASE_URL) {
  if (pool) return pool;
  if (!url) return null;

  let pgModule;
  try {
    pgModule = require('pg');
  } catch {
    throw new Error("DATABASE_URL is set but the 'pg' package is missing — run `npm install`.");
  }

  const local = /localhost|127\.0\.0\.1|\[::1\]/.test(url);
  pool = new pgModule.Pool({
    connectionString: url,
    // Managed providers (Render, Neon, Supabase) terminate TLS with their own
    // CA; plain local servers do not speak TLS at all.
    ssl: local ? undefined : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    max: 5,
  });

  // Fail fast — see the header note about split-brain writes.
  await pool.query('SELECT 1');
  await ensureSchema();
  return pool;
}

/** Single query seam used by the stores. */
async function query(text, params) {
  if (!pool) throw new Error('PostgreSQL is not initialised (no DATABASE_URL).');
  return pool.query(text, params);
}

/** True for a Postgres unique-violation (used to map duplicates to HTTP 409). */
function isUniqueViolation(err) {
  return !!(err && (err.code === '23505' || err.constraint));
}

async function ensureSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL DEFAULT '',
      email       TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT 'employee',
      manager_id  TEXT,
      permissions JSONB NOT NULL DEFAULT '{}',
      pw_algo     TEXT NOT NULL DEFAULT '',
      pw_salt     TEXT NOT NULL DEFAULT '',
      pw_hash     TEXT NOT NULL DEFAULT '',
      created_at  BIGINT NOT NULL DEFAULT 0
    )
  `);
  // Existing databases predate the permissions column — add it in place.
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'`);
  // Emails are stored lower-cased by the auth store, so a plain unique index
  // matches the application-level duplicate check.
  await query('CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (email)');

  await query(`
    CREATE TABLE IF NOT EXISTS inbox_threads (
      box_owner  TEXT NOT NULL,
      peer_id    TEXT NOT NULL,
      peer_name  TEXT NOT NULL DEFAULT '',
      peer_role  TEXT NOT NULL DEFAULT '',
      read_ts    BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (box_owner, peer_id)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS inbox_messages (
      id         TEXT NOT NULL,
      box_owner  TEXT NOT NULL,
      peer_id    TEXT NOT NULL,
      from_id    TEXT NOT NULL,
      to_id      TEXT NOT NULL,
      body       TEXT NOT NULL,
      ts         BIGINT NOT NULL,
      generated  BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY (box_owner, id)
    )
  `);
  await query(
    'CREATE INDEX IF NOT EXISTS inbox_messages_thread_idx ON inbox_messages (box_owner, peer_id, ts)'
  );
}

/** Release connections on shutdown. */
async function closePool() {
  if (!pool) return;
  const p = pool;
  pool = null;
  try {
    await p.end();
  } catch { /* already closed */ }
}

module.exports = { init, query, enabled, isUniqueViolation, closePool };
