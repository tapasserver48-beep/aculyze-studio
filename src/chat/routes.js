/**
 * /api/chat — Slack-style group messaging (departments + channels).
 *
 *   GET    /api/chat/departments                 → { departments }
 *   POST   /api/chat/departments      { name }   → { department }   (admin+)
 *   POST   /api/chat/departments/:id/join        → { department }
 *   POST   /api/chat/departments/:id/leave       → { department }
 *
 *   GET    /api/chat/channels                    → { channels }   (mine, unread badges)
 *   POST   /api/chat/channels         { name }   → { channel }    (manager+)
 *   GET    /api/chat/channels/:id                 → { channel }    (members, roles)
 *   POST   /api/chat/channels/:id/join            → { channel }
 *   POST   /api/chat/channels/:id/leave           → { channel }
 *   GET    /api/chat/channels/:id/messages?since=&limit= → { messages }
 *   POST   /api/chat/channels/:id/messages { body }       → { message }
 *   POST   /api/chat/channels/:id/read  { ts }   → { readTs }
 *
 *   GET    /api/chat/people                      → { people }      (directory)
 *   GET    /api/chat/unread                      → { unread }      (total badge)
 *
 * Every route requires a signed-in account and is bound to `req.authUid`.
 * Permission tiers come from src/auth/roles.js: employees may read/post in
 * channels they joined, managers+ may create channels, admins+ may create
 * departments.
 */
const express = require('express');
const { requireUser } = require('../auth/session');
const { ROLES } = require('../auth/roles');
const store = require('./store');

function createChatRouter(options = {}) {
  const dataDir = options.dataDir;
  const router = express.Router();

  router.use(requireUser);

  const wrap = (handler) => (req, res) => {
    try {
      handler(req, res);
    } catch (err) {
      const status = (err && err.status) || 500;
      const code = (err && err.code) || 'failed';
      if (status >= 500) {
        console.warn(`[chat] ${req.method} ${req.originalUrl}: ${String((err && err.message) || err).slice(0, 200)}`);
      }
      res.status(status).json({ error: (err && err.message) || 'Something went wrong.', code });
    }
  };

  const myRole = (req) => ((req.user && req.user.role) || 'employee');
  const roleLevel = (role) => (ROLES[role] ? ROLES[role].level : 99);
  const idParam = (req, name) => {
    const id = Number(req.params[name]);
    if (!Number.isInteger(id) || id <= 0) {
      throw new store.ChatError(400, 'validation', 'Unknown id.');
    }
    return id;
  };

  // ---------- departments ----------

  router.get('/departments', wrap((req, res) => {
    res.json({ departments: store.listDepartments(dataDir, req.authUid) });
  }));

  router.post('/departments', wrap((req, res) => {
    // founder + admin only (levels 0–1).
    if (roleLevel(myRole(req)) > 1) {
      throw new store.ChatError(403, 'permission', 'Only founders and admins can create departments.');
    }
    const department = store.createDepartment(dataDir, req.authUid, (req.body || {}).name);
    res.status(201).json({ department });
  }));

  router.post('/departments/:id/join', wrap((req, res) => {
    res.json({ department: store.joinDepartment(dataDir, req.authUid, idParam(req, 'id')) });
  }));

  router.post('/departments/:id/leave', wrap((req, res) => {
    res.json({ department: store.leaveDepartment(dataDir, req.authUid, idParam(req, 'id')) });
  }));

  // ---------- channels ----------

  router.get('/channels', wrap((req, res) => {
    res.json({ channels: store.listChannels(dataDir, req.authUid) });
  }));

  router.post('/channels', wrap((req, res) => {
    // Any signed-in member may create a group channel (Slack-style);
    // departments stay admin-only — they shape the org, not a chat room.
    const channel = store.createChannel(dataDir, req.authUid, (req.body || {}).name);
    res.status(201).json({ channel });
  }));

  router.get('/channels/:id', wrap((req, res) => {
    res.json({ channel: store.getChannel(dataDir, req.authUid, idParam(req, 'id')) });
  }));

  router.post('/channels/:id/join', wrap((req, res) => {
    res.json({ channel: store.joinChannel(dataDir, req.authUid, idParam(req, 'id')) });
  }));

  router.post('/channels/:id/leave', wrap((req, res) => {
    res.json({ channel: store.leaveChannel(dataDir, req.authUid, idParam(req, 'id')) });
  }));

  router.get('/channels/:id/messages', wrap((req, res) => {
    res.json(store.listMessages(dataDir, req.authUid, idParam(req, 'id'), {
      since: req.query.since,
      limit: req.query.limit,
    }));
  }));

  router.post('/channels/:id/messages', wrap((req, res) => {
    const body = req.body || {};
    const message = store.sendMessage(dataDir, req.authUid, idParam(req, 'id'), body.body);
    // Push to every connected socket watching this channel (see realtime.js).
    if (typeof options.broadcast === 'function') {
      options.broadcast(message.channel, { type: 'message', message });
    }
    res.status(201).json({ message, maxBody: store.MAX_BODY });
  }));

  router.post('/channels/:id/read', wrap((req, res) => {
    const body = req.body || {};
    res.json(store.markRead(dataDir, req.authUid, idParam(req, 'id'), body.ts));
  }));

  // ---------- directory + badges ----------

  router.get('/people', wrap((req, res) => {
    res.json({ people: store.listPeople(dataDir, req.authUid) });
  }));

  router.get('/unread', wrap((req, res) => {
    res.json({ unread: store.unreadCount(dataDir, req.authUid) });
  }));

  return router;
}

module.exports = { createChatRouter };
