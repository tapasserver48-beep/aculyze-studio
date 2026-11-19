/**
 * Inbox — server-side message store.
 *
 * Phase 1 storage backends (chosen by ../db/pg.js, i.e. DATABASE_URL):
 *  - PostgreSQL: rows in `inbox_threads` + `inbox_messages`, keyed by box.
 *  - Flat JSON otherwise: one box file per participant under
 *    `data/inbox/<peerId>.json`, so local development needs no database.
 *
 * A participant id is either:
 *   `usr-<uid>`  a registered local account (can log in and read its box)
 *   `emp-<id>`   an Aculyze LMS employee contact (addressable, persists)
 *
 * Every send writes the message into BOTH boxes (sender's copy + recipient's
 * copy), so each side reads only its own box:
 *   - sender:   threads keyed by the recipient id
 *   - receiver: threads keyed by the sender id
 * That makes listing, polling (`since`) and unread counts a single-box read
 * per user — no cross-user scan.
 *
 * Message shape (wire + JSON disk):
 *   { id, from, to, body, ts, generated, attachments, deletedAt }
 * `generated: true` marks text the AI drafted and the user confirmed.
 * `attachments` are inline data-URL files ({ kind, mime, data, name, dur })
 * so both storage backends carry photos and voice notes with no file store.
 * `deletedAt` is a tombstone timestamp: when set the body and attachments
 * have been cleared by "delete for everyone" and both sides render a
 * placeholder instead of the content.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pg = require('../db/pg');

const PEER_ID_RE = /^[a-zA-Z0-9_.:@-]{1,120}$/;
const MAX_MESSAGES_PER_THREAD = 500;
const MAX_BODY = 4000;

/* ---- attachments (photos + voice notes, sent inline as data URLs) ---- */
const MAX_ATTACHMENTS = 6;
/** Base64 characters per file (~2.6 MB of binary — matches the UI's 2 MB cap
 *  with headroom for the encoding). */
const MAX_ATTACHMENT_CHARS = 3500000;
/** Base64 characters for everything in one message (express allows 32 MB). */
const MAX_MESSAGE_CHARS = 6000000;
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']);
const AUDIO_MIME = new Set([
  'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/aac',
]);
const DATA_URL_RE = /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/i;

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

function validationError(message) {
  const err = new Error(message);
  err.status = 400;
  err.code = 'validation';
  return err;
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
 * Validate the inline attachments a message may carry. Anything not on the
 * image/audio allow-list is rejected here rather than at render time, so a
 * hostile client can never smuggle `text/html` data into another user's bubble.
 */
function sanitizeAttachments(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw validationError('Attachments must be a list.');
  if (raw.length > MAX_ATTACHMENTS) {
    throw validationError(`You can attach up to ${MAX_ATTACHMENTS} files per message.`);
  }
  const out = [];
  let total = 0;
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue;
    const kind = a.kind === 'image' || a.kind === 'audio' ? a.kind : null;
    if (!kind) throw validationError('Each attachment needs a type (image or audio).');
    const mime = String(a.mime || '').toLowerCase().split(';')[0].trim();
    const allowed = kind === 'image' ? IMAGE_MIME : AUDIO_MIME;
    if (!allowed.has(mime)) {
      throw validationError(kind === 'image' ? 'That image type is not supported.' : 'That audio type is not supported.');
    }
    const data = String(a.data || '').replace(/\s+/g, '');
    if (!DATA_URL_RE.test(data) || !data.startsWith(`data:${mime}`)) {
      throw validationError('That attachment could not be read.');
    }
    if (data.length > MAX_ATTACHMENT_CHARS) throw validationError('That file is too large (max 2 MB).');
    total += data.length;
    if (total > MAX_MESSAGE_CHARS) throw validationError('This message is too large.');
    out.push({
      kind,
      mime,
      data,
      name: String(a.name || '').slice(0, 120),
      dur: Math.max(0, Math.min(600, Number(a.dur) || 0)),
    });
  }
  return out;
}

/** Validate + build the stored message (shared by both backends).
 *  `ts` is only ever supplied by internal callers (the seed script) — the
 *  HTTP route always takes the server clock. */
