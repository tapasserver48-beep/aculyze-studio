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
  router.get('/workspaces/:id/knowledge', async (req, res) => {
    try {
      const workspace = await getWorkspace(dataDir, req.params.id);
      if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

      if (!canAccessWorkspace(req.user.role, req.user.id, workspace.creator_id)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Return knowledge from completed crawl jobs for this workspace
      // (Implementation will be in knowledge.js)
      res.json({ knowledge: [], message: 'Knowledge retrieval endpoint' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createCustomerExecutiveRouter };