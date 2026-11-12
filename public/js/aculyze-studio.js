/* ========================================================================
   ACULYZE STUDIO — Application logic (quiet "AI application" refinement)
   Two agents (Zara · Sales Agent) + Foppy voice presence (page-mascot port)
   Conversation architecture: single Zara conversation in right panel
   ======================================================================== */

import {
  sttSupported,
  ttsSupported,
  createListener,
  speak,
  stopSpeaking,
  isSpeaking,
  toSpokenText,
} from './voice.js';
import { streamChat, salesChat, resolveIntegrations, classifyOrchestrator, runOrchestrator, classifyResearch, researchQuestion, listIntegrations, integrationDetail, integrationConnect, integrationTest, integrationDisconnect, executeIntegration, gmailSearch, gmailGetMessage, gmailCreateDraft, gmailSendMessage, fetchStatus, fetchConfig, fetchModels, salesQuery, salesStatus, salesConnect, lmsStatus, loadEmployees, loadTokenUsage, authMe, authLogin, authRegister, authLogout, inboxThreads, inboxContacts, inboxMessages, inboxSend, inboxRead } from './api.js';
import { renderMarkdown, enhanceCodeBlocks } from './markdown.js';
import { createMascot } from './mascot.js';
import { loadConversations, saveConversations, createConversation, autoTitleFrom, groupConversations, loadSettings, saveSettings, uid } from './store.js';

const SYSTEM_PROMPTS = {
  sales: `You are the Sales Agent of Aculyze Studio, a business-intelligence assistant powered by Aculyze LMS. Answer sales/customer/lead/performance questions using ONLY Aculyze LMS data. Never invent revenue, customer, lead, employee, or conversion statistics. If not available in the business data, say exactly: "I don't have that information in the available Aculyze business data." Be concise, professional, helpful.`,
  zara: `You are Zara, Aculyze's AI copilot. Answer clearly and helpfully. Use web research when the user asks to search or browse, and when the answer needs current or source-backed information. Never claim to have searched unless the research tool did so. If search fails or evidence is limited, say what happened and show the sources that were actually retrieved. Never invent sources or facts. Be clear about where information came from.`,
};

/** Build ERP/LMS context for Sales Agent from live plugin data. */
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
  if (question) parts.push('', `Question: ${question}`, 'Answer:');
  return parts.join('\n').slice(0, 12000);
}

const PREFS_KEY = 'aculyze.studio.prefs.v1';
const THEME_KEY = 'aculyze.studio.theme';
const VIEW_KEY = 'aculyze.studio.startupview';
const THREADS_KEY = 'aculyze.studio.threads.v1';
const CONVERSATIONS_KEY = 'aculyze.studio.conversations.v1';

const state = {
  activeAgent: 'zara',
  activeView: 'home',
  voiceSupported: sttSupported() && ttsSupported(),
  listening: false,
  speaking: false,
  muted: false,
  conversations: loadConversations(),
  threads: loadThreads(),
  threadId: null, // set after loadThreads below
  // Conversation state: currently selected conversation in the right panel
  selectedConversationId: null,
  // Lightweight conversation cache for UI (localStorage-persisted but NOT model memory)
  conversationCache: loadConversationCache(),
  attachments: [], // pending image attachments { name, type, dataUrl }
  context: '',
  abortCtrl: null,
  activeRequest: null,
  prefs: loadPrefs(),
};

// Sales Agent — completely separate state from Zara
const SALES_CONV_KEY = 'aculyze.studio.sales-conversations.v1';
function loadSalesConversationCache() {
  try {
    const raw = localStorage.getItem(SALES_CONV_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c) => c && typeof c.id === 'string' && c.agent === 'sales');
  } catch { return []; }
}
function saveSalesConversationCache() {
  try { localStorage.setItem(SALES_CONV_KEY, JSON.stringify(salesState.conversationCache)); } catch { /* quota */ }
}
const salesState = {
  selectedConversationId: null,
  abortCtrl: null,
  activeRequest: null,
  conversationCache: loadSalesConversationCache(), // Sales conversations stored separately
};

// Inbox — human-to-human messaging workspace, separate from Zara and Sales.
// Messages live on the server (data/inbox/*.json) and are pulled in with a
// `since` cursor every few seconds; nothing here is the source of truth.
const inboxState = {
  selectedUserId: null,
  activeRequest: null,
  users: [], // { id, name, role, status, avatar, lastMessage, updatedAt, unread }
  messages: {}, // { [peerId]: [{ id, role, content, timestamp, generated }] }
  threads: {}, // { [peerId]: { preview, lastTs, unread, readTs } } from /api/inbox/threads
  meId: null, // 'usr-<uid>' — this account's peer id
  pollTimer: null, // ms-interval for new messages
  threadTimer: null, // ms-interval for previews + unread badges
  polling: false,
  threadsBusy: false,
};

/* Start in the most recent thread (or lazily create one in the Zara view). */
state.threadId = state.threads.length
  ? state.threads.reduce((best, t) => (t.updatedAt > best.updatedAt ? t : best), state.threads[0]).id
  : null;

function loadPrefs() {
  try { return { enterToSend: true, webResearch: false, startupView: 'home', theme: 'dark', compact: false, animations: true, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; }
  catch { return { enterToSend: true, webResearch: false, startupView: 'home', theme: 'dark', compact: false, animations: true }; }
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs)); } catch { /* optional */ }
}
function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  document.body.classList.toggle('compact', !!state.prefs.compact);
  document.body.classList.toggle('no-animations', state.prefs.animations === false);
}

/* ---------- Conversation cache (localStorage, UI-only, NOT model memory) ---------- */
function loadConversationCache() {
  try {
    const raw = localStorage.getItem(CONVERSATIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Validate structure
    return parsed.filter((c) => c && typeof c.id === 'string' && c.agent === 'zara');
  } catch {
    return [];
  }
}
function saveConversationCache() {
  try {
    localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(state.conversationCache));
  } catch { /* quota — ignore */ }
}

/* ---------- Zara threads (AI inbox) ---------- */
function loadThreads() {
  let threads = null;
  try { threads = JSON.parse(localStorage.getItem(THREADS_KEY) || 'null'); } catch { threads = null; }
  if (!Array.isArray(threads)) threads = [];
  threads = threads
    .filter((t) => t && typeof t.id === 'string' && Array.isArray(t.messages))
    .map((t) => ({ id: t.id, title: t.title || '', messages: t.messages, updatedAt: t.updatedAt || Date.now(), unread: !!t.unread }));
  if (!threads.length) {
    // Migrate any pre-inbox Zara messages into a first thread.
    const legacy = loadConversations().zara || [];
    if (legacy.length) threads.push({ id: threadId(), title: legacyTitle(legacy), messages: legacy, updatedAt: Date.now(), unread: false });
  }
  return threads;
}
function threadId() {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function legacyTitle(messages) {
  const first = messages.find((m) => m.role === 'user');
  return first ? titleFromText(first.content) : 'Previous conversation';
}
function titleFromText(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > 42 ? `${clean.slice(0, 42).trimEnd()}…` : clean || 'New message';
}

/* ---------- Element references ---------- */
const els = {
  sidebar: document.getElementById('sidebar'),
  sidebarOverlay: document.getElementById('sidebarOverlay'),
  sidebarCollapse: document.getElementById('sidebarCollapse'),
  sidebarOpen: document.getElementById('sidebarOpen'),
  navHome: document.getElementById('navHome'),
  navApps: document.getElementById('navApps'),
  navStore: document.getElementById('navStore'),
  navCommand: document.getElementById('navCommand'),
  navSettings: document.getElementById('navSettings'),
  navInbox: document.getElementById('navInbox'),
  agentSales: document.getElementById('agentSales'),
  viewHome: document.getElementById('view-home'),
  viewSales: document.getElementById('view-sales'),
  viewZara: document.getElementById('view-zara'),
  viewApps: document.getElementById('view-apps'),
  viewStore: document.getElementById('view-store'),
  viewCommand: document.getElementById('view-command'),
  viewSettings: document.getElementById('view-settings'),
  viewInbox: document.getElementById('view-inbox'),
  copilot: document.getElementById('copilot'),
  zaraConversations: document.getElementById('zaraConversations'),
  zaraEmptyState: document.getElementById('zaraEmptyState'),
  workspaceTitle: document.getElementById('workspaceTitle'),
  salesMessages: document.getElementById('salesMessages'),
  zaraMessages: document.getElementById('zaraMessages'),
  salesInput: document.getElementById('salesInput'),
  zaraInput: document.getElementById('zaraInput'),
  salesSend: document.getElementById('salesSend'),
  zaraSend: document.getElementById('zaraSend'),
  zaraStop: document.getElementById('zaraStop'),
  foppyWrap: document.getElementById('foppyWrap'),
  foppyPanel: document.getElementById('foppyPanel'),
  foppyClose: document.getElementById('foppyClose'),
  foppyStatus: document.getElementById('foppyStatus'),
  foppySub: document.getElementById('foppySub'),
  foppyWaveform: document.getElementById('foppyWaveform'),
  foppyVoiceBtn: document.getElementById('foppyVoiceBtn'),
  foppyMuteBtn: document.getElementById('foppyMuteBtn'),
  zaraInbox: document.getElementById('zaraInbox'),
  inboxList: document.getElementById('inboxList'),
  inboxSearch: document.getElementById('inboxSearch'),
  inboxEmpty: document.getElementById('inboxEmpty'),
  inboxDetail: document.getElementById('inboxDetail'),
  inboxEmptyDetail: document.getElementById('inboxEmptyDetail'),
  inboxDetailName: document.getElementById('inboxDetailName'),
  inboxDetailRole: document.getElementById('inboxDetailRole'),
  inboxDetailAvatar: document.getElementById('inboxDetailAvatar'),
  inboxDetailStatusDot: document.getElementById('inboxDetailStatusDot'),
  inboxDetailStatusText: document.getElementById('inboxDetailStatusText'),
  inboxMessages: document.getElementById('inboxMessages'),
  inboxInput: document.getElementById('inboxInput'),
  inboxSend: document.getElementById('inboxSend'),
  inboxBack: document.getElementById('inboxBack'),
  zaraNewMessage: document.getElementById('zaraNewMessage'),
  zaraInboxOpen: document.getElementById('zaraInboxOpen'),
  zaraAttachments: document.getElementById('zaraAttachments'),
  zaraFileInput: document.getElementById('zaraFileInput'),
  zaraAttach: document.getElementById('zaraAttach'),
  zaraWebToggle: document.getElementById('zaraWebToggle'),
  zaraMic: document.getElementById('zaraMic'),
  zaraStatusText: document.getElementById('zaraStatusText'),
  employeeList: document.getElementById('employeeList'),
  employeeSearch: document.getElementById('employeeSearch'),
  employeeEmpty: document.getElementById('employeeEmpty'),
  // Conversation architecture elements
  conversationList: document.getElementById('conversationList'),
  conversationEmpty: document.getElementById('conversationEmpty'),
  conversationDetail: document.getElementById('conversationDetail'),
  conversationTitle: document.getElementById('conversationTitle'),
  conversationMessages: document.getElementById('conversationMessages'),
  conversationEmptyDetail: document.getElementById('conversationEmptyDetail'),
  backToListings: document.querySelector('.back-to-listings'),
  zaraInput: document.getElementById('zaraInput'),
};

/* ---------- Sidebar collapse persistence (restored from app.js) ---------- */
const K_SIDEBAR = 'aculyze.sidebar';
function setSidebarCollapsed(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', !!collapsed);
  try { localStorage.setItem(K_SIDEBAR, collapsed ? '1' : '0'); } catch { /* ignore */ }
}
function toggleSidebar() {
  const collapsed = document.body.classList.contains('sidebar-collapsed');
  setSidebarCollapsed(!collapsed);
}
// Restore collapsed state from localStorage on init
try { if (localStorage.getItem(K_SIDEBAR) === '1') { document.body.classList.add('sidebar-collapsed'); } } catch { /* ignore */ }
// Apply persisted theme + preferences on init
applyTheme(state.prefs.theme);
document.querySelector('#themeToggle')?.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  state.prefs.theme = next;
  savePrefs();
  applyTheme(next);
});
els.sidebarCollapse?.addEventListener('click', toggleSidebar);

/* Mobile drawer (<=1024px): sidebar is off-canvas, slides in over content */
const isDrawerViewport = () => window.matchMedia('(max-width: 1024px)').matches;
function openSidebarDrawer() {
  document.body.classList.add('sidebar-open');
  if (els.sidebarOverlay) {
    els.sidebarOverlay.hidden = false;
    els.sidebarOverlay.setAttribute('aria-hidden', 'false');
  }
}
function closeSidebarDrawer() {
  document.body.classList.remove('sidebar-open');
  if (els.sidebarOverlay) {
    els.sidebarOverlay.hidden = true;
    els.sidebarOverlay.setAttribute('aria-hidden', 'true');
  }
}
els.sidebarOpen?.addEventListener('click', () => {
  if (isDrawerViewport()) {
    if (document.body.classList.contains('sidebar-open')) closeSidebarDrawer();
    else openSidebarDrawer();
  } else {
    toggleSidebar();
  }
});
els.sidebarOverlay?.addEventListener('click', closeSidebarDrawer);
// Esc closes the drawer
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeSidebarDrawer();
    closeAppDrawer();
  }
});
// Choosing a nav item closes the drawer
document.querySelectorAll('.sidebar-item, .agent-item').forEach((btn) => {
  btn.addEventListener('click', () => { if (isDrawerViewport()) closeSidebarDrawer(); });
});
// Leaving the mobile viewport resets any open drawer
window.matchMedia('(max-width: 1024px)').addEventListener('change', closeSidebarDrawer);

// Keyboard shortcut: Ctrl/Cmd + B toggles sidebar
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    toggleSidebar();
  }
});

/* ---------- Zara copilot panel open/close (independent of the sidebar) ---------- */
const K_COPILOT = 'zara:copilot-collapsed:v1';
function setCopilotCollapsed(collapsed) {
  const c = !!collapsed;
  els.copilot?.classList.toggle('collapsed', c);
  document.body.classList.toggle('copilot-collapsed', c);
  try { localStorage.setItem(K_COPILOT, c ? '1' : '0'); } catch { /* ignore */ }
}
function openCopilot() { setCopilotCollapsed(false); }
function closeCopilot() { setCopilotCollapsed(true); }

// Restore persisted Zara state; default to open on desktop, closed as an overlay
// on tablet/mobile (which have no room for a permanent third column).
const compactMq = window.matchMedia('(max-width: 1024px)');
try {
  const stored = localStorage.getItem(K_COPILOT);
  setCopilotCollapsed(stored === null ? compactMq.matches : stored === '1');
} catch { setCopilotCollapsed(compactMq.matches); }

// The existing controls: close in the panel header, reopen on the collapsed rail.
document.getElementById('copilotCollapse')?.addEventListener('click', closeCopilot);
document.getElementById('copilotExpand')?.addEventListener('click', openCopilot);

// Crossing into a compact viewport turns the panel into a hidden overlay.
// Visual only — the persisted open/closed choice is left untouched.
compactMq.addEventListener?.('change', (e) => {
  if (e.matches) els.copilot?.classList.add('collapsed');
});

// Sidebar navigation - view switching
els.navHome?.addEventListener('click', () => setView('home'));
els.navInbox?.addEventListener('click', () => setView('inbox'));
els.agentSales?.addEventListener('click', () => setView('sales'));
els.navApps?.addEventListener('click', () => {
  setView('apps');
});
els.navStore?.addEventListener('click', () => setView('store'));
els.navCommand?.addEventListener('click', () => setView('command'));
els.navSettings?.addEventListener('click', () => {
  openSettings('account');
});

/* ---------- Aculyze Store — contact / free-trial dialog ---------- */
const storeContactOverlay = document.getElementById('storeContactOverlay');
const storeContactContext = document.getElementById('storeContactContext');
const storeContactMail = document.getElementById('storeContactMail');

function openStoreContact(app, reason) {
  if (!storeContactOverlay) return;
  if (storeContactContext) {
    storeContactContext.textContent = reason
      ? `${reason} — ${app}. Our team replies within one business day.`
      : `Questions about ${app}? Our team replies within one business day.`;
  }
  if (storeContactMail) {
    const subject = reason ? `${app} — ${reason}` : `Aculyze Store — ${app}`;
    storeContactMail.href = `mailto:admin@aculyze.in?subject=${encodeURIComponent(subject)}`;
  }
  storeContactOverlay.hidden = false;
}

function closeStoreContact() {
  if (storeContactOverlay) storeContactOverlay.hidden = true;
}

document.querySelectorAll('[data-contact-app]').forEach((btn) => {
  btn.addEventListener('click', () => {
    openStoreContact(
      btn.getAttribute('data-contact-app') || 'Aculyze Store',
      btn.getAttribute('data-contact-reason') || ''
    );
  });
});
document.getElementById('storeContactClose')?.addEventListener('click', closeStoreContact);
document.getElementById('storeContactDone')?.addEventListener('click', closeStoreContact);
storeContactOverlay?.addEventListener('click', (e) => {
  if (e.target === storeContactOverlay) closeStoreContact();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && storeContactOverlay && !storeContactOverlay.hidden) closeStoreContact();
});

/* ============================================================
   COMMAND CENTRE — plan selection, daily tasks, report mail,
   employee plans and real token usage.

   Everything the page edits is persisted on this device under
   the `cc.*` localStorage keys (report recipient, tasks, plan,
   per-employee plans). Server-backed data — token usage and the
   employee list — is fetched fresh each time the page opens.
   ============================================================ */
const ccStore = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`cc.${key}`);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`cc.${key}`, JSON.stringify(value));
    } catch { /* private mode / quota — page still works in-session */ }
  },
};

const ccEls = {
  refresh: document.getElementById('ccRefresh'),
  reportTo: document.getElementById('ccReportTo'),
  reportSave: document.getElementById('ccReportSave'),
  reportHint: document.getElementById('ccReportHint'),
  taskForm: document.getElementById('ccTaskForm'),
  taskInput: document.getElementById('ccTaskInput'),
  tasks: document.getElementById('ccTasks'),
  tasksEmpty: document.getElementById('ccTasksEmpty'),
  salesTokens: document.getElementById('ccSalesTokens'),
  salesCalls: document.getElementById('ccSalesCalls'),
  salesSplit: document.getElementById('ccSalesSplit'),
  zaraTokens: document.getElementById('ccZaraTokens'),
  zaraCalls: document.getElementById('ccZaraCalls'),
  totalTokens: document.getElementById('ccTotalTokens'),
  resetIn: document.getElementById('ccResetIn'),
  zaraPlanName: document.getElementById('ccZaraPlanName'),
  zaraPlanLimit: document.getElementById('ccZaraPlanLimit'),
  empBody: document.getElementById('ccEmpBody'),
  planFree: document.getElementById('ccPlanFree'),
  planAgents: document.getElementById('ccPlanAgents'),
};

function ccDayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 1234 → "1.2K", 4820000 → "4.8M" */
function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e5 ? 0 : 1)}K`;
  return String(v);
}

/* ---- Plan selection (no billing yet — selection only) ---- */
function ccApplyPlan(plan) {
  const isFree = plan !== 'agents';
  ccEls.planFree?.classList.toggle('selected', isFree);
  ccEls.planAgents?.classList.toggle('selected', !isFree);
  document.querySelectorAll('.cc-plan-btn').forEach((btn) => {
    const active = (btn.getAttribute('data-plan-select') === (isFree ? 'free' : 'agents'));
    btn.textContent = active ? 'Selected' : 'Select plan';
    btn.classList.toggle('primary', active);
  });
  if (ccEls.zaraPlanName) ccEls.zaraPlanName.textContent = isFree ? 'Free' : 'Agents';
  if (ccEls.zaraPlanLimit) {
    ccEls.zaraPlanLimit.textContent = isFree
      ? '200K tokens per user · per day'
      : 'Unlimited tokens · Maintenance + Coding agents';
  }
}

document.querySelectorAll('[data-plan-select]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const plan = btn.getAttribute('data-plan-select') === 'agents' ? 'agents' : 'free';
    ccStore.set('plan', plan);
    ccApplyPlan(plan);
    toast(plan === 'agents'
      ? 'Plan set to Agents — unlimited tokens (billing comes later)'
      : 'Plan set to Free — 200K tokens per user per day', 'info');
  });
});

/* ---- Daily sales report recipient ---- */
function ccSaveReportEmail() {
  const input = ccEls.reportTo;
  const hint = ccEls.reportHint;
  if (!input) return;
  const value = input.value.trim();
  if (!value || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    if (hint) hint.textContent = 'Enter a valid email address — e.g. reports@aculyze.in';
    input.focus();
    return;
  }
  ccStore.set('reportTo', value);
  if (hint) hint.textContent = `Saved — daily sales reports go to ${value}`;
  toast(`Daily sales report recipient: ${value}`, 'info');
}
ccEls.reportSave?.addEventListener('click', ccSaveReportEmail);
ccEls.reportTo?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); ccSaveReportEmail(); }
});

/* ---- Daily tasks (a fresh list for every calendar day) ---- */
function ccRenderTasks() {
  const list = ccStore.get(`tasks.${ccDayKey()}`, []);
  if (!ccEls.tasks) return;
  ccEls.tasks.innerHTML = '';
  list.forEach((task, index) => {
    const li = document.createElement('li');
    li.className = `cc-task${task.done ? ' done' : ''}`;

    const check = document.createElement('button');
    check.type = 'button';
    check.className = `cc-task-check${task.done ? ' on' : ''}`;
    check.setAttribute('aria-pressed', String(!!task.done));
    check.setAttribute('aria-label', task.done ? 'Mark as not done' : 'Mark as done');
    check.innerHTML = `<span class="material-symbols-outlined">${task.done ? 'check_circle' : 'check_circle_outline'}</span>`;
    check.addEventListener('click', () => {
      const tasks = ccStore.get(`tasks.${ccDayKey()}`, []);
      if (tasks[index]) tasks[index].done = !tasks[index].done;
      ccStore.set(`tasks.${ccDayKey()}`, tasks);
      ccRenderTasks();
    });

    const text = document.createElement('span');
    text.className = 'cc-task-text';
    text.textContent = task.text || '';

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'cc-task-del';
    del.setAttribute('aria-label', 'Delete task');
    del.textContent = '×';
    del.addEventListener('click', () => {
      const tasks = ccStore.get(`tasks.${ccDayKey()}`, []);
      tasks.splice(index, 1);
      ccStore.set(`tasks.${ccDayKey()}`, tasks);
      ccRenderTasks();
    });

    li.append(check, text, del);
    ccEls.tasks.appendChild(li);
  });
  if (ccEls.tasksEmpty) ccEls.tasksEmpty.hidden = list.length > 0;
}

ccEls.taskForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  const input = ccEls.taskInput;
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  const key = `tasks.${ccDayKey()}`;
  const tasks = ccStore.get(key, []);
  tasks.push({ text, done: false, at: Date.now() });
  ccStore.set(key, tasks);
  input.value = '';
  ccRenderTasks();
  input.focus();
});

/* ---- Employees — plan details (roster from Aculyze LMS) ---- */
async function ccRenderEmployees() {
  const body = ccEls.empBody;
  if (!body) return;
  const noteRow = (msg) => {
    body.innerHTML = '';
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'cc-table-note';
    td.textContent = msg;
    tr.appendChild(td);
    body.appendChild(tr);
  };

  try {
    const data = await loadEmployees();
    const list = (data && data.employees) || [];
    if (!list.length) {
      noteRow('No employees returned by Aculyze LMS yet.');
      return;
    }
    const plans = ccStore.get('empPlans', {});
    body.innerHTML = '';
    for (const emp of list) {
      const id = String(emp.id || emp.email || emp.name || `emp-${body.childElementCount}`);
      const plan = plans[id] === 'agents' ? 'agents' : 'free';

      const tr = document.createElement('tr');

      const tdName = document.createElement('td');
      const strong = document.createElement('strong');
      strong.textContent = emp.name || emp.email || 'Employee';
      tdName.appendChild(strong);
      if (emp.email) {
        const small = document.createElement('br');
        tdName.appendChild(small);
        const mail = document.createElement('span');
        mail.className = 'cc-hint';
        mail.textContent = emp.email;
        tdName.appendChild(mail);
      }

      const tdRole = document.createElement('td');
      tdRole.textContent = emp.role || '—';

      const tdPlan = document.createElement('td');
      const select = document.createElement('select');
      select.className = 'cc-plan-select';
      select.setAttribute('aria-label', `Plan for ${emp.name || 'employee'}`);
      for (const [value, label] of [['free', 'Free'], ['agents', 'Agents']]) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        if (value === plan) opt.selected = true;
        select.appendChild(opt);
      }

      const tdLimit = document.createElement('td');
      tdLimit.textContent = plan === 'free' ? '200K / day' : 'Unlimited';

      select.addEventListener('change', () => {
        const all = ccStore.get('empPlans', {});
        all[id] = select.value;
        ccStore.set('empPlans', all);
        tdLimit.textContent = select.value === 'free' ? '200K / day' : 'Unlimited';
        toast(`${emp.name || 'Employee'} → ${select.value === 'free' ? 'Free' : 'Agents'} plan`, 'info');
      });

      tdPlan.appendChild(select);
      tr.append(tdName, tdRole, tdPlan, tdLimit);
      body.appendChild(tr);
    }
  } catch (err) {
    noteRow(err && err.message ? err.message : 'Could not load employees.');
  }
}

/* ---- Token usage (server-side accounting, data/ai-usage.json) ---- */
async function ccRefreshUsage() {
  try {
    const u = await loadTokenUsage();
    const share = u.total && u.total.tokens
      ? `${Math.round((u.sales.tokens / u.total.tokens) * 100)}%`
      : '0%';
    if (ccEls.salesTokens) ccEls.salesTokens.textContent = fmtTokens(u.sales.tokens);
    if (ccEls.salesCalls) ccEls.salesCalls.textContent = String(u.sales.calls);
    if (ccEls.salesSplit) ccEls.salesSplit.textContent = share;
    if (ccEls.zaraTokens) ccEls.zaraTokens.textContent = fmtTokens(u.zara.tokens);
    if (ccEls.zaraCalls) ccEls.zaraCalls.textContent = String(u.zara.calls);
    if (ccEls.totalTokens) ccEls.totalTokens.textContent = fmtTokens(u.total.tokens);
  } catch {
    for (const el of [ccEls.salesTokens, ccEls.salesCalls, ccEls.salesSplit,
      ccEls.zaraTokens, ccEls.zaraCalls, ccEls.totalTokens]) {
      if (el) el.textContent = '—';
    }
  }
}

/* ---- "Plan expires in" — counts down to the daily quota reset ---- */
function ccTickReset() {
  const el = ccEls.resetIn;
  if (!el || state.activeView !== 'command') return;
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  let s = Math.max(0, Math.floor((midnight.getTime() - now.getTime()) / 1000));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const pad = (n) => String(n).padStart(2, '0');
  el.textContent = `${h}h ${pad(m)}m ${pad(s)}s`;
}
setInterval(ccTickReset, 1000);

/* ---- Open/refresh the whole page ---- */
function refreshCommandCentre() {
  ccApplyPlan(ccStore.get('plan', 'free'));
  const report = ccStore.get('reportTo', '');
  if (ccEls.reportTo && report) {
    ccEls.reportTo.value = report;
    if (ccEls.reportHint) ccEls.reportHint.textContent = `Saved — daily sales reports go to ${report}`;
  }
  ccRenderTasks();
  ccRenderEmployees();
  ccRefreshUsage();
  ccTickReset();
}
ccEls.refresh?.addEventListener('click', () => {
  refreshCommandCentre();
  toast('Command Centre refreshed', 'info');
});

// Home quick-open cards (Zara + Sales)
document.querySelectorAll('.home-card[data-open]').forEach((card) => {
  card.addEventListener('click', () => {
    const target = card.getAttribute('data-open');
    if (target === 'zara' || target === 'sales') setView(target);
  });
});

/* ---------- View/agent switching ---------- */
const VIEW_META = { home: true, inbox: true, zara: true, sales: true, apps: true, store: true, command: true, settings: true };
function switchAgent(agent) {
  if (agent !== 'sales' && agent !== 'zara') return;
  setView(agent);
}
function setView(view) {
  const next = VIEW_META[view] ? view : 'home';

  // Clear agent-specific state when switching away from an agent view
  if (state.activeView !== next) {
    if (next === 'home') {
      state.activeAgent = null;
      state.selectedConversationId = null;
    } else if (next === 'zara') {
      state.activeAgent = 'zara';
    } else if (next === 'sales') {
      state.activeAgent = 'sales';
    } else if (next === 'apps' || next === 'settings' || next === 'inbox' || next === 'store' || next === 'command') {
      state.activeAgent = null;
      state.selectedConversationId = null;
    }
  }

  state.activeView = next;

  // Keep sidebar active highlight in sync with the current view
  const navMap = { home: els.navHome, inbox: els.navInbox, sales: els.agentSales, apps: els.navApps, store: els.navStore, command: els.navCommand, settings: els.navSettings };
  Object.entries(navMap).forEach(([key, el]) => {
    if (!el) return;
    const isActive = key === next;
    el.classList.toggle('active', isActive);
    if (isActive) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });

  els.viewHome.classList.toggle('active', next === 'home');
  els.viewZara.classList.toggle('active', next === 'zara');
  els.viewSales.classList.toggle('active', next === 'sales');
  els.viewApps.classList.toggle('active', next === 'apps');
  els.viewStore.classList.toggle('active', next === 'store');
  els.viewCommand.classList.toggle('active', next === 'command');
  els.viewSettings.classList.toggle('active', next === 'settings');
  els.viewInbox.classList.toggle('active', next === 'inbox');

  // On compact viewports the Zara panel is an overlay: close it on navigation.
  // On desktop the persisted open/closed state is left untouched.
  if (compactMq.matches) {
    els.copilot?.classList.add('collapsed');
  }

  // --- Zara view ---
  if (next === 'zara') {
    renderConversationList();
    if (state.selectedConversationId) {
      showConversationDetail(state.selectedConversationId);
    } else {
      els.zaraConversations.hidden = false;
      els.conversationDetail.hidden = true;
      if (els.zaraEmptyState) els.zaraEmptyState.style.display = '';
      if (els.conversationEmpty) els.conversationEmpty.style.display = '';
    }
    // Update right panel header for Zara
    const copilotAgent = document.getElementById('copilotAgent');
    const copilotSubtitle = document.getElementById('copilotSubtitle');
    if (copilotAgent) copilotAgent.textContent = 'Zara';
    if (copilotSubtitle) copilotSubtitle.textContent = 'Research · General AI';
    if (els.workspaceTitle) {
      els.workspaceTitle.textContent = 'Zara Gen AI';
    }
    // Reset composer placeholder for Zara
    if (els.zaraInput) els.zaraInput.placeholder = 'Message Zara…';
    if (els.zaraInput) els.zaraInput.setAttribute('aria-label', 'Message Zara');
  }
  // --- Sales view ---
  else if (next === 'sales') {
    // Show Sales conversation panel on right (reuse same DOM elements)
    if (els.zaraConversations) els.zaraConversations.hidden = false;
    if (els.conversationDetail) els.conversationDetail.hidden = true;
    if (els.zaraEmptyState) els.zaraEmptyState.style.display = 'none';
    if (els.conversationEmpty) els.conversationEmpty.style.display = 'none';
    if (els.workspaceTitle) {
      els.workspaceTitle.textContent = 'Sales Agent';
    }
    // Update right panel header for Sales
    const copilotAgent = document.getElementById('copilotAgent');
    const copilotSubtitle = document.getElementById('copilotSubtitle');
    if (copilotAgent) copilotAgent.textContent = 'Sales Agent';
    if (copilotSubtitle) copilotSubtitle.textContent = 'Business Intelligence';
    // Sales-specific composer placeholder
    if (els.zaraInput) els.zaraInput.placeholder = 'Ask Sales Agent…';
    if (els.zaraInput) els.zaraInput.setAttribute('aria-label', 'Message Sales Agent');
    // Render sales conversation list
    renderSalesConversationList();
    // Load live sales dashboard data
    loadSalesDashboard();
    if (salesState.selectedConversationId) {
      showSalesConversationDetail(salesState.selectedConversationId);
    } else {
      if (els.conversationList) {
        els.conversationList.innerHTML = '';
        if (els.conversationEmpty) els.conversationEmpty.style.display = '';
      }
    }
  }
  // --- Apps view ---
  else if (next === 'apps') {
    if (els.zaraConversations) els.zaraConversations.hidden = true;
    if (els.conversationDetail) els.conversationDetail.hidden = true;
    if (els.zaraEmptyState) els.zaraEmptyState.style.display = 'none';
    if (els.conversationEmpty) els.conversationEmpty.style.display = 'none';
    const copilotAgent = document.getElementById('copilotAgent');
    const copilotSubtitle = document.getElementById('copilotSubtitle');
    if (copilotAgent) copilotAgent.textContent = 'Zara';
    if (copilotSubtitle) copilotSubtitle.textContent = 'Research · General AI';
    if (els.workspaceTitle) {
      els.workspaceTitle.textContent = 'Apps';
    }
    refreshApps();
  }
  // --- Settings view ---
  else if (next === 'settings') {
    if (els.zaraConversations) els.zaraConversations.hidden = true;
    if (els.conversationDetail) els.conversationDetail.hidden = true;
    if (els.zaraEmptyState) els.zaraEmptyState.style.display = 'none';
    if (els.conversationEmpty) els.conversationEmpty.style.display = 'none';
    const copilotAgent = document.getElementById('copilotAgent');
    const copilotSubtitle = document.getElementById('copilotSubtitle');
    if (copilotAgent) copilotAgent.textContent = 'Zara';
    if (copilotSubtitle) copilotSubtitle.textContent = 'Research · General AI';
    if (els.workspaceTitle) {
      els.workspaceTitle.textContent = 'Settings';
    }
  }
  // --- Inbox view ---
  else if (next === 'inbox') {
    if (els.zaraConversations) els.zaraConversations.hidden = true;
    if (els.conversationDetail) els.conversationDetail.hidden = true;
    if (els.zaraEmptyState) els.zaraEmptyState.style.display = 'none';
    if (els.conversationEmpty) els.conversationEmpty.style.display = 'none';
    const copilotAgent = document.getElementById('copilotAgent');
    const copilotSubtitle = document.getElementById('copilotSubtitle');
    if (copilotAgent) copilotAgent.textContent = 'Zara';
    if (copilotSubtitle) copilotSubtitle.textContent = 'Research · General AI';
    if (els.workspaceTitle) {
      els.workspaceTitle.textContent = 'Inbox';
    }
    refreshInbox();
  }
  // --- Store view ---
  else if (next === 'store') {
    if (els.zaraConversations) els.zaraConversations.hidden = true;
    if (els.conversationDetail) els.conversationDetail.hidden = true;
    if (els.zaraEmptyState) els.zaraEmptyState.style.display = 'none';
    if (els.conversationEmpty) els.conversationEmpty.style.display = 'none';
    const copilotAgent = document.getElementById('copilotAgent');
    const copilotSubtitle = document.getElementById('copilotSubtitle');
    if (copilotAgent) copilotAgent.textContent = 'Zara';
    if (copilotSubtitle) copilotSubtitle.textContent = 'Research · General AI';
    if (els.workspaceTitle) {
      els.workspaceTitle.textContent = 'Aculyze Store';
    }
  }
  // --- Command Centre view ---
  else if (next === 'command') {
    if (els.zaraConversations) els.zaraConversations.hidden = true;
    if (els.conversationDetail) els.conversationDetail.hidden = true;
    if (els.zaraEmptyState) els.zaraEmptyState.style.display = 'none';
    if (els.conversationEmpty) els.conversationEmpty.style.display = 'none';
    const copilotAgent = document.getElementById('copilotAgent');
    const copilotSubtitle = document.getElementById('copilotSubtitle');
    if (copilotAgent) copilotAgent.textContent = 'Zara';
    if (copilotSubtitle) copilotSubtitle.textContent = 'Research · General AI';
    if (els.workspaceTitle) {
      els.workspaceTitle.textContent = 'Command Centre';
    }
    refreshCommandCentre();
  }
  // --- Home view ---
  else {
    // Reset right panel header for Home
    const copilotAgent = document.getElementById('copilotAgent');
    const copilotSubtitle = document.getElementById('copilotSubtitle');
    if (copilotAgent) copilotAgent.textContent = 'Zara';
    if (copilotSubtitle) copilotSubtitle.textContent = 'Research · General AI';
    if (els.zaraConversations) els.zaraConversations.hidden = true;
    if (els.conversationDetail) els.conversationDetail.hidden = true;
    if (els.zaraEmptyState) els.zaraEmptyState.style.display = 'block';
    if (els.conversationEmpty) els.conversationEmpty.style.display = 'block';
    if (els.workspaceTitle) {
      els.workspaceTitle.textContent = 'Home • AI workspace';
    }
  }
}

/* ---------- Conversation list rendering ---------- */
function renderConversationList() {
  if (!els.conversationList) return;
  // Build list from conversationCache
  const cache = state.conversationCache;
  els.conversationList.innerHTML = '';
  
  if (!cache || cache.length === 0) {
    if (els.conversationEmpty) els.conversationEmpty.style.display = '';
    return;
  }
  
  if (els.conversationEmpty) els.conversationEmpty.style.display = 'none';
  
  // Pinned conversations first, then most recently updated
  const sorted = [...cache].sort((a, b) => {
    const pin = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    if (pin) return pin;
    return toMillis(b.updatedAt) - toMillis(a.updatedAt);
  });
  
  const ul = document.createElement('ul');
  ul.className = 'conversation-row-list';
  
  for (const conv of sorted) {
    const li = document.createElement('li');
    li.className = 'conversation-row has-actions';
    li.dataset.conversationId = conv.id;
    li.innerHTML = `
      <div class="conversation-avatar">Z</div>
      <div class="conversation-details">
        <span class="conversation-title">${conv.title || 'New conversation'}</span>
        <span class="conversation-preview">${conv.lastMessage ? truncate(conv.lastMessage, 60) : ''}</span>
      </div>
      <div class="conversation-meta">
        ${conv.pinned ? '<span class="material-symbols-outlined row-pin-ico" title="Pinned">push_pin</span>' : ''}
        <span class="conversation-time">${timeAgo(conv.updatedAt)}</span>
      </div>
      <div class="conversation-row-actions">
        <button class="row-act" data-act="pin" type="button" aria-label="${conv.pinned ? 'Unpin' : 'Pin'} conversation" title="${conv.pinned ? 'Unpin' : 'Pin'}">
          <span class="material-symbols-outlined"${conv.pinned ? ' data-on="1"' : ''}>push_pin</span>
        </button>
        <button class="row-act danger" data-act="delete" type="button" aria-label="Delete conversation" title="Delete">
          <span class="material-symbols-outlined">delete</span>
        </button>
      </div>
    `;
    li.querySelector('[data-act="pin"]').addEventListener('click', (e) => {
      e.stopPropagation();
      togglePinConversation(conv.id);
    });
    li.querySelector('[data-act="delete"]').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteConversation(conv.id);
    });
    li.addEventListener('click', () => selectConversation(conv.id));
    ul.appendChild(li);
  }
  
  els.conversationList.appendChild(ul);
}

/* ---------- Pin / delete conversation ---------- */
function togglePinConversation(id) {
  const conv = state.conversationCache.find((c) => c.id === id);
  if (!conv) return;
  conv.pinned = !conv.pinned;
  saveConversationCache();
  renderConversationList();
  toast(conv.pinned ? 'Pinned to top' : 'Unpinned');
}

async function deleteConversation(id) {
  const conv = state.conversationCache.find((c) => c.id === id);
  if (!conv) return;
  const ok = await showAppConfirm({
    title: 'Delete conversation',
    detail: `Delete "${conv.title || 'this conversation'}"? This cannot be undone.`,
    okLabel: 'Delete',
    cancelLabel: 'Cancel',
  });
  if (!ok) return;
  state.conversationCache = state.conversationCache.filter((c) => c.id !== id);
  // If the deleted conversation is open, close the detail panel
  if (state.selectedConversationId === id) {
    state.selectedConversationId = null;
    if (els.conversationDetail) els.conversationDetail.hidden = true;
    if (els.zaraConversations) els.zaraConversations.hidden = false;
    if (els.zaraEmptyState) els.zaraEmptyState.style.display = '';
    if (els.workspaceTitle) els.workspaceTitle.textContent = 'Zara Gen AI';
  }
  saveConversationCache();
  renderConversationList();
  toast('Conversation deleted');
}

/* ---------- Show conversation detail ---------- */
/** Render one stored message body.
 *  content may be a plain string OR an array of content parts (text + image_url)
 *  when the message carried image attachments — renderMarkdown() only takes strings. */
function renderMessageBody(msg) {
  const content = msg && msg.content;
  if (Array.isArray(content)) {
    let html = '';
    for (const part of content) {
      if (!part) continue;
      if (part.type === 'image_url' && part.image_url && part.image_url.url) {
        html += `<img class="msg-att" src="${part.image_url.url}" alt="Attached image">`;
      } else if (part.type === 'text' && part.text) {
        html += `<div class="msg-content">${renderMarkdown(String(part.text))}</div>`;
      }
    }
    return html || '<div class="msg-content"></div>';
  }
  const text = content ? String(content) : '';
  const textHtml = text ? `<div class="msg-content">${renderMarkdown(text)}</div>` : '';
  const atts = Array.isArray(msg && msg.attachments) ? msg.attachments : [];
  const attHtml = atts
    .map((a) => (a && a.dataUrl ? `<img class="msg-att" src="${a.dataUrl}" alt="Attached image">` : ''))
    .join('');
  return (textHtml + attHtml) || '<div class="msg-content"></div>';
}

function showConversationDetail(conversationId) {
  if (!els.conversationDetail) return;
  
  // Hide conversation list, show detail panel
  els.zaraConversations.hidden = true;
  els.conversationDetail.hidden = false;
  
  // Find the conversation in cache
  const conv = state.conversationCache.find((c) => c.id === conversationId);
  if (!conv) return;
  
  // Update title
  if (els.conversationTitle) {
    els.conversationTitle.textContent = conv.title || 'New conversation';
  }
  
  // Update last updated
  if (els.conversationEmptyDetail) {
    els.conversationEmptyDetail.style.display = 'none';
  }
  if (els.conversationMessages) {
    els.conversationMessages.innerHTML = '';
    if (conv.messages && conv.messages.length > 0) {
      // Render messages
      const messagesEl = document.createElement('div');
      messagesEl.className = 'conversation-message-list';
      for (const msg of conv.messages) {
        const msgEl = document.createElement('div');
        msgEl.className = `msg ${msg.role === 'assistant' ? 'agent' : msg.role}`;
        msgEl.innerHTML = `
          <div class="msg-body">
            ${renderMessageBody(msg)}
          </div>
        `;
        messagesEl.appendChild(msgEl);
      }
      els.conversationMessages.appendChild(messagesEl);
    } else if (els.conversationEmptyDetail) {
      els.conversationEmptyDetail.style.display = '';
    }
  }
  
  // Update back button
  if (els.backToListings) {
    els.backToListings.onclick = () => {
      state.selectedConversationId = null;
      renderConversationList();
      if (els.conversationDetail) els.conversationDetail.hidden = true;
      if (els.zaraConversations) els.zaraConversations.hidden = false;
      if (els.zaraEmptyState) els.zaraEmptyState.style.display = '';
      if (els.conversationEmpty) els.conversationEmpty.style.display = '';
      if (els.workspaceTitle) els.workspaceTitle.textContent = 'Zara Gen AI';
    };
  }
  
  // Scroll to bottom
  if (els.conversationMessages) {
    els.conversationMessages.scrollTop = els.conversationMessages.scrollHeight;
  }
}

/* ---------- Select conversation ---------- */
function selectConversation(conversationId) {
  if (conversationId === state.selectedConversationId) {
    // Deselect
    state.selectedConversationId = null;
    renderConversationList();
    if (els.conversationDetail) {
      els.conversationDetail.hidden = true;
      if (els.zaraConversations) els.zaraConversations.hidden = false;
      if (els.zaraEmptyState) els.zaraEmptyState.style.display = '';
      if (els.conversationEmpty) els.conversationEmpty.style.display = '';
    }
    if (els.workspaceTitle) {
      els.workspaceTitle.textContent = 'Zara Gen AI';
    }
    return;
  }
  
  // Select conversation
  state.selectedConversationId = conversationId;
  
  // Update cache: mark as recent
  const cache = state.conversationCache;
  const conv = cache.find((c) => c.id === conversationId);
  if (conv) {
    conv.updatedAt = Date.now();
    conv.accessedAt = Date.now();
    saveConversationCache();
  }
  
  renderConversationList();
  showConversationDetail(conversationId);
  
  // Center workspace title
  if (els.workspaceTitle) {
    els.workspaceTitle.textContent = 'Zara Gen AI';
  }
}

/* ---------- New conversation ---------- */
function newConversation() {
  // Create new conversation object
  const conv = {
    id: generateConversationId(),
    agent: 'zara',
    title: 'New conversation',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
  };
  
  // Add to cache
  state.conversationCache.unshift(conv);
  saveConversationCache();
  renderConversationList();
  
  // Select the new conversation
  selectConversation(conv.id);
  
  // Focus the composer
  if (els.zaraInput) {
    els.zaraInput.focus();
  }
  
  toast('New conversation started');
}

/* ---------- Helper functions ---------- */
function generateConversationId() {
  return `conv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
}
/* updatedAt may be an epoch number or an ISO string — normalise to millis */
function toMillis(ts) {
  if (typeof ts === 'number') return ts;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? 0 : t;
}
function timeAgo(timestamp) {
  if (!timestamp) return 'Just now';
  const diff = Date.now() - toMillis(timestamp);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return 'Just now';
  if (diff < hour) return `${Math.floor(diff / minute)} min ago`;
  if (diff < day) return `${Math.floor(diff / hour)} hr ago`;
  return `${Math.floor(diff / day)} day ago`;
}

