/**
 * Zara AI — frontend application.
 * Depends only on the Chat API Layer (js/api.js), never on LM Studio directly.
 */
import { fetchConfig, fetchStatus, fetchModels, streamChat, searchWeb, fetchPageText, emailStatus, sendEmail, salesStatus, salesConnect, salesQuery,
  listIntegrations, integrationDetail, integrationConnect, integrationTest, integrationDisconnect,
  resolveIntegrations, executeIntegration,
  resolveBrowser, executeBrowser,
  resolveComputer, executeComputer,
  classifyOrchestrator, runOrchestrator } from './api.js';
import {
  loadConversations, saveConversations, createConversation, autoTitleFrom,
  groupConversations, loadSettings, saveSettings, uid,
} from './store.js';
import { renderMarkdown, highlightAll, enhanceCodeBlocks } from './markdown.js';
import { sttSupported, ttsSupported, createListener, speak, stopSpeaking, isSpeaking } from './voice.js';
import { voiceStatus, synthesizeVoice } from './api.js';
import { createThinking } from './thinking.js';

const $ = (sel) => document.querySelector(sel);

// --- DOM ---
const sidebar = $('#sidebar');
const sidebarOverlay = $('#sidebarOverlay');
const historyList = $('#historyList');
const messagesEl = $('#messages');
const emptyState = $('#emptyState');
const chatScroll = $('#chatScroll');
const input = $('#composerInput');
const sendBtn = $('#sendBtn');
const stopBtn = $('#stopBtn');
const statusDot = $('#statusDot');
const statusText = $('#statusText');
const offlineBanner = $('#offlineBanner');
const toastRoot = $('#toastRoot');

// --- State ---
let conversations = loadConversations();
let settings = loadSettings();
let activeId = conversations[0]?.id || null;
let generating = false;
let abortController = null;
let availableModels = [];
let providerName = 'lmstudio';
let serverUrl = '';
let historyFilter = '';
const K_SIDEBAR = 'zara:sidebar-collapsed:v1';

// --- AI agents (sidebar category): each is a lightweight persona applied
// as an extra system message; the core model stays the same. ---
const AGENTS = [
  { id: 'zara', name: 'Zara', icon: 'Z', desc: 'Everyday questions & tasks', persona: '' },
  { id: 'research', name: 'Researcher', icon: '🔎', desc: 'Facts, sources, web answers', persona: 'You are in RESEARCH mode: answer factually and concisely, cite sources like [1] when web reference material is provided, and clearly say when you are unsure instead of guessing.' },
  { id: 'coder', name: 'Coder', icon: '⌨️', desc: 'Code, debugging, reviews', persona: 'You are in CODING mode: give precise, working code in fenced blocks with the correct language tag, keep prose explanations short, and mention edge cases or bugs you notice.' },
  { id: 'writer', name: 'Writer', icon: '✍️', desc: 'Drafts, emails, editing', persona: 'You are in WRITING mode: produce polished, well-structured prose with a clear tone, and when asked to improve text, offer a tighter rewrite plus one line on what you changed.' },
  { id: 'teacher', name: 'Teacher', icon: '🎓', desc: 'Step-by-step learning', persona: 'You are in TEACHING mode: explain step by step in simple language, use one short concrete example, and end with a single quick question that checks understanding.' },
  { id: 'sales', name: 'Sales AI', icon: '💼', desc: 'SAP / ERP sales data', persona: 'You are in SALES mode: answer strictly from the ERP/SALES DATA provided in the context — quotes, orders, revenue, customers and stock figures. Quote exact numbers, never invent or guess values that are not in the data, and say plainly when the data does not contain the answer.' },
];
function agentById(id) {
  return AGENTS.find((a) => a.id === id) || AGENTS[0];
}

function isMobileLayout() {
  return window.matchMedia('(max-width: 900px)').matches;
}

function setSidebarCollapsed(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', !!collapsed);
  try { localStorage.setItem(K_SIDEBAR, collapsed ? '1' : '0'); } catch { /* ignore */ }
}

function toggleSidebar() {
  if (isMobileLayout()) {
    sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
  } else {
    setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed'));
  }
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  toastRoot.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function activeConversation() {
  return conversations.find((c) => c.id === activeId) || null;
}

function persist() {
  saveConversations(conversations);
}

// ============ THEME ============
function applyTheme() {
  const root = document.documentElement;
  const theme = settings.theme || 'dark'; // ACULYZE STUDIO defaults to Deep Space
  if (theme === 'system') {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
  } else {
    root.setAttribute('data-theme', theme);
  }
  document.body.classList.toggle('compact', !!settings.compact);
  document.body.classList.toggle('no-animations', settings.animations === false);
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if (settings.theme === 'system') applyTheme();
});

// ============ SIDEBAR ============
function openSidebar() {
  sidebar.classList.add('open');
  sidebarOverlay.hidden = false;
}
function closeSidebar() {
  sidebar.classList.remove('open');
  sidebarOverlay.hidden = true;
}

// ============ AI AGENTS (palette + settings mounts) ============
function renderAgents() {
  const conv = activeConversation();
  const activeAgent = conv?.agent || 'zara';
  document.querySelectorAll('.agents-mount').forEach((mount) => {
    mount.innerHTML = '';
    for (const a of AGENTS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'agent-item' + (a.id === activeAgent ? ' active' : '');
      btn.setAttribute('aria-pressed', String(a.id === activeAgent));
      btn.title = a.persona ? `Start a chat with ${a.name} — ${a.desc}` : `Chat with Zara — ${a.desc}`;
      const ico = document.createElement('span');
      ico.className = 'agent-ico' + (a.id === 'zara' ? ' zara-ico' : '');
      ico.textContent = a.icon;
      const meta = document.createElement('span');
      meta.className = 'agent-meta';
      const name = document.createElement('strong');
      name.textContent = a.name;
      const desc = document.createElement('small');
      desc.textContent = a.desc;
      meta.append(name, desc);
      const check = document.createElement('span');
      check.className = 'agent-check';
      check.textContent = '✓';
      check.setAttribute('aria-hidden', 'true');
      btn.append(ico, meta, check);
      btn.onclick = () => pickAgent(a.id);
      mount.appendChild(btn);
    }
  });
}

/** Pick an agent → reuse the current empty chat, otherwise start a new one. */
async function pickAgent(id) {
  if (generating) { toast('Stop generation before switching agents'); return; }
  closeAgentPalette();
  stopVoicePlayback();
  let conv = activeConversation();
  if (!conv || conv.messages.length > 0 || (conv.agent && conv.agent !== id)) {
    conv = createConversation();
    conversations.unshift(conv);
    activeId = conv.id;
  }
  conv.agent = id;
  conv.updatedAt = new Date().toISOString();
  persist();
  renderAll();
  const a = agentById(id);
  toast(id === 'zara' ? '💬 Chatting with Zara' : `${a.icon} New chat with ${a.name}`);
  input.focus();
  closeSidebar();

  // Sales AI needs the SAP/ERP plugin — walk the user through connecting it.
  if (id === 'sales') {
    try {
      const status = await salesStatus();
      if (!status.connected) {
        openSettings();
        showSettingsPage('sales-detail');
        setTimeout(() => $('#setSalesProvider')?.focus(), 80);
        toast('🔌 Add your SAP/ERP provider + API key to connect the plugin');
      } else if (!status.inUse) {
        openSettings();
        showSettingsPage('sales-detail');
        toast('🔌 Turn on "Use this integration" so Sales AI can read your ERP data');
      } else if (!settingsOverlay.hidden) {
        closeSettings();
      }
    } catch { /* offline — Settings still reachable manually */ }
  } else if (!settingsOverlay.hidden) {
    closeSettings();
  }
}

function renderHistory() {
  historyList.innerHTML = '';
  const q = historyFilter.trim().toLowerCase();
  const visible = q
    ? conversations.filter((c) => c.title.toLowerCase().includes(q))
    : conversations;
  if (conversations.length === 0) {
    const d = document.createElement('div');
    d.className = 'history-empty';
    d.textContent = 'No conversations yet. Start a new chat.';
    historyList.appendChild(d);
    return;
  }
  if (visible.length === 0) {
    const d = document.createElement('div');
    d.className = 'history-empty';
    d.textContent = `No chats match "${historyFilter.trim()}".`;
    historyList.appendChild(d);
    return;
  }
  const groups = groupConversations(visible);
  for (const [group, items] of Object.entries(groups)) {
    if (items.length === 0) continue;
    const g = document.createElement('div');
    g.className = 'history-group';
    const gl = document.createElement('span');
    gl.textContent = group;
    const gc = document.createElement('span');
    gc.className = 'group-count';
    gc.textContent = items.length;
    g.append(gl, gc);
    historyList.appendChild(g);
    for (const conv of items) {
      const btn = document.createElement('div');
      btn.className = 'history-item' + (conv.id === activeId ? ' active' : '');
      btn.setAttribute('role', 'button');
      btn.tabIndex = 0;
      const ico = document.createElement('span');
      ico.className = 'chat-ico';
      ico.textContent = '💬';
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = conv.title;
      title.title = conv.title;
      const dots = document.createElement('button');
      dots.className = 'dots';
      dots.textContent = '⋯';
      dots.title = 'Options';
      dots.onclick = (e) => {
        e.stopPropagation();
        showItemMenu(dots, conv);
      };
      btn.append(ico, title, dots);
      btn.onclick = () => {
        if (generating) { toast('Stop generation before switching chats'); return; }
        stopVoicePlayback();
        activeId = conv.id;
        renderAll();
        closeSidebar();
      };
      btn.onkeydown = (e) => { if (e.key === 'Enter') btn.click(); };
      historyList.appendChild(btn);
    }
  }
}

function showItemMenu(anchor, conv) {
  document.querySelectorAll('.item-menu').forEach((m) => m.remove());
  const menu = document.createElement('div');
  menu.className = 'item-menu';
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
  menu.style.left = `${Math.min(rect.left, window.innerWidth - 160)}px`;

  const rename = document.createElement('button');
  rename.textContent = '✏ Rename';
  rename.onclick = () => {
    menu.remove();
    const next = prompt('Rename conversation', conv.title);
    if (next && next.trim()) {
      conv.title = next.trim().slice(0, 80);
      conv.updatedAt = new Date().toISOString();
      persist();
      renderHistory();
    }
  };
  const del = document.createElement('button');
  del.textContent = '🗑 Delete';
  del.className = 'danger';
  del.onclick = () => {
    menu.remove();
    if (!confirm(`Delete "${conv.title}"?`)) return;
    conversations = conversations.filter((c) => c.id !== conv.id);
    if (activeId === conv.id) activeId = conversations[0]?.id || null;
    persist();
    renderAll();
    toast('Conversation deleted');
  };
  menu.append(rename, del);
  document.body.appendChild(menu);
  const close = (e) => {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); }
  };
  setTimeout(() => document.addEventListener('click', close), 0);
}

function newChat() {
  if (generating) { toast('Stop generation before starting a new chat'); return; }
  const conv = createConversation();
  conversations.unshift(conv);
  activeId = conv.id;
  persist();
  renderAll();
  input.focus();
  closeSidebar();
}

// ============ MESSAGES ============
function setEmptyVisible() {
  const conv = activeConversation();
  const isEmpty = !conv || conv.messages.length === 0;
  emptyState.style.display = isEmpty ? '' : 'none';
}

