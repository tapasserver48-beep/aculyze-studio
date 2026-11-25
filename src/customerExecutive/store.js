/**
 * Customer Executive Store — persistent storage for customer workspaces,
 * crawled knowledge, chatbots, leads, crawl jobs, and conversations.
 *
 * Storage: PostgreSQL when DATABASE_URL is set, JSON files otherwise.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pg = require('../db/pg');

// ---------- ID generation ----------
function generateId() {
  return 'cust-' + crypto.randomUUID().substring(0, 8);
}

function generateConversationId() {
  return 'conv-' + crypto.randomUUID().substring(0, 8);
}

function generateMessageId() {
  return 'msg-' + crypto.randomUUID().substring(0, 8);
}

// ---------- PostgreSQL Schema ----------
async function ensureSchema() {
  // One definition for all Customer Executive tables (creates + repairs): ./schema.js
  if (pg.enabled()) return require('./schema').ensureAll();
  if (!pg.enabled()) {
    // Initialize JSON files for local development
    const dataDir = process.env.ACULYZE_DATA_DIR;
    const files = ['customer_workspaces.json', 'customer_knowledge.json', 'customer_chatbots.json',
                   'customer_leads.json', 'customer_crawl_jobs.json', 'customer_conversations.json',
                   'customer_messages.json'];
    const dir = path.join(dataDir || '.', 'data', 'customer');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of files) {
      if (!fs.existsSync(path.join(dir, f))) {
        fs.writeFileSync(path.join(dir, f), JSON.stringify({ items: [] }, null, 2), 'utf8');
      }
    }
    return;
  }

  // Workspaces
  await pg.query(`
    CREATE TABLE IF NOT EXISTS customer_workspaces (
      id          TEXT PRIMARY KEY,
      creator_id  TEXT NOT NULL,           -- human user id
      name        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at  BIGINT NOT NULL,
      updated_at  BIGINT NOT NULL
    )
  `);

  // Knowledge extraction from websites
  await pg.query(`
    CREATE TABLE IF NOT EXISTS customer_knowledge (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL REFERENCES customer_workspaces(id) ON DELETE CASCADE,
      source_url    TEXT NOT NULL,
      content       TEXT NOT NULL,
      content_type  TEXT,
      extracted_at  BIGINT NOT NULL,
      version       INTEGER NOT NULL DEFAULT 1
    )
  `);
  await pg.query('CREATE UNIQUE INDEX IF NOT EXISTS customer_knowledge_uniq ON customer_knowledge (workspace_id, source_url, version)');
  await pg.query('CREATE INDEX IF NOT EXISTS customer_knowledge_workspace_idx ON customer_knowledge (workspace_id)');

  // Chatbot configurations
  await pg.query(`
    CREATE TABLE IF NOT EXISTS customer_chatbots (
      id             TEXT PRIMARY KEY,
      workspace_id   TEXT NOT NULL REFERENCES customer_workspaces(id) ON DELETE CASCADE,
      name           TEXT NOT NULL,
      config         JSONB NOT NULL,              -- brand, welcome, FAQs, lead fields
      publish_key    TEXT NOT NULL UNIQUE,        -- public identifier
      status         TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT/TESTING/APPROVED/PUBLISHED/PAUSED/ARCHIVED
      approved_by    TEXT,                        -- human approver id
      approved_at    BIGINT,
      approved_version INTEGER,
      published_at   BIGINT,
      created_at     BIGINT NOT NULL,
      updated_at     BIGINT NOT NULL
    )
  `);
  await pg.query('CREATE INDEX IF NOT EXISTS customer_chatbots_workspace_idx ON customer_chatbots (workspace_id)');
  await pg.query('CREATE INDEX IF NOT EXISTS customer_chatbots_status_idx ON customer_chatbots (status)');

  // Lead capture
  await pg.query(`
    CREATE TABLE IF NOT EXISTS customer_leads (
      id           TEXT PRIMARY KEY,
      chatbot_id   TEXT NOT NULL REFERENCES customer_chatbots(id) ON DELETE CASCADE,
      workspace_id   TEXT NOT NULL,
      visitor_id   TEXT,                          -- anonymous session id
      fields       JSONB NOT NULL,                -- name, email, phone, enquiry
      consent_given BOOLEAN NOT NULL DEFAULT FALSE,
      consent_at   BIGINT,
      created_at   BIGINT NOT NULL
    )
  `);
  await pg.query('CREATE INDEX IF NOT EXISTS customer_leads_workspace_idx ON customer_leads (workspace_id)');
  await pg.query('CREATE INDEX IF NOT EXISTS customer_leads_chatbot_idx ON customer_leads (chatbot_id)');

  // Crawl jobs
  await pg.query(`
    CREATE TABLE IF NOT EXISTS customer_crawl_jobs (
      id         TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES customer_workspaces(id) ON DELETE CASCADE,
      target_url TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'PENDING', -- PENDING/RUNNING/SUCCESS/FAILED/PARTIAL
      pages_queued  INTEGER DEFAULT 0,
      pages_completed INTEGER DEFAULT 0,
      error_message TEXT,
      started_at BIGINT,
      completed_at BIGINT,
      created_at BIGINT NOT NULL
    )
  `);
  await pg.query('CREATE INDEX IF NOT EXISTS customer_crawl_jobs_workspace_idx ON customer_crawl_jobs (workspace_id)');
  await pg.query('CREATE INDEX IF NOT EXISTS customer_crawl_jobs_status_idx ON customer_crawl_jobs (status)');

  // Conversation history
  await pg.query(`
    CREATE TABLE IF NOT EXISTS customer_conversations (
      id         TEXT PRIMARY KEY,
      chatbot_id TEXT NOT NULL REFERENCES customer_chatbots(id) ON DELETE CASCADE,
      publish_key TEXT NOT NULL,
      visitor_id TEXT,
      created_at BIGINT NOT NULL,
      last_activity BIGINT NOT NULL
    )
  `);
  await pg.query('CREATE INDEX IF NOT EXISTS customer_conversations_chatbot_idx ON customer_conversations (chatbot_id)');
  await pg.query('CREATE INDEX IF NOT EXISTS customer_conversations_visitor_idx ON customer_conversations (visitor_id)');

  // Messages within conversations
  await pg.query(`
    CREATE TABLE IF NOT EXISTS customer_messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES customer_conversations(id) ON DELETE CASCADE,
      role            TEXT NOT NULL,                 -- 'user' or 'assistant'
      content         TEXT NOT NULL,
      source_refs     JSONB,                         -- knowledge source IDs for assistant messages
      tokens          INTEGER,
      created_at      BIGINT NOT NULL
    )
  `);
  await pg.query('CREATE INDEX IF NOT EXISTS customer_messages_conversation_idx ON customer_messages (conversation_id)');
}

// ---------- JSON File Backend ----------
const CUSTOMER_DATA_DIR = (dataDir) => path.join(dataDir || '.', 'data', 'customer');
const customerFile = (dataDir, name) => path.join(CUSTOMER_DATA_DIR(dataDir), `${name}.json`);

function readItems(dataDir, name) {
  try {
    const content = fs.readFileSync(customerFile(dataDir, name), 'utf8');
    return JSON.parse(content).items || [];
  } catch {
    return [];
  }
}

function writeItems(dataDir, name, items) {
  const file = customerFile(dataDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ items }, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ---------- Workspaces ----------
async function createWorkspace(dataDir, { creatorId, name, status }) {
  const now = Date.now();
  const id = generateId();
  const workspace = { id, creator_id: creatorId, name, status: status || 'ACTIVE',
                     created_at: now, updated_at: now };

  if (pg.enabled()) {
    const { rows } = await pg.query(
      `INSERT INTO customer_workspaces (id, creator_id, name, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [id, creatorId, name, status || 'ACTIVE', now, now]);
    return rows[0];
  }

  const items = readItems(dataDir, 'customer_workspaces');
  items.push(workspace);
  writeItems(dataDir, 'customer_workspaces', items);
  return workspace;
}

async function getWorkspace(dataDir, id) {
  if (pg.enabled()) {
    const { rows } = await pg.query('SELECT * FROM customer_workspaces WHERE id = $1', [id]);
    return rows[0] || null;
  }
  return readItems(dataDir, 'customer_workspaces').find(w => w.id === id) || null;
}

async function listWorkspaces(dataDir, { creatorId } = {}) {
  if (pg.enabled()) {
    const params = [];
    const where = creatorId ? 'WHERE creator_id = $1' : '';
    if (creatorId) params.push(creatorId);
    const { rows } = await pg.query(`SELECT * FROM customer_workspaces ${where} ORDER BY created_at DESC`, params);
    return rows;
  }
  const items = readItems(dataDir, 'customer_workspaces');
  return creatorId
    ? items.filter(w => w.creator_id === creatorId).sort((a, b) => b.created_at - a.created_at)
    : items.sort((a, b) => b.created_at - a.created_at);
}

async function updateWorkspace(dataDir, id, updates) {
  const now = Date.now();
  if (pg.enabled()) {
    const fields = [];
    const params = [];
    let idx = 1;
    for (const [k, v] of Object.entries({ ...updates, updated_at: now })) {
      fields.push(`${k} = $${idx++}`);
      params.push(v);
    }
    params.push(id);
    const { rows } = await pg.query(`UPDATE customer_workspaces SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`, [...params, id]);
    return rows[0] || null;
  }
  const items = readItems(dataDir, 'customer_workspaces');
  const idx = items.findIndex(w => w.id === id);
  if (idx === -1) return null;
  items[idx] = { ...items[idx], ...updates, updated_at: now };
  writeItems(dataDir, 'customer_workspaces', items);
  return items[idx];
}

async function deleteWorkspace(dataDir, id) {
  if (pg.enabled()) {
    const result = await pg.query('DELETE FROM customer_workspaces WHERE id = $1 RETURNING id', [id]);
    return result.rows.length > 0;
  }
  const items = readItems(dataDir, 'customer_workspaces');
  const idx = items.findIndex(w => w.id === id);
  if (idx === -1) return false;
  items.splice(idx, 1);
  writeItems(dataDir, 'customer_workspaces', items);
  return true;
}

// ---------- Authorization ----------
const AUTHORIZATION_ROLES = {
  founder: 'founder',
  admin: 'admin',
  manager: 'manager',
  employee: 'employee'
};

/**
 * Check if a user can access a customer workspace.
 * Founder/admin/manager can access any workspace they have permission for.
 * Employee can only access if explicitly authorized (future extension).
 */
function canAccessWorkspace(userRole, userId, workspaceCreatorId) {
  const canViewAny = ['founder', 'admin'].includes(userRole);
  return canViewAny || userId === workspaceCreatorId;
}

module.exports = {
  // ID generators
  generateId,
  generateConversationId,
  generateMessageId,
  // Schema
  ensureSchema,
  // Workspaces
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  updateWorkspace,
  deleteWorkspace,
  // Authorization
  AUTHORIZATION_ROLES,
  canAccessWorkspace,
};