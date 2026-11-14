/**
 * Chat — data access layer (departments, channels, messages).
 *
 * Every function takes `dataDir` and opens the SQLite handle through
 * getDb(). Display names are resolved from the JSON auth store at read
 * time (single source of truth for accounts), never copied in.
 *
 * Read model:
 *   listChannels(uid)  → channels I belong to, with unread counts + last message
 *   listMessages(...)  → paginated history for one channel (member-only)
 * Write model:
 *   sendMessage        → insert + return the wire-shaped message
 *   markRead           → bump my last_read_ts cursor
 *
 * Role rules (who can do what) live in routes.js, not here — the store is
 * purely mechanical so it stays easy to test.
 */
const crypto = require('crypto');
const { getDb } = require('./db');
const { readDoc } = require('../auth/store');

const MAX_BODY = 4000;
const MAX_NAME = 60;

class ChatError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function assertUid(uid) {
  const s = String(uid || '');
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(s)) throw new ChatError(401, 'unauthenticated', 'Please sign in to continue.');
  return s;
}

function normalizeName(name) {
  const s = String(name || '').trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);
  if (!s) throw new ChatError(400, 'validation', 'Name cannot be empty.');
  return s;
}

/** URL-ish unique key for a channel name. */
function slugify(dataDir, name) {
  const db = getDb(dataDir);
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'channel';
  // Unique-ify against existing slugs.
  let slug = base;
  let n = 1;
  while (db.prepare('SELECT 1 FROM channels WHERE slug = ?').get(slug)) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

/** uid → display name from the auth store (falls back to a short id). */
function nameLookup(dataDir) {
  const users = readDoc(dataDir).users;
  const map = new Map();
  for (const u of users) map.set(u.id, u.name || u.email || 'User');
  return (uid) => map.get(uid) || 'User';
}

// ---------- departments ----------

function listDepartments(dataDir, uid) {
  const db = getDb(dataDir);
  const rows = db.prepare(`
    SELECT d.id, d.name, d.created_at,
           (SELECT COUNT(*) FROM channel_members cm
              JOIN channels c ON c.id = cm.channel_id
             WHERE c.department_id = d.id) AS member_count,
           EXISTS(SELECT 1 FROM channel_members cm
                    JOIN channels c ON c.id = cm.channel_id
                   WHERE c.department_id = d.id AND cm.uid = ?) AS joined
    FROM departments d
    ORDER BY d.name COLLATE NOCASE
  `).all(uid);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    memberCount: r.member_count,
    joined: !!r.joined,
  }));
}

function createDepartment(dataDir, uid, rawName) {
  const db = getDb(dataDir);
  const name = normalizeName(rawName);
  const now = Date.now();
  const tx = db.transaction(() => {
    let dept;
    try {
      dept = db.prepare('INSERT INTO departments (name, created_by, created_at) VALUES (?, ?, ?)')
        .run(name, uid, now);
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) throw new ChatError(409, 'conflict', 'That department already exists.');
      throw err;
    }
    const deptId = dept.lastInsertRowid;
    // Every department ships with its own channel; the creator owns it.
    const chan = db.prepare(
      'INSERT INTO channels (name, slug, type, department_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(name, slugify(dataDir, name), 'department', deptId, uid, now);
    db.prepare('INSERT INTO channel_members (channel_id, uid, role, joined_at) VALUES (?, ?, ?, ?)')
      .run(chan.lastInsertRowid, uid, 'owner', now);
    return deptId;
  });
  const id = tx();
  return getDepartment(dataDir, uid, id);
}

function getDepartment(dataDir, uid, id) {
  const db = getDb(dataDir);
  const row = db.prepare(`
    SELECT d.id, d.name, d.created_at,
           (SELECT COUNT(*) FROM channel_members cm
              JOIN channels c ON c.id = cm.channel_id
             WHERE c.department_id = d.id) AS member_count,
           EXISTS(SELECT 1 FROM channel_members cm
                    JOIN channels c ON c.id = cm.channel_id
                   WHERE c.department_id = d.id AND cm.uid = ?) AS joined
    FROM departments d WHERE d.id = ?
  `).get(uid, id);
  if (!row) throw new ChatError(404, 'not_found', 'Department not found.');
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    memberCount: row.member_count,
    joined: !!row.joined,
  };
}

function departmentChannelId(dataDir, deptId) {
  const db = getDb(dataDir);
  const row = db.prepare("SELECT id FROM channels WHERE department_id = ? AND type = 'department'").get(deptId);
  return row ? row.id : null;
}

