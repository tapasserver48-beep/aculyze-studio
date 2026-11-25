/**
 * Conversation History — tracks chatbot visitor interactions for analytics
 * and compliance with consent requirements.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pg = require('../db/pg');

function generateConversationId() {
  return 'conv-' + crypto.randomUUID().substring(0, 8);
}

function generateMessageId() {
  return 'msg-' + crypto.randomUUID().substring(0, 8);
}

const CUSTOMER_DATA_DIR = (dataDir) => path.join(dataDir || '.', 'data', 'customer');
const conversationsFile = (dataDir) => path.join(CUSTOMER_DATA_DIR(dataDir), 'customer_conversations.json');

function readConversations(dataDir) {
  try {
    const content = fs.readFileSync(conversationsFile(dataDir), 'utf8');
    return JSON.parse(content).items || [];
  } catch {
    return [];
  }
}

function writeConversations(dataDir, items) {
  const file = conversationsFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ items }, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

async function ensureSchema() {
  // One definition for all Customer Executive tables (creates + repairs): ./schema.js
  if (pg.enabled()) return require('./schema').ensureAll();
  if (!pg.enabled()) {
    const file = conversationsFile(process.env.ACULYZE_DATA_DIR);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ items: [] }, null, 2), 'utf8');
    }
    return;
  }

  await pg.query(`
    CREATE TABLE IF NOT EXISTS customer_conversations (
      id TEXT PRIMARY KEY,
      chatbot_id TEXT NOT NULL REFERENCES customer_chatbots(id) ON DELETE CASCADE,
      publish_key TEXT NOT NULL,
      visitor_id TEXT,
      started_at BIGINT NOT NULL,
      last_activity BIGINT NOT NULL
    )
  `);
  await pg.query('CREATE INDEX IF NOT EXISTS customer_conversations_chatbot_idx ON customer_conversations (chatbot_id)');
  await pg.query('CREATE INDEX IF NOT EXISTS customer_conversations_visitor_idx ON customer_conversations (visitor_id)');

  await pg.query(`
    CREATE TABLE IF NOT EXISTS customer_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES customer_conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      source_refs JSONB,
      tokens INTEGER,
      created_at BIGINT NOT NULL
    )
  `);
  await pg.query('CREATE INDEX IF NOT EXISTS customer_messages_conversation_idx ON customer_messages (conversation_id)');
}

async function createConversation(dataDir, { chatbotId, publishKey, visitorId }) {
  const now = Date.now();
  const id = generateConversationId();

  const conv = {
    id,
    chatbot_id: chatbotId,
    publish_key: publishKey,
    visitor_id: visitorId || null,
    started_at: now,
    last_activity: now
  };

  if (pg.enabled()) {
    const { rows } = await pg.query(
      `INSERT INTO customer_conversations (id, chatbot_id, publish_key, visitor_id, started_at, last_activity)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [id, chatbotId, publishKey, visitorId || null, now, now]
    );
    return rows[0];
  }

  const items = readConversations(dataDir);
  items.push(conv);
  writeConversations(dataDir, items);
  return conv;
}

async function getConversation(dataDir, id) {
  if (pg.enabled()) {
    const { rows } = await pg.query('SELECT * FROM customer_conversations WHERE id = $1', [id]);
    return rows[0] || null;
  }
  return readConversations(dataDir).find(c => c.id === id) || null;
}

async function listConversations(dataDir, filters = {}) {
  if (pg.enabled()) {
    const { rows } = await pg.query('SELECT * FROM customer_conversations WHERE chatbot_id = $1 ORDER BY last_activity DESC LIMIT 100', [filters.chatbotId]);
    return rows;
  }
  const all = readConversations(dataDir);
  return all
    .filter(c => !filters.chatbotId || c.chatbot_id === filters.chatbotId)
    .filter(c => !filters.visitorId || c.visitor_id === filters.visitorId)
    .sort((a, b) => b.last_activity - a.last_activity)
    .slice(0, 100);
}

async function updateConversation(dataDir, conversationId, updates) {
  if (pg.enabled()) {
    const fields = [];
    const params = [];
    let idx = 1;
    for (const [k, v] of Object.entries(updates)) {
      fields.push(`${k} = $${idx++}`);
      params.push(v);
    }
    params.push(conversationId);

    const result = await pg.query(
      `UPDATE customer_conversations SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      [...params, conversationId]
    );
    return result.rows[0] || null;
  }

  const items = readConversations(dataDir);
  const found = items.find(c => c.id === conversationId);
  if (!found) return null;
  items[items.indexOf(found)] = { ...found, ...updates };
  writeConversations(dataDir, items);
  return items[items.length - 1];
}

// ---------- Messages ----------
const messagesFile = (dataDir) => path.join(CUSTOMER_DATA_DIR(dataDir), 'customer_messages.json');

function readMessages(dataDir) {
  try {
    const content = fs.readFileSync(messagesFile(dataDir), 'utf8');
    return JSON.parse(content).items || [];
  } catch {
    return [];
  }
}

function writeMessages(dataDir, items) {
  const file = messagesFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ items }, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

async function addMessage(dataDir, { conversationId, role, content, sourceRefs, tokens }) {
  const now = Date.now();
  const id = generateMessageId();

  const message = {
    id,
    conversation_id: conversationId,
    role,
    content,
    source_refs: sourceRefs || null,
    tokens,
    created_at: now
  };

  if (pg.enabled()) {
    const { rows } = await pg.query(
      `INSERT INTO customer_messages (id, conversation_id, role, content, source_refs, tokens, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, conversationId, role, content, sourceRefs ? JSON.stringify(sourceRefs) : null, tokens, now]
    );
    return rows[0];
  }

  const items = readMessages(dataDir);
  items.push(message);
  writeMessages(dataDir, items);
  return message;
}

async function listMessages(dataDir, conversationId) {
  if (pg.enabled()) {
    const { rows } = await pg.query(
      'SELECT id, role, content, tokens, created_at FROM customer_messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [conversationId]
    );
    return rows;
  }

  const items = readMessages(dataDir);
  return items
    .filter(m => m.conversation_id === conversationId)
    .sort((a, b) => a.created_at - b.created_at);
}

module.exports = {
  generateConversationId,
  generateMessageId,
  ensureSchema,
  createConversation,
  getConversation,
  listConversations,
  updateConversation,
  addMessage,
  listMessages
};