function scrollToBottom(smooth = false) {
  chatScroll.scrollTo({ top: chatScroll.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

function copyText(text, label = 'Copied ✓') {
  navigator.clipboard.writeText(text).then(() => toast(label)).catch(() => toast('Copy failed'));
}

function renderMessages() {
  messagesEl.innerHTML = '';
  const conv = activeConversation();
  setEmptyVisible();
  if (!conv) return;
  for (const msg of conv.messages) {
    messagesEl.appendChild(msg.role === 'user' ? userNode(conv, msg) : assistantNode(conv, msg));
  }
  highlightAll(messagesEl);
  scrollToBottom();
}

function userNode(conv, msg) {
  const wrap = document.createElement('div');
  wrap.className = 'msg user';
  wrap.dataset.msgId = msg.id;
  wrap.innerHTML = `<div class="msg-body"><div class="msg-content"></div><div class="msg-actions"></div></div>`;
  wrap.querySelector('.msg-content').textContent = msg.content;
  const actions = wrap.querySelector('.msg-actions');
  const edit = document.createElement('button');
  edit.className = 'mini-btn';
  edit.textContent = '✏ Edit';
  edit.onclick = () => {
    if (generating) { toast('Stop generation first'); return; }
    const next = prompt('Edit message', msg.content);
    if (next && next.trim() && next !== msg.content) {
      // Truncate conversation at this message and resend (regenerate from edit)
      const idx = conv.messages.findIndex((m) => m.id === msg.id);
      conv.messages = conv.messages.slice(0, idx);
      conv.updatedAt = new Date().toISOString();
      persist();
      sendUserMessage(next.trim(), conv);
    }
  };
  const copy = document.createElement('button');
  copy.className = 'mini-btn';
  copy.textContent = '⧉ Copy';
  copy.onclick = () => copyText(msg.content);
  actions.append(edit, copy);
  return wrap;
}

function assistantNode(conv, msg) {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  wrap.dataset.msgId = msg.id;
  const body = document.createElement('div');
  body.className = 'msg-body';
  const content = document.createElement('div');
  content.className = 'msg-content';
  content.innerHTML = renderMarkdown(msg.content);
  enhanceCodeBlocks(body, toast);
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  const copy = document.createElement('button');
  copy.className = 'mini-btn';
  copy.textContent = '⧉ Copy';
  copy.onclick = () => copyText(msg.content);
  const regen = document.createElement('button');
  regen.className = 'mini-btn';
  regen.textContent = '↻ Regenerate';
  regen.onclick = () => regenerateFrom(conv, msg);
  actions.append(copy, regen);
  const read = document.createElement('button');
  read.className = 'mini-btn speak-btn';
  read.dataset.speakId = msg.id;
  refreshSpeakButton(read);
  read.onclick = () => toggleSpeak(msg, read);
  actions.append(read);
  // Persisted reasoning summary ("Thought for Ns" — expandable steps)
  let thoughtEl = null;
  if (msg.thought && (msg.thought.seconds >= 1 || (msg.thought.steps || []).length > 1)) {
    const t = createThinking({
      status: 'done',
      elapsedSeconds: msg.thought.seconds,
      steps: msg.thought.steps || [],
    });
    thoughtEl = t.el;
  }
  // Compact, expandable Sources for connected-app answers (§18)
  let appSrcEl = null;
  if (Array.isArray(msg.appSources) && msg.appSources.length) {
    const det = document.createElement('details');
    det.className = 'app-sources';
    const sum = document.createElement('summary');
    sum.className = 'app-sources-summary';
    sum.textContent = `Sources — ${msg.appSources.map((s) => `${s.icon || ''} ${s.app} · ${s.count} ${s.unit || ''}`).join('   ·   ')}`;
    const groups = document.createElement('div');
    groups.className = 'app-sources-groups';
    msg.appSources.forEach((s) => {
      const g = document.createElement('div');
      g.className = 'as-group';
      const head = document.createElement('div');
      head.className = 'as-group-head';
      head.textContent = `${s.icon || ''} ${s.app} — ${s.count} ${s.unit || 'items'}`;
      g.appendChild(head);
      const ul = document.createElement('ul');
      (s.items || []).slice(0, 5).forEach((it) => {
        const li = document.createElement('li');
        li.textContent = it.meta ? `${it.title} — ${it.meta}` : it.title;
        li.title = it.title;
        ul.appendChild(li);
      });
      g.appendChild(ul);
      groups.appendChild(g);
    });
    det.append(sum, groups);
    appSrcEl = det;
  }
  let sourcesEl = null;
  if (Array.isArray(msg.sources) && msg.sources.length) {
    const src = document.createElement('div');
    src.className = 'sources';
    const label = document.createElement('span');
    label.className = 'sources-label';
    label.textContent = '🌐 Sources:';
    src.appendChild(label);
    msg.sources.slice(0, 5).forEach((s, i) => {
      const a = document.createElement('a');
      a.href = s.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = `[${i + 1}] ${s.title}`;
      a.title = s.url;
      src.appendChild(a);
    });
    sourcesEl = src;
  }
  if (thoughtEl) body.appendChild(thoughtEl);
  body.append(content, actions);
  if (appSrcEl) body.appendChild(appSrcEl);
  if (sourcesEl) body.appendChild(sourcesEl);
  wrap.append(body);
  return wrap;
}

function errorNode(text, hint) {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  wrap.innerHTML = `<div class="msg-body"></div>`;
  const box = document.createElement('div');
  box.className = 'msg-error';
  box.innerHTML = `<strong></strong><br/><small></small>`;
  box.querySelector('strong').textContent = text;
  box.querySelector('small').textContent = hint || '';
  wrap.querySelector('.msg-body').appendChild(box);
  return wrap;
}

// ============ SEND / STREAM ============
function setGenerating(on) {
  generating = on;
  sendBtn.hidden = on;
  stopBtn.hidden = !on;
  sendBtn.disabled = on || !input.value.trim();
}

function apiMessages(conv) {
  // Send full history (roles preserved), capped to last 40 messages
  return conv.messages.slice(-40).map((m) => ({ role: m.role, content: m.content }));
}

function buildWebContext(sources, pages = [], question = '') {
  // Brave snippets are noisy (breadcrumb trails, "7 weeks ago" dates) —
  // clean them so the model reads sentences, not link soup.
  const clean = (t) =>
    String(t || '')
      .replace(/^[^\s]*(\.com|\.org|\.in|\.net|\.io|\.gov|\.edu)(\s*›\s*[^\s]+)*/i, ' ')
      .replace(/[\u203a\u2039›«]+/g, ' ')
      .replace(/\s*[-–—]\s*\d+\s*(week|month|day|hour|year)s?\s*ago\s*/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const parts = [
    'REFERENCE MATERIAL from the web is provided below between <web> tags.',
    'Rules: (1) Use it to answer the user briefly and directly, in your own words.',
    '(2) NEVER print or repeat the reference material, the <web> tags, or the === markers — that is source data, not your answer.',
    '(3) Cite sources inline like [1], [2] matching the numbering. If the material is irrelevant, ignore it and answer from your own knowledge.\n',
    '<web>',
  ];
  sources.slice(0, 5).forEach((s, i) => {
    const snip = clean(s.snippet).slice(0, 300);
    parts.push(`[${i + 1}] ${s.title} — ${snip}`);
  });
  pages.forEach((p, i) => {
    parts.push(`--- full text of [${i + 1}] ${p.title} ---`, p.text.slice(0, 3000));
  });
  parts.push('</web>');
  // Recency prompting: small models follow an instruction placed right
  // before "Answer:" far better than one at the top of a long context.
  if (question) parts.push('', `Question: ${question}`, 'Answer:');
  return parts.join('\n').slice(0, 12000);
}

/** ERP/SAP plugin data → system context with the same never-print rules. */
function buildSalesContext({ provider, data }, question = '') {
  const parts = [
    `SALES DATA fetched live from ${provider} is provided below between <erp> tags.`,
    'Rules: (1) Answer the question using ONLY this data and quote exact figures.',
    '(2) NEVER print or repeat the raw data, the <erp> tags or the === markers — that is source data, not your answer.',
    '(3) If the answer is not contained in the data, say so plainly — never invent numbers.\n',
    '<erp>',
    String(data || '').slice(0, 10000),
    '</erp>',
  ];
  // Recency prompting: small models follow instructions placed right before "Answer:".
  if (question) parts.push('', `Question: ${question}`, 'Answer:');
  return parts.join('\n').slice(0, 12000);
}

async function sendUserMessage(text, convOverride) {
  const conv = convOverride || activeConversation() || (() => {
    const c = createConversation();
    conversations.unshift(c);
    activeId = c.id;
    return c;
  })();
  const clean = text.trim();
  if (!clean || generating) return;
  stopVoicePlayback();

  if (conv.messages.length === 0) {
    conv.title = autoTitleFrom(clean);
  }
  const userMsg = { id: uid('msg'), conversationId: conv.id, role: 'user', content: clean, createdAt: new Date().toISOString() };
  conv.messages.push(userMsg);
  conv.updatedAt = new Date().toISOString();
  persist();
  input.value = '';
  autoGrow();
  setGenerating(false);
  renderAll();

  await generateReply(conv);
}

async function generateReply(conv, { regenerateBase = null } = {}) {
  const history = regenerateBase || apiMessages(conv);
  setGenerating(true);

  const assistantMsg = {
    id: uid('msg'), conversationId: conv.id, role: 'assistant',
    content: '', createdAt: new Date().toISOString(),
  };

  // "AI thinking" row: live from send until the first token, then it collapses
  // into an expandable "Thought for Ns" row that is persisted with the message.
  const thinking = createThinking({
    status: 'thinking',
    statusLabels: ['Reading your message', 'Gathering context', 'Checking the web', 'Drafting a reply'],
    steps: [],
    onCancel: () => { if (abortController) abortController.abort(); },
  });
  messagesEl.appendChild(thinking.el);
  scrollToBottom();
  abortController = new AbortController();
  const addStep = (id, text) => {
    thinking.update({ steps: [...thinking.snapshot().steps, { id, text }] });
  };
  // Flip a step's text in place (e.g. "● Browser opening…" → "✓ Chrome is open").
  const replaceStep = (id, text) => {
    thinking.update({
      steps: thinking.snapshot().steps.map((s) => (s.id === id ? { ...s, text } : s)),
    });
  };
  const recordThought = () => {
    const snap = thinking.snapshot();
    if (snap.seconds >= 1 || snap.steps.length > 1) assistantMsg.thought = snap;
  };

  // Optional agent persona (sidebar "AI Agents") → ephemeral system message.
  let sendHistory = history;
  const agent = agentById(conv.agent || 'zara');
  if (agent.persona) {
    sendHistory = [{ role: 'system', content: agent.persona }, ...history];
  }

  // Sales AI agent → pull live data from the connected SAP/ERP plugin and
  // hand it to the model as context (same recency-prompt pattern as web).
  if (conv.agent === 'sales') {
    const lastUser = [...conv.messages].reverse().find((m) => m.role === 'user');
    if (lastUser) {
      addStep('sales', 'Fetching live data from your ERP…');
      try {
        const q = await salesQuery(lastUser.content);
        addStep('salesdata', `Loaded data from ${q.provider}`);
        sendHistory = [{ role: 'system', content: buildSalesContext(q, lastUser.content) }, ...sendHistory];
      } catch (err) {
        addStep('saleserr', 'ERP plugin unavailable');
        toast(err.hint ? `${err.message} — ${err.hint}` : err.message);
      }
    }
  }

  // Zara Orchestrator — central intent routing. Detects YouTube/visual
  // workflows ("play X on YouTube", "search YouTube for X", "pause the video",
  // "click the first video") and runs them through the controlled visual loop
  // (open → navigate → identify target → click → verify playback), one action
  // at a time, stopping honestly if the target can't be found. For everything
  // else it returns a classification and the existing browser/computer blocks
  // below handle it — no duplicate routing, no rewrite of working systems.
  let orchestratorRan = false;
  if (!regenerateBase) {
    const orchUser = [...conv.messages].reverse().find((m) => m.role === 'user');
    if (orchUser) {
      try {
        const cls = await classifyOrchestrator(orchUser.content);
        if (cls.intent === 'youtube') {
          orchestratorRan = true;
          addStep('ytwork', '🎬 Handling that…');
          const run = await runOrchestrator(orchUser.content);
          const steps = run.steps || [];
          steps.forEach((s, i) => {
            if (i === 0) replaceStep('ytwork', s.text);
            else addStep(s.id || `ytstep${i}`, s.text);
          });
          if (!steps.length) replaceStep('ytwork', '✓ Done.');
          if (run.context) sendHistory = [{ role: 'system', content: run.context }, ...sendHistory];
          if (run.notice) {
            addStep('ytnotice', run.notice);
            toast(run.notice);
          }
        }
      } catch (err) {
        // Orchestrator unavailable — fall through to the normal pipeline so the
        // message is still handled (browser / computer / LLM).
        console.warn('orchestrator classify failed', err);
      }
    }
  }

  // Local browser automation ("Open Chrome and search ind vs wi", "go to
  // aculyze.in", "read this page", "go back"). Runs BEFORE the app tools so a
  // browser command is never hijacked by an integration router, and skips
  // web/apps for that message. Only explicitly implemented operations exist —
  // the model can never execute arbitrary code, shell or Python.
  let browserRan = false;
  if (!regenerateBase && !orchestratorRan) {
    const browserUser = [...conv.messages].reverse().find((m) => m.role === 'user');
    if (browserUser) {
      try {
        const b = await resolveBrowser(browserUser.content);
        if (b.actions && b.actions.length) {
          browserRan = true;
          addStep('brwork', '🌐 Doing your browser request…');
          let exec = null;
          if (b.sensitive) {
            // Sensitive actions (buy/send/submit/delete/password) always
            // require an explicit confirmation before anything is run.
            const ok = await showAppConfirm({
              title: b.sensitive.title || 'Run this browser action?',
              detail: b.sensitive.detail || '⚠ This looks sensitive — Zara needs your confirmation first.',
              preview: b.sensitive.preview || b.actions.map((a) => a.label),
              okLabel: b.sensitive.verb || 'Allow & run',
              cancelLabel: 'Cancel',
            });
            if (ok) {
              exec = await executeBrowser({ message: browserUser.content, confirm: true });
            } else {
              replaceStep('brwork', '🚫 Browser action cancelled — nothing was run');
              toast('Browser action cancelled');
              sendHistory = [{
                role: 'system',
                content: 'The user DECLINED a local browser action. Say briefly that nothing was run. Never claim any browser action happened.',
              }, ...sendHistory];
            }
          } else {
            exec = await executeBrowser({ message: browserUser.content });
          }
          if (exec) {
            const steps = exec.steps || [];
            steps.forEach((s, i) => {
              if (i === 0) replaceStep('brwork', s.text);
              else addStep(s.id || `brstep${i}`, s.text);
            });
            if (!steps.length) replaceStep('brwork', '✓ Browser request handled.');
            if (exec.context) sendHistory = [{ role: 'system', content: exec.context }, ...sendHistory];
            if (exec.notice) {
              addStep('brnotice', exec.notice);
              toast(exec.notice);
            }
          }
        } else if (b.notice) {
          // Sensitive-sounding phrase with no browsing action ("Send this email").
          addStep('brnotice', b.notice);
          toast(b.notice);
          sendHistory = [{ role: 'system', content: `NOTE FOR THE ANSWER: ${b.notice}` }, ...sendHistory];
        }
      } catch (err) {
        addStep('brerr', err.message || 'Browser automation unavailable');
        toast(err.message || 'Browser automation is unavailable');
        sendHistory = [{
          role: 'system',
          content: 'The local browser automation service is unavailable. If the user asked for a browser action, tell them briefly it could not run.',
        }, ...sendHistory];
      }
    }
  }

  // Local computer control ("Open VS Code", "close the calculator", "switch to
  // Notepad", "show the desktop", "what apps are installed?"). Runs AFTER the
  // browser router, so browser commands stay with browser automation. Only the
  // eight explicitly implemented Level-1 operations exist — the model can
  // never construct OS commands, and there is no shell execution at all.
  let computerRan = false;
  let directReply = null; // deterministic app answer, rendered verbatim
  if (!regenerateBase && !browserRan && !orchestratorRan) {
    const compUser = [...conv.messages].reverse().find((m) => m.role === 'user');
    if (compUser) {
      try {
        const cplan = await resolveComputer(compUser.content);
        if (cplan.actions && cplan.actions.length) {
          computerRan = true;
          addStep('cpwork', '🖥️ Doing that on your computer…');
          const exec = await executeComputer({ message: compUser.content });
          const steps = exec.steps || [];
          steps.forEach((s, i) => {
            if (i === 0) replaceStep('cpwork', s.text);
            else addStep(s.id || `cpstep${i}`, s.text);
          });
          if (!steps.length) replaceStep('cpwork', '✓ Done.');
          if (exec.direct && exec.direct.text) directReply = exec.direct.text;
          else if (exec.context) sendHistory = [{ role: 'system', content: exec.context }, ...sendHistory];
          if (exec.notice) {
            addStep('cpnotice', exec.notice);
            toast(exec.notice);
          }
        } else if (cplan.notice) {
          // Higher-risk intent (install/delete/settings/…) — answered honestly,
          // never executed.
          addStep('cpnotice', cplan.notice);
          toast(cplan.notice);
          sendHistory = [{ role: 'system', content: `NOTE FOR THE ANSWER: ${cplan.notice}` }, ...sendHistory];
        }
      } catch (err) {
        addStep('cperr', err.message || 'Computer control unavailable');
        sendHistory = [{
          role: 'system',
          content: 'The local computer-control agent is unavailable. If the user asked to open or control an app, tell them briefly it could not run.',
        }, ...sendHistory];
      }
    }
  }

  // Connected apps (Gmail, Calendar, Teams, Drive, LMS…) → the backend plans
  // and runs the right tools, returning display steps + a ready context.
  // Write actions (send email / create event / post message) come back as a
  // confirmation the user must approve first — never silent.
  let appSources = [];
  if (!regenerateBase) await appsReady.catch(() => {});
  if (appsConnectedIds().length && !regenerateBase && !browserRan && !computerRan && !orchestratorRan) {
    const lastUser = [...conv.messages].reverse().find((m) => m.role === 'user');
    if (lastUser) {
      addStep('apps', 'Checking your connected apps…');
      try {
        const r = await resolveIntegrations(lastUser.content);
        if (r.confirm) {
          const ok = await showAppConfirm({
            title: r.confirm.title,
            detail: r.confirm.detail,
            preview: r.confirm.preview,
            okLabel: r.confirm.verb || 'Confirm',
            cancelLabel: 'Cancel',
          });
          if (!ok) {
            addStep('appcancel', 'Action cancelled — nothing was sent');
            toast('Action cancelled');
            sendHistory = [{
              role: 'system',
              content: 'The user CANCELLED the action they were asked to confirm. Tell them briefly that nothing was sent or created. Do not perform the action.',
            }, ...sendHistory];
          } else {
            addStep('apprun', `${r.confirm.icon} ${r.confirm.appName} — ${r.confirm.verb}…`);
            const ex = await executeIntegration({ tool: r.confirm.tool, args: r.confirm.args, confirm: true });
            if (ex.step) addStep(ex.step.id, ex.step.text);
            if (ex.context) sendHistory = [{ role: 'system', content: ex.context }, ...sendHistory];
            if (ex.sources) appSources = ex.sources;
            toast(`${r.confirm.icon} ${ex.summary || 'Done'}`);
          }
        } else if (r.notice) {
          addStep('appsnote', r.notice);
          toast(r.notice);
          sendHistory = [{
            role: 'system',
            content: `NOTE FOR THE ANSWER: ${r.notice} If it matters to the user's request, mention it naturally in your reply.`,
          }, ...sendHistory];
        } else if (r.context) {
          (r.steps || []).forEach((s, i) => addStep(s.id || `appstep${i}`, s.text));
          sendHistory = [{ role: 'system', content: r.context }, ...sendHistory];
          appSources = r.sources || [];
        } else {
          addStep('appsnone', 'No connected apps needed for this');
        }
      } catch (err) {
        addStep('appserr', err.message || 'Connected apps unavailable');
        toast(err.message || 'Connected apps are unavailable');
      }
    }
  }

  // Optional web grounding: search the last user message, send results as
  // an ephemeral system message (never stored in the conversation).
  let webSources = [];
  if (settings.webSearch && !regenerateBase && !browserRan && !computerRan && !orchestratorRan) {
    const lastUser = [...conv.messages].reverse().find((m) => m.role === 'user');
    if (lastUser) {
      const shortQuery = lastUser.content.length > 60 ? `${lastUser.content.slice(0, 60)}…` : lastUser.content;
      addStep('search', `Searching the web for "${shortQuery}"`);
      try {
        const found = await searchWeb(lastUser.content, 5);
        webSources = found.results || [];
        if (webSources.length) {
          addStep('found', `Found ${webSources.length} relevant sources`);
          // Read the top 2 pages live so the model gets real content,
          // not just one-line snippets.
          toast('🌐 Searching & reading pages…');
          const pages = [];
          for (const s of webSources.slice(0, 2)) {
            let host = s.url;
            try { host = new URL(s.url).hostname.replace(/^www\./, ''); } catch { /* keep raw url */ }
            addStep(`page:${s.url}`, `Reading ${host}`);
            try {
              const p = await fetchPageText(s.url);
              if (p && p.text && p.text.trim().length > 200) pages.push(p);
            } catch { /* skip unreadable pages */ }
          }
          if (pages.length) toast(`🌐 Using ${webSources.length} sources (${pages.length} pages read)`);
          else toast(`🌐 Using ${webSources.length} web sources`);
          sendHistory = [{ role: 'system', content: buildWebContext(webSources, pages, lastUser.content) }, ...sendHistory];
        }
      } catch (err) {
        toast(err.message || 'Web search failed — answering without it');
      }
    }
  }

  // Deterministic computer answer ("Do I have VS Code?", "What apps are
  // installed?") — render it verbatim instead of asking the model, so it can
  // never be hallucinated and works fully offline.
  if (directReply) {
    assistantMsg.content = directReply;
    thinking.update({ status: 'done' });
    recordThought();
    thinking.destroy();
    conv.messages.push(assistantMsg);
    conv.updatedAt = new Date().toISOString();
    persist();
    messagesEl.appendChild(assistantNode(conv, assistantMsg));
    highlightAll(messagesEl);
    scrollToBottom();
    if (settings.voiceReplies) speakAIOrFallback(assistantMsg);
    setGenerating(false);
    abortController = null;
    renderHistory();
    return;
  }

  // Cancelled via the thinking row's Stop before the stream started?
  if (abortController.signal.aborted) {
    thinking.destroy();
    abortController = null;
    setGenerating(false);
    renderHistory();
    toast('Generation stopped');
    return;
  }
  addStep('draft', 'Drafting a reply');

  let streamWrap = null;

  try {
    // Create live streaming bubble
    streamWrap = document.createElement('div');
    streamWrap.className = 'msg assistant';
    streamWrap.innerHTML = `<div class="msg-body"><div class="msg-content"></div></div>`;
    messagesEl.appendChild(streamWrap);
    const contentEl = streamWrap.querySelector('.msg-content');

    const result = await streamChat({
      messages: sendHistory,
      model: settings.model || undefined,
      temperature: Number(settings.temperature ?? 0.7),
      max_tokens: Number(settings.maxTokens ?? 2048),
      signal: abortController.signal,
      onToken: (tok, full) => {
        // First token → thinking collapses into the "Thought for Ns" row.
        if (assistantMsg.content === '' && full) thinking.update({ status: 'streaming' });
        assistantMsg.content = full;
        contentEl.innerHTML = renderMarkdown(full);
        scrollToBottom();
      },
    });

    assistantMsg.content = result.content;
    if (webSources.length) assistantMsg.sources = webSources;
    if (appSources.length) assistantMsg.appSources = appSources;
    if (!assistantMsg.content) {
      streamWrap.remove();
      messagesEl.appendChild(errorNode('The model returned no text.', 'Try again with a different prompt.'));
    } else {
      thinking.update({ status: 'done' });
      recordThought();
      thinking.destroy();
      conv.messages.push(assistantMsg);
      conv.updatedAt = new Date().toISOString();
      persist();
      streamWrap.remove();
      messagesEl.appendChild(assistantNode(conv, assistantMsg));
      highlightAll(messagesEl);
      scrollToBottom();
      // Auto-speak: Zara talks back (OmniVoice when the AI voice is online,
      // browser speechSynthesis as the fallback).
      if (settings.voiceReplies) speakAIOrFallback(assistantMsg);
    }
  } catch (err) {
    thinking.destroy();
    if (abortController?.signal.aborted) {
      // Preserve partial response
      if (assistantMsg.content) {
        recordThought();
        if (webSources.length) assistantMsg.sources = webSources;
        if (appSources.length) assistantMsg.appSources = appSources;
        conv.messages.push(assistantMsg);
        conv.updatedAt = new Date().toISOString();
        persist();
        streamWrap?.remove();
        messagesEl.appendChild(assistantNode(conv, assistantMsg));
        toast('Generation stopped — partial response kept');
      } else {
        streamWrap?.remove();
        messagesEl.appendChild(errorNode('Generation stopped.', 'Partial response was empty.'));
      }
    } else {
      streamWrap?.remove();
      const friendly = err.message || 'Something went wrong.';
      messagesEl.appendChild(errorNode(friendly, err.hint || 'Please try again.'));
    }
  } finally {
    thinking.destroy();
    setGenerating(false);
    abortController = null;
    renderHistory();
    scrollToBottom();
  }
}

async function regenerateFrom(conv, assistantMsg) {
  if (generating) { toast('Stop generation first'); return; }
  stopVoicePlayback();
  const idx = conv.messages.findIndex((m) => m.id === assistantMsg.id);
  if (idx <= 0) return;
  // Remove the assistant message (and anything after), keep history up to prior user msg
  conv.messages = conv.messages.slice(0, idx);
  conv.updatedAt = new Date().toISOString();
  persist();
  renderMessages();
  await generateReply(conv);
}

// ============ VOICE (STT dictation + TTS read-aloud) ============
let speakingId = null;
let dictListener = null;
let dictating = false;
let dictBase = '';
let aiVoice = { enabled: false, online: false, model: null };
let aiAudio = null; // current <audio> playing OmniVoice output
const micBtn = $('#micBtn');

async function refreshVoiceStatus() {
  try {
    const s = await voiceStatus();
    aiVoice = { enabled: !!s.enabled, online: !!s.online, model: s.model || null };
  } catch { /* offline — browser fallback stands */ }
  const line = $('#voiceStatusLine');
  if (line) {
    const online = aiVoice.enabled && aiVoice.online;
    line.textContent = online
      ? `● Available — ${aiVoice.model || 'OmniVoice'}`
      : aiVoice.enabled ? '○ Offline — browser fallback' : '○ Offline — browser fallback';
    line.classList.remove('ok', 'down');
    line.classList.add(online ? 'ok' : 'down');
  }
}

function refreshSpeakButton(btn) {
  const activeAi = speakingId !== null && btn.dataset.speakId === speakingId && !!aiAudio && !aiAudio.paused;
  const activeBrowser = speakingId !== null && btn.dataset.speakId === speakingId && isSpeaking();
  btn.textContent = activeAi || activeBrowser ? '⏹ Stop' : aiVoice.online ? '🔊 Read aloud' : '🔊 Read aloud';
}

function refreshAllSpeakButtons() {
  document.querySelectorAll('.speak-btn').forEach(refreshSpeakButton);
}

function stopVoicePlayback() {
  stopSpeaking(); // browser TTS
  if (aiAudio) {
    try { aiAudio.pause(); } catch { /* noop */ }
    try { URL.revokeObjectURL(aiAudio.src); } catch { /* noop */ }
    aiAudio = null;
  }
  speakingId = null;
  refreshAllSpeakButtons();
}

/** Speak a reply with Zara's AI voice (OmniVoice); falls back to browser TTS. */
async function speakAIOrFallback(msg, btn) {
  speakingId = msg.id;
  refreshAllSpeakButtons();
  const finish = () => {
    speakingId = null;
    refreshAllSpeakButtons();
  };
  if (aiVoice.online) {
    toast('🔊 AI voice preparing — can take ~30s on CPU…');
    try {
      const url = await synthesizeVoice(msg.content);
      if (speakingId !== msg.id) { // stopped while synthesizing
        URL.revokeObjectURL(url);
        return;
      }
      const audio = new Audio(url);
      aiAudio = audio;
      audio.onended = () => {
        if (aiAudio === audio) aiAudio = null;
        URL.revokeObjectURL(url);
        finish();
      };
      audio.onerror = () => {
        if (aiAudio === audio) aiAudio = null;
        finish();
        speak(msg.content, { onEnd: finish }); // fallback if audio breaks
      };
      await audio.play();
      return;
    } catch (err) {
      aiAudio = null;
      if (!err || err.name !== 'AbortError') {
        // AI voice failed — quietly fall back to browser voice
        const ok = speak(msg.content, { onEnd: finish });
        if (!ok) { finish(); toast('Voice unavailable'); }
        return;
      }
      finish();
      return;
    }
  }
  const ok = ttsSupported() ? speak(msg.content, { onEnd: finish }) : false;
  if (!ok) { finish(); toast('Voice is not available in this browser'); }
}

function toggleSpeak(msg, btn) {
  const isSameActive = speakingId === msg.id && (isSpeaking() || (aiAudio && !aiAudio.paused));
  if (isSameActive) {
    stopVoicePlayback();
    return;
  }
  stopVoicePlayback();
  speakingId = msg.id;
  refreshAllSpeakButtons();
  speakAIOrFallback(msg, btn);
}

// ============ VOICE MODE (hands-free conversation loop) ============
// Mic listens → message sent → Zara speaks the reply → mic listens again.
let voiceModeOn = false;
let vmState = 'off'; // off | listening | thinking | speaking
let vmListener = null;
const voicePanel = $('#voicePanel');
const voiceModeBtn = $('#voiceModeBtn');
const voiceStateEl = $('#voiceState');
const voiceTranscriptEl = $('#voiceTranscript');

function vmSetState(state, transcript) {
  vmState = state;
  voicePanel.dataset.state = state;
  voiceStateEl.textContent =
    state === 'listening' ? 'Listening… speak to Zara'
    : state === 'thinking' ? 'Zara is thinking…'
    : 'Zara is speaking…';
  if (transcript !== undefined) voiceTranscriptEl.textContent = transcript;
}

function vmListen() {
  if (!voiceModeOn || vmState !== 'listening' || vmListener) return;
  vmListener = createListener({
    onInterim: (t) => { voiceTranscriptEl.textContent = t; },
    onFinal: (t) => { vmHandleSpeech(t); },
    onEnd: () => {
      // Silence with no final result → keep listening (the loop continues).
      vmListener = null;
      if (voiceModeOn && vmState === 'listening') vmListen();
    },
    onError: (code) => {
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        toast('🎤 Microphone blocked — allow mic access and try again');
        stopVoiceMode();
      } else if (code === 'audio-capture') {
        toast('No microphone found');
        stopVoiceMode();
      } else if (code === 'network') {
        toast('Speech service offline — check your connection');
      }
      // 'no-speech' / 'aborted' → onEnd handles the restart
    },
  });
  if (!vmListener) {
    toast('Voice mode needs Chrome or Edge');
    stopVoiceMode();
    return;
  }
  vmListener.start();
}

async function vmHandleSpeech(text) {
  const said = String(text || '').trim();
  if (!voiceModeOn) return;
  if (!said) return; // onEnd will restart listening
  // Turn ends here: stop the mic while we think and speak.
  if (vmListener) { vmListener.stop(); vmListener = null; }
  vmSetState('thinking', said);

  // Suppress the settings-based auto read-aloud so we don't double-speak.
  const prevVoiceReplies = settings.voiceReplies;
  settings.voiceReplies = false;
  try {
    await sendUserMessage(said);
  } finally {
    settings.voiceReplies = prevVoiceReplies;
  }
  if (!voiceModeOn) return;

  const conv = activeConversation();
  const last = conv ? [...conv.messages].reverse().find((m) => m.role === 'assistant') : null;
  const reply = last && last.content ? last.content : 'Sorry, I could not answer that.';
  vmSetState('speaking', said);

  const backToListening = () => {
    if (!voiceModeOn) return;
    vmSetState('listening', '');
    vmListen();
  };
  const ok = speak(reply, { onEnd: backToListening, onError: backToListening });
  if (!ok) backToListening();
}

function startVoiceMode() {
  if (!sttSupported()) {
    toast('Voice mode needs Chrome or Edge');
    return;
  }
  if (generating) {
    toast('Stop generation first');
    return;
  }
  voiceModeOn = true;
  voiceModeBtn.classList.add('active');
  voiceModeBtn.setAttribute('aria-pressed', 'true');
  voicePanel.hidden = false;
  stopVoicePlayback(); // don't talk over Zara's voice
  if (dictating && dictListener) { dictListener.stop(); dictListener = null; setDictating(false); }
  vmSetState('listening', '');
  vmListen();
}

function stopVoiceMode() {
  voiceModeOn = false;
  voiceModeBtn.classList.remove('active');
  voiceModeBtn.setAttribute('aria-pressed', 'false');
  voicePanel.hidden = true;
  if (vmListener) { vmListener.abort(); vmListener = null; }
  stopSpeaking();
  voiceTranscriptEl.textContent = '';
  vmState = 'off';
}

voiceModeBtn.addEventListener('click', () => (voiceModeOn ? stopVoiceMode() : startVoiceMode()));
$('#voiceEndBtn').addEventListener('click', stopVoiceMode);

const MIC_ICONS = {
  mic: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>`,
  stop: `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`,
};
function setDictating(on) {
  dictating = on;
  micBtn.classList.toggle('listening', on);
  micBtn.innerHTML = on ? MIC_ICONS.stop : MIC_ICONS.mic;
  micBtn.title = on ? 'Stop dictation' : 'Voice input (dictation)';
}

micBtn.addEventListener('click', () => {
  if (voiceModeOn) {
    toast('Voice conversation is active — ✕ End it to use dictation');
    return;
  }
  if (!sttSupported()) {
    toast('Voice input needs Chrome or Edge');
    return;
  }
  if (dictating && dictListener) {
    dictListener.stop();
    return;
  }
  if (generating) {
    toast('Stop generation first');
    return;
  }
  stopVoicePlayback(); // don't dictate over Zara's voice
  dictBase = input.value;
  dictListener = createListener({
    onInterim: (t) => {
      input.value = dictBase + t;
      autoGrow();
    },
    onFinal: (t) => {
      const merged = `${dictBase}${t}`.trim();
      input.value = merged ? `${merged} ` : '';
      dictBase = input.value;
      autoGrow();
    },
    onEnd: () => setDictating(false),
    onError: (code) => {
      setDictating(false);
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        toast('Microphone blocked — allow mic access and try again');
      } else if (code === 'network') {
        toast('Dictation unavailable here — use Zara on localhost, or check connection');
      } else if (code !== 'aborted' && code !== 'no-speech') {
        toast(`Dictation error: ${code}`);
      }
    },
  });
  if (!dictListener) {
    toast('Voice input needs Chrome or Edge');
    return;
  }
  dictListener.start();
  setDictating(true);
  toast('Listening… speak now');
});

// ============ WEB SEARCH TOGGLE + EMAIL ============
const webBtn = $('#webBtn');
const emailBtn = $('#emailBtn');
const emailOverlay = $('#emailOverlay');

function syncWebButton() {
  webBtn.classList.toggle('active', !!settings.webSearch);
  webBtn.title = settings.webSearch ? 'Web search ON — answers use fresh results' : 'Answer with web search';
}

webBtn.addEventListener('click', () => {
  settings.webSearch = !settings.webSearch;
  saveSettings(settings);
  syncWebButton();
  toast(settings.webSearch ? '🌐 Web search ON' : 'Web search OFF');
});

function openEmail() {
  emailOverlay.hidden = false;
  setTimeout(() => $('#emailTo').focus(), 50);
}
function closeEmail() {
  emailOverlay.hidden = true;
}
emailBtn.addEventListener('click', openEmail);
$('#emailClose').addEventListener('click', closeEmail);
emailOverlay.addEventListener('click', (e) => { if (e.target === emailOverlay) closeEmail(); });
$('#emailFillLast').addEventListener('click', () => {
  const conv = activeConversation();
  const lastAssistant = conv ? [...conv.messages].reverse().find((m) => m.role === 'assistant' && m.content) : null;
  if (!lastAssistant) { toast('No Zara reply to use yet'); return; }
  $('#emailBody').value = lastAssistant.content;
  toast('Last reply inserted');
});
$('#emailSend').addEventListener('click', async () => {
  const to = $('#emailTo').value.trim();
  const subject = $('#emailSubject').value.trim();
  const body = $('#emailBody').value;
  if (!to || !subject || !body.trim()) { toast('Fill in To, Subject and Message'); return; }
  const btn = $('#emailSend');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    await sendEmail({ to, subject, body });
    toast('Email sent ✓');
    closeEmail();
    $('#emailTo').value = '';
    $('#emailSubject').value = '';
    $('#emailBody').value = '';
  } catch (err) {
    toast(err.hint ? `${err.message} ${err.hint}` : (err.message || 'Sending failed'));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send';
  }
});

// ============ COMPOSER ============
function autoGrow() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
  sendBtn.disabled = generating || !input.value.trim();
}

input.addEventListener('input', autoGrow);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const conv = activeConversation();
    sendUserMessage(input.value, conv);
  }
});
sendBtn.addEventListener('click', () => sendUserMessage(input.value, activeConversation()));
stopBtn.addEventListener('click', () => {
  stopVoicePlayback();
  if (abortController) abortController.abort();
});

$('#attachBtn').addEventListener('click', () => toast('Attachments coming soon'));

// Drag/drop prepared for future (no processing yet)
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files?.length) toast('Attachments coming soon — file ignored');
});

// ============ MODELS + STATUS ============
function currentModelName() {
  if (!availableModels.length) return null;
  const m = availableModels.find((x) => x.id === settings.model);
  return (m && (m.name || m.id)) || availableModels[0].name || availableModels[0].id;
}

function updateModelLabel() {
  // Keep a valid default selected, then mirror the name into the header
  // chip and the AI & Models provider card.
  if (!settings.model && availableModels[0]) {
    settings.model = availableModels[0].id;
    saveSettings(settings);
  }
  const name = currentModelName();
  const chip = $('#modelChipLabel');
  if (chip) chip.textContent = name || 'Local model';
  const card = $('#modelCardName');
  if (card) card.textContent = name || (availableModels.length ? '—' : 'No models available');
  if (statusDot.classList.contains('online') && name) statusText.textContent = name;
}

/** Update every connection-status line (provider card + detail page). */
function setConnStatus(kind, text) {
  document.querySelectorAll('.js-conn-status').forEach((el) => {
    el.textContent = text;
    el.classList.remove('ok', 'down', 'err');
    if (kind) el.classList.add(kind);
  });
}

async function refreshStatus() {
  try {
    const s = await fetchStatus();
    providerName = s.provider || 'lmstudio';
    serverUrl = s.server || '';
    const online = s.status === 'connected';
    statusDot.className = 'status-dot ' + (online ? 'online' : 'offline');
    statusText.textContent = online ? (currentModelName() || 'Local model') : 'Not connected';
    offlineBanner.hidden = online;
    setConnStatus(online ? 'ok' : 'down', online ? `● Connected${s.latencyMs != null ? ` (${s.latencyMs} ms)` : ''}` : '○ Not connected');
    const provLabel = providerName === 'lmstudio' ? 'LM Studio' : providerName;
    $('#connProvider').textContent = provLabel;
    $('#genProvider').textContent = provLabel;
    $('#aboutProvider').textContent = provLabel;
    $('#connServer').textContent = serverUrl || '—';
    return online;
  } catch {
    statusDot.className = 'status-dot offline';
    statusText.textContent = 'Not connected';
    offlineBanner.hidden = false;
    return false;
  }
}

async function refreshModels() {
  try {
    const data = await fetchModels();
    availableModels = data.models || [];
  } catch {
    availableModels = [];
  }
  updateModelLabel();
  syncSettingsForm();
}

$('#retryConnBtn').addEventListener('click', async () => {
  await refreshStatus();
  await refreshModels();
});
$('#checkConnBtn').addEventListener('click', async () => {
  setConnStatus('', '◌ Connecting…');
  await refreshStatus();
  await refreshModels();
  toast('Connection checked');
});

// ============ APPS & INTEGRATIONS ============
let appsState = { categories: [], featured: [], apps: [] };
// Resolved once the boot catalog fetch finishes; chat awaits it so a message
// sent instantly after page load still sees connected apps.
let appsReady = Promise.resolve();
const appsConnectedIds = () => appsState.apps.filter((a) => a.status === 'connected').map((a) => a.id);
const appById = (id) => appsState.apps.find((a) => a.id === id) || null;

const APP_ENV_HINTS = {
  google: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET',
  microsoft: 'MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET',
  canva: 'CANVA_CLIENT_ID and CANVA_CLIENT_SECRET',
};

async function refreshApps({ render = true } = {}) {
  try {
    const data = await listIntegrations();
    appsState = { categories: data.categories || [], featured: data.featured || [], apps: data.apps || [] };
    // Aculyze Sales AI mirrors the existing Sales plugin connection.
    const sales = appById('aculyze-sales');
    if (sales) {
      try {
        const s = await salesStatus();
        sales.status = s.connected ? 'connected' : 'not_connected';
        sales.account = s.providerName || '';
        sales.sync = s.connected ? (s.inUse ? 'In use' : 'Paused') : '';
      } catch { /* keep catalog status */ }
    }
    if (render) renderApps();
  } catch { /* offline — catalog keeps its defaults */ }
}

function appSearchText(a) {
  const cat = appsState.categories.find((c) => c.id === a.category);
  const extra = { onedrive: 'microsoft', sharepoint: 'microsoft', gmail: 'google mail', gcal: 'google', gdrive: 'google', gdocs: 'google docs', gsheets: 'google', 'aculyze-sales': 'sap erp sales intelligence' }[a.id] || '';
  return `${a.name} ${a.desc} ${cat ? cat.label : a.category} ${extra}`.toLowerCase();
}

function appPill(a) {
  const p = document.createElement('span');
  p.className = 'app-pill';
  const map = {
    connected: ['ok', '● Connected'],
    not_connected: ['off', '○ Not connected'],
    reauth: ['warn', '⚠ Needs reconnect'],
    not_configured: ['off', '○ Not configured'],
    coming_soon: ['soon', 'Coming soon'],
  };
  const [kind, text] = map[a.status] || map.not_connected;
  p.classList.add(kind);
  p.textContent = text;
  return p;
}

function appCardNode(a) {
  const card = document.createElement('article');
  card.className = 'app-card' + (a.state === 'soon' ? ' soon' : '');
  card.dataset.app = a.id;

  const ic = document.createElement('div');
  ic.className = 'app-ic';
  ic.setAttribute('aria-hidden', 'true');
  ic.textContent = a.icon;

  const main = document.createElement('div');
  main.className = 'app-main';
  const nameRow = document.createElement('div');
  nameRow.className = 'app-name-row';
  const name = document.createElement('strong');
  name.textContent = a.name;
  nameRow.append(name, appPill(a));

  const desc = document.createElement('p');
  desc.className = 'app-desc';
  desc.textContent = a.desc;

  const account = document.createElement('p');
  account.className = 'app-account';
  account.textContent = a.status === 'connected' ? (a.account || (a.sync ? `Sync · ${a.sync}` : 'Connected')) : '';
  account.hidden = account.textContent === '';

  main.append(nameRow, desc, account);

  const actions = document.createElement('div');
  actions.className = 'app-actions';
  if (a.link) {
    const manage = document.createElement('button');
    manage.className = 'ghost-btn sm';
    manage.textContent = 'Manage';
    manage.onclick = () => showSettingsPage(a.link);
    actions.appendChild(manage);
  } else if (a.state === 'soon') {
    // "Coming soon" — deliberately no buttons (never fake an integration).
  } else if (a.status === 'connected' || a.status === 'reauth') {
    const manage = document.createElement('button');
    manage.className = 'ghost-btn sm';
    manage.textContent = 'Manage';
    manage.onclick = () => openAppDetail(a.id);
    const disc = document.createElement('button');
    disc.className = 'ghost-btn sm danger';
    disc.textContent = 'Disconnect';
    disc.onclick = () => confirmDisconnect(appById(a.id) || a);
    actions.append(manage, disc);
  } else {
    const connect = document.createElement('button');
    connect.className = 'primary-btn sm';
    connect.textContent = a.status === 'reauth' ? 'Reconnect' : 'Connect';
    connect.onclick = () => startConnect(a);
    actions.appendChild(connect);
  }

  card.append(ic, main, actions);
  card.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    if (a.link) showSettingsPage(a.link);
    else if (a.state === 'ready') openAppDetail(a.id);
  });
  return card;
}

function featuredChip(a) {
  const chip = document.createElement('button');
  chip.className = 'app-chip';
  chip.innerHTML = `<span class="app-chip-ic" aria-hidden="true"></span><span class="app-chip-name"></span>`;
  chip.querySelector('.app-chip-ic').textContent = a.icon;
  chip.querySelector('.app-chip-name').textContent = a.name;
  if (a.status === 'connected') chip.classList.add('connected');
  chip.title = a.desc;
  chip.onclick = () => {
    if (a.link) showSettingsPage(a.link);
    else if (a.state === 'ready') openAppDetail(a.id);
    else toast(`${a.name} is coming soon`);
  };
  return chip;
}

function renderApps() {
  const filter = ($('#appSearch')?.value || '').trim().toLowerCase();
  const cat = $('#appsCatalog');
  const feat = $('#appsFeatured');
  const featRow = $('#appsFeaturedRow');
  if (!cat) return;

  if (feat && featRow) {
    const featured = (appsState.featured || [])
      .map(appById).filter(Boolean)
      .filter((a) => !filter || appSearchText(a).includes(filter));
    featRow.innerHTML = '';
    feat.hidden = featured.length === 0;
    featured.forEach((a) => featRow.appendChild(featuredChip(a)));
  }

  cat.innerHTML = '';
  let shown = 0;
  for (const c of appsState.categories) {
    const apps = appsState.apps.filter((a) => a.category === c.id && (!filter || appSearchText(a).includes(filter)));
    if (!apps.length) continue;
    shown += apps.length;
    const sec = document.createElement('section');
    sec.className = 'apps-cat';
    const h = document.createElement('h4');
    h.className = 'apps-cat-title';
    h.textContent = c.label;
    const grid = document.createElement('div');
    grid.className = 'apps-grid';
    apps.forEach((a) => grid.appendChild(appCardNode(a)));
    sec.append(h, grid);
    cat.appendChild(sec);
  }
  if (!shown) {
    const empty = document.createElement('p');
    empty.className = 'apps-empty';
    empty.textContent = `No apps match “${$('#appSearch').value.trim()}”.`;
    cat.appendChild(empty);
  }
}

/** Connect flow (§21): permission explanation → Continue → provider OAuth. */
async function startConnect(a) {
  if (a.state === 'soon') { toast(`${a.name} is coming soon`); return; }
  if (a.auth === 'apikey') { openAppDetail(a.id); return; } // API-key apps connect via their detail form
  if (a.status === 'not_configured') {
    await showAppConfirm({
      title: `${a.name} isn't configured yet`,
      detail: `Add ${APP_ENV_HINTS[a.provider] || 'OAuth credentials'} to .env and restart Zara — then connect here.`,
      okLabel: 'Got it', cancelLabel: null,
    });
    return;
  }
  const ok = await showAppConfirm({
    title: `Connect ${a.name}`,
    detail: 'Zara will be able to:',
    consents: a.consent || [],
    okLabel: a.connectLabel || 'Continue',
    cancelLabel: 'Cancel',
  });
  if (!ok) return;
  try {
    const r = await integrationConnect(a.id, {});
    if (r.authorizationUrl) {
      // Send the browser to the provider; the callback lands back on this page.
      window.location.href = r.authorizationUrl;
      return;
    }
    await refreshApps();
    toast(`✓ ${a.name} connected`);
  } catch (err) {
    toast(err.hint ? `${err.message} — ${err.hint}` : err.message || 'Could not start connecting');
  }
}

