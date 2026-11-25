/**
 * Customer Executive stores on PostgreSQL (pg-mem). Regressions found in 04.4:
 *   - updateChatbot numbered its SQL parameters wrongly, so on Postgres no
 *     chatbot could be edited, approved or published; it also pasted request
 *     keys into the SQL (injection)
 *   - updateKnowledge had the same parameter bug and JSON.parse'd JSONB values
 *   - listConversations always queried Postgres and then ignored the rows
 *
 *   node test/customer-pg.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { newDb } = require('pg-mem');

delete process.env.DATABASE_URL;
const pgPath = require.resolve('pg');
const mem = newDb();
mem.public.registerFunction({ name: 'to_tsvector', args: ['text', 'text'], returns: 'text', implementation: (_c, t) => t });
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: mem.adapters.createPg() };

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`PASS ${name}`);
  else { failures += 1; console.log(`FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cust-pg-'));
  process.env.ACULYZE_DATA_DIR = dir;
  const pg = require('../src/db/pg');
  await pg.init('postgres://test@localhost/test');
  const store = require('../src/customerExecutive/store');
  const knowledge = require('../src/customerExecutive/knowledge');
  const chatbots = require('../src/customerExecutive/chatbots');
  const conversations = require('../src/customerExecutive/conversations');
  const leads = require('../src/customerExecutive/leads');
  const { answerVisitor } = require('../src/customerExecutive/answer');

  // pg-mem doesn't support GIN full-text indexes; create the schema without them.
  const realQuery = pg.query;
  // pg-mem also rejects CREATE TABLE IF NOT EXISTS for a table that already exists.
  const lenient = async (sql, params) => {
    if (/USING gin/i.test(sql)) return { rows: [] };
    try {
      return await realQuery(sql, params);
    } catch (e) {
      if (/^\s*CREATE (TABLE|INDEX) IF NOT EXISTS/i.test(sql)) return { rows: [] };
      throw e;
    }
  };
  pg.query = lenient;
  // Start from the OLD table design (what Render has today) so the repair is tested.
  await realQuery(`CREATE TABLE customer_workspaces (id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE', created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`);
  await realQuery(`CREATE TABLE customer_knowledge (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, source_url TEXT NOT NULL, content TEXT NOT NULL, content_type TEXT, extracted_at BIGINT NOT NULL, version INTEGER NOT NULL DEFAULT 1)`);
  await realQuery(`CREATE TABLE customer_chatbots (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, config JSONB NOT NULL, publish_key TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'DRAFT', approved_by TEXT, approved_at BIGINT, approved_version INTEGER, published_at BIGINT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`);
  await realQuery(`CREATE TABLE customer_leads (id TEXT PRIMARY KEY, chatbot_id TEXT NOT NULL, workspace_id TEXT NOT NULL, visitor_id TEXT, fields JSONB NOT NULL, consent_given BOOLEAN NOT NULL DEFAULT FALSE, consent_at BIGINT, created_at BIGINT NOT NULL)`);
  await realQuery(`CREATE TABLE customer_conversations (id TEXT PRIMARY KEY, chatbot_id TEXT NOT NULL, publish_key TEXT NOT NULL, visitor_id TEXT, created_at BIGINT NOT NULL, last_activity BIGINT NOT NULL)`);
  const repair = await require('../src/customerExecutive/schema').ensureAll().catch((e) => ({ error: e.message }));
  check('old-design tables repaired', repair && Array.isArray(repair.repaired) && repair.repaired.length > 5, JSON.stringify(repair).slice(0, 300));
  await store.ensureSchema();
  await knowledge.ensureSchema();
  await chatbots.ensureSchema();
  await conversations.ensureSchema();
  if (leads.ensureSchema) await leads.ensureSchema();
  pg.query = realQuery;

  try {
    const ws = await store.createWorkspace(dir, { creatorId: 'u1', name: 'Acme' });
    const cb = await chatbots.createChatbot(dir, { workspaceId: ws.id, name: 'Acme Bot', description: 'd', instructions: 'Be kind', knowledgeIds: ['kg-1'], createdBy: 'u1' });
    check('chatbot created', cb && cb.id);

    console.log('\n=== updateChatbot on Postgres ===');
    const edited = await chatbots.updateChatbot(dir, ws.id, cb.id, { name: 'Renamed', knowledge_ids: ['kg-2', 'kg-3'] });
    check('edit returns the chatbot', edited && edited.name === 'Renamed', JSON.stringify(edited));
    const kids = edited && (typeof edited.knowledge_ids === 'string' ? JSON.parse(edited.knowledge_ids) : edited.knowledge_ids);
    check('JSONB array saved', Array.isArray(kids) && kids.length === 2);
    check('updated_at is a timestamp', edited && Number(edited.updated_at) > 1e12, String(edited && edited.updated_at));
    const injected = await chatbots.updateChatbot(dir, ws.id, cb.id, { 'name = \'x\'; DROP TABLE customer_chatbots; --': 1, description: 'safe' });
    check('unknown / malicious keys ignored', injected && injected.description === 'safe');
    check('table still exists', (await chatbots.getChatbot(dir, ws.id, cb.id)) !== null);

    const approved = await chatbots.approveChatbot(dir, ws.id, cb.id, 'u1', 'employee');
    check('approve works on Postgres', approved && approved.state === 'approved', JSON.stringify(approved));
    const published = await chatbots.publishChatbot(dir, ws.id, cb.id);
    check('publish works on Postgres', published && published.state === 'published' && /^pub_/.test(published.publish_key), JSON.stringify(published));
    const byKey = await chatbots.getChatbotByPublishKey(dir, published.publish_key);
    check('found by publish key', byKey && byKey.id === cb.id);
    const unpub = await chatbots.unpublishChatbot(dir, ws.id, cb.id);
    check('unpublish works', unpub && unpub.state === 'approved' && !unpub.publish_key);

    console.log('\n=== knowledge on Postgres ===');
    const k = await knowledge.addKnowledge(dir, { workspaceId: ws.id, sourceUrl: 'https://acme.example/pricing', content: { headings: ['Pricing'], paragraphs: ['The Growth plan costs 2499 rupees per month.'] }, contentType: 'crawl_result' });
    const ku = await knowledge.updateKnowledge(dir, ws.id, k.id, { content_content: 'The Growth plan costs 2999 rupees per month.', content_headings: ['Pricing 2'], bogus: 'x' });
    check('updateKnowledge works', ku && /2999/.test(ku.content_content) && ku.content_headings[0] === 'Pricing 2', JSON.stringify(ku));
    check('version bumped', ku && Number(ku.version) === 2);
    const items = await knowledge.getKnowledge(dir, ws.id);
    const r = await answerVisitor({ dataDir: dir, chatbot: { ...cb, workspace_id: ws.id }, message: 'growth plan cost', items });
    check('retrieval reads Postgres rows (JSONB headings)', r.sources[0] && r.sources[0].url === 'https://acme.example/pricing' && r.sources[0].title === 'Pricing 2', JSON.stringify(r.sources));

    console.log('\n=== conversations on Postgres ===');
    const conv = await conversations.createConversation(dir, { chatbotId: cb.id, publishKey: 'pub_x', visitorId: null });
    await conversations.addMessage(dir, { conversationId: conv.id, role: 'user', content: 'hi' });
    const list = await conversations.listConversations(dir, { chatbotId: cb.id });
    check('listConversations returns Postgres rows', list.length === 1 && list[0].id === conv.id, JSON.stringify(list));

    console.log('\n=== leads on Postgres ===');
    const lead = await leads.createLead(dir, { chatbotId: cb.id, email: 'p@example.com', name: 'Priya', conversation: [{ role: 'user', content: 'hi' }], consent: true, sourceUrl: '' });
    check('lead with a transcript saved (JSONB, was TEXT[])', lead && lead.id && !lead.error, JSON.stringify(lead).slice(0, 200));
    const ll = await leads.listLeads(dir, cb.id);
    const convo = ll[0] && (typeof ll[0].conversation === 'string' ? JSON.parse(ll[0].conversation) : ll[0].conversation);
    check('lead transcript reads back', Array.isArray(convo) && convo[0].content === 'hi', JSON.stringify(ll[0]));
  } catch (err) {
    failures += 1;
    console.log('FAIL unexpected error:', err.stack);
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\nRESULT: ${failures} FAILED` : '\nRESULT: OK — customer stores work on Postgres');
  process.exit(failures ? 1 : 0);
}

main();
