/**
 * Integrations — per-user connection store (server-side only).
 *
 * Zara v1 has no database and no login: the existing architecture keeps data
 * in `data/*.json` files (like sales-plugin.json). Connections follow the same
 * pattern — one file per user under `data/integrations/<uid>.json`.
 *
 * Security rules enforced here:
 *  - Access & refresh tokens (and LMS API keys) are encrypted at rest with
 *    AES-256-GCM. The key comes from INTEGRATIONS_ENCRYPTION_KEY, otherwise a
 *    machine-local key file `data/.integrations-key` is generated once.
 *  - The browser only ever sees a `zara_uid` httpOnly cookie (identity, no
 *    secret) — tokens are NEVER serialized into API responses.
 *  - OAuth `state` values are HMAC-signed and embed the user id, so a callback
 *    works even if cookies are lost mid-flow.
 *
 * When real authentication arrives, swap `ensureUid` to return the logged-in
 * user's id — the rest of the system is already keyed per user (tenant-ready).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const UID_COOKIE = 'zara_uid';
let cachedKey = null;

function keyFile(dataDir) {
  return path.join(dataDir, '.integrations-key');
}

/** AES-256 key: env override (hex or passphrase) or generated machine key. */
function getKey(dataDir) {
  if (cachedKey) return cachedKey;
  const env = String(process.env.INTEGRATIONS_ENCRYPTION_KEY || '').trim();
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
      return cachedKey;
    }
  } catch { /* generate below */ }
  const fresh = crypto.randomBytes(32);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(keyFile(dataDir), fresh.toString('hex'), { mode: 0o600 });
  cachedKey = fresh;
  return cachedKey;
}

/** Encrypt a secret → `v1.<iv>.<tag>.<ct>` (base64 parts). */
function encrypt(dataDir, plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(dataDir), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ct.toString('base64')}`;
}

function decrypt(dataDir, val) {
  if (!val || typeof val !== 'string') return '';
  try {
    const [v, ivB, tagB, ctB] = val.split('.');
    if (v !== 'v1') return '';
    const d = crypto.createDecipheriv('aes-256-gcm', getKey(dataDir), Buffer.from(ivB, 'base64'));
    d.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ctB, 'base64')), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

// ---------- user identity (httpOnly cookie; no secret material) ----------

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

function safeUid(uid) {
  return /^[a-zA-Z0-9_-]{8,80}$/.test(String(uid || '')) ? String(uid) : null;
}

/**
 * Returns this browser's user id, minting + setting the cookie when new.
 * When a login session is present (req.authUid, set by auth/session.js) the
 * ACCOUNT id wins — that is the "real authentication arrives" swap described
 * above: every per-user store becomes keyed to the login with no call-site
 * changes, and anonymous browsers keep their own separate id.
 */
function ensureUid(req, res) {
  const authed = safeUid(req && req.authUid);
  if (authed) return authed;
  const fromCookie = safeUid(parseCookies(req)[UID_COOKIE]);
  const uid = fromCookie || crypto.randomUUID();
  if (!fromCookie && res && typeof res.cookie === 'function') {
    res.cookie(UID_COOKIE, uid, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 10 * 365 * 24 * 3600 * 1000 });
  }
  return uid;
}

// ---------- per-user file ----------

function fileFor(dataDir, uid) {
  const safe = safeUid(uid);
  if (!safe) throw new Error('Invalid user id');
  return path.join(dataDir, 'integrations', `${safe}.json`);
}

function loadUser(dataDir, uid) {
  if (!safeUid(uid)) return { connections: {}, pending: {} }; // catalog-only views
  try {
    const data = JSON.parse(fs.readFileSync(fileFor(dataDir, uid), 'utf8'));
    return { connections: data.connections || {}, pending: data.pending || {} };
  } catch {
    return { connections: {}, pending: {} };
  }
}

function saveUser(dataDir, uid, data) {
  const file = fileFor(dataDir, uid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// ---------- signed OAuth state ----------

function signState(dataDir, uid) {
  const exp = Date.now() + 15 * 60 * 1000;
  const payload = `${uid}.${exp}`;
  const sig = crypto.createHmac('sha256', getKey(dataDir)).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyState(dataDir, state) {
  const parts = String(state || '').split('.');
  if (parts.length !== 3) return null;
  const [uid, expStr, sig] = parts;
  const payload = `${uid}.${expStr}`;
  const expect = crypto.createHmac('sha256', getKey(dataDir)).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() > Number(expStr)) return null;
  return safeUid(uid);
}

module.exports = {
  UID_COOKIE,
  ensureUid,
  encrypt,
  decrypt,
  loadUser,
  saveUser,
  signState,
  verifyState,
  safeUid,
};
