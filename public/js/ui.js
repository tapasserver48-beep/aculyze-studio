/**
 * ACULYZE STUDIO — workspace shell (additive layer).
 * Powers the deep-space visuals + new surfaces WITHOUT touching chat logic:
 *   · Starfield canvas (decorative, respects reduced-motion)
 *   · Command bar (/commands + plain-ask routing into the main composer)
 *   · Right-side Zara Copilot (independent streamChat thread)
 *   · Sales dashboard workspace view
 *   · Sidebar nav → settings pages / workspace routing
 * Talks to app.js ONLY via the window.__studio bridge; to models via api.js.
 */
import { streamChat, fetchModels, salesStatus } from './api.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

// Small helpers reused across this layer -------------------------------------------------
const escapeHtml = (s) => String(s)
  .replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>')
  .replace(/"/g, '"').replace(/'/g, ''');

const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
  document.body.classList.contains('no-animations');

// Studio bridge (populated by app.js after init). Tolerate load-order races.
const studio = () => window.__studio || null;

// ============================================================================
// 1. STARFIELD — drifting stars + faint nebula. Decorative only, z-index -1.
// ============================================================================
function initStarfield() {
  const canvas = $('#spaceCanvas');
  if (!canvas || prefersReducedMotion()) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  let w = 0, h = 0, stars = [], dpr = 1, raf = 0;
  const COUNT = 90;          // lighter field — decorative, not the star of the show
  const FRAME_MS = 34;       // ~30fps: plenty for a slow drift, halves CPU vs 60fps
  let last = 0;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth = window.innerWidth;
    h = canvas.clientHeight = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    stars = Array.from({ length: COUNT }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() * 1.3 + 0.2,
      a: Math.random() * 0.5 + 0.2,
      tw: Math.random() * 0.02 + 0.004,
      dir: Math.random() < 0.5 ? -1 : 1,
      hue: Math.random() < 0.75 ? 210 : 265, // blue-white or faint violet
    }));
  }

  function frame(ts) {
    raf = requestAnimationFrame(frame);
    if (ts - last < FRAME_MS) return;   // throttle: skip frames to cap CPU
    last = ts;
    ctx.clearRect(0, 0, w, h);
    for (const s of stars) {
      s.a += s.tw * s.dir;
      if (s.a > 0.75 || s.a < 0.15) s.dir *= -1;
      s.x += s.vx;
      if (s.x < -2) s.x = w + 2;
      if (s.x > w + 2) s.x = -2;
      ctx.globalAlpha = s.a;
      ctx.fillStyle = `hsl(${s.hue}, 90%, 82%)`;
      ctx.fillRect(s.x, s.y, s.r * 2, s.r * 2); // square dot: cheaper than arc+fill
    }
    ctx.globalAlpha = 1;
  }

  resize();
  raf = requestAnimationFrame(frame);
  window.addEventListener('resize', resize, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; }
    else if (!raf) { last = 0; raf = requestAnimationFrame(frame); }
  });
}

// ============================================================================
// 2. COMMAND BAR — "/" opens a command menu; Enter routes commands or asks.
// ============================================================================
const COMMANDS = [
  { id: 'new', label: 'New chat', tag: 'chat', run: () => studio()?.newChat() },
  { id: 'agents', label: 'Browse agents', tag: 'agents', run: () => $('#agentsBtn')?.click() },
  { id: 'models', label: 'AI & Models', tag: 'settings', run: () => studio()?.openSettings('models') },
  { id: 'apps', label: 'Apps & Integrations', tag: 'settings', run: () => studio()?.openSettings('apps') },
  { id: 'dashboard', label: 'Open Sales dashboard', tag: 'workspace', run: () => showWorkspace(true) },
  { id: 'integrations', label: 'Integrations', tag: 'settings', run: () => studio()?.openSettings('apps') },
  { id: 'voice', label: 'Toggle voice conversation', tag: 'voice', run: () => $('#voiceModeBtn')?.click() },
  { id: 'settings', label: 'Open settings', tag: 'settings', run: () => $('#settingsBtn')?.click() },
];

function initCommandBar() {
  const bar = $('#commandBar');
  const input = $('#commandInput');
  const results = $('#commandResults');
  if (!bar || !input || !results) return;

  let active = -1;
  let matches = [];

  const close = () => { results.hidden = true; results.innerHTML = ''; active = -1; matches = []; };

  function render(list) {
    matches = list;
    active = -1;
    if (!list.length) { close(); return; }
    results.innerHTML = list.map((c, i) =>
      `<button class="cr-item" data-idx="${i}" type="button">
         <span class="cr-ic">—</span><span>${escapeHtml(c.label)}</span><span class="cr-tag">${escapeHtml(c.tag)}</span>
        </button>`).join('');
    results.hidden = false;
  }

  function filter(q) {
    const query = q.replace(/^\//, '').trim().toLowerCase();
    if (!query) return COMMANDS.slice(0, 6);
    return COMMANDS.filter((c) => c.label.toLowerCase().includes(query) || c.id.includes(query));
  }

  function run(i) {
    const c = matches[i];
    if (!c) return;
    close();
    input.value = '';
    c.run();
  }

  function submit() {
    const raw = input.value.trim();
    if (!raw) return;
    if (active >= 0 && matches[active]) { run(active); return; }
    if (raw.startsWith('/')) {
      const list = filter(raw);
      if (list.length === 1) { run(COMMANDS.indexOf(list[0])); return; }
      render(list);
      return;
    }
    // Plain ask → hand to the main composer and send.
    close();
    input.value = '';
    sendViaComposer(raw);
  }

  input.addEventListener('focus', () => { if (!input.value) render(filter('')); });
  input.addEventListener('input', () => {
    const v = input.value;
    if (v.startsWith('/') || v === '') render(filter(v)); else close();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') { close(); input.blur(); }
    else if (e.key === 'ArrowDown' && !results.hidden) {
      e.preventDefault(); active = (active + 1) % matches.length; highlight();
    } else if (e.key === 'ArrowUp' && !results.hidden) {
      e.preventDefault(); active = (active - 1 + matches.length) % matches.length; highlight();
    }
  });
  results.addEventListener('click', (e) => {
    const btn = e.target.closest('.cr-item');
    if (btn) run(Number(btn.dataset.idx));
  });
  document.addEventListener('click', (e) => { if (!bar.contains(e.target)) close(); });

  // "/" globally focuses the command bar (unless typing in a field).
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault();
    input.focus();
    render(filter(''));
  });

  function highlight() {
    $$('.cr-item', results).forEach((el, i) => el.classList.toggle('active', i === active));
  }
}

/** Fill the main composer with text and trigger a send (reuses app.js wiring). */
function sendViaComposer(text) {
  const input = $('#composerInput');
  const sendBtn = $('#sendBtn');
  if (!input) return;
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  // Let app.js enable the send button, then click it.
  requestAnimationFrame(() => { if (sendBtn && !sendBtn.disabled) sendBtn.click(); });
}

// ============================================================================
// 3. ZARA COPILOT — independent right-panel thread via streamChat.
// ============================================================================
function initCopilot() {
  const panel = $('#copilot');
  const toggle = $('#copilotToggle');
  const closeBtn = $('#copilotClose');
  const thread = $('#copilotThread');
  const input = $('#copilotInput');
  const send = $('#copilotSend');
  const modelSel = $('#copilotModel');
  const ctxEl = $('#copilotContext');
  if (!panel || !thread || !input || !send) return;

  let history = [];
  let abort = null;
  let busy = false;

  // Desktop default open; tablet/mobile drawer starts closed.
  const isDesktop = () => window.matchMedia('(min-width: 1361px)').matches;
  function setOpen(open) {
    document.body.classList.toggle('copilot-open', open);
    document.body.classList.toggle('copilot-collapsed', !open && isDesktop());
    if (toggle) {
      toggle.classList.toggle('active', open);
      toggle.setAttribute('aria-pressed', String(open));
    }
    if (open) input.focus();
  }
  // Initial state: open on desktop, closed as a drawer below.
  setOpen(isDesktop());

  toggle?.addEventListener('click', () => {
    const open = isDesktop()
      ? document.body.classList.contains('copilot-collapsed')
      : !document.body.classList.contains('copilot-open');
    setOpen(open);
  });
  closeBtn?.addEventListener('click', () => setOpen(false));

  // Populate model options once models are available (non-blocking).
  async function loadModels() {
    if (!modelSel) return;
    try {
      const data = await fetchModels();
      const models = data.models || [];
      modelSel.innerHTML = '<option value="">Default model</option>' +
        models.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name || m.id)}</option>`).join('');
    } catch { /* offline — keep default */ }
  }
  loadModels();
  // Retry once after app.js finishes booting models.
  setTimeout(loadModels, 2500);

  // Keep the context chip in sync with the active agent (best-effort).
  function syncContext() {
    if (!ctxEl) return;
    const active = $('.agents-mount .agent-item.active .agent-meta strong')?.textContent || 'Zara';
    ctxEl.innerHTML =
      `<span class="cc-chip live">— ${escapeHtml(active)}</span><span class="cc-chip">This conversation</span>`;
  }
  syncContext();
  // Agent changes re-render the mounts; watch for a new active item.
  const mo = new MutationObserver(syncContext);
  const mount = $('.agents-mount');
  if (mount) mo.observe(mount, { subtree: true, attributes: true, attributeFilter: ['class'] });

  const autoscroll = () => { thread.scrollTop = thread.scrollHeight; };

  function addMsg(role, html) {
    const empty = $('.copilot-empty', thread);
    if (empty) empty.remove();
    const wrap = document.createElement('div');
    wrap.className = `cp-msg ${role}`;
    const bubble = document.createElement('div');
    bubble.className = 'cp-bubble';
    bubble.innerHTML = html;
    wrap.appendChild(bubble);
    thread.appendChild(wrap);
    autoscroll();
    return bubble;
  }

  async function ask() {
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = '';
    input.style.height = 'auto';
    send.disabled = true;
    busy = true;

    addMsg('user', escapeHtml(text));
    history.push({ role: 'user', content: text });

    const bubble = addMsg('zara', '<span class="cp-typing"><i></i><i></i><i></i></span>');
    abort = new AbortController();
    let acc = '';
    try {
      const model = modelSel?.value || studio()?.getModel() || undefined;
      const res = await streamChat({
        messages: [
          { role: 'system', content: 'You are Zara Copilot, a concise side-assistant in Aculyze Studio. Keep answers short and useful unless asked for detail.' },
          ...history.slice(-12),
        ],
        model,
        signal: abort.signal,
        onToken: (tok, full) => { acc = full; bubble.textContent = acc; autoscroll(); },
      });
      const finalText = res.content || acc || '(no response)';
      history.push({ role: 'assistant', content: finalText });
      bubble.textContent = finalText;
    } catch (err) {
      if (abort?.signal.aborted) {
        bubble.textContent = acc ? acc + ' …(stopped)' : '…(stopped)';
      } else {
        bubble.innerHTML = `<span style="color:var(--err)">${escapeHtml(err?.message || 'Something went wrong.)}</span>` +
          (err?.hint ? `<br><small style="color:var(--text-muted)">${escapeHtml(err.hint)}</small>` : '');
        history.pop(); // drop the unanswered user turn
      }
    } finally {
      abort = null;
      busy = false;
      send.disabled = !input.value.trim();
      autoscroll();
    }
  }

  send.addEventListener('click', ask);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); }
  });
  input.addEventListener('input', () => {
    send.disabled = busy || !input.value.trim();
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  // Recompute drawer vs column when crossing the breakpoint.
  window.matchMedia('(min-width: 1361px)').addEventListener?.('change', () => setOpen(isDesktop()));
}

// ============================================================================
// 4. WORKSPACE VIEW — Sales dashboard toggle (hidden by default).
// ============================================================================
let workspaceOpen = false;

function showWorkspace(open) {
  const view = $('#workspaceView');
  if (!view) return;
  workspaceOpen = open;
  view.hidden = !open;
  if (open) {
    refreshSalesMetrics();
    $('#workspaceClose')?.focus();
  }
}

async function refreshSalesMetrics() {
  const metrics = $('#wsMetrics');
  if (!metrics) return;
  try {
    const s = await salesStatus();
    if (!s?.connected) return; // keep the "Connect ERP to view" placeholders
    // When connected, ask the Sales agent for a live summary (best-effort).
    // We only replace placeholders if we actually get structured data back.
  } catch { /* offline — placeholders stand */ }
}

function initWorkspace() {
  $('#workspaceClose')?.addEventListener('click', () => showWorkspace(false));
  // Sidebar "Dashboard" entry.
  $$('[data-nav-view="dashboard"]').forEach((b) =>
    b.addEventListener('click', () => showWorkspace(true)));
}

// ============================================================================
// 5. SIDEBAR NAV ROUTING → settings pages.
// ============================================================================
function initSidebarNav() {
  $$('[data-nav-settings]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const page = btn.getAttribute('data-nav-settings');
      studio()?.openSettings(page);
    });
  });
}

// ============================================================================
// 6. HERO CHIPS → send the prompt via the main composer.
// ============================================================================
function initHeroChips() {
  $$('.hero-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const prompt = chip.getAttribute('data-prompt');
      if (prompt) sendViaComposer(prompt);
    });
  });
}

// ============================================================================
// BOOT — deferred so first paint + the mobile drawer transition are never
// competing with this layer's setup (command listeners, copilot, observers).
// ============================================================================
function boot() {
  const start = () => {
    try { initStarfield(); } catch { /* visual only */ }
    try { initCommandBar(); } catch { /* additive */ }
    try { initCopilot(); } catch { /* additive */ }
    try { initWorkspace(); } catch { /* additive */ }
    try { initSidebarNav(); } catch { /* additive */ }
    try { initHeroChips(); } catch { /* additive */ }
  };
  // Run after the browser has painted the initial layout (and after app.js's
  // own synchronous init), so the sidebar open animation starts on a free frame.
  const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 1));
  idle(() => requestAnimationFrame(start), { timeout: 400 });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 1));
    idle(() => requestAnimationFrame(boot), { timeout: 400 });
  });
} else {
  const idle = window.requestIdlifecycleCallback || ((cb) => setTimeout(cb, 1));
  idle(() => requestAnimationFrame(boot), { timeout: 400 });
}