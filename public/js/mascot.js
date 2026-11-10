/* Foppy mascot engine — vanilla port of the `page-mascot` component pattern
 * (MIT © Kamran Ahmed, https://github.com/nilbuild/page-mascot). The original
 * React component is unwrapped into this single ESM file for the non-bundler
 * Studio page: same 3x3 sheet geometry, dead zone, hysteresis, squash and
 * single-property `background-position` cell switching — no animation library.
 *
 * Sheet files (serve from public/mascot/):
 *   ./mascot/bunny-directions.webp   1080x1080, 3x3 head directions
 *   ./mascot/butterfly-reactions.webp 1080x1080, 3x3 expressions
 * Sheets are probed at init; when missing the button collapses to a quiet dot
 * placeholder so the UI stays clean until the real character is dropped in.
 */

export const DIRECTIONS = ['up-left', 'up', 'up-right', 'left', 'center', 'right', 'down-left', 'down', 'down-right'];
export const REACTIONS = ['blink', 'heart', 'sparkle', 'surprised', 'wink', 'bashful', 'sleepy', 'dizzy', 'delighted'];

// Clockwise from the right (matches atan2 with y pointing down) — reference parity.
const CLOCKWISE = ['right', 'down-right', 'down', 'down-left', 'left', 'up-left', 'up', 'up-right'];
const SECTOR = (Math.PI * 2) / CLOCKWISE.length;
const HYSTERESIS = 0.12;
const DEAD_ZONE = 70;
const SQUASH_MS = 420;

const SQUASH = [
  { transform: 'scale(1, 1)', easing: 'ease-in' },
  { transform: 'scale(1.10, 0.86)', offset: 0.18, easing: 'ease-out' },
  { transform: 'scale(0.95, 1.08)', offset: 0.45, easing: 'ease-in-out' },
  { transform: 'scale(1.03, 0.97)', offset: 0.72, easing: 'ease-in-out' },
  { transform: 'scale(1, 1)' },
];

/** Studio state -> { reaction cell, dir hint }. Cells stay on the reference sheet. */
const STATE_CELLS = {
  idle: { dir: 'center' },
  listening: { reaction: 'wink' },
  thinking: { reaction: 'bashful', dir: 'center' },
  fetching: { reaction: 'bashful', dir: 'center' },
  searching: { reaction: 'bashful', dir: 'center' },
  analyzing: { reaction: 'bashful', dir: 'center' },
  speaking: { reaction: 'delighted', dir: 'center' },
  success: { reaction: 'heart', dir: 'center' },
  error: { reaction: 'dizzy', dir: 'center' },
  sleeping: { reaction: 'sleepy', dir: 'down' },
};

function cellPos(index) {
  return `${(index % 3) * 50}% ${Math.floor(index / 3) * 50}%`;
}

function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

