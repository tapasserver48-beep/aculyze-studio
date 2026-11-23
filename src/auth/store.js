/**
 * Auth — local account store (server-side only).
 *
 * Phase 1 storage backends:
 *  - PostgreSQL when `DATABASE_URL` is set (see ../db/pg.js) — this is the
 *    source of truth for credentials and account mutations.
 *  - The legacy flat file `data/users.json` otherwise, so local development
 *    needs no database.
 *
 * The credential/mutation functions are async because Postgres is. The one
 * synchronous reader, `readDoc()`, serves the chat + inbox helpers that only
 * ever need names and roles: in Postgres mode it reads an in-memory directory
 * mirror that this module refreshes at boot and after every successful
 * mutation (the service is a single writer, so the mirror never drifts).
 *
 * Security rules:
 *  - Passwords are NEVER stored in the clear. scrypt (N=16384, r=8, p=1)
 *    with a per-user 16-byte random salt → 64-byte key, hex encoded.
 *  - Comparison is always timing-safe.
 *  - No account field other than { id, name, email, createdAt, pw } — no
 *    tokens, no sessions and no secrets are kept here (sessions live in the
 *    signed httpOnly cookie issued by ./session.js).
 *  - JSON writes go through a temp file + rename so a crash can't leave a
 *    half-written users.json behind.
 *
 * ROLE SUPPORT:
 *  - Fields: role (default: 'employee'), managerId (optional parent)
 *  - Default roles: founder, admin, manager, employee
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pg = require('../db/pg');
const { normalizePermissions, effectivePages } = require('./roles');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 6;

function usersFile(dataDir) {
  return path.join(dataDir, 'users.json');
}

/** Error carrying an HTTP status + machine code for the routes layer. */
function authError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

// ---------- directory mirror (Postgres mode) ----------
// Names/roles only — credentials always come from the database itself.

let directory = null;

function refreshDirectory(rows) {
  directory = (rows || []).map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role || 'employee',
    managerId: r.manager_id || undefined,
    createdAt: Number(r.created_at) || 0,
  }));
  return directory;
}

async function reloadDirectory() {
  const { rows } = await pg.query(
    'SELECT id, name, email, role, manager_id, created_at FROM users ORDER BY created_at'
  );
  return refreshDirectory(rows);
}

// ---------- JSON backend ----------

function readJsonDoc(dataDir) {
  try {
    const doc = JSON.parse(fs.readFileSync(usersFile(dataDir), 'utf8'));
    return { users: Array.isArray(doc.users) ? doc.users : [] };
  } catch {
    return { users: [] };
  }
}

function writeDoc(dataDir, doc) {
  const file = usersFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Synchronous directory read for the chat/inbox helpers (names + roles).
 * Postgres mode returns the in-memory mirror; JSON mode reads the file.
 */
function readDoc(dataDir) {
  if (pg.enabled()) return { users: directory || [] };
  return readJsonDoc(dataDir);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// ---------- password hashing (scrypt) ----------

function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

function verifyPassword(user, password) {
  try {
    if (String(password || '').length > 200) return false;
    const expected = Buffer.from((user.pw && user.pw.hash) || '', 'hex');
    const salt = (user.pw && user.pw.salt) || '';
    if (!expected.length || !salt) return false;
    const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'hex'), 64);
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ---------- row mapping (Postgres mode) ----------

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role || 'employee',
    managerId: row.manager_id || undefined,
    permissions: row.permissions && typeof row.permissions === 'object' ? row.permissions : {},
    pw: { algo: row.pw_algo, salt: row.pw_salt, hash: row.pw_hash },
    createdAt: Number(row.created_at) || 0,
  };
}

const USER_COLS = 'id, name, email, role, manager_id, permissions, pw_algo, pw_salt, pw_hash, created_at';

async function pgFindById(id) {
  const { rows } = await pg.query('SELECT * FROM users WHERE id = $1', [id]);
  return rowToUser(rows[0]);
}

async function pgFindByEmail(email) {
  const { rows } = await pg.query('SELECT * FROM users WHERE email = $1', [email]);
  return rowToUser(rows[0]);
}

async function pgInsertUser(user) {
  await pg.query(
    `INSERT INTO users (${USER_COLS})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO NOTHING`,
    [
      user.id,
      user.name,
      user.email,
      user.role || 'employee',
      user.managerId || null,
      JSON.stringify(user.permissions || {}),
      user.pw.algo,
      user.pw.salt,
      user.pw.hash,
      user.createdAt,
    ]
  );
}

