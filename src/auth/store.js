/**
 * Auth — local account store (server-side only).
 *
 * Zara v1 has no database; accounts follow the same flat-JSON pattern as the
 * rest of `data/` — one file `data/users.json` holding every local account.
 *
 * Security rules:
 *  - Passwords are NEVER stored in the clear. scrypt (N=16384, r=8, p=1)
 *    with a per-user 16-byte random salt → 64-byte key, hex encoded.
 *  - Comparison is always timing-safe.
 *  - No account field other than { id, name, email, createdAt, pw } — no
 *    tokens, no sessions and no secrets are kept in this file (sessions live
 *    in the signed httpOnly cookie issued by ./session.js).
 *  - Reads/writes are whole-file (the user base is tiny, local-only) and
 *    writes go through a temp file + rename so a crash can't leave a
 *    half-written users.json behind.
 *
 * ROLE SUPPORT:
 *  - New fields: role (default: 'employee'), managerId (optional parent)
 *  - Default roles: founder, admin, manager, employee
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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

function readDoc(dataDir) {
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

// ---------- lookups ----------

function findById(dataDir, id) {
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(String(id || ''))) return null;
  return readDoc(dataDir).users.find((u) => u.id === id) || null;
}

function findByEmail(dataDir, email) {
  const emailN = normalizeEmail(email);
  if (!emailN) return null;
  return readDoc(dataDir).users.find((u) => normalizeEmail(u.email) === emailN) || null;
}

function countUsers(dataDir) {
  return readDoc(dataDir).users.length;
}

// ---------- mutations ----------

/**
 * Create a local account.
 * `uid` (optional) pins the account to this browser's existing `zara_uid`,
 * so integrations/data already collected on this machine stay attached to
 * the new account instead of being orphaned.
 */
function createUser(dataDir, { name, email, password, uid }) {
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

  const doc = readDoc(dataDir);
  if (doc.users.some((u) => normalizeEmail(u.email) === emailN)) {
    throw authError(409, 'exists', 'An account with this email already exists.');
  }

  const id = /^[a-zA-Z0-9_-]{8,80}$/.test(String(uid || '')) ? String(uid) : crypto.randomUUID();
  if (doc.users.some((u) => u.id === id)) {
    // The browser uid is already taken by another account → mint a fresh one.
    return createUser(dataDir, { name: nameN, email: emailN, password, uid: crypto.randomUUID() });
  }

  const { salt, hash } = hashPassword(pw);
  const user = {
    id,
    name: nameN,
    email: emailN,
    pw: { algo: 'scrypt', salt, hash },
    createdAt: Date.now(),
  };

  doc.users.push(user);
  writeDoc(dataDir, doc);
  return user;
}

/** Verify email + password → the account, or null. */
function authenticate(dataDir, email, password) {
  const user = findByEmail(dataDir, email);
  if (!user) return null;
  if (!verifyPassword(user, password)) return null;
  return user;
}

/** The only account shape that may leave the server. */
function publicUser(user) {
  if (!user) return null;
  return { 
    id: user.id, 
    name: user.name, 
    email: user.email, 
    createdAt: user.createdAt,
    role: user.role || 'employee'
  };
}

/** Get all users (admin use). */
function listUsers(dataDir) {
  const doc = readDoc(dataDir);
  return doc.users.map((u) => publicUser(u));
}

/** Update a user's role (admin use). */
function updateUser(dataDir, userId, updates) {
  const doc = readDoc(dataDir);
  const idx = doc.users.findIndex((u) => u.id === userId);
  if (idx === -1) return null;
  
  const user = doc.users[idx];
  const updatesAllowed = ['role', 'managerId', 'name'];
  
  for (const key of updatesAllowed) {
    if (updates[key] !== undefined) {
      user[key] = updates[key];
    }
  }
  
  doc.users[idx] = user;
  writeDoc(dataDir, doc);
  return publicUser(user);
}

/** Delete a user (admin use). */
function deleteUser(dataDir, userId) {
  const doc = readDoc(dataDir);
  const idx = doc.users.findIndex((u) => u.id === userId);
  if (idx === -1) return null;
  
  const deleted = doc.users.splice(idx, 1)[0];
  writeDoc(dataDir, doc);
  return { id: deleted.id, email: deleted.email };
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
  publicUser,
  publicUserWithRole: require('./roles').publicUserWithRole,
  verifyPassword,
  listUsers,
  updateUser,
  deleteUser,
};
