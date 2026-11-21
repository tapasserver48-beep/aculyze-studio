/**
 * Customer Knowledge Management — stores and retrieves website content
 * extracted into tenant-isolated knowledge bases.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pg = require('../db/pg');

function generateKnowledgeId() {
  return 'kg-' + crypto.randomUUID().substring(0, 8);
}

async function ensureSchema() {
  if (!pg.enabled()) {
    const dataDir = process.env.ACULYZE_DATA_DIR;
    const file = path.join(dataDir || '.', 'data', 'customer', 'customer_knowledge.json');
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ items: [] }, null, 2), 'utf8');
    }
    return;
  }

  // Created by store.js, but ensure for safety
  await pg.query('CREATE TABLE IF NOT EXISTS customer_knowledge');
}

// ---------- JSON File Backend ----------
const CUSTOMER_DATA_DIR = (dataDir) => path.join(dataDir || '.', 'data', 'customer');
const knowledgeFile = (dataDir) => path.join(CUSTOMER_DATA_DIR(dataDir), 'customer_knowledge.json');

function readKnowledge(dataDir) {
  try {
    const content = fs.readFileSync(knowledgeFile(dataDir), 'utf8');
    return JSON.parse(content).items || [];
  } catch {
    return [];
  }
}

function writeKnowledge(dataDir, items) {
  const file = knowledgeFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ items }, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ---------- Knowledge CRUD ----------
async function addKnowledge(dataDir, { workspaceId, sourceUrl, content, contentType }) {
  const now = Date.now();
  const id = generateKnowledgeId();

  const knowledgeItem = {
    id,
    workspace_id: workspaceId,
    source_url: sourceUrl,
    content,
    content_type: contentType,
    extracted_at: now,
    version: 1
  };

  if (pg.enabled()) {
    const { rows } = await pg.query(
      `INSERT INTO customer_knowledge 
       (id, workspace_id, source_url, content, content_type, extracted_at, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, workspaceId, sourceUrl, content, contentType, now, 1]
    );
    return rows[0];
  }

  const items = readKnowledge(dataDir);
  items.push(knowledgeItem);
  writeKnowledge(dataDir, items);
  return knowledgeItem;
}

async function getKnowledge(dataDir, workspaceId) {
  if (pg.enabled()) {
    const { rows } = await pg.query(
      `SELECT * FROM customer_knowledge WHERE workspace_id = $1 ORDER BY extracted_at DESC`,
      [workspaceId]
    );
    return rows;
  }
  return readKnowledge(dataDir).filter(k => k.workspace_id === workspaceId);
}

async function getKnowledgeBySource(dataDir, workspaceId, sourceUrl) {
  if (pg.enabled()) {
    const { rows } = await pg.query(
      `SELECT * FROM customer_knowledge WHERE workspace_id = $1 AND source_url = $2 ORDER BY version DESC`,
      [workspaceId, sourceUrl]
    );
    return rows;
  }
  return readKnowledge(dataDir)
    .filter(k => k.workspace_id === workspaceId && k.source_url === sourceUrl)
    .sort((a, b) => b.extracted_at - a.extracted_at);
}

async function deleteKnowledge(dataDir, workspaceId, id) {
  if (pg.enabled()) {
    const result = await pg.query(
      `DELETE FROM customer_knowledge WHERE id = $1 AND workspace_id = $2 RETURNING id`,
      [id, workspaceId]
    );
    return result.rows.length > 0;
  }
  const items = readKnowledge(dataDir);
  const idx = items.findIndex(k => k.id === id && k.workspace_id === workspaceId);
  if (idx === -1) return false;
  items.splice(idx, 1);
  writeKnowledge(dataDir, items);
  return true;
}

/**
 * Retrieve relevant knowledge chunks for a query.
 * Returns content with source references for the chatbot to cite.
 */
async function searchKnowledge(dataDir, workspaceId, query) {
  const knowledge = await getKnowledge(dataDir, workspaceId);

  // Simple keyword matching - can be enhanced with embeddings later
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 3);
  if (!queryTerms.length) return [];

  const results = knowledge
    .map(k => {
      const matches = queryTerms.filter(t => k.content.toLowerCase().includes(t));
      return { ...k, matchScore: matches.length / queryTerms.length };
    })
    .filter(k => k.matchScore > 0)
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 5); // Top 5 results

  return results;
}

module.exports = {
  generateKnowledgeId,
  ensureSchema,
  addKnowledge,
  getKnowledge,
  getKnowledgeBySource,
  deleteKnowledge,
  searchKnowledge
};