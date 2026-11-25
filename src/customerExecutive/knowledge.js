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
  // One definition for all Customer Executive tables (creates + repairs): ./schema.js
  if (pg.enabled()) return require('./schema').ensureAll();
  if (!pg.enabled()) {
    const dataDir = process.env.ACULYZE_DATA_DIR;
    const file = path.join(dataDir || '.', 'data', 'customer', 'customer_knowledge.json');
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ items: [] }, null, 2), 'utf8');
    }
    return;
  }

  // Ensure the table exists with proper schema
  await pg.query(`
    CREATE TABLE IF NOT EXISTS customer_knowledge (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES customer_workspaces(id) ON DELETE CASCADE,
      source_url TEXT NOT NULL,
      content_content TEXT,        -- Title/meta/heading/paragraph text
      content_headings JSONB,      -- Extracted headings as array
      content_links JSONB,         -- Extracted links
      contact_emails JSONB,        -- Contact emails
      contact_phones JSONB,        -- Contact phones
      content_type TEXT,
      extracted_at BIGINT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    )
  `);
  await pg.query('CREATE INDEX IF NOT EXISTS customer_knowledge_workspace_idx ON customer_knowledge (workspace_id)');
  await pg.query('CREATE INDEX IF NOT EXISTS customer_knowledge_source_idx ON customer_knowledge (workspace_id, source_url)');
  await pg.query('CREATE INDEX IF NOT EXISTS customer_knowledge_search_idx ON customer_knowledge USING gin(to_tsvector(\'english\', content_content))');
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

  // Flatten content for storage
  const contentText = extractTextFromContent(content);
  const contentHeadings = content.headings || [];
  const contentLinks = content.links || [];
  const contactEmails = content.contact_emails || [];
  const contactPhones = content.contact_phones || [];

  const knowledgeItem = {
    id,
    workspace_id: workspaceId,
    source_url: sourceUrl,
    content_content: contentText,
    content_headings: contentHeadings,
    content_links: contentLinks,
    contact_emails: contactEmails,
    contact_phones: contactPhones,
    content_type: contentType,
    extracted_at: now,
    version: 1
  };

  if (pg.enabled()) {
    const { rows } = await pg.query(
      `INSERT INTO customer_knowledge 
       (id, workspace_id, source_url, content_content, content_headings, content_links,
        contact_emails, contact_phones, content_type, extracted_at, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [id, workspaceId, sourceUrl, contentText, JSON.stringify(contentHeadings), JSON.stringify(contentLinks),
       JSON.stringify(contactEmails), JSON.stringify(contactPhones), contentType, now, 1]
    );
    return rows[0];
  }

  const items = readKnowledge(dataDir);
  items.push(knowledgeItem);
  writeKnowledge(dataDir, items);
  return knowledgeItem;
}

/** JSONB comes back parsed from node-pg, as text from older rows. */
function asList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
}

function extractTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (!content) return '';

  const parts = [];
  if (content.title) parts.push(content.title);
  if (content.metaDescription) parts.push(content.metaDescription);
  if (content.headings) parts.push(...content.headings);
  if (content.paragraphs) parts.push(...content.paragraphs);

  return parts.join(' ');
}

async function getKnowledge(dataDir, workspaceId) {
  if (pg.enabled()) {
    const { rows } = await pg.query(
      `SELECT 
         id, workspace_id, source_url, content_content, content_headings, content_links,
         contact_emails, contact_phones, content_type, extracted_at, version
       FROM customer_knowledge 
       WHERE workspace_id = $1 
       ORDER BY extracted_at DESC`,
      [workspaceId]
    );
    return rows;
  }
  return readKnowledge(dataDir).filter(k => k.workspace_id === workspaceId);
}

async function getKnowledgeBySource(dataDir, workspaceId, sourceUrl) {
  if (pg.enabled()) {
    const { rows } = await pg.query(
      `SELECT 
         id, workspace_id, source_url, content_content, content_headings, content_links,
         contact_emails, contact_phones, content_type, extracted_at, version
       FROM customer_knowledge 
       WHERE workspace_id = $1 AND source_url = $2 
       ORDER BY version DESC`,
      [workspaceId, sourceUrl]
    );
    return rows;
  }
  return readKnowledge(dataDir)
    .filter(k => k.workspace_id === workspaceId && k.source_url === sourceUrl)
    .sort((a, b) => b.extracted_at - a.extracted_at);
}

async function updateKnowledge(dataDir, workspaceId, knowledgeId, updates) {
  // Whitelisted columns only: names are never taken from the request.
  const ALLOWED = ['source_url', 'content_content', 'content_headings', 'content_links', 'contact_emails', 'contact_phones', 'content_type'];
  const JSONB = new Set(['content_headings', 'content_links', 'contact_emails', 'contact_phones']);
  const clean = {};
  for (const [k, v] of Object.entries(updates || {})) if (ALLOWED.includes(k) && v !== undefined) clean[k] = v;
  updates = clean;

  if (pg.enabled()) {
    const fields = [];
    const params = [];
    for (const [k, v] of Object.entries(clean)) {
      params.push(JSONB.has(k) ? JSON.stringify(v ?? []) : v);
      fields.push(`${k} = $${params.length}`);
    }
    fields.push('version = version + 1');
    params.push(knowledgeId, workspaceId);

    const result = await pg.query(
      `UPDATE customer_knowledge SET ${fields.join(', ')} WHERE id = $${params.length - 1} AND workspace_id = $${params.length} RETURNING *`,
      params
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      workspace_id: row.workspace_id,
      source_url: row.source_url,
      content_content: row.content_content,
      content_headings: asList(row.content_headings),
      content_links: asList(row.content_links),
      contact_emails: asList(row.contact_emails),
      contact_phones: asList(row.contact_phones),
      content_type: row.content_type,
      extracted_at: Number(row.extracted_at),
      version: row.version
    };
  }

  // JSON backend
  const items = readKnowledge(dataDir);
  const found = items.find(k => k.id === knowledgeId && k.workspace_id === workspaceId);
  if (!found) return null;

  const at = items.indexOf(found);
  items[at] = { ...found, ...updates, version: (found.version || 0) + 1 };
  writeKnowledge(dataDir, items);
  return items[at];
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
  // Passage-level BM25 (Phase 04.4): each result is the best passage of a page,
  // not the whole page. matchScore is the passage's share of the top score.
  const { indexFor, search } = require('./retrieval');
  const { results } = search(indexFor(workspaceId, knowledge), query, { limit: 5, perPage: 1 });
  const top = results.length ? results[0].score : 1;
  const byId = new Map(knowledge.map((k) => [k.id, k]));
  return results.map((r) => ({
    ...(byId.get(r.knowledgeId) || {}),
    id: r.knowledgeId,
    source_url: r.url,
    title: r.title,
    content_content: r.text,
    matchScore: Math.round((r.score / top) * 100) / 100,
  }));
}

/**
 * Generate a structured response for the chatbot with source citations
 */
async function getChatbotResponse(dataDir, workspaceId, question) {
  const knowledge = await searchKnowledge(dataDir, workspaceId, question);

  if (knowledge.length === 0) {
    return {
      answer: "I don't have enough information in my knowledge base to answer that question. Please ask about topics covered in the crawled website content.",
      sources: [],
      confidence: 0
    };
  }

  // Simple aggregation - can be enhanced with LLM summarization
  const combinedContent = knowledge.map(k => k.content_content).join(' ');

  return {
    answer: combinedContent,
    sources: knowledge.map(k => k.source_url).slice(0, 3),
    knowledgeChunks: knowledge.map(k => ({
      source: k.source_url,
      content: k.content_content.slice(0, 500),
      confidence: k.matchScore
    }))
  };
}

module.exports = {
  generateKnowledgeId,
  ensureSchema,
  addKnowledge,
  getKnowledge,
  getKnowledgeBySource,
  updateKnowledge,
  deleteKnowledge,
  searchKnowledge,
  getChatbotResponse
};