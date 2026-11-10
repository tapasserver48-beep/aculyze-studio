/**
 * createThinking(props) — reusable "AI thinking" indicator for chat UIs.
 *
 * States: "idle" | "thinking" | "streaming" | "done"
 *
 * @param {Object} props
 * @param {"idle"|"thinking"|"streaming"|"done"} [props.status="idle"]
 * @param {string[]} [props.statusLabels]  rotating labels (cycle ~2.5s, fade)
 * @param {{id:string,text:string}[]} [props.steps]  reasoning steps, animated in
 * @param {number} [props.elapsedSeconds]  external clock; self-tracked if omitted.
 *        Frozen into "Thought for Ns" when leaving "thinking".
 * @param {() => void} [props.onCancel]    Stop button callback
 *
 * @returns {{ el: HTMLElement, update(props:Object):void, snapshot():{seconds:number,steps:{id:string,text:string}[]}, destroy():void }}
 *
 * Usage:
 *   const t = createThinking({ status: 'thinking', onCancel: () => abort() });
 *   mount.appendChild(t.el);
 *   t.update({ steps: [{ id: 's1', text: 'Searching the web' }] });
 *   t.update({ status: 'streaming' });   // collapses to "Thought for Ns"
 *   t.update({ status: 'done' });
 */

const DEFAULT_LABELS = ['Reading your message', 'Gathering context', 'Drafting a reply'];
const LABEL_INTERVAL_MS = 2500; // rotate every 2–3s per spec
const FADE_MS = 220;
const TICK_MS = 250;

let seq = 0;

