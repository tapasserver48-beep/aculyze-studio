/**
 * Chat — SQLite database (departments, channels, messages).
 *
 * One file: `data/chat.db`. Users stay in the existing JSON auth store —
 * this database only references them by uid, so there is a single source of
 * truth for accounts. All timestamps are epoch milliseconds.
 *
 * Schema:
 *   departments      id, name, created_by, created_at
 *   channels         id, name, slug, type('group'|'department'), department_id,
 *                    created_by, created_at
 *   channel_members  channel_id, uid, role('owner'|'member'), joined_at,
 *                    last_read_ts          (PK: channel_id+uid)
 *   messages         id, channel_id, uid, body, created_at
 *
 * A department automatically gets one channel of the same name (type =
 * 'department'); joining the department joins that channel.
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS departments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  created_by  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  slug          TEXT    NOT NULL UNIQUE,
  type          TEXT    NOT NULL DEFAULT 'group' CHECK (type IN ('group','department')),
  department_id INTEGER REFERENCES departments(id) ON DELETE CASCADE,
  created_by    TEXT    NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  uid          TEXT    NOT NULL,
  role         TEXT    NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  joined_at    INTEGER NOT NULL,
  last_read_ts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, uid)
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  uid        TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_channel  ON messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_members_uid       ON channel_members(uid);
CREATE INDEX IF NOT EXISTS idx_channels_dept     ON channels(department_id);
`;

/** Open (and lazily create) the chat database. Safe to call repeatedly. */
function getDb(dataDir) {
  if (db) return db;
  fs.mkdirSync(dataDir, { recursive: true });
  db = new Database(path.join(dataDir, 'chat.db'));
  db.pragma('journal_mode = WAL');   // concurrent reads while writing
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

/** Close the handle (shutdown hook / tests). */
function closeDb() {
  if (db) {
    try { db.close(); } catch { /* already closed */ }
    db = null;
  }
}

module.exports = { getDb, closeDb };
