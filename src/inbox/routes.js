/**
 * /api/inbox — human-to-human messaging for the Inbox workspace.
 *
 *   GET  /api/inbox/threads              → { threads: [...] }   (unread badges)
 *   GET  /api/inbox/contacts             → { contacts: [...] }  (local accounts)
 *   GET  /api/inbox/messages?peer=&since= → { messages, readTs } (poll cursor)
 *   POST /api/inbox/messages  { to, body, generated } → { message }
 *   POST /api/inbox/read      { peer }    → { readTs }
 *
 * Every route requires a signed-in account (401 otherwise) and is bound to
 * `req.authUid` — a caller can only read or write their own box, so there is
 * no `?as=` style identity parameter anywhere to abuse.
 *
 * `since` is a millisecond timestamp cursor: the client polls every ~2.5s
 * asking only for what it has not seen yet.
 */
const express = require('express');
const { requireUser } = require('../auth/session');
const { readDoc } = require('../auth/store');
const { boxIdForAccount, sendMessage, listThreads, listMessages, markRead, MAX_BODY } = require('./store');

function createInboxRouter(options = {}) {
  const dataDir = options.dataDir;
  const router = express.Router();

  // Body parsing is global (server.js mounts express.json() for every route).
  router.use(requireUser);

  const myId = (req) => boxIdForAccount(req.authUid);

  const wrap = (handler) => (req, res) => {
    try {
      handler(req, res);
    } catch (err) {
      const status = (err && err.status) || 500;
      const code = (err && err.code) || 'failed';
      if (status >= 500) {
        console.warn(`[inbox] ${req.method} ${req.originalUrl}: ${String(err && err.message || err).slice(0, 200)}`);
      }
      res.status(status).json({ error: (err && err.message) || 'Something went wrong.', code });
    }
  };

  router.get('/threads', wrap((req, res) => {
    res.json({ threads: listThreads(dataDir, myId(req)), me: myId(req) });
  }));

  /**
   * Registered local accounts as contacts — these are the peers that can
   * actually sign in and receive. Shown alongside the LMS employee list.
   */
  router.get('/contacts', wrap((req, res) => {
    const contacts = readDoc(dataDir).users
      .map((u) => ({ id: `usr-${u.id}`, name: u.name, role: 'Local account', kind: 'account' }))
      .filter((c) => c.id !== myId(req));
    res.json({ contacts });
  }));

  router.get('/messages', wrap((req, res) => {
    const out = listMessages(dataDir, myId(req), String(req.query.peer || ''), req.query.since);
    res.json(out);
  }));

  router.post('/messages', wrap((req, res) => {
    const body = req.body || {};
    const me = readDoc(dataDir).users.find((u) => u.id === req.authUid);

    const to = String(body.to || '');
    // Display name for the recipient's copy of the thread: prefer the real
    // registered name, fall back to whatever the client knows (employees).
    let toName = String(body.toName || '').trim().slice(0, 80);
    if (to.startsWith('usr-')) {
      const peer = readDoc(dataDir).users.find((u) => `usr-${u.id}` === to);
      if (peer) toName = peer.name;
    }

    const message = sendMessage(dataDir, {
      from: myId(req),
      fromName: (me && me.name) || 'Someone',
      to,
      toName,
      peerRole: String(body.toRole || '').trim().slice(0, 80),
      body: body.body,
      generated: !!body.generated,
    });

    res.status(201).json({ message, maxBody: MAX_BODY });
  }));

  router.post('/read', wrap((req, res) => {
    const readTs = markRead(dataDir, myId(req), String((req.body || {}).peer || ''));
    res.json({ readTs });
  }));

  return router;
}

module.exports = { createInboxRouter };
