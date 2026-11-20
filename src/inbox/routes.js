/**
 * /api/inbox — human-to-human messaging for the Inbox workspace.
 *
 *   GET  /api/inbox/threads              → { threads: [...] }   (unread badges)
 *   GET  /api/inbox/contacts             → { contacts: [...] }  (local accounts)
 *   GET  /api/inbox/messages?peer=&since= → { messages, readTs } (poll cursor)
 *   POST /api/inbox/messages  { to, body, generated, attachments } → { message }
 *   POST /api/inbox/messages/delete { id, scope }  → { id, scope }
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
const { boxIdForAccount, sendMessage, listThreads, listMessages, markRead, deleteMessage, MAX_BODY } = require('./store');

function createInboxRouter(options = {}) {
  const dataDir = options.dataDir;
  const router = express.Router();

  // Body parsing is global (server.js mounts express.json() for every route).
  router.use(requireUser);

  const myId = (req) => boxIdForAccount(req.authUid);

  // Promise-aware: the store is async in Phase 1 (PostgreSQL), so a handler
  // may throw synchronously or reject — both land here.
  const wrap = (handler) => (req, res) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((err) => {
        const status = (err && err.status) || 500;
        const code = (err && err.code) || 'failed';
        if (status >= 500) {
          console.warn(`[inbox] ${req.method} ${req.originalUrl}: ${String(err && err.message || err).slice(0, 200)}`);
        }
        if (res.headersSent) return;
        res.status(status).json({ error: (err && err.message) || 'Something went wrong.', code });
      });
  };

  router.get('/threads', wrap(async (req, res) => {
    res.json({ threads: await listThreads(dataDir, myId(req)), me: myId(req) });
  }));

  /**
   * Registered local accounts as contacts — these are the peers that can
   * actually sign in and receive. The Inbox page lists accounts only.
   * Also includes AI employees as distinct contacts.
   */
  router.get('/contacts', wrap(async (req, res) => {
    // Human users (local accounts)
    const localContacts = readDoc(dataDir).users
      .map((u) => ({ id: `usr-${u.id}`, name: u.name, role: 'Human employee', kind: 'account' }))
      .filter((c) => c.id !== myId(req));

    // AI employees
    const { listEmployees } = require('../employees/store');
    let aiContacts = [];
    try {
      const employees = await listEmployees(dataDir);
      aiContacts = employees
        .filter(e => e.status === 'active')
        .map((e) => ({ 
          id: e.id, 
          name: e.name, 
          role: e.designation || 'AI Employee', 
          kind: 'ai',
          employee_code: e.employee_code,
          capabilities: e.capabilities || []
        }));
    } catch {
      // AI employee store not available, return only human contacts
    }

    res.json({ contacts: [...localContacts, ...aiContacts] });
  }));

  router.get('/messages', wrap(async (req, res) => {
    const out = await listMessages(dataDir, myId(req), String(req.query.peer || ''), req.query.since);
    res.json(out);
  }));

  router.post('/messages', wrap(async (req, res) => {
    const body = req.body || {};
    const me = readDoc(dataDir).users.find((u) => u.id === req.authUid);

    const to = String(body.to || '');
    // Display name for the recipient's copy of the thread: prefer the real
    // registered name, fall back to whatever the client knows (employees).
    let toName = String(body.toName || '').trim().slice(0, 80);
    
    if (to.startsWith('usr-')) {
      const peer = readDoc(dataDir).users.find((u) => `usr-${u.id}` === to);
      if (peer) toName = peer.name;
    } else if (to.startsWith('emp-ai-')) {
      // AI employee recipient
      const { findById } = require('../employees/store');
      const employee = await findById(dataDir, to);
      if (employee) toName = employee.name || toName;
    }

    const message = await sendMessage(dataDir, {
      from: myId(req),
      fromName: (me && me.name) || 'Someone',
      to,
      toName,
      peerRole: String(body.toRole || '').trim().slice(0, 80),
      body: body.body,
      generated: !!body.generated,
      // Photos and voice notes ride along inline (data URLs); the store
      // enforces the allow-list and per-file size caps.
      attachments: body.attachments,
    });

    res.status(201).json({ message, maxBody: MAX_BODY });
  }));

  /**
   * Delete a message from this conversation. `scope`:
   *   'everyone' (default) — sender only; both copies become a tombstone the
   *                          other side renders as "Message deleted".
   *   'me'                 — this account's copy only.
   */
  router.post('/messages/delete', wrap(async (req, res) => {
    const body = req.body || {};
    const scope = body.scope === 'me' ? 'me' : 'everyone';
    const out = await deleteMessage(dataDir, myId(req), body.id, scope);
    res.json(out);
  }));

  router.post('/read', wrap(async (req, res) => {
    const readTs = await markRead(dataDir, myId(req), String((req.body || {}).peer || ''));
    res.json({ readTs });
  }));

  return router;
}

module.exports = { createInboxRouter };
