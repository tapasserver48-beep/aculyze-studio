/**
 * Lead Capture — handles lead collection from public chatbot visitors
 * with explicit consent tracking.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pg = require('../db/pg');

function generateLeadId() {
  return 'lead-' + crypto.randomUUID().substring(0, 8);
}

const CUSTOMER_DATA_DIR = (dataDir) => path.join(dataDir || '.', 'data', 'customer');
const leadsFile = (dataDir) => path.join(CUSTOMER_DATA_DIR(dataDir), 'customer_leads.json');

function readLeads(dataDir) {
  try {
    const content = fs.readFileSync(leadsFile(dataDir), 'utf8');
    return JSON.parse(content).items || [];
  } catch {
    return [];
  }
}

function writeLeads(dataDir, items) {
  const file = leadsFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ items }, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

async function ensureSchema() {
  // One definition for all Customer Executive tables (creates + repairs): ./schema.js
  if (pg.enabled()) return require('./schema').ensureAll();
  if (!pg.enabled()) {
    const file = leadsFile(process.env.ACULYZE_DATA_DIR);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ items: [] }, null, 2), 'utf8');
    }
    return;
  }

  await pg.query(`
    CREATE TABLE IF NOT EXISTS customer_leads (
      id TEXT PRIMARY KEY,
      chatbot_id TEXT NOT NULL REFERENCES customer_chatbots(id) ON DELETE CASCADE,
      email TEXT,
      name TEXT,
      phone TEXT,
      company TEXT,
      conversation TEXT[],
      consent BOOLEAN NOT NULL DEFAULT false,
      consent_text_hash TEXT,
      source_url TEXT NOT NULL,
      user_agent TEXT,
      ip_address TEXT,
      created_at BIGINT NOT NULL
    )
  `);
  await pg.query('CREATE INDEX IF NOT EXISTS customer_leads_chatbot_idx ON customer_leads (chatbot_id)');
  await pg.query('CREATE INDEX IF NOT EXISTS customer_leads_email_idx ON customer_leads (email)');
  await pg.query('CREATE INDEX IF NOT EXISTS customer_leads_created_idx ON customer_leads (created_at DESC)');
}

async function createLead(dataDir, {
  chatbotId,
  email,
  name,
  phone,
  company,
  conversation,
  consent,
  consentTextHash,
  sourceUrl,
  userAgent,
  ipAddress
}) {
  if (!consent) {
    return { error: 'Consent is required to capture leads' };
  }

  const now = Date.now();
  const id = generateLeadId();

  const lead = {
    id,
    chatbot_id: chatbotId,
    email,
    name,
    phone,
    company,
    conversation,
    consent,
    consent_text_hash: consentTextHash,
    source_url: sourceUrl,
    user_agent: userAgent,
    ip_address: ipAddress,
    created_at: now
  };

  if (pg.enabled()) {
    const { rows } = await pg.query(
      `INSERT INTO customer_leads
       (id, chatbot_id, email, name, phone, company, conversation,
        consent, consent_text_hash, source_url, user_agent, ip_address, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [id, chatbotId, email, name, phone, company, JSON.stringify(conversation || []),
       consent, consentTextHash, sourceUrl, userAgent, ipAddress, now]
    );
    require('../automations/events').emit('lead.created', { dataDir, lead: rows[0] });
    return rows[0];
  }

  const items = readLeads(dataDir);
  items.push(lead);
  writeLeads(dataDir, items);
  // Automations ("New website lead" trigger) listen for this.
  require('../automations/events').emit('lead.created', { dataDir, lead });
  return lead;
}

async function listLeads(dataDir, chatbotId) {
  if (pg.enabled()) {
    const { rows } = await pg.query(
      `SELECT id, email, name, phone, company, conversation, consent, created_at
       FROM customer_leads WHERE chatbot_id = $1 ORDER BY created_at DESC`,
      [chatbotId]
    );
    return rows;
  }
  return readLeads(dataDir)
    .filter(l => l.chatbot_id === chatbotId)
    .sort((a, b) => b.created_at - a.created_at);
}

async function getLead(dataDir, chatbotId, leadId) {
  if (pg.enabled()) {
    const { rows } = await pg.query(
      `SELECT * FROM customer_leads WHERE id = $1 AND chatbot_id = $2`,
      [leadId, chatbotId]
    );
    return rows[0] || null;
  }
  return readLeads(dataDir).find(l => l.id === leadId && l.chatbot_id === chatbotId) || null;
}

module.exports = {
  generateLeadId,
  ensureSchema,
  createLead,
  listLeads,
  getLead
};