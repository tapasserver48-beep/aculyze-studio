/**
 * /api/automations — "when X → AI employee does Y" rules (Phase 04.2).
 *
 *   GET    /                  my automations (managers/admins: everyone's), with runs today
 *   POST   /                  create  { name, trigger, employeeId, instruction, maxRunsPerDay }
 *   PATCH  /:id               edit / pause / resume (owner or admin; managers may pause any)
 *   DELETE /:id               owner or admin
 *   POST   /:id/test          fire once now with sample details
 *   GET    /:id/history       recent firings
 *   GET    /options           AI employees + chatbots for the form
 */

const express = require('express');
const { requireUser } = require('../auth/authorize');
const store = require('./store');
const service = require('./service');
const authStore = require('../auth/store');
const { listEmployees } = require('../employees/store');

const MANAGER_ROLES = ['founder', 'admin', 'manager'];
const ADMIN_ROLES = ['founder', 'admin'];

function createAutomationsRouter({ dataDir }) {
  const router = express.Router();
  router.use(requireUser);

  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
    if (!err.status) console.warn(`[automations] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'Something went wrong.' });
  });
  const http = (status, message) => Object.assign(new Error(message), { status });
  const isManager = (u) => MANAGER_ROLES.includes(u.role);
  const isAdmin = (u) => ADMIN_ROLES.includes(u.role);

  function found(req) {
    const a = store.get(dataDir, req.params.id);
    if (!a) throw http(404, 'Automation not found');
    if (a.ownerId !== req.user.id && !isManager(req.user)) throw http(404, 'Automation not found');
    return a;
  }
  const canEdit = (a, u) => a.ownerId === u.id || isAdmin(u);
  function checkTrigger(user, trigger) {
    if (trigger && store.MANAGER_ONLY_TRIGGERS.includes(trigger.type) && !isManager(user)) {
      throw http(403, 'Only managers and admins can automate on website leads or overdue tasks.');
    }
  }

  async function view(a, users, today) {
    const owner = users.get(a.ownerId);
    return {
      ...a,
      ownerName: owner ? owner.name || owner.email : 'Former user',
      summary: service.triggerSummary(a.trigger),
      runsToday: store.listHistory(dataDir, { automationId: a.id, since: today, limit: 1000 }).filter((h) => h.status === 'started').length,
      lastHistory: store.listHistory(dataDir, { automationId: a.id, limit: 1 })[0] || null,
    };
  }

  router.get('/options', wrap(async (req, res) => {
    const employees = (await listEmployees(dataDir)).filter((e) => e.employee_type === 'ai' && e.status === 'active')
      .map((e) => ({ id: e.id, name: e.name, code: e.employee_code, capabilities: e.capabilities || [] }));
    let chatbots = [];
    if (isManager(req.user)) {
      try {
        const { listWorkspaces } = require('../customerExecutive/store');
        const { listChatbots } = require('../customerExecutive/chatbots');
        const workspaces = await listWorkspaces(dataDir, {});
        for (const w of workspaces) {
          const bots = await listChatbots(dataDir, w.id).catch(() => []);
          for (const b of bots) chatbots.push({ id: b.id, name: b.name || b.id, workspace: w.name || w.id });
        }
      } catch { chatbots = []; }
    }
    res.json({ employees, chatbots, canUseManagerTriggers: isManager(req.user) });
  }));

  router.get('/', wrap(async (req, res) => {
    const users = new Map(((await authStore.listUsers(dataDir)) || []).map((u) => [u.id, u]));
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const all = store.list(dataDir).filter((a) => a.ownerId === req.user.id || isManager(req.user));
    const items = [];
    for (const a of all) items.push(await view(a, users, today.getTime()));
    res.json({ automations: items.sort((x, y) => y.created_at - x.created_at) });
  }));

  router.post('/', wrap(async (req, res) => {
    checkTrigger(req.user, req.body && req.body.trigger);
    const a = store.create(dataDir, req.body || {}, req.user.id);
    res.status(201).json({ automation: a });
  }));

  router.patch('/:id', wrap(async (req, res) => {
    const a = found(req);
    const body = req.body || {};
    const onlyToggle = Object.keys(body).every((k) => k === 'active');
    if (!canEdit(a, req.user) && !(onlyToggle && isManager(req.user))) throw http(403, 'Only the owner or an admin can change this automation.');
    checkTrigger(req.user, body.trigger);
    res.json({ automation: store.update(dataDir, a.id, body) });
  }));

  router.delete('/:id', wrap(async (req, res) => {
    const a = found(req);
    if (!canEdit(a, req.user)) throw http(403, 'Only the owner or an admin can delete this automation.');
    store.remove(dataDir, a.id);
    res.json({ ok: true });
  }));

  router.post('/:id/test', wrap(async (req, res) => {
    const a = found(req);
    if (!canEdit(a, req.user)) throw http(403, 'Only the owner or an admin can test this automation.');
    const out = await service.testNow(dataDir, a);
    if (out.skipped) throw http(409, `Not run: ${out.skipped}.`);
    res.status(202).json(out);
  }));

  router.get('/:id/history', wrap(async (req, res) => {
    const a = found(req);
    res.json({ history: store.listHistory(dataDir, { automationId: a.id, limit: 30 }) });
  }));

  return router;
}

module.exports = { createAutomationsRouter };
