/**
 * Floating Voice Assistant — global voice frontend for the Sales Agent.
 *
 * Architecture:
 *   Floating Voice Assistant → Speech-to-Text → Sales Agent (/api/sales/chat)
 *   → Sales Agent logic → Aculyze LMS API → text response → Text-to-Speech
 *   → Assistant speaks aloud.
 *
 * The Sales Agent remains the single brain. This is only a voice + visual
 * frontend that reuses the existing Sales Agent chat backend.
 *
 * Image: public/voice-assistant.svg (unchanged).
 *
 * Interaction:
 *   IDLE — hover shows "Talk to Sales Agent" tooltip + Stop/Mute controls
 *   Click → start listening → live interim text appears in the conversation
 *     popup → capture speech → send to Sales Agent backend → popup shows the
 *     AI answer as text → reply is spoken aloud (unless muted) → IDLE.
 *   Stop — aborts listening/speaking immediately.
 *   Mute — silences TTS playback; the answer is still shown as text.
 *
 * Notes:
 *   The orb (button) and its controls are SIBLINGS — never nest <button>
 *   inside <button>, the HTML parser would restructure the DOM.
 */

import {
  sttSupported,
  ttsSupported,
  createListener,
  speak,
  stopSpeaking,
  toSpokenText,
} from './voice.js';
import { salesChat } from './api.js';

const VA_KEY = 'voiceAssistantPosition';
const VA_MUTE_KEY = 'voiceAssistantMuted';
const CLICK_THRESHOLD_PX = 10; // movement below this = click, above = drag

const IMAGE_URL = '/voice-assistant.svg';
const GREETING = 'Hi, I am your assistant. How can I help you?';
const GREET_SEEN_KEY = 'voiceAssistantGreeted'; // sessionStorage — once per tab session

let va = null; // singleton instance

function clampToViewport(x, y, w, h) {
  const vw = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
  const vh = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);
  const left = Math.min(Math.max(x, 8), vw - w - 8);
  const top = Math.min(Math.max(y, 8), vh - h - 8);
  return { left, top };
}

function loadPosition(w, h) {
  try {
    const raw = localStorage.getItem(VA_KEY);
    if (!raw) return null;
    const pos = JSON.parse(raw);
    if (typeof pos.x !== 'number' || typeof pos.y !== 'number') return null;
    return clampToViewport(pos.x, pos.y, w, h);
  } catch { return null; }
}

function savePosition(x, y) {
  try { localStorage.setItem(VA_KEY, JSON.stringify({ x, y })); } catch { /* quota */ }
}

