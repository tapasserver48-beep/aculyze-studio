/**
 * Tier 2 — LLM tool-calling agent (Phase B).
 *
 * Two-tier architecture:
 *   Tier 1 (integrations/router.js): deterministic regex gate — high-confidence
 *          hits run directly, no model cost. Tried FIRST by manager.resolve().
 *   Tier 2 (this module): the brain picks tools itself via native
 *          function-calling — for natural/ambiguous phrasing Tier 1 misses
 *          ("any news from the client thread?", "who's handling Orbinox?").
 *
 * Contract (mirrors resolve()):
 *   run() → { steps, context, sources, confirm?, notice? }
 *
 * Safety invariants (§9–§12):
 *   • ONLY whitelisted tools from tools.js are exposed (schemas filtered by
 *     connection + permissions; runTool re-checks both before executing).
 *   • WRITE tools are NEVER executed here — the first write tool call stops
 *     the loop and returns manager.buildConfirmation() → user must approve.
 *   • Bounded: MAX_STEPS tool rounds, TOOL_RESULT_CAP chars per result,
 *     overall wall-clock budget.
 *   • Any failure degrades to "no app context" — chat still answers.
 */
const { buildToolSchemas, NAME_TO_ID } = require('./schemas');
const { getTool } = require('../integrations/tools');
const { getApp } = require('../integrations/catalog');
const { buildAppsContext } = require('../integrations/manager');

const MAX_STEPS = 4;            // tool-calling rounds per user message
const TOOL_RESULT_CAP = 6000;   // chars of each tool result fed back to the model
const STEP_BUDGET_MS = 45000;   // wall-clock for the whole loop

const SYSTEM = `You are Zara's tool agent inside Aculyze Studio. You fetch REAL data from the user's connected apps by calling tools, then hand the raw findings back to the main assistant — you do NOT write the final answer yourself.

Rules:
- Only call tools that exist in the provided list. Never invent tools.
- Prefer one focused query; chain tools when needed (e.g. search → open message).
- If a tool returns an error or empty results, adjust once (different query) or stop.
- When you have enough data (or need none), stop calling tools.
- You may call several independent tools in a single round.
- WRITE tools (send/create/update) will be shown to the user for confirmation — call them when the user asked for that action; never call them for exploration.
- If the request needs no tools at all, reply with no tool calls and a one-line note like NO_TOOLS.`;

/** Serialize one tool result for the model (capped). */
function toolResultPayload(res) {
  const out = {
    count: typeof res.count === 'number' ? res.count : undefined,
    summary: res.summary || undefined,
    text: res.text ? String(res.text).slice(0, TOOL_RESULT_CAP) : undefined,
    items: Array.isArray(res.items) ? res.items.slice(0, 5) : undefined,
    error: res.error || undefined,
  };
  if (res.pagination) out.pagination = res.pagination;
  try {
    return JSON.stringify(out).slice(0, TOOL_RESULT_CAP + 500);
  } catch {
    return '{"error":"unserializable tool result"}';
  }
}

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

/**
 * Run the Tier 2 loop for one user message.
 *
 * @param {object} o
 * @param {object} o.provider   AI provider (hybrid router) with sendMessage({messages, tools})
 * @param {object} o.manager    IntegrationManager (listApps, runTool, buildConfirmation)
 * @param {string} o.uid        user id
 * @param {string} o.message    user message
 * @param {Array}  o.history    prior conversation messages (role/content), oldest first
 * @returns {Promise<{steps, context, sources, confirm?, notice?, used: boolean}>}
 */
