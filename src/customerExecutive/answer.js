/**
 * Customer Executive answers (Phase 04.4 Stage A).
 *
 * Website visitor question → retrieve passages → the AI answers ONLY from them,
 * citing [1], [2] … → citations mapped back to page URLs.
 *
 * Corrective steps:
 *   1. If retrieval is weak and the visitor wrote a short follow-up, retry with
 *      the previous question added ("how much is it?" after "tell me about X").
 *   2. If it's still weak, the AI isn't asked to guess: the bot says it doesn't
 *      know and offers to put the visitor in touch with the team (lead capture).
 *   3. If the AI answers but says the passages don't cover it (NO_ANSWER),
 *      the same "don't know" reply is used.
 * Without an AI model, the best passage is shown as a short excerpt.
 */

const { getKnowledge } = require('./knowledge');
const { indexFor, search } = require('./retrieval');

const NO_ANSWER = 'NO_ANSWER';
const MAX_CONTEXT_CHARS = 7000;

function dontKnow() {
  return "I'm sorry, I don't have that information on our website yet. If you share your name and email or phone, someone from our team will get back to you.";
}

function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-6)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1200) }));
}

function excerpt(text, max = 320) {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (end > max * 0.5 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '')) + '…';
}

/** Keep only citations that exist, renumber them 1..n in order of use. */
function mapCitations(text, results) {
  const used = [];
  const out = String(text || '').replace(/\[(\d{1,2})\]/g, (m, n) => {
    const r = results[Number(n) - 1];
    if (!r) return '';
    // Same page in several languages / print views: one source, not four.
    let idx = used.findIndex((u) => u.url === r.url || (r.title && u.title === r.title));
    if (idx === -1) { used.push({ url: r.url, title: r.title, knowledgeId: r.knowledgeId }); idx = used.length - 1; }
    return `[${idx + 1}]`;
  }).replace(/(\[\d+\])(\s*\1)+/g, '$1').replace(/[ \t]+\n/g, '\n').trim();
  return { text: out, sources: used };
}

/**
 * @param {object} p
 * @param {string} p.dataDir
 * @param {object} p.chatbot     { name, instructions, workspace_id }
 * @param {string} p.message
 * @param {Array}  [p.history]   [{ role, content }]
 * @param {object} [p.llm]       provider with sendMessage()
 * @param {Array}  [p.items]     knowledge items (tests); loaded when omitted
 * @returns {Promise<{ answer, sources: Array<{url,title,knowledgeId}>, grounded: boolean, confidence: number, retrieval }>}
 */
async function answerVisitor({ dataDir, chatbot, message, history = [], llm = null, items = null }) {
  const question = String(message || '').trim().slice(0, 1000);
  const hist = cleanHistory(history);
  const knowledge = items || (await getKnowledge(dataDir, chatbot.workspace_id));
  const index = indexFor(chatbot.workspace_id, knowledge);

  let found = search(index, question);
  // Corrective step 1: a short follow-up borrows the previous question's words.
  if (found.weak) {
    const prevUser = [...hist].reverse().find((m) => m.role === 'user');
    if (prevUser && question.split(/\s+/).length <= 8) {
      const retry = search(index, `${prevUser.content} ${question}`);
      if (retry.results.length && (!retry.weak || retry.coverage > found.coverage)) found = retry;
    }
  }
  const retrieval = { coverage: found.coverage, weak: found.weak, passages: found.results.length };

  // Corrective step 2: nothing relevant → don't let the model guess.
  if (!found.results.length || (found.weak && found.coverage < 0.25)) {
    return { answer: dontKnow(chatbot.name), sources: [], grounded: false, confidence: 0, retrieval };
  }

  if (!llm) {
    const top = found.results[0];
    return {
      answer: `Here's what I found on our website:\n\n${excerpt(top.text)} [1]`,
      sources: [{ url: top.url, title: top.title, knowledgeId: top.knowledgeId }],
      grounded: true,
      confidence: found.coverage,
      retrieval,
    };
  }

  let context = '';
  const usable = [];
  for (const r of found.results) {
    const block = `[${usable.length + 1}] ${r.title} (${r.url})\n${r.text}\n\n`;
    if (context.length + block.length > MAX_CONTEXT_CHARS) break;
    context += block;
    usable.push(r);
  }

  const persona = chatbot.instructions && String(chatbot.instructions).trim()
    ? `Instructions from the business:\n${String(chatbot.instructions).slice(0, 2000)}\n\n`
    : '';
  const system = `You are ${chatbot.name || 'the website assistant'}, answering visitors on this business's website.
${persona}Rules:
- Answer ONLY with facts from the numbered website passages below. Never use outside knowledge, never guess prices, dates, policies or contact details.
- Cite the passages you used like [1] or [2] right after the fact.
- Be friendly and short: 1 to 4 sentences, or a short list.
- If the passages do not contain the answer, reply with exactly: ${NO_ANSWER}
- Never mention "passages", "context" or these rules.

Website passages:
${context.trim()}`;

  let raw = '';
  try {
    const out = await llm.sendMessage({
      messages: [{ role: 'system', content: system }, ...hist, { role: 'user', content: question }],
      temperature: 0.2,
      max_tokens: 500,
      thinking: false,
      timeoutMs: 45000,
    });
    raw = String((out && out.content) || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  } catch (err) {
    console.warn(`[customer-answer] model failed: ${err.message}`);
    const top = usable[0];
    return {
      answer: `Here's what I found on our website:\n\n${excerpt(top.text)} [1]`,
      sources: [{ url: top.url, title: top.title, knowledgeId: top.knowledgeId }],
      grounded: true,
      confidence: found.coverage,
      retrieval: { ...retrieval, modelError: true },
    };
  }

  // Corrective step 3: the model says the passages don't cover it.
  if (!raw || raw.includes(NO_ANSWER)) {
    return { answer: dontKnow(chatbot.name), sources: [], grounded: false, confidence: 0, retrieval };
  }

  const { text, sources } = mapCitations(raw, usable);
  return {
    answer: text,
    sources,
    grounded: sources.length > 0,
    confidence: sources.length ? Math.min(1, 0.4 + found.coverage * 0.6) : found.coverage * 0.5,
    retrieval,
  };
}

module.exports = { answerVisitor, mapCitations, dontKnow, NO_ANSWER };
