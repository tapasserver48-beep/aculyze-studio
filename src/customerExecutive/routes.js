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

function createCustomerExecutiveRouter({ dataDir }) {
  const router = express.Router();

  // Ensure database schema on mount
  ensureSchema();

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

  // ---- Chatbot Management Endpoints ----
  const {
    createChatbot, getChatbot, listChatbots, updateChatbot, deleteChatbot,
    approveChatbot, publishChatbot, unpublishChatbot
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

      const updated = await updateChatbot(dataDir, found.workspace.id, req.params.id, req.body);
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

  // ---- Public Visitor Endpoints (no auth required) ----
  // Mount at /public/:publishKey

  router.get('/public/:publishKey', async (req, res) => {
    try {
      const chatbot = await getChatbotByPublishKey(dataDir, req.params.publishKey);
      if (!chatbot) return res.status(404).json({ error: 'Chatbot not found or not published' });

      // Update visitor count
      const publishKey = chatbot.publish_key;
      await updateChatbot(dataDir, chatbot.workspace_id, chatbot.id, {
        visitor_count: (chatbot.visitor_count || 0) + 1
      }).catch(() => {});

      // Return only public data
      res.json({
        chatbot: {
          id: chatbot.id,
          name: chatbot.name,
          description: chatbot.description,
          instructions: chatbot.instructions,
          knowledge_ids: chatbot.knowledge_ids
        }
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/public/:publishKey/converse', async (req, res) => {
    try {
      const chatbot = await getChatbotByPublishKey(dataDir, req.params.publishKey);
      if (!chatbot) return res.status(404).json({ error: 'Chatbot not found or not published' });

      const { message, history } = req.body;
      if (!message) return res.status(400).json({ error: 'Message required' });

      // Update last_used_at
      await updateChatbot(dataDir, chatbot.workspace_id, chatbot.id, {
        last_used_at: Date.now()
      }).catch(() => {});

      // Get chatbot response from knowledge
      const workspaceId = chatbot.workspace_id;
      let answer = "I don't have information to answer that question.";
      let sources = [];

      if (chatbot.instructions) {
        // Process the question through the knowledge
        const knowledge = await searchKnowledge(dataDir, workspaceId, message);
        if (knowledge.length > 0) {
          answer = knowledge.map(k => k.content_content).join(' ');
          sources = knowledge.slice(0, 3).map(k => k.source_url);
        }
      }

      res.json({
        response: answer,
        sources,
        conversationId: `conv-${crypto.randomUUID().substring(0, 8)}`
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/public/:publishKey/leads', async (req, res) => {
    try {
      const chatbot = await getChatbotByPublishKey(dataDir, req.params.publishKey);
      if (!chatbot) return res.status(404).json({ error: 'Chatbot not found or not published' });

      const { email, name, phone, company, consent, consentText } = req.body;

      // Hash consent text for verification
      const consentTextHash = consent && consentText
        ? crypto.createHash('sha256').update(consentText).digest('hex')
        : null;

      const lead = await createLead(dataDir, {
        chatbotId: chatbot.id,
        email,
        name,
        phone,
        company,
        conversation: [],
        consent: consent === true,
        consentTextHash,
        sourceUrl: req.protocol + '://' + req.get('host') + req.originalUrl,
        userAgent: req.get('User-Agent'),
        ipAddress: req.ip || req.socket.remoteAddress
      });

      if (lead.error) {
        return res.status(400).json({ error: lead.error });
      }

      res.status(201).json({ lead: { id: lead.id, consent: lead.consent } });
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