/**
 * Inbox — server-side message store (flat JSON, no database).
 *
 * One box file per participant under `data/inbox/<peerId>.json`, where a
 * participant id is either:
 *   `usr-<uid>`  a registered local account (can log in and read its box)
 *   `emp-<id>`   an Aculyze LMS employee contact (addressable, persists)
 *
 * Every send writes the message into BOTH boxes (sender's copy + recipient's
 * copy), so each side reads only its own file:
 *   - sender:   threads keyed by the peer id
 *   - receiver: threads keyed by the sender id
 * That makes listing, polling (`since`) and unread counts a single-file read
 * per user — no scanning, no join, no index.
 *
 * Message shape (wire + disk):
 *   { id, from, to, body, ts, generated }
 * `generated: true` marks text the AI drafted and the user confirmed.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PEER_ID_RE = /^[a-zA-Z0-9_.:@-]{1,120}$/;
const MAX_MESSAGES_PER_THREAD = 500;
const MAX_BODY = 4000;

function inboxDir(dataDir) {
  return path.join(dataDir, 'inbox');
}

/** Account id of the logged-in user, in peer-id form. */
function boxIdForAccount(uid) {
  return `usr-${uid}`;
}

function assertPeerId(id) {
  const s = String(id || '');
  if (!PEER_ID_RE.test(s)) {
    const err = new Error('Unknown conversation participant.');
    err.status = 400;
    err.code = 'validation';
    throw err;
  }
  return s;
}

/**
 * Deterministic, path-safe file name for a peer id: the readable part keeps
 * `usr-alice` / `emp-12` debuggable, the 8-char digest prevents collisions
 * between ids that sanitize to the same readable part.
 */
function boxFile(dataDir, peerId) {
  const id = assertPeerId(peerId);
  const readable = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'peer';
  const digest = crypto.createHash('sha1').update(id).digest('hex').slice(0, 8);
  return path.join(inboxDir(dataDir), `${readable}_${digest}.json`);
}

function emptyBox(owner) {
  return { owner, threads: {} };
}

function loadBox(dataDir, peerId) {
  try {
    const doc = JSON.parse(fs.readFileSync(boxFile(dataDir, peerId), 'utf8'));
    return {
      owner: doc.owner || peerId,
      threads: doc.threads && typeof doc.threads === 'object' ? doc.threads : {},
    };
  } catch {
    // Missing or unreadable file = an empty box. Callers only persist it
    // once they actually mutate something (sendMessage / markRead).
    return emptyBox(peerId);
  }
}

function saveBox(dataDir, peerId, box) {
  const file = boxFile(dataDir, peerId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(box), 'utf8');
  fs.renameSync(tmp, file);
}

function threadOf(box, peerId, peerName, peerRole) {
  if (!box.threads[peerId]) {
    box.threads[peerId] = {
      peerId,
      peerName: peerName || '',
      peerRole: peerRole || '',
      readTs: 0,
      messages: [],
    };
  } else {
    // Adopt a real name over an empty one, and heal the placeholder that
    // older writes stored (a thread used to inherit its own peer id as name).
    const current = box.threads[peerId].peerName;
    if (peerName && (!current || current === peerId)) box.threads[peerId].peerName = peerName;
  }
  if (peerRole && !box.threads[peerId].peerRole) box.threads[peerId].peerRole = peerRole;
  return box.threads[peerId];
}

/**
 * Deliver one message to both participants.
 * Returns the stored message (with its server-assigned id + timestamp).
 */
function sendMessage(dataDir, { from, fromName, to, toName, peerRole, body, generated }) {
  const senderId = assertPeerId(from);
  const recipientId = assertPeerId(to);
  const text = String(body || '').trim();
  if (!text) {
    const err = new Error('Message cannot be empty.');
    err.status = 400;
    err.code = 'validation';
    throw err;
  }
  if (text.length > MAX_BODY) {
    const err = `Message is too long (max ${MAX_BODY} characters).`;
    const e = new Error(err);
    e.status = 400;
    e.code = 'validation';
    throw e;
  }

  const message = {
    id: crypto.randomUUID(),
    from: senderId,
    to: recipientId,
    body: text.slice(0, MAX_BODY),
    ts: Date.now(),
    generated: !!generated,
  };

  // Sender copy: thread keyed by the recipient.
  const senderBox = loadBox(dataDir, senderId);
  const senderThread = threadOf(senderBox, recipientId, toName, peerRole);
  senderThread.messages.push(message);
  if (senderThread.messages.length > MAX_MESSAGES_PER_THREAD) {
    senderThread.messages = senderThread.messages.slice(-MAX_MESSAGES_PER_THREAD);
  }
  // Sending counts as reading that thread — no self-unread badge.
  senderThread.readTs = Math.max(senderThread.readTs || 0, message.ts);
  saveBox(dataDir, senderId, senderBox);

  // Recipient copy: thread keyed by the sender. readTs stays untouched so
  // the message shows up as unread until the recipient opens the thread.
  const recipientBox = loadBox(dataDir, recipientId);
  const recipientThread = threadOf(recipientBox, senderId, fromName, '');
  recipientThread.messages.push(message);
  if (recipientThread.messages.length > MAX_MESSAGES_PER_THREAD) {
    recipientThread.messages = recipientThread.messages.slice(-MAX_MESSAGES_PER_THREAD);
  }
  saveBox(dataDir, recipientId, recipientBox);

  return message;
}

function previewOf(thread) {
  const last = thread.messages[thread.messages.length - 1];
  return last ? last.body : '';
}

function unreadOf(thread, myId) {
  let n = 0;
  for (const m of thread.messages) {
    if (m.from !== myId && m.ts > (thread.readTs || 0)) n += 1;
  }
  return n;
}

/** All conversations for the signed-in user, newest activity first. */
function listThreads(dataDir, myId) {
  const box = loadBox(dataDir, myId);
  return Object.values(box.threads)
    .map((t) => {
      const last = t.messages[t.messages.length - 1];
      return {
        peerId: t.peerId,
        peerName: t.peerName || t.peerId, // display fallback when unknown
        peerRole: t.peerRole || '',
        preview: previewOf(t),
        lastTs: last ? last.ts : 0,
        unread: unreadOf(t, myId),
        readTs: t.readTs || 0,
      };
    })
    .sort((a, b) => b.lastTs - a.lastTs);
}

/**
 * Messages with one peer newer than `since` (a ts cursor; omit for history).
 * Returns { messages, readTs, peerId }.
 */
function listMessages(dataDir, myId, peer, since) {
  const peerId = assertPeerId(peer);
  const box = loadBox(dataDir, myId);
  const thread = box.threads[peerId];
  if (!thread) return { peerId, messages: [], readTs: 0 };
  const sinceTs = Number(since) || 0;
  return {
    peerId,
    messages: thread.messages.filter((m) => m.ts > sinceTs),
    readTs: thread.readTs || 0,
  };
}

/** Mark a thread read up to now. Returns the new readTs. */
function markRead(dataDir, myId, peer) {
  const peerId = assertPeerId(peer);
  const box = loadBox(dataDir, myId);
  const thread = box.threads[peerId];
  // Merely opening an empty conversation must not fabricate a thread (and a
  // placeholder display name) on disk — there is nothing read yet.
  if (!thread) return Date.now();
  thread.readTs = Date.now();
  saveBox(dataDir, myId, box);
  return thread.readTs;
}

module.exports = {
  MAX_BODY,
  boxIdForAccount,
  assertPeerId,
  sendMessage,
  listThreads,
  listMessages,
  markRead,
};