function srowNode(label, sub, value) {
  const row = document.createElement('div');
  row.className = 'srow';
  const text = document.createElement('div');
  text.className = 'srow-text';
  const strong = document.createElement('strong');
  strong.textContent = label;
  const small = document.createElement('small');
  small.textContent = sub || '';
  text.append(strong, small);
  row.appendChild(text);
  if (value !== undefined && value !== null) {
    if (value instanceof Node) row.appendChild(value);
    else { const v = document.createElement('span'); v.className = 'srow-value'; v.textContent = String(value); row.appendChild(v); }
  }
  return row;
}

async function openAppDetail(appId) {
  const app = appById(appId);
  if (app && app.link) { showSettingsPage(app.link); return; }
  showSettingsPage('app-detail');
  const head = $('#appDetailHead');
  const body = $('#appDetailBody');
  head.innerHTML = '';
  body.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const a = await integrationDetail(appId);
    renderAppDetail(a, head, body);
  } catch (err) {
    body.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'conn-line err';
    p.textContent = err.message || 'Could not load that app.';
    body.appendChild(p);
  }
}

function renderAppDetail(a, head, body) {
  // ---- header: icon + name + status ----
  const ic = document.createElement('div');
  ic.className = 'app-ic lg';
  ic.setAttribute('aria-hidden', 'true');
  ic.textContent = a.icon;
  const titleWrap = document.createElement('div');
  const titleRow = document.createElement('div');
  titleRow.className = 'app-name-row';
  const h = document.createElement('strong');
  h.className = 'app-detail-name';
  h.textContent = a.name;
  titleRow.append(h, appPill(a));
  const desc = document.createElement('p');
  desc.className = 'app-desc';
  desc.textContent = a.desc;
  titleWrap.append(titleRow, desc);
  head.append(ic, titleWrap);

  // ---- body ----
  body.innerHTML = '';

  if (a.state === 'soon') {
    body.appendChild(srowNode('Status', 'This integration is architected but not available yet', 'Coming soon'));
    const note = document.createElement('p');
    note.className = 'field-note';
    note.textContent = 'Zara never fakes capabilities — this app will appear here once its API is implemented.';
    body.appendChild(note);
    return;
  }

  const connected = a.status === 'connected' || a.status === 'reauth';
  body.appendChild(srowNode('Account', connected ? 'Connected as' : 'No account connected',
    connected ? (a.account || 'Connected') : '—'));
  const statusEl = document.createElement('span');
  statusEl.className = `conn-line ${connected ? 'ok' : a.status === 'not_configured' ? 'down' : ''}`;
  statusEl.textContent = a.status === 'connected' ? '● Connected'
    : a.status === 'reauth' ? '⚠ Reconnect required'
    : a.status === 'not_configured' ? '○ Not configured'
    : '○ Not connected';
  body.appendChild(srowNode('Status', 'Connection state on this machine', statusEl));

  // permissions
  const chips = document.createElement('div');
  chips.className = 'perm-chips';
  const info = a.permissionInfo || { permissions: a.permissions || [] };
  (info.permissions || []).forEach((p) => {
    const chip = document.createElement('span');
    chip.className = 'perm-chip' + (p.granted ? ' granted' : '');
    chip.textContent = `${p.granted ? '✓ ' : '○ '}${p.label}`;
    chips.appendChild(chip);
  });
  body.appendChild(srowNode('Permissions', connected
    ? 'Granted access — write actions always ask for you first'
    : 'What Zara will be allowed to do once connected', chips));

  body.appendChild(srowNode('Last connected', 'When authorization completed',
    a.connectedAt ? new Date(a.connectedAt).toLocaleString() : '—'));

  if (a.lastTest) {
    body.appendChild(srowNode('Last test', new Date(a.lastTest.at || Date.now()).toLocaleString(),
      a.lastTest.ok ? `✓ Passed${a.lastTest.ms ? ` · ${a.lastTest.ms} ms` : ''}` : `⚠ ${a.lastTest.detail || 'Failed'}`));
  }

  if (a.auth === 'apikey') return void renderLmsActions(a, body, connected);

  // ---- actions ----
  const actions = document.createElement('div');
  actions.className = 'srow srow-actions';
  if (connected) {
    const testBtn = document.createElement('button');
    testBtn.className = 'ghost-btn';
    testBtn.textContent = 'Test connection';
    testBtn.onclick = async () => {
      testBtn.disabled = true;
      testBtn.textContent = 'Testing…';
      try {
        const r = await integrationTest(a.id);
        if (r.test && r.test.ok) toast(`✓ ${a.name} is reachable (${r.test.ms || 0} ms)`);
        else toast(`⚠ Test failed: ${(r.test && (r.test.detail || r.test.error)) || 'no response'}`);
      } catch (err) { toast(err.message || 'Test failed'); }
      finally { testBtn.disabled = false; testBtn.textContent = 'Test connection'; openAppDetail(a.id); }
    };
    const discBtn = document.createElement('button');
    discBtn.className = 'ghost-btn danger';
    discBtn.textContent = 'Disconnect';
    discBtn.onclick = () => confirmDisconnect(a);
    actions.append(testBtn, discBtn);
  } else if (a.status === 'not_configured') {
    const note = document.createElement('p');
    note.className = 'field-note';
    note.textContent = `Add ${APP_ENV_HINTS[a.provider] || 'OAuth credentials'} to .env and restart Zara to enable ${a.name}.`;
    body.appendChild(note);
  } else {
    const connect = document.createElement('button');
    connect.className = 'primary-btn';
    connect.textContent = a.connectLabel || 'Connect';
    connect.onclick = () => startConnect(a);
    actions.appendChild(connect);
    const consents = document.createElement('div');
    consents.className = 'detail-consent';
    const p = document.createElement('p');
    p.className = 'field-note';
    p.textContent = 'Zara will be able to:';
    const ul = document.createElement('ul');
    ul.className = 'access-list consent-list';
    (a.consent || []).forEach((c) => { const li = document.createElement('li'); li.textContent = c; ul.appendChild(li); });
    consents.append(p, ul);
    body.appendChild(consents);
  }
  body.appendChild(actions);
}

