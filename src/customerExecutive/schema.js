/**
 * Customer Executive tables: ONE definition per table (Phase 04.4 fix).
 *
 * Before: store.js created an older design of most tables first (chatbots with
 * config/status, leads with a single `fields` column, knowledge with `content`,
 * conversations with created_at), and each module's own CREATE TABLE IF NOT
 * EXISTS was then skipped. On Postgres every chatbot, lead, conversation and
 * knowledge insert failed. leads.conversation was also TEXT[] while the code
 * writes JSON text.
 *
 * Now: tables are created here with the columns the code uses, and tables that
 * already exist in the old design are repaired in place (no data dropped):
 *   - missing columns are added
 *   - NOT NULL is removed from old columns the code doesn't write
 *   - leads.conversation is converted from TEXT[] to JSONB
 */

const pg = require('../db/pg');

const TABLES = [
  {
    name: 'customer_workspaces',
    columns: {
      id: 'TEXT PRIMARY KEY',
      creator_id: 'TEXT NOT NULL',
      name: 'TEXT NOT NULL',
      status: "TEXT NOT NULL DEFAULT 'ACTIVE'",
      created_at: 'BIGINT NOT NULL',
      updated_at: 'BIGINT NOT NULL',
    },
    indexes: [],
  },
  {
    name: 'customer_knowledge',
    columns: {
      id: 'TEXT PRIMARY KEY',
      workspace_id: 'TEXT NOT NULL REFERENCES customer_workspaces(id) ON DELETE CASCADE',
      source_url: 'TEXT NOT NULL',
      content_content: 'TEXT',
      content_headings: 'JSONB',
      content_links: 'JSONB',
      contact_emails: 'JSONB',
      contact_phones: 'JSONB',
      content_type: 'TEXT',
      extracted_at: 'BIGINT NOT NULL',
      version: 'INTEGER NOT NULL DEFAULT 1',
    },
    indexes: [
      'CREATE INDEX IF NOT EXISTS customer_knowledge_workspace_idx ON customer_knowledge (workspace_id)',
      'CREATE INDEX IF NOT EXISTS customer_knowledge_source_idx ON customer_knowledge (workspace_id, source_url)',
    ],
  },
  {
    name: 'customer_chatbots',
    columns: {
      id: 'TEXT PRIMARY KEY',
      workspace_id: 'TEXT NOT NULL REFERENCES customer_workspaces(id) ON DELETE CASCADE',
      name: 'TEXT NOT NULL',
      description: 'TEXT',
      instructions: 'TEXT',
      knowledge_ids: 'JSONB',
      state: "TEXT NOT NULL DEFAULT 'draft'",
      publish_key: 'TEXT',
      approved_by: 'TEXT',
      approved_at: 'BIGINT',
      published_at: 'BIGINT',
      visitor_count: 'BIGINT DEFAULT 0',
      last_used_at: 'BIGINT',
      created_by: 'TEXT',
      created_at: 'BIGINT NOT NULL',
      updated_at: 'BIGINT NOT NULL',
    },
    indexes: [
      'CREATE INDEX IF NOT EXISTS customer_chatbots_workspace_idx ON customer_chatbots (workspace_id)',
      'CREATE INDEX IF NOT EXISTS customer_chatbots_state_idx ON customer_chatbots (state)',
      'CREATE INDEX IF NOT EXISTS customer_chatbots_publish_key_idx ON customer_chatbots (publish_key)',
    ],
  },
  {
    name: 'customer_leads',
    columns: {
      id: 'TEXT PRIMARY KEY',
      chatbot_id: 'TEXT NOT NULL REFERENCES customer_chatbots(id) ON DELETE CASCADE',
      email: 'TEXT',
      name: 'TEXT',
      phone: 'TEXT',
      company: 'TEXT',
      conversation: 'JSONB',
      consent: 'BOOLEAN NOT NULL DEFAULT false',
      consent_text_hash: 'TEXT',
      source_url: 'TEXT',
      user_agent: 'TEXT',
      ip_address: 'TEXT',
      created_at: 'BIGINT NOT NULL',
    },
    indexes: [
      'CREATE INDEX IF NOT EXISTS customer_leads_chatbot_idx ON customer_leads (chatbot_id)',
      'CREATE INDEX IF NOT EXISTS customer_leads_email_idx ON customer_leads (email)',
      'CREATE INDEX IF NOT EXISTS customer_leads_created_idx ON customer_leads (created_at DESC)',
    ],
  },
  {
    name: 'customer_crawl_jobs',
    columns: {
      id: 'TEXT PRIMARY KEY',
      workspace_id: 'TEXT NOT NULL REFERENCES customer_workspaces(id) ON DELETE CASCADE',
      target_url: 'TEXT NOT NULL',
      status: "TEXT NOT NULL DEFAULT 'PENDING'",
      pages_queued: 'INTEGER DEFAULT 0',
      pages_completed: 'INTEGER DEFAULT 0',
      content: 'JSONB',
      error_message: 'TEXT',
      started_at: 'BIGINT',
      completed_at: 'BIGINT',
      created_at: 'BIGINT NOT NULL',
    },
    indexes: [
      'CREATE INDEX IF NOT EXISTS customer_crawl_jobs_workspace_idx ON customer_crawl_jobs (workspace_id)',
    ],
  },
  {
    name: 'customer_conversations',
    columns: {
      id: 'TEXT PRIMARY KEY',
      chatbot_id: 'TEXT NOT NULL REFERENCES customer_chatbots(id) ON DELETE CASCADE',
      publish_key: 'TEXT',
      visitor_id: 'TEXT',
      started_at: 'BIGINT',
      last_activity: 'BIGINT',
    },
    indexes: [
      'CREATE INDEX IF NOT EXISTS customer_conversations_chatbot_idx ON customer_conversations (chatbot_id)',
    ],
  },
  {
    name: 'customer_messages',
    columns: {
      id: 'TEXT PRIMARY KEY',
      conversation_id: 'TEXT NOT NULL REFERENCES customer_conversations(id) ON DELETE CASCADE',
      role: 'TEXT NOT NULL',
      content: 'TEXT NOT NULL',
      source_refs: 'JSONB',
      tokens: 'INTEGER',
      created_at: 'BIGINT NOT NULL',
    },
    indexes: [
      'CREATE INDEX IF NOT EXISTS customer_messages_conversation_idx ON customer_messages (conversation_id)',
    ],
  },
];

