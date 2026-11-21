/**
 * /api/chief — Chief of Staff planning and delegation (Phase 03.3).
 *
 * POST   /api/chief/plans            Draft a plan from an objective (no tasks created)
 * GET    /api/chief/plans            List plans visible to this user
 * GET    /api/chief/plans/:id        Monitor one plan (progress, blockers, overdue)
 * POST   /api/chief/plans/:id/approve  Approve → creates tasks via Central Task Engine
 * POST   /api/chief/plans/:id/reject   Reject the draft
 * GET    /api/chief/plans/:id/report Consolidated result for the initiating user
 * GET    /api/chief/staff            Staff monitor: workload, health, tasks needing attention
 * POST   /api/chief/staff/followups  Apply chosen follow-ups (nudge / reassign)
 *
 * Every route requires a signed-in human session. Identity and authority are
 * resolved from the session server-side; nothing about an AI identity is read
 * from request headers (Phase 03.2B).
 */

const express = require('express');
const { requireUser } = require('../auth/authorize');
const {
  draftPlan,
  approvePlan,
  rejectPlan,
  getPlanStatus,
  buildReport,
  getPlans,
  getPlan,
  DELEGATION_ROLES,
} = require('./index');
const { getStaffOverview, applyFollowups } = require('./monitor');

function sendError(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error('[ChiefOfStaff]', err);
  res.status(status).json({
    error: err.message || 'Request failed',
    code: err.code || undefined,
    planId: err.planId || undefined,
  });
}

/**
 * Who may read a plan. Every delegation role can approve, so every delegation
 * role must be able to see what it is being asked to approve — an approver who
 * cannot open the plan cannot do their job. Employees hold no delegation role
 * and cannot initiate one either, so they see no plans.
 */
async function canViewPlan(dataDir, plan, user) {
  if (!plan) return false;
  if (plan.created_by === user.id) return true;
  return DELEGATION_ROLES.includes(user.role || 'employee');
}

function createChiefOfStaffRouter({ dataDir }) {
  const router = express.Router();

  router.use(requireUser);

  // ---- Draft -------------------------------------------------------
  router.post('/plans', async (req, res) => {
    try {
      const { objective, description, constraints, deadline, priority, stakeholders } = req.body || {};
      const result = await draftPlan({
        dataDir,
        userId: req.user.id,
        input: {
          title: typeof objective === 'string' ? objective : objective?.title,
          description: typeof description === 'string' ? description : objective?.description,
          constraints,
          stakeholders,
          deadline,
          priority,
        },
      });

      if (result.status === 'needs_clarification') {
        // Ask rather than guess (brief §3 step 3). Nothing was persisted, so
        // a retry with more detail starts clean — no duplicate plans.
        return res.status(200).json({
          status: 'needs_clarification',
          reason: result.reason,
          missing: result.missing,
          summary: result.summary,
          successCriteria: result.successCriteria,
          provider: result.provider,
          model: result.model,
          latencyMs: result.latencyMs,
        });
      }

      res.status(201).json({
        status: 'draft',
        planId: result.plan.id,
        plan: await getPlanStatus({ dataDir, planId: result.plan.id }),
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  // ---- List --------------------------------------------------------
  router.get('/plans', async (req, res) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : null;
      const all = await getPlans(dataDir, { status, limit: 50 });
      const visible = [];
      for (const p of all) {
        if (await canViewPlan(dataDir, p, req.user)) {
          visible.push({
            planId: p.id,
            status: p.status,
            objective: p.objective?.title,
            created_by: p.created_by,
            created_at: p.created_at,
            subtasks: p.subtasks?.length || 0,
          });
        }
      }
      res.json({ plans: visible });
    } catch (err) {
      sendError(res, err);
    }
  });

  // ---- Monitor -----------------------------------------------------
  router.get('/plans/:id', async (req, res) => {
    try {
      const plan = await getPlan(dataDir, req.params.id);
      if (!plan) return res.status(404).json({ error: 'Plan not found' });
      if (!(await canViewPlan(dataDir, plan, req.user))) {
        return res.status(403).json({ error: 'You do not have access to this plan' });
      }
      res.json(await getPlanStatus({ dataDir, planId: plan.id }));
    } catch (err) {
      sendError(res, err);
    }
  });

  // ---- Approve (creates tasks) -------------------------------------
  router.post('/plans/:id/approve', async (req, res) => {
    try {
      const { plan, created } = await approvePlan({
        dataDir,
        planId: req.params.id,
        approverId: req.user.id,
      });
      res.json({
        status: plan.status,
        planId: plan.id,
        created,
        plan: await getPlanStatus({ dataDir, planId: plan.id }),
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  // ---- Reject ------------------------------------------------------
  router.post('/plans/:id/reject', async (req, res) => {
    try {
      const { plan } = await rejectPlan({
        dataDir,
        planId: req.params.id,
        approverId: req.user.id,
        reason: req.body?.reason,
      });
      res.json({ status: plan.status, planId: plan.id });
    } catch (err) {
      sendError(res, err);
    }
  });

  // ---- Consolidated report -----------------------------------------
  router.get('/plans/:id/report', async (req, res) => {
    try {
      const plan = await getPlan(dataDir, req.params.id);
      if (!plan) return res.status(404).json({ error: 'Plan not found' });
      if (!(await canViewPlan(dataDir, plan, req.user))) {
        return res.status(403).json({ error: 'You do not have access to this plan' });
      }
      res.json(await buildReport({ dataDir, planId: plan.id }));
    } catch (err) {
      sendError(res, err);
    }
  });

  // ---- Staff monitoring --------------------------------------------
  // Workload and health for every employee in the viewer's authority, plus
  // the tasks that need a follow-up. Delegation roles only.
  router.get('/staff', async (req, res) => {
    try {
      res.json(await getStaffOverview({ dataDir, userId: req.user.id }));
    } catch (err) {
      sendError(res, err);
    }
  });

  // Apply follow-ups the human selected (nudge or reassign). Nothing is
  // applied automatically; every action is re-validated server-side.
  router.post('/staff/followups', async (req, res) => {
    try {
      res.json(await applyFollowups({ dataDir, userId: req.user.id, actions: req.body?.actions }));
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}

module.exports = { createChiefOfStaffRouter };
