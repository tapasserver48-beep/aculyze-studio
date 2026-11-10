/**
 * mailDraft — LLM-assisted extraction of {to, subject, body} for write intents.
 *
 * The regex planner (router.mailArgs) only handles explicit phrasing
 * ("subject: …", quoted bodies). A natural request like
 *   "email priya thanking her for yesterday's demo and attach the pricing"
 * falls back to stuffing the WHOLE message into the body.
 *
 * This module asks the active AI brain (NVIDIA primary / LM Studio fallback,
 * same router as chat) to extract structured fields as JSON. Rules:
 *   • Always returns valid args — on ANY failure it returns the regex args
 *     unchanged (never blocks sending).
 *   • Short timeout — drafting must not stall the chat.
 *   • The result is only ever shown in the confirm modal; the user still
 *     approves (§12) and can edit before sending.
 */
const { createRouterFromEnv } = require('../services/ai/router');

let _provider = null;
function provider() {
  if (!_provider) _provider = createRouterFromEnv(process.env).active;
  return _provider;
}

const SYSTEM = `You extract email fields from a user's request. Reply with ONLY a JSON object, no prose, no markdown fences:
{"to":"recipient@example.com","subject":"max 100 chars","body":"the email text, nicely written, 2-8 sentences"}
Rules:
- "to": use the email address found in the request; if none, use "".
- "subject": short, specific, no "Re:".
- "body": write a complete, natural email that covers everything the user asked to convey. Never include the recipient address or the word "subject" in the body. If the request contains an explicit message/quote, keep its intent.
- If the request is not an email at all, return {"to":"","subject":"","body":""}.`;

function parseJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  // strip ```json fences and leading prose
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const j = JSON.parse(s.slice(start, end + 1));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} message  raw user request
 * @param {object} fallbackArgs  regex-extracted args (router.mailArgs)
 * @returns {Promise<{to:string,subject:string,body:string}>}
 */
async function draftMail(message, fallbackArgs = {}, { timeoutMs = 8000 } = {}) {
  const fallback = {
    to: String(fallbackArgs.to || ''),
    subject: String(fallbackArgs.subject || 'Message from Zara'),
    body: String(fallbackArgs.body || ''),
  };
  try {
    const call = provider().sendMessage({
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: String(message || '').slice(0, 2000) },
      ],
      temperature: 0.2,
      max_tokens: 700,
    });
    const res = await Promise.race([
      call,
      new Promise((_, rej) => setTimeout(() => rej(new Error('draft timeout')), timeoutMs)),
    ]);
    const j = parseJson(res && res.content);
    if (!j) {
      console.warn('[mailDraft] Model returned unparseable JSON; using regex args.', JSON.stringify(String(res && res.content || '').slice(0, 200)));
      return fallback;
    }
    const to = typeof j.to === 'string' && j.to.trim() ? j.to.trim() : fallback.to;
    const subject = typeof j.subject === 'string' && j.subject.trim() ? j.subject.trim().slice(0, 120) : fallback.subject;
    const body = typeof j.body === 'string' && j.body.trim() ? j.body.trim().slice(0, 4000) : fallback.body;
    if (!to && !body) return fallback;
    return { to, subject, body, drafted: true };
  } catch (err) {
    console.warn('[mailDraft] LLM draft failed, using regex args:', err && err.message);
    return fallback; // never block the send on drafting
  }
}

module.exports = { draftMail };