function joinDepartment(dataDir, uid, deptId) {
  const db = getDb(dataDir);
  getDepartment(dataDir, uid, deptId); // 404s for unknown ids
  const chanId = departmentChannelId(dataDir, deptId);
  if (!chanId) throw new ChatError(404, 'not_found', 'Department channel missing.');
  joinChannel(dataDir, uid, chanId);
  return getDepartment(dataDir, uid, deptId);
}

function leaveDepartment(dataDir, uid, deptId) {
  const db = getDb(dataDir);
  getDepartment(dataDir, uid, deptId);
  const chanId = departmentChannelId(dataDir, deptId);
  if (chanId) leaveChannel(dataDir, uid, chanId);
  return getDepartment(dataDir, uid, deptId);
}

// ---------- channels ----------

function isMember(dataDir, channelId, uid) {
  const db = getDb(dataDir);
  return !!db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND uid = ?').get(channelId, uid);
}

function channelRow(dataDir, channelId) {
  const db = getDb(dataDir);
  return db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
}

function requireChannel(dataDir, channelId) {
  const row = channelRow(dataDir, channelId);
  if (!row) throw new ChatError(404, 'not_found', 'Channel not found.');
  return row;
}

/** Channels I belong to, newest activity first, with unread badges. */
function listChannels(dataDir, uid) {
  const db = getDb(dataDir);
  const rows = db.prepare(`
    SELECT c.id, c.name, c.slug, c.type, c.department_id, c.created_by, c.created_at,
           cm.role, cm.last_read_ts,
           (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id) AS message_count,
           (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id
              AND m.uid <> ? AND m.created_at > cm.last_read_ts) AS unread,
           (SELECT m.body FROM messages m WHERE m.channel_id = c.id
             ORDER BY m.created_at DESC LIMIT 1) AS last_body,
           (SELECT m.created_at FROM messages m WHERE m.channel_id = c.id
             ORDER BY m.created_at DESC LIMIT 1) AS last_ts,
           (SELECT m.uid FROM messages m WHERE m.channel_id = c.id
             ORDER BY m.created_at DESC LIMIT 1) AS last_uid
    FROM channels c
    JOIN channel_members cm ON cm.channel_id = c.id AND cm.uid = ?
    ORDER BY COALESCE(last_ts, c.created_at) DESC
  `).all(uid, uid);

  const names = nameLookup(dataDir);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    type: r.type,
    departmentId: r.department_id,
    role: r.role,
    memberCount: db.prepare('SELECT COUNT(*) AS n FROM channel_members WHERE channel_id = ?').get(r.id).n,
    messageCount: r.message_count,
    unread: r.unread,
    lastReadTs: r.last_read_ts,
    lastBody: r.last_body || '',
    lastTs: r.last_ts || r.created_at,
    lastUid: r.last_uid || '',
    lastByName: r.last_uid ? names(r.last_uid) : '',
    createdAt: r.created_at,
    createdBy: r.created_by,
  }));
}

function getChannel(dataDir, uid, channelId) {
  const row = requireChannel(dataDir, channelId);
  if (!isMember(dataDir, channelId, uid)) throw new ChatError(403, 'permission', 'Join this channel to view it.');
  const db = getDb(dataDir);
  const cm = db.prepare('SELECT role, last_read_ts FROM channel_members WHERE channel_id = ? AND uid = ?')
    .get(channelId, uid);
  const names = nameLookup(dataDir);
  const members = db.prepare(`
    SELECT cm.uid, cm.role, cm.joined_at FROM channel_members cm
    WHERE cm.channel_id = ? ORDER BY cm.joined_at
  `).all(channelId);
  const counts = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?').get(channelId);
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    type: row.type,
    departmentId: row.department_id,
    myRole: cm.role,
    lastReadTs: cm.last_read_ts,
    messageCount: counts.n,
    createdAt: row.created_at,
    createdBy: row.created_by,
    createdByName: names(row.created_by),
    members: members.map((m) => ({ uid: m.uid, name: names(m.uid), role: m.role, joinedAt: m.joined_at })),
  };
}

function createChannel(dataDir, uid, rawName) {
  const db = getDb(dataDir);
  const name = normalizeName(rawName);
  const now = Date.now();
  const tx = db.transaction(() => {
    const chan = db.prepare(
      'INSERT INTO channels (name, slug, type, department_id, created_by, created_at) VALUES (?, ?, ?, NULL, ?, ?)'
    ).run(name, slugify(dataDir, name), 'group', uid, now);
    db.prepare('INSERT INTO channel_members (channel_id, uid, role, joined_at) VALUES (?, ?, ?, ?)')
      .run(chan.lastInsertRowid, uid, 'owner', now);
    return chan.lastInsertRowid;
  });
  return getChannel(dataDir, uid, tx());
}

