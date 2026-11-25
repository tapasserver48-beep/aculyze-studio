/**
 * Inbox chat with AI employees (Phase 04.1b) — "chat first, task on request".
 *
 * When a person messages an AI employee in the Inbox, the employee replies
 * conversationally in the same thread. Chat replies use NO tools: they never
 * read apps or take actions. Real work happens only when the person turns a
 * message into a task ("Make this a task"), which runs through the normal
 * agent runtime with its permission and approval rules.
 */

const { createRouterFromEnv } = require('../services/ai/router');
const { findById } = require('../employees/store');
const { sendMessage, listMessages } = require('../inbox/store');

const HISTORY = 12;          // recent messages given to the model
const REPLY_MAX_TOKENS = 700;
const inFlight = new Set();  // one reply at a time per thread

const CHAT_RULES = `
You are chatting with a colleague in the company Inbox.
- Be brief, warm and practical. Plain text or light markdown, at most a few short paragraphs.
- In this chat you cannot open apps, read email, or take actions. Never pretend you did, and never invent data.
- If the person wants real work done (read or send email, check the calendar, pull sales or leads, prepare a report), say you can do it as a task and tell them to click "Make this a task" under their message. You may suggest a clearer one-line task wording.
- Answer general questions, help them plan or phrase a request, and explain what you can do.`;

function personaOf(employee) {
  const own = String((employee && employee.system_instructions) || '').trim();
  return own || `You are ${employee.name}, an AI employee of Aculyze Studio.`;
}

/**
 * Generate and post the AI employee's reply to the latest message in the
 * thread between `userId` (account id) and `employeeId`. Never throws.
 */
async function replyInThread(dataDir, { employeeId, userId, provider = null }) {
  const key = `${employeeId}:${userId}`;
  if (inFlight.has(key)) return null;
  inFlight.add(key);
  try {
    const employee = await findById(dataDir, employeeId);
    if (!employee || employee.status !== 'active' || employee.employee_type !== 'ai') return null;

    const me = `usr-${userId}`;
    const { messages } = await listMessages(dataDir, me, employeeId, 0);
    const recent = (messages || []).filter((m) => !m.deleted && m.body).slice(-HISTORY);
    if (!recent.length || recent[recent.length - 1].from !== me) return null; // nothing new from the person

    const latest = String(recent[recent.length - 1].body || '');
    const memory = require('../memory/store').contextFor(dataDir, userId, latest);
    const chat = [
      { role: 'system', content: `${personaOf(employee)}\n${CHAT_RULES}` },
      ...(memory ? [{ role: 'system', content: memory }] : []),
      ...recent.map((m) => ({ role: m.from === me ? 'user' : 'assistant', content: String(m.body).slice(0, 2000) })),
    ];

    const llm = provider || createRouterFromEnv(process.env).active;
    // Learn lasting facts from what the person wrote (in the background, never blocks the reply).
    require('../memory/learn').learnFromExchange({ dataDir, userId, userText: latest, llm, source: 'inbox', employeeId: employee.id }).catch(() => {});
    let text = '';
    try {
      const res = await llm.sendMessage({ messages: chat, temperature: 0.4, max_tokens: REPLY_MAX_TOKENS, thinking: false, timeoutMs: 45000 });
      text = String((res && res.content) || '').trim();
    } catch (err) {
      console.warn(`[inbox-ai] reply failed: ${err.message}`);
      text = "Sorry, I couldn't think of a reply just now (the AI model didn't answer). Try again in a moment. If you want work done, click \"Make this a task\" under your message.";
    }
    if (!text) return null;

    return await sendMessage(dataDir, {
      from: employee.id,
      fromName: employee.name,
      to: me,
      toName: '',
      peerRole: employee.designation || 'AI Employee',
      body: text.slice(0, 3800),
      generated: true,
    });
  } catch (err) {
    console.warn(`[inbox-ai] ${err.message}`);
    return null;
  } finally {
    inFlight.delete(key);
  }
}

/** Post a short message from the AI employee into the person's thread. */
async function postFromEmployee(dataDir, employee, userId, body) {
  try {
    return await sendMessage(dataDir, {
      from: employee.id,
      fromName: employee.name,
      to: `usr-${userId}`,
      toName: '',
      peerRole: employee.designation || 'AI Employee',
      body: String(body).slice(0, 3800),
      generated: true,
    });
  } catch (err) {
    console.warn(`[inbox-ai] post failed: ${err.message}`);
    return null;
  }
}

module.exports = { replyInThread, postFromEmployee };