/* ---------- Center workspace state ---------- */
function updateCenterWorkspace() {
  if (state.activeView !== 'zara') return;
  
  // Center shows Zara workspace, not conversation messages
  if (els.workspaceTitle) {
    if (state.selectedConversationId) {
      const conv = state.conversationCache.find((c) => c.id === state.selectedConversationId);
      els.workspaceTitle.textContent = conv ? conv.title : 'Zara Gen AI';
    } else {
      els.workspaceTitle.textContent = 'Zara Gen AI';
    }
  }
}

/* ---------- Toast notifications ---------- */
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  const root = document.getElementById('toastRoot');
  if (root) {
    root.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, 2600);
  }
}

/* ---------- Zara composer — auto-grow textarea ---------- */
function autoGrowTextarea() {
  if (!els.zaraInput) return;
  els.zaraInput.style.height = 'auto';
  els.zaraInput.style.height = Math.min(els.zaraInput.scrollHeight, 220) + 'px';
}

/** Send is enabled when there is text OR a pending image, and nothing is in flight. */
function syncSendButton() {
  if (!els.zaraSend) return;
  if (state.abortCtrl || state.activeRequest) { els.zaraSend.disabled = true; return; }
  const hasText = !!els.zaraInput?.value.trim();
  const hasAtt = !!(state.attachments && state.attachments.length);
  els.zaraSend.disabled = !(hasText || hasAtt);
}

/* ---------- Send Zara message ---------- */
/* ---------- Connected apps: confirm modal + chat tool steps ---------- */
let appConfirmDone = null;

/** Promise-based confirm dialog for write actions (send email, etc.). */
function showAppConfirm({ title, detail, preview, okLabel = 'Confirm', cancelLabel = 'Cancel' }) {
  let modal = document.getElementById('appConfirmModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'appConfirmModal';
    modal.className = 'utility-overlay';
    modal.innerHTML = `
      <section class="utility-dialog" role="dialog" aria-modal="true" aria-labelledby="appConfirmTitle">
        <header>
          <div><small>Aculyze AI Studio</small><h2 id="appConfirmTitle">Confirm</h2></div>
          <button class="icon-btn ghost" id="appConfirmClose" type="button" aria-label="Close">×</button>
        </header>
        <div class="utility-content">
          <p id="appConfirmDetail" class="utility-status-line"></p>
          <div id="appConfirmPreview"></div>
          <div class="utility-actions" style="flex-direction: row; gap: 8px; margin-top: 10px;">
            <button class="utility-secondary" id="appConfirmCancel" type="button">Cancel</button>
            <button class="utility-primary" id="appConfirmOk" type="button">Confirm</button>
          </div>
        </div>
      </section>`;
    document.body.appendChild(modal);
  }
  if (appConfirmDone) appConfirmDone(false); // a pending confirm loses to a new one

  modal.querySelector('#appConfirmTitle').textContent = title || 'Confirm';
  const detailEl = modal.querySelector('#appConfirmDetail');
  detailEl.textContent = detail || '';
  detailEl.hidden = !detail;

  const pv = modal.querySelector('#appConfirmPreview');
  pv.innerHTML = '';
  (preview || []).forEach((row) => {
    const el = document.createElement('div');
    el.className = 'settings-row';
    const l = document.createElement('strong');
    l.textContent = row.label;
    const v = document.createElement('span');
    v.textContent = row.value;
    v.style.whiteSpace = 'pre-wrap';
    v.style.overflowWrap = 'anywhere';
    el.append(l, v);
    pv.appendChild(el);
  });

  modal.querySelector('#appConfirmOk').textContent = okLabel;
  modal.querySelector('#appConfirmCancel').textContent = cancelLabel || 'Cancel';
  modal.hidden = false;
  setTimeout(() => modal.querySelector('#appConfirmOk').focus(), 60);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      modal.hidden = true;
      document.removeEventListener('keydown', onKey, true);
      if (appConfirmDone === finish) appConfirmDone = null;
      resolve(val);
    };
    appConfirmDone = finish;
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
    }
    document.addEventListener('keydown', onKey, true);
    modal.querySelector('#appConfirmOk').onclick = () => finish(true);
    modal.querySelector('#appConfirmCancel').onclick = () => finish(false);
    modal.querySelector('#appConfirmClose').onclick = () => finish(false);
    modal.onclick = (e) => { if (e.target === modal) finish(false); };
  });
}

/** Render a tool step ("✓ Found 5 emails") in the open conversation. */
function addToolStep(text) {
  if (!els.conversationDetail || els.conversationDetail.hidden || !els.conversationMessages) return;
  const empty = els.conversationMessages.querySelector('.conversation-empty');
  if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = 'tool-step';
  el.textContent = text;
  els.conversationMessages.appendChild(el);
  els.conversationMessages.scrollTop = els.conversationMessages.scrollHeight;
}

/* ---------- Live "thinking / fetching" indicator shown while awaiting a reply ----------
   One request at a time, so a single module-level bubble is enough. */
let thinkingEl = null;
let thinkingTimer = null;
let thinkingReasonAcc = '';

function showThinking(label = 'Thinking') {
  removeThinking();
  if (!els.conversationDetail || els.conversationDetail.hidden || !els.conversationMessages) return;
  const empty = els.conversationMessages.querySelector('.conversation-empty');
  if (empty) empty.remove();
  thinkingEl = document.createElement('div');
  thinkingEl.className = 'msg agent thinking';
  thinkingEl.innerHTML = `
    <div class="msg-body">
      <div class="thinking-row">
        <span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="thinking-text">${label}</span>
        <span class="thinking-elapsed">0s</span>
      </div>
      <div class="thinking-reason" hidden></div>
    </div>`;
  els.conversationMessages.appendChild(thinkingEl);
  const startedAt = Date.now();
  thinkingTimer = setInterval(() => {
    if (!thinkingEl) return;
    const el = thinkingEl.querySelector('.thinking-elapsed');
    if (el) el.textContent = `${Math.round((Date.now() - startedAt) / 1000)}s`;
  }, 1000);
  els.conversationMessages.scrollTop = els.conversationMessages.scrollHeight;
}

/** Update the label, and/or append a chunk of live reasoning text. */
function setThinking(label, reason) {
  if (!thinkingEl) return;
  if (label != null) {
    const t = thinkingEl.querySelector('.thinking-text');
    if (t) t.textContent = label;
  }
  if (reason != null) {
    thinkingReasonAcc += reason;
    const r = thinkingEl.querySelector('.thinking-reason');
    if (r) {
      r.hidden = false;
      // keep only the tail so a long CoT never balloons the bubble
      r.textContent = thinkingReasonAcc.length > 700
        ? '…' + thinkingReasonAcc.slice(-700)
        : thinkingReasonAcc;
    }
    if (els.conversationMessages) els.conversationMessages.scrollTop = els.conversationMessages.scrollHeight;
  }
}

function removeThinking() {
  if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; }
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  thinkingReasonAcc = '';
}

/**
 * Build user message content with optional image attachments.
 * Attachments limited to 4 images max.
 */
function buildUserContent(text, attachments = []) {
  if (!attachments || attachments.length === 0) {
    return { role: 'user', content: text || '' };
  }

  const parts = [];

  // Add text first if present
  if (text && text.trim()) {
    parts.push({ type: 'text', text: text.trim() });
  }

  // Add up to 4 image attachments
  const imageAttachments = attachments.slice(0, 4).filter(a => a.dataUrl && a.dataUrl.startsWith('data:image/'));
  for (const att of imageAttachments) {
    parts.push({
      type: 'image_url',
      image_url: { url: att.dataUrl },
    });
  }

  // If only images, provide a default text
  if (parts.length === 0 || (parts.length === imageAttachments.length && !text.trim())) {
    parts.push({ type: 'text', text: 'Image attachment' });
  }

  return { role: 'user', content: parts };
}

async function sendZaraMessage() {
  if (!els.zaraInput) return;
  const text = els.zaraInput.value.trim();
  const hasAtt = state.attachments && state.attachments.length > 0;
  if (state.activeRequest || state.abortCtrl) return; // a reply is already in flight
  if (!text && !hasAtt) return;
  state.activeRequest = true;

  // One outer try/catch/finally for the WHOLE send so the composer always
  // recovers (button, stop control, thinking bubble) even if setup throws.
  let conv = null; // hoisted: the catch below needs it
  try {
  els.zaraInput.value = '';
  els.zaraInput.style.height = 'auto';
  if (els.zaraSend) els.zaraSend.disabled = true;
  if (els.zaraStop) els.zaraStop.hidden = false;

  const convId = state.selectedConversationId || null;
  if (!convId) {
    // Auto-create a conversation if none selected
    newConversation();
  }

  const finalConvId = state.selectedConversationId;
  conv = state.conversationCache.find((c) => c.id === finalConvId);

  // Add user message to cache
  if (conv) {
    const userContent = buildUserContent(text, state.attachments);
    conv.messages.push({
      role: 'user',
      content: userContent.content,
      attachments: state.attachments.slice(0, 4),
    });
    conv.updatedAt = Date.now();
    saveConversationCache();
    renderConversationList();
  }

  // Show in conversation detail if open
  if (els.conversationDetail && !els.conversationDetail.hidden) {
    const msgEl = document.createElement('div');
    msgEl.className = 'msg user';
    msgEl.innerHTML = `<div class="msg-body">${renderMessageBody({ content: text, attachments: state.attachments })}</div>`;
    if (els.conversationMessages) {
      const empty = els.conversationMessages.querySelector('.conversation-empty');
      if (empty) empty.remove();
      els.conversationMessages.appendChild(msgEl);
      els.conversationMessages.scrollTop = els.conversationMessages.scrollHeight;
    }
  }

  // Live status: show a "thinking" bubble right away so the wait is visible
  showThinking('Thinking…');

  // ---- Connected apps (Gmail, Calendar, LMS…): plan tools, run reads,
  //      confirm writes (§10–§12). Never silent — write actions need approval.
  let integrationSystem = null;   // prepended as ephemeral system message
  let integrationSources = [];
  // appsState loads lazily (only when the Apps page opens) — fetch once here
  // if we've never seen it, so a fresh session still gets app-aware answers.
  if (!appsState.apps.length) {
    try { await refreshApps(); } catch { /* non-fatal: answer without app context */ }
  }
  if (appsState.apps.some((a) => a.status === 'connected')) {
    setThinking('Checking connected apps…');
    try {
      const r = await resolveIntegrations(text);
      if (r.confirm) {
        const ok = await showAppConfirm({
          title: r.confirm.title,
          detail: r.confirm.detail,
          preview: r.confirm.preview,
          okLabel: r.confirm.verb || 'Confirm',
          cancelLabel: 'Cancel',
        });
        if (!ok) {
          addToolStep('Action cancelled — nothing was sent');
          toast('Action cancelled');
          integrationSystem =
            'The user CANCELLED the action they were asked to confirm. Tell them briefly that nothing was sent or created. Do not perform the action.';
        } else {
          addToolStep(`${r.confirm.icon} ${r.confirm.appName} — ${r.confirm.verb}…`);
          try {
            const ex = await executeIntegration({ tool: r.confirm.tool, args: r.confirm.args, confirm: true });
            if (ex.step) addToolStep(ex.step.text);
            if (ex.context) integrationSystem = ex.context;
            if (ex.sources) integrationSources = ex.sources;
            toast(`${r.confirm.icon} ${ex.summary || 'Done'}`);
          } catch (execErr) {
            addToolStep(`✗ ${execErr.message || 'Action failed'}`);
            toast(execErr.message || 'Action failed', 'error');
            integrationSystem = `The action FAILED: ${execErr.message}. Tell the user briefly and do not claim the action succeeded.`;
          }
        }
      } else if (r.notice) {
        addToolStep(r.notice);
        toast(r.notice);
        integrationSystem = `NOTE FOR THE ANSWER: ${r.notice} If it matters to the user's request, mention it naturally in your reply.`;
      } else if (r.context) {
        (r.steps || []).forEach((s) => addToolStep(s.text));
        integrationSystem = r.context;
        integrationSources = r.sources || [];
      }
    } catch (err) {
      // Non-fatal: answer without app context
      addToolStep(err.message || 'Connected apps unavailable');
    }
  }

  // Build user message content including image attachments
  const userMessageContent = buildUserContent(text, state.attachments);

  // Stream response from API
  setThinking('Thinking…');
  state.abortCtrl = new AbortController();
  let acc = '';
    // Build messages with proper image serialization
    const chatMessages = [
      { role: 'system', content: SYSTEM_PROMPTS.zara },
      ...(integrationSystem ? [{ role: 'system', content: integrationSystem }] : []),
    ];

    // Add history with proper content format
    if (conv) {
      for (const m of conv.messages.slice(-12)) {
        if (m.attachments && m.attachments.length > 0) {
          // Convert stored content back to proper format with image parts
          const content = m.content;
          chatMessages.push({
            role: m.role,
            content: Array.isArray(content) ? content : content,
          });
        } else {
          chatMessages.push({ role: m.role, content: m.content });
        }
      }
    }

    chatMessages.push(userMessageContent);

    const res = await streamChat({
      messages: chatMessages,
      signal: state.abortCtrl.signal,
      onReasoning: (chunk) => {
        // Surface the model's real reasoning stream while it thinks
        setThinking('Thinking…', chunk);
      },
      onToken: (tok, full) => {
        acc = full;
        removeThinking(); // first token: the answer has started
        if (els.conversationDetail && !els.conversationDetail.hidden) {
          // Update or create assistant bubble
          let bubble = els.conversationMessages?.querySelector('.msg.agent.streaming');
          if (!bubble) {
            bubble = document.createElement('div');
            bubble.className = 'msg agent streaming';
            bubble.innerHTML = '<div class="msg-body"><div class="msg-content"></div></div>';
            if (els.conversationMessages) els.conversationMessages.appendChild(bubble);
          }
          const contentDiv = bubble.querySelector('.msg-content');
          if (contentDiv) contentDiv.innerHTML = renderMarkdown(acc);
          els.conversationMessages.scrollTop = els.conversationMessages.scrollHeight;
        }
      },
    });
    const finalText = res.content || acc || '(no response)';

    // Save assistant message to cache
    if (conv) {
      const srcs = [...(res.sources || []), ...integrationSources];
      conv.messages.push({ role: 'assistant', content: finalText, sources: srcs });
      conv.updatedAt = Date.now();
      saveConversationCache();
    }

    // Clear attachments after successful send
    clearAttachments();

    // Final render in detail panel
    if (els.conversationDetail && !els.conversationDetail.hidden) {
      let bubble = els.conversationMessages?.querySelector('.msg.agent.streaming');
      if (bubble) {
        bubble.classList.remove('streaming');
        const contentDiv = bubble.querySelector('.msg-content');
        if (contentDiv) contentDiv.innerHTML = renderMarkdown(finalText);
      }
      els.conversationMessages.scrollTop = els.conversationMessages.scrollHeight;
    }
  } catch (err) {
    if (state.abortCtrl?.signal.aborted) {
      toast('Message stopped');
    } else {
      toast('Error: ' + (err?.message || 'Something went wrong'), 'error');
      if (conv) conv.messages.pop(); // remove the unanswered user turn
      // Clear attachments even on error
      clearAttachments();
    }
  } finally {
    removeThinking();
    state.abortCtrl = null;
    state.activeRequest = null;
    syncSendButton();
    if (els.zaraStop) els.zaraStop.hidden = true;
    autoGrowTextarea();
  }
}

/** Clear pending attachments after sending */
function clearAttachments() {
  if (state.attachments && state.attachments.length > 0) {
    state.attachments = [];
    if (els.zaraAttachments) els.zaraAttachments.hidden = true;
  }
}

/* ---------- Stop Zara ---------- */
function stopZara() {
  if (state.abortCtrl) {
    state.abortCtrl.abort();
  }
  if (els.zaraStop) els.zaraStop.hidden = true;
  syncSendButton();
}

/* ---------- Composer event listeners (dispatch by active agent) ---------- */
els.zaraSend?.addEventListener('click', () => {
  if (state.activeAgent === 'sales') {
    sendSalesMessage();
  } else {
    sendZaraMessage();
  }
});
els.zaraStop?.addEventListener('click', () => {
  if (state.activeAgent === 'sales') {
    stopSales();
  } else {
    stopZara();
  }
});

els.zaraInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (state.activeAgent === 'sales') {
      sendSalesMessage();
    } else {
      sendZaraMessage();
    }
  }
  autoGrowTextarea();
});

els.zaraInput?.addEventListener('input', () => {
  autoGrowTextarea();
  syncSendButton();
});

/* ---------- File attachment (shared by picker, paste and drag-drop) ---------- */
const MAX_ATTACHMENTS = 4;

/** Add a chip to the composer for one already-decoded image. */
function appendAttachmentChip(att) {
  state.attachments.push(att);
  if (!els.zaraAttachments) return;
  els.zaraAttachments.hidden = false;
  const chip = document.createElement('div');
  chip.className = 'chip-image';
  chip.innerHTML = `<img src="${att.dataUrl}" alt=""><small></small><button class="chip-del" type="button" aria-label="Remove attachment">&times;</button>`;
  chip.querySelector('small').textContent = att.name;
  chip.querySelector('.chip-del')?.addEventListener('click', () => {
    state.attachments = state.attachments.filter((a) => a !== att);
    chip.remove();
    if (state.attachments.length === 0) els.zaraAttachments.hidden = true;
    syncSendButton();
  });
  els.zaraAttachments.appendChild(chip);
}

/** Read a list of File objects, keeping images only (max 4 per message). */
function addImageFiles(files) {
  const images = Array.from(files || []).filter((f) => f && f.type.startsWith('image/'));
  if (!images.length) return 0;
  let added = 0;
  for (const file of images) {
    if (state.attachments.length >= MAX_ATTACHMENTS) {
      toast(`Up to ${MAX_ATTACHMENTS} images per message`, 'error');
      break;
    }
    added++;
    const reader = new FileReader();
    reader.onload = (ev) => {
      appendAttachmentChip({ name: file.name || 'image', type: file.type, dataUrl: ev.target.result });
      syncSendButton(); // an image alone is enough to allow sending
    };
    reader.onerror = () => toast(`Could not read ${file.name}`, 'error');
    reader.readAsDataURL(file);
  }
  return added;
}

els.zaraAttach?.addEventListener('click', () => {
  els.zaraFileInput?.click();
});

els.zaraFileInput?.addEventListener('change', (e) => {
  addImageFiles(e.target.files);
  e.target.value = '';
});