function renderLmsActions(a, body, connected) {
  if (connected) {
    body.appendChild(srowNode('Saved key', 'Stored server-side, encrypted — never sent to the browser',
      a.mask || '••••••••'));
    body.appendChild(srowNode('API base URL', 'Communicates through the LMS API only (never its database)',
      a.baseUrl || '—'));
  }
  const urlRow = srowNode('API base URL', 'Your Aculyze LMS endpoint');
  const url = document.createElement('input');
  url.className = 'modern-input';
  url.type = 'url';
  url.id = 'lmsBaseUrl';
  url.placeholder = 'https://lms.example.com/api';
  url.autocomplete = 'off';
  url.value = a.baseUrl || '';
  urlRow.appendChild(url);

  const keyRow = srowNode('API key', connected ? 'Leave blank to keep the saved key — paste a new one to replace it' : 'Stored server-side only — shown masked after saving');
  const keyWrap = document.createElement('div');
  keyWrap.className = 'key-field';
  const key = document.createElement('input');
  key.className = 'modern-input';
  key.type = 'password';
  key.id = 'lmsKey';
  key.placeholder = a.mask ? `${a.mask} (saved)` : 'ak_live_…';
  key.autocomplete = 'off';
  const eye = document.createElement('button');
  eye.className = 'key-eye';
  eye.type = 'button';
  eye.setAttribute('aria-label', 'Show API key');
  eye.title = 'Show / hide API key';
  eye.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" /><circle cx="12" cy="12" r="2.5" /></svg>';
  eye.onclick = () => { key.type = key.type === 'password' ? 'text' : 'password'; };
  keyWrap.append(key, eye);
  keyRow.appendChild(keyWrap);

  body.append(urlRow, keyRow);

  const actions = document.createElement('div');
  actions.className = 'srow srow-actions';
  const save = document.createElement('button');
  save.className = 'primary-btn';
  save.textContent = 'Connect & test';
  save.onclick = async () => {
    const baseUrl = url.value.trim();
    const apiKey = key.value.trim();
    if (!baseUrl || !apiKey) { toast('API base URL and API key are both required'); return; }
    save.disabled = true;
    save.textContent = 'Connecting…';
    try {
      const r = await integrationConnect(a.id, { baseUrl, apiKey });
      if (r.test && r.test.ok) toast(`✅ Aculyze LMS connected (${r.test.ms || 0} ms)`);
      else toast(`⚠ Saved, but the test failed: ${(r.test && (r.test.detail || r.test.error)) || 'no response'}`);
      await refreshApps();
      openAppDetail(a.id);
    } catch (err) {
      toast(err.hint ? `${err.message} — ${err.hint}` : err.message || 'Could not connect');
      save.disabled = false;
      save.textContent = 'Connect & test';
    }
  };
  actions.appendChild(save);

  const replace = document.createElement('button');
  replace.className = 'ghost-btn';
  replace.textContent = 'Replace key';
  replace.onclick = () => { key.type = 'text'; key.value = ''; key.placeholder = 'Paste the new API key'; key.focus(); };
  actions.appendChild(replace);

  if (connected) {
    const testBtn = document.createElement('button');
    testBtn.className = 'ghost-btn';
    testBtn.textContent = 'Test connection';
    testBtn.onclick = async () => {
      testBtn.disabled = true;
      testBtn.textContent = 'Testing…';
      try {
        const r = await integrationTest(a.id);
        toast(r.test && r.test.ok ? `✓ LMS reachable (${r.test.ms || 0} ms)` : `⚠ ${(r.test && (r.test.detail || r.test.error)) || 'Test failed'}`);
      } catch (err) { toast(err.message || 'Test failed'); }
      finally { testBtn.disabled = false; testBtn.textContent = 'Test connection'; openAppDetail(a.id); }
    };
    const disc = document.createElement('button');
    disc.className = 'ghost-btn danger';
    disc.textContent = 'Disconnect';
    disc.onclick = () => confirmDisconnect(a);
    actions.append(testBtn, disc);
  }
  body.appendChild(actions);
  const note = document.createElement('p');
  note.className = 'field-note';
  note.textContent = 'The key is encrypted on the server — the browser only ever sees this masked form.';
  body.appendChild(note);
}

