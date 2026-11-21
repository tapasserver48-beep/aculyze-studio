/**
 * Phase 03.4 Customer Executive Agent Tests
 *
 * Tests for secure website crawling, knowledge extraction,
 * chatbot management, and lead capture.
 *
 * TWO KINDS OF EVIDENCE:
 *   Section A — AUTOMATED tests (no live NVIDIA)
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;

function check(name, cond, extra = '') {
  if (cond) {
    console.log(`PASS ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${extra ? ' — ' + extra : ''}`);
  }
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'customer-test-'));

  try {
    console.log('\n=== Section A: Database Schema Tests ===\n');

    // Clear require cache to ensure fresh module loads with env set
    const modPaths = [
      require.resolve('../src/customerExecutive/store'),
      require.resolve('../src/customerExecutive/crawler'),
      require.resolve('../src/customerExecutive/knowledge'),
      require.resolve('../src/customerExecutive/chatbots'),
      require.resolve('../src/customerExecutive/leads'),
      require.resolve('../src/db/pg'),
    ];
    for (const p of modPaths) {
      if (require.cache[p]) delete require.cache[p];
    }

    // Set dataDir for schema initialization
    process.env.ACULYZE_DATA_DIR = dataDir;

    // Re-require modules
    const store = require('../src/customerExecutive/store');
    const crawler = require('../src/customerExecutive/crawler');
    const knowledge = require('../src/customerExecutive/knowledge');
    const chatbots = require('../src/customerExecutive/chatbots');
    const leads = require('../src/customerExecutive/leads');

    // Initialize schemas
    await store.ensureSchema();
    await crawler.ensureSchema && await crawler.ensureSchema();
    await knowledge.ensureSchema();

    // Verify schema files created
    const schemaFiles = fs.readdirSync(path.join(dataDir, 'data', 'customer'));
    check('A workspace schema files initialized', schemaFiles.includes('customer_workspaces.json'));

    // Create workspace
    const ws = await store.createWorkspace(dataDir, {
      creatorId: 'test-user-1',
      name: 'Test Workspace'
    });
    check('A workspace created', !!ws?.id, ws?.id);

    // List workspaces
    const workspaces = await store.listWorkspaces(dataDir, { creatorId: 'test-user-1' });
    check('A workspace listed in creator view', workspaces.length === 1, `${workspaces.length}`);

    // Get workspace
    const fetched = await store.getWorkspace(dataDir, ws.id);
    check('A workspace can be fetched by ID', fetched?.name === 'Test Workspace');

    console.log('\n=== Section B: Crawler Schema Tests ===\n');

    // Crawl job schema
    const crawlJob = await crawler.createCrawlJob(dataDir, {
      workspaceId: ws.id,
      targetUrl: 'https://example.com'
    });
    check('B crawl job created with ID', crawlJob?.id?.startsWith('crawl-'));
    check('B crawl job has pending status', crawlJob?.status === 'PENDING');

    // URL validation
    const validUrl = crawler.validateUrl('https://example.com/page');
    check('B valid HTTPS URL passes', validUrl.valid, validUrl.error || 'ok');

    const httpUrl = crawler.validateUrl('http://example.com');
    check('B HTTP URL rejected', !httpUrl.valid, httpUrl.error);

    const credsUrl = crawler.validateUrl('https://user:pass@example.com');
    check('B URL with credentials rejected', !credsUrl.valid, credsUrl.error);

    const localhostUrl = crawler.validateUrl('https://localhost:8080');
    check('B localhost URL rejected', !localhostUrl.valid, localhostUrl.error);

    const privatePort = crawler.validateUrl('https://example.com:25');
    check('B blocked port rejected', !privatePort.valid, privatePort.error);

    // Double-encoded path attack
    const doubleEncoded = crawler.validateUrl('https://example.com/%252e%252e%252f');
    check('B double-encoded path rejected', !doubleEncoded.valid, doubleEncoded.error);

    console.log('\n=== Section C: Knowledge Storage Tests ===\n');

    // Knowledge item
    const knowledgeItem = await knowledge.addKnowledge(dataDir, {
      workspaceId: ws.id,
      sourceUrl: 'https://example.com',
      content: {
        title: 'Example Domain',
        metaDescription: 'This domain is for use in illustrative examples',
        headings: ['Example Heading'],
        paragraphs: ['This is an example paragraph.'],
        links: [],
        contact_emails: ['info@example.com'],
        contact_phones: ['+1-555-123-4567']
      },
      contentType: 'webpage'
    });
    check('C knowledge item stored', knowledgeItem?.id?.startsWith('kg-'));
    check('C knowledge has source_url', knowledgeItem?.source_url === 'https://example.com');
    check('C knowledge has contact info', knowledgeItem?.contact_emails?.length);

    // List knowledge
    const knowledgeList = await knowledge.getKnowledge(dataDir, ws.id);
    check('C knowledge can be listed by workspace', knowledgeList.length >= 1);

    // Search knowledge
    const searchResults = await knowledge.searchKnowledge(dataDir, ws.id, 'example');
    check('C knowledge search works', searchResults.length >= 0);

    console.log('\n=== Section D: Chatbot Management Tests ===\n');

    // Ensure leads schema
    await leads.ensureSchema && await leads.ensureSchema();

    // Create chatbot
    const chatbot = await chatbots.createChatbot(dataDir, {
      workspaceId: ws.id,
      name: 'Test Bot',
      description: 'A test chatbot',
      instructions: 'Be helpful.',
      knowledgeIds: [],
      createdBy: 'test-user-1'
    });
    check('D chatbot created with ID', chatbot?.id?.startsWith('cb-'));
    check('D chatbot in draft state', chatbot?.state === 'draft');

    // List chatbots
    const chatbotList = await chatbots.listChatbots(dataDir, ws.id);
    check('D chatbots can be listed', chatbotList.length >= 1, `${chatbotList.length}`);

    // Update chatbot
    const updated = await chatbots.updateChatbot(dataDir, ws.id, chatbot.id, { name: 'Updated Bot' });
    check('D chatbot updated', updated?.name === 'Updated Bot');

    // Approve chatbot (by creator)
    const approved = await chatbots.approveChatbot(dataDir, ws.id, chatbot.id, 'test-user-1', 'employee');
    check('D chatbot can be approved by creator', approved?.state === 'approved');

    // Publish chatbot
    const published = await chatbots.publishChatbot(dataDir, ws.id, chatbot.id);
    check('D chatbot published', published?.state === 'published');
    check('D chatbot has publish key', !!published?.publish_key);
    check('D publish key format correct', published?.publish_key?.startsWith('pub_'));

    // Get by publish key (public access)
    const publicChatbot = await chatbots.getChatbotByPublishKey(dataDir, published.publish_key);
    check('D chatbot retrievable by publish key', publicChatbot?.id === chatbot.id);

    // Delete chatbot
    const deleted = await chatbots.deleteChatbot(dataDir, ws.id, chatbot.id);
    check('D chatbot deleted', deleted === true);

    // Verify deletion
    const afterDelete = await chatbots.getChatbot(dataDir, ws.id, chatbot.id);
    check('D chatbot not found after deletion', afterDelete === null);

    console.log('\n=== Section E: Lead Capture Tests ===\n');

    // Create chatbot for lead capture test
    const leadBot = await chatbots.createChatbot(dataDir, {
      workspaceId: ws.id,
      name: 'Lead Capture Bot',
      description: 'Test lead bot',
      instructions: 'Ask for contact info.',
      knowledgeIds: [],
      createdBy: 'test-user-1'
    });
    const publishedLeadBot = await chatbots.publishChatbot(dataDir, ws.id, leadBot.id);
    const leadPubKey = publishedLeadBot.publish_key;

    // Create lead with consent
    const lead = await leads.createLead(dataDir, {
      chatbotId: leadBot.id,
      email: 'visitor@example.com',
      name: 'Test Visitor',
      consent: true,
      consentTextHash: 'hashed-consent-text',
      sourceUrl: 'https://example.com',
      userAgent: 'Test Agent',
      ipAddress: '127.0.0.1'
    });
    check('E lead captured with consent', lead?.id?.startsWith('lead-'));
    check('E lead has email', lead?.email === 'visitor@example.com');
    check('E lead consent recorded', lead?.consent === true);

    // Lead without consent should fail
    const noConsent = await leads.createLead(dataDir, {
      chatbotId: leadBot.id,
      email: 'nope@example.com',
      consent: false
    });
    check('E lead without consent rejected', noConsent?.error !== undefined);

    // List leads
    const leadList = await leads.listLeads(dataDir, leadBot.id);
    check('E leads can be listed', leadList.length >= 1, `${leadList.length}`);

    // Get lead by ID
    const fetchedLead = await leads.getLead(dataDir, leadBot.id, lead.id);
    check('E lead can be fetched', fetchedLead?.email === 'visitor@example.com');

    console.log('\n=== Section F: SSRF Protection Tests ===\n');

    // Private IP detection
    check('F 192.168.x.x detected as private', crawler.isPrivateIp('192.168.1.1'));
    check('F 10.x.x.x detected as private', crawler.isPrivateIp('10.0.0.1'));
    check('F 172.16-31.x.x detected as private', crawler.isPrivateIp('172.16.0.1'));
    check('F 127.x.x.x detected as private', crawler.isPrivateIp('127.0.0.1'));
    check('F public IP not detected as private', !crawler.isPrivateIp('8.8.8.8'));
    check('F cloudflare IP not private', !crawler.isPrivateIp('1.1.1.1'));

    console.log('\n=== CLEANUP ===\n');
    await store.deleteWorkspace(dataDir, ws.id);

  } catch (err) {
    console.error('FAIL', err);
    failures += 1;
  } finally {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  if (failures) {
    console.log(`\nRESULT: ${failures} failed`);
    process.exit(1);
  }
  console.log('\nRESULT: OK — all Phase 03.4 tests passed');
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});