/* Paste an image from the clipboard straight into the composer */
els.zaraInput?.addEventListener('paste', (e) => {
  const dt = e.clipboardData;
  if (!dt) return;
  // Screenshots usually land in .files; some browsers only expose .items
  let files = Array.from(dt.files || []);
  if (!files.length && dt.items) {
    files = Array.from(dt.items)
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter(Boolean);
  }
  if (!files.length) return; // plain text — let the browser handle it
  const added = addImageFiles(files);
  if (added) {
    e.preventDefault();
    toast(added === 1 ? 'Image pasted' : `${added} images pasted`);
  }
});

/* Drag & drop images onto the chat panel / composer.
   The composer lives INSIDE the detail panel, so every handler stops
   propagation — otherwise one drop would bubble and attach each image twice. */
function wireImageDrop(el) {
  if (!el) return;
  let depth = 0;
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

  el.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    depth++;
    el.classList.add('drag-over');
  });
  el.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  });
  // dragleave may report no `types` in some browsers — don't gate on it
  el.addEventListener('dragleave', (e) => {
    e.stopPropagation();
    depth = Math.max(0, depth - 1);
    if (!depth) el.classList.remove('drag-over');
  });
  el.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    depth = 0;
    el.classList.remove('drag-over');
    const added = addImageFiles(e.dataTransfer.files);
    if (added) toast(added === 1 ? 'Image attached' : `${added} images attached`);
    else toast('Drop image files (PNG, JPEG, WebP or GIF)', 'error');
  });
}
wireImageDrop(document.querySelector('.composer.zara-composer'));
wireImageDrop(els.conversationDetail);

/* ---------- Web research toggle ---------- */
els.zaraWebToggle?.addEventListener('click', (e) => {
  const pressed = els.zaraWebToggle.getAttribute('aria-pressed') === 'true';
  els.zaraWebToggle.setAttribute('aria-pressed', String(!pressed));
  els.zaraWebToggle.classList.toggle('active', !pressed);
  state.prefs.webResearch = !pressed;
  savePrefs();
  toast('Web research ' + (!pressed ? 'on' : 'off'));
});

/* ---------- Mic / voice ---------- */
els.zaraMic?.addEventListener('click', (e) => {
  const pressed = els.zaraMic.getAttribute('aria-pressed') === 'true';
  els.zaraMic.setAttribute('aria-pressed', String(!pressed));
  els.zaraMic.classList.toggle('listening', !pressed);
  toast(!pressed ? 'Listening...' : 'Microphone off');
});

/* ========================================================================
   SALES AGENT — completely separate state from Zara
   Uses the same right-panel DOM elements but with isolated Sales state.
   ======================================================================== */

/* ---------- Sales conversation list rendering ---------- */
function renderSalesConversationList() {
  if (!els.conversationList) return;
  const cache = salesState.conversationCache;
  els.conversationList.innerHTML = '';

  if (!cache || cache.length === 0) {
    if (els.conversationEmpty) els.conversationEmpty.style.display = '';
    return;
  }

  if (els.conversationEmpty) els.conversationEmpty.style.display = 'none';

  const ul = document.createElement('ul');
  ul.className = 'conversation-row-list';

  for (const conv of cache) {
    const li = document.createElement('li');
    li.className = 'conversation-row';
    li.dataset.conversationId = conv.id;
    li.dataset.agent = conv.agent || 'sales';
    li.innerHTML = `
      <div class="conversation-avatar">S</div>
      <div class="conversation-details">
        <span class="conversation-title">${conv.title || 'New sales chat'}</span>
        <span class="conversation-preview">${conv.lastMessage ? truncate(conv.lastMessage, 60) : ''}</span>
      </div>
      <div class="conversation-meta">
        <span class="conversation-time">${timeAgo(conv.updatedAt)}</span>
      </div>
    `;
    li.addEventListener('click', () => selectSalesConversation(conv.id));
    ul.appendChild(li);
  }

  els.conversationList.appendChild(ul);
}

/* ---------- Show Sales conversation detail ---------- */
function showSalesConversationDetail(conversationId) {
  if (!els.conversationDetail) return;

  els.zaraConversations.hidden = true;
  els.conversationDetail.hidden = false;

  const conv = salesState.conversationCache.find((c) => c.id === conversationId);
  if (!conv) return;

  if (els.conversationTitle) {
    els.conversationTitle.textContent = conv.title || 'Sales conversation';
  }

  if (els.conversationEmptyDetail) {
    els.conversationEmptyDetail.style.display = 'none';
  }

  if (els.conversationMessages) {
    els.conversationMessages.innerHTML = '';
    if (conv.messages && conv.messages.length > 0) {
      const messagesEl = document.createElement('div');
      messagesEl.className = 'conversation-message-list';
      for (const msg of conv.messages) {
        const msgEl = document.createElement('div');
        msgEl.className = `msg ${msg.role === 'assistant' ? 'agent' : msg.role}`;
        msgEl.innerHTML = `
          <div class="msg-body">
            ${renderMessageBody(msg)}
          </div>
        `;
        messagesEl.appendChild(msgEl);
      }
      els.conversationMessages.appendChild(messagesEl);
    } else if (els.conversationEmptyDetail) {
      els.conversationEmptyDetail.style.display = '';
    }
  }

  if (els.backToListings) {
    els.backToListings.onclick = () => {
      salesState.selectedConversationId = null;
      renderSalesConversationList();
      if (els.conversationDetail) els.conversationDetail.hidden = true;
      if (els.zaraConversations) els.zaraConversations.hidden = false;
      if (els.zaraEmptyState) els.zaraEmptyState.style.display = '';
      if (els.conversationEmpty) els.conversationEmpty.style.display = '';
      if (els.workspaceTitle) els.workspaceTitle.textContent = 'Sales Agent';
    };
  }

  if (els.conversationMessages) {
    els.conversationMessages.scrollTop = els.conversationMessages.scrollHeight;
  }
}

/* ---------- Select Sales conversation ---------- */
function selectSalesConversation(conversationId) {
  if (conversationId === salesState.selectedConversationId) {
    salesState.selectedConversationId = null;
    renderSalesConversationList();
    if (els.conversationDetail) {
      els.conversationDetail.hidden = true;
      els.zaraConversations.hidden = false;
      if (els.zaraEmptyState) els.zaraEmptyState.style.display = '';
      if (els.conversationEmpty) els.conversationEmpty.style.display = '';
    }
    if (els.workspaceTitle) {
      els.workspaceTitle.textContent = 'Sales Agent';
    }
    return;
  }

  salesState.selectedConversationId = conversationId;

  const cache = salesState.conversationCache;
  const conv = cache.find((c) => c.id === conversationId);
  if (conv) {
    conv.updatedAt = Date.now();
    conv.accessedAt = Date.now();
    saveSalesConversationCache();
  }

  renderSalesConversationList();
  showSalesConversationDetail(conversationId);

  if (els.workspaceTitle) {
    els.workspaceTitle.textContent = 'Sales Agent';
  }
}

/* ---------- New Sales conversation ---------- */
function newSalesConversation() {
  const conv = {
    id: generateConversationId(),
    agent: 'sales',
    title: 'New sales chat',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
  };

  salesState.conversationCache.unshift(conv);
  saveSalesConversationCache();
  renderSalesConversationList();
  selectSalesConversation(conv.id);

  if (els.zaraInput) {
    els.zaraInput.focus();
  }

  toast('New sales conversation started');
}

/* ---------- Send Sales message ---------- */
async function sendSalesMessage() {
  if (!els.zaraInput) return;
  const text = els.zaraInput.value.trim();
  if (!text || salesState.activeRequest) return;

  els.zaraInput.value = '';
  els.zaraInput.style.height = 'auto';
  if (els.zaraSend) els.zaraSend.disabled = true;
  if (els.zaraStop) els.zaraStop.hidden = false;

  if (!salesState.selectedConversationId) {
    newSalesConversation();
  }

  const finalConvId = salesState.selectedConversationId;
  const conv = salesState.conversationCache.find((c) => c.id === finalConvId);

  if (conv) {
    conv.messages.push({ role: 'user', content: text });
    conv.updatedAt = Date.now();
    saveSalesConversationCache();
    renderSalesConversationList();
  }

  if (els.conversationDetail && !els.conversationDetail.hidden) {
    const msgEl = document.createElement('div');
    msgEl.className = 'msg user';
    msgEl.innerHTML = `<div class="msg-body"><div class="msg-content">${renderMarkdown(text)}</div></div>`;
    if (els.conversationMessages) {
      const empty = els.conversationMessages.querySelector('.conversation-empty');
      if (empty) empty.remove();
      els.conversationMessages.appendChild(msgEl);
      els.conversationMessages.scrollTop = els.conversationMessages.scrollHeight;
    }
  }

  salesState.abortCtrl = new AbortController();
  let acc = '';

  showThinking('Thinking…');

  try {
    // Use Sales Agent dedicated chat endpoint — backend fetches live LMS data,
    // extracts structured facts, and answers from real data only.
    const res = await salesChat({
      messages: [
        ...(conv ? conv.messages.slice(-12).map((m) => ({ role: m.role, content: m.content })) : []).filter(Boolean),
        { role: 'user', content: text },
      ],
      signal: salesState.abortCtrl.signal,
      onToken: (tok, full) => {
        acc = full;
        removeThinking();
        if (els.conversationDetail && !els.conversationDetail.hidden) {
          let bubble = els.conversationMessages?.querySelector('.msg.agent.streaming');
          if (!bubble) {
            bubble = document.createElement('div');
            bubble.className = 'msg agent streaming';
            bubble.innerHTML = '<div class="msg-body"><div class="msg-content"></div></div>';
            if (els.conversationMessages) els.conversationMessages.appendChild(bubble);
          }
          const contentDiv = bubble.querySelector('.msg-content');
          if (contentDiv) contentDiv.innerHTML = renderMarkdown(acc);
          els.conversationMessages.scrollTop = els.conversationMessages.scrollHeight;
        }
      },
    });

    const finalText = res.content || acc || '(no response)';

    if (conv) {
      conv.messages.push({ role: 'assistant', content: finalText, sources: res.sources || [] });
      conv.updatedAt = Date.now();
      saveSalesConversationCache();
    }

    if (els.conversationDetail && !els.conversationDetail.hidden) {
      let bubble = els.conversationMessages?.querySelector('.msg.agent.streaming');
      if (bubble) {
        bubble.classList.remove('streaming');
        const contentDiv = bubble.querySelector('.msg-content');
        if (contentDiv) contentDiv.innerHTML = renderMarkdown(finalText);
      }
      els.conversationMessages.scrollTop = els.conversationMessages.scrollHeight;
    }
  } catch (err) {
    if (salesState.abortCtrl?.signal.aborted) {
      toast('Message stopped');
    } else {
      toast('Error: ' + (err?.message || 'Something went wrong'), 'error');
      if (conv) conv.messages.pop();
    }
  } finally {
    removeThinking();
    salesState.abortCtrl = null;
    salesState.activeRequest = null;
    if (els.zaraSend) els.zaraSend.disabled = !els.zaraInput.value.trim();
    if (els.zaraStop) els.zaraStop.hidden = true;
    autoGrowTextarea();
  }
}

/* ---------- Stop Sales ---------- */
function stopSales() {
  if (salesState.abortCtrl) {
    salesState.abortCtrl.abort();
  }
  if (els.zaraStop) els.zaraStop.hidden = true;
  if (els.zaraSend) els.zaraSend.disabled = !els.zaraInput.value.trim();
}

/* ---------- Inbox rendering ----------
   Uses the existing conversation-row classes (.inbox-who / .inbox-copy / .inbox-meta)
   so each row shows avatar, name, online status, last message, time and unread count. */
function renderInboxList() {
  if (!els.inboxList) return;
  const users = inboxState.users;
  els.inboxList.innerHTML = '';

  if (!users || users.length === 0) {
    if (els.inboxEmpty) els.inboxEmpty.style.display = '';
    return;
  }

  if (els.inboxEmpty) els.inboxEmpty.style.display = 'none';

  for (const user of users) {
    const online = user.status === 'online';
    const initial = String(user.avatar || user.name || '?').trim().charAt(0).toUpperCase() || '?';

    const li = document.createElement('li');
    li.className = 'inbox-row';
    li.dataset.userId = user.id;
    li.tabIndex = 0;
    if (inboxState.selectedUserId === user.id) li.classList.add('active');

    const who = document.createElement('span');
    who.className = 'inbox-who';
    who.textContent = initial;

    const copy = document.createElement('span');
    copy.className = 'inbox-copy';

    const nameRow = document.createElement('span');
    nameRow.className = 'inbox-name-row';
    const dot = document.createElement('span');
    dot.className = `inbox-status-dot ${online ? 'online' : 'offline'}`;
    dot.title = online ? 'Online' : 'Offline';
    dot.setAttribute('aria-label', online ? 'Online' : 'Offline');
    const name = document.createElement('strong');
    name.className = 'inbox-name';
    name.textContent = user.name || 'Unknown';
    nameRow.append(dot, name);

    const preview = document.createElement('small');
    preview.className = 'inbox-preview';
    preview.textContent = user.lastMessage || 'No messages yet';

    copy.append(nameRow, preview);

    const side = document.createElement('span');
    side.className = 'inbox-side';
    const time = document.createElement('span');
    time.className = 'inbox-meta';
    time.textContent = timeAgo(user.updatedAt || user.timestamp || Date.now());
    side.appendChild(time);

    if (Number(user.unread) > 0) {
      const unread = document.createElement('span');
      unread.className = 'inbox-unread';
      unread.textContent = String(user.unread);
      unread.setAttribute('aria-label', `${user.unread} unread`);
      side.appendChild(unread);
    }

    li.append(who, copy, side);
    li.addEventListener('click', () => selectInboxUser(user.id));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectInboxUser(user.id);
      }
    });
    els.inboxList.appendChild(li);
  }
}

/* ---------- Load inbox contacts: LMS employees + local accounts ---------- */
function normalizeEmployee(e) {
  if (!e) return null;
  const raw = e.id ?? e.employee_id ?? e.email;
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  return {
    id: 'emp-' + String(raw).trim(),
    name: e.name || e.full_name || e.email || 'Employee',
    role: e.role || 'Employee',
    kind: 'employee',
    status: e.status === 'online' ? 'online' : 'offline',
    avatar: e.avatar,
  };
}

async function loadInboxUsers() {
  const [employeesRes, threadsRes, contactsRes] = await Promise.allSettled([
    loadEmployees(),
    inboxThreads(),
    inboxContacts(),
  ]);

  const employees = employeesRes.status === 'fulfilled' ? (employeesRes.value.employees || []) : [];
  const contacts = contactsRes.status === 'fulfilled' ? (contactsRes.value.contacts || []) : [];
  const threads = threadsRes.status === 'fulfilled' ? (threadsRes.value.threads || []) : [];

  if (threadsRes.status === 'fulfilled' && threadsRes.value.me) {
    inboxState.meId = threadsRes.value.me;
  }
  const threadMap = {};
  for (const t of threads) threadMap[t.peerId] = t;
  inboxState.threads = threadMap;

  // Local accounts first (they can actually reply), then employees.
  const merged = [];
  const seen = new Set();
  const push = (u) => {
    if (!u || !u.id || seen.has(u.id)) return;
    seen.add(u.id);
    merged.push(u);
  };

  for (const c of contacts) {
    push({ id: c.id, name: c.name || 'Member', role: c.role || 'Local account', kind: 'account', status: 'offline' });
  }
  for (const e of employees) push(normalizeEmployee(e));

  for (const u of merged) {
    const t = threadMap[u.id];
    if (!t) continue;
    u.lastMessage = t.preview || '';
    u.updatedAt = t.lastTs || 0;
    u.unread = t.unread || 0;
    // Only adopt a real stored name — a thread whose peerName is just the
    // peer id is an unknown name, not a better one than the contact list.
    if (t.peerName && t.peerName !== t.peerId && u.kind !== 'account') u.name = t.peerName;
  }

  // Someone new wrote to us but isn't in either contact source yet.
  for (const t of threads) {
    if (seen.has(t.peerId)) continue;
    push({
      id: t.peerId,
      name: t.peerName || t.peerId,
      role: t.peerRole || (String(t.peerId).startsWith('usr-') ? 'Local account' : 'Contact'),
      kind: String(t.peerId).startsWith('usr-') ? 'account' : 'contact',
      status: 'offline',
      lastMessage: t.preview || '',
      updatedAt: t.lastTs || 0,
      unread: t.unread || 0,
    });
  }

  merged.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  inboxState.users = merged;
  renderInboxList();
}

/* ---------- Show inbox user detail (header + rendered history) ---------- */
function showInboxUserDetail(userId) {
  if (!els.inboxDetail) return;

  els.inboxDetail.hidden = false;
  if (els.inboxEmptyDetail) els.inboxEmptyDetail.style.display = 'none';

  const user = inboxState.users.find((u) => u.id === userId);
  if (!user) return;

  if (els.inboxDetailName) els.inboxDetailName.textContent = user.name;
  if (els.inboxDetailRole) els.inboxDetailRole.textContent = user.role || 'User';
  if (els.inboxDetailAvatar) {
    els.inboxDetailAvatar.textContent = user.avatar || user.name.charAt(0).toUpperCase();
  }
  if (els.inboxDetailStatusDot && els.inboxDetailStatusText) {
    const isOnline = user.status === 'online';
    els.inboxDetailStatusDot.className = `status-dot ${isOnline ? 'online' : 'offline'}`;
    els.inboxDetailStatusText.textContent = isOnline ? 'Online' : 'Offline';
  }

  renderInboxMessages(userId);
}

/** Rebuild the message list for one peer from the local (server-backed) cache. */
function renderInboxMessages(userId) {
  if (!els.inboxMessages) return;
  if (inboxState.selectedUserId !== userId) return;

  const messages = inboxState.messages[userId] || [];
  els.inboxMessages.innerHTML = '';

  if (!messages.length) {
    const empty = document.createElement('div');
    empty.className = 'inbox-thread-empty';
    empty.textContent = 'No messages yet. Say hello.';
    els.inboxMessages.appendChild(empty);
    return;
  }

  // Group messages by sender for better display
  let lastSender = null;
  let lastDate = null;

  for (const msg of messages) {
    const msgDate = new Date(msg.timestamp);
    const dateStr = msgDate.toLocaleDateString();

    // Add date separator if this is a new day and not the first message
    if (dateStr !== lastDate && messages.indexOf(msg) > 0) {
      const dateDiv = document.createElement('div');
      dateDiv.className = 'msg-date';
      dateDiv.textContent = dateStr;
      els.inboxMessages.appendChild(dateDiv);
      lastDate = dateStr;
    }

    const msgEl = document.createElement('div');
    const role = msg.role === 'assistant' ? 'agent' : 'user';
    const isGenerated = msg.generated || false;
    const isUser = role === 'user';
    msgEl.className = `msg ${role}${isGenerated ? ' generated' : ''}${lastSender === role ? ' msg-grouped' : ''}`;
    msgEl.dataset.timestamp = msg.timestamp;

    const timeStr = msgDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    msgEl.innerHTML = `
      <div class="msg-body">
        ${isGenerated ? `<span class="msg-ai-tag">AI drafted</span>` : ''}
        <div class="msg-content">${renderMarkdown(msg.content)}</div>
      </div>
      <span class="msg-time">${timeStr}</span>
    `;
    els.inboxMessages.appendChild(msgEl);
    lastSender = role;
  }
  els.inboxMessages.scrollTop = els.inboxMessages.scrollHeight;
}

/* ---------- Select inbox user ---------- */
async function selectInboxUser(userId) {
  if (userId === inboxState.selectedUserId) return;

  if (aiDraft.peer !== userId) closeAiDraft();
  inboxState.selectedUserId = userId;
  renderInboxList();
  showInboxUserDetail(userId);
  await loadInboxHistory(userId);
}

/* ---------- Server-backed helpers: history, merge, read receipts ---------- */

/** Wire message → the shape the bubble renderer already understands. */
function toClientMessage(m) {
  return {
    id: m.id,
    role: m.from === inboxState.meId ? 'user' : 'assistant',
    content: m.body,
    timestamp: m.ts,
    generated: !!m.generated,
  };
}

/** Merge server messages into the local cache (dedupe by id), oldest first. */
function mergeMessages(peerId, incoming) {
  const list = inboxState.messages[peerId] || (inboxState.messages[peerId] = []);
  const seen = new Set(list.map((m) => m.id).filter(Boolean));
  let added = 0;
  for (const raw of incoming || []) {
    if (!raw || !raw.id) continue;
    if (seen.has(raw.id)) continue;
    seen.add(raw.id);
    list.push(toClientMessage(raw));
    added += 1;
  }
  list.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  return added;
}

/** Newest timestamp we already hold for a peer — the `since` poll cursor. */
function latestTs(peerId) {
  let max = (inboxState.threads[peerId] && inboxState.threads[peerId].lastTs) || 0;
  const list = inboxState.messages[peerId] || [];
  for (const m of list) if ((m.timestamp || 0) > max) max = m.timestamp;
  return max;
}

/** Keep the cached thread summary + the list row in sync after a change. */
function applyThreadPreview(peerId, preview, lastTs) {
  const t = inboxState.threads[peerId] ||
    (inboxState.threads[peerId] = { peerId, preview: '', lastTs: 0, unread: 0, readTs: 0 });
  t.preview = preview;
  t.lastTs = lastTs;
  const user = inboxState.users.find((u) => u.id === peerId);
  if (user) {
    user.lastMessage = preview;
    user.updatedAt = lastTs;
  }
}

/** Opening a thread (or seeing its message arrive while open) clears it. */
function markThreadRead(peerId) {
  const t = inboxState.threads[peerId];
  const user = inboxState.users.find((u) => u.id === peerId);
  const hadUnread = (t && t.unread > 0) || (user && user.unread > 0);
  if (t) {
    t.unread = 0;
    t.readTs = Date.now();
  }
  if (user) user.unread = 0;
  if (hadUnread) renderInboxList();
  if (authState.user) inboxRead(peerId).catch(() => { /* best-effort receipt */ });
}