function joinChannel(dataDir, uid, channelId) {
  const db = getDb(dataDir);
  requireChannel(dataDir, channelId);
  db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, uid, role, joined_at) VALUES (?, ?, ?, ?)')
    .run(channelId, uid, 'member', Date.now());
  return getChannel(dataDir, uid, channelId);
}

function leaveChannel(dataDir, uid, channelId) {
  const db = getDb(dataDir);
  requireChannel(dataDir, channelId);
  if (!isMember(dataDir, channelId, uid)) throw new ChatError(403, 'permission', 'You are not in this channel.');
  // The last owner cannot abandon a channel they created.
  const mine = db.prepare("SELECT role FROM channel_members WHERE channel_id = ? AND uid = ?").get(channelId, uid);
  const owners = db.prepare("SELECT COUNT(*) AS n FROM channel_members WHERE channel_id = ? AND role = 'owner'")
    .get(channelId).n;
  if (mine.role === 'owner' && owners <= 1) {
    throw new ChatError(409, 'conflict', 'Promote another owner before leaving.');
  }
  db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND uid = ?').run(channelId, uid);
  return { left: true };
}

// ---------- messages ----------

function listMessages(dataDir, uid, channelId, { since = 0, limit = 50 } = {}) {
  const db = getDb(dataDir);
  if (!isMember(dataDir, channelId, uid)) throw new ChatError(403, 'permission', 'Join this channel to read it.');
  const sinceTs = Number(since) || 0;
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = db.prepare(`
    SELECT id, channel_id, uid, body, created_at FROM messages
    WHERE channel_id = ? AND created_at > ?
    ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(channelId, sinceTs, cap);
  const names = nameLookup(dataDir);
  const messages = rows.reverse().map((m) => ({
    id: m.id,
    channel: m.channel_id,
    from: m.uid,
    fromName: names(m.uid),
    body: m.body,
    ts: m.created_at,
  }));
  return { channelId, messages, count: messages.length };
}

function sendMessage(dataDir, uid, channelId, rawBody) {
  const db = getDb(dataDir);
  const member = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND uid = ?').get(channelId, uid);
  if (!member) throw new ChatError(403, 'permission', 'Join this channel to post.');
  const text = String(rawBody || '').trim();
  if (!text) throw new ChatError(400, 'validation', 'Message cannot be empty.');
  if (text.length > MAX_BODY) throw new ChatError(400, 'validation', `Message is too long (max ${MAX_BODY} characters).`);
  const now = Date.now();
  const info = db.prepare('INSERT INTO messages (channel_id, uid, body, created_at) VALUES (?, ?, ?, ?)')
    .run(channelId, uid, text, now);
  // Sending counts as reading — no self-unread badge.
  db.prepare('UPDATE channel_members SET last_read_ts = ? WHERE channel_id = ? AND uid = ?')
    .run(now, channelId, uid);
  const names = nameLookup(dataDir);
  return {
    id: Number(info.lastInsertRowid),
    channel: channelId,
    from: uid,
    fromName: names(uid),
    body: text,
    ts: now,
  };
}

function markRead(dataDir, uid, channelId, upToTs) {
  const db = getDb(dataDir);
  if (!isMember(dataDir, channelId, uid)) throw new ChatError(403, 'permission', 'Join this channel first.');
  const ts = Number(upToTs) || Date.now();
  db.prepare(`
    UPDATE channel_members SET last_read_ts = MAX(last_read_ts, ?)
    WHERE channel_id = ? AND uid = ?
  `).run(ts, channelId, uid);
  return { channelId, readTs: ts };
}

function unreadCount(dataDir, uid) {
  const db = getDb(dataDir);
  const row = db.prepare(`
    SELECT COALESCE(SUM((
      SELECT COUNT(*) FROM messages m
      WHERE m.channel_id = cm.channel_id AND m.uid <> cm.uid AND m.created_at > cm.last_read_ts
    )), 0) AS n FROM channel_members cm WHERE cm.uid = ?
  `).get(uid);
  return row ? row.n : 0;
}

/** Directory of signed-in accounts, for the member picker / AI search. */
function listPeople(dataDir, uid) {
  return readDoc(dataDir).users
    .filter((u) => u.id !== uid)
    .map((u) => ({ uid: u.id, name: u.name || u.email, role: u.role || 'employee' }));
}

module.exports = {
  MAX_BODY,
  MAX_NAME,
  ChatError,
  isMember,
  listDepartments,
  createDepartment,
  getDepartment,
  joinDepartment,
  leaveDepartment,
  listChannels,
  getChannel,
  createChannel,
  joinChannel,
  leaveChannel,
  listMessages,
  sendMessage,
  markRead,
  unreadCount,
  listPeople,
};