async function confirmDisconnect(a) {
  const ok = await showAppConfirm({
    title: `Disconnect ${a.name}?`,
    detail: `${a.icon} Zara will lose access to ${a.name} and its tools will stop working. You can reconnect any time.`,
    okLabel: 'Disconnect',
    cancelLabel: 'Cancel',
  });
  if (!ok) return;
  try {
    await integrationDisconnect(a.id);
    toast(`${a.name} disconnected`);
    await refreshApps();
    if (settingsOverlay.dataset.page === 'app-detail') openAppDetail(a.id);
  } catch (err) { toast(err.message || 'Could not disconnect'); }
}

// ---- generic confirmation modal (returns true/false) ----
let appConfirmDone = null;
function showAppConfirm({ title, detail, consents, preview, okLabel = 'Continue', cancelLabel = 'Cancel' }) {
  const overlay = $('#appConfirmOverlay');
  if (appConfirmDone) appConfirmDone(false); // a pending confirm loses to a new one
  $('#appConfirmTitle').textContent = title || 'Confirm';
  const detailEl = $('#appConfirmDetail');
  detailEl.textContent = detail || '';
  detailEl.hidden = !detail;

  const list = $('#appConfirmList');
  list.innerHTML = '';
  if (consents && consents.length) {
    consents.forEach((c) => { const li = document.createElement('li'); li.textContent = c; list.appendChild(li); });
    list.hidden = false;
  } else list.hidden = true;

  const pv = $('#appConfirmPreview');
  pv.innerHTML = '';
  if (preview && preview.length) {
    preview.forEach((row) => {
      const el = document.createElement('div');
      el.className = 'cp-row';
      const l = document.createElement('span');
      l.className = 'cp-label';
      l.textContent = row.label;
      const v = document.createElement('span');
      v.className = 'cp-value';
      v.textContent = row.value;
      el.append(l, v);
      pv.appendChild(el);
    });
    pv.hidden = false;
  } else pv.hidden = true;

  $('#appConfirmOk').textContent = okLabel;
  const cancel = $('#appConfirmCancel');
  cancel.textContent = cancelLabel || 'Cancel';
  cancel.hidden = cancelLabel === null;
  overlay.hidden = false;
  setTimeout(() => $('#appConfirmOk').focus(), 60);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;          // double-click / Escape-after-click: settle once
      settled = true;
      overlay.hidden = true;
      document.removeEventListener('keydown', onKey, true);
      // Clear the pending handle only if it is still ours (opening a NEW modal
      // takes ownership via "if (appConfirmDone) appConfirmDone(false)").
      if (appConfirmDone === finish) appConfirmDone = null;
      resolve(val);                 // resolve THIS caller's promise
    };
    appConfirmDone = finish;
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
    }
    document.addEventListener('keydown', onKey, true); // capture: closes this before anything else
    $('#appConfirmOk').onclick = () => finish(true);
    cancel.onclick = () => finish(false);
    $('#appConfirmClose').onclick = () => finish(false);
    overlay.onclick = (e) => { if (e.target === overlay) finish(false); };
  });
}

