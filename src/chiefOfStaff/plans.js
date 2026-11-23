/**
 * Delegation plan store — Phase 03.3.
 *
 * A plan is NOT a task. It is the Chief of Staff's draft decomposition of an
 * objective plus its approval state. Actual tasks are only ever created by the
 * Central Task Engine, and only after a human approves the plan (brief §6).
 *
 * Storage: <dataDir>/delegation/plans.json. This file never holds task records,
 * so it cannot become a duplicate task system (brief §5).
 *
 * Lifecycle: draft → approved → executing → completed
 *                     ↘ rejected
 */

const fs = require('fs');
const path = require('path');

const PLAN_STATUSES = ['draft', 'approved', 'rejected', 'executing', 'completed'];

function plansFile(dataDir) {
  return path.join(dataDir, 'delegation', 'plans.json');
}

// Files locally, Postgres (app_documents) when DATABASE_URL is set.
const docstore = require('../db/docstore');

function readPlans(dataDir) {
  const doc = docstore.readJson(dataDir, plansFile(dataDir), { plans: [] });
  return { plans: Array.isArray(doc.plans) ? doc.plans : [] };
}

function writePlans(dataDir, doc) {
  docstore.writeJson(dataDir, plansFile(dataDir), doc);
}

function generatePlanId() {
  return `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function savePlan(dataDir, plan) {
  const doc = readPlans(dataDir);
  const idx = doc.plans.findIndex(p => p.id === plan.id);
  plan.updated_at = Date.now();
  if (idx === -1) doc.plans.unshift(plan);
  else doc.plans[idx] = plan;
  writePlans(dataDir, doc);
  return plan;
}

async function getPlan(dataDir, id) {
  if (!id) return null;
  return readPlans(dataDir).plans.find(p => p.id === id) || null;
}

/** Newest first. `limit` keeps the payload bounded for the UI list. */
async function listPlans(dataDir, { limit = 50, status = null } = {}) {
  let plans = readPlans(dataDir).plans;
  if (status) plans = plans.filter(p => p.status === status);
  return plans.slice(0, limit);
}

/**
 * Duplicate-objective guard (brief §5 "prevent duplicate task creation").
 * Two open plans for the same objective would fork the same work.
 */
async function findOpenPlanForObjective(dataDir, objectiveTitle) {
  const title = String(objectiveTitle || '').trim().toLowerCase();
  if (!title) return null;
  return readPlans(dataDir).plans.find(
    p => p.status !== 'rejected' && p.status !== 'completed'
      && String(p.objective?.title || '').trim().toLowerCase() === title
  ) || null;
}

module.exports = {
  PLAN_STATUSES,
  generatePlanId,
  savePlan,
  getPlan,
  listPlans,
  findOpenPlanForObjective,
};
