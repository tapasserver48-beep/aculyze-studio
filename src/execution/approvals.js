/**
 * Approval requests for AI employee write actions (Phase 04.1).
 *
 * When an agent wants to send/create something, the run pauses and its full
 * state (conversation + pending tool call) is saved here so it can resume
 * after the initiating human approves or rejects.
 *
 * Storage: data/agent-approvals.json (JSON only for now; Postgres is a
 * follow-up — see docs/phase-04.1-agent-runtime.md).
 */

const crypto = require('crypto');
const path = require('path');
const docstore = require('../db/docstore');


const STATUS = { PENDING: 'pending', APPROVED: 'approved', REJECTED: 'rejected', FAILED: 'failed' };

const fileOf = (dataDir) => path.join(dataDir, 'agent-approvals.json');

function readAll(dataDir) {
  const doc = docstore.readJson(dataDir, fileOf(dataDir), { items: [] });
  return Array.isArray(doc.items) ? doc.items : [];
}

function writeAll(dataDir, items) {
  docstore.writeJson(dataDir, fileOf(dataDir), { items });
}

function createApproval(dataDir, { taskId, employeeId, initiatingUserId, executionId, tool, args, toolCallId, confirm, state }) {
  const items = readAll(dataDir);
  const approval = {
    id: 'appr-' + crypto.randomUUID().substring(0, 12),
    status: STATUS.PENDING,
    taskId,
    employeeId,
    initiatingUserId,
    executionId,
    tool,
    args: args || {},
    toolCallId: toolCallId || null,
    confirm: confirm || null, // preview from IntegrationManager.buildConfirmation
    state: state || null,     // { messages, steps, round } to resume the run
    created_at: Date.now(),
    decided_at: null,
    decided_by: null,
    reason: null,
  };
  items.push(approval);
  writeAll(dataDir, items);
  return approval;
}

function getApproval(dataDir, id) {
  return readAll(dataDir).find((a) => a.id === id) || null;
}

function listApprovals(dataDir, { userId, taskId, status } = {}) {
  return readAll(dataDir)
    .filter((a) => (!userId || a.initiatingUserId === userId)
      && (!taskId || a.taskId === taskId)
      && (!status || a.status === status))
    .sort((a, b) => b.created_at - a.created_at);
}

/**
 * Move a PENDING approval to a decided status. Returns the updated record,
 * or null if it was not pending (already decided → no double execution).
 */
function decideApproval(dataDir, id, { status, userId, reason = null }) {
  const items = readAll(dataDir);
  const idx = items.findIndex((a) => a.id === id);
  if (idx === -1 || items[idx].status !== STATUS.PENDING) return null;
  items[idx] = { ...items[idx], status, decided_at: Date.now(), decided_by: userId, reason };
  writeAll(dataDir, items);
  return items[idx];
}

/** Drop the saved conversation once the run has resumed (keeps the file small). */
function clearState(dataDir, id, patch = {}) {
  const items = readAll(dataDir);
  const idx = items.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  items[idx] = { ...items[idx], ...patch, state: null };
  writeAll(dataDir, items);
  return items[idx];
}

/** Public view — never ship the saved conversation to the browser. */
function publicView(a) {
  if (!a) return null;
  const { state, ...rest } = a;
  return rest;
}

module.exports = { STATUS, createApproval, getApproval, listApprovals, decideApproval, clearState, publicView };
