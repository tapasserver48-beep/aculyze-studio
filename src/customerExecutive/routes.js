/**
 * /api/customer — Customer Executive API endpoints.
 *
 * Management APIs (authenticated):
 *   POST   /api/customer/workspaces        Create workspace
 *   GET    /api/customer/workspaces        List workspaces
 *   GET    /api/customer/workspaces/:id    Read workspace
 *   PUT    /api/customer/workspaces/:id    Update workspace
 *   DELETE /api/customer/workspaces/:id    Delete workspace
 *   POST   /api/customer/workspaces/:id/crawl   Submit crawl job
 *   GET    /api/customer/workspaces/:id/crawl   Get crawl status
 *   GET    /api/customer/workspaces/:id/knowledge  List knowledge
 *   POST   /api/customer/chatbots           Create chatbot
 *   GET    /api/customer/chatbots           List chatbots
 *   PUT    /api/customer/chatbots/:id       Update chatbot
 *   POST   /api/customer/chatbots/:id/approve Approve chatbot
 *   POST   /api/customer/chatbots/:id/publish Publish chatbot
 *   GET    /api/customer/chatbots/:id/leads   List leads
 *   GET    /api/customer/chatbots/:id/analytics Analytics
 *
 * Public visitor APIs:
 *   GET    /api/customer/public/:publishKey/chatbot  Load chatbot config
 *   POST   /api/customer/public/:publishKey/converse  Chat message
 *   POST   /api/customer/public/:publishKey/leads   Capture lead (with consent)
 */

const express = require('express');
const crypto = require('crypto');
const { answerVisitor } = require('./answer');
const crawlJobs = require('./crawlJobs');
const { requireUser } = require('../auth/authorize');
const pg = require('../db/pg');
const {
  createWorkspace, getWorkspace, listWorkspaces, updateWorkspace, deleteWorkspace
} = require('./store');
const { ensureSchema } = require('./store');
const { canAccessWorkspace } = require('./store');
const {
  createCrawlJob, executeCrawlJob, getCrawlJob, listCrawlJobs
} = require('./crawler');

// Import conversations module for chat history tracking
const {
  ensureSchema: ensureConversationsSchema,
  createConversation, getConversation, listConversations, updateConversation,
  addMessage, listMessages
} = require('./conversations');