// ---------- lookups ----------

async function findById(dataDir, id) {
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(String(id || ''))) return null;
  if (pg.enabled()) return pgFindById(id);
  return readJsonDoc(dataDir).users.find((u) => u.id === id) || null;
}

async function findByEmail(dataDir, email) {
  const emailN = normalizeEmail(email);
  if (!emailN) return null;
  if (pg.enabled()) return pgFindByEmail(emailN);
  return readJsonDoc(dataDir).users.find((u) => normalizeEmail(u.email) === emailN) || null;
}

async function countUsers(dataDir) {
  if (pg.enabled()) {
    const { rows } = await pg.query('SELECT count(*)::int AS n FROM users');
    return Number(rows[0].n) || 0;
  }
  return readJsonDoc(dataDir).users.length;
}

/**
 * How many admin/founder accounts exist.
 * The first-admin bootstrap (./setup.js + GET/POST /api/auth/setup) runs only
 * while this returns 0, and disables itself forever once it does not — see
 * ./setup.js for why a permanently open "create admin" door is not an option.
 */
async function countAdmins(dataDir) {
  if (pg.enabled()) {
    const { rows } = await pg.query(
      "SELECT count(*)::int AS n FROM users WHERE role IN ('admin', 'founder')"
    );
    return Number(rows[0].n) || 0;
  }
  return readJsonDoc(dataDir).users.filter(
    (u) => u && (u.role === 'admin' || u.role === 'founder')
  ).length;
}

// ---------- mutations ----------

/**
 * Create a local account.
 * `uid` (optional) pins the account to this browser's existing `zara_uid`,
 * so integrations/data already collected on this machine stay attached to
 * the new account instead of being orphaned.
 * `role` (optional) is for admin-created accounts; self-registration always
 * falls back to the 'employee' default inside.
 */
async function createUser(dataDir, { name, email, password, uid, role, permissions }) {
  const nameN = String(name || '').trim().slice(0, 80);
  const emailN = normalizeEmail(email);

  if (!nameN) throw authError(422, 'validation', 'Please enter your name.');
  if (!EMAIL_RE.test(emailN)) throw authError(422, 'validation', 'Please enter a valid email address.');
  const pw = String(password || '');
  if (pw.length < MIN_PASSWORD) {
    throw authError(422, 'validation', `Password must be at least ${MIN_PASSWORD} characters.`);
  }
  if (pw.length > 200) {
    throw authError(422, 'validation', 'Password must be at most 200 characters.');
  }

  if (await findByEmail(dataDir, emailN)) {
    throw authError(409, 'exists', 'An account with this email already exists.');
  }

  const id = /^[a-zA-Z0-9_-]{8,80}$/.test(String(uid || '')) ? String(uid) : crypto.randomUUID();
  if (await findById(dataDir, id)) {
    // The browser uid is already taken by another account → mint a fresh one.
    return createUser(dataDir, { name: nameN, email: emailN, password, uid: crypto.randomUUID(), role, permissions });
  }

  const { salt, hash } = hashPassword(pw);
  const user = {
    id,
    name: nameN,
    email: emailN,
    role: role || 'employee',
    permissions: normalizePermissions(permissions),
    pw: { algo: 'scrypt', salt, hash },
    createdAt: Date.now(),
  };

  if (pg.enabled()) {
    try {
      await pgInsertUser(user);
    } catch (err) {
      if (pg.isUniqueViolation(err)) {
        throw authError(409, 'exists', 'An account with this email already exists.');
      }
      throw err;
    }
    await reloadDirectory();
  } else {
    const doc = readJsonDoc(dataDir);
    doc.users.push(user);
    writeDoc(dataDir, doc);
  }
  return user;
}

/** Verify email + password → the account, or null. */
async function authenticate(dataDir, email, password) {
  const user = await findByEmail(dataDir, email);
  if (!user) return null;
  if (!verifyPassword(user, password)) return null;
  return user;
}

