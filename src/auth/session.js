/**
 * Auth — signed session cookies (server-side only).
 *
 * A session is a self-contained signed token: `<uid>.<exp>.<hmac>` where the
 * HMAC-SHA256 is keyed by a machine-local 32-byte key kept in
 * `data/.auth-key` (same pattern as data/.integrations-key). Nothing about
 * the session is stored server-side, so there is no session table to grow —
 * a valid, unexpired signature IS the session.
 *
 * The cookie itself is httpOnly + SameSite=Lax, so JavaScript can never read
 * the token and a cross-site form post can never replay it.
 *
 * `attachAuth()` runs early in server.js and populates:
 *   req.user    → public account shape { id, name, email } (or undefined)
 *   req.authUid → the logged-in account id
 * Downstream, `ensureUid()` prefers req.authUid, so every existing per-user
 * store (integrations, LMS credentials, inbox) becomes keyed to the login
 * with zero changes at the call sites.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSION_COOKIE = 'zara_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const UID_RE = /^[a-zA-Z0-9_-]{8,80}$/;

let cachedKey = null;

function keyFile(dataDir) {
  return path.join(dataDir, '.auth-key');
}

/** AES-grade 32-byte HMAC key: env override or generated machine key. */
function getKey(dataDir) {
  if (cachedKey) return cachedKey;
  const env = String(process.env.AUTH_SESSION_KEY || '').trim();
  if (env) {
    cachedKey = /^[0-9a-f]{64}$/i.test(env)
      ? Buffer.from(env, 'hex')
      : crypto.createHash('sha256').update(env).digest();
    return cachedKey;
  }
  try {
    const k = Buffer.from(fs.readFileSync(keyFile(dataDir), 'utf8').trim(), 'hex');
    if (k.length === 32) {
      cachedKey = k;
      return k;
    }
  } catch { /* generate below */ }
  const fresh = crypto.randomBytes(32);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(keyFile(dataDir), fresh.toString('hex'), { mode: 0o600 });
  cachedKey = fresh;
  return fresh;
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers && req.headers.cookie;
  if (!raw) return out;
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Mint `<uid>.<exp>.<sig>` for a logged-in account. */
function signSession(dataDir, uid) {
  if (!UID_RE.test(String(uid || ''))) throw new Error('Invalid user id');
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `${uid}.${exp}`;
  const sig = crypto.createHmac('sha256', getKey(dataDir)).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/** Returns the uid when the token is authentic and unexpired, else null. */
function verifySession(dataDir, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [uid, expStr, sig] = parts;
  if (!UID_RE.test(uid)) return null;
  const payload = `${uid}.${expStr}`;
  const expect = crypto.createHmac('sha256', getKey(dataDir)).update(payload).digest('base64url');
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (!Number.isFinite(Number(expStr)) || Date.now() > Number(expStr)) return null;
  return uid;
}

function sessionCookieOptions(req, maxAge = SESSION_TTL_MS) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge,
    // Only meaningful behind TLS; localhost runs plain HTTP.
    secure: !!(req && req.secure),
  };
}

function setSessionCookie(dataDir, req, res, uid) {
  res.cookie(SESSION_COOKIE, signSession(dataDir, uid), sessionCookieOptions(req));
}

function clearSessionCookie(dataDir, req, res) {
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions(req, 0));
}

/**
 * Express middleware: resolve the session cookie into req.user / req.authUid.
 * Never rejects — anonymous requests simply stay anonymous, so the rest of
 * the app (status/config/static) keeps working on the login screen.
 */
function attachAuth(dataDir) {
  return (req, res, next) => {
    try {
      const uid = verifySession(dataDir, parseCookies(req)[SESSION_COOKIE]);
      if (uid) {
        // Lazy require avoids a store↔session require cycle.
        const { findById, publicUser } = require('./store');
        const user = findById(dataDir, uid);
        if (user) {
          req.user = publicUser(user);
          req.authUid = uid;
        }
      }
    } catch { /* treat as signed out */ }
    next();
  };
}

/** Guard for routes that must not run anonymously. */
function requireUser(req, res, next) {
  if (req.user && req.authUid) return next();
  res.status(401).json({ error: 'Please sign in to continue.', code: 'unauthenticated' });
}

module.exports = {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  attachAuth,
  requireUser,
  signSession,
  verifySession,
  setSessionCookie,
  clearSessionCookie,
};
