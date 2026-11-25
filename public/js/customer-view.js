/**
 * Customer Executive page (Phase 04.4): the website assistant.
 *
 *  First run: business name + website → workspace, crawl, and an assistant.
 *  Assistant tab: settings, live test chat (same engine as the public widget,
 *    with sources), approve + publish, embed code.
 *  Website pages: re-read the site with live progress, see / remove pages.
 *  Leads and Conversations from the public widget.
 *
 * One assistant per business keeps it simple; the API supports more.
 */

import {
  customerWorkspaces, customerCreateWorkspace, customerOverview, customerStartCrawl, customerCrawlStatus,
  customerCancelCrawl, customerDeletePage, customerCreateChatbot, customerUpdateChatbot, customerApproveChatbot,
  customerPublishChatbot, customerUnpublishChatbot, customerTestChatbot, customerLeads, customerConversations,
} from './api.js';
import { escapeHtml as esc, dateTime, relativeTime } from './work-ui.js';

const STATE = {
  draft: ['Draft', ''],
  approved: ['Approved, not live', 'is-warn'],
  published: ['Live on your website', 'is-ok'],
};

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
}
function pathOf(u) {
  try { const x = new URL(u); return (x.pathname + x.search) || '/'; } catch { return u; }
}
function normaliseUrl(v) {
  let s = String(v || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/^http:\/\//i, 'https://');
}

export function initCustomerView({ toast, confirm }) {
  const $ = (id) => document.getElementById(id);
  const root = $('view-customer');
  if (!root) return { onOpen: () => {} };

  const state = {
    workspaces: [],
    wsId: null,
    overview: null,
    tab: 'assistant',
    chat: [], // { role, content, sources?, grounded? }
    polling: null,
    loading: false,
  };
  const bot = () => (state.overview && state.overview.chatbots[0]) || null;
  const siteUrl = () => {
    const ov = state.overview;
    if (!ov) return '';
    if (ov.crawl && ov.crawl.url) return ov.crawl.url;
    const first = ov.pages[0];
    return first ? `https://${new URL(first.url).host}/` : '';
  };

  /* ---------------- tabs ---------------- */
  function setTab(next) {
    state.tab = next;
    root.querySelectorAll('[data-ce-tab]').forEach((b) => {
      const on = b.dataset.ceTab === next;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    root.querySelectorAll('[data-ce-panel]').forEach((p) => { p.hidden = p.dataset.cePanel !== next; });
    if (next === 'leads') loadLeads();
    if (next === 'chats') loadConversations();
  }
  root.querySelectorAll('[data-ce-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.ceTab)));
  root.querySelector('.cs-tabs')?.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const tabs = [...root.querySelectorAll('[data-ce-tab]')];
    const i = tabs.findIndex((t) => t.dataset.ceTab === state.tab);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    setTab(next.dataset.ceTab);
    next.focus();
  });

  /* ---------------- loading ---------------- */
  async function load({ keepChat = true } = {}) {
    if (state.loading) return;
    state.loading = true;
    try {
      const { workspaces } = await customerWorkspaces();
      state.workspaces = workspaces || [];
      if (!state.workspaces.length) {
        state.wsId = null;
        state.overview = null;
        renderOnboarding();
        return;
      }
      if (!state.workspaces.some((w) => w.id === state.wsId)) state.wsId = state.workspaces[0].id;
      state.overview = await customerOverview(state.wsId);
      // Every business gets one assistant; create it the first time.
      if (!state.overview.chatbots.length) {
        await customerCreateChatbot({ workspaceId: state.wsId, name: `${state.overview.workspace.name} Assistant`, description: `Hi! Ask me anything about ${state.overview.workspace.name}.`, instructions: '' });
        state.overview = await customerOverview(state.wsId);
      }
      if (!keepChat) state.chat = [];
      render();
      if (state.overview.crawl && state.overview.crawl.status === 'running') startPolling();
    } catch (err) {
      $('ceSummary').textContent = err.message || 'Could not load the Customer Executive.';
    } finally {
      state.loading = false;
    }
  }

  /* ---------------- onboarding ---------------- */
  function renderOnboarding() {
    $('ceOnboard').hidden = false;
    $('ceMain').hidden = true;
    $('ceWorkspace').hidden = true;
    $('ceSummary').textContent = 'Answers visitors on your website from your own pages, and collects leads when it can\'t help.';
  }

  $('ceOnboard').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const err = $('ceOnboardError');
    const name = f.name.value.trim();
    const url = normaliseUrl(f.url.value);
    err.hidden = true;
    if (!name || !url) { err.textContent = 'Enter your business name and website address.'; err.hidden = false; return; }
    const btn = $('ceOnboardSave');
    btn.disabled = true;
    btn.textContent = 'Starting…';
    try {
      const { workspace } = await customerCreateWorkspace(name);
      state.wsId = workspace.id;
      await customerCreateChatbot({ workspaceId: workspace.id, name: `${name} Assistant`, description: `Hi! Ask me anything about ${name}.`, instructions: '' });
      await customerStartCrawl(workspace.id, url, 30);
      $('ceOnboard').hidden = true;
      f.reset();
      await load({ keepChat: false });
      setTab('website');
      toast('Reading your website. This usually takes under a minute.');
    } catch (ex) {
      err.textContent = ex.message || 'Could not start.';
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Read my website';
    }
  });

  /* ---------------- main render ---------------- */
  function render() {
    const ov = state.overview;
    if (!ov) return;
    $('ceOnboard').hidden = true;
    $('ceMain').hidden = false;

    const sel = $('ceWorkspace');
    sel.hidden = state.workspaces.length < 2;
    sel.innerHTML = state.workspaces.map((w) => `<option value="${esc(w.id)}"${w.id === state.wsId ? ' selected' : ''}>${esc(w.name)}</option>`).join('');

    const b = bot();
    const live = b && b.state === 'published';
    $('ceSummary').textContent = live
      ? `${b.name} is live on ${hostOf(siteUrl()) || 'your website'}.`
      : `${ov.workspace.name}: ${ov.pages.length ? 'test your assistant, then publish it.' : 'read your website first.'}`;

    const words = ov.pages.reduce((n, p) => n + p.words, 0);
    $('ceKpis').innerHTML = [
      [ov.pages.length, 'Website pages read'],
      [words.toLocaleString(), 'Words it can answer from'],
      [b ? (b.leadCount || 0) : 0, 'Leads collected'],
      [b ? Number(b.visitor_count || 0) : 0, 'Widget opens'],
    ].map(([v, l]) => `<div class="ex-kpi"><span class="ex-kpi-value">${esc(String(v))}</span><span class="ex-kpi-label">${esc(l)}</span></div>`).join('');

    renderBot();
    renderPages();
    renderCrawl(ov.crawl);
  }

  function renderBot() {
    const b = bot();
    if (!b) return;
    const f = $('ceBotForm');
    if (document.activeElement == null || !f.contains(document.activeElement)) {
      f.name.value = b.name || '';
      f.description.value = b.description || '';
      f.instructions.value = b.instructions || '';
    }
    const [label, cls] = STATE[b.state] || STATE.draft;
    const chip = $('ceBotState');
    chip.textContent = label;
    chip.className = `ex-chip ${cls}`;

    const live = b.state === 'published';
    const noPages = !state.overview.pages.length;
    $('cePublishBtn').hidden = live;
    $('cePublishBtn').disabled = noPages;
    $('ceUnpublish').hidden = !live;
    $('ceEmbed').hidden = !live;
    $('cePublishNote').textContent = live
      ? 'Your assistant is live. Add this code to your website to show the chat bubble.'
      : noPages
        ? 'Read your website first, then test a few questions before publishing.'
        : 'When the test answers look right, publish to get the code for your website.';
    if (live) {
      const src = `${location.origin}/widget/aculyze-chat.js`;
      $('ceEmbedCode').value = `<script src="${src}" data-key="${b.publish_key}" async></script>`;
    }
  }

  function renderPages() {
    const pages = state.overview.pages.slice().sort((a, b) => a.url.localeCompare(b.url));
    const t = $('cePages');
    if (!pages.length) {
      t.innerHTML = '<tbody><tr><td class="work-empty">No pages yet. Enter your website address above and choose Read website.</td></tr></tbody>';
      return;
    }
    t.innerHTML = `<thead><tr><th scope="col">Page</th><th scope="col" class="num">Words</th><th scope="col">Read</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${pages.map((p) => `
      <tr>
        <td><div class="ce-page-title">${esc(p.title)}</div><a class="ce-page-url" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(p.url))}${esc(pathOf(p.url))}</a></td>
        <td class="num">${p.words.toLocaleString()}</td>
        <td>${p.extractedAt ? esc(relativeTime(p.extractedAt)) : '—'}</td>
        <td class="ce-actions"><button type="button" class="utility-secondary ce-small" data-ce-del="${esc(p.id)}" aria-label="Remove ${esc(p.title)}">Remove</button></td>
      </tr>`).join('')}</tbody>`;
    const urlInput = $('ceCrawlForm').url;
    if (!urlInput.value) urlInput.value = siteUrl();
  }

  function renderCrawl(job) {
    const running = job && job.status === 'running';
    $('ceCrawlProgress').hidden = !running;
    $('ceCrawlBtn').disabled = running;
    $('ceCrawlCancel').hidden = !running;
    const last = $('ceCrawlLast');
    if (running) {
      const max = Math.max(job.saved + job.queued, 1);
      $('ceCrawlBar').style.width = `${Math.min(100, Math.round((job.saved / Math.min(max, 30)) * 100))}%`;
      $('ceCrawlText').textContent = `Read ${job.saved} page${job.saved === 1 ? '' : 's'}${job.current ? ` · now reading ${pathOf(job.current)}` : ''}`;
      last.textContent = '';
      return;
    }
    if (!job) { last.textContent = ''; return; }
    if (job.status === 'done') {
      last.textContent = `Last read ${relativeTime(job.finishedAt)}: ${job.pagesSaved} page${job.pagesSaved === 1 ? '' : 's'} from ${hostOf(job.url)}${job.errors && job.errors.length ? ` (${job.errors.length} could not be read)` : ''}.`;
    } else if (job.status === 'failed') {
      last.textContent = `The last read failed: ${job.error || 'unknown error'}`;
    } else if (job.status === 'cancelled') {
      last.textContent = 'The last read was stopped. Earlier pages were kept.';
    }
  }

  /* ---------------- crawl ---------------- */
  function startPolling() {
    stopPolling();
    state.polling = setInterval(async () => {
      if (!state.wsId || root.hidden || !root.classList.contains('active')) return;
      try {
        const { job } = await customerCrawlStatus(state.wsId);
        renderCrawl(job);
        if (!job || job.status !== 'running') {
          stopPolling();
          state.overview = await customerOverview(state.wsId);
          render();
          if (job && job.status === 'done') toast(`Read ${job.pagesSaved} pages from ${hostOf(job.url)}`);
          if (job && job.status === 'failed') toast(job.error || 'Reading the website failed', 'error');
        }
      } catch { /* keep polling */ }
    }, 1500);
  }
  function stopPolling() {
    if (state.polling) clearInterval(state.polling);
    state.polling = null;
  }

  $('ceCrawlForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const url = normaliseUrl(f.url.value);
    if (!url) { toast('Enter your website address', 'error'); f.url.focus(); return; }
    try {
      const { job } = await customerStartCrawl(state.wsId, url, Number(f.maxPages.value));
      renderCrawl(job);
      startPolling();
    } catch (err) {
      toast(err.message || 'Could not start reading the website', 'error');
    }
  });
  $('ceCrawlCancel').addEventListener('click', async () => {
    try { await customerCancelCrawl(state.wsId); toast('Stopping…'); } catch (err) { toast(err.message, 'error'); }
  });
  $('cePages').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-ce-del]');
    if (!btn) return;
    const page = state.overview.pages.find((p) => p.id === btn.dataset.ceDel);
    const ok = await confirm({ title: 'Remove this page?', detail: `The assistant will stop answering from "${page ? page.title : 'this page'}". Reading the website again adds it back.`, okLabel: 'Remove' });
    if (!ok) return;
    try {
      await customerDeletePage(state.wsId, btn.dataset.ceDel);
      state.overview.pages = state.overview.pages.filter((p) => p.id !== btn.dataset.ceDel);
      render();
    } catch (err) { toast(err.message, 'error'); }
  });

  /* ---------------- settings + publish ---------------- */
  $('ceBotForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const err = $('ceBotError');
    err.hidden = true;
    if (!f.name.value.trim()) { err.textContent = 'Give the assistant a name.'; err.hidden = false; return; }
    try {
      const { chatbot } = await customerUpdateChatbot(bot().id, { name: f.name.value, description: f.description.value, instructions: f.instructions.value });
      Object.assign(bot(), chatbot);
      render();
      toast('Settings saved');
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });

  $('cePublishBtn').addEventListener('click', async () => {
    const b = bot();
    const ok = await confirm({
      title: 'Publish the assistant?',
      detail: 'Anyone who visits your website will be able to chat with it. It answers only from your website pages and offers to take contact details when it doesn\'t know.',
      okLabel: 'Publish',
    });
    if (!ok) return;
    try {
      if (b.state === 'draft') await customerApproveChatbot(b.id);
      const { chatbot } = await customerPublishChatbot(b.id);
      Object.assign(b, chatbot);
      render();
      toast('Published. Copy the code onto your website.');
    } catch (err) { toast(err.message || 'Could not publish', 'error'); }
  });
  $('ceUnpublish').addEventListener('click', async () => {
    const ok = await confirm({ title: 'Take the assistant offline?', detail: 'The chat bubble stops working on your website. Publishing again gives a new code.', okLabel: 'Take offline' });
    if (!ok) return;
    try {
      const { chatbot } = await customerUnpublishChatbot(bot().id);
      Object.assign(bot(), chatbot);
      render();
    } catch (err) { toast(err.message, 'error'); }
  });
  $('ceEmbedCopy').addEventListener('click', async () => {
    const code = $('ceEmbedCode').value;
    try { await navigator.clipboard.writeText(code); toast('Code copied'); } catch { $('ceEmbedCode').select(); toast('Press Ctrl+C to copy'); }
  });

  /* ---------------- test chat ---------------- */
  function renderChat() {
    const box = $('ceChat');
    if (!state.chat.length) {
      box.innerHTML = '<p class="ce-chat-hint">Ask what a customer would ask. Answers show which of your pages they came from.</p>';
      return;
    }
    box.innerHTML = state.chat.map((m) => {
      if (m.role === 'user') return `<div class="ce-msg is-user"><p>${esc(m.content)}</p></div>`;
      if (m.pending) return '<div class="ce-msg is-bot is-pending"><p>Thinking…</p></div>';
      const text = esc(m.content).replace(/\[(\d+)\]/g, (x, n) => {
        const s = (m.sources || [])[Number(n) - 1];
        return s ? `<a class="ce-cite" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" title="${esc(s.title)}">${n}</a>` : '';
      }).replace(/\n/g, '<br>');
      const sources = (m.sources || []).map((s, i) => `<li><span>${i + 1}</span><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title || pathOf(s.url))}</a></li>`).join('');
      const tag = m.grounded
        ? '<span class="ex-chip is-ok">Answered from your website</span>'
        : '<span class="ex-chip is-warn">Not on your website: offers to take contact details</span>';
      return `<div class="ce-msg is-bot"><p>${text}</p>${sources ? `<ol class="ce-sources">${sources}</ol>` : ''}<div class="ce-msg-tag">${tag}</div></div>`;
    }).join('');
    box.scrollTop = box.scrollHeight;
  }

  $('ceTestForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('ceTestInput');
    const q = input.value.trim();
    if (!q || state.chat.some((m) => m.pending)) return;
    if (!state.overview.pages.length) { toast('Read your website first', 'error'); setTab('website'); return; }
    const history = state.chat.filter((m) => !m.pending).slice(-6).map((m) => ({ role: m.role, content: m.content }));
    state.chat.push({ role: 'user', content: q }, { role: 'assistant', pending: true });
    input.value = '';
    renderChat();
    try {
      const r = await customerTestChatbot(bot().id, q, history);
      state.chat[state.chat.length - 1] = { role: 'assistant', content: r.response, sources: r.sourceDetails || [], grounded: r.grounded };
    } catch (err) {
      state.chat[state.chat.length - 1] = { role: 'assistant', content: `Error: ${err.message}`, sources: [], grounded: false };
    }
    renderChat();
  });
  $('ceTestClear').addEventListener('click', () => { state.chat = []; renderChat(); });

  /* ---------------- leads + conversations ---------------- */
  async function loadLeads() {
    const t = $('ceLeads');
    const b = bot();
    if (!b) return;
    t.innerHTML = '<tbody><tr><td class="work-empty">Loading…</td></tr></tbody>';
    try {
      const { leads } = await customerLeads(b.id);
      if (!leads.length) {
        t.innerHTML = '<tbody><tr><td class="work-empty">No leads yet. When the assistant can\'t answer, it offers to take the visitor\'s contact details, and they appear here.</td></tr></tbody>';
        return;
      }
      t.innerHTML = `<thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Phone</th><th scope="col">When</th></tr></thead><tbody>${leads.map((l) => `
        <tr><td>${esc(l.name || '—')}${l.company ? `<div class="ce-page-url">${esc(l.company)}</div>` : ''}</td>
        <td>${l.email ? `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>` : '—'}</td>
        <td>${l.phone ? `<a href="tel:${esc(l.phone)}">${esc(l.phone)}</a>` : '—'}</td>
        <td>${esc(dateTime(Number(l.created_at)))}</td></tr>`).join('')}</tbody>`;
    } catch (err) {
      t.innerHTML = `<tbody><tr><td class="work-empty">${esc(err.message)}</td></tr></tbody>`;
    }
  }

  async function loadConversations() {
    const list = $('ceConvos');
    const b = bot();
    if (!b) return;
    list.innerHTML = '<li class="work-empty">Loading…</li>';
    try {
      const { conversations } = await customerConversations(b.id);
      if (!conversations.length) {
        list.innerHTML = '<li class="work-empty">No visitor conversations yet. They appear here once the assistant is live on your website.</li>';
        return;
      }
      list.innerHTML = conversations.map((c) => {
        const first = c.messages.find((m) => m.role === 'user');
        return `<li class="ce-convo"><details>
          <summary><span class="ce-convo-q">${esc(first ? first.content : '(no messages)')}</span><span class="ce-convo-meta">${c.messages.length} messages · ${esc(relativeTime(c.lastActivity || c.startedAt))}</span></summary>
          <div class="ce-chat ce-chat-static">${c.messages.map((m) => `<div class="ce-msg ${m.role === 'user' ? 'is-user' : 'is-bot'}"><p>${esc(m.content).replace(/\n/g, '<br>')}</p></div>`).join('')}</div>
        </details></li>`;
      }).join('');
    } catch (err) {
      list.innerHTML = `<li class="work-empty">${esc(err.message)}</li>`;
    }
  }

  $('ceWorkspace').addEventListener('change', (e) => { state.wsId = e.target.value; state.chat = []; load({ keepChat: false }); renderChat(); });
  $('ceRefresh').addEventListener('click', () => load());

  return {
    onOpen() { load(); },
  };
}