/** The only account shape that may leave the server. */
function publicUser(user) {
  if (!user) return null;
  const role = user.role || 'employee';
  const permissions = normalizePermissions(user.permissions);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
    role,
    // "Reports to" — acts as the person's team lead (Executive Agent follow-ups).
    managerId: user.managerId || null,
    // Raw per-user overrides (admin UI needs them to render the matrix).
    permissions,
    // Resolved page access — the client gates its nav from this map, so it
    // never has to reimplement the role-default/override precedence.
    pages: effectivePages(role, permissions),
  };
}

/** Get all users (admin use). */
async function listUsers(dataDir) {
  if (pg.enabled()) {
    const { rows } = await pg.query(`SELECT ${USER_COLS} FROM users ORDER BY created_at`);
    return rows.map((r) => publicUser(rowToUser(r)));
  }
  return readJsonDoc(dataDir).users.map((u) => publicUser(u));
}

/** Update a user's role/permissions/name (admin use). */
async function updateUser(dataDir, userId, updates) {
  const updatesAllowed = ['role', 'managerId', 'name', 'permissions'];

  if (pg.enabled()) {
    const current = await pgFindById(userId);
    if (!current) return null;
    const next = { ...current };
    for (const key of updatesAllowed) {
      if (updates[key] !== undefined) next[key] = updates[key];
    }
    const { rows } = await pg.query(
      `UPDATE users SET name = $2, email = $3, role = $4, manager_id = $5, permissions = $6
       WHERE id = $1 RETURNING ${USER_COLS}`,
      [
        userId,
        next.name,
        next.email,
        next.role || 'employee',
        next.managerId || null,
        JSON.stringify(normalizePermissions(next.permissions)),
      ]
    );
    await reloadDirectory();
    return publicUser(rowToUser(rows[0]));
  }

  const doc = readJsonDoc(dataDir);
  const idx = doc.users.findIndex((u) => u.id === userId);
  if (idx === -1) return null;

  const user = doc.users[idx];
  for (const key of updatesAllowed) {
    if (updates[key] !== undefined) {
      user[key] = key === 'permissions' ? normalizePermissions(updates[key]) : updates[key];
    }
  }
  doc.users[idx] = user;
  writeDoc(dataDir, doc);
  return publicUser(user);
}

/** Delete a user (admin use). */
async function deleteUser(dataDir, userId) {
  if (pg.enabled()) {
    const { rows } = await pg.query('DELETE FROM users WHERE id = $1 RETURNING id, email', [userId]);
    if (!rows[0]) return null;
    await reloadDirectory();
    return { id: rows[0].id, email: rows[0].email };
  }

  const doc = readJsonDoc(dataDir);
  const idx = doc.users.findIndex((u) => u.id === userId);
  if (idx === -1) return null;

  const deleted = doc.users.splice(idx, 1)[0];
  writeDoc(dataDir, doc);
  return { id: deleted.id, email: deleted.email };
}

/**
 * One-time bootstrap, run during boot when Postgres is enabled:
 * copy `data/users.json` into an empty `users` table (a fresh Render instance
 * has no database rows yet), then load the directory mirror.
 * If the table already has rows, Postgres wins — the file is never merged.
 */
async function migrateToPostgres(dataDir) {
  if (!pg.enabled()) return { migrated: 0 };
  const { rows } = await pg.query('SELECT count(*)::int AS n FROM users');
  const existing = Number(rows[0].n) || 0;

  let migrated = 0;
  if (existing === 0) {
    const fileUsers = readJsonDoc(dataDir).users;
    for (const u of fileUsers) {
      if (!u || !u.id || !u.pw) continue;
      try {
        await pgInsertUser({
          id: u.id,
          name: u.name || '',
          email: normalizeEmail(u.email),
          role: u.role || 'employee',
          managerId: u.managerId,
          permissions: normalizePermissions(u.permissions),
          pw: u.pw,
          createdAt: u.createdAt || Date.now(),
        });
        migrated += 1;
      } catch (err) {
        if (!pg.isUniqueViolation(err)) throw err;
      }
    }
  }

  await reloadDirectory();
  return { migrated };
}

module.exports = {
  MIN_PASSWORD,
  authError,
  normalizeEmail,
  readDoc,
  createUser,
  authenticate,
  findById,
  findByEmail,
  countUsers,
  countAdmins,
  publicUser,
  publicUserWithRole: require('./roles').publicUserWithRole,
  verifyPassword,
  listUsers,
  updateUser,
  deleteUser,
  migrateToPostgres,
};
