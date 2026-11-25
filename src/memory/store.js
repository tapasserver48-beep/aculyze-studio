/**
 * Personal memory (Phase 04.4 Stage B): short facts Zara and the AI employees
 * remember about each person ("Prefers short answers", "Manages the Chennai
 * sales team"). One document per account through the docstore, so it lives in
 * Postgres on Render.
 *
 *   memory/<userId>.json → { settings: { autoLearn }, items: [MemoryItem] }
 *   MemoryItem = { id, text, category, source, employeeId, createdAt, updatedAt, lastUsedAt }
 *
 * Inspired by llm_apps_with_memory_tutorials (llm_app_personalized_memory,
 * multi_llm_memory) in Shubhamsaboo/awesome-llm-apps (Apache-2.0); no code copied.
 */

const path = require('path');
const crypto = require('crypto');
const docstore = require('../db/docstore');
const { tokenize } = require('../customerExecutive/retrieval');

const MAX_ITEMS = 200;
const MAX_TEXT = 300;
const CATEGORIES = ['about', 'preference', 'work', 'other'];
const SOURCES = ['manual', 'zara', 'inbox', 'task'];

// Never store secrets, whatever asked for it.
const SECRET_RE = /\b(password|passcode|passwd|pwd|otp|one[- ]time code|pin\b|cvv|api[ _-]?key|secret key|token)\b|\b(?:\d[ -]?){13,19}\b|\bsk-[A-Za-z0-9]{16,}|\bnvapi-[A-Za-z0-9_-]{16,}/i;

function fileFor(dataDir, userId) {
  const safe = String(userId || '').replace(/[^A-Za-z0-9_.-]/g, '_');
  if (!safe) throw new Error('A user is required.');
  return path.join(dataDir, 'memory', `${safe}.json`);
}

function read(dataDir, userId) {
  const doc = docstore.readJson(dataDir, fileFor(dataDir, userId), null) || {};
  return {
    settings: { autoLearn: doc.settings ? doc.settings.autoLearn !== false : true },
    items: Array.isArray(doc.items) ? doc.items : [],
  };
}

function write(dataDir, userId, doc) {
  docstore.writeJson(dataDir, fileFor(dataDir, userId), doc);
  return doc;
}

function cleanText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().replace(/^[-•*]\s*/, '').slice(0, MAX_TEXT);
}

function isSecret(text) {
  return SECRET_RE.test(String(text || ''));
}

function similar(a, b) {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return String(a).toLowerCase() === String(b).toLowerCase();
  let both = 0;
  for (const t of ta) if (tb.has(t)) both++;
  return both / Math.min(ta.size, tb.size) >= 0.8;
}

function list(dataDir, userId) {
  const doc = read(dataDir, userId);
  return { settings: doc.settings, items: doc.items.slice().sort((a, b) => b.updatedAt - a.updatedAt) };
}

/**
 * Add a memory. Near-duplicates update the existing one instead.
 * @returns {{ item?, error?, duplicate? }}
 */
function add(dataDir, userId, { text, category = 'other', source = 'manual', employeeId = null } = {}) {
  const t = cleanText(text);
  if (!t) return { error: 'The memory is empty.' };
  if (isSecret(t)) return { error: "For your safety I don't remember passwords, codes, keys or card numbers." };
  const doc = read(dataDir, userId);
  const now = Date.now();
  const dup = doc.items.find((i) => similar(i.text, t));
  if (dup) {
    // Keep the existing wording when only case / punctuation differs.
    const plain = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (plain(dup.text) !== plain(t)) dup.text = t;
    dup.updatedAt = now;
    write(dataDir, userId, doc);
    return { item: dup, duplicate: true };
  }
  const item = {
    id: `mem-${crypto.randomUUID().slice(0, 10)}`,
    text: t,
    category: CATEGORIES.includes(category) ? category : 'other',
    source: SOURCES.includes(source) ? source : 'manual',
    employeeId: employeeId || null,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
  };
  doc.items.push(item);
  // Over the cap: drop the least recently used / oldest.
  if (doc.items.length > MAX_ITEMS) {
    doc.items.sort((a, b) => (b.lastUsedAt || b.updatedAt) - (a.lastUsedAt || a.updatedAt));
    doc.items = doc.items.slice(0, MAX_ITEMS);
  }
  write(dataDir, userId, doc);
  return { item };
}

function update(dataDir, userId, id, { text, category } = {}) {
  const doc = read(dataDir, userId);
  const item = doc.items.find((i) => i.id === id);
  if (!item) return { error: 'Memory not found.' };
  if (text !== undefined) {
    const t = cleanText(text);
    if (!t) return { error: 'The memory is empty.' };
    if (isSecret(t)) return { error: "For your safety I don't remember passwords, codes, keys or card numbers." };
    item.text = t;
  }
  if (category && CATEGORIES.includes(category)) item.category = category;
  item.updatedAt = Date.now();
  write(dataDir, userId, doc);
  return { item };
}

function remove(dataDir, userId, id) {
  const doc = read(dataDir, userId);
  const before = doc.items.length;
  doc.items = doc.items.filter((i) => i.id !== id);
  write(dataDir, userId, doc);
  return doc.items.length < before;
}

function clear(dataDir, userId) {
  const doc = read(dataDir, userId);
  const n = doc.items.length;
  doc.items = [];
  write(dataDir, userId, doc);
  return n;
}

function setSettings(dataDir, userId, { autoLearn } = {}) {
  const doc = read(dataDir, userId);
  if (typeof autoLearn === 'boolean') doc.settings.autoLearn = autoLearn;
  write(dataDir, userId, doc);
  return doc.settings;
}

/** Memories matching words in `query` ("forget my job title" → the job memory). */
function find(dataDir, userId, query) {
  const terms = new Set(tokenize(query));
  if (!terms.size) return [];
  return read(dataDir, userId).items
    .map((i) => ({ i, hits: tokenize(i.text).filter((t) => terms.has(t)).length }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .map((x) => x.i);
}

/**
 * The memories to give the AI for one request: always "about" + "preference"
 * (they shape every answer), then the most relevant others, newest first.
 * Marks them used. Returns '' when there is nothing to add.
 */
function contextFor(dataDir, userId, query = '', { limit = 20 } = {}) {
  if (!userId) return '';
  let doc;
  try { doc = read(dataDir, userId); } catch { return ''; }
  if (!doc.items.length) return '';
  const terms = new Set(tokenize(query));
  const scored = doc.items.map((i) => {
    const hits = terms.size ? tokenize(i.text).filter((t) => terms.has(t)).length : 0;
    const core = i.category === 'about' || i.category === 'preference' ? 2 : 0;
    return { i, score: core + hits * 3 + (i.updatedAt / 1e13) };
  }).sort((a, b) => b.score - a.score).slice(0, limit);
  const now = Date.now();
  for (const s of scored) s.i.lastUsedAt = now;
  try { write(dataDir, userId, doc); } catch { /* best effort */ }
  const lines = scored.map((s) => `- ${s.i.text}`);
  return `WHAT YOU REMEMBER ABOUT THIS PERSON (they told you or it came up in earlier chats; use it naturally when relevant, never recite the list, and if something here conflicts with what they say now, trust what they say now):\n${lines.join('\n')}`;
}

module.exports = { list, add, update, remove, clear, setSettings, find, contextFor, read, isSecret, similar, CATEGORIES, MAX_ITEMS };
