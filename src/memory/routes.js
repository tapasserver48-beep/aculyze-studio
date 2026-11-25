/**
 * /api/memory — the signed-in person's memory (Phase 04.4 Stage B).
 *
 *   GET    /             { settings, items }
 *   POST   /             { text, category? }           add by hand
 *   PATCH  /:id          { text?, category? }
 *   DELETE /:id
 *   DELETE /             forget everything
 *   PUT    /settings     { autoLearn }
 *   GET    /context?q=   memory text for one Zara request
 *   POST   /command      { text } → handles "remember …" / "forget …" / "what do you remember"
 *   POST   /learn        { userText, assistantText } → background learning after a Zara turn
 */

const express = require('express');
const { requireUser } = require('../auth/session');
const store = require('./store');
const { learnFromExchange, parseCommand, toThirdPerson } = require('./learn');

function createMemoryRouter({ dataDir, llm }) {
  const router = express.Router();
  router.use(requireUser);
  const uid = (req) => req.user.id;

  router.get('/', (req, res) => res.json(store.list(dataDir, uid(req))));

  router.post('/', (req, res) => {
    const r = store.add(dataDir, uid(req), { text: req.body && req.body.text, category: req.body && req.body.category, source: 'manual' });
    if (r.error) return res.status(400).json({ error: r.error });
    res.status(r.duplicate ? 200 : 201).json(r);
  });

  router.patch('/:id', (req, res) => {
    const r = store.update(dataDir, uid(req), req.params.id, req.body || {});
    if (r.error) return res.status(r.error === 'Memory not found.' ? 404 : 400).json({ error: r.error });
    res.json(r);
  });

  router.delete('/:id', (req, res) => {
    if (!store.remove(dataDir, uid(req), req.params.id)) return res.status(404).json({ error: 'Memory not found.' });
    res.json({ removed: true });
  });

  router.delete('/', (req, res) => res.json({ removed: store.clear(dataDir, uid(req)) }));

  router.put('/settings', (req, res) => res.json({ settings: store.setSettings(dataDir, uid(req), req.body || {}) }));

  router.get('/context', (req, res) => {
    res.json({ context: store.contextFor(dataDir, uid(req), String(req.query.q || '').slice(0, 2000)) });
  });

  router.post('/command', (req, res) => {
    const cmd = parseCommand(req.body && req.body.text);
    if (!cmd) return res.json({ handled: false });
    const id = uid(req);
    if (cmd.type === 'list') {
      const { items } = store.list(dataDir, id);
      const reply = items.length
        ? `Here's what I remember about you:\n\n${items.slice(0, 40).map((i) => `- ${i.text}`).join('\n')}\n\nYou can say "forget …" to remove something, or manage everything in Settings → Memory.`
        : "I don't remember anything about you yet. Tell me things like your role or how you like answers, or say \"remember that …\".";
      return res.json({ handled: true, reply, changed: false });
    }
    if (cmd.type === 'forget-all') {
      const n = store.clear(dataDir, id);
      return res.json({ handled: true, reply: n ? `Done. I've forgotten all ${n} thing${n === 1 ? '' : 's'} I remembered about you.` : "I didn't remember anything about you.", changed: n > 0 });
    }
    if (cmd.type === 'forget') {
      const matches = store.find(dataDir, id, cmd.query);
      if (!matches.length) return res.json({ handled: true, reply: `I couldn't find anything about "${cmd.query}" in my memory.`, changed: false });
      const gone = matches.slice(0, 3);
      for (const m of gone) store.remove(dataDir, id, m.id);
      return res.json({ handled: true, reply: `Okay, I've forgotten:\n\n${gone.map((m) => `- ${m.text}`).join('\n')}`, changed: true, removed: gone.map((m) => m.id) });
    }
    // remember
    const r = store.add(dataDir, id, { text: toThirdPerson(cmd.text), category: 'other', source: 'zara' });
    if (r.error) return res.json({ handled: true, reply: r.error, changed: false });
    return res.json({ handled: true, reply: `Got it. I'll remember: "${r.item.text}"`, changed: true, item: r.item });
  });

  router.post('/learn', async (req, res) => {
    const { userText, assistantText } = req.body || {};
    try {
      const r = await learnFromExchange({ dataDir, userId: uid(req), userText, assistantText, llm, source: 'zara' });
      res.json(r);
    } catch (err) {
      res.json({ changed: false, skipped: err.message });
    }
  });

  return router;
}

module.exports = { createMemoryRouter };
