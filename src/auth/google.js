/**
 * Google sign-in for the local login screen (OAuth 2.0, authorization code).
 *
 *   GET /api/auth/google          → redirect to Google's consent screen
 *   GET /api/auth/google/callback → exchange the code, then sign the user in
 *
 * Scope is deliberately limited to `openid email profile`: this flow proves
 * IDENTITY only. Gmail / Calendar access keeps living in the separate
 * integrations flow (src/integrations/providers/google.js) so the two never
 * share a token or a scope set.
 *
 * The account is matched (or created) by verified email address. Sign-in is
 * protected by a short-lived httpOnly `state` cookie compared in constant
 * time, which is what stops a CSRF'd login.
 */
const crypto = require('crypto');
const { findByEmail, createUser, authError } = require('./store');
const { ensureUid } = require('../integrations/store');
const { setSessionCookie } = require('./session');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const SCOPE = 'openid email profile';

const STATE_COOKIE = 'zara_gstate';
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes to complete the consent screen

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Human-readable copy for every failure the login screen can surface. */
const ERROR_COPY = {
  not_configured: 'Google sign-in is not configured yet — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
  bad_state: 'That sign-in link expired. Please try again.',
  denied: 'Google sign-in was cancelled.',
  no_code: 'Google did not return a sign-in code. Please try again.',
  no_email: 'That Google account has no email address we can use.',
  exchange_failed: 'Google rejected the sign-in. Please try again.',
  failed: 'Could not sign you in with Google. Please try again.',
};

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

/** Public origin the browser is on — honours Render's forwarded headers. */
function publicOrigin(req) {
  const envBase = String(process.env.AUTH_REDIRECT_BASE || process.env.INTEGRATIONS_REDIRECT_BASE || '')
    .trim()
    .replace(/\/+$/, '');
  if (envBase) return envBase;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000');
  const proto = String(req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http'))
    .split(',')[0]
    .trim();
  return `${proto}://${host}`;
}

function redirectUri(req) {
  return `${publicOrigin(req)}/api/auth/google/callback`;
}

function clientId() {
  return String(process.env.GOOGLE_CLIENT_ID || '').trim();
}
function clientSecret() {
  return String(process.env.GOOGLE_CLIENT_SECRET || '').trim();
}
function isConfigured() {
  return !!(clientId() && clientSecret());
}

function mintState() {
  return `${crypto.randomBytes(18).toString('base64url')}.${Date.now() + STATE_TTL_MS}`;
}

function stateMatches(req, state) {
  const cookie = parseCookies(req)[STATE_COOKIE];
  const given = String(state || '');
  if (!cookie || !given) return false;
  const a = Buffer.from(String(cookie));
  const b = Buffer.from(given);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const exp = Number(given.split('.')[1]);
  return Number.isFinite(exp) && Date.now() <= exp;
}

function stateCookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    // Scoped to this flow only — the login form never sees it.
    path: '/api/auth/google',
    maxAge: STATE_TTL_MS,
    secure: !!(req && req.secure),
  };
}

function buildAuthUrl(req, state) {
  const u = new URL(AUTH_URL);
  u.searchParams.set('client_id', clientId());
  u.searchParams.set('redirect_uri', redirectUri(req));
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPE);
  u.searchParams.set('state', state);
  // Always offer the account chooser so a second Google identity is possible.
  u.searchParams.set('prompt', 'select_account');
  u.searchParams.set('access_type', 'online');
  return u.toString();
}

async function exchangeCode(code, uri) {
  const body = new URLSearchParams({
    code,
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: uri,
    grant_type: 'authorization_code',
  });
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || !json.access_token) {
    throw authError(502, 'exchange_failed', ERROR_COPY.exchange_failed);
  }
  return json;
}

async function fetchProfile(accessToken) {
  const r = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || !json.email) {
    throw authError(502, 'no_email', ERROR_COPY.no_email);
  }
  return json;
}

/**
 * Factory bound to the auth data directory.
 * Both handlers are redirect-based (the browser navigates away and comes
 * back), so every failure is reported as `/?auth_error=<code>` rather than
 * as JSON — the login screen turns the code into a readable sentence.
 */
function createGoogleAuth({ dataDir }) {
  /** Step 1 — send the browser to Google. */
  function login(req, res) {
    if (!isConfigured()) return res.redirect('/?auth_error=not_configured');
    const state = mintState();
    res.cookie(STATE_COOKIE, state, stateCookieOptions(req));
    res.redirect(buildAuthUrl(req, state));
  }

  /** Step 2 — Google sends the browser back with a code. */
  async function callback(req, res) {
    const fail = (code) => {
      try { res.clearCookie(STATE_COOKIE, { ...stateCookieOptions(req), maxAge: 0 }); } catch { /* noop */ }
      res.redirect(`/?auth_error=${encodeURIComponent(code)}`);
    };

    try {
      const oauthError = String(req.query.error || '');
      if (oauthError) return fail(oauthError === 'access_denied' ? 'denied' : 'failed');
      if (!isConfigured()) return fail('not_configured');
      if (!stateMatches(req, req.query.state)) return fail('bad_state');

      const code = String(req.query.code || '');
      if (!code) return fail('no_code');

      const tokens = await exchangeCode(code, redirectUri(req));
      const profile = await fetchProfile(tokens.access_token);

      const email = String(profile.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return fail('no_email');

      // Match by verified email; otherwise create a Google-backed account.
      // The password is random and never shown — that account can only ever
      // be opened again through this Google flow.
      let user = findByEmail(dataDir, email);
      if (!user) {
        user = createUser(dataDir, {
          name: String(profile.name || email.split('@')[0] || 'Google user').trim().slice(0, 80),
          email,
          password: crypto.randomBytes(24).toString('base64url'),
          // Pin to this browser's existing data (integrations, LMS) exactly
          // like the register route does.
          uid: ensureUid(req, res),
        });
      }

      setSessionCookie(dataDir, req, res, user.id);
      res.redirect('/?auth=google');
    } catch (err) {
      const code = err && err.code && ERROR_COPY[err.code] ? err.code : 'failed';
      console.warn(`[auth] google callback: ${String((err && err.message) || err).slice(0, 200)}`);
      fail(code);
    }
  }

  return { login, callback, isConfigured, redirectUri, ERROR_COPY };
}

module.exports = { createGoogleAuth, ERROR_COPY, isConfigured, redirectUri };