function buildMessage({ from, to, body, generated, attachments, ts }) {
  const senderId = assertPeerId(from);
  const recipientId = assertPeerId(to);
  const text = String(body || '').trim();
  const atts = sanitizeAttachments(attachments);
  if (!text && !atts.length) throw validationError('Message cannot be empty.');
  if (text.length > MAX_BODY) {
    throw validationError(`Message is too long (max ${MAX_BODY} characters).`);
  }
  return {
    id: crypto.randomUUID(),
    from: senderId,
    to: recipientId,
    body: text.slice(0, MAX_BODY),
    ts: Number(ts) > 0 ? Number(ts) : Date.now(),
    generated: !!generated,
    attachments: atts,
  };
}

/**
 * Deliver one message to both participants.
 * Returns the stored message (with its server-assigned id + timestamp).
 */
async function sendMessage(dataDir, { from, fromName, to, toName, peerRole, body, generated, attachments, ts }) {
  const message = buildMessage({ from, to, body, generated, attachments, ts });

  if (pg.enabled()) {
    const senderId = message.from;
    const recipientId = message.to;

    // Sender copy: thread keyed by the recipient. Sending counts as reading
    // that thread — no self-unread badge.
    await pg.query(
      `INSERT INTO inbox_threads (box_owner, peer_id, peer_name, peer_role, read_ts)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (box_owner, peer_id) DO UPDATE SET
         peer_name  = CASE WHEN inbox_threads.peer_name = '' OR inbox_threads.peer_name = inbox_threads.peer_id
                           THEN EXCLUDED.peer_name ELSE inbox_threads.peer_name END,
         peer_role  = CASE WHEN inbox_threads.peer_role = '' THEN EXCLUDED.peer_role ELSE inbox_threads.peer_role END,
         read_ts    = GREATEST(inbox_threads.read_ts, EXCLUDED.read_ts)`,
      [senderId, recipientId, toName || '', peerRole || '', message.ts]
    );

    // Recipient copy: thread keyed by the sender. read_ts stays untouched so
    // the message shows up as unread until the recipient opens the thread.
    await pg.query(
      `INSERT INTO inbox_threads (box_owner, peer_id, peer_name, peer_role, read_ts)
       VALUES ($1, $2, $3, '', 0)
       ON CONFLICT (box_owner, peer_id) DO UPDATE SET
         peer_name  = CASE WHEN inbox_threads.peer_name = '' OR inbox_threads.peer_name = inbox_threads.peer_id
                           THEN EXCLUDED.peer_name ELSE inbox_threads.peer_name END`,
      [recipientId, senderId, fromName || '']
    );

    for (const [boxOwner, peerId] of [[senderId, recipientId], [recipientId, senderId]]) {
      await pg.query(
        `INSERT INTO inbox_messages (id, box_owner, peer_id, from_id, to_id, body, ts, generated, attachments, deleted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 0)`,
        [message.id, boxOwner, peerId, message.from, message.to, message.body, message.ts,
         message.generated, JSON.stringify(message.attachments || [])]
      );
      // Trim to MAX_MESSAGES_PER_THREAD, same as the file backend's slice().
      await pg.query(
        `DELETE FROM inbox_messages
          WHERE box_owner = $1 AND peer_id = $2
            AND ts < (SELECT ts FROM inbox_messages
                       WHERE box_owner = $1 AND peer_id = $2
                       ORDER BY ts DESC OFFSET $3 LIMIT 1)`,
        [boxOwner, peerId, MAX_MESSAGES_PER_THREAD - 1]
      );
    }
    return message;
  }

  // ---- JSON backend (unchanged behaviour) ----

  // Sender copy: thread keyed by the recipient.
  const senderBox = loadBox(dataDir, message.from);
  const senderThread = threadOf(senderBox, message.to, toName, peerRole);
  senderThread.messages.push(message);
  if (senderThread.messages.length > MAX_MESSAGES_PER_THREAD) {
    senderThread.messages = senderThread.messages.slice(-MAX_MESSAGES_PER_THREAD);
  }
  // Sending counts as reading that thread — no self-unread badge.
  senderThread.readTs = Math.max(senderThread.readTs || 0, message.ts);
  saveBox(dataDir, message.from, senderBox);

  // Recipient copy: thread keyed by the sender. readTs stays untouched so
  // the message shows up as unread until the recipient opens the thread.
  const recipientBox = loadBox(dataDir, message.to);
  const recipientThread = threadOf(recipientBox, message.from, fromName, '');
  recipientThread.messages.push(message);
  if (recipientThread.messages.length > MAX_MESSAGES_PER_THREAD) {
    recipientThread.messages = recipientThread.messages.slice(-MAX_MESSAGES_PER_THREAD);
  }
  saveBox(dataDir, message.to, recipientBox);

  return message;
}

