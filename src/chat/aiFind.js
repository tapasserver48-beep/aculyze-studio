/**
 * aiFind — LLM re-rank for the "find people/channels" directory search.
 *
 * The deterministic scorer in store.findInWorkspace already returns keyword
 * hits; this module asks the active AI brain to pick the BEST matches from a
 * closed candidate list. Rules:
 *   • The model may only choose ids we hand it — every returned id is checked
 *     against the whitelist, so it can never invent a person or channel.
 *   • Short timeout (search must feel instant); on ANY failure it returns
 *     null and the caller serves the keyword results unchanged.
 *   • Same provider router as chat / mailDraft (LM Studio + NVIDIA hybrid).
 */
const { createRouterFromEnv } = require('../services/ai/router');

let _provider = null;
function provider() {
  if (!_provider) _provider = createRouterFromEnv(process.env).active;
  return _provider;
}

const SYSTEM = `You help people find colleagues and chat channels in a workspace.
You receive a query and a CLOSED list of candidates (ids are fixed — you may only repeat ids from that list, never invent new ones).
Reply with ONLY a JSON object, no prose, no markdown fences:
{"people":["<uid>"],"channels":["<id>"],"departments":["<id>"],"answer":"one short helpful sentence"}
Rules:
- Include only the ids that genuinely match the query; use [] when nothing fits.
- Keep ids exactly as given (channels/departments ids are numbers — return them as strings).
- "answer" is at most 20 words, friendly, and may name the top pick.`;

function parseJson(text) {
  if (!text) return null;
  let s = String(text).trim();
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
 * Re-rank the candidate lists for a query.
 * @returns {Promise<{people:string[],channels:string[],departments:string[],answer:string}|null>}
 *          null → caller serves the deterministic keyword results.
 */
async function reRank(query, candidates, { timeoutMs = 6000 } = {}) {
  const people = Array.isArray(candidates.people) ? candidates.people : [];
  const channels = Array.isArray(candidates.channels) ? candidates.channels : [];
  const departments = Array.isArray(candidates.departments) ? candidates.departments : [];
  if (!people.length && !channels.length && !departments.length) return null;

  const allowedPeople = new Set(people.map((p) => String(p.uid)));
  const allowedChannels = new Set(channels.map((c) => String(c.id)));
  const allowedDepts = new Set(departments.map((d) => String(d.id)));

  try {
    const call = provider().sendMessage({
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: `Query: ${String(query || '').slice(0, 300)}\nCandidates: ${JSON.stringify({
            people,
            channels: channels.map((c) => ({ id: String(c.id), name: c.name })),
            departments: departments.map((d) => ({ id: String(d.id), name: d.name })),
          })}`,
        },
      ],
      temperature: 0.1,
      max_tokens: 400,
    });
    const res = await Promise.race([
      call,
      new Promise((_, rej) => setTimeout(() => rej(new Error('find timeout')), timeoutMs)),
    ]);
    const j = parseJson(res && res.content);
    if (!j) return null;

    const pick = (list, allowed) => (Array.isArray(list) ? list.map((x) => String(x)).filter((x) => allowed.has(x)) : []);
    const answer = typeof j.answer === 'string' ? j.answer.slice(0, 300) : '';
    return {
      people: pick(j.people, allowedPeople),
      channels: pick(j.channels, allowedChannels),
      departments: pick(j.departments, allowedDepts),
      answer,
    };
  } catch {
    return null; // LLM unreachable → keyword fallback (caller decides)
  }
}

module.exports = { reRank };