/** OAuth callback landed back on Zara (/?app=gmail&status=connected). */
function handleIntegrationCallback() {
  const p = new URLSearchParams(location.search);
  const appId = p.get('app');
  const status = p.get('status');
  if (!appId && !status) return;
  const app = appById(appId);
  const name = (app && app.name) || (appId ? appId.replace(/-/g, ' ') : 'App');
  if (status === 'connected') toast(`✓ ${name} connected`);
  else if (status === 'denied') toast(`${name} authorization was cancelled`);
  else if (status === 'error') toast(`Couldn't finish connecting ${name} — please try again`);
  if (appId) {
    openSettings('apps');
    setTimeout(() => openAppDetail(appId), 120);
  }
  history.replaceState({}, '', location.pathname);
}

// ============ SETTINGS (left nav + right panel workspace) ============
const settingsOverlay = $('#settingsOverlay');
const DETAIL_PARENT = { 'provider-detail': 'models', 'sales-detail': 'apps', 'app-detail': 'apps' };

function openSettings(page) {
  syncSettingsForm();
  refreshSalesPluginStatus();
  settingsOverlay.hidden = false;
  const target = page || 'general';
  showSettingsPage(target);
  // Mobile: opening from ⚙ shows the section list first; deep links jump straight in.
  if (!page && isMobileLayout()) settingsOverlay.dataset.view = 'list';
}
function closeSettings() {
  settingsOverlay.hidden = true;
}

