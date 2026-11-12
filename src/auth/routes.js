/**
 * /api/auth — local login for Aculyze Studio.
 *
 *   POST /api/auth/register  { name, email, password } → 201 { user }
 *   POST /api/auth/login     { email, password }       → 200 { user }
 *   POST /api/auth/logout                             → 200 { ok }
 *   GET  /api/auth/me                                 → 200 { user: {…}|null }
 *   GET  /api/auth/google                             → 302 → Google consent
 *   GET  /api/auth/google/callback                    → 302 → /?auth=google
 *
 * Success issues the signed httpOnly `zara_session` cookie (7 days).
 * `GET /me` always answers 200 — the login screen just reads `user: null`.
 * Errors are always { error, code } with a human-readable message.
 */
const express = require('express');
const { ensureUid } = require('../integrations/store');
const {
  createUser,
  authenticate,
  publicUser,
  publicUserWithRole,
  authError,
  listUsers,
  updateUser,
  deleteUser
} = require('./store');
const {
  requireUser,
  requireRole
} = require('./authorize');
const {
  requireUser: sessionRequireUser,
  setSessionCookie,
  clearSessionCookie
} = require('./session');
const { createGoogleAuth } = require('./google');

function createAuthRouter(options = {}) {
  const router = express.Router();
  const dataDir = options.dataDir;

  // The login screen posts JSON with no cookies attached on purpose — never
  // to forward-cache an old session onto a fresh login response.
  // Body parsing is global (server.js mounts express.json() for every route),
  // so the field-level checks inside each handler bound the actual payload.

  const wrap = (handler) => (req, res) => {
    try {
      handler(req, res);
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      const code = (err && err.code) || 'failed';
      if (status >= 500) {
        console.warn(`[auth] ${req.method} ${req.originalUrl}: ${String(err && err.message || err).slice(0, 200)}`);
      }
      res.status(status).json({ error: (err && err.message) || 'Something went wrong.', code });
    }
  };

  router.post('/register', wrap((req, res) => {
    const body = req.body || {};
    const user = createUser(dataDir, {
      name: body.name,
      email: body.email,
      password: body.password,
      // Pin the new account to this browser's existing identity so data
      // already collected here (integrations, LMS connection) carries over.
      uid: String(req.headers.cookie || '').includes('zara_uid') ? ensureUid(req, res) : undefined,
    });
    setSessionCookie(dataDir, req, res, user.id);
    res.status(201).json({ user: publicUser(user) });
  }));

  router.post('/login', wrap((req, res) => {
    const body = req.body || {};
    const user = authenticate(dataDir, body.email, body.password);
    if (!user) {
      throw authError(401, 'invalid_credentials', 'Wrong email or password.');
    }
    setSessionCookie(dataDir, req, res, user.id);
    res.json({ user: publicUser(user) });
  }));

  router.post('/logout', wrap((req, res) => {
    clearSessionCookie(dataDir, req, res);
    res.json({ ok: true });
  }));

  router.get('/me', wrap((req, res) => {
    res.json({ user: req.user || null });
  }));

  // -------- Google sign-in (browser redirect flow) --------
  // Identity only — see src/auth/google.js. Both handlers answer with a
  // redirect, never JSON, so they are deliberately outside `wrap()`.
  const googleAuth = createGoogleAuth({ dataDir });
  router.get('/google', (req, res) => googleAuth.login(req, res));
  router.get('/google/callback', (req, res) => {
    Promise.resolve()
      .then(() => googleAuth.callback(req, res))
      .catch((err) => {
        console.warn(`[auth] google callback: ${String((err && err.message) || err).slice(0, 200)}`);
        if (res.headersSent) return;
        res.redirect('/?auth_error=failed');
      });
  });

  // Kept for symmetry with other routers; nothing else mounts under /api/auth.
  router.get('/session', requireUser, (req, res) => {
    res.json({ user: req.user });
  });

  // -------- User Management (Admin routes) --------
  // List all users
  router.get('/users', requireUser, requireRole(['admin', 'founder']), wrap((req, res) => {
    const users = listUsers(dataDir);
    res.json({ users });
  }));

  // Get user details
  router.get('/users/:id', requireUser, requireRole(['admin', 'founder']), wrap((req, res) => {
    const { findById } = require('./store');
    const user = findById(dataDir, req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found', code: 'not_found' });
    }
    res.json({ user: publicUserWithRole(user) });
  }));

  // Update user (role assignment)
  router.patch('/users/:id', requireUser, requireRole(['admin', 'founder']), wrap((req, res) => {
    const { canAssignRole } = require('./roles');
    const user = updateUser(dataDir, req.params.id, req.body);
    if (!user) {
      return res.status(404).json({ error: 'User not found', code: 'not_found' });
    }
    res.json({ user });
  }));

  // Delete user
  router.delete('/users/:id', requireUser, requireRole(['admin', 'founder']), wrap((req, res) => {
    const deleted = deleteUser(dataDir, req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'User not found', code: 'not_found' });
    }
    res.json({ deleted, ok: true });
  }));

  return router;
}

module.exports = { createAuthRouter };