export function createMascot(root, {
  size = 64,
  directions = './mascot/bunny-directions.webp',
  reactions = './mascot/butterfly-reactions.webp',
  label = 'Foppy',
  onToggle = null,
} = {}) {
  let state = 'idle';
  let listening = false;
  let flutterTimer = null;
  let blinkTimer = null;
  let payTimer = null;
  let payLock = 0;
  let dead = false;
  let sheetsReady = false;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'foppy-mascot';
  button.setAttribute('aria-label', `${label}, personal voice assistant`);
  button.setAttribute('role', 'button');

  const stage = document.createElement('span');
  stage.className = 'foppy-mascot-stage';

  const dirLayer = document.createElement('span');
  dirLayer.className = 'foppy-layer foppy-layer-directions';
  dirLayer.style.backgroundImage = `url("${directions}")`;
  dirLayer.style.backgroundPosition = cellPos(DIRECTIONS.indexOf('center'));

  const reactionLayer = document.createElement('span');
  reactionLayer.className = 'foppy-layer foppy-layer-reactions';
  reactionLayer.style.backgroundImage = `url("${reactions}")`;
  reactionLayer.style.backgroundPosition = cellPos(REACTIONS.indexOf('blink'));
  reactionLayer.style.opacity = '0';

  const dot = document.createElement('span');
  dot.className = 'foppy-dot';
  dot.setAttribute('aria-hidden', 'true');

  const tag = document.createElement('span');
  tag.className = 'foppy-tag';
  tag.textContent = label;
  tag.setAttribute('aria-hidden', 'true');

  stage.append(dirLayer, reactionLayer, dot);
  button.append(stage, tag);
  root.appendChild(button);

  // Tiny sheet presence probe: when either webp is absent, show the neutral dot.
  const probe = new Image();
  probe.onload = () => { sheetsReady = true; button.classList.remove('sheets-missing'); };
  probe.onerror = () => { sheetsReady = false; button.classList.add('sheets-missing'); };
  probe.src = directions;
  const probe2 = new Image();
  probe2.onerror = () => { sheetsReady = false; button.classList.add('sheets-missing'); };
  probe2.src = reactions;

  function paint() {
    const mapped = STATE_CELLS[state] || STATE_CELLS.idle;
    if (!sheetsReady) return; // dot fallback needs no cell painting
    if (mapped.dir) dirLayer.style.backgroundPosition = cellPos(DIRECTIONS.indexOf(mapped.dir));
    else if (pointerDir) dirLayer.style.backgroundPosition = cellPos(DIRECTIONS.indexOf(pointerDir));
    else dirLayer.style.backgroundPosition = cellPos(DIRECTIONS.indexOf('center'));

    if (mapped.reaction) {
      reactionLayer.style.backgroundPosition = cellPos(REACTIONS.indexOf(mapped.reaction));
      dirLayer.style.opacity = '0';
      reactionLayer.style.opacity = '1';
    } else {
      dirLayer.style.opacity = '1';
      reactionLayer.style.opacity = '0';
    }
  }

  /* Pointer gaze — the page-mascot pattern: dead zone + hysteresis hold. */
  let pointer = null;
  let pointerDir = null;
  let sector = -1;

  function aim() {
    if (dead) return;
    const box = button.getBoundingClientRect();
    if (state === 'speaking' || state === 'thinking' || state === 'success' || state === 'error' || state === 'sleeping') {
      pointerDir = null; // settle, no chase during work states
      paint();
      return;
    }
    if (!pointer) { paint(); return; }
    const dx = pointer.x - (box.left + box.width / 2);
    const dy = pointer.y - (box.top + box.height / 2);
    if (Math.hypot(dx, dy) < DEAD_ZONE) {
      pointerDir = null;
      sector = -1;
      paint();
      return;
    }
    const angle = Math.atan2(dy, dx);
    if (sector !== -1 && Math.abs(wrapAngle(angle - sector * SECTOR)) < SECTOR / 2 + HYSTERESIS) return;
    sector = (Math.round(angle / SECTOR) + CLOCKWISE.length) % CLOCKWISE.length;
    pointerDir = CLOCKWISE[sector];
    paint();
  }

  function onMove(event) {
    pointer = { x: event.clientX, y: event.clientY };
    aim();
  }
  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('scroll', () => aim(), { passive: true });

  /* Occasional quiet blink and slower breath purely via sheet frames + CSS. */
  function scheduleBlink() {
    clearTimeout(blinkTimer);
    blinkTimer = setTimeout(() => {
      if (dead || listening || state !== 'idle' || !sheetsReady) { scheduleBlink(); return; }
      reactionLayer.style.backgroundPosition = cellPos(REACTIONS.indexOf('blink'));
      dirLayer.style.opacity = '0';
      reactionLayer.style.opacity = '1';
      setTimeout(() => {
        if (dead) return;
        if (state === 'idle' && !listening) { dirLayer.style.opacity = '1'; reactionLayer.style.opacity = '0'; }
        scheduleBlink();
      }, 170);
    }, 4000 + Math.random() * 4000);
  }

  function stopFlutter() {
    clearInterval(flutterTimer);
    flutterTimer = null;
  }

  button.addEventListener('click', () => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches === false && stage.animate) {
      stage.animate(SQUASH, { duration: SQUASH_MS, easing: 'linear' });
    }
    // Brief wink payoff (as the reference shows a reaction on poke).
    const now = Date.now();
    if (now > payLock && state !== 'speaking') {
      payLock = now + 700;
      reactionLayer.style.backgroundPosition = cellPos(REACTIONS.indexOf('wink'));
      dirLayer.style.opacity = '0';
      reactionLayer.style.opacity = '1';
      clearTimeout(payTimer);
      payTimer = setTimeout(() => {
        if (dead || state === 'speaking' || listening) return;
        dirLayer.style.opacity = '1';
        reactionLayer.style.opacity = '0';
      }, 460);
    }
    if (typeof onToggle === 'function') onToggle();
  });

  scheduleBlink();

  return {
    el: button,
    setState(next) {
      const normalized = STATE_CELLS[next] ? next : 'idle';
      if (next === 'sleep') stopFlutter();
      state = normalized;
      if (state === 'idle') scheduleBlink();
      else clearTimeout(blinkTimer);
      if (state !== 'speaking') stopFlutter();
      // Speaking: gentle per-utterance flutter between delighted/wink cells, no bounce.
      if (state === 'speaking' && sheetsReady && !flutterTimer) {
        let on = true;
        flutterTimer = setInterval(() => {
          if (state !== 'speaking' || !sheetsReady) { stopFlutter(); return; }
          reactionLayer.style.backgroundPosition = cellPos(REACTIONS.indexOf(on ? 'delighted' : 'wink'));
          on = !on;
        }, 380);
      }
      paint();
    },
    setListening(on) {
      listening = !!on;
      paint();
      if (listening) {
        clearTimeout(blinkTimer);
        button.classList.add('is-listening');
      } else {
        button.classList.remove('is-listening');
        scheduleBlink();
      }
    },
    sheetOk: () => sheetsReady,
    destroy() {
      dead = true;
      stopFlutter();
      clearTimeout(blinkTimer);
      clearTimeout(payTimer);
      window.removeEventListener('pointermove', onMove);
      button.remove();
    },
  };
}
