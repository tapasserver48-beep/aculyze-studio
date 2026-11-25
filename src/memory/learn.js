/**
 * Memory learning + commands (Phase 04.4 Stage B).
 *
 * learnFromExchange(): after a chat turn, the AI compares what the person said
 * with what is already remembered and returns small changes:
 *   { add: [{ text, category }], update: [{ id, text }], remove: [id] }
 * A cheap pre-filter skips turns with nothing personal in them, so most
 * messages cost no extra AI call. One learning call per person per 15 s.
 *
 * parseCommand(): explicit "remember that …", "forget …", "what do you
 * remember about me?" — handled without the AI.
 */

const store = require('./store');

const COOLDOWN_MS = 15000;
const lastRun = new Map(); // userId → timestamp

// Something about the person: first person + a statement, or a stated preference.
const PERSONAL_RE = /\b(i|i'm|im|i am|i've|my|me|mine|we|we're|our|us)\b/i;
const SIGNAL_RE = /\b(am|work|working|job|role|title|team|manage|lead|run|own|founder|ceo|based|live|from|call me|name is|prefer|like|love|hate|don'?t like|always|never|usually|please (?:always|don'?t|never)|reply|answer|language|speak|focus|project|client|customer|company|business|goal|deadline|launch|hiring|budget)\b/i;

function worthLearning(userText) {
  const t = String(userText || '').trim();
  if (t.split(/\s+/).length < 4) return false;
  if (store.isSecret(t)) return false;
  return PERSONAL_RE.test(t) && SIGNAL_RE.test(t);
}