/** Full history for one peer, then mark it read. */
async function loadInboxHistory(peerId) {
  if (!authState.user || !peerId) return;
  try {
    const data = await inboxMessages({ peer: peerId });
    if (inboxState.selectedUserId !== peerId) return; // user switched away
    if (Array.isArray(data.messages)) mergeMessages(peerId, data.messages);
    renderInboxMessages(peerId);
    markThreadRead(peerId);
  } catch (err) {
    if (err && (err.status === 401 || err.code === 'unauthenticated')) return;
    toast('Could not load this conversation', 'error');
  }
}

/* ---------- Receive: polling with a `since` cursor ---------- */

function pollInboxMessages() {
  if (!authState.user || state.activeView !== 'inbox') return;
  const peer = inboxState.selectedUserId;
  if (!peer || inboxState.activeRequest || inboxState.polling) return;

  inboxState.polling = true;
  inboxMessages({ peer, since: latestTs(peer) })
    .then((data) => {
      if (inboxState.selectedUserId !== peer) return;
      if (!Array.isArray(data.messages) || !data.messages.length) return;
      const added = mergeMessages(peer, data.messages);
      if (!added) return;
      const list = inboxState.messages[peer] || [];
      const last = list[list.length - 1];
      applyThreadPreview(peer, last.content, last.timestamp);
      if (last.role !== 'user') markThreadRead(peer); // it's on screen → read
      renderInboxMessages(peer);
      renderInboxList();
    })
    .catch(() => { /* transient — the next tick retries */ })
    .finally(() => { inboxState.polling = false; });
}

function pollInboxThreads() {
  if (!authState.user || state.activeView !== 'inbox' || inboxState.threadsBusy) return;
  inboxState.threadsBusy = true;
  inboxThreads()
    .then((data) => {
      if (!Array.isArray(data.threads)) return;
      if (data.me) inboxState.meId = data.me;
      const map = {};
      for (const t of data.threads) map[t.peerId] = t;
      inboxState.threads = map;

      const unknown = data.threads.some((t) => !inboxState.users.some((u) => u.id === t.peerId));
      if (unknown) { loadInboxUsers(); return; } // a new conversation appeared

      let changed = false;
      for (const user of inboxState.users) {
        const t = map[user.id];
        const unread = t ? (t.unread || 0) : 0;
        const preview = t ? (t.preview || '') : (user.lastMessage || '');
        const lastTs = t ? (t.lastTs || 0) : (user.updatedAt || 0);
        if ((user.unread || 0) !== unread || (user.lastMessage || '') !== preview || (user.updatedAt || 0) !== lastTs) {
          changed = true;
        }
        user.unread = unread;
        user.lastMessage = preview;
        user.updatedAt = lastTs;
      }
      if (changed) renderInboxList();
    })
    .catch(() => { /* transient */ })
    .finally(() => { inboxState.threadsBusy = false; });
}

function startInboxPolling() {
  if (!authState.user) return;
  if (!inboxState.pollTimer) inboxState.pollTimer = setInterval(pollInboxMessages, 2500);
  if (!inboxState.threadTimer) inboxState.threadTimer = setInterval(pollInboxThreads, 5000);
}

function stopInboxPolling() {
  if (inboxState.pollTimer) { clearInterval(inboxState.pollTimer); inboxState.pollTimer = null; }
  if (inboxState.threadTimer) { clearInterval(inboxState.threadTimer); inboxState.threadTimer = null; }
}

/** (Re)load contacts + threads, then keep them fresh while the view is open. */
async function refreshInbox() {
  await loadInboxUsers();
  startInboxPolling();
  const peer = inboxState.selectedUserId;
  if (peer) await loadInboxHistory(peer);
}

/* ---------- Send inbox message (delivered + persisted server-side) ---------- */
async function sendInboxMessage() {
  if (!els.inboxInput) return;
  const text = els.inboxInput.value.trim();
  if (!text || inboxState.activeRequest) return;

  if (!authState.user) {
    toast('Sign in to send messages', 'error');
    return;
  }
  const userId = inboxState.selectedUserId;
  if (!userId) return;
  const user = inboxState.users.find((u) => u.id === userId);

  els.inboxInput.value = '';
  els.inboxInput.style.height = 'auto';
  if (els.inboxSend) els.inboxSend.disabled = true;

  inboxState.activeRequest = true;
  try {
    const { message } = await inboxSend({
      to: userId,
      body: text,
      toName: user ? user.name : '',
      toRole: user ? user.role : '',
    });
    mergeMessages(userId, [message]);
    applyThreadPreview(userId, text, message.ts);
    markThreadRead(userId); // sending counts as reading that thread
    renderInboxMessages(userId);
    renderInboxList();
  } catch (err) {
    // Put the text back so nothing the user typed is lost.
    if (els.inboxInput) { els.inboxInput.value = text; els.inboxInput.style.height = 'auto'; }
    if (err && (err.status === 401 || err.code === 'unauthenticated')) {
      toast('Your session ended — sign in again', 'error');
    } else {
      toast(err?.message || 'Message failed to send', 'error');
    }
  } finally {
    inboxState.activeRequest = null;
    if (els.inboxSend) els.inboxSend.disabled = !els.inboxInput.value.trim();
    autoGrowTextarea();
  }
}

/* ==========================================================================
   AI DRAFTS A MESSAGE ON YOUR BEHALF — instruction → preview → you confirm
   ========================================================================== */
const aiDraft = { peer: null, instruction: '', text: '', abort: null, editing: false, busy: false };

const aiEls = {
  panel: document.getElementById('aiDraft'),
  body: document.getElementById('aiDraftBody'),
  state: document.getElementById('aiDraftState'),
  editBox: document.getElementById('aiDraftEditBox'),
  edit: document.getElementById('aiDraftEdit'),
  regen: document.getElementById('aiDraftRegen'),
  cancel: document.getElementById('aiDraftCancel'),
  send: document.getElementById('aiDraftSend'),
  close: document.getElementById('aiDraftClose'),
  btn: document.getElementById('inboxAi'),
};

function setAiDraftState(text, busy) {
  if (aiEls.state) aiEls.state.textContent = text || '';
  if (aiEls.send) aiEls.send.disabled = !!busy || !aiDraft.text;
  if (aiEls.regen) aiEls.regen.disabled = !!busy;
}

function setAiDraftText(text) {
  aiDraft.text = text || '';
  if (aiEls.body) aiEls.body.textContent = aiDraft.text;
  if (aiEls.editBox) aiEls.editBox.value = aiDraft.text;
  if (aiEls.send) aiEls.send.disabled = !aiDraft.text || aiDraft.busy;
}

function showAiDraftPanel(show) {
  if (aiEls.panel) aiEls.panel.hidden = !show;
}

function setAiDraftEditing(editing) {
  aiDraft.editing = editing;
  if (aiEls.body) aiEls.body.hidden = editing;
  if (aiEls.editBox) {
    aiEls.editBox.hidden = !editing;
    if (editing) { aiEls.editBox.value = aiDraft.text; aiEls.editBox.focus(); }
  }
  if (aiEls.edit) aiEls.edit.textContent = editing ? 'Done' : 'Edit';
}

function closeAiDraft() {
  if (aiDraft.abort) {
    try { aiDraft.abort.abort(); } catch { /* noop */ }
    aiDraft.abort = null;
  }
  aiDraft.busy = false;
  aiDraft.instruction = '';
  setAiDraftEditing(false);
  setAiDraftText('');
  showAiDraftPanel(false);
  if (aiEls.state) aiEls.state.textContent = 'Writing…';
}

async function generateAiDraft() {
  const peer = aiDraft.peer;
  if (!peer || !aiDraft.instruction) return;
  const user = inboxState.users.find((u) => u.id === peer);

  aiDraft.busy = true;
  setAiDraftEditing(false);
  setAiDraftText('');
  setAiDraftState('Writing…', true);
  aiDraft.abort = new AbortController();

  const history = (inboxState.messages[peer] || [])
    .slice(-8)
    .map((m) => `${m.role === 'user' ? 'Me' : (user ? user.name : 'Them')}: ${m.content}`)
    .join('\n');

  const system = [
    'You draft a short outgoing chat message on behalf of the user of a local messaging app.',
    `Recipient: ${user ? user.name : 'the contact'}${user && user.role ? ` (${user.role})` : ''}.`,
    history ? `Conversation so far:\n${history}` : 'This is a brand new conversation — there are no previous messages.',
    'Output ONLY the message text that will be sent to the recipient. No quotation marks, no preamble, no subject line, no sign-off unless the instruction asks for one.',
    'Keep it natural, concise and in the language of the instruction.',
  ].join('\n\n');

  try {
    const res = await streamChat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: aiDraft.instruction },
      ],
      signal: aiDraft.abort.signal,
      onToken: (tok, full) => {
        if (!aiDraft.abort || aiDraft.abort.signal.aborted) return;
        setAiDraftText(full);
      },
    });
    if (!aiDraft.abort || aiDraft.abort.signal.aborted) return; // cancelled mid-stream
    const finalText = String(res.content || '').trim();
    setAiDraftText(finalText);
    setAiDraftState(finalText ? 'Review before sending' : 'No draft produced — hit Regenerate', false);
    if (!finalText) toast('The model returned an empty draft.', 'error');
  } catch (err) {
    if (aiDraft.abort && aiDraft.abort.signal.aborted) return; // user cancelled
    setAiDraftState('Draft failed', false);
    toast(err?.message || 'Could not draft a message', 'error');
  } finally {
    aiDraft.busy = false;
    aiDraft.abort = null;
    if (aiEls.send) aiEls.send.disabled = !aiDraft.text;
    if (aiEls.regen) aiEls.regen.disabled = false;
  }
}

/** Composer text is the INSTRUCTION; the draft lands in the preview panel. */
async function startAiDraft() {
  if (!authState.user) {
    toast('Sign in to use the inbox', 'error');
    return;
  }
  if (!inboxState.selectedUserId) {
    toast('Select a conversation first', 'error');
    return;
  }
  const instruction = (els.inboxInput?.value || '').trim();
  if (!instruction) {
    els.inboxInput?.focus();
    toast('Type what the message should say, then tap the AI button', 'info');
    return;
  }

  if (els.inboxInput) { els.inboxInput.value = ''; els.inboxInput.style.height = 'auto'; }
  if (els.inboxSend) els.inboxSend.disabled = true;

  if (aiDraft.peer !== inboxState.selectedUserId) closeAiDraft();
  aiDraft.peer = inboxState.selectedUserId;
  aiDraft.instruction = instruction;
  showAiDraftPanel(true);
  await generateAiDraft();
}

/** Confirm: the reviewed draft is delivered as a `generated: true` message. */
async function sendAiDraft() {
  const peer = aiDraft.peer;
  const text = String(aiDraft.editing ? (aiEls.editBox?.value || '') : aiDraft.text).trim();
  if (!peer || !text || aiDraft.busy) return;

  const user = inboxState.users.find((u) => u.id === peer);
  aiDraft.busy = true;
  if (aiEls.send) aiEls.send.disabled = true;
  if (aiEls.regen) aiEls.regen.disabled = true;
  setAiDraftState('Sending…', true);

  try {
    const { message } = await inboxSend({
      to: peer,
      body: text,
      generated: true,
      toName: user ? user.name : '',
      toRole: user ? user.role : '',
    });
    mergeMessages(peer, [message]);
    applyThreadPreview(peer, text, message.ts);
    markThreadRead(peer);
    renderInboxMessages(peer);
    renderInboxList();
    closeAiDraft();
    toast('Message sent (drafted by AI)', 'info');
  } catch (err) {
    setAiDraftState('Could not send', false);
    toast(err?.message || 'Message failed to send', 'error');
  } finally {
    aiDraft.busy = false;
    if (aiEls.send) aiEls.send.disabled = !aiDraft.text;
    if (aiEls.regen) aiEls.regen.disabled = false;
  }
}

aiEls.btn?.addEventListener('click', startAiDraft);
aiEls.regen?.addEventListener('click', () => { if (!aiDraft.busy && aiDraft.instruction) generateAiDraft(); });
aiEls.cancel?.addEventListener('click', closeAiDraft);
aiEls.close?.addEventListener('click', closeAiDraft);
aiEls.send?.addEventListener('click', sendAiDraft);
aiEls.edit?.addEventListener('click', () => {
  if (!aiDraft.editing && !aiDraft.text) return;
  if (aiDraft.editing) {
    setAiDraftText((aiEls.editBox?.value || aiDraft.text).trim());
    setAiDraftEditing(false);
    setAiDraftState(aiDraft.text ? 'Review before sending' : 'Draft is empty', false);
  } else {
    setAiDraftEditing(true);
    setAiDraftState('Editing', false);
  }
});

/* ==========================================================================
   AUTH — local login (scrypt accounts + signed httpOnly session cookie)
   ========================================================================== */
const authState = { user: null, mode: 'login' };

/** Server-side codes from src/auth/google.js, mirrored for the UI. */
const GOOGLE_SIGNIN_ERRORS = {
  not_configured: 'Google sign-in is not configured yet — add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the server.',
  bad_state: 'That sign-in attempt expired. Please try again.',
  denied: 'Google sign-in was cancelled.',
  no_code: 'Google did not return a sign-in code. Please try again.',
  no_email: 'That Google account has no email address we can use.',
  exchange_failed: 'Google rejected the sign-in. Please try again.',
  failed: 'Could not sign you in with Google. Please try again.',
};

const authEls = {
  screen: document.getElementById('authScreen'),
  form: document.getElementById('authForm'),
  tabLogin: document.getElementById('authTabLogin'),
  tabRegister: document.getElementById('authTabRegister'),
  heading: document.getElementById('authTitle'),
  subtitle: document.getElementById('authSubtitle'),
  nameField: document.getElementById('authNameField'),
  name: document.getElementById('authName'),
  email: document.getElementById('authEmail'),
  password: document.getElementById('authPassword'),
  pwToggle: document.getElementById('authPwToggle'),
  error: document.getElementById('authError'),
  submit: document.getElementById('authSubmit'),
  switchText: document.getElementById('authSwitchText'),
  switchBtn: document.getElementById('authSwitch'),
  google: document.getElementById('authGoogle'),
  avatar: document.getElementById('btnUserMenu'),
  menu: document.getElementById('userMenu'),
  menuAvatar: document.getElementById('userMenuAvatar'),
  menuName: document.getElementById('userName'),
  menuEmail: document.getElementById('userEmail'),
  logout: document.getElementById('btnLogout'),
};

function authSubmitLabel() {
  return authState.mode === 'register' ? 'Create account' : 'Sign in';
}

function showAuthError(msg) {
  if (!authEls.error) return;
  authEls.error.textContent = msg || '';
  authEls.error.hidden = !msg;
  // Mark the fields invalid so assistive tech announces the problem too.
  const invalid = !!msg;
  for (const el of [authEls.email, authEls.password, authEls.name]) {
    if (el) el.setAttribute('aria-invalid', String(invalid));
  }
}

function setAuthMode(mode) {
  authState.mode = mode === 'register' ? 'register' : 'login';
  const isReg = authState.mode === 'register';
  authEls.tabLogin?.classList.toggle('active', !isReg);
  authEls.tabRegister?.classList.toggle('active', isReg);
  authEls.tabLogin?.setAttribute('aria-selected', String(!isReg));
  authEls.tabRegister?.setAttribute('aria-selected', String(isReg));
  if (authEls.nameField) authEls.nameField.hidden = !isReg;
  if (authEls.password) {
    authEls.password.autocomplete = isReg ? 'new-password' : 'current-password';
    authEls.password.placeholder = isReg ? 'At least 6 characters' : '••••••••';
  }
  if (authEls.submit) authEls.submit.textContent = authSubmitLabel();

  // Headline + the "already have an account?" link follow the active tab.
  if (authEls.heading) authEls.heading.textContent = isReg ? 'Create your account' : 'Welcome back';
  if (authEls.subtitle) {
    authEls.subtitle.textContent = isReg
      ? 'It takes a minute — then your workspace is ready.'
      : 'Sign in to open your workspace and inbox.';
  }
  if (authEls.switchText) {
    authEls.switchText.textContent = isReg ? 'Already have an account?' : 'Don’t have an account?';
  }
  if (authEls.switchBtn) authEls.switchBtn.textContent = isReg ? 'Sign in' : 'Create one';

  resetPasswordVisibility();
  showAuthError('');
}

/** Put the password back to hidden when the form changes shape. */
function resetPasswordVisibility() {
  const input = authEls.password;
  const btn = authEls.pwToggle;
  if (input) input.type = 'password';
  if (btn) {
    btn.classList.remove('on');
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-label', 'Show password');
    btn.title = 'Show password';
  }
}

function showAuthScreen(show) {
  if (authEls.screen) authEls.screen.hidden = !show;
  // Hides the floating voice assistant + Foppy while signed out.
  document.body.classList.toggle('is-unauthenticated', !!show);
  if (show) {
    // Always land on a clean Sign in form (a logout must not come back to a
    // still-open Create account tab, and a stale password is never kept).
    setAuthMode('login');
    authEls.form?.reset();
    closeUserMenu();
    setTimeout(() => authEls.email?.focus(), 60);
  }
}

function applyAuthUser(user) {
  authState.user = user || null;
  inboxState.meId = user ? 'usr-' + user.id : null;
  const initial = user
    ? (String(user.name || user.email || '?').trim().charAt(0).toUpperCase() || '?')
    : '?';
  if (authEls.avatar) authEls.avatar.textContent = initial;
  if (authEls.menuAvatar) authEls.menuAvatar.textContent = initial;
  if (authEls.menuName) authEls.menuName.textContent = user ? user.name : 'Not signed in';
  if (authEls.menuEmail) authEls.menuEmail.textContent = user ? user.email : '';
  if (!user) stopInboxPolling();
}

function closeUserMenu() {
  if (authEls.menu) authEls.menu.hidden = true;
}

function toggleUserMenu() {
  if (!authEls.menu || !authEls.avatar) return;
  if (!authEls.menu.hidden) { closeUserMenu(); return; }
  const rect = authEls.avatar.getBoundingClientRect();
  authEls.menu.hidden = false;
  const width = authEls.menu.offsetWidth;
  authEls.menu.style.top = `${Math.round(rect.bottom + 8)}px`;
  authEls.menu.style.left = `${Math.max(8, Math.round(rect.right - width))}px`;
}

/** Consume ?auth=google / ?auth_error=… left behind by the OAuth redirect,
 *  then strip them so a refresh never replays the message. */
function consumeAuthRedirect() {
  const params = new URLSearchParams(window.location.search);
  const ok = params.get('auth');
  const err = params.get('auth_error');
  if (!ok && !err) return;

  params.delete('auth');
  params.delete('auth_error');
  const qs = params.toString();
  window.history.replaceState(
    {},
    '',
    window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash
  );

  if (err) showAuthError(GOOGLE_SIGNIN_ERRORS[err] || GOOGLE_SIGNIN_ERRORS.failed);
  else if (ok === 'google') toast('Signed in with Google', 'info');
}

async function initAuth() {
  setAuthMode('login');
  try {
    const data = await authMe();
    applyAuthUser(data.user || null);
    showAuthScreen(!data.user);
    if (data.user && state.activeView === 'inbox') refreshInbox();
  } catch {
    applyAuthUser(null);
    showAuthScreen(true);
  }
  // After showAuthScreen() so a fresh Sign-in form is on screen first.
  consumeAuthRedirect();
}

authEls.tabLogin?.addEventListener('click', () => setAuthMode('login'));
authEls.tabRegister?.addEventListener('click', () => setAuthMode('register'));

/* The link under the form is the same switch as the tabs, worded for the
   mode you are NOT in — so "already have an account?" is one click away. */
authEls.switchBtn?.addEventListener('click', () => {
  const next = authState.mode === 'register' ? 'login' : 'register';
  setAuthMode(next);
  (next === 'register' ? authEls.name : authEls.email)?.focus();
});

/* Password view / hide — the button keeps focus so it can be toggled back. */
authEls.pwToggle?.addEventListener('click', () => {
  const input = authEls.password;
  const btn = authEls.pwToggle;
  if (!input || !btn) return;
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  const label = showing ? 'Show password' : 'Hide password';
  btn.classList.toggle('on', !showing);
  btn.setAttribute('aria-pressed', String(!showing));
  btn.setAttribute('aria-label', label);
  btn.title = label;
});

/* Google sign-in — a full-page redirect handled by /api/auth/google. */
authEls.google?.addEventListener('click', () => {
  if (!authEls.google || authEls.google.disabled) return;
  authEls.google.disabled = true;
  authEls.google.setAttribute('aria-busy', 'true');
  window.location.assign('/api/auth/google');
});

authEls.form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    name: (authEls.name?.value || '').trim(),
    email: (authEls.email?.value || '').trim(),
    password: authEls.password?.value || '',
  };
  if (!payload.email || !payload.password) {
    showAuthError('Enter your email and password.');
    return;
  }
  if (authState.mode === 'register' && !payload.name) {
    showAuthError('Enter your name.');
    return;
  }

  showAuthError('');
  const isReg = authState.mode === 'register';
  if (authEls.submit) {
    authEls.submit.disabled = true;
    authEls.submit.textContent = isReg ? 'Creating…' : 'Signing in…';
  }

  try {
    const data = isReg ? await authRegister(payload) : await authLogin(payload);
    applyAuthUser(data.user);
    showAuthScreen(false);
    authEls.form?.reset();
    toast(`Welcome, ${data.user.name}`, 'info');
    if (state.activeView === 'inbox') refreshInbox();
  } catch (err) {
    showAuthError(err?.message || 'Could not sign in.');
  } finally {
    if (authEls.submit) {
      authEls.submit.disabled = false;
      authEls.submit.textContent = authSubmitLabel();
    }
  }
});