async function run({ provider, manager, uid, message, history = [] }) {
  const failed = (why) => {
    console.warn(`[agent:tier2] ${why}`);
    return { steps: [], context: null, sources: [], used: false };
  };
  if (!provider || typeof provider.sendMessage !== 'function') return failed('no provider');
  if (!uid || !String(message || '').trim()) return failed('no uid/message');

  const views = manager.listApps(uid);
  const tools = buildToolSchemas(views);
  if (!tools.length) return failed('no connected tools');

  const messages = [
    { role: 'system', content: SYSTEM },
    ...(history || []).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
      .slice(-6)
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) })),
    { role: 'user', content: String(message).slice(0, 4000) },
  ];

  const steps = [];
  const sections = [];
  const sources = [];
  const done = new Map(); // toolId → last result (for `after` chaining)
  const deadline = Date.now() + STEP_BUDGET_MS;

  for (let round = 0; round < MAX_STEPS; round++) {
    if (Date.now() > deadline) break;

    let res;
    try {
      res = await provider.sendMessage({
        messages,
        tools,
        temperature: 0.1,
        max_tokens: 1400,
        timeoutMs: Math.min(20000, deadline - Date.now()),
      });
    } catch (err) {
      return failed(`model call failed: ${err.message}`);
    }

    const toolCalls = Array.isArray(res.toolCalls) ? res.toolCalls : [];
    if (!toolCalls.length) {
      // Model decided: no more tools. Context only matters if we fetched some.
      break;
    }

    // Record the assistant turn (must include tool_calls for the protocol).
    messages.push({
      role: 'assistant',
      content: res.content || null,
      tool_calls: toolCalls,
    });

    let stopForWrite = null;

    for (const call of toolCalls) {
      const schemaName = call?.function?.name || '';
      const toolId = NAME_TO_ID.get(schemaName);
      const def = toolId ? getTool(toolId) : null;

      if (!def) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id || 'unknown',
          content: JSON.stringify({ error: `Unknown tool "${schemaName}".` }),
        });
        continue;
      }
      const appDef = getApp(def.app);
      const args = parseArgs(call?.function?.arguments);

      // ---- §12: writes NEVER execute here → confirmation request ----
      if (def.kind === 'write') {
        stopForWrite = { tool: toolId, args };
        break;
      }

      // ---- reads: execute through runTool (permission-gated, keyless) ----
      try {
        const result = await manager.runTool(uid, toolId, args);
        done.set(toolId, result);
        const count = typeof result.count === 'number' ? result.count : 0;
        steps.push({
          id: `${def.app}:${toolId}`,
          text: `${appDef.icon} ${appDef.name} — ${count ? `✓ Found ${count} ${def.done}` : `✓ ${def.progress ? def.progress.replace(/…$/, '') : 'Checked'} (${def.done})`}`,
          ok: true,
        });
        if (result.text && String(result.text).trim()) {
          sections.push(`## ${appDef.name}\n${String(result.text).slice(0, 6000)}`);
        }
        if (Array.isArray(result.items) && result.items.length) {
          sources.push({
            app: appDef.name, icon: appDef.icon, count: count || result.items.length,
            unit: def.unit, items: result.items.slice(0, 5),
          });
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id || toolId,
          content: toolResultPayload(result),
        });
      } catch (err) {
        const friendly = String(err && err.message || 'tool failed').slice(0, 300);
        steps.push({ id: `${def.app}:${toolId}:err`, text: `${appDef.icon} ${appDef.name} — ${friendly}`, ok: false });
        messages.push({
          role: 'tool',
          tool_call_id: call.id || toolId,
          content: JSON.stringify({ error: friendly }),
        });
      }
    }

    // ---- a write was requested → build the confirmation and STOP ----
    if (stopForWrite) {
      const conf = await manager.buildConfirmation(uid, stopForWrite);
      if (conf.confirm) {
        return { confirm: conf.confirm, steps, context: null, sources: [], used: true };
      }
      // not connected / not authorized → surface as a notice, keep reads so far
      if (conf.notice) {
        return { notice: conf.notice, steps, context: null, sources: [], used: true };
      }
      // otherwise fall through with whatever reads we collected
      break;
    }
  }

  if (!sections.length) {
    return { steps, context: null, sources: [], used: steps.length > 0 };
  }

  // Same context builder Tier 1 uses — one format for both tiers.
  const context = buildAppsContext(sections, String(message || ''));

  const seen = new Set();
  const deduped = sources.filter((s) => {
    const k = `${s.app}:${s.unit}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { steps, context, sources: deduped, used: true };
}

module.exports = { run, MAX_STEPS };