/** Column type without constraints, for ALTER TABLE ADD COLUMN on an existing table. */
function bareType(def) {
  return def
    .replace(/\s+PRIMARY KEY/i, '')
    .replace(/\s+REFERENCES[\s\S]*$/i, '')
    .replace(/\s+NOT NULL/i, '');
}

async function existingColumns(table) {
  const { rows } = await pg.query(
    `SELECT column_name, is_nullable, data_type FROM information_schema.columns WHERE table_name = $1`,
    [table]
  );
  return rows;
}

async function tableExists(table) {
  try {
    await pg.query(`SELECT 1 FROM ${table} LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

/** Bring an existing table up to the current design without dropping data. */
async function repair(t, log) {
  let cols;
  try { cols = await existingColumns(t.name); } catch { return; } // no information_schema (tests)
  if (!cols || !cols.length) return;
  const have = new Map(cols.map((c) => [c.column_name, c]));
  for (const [col, def] of Object.entries(t.columns)) {
    if (!have.has(col)) {
      await pg.query(`ALTER TABLE ${t.name} ADD COLUMN ${col} ${bareType(def)}`);
      log.push(`${t.name}: added ${col}`);
    }
  }
  for (const c of cols) {
    if (!t.columns[c.column_name] && c.is_nullable === 'NO') {
      await pg.query(`ALTER TABLE ${t.name} ALTER COLUMN ${c.column_name} DROP NOT NULL`);
      log.push(`${t.name}: ${c.column_name} no longer required`);
    }
  }
  const conv = have.get('conversation');
  if (t.name === 'customer_leads' && conv && /ARRAY/i.test(conv.data_type)) {
    await pg.query('ALTER TABLE customer_leads ALTER COLUMN conversation TYPE JSONB USING to_jsonb(conversation)');
    log.push('customer_leads: conversation converted to JSONB');
  }
  const sourceUrl = have.get('source_url');
  if (t.name === 'customer_leads' && sourceUrl && sourceUrl.is_nullable === 'NO') {
    await pg.query('ALTER TABLE customer_leads ALTER COLUMN source_url DROP NOT NULL');
  }
}

let ready = null;

/** Create / repair every Customer Executive table, once per process. */
function ensureAll() {
  if (!pg.enabled()) return Promise.resolve({ mode: 'files' });
  if (!ready) {
    ready = (async () => {
      const log = [];
      for (const t of TABLES) {
        if (await tableExists(t.name)) {
          await repair(t, log);
        } else {
          const cols = Object.entries(t.columns).map(([c, d]) => `${c} ${d}`).join(',\n  ');
          await pg.query(`CREATE TABLE ${t.name} (\n  ${cols}\n)`);
        }
        for (const ix of t.indexes) {
          try { await pg.query(ix); } catch { /* index exists in another shape */ }
        }
      }
      if (log.length) console.log(`[customer] schema repaired: ${log.join('; ')}`);
      return { mode: 'postgres', repaired: log };
    })().catch((err) => {
      ready = null; // retry on next call
      console.error('[customer] schema setup failed:', err.message);
      throw err;
    });
  }
  return ready;
}

module.exports = { ensureAll, TABLES };
