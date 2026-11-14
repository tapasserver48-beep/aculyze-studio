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
 *   POST   /api/chat/channels/:id/members { uid }         → { channel }   (invite)
 *   DELETE /api/chat/channels/:id/members/:uid            → { channel }   (remove)
 *
 *   GET    /api/chat/people                      → { people }      (directory)
 *   GET    /api/chat/unread                      → { unread }      (total badge)
 *   GET    /api/chat/find?q=                     → { people, channels, departments, answer }
 *                                                 (keyword scorer + LLM re-rank)
 *
 * Every route requires a signed-in account and is bound to `req.authUid`.
 * Permission tiers come from src/auth/roles.js: employees may read/post in
 * channels they joined and invite members, admins+ may create departments.
 */
const express = require('express');
const { requireUser } = require('../auth/session');
const { ROLES } = require('../auth/roles');
const store = require('./store');
const { reRank } = require('./aiFind');

function createChatRouter(options = {}) {
  const dataDir = options.dataDir;
  const router = express.Router();

  router.use(requireUser);

  const wrap = (handler) => (req, res) => {
    try {
      handler(req, res);
    } catch (err) {
      sendError(req, res, err);
    }
  };

  // Async twin of `wrap` — used by endpoints that may call the LLM.
  const wrapAsync = (handler) => (req, res) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((err) => sendError(req, res, err));
  };

  function sendError(req, res, err) {
    const status = (err && err.status) || 500;
    const code = (err && err.code) || 'failed';
    if (status >= 500) {
      console.warn(`[chat] ${req.method} ${req.originalUrl}: ${String((err && err.message) || err).slice(0, 200)}`);
    }
    res.status(status).json({ error: (err && err.message) || 'Something went wrong.', code });
  }

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

  // ---------- membership (member picker) ----------

  router.post('/channels/:id/members', wrap((req, res) => {
    const id = idParam(req, 'id');
    const channel = store.addMember(dataDir, req.authUid, id, (req.body || {}).uid);
    // Tell every open socket the roster changed so headers refresh live.
    if (typeof options.broadcast === 'function') {
      options.broadcast(id, { type: 'members', channel: id, action: 'add', by: req.authUid });
    }
    res.status(201).json({ channel });
  }));

  router.delete('/channels/:id/members/:uid', wrap((req, res) => {
    const id = idParam(req, 'id');
    const target = String(req.params.uid || '');
    const result = store.removeMember(dataDir, req.authUid, id, target);
    if (typeof options.broadcast === 'function') {
      options.broadcast(id, { type: 'members', channel: id, action: 'remove', uid: target, by: req.authUid });
    }
    // Self-leave reuses leaveChannel → { left, deleted } instead of a roster.
    if (result && result.left) {
      res.json({ left: true, deleted: !!result.deleted });
      return;
    }
    res.json({ channel: result });
  }));

  // ---------- directory + badges ----------

  router.get('/people', wrap((req, res) => {
    res.json({ people: store.listPeople(dataDir, req.authUid) });
  }));

  router.get('/unread', wrap((req, res) => {
    res.json({ unread: store.unreadCount(dataDir, req.authUid) });
  }));

  /**
   * AI-assisted directory search. Keyword hits come back instantly; the LLM
   * re-ranks them from a closed candidate list (never invents ids). When the
   * model is unreachable the keyword results are served as-is — `ai: false`
   * tells the UI to say so.
   */
  router.get('/find', wrapAsync(async (req, res) => {
    const base = store.findInWorkspace(dataDir, req.authUid, req.query.q);
    const { candidates, ...keyword } = base;
    const ranked = await reRank(base.query, candidates);
    if (ranked) {
      // Order the deterministic lists by the model's picks; keep any keyword
      // hits it didn't mention (so nothing that matched is silently dropped).
      const order = (list, ids, key) => {
        const byId = new Map(list.map((x) => [String(x[key]), x]));
        const out = [];
        for (const id of ids) {
          const hit = byId.get(String(id));
          if (hit) { out.push(hit); byId.delete(String(id)); }
        }
        for (const rest of byId.values()) out.push(rest);
        return out;
      };
      res.json({
        ...keyword,
        people: order(keyword.people, ranked.people, 'uid'),
        channels: order(keyword.channels, ranked.channels, 'id'),
        departments: order(keyword.departments, ranked.departments, 'id'),
        answer: ranked.answer,
        ai: true,
      });
      return;
    }
    res.json({ ...keyword, answer: '', ai: false });
  }));

  return router;
}

module.exports = { createChatRouter };