authEls.avatar?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleUserMenu();
});

document.addEventListener('click', (e) => {
  if (!authEls.menu || authEls.menu.hidden) return;
  if (authEls.menu.contains(e.target) || authEls.avatar?.contains(e.target)) return;
  closeUserMenu();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (authEls.menu && !authEls.menu.hidden) { closeUserMenu(); return; }
  if (aiDraft.instruction && aiEls.panel && !aiEls.panel.hidden) closeAiDraft();
});

authEls.logout?.addEventListener('click', async () => {
  closeUserMenu();
  try { await authLogout(); } catch { /* cookie cleared best effort */ }

  // Reset inbox to a signed-out state so no account data lingers on screen.
  inboxState.messages = {};
  inboxState.threads = {};
  inboxState.users = [];
  inboxState.selectedUserId = null;
  inboxState.meId = null;
  aiDraft.peer = null;
  closeAiDraft();
  if (els.inboxDetail) els.inboxDetail.hidden = true;
  if (els.inboxEmptyDetail) els.inboxEmptyDetail.style.display = '';
  if (els.inboxMessages) els.inboxMessages.innerHTML = '';
  renderInboxList();

  applyAuthUser(null);
  showAuthScreen(true);
  toast('Signed out', 'info');
});

initAuth();

/* ==========================================================================
   HOME GREETING — time-aware (was hardcoded "Good morning" 24/7)
   ========================================================================== */
/** morning < 12:00 · afternoon < 17:00 · evening otherwise */
function greetingWordForNow(d = new Date()) {
  const h = d.getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

function renderHomeGreeting() {
  const el = document.getElementById('homeGreeting');
  if (!el) return;
  const word = greetingWordForNow();
  if (el.dataset.greeting === word) return; // already showing the right word
  el.dataset.greeting = word;

  // Rebuild the heading instead of assigning textContent, so the
  // .greet-accent gradient span keeps its styling.
  el.textContent = '';
  el.append('Good ');
  const accent = document.createElement('span');
  accent.className = 'greet-accent';
  accent.textContent = word;
  el.append(accent);
}

renderHomeGreeting();
// re-check every minute so the greeting rolls over if the tab stays open
setInterval(renderHomeGreeting, 60 * 1000);

/* ---------- Apps marketplace (uses existing /api/integrations) ---------- */
const appsState = { categories: [], apps: [], selectedId: null, query: '', activeCategory: 'all' };

const APP_STATUS_LABEL = {
  connected: 'Connected',
  not_connected: 'Not connected',
  reauth: 'Needs reconnect',
  not_configured: 'Not configured',
  coming_soon: 'Coming soon',
};

async function refreshApps() {
  try {
    const data = await listIntegrations();
    appsState.categories = data.categories || [];
    appsState.apps = data.apps || [];
  } catch { /* keep whatever we had */ }
  renderApps();
}

/* Flat Google Material icons for the Apps page — app id → { icon, color }.
   Falls back to the catalog emoji when an id is not mapped. */
const APP_FLAT_ICONS = {
  gmail:        { icon: 'mail',            color: '#EA4335' },
  gcal:         { icon: 'calendar_month',  color: '#4285F4' },
  gdrive:       { icon: 'folder',          color: '#F9AB00' },
  gdocs:        { icon: 'description',     color: '#1A73E8' },
  gsheets:      { icon: 'table_chart',     color: '#34A853' },
  gmeet:        { icon: 'videocam',        color: '#00AC47' },
  gchat:        { icon: 'chat',            color: '#0F9D58' },
  outlook:      { icon: 'mark_email_read', color: '#0078D4' },
  mscal:        { icon: 'calendar_month',  color: '#28A8EA' },
  teams:        { icon: 'groups',          color: '#6264A7' },
  onedrive:     { icon: 'cloud',           color: '#0364B8' },
  sharepoint:   { icon: 'hub',             color: '#038387' },
  excel:        { icon: 'table_view',      color: '#217346' },
  word:         { icon: 'article',         color: '#2B579A' },
  slack:        { icon: 'forum',           color: '#E01E5A' },
  notion:       { icon: 'web',             color: '#9CA3AF' },
  trello:       { icon: 'dashboard',       color: '#0079BF' },
  asana:        { icon: 'task_alt',        color: '#F06A6A' },
  clickup:      { icon: 'rocket_launch',   color: '#7B68EE' },
  dropbox:      { icon: 'inventory_2',     color: '#0061FF' },
  canva:        { icon: 'palette',         color: '#00C4CC' },
  salesforce:   { icon: 'handshake',       color: '#00A1E0' },
  hubspot:      { icon: 'hub',             color: '#FF7A59' },
  zoho:         { icon: 'apps',            color: '#E42527' },
  sap:          { icon: 'factory',         color: '#008FD3' },
  oracle:       { icon: 'database',        color: '#C74634' },
  dynamics:     { icon: 'analytics',       color: '#742774' },
  'aculyze-lms':    { icon: 'school',      color: '#6d28d9' },
  'aculyze-sales':  { icon: 'work',        color: '#db2777' },
  'aculyze-api':    { icon: 'api',         color: '#0891b2' },
};

function renderApps() {
  const root = document.getElementById('appsContent');
  if (!root) return;
  const q = appsState.query.trim().toLowerCase();
  const apps = appsState.apps.filter((a) => {
    if (!q) return true;
    return `${a.name} ${a.desc || ''} ${a.category || ''}`.toLowerCase().includes(q);
  });

  root.innerHTML = '';

  // Search bar
  const search = document.createElement('div');
  search.className = 'apps-search';
  search.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M16.5 16.5 21 21"/></svg>`;
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.placeholder = 'Search integrations';
  searchInput.value = appsState.query;
  searchInput.addEventListener('input', () => {
    appsState.query = searchInput.value;
    renderApps();
    const again = document.querySelector('#appsContent .apps-search input');
    if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
  });
  search.appendChild(searchInput);
  root.appendChild(search);

  if (!apps.length) {
    const empty = document.createElement('div');
    empty.className = 'apps-empty';
    empty.textContent = appsState.query ? 'No integrations match your search.' : 'No integrations configured yet.';
    root.appendChild(empty);
    return;
  }

  const labelFor = (id) => (appsState.categories.find((c) => c.id === id) || {}).label || id;

  // Category pills
  const pillBar = document.createElement('div');
  pillBar.className = 'apps-category-pills';
  const allPill = document.createElement('button');
  allPill.type = 'button';
  allPill.className = `apps-category-pill ${appsState.activeCategory === 'all' ? 'active' : ''}`;
  allPill.textContent = 'All Apps';
  allPill.addEventListener('click', () => { appsState.activeCategory = 'all'; renderApps(); });
  pillBar.appendChild(allPill);

  const categoryOrder = ['work', 'productivity', 'creative', 'crm', 'erp', 'aculyze'];
  categoryOrder.forEach((catId) => {
    const cat = appsState.categories.find((c) => c.id === catId);
    if (!cat) return;
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = `apps-category-pill ${appsState.activeCategory === catId ? 'active' : ''}`;
    pill.textContent = cat.label;
    pill.addEventListener('click', () => { appsState.activeCategory = catId; renderApps(); });
    pillBar.appendChild(pill);
  });
  root.appendChild(pillBar);

  // Filter apps by active category
  let filteredApps = apps;
  if (appsState.activeCategory && appsState.activeCategory !== 'all') {
    filteredApps = apps.filter((a) => a.category === appsState.activeCategory);
  }

  // Split into featured and non-featured
  const featuredApps = filteredApps.filter((a) => a.featured);
  const otherApps = filteredApps.filter((a) => !a.featured);

  // Section header helper
  const sectionHeader = (title, sub) => {
    const h = document.createElement('div');
    h.className = 'apps-section-header';
    h.innerHTML = `<div><div class="apps-section-title">${title}</div><div class="apps-section-sub">${sub}</div></div>`;
    return h;
  };

  // Build app card
  const buildCard = (a) => {
    const card = document.createElement('a');
    card.className = 'app-card ac-app-card-link';
    card.href = '#';
    card.addEventListener('click', (e) => { e.preventDefault(); openAppDrawer(a.id); });

    const statusText = APP_STATUS_LABEL[a.status] || a.status || 'Available';
    const statusClass = a.status === 'connected' ? 'connected'
      : a.status === 'coming_soon' ? 'coming-soon'
      : 'not-configured';
    const isComingSoon = a.status === 'coming_soon';
    const btnText = a.status === 'connected' ? 'Configure' : isComingSoon ? 'Coming soon' : 'Get';
    const btnDisabled = isComingSoon;

    const flat = APP_FLAT_ICONS[a.id];
    const iconHtml = flat
      ? `<span class="ac-app-ico" aria-hidden="true" style="background:${flat.color}1A"><span class="material-symbols-outlined" style="color:${flat.color}">${flat.icon}</span></span>`
      : `<span class="ac-app-ico" aria-hidden="true">${(a.icon || '•').slice(0, 2)}</span>`;

    card.innerHTML = `
      ${iconHtml}
      <div class="ac-app-name">${a.name}</div>
      <p class="ac-app-desc">${a.desc || ''}</p>
      <div class="ac-app-status-row">
        <span class="ac-app-status ${statusClass}"><span class="ac-app-status-dot"></span>${statusText}</span>
        <span class="ac-btn-details" aria-label="Details for ${a.name}">→</span>
      </div>
      <div class="ac-app-actions">
        <button class="ac-btn-primary" type="button" ${btnDisabled ? 'disabled' : ''}>${btnText}</button>
      </div>
    `;
    return card;
  };

  // Featured section
  if (featuredApps.length) {
    root.appendChild(sectionHeader('Featured Integrations', 'Handpicked for your workspace'));
    const featuredGrid = document.createElement('div');
    featuredGrid.className = 'apps-grid';
    featuredGrid.style.gridTemplateColumns = 'repeat(4, minmax(0, 1fr))';
    featuredApps.forEach((a) => featuredGrid.appendChild(buildCard(a)));
    root.appendChild(featuredGrid);
  }

  // All apps section (remaining)
  if (otherApps.length) {
    const sectionTitle = appsState.activeCategory && appsState.activeCategory !== 'all'
      ? labelFor(appsState.activeCategory)
      : 'All Integrations';
    const sectionSub = 'Connect and manage your integrations';
    root.appendChild(sectionHeader(sectionTitle, sectionSub));
    const otherGrid = document.createElement('div');
    otherGrid.className = 'apps-grid';
    otherApps.forEach((a) => otherGrid.appendChild(buildCard(a)));
    root.appendChild(otherGrid);
  }
}

async function openAppDrawer(appId) {
  const drawer = document.getElementById('appDrawer');
  const body = document.getElementById('appDrawerBody');
  const title = document.getElementById('appDrawerTitle');
  if (!drawer || !body) return;
  appsState.selectedId = appId;
  if (title) title.textContent = 'Integration';
  body.innerHTML = '<p class="utility-status-line">Loading…</p>';
  drawer.hidden = false;

  let detail = null;
  try {
    detail = await integrationDetail(appId);
  } catch (err) {
    body.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'utility-status-line';
    p.textContent = String(err.message || 'Could not load this integration.');
    body.appendChild(p);
    return;
  }

  const app = (appsState.apps.find((a) => a.id === appId) || detail.app || {});
  if (title) title.textContent = app.name || appId;

  body.innerHTML = '';

  // Header: name + status
  const header = document.createElement('div');
  header.className = 'utility-detail-header';
  const nameEl = document.createElement('h3');
  nameEl.className = 'utility-detail-name';
  nameEl.textContent = detail.name || app.name || appId;
  header.appendChild(nameEl);
  
  // Provider indicator for OAuth apps
  if (detail.provider) {
    const providerEl = document.createElement('span');
    providerEl.className = 'utility-provider';
    providerEl.style.fontSize = '11px';
    providerEl.style.color = 'var(--text-muted)';
    providerEl.textContent = detail.provider === 'google' ? 'Google OAuth 2.0' : detail.provider;
    header.appendChild(providerEl);
  }
  
  const status = document.createElement('span');
  const statusClass = detail.status === 'connected' ? 'connected' 
    : detail.status === 'not_configured' ? 'not-configured'
    : detail.status === 'connecting' ? 'connecting'
    : detail.status === 'disconnected' ? 'not-connected'
    : detail.status === 'error' ? 'error'
    : 'action';
  status.className = `app-status ${statusClass}`;
  const statusText = {
    connected: 'Connected',
    not_configured: 'Not configured',
    connecting: 'Connecting',
    disconnected: 'Not connected',
    error: 'Error',
    reauth: 'Needs re-auth',
    coming_soon: 'Coming soon',
  }[detail.status] || (detail.status || 'Available');
  status.textContent = statusText;
  header.appendChild(status);
  body.appendChild(header);

  // OAuth apps don't need the generic API config fields
  const isOAuthApp = detail.auth === 'oauth' && detail.provider;
  
  // OAuth/Provider info section
  if (isOAuthApp) {
    // Show provider-specific info
    if (detail.provider === 'google') {
      const oauthSection = document.createElement('div');
      oauthSection.className = 'settings-row utility-static';
      oauthSection.innerHTML = `
        <div>
          <strong>Authentication</strong>
          <small>OAuth 2.0 flow via Google</small>
        </div>
        <div class="setting-control">
          <span class="app-status ${detail.status === 'connected' ? 'connected' : 'not-connected'}">${statusText}</span>
        </div>
      `;
      body.appendChild(oauthSection);
      
      // Show connected account if connected
      if (detail.status === 'connected' && detail.account) {
        const accountRow = document.createElement('div');
        accountRow.className = 'settings-row utility-static';
        accountRow.innerHTML = `
          <div>
            <strong>Google Account</strong>
            <small>Authorized for Gmail access</small>
          </div>
          <div class="setting-control">
            <span class="app-status connected">${detail.account}</span>
          </div>
        `;
        body.appendChild(accountRow);
      }
    }
  } else {
    // API key apps - show generic config fields
    const configFields = [
      { label: 'API Name', value: detail.name || app.name || appId },
      { label: 'Base URL', value: detail.baseUrl || 'https://lm.aculyze.in/api/v1' },
      { label: 'API Key', value: detail.hasKey ? '••••••••••••' : 'Not set', masked: true },
    ];
    configFields.forEach((field) => {
      const row = document.createElement('div');
      row.className = 'settings-row utility-static';
      const left = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = field.label;
      const small = document.createElement('small');
      small.textContent = field.masked ? (detail.hasKey ? 'Saved (server-side)' : 'Not configured') : field.value;
      left.appendChild(strong);
      left.appendChild(small);
      const right = document.createElement('div');
      right.className = 'setting-control';
      row.appendChild(left);
      if (field.masked) {
        const badge = document.createElement('span');
        badge.className = 'app-status ' + (detail.hasKey ? 'connected' : 'unavailable');
        badge.textContent = detail.hasKey ? 'Set' : 'Not set';
        right.appendChild(badge);
        row.appendChild(right);
      }
      body.appendChild(row);
    });
  }

  // Permissions (fix [object Object] — render label + granted state)
  if (detail.permissions && detail.permissions.length) {
    const permsLabel = document.createElement('p');
    permsLabel.className = 'utility-status-line';
    permsLabel.textContent = 'Permissions';
    body.appendChild(permsLabel);
    const ul = document.createElement('ul');
    ul.className = 'utility-perm-list';
    detail.permissions.forEach((p) => {
      const li = document.createElement('li');
      li.textContent = p.label || p.id;
      li.classList.toggle('granted', !!p.granted);
      ul.appendChild(li);
    });
    body.appendChild(ul);
  }

  // Last test result
  if (detail.lastTest) {
    const testRow = document.createElement('div');
    testRow.className = 'settings-row utility-static';
    const testLeft = document.createElement('div');
    const testStrong = document.createElement('strong');
    testStrong.textContent = 'Last verify';
    const testSmall = document.createElement('small');
    testSmall.textContent = `${detail.lastTest.label || ''} ${detail.lastTest.ms !== undefined ? `(${detail.lastTest.ms} ms)` : ''}`.trim();
    testLeft.appendChild(testStrong);
    testLeft.appendChild(testSmall);
    const testRight = document.createElement('div');
    testRight.className = 'setting-control';
    const testBadge = document.createElement('span');
    testBadge.className = `app-status ${detail.lastTest.ok ? 'connected' : 'action'}`;
    testBadge.textContent = detail.lastTest.ok ? 'Verified' : (detail.lastTest.label || 'Failed');
    testRight.appendChild(testBadge);
    testRow.appendChild(testLeft);
    testRow.appendChild(testRight);
    body.appendChild(testRow);
  }

  // Action buttons
  const actions = document.createElement('div');
  actions.className = 'utility-actions';

  if (detail.status === 'connected') {
    // OAuth apps with connected account
    if (isOAuthApp && detail.account) {
      // Gmail-specific: Add "Search Emails" button
      if (appId === 'gmail' && detail.granted && detail.granted.includes('READ_EMAIL')) {
        const searchEmails = document.createElement('button');
        searchEmails.type = 'button';
        searchEmails.className = 'utility-primary';
        searchEmails.textContent = 'Search Emails';
        searchEmails.addEventListener('click', () => {
          openAppDrawer(appId);
          // Trigger Gmail search UI
          triggerGmailSearchUI();
        });
        actions.appendChild(searchEmails);
      }

      // Gmail-specific: Add "Draft Email" button
      if (appId === 'gmail' && detail.granted && (detail.granted.includes('CREATE_DRAFT') || detail.granted.includes('SEND_EMAIL'))) {
        const draftEmail = document.createElement('button');
        draftEmail.type = 'button';
        draftEmail.className = 'utility-secondary';
        draftEmail.textContent = 'Draft Email';
        draftEmail.addEventListener('click', () => {
          openDraftEditor();
        });
        actions.appendChild(draftEmail);
      }
    }

    const disconnect = document.createElement('button');
    disconnect.type = 'button';
    disconnect.className = 'utility-secondary';
    disconnect.textContent = 'Disconnect';
    disconnect.addEventListener('click', async () => {
      disconnect.disabled = true;
      try {
        await integrationDisconnect(appId);
        toast('Disconnected');
        closeAppDrawer();
        refreshApps();
      } catch (err) {
        toast(err.message || 'Could not disconnect', 'error');
        disconnect.disabled = false;
      }
    });
    actions.appendChild(disconnect);

    // Show Verify for connected apps
    if (!detail.lastTest) {
      const verify = document.createElement('button');
      verify.type = 'button';
      verify.className = 'utility-primary';
      verify.textContent = 'Verify Connection';
      verify.addEventListener('click', async () => {
        verify.disabled = true;
        verify.textContent = 'Verifying…';
        try {
          const r = await integrationTest(appId);
          const ok = r && r.test && r.test.ok;
          toast(ok ? 'Connection verified' : 'Verification failed', ok ? 'info' : 'error');
          refreshApps();
          openAppDrawer(appId);
        } catch (err) {
          toast(err.message || 'Verification failed', 'error');
        }
        verify.disabled = false;
        verify.textContent = 'Verify Connection';
      });
      actions.appendChild(verify);
    }
  } else if (detail.status === 'not_configured') {
    // Admin Setup Required message for OAuth apps
    if (isOAuthApp && detail.provider) {
      const setupNote = document.createElement('div');
      setupNote.className = 'utility-status-line';
      setupNote.style.fontSize = '12px';
      setupNote.style.color = 'var(--text-muted)';
      setupNote.style.marginBottom = '8px';
      setupNote.textContent = 'Admin setup required: Configure Google OAuth credentials in .env';
      body.insertBefore(setupNote, actions);
      // Still show Connect button, but it will fail with a helpful error
      const connectDisabled = document.createElement('button');
      connectDisabled.type = 'button';
      connectDisabled.className = 'utility-primary';
      connectDisabled.textContent = 'Connect (setup required)';
      connectDisabled.disabled = true;
      connectDisabled.title = 'OAuth credentials not configured in .env';
      actions.appendChild(connectDisabled);
    } else {
      // Non-OAuth apps that are not configured
      const connect = document.createElement('button');
      connect.type = 'button';
      connect.className = 'utility-primary';
      connect.textContent = 'Connect';
      connect.addEventListener('click', async () => {
        connect.disabled = true;
        connect.textContent = 'Connecting…';
        try {
          await integrationConnect(appId, {});
          toast('Connected');
          closeAppDrawer();
          refreshApps();
        } catch (err) {
          toast(err.message || 'Could not connect', 'error');
          connect.disabled = false;
          connect.textContent = 'Connect';
        }
      });
      actions.appendChild(connect);
    }
  } else if (detail.status === 'not_connected' || detail.status === 'disconnected') {
    // OAuth is configured but no account connected - show Connect
    const connect = document.createElement('button');
    connect.type = 'button';
    connect.className = 'utility-primary';
    connect.textContent = 'Connect';
    connect.addEventListener('click', async () => {
      connect.disabled = true;
      connect.textContent = 'Connecting…';
      try {
        await integrationConnect(appId, {});
        toast('Connected');
        closeAppDrawer();
        refreshApps();
      } catch (err) {
        toast(err.message || 'Could not connect', 'error');
        connect.disabled = false;
        connect.textContent = 'Connect';
      }
    });
    actions.appendChild(connect);
  } else if (detail.status !== 'coming_soon' && detail.status !== 'error') {
    const connect = document.createElement('button');
    connect.type = 'button';
    connect.className = 'utility-primary';
    connect.textContent = 'Connect';
    connect.addEventListener('click', async () => {
      connect.disabled = true;
      connect.textContent = 'Connecting…';
      try {
        await integrationConnect(appId, {});
        toast('Connected');
        closeAppDrawer();
        refreshApps();
      } catch (err) {
        toast(err.message || 'Could not connect', 'error');
        connect.disabled = false;
        connect.textContent = 'Connect';
      }
    });
    actions.appendChild(connect);
  } else if (detail.status === 'error') {
    const errorNote = document.createElement('div');
    errorNote.className = 'utility-status-line';
    errorNote.style.fontSize = '12px';
    errorNote.style.color = 'var(--error, #ef4444)';
    errorNote.textContent = 'Connection error. Please reconnect.';
    body.insertBefore(errorNote, actions);
  }
  body.appendChild(actions);

  const note = document.createElement('p');
  note.className = 'utility-status-line';
  if (isOAuthApp) {
    note.textContent = 'OAuth 2.0 tokens are stored server-side and encrypted.';
  } else {
    note.textContent = 'API keys are stored server-side and never shown here.';
  }
  body.appendChild(note);
}

function closeAppDrawer() {
  const drawer = document.getElementById('appDrawer');
  if (drawer) drawer.hidden = true;
  appsState.selectedId = null;
}
document.getElementById('appDrawerClose')?.addEventListener('click', closeAppDrawer);

/* ---------- Gmail UI helpers ---------- */

/** Show Gmail search interface in the app drawer */
async function triggerGmailSearchUI() {
  const drawer = document.getElementById('appDrawer');
  const body = document.getElementById('appDrawerBody');
  if (!drawer || !body) return;

  // Build Gmail search UI
  body.innerHTML = '';

  const searchTitle = document.createElement('h3');
  searchTitle.className = 'utility-detail-name';
  searchTitle.textContent = 'Gmail Search';
  body.appendChild(searchTitle);

  const searchForm = document.createElement('div');
  searchForm.className = 'utility-form';
  searchForm.innerHTML = `
    <div class="settings-row">
      <div><strong>Search query</strong><small>Enter search terms (e.g., "from:barathi@ in:inbox")</small></div>
      <input type="search" id="gmailSearchInput" placeholder="Search emails..." style="width: 200px">
    </div>
    <div class="settings-row">
      <div><strong>Maximum results</strong></div>
      <input type="number" id="gmailMaxResults" value="10" min="1" max="50" style="width: 60px">
    </div>
  `;
  body.appendChild(searchForm);

  const searchBtn = document.createElement('button');
  searchBtn.type = 'button';
  searchBtn.className = 'utility-primary';
  searchBtn.textContent = 'Search';
  body.appendChild(searchBtn);

  const resultsDiv = document.createElement('div');
  resultsDiv.id = 'gmailResults';
  resultsDiv.className = 'gmail-results';
  body.appendChild(resultsDiv);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'utility-secondary';
  closeBtn.textContent = 'Close';
  closeBtn.style.marginTop = '10px';
  closeBtn.addEventListener('click', () => {
    refreshApps();
    openAppDrawer('gmail');
  });
  body.appendChild(closeBtn);

  // Search button handler
  searchBtn.addEventListener('click', async () => {
    const q = document.getElementById('gmailSearchInput')?.value?.trim();
    const max = Number(document.getElementById('gmailMaxResults')?.value || 10);
    if (!q) return toast('Please enter a search query', 'info');

    searchBtn.disabled = true;
    searchBtn.textContent = 'Searching…';
    resultsDiv.innerHTML = '<p class="utility-status-line">Searching Gmail…</p>';

    try {
      // Use the integrations API to search
      const result = await executeIntegration({
        tool: 'gmail.search',
        args: { q, max }
      });

      if (result.ok && result.sources && result.sources.length) {
        const items = result.sources[0].items || [];
        if (items.length) {
          resultsDiv.innerHTML = `
            <p class="utility-status-line">Found ${items.length} email(s)</p>
            <ul class="utility-perm-list">
              ${items.map(item => `
                <li style="margin-bottom: 8px; padding: 8px; border: 1px solid var(--border); border-radius: 6px;">
                  <strong>${item.title || '(no subject)'}</strong>
                  <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">
                    ${item.meta || ''}
                  </div>
                  <button class="ac-btn-details" style="margin-top: 6px;" onclick="openEmailDetail('${item.title || ''}', '${encodeURIComponent(JSON.stringify(item).replace(/"/g, '\\"'))}')">
                    Read
                  </button>
                </li>
              `).join('')}
            </ul>
          `;
        } else {
          resultsDiv.innerHTML = '<p class="utility-status-line">No emails found matching your search.</p>';
        }
      } else {
        resultsDiv.innerHTML = `<p class="utility-status-line">Search failed: ${result.detail || result.error || 'unknown error'}</p>`;
      }
    } catch (err) {
      resultsDiv.innerHTML = `<p class="utility-status-line">Error: ${err.message || 'Search failed'}</p>`;
    }

    searchBtn.disabled = false;
    searchBtn.textContent = 'Search';
  });
}

