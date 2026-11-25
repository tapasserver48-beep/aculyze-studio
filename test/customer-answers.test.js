/**
 * Phase 04.4 Stage A — Customer Executive answers: passage retrieval (BM25),
 * grounded AI answers with citations, corrective "don't know", and the public
 * visitor endpoints (no sign-in, rate limit, server-side history, leads).
 * Run with: node test/customer-answers.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

delete process.env.DATABASE_URL;
process.env.CUSTOMER_BOT_PER_MIN = '6';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'customer-answers-'));
process.env.ACULYZE_DATA_DIR = dataDir;

const retrieval = require('../src/customerExecutive/retrieval');
const { answerVisitor, mapCitations, NO_ANSWER } = require('../src/customerExecutive/answer');
const store = require('../src/customerExecutive/store');
const knowledge = require('../src/customerExecutive/knowledge');
const chatbots = require('../src/customerExecutive/chatbots');
const leads = require('../src/customerExecutive/leads');
const { createCustomerExecutiveRouter } = require('../src/customerExecutive/routes');

const PAGES = [
  { id: 'kg-1', source_url: 'https://acme.example/pricing', content_headings: ['Pricing'], extracted_at: 1, version: 1,
    content_content: 'Pricing. The Starter plan costs 999 rupees per month and includes 3 users. The Growth plan costs 2499 rupees per month for 10 users. Annual billing gives two months free.' },
  { id: 'kg-2', source_url: 'https://acme.example/contact', content_headings: ['Contact us'], extracted_at: 1, version: 1,
    content_content: 'Contact us. Our office is in Chennai, Tamil Nadu. Support hours are Monday to Saturday, 9am to 7pm IST. Email support@acme.example or call +91 44 1234 5678.' },
  { id: 'kg-3', source_url: 'https://acme.example/about', content_headings: ['About Acme'], extracted_at: 1, version: 1,
    content_content: `About Acme. ${'Acme builds learning management software for schools and colleges across India. '.repeat(30)} Founded in 2015 by two teachers.` },
];

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (err) { console.error(`  ✗ ${name}\n    ${err.stack}`); process.exitCode = 1; }
}

/** Stub model: records calls, answers with a fixed reply. */
function stubLlm(reply) {
  const calls = [];
  return { calls, sendMessage: async (req) => { calls.push(req); if (reply instanceof Error) throw reply; return { content: typeof reply === 'function' ? reply(req) : reply }; } };
}