function showSettingsPage(page) {
  document.querySelectorAll('.spanel').forEach((s) => s.classList.toggle('active', s.dataset.page === page));
  document.querySelectorAll('.snav-item').forEach((b) => {
    const p = b.dataset.page;
    const active = p === page
      || (page === 'provider-detail' && p === 'models')
      || (page === 'sales-detail' && p === 'apps')
      || (page === 'app-detail' && p === 'apps');
    b.classList.toggle('active', active);
  });
  settingsOverlay.dataset.page = page;
  settingsOverlay.dataset.view = 'detail';
  const content = document.querySelector('.settings-content');
  if (content) content.scrollTop = 0;
  if (page === 'agents') renderAgents();
  if (page === 'apps') refreshApps();
}
function syncSettingsForm() {
  $('#setProvider').value = providerName === 'lmstudio' ? 'LM Studio' : providerName;
  const sel = $('#setModel');
  sel.innerHTML = '';
  if (availableModels.length === 0) {
    const o = document.createElement('option');
    o.textContent = settings.model || 'No models available';
    o.value = settings.model || '';
    sel.appendChild(o);
  } else {
    for (const m of availableModels) {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.name || m.id;
      sel.appendChild(o);
    }
    sel.value = settings.model || availableModels[0].id;
  }
  $('#setTemp').value = settings.temperature;
  $('#setMaxTokens').value = settings.maxTokens;
  document.querySelectorAll('#themeGroup input[name="theme"]').forEach((r) => {
    r.checked = r.value === settings.theme;
  });
  $('#setCompact').checked = !!settings.compact;
  $('#setAnimations').checked = settings.animations !== false;
  $('#setVoiceReplies').checked = !!settings.voiceReplies;
  const dataCount = $('#dataConvCount');
  if (dataCount) dataCount.textContent = `${conversations.length} chat${conversations.length === 1 ? '' : 's'}`;
}
const settingsOpen = () => openSettings();
$('#settingsBtn').addEventListener('click', settingsOpen);
$('#settingsBtnSidebar').addEventListener('click', settingsOpen);
$('#modelStatusBtn').addEventListener('click', () => openSettings('models'));
$('#providerLmCard').addEventListener('click', () => showSettingsPage('provider-detail'));
$('#manageSalesBtn')?.addEventListener('click', () => showSettingsPage('sales-detail'));
document.querySelectorAll('.back-link').forEach((b) =>
  b.addEventListener('click', () => showSettingsPage(b.dataset.back)));
$('#settingsBack').addEventListener('click', () => {
  const page = settingsOverlay.dataset.page;
  const parent = DETAIL_PARENT[page];
  if (parent) showSettingsPage(parent);
  else settingsOverlay.dataset.view = 'list';
});
document.querySelectorAll('.snav-item').forEach((b) =>
  b.addEventListener('click', () => showSettingsPage(b.dataset.page)));
$('#salesKeyEye').addEventListener('click', () => {
  const key = $('#setSalesKey');
  const show = key.type === 'password';
  key.type = show ? 'text' : 'password';
  $('#salesKeyEye').setAttribute('aria-label', show ? 'Hide API key' : 'Show API key');
});