/** Open draft editor modal */
function openDraftEditor() {
  // Create or reuse draft modal
  let modal = document.getElementById('draftModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'draftModal';
    modal.className = 'utility-overlay';
    modal.innerHTML = `
      <section class="utility-dialog" role="dialog" aria-modal="true" aria-labelledby="draftTitle">
        <header>
          <div><small>Aculyze AI Studio</small><h2 id="draftTitle">Draft Email</h2></div>
          <button class="icon-btn ghost" id="draftClose" type="button" aria-label="Close">×</button>
        </header>
        <div class="utility-content" id="draftContent">
          <div class="settings-row">
            <div><strong>To</strong></div>
            <input type="email" id="draftTo" placeholder="recipient@example.com" style="width: 200px;">
          </div>
          <div class="settings-row">
            <div><strong>Subject</strong></div>
            <input type="text" id="draftSubject" placeholder="Subject" style="width: 200px;">
          </div>
          <div class="settings-row">
            <div><strong>Message</strong></div>
            <textarea id="draftBody" rows="5" placeholder="Your message..." style="width: 100%;"></textarea>
          </div>
          <div class="utility-actions" style="flex-direction: row; gap: 8px; margin-top: 10px;">
            <button class="utility-secondary" id="draftCancel">Cancel</button>
            <button class="utility-primary" id="draftSend">Send</button>
          </div>
          <div id="draftStatus" style="margin-top: 8px; font-size: 12px;"></div>
        </div>
      </section>
    `;
    document.body.appendChild(modal);

    modal.querySelector('#draftClose').addEventListener('click', () => {
      modal.hidden = true;
    });
    modal.querySelector('#draftCancel').addEventListener('click', () => {
      modal.hidden = true;
    });
  }

  // Reset form
  modal.querySelector('#draftTo').value = '';
  modal.querySelector('#draftSubject').value = 'Message from Zara';
  modal.querySelector('#draftBody').value = '';
  modal.querySelector('#draftStatus').textContent = '';
  modal.hidden = false;

  const sendBtn = modal.querySelector('#draftSend');
  sendBtn.disabled = true;
  sendBtn.textContent = 'Send';

  const toInput = modal.querySelector('#draftTo');
  const subjectInput = modal.querySelector('#draftSubject');
  const bodyInput = modal.querySelector('#draftBody');
  const statusDiv = modal.querySelector('#draftStatus');

  // Enable button when form is valid
  const updateState = () => {
    const valid = toInput.value.trim() && bodyInput.value.trim();
    sendBtn.disabled = !valid;
  };

  toInput.addEventListener('input', updateState);
  subjectInput.addEventListener('input', updateState);
  bodyInput.addEventListener('input', updateState);

  sendBtn.addEventListener('click', async () => {
    const to = toInput.value.trim();
    const subject = subjectInput.value.trim();
    const body = bodyInput.value.trim();

    if (!isValidEmail(to)) {
      statusDiv.textContent = 'Please enter a valid email address.';
      return;
    }

    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    statusDiv.textContent = '';

    try {
      const result = await executeIntegration({
        tool: 'gmail.send_message',
        args: { to, subject, body },
        confirm: true // Requires user confirmation
      });

      if (result.ok) {
        statusDiv.textContent = '✓ Email sent successfully!';
        statusDiv.style.color = 'var(--accent)';
        setTimeout(() => {
          modal.hidden = true;
          refreshApps();
        }, 1500);
      } else {
        statusDiv.textContent = result.error || 'Failed to send email.';
        statusDiv.style.color = 'var(--error, #ef4444)';
      }
    } catch (err) {
      statusDiv.textContent = err.message || 'Failed to send email.';
      statusDiv.style.color = 'var(--error, #ef4444)';
    }

    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
  });
}

/** Validate email format */
function isValidEmail(address) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(String(address || '').trim());
}

/* ---------- New chat button (right panel) — dispatches by active agent ---------- */
document.getElementById('copilotNewChat')?.addEventListener('click', () => {
  if (state.activeAgent === 'sales') {
    newSalesConversation();
  } else {
    newConversation();
  }
});

/* ---------- Inbox composer event listeners ---------- */
els.inboxSend?.addEventListener('click', sendInboxMessage);
els.inboxAi?.addEventListener('click', async (e) => {
  e.preventDefault();
  if (!authState.user) {
    toast('Sign in to use AI drafting', 'info');
    return;
  }
  if (!els.inboxInput?.value?.trim()) {
    if (els.inboxMessages) {
      const lastMsg = els.inboxMessages.lastElementChild;
      const lastContent = lastMsg?.querySelector('.msg-content')?.textContent;
      if (lastContent) els.inboxInput.value = `Respond to: ${lastContent.slice(0, 100)}...`;
    }
  }
  await draftInboxWithAi();
});
els.inboxInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendInboxMessage();
  }
  autoGrowTextarea();
});
els.inboxInput?.addEventListener('input', autoGrowTextarea);

/* ==========================================================================
   SETTINGS OVERLAY (ported from app.js) ================================== */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const settingsClose = $('#settingsClose');
const settingsBack = $('#settingsBack');

function openSettings(page) {
  setView('settings');
  syncSettingsForm();
  refreshSalesPluginStatus();
  refreshAccountProvider();
  const target = page || 'account';
  showSettingsPage(target);
}
function closeSettings() {
  setView('home');
}
function showSettingsPage(page) {
  $$('.spanel').forEach((s) => s.classList.toggle('active', s.dataset.page === page));
  $$('.snav-item').forEach((b) => {
    const p = b.dataset.page;
    const active = p === page
      || (page === 'provider-detail' && p === 'models')
      || (page === 'sales-detail' && p === 'apps')
      || (page === 'app-detail' && p === 'apps');
    b.classList.toggle('active', active);
  });
  document.getElementById('settingsPage')?.dataset.page?.toString();
  document.getElementById('settingsPage')?.setAttribute('data-page', page);
  document.getElementById('settingsPage')?.setAttribute('data-view', page === 'account' ? 'list' : 'detail');
  const content = document.querySelector('.settings-content');
  if (content) content.scrollTop = 0;
}

function syncSettingsForm() {
  const providerName = state.prefs.providerName || 'lmstudio';
  $('#setProvider').value = providerName === 'lmstudio' ? 'LM Studio' : providerName;
  const sel = $('#setModel');
  sel.innerHTML = '';
  if (state.prefs.availableModels && state.prefs.availableModels.length > 0) {
    for (const m of state.prefs.availableModels) {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.name || m.id;
      sel.appendChild(o);
    }
    sel.value = state.prefs.model || state.prefs.availableModels[0].id;
  } else {
    const o = document.createElement('option');
    o.textContent = state.prefs.model || 'No models available';
    o.value = state.prefs.model || '';
    sel.appendChild(o);
  }
  $('#setTemp').value = state.prefs.temperature || 0.7;
  $('#setMaxTokens').value = state.prefs.maxTokens || 2048;
  const setSwitch = (id, on) => {
    const wrap = document.getElementById(id);
    if (!wrap) return;
    const input = wrap.tagName === 'LABEL' ? wrap.querySelector('input') : wrap;
    if (input) input.checked = !!on;
    wrap.setAttribute('aria-checked', on ? 'true' : 'false');
  };
  $$('#themeGroup button').forEach((b) => {
    b.classList.toggle('active', b.value === state.prefs.theme);
  });
  setSwitch('setCompact', state.prefs.compact);
  setSwitch('setAnimations', state.prefs.animations !== false);
  setSwitch('setVoiceReplies', !!state.prefs.voiceReplies);
  setSwitch('setWebResearch', !!state.prefs.webResearch);
}