export function mountVoiceAssistant(root) {
  if (va) return va;
  if (!root) root = document.body;

  const wrap = document.createElement('div');
  wrap.className = 'voice-assistant-wrap';
  wrap.setAttribute('aria-label', 'Aculyze Sales Agent Voice Assistant');
  wrap.setAttribute('role', 'group');

  // Hover tooltip — small, simple
  const tooltip = document.createElement('div');
  tooltip.className = 'voice-assistant-tooltip';
  tooltip.textContent = 'Talk to Sales Agent';
  tooltip.setAttribute('aria-hidden', 'true');

  // Greeting popup — speech bubble beside the orb, shown once per session
  const greeting = document.createElement('div');
  greeting.className = 'voice-assistant-greeting';
  greeting.setAttribute('role', 'status');
  greeting.innerHTML =
    '<button class="va-greet-close" type="button" aria-label="Dismiss greeting" title="Dismiss">\u2715</button>' +
    '<div class="va-greet-row">' +
      '<span class="va-greet-avatar" aria-hidden="true"></span>' +
      '<div class="va-greet-body">' +
        '<strong>Sales Agent</strong>' +
        `<p>${GREETING}</p>` +
        '<span class="va-greet-hint">Tap the orb to talk to me</span>' +
      '</div>' +
    '</div>';

  // Conversation popup — user input + AI answer shown as readable text
  const transcript = document.createElement('div');
  transcript.className = 'voice-assistant-transcript';
  transcript.setAttribute('role', 'region');
  transcript.setAttribute('aria-label', 'Voice conversation');
  transcript.innerHTML =
    '<div class="va-transcript-head">' +
      '<span class="va-transcript-dot" aria-hidden="true"></span>' +
      '<span class="va-transcript-title">Sales Agent</span>' +
      '<span class="va-transcript-state" aria-hidden="true"></span>' +
      '<button class="va-transcript-close" type="button" aria-label="Close conversation" title="Close">\u2715</button>' +
    '</div>' +
    '<div class="va-transcript-body" aria-live="polite"></div>';

  // Main orb (its own button — controls are siblings, never nested)
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'voice-assistant-btn';
  btn.setAttribute('aria-label', 'Activate voice assistant');
  btn.innerHTML =
    `<img class="voice-assistant-img" src="${IMAGE_URL}" alt="" aria-hidden="true" decoding="async" loading="eager">` +
    '<div class="voice-assistant-glow" aria-hidden="true"></div>' +
    '<div class="voice-assistant-text" aria-hidden="true">Speaking\u2026</div>' +
    '<div class="voice-assistant-label" aria-hidden="true">Sales Agent</div>' +
    '<div class="voice-assistant-state" aria-live="polite">Idle</div>';

  // Stop + Mute controls (siblings of the orb, inside the orb footprint)
  const controls = document.createElement('div');
  controls.className = 'voice-assistant-controls';
  controls.innerHTML =
    '<button class="voice-assistant-control va-stop" type="button" aria-label="Stop" title="Stop">' +
      '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>' +
    '</button>' +
    '<button class="voice-assistant-control va-mute" type="button" aria-pressed="false" aria-label="Mute voice replies" title="Mute">' +
      '<svg class="ico-on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>' +
      '<svg class="ico-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5z"/><line x1="16" y1="9.5" x2="21.5" y2="15"/><line x1="21.5" y1="9.5" x2="16" y2="15"/></svg>' +
    '</button>';

  wrap.appendChild(tooltip);
  wrap.appendChild(greeting);
  wrap.appendChild(transcript);
  wrap.appendChild(btn);
  wrap.appendChild(controls);
  root.appendChild(wrap);

  const stateEl = btn.querySelector('.voice-assistant-state');
  const speakingText = btn.querySelector('.voice-assistant-text');
  const stopBtn = controls.querySelector('.va-stop');
  const muteBtn = controls.querySelector('.va-mute');
  const transcriptBody = transcript.querySelector('.va-transcript-body');
  const transcriptClose = transcript.querySelector('.va-transcript-close');
  const transcriptState = transcript.querySelector('.va-transcript-state');

  // ---- State ----
  let state = 'idle';
  let listener = null;
  let utterance = null;
  let userTurn = null; // live (interim) user entry in the popup
  let muted = false;
  try { muted = localStorage.getItem(VA_MUTE_KEY) === '1'; } catch { /* private mode */ }

  let dragStartX = 0, dragStartY = 0;
  let startLeft = 0, startTop = 0;
  let isDragging = false;
  let pointerStartX = 0, pointerStartY = 0;

  function renderStateLabel() {
    const labels = { listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking', stopped: 'Stopped' };
    let label = labels[state] || '';
    if (!label && state === 'idle' && muted) label = 'Muted';
    transcriptState.textContent = label;
    transcriptState.classList.toggle(
      'is-active',
      state === 'listening' || state === 'thinking' || state === 'speaking'
    );
  }

  function setState(next) {
    state = next;
    wrap.classList.remove('idle', 'listening', 'speaking', 'thinking', 'stopped');
    wrap.classList.add(next);
    const busy = next === 'listening' || next === 'speaking' || next === 'thinking';
    wrap.setAttribute('aria-busy', busy ? 'true' : 'false');
    stateEl.textContent = next.charAt(0).toUpperCase() + next.slice(1);

    // "Speaking…" overlay only while audio is actually playing
    speakingText.setAttribute('aria-hidden', next === 'speaking' ? 'false' : 'true');

    renderStateLabel();

    if (next === 'idle' || next === 'stopped') {
      stopSpeaking();
      if (listener) { try { listener.abort(); } catch { /* noop */ } listener = null; }
      clearUserTurn();
    }
  }

  function showError(msg) {
    setState('idle');
    toastVoice(msg || 'Voice error.');
  }

  function toastVoice(msg) {
    const t = document.createElement('div');
    t.style.position = 'fixed';
    t.style.bottom = '110px';
    t.style.left = '24px';
    t.style.zIndex = '2147483648';
    t.style.padding = '8px 12px';
    t.style.borderRadius = '8px';
    t.style.background = 'rgba(15, 23, 42, 0.92)';
    t.style.border = '1px solid rgba(255, 255, 255, 0.22)';
    t.style.color = '#ffffff';
    t.style.fontSize = '12px';
    t.style.fontFamily = 'var(--font)';
    t.style.pointerEvents = 'none';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.3s'; setTimeout(() => t.remove(), 300); }, 2000);
  }

  // ---- Greeting popup — "Hi, I am your assistant…" (once per session) ----
  let greetHideTimer = null;

  function showGreeting() {
    if (greeting.classList.contains('is-open')) return;
    // Flip the bubble if the orb was dragged near the right edge.
    const rect = wrap.getBoundingClientRect();
    greeting.classList.toggle('edge-left', rect.left + 270 > window.innerWidth);
    greeting.classList.add('is-open');
    clearTimeout(greetHideTimer);
    greetHideTimer = setTimeout(hideGreeting, 9000);
  }

  function hideGreeting() {
    clearTimeout(greetHideTimer);
    greeting.classList.remove('is-open');
  }

  // Clicking the bubble (or its ✕) dismisses it — never activates the orb.
  greeting.addEventListener('click', (e) => {
    e.stopPropagation();
    hideGreeting();
  });

  function scheduleGreeting() {
    try { if (sessionStorage.getItem(GREET_SEEN_KEY) === '1') return; } catch { /* private mode */ }
    let tries = 0;
    const tryShow = () => {
      // Signed-out users can't see the widget — wait for the auth screen to clear.
      if (document.body.classList.contains('is-unauthenticated')) {
        if (tries++ < 30) setTimeout(tryShow, 2000);
        return;
      }
      try { sessionStorage.setItem(GREET_SEEN_KEY, '1'); } catch { /* noop */ }
      showGreeting();
    };
    setTimeout(tryShow, 1500);
  }
  scheduleGreeting();

  // ---- Conversation popup ----
  function syncTranscriptSide() {
    const rect = wrap.getBoundingClientRect();
    const vw = window.innerWidth;
    // ~280px wide popup — flip horizontally near the right edge…
    transcript.classList.toggle('edge-right', rect.left + 300 > vw);
    // …and open downward when the orb sits too close to the top edge
    transcript.classList.toggle('edge-below', rect.top < 260);
  }

  function openTranscript() {
    if (transcript.classList.contains('is-open')) return;
    hideGreeting(); // the conversation takes over from the greeting
    syncTranscriptSide();
    transcript.classList.add('is-open');
    wrap.classList.add('has-transcript');
  }

  function closeTranscript() {
    transcript.classList.remove('is-open');
    wrap.classList.remove('has-transcript');
    clearUserTurn();
  }

  /** who: 'user' | 'agent'. Text is set via textContent (never HTML). */
  function addTurn(who, text) {
    openTranscript();
    const el = document.createElement('div');
    el.className = 'va-turn ' + who;

    const label = document.createElement('span');
    label.className = 'va-turn-who';
    label.textContent = who === 'user' ? 'You' : 'Sales Agent';

    const p = document.createElement('p');
    p.className = 'va-turn-text';
    p.textContent = text;

    el.append(label, p);
    transcriptBody.appendChild(el);
    transcriptBody.scrollTop = transcriptBody.scrollHeight;
    return el;
  }

  /** Live update of the current user turn (interim = still talking). */
  function showUserTurn(text, interim) {
    if (!userTurn) {
      userTurn = addTurn('user', text || '');
    } else {
      userTurn.querySelector('.va-turn-text').textContent = text || '';
    }
    userTurn.classList.toggle('is-interim', !!interim);
    transcriptBody.scrollTop = transcriptBody.scrollHeight;
  }

  function finalizeUserTurn(text) {
    showUserTurn(text, false);
    userTurn = null; // next utterance starts a fresh entry
  }

  function clearUserTurn() {
    if (userTurn) { userTurn.remove(); userTurn = null; }
  }

  // ---- Mute ----
  function applyMute() {
    muteBtn.classList.toggle('is-muted', muted);
    muteBtn.setAttribute('aria-pressed', String(muted));
    const label = muted ? 'Unmute voice replies' : 'Mute voice replies';
    muteBtn.setAttribute('aria-label', label);
    muteBtn.title = label;
    wrap.classList.toggle('is-muted', muted);
    renderStateLabel();
    try { localStorage.setItem(VA_MUTE_KEY, muted ? '1' : '0'); } catch { /* noop */ }
  }

  function toggleMute() {
    muted = !muted;
    applyMute();
    if (muted) stopSpeaking();
  }

  applyMute();

  // ---- Voice flow ----
  async function activate() {
    if (state === 'listening' || state === 'speaking' || state === 'thinking') return;
    hideGreeting();
    if (!sttSupported()) { showError('Speech recognition not supported in this browser.'); return; }

    setState('listening');
    startListening();
  }

  async function startListening() {
    setState('listening');
    openTranscript();

    listener = createListener({
      lang: 'en-US',
      onInterim: (text) => { showUserTurn(text, true); },
      onFinal: async (text) => {
        try { listener.stop(); } catch { /* noop */ }
        listener = null;
        if (!text || !text.trim()) { setState('idle'); return; }
        finalizeUserTurn(text.trim());
        await sendToSalesAgent(text.trim());
      },
      onEnd: () => {
        if (state === 'listening' && listener) setState('idle');
      },
      onError: (code) => {
        listener = null;
        showError(`Microphone error (${code}).`);
      },
    });

    try { listener.start(); } catch (err) {
      listener = null;
      showError('Could not start microphone.');
    }
  }

  async function sendToSalesAgent(text) {
    setState('thinking');

    try {
      const res = await salesChat({
        messages: [{ role: 'user', content: text }],
        agent: 'sales',
        stream: false,
      });

      const reply = res.content || '';
      if (!reply) { setState('idle'); return; }

      // Stop was pressed while the model was working — drop the reply.
      if (state !== 'thinking') return;

      addTurn('agent', reply);
      await speakReply(reply);
    } catch (err) {
      showError(err.message || 'Sales Agent request failed.');
    }
  }

  async function speakReply(text) {
    const spoken = toSpokenText(text) || '';

    // Muted (or TTS unavailable): the answer is already visible as text.
    if (muted || !ttsSupported() || !spoken) {
      setState('idle');
      return;
    }

    setState('speaking');
    return new Promise((resolve) => {
      const ok = speak(spoken, {
        rate: 1,
        onEnd: () => {
          utterance = null;
          if (state === 'speaking') setState('idle');
          resolve();
        },
        onError: () => {
          utterance = null;
          if (state === 'speaking') setState('idle');
          resolve();
        },
      });
      if (!ok) { setState('idle'); resolve(); }
    });
  }

  function stopAll() {
    stopSpeaking();
    if (listener) { try { listener.abort(); } catch { /* noop */ } listener = null; }
    setState('stopped');
    setTimeout(() => { if (state === 'stopped') setState('idle'); }, 500);
  }

  // ---- Pointer / drag logic ----
  function onPointerDown(e) {
    if (e.button !== 0 && e.pointerType !== 'touch') return;
    e.preventDefault();
    isDragging = false;
    pointerStartX = e.clientX;
    pointerStartY = e.clientY;
    const rect = wrap.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    dragStartX = rect.left;
    dragStartY = rect.top;
    try { wrap.setPointerCapture(e.pointerId); } catch { /* noop */ }
  }

  function onPointerMove(e) {
    if (!wrap.hasPointerCapture(e.pointerId)) return;
    const dx = Math.abs(e.clientX - pointerStartX);
    const dy = Math.abs(e.clientY - pointerStartY);
    if (dx > CLICK_THRESHOLD_PX || dy > CLICK_THRESHOLD_PX) {
      isDragging = true;
      const { left, top } = clampToViewport(
        dragStartX + (e.clientX - pointerStartX),
        dragStartY + (e.clientY - pointerStartY),
        wrap.offsetWidth,
        wrap.offsetHeight
      );
      wrap.style.left = `${left}px`;
      wrap.style.top = `${top}px`;
      wrap.style.right = 'auto';
      wrap.style.bottom = 'auto';
    }
  }

  function onPointerUp(e) {
    try { wrap.releasePointerCapture(e.pointerId); } catch { /* noop */ }

    // Clicks on Stop / Mute / the popup / the greeting must never activate the orb.
    const target = e.target instanceof Element ? e.target : null;
    if (target && target.closest('.voice-assistant-controls, .voice-assistant-transcript, .voice-assistant-greeting')) return;

    if (isDragging) {
      isDragging = false;
      const rect = wrap.getBoundingClientRect();
      savePosition(rect.left, rect.top);
      syncTranscriptSide(); // popup must flip if the orb moved to an edge
      return;
    }
    // Not a drag → treat as click
    e.preventDefault();
    e.stopPropagation();
    activate();
  }

  function onPointerCancel(e) {
    try { wrap.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    isDragging = false;
  }

  // ---- Control handlers ----
  stopBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    stopAll();
  });

  muteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMute();
  });

  transcriptClose.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTranscript();
  });

  btn.addEventListener('pointerdown', onPointerDown, { touchAction: 'none' });
  wrap.addEventListener('pointermove', onPointerMove, { touchAction: 'none' });
  wrap.addEventListener('pointerup', onPointerUp);
  wrap.addEventListener('pointercancel', onPointerCancel);

  // ---- Position persistence ----
  const saved = loadPosition(wrap.offsetWidth, wrap.offsetHeight);
  if (saved) {
    wrap.style.left = `${saved.left}px`;
    wrap.style.top = `${saved.top}px`;
    wrap.style.right = 'auto';
    wrap.style.bottom = 'auto';
  }

  // Keep inside viewport on resize (and re-flip the popup)
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const rect = wrap.getBoundingClientRect();
      const { left, top } = clampToViewport(rect.left, rect.top, rect.width, rect.height);
      if (left !== rect.left || top !== rect.top) {
        wrap.style.left = `${left}px`;
        wrap.style.top = `${top}px`;
        wrap.style.right = 'auto';
        wrap.style.bottom = 'auto';
        savePosition(left, top);
      }
      syncTranscriptSide();
    }, 150);
  });

  return {
    el: wrap,
    setState,
    destroy: () => { stopAll(); wrap.remove(); va = null; },
    sttSupported: () => sttSupported(),
    ttsSupported: () => ttsSupported(),
  };
}

/* Auto-mount the global floating Voice Assistant once the Studio shell is ready.
   Positioned bottom-left to avoid the Foppy mascot (bottom-right). */
if (typeof document !== 'undefined' && document.body) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      va = mountVoiceAssistant(document.body);
    });
  } else {
    va = mountVoiceAssistant(document.body);
  }
}
