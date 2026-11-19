/**
 * /api/auth — local login for Aculyze Studio.
 *
 *   POST /api/auth/register  { name, email, password } → 201 { user }
 *   POST /api/auth/login     { email, password }       → 200 { user }
 *   POST /api/auth/logout                             → 200 { ok }
 *   GET  /api/auth/me                                 → 200 { user: {…}|null }
 *   GET  /api/auth/setup                              → 200 { needed, codeSource }
 *   POST /api/auth/setup     { name, email, password, code }
 *                                                        → 201 { user } | 403/401
 *   GET  /api/auth/google                             → 302 → Google consent
 *   GET  /api/auth/google/callback                    → 302 → /?auth=google
 *
 * `/setup` is the first-admin bootstrap and is self-disabling: it only works
 * while the database has ZERO admin/founder accounts, and only with the
 * one-time setup code. See ./setup.js.
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
const {
  ROLES,
  ROLE_LIST,
  PAGE_LIST,
  ROLE_PAGES,
  canAssignRole,
  normalizePermissions,
  effectivePages
} = require('./roles');
const { createGoogleAuth } = require('./google');

function createAuthRouter(options = {}) {
  const router = express.Router();
  const dataDir = options.dataDir;

  // The login screen posts JSON with no cookies attached on purpose — never
  // to forward-cache an old session onto a fresh login response.
  // Body parsing is global (server.js mounts express.json() for every route),
  // so the field-level checks inside each handler bound the actual payload.

  // Promise-aware: the account store is async in Phase 1 (PostgreSQL), so a
  // handler may throw synchronously or reject — both land here.
  const wrap = (handler) => (req, res) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((err) => {
        const status = err && err.status ? err.status : 500;
        const code = (err && err.code) || 'failed';
        if (status >= 500) {
          console.warn(`[auth] ${req.method} ${req.originalUrl}: ${String(err && err.message || err).slice(0, 200)}`);
        }
        if (res.headersSent) return;
        res.status(status).json({ error: (err && err.message) || 'Something went wrong.', code });
      });
  };

  router.post('/register', wrap(async (req, res) => {
    const body = req.body || {};
    const user = await createUser(dataDir, {
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

  router.post('/login', wrap(async (req, res) => {
    const body = req.body || {};
    const user = await authenticate(dataDir, body.email, body.password);
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

  // -------- First-admin bootstrap (self-disabling) --------
  // A fresh deployment has no admin/founder, so the Admin page would be
  // unreachable. These two routes exist ONLY while that is true: the moment
  // one admin/founder exists they answer 403/`needed:false` forever.
  // POST additionally demands the one-time setup code, so an open window is
  // still not an open door. Full rules: ./setup.js.
  const {
    checkSetupCode,
    delayWrongCode,
    setupState,
    withSetupLock,
  } = require('./setup');

  // Public on purpose — the login screen asks before it offers the form.
  // Reveals nothing beyond "this install has no admin yet".
  router.get('/setup', wrap(async (req, res) => {
    res.json(await setupState(dataDir));
  }));

  router.post('/setup', wrap(async (req, res) => {
    const body = req.body || {};

    // Closure is checked first, OUTSIDE the serialisation lock: once an admin
    // exists the door is shut for good, so a late POST must not reach the code
    // check or sit behind a lock it no longer needs.
    const state = await setupState(dataDir);
    if (!state.needed) {
      return res.status(403).json({
        error: 'This workspace already has an administrator.',
        code: 'setup_complete',
      });
    }

    if (!checkSetupCode(body.code)) {
      // Also outside the lock — a wrong guess must never stall a legitimate
      // attempt that is waiting on it.
      await delayWrongCode();
      return res.status(401).json({ error: 'That setup code is not correct.', code: 'bad_setup_code' });
    }

    // Serialised: two concurrent posts carrying the right code must not both
    // pass the zero-admin check and both mint a founder. Re-check inside the
    // lock, because the state read above happened before it.
    const user = await withSetupLock(async () => {
      const again = await setupState(dataDir);
      if (!again.needed) return null;
      // 'founder' is the only sensible first account: an admin cannot assign
      // the founder role, so a first admin could never be upgraded later.
      return createUser(dataDir, {
        name: body.name,
        email: body.email,
        password: body.password,
        role: 'founder',
      });
    });

    if (!user) {
      return res.status(403).json({
        error: 'This workspace already has an administrator.',
        code: 'setup_complete',
      });
    }

    setSessionCookie(dataDir, req, res, user.id);
    res.status(201).json({ user: publicUser(user) });
  }));

  // -------- User Management (Admin routes) --------
  const adminOnly = [requireUser, requireRole(['admin', 'founder'])];

  // Shared guard: an admin may only touch users at or below their own rank.
  // Levels run founder(0) → admin(1) → manager(2) → employee(3), so the
  // actor must be at least as high (lower level number) as the target.
  const canManageTarget = (actorRole, targetRole) => {
    const actor = ROLES[actorRole];
    const target = ROLES[targetRole];
    if (!actor || !target) return false;
    return actor.level <= target.level;
  };

  // List all users (with permissions + resolved pages for the admin matrix)
  router.get('/users', ...adminOnly, wrap(async (req, res) => {
    const users = await listUsers(dataDir);
    res.json({ users });
  }));

  // Page catalogue + role defaults — what the permission matrix renders.
  router.get('/pages', ...adminOnly, (req, res) => {
    res.json({
      pages: PAGE_LIST,
      roles: ROLE_LIST.map((r) => ({ id: r, label: ROLES[r].label, defaults: ROLE_PAGES[r] })),
      // Roles this actor may assign — drives the create-form dropdown.
      assignable: ROLE_LIST.filter((r) => canAssignRole(req.user.role, r)),
    });
  });

  // Get user details
  router.get('/users/:id', ...adminOnly, wrap(async (req, res) => {
    const { findById } = require('./store');
    const user = await findById(dataDir, req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found', code: 'not_found' });
    }
    res.json({ user: publicUserWithRole(user) });
  }));

  // Create a user (admin use — role is validated against the actor's canAssign)
  router.post('/users', ...adminOnly, wrap(async (req, res) => {
    const body = req.body || {};
    const targetRole = String(body.role || 'employee').trim().toLowerCase();

    if (!ROLE_LIST.includes(targetRole)) {
      return res.status(422).json({ error: 'Unknown role.', code: 'validation' });
    }
    if (!canAssignRole(req.user.role, targetRole)) {
      return res.status(403).json({
        error: `Your role cannot assign the ${ROLES[targetRole].label} role.`,
        code: 'forbidden',
      });
    }

    const user = await createUser(dataDir, {
      name: body.name,
      email: body.email,
      password: body.password,
      role: targetRole,
      permissions: body.permissions,
    });
    // The admin stays signed in — no session cookie is issued here.
    res.status(201).json({ user: publicUserWithRole(user) });
  }));

  // Update user (role assignment / rename)
  router.patch('/users/:id', ...adminOnly, wrap(async (req, res) => {
    const body = req.body || {};
    const { findById } = require('./store');
    const target = await findById(dataDir, req.params.id);
    if (!target) {
      return res.status(404).json({ error: 'User not found', code: 'not_found' });
    }

    const updates = {};
    if (body.role !== undefined) {
      const targetRole = String(body.role).trim().toLowerCase();
      if (!ROLE_LIST.includes(targetRole)) {
        return res.status(422).json({ error: 'Unknown role.', code: 'validation' });
      }
      if (!canAssignRole(req.user.role, targetRole)) {
        return res.status(403).json({
          error: `Your role cannot assign the ${ROLES[targetRole].label} role.`,
          code: 'forbidden',
        });
      }
      if (!canManageTarget(req.user.role, target.role)) {
        return res.status(403).json({ error: 'You cannot modify a user above your role.', code: 'forbidden' });
      }
      updates.role = targetRole;
    }
    if (body.name !== undefined) updates.name = body.name;
    if (body.permissions !== undefined) updates.permissions = normalizePermissions(body.permissions);

    const user = await updateUser(dataDir, req.params.id, updates);
    res.json({ user });
  }));

  // Read a user's raw permission overrides + resolved pages.
  router.get('/users/:id/permissions', ...adminOnly, wrap(async (req, res) => {
    const { findById } = require('./store');
    const user = await findById(dataDir, req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found', code: 'not_found' });
    }
    const role = user.role || 'employee';
    const permissions = normalizePermissions(user.permissions);
    res.json({ role, permissions, pages: effectivePages(role, permissions) });
  }));

  // Replace a user's permission overrides (full matrix save).
  router.put('/users/:id/permissions', ...adminOnly, wrap(async (req, res) => {
    const body = req.body || {};
    const { findById } = require('./store');
    const target = await findById(dataDir, req.params.id);
    if (!target) {
      return res.status(404).json({ error: 'User not found', code: 'not_found' });
    }
    if (!canManageTarget(req.user.role, target.role)) {
      return res.status(403).json({ error: 'You cannot modify a user above your role.', code: 'forbidden' });
    }
    const permissions = normalizePermissions(body.permissions);
    const user = await updateUser(dataDir, req.params.id, { permissions });
    const role = (user && user.role) || 'employee';
    res.json({ user, permissions: normalizePermissions(user && user.permissions), pages: effectivePages(role, permissions) });
  }));

  // Delete user — never yourself, never someone above your own role.
  router.delete('/users/:id', ...adminOnly, wrap(async (req, res) => {
    if (req.params.id === req.authUid) {
      return res.status(400).json({ error: 'You cannot delete your own account.', code: 'validation' });
    }
    const { findById } = require('./store');
    const target = await findById(dataDir, req.params.id);
    if (!target) {
      return res.status(404).json({ error: 'User not found', code: 'not_found' });
    }
    if (!canManageTarget(req.user.role, target.role)) {
      return res.status(403).json({ error: 'You cannot delete a user above your role.', code: 'forbidden' });
    }
    const deleted = await deleteUser(dataDir, req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'User not found', code: 'not_found' });
    }
    res.json({ deleted, ok: true });
  }));

  return router;
}

module.exports = { createAuthRouter };