async function refreshSalesPluginStatus({ fillFields = true } = {}) {
  const line = $('#salesStatusLine');
  line.textContent = 'Checking…';
  try {
    const s = await salesStatus();
    if (fillFields) {
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

$('#salesConnectBtn')?.addEventListener('click', async () => {
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

$('#setSalesUse')?.addEventListener('change', async (e) => {
  try {
    await salesConnect({ inUse: e.target.checked });
    toast(e.target.checked ? '🔌 Sales AI plugin is now in use' : 'Sales AI plugin paused');
  } catch (err) { toast(err.message || 'Could not update plugin'); }
  await refreshSalesPluginStatus({ fillFields: false });
});

$('#salesKeyEye')?.addEventListener('click', () => {
  const key = $('#setSalesKey');
  const show = key.type === 'password';
  key.type = show ? 'text' : 'password';
  $('#salesKeyEye').setAttribute('aria-label', show ? 'Hide API key' : 'Show API key');
});

settingsClose?.addEventListener('click', closeSettings);
settingsBack?.addEventListener('click', () => {
  const settingsPage = document.getElementById('settingsPage');
  const page = settingsPage?.getAttribute('data-page');
  const parent = { 'provider-detail': 'models', 'sales-detail': 'apps', 'app-detail': 'apps' }[page];
  if (parent) showSettingsPage(parent);
  else settingsPage?.setAttribute('data-view', 'list');
});

$$('.snav-item')?.forEach((b) =>
  b.addEventListener('click', () => showSettingsPage(b.dataset.page))
);

/* ---------- Settings form listeners ---------- */
$('#setProvider')?.addEventListener('change', (e) => {
  state.prefs.providerName = e.target.value;
  savePrefs();
});
$('#setModel')?.addEventListener('change', (e) => {
  state.prefs.model = e.target.value;
  savePrefs();
});
$('#setTemp')?.addEventListener('change', (e) => {
  state.prefs.temperature = Number(e.target.value) || 0.7;
  savePrefs();
});
$('#setMaxTokens')?.addEventListener('change', (e) => {
  state.prefs.maxTokens = Number(e.target.value) || 2048;
  savePrefs();
});
$$('#themeGroup button')?.forEach((b) =>
  b.addEventListener('click', () => {
    state.prefs.theme = b.value;
    savePrefs();
    applyTheme(b.value);
    $$('#themeGroup button').forEach((x) => x.classList.toggle('active', x === b));
  })
);
const bindSwitch = (id, key, after) => {
  const wrap = document.getElementById(id);
  if (!wrap) return;
  const input = wrap.tagName === 'LABEL' ? wrap.querySelector('input') : wrap;
  if (!input) return;
  input.addEventListener('change', (e) => {
    state.prefs[key] = e.target.checked;
    savePrefs();
    wrap.setAttribute('aria-checked', e.target.checked ? 'true' : 'false');
    if (after) after(e.target.checked);
  });
};
bindSwitch('setCompact', 'compact', (on) => document.body.classList.toggle('compact', !!on));
bindSwitch('setAnimations', 'animations', (on) => document.body.classList.toggle('no-animations', !on));
bindSwitch('setVoiceReplies', 'voiceReplies');
bindSwitch('setWebResearch', 'webResearch');

/* ---------- Settings navigation buttons ---------- */
$('#manageSalesBtn')?.addEventListener('click', () => showSettingsPage('sales-detail'));
$('#appsBtn')?.addEventListener('click', () => {
  closeSettings();
  setView('apps');
});
$('#clearLocalData')?.addEventListener('click', () => {
  try {
    localStorage.removeItem('aculyze.studio.conversations.v1');
    localStorage.removeItem('aculyze.studio.threads.v1');
    localStorage.removeItem('aculyze.studio.sales-conversations.v1');
    state.conversationCache = [];
    state.threads = [];
    state.selectedConversationId = null;
    salesState.conversationCache = [];
    salesState.selectedConversationId = null;
    toast('Local conversation data cleared');
  } catch { toast('Could not clear local data', 'error'); }
});

/* ---------- Account panel provider status ---------- */
async function refreshAccountProvider() {
  const line = document.getElementById('accountProvider');
  const badge = document.getElementById('accountProviderStatus');
  if (!line || !badge) return;
  try {
    const s = await fetchStatus();
    line.textContent = s.status === 'connected' ? `${s.provider} · connected` : `${s.provider} · ${s.status}`;
    badge.textContent = s.status === 'connected' ? 'Online' : 'Offline';
    badge.classList.toggle('connected', s.status === 'connected');
  } catch {
    line.textContent = 'Backend unreachable';
    badge.textContent = 'Offline';
    badge.classList.remove('connected');
  }
}

/* ---------- Inbox search + back + attach listeners ---------- */
els.inboxSearch?.addEventListener('input', () => {
  const q = els.inboxSearch.value.trim().toLowerCase();
  const rows = els.inboxList?.querySelectorAll('.inbox-row') || [];
  rows.forEach((row) => {
    const name = row.querySelector('.inbox-name')?.textContent?.toLowerCase() || '';
    row.style.display = name.includes(q) ? '' : 'none';
  });
});
els.inboxBack?.addEventListener('click', () => {
  inboxState.selectedUserId = null;
  closeAiDraft();
  if (els.inboxDetail) els.inboxDetail.hidden = true;
  if (els.inboxEmptyDetail) els.inboxEmptyDetail.style.display = '';
  renderInboxList();
});

/* ==========================================================================
   SALES DASHBOARD — live data from Aculyze LMS
   ========================================================================== */
let salesDashboardState = { connected: false, permission: false, lastUpdated: null };

/* Sections hidden while a non-success state is shown (markup is preserved so
   Retry can restore real data without a page reload). */
const SALES_SECTIONS_SEL = '#salesKpis, #view-sales .sd-row, #view-sales .customers-table-panel';

const SALES_STATE_MESSAGES = {
  loading: 'Loading sales data…',
  disconnected: 'Aculyze LMS is not connected.',
  auth: 'Unable to load Sales Agent data. LMS API authentication failed.',
  permission: 'Sales Agent does not have the required LMS permission.',
  validation: 'Aculyze LMS rejected the request (validation error).',
  not_found: 'Aculyze LMS endpoint not found.',
  rate_limited: 'Aculyze LMS rate limit exceeded — try again shortly.',
  unavailable: 'Aculyze LMS is temporarily unavailable. Try again later.',
  network: 'Unable to reach Aculyze LMS. Check the server connection.',
  nodata: 'No sales data available for this period.',
};

function setSalesSectionsVisible(show) {
  document.querySelectorAll(SALES_SECTIONS_SEL).forEach((el) => { el.hidden = !show; });
}

/** Header live pill: connecting / live / error + last-updated timestamp. */
function setSalesLive(state, timeText) {
  const pill = document.getElementById('salesLive');
  const text = document.getElementById('salesLiveText');
  const time = document.getElementById('salesLastUpdated');
  if (pill) pill.className = `sd-live is-${state}`;
  if (text) {
    text.textContent = state === 'live' ? 'Connected'
      : state === 'loading' ? 'Refreshing…'
      : state === 'error' ? 'Unavailable'
      : 'Connecting…';
  }
  if (time) time.textContent = timeText || 'Last updated —';
}

/** Marks the refresh button busy while a load is in flight. */
function setRefreshBusy(busy) {
  const btn = document.getElementById('salesRefresh');
  if (!btn) return;
  btn.classList.toggle('is-busy', !!busy);
  btn.disabled = !!busy;
  const label = btn.querySelector('span');
  if (label) label.textContent = busy ? 'Refreshing…' : 'Refresh data';
}

/** HTML-escape LMS strings; never let objects reach innerHTML. */
function esc(v) {
  if (v === null || v === undefined || v === '') return '-';
  if (typeof v === 'object') return '-'; // guards against [object Object]
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** `assigned_employee: { id, name }` → name; falls back to plain string fields. */
function employeeName(r) {
  const e = r && r.assigned_employee;
  if (e && typeof e === 'object') return e.name || (e.id != null ? `#${e.id}` : '-');
  return r && (r.employee || r.assignee) || '-';
}

/** ISO timestamps → YYYY-MM-DD for compact table cells. */
function dateOnly(v) {
  if (!v) return '-';
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}T/.test(s) ? s.slice(0, 10) : s;
}

/** Read { error, category, label } from a failed backend response. */
async function readSalesError(res) {
  const data = await res.json().catch(() => ({}));
  return { status: res.status, category: data.category || '', label: data.label || '', error: data.error || '' };
}

/** Map a failed response to one of SALES_STATE_MESSAGES' keys. */
function salesErrorType(info) {
  const byStatus = { 401: 'auth', 403: 'permission', 404: 'not_found', 409: 'disconnected', 422: 'validation', 429: 'rate_limited' };
  const byCategory = {
    invalid_key: 'auth', permission: 'permission', not_found: 'not_found',
    not_connected: 'disconnected', validation: 'validation', rate_limited: 'rate_limited',
    server_unavailable: 'unavailable',
  };
  return byCategory[info.category] || byStatus[info.status] || 'unavailable';
}

/** Transient LMS failures worth one silent automatic retry before erroring. */
const SALES_TRANSIENT_ERRORS = new Set(['unavailable', 'network', 'rate_limited']);

/**
 * Auto-retry once for transient errors (LMS timeout, 5xx, rate limit).
 * Returns true when a retry was launched (its result already rendered the
 * dashboard or the error), false when the error should be shown as-is.
 */
async function salesAutoRetry(type, attempt) {
  if (attempt >= 1 || !SALES_TRANSIENT_ERRORS.has(type)) return false;
  const note = document.getElementById('salesDataNote');
  if (note) {
    note.hidden = false;
    note.textContent = 'Aculyze LMS responded slowly — retrying…';
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await loadSalesDashboard(attempt + 1);
  return true;
}

async function loadSalesDashboard(attempt = 0) {
  const note = document.getElementById('salesDataNote');
  showSalesState('loading');
  setRefreshBusy(true);
  setSalesLive('loading', document.getElementById('salesLastUpdated')?.textContent || 'Last updated —');

  const dateFrom = document.getElementById('salesDateFrom')?.value || '';
  const dateTo = document.getElementById('salesDateTo')?.value || '';
  const range = [];
  if (dateFrom) range.push(`date_from=${encodeURIComponent(dateFrom)}`);
  if (dateTo) range.push(`date_to=${encodeURIComponent(dateTo)}`);
  const rangeQs = range.length ? `?${range.join('&')}` : '';
  const rangeAmp = range.length ? `&${range.join('&')}` : '';
  if (note) {
    note.hidden = false;
    note.textContent = range.length
      ? `Loading Aculyze LMS data for ${dateFrom || '…'} → ${dateTo || '…'}…`
      : 'Loading Aculyze LMS data…';
  }

  let summary = null, salesRows = [], leadsRows = [], customersRows = [];
  try {
    const [sRes, salesRes, leadsRes, customersRes] = await Promise.all([
      fetch(`/api/sales/summary${rangeQs}`),
      fetch(`/api/sales/records?resource=sales&per_page=10${rangeAmp}`),
      fetch(`/api/sales/records?resource=leads&per_page=10${rangeAmp}`),
      fetch(`/api/sales/records?resource=customers&per_page=10${rangeAmp}`),
    ]);

    // Summary drives KPIs + charts — a failure here is a dashboard failure.
    if (!sRes.ok) {
      const info = await readSalesError(sRes);
      const type = salesErrorType(info);
      if (await salesAutoRetry(type, attempt)) return;
      // Show a human reason: map transport codes to plain words, keep the
      // full raw text in the tooltip for support/debugging.
      const raw = String(info.error || info.label || '')
        .replace(/^Could not reach Aculyze LMS\.\s*/, '')
        .replace(/^Server unavailable[—-]?\s*/, '')
        .trim();
      const low = raw.toLowerCase();
      let reason = '';
      if (type === 'auth' || type === 'permission') reason = '';
      else if (low.includes('connect_timeout') || low.includes('etimedout') || low.includes('timed out')) {
        reason = 'connection to the LMS server timed out — its firewall/network is not accepting requests from this server';
      } else if (low.includes('enotfound') || low.includes('eai_again')) {
        reason = 'the LMS server address could not be resolved (DNS)';
      } else if (low.includes('refused')) {
        reason = 'the LMS server refused the connection';
      } else if (raw) reason = raw.slice(0, 120);
      showSalesState(type, reason ? `(${reason})` : '', raw);
      return;
    }
    summary = await sRes.json();

    // Tables: abort on credential/permission errors, otherwise keep whatever loaded.
    for (const [res, setter] of [[salesRes, (d) => { salesRows = d; }], [leadsRes, (d) => { leadsRows = d; }], [customersRes, (d) => { customersRows = d; }]]) {
      if (res.ok) { setter((await res.json()).rows || []); continue; }
      const info = await readSalesError(res);
      const type = salesErrorType(info);
      if (type === 'auth' || type === 'permission' || type === 'disconnected') { showSalesState(type); return; }
    }
  } catch (err) {
    console.warn('[sales-dashboard] request failed:', err && err.message);
    if (await salesAutoRetry('network', attempt)) return;
    showSalesState('network');
    return;
  }

  if (!summary || !summary.summary) { showSalesState('nodata'); return; }

  salesDashboardState.connected = true;
  salesDashboardState.permission = true;
  salesDashboardState.lastUpdated = new Date();

  setSalesSectionsVisible(true);
  setRefreshBusy(false);
  const stateBox = document.getElementById('salesState');
  if (stateBox) stateBox.hidden = true;
  const stamp = salesDashboardState.lastUpdated.toLocaleTimeString();
  setSalesLive('live', `Last updated ${stamp}`);
  if (note) {
    note.hidden = false;
    note.textContent = `Live from Aculyze LMS · Updated ${stamp}`;
  }

  const summ = summary.summary;
  const currency = summary.currency || 'INR';
  const kpiEls = {
    total_sales: document.querySelector('#salesKpis [data-context="total_sales"] strong'),
    orders: document.querySelector('#salesKpis [data-context="orders"] strong'),
    customers: document.querySelector('#salesKpis [data-context="customers"] strong'),
    average_order_value: document.querySelector('#salesKpis [data-context="average_order_value"] strong'),
  };
  if (kpiEls.total_sales) kpiEls.total_sales.textContent = `${currency} ${(summ.total_sales || 0).toLocaleString()}`;
  if (kpiEls.orders) kpiEls.orders.textContent = (summ.orders || 0).toLocaleString();
  if (kpiEls.customers) kpiEls.customers.textContent = (summ.customers || 0).toLocaleString();
  if (kpiEls.average_order_value) kpiEls.average_order_value.textContent = `${currency} ${(summ.average_order_value || 0).toLocaleString()}`;

  renderSalesChart(summary.byMonth || []);
  renderOrdersChart(summary.byMonth || []);
  renderEmployeeBars(summary.byEmployee || []);
  renderStatusDonut(summary.byStatus || []);

  const employeeData = document.getElementById('employeeData');
  const statusData = document.getElementById('statusData');

  const salesBody = document.getElementById('salesTableBody');
  if (salesBody) {
    if (salesRows.length) {
      salesBody.innerHTML = salesRows.map((r) => `
        <tr>
          <td>${esc(r.proposal_number || (r.id != null ? `#${r.id}` : ''))}</td>
          <td>${esc(r.customer)}</td>
          <td>${esc(r.employee)}</td>
          <td class="sd-amount">${Number(r.amount || 0).toLocaleString()}</td>
          <td>${esc(r.currency || currency)}</td>
          <td><span class="app-status ${r.status === 'won' ? 'connected' : r.status === 'lost' ? 'action' : ''}">${esc(r.status)}</span></td>
          <td>${esc(dateOnly(r.date))}</td>
        </tr>
      `).join('');
    } else {
      salesBody.innerHTML = '<tr><td colspan="7" class="data-empty">No sales data available for this period.</td></tr>';
    }
  }

  const salesMetrics = document.getElementById('salesMetrics');
  if (salesMetrics) {
    const totalAmt = salesRows.reduce((s, r) => s + Number(r.amount || 0), 0);
    salesMetrics.innerHTML = `
      <span class="sd-metric"><span>Records</span><b>${salesRows.length}</b></span>
      <span class="sd-metric"><span>Total value</span><b>${esc(currency)} ${totalAmt.toLocaleString()}</b></span>
      <span class="sd-metric"><span>Avg deal</span><b>${esc(currency)} ${salesRows.length ? Math.round(totalAmt / salesRows.length).toLocaleString() : '0'}</b></span>
    `;
  }

  const leadsBody = document.getElementById('leadsTableBody');
  if (leadsBody) {
    if (leadsRows.length) {
      leadsBody.innerHTML = leadsRows.map((r) => `
        <tr>
          <td>${esc(r.company)}</td>
          <td><span class="app-status">${esc(r.status_label || r.status)}</span></td>
          <td>${esc(r.stage)}</td>
          <td><span class="app-status">${esc(r.temperature_label || r.temperature)}</span></td>
          <td>${esc(employeeName(r))}</td>
          <td>${esc(dateOnly(r.created_at))}</td>
        </tr>
      `).join('');
    } else {
      leadsBody.innerHTML = '<tr><td colspan="6" class="data-empty">No leads data available.</td></tr>';
    }
  }

  const leadsMetrics = document.getElementById('leadsMetrics');
  if (leadsMetrics) {
    const warm = leadsRows.filter((r) => String(r.temperature_label || r.temperature || '').toLowerCase() === 'warm').length;
    const hot = leadsRows.filter((r) => String(r.temperature_label || r.temperature || '').toLowerCase() === 'hot').length;
    leadsMetrics.innerHTML = `
      <span class="sd-metric"><span>Total leads</span><b>${leadsRows.length}</b></span>
      <span class="sd-metric"><span>Warm</span><b>${warm}</b></span>
      <span class="sd-metric"><span>Hot</span><b>${hot}</b></span>
    `;
  }

  const custBody = document.getElementById('customersTableBody');
  if (custBody) {
    if (customersRows.length) {
      custBody.innerHTML = customersRows.map((r) => `
        <tr>
          <td>${esc(r.company_name || r.company)}</td>
          <td>${esc(r.city)}</td>
          <td>${esc(r.industry)}</td>
          <td>${esc(employeeName(r))}</td>
          <td>${esc(dateOnly(r.created_at))}</td>
        </tr>
      `).join('');
    } else {
      custBody.innerHTML = '<tr><td colspan="5" class="data-empty">No customers data available.</td></tr>';
    }
  }

  const customersMetrics = document.getElementById('customersMetrics');
  if (customersMetrics) {
    customersMetrics.innerHTML = `<span class="sd-metric"><span>Total customers</span><b>${customersRows.length}</b></span>`;
  }

  // Hide empty-state placeholders now that charts/tables render into their panels.
  [employeeData, statusData].forEach((el) => { if (el) el.style.display = 'none'; });
}

/** Monthly revenue line chart (by_month.total_sales) — cyan. */
function renderSalesChart(byMonth) {
  const svg = document.getElementById('revenueChart');
  const empty = document.getElementById('revenueChartEmpty');
  if (!svg) return;
  if (!byMonth || !byMonth.length) { svg.innerHTML = ''; if (empty) empty.hidden = false; return; }
  if (empty) empty.hidden = true;

  const width = svg.clientWidth || 660;
  const height = 288;
  const padding = { t: 10, r: 24, b: 34, l: 42 };
  const chartW = width - padding.l - padding.r;
  const chartH = height - padding.t - padding.b;

  const months = byMonth.map((m) => m.month);
  const values = byMonth.map((m) => Number(m.total_sales) || 0);
  const maxVal = Math.max(...values, 1);

  const xAt = (i) => (values.length === 1 ? padding.l + chartW / 2 : padding.l + (i / (values.length - 1)) * chartW);
  const yAt = (v) => height - padding.b - (v / maxVal) * chartH;

  svg.innerHTML = '';
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);

  // grid
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  for (let i = 0; i < values.length; i++) {
    const x = xAt(i);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x); line.setAttribute('y1', padding.t);
    line.setAttribute('x2', x); line.setAttribute('y2', height - padding.b);
    line.setAttribute('class', 'chart-grid');
    g.appendChild(line);
  }
  svg.appendChild(g);

  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const grad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
  grad.setAttribute('id', 'sdLine'); grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0'); grad.setAttribute('x2', '0'); grad.setAttribute('y2', '1');
  const s1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop'); s1.setAttribute('offset', '0%'); s1.setAttribute('stop-color', '#22D3EE'); s1.setAttribute('stop-opacity', '1');
  const s2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop'); s2.setAttribute('offset', '100%'); s2.setAttribute('stop-color', '#8B4DFF'); s2.setAttribute('stop-opacity', '1');
  grad.appendChild(s1); grad.appendChild(s2); defs.appendChild(grad);

  const areaGrad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
  areaGrad.setAttribute('id', 'sdArea'); areaGrad.setAttribute('x1', '0'); areaGrad.setAttribute('y1', '0'); areaGrad.setAttribute('x2', '0'); areaGrad.setAttribute('y2', '1');
  const a1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop'); a1.setAttribute('offset', '0%'); a1.setAttribute('stop-color', '#22D3EE'); a1.setAttribute('stop-opacity', '0.35');
  const a2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop'); a2.setAttribute('offset', '100%'); a2.setAttribute('stop-color', '#22D3EE'); a2.setAttribute('stop-opacity', '0');
  areaGrad.appendChild(a1); areaGrad.appendChild(a2); defs.appendChild(areaGrad);
  svg.appendChild(defs);

  const points = values.map((v, i) => `${xAt(i)},${yAt(v)}`);

  const areaPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  areaPath.setAttribute('d', `M ${padding.l},${height - padding.b} L ${points.join(' ')} L ${xAt(values.length - 1)},${height - padding.b} Z`);
  areaPath.setAttribute('class', 'chart-area'); svg.appendChild(areaPath);

  const linePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  linePath.setAttribute('d', values.length > 1 ? `M ${points.join(' ')}` : `M ${points[0]} L ${points[0]}`);
  linePath.setAttribute('class', 'chart-line'); svg.appendChild(linePath);

  values.forEach((v, i) => {
    const x = xAt(i); const y = yAt(v);
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('r', 4); dot.setAttribute('class', 'chart-dot'); svg.appendChild(dot);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', x); label.setAttribute('y', height - padding.b + 17);
    label.setAttribute('text-anchor', 'middle'); label.setAttribute('class', 'chart-axis');
    label.textContent = months[i]; svg.appendChild(label);
  });
}

/** Monthly orders line chart (by_month.orders) — violet. */
function renderOrdersChart(byMonth) {
  const svg = document.getElementById('ordersChart');
  const empty = document.getElementById('ordersChartEmpty');
  if (!svg) return;
  if (!byMonth || !byMonth.length) { svg.innerHTML = ''; if (empty) empty.hidden = false; return; }
  if (empty) empty.hidden = true;

  const width = svg.clientWidth || 440;
  const height = 208;
  const padding = { t: 10, r: 16, b: 34, l: 42 };
  const chartW = width - padding.l - padding.r;
  const chartH = height - padding.t - padding.b;

  const months = byMonth.map((m) => m.month);
  const values = byMonth.map((m) => Number(m.orders) || 0);
  const maxVal = Math.max(...values, 1);

  const xAt = (i) => (values.length === 1 ? padding.l + chartW / 2 : padding.l + (i / (values.length - 1)) * chartW);
  const yAt = (v) => height - padding.b - (v / maxVal) * chartH;

  svg.innerHTML = '';
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);

  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const grad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
  grad.setAttribute('id', 'sdLine'); grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0'); grad.setAttribute('x2', '0'); grad.setAttribute('y2', '1');
  const s1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop'); s1.setAttribute('offset', '0%'); s1.setAttribute('stop-color', '#8B4DFF'); s1.setAttribute('stop-opacity', '1');
  const s2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop'); s2.setAttribute('offset', '100%'); s2.setAttribute('stop-color', '#FF4FC3'); s2.setAttribute('stop-opacity', '1');
  grad.appendChild(s1); grad.appendChild(s2); defs.appendChild(grad);

  const areaGrad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
  areaGrad.setAttribute('id', 'sdArea'); areaGrad.setAttribute('x1', '0'); areaGrad.setAttribute('y1', '0'); areaGrad.setAttribute('x2', '0'); areaGrad.setAttribute('y2', '1');
  const a1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop'); a1.setAttribute('offset', '0%'); a1.setAttribute('stop-color', '#8B4DFF'); a1.setAttribute('stop-opacity', '0.30');
  const a2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop'); a2.setAttribute('offset', '100%'); a2.setAttribute('stop-color', '#8B4DFF'); a2.setAttribute('stop-opacity', '0');
  areaGrad.appendChild(a1); areaGrad.appendChild(a2); defs.appendChild(areaGrad);
  svg.appendChild(defs);

  const points = values.map((v, i) => `${xAt(i)},${yAt(v)}`);

  const areaPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  areaPath.setAttribute('d', `M ${padding.l},${height - padding.b} L ${points.join(' ')} L ${xAt(values.length - 1)},${height - padding.b} Z`);
  areaPath.setAttribute('class', 'chart-area'); svg.appendChild(areaPath);

  const linePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  linePath.setAttribute('d', values.length > 1 ? `M ${points.join(' ')}` : `M ${points[0]} L ${points[0]}`);
  linePath.setAttribute('class', 'chart-line orders-line'); svg.appendChild(linePath);

  values.forEach((v, i) => {
    const x = xAt(i); const y = yAt(v);
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('r', 3.5); dot.setAttribute('class', 'chart-dot'); svg.appendChild(dot);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', x); label.setAttribute('y', height - padding.b + 16);
    label.setAttribute('text-anchor', 'middle'); label.setAttribute('class', 'chart-axis');
    label.textContent = months[i]; svg.appendChild(label);
  });
}

/** Ranked horizontal bar chart — sales by employee (total_sales). */
function renderEmployeeBars(byEmployee) {
  const panel = document.getElementById('employeeData');
  if (!panel) return;
  if (!byEmployee || !byEmployee.length) { panel.innerHTML = '<div class="data-empty">No employee data</div>'; panel.style.display = ''; return; }

  const sorted = [...byEmployee].sort((a, b) => Number(b.total_sales || 0) - Number(a.total_sales || 0));
  const maxVal = Math.max(...sorted.map((e) => Number(e.total_sales || 0)), 1);
  const currency = '';

  panel.innerHTML = '<div class="sd-bars"></div>';
  const bars = panel.querySelector('.sd-bars');
  sorted.forEach((e, idx) => {
    const pct = Math.round((Number(e.total_sales || 0) / maxVal) * 100);
    const name = esc(e.employee || e.name || 'Unknown');
    const total = Number(e.total_sales || 0);
    const orders = Number(e.orders || 0);
    const div = document.createElement('div');
    div.className = 'sd-bar-row';
    div.innerHTML = `
      <span class="sd-bar-name">${idx + 1}. ${name}</span>
      <div class="sd-bar-track"><div class="sd-bar-fill" style="width:${pct}%"></div></div>
      <span class="sd-bar-value">${total.toLocaleString()}</span>
    `;
    bars.appendChild(div);
  });
  panel.style.display = '';
}

/** Donut + legend — sales status (by_status). */
function renderStatusDonut(byStatus) {
  const panel = document.getElementById('statusData');
  if (!panel) return;
  if (!byStatus || !byStatus.length) { panel.innerHTML = '<div class="data-empty">No status data</div>'; panel.style.display = ''; return; }

  const total = byStatus.reduce((s, x) => s + Number(x.count || 0), 0);
  const colors = { won: '#22D3EE', hold: '#FFC93A', lost: '#FF4FC3', open: '#8B4DFF' };
  let start = 0;
  const slices = byStatus.map((s) => {
    const sweep = total ? (Number(s.count || 0) / total) * 360 : 0;
    const col = colors[s.status] || '#8B4DFF';
    const end = start + sweep;
    const rad = (a) => (a * Math.PI) / 180;
    const x1 = 74 + 70 * Math.cos(rad(start)); const y1 = 74 + 70 * Math.sin(rad(start));
    const x2 = 74 + 70 * Math.cos(rad(end)); const y2 = 74 + 70 * Math.sin(rad(end));
    const arcFlag = sweep > 180 ? 1 : 0;
    const d = `M ${x1} ${y1} A 70 70 0 ${arcFlag} 1 ${x2} ${y2} L 74 74 Z`;
    const out = { d, col, status: s.status, count: Number(s.count || 0), pct: total ? Math.round((Number(s.count || 0) / total) * 100) : 0 };
    start = end;
    return out;
  });

  panel.innerHTML = `
    <div class="sd-donut-wrap">
      <svg class="sd-donut" viewBox="0 0 148 148" role="img" aria-label="Sales status distribution">
        ${slices.map((sl) => `<path d="${sl.d}" fill="${sl.col}" stroke="#050713" stroke-width="2"/>`).join('')}
        <text class="sd-donut-center-val" x="74" y="72" text-anchor="middle">${total}</text>
        <text class="sd-donut-center-lbl" x="74" y="90" text-anchor="middle">orders</text>
      </svg>
      <div class="sd-legend">
        ${slices.map((sl) => `
          <div class="sd-legend-row">
            <div class="sd-legend-dot" style="background:${sl.col}"></div>
            <span class="sd-legend-name">${sl.status}</span>
            <span class="sd-legend-val">${sl.count} (${sl.pct}%)</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
  panel.style.display = '';
}

function showSalesState(type, detail, title) {
  const note = document.getElementById('salesDataNote');
  const stateBox = document.getElementById('salesState');
  if (!stateBox) return;

  // Loading is announced by the data note only — keep the state box out of it.
  if (type === 'loading') {
    stateBox.hidden = true;
    if (note) note.hidden = false;
    return;
  }

  // Hide the data sections instead of emptying them, so a Retry can restore
  // the real KPI/chart/table markup without a reload.
  setSalesSectionsVisible(false);
  setRefreshBusy(false);
  setSalesLive('error', 'Last updated —');
  if (note) note.hidden = true;

  stateBox.className = `sales-state ${type}`;
  stateBox.hidden = false;
  stateBox.textContent = SALES_STATE_MESSAGES[type] || SALES_STATE_MESSAGES.unavailable;
  if (detail) stateBox.textContent += ` ${detail}`;
  // Full upstream text (transport codes) on hover — short banner stays readable.
  stateBox.title = title || detail || '';

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'period-select sales-retry';
  retry.textContent = 'Retry';
  retry.addEventListener('click', () => loadSalesDashboard());
  stateBox.appendChild(retry);
}

$('#salesRefresh')?.addEventListener('click', () => loadSalesDashboard());
$('#salesDateFrom')?.addEventListener('change', () => loadSalesDashboard());
$('#salesDateTo')?.addEventListener('change', () => loadSalesDashboard());