(async () => {
  console.log('retrieval');
  await test('tokenize drops stop words and stems', () => {
    assert.deepStrictEqual(retrieval.tokenize('What are the plans for schools?'), ['plan', 'school']);
    const one = (w) => retrieval.tokenize(w)[0];
    assert.ok(['price', 'prices', 'priced', 'pricing'].every((w) => one(w) === one('price')), 'price forms match');
    assert.strictEqual(one('services'), one('service'));
    assert.strictEqual(one('running'), 'run');
    assert.deepStrictEqual(retrieval.tokenize('24x7 support in 2024'), ['24x7', 'support', '2024']);
  });
  await test('long pages are split into overlapping passages', () => {
    const p = retrieval.splitPassages(Array.from({ length: 300 }, (_, i) => `w${i}`).join(' '));
    assert.strictEqual(p.length, 3);
    assert.ok(p[1].startsWith('w110 '), 'second passage overlaps the first by 30 words');
  });
  await test('ranks the right page first and finds the right passage', () => {
    const idx = retrieval.buildIndex(PAGES);
    assert.strictEqual(retrieval.search(idx, 'How much does the growth plan cost?').results[0].url, 'https://acme.example/pricing');
    assert.strictEqual(retrieval.search(idx, 'what are your support hours').results[0].url, 'https://acme.example/contact');
    const about = retrieval.search(idx, 'when was acme founded');
    assert.strictEqual(about.results[0].url, 'https://acme.example/about');
    assert.match(about.results[0].text, /Founded in 2015/);
    assert.ok(about.results.filter((r) => r.url.endsWith('/about')).length <= 2, 'max 2 passages per page');
  });
  await test('weak results are flagged (corrective check)', () => {
    const idx = retrieval.buildIndex(PAGES);
    assert.strictEqual(retrieval.search(idx, 'do you sell bicycles').weak, true);
    assert.strictEqual(retrieval.search(idx, 'starter plan price').weak, false);
  });

  console.log('answers');
  const bot = { name: 'Acme', workspace_id: 'ws-test', instructions: 'Be warm.' };
  await test('grounded answer: citations mapped to page URLs', async () => {
    const llm = stubLlm('The Growth plan is 2499 rupees per month [1]. Annual billing gives two months free [1].');
    const r = await answerVisitor({ chatbot: bot, message: 'How much is the growth plan?', llm, items: PAGES });
    assert.strictEqual(r.grounded, true);
    assert.deepStrictEqual(r.sources.map((s) => s.url), ['https://acme.example/pricing']);
    assert.match(r.answer, /2499 rupees per month \[1\]/);
    const sys = llm.calls[0].messages[0].content;
    assert.match(sys, /Be warm\./);
    assert.match(sys, /\[1\] Pricing \(https:\/\/acme\.example\/pricing\)/);
  });
  await test('model says NO_ANSWER → polite "don\'t know" with contact offer', async () => {
    const r = await answerVisitor({ chatbot: bot, message: 'What is the refund policy for the starter plan?', llm: stubLlm(NO_ANSWER), items: PAGES });
    assert.strictEqual(r.grounded, false);
    assert.match(r.answer, /don't have that information/);
    assert.match(r.answer, /name and email or phone/);
  });
  await test('unrelated question → no model call at all', async () => {
    const llm = stubLlm('should not be called');
    const r = await answerVisitor({ chatbot: bot, message: 'do you sell bicycles', llm, items: PAGES });
    assert.strictEqual(llm.calls.length, 0);
    assert.strictEqual(r.grounded, false);
  });
  await test('short follow-up borrows the previous question', async () => {
    const llm = stubLlm('It is 999 rupees per month [1].');
    const history = [{ role: 'user', content: 'Tell me about the starter plan pricing' }, { role: 'assistant', content: 'Sure.' }];
    const r = await answerVisitor({ chatbot: bot, message: 'how much is it?', history, llm, items: PAGES });
    assert.strictEqual(r.grounded, true);
    assert.strictEqual(r.sources[0].url, 'https://acme.example/pricing');
    assert.strictEqual(llm.calls[0].messages[1].content, 'Tell me about the starter plan pricing', 'history passed to the model');
  });
  await test('no model / model error → short excerpt, not the whole page', async () => {
    const a = await answerVisitor({ chatbot: bot, message: 'when was acme founded', items: PAGES });
    assert.ok(a.answer.length < 450, `excerpt too long: ${a.answer.length}`);
    assert.strictEqual(a.sources[0].url, 'https://acme.example/about');
    const b = await answerVisitor({ chatbot: bot, message: 'support hours', llm: stubLlm(new Error('down')), items: PAGES });
    assert.strictEqual(b.retrieval.modelError, true);
    assert.match(b.answer, /Here's what I found/);
  });
  await test('invalid citations are dropped and repeated ones merged', () => {
    const res = [{ url: 'u1', title: 'A' }, { url: 'u2', title: 'B' }];
    const { text, sources } = mapCitations('X [2] [2]. Y [9]. Z [1].', res);
    assert.strictEqual(text, 'X [1]. Y . Z [2].');
    assert.deepStrictEqual(sources.map((s) => s.url), ['u2', 'u1']);
    const same = mapCitations('A [1] B [2] C [3].', [{ url: 'x/en', title: 'FAQ' }, { url: 'x/de', title: 'FAQ' }, { url: 'y', title: 'Pricing' }]);
    assert.strictEqual(same.text, 'A [1] B [1] C [2].');
    assert.strictEqual(same.sources.length, 2);
  });

  console.log('routes');
  await store.ensureSchema();
  await knowledge.ensureSchema();
  if (leads.ensureSchema) await leads.ensureSchema();
  const ws = await store.createWorkspace(dataDir, { creatorId: 'owner-1', name: 'Acme' });
  for (const p of PAGES) {
    await knowledge.addKnowledge(dataDir, { workspaceId: ws.id, sourceUrl: p.source_url, content: { headings: p.content_headings, paragraphs: [p.content_content] }, contentType: 'webpage' });
  }
  const cb = await chatbots.createChatbot(dataDir, { workspaceId: ws.id, name: 'Acme', description: 'Help', instructions: 'SECRET internal instructions', knowledgeIds: [], createdBy: 'owner-1' });
  await chatbots.approveChatbot(dataDir, ws.id, cb.id, 'owner-1', 'employee');
  const pub = await chatbots.publishChatbot(dataDir, ws.id, cb.id);
  const key = pub.publish_key;
  assert.ok(key, `publish failed: ${JSON.stringify(pub)}`);

  const llm = stubLlm((req) => (/refund/i.test(req.messages[req.messages.length - 1].content) ? NO_ANSWER : 'Growth is 2499 rupees per month [1].'));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (req.headers['x-user']) { req.user = { id: req.headers['x-user'], role: 'employee' }; req.authUid = req.headers['x-user']; } next(); });
  app.use('/api/customer', createCustomerExecutiveRouter({ dataDir, llm }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/customer`;
  const call = async (method, p, body, user) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(user ? { 'x-user': user } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };

  await test('public info works without sign-in and hides instructions', async () => {
    const r = await call('GET', `/public/${key}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.chatbot.name, 'Acme');
    assert.strictEqual(r.body.chatbot.instructions, undefined);
  });
  let convId;
  await test('public converse: grounded answer with sources (used to crash)', async () => {
    const r = await call('POST', `/public/${key}/converse`, { message: 'How much is the growth plan?' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.response, 'Growth is 2499 rupees per month [1].');
    assert.deepStrictEqual(r.body.sources, ['https://acme.example/pricing']);
    assert.strictEqual(r.body.grounded, true);
    convId = r.body.conversationId;
    assert.ok(convId);
  });
  await test('conversation history comes from the server, foreign ids are ignored', async () => {
    const before = llm.calls.length;
    const r = await call('POST', `/public/${key}/converse`, { message: 'and the growth plan users?', conversationId: convId, history: [{ role: 'user', content: 'INJECTED' }] });
    assert.strictEqual(r.body.conversationId, convId);
    const msgs = llm.calls[before].messages;
    assert.ok(msgs.some((m) => m.content === 'How much is the growth plan?'), 'stored history used');
    assert.ok(!msgs.some((m) => m.content === 'INJECTED'), 'browser history ignored');
    const other = await call('POST', `/public/${key}/converse`, { message: 'pricing', conversationId: 'conv-not-mine' });
    assert.notStrictEqual(other.body.conversationId, 'conv-not-mine');
  });
  await test('unanswerable question offers contact', async () => {
    const r = await call('POST', `/public/${key}/converse`, { message: 'What is your refund policy for the starter plan?' });
    assert.strictEqual(r.body.grounded, false);
    assert.strictEqual(r.body.offerContact, true);
  });
  await test('lead with consent saves the transcript (crypto was missing)', async () => {
    const r = await call('POST', `/public/${key}/leads`, { name: 'Priya', email: 'priya@example.com', consent: true, consentText: 'I agree', conversationId: convId });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const list = await leads.listLeads(dataDir, cb.id);
    const lead = list.find((l) => l.id === r.body.lead.id);
    const convo = typeof lead.conversation === 'string' ? JSON.parse(lead.conversation) : lead.conversation;
    assert.ok(convo.length >= 2, 'transcript attached');
  });
  await test('rate limit: too many messages from one visitor → 429', async () => {
    let last;
    for (let i = 0; i < 8; i++) last = await call('POST', `/public/${key}/converse`, { message: 'pricing' });
    assert.strictEqual(last.status, 429);
  });
  await test('owner test chat works in the app, strangers get 404, anonymous 401', async () => {
    const r = await call('POST', `/chatbots/${cb.id}/test`, { message: 'How much is the growth plan?' }, 'owner-1');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.grounded, true);
    assert.strictEqual((await call('POST', `/chatbots/${cb.id}/test`, { message: 'x' }, 'someone-else')).status, 404);
    assert.strictEqual((await call('POST', `/chatbots/${cb.id}/test`, { message: 'x' })).status, 401);
  });
  await test('knowledge search returns the best passage per page', async () => {
    const r = await call('GET', `/workspaces/${ws.id}/knowledge/search?q=${encodeURIComponent('support hours')}`, null, 'owner-1');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const list = r.body.results || r.body.knowledge || r.body;
    assert.strictEqual(list[0].source_url, 'https://acme.example/contact');
  });

  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
