/**
 * Phase 04.4 Stage B — personal memory: store, secret filter, commands,
 * AI learning (add / update / remove), context for prompts, the /api/memory
 * routes (per-user isolation), and Inbox replies using memory.
 * Run with: node test/memory.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

delete process.env.DATABASE_URL;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-test-'));
process.env.ACULYZE_DATA_DIR = dataDir;

const store = require('../src/memory/store');
const { learnFromExchange, parseCommand, worthLearning, toThirdPerson } = require('../src/memory/learn');
const { createMemoryRouter } = require('../src/memory/routes');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (err) { console.error(`  ✗ ${name}\n    ${err.stack}`); process.exitCode = 1; }
}
function stubLlm(reply) {
  const calls = [];
  return { calls, sendMessage: async (req) => { calls.push(req); return { content: typeof reply === 'function' ? reply(req) : reply }; } };
}

(async () => {
  console.log('store');
  await test('add, near-duplicate updates instead of adding, list newest first', () => {
    const a = store.add(dataDir, 'u1', { text: 'Manages the Chennai sales team.', category: 'about' });
    assert.ok(a.item && !a.duplicate);
    const b = store.add(dataDir, 'u1', { text: 'manages the chennai sales team' });
    assert.strictEqual(b.duplicate, true);
    store.add(dataDir, 'u1', { text: 'Prefers short answers in bullet points.', category: 'preference' });
    const { items, settings } = store.list(dataDir, 'u1');
    assert.strictEqual(items.length, 2);
    assert.strictEqual(settings.autoLearn, true);
  });
  await test('never stores passwords, codes, keys or card numbers', () => {
    for (const t of ['My password is hunter2', 'OTP 482913', 'card 4111 1111 1111 1111', 'key sk-abcdefghijklmnopqrstu', 'my api key is xyz']) {
      assert.ok(store.add(dataDir, 'u1', { text: t }).error, t);
    }
    assert.strictEqual(store.list(dataDir, 'u1').items.length, 2);
  });
  await test('update, remove, find, settings, clear; users are separate', () => {
    const [first] = store.list(dataDir, 'u1').items;
    assert.strictEqual(store.update(dataDir, 'u1', first.id, { text: 'Prefers detailed answers.' }).item.text, 'Prefers detailed answers.');
    assert.strictEqual(store.find(dataDir, 'u1', 'forget the chennai team thing')[0].text, 'Manages the Chennai sales team.');
    store.add(dataDir, 'u2', { text: 'Works in finance.' });
    assert.strictEqual(store.list(dataDir, 'u2').items.length, 1);
    assert.strictEqual(store.setSettings(dataDir, 'u2', { autoLearn: false }).autoLearn, false);
    assert.strictEqual(store.clear(dataDir, 'u2'), 1);
    assert.strictEqual(store.list(dataDir, 'u1').items.length, 2, 'u1 untouched');
  });
  await test('cap: oldest / least used memories are dropped past the limit', () => {
    for (let i = 0; i < store.MAX_ITEMS + 5; i++) store.add(dataDir, 'u3', { text: `Fact number ${i} about project ${i * 7919}` });
    assert.strictEqual(store.list(dataDir, 'u3').items.length, store.MAX_ITEMS);
  });
  await test('context: preferences always included, relevant ones first, empty when nothing', () => {
    const ctx = store.contextFor(dataDir, 'u1', 'draft an email to the chennai team');
    assert.match(ctx, /WHAT YOU REMEMBER ABOUT THIS PERSON/);
    assert.match(ctx, /Prefers detailed answers/);
    assert.match(ctx, /Chennai sales team/);
    assert.strictEqual(store.contextFor(dataDir, 'nobody', 'x'), '');
  });

  console.log('commands');
  await test('parses remember / forget / forget all / list', () => {
    assert.deepStrictEqual(parseCommand('Remember that I manage the Chennai team.'), { type: 'remember', text: 'I manage the Chennai team' });
    assert.deepStrictEqual(parseCommand('please forget my old job title'), { type: 'forget', query: 'my old job title' });
    assert.deepStrictEqual(parseCommand('forget everything about me'), { type: 'forget-all' });
    assert.deepStrictEqual(parseCommand('What do you remember about me?'), { type: 'list' });
    assert.strictEqual(parseCommand('How do I remember passwords safely?'), null);
    assert.strictEqual(parseCommand('Can you help me forget-proof my notes'), null);
  });
  await test('first person becomes third person', () => {
    assert.strictEqual(toThirdPerson('I manage the Chennai team'), 'Manages the Chennai team.');
    assert.strictEqual(toThirdPerson("I'm the head of sales"), 'Is the head of sales.');
    assert.strictEqual(toThirdPerson('my favourite format is tables'), 'Their favourite format is tables.');
    assert.strictEqual(toThirdPerson('I prefer replies in Tamil'), 'Prefers replies in Tamil.');
  });

  console.log('learning');
  await test('pre-filter: only personal, lasting statements reach the AI', () => {
    assert.strictEqual(worthLearning('What is the GST rate on software?'), false);
    assert.strictEqual(worthLearning('I manage the Chennai sales team of 12 people'), true);
    assert.strictEqual(worthLearning('Please always reply in bullet points for me'), true);
    assert.strictEqual(worthLearning('My password is abc and I work here'), false);
  });
  await test('applies add / update / remove from the AI; ignores unknown ids', async () => {
    const before = store.list(dataDir, 'u1').items;
    const chennai = before.find((i) => /Chennai/.test(i.text));
    const pref = before.find((i) => /detailed/.test(i.text));
    const llm = stubLlm(() => JSON.stringify({
      add: [{ text: 'Is launching a new product in March.', category: 'work' }],
      update: [{ id: chennai.id, text: 'Manages the Bengaluru sales team.' }, { id: 'mem-unknown', text: 'x' }],
      remove: [pref.id, 'mem-nope'],
    }));
    const r = await learnFromExchange({ dataDir, userId: 'u1', userText: "I moved to the Bengaluru team and we're launching a product in March", llm, force: true });
    assert.strictEqual(r.changed, true);
    const texts = store.list(dataDir, 'u1').items.map((i) => i.text);
    assert.ok(texts.includes('Manages the Bengaluru sales team.'));
    assert.ok(texts.includes('Is launching a new product in March.'));
    assert.ok(!texts.some((t) => /detailed/.test(t)));
    assert.match(llm.calls[0].messages[1].content, new RegExp(chennai.id), 'existing memories (with ids) sent to the AI');
  });
  await test('no AI call for impersonal messages, when learning is off, or during cooldown', async () => {
    const llm = stubLlm('{"add":[],"update":[],"remove":[]}');
    assert.strictEqual((await learnFromExchange({ dataDir, userId: 'u4', userText: 'What is the capital of France?', llm })).skipped, 'nothing-personal');
    store.setSettings(dataDir, 'u5', { autoLearn: false });
    assert.strictEqual((await learnFromExchange({ dataDir, userId: 'u5', userText: 'I manage the finance team at Acme', llm })).skipped, 'off');
    await learnFromExchange({ dataDir, userId: 'u6', userText: 'I manage the finance team at Acme', llm });
    assert.strictEqual((await learnFromExchange({ dataDir, userId: 'u6', userText: 'I also lead the audit project', llm })).skipped, 'cooldown');
    assert.strictEqual(llm.calls.length, 1);
  });
  await test('broken AI output changes nothing', async () => {
    const before = store.list(dataDir, 'u1').items.length;
    const r = await learnFromExchange({ dataDir, userId: 'u1', userText: 'I run the Mumbai office for the company', llm: stubLlm('sure! I will remember that'), force: true });
    assert.strictEqual(r.skipped, 'unparseable');
    assert.strictEqual(store.list(dataDir, 'u1').items.length, before);
  });

  console.log('routes');
  const llm = stubLlm('{"add":[{"text":"Leads the marketing team.","category":"about"}],"update":[],"remove":[]}');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { const u = req.headers['x-user']; if (u) { req.user = { id: u }; req.authUid = u; } next(); });
  app.use('/api/memory', createMemoryRouter({ dataDir, llm }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/memory`;
  const call = async (method, p, body, user = 'r1') => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(user ? { 'x-user': user } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };

  await test('commands through the API: remember, list, forget, forget all', async () => {
    let r = await call('POST', '/command', { text: 'remember that I prefer replies in Tamil' });
    assert.strictEqual(r.body.handled, true);
    assert.match(r.body.reply, /Prefers replies in Tamil/);
    r = await call('POST', '/command', { text: 'what do you remember about me?' });
    assert.match(r.body.reply, /Prefers replies in Tamil/);
    r = await call('POST', '/command', { text: 'forget the Tamil thing' });
    assert.match(r.body.reply, /forgotten/);
    assert.strictEqual((await call('GET', '')).body.items.length, 0);
    await call('POST', '', { text: 'Works from Chennai.' });
    r = await call('POST', '/command', { text: 'forget everything about me' });
    assert.match(r.body.reply, /forgotten all 1 thing/);
    assert.strictEqual((await call('POST', '/command', { text: 'What is the weather?' })).body.handled, false);
  });
  await test('CRUD, settings, learn, context; 401 when signed out; users isolated', async () => {
    const add = await call('POST', '', { text: 'Runs the Pune office.' });
    assert.strictEqual(add.status, 201);
    const id = add.body.item.id;
    assert.strictEqual((await call('PATCH', `/${id}`, { text: 'Runs the Pune and Nashik offices.' })).body.item.text, 'Runs the Pune and Nashik offices.');
    assert.strictEqual((await call('POST', '', { text: 'my password is x' })).status, 400);
    assert.strictEqual((await call('GET', '', null, 'r2')).body.items.length, 0, 'another user sees nothing');
    assert.strictEqual((await call('DELETE', `/${id}`, null, 'r2')).status, 404, 'cannot delete another user\'s memory');
    const learn = await call('POST', '/learn', { userText: 'I lead the marketing team at Acme now', assistantText: 'Great!' });
    assert.strictEqual(learn.body.changed, true);
    const ctx = await call('GET', `/context?q=${encodeURIComponent('marketing plan')}`);
    assert.match(ctx.body.context, /Leads the marketing team/);
    assert.strictEqual((await call('PUT', '/settings', { autoLearn: false })).body.settings.autoLearn, false);
    assert.strictEqual((await call('GET', '', null, null)).status, 401);
  });
  server.close();

  console.log('AI employees');
  await test('Inbox replies include the person\'s memory', async () => {
    const authStore = require('../src/auth/store');
    const employees = require('../src/employees/store');
    const inbox = require('../src/inbox/store');
    const { replyInThread } = require('../src/execution/inboxChat');
    const user = await authStore.createUser(dataDir, { name: 'Meena', email: 'meena@example.com', password: 'Password123!' });
    const made = await employees.initializeEmployee(dataDir, 'AI-CHIEF-001');
    const emp = made.employee || (await employees.listEmployees(dataDir)).find((e) => e.employee_code === 'AI-CHIEF-001');
    store.add(dataDir, user.id, { text: 'Prefers replies in Tamil.', category: 'preference' });
    await inbox.sendMessage(dataDir, { from: `usr-${user.id}`, fromName: 'Meena', to: emp.id, toName: emp.name, body: 'Can you summarise this week for me?' });
    const seen = stubLlm('Sure, here is the summary.');
    await replyInThread(dataDir, { employeeId: emp.id, userId: user.id, provider: seen });
    const systemText = seen.calls[0].messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    assert.match(systemText, /Prefers replies in Tamil/);
  });

  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
  process.exit(process.exitCode || 0);
})();