export function createThinking({
  status = 'idle',
  statusLabels = DEFAULT_LABELS,
  steps = [],
  elapsedSeconds,
  onCancel,
} = {}) {
  const panelId = `ai-think-panel-${++seq}`;
  const state = {
    status,
    statusLabels: statusLabels && statusLabels.length ? statusLabels : DEFAULT_LABELS,
    steps: Array.isArray(steps) ? steps : [],
    elapsedSeconds,
    onCancel,
  };

  // ---- DOM ----
  const el = document.createElement('div');
  el.className = 'ai-thinking';
  el.setAttribute('aria-busy', 'false');
  el.innerHTML = `
    <div class="ai-thinking-live">
      <span class="ai-thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="ai-thinking-status" aria-live="polite"></span>
      <span class="ai-thinking-timer" aria-hidden="true">0s</span>
      <button type="button" class="ai-thinking-toggle ai-thinking-panel-toggle"
              aria-expanded="false" aria-controls="${panelId}"
              aria-label="Toggle reasoning steps">
        <span class="chev" aria-hidden="true">&#8250;</span>
      </button>
      <button type="button" class="ai-thinking-stop">&#9632; Stop</button>
    </div>
    <button type="button" class="ai-thinking-collapsed ai-thinking-toggle"
            aria-expanded="false" aria-controls="${panelId}">
      <span class="chev" aria-hidden="true">&#8250;</span>
      <span class="ai-thinking-title"></span>
    </button>
    <div class="ai-thinking-panel" id="${panelId}">
      <div class="inner"><ol class="ai-thinking-steps"></ol></div>
    </div>
  `;
  const liveEl = el.querySelector('.ai-thinking-live');
  const statusEl = el.querySelector('.ai-thinking-status');
  const timerEl = el.querySelector('.ai-thinking-timer');
  const liveToggle = el.querySelector('.ai-thinking-panel-toggle');
  const stopBtn = el.querySelector('.ai-thinking-stop');
  const collapsedEl = el.querySelector('.ai-thinking-collapsed');
  const titleEl = el.querySelector('.ai-thinking-title');
  const panelEl = el.querySelector('.ai-thinking-panel');
  const stepsEl = el.querySelector('.ai-thinking-steps');

  // ---- time ----
  let startedAt = performance.now();
  let frozenSec = null; // elapsed frozen at thinking → streaming/done
  let labelIdx = 0;
  let labelTimer = null;
  let labelFadeTimer = null;
  let tickTimer = null;
  let panelOpen = false;
  let userToggledPanel = false;
  let destroyed = false;
  const renderedStepIds = new Set();

  const reduceMotion = () =>
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function elapsedSec() {
    if (typeof state.elapsedSeconds === 'number') return Math.max(0, Math.floor(state.elapsedSeconds));
    if (frozenSec !== null) return frozenSec;
    return Math.max(0, Math.floor((performance.now() - startedAt) / 1000));
  }

  // ---- label rotation (thinking only) ----
  function showLabel(text) {
    if (reduceMotion()) {
      statusEl.textContent = text;
      return;
    }
    statusEl.classList.add('fading');
    labelFadeTimer = setTimeout(() => {
      statusEl.textContent = text;
      statusEl.classList.remove('fading');
    }, FADE_MS);
  }

  function startRotation() {
    stopRotation();
    labelIdx = 0;
    statusEl.textContent = state.statusLabels[0];
    if (state.statusLabels.length < 2) return;
    labelTimer = setInterval(() => {
      labelIdx = (labelIdx + 1) % state.statusLabels.length;
      showLabel(state.statusLabels[labelIdx]);
    }, LABEL_INTERVAL_MS);
  }
  function stopRotation() {
    if (labelTimer) clearInterval(labelTimer);
    if (labelFadeTimer) clearTimeout(labelFadeTimer);
    labelTimer = labelFadeTimer = null;
    statusEl.classList.remove('fading');
  }

  // ---- elapsed ticker ----
  function startTick() {
    stopTick();
    tickTimer = setInterval(() => {
      timerEl.textContent = `${elapsedSec()}s`;
    }, TICK_MS);
  }
  function stopTick() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
  }

  // ---- steps ----
  function syncSteps() {
    for (const step of state.steps) {
      if (!step || step.id == null || renderedStepIds.has(step.id)) continue;
      renderedStepIds.add(step.id);
      const li = document.createElement('li');
      li.className = 'ai-thinking-step';
      li.textContent = step.text;
      stepsEl.appendChild(li);
    }
    // First steps arriving while thinking → reveal them ("as they arrive").
    if (!userToggledPanel && state.status === 'thinking' && state.steps.length > 0) {
      setPanel(true);
    }
  }

  // ---- panel ----
  function setPanel(open) {
    panelOpen = !!open;
    panelEl.classList.toggle('open', panelOpen);
    liveToggle.setAttribute('aria-expanded', String(panelOpen));
    collapsedEl.setAttribute('aria-expanded', String(panelOpen));
  }
  function togglePanel() {
    userToggledPanel = true;
    setPanel(!panelOpen);
  }
  liveToggle.addEventListener('click', togglePanel);
  collapsedEl.addEventListener('click', togglePanel);
  stopBtn.addEventListener('click', () => {
    if (typeof state.onCancel === 'function') state.onCancel();
  });

  // ---- render ----
  function render() {
    el.dataset.status = state.status;
    el.setAttribute(
      'aria-busy',
      state.status === 'thinking' || state.status === 'streaming' ? 'true' : 'false'
    );
    timerEl.textContent = `${elapsedSec()}s`;
    titleEl.textContent = elapsedSec() >= 1 ? `Thought for ${elapsedSec()}s` : 'Thought for <1s';
    syncSteps();
  }

  function setStatus(next) {
    const prev = state.status;
    if (next === prev) return;
    if (prev === 'thinking' && (next === 'streaming' || next === 'done')) {
      if (typeof state.elapsedSeconds !== 'number') {
        frozenSec = Math.max(0, Math.floor((performance.now() - startedAt) / 1000));
      }
      stopRotation();
      stopTick();
    }
    if (next === 'thinking') {
      startedAt = performance.now();
      frozenSec = null;
      userToggledPanel = false;
      startRotation();
      startTick();
    }
    state.status = next;
    // Default panel affordance: open while thinking (steps stream in),
    // collapsed on streaming/done (expandable "Thought for Ns" row).
    userToggledPanel = false;
    setPanel(next === 'thinking' && state.steps.length > 0);
  }

  // ---- public API ----
  function update(props = {}) {
    if (destroyed) return;
    if (props.statusLabels && props.statusLabels.length) {
      state.statusLabels = props.statusLabels;
      if (state.status === 'thinking') startRotation();
    }
    if (props.onCancel !== undefined) state.onCancel = props.onCancel;
    if (props.elapsedSeconds !== undefined) {
      state.elapsedSeconds = props.elapsedSeconds;
      if (typeof props.elapsedSeconds === 'number') frozenSec = null;
    }
    if (Array.isArray(props.steps)) state.steps = props.steps;
    if (props.status !== undefined && props.status !== state.status) setStatus(props.status);
    render();
  }

  function snapshot() {
    return {
      seconds: elapsedSec(),
      steps: state.steps.map((s) => ({ id: String(s.id), text: String(s.text) })),
    };
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    stopRotation();
    stopTick();
    el.remove();
  }

  // initial paint — rotation/tick only when born in "thinking"
  if (state.status === 'thinking') {
    startRotation();
    startTick();
  }
  render();
  setPanel(state.status === 'thinking' && state.steps.length > 0);

  return { el, update, snapshot, destroy };
}

export default createThinking;