function parseJson(raw) {
  const s = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

const LEARN_PROMPT = `You maintain a short memory about ONE person who uses a business AI assistant.
From the person's latest message (and the assistant reply for context), decide what to remember long-term.

Remember only DURABLE facts about the person: their name, role, team, company, location, ongoing projects or goals, and stated preferences for how answers should be (length, tone, language, format).
Do NOT remember: one-off questions, things about other people or the world, the assistant's own answers, temporary moods, anything sensitive (health, religion, politics, finances of individuals), and NEVER passwords, codes, keys or card numbers.

Write each memory as one short sentence in the third person, e.g. "Manages the Chennai sales team." or "Prefers answers in bullet points."
Rules for changes:
- ADD every durable fact from the message that is not already stated in the existing memories, even if a related memory exists (e.g. "Works in the Chennai office" exists and they say they manage the sales team → add "Manages the sales team.").
- UPDATE a memory (use its id) only when the new fact replaces it (e.g. they moved team or changed role).
- REMOVE a memory when the person says it is wrong or no longer true.
- Change nothing for questions, requests and small talk with no lasting fact about the person.

Reply with JSON only:
{"add":[{"text":"...","category":"about|preference|work|other"}],"update":[{"id":"mem-...","text":"..."}],"remove":["mem-..."]}`;

/**
 * @returns {Promise<{ changed: boolean, added: [], updated: [], removed: [], skipped?: string }>}
 */
async function learnFromExchange({ dataDir, userId, userText, assistantText = '', llm, source = 'zara', employeeId = null, force = false }) {
  const out = { changed: false, added: [], updated: [], removed: [] };
  if (!userId || !llm) return { ...out, skipped: 'no-user-or-model' };
  const doc = store.read(dataDir, userId);
  if (!doc.settings.autoLearn) return { ...out, skipped: 'off' };
  if (!force && !worthLearning(userText)) return { ...out, skipped: 'nothing-personal' };
  const now = Date.now();
  if (!force && now - (lastRun.get(userId) || 0) < COOLDOWN_MS) return { ...out, skipped: 'cooldown' };
  lastRun.set(userId, now);

  const existing = doc.items.slice(-60).map((i) => `${i.id}: ${i.text}`).join('\n') || '(nothing yet)';
  let res;
  try {
    res = await llm.sendMessage({
      messages: [
        { role: 'system', content: LEARN_PROMPT },
        { role: 'user', content: `EXISTING MEMORIES:\n${existing}\n\nPERSON'S MESSAGE:\n${String(userText).slice(0, 2000)}\n\nASSISTANT REPLY (context only):\n${String(assistantText).slice(0, 800)}` },
      ],
      temperature: 0,
      max_tokens: 400,
      thinking: false,
      timeoutMs: 30000,
    });
  } catch (err) {
    return { ...out, skipped: `model: ${err.message}` };
  }
  const ops = parseJson(res && res.content);
  if (!ops) return { ...out, skipped: 'unparseable' };
  const ids = new Set(doc.items.map((i) => i.id));

  for (const id of (Array.isArray(ops.remove) ? ops.remove : []).slice(0, 5)) {
    if (ids.has(id) && store.remove(dataDir, userId, id)) out.removed.push(id);
  }
  for (const u of (Array.isArray(ops.update) ? ops.update : []).slice(0, 5)) {
    if (!u || !ids.has(u.id) || out.removed.includes(u.id)) continue;
    const r = store.update(dataDir, userId, u.id, { text: u.text });
    if (r.item) out.updated.push(r.item);
  }
  for (const a of (Array.isArray(ops.add) ? ops.add : []).slice(0, 5)) {
    if (!a || !a.text) continue;
    const r = store.add(dataDir, userId, { text: a.text, category: a.category, source, employeeId });
    if (r.item && !r.duplicate) out.added.push(r.item);
    else if (r.item) out.updated.push(r.item);
  }
  out.updated = out.updated.filter((u, i, all) => all.findIndex((x) => x.id === u.id) === i && !out.added.some((a) => a.id === u.id));
  out.changed = Boolean(out.added.length || out.updated.length || out.removed.length);
  return out;
}

/**
 * Explicit memory commands. Returns null when the text is not a command.
 *   "remember that I manage the Chennai team" → { type: 'remember', text }
 *   "forget my old job title" / "forget that I …" → { type: 'forget', query }
 *   "forget everything about me" → { type: 'forget-all' }
 *   "what do you remember about me?" → { type: 'list' }
 */
function parseCommand(text) {
  const t = String(text || '').trim().replace(/[.!]+$/, '');
  if (!t || t.length > 400) return null;
  let m;
  if (/^(what|which things|tell me what) (do|did) you (remember|know) about me\??$|^what('s| is) in your memory( about me)?\??$|^show (me )?(my|your) memor(y|ies)$/i.test(t)) return { type: 'list' };
  if (/^(please )?forget (everything|all) (about me|you know about me|you remember)$/i.test(t)) return { type: 'forget-all' };
  if ((m = t.match(/^(?:please )?(?:zara,? )?forget (?:that |about )?(.{3,})$/i))) return { type: 'forget', query: m[1] };
  if ((m = t.match(/^(?:please )?(?:zara,? )?(?:remember|note|keep in mind|don'?t forget)(?: that| this)?[:,]? (.{3,})$/i))) return { type: 'remember', text: m[1] };
  return null;
}

/** First person → third person for a remembered sentence ("I manage X" → "Manages X"). */
function toThirdPerson(text) {
  let s = String(text || '').trim().replace(/[.!]+$/, '');
  const verb = s.match(/^I(?: am|'m|’m)\s+(.*)$/i);
  if (verb) return capital(`Is ${verb[1]}.`.replace(/\bmy\b/gi, 'their'));
  const generic = s.match(/^I ([a-z]+)\s+(.*)$/i);
  if (generic) return capital(`${thirdVerb(generic[1])} ${generic[2]}`.replace(/\bmy\b/gi, 'their').replace(/\bme\b/gi, 'them') + '.');
  s = s.replace(/^my /i, 'Their ').replace(/\bmy\b/gi, 'their').replace(/\bI am\b/gi, 'they are').replace(/\bI'm\b/gi, 'they are').replace(/\bI\b/g, 'they').replace(/\bme\b/gi, 'them');
  return capital(`${s}.`);
}
function thirdVerb(v) {
  const w = v.toLowerCase();
  if (w === 'have') return 'Has';
  if (w === 'do') return 'Does';
  if (/(s|sh|ch|x|z|o)$/.test(w)) return `${w}es`;
  if (/[^aeiou]y$/.test(w)) return `${w.slice(0, -1)}ies`;
  return `${w}s`;
}
function capital(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

module.exports = { learnFromExchange, parseCommand, worthLearning, toThirdPerson, LEARN_PROMPT };