/**
 * Conversation-list preview for the newest message: real text when there is
 * any, otherwise what the attachments are, otherwise the deletion tombstone.
 */
function previewOf(message) {
  if (!message) return '';
  if (message.deletedAt) return 'Message deleted';
  const text = String(message.body || '').trim();
  if (text) return text;
  const atts = Array.isArray(message.attachments) ? message.attachments : [];
  if (atts.some((a) => a && a.kind === 'image')) return 'Photo';
  if (atts.length) return 'Voice message';
  return '';
}

function unreadOf(thread, myId) {
  let n = 0;
  for (const m of thread.messages) {
    // A message deleted for everyone is no longer content — it must not keep
    // a badge lit on either side.
    if (m.deletedAt) continue;
    if (m.from !== myId && m.ts > (thread.readTs || 0)) n += 1;
  }
  return n;
}

/** All conversations for the signed-in user, newest activity first. */
async function listThreads(dataDir, myId) {
  if (pg.enabled()) {
    const { rows } = await pg.query(
      'SELECT peer_id, peer_name, peer_role, read_ts FROM inbox_threads WHERE box_owner = $1',
      [myId]
    );
    // Per-thread lookups instead of one correlated query: a user has a
    // handful of threads, and these stay index-friendly on both backends.
    const out = [];
    for (const r of rows) {
      const peerId = r.peer_id;
      const readTs = Number(r.read_ts) || 0;
      const [last, unread] = await Promise.all([
        pg.query(
          'SELECT body, ts, attachments, deleted_at FROM inbox_messages WHERE box_owner = $1 AND peer_id = $2 ORDER BY ts DESC LIMIT 1',
          [myId, peerId]
        ),
        pg.query(
          'SELECT count(*)::int AS n FROM inbox_messages WHERE box_owner = $1 AND peer_id = $2 AND from_id <> $1 AND ts > $3 AND deleted_at = 0',
          [myId, peerId, readTs]
        ),
      ]);
      const lastRow = last.rows[0];
      out.push({
        peerId,
        peerName: r.peer_name || peerId, // display fallback when unknown
        peerRole: r.peer_role || '',
        preview: lastRow
          ? previewOf({
              body: lastRow.body,
              attachments: lastRow.attachments || [],
              deletedAt: Number(lastRow.deleted_at) || 0,
            })
          : '',
        lastTs: lastRow ? Number(lastRow.ts) || 0 : 0,
        unread: Number(unread.rows[0] && unread.rows[0].n) || 0,
        readTs,
      });
    }
    out.sort((a, b) => b.lastTs - a.lastTs);
    return out;
  }

  const box = loadBox(dataDir, myId);
  return Object.values(box.threads)
    .map((t) => {
      const last = t.messages[t.messages.length - 1];
      return {
        peerId: t.peerId,
        peerName: t.peerName || t.peerId, // display fallback when unknown
        peerRole: t.peerRole || '',
        preview: previewOf(last),
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
async function listMessages(dataDir, myId, peer, since) {
  const peerId = assertPeerId(peer);

  if (pg.enabled()) {
    const sinceTs = Number(since) || 0;
    const [msgs, threads] = await Promise.all([
      pg.query(
        `SELECT id, from_id, to_id, body, ts, generated, attachments, deleted_at
           FROM inbox_messages
          WHERE box_owner = $1 AND peer_id = $2 AND (ts > $3 OR deleted_at > $3)
          ORDER BY ts`,
        [myId, peerId, sinceTs]
      ),
      pg.query('SELECT read_ts FROM inbox_threads WHERE box_owner = $1 AND peer_id = $2', [myId, peerId]),
    ]);
    return {
      peerId,
      messages: msgs.rows.map((m) => ({
        id: m.id,
        from: m.from_id,
        to: m.to_id,
        body: m.body,
        ts: Number(m.ts) || 0,
        generated: !!m.generated,
        attachments: m.attachments || [],
        deletedAt: Number(m.deleted_at) || 0,
        deleted: Number(m.deleted_at) > 0,
      })),
      readTs: threads.rows[0] ? Number(threads.rows[0].read_ts) || 0 : 0,
    };
  }

  const box = loadBox(dataDir, myId);
  const thread = box.threads[peerId];
  if (!thread) return { peerId, messages: [], readTs: 0 };
  const sinceTs = Number(since) || 0;
  // `since` is a message-ts cursor, but a tombstone must also be re-delivered
  // after it happens: deletions of OLDER messages would otherwise never reach
  // the other side until the thread is reopened.
  const messages = thread.messages
    .filter((m) => m.ts > sinceTs || (m.deletedAt || 0) > sinceTs)
    .map((m) => ({
      id: m.id,
      from: m.from,
      to: m.to,
      body: m.body,
      ts: m.ts,
      generated: !!m.generated,
      attachments: m.attachments || [],
      deletedAt: m.deletedAt || 0,
      deleted: !!m.deletedAt,
    }));
  return { peerId, messages, readTs: thread.readTs || 0 };
}

/** Mark a thread read up to `at` (defaults to now). Returns the new readTs.
 *  `at` exists for the inbox seed script, which needs a thread left with a
 *  specific unread boundary; the HTTP route always uses the default. */
async function markRead(dataDir, myId, peer, at) {
  const peerId = assertPeerId(peer);
  const when = Number(at) > 0 ? Number(at) : Date.now();

  if (pg.enabled()) {
    // Merely opening an empty conversation must not fabricate a thread (and
    // a placeholder display name) — there is nothing read yet.
    const { rows } = await pg.query(
      'UPDATE inbox_threads SET read_ts = $3 WHERE box_owner = $1 AND peer_id = $2 RETURNING read_ts',
      [myId, peerId, when]
    );
    return rows[0] ? Number(rows[0].read_ts) || when : when;
  }

  const box = loadBox(dataDir, myId);
  const thread = box.threads[peerId];
  // Merely opening an empty conversation must not fabricate a thread (and a
  // placeholder display name) on disk — there is nothing read yet.
  if (!thread) return when;
  thread.readTs = when;
  saveBox(dataDir, myId, box);
  return thread.readTs;
}

function notFoundError() {
  const err = new Error('That message no longer exists.');
  err.status = 404;
  err.code = 'not_found';
  return err;
}

function forbiddenError(message) {
  const err = new Error(message);
  err.status = 403;
  err.code = 'forbidden';
  return err;
}

/**
 * Remove a message from a conversation.
 *
 *   scope 'everyone' — sender only. The body and attachments are cleared in
 *                      BOTH copies of the thread and a `deletedAt` tombstone
 *                      is left behind, so the other side sees "Message
 *                      deleted" instead of the content ever again.
 *   scope 'me'       — the caller's copy only; the other participant keeps
 *                      what they received (WhatsApp's "delete for me").
 */
async function deleteMessage(dataDir, myId, id, scope = 'everyone') {
  const msgId = String(id || '');
  if (!msgId) throw validationError('Message id is required.');
  const everywhere = scope !== 'me';

  if (pg.enabled()) {
    if (everywhere) {
      const own = await pg.query(
        'SELECT from_id FROM inbox_messages WHERE box_owner = $1 AND id = $2',
        [myId, msgId]
      );
      if (!own.rows.length) throw notFoundError();
      if (own.rows[0].from_id !== myId) {
        throw forbiddenError('Only the sender can delete a message for everyone.');
      }
      // The same id exists in both boxes — one statement tombstones both.
      await pg.query(
        `UPDATE inbox_messages SET body = '', attachments = '[]'::jsonb, deleted_at = $2
          WHERE id = $1 AND from_id = $3`,
        [msgId, Date.now(), myId]
      );
    } else {
      await pg.query('DELETE FROM inbox_messages WHERE box_owner = $1 AND id = $2', [myId, msgId]);
    }
    return { id: msgId, scope: everywhere ? 'everyone' : 'me' };
  }

  // ---- JSON backend ----
  const box = loadBox(dataDir, myId);
  let thread = null;
  for (const t of Object.values(box.threads)) {
    if (Array.isArray(t.messages) && t.messages.some((m) => m.id === msgId)) { thread = t; break; }
  }
  if (!thread) throw notFoundError();
  const msg = thread.messages.find((m) => m.id === msgId);

  if (!everywhere) {
    thread.messages = thread.messages.filter((m) => m.id !== msgId);
    saveBox(dataDir, myId, box);
    return { id: msgId, scope: 'me' };
  }

  if (msg.from !== myId) throw forbiddenError('Only the sender can delete a message for everyone.');
  const now = Date.now();
  msg.body = '';
  msg.attachments = [];
  msg.deletedAt = now;
  saveBox(dataDir, myId, box);

  // Mirror the tombstone into the recipient's copy of the same thread.
  const peerId = msg.to === myId ? msg.from : msg.to;
  const peerBox = loadBox(dataDir, peerId);
  const peerThread = peerBox.threads[myId];
  const mirror = peerThread && Array.isArray(peerThread.messages)
    ? peerThread.messages.find((m) => m.id === msgId)
    : null;
  if (mirror) {
    mirror.body = '';
    mirror.attachments = [];
    mirror.deletedAt = now;
    saveBox(dataDir, peerId, peerBox);
  }
  return { id: msgId, scope: 'everyone' };
}

/**
 * One-time bootstrap, run during boot when Postgres is enabled: copy every
 * `data/inbox/*.json` box into empty tables (a fresh Render instance has no
 * rows yet). If any thread rows already exist, Postgres wins — files are
 * never re-merged.
 */
async function migrateToPostgres(dataDir) {
  if (!pg.enabled()) return { migrated: 0 };
  const { rows } = await pg.query('SELECT count(*)::int AS n FROM inbox_threads');
  if ((Number(rows[0].n) || 0) > 0) return { migrated: 0 };

  let migrated = 0;
  let files = [];
  try {
    files = fs.readdirSync(inboxDir(dataDir)).filter((f) => f.endsWith('.json'));
  } catch {
    return { migrated: 0 };
  }

  for (const file of files) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(inboxDir(dataDir), file), 'utf8'));
    } catch {
      continue;
    }
    const owner = String(doc.owner || '');
    if (!owner || !doc.threads || typeof doc.threads !== 'object') continue;

    for (const thread of Object.values(doc.threads)) {
      if (!thread || !thread.peerId) continue;
      const peerId = assertPeerId(thread.peerId);
      await pg.query(
        `INSERT INTO inbox_threads (box_owner, peer_id, peer_name, peer_role, read_ts)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (box_owner, peer_id) DO NOTHING`,
        [owner, peerId, thread.peerName || '', thread.peerRole || '', thread.readTs || 0]
      );
      for (const m of Array.isArray(thread.messages) ? thread.messages : []) {
        if (!m || !m.id) continue; // a tombstone (empty body) still migrates
        try {
          await pg.query(
            `INSERT INTO inbox_messages (id, box_owner, peer_id, from_id, to_id, body, ts, generated, attachments, deleted_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10) ON CONFLICT (box_owner, id) DO NOTHING`,
            [m.id, owner, peerId, m.from || '', m.to || '', m.body || '', m.ts || 0, !!m.generated,
             JSON.stringify(m.attachments || []), m.deletedAt || 0]
          );
          migrated += 1;
        } catch (err) {
          if (!pg.isUniqueViolation(err)) throw err;
        }
      }
    }
  }
  return { migrated };
}

module.exports = {
  MAX_BODY,
  boxIdForAccount,
  assertPeerId,
  sendMessage,
  listThreads,
  listMessages,
  markRead,
  deleteMessage,
  migrateToPostgres,
};