// ---- Sales AI agent: SAP / ERP plugin connection ----
async function refreshSalesPluginStatus({ fillFields = true } = {}) {
  const line = $('#salesStatusLine');
  line.textContent = 'Checking…';
  try {
    const s = await salesStatus();
    if (fillFields) {
      // Only refill inputs on open — never clobber what the user is typing.
      $('#setSalesProvider').value = s.providerName || '';
      $('#setSalesUrl').value = s.baseUrl || '';
      $('#setSalesKey').value = '';
      $('#setSalesKey').placeholder = s.hasKey ? '•••••••• (saved — leave blank to keep)' : 'Paste your API key';
      $('#setSalesUse').checked = !!s.inUse;
    }
    if (!s.connected) {
      line.textContent = 'Not connected';
      setSalesCard('down', '○ Not connected', '');
    } else if (s.lastTest && s.lastTest.ok) {
      line.textContent = `Connected to ${s.providerName} ✓ (tested ${s.lastTest.status}, ${s.lastTest.ms} ms)${s.inUse ? ' · in use' : ' · paused'}`;
      setSalesCard('ok', '● Connected', s.inUse ? 'In use' : 'Paused');
    } else if (s.lastTest && !s.lastTest.ok) {
      line.textContent = `Saved for ${s.providerName} — last test failed${s.lastTest.error ? `: ${s.lastTest.error}` : s.lastTest.status ? ` (HTTP ${s.lastTest.status})` : ''}${s.inUse ? ' · in use' : ''}`;
      setSalesCard('down', '⚠ Last test failed', '');
    } else {
      line.textContent = `Connected to ${s.providerName}${s.inUse ? ' · in use' : ' · paused'}`;
      setSalesCard('ok', '● Connected', s.inUse ? 'In use' : 'Paused');
    }
    return s;
  } catch {
    line.textContent = 'Server unreachable';
    setSalesCard('err', '⚠ Server unreachable', '');
    return null;
  }
}

function setSalesCard(kind, text, sync) {
  const card = $('#salesCardStatus');
  if (!card) return;
  card.textContent = text;
  card.classList.remove('ok', 'down', 'err');
  card.classList.add(kind);
  const syncEl = $('#salesCardSync');
  if (syncEl) syncEl.textContent = sync;
}

$('#salesConnectBtn').addEventListener('click', async () => {
  const btn = $('#salesConnectBtn');
  const providerName = $('#setSalesProvider').value.trim();
  const baseUrl = $('#setSalesUrl').value.trim();
  const apiKey = $('#setSalesKey').value.trim();
  if (!providerName || !baseUrl || !apiKey) {
    toast('Provider name, API base URL and API key are all required');
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  $('#salesStatusLine').textContent = 'Testing connection…';
  try {
    const r = await salesConnect({ providerName, baseUrl, apiKey, inUse: $('#setSalesUse').checked });
    if (r.test && r.test.ok) toast(`✅ ${providerName} connected (${r.test.ms} ms)`);
    else if (r.test && !r.test.ok) toast(`⚠ Saved, but connection test failed: ${r.test.error || `HTTP ${r.test.status}`}`);
    else toast('💾 Plugin saved');
  } catch (err) {
    toast(err.hint ? `${err.message} — ${err.hint}` : err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save changes';
    await refreshSalesPluginStatus();
  }
});

$('#setSalesUse').addEventListener('change', async (e) => {
  try {
    await salesConnect({ inUse: e.target.checked });
    toast(e.target.checked ? '🔌 Sales AI plugin is now in use' : 'Sales AI plugin paused');
  } catch (err) { toast(err.message || 'Could not update plugin'); }
  // Don't refill the inputs here — the user may be mid-edit.
  await refreshSalesPluginStatus({ fillFields: false });
});
$('#accountBtn').addEventListener('click', () => toast('Single local user in v1 — no login required'));
$('#settingsClose').addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) closeSettings(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const hadSettings = !settingsOverlay.hidden;
    closeSettings(); closeEmail(); closeAgentPalette(); closeModelMenu();
    document.querySelectorAll('.item-menu').forEach((m) => m.remove());
    if (isMobileLayout() && sidebar.classList.contains('open')) closeSidebar();
    if (!hadSettings && document.querySelector('#searchBox.expanded')) collapseSearch();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); newChat(); }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); newChat(); }
});
$('#setModel').addEventListener('change', (e) => {
  settings.model = e.target.value;
  saveSettings(settings);
  updateModelLabel();
});
$('#setTemp').addEventListener('change', (e) => {
  settings.temperature = Math.min(2, Math.max(0, Number(e.target.value) || 0.7));
  saveSettings(settings);
  syncSettingsForm();
});
$('#setMaxTokens').addEventListener('change', (e) => {
  settings.maxTokens = Math.min(8192, Math.max(128, Number(e.target.value) || 2048));
  saveSettings(settings);
  syncSettingsForm();
});
$('#themeGroup').addEventListener('change', (e) => {
  if (e.target.name !== 'theme') return;
  settings.theme = e.target.value;
  saveSettings(settings);
  applyTheme();
});
$('#setCompact').addEventListener('change', (e) => {
  settings.compact = e.target.checked;
  saveSettings(settings);
  applyTheme();
});
$('#setAnimations').addEventListener('change', (e) => {
  settings.animations = e.target.checked;
  saveSettings(settings);
  applyTheme();
  toast(e.target.checked ? 'Animations on' : 'Animations off');
});
$('#setVoiceReplies').addEventListener('change', (e) => {
  settings.voiceReplies = e.target.checked;
  saveSettings(settings);
  if (settings.voiceReplies) refreshVoiceStatus();
  toast(settings.voiceReplies ? '🔊 Zara will read replies aloud' : 'Voice replies off');
});

// ============ AGENT PALETTE (✦ Agents command menu) ============
const agentPalette = $('#agentPalette');
function openAgentPalette() {
  renderAgents();
  agentPalette.hidden = false;
  $('#agentPaletteClose').focus();
}
function closeAgentPalette() { agentPalette.hidden = true; }
$('#agentsBtn').addEventListener('click', openAgentPalette);
$('#agentPaletteClose').addEventListener('click', closeAgentPalette);

// ---- Apps & Integrations entry points ----
$('#appsBtn').addEventListener('click', () => { closeSidebar(); openSettings('apps'); });
$('#appSearch')?.addEventListener('input', renderApps);
agentPalette.addEventListener('click', (e) => { if (e.target === agentPalette) closeAgentPalette(); });

// ============ SIDEBAR SEARCH (compact ⌕ → expands into input) ============
const searchBox = $('#searchBox');
function expandSearch() {
  if (document.body.classList.contains('sidebar-collapsed')) setSidebarCollapsed(false);
  searchBox.classList.add('expanded');
  const inp = $('#historySearch');
  inp.focus();
  inp.select();
}
function collapseSearch() {
  searchBox.classList.remove('expanded');
  const inp = $('#historySearch');
  if (inp.value) {
    inp.value = '';
    historyFilter = '';
    renderHistory();
  }
}
$('#searchTrigger').addEventListener('click', expandSearch);
$('#searchClose').addEventListener('click', collapseSearch);
$('#historySearch').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.stopPropagation(); collapseSearch(); }
});

// ============ MODEL SELECTOR (header chip → popover) ============
const modelChip = $('#modelChip');
const modelMenu = $('#modelMenu');
function renderModelMenu() {
  modelMenu.innerHTML = '';
  const label = document.createElement('div');
  label.className = 'mp-label';
  label.textContent = 'Model';
  modelMenu.appendChild(label);
  if (!availableModels.length) {
    const empty = document.createElement('div');
    empty.className = 'mp-empty';
    empty.textContent = 'No models available — start LM Studio.';
    modelMenu.appendChild(empty);
    return;
  }
  for (const m of availableModels) {
    const b = document.createElement('button');
    b.className = 'mp-item' + (m.id === settings.model ? ' active' : '');
    b.setAttribute('role', 'menuitem');
    const t = document.createElement('span');
    t.textContent = m.name || m.id;
    t.title = m.id;
    b.appendChild(t);
    if (m.id === settings.model) {
      const c = document.createElement('span');
      c.className = 'check';
      c.textContent = '✓';
      b.appendChild(c);
    }
    b.onclick = () => {
      settings.model = m.id;
      saveSettings(settings);
      updateModelLabel();
      statusText.textContent = currentModelName() || 'Not connected';
      closeModelMenu();
      toast(`Model: ${m.name || m.id}`);
    };
    modelMenu.appendChild(b);
  }
}
function closeModelMenu() {
  modelMenu.hidden = true;
  modelChip.setAttribute('aria-expanded', 'false');
}
modelChip.addEventListener('click', (e) => {
  e.stopPropagation();
  if (modelMenu.hidden) {
    renderModelMenu();
    modelMenu.hidden = false;
    modelChip.setAttribute('aria-expanded', 'true');
  } else closeModelMenu();
});
document.addEventListener('click', (e) => {
  if (!modelMenu.hidden && !modelMenu.contains(e.target) && !modelChip.contains(e.target)) closeModelMenu();
});

// ============ DATA & PRIVACY ============
$('#exportDataBtn').addEventListener('click', () => {
  try {
    const blob = new Blob([JSON.stringify(conversations, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `zara-conversations-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Conversations exported ✓');
  } catch { toast('Export failed'); }
});
$('#clearDataBtn').addEventListener('click', () => {
  if (!confirm('Delete ALL conversations from this browser? This cannot be undone.')) return;
  stopVoicePlayback();
  if (generating) abortController?.abort();
  conversations = [];
  const c = createConversation();
  conversations.push(c);
  activeId = c.id;
  persist();
  renderAll();
  const dataCount = $('#dataConvCount');
  if (dataCount) dataCount.textContent = '1 chat';
  toast('All conversations deleted');
});

// ============ TOP / NAV ============
$('#menuBtn').addEventListener('click', toggleSidebar);
$('#historySearch').addEventListener('input', (e) => {
  historyFilter = e.target.value;
  renderHistory();
});
sidebarOverlay.addEventListener('click', closeSidebar);
$('#newChatBtn').addEventListener('click', newChat);
$('#newChatBtnTop').addEventListener('click', newChat);

// ============ INIT ============
function renderAll() {
  renderAgents();
  renderHistory();
  renderMessages();
}

async function init() {
  applyTheme();
  autoGrow();
  syncWebButton();
  try {
    if (!isMobileLayout() && localStorage.getItem(K_SIDEBAR) === '1') {
      document.body.classList.add('sidebar-collapsed');
    }
  } catch { /* ignore */ }
  if (!activeConversation() && conversations.length === 0) {
    const c = createConversation();
    conversations.unshift(c);
    activeId = c.id;
    persist();
  } else if (!activeConversation()) {
    activeId = conversations[0].id;
  }
  renderAll();
  try {
    const cfg = await fetchConfig();
    providerName = cfg.provider || 'lmstudio';
    if (cfg.email && cfg.email.enabled && cfg.email.configured) {
      emailBtn.hidden = false;
    }
    if (typeof cfg.defaultTemperature === 'number' && loadSettings().temperature === undefined) {
      settings.temperature = cfg.defaultTemperature;
    }
  } catch { /* offline — defaults stand */ }
  await refreshStatus();
  await refreshModels();
  refreshVoiceStatus();
  setInterval(refreshStatus, 15000);
  // Apps & Integrations: load connection status (chat uses it as a gate)
  // and handle an OAuth callback that just landed on this page.
  try {
    appsReady = refreshApps({ render: false });
    await appsReady;
    handleIntegrationCallback();
  } catch { /* offline — apps stay in their default state */ }
}

// ============ STUDIO BRIDGE (additive, no behavior change) ============
// Exposes a tiny stable surface for the ACULYZE STUDIO shell (js/ui.js): the
// command bar, sidebar nav and workspace views. Pure function references —
// touching nothing about existing behavior.
if (typeof window !== 'undefined') {
  window.__studio = {
    pickAgent,
    newChat,
    openSettings,
    showSettingsPage,
    toast,
    getModels: () => availableModels.slice(),
    getModel: () => settings.model || availableModels[0]?.id || '',
  };
}

init();