function createCustomerExecutiveRouter({ dataDir, llm = null }) {
  const router = express.Router();

  // Ensure database schema on mount
  ensureSchema();
  ensureConversationsSchema();

  // ---- Public Visitor Endpoints (no sign-in) ----
  // Registered BEFORE requireUser: website visitors are anonymous. (They used
  // to sit after it, so every visitor got "Please sign in".)

  // Anonymous visitors trigger AI calls, so cap them per visitor IP and per chatbot.
  const visitorHits = new Map(); // `${key}:${ip}` → [timestamps]
  const botHits = new Map(); // key → { day, count }
  const VISITOR_PER_MIN = Number(process.env.CUSTOMER_BOT_PER_MIN || 12);
  const BOT_PER_DAY = Number(process.env.CUSTOMER_BOT_PER_DAY || 2000);
  function rateLimited(key, ip) {
    const now = Date.now();
    const vk = `${key}:${ip}`;
    const recent = (visitorHits.get(vk) || []).filter((t) => now - t < 60000);
    if (recent.length >= VISITOR_PER_MIN) return 'Too many messages. Please wait a minute and try again.';
    recent.push(now);
    visitorHits.set(vk, recent);
    if (visitorHits.size > 5000) visitorHits.delete(visitorHits.keys().next().value);
    const day = new Date().toISOString().slice(0, 10);
    const b = botHits.get(key);
    const entry = b && b.day === day ? b : { day, count: 0 };
    if (entry.count >= BOT_PER_DAY) return 'This assistant has reached its daily limit. Please try again tomorrow.';
    entry.count += 1;
    botHits.set(key, entry);
    return null;
  }

  router.get('/public/:publishKey', async (req, res) => {
    try {
      const chatbot = await getChatbotByPublishKey(dataDir, req.params.publishKey);
      if (!chatbot) return res.status(404).json({ error: 'Chatbot not found or not published' });
      await updateChatbot(dataDir, chatbot.workspace_id, chatbot.id, {
        visitor_count: (Number(chatbot.visitor_count) || 0) + 1,
      }).catch(() => {});
      // Public data only: the business's private instructions stay on the server.
      res.json({ chatbot: { id: chatbot.id, name: chatbot.name, description: chatbot.description } });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/public/:publishKey/converse', async (req, res) => {
    try {
      const chatbot = await getChatbotByPublishKey(dataDir, req.params.publishKey);
      if (!chatbot) return res.status(404).json({ error: 'Chatbot not found or not published' });

      const message = String((req.body && req.body.message) || '').trim();
      if (!message) return res.status(400).json({ error: 'Message required' });
      if (message.length > 1000) return res.status(400).json({ error: 'Message is too long (1000 characters max).' });
      const limited = rateLimited(chatbot.publish_key, req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
      if (limited) return res.status(429).json({ error: limited });

      updateChatbot(dataDir, chatbot.workspace_id, chatbot.id, { last_used_at: Date.now() }).catch(() => {});

      // Continue a conversation only if it belongs to this chatbot; history comes
      // from the server, never from the browser.
      let conversationId = req.body && req.body.conversationId;
      let history = [];
      const existing = conversationId ? await getConversation(dataDir, conversationId) : null;
      if (existing && existing.chatbot_id === chatbot.id) {
        history = (await listMessages(dataDir, conversationId)).map((m) => ({ role: m.role, content: m.content }));
      } else {
        const conv = await createConversation(dataDir, { chatbotId: chatbot.id, publishKey: chatbot.publish_key, visitorId: null });
        conversationId = conv.id;
      }

      await addMessage(dataDir, { conversationId, role: 'user', content: message });
      const result = await answerVisitor({ dataDir, chatbot, message, history, llm });
      await addMessage(dataDir, {
        conversationId,
        role: 'assistant',
        content: result.answer,
        sourceRefs: result.sources.map((s) => ({ knowledgeId: s.knowledgeId, url: s.url })),
        tokens: result.answer.split(/\s+/).length,
      });
      await updateConversation(dataDir, conversationId, { last_activity: Date.now() }).catch(() => {});

      res.json({
        response: result.answer,
        sources: result.sources.map((s) => s.url),
        sourceDetails: result.sources.map((s) => ({ url: s.url, title: s.title })),
        grounded: result.grounded,
        offerContact: !result.grounded,
        conversationId,
      });
    } catch (e) {
      console.error('[customer] converse failed:', e.message);
      res.status(500).json({ error: 'The assistant could not answer just now. Please try again.' });
    }
  });

  router.post('/public/:publishKey/leads', async (req, res) => {
    try {
      const chatbot = await getChatbotByPublishKey(dataDir, req.params.publishKey);
      if (!chatbot) return res.status(404).json({ error: 'Chatbot not found or not published' });
      const limited = rateLimited(chatbot.publish_key, req.ip || 'unknown');
      if (limited) return res.status(429).json({ error: limited });

      const { email, name, phone, company, consent, consentText, conversationId } = req.body || {};
      const consentTextHash = consent && consentText
        ? crypto.createHash('sha256').update(String(consentText)).digest('hex')
        : null;
      // Attach the chat transcript when the conversation belongs to this chatbot.
      let conversation = [];
      const conv = conversationId ? await getConversation(dataDir, conversationId) : null;
      if (conv && conv.chatbot_id === chatbot.id) {
        conversation = (await listMessages(dataDir, conversationId)).slice(-20).map((m) => ({ role: m.role, content: String(m.content).slice(0, 1000) }));
      }

      const lead = await createLead(dataDir, {
        chatbotId: chatbot.id,
        email,
        name,
        phone,
        company,
        conversation,
        consent: consent === true,
        consentTextHash,
        sourceUrl: req.get('Referer') || req.get('Origin') || '',
        userAgent: req.get('User-Agent'),
        ipAddress: req.ip || (req.socket && req.socket.remoteAddress),
      });
      if (lead.error) return res.status(400).json({ error: lead.error });
      res.status(201).json({ lead: { id: lead.id, consent: lead.consent } });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- Authenticated Management APIs ----
  router.use(requireUser);

  // Workspace CRUD
  router.post('/workspaces', async (req, res) => {
    try {
      const { name } = req.body;
      if (!name) return res.status(400).json({ error: 'Name required' });

      const workspace = await createWorkspace(dataDir, {
        creatorId: req.user.id,
        name
      });
      res.status(201).json({ workspace });
    } catch (e) {
      console.error('[CustomerExecutive]', e);
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/workspaces', async (req, res) => {
    try {
      const workspaces = await listWorkspaces(dataDir, { creatorId: req.user.id });
      res.json({ workspaces });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/workspaces/:id', async (req, res) => {
    try {
      const workspace = await getWorkspace(dataDir, req.params.id);
      if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

      // Authorization check
      const { AUTHORIZATION_ROLES, canAccessWorkspace } = require('./store');
      if (!canAccessWorkspace(req.user.role, req.user.id, workspace.creator_id)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      res.json({ workspace });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put('/workspaces/:id', async (req, res) => {
    try {
      const workspace = await getWorkspace(dataDir, req.params.id);
      if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

      if (workspace.creator_id !== req.user.id && !['founder', 'admin'].includes(req.user.role)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const updated = await updateWorkspace(dataDir, req.params.id, req.body);
      res.json({ workspace: updated });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.delete('/workspaces/:id', async (req, res) => {
    try {
      const workspace = await getWorkspace(dataDir, req.params.id);
      if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

      if (workspace.creator_id !== req.user.id && !['founder', 'admin'].includes(req.user.role)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      await deleteWorkspace(dataDir, req.params.id);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- Crawl Endpoints ----
  router.post('/workspaces/:id/crawl', async (req, res) => {
    try {
      const workspace = await getWorkspace(dataDir, req.params.id);
      if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

      if (!canAccessWorkspace(req.user.role, req.user.id, workspace.creator_id)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { targetUrl } = req.body;
      if (!targetUrl) return res.status(400).json({ error: 'targetUrl required' });

      const job = await createCrawlJob(dataDir, {
        workspaceId: req.params.id,
        targetUrl
      });
      res.status(201).json({ job });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/workspaces/:id/crawl/:jobId/execute', async (req, res) => {
    try {
      const job = await getCrawlJob(dataDir, req.params.jobId);
      if (!job) return res.status(404).json({ error: 'Crawl job not found' });

      if (job.workspace_id !== req.params.id) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const result = await executeCrawlJob(dataDir, req.params.jobId);
      res.json({ job: result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/workspaces/:id/crawl', async (req, res) => {
    try {
      const jobs = await listCrawlJobs(dataDir, req.params.id);
      res.json({ jobs });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/workspaces/:id/crawl/:jobId', async (req, res) => {
    try {
      const job = await getCrawlJob(dataDir, req.params.jobId);
      if (!job) return res.status(404).json({ error: 'Crawl job not found' });

      if (job.workspace_id !== req.params.id) {
        return res.status(403).json({ error: 'Access denied' });
      }

      res.json({ job });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- Knowledge Endpoints ----
  const {
    searchKnowledge, getChatbotResponse,
    addKnowledge, getKnowledge, getKnowledgeBySource,
    updateKnowledge, deleteKnowledge
  } = require('./knowledge');

  // Crawl job import for integration
  const { getCrawlJob } = require('./crawler');

  router.get('/workspaces/:id/knowledge', async (req, res) => {
    try {
      const workspace = await getWorkspace(dataDir, req.params.id);
      if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

      if (!canAccessWorkspace(req.user.role, req.user.id, workspace.creator_id)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const knowledge = await getKnowledge(dataDir, req.params.id);
      res.json({ knowledge });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/workspaces/:id/knowledge', async (req, res) => {
    try {
      const workspace = await getWorkspace(dataDir, req.params.id);
      if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

      if (!canAccessWorkspace(req.user.role, req.user.id, workspace.creator_id)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { sourceUrl, content, contentType } = req.body;
      if (!sourceUrl) return res.status(400).json({ error: 'sourceUrl required' });

      const item = await addKnowledge(dataDir, {
        workspaceId: req.params.id,
        sourceUrl,
        content,
        contentType
      });
      res.status(201).json({ knowledge: item });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/workspaces/:id/knowledge/search', async (req, res) => {
    try {
      const workspace = await getWorkspace(dataDir, req.params.id);
      if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

      if (!canAccessWorkspace(req.user.role, req.user.id, workspace.creator_id)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { q } = req.query;
      if (!q) return res.status(400).json({ error: 'Query parameter q required' });

      const results = await searchKnowledge(dataDir, req.params.id, q);
      res.json({ results });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/workspaces/:id/knowledge/chat-response', async (req, res) => {
    try {
      const workspace = await getWorkspace(dataDir, req.params.id);
      if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

      if (!canAccessWorkspace(req.user.role, req.user.id, workspace.creator_id)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { q } = req.query;
      if (!q) return res.status(400).json({ error: 'Query parameter q required' });

      const response = await getChatbotResponse(dataDir, req.params.id, q);
      res.json({ response });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- Integration: Add knowledge from crawl results ----
  router.get('/workspaces/:id/crawl/:jobId/knowledge', async (req, res) => {
    try {
      const job = await getCrawlJob(dataDir, req.params.jobId);
      if (!job) return res.status(404).json({ error: 'Crawl job not found' });

      if (job.workspace_id !== req.params.id) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Persist crawl results to knowledge if not already done
      const contentItems = job.content || [];
      const persisted = [];

      for (const item of contentItems) {
        if (item.sourceUrl) {
          const existing = await getKnowledgeBySource(dataDir, req.params.id, item.sourceUrl);
          if (!existing || existing.length === 0) {
            const kg = await addKnowledge(dataDir, {
              workspaceId: req.params.id,
              sourceUrl: item.sourceUrl,
              content: item,
              contentType: 'crawl_result'
            });
            persisted.push(kg);
          }
        }
      }

      res.json({ 
        crawlJobId: req.params.jobId,
        pagesCrawled: contentItems.length,
        knowledgePersisted: persisted.length 
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- Knowledge CRUD ----
  router.get('/workspaces/:id/knowledge/search', async (req, res) => {
    try {
      const workspace = await getWorkspace(dataDir, req.params.id);
      if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

      if (!canAccessWorkspace(req.user.role, req.user.id, workspace.creator_id)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { q } = req.query;
      if (!q) return res.status(400).json({ error: 'Query parameter q required' });

      const results = await searchKnowledge(dataDir, req.params.id, q);
      res.json({ results });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.delete('/workspaces/:id/knowledge/:knowledgeId', async (req, res) => {
    try {
      const w = await getWorkspace(dataDir, req.params.id);
      if (!w) return res.status(404).json({ error: 'Workspace not found' });

      if (!canAccessWorkspace(req.user.role, req.user.id, w.creator_id)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Get specific knowledge item first
      const allK = await getKnowledge(dataDir, req.params.id);
      const target = allK.find(k => k.id === req.params.knowledgeId || k.source_url === req.params.knowledgeId);
      if (!target) return res.status(404).json({ error: 'Knowledge not found' });

      const deleted = await deleteKnowledge(dataDir, req.params.id, target.id);
      res.json({ success: deleted });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put('/workspaces/:id/knowledge/:knowledgeId', async (req, res) => {
    try {
      const w = await getWorkspace(dataDir, req.params.id);
      if (!w) return res.status(404).json({ error: 'Workspace not found' });

      if (!canAccessWorkspace(req.user.role, req.user.id, w.creator_id)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const allK = await getKnowledge(dataDir, req.params.id);
      const target = allK.find(k => k.id === req.params.knowledgeId || k.source_url === req.params.knowledgeId);
      if (!target) return res.status(404).json({ error: 'Knowledge not found' });

      const updated = await updateKnowledge(dataDir, req.params.id, target.id, req.body);
      res.json({ knowledge: updated });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/workspaces/:id/knowledge/:knowledgeId', async (req, res) => {
    try {
      const w = await getWorkspace(dataDir, req.params.id);
      if (!w) return res.status(404).json({ error: 'Workspace not found' });

      if (!canAccessWorkspace(req.user.role, req.user.id, w.creator_id)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Get by ID - need to find in knowledge list
      const allK = await getKnowledge(dataDir, req.params.id);
      const target = allK.find(k => k.id === req.params.knowledgeId || k.source_url === req.params.knowledgeId);
      res.json({ knowledge: target || null });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- Chatbot Management Endpoints ----
  const {
    createChatbot, getChatbot, listChatbots, updateChatbot, deleteChatbot,
    approveChatbot, publishChatbot, unpublishChatbot, getChatbotByPublishKey
  } = require('./chatbots');

  const {
    ensureSchema: ensureLeadsSchema, createLead, listLeads, getLead
  } = require('./leads');

  // Ensure leads schema
  ensureLeadsSchema();

  router.post('/chatbots', async (req, res) => {
    try {
      const { name, description, instructions, knowledgeIds } = req.body;
      if (!name) return res.status(400).json({ error: 'Name required' });

      // Find workspace to associate (default to user's first workspace)
      const workspace = await getWorkspace(dataDir, req.body.workspaceId);
      if (!workspace) return res.status(400).json({ error: 'workspaceId required' });

      if (!canAccessWorkspace(req.user.role, req.user.id, workspace.creator_id)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const chatbot = await createChatbot(dataDir, {
        workspaceId: workspace.id,
        name,
        description,
        instructions,
        knowledgeIds,
        createdBy: req.user.id
      });
      res.status(201).json({ chatbot });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/chatbots', async (req, res) => {
    try {
      // Find user's workspaces
      const workspaces = await listWorkspaces(dataDir, { creatorId: req.user.id });
      if (workspaces.length === 0) return res.json({ chatbots: [] });

      const workspaceIds = workspaces.map(w => w.id);
      const allChatbots = [];
      for (const wid of workspaceIds) {
        const chatbots = await listChatbots(dataDir, wid);
        allChatbots.push(...chatbots);
      }

      res.json({ chatbots: allChatbots });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/chatbots/:id', async (req, res) => {
    try {
      // Find the chatbot across user's workspaces
      const workspaces = await listWorkspaces(dataDir, { creatorId: req.user.id });
      for (const w of workspaces) {
        const chatbot = await getChatbot(dataDir, w.id, req.params.id);
        if (chatbot) return res.json({ chatbot });
      }
      res.status(404).json({ error: 'Chatbot not found' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put('/chatbots/:id', async (req, res) => {
    try {
      // Find the chatbot and verify ownership
      const workspaces = await listWorkspaces(dataDir, { creatorId: req.user.id });
      let found = null;
      for (const w of workspaces) {
        const chatbot = await getChatbot(dataDir, w.id, req.params.id);
        if (chatbot) {
          found = { workspace: w, chatbot };
          break;
        }
      }
      if (!found) return res.status(404).json({ error: 'Chatbot not found' });

      // Only the content can be edited here. State, publish key and approval
      // go through /approve, /publish and /unpublish.
      const { name, description, instructions } = req.body || {};
      const changes = {};
      if (typeof name === 'string') {
        if (!name.trim()) return res.status(400).json({ error: 'Name cannot be empty' });
        changes.name = name.trim().slice(0, 80);
      }
      if (typeof description === 'string') changes.description = description.slice(0, 500);
      if (typeof instructions === 'string') changes.instructions = instructions.slice(0, 4000);
      const updated = await updateChatbot(dataDir, found.workspace.id, req.params.id, changes);
      res.json({ chatbot: updated });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.delete('/chatbots/:id', async (req, res) => {
    try {
      const workspaces = await listWorkspaces(dataDir, { creatorId: req.user.id });
      for (const w of workspaces) {
        const deleted = await deleteChatbot(dataDir, w.id, req.params.id);
        if (deleted) return res.json({ success: true });
      }
      res.status(404).json({ error: 'Chatbot not found' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- Customer Executive page (Phase 04.4) ----
  async function ownWorkspace(req, res) {
    const workspace = await getWorkspace(dataDir, req.params.id);
    if (!workspace) { res.status(404).json({ error: 'Workspace not found' }); return null; }
    if (!canAccessWorkspace(req.user.role, req.user.id, workspace.creator_id)) { res.status(403).json({ error: 'Access denied' }); return null; }
    return workspace;
  }

  // Everything the page needs for one workspace, in one call.
  router.get('/workspaces/:id/overview', async (req, res) => {
    try {
      const workspace = await ownWorkspace(req, res);
      if (!workspace) return;
      const { pageTitle } = require('./retrieval');
      const items = await getKnowledge(dataDir, workspace.id);
      const pages = items.map((k) => ({
        id: k.id,
        url: k.source_url,
        title: pageTitle(k),
        words: String(k.content_content || '').split(/\s+/).filter(Boolean).length,
        extractedAt: Number(k.extracted_at) || null,
      }));
      const bots = await listChatbots(dataDir, workspace.id);
      const chatbots = [];
      for (const b of bots) {
        const full = await getChatbot(dataDir, workspace.id, b.id);
        const leadList = await listLeads(dataDir, b.id).catch(() => []);
        chatbots.push({ ...full, leadCount: leadList.length });
      }
      res.json({ workspace, pages, chatbots, crawl: crawlJobs.status(dataDir, workspace.id) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/workspaces/:id/site-crawl', async (req, res) => {
    try {
      const workspace = await ownWorkspace(req, res);
      if (!workspace) return;
      let url = String((req.body && req.body.url) || '').trim();
      if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
      url = url.replace(/^http:\/\//i, 'https://');
      const { validateUrl } = require('./crawler');
      const v = validateUrl(url);
      if (!v.valid) return res.status(400).json({ error: `That website address can't be crawled: ${v.error}` });
      const r = crawlJobs.start({ dataDir, workspaceId: workspace.id, url, maxPages: req.body && req.body.maxPages, userId: req.user.id });
      if (r.error) return res.status(409).json({ error: r.error, job: r.job });
      res.status(202).json({ job: r.job });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/workspaces/:id/site-crawl', async (req, res) => {
    try {
      const workspace = await ownWorkspace(req, res);
      if (!workspace) return;
      res.json({ job: crawlJobs.status(dataDir, workspace.id) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.delete('/workspaces/:id/site-crawl', async (req, res) => {
    try {
      const workspace = await ownWorkspace(req, res);
      if (!workspace) return;
      res.json({ cancelled: crawlJobs.cancel(workspace.id) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/chatbots/:id/unpublish', async (req, res) => {
    try {
      const { workspace, chatbot } = await findChatbot(req.user, req.params.id);
      if (!chatbot) return res.status(404).json({ error: 'Chatbot not found' });
      const updated = await unpublishChatbot(dataDir, workspace.id, chatbot.id);
      res.json({ chatbot: updated });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Recent visitor conversations with their messages (owner only).
  router.get('/chatbots/:id/conversations', async (req, res) => {
    try {
      const { chatbot } = await findChatbot(req.user, req.params.id);
      if (!chatbot) return res.status(404).json({ error: 'Chatbot not found' });
      const all = await listConversations(dataDir, { chatbotId: chatbot.id });
      const recent = (all || [])
        .sort((a, b) => Number(b.last_activity || b.started_at || 0) - Number(a.last_activity || a.started_at || 0))
        .slice(0, 30);
      const conversations = [];
      for (const c of recent) {
        const msgs = await listMessages(dataDir, c.id);
        conversations.push({
          id: c.id,
          startedAt: Number(c.started_at) || null,
          lastActivity: Number(c.last_activity) || null,
          messages: msgs.slice(-40).map((m) => ({ role: m.role, content: m.content, at: Number(m.created_at) || null })),
        });
      }
      res.json({ conversations, total: (all || []).length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Owner's preview: same answer engine as the public widget, works in draft too.
  // History comes from the request (nothing is stored for previews).
  router.post('/chatbots/:id/test', async (req, res) => {
    try {
      const { chatbot } = await findChatbot(req.user, req.params.id);
      if (!chatbot) return res.status(404).json({ error: 'Chatbot not found' });
      const message = String((req.body && req.body.message) || '').trim();
      if (!message) return res.status(400).json({ error: 'Message required' });
      const result = await answerVisitor({ dataDir, chatbot, message: message.slice(0, 1000), history: (req.body && req.body.history) || [], llm });
      res.json({
        response: result.answer,
        sourceDetails: result.sources.map((s) => ({ url: s.url, title: s.title })),
        grounded: result.grounded,
        confidence: result.confidence,
        retrieval: result.retrieval,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/chatbots/:id/approve', async (req, res) => {
    try {
      const workspaces = await listWorkspaces(dataDir, { creatorId: req.user.id });
      let found = null;
      for (const w of workspaces) {
        const chatbot = await getChatbot(dataDir, w.id, req.params.id);
        if (chatbot) {
          found = { workspace: w, chatbot };
          break;
        }
      }
      if (!found) return res.status(404).json({ error: 'Chatbot not found' });

      const result = await approveChatbot(dataDir, found.workspace.id, req.params.id, req.user.id, req.user.role);
      if (result.error) return res.status(403).json({ error: result.error });
      res.json({ chatbot: result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/chatbots/:id/publish', async (req, res) => {
    try {
      const workspaces = await listWorkspaces(dataDir, { creatorId: req.user.id });
      let found = null;
      for (const w of workspaces) {
        const chatbot = await getChatbot(dataDir, w.id, req.params.id);
        if (chatbot) {
          found = { workspace: w, chatbot };
          break;
        }
      }
      if (!found) return res.status(404).json({ error: 'Chatbot not found' });

      const result = await publishChatbot(dataDir, found.workspace.id, req.params.id, req.user.id);
      if (result.error) return res.status(400).json({ error: result.error });
      res.json({ chatbot: result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/chatbots/:id/leads', async (req, res) => {
    try {
      const { workspace, chatbot } = await findChatbot(req.user, req.params.id);
      if (!chatbot) {
        return res.status(404).json({ error: 'Chatbot not found' });
      }

      const leads = await listLeads(dataDir, chatbot.id);
      res.json({ leads });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Helper to find chatbot across user's workspaces
  async function findChatbot(user, chatbotId) {
    if (!user) return { chatbot: null };
    const workspaces = await listWorkspaces(dataDir, { creatorId: user.id });
    for (const w of workspaces) {
      const chatbot = await getChatbot(dataDir, w.id, chatbotId);
      if (chatbot) return { workspace: w, chatbot };
    }
    return { chatbot: null };
  }

  return router;
}

module.exports = { createCustomerExecutiveRouter };