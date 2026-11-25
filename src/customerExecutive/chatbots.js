/**
 * Chatbot Management — handles chatbot configuration, approval, publishing,
 * and public visitor interactions with human approval gates.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pg = require('../db/pg');

function generateChatbotId() {
  return 'cb-' + crypto.randomUUID().substring(0, 8);
}

function generatePublishKey() {
  return 'pub_' + crypto.randomBytes(16).toString('hex');
}

const CUSTOMER_DATA_DIR = (dataDir) => path.join(dataDir || '.', 'data', 'customer');
const chatbotsFile = (dataDir) => path.join(CUSTOMER_DATA_DIR(dataDir), 'customer_chatbots.json');

function readChatbots(dataDir) {
  try {
    const content = fs.readFileSync(chatbotsFile(dataDir), 'utf8');
    return JSON.parse(content).items || [];
  } catch {
    return [];
  }
}

function writeChatbots(dataDir, items) {
  const file = chatbotsFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ items }, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

async function ensureSchema() {
  // One definition for all Customer Executive tables (creates + repairs): ./schema.js
  if (pg.enabled()) return require('./schema').ensureAll();
  if (!pg.enabled()) {
    const file = chatbotsFile(process.env.ACULYZE_DATA_DIR);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ items: [] }, null, 2), 'utf8');
    }
    return;
  }

  await pg.query(`
    CREATE TABLE IF NOT EXISTS customer_chatbots (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES customer_workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      instructions TEXT,
      knowledge_ids JSONB,
      state TEXT NOT NULL DEFAULT 'draft',
      publish_key TEXT,
      approved_by TEXT,
      approved_at BIGINT,
      published_at BIGINT,
      visitor_count BIGINT DEFAULT 0,
      last_used_at BIGINT,
      created_by TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `);
  await pg.query('CREATE INDEX IF NOT EXISTS customer_chatbots_workspace_idx ON customer_chatbots (workspace_id)');
  await pg.query('CREATE INDEX IF NOT EXISTS customer_chatbots_state_idx ON customer_chatbots (state)');
  await pg.query('CREATE INDEX IF NOT EXISTS customer_chatbots_publish_key_idx ON customer_chatbots (publish_key)');
}

async function createChatbot(dataDir, { workspaceId, name, description, instructions, knowledgeIds, createdBy }) {
  const now = Date.now();
  const id = generateChatbotId();

  const chatbot = {
    id,
    workspace_id: workspaceId,
    name,
    description,
    instructions,
    knowledge_ids: knowledgeIds || [],
    state: 'draft',
    publish_key: null,
    approved_by: null,
    approved_at: null,
    published_at: null,
    visitor_count: 0,
    last_used_at: null,
    created_by: createdBy,
    created_at: now,
    updated_at: now
  };

  if (pg.enabled()) {
    const { rows } = await pg.query(
      `INSERT INTO customer_chatbots
       (id, workspace_id, name, description, instructions, knowledge_ids,
        state, publish_key, approved_by, approved_at, published_at,
        visitor_count, last_used_at, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [id, workspaceId, name, description, instructions, JSON.stringify(knowledgeIds || []),
       'draft', null, null, null, null, 0, null, createdBy, now, now]
    );
    return rows[0];
  }

  const items = readChatbots(dataDir);
  items.push(chatbot);
  writeChatbots(dataDir, items);
  return chatbot;
}

async function getChatbot(dataDir, workspaceId, chatbotId) {
  if (pg.enabled()) {
    const { rows } = await pg.query(
      `SELECT * FROM customer_chatbots WHERE id = $1 AND workspace_id = $2`,
      [chatbotId, workspaceId]
    );
    return rows[0] || null;
  }
  return readChatbots(dataDir).find(c => c.id === chatbotId && c.workspace_id === workspaceId) || null;
}

async function getChatbotByPublishKey(dataDir, publishKey) {
  if (pg.enabled()) {
    const { rows } = await pg.query(
      `SELECT * FROM customer_chatbots WHERE publish_key = $1 AND state = 'published'`,
      [publishKey]
    );
    return rows[0] || null;
  }
  return readChatbots(dataDir).find(c => c.publish_key === publishKey && c.state === 'published') || null;
}

async function listChatbots(dataDir, workspaceId) {
  if (pg.enabled()) {
    const { rows } = await pg.query(
      `SELECT id, name, description, state, publish_key, created_at, updated_at, visitor_count
       FROM customer_chatbots WHERE workspace_id = $1 ORDER BY updated_at DESC`,
      [workspaceId]
    );
    return rows;
  }
  return readChatbots(dataDir)
    .filter(c => c.workspace_id === workspaceId)
    .sort((a, b) => b.updated_at - a.updated_at);
}

// Columns an update may touch. Anything else is ignored: column names are never
// taken from the request (they used to be pasted into the SQL: SQL injection).
const UPDATABLE = ['name', 'description', 'instructions', 'knowledge_ids', 'state', 'publish_key',
  'approved_by', 'approved_at', 'published_at', 'visitor_count', 'last_used_at'];
const JSONB_COLUMNS = new Set(['knowledge_ids']);

async function updateChatbot(dataDir, workspaceId, chatbotId, updates, userId) {
  const clean = {};
  for (const [k, v] of Object.entries(updates || {})) {
    if (UPDATABLE.includes(k) && v !== undefined) clean[k] = v;
  }

  if (pg.enabled()) {
    const fields = [];
    const params = [];
    for (const [k, v] of Object.entries(clean)) {
      params.push(JSONB_COLUMNS.has(k) && v !== null ? JSON.stringify(v) : v);
      fields.push(`${k} = $${params.length}`);
    }
    params.push(Date.now());
    fields.push(`updated_at = $${params.length}`);
    params.push(chatbotId);
    const idParam = params.length;
    params.push(workspaceId);
    const wsParam = params.length;

    const result = await pg.query(
      `UPDATE customer_chatbots SET ${fields.join(', ')} WHERE id = $${idParam} AND workspace_id = $${wsParam} RETURNING *`,
      params
    );
    return result.rows[0] || null;
  }

  const items = readChatbots(dataDir);
  const idx = items.findIndex(c => c.id === chatbotId && c.workspace_id === workspaceId);
  if (idx === -1) return null;

  items[idx] = { ...items[idx], ...clean, updated_at: Date.now() };
  writeChatbots(dataDir, items);
  return items[idx];
}

async function deleteChatbot(dataDir, workspaceId, id) {
  if (pg.enabled()) {
    const result = await pg.query(
      `DELETE FROM customer_chatbots WHERE id = $1 AND workspace_id = $2 RETURNING id`,
      [id, workspaceId]
    );
    return result.rows.length > 0;
  }
  const items = readChatbots(dataDir);
  const idx = items.findIndex(c => c.id === id && c.workspace_id === workspaceId);
  if (idx === -1) return false;
  items.splice(idx, 1);
  writeChatbots(dataDir, items);
  return true;
}

async function approveChatbot(dataDir, workspaceId, chatbotId, approverId, approverRole) {
  const chatbot = await getChatbot(dataDir, workspaceId, chatbotId);
  if (!chatbot) return null;

  // Only founder, admin, or the creator can approve
  const workspace = await getWorkspaceInfo(dataDir, workspaceId);
  if (!workspace) return null;

  const isCreator = chatbot.created_by === approverId;
  const isApprover = ['founder', 'admin'].includes(approverRole);
  const isCreatorOfWorkspace = workspace.creator_id === approverId;

  if (!isApprover && !isCreator && !isCreatorOfWorkspace) {
    return { error: 'Access denied: only founders, admins, or the creator can approve' };
  }

  if (chatbot.state === 'approved' || chatbot.state === 'published') {
    return { error: 'Chatbot already approved or published' };
  }

  const updates = {
    state: 'approved',
    approved_by: approverId,
    approved_at: Date.now()
  };

  return updateChatbot(dataDir, workspaceId, chatbotId, updates, approverId);
}

// Used to read only the JSON file, so on Postgres no chatbot could be approved.
async function getWorkspaceInfo(dataDir, workspaceId) {
  return require('./store').getWorkspace(dataDir, workspaceId);
}

async function publishChatbot(dataDir, workspaceId, chatbotId, userId) {
  const chatbot = await getChatbot(dataDir, workspaceId, chatbotId);
  if (!chatbot) return null;

  if (chatbot.state !== 'approved') {
    return { error: 'Chatbot must be approved before publishing' };
  }

  const updates = {
    state: 'published',
    publish_key: generatePublishKey(),
    published_at: Date.now()
  };

  return updateChatbot(dataDir, workspaceId, chatbotId, updates, userId);
}

async function unpublishChatbot(dataDir, workspaceId, chatbotId) {
  const chatbot = await getChatbot(dataDir, workspaceId, chatbotId);
  if (!chatbot) return null;

  const updates = {
    state: 'approved',
    publish_key: null,
    published_at: null
  };

  return updateChatbot(dataDir, workspaceId, chatbotId, updates);
}

module.exports = {
  generateChatbotId,
  generatePublishKey,
  ensureSchema,
  createChatbot,
  getChatbot,
  getChatbotByPublishKey,
  listChatbots,
  updateChatbot,
  deleteChatbot,
  approveChatbot,
  publishChatbot,
  unpublishChatbot
};