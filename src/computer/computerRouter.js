/**
 * Computer router — deterministic natural-language → whitelisted computer
 * actions. Pure local heuristics, NO model call (same pattern as the browser
 * router). Runs AFTER the browser router, so "Open Chrome and search X" is
 * owned by browser automation and "Open VS Code" lands here.
 *
 * plan(message) → {
 *   actions: [ { id, tool, args, label, progress, done(r), context(r) } ],
 *   notice:  null | string
 * }
 *
 * Security: only the eight implemented Level-1 operations can ever appear in
 * `actions` (app.open/close/focus/list, window.minimize/maximize/restore,
 * desktop.show). Level 2/3 intents (install, delete, settings, scripts,
 * passwords…) are detected and answered honestly — never executed.
 */

const { normalizeAppName, BROWSER_MODULE_APPS } = require('./aliases');
const { highRiskIntent, explanationFor } = require('./permissions');

// "How do I open Chrome?" is a question, not a command.
const QUESTIONISH_RE = /^(?:how|why|what|when|where|who|whose|does|did|explain|tell me|describe)\b/i;

// Leading politeness filler: "hey zara,", "can you please", …
const POLITE_RE = /^\s*(?:hey\s+|ok\s+|yo\s+)?(?:zara\s*[,.]?\s*)?(?:(?:can|could|would|will)\s+)?(?:you\s+)?(?:please\s+)?/i;

const PRONOUN_RE = /^(?:it|that|this|them|the\s+(?:app|application|window|program)|everything)$/i;

const VERBS = [
  { re: /^(?:open|launch|start|run|fire\s+up)\s+/i, tool: 'app.open' },
  { re: /^(?:close|quit|exit)\s+/i, tool: 'app.close' },
  { re: /^(?:switch\s+to|go\s+to|bring\s+up|bring\s+back\s+to|focus(?:\s+on)?|activate)\s+/i, tool: 'app.focus' },
  { re: /^(?:minimi[sz]e)\s+/i, tool: 'window.minimize' },
  { re: /^(?:maximi[sz]e|fullscreen)\s+/i, tool: 'window.maximize' },
  { re: /^(?:restore|unmini[sz]e|normali[sz]e)\s+/i, tool: 'window.restore' },
];

const DESKTOP_RE = /\b(?:show\s+(?:me\s+)?(?:the\s+)?desktop|show\s+desktop|minimi[sz]e\s+(?:everything|all\s+(?:the\s+)?(?:windows|apps))|hide\s+(?:all\s+)?(?:the\s+)?windows)\b/i;

// "capture the screen" / "take a screenshot" — read-only screenshot (Level 1).
const SCREENSHOT_RE = /\b(?:take|capture|grab|snap)\s+(?:a\s+)?(?:screenshot|screen\s+shot|picture|capture)|\bscreenshot\b|\bcapture\s+(?:the\s+)?(?:screen|display|monitor)\b/i;

// "Do I have VS Code?" / "Is Photoshop installed?" / "Which browser do I have?"
const CHECK_RE = /^(?:do\s+(?:i|we)\s+have|is|are|does\s+(?:this\s+computer|my\s+(?:computer|pc|laptop|mac))\s+have)\s+(.+?)(?:\s+installed|\s+on\s+this\s+(?:computer|pc|laptop|mac))?\s*\??$/i;
const BROWSERS_RE = /^(?:which|what)\s+(?:web\s*)?browsers?\b/i;
const LIST_RE = /^(?:(?:what|which|list|show|give\s+me(?:\s+a\s+list\s+of)?|tell\s+me(?:\s+about)?)\b[\s\S]{0,40}\b(?:apps?|applications?|programs?|software)\b|(?:apps?|applications?|programs?)\s+(?:i\s+)?(?:have|installed))/i;

// ---------------------------------------------------------------------------
// Action builders (UI texts + context lines, same contract as browser router)
// ---------------------------------------------------------------------------

function mkOpen(name) {
  return {
    id: 'cp-open',
    tool: 'app.open',
    args: { app: name },
    label: `Open ${name}`,
    progress: `● Opening ${name}…`,
    done: (r) => {
      if (r && r.missing) return `⚠ Zara couldn't find ${name} on this computer.`;
      if (r && r.ok) return `✓ ${name} opened.`;
      return `⚠ Zara couldn't open ${name}.`;
    },
    context: (r) => {
      if (r && r.missing) return `${name} is NOT installed on this computer. Tell the user briefly, e.g. "I couldn't find ${name} on this computer." Never claim it opened.`;
      if (r && r.ok) return `${name} was opened on this computer. Give a SHORT confirmation in the user's phrasing. Never claim other actions.`;
      return `${name} did not start. Tell the user briefly it could not be opened.`;
    },
  };
}

function mkClose(name) {
  return {
    id: 'cp-close',
    tool: 'app.close',
    args: { app: name },
    label: `Close ${name}`,
    progress: `● Closing ${name}…`,
    done: (r) => {
      if (r && r.missing) return `⚠ Zara couldn't find ${name} on this computer.`;
      if (r && r.wasRunning === false) return `✓ ${name} wasn't running.`;
      if (r && r.closed) return `✓ ${name} closed.`;
      return `⚠ ${name} didn't close${(r && r.note) ? ` (${r.note})` : ''}.`;
    },
    context: (r) => {
      if (r && r.missing) return `${name} is NOT installed on this computer. Say so briefly.`;
      if (r && r.closed) return `${name} was closed. Give a SHORT confirmation.`;
      if (r && r.wasRunning === false) return `${name} was not running — nothing to close. Say so briefly.`;
      return `${name} did not close${(r && r.note) ? ` — ${r.note}` : ''}. Say so briefly; never claim it closed.`;
    },
  };
}

function mkFocus(name) {
  return {
    id: 'cp-focus',
    tool: 'app.focus',
    args: { app: name },
    label: `Switch to ${name}`,
    progress: `● Switching to ${name}…`,
    done: (r) => (r && (r.found || r.ok)) ? `✓ Switched to ${name}.` : `⚠ Zara couldn't switch to ${name} (is it open?).`,
    context: (r) => ((r && (r.found || r.ok))
      ? `Focused the ${name} window. Give a SHORT confirmation.`
      : `Could not focus ${name} — it may not be open. Say so briefly.`),
  };
}

function mkWindowOp(tool, name) {
  const verb = tool === 'window.minimize' ? 'Minimize' : tool === 'window.maximize' ? 'Maximize' : 'Restore';
  const past = verb.toLowerCase() === 'minimize' ? 'minimized' : verb.toLowerCase() === 'maximize' ? 'maximized' : 'restored';
  return {
    id: `cp-${tool.split('.')[1]}`,
    tool,
    args: { app: name },
    label: `${verb} ${name}`,
    progress: `● ${verb}ing ${name}…`,
    done: (r) => {
      if (r && r.missing) return `⚠ Zara couldn't find ${name} on this computer.`;
      if (r && r.found) return `✓ ${name} ${past}.`;
      return `⚠ No open ${name} window to ${verb.toLowerCase()}.`;
    },
    context: (r) => {
      if (r && r.missing) return `${name} is NOT installed on this computer. Say so briefly.`;
      if (r && r.found) return `${name} was ${past}. Give a SHORT confirmation.`;
      return `No open ${name} window was found, so nothing was ${past}. Say so briefly.`;
    },
  };
}

function mkDesktop() {
  return {
    id: 'cp-desktop',
    tool: 'desktop.show',
    args: {},
    label: 'Show desktop',
    progress: '● Showing your desktop…',
    done: () => '✓ Desktop shown.',
    context: () => 'The desktop was shown (all windows minimized). Give a SHORT confirmation.',
  };
}

function mkScreenshot() {
  return {
    id: 'cp-screenshot',
    tool: 'screen.capture',
    args: {},
    label: 'Capture the screen',
    progress: '● Capturing your screen…',
    done: (r) => (r && r.ok) ? '✓ Screen captured.' : '⚠ I couldn\'t capture the screen.',
    context: (r) => ((r && r.ok)
      ? 'A screenshot of the screen was captured. Give a SHORT confirmation; you cannot see the image, so do not describe its contents.'
      : 'The screenshot could not be taken. Say so briefly.'),
  };
}

function mkAppList(app) {
  return {
    id: 'cp-list',
    tool: 'app.list',
    args: app ? { kind: 'check', app } : { kind: 'list' },
    label: app ? `Check for ${app}` : 'List installed apps',
    progress: app ? `● Checking for ${app}…` : '● Listing your apps…',
    done: (r) => `✓ ${(r && r.direct) ? 'Answer ready.' : 'Done.'}`,
    context: () => '', // the direct answer is rendered verbatim; no model needed
  };
}

// ---------------------------------------------------------------------------
// plan()
// ---------------------------------------------------------------------------

function cleanAppPhrase(s) {
  return String(s || '')
    .replace(/[?.!,]+$/g, '')
    .replace(/^up\s+/i, '')
    .replace(/^(?:the|my|a|an)\s+/i, '')
    .replace(/\s+(?:please|for\s+me|up|now|on\s+my\s+(?:computer|pc|laptop|mac|desktop)|(?:app|application|program))$/i, '')
    .trim();
}

function plan(message) {
  const m = String(message || '').trim();
  const empty = { actions: [], notice: null };
  if (!m || m.length > 400) return empty;

  // Show desktop ------------------------------------------------------------
  if (DESKTOP_RE.test(m)) return { actions: [mkDesktop()], notice: null };

  // Screen capture (read-only screenshot) ----------------------------------
  if (SCREENSHOT_RE.test(m) && !/\b(?:of|the)\s+(?:app|window)\b/i.test(m)) {
    return { actions: [mkScreenshot()], notice: null };
  }

  // Installed-app questions → deterministic local answer (no model needed) --
  const q = m.replace(POLITE_RE, '');
  if (BROWSERS_RE.test(q)) {
    return { actions: [{ ...mkAppList(null), args: { kind: 'browsers' } }], notice: null };
  }

  const check = CHECK_RE.exec(q);
  if (check) {
    const phrase = cleanAppPhrase(check[1]);
    if (phrase && !PRONOUN_RE.test(phrase)) {
      const norm = normalizeAppName(phrase);
      return { actions: [mkAppList(norm ? norm.name : phrase)], notice: null };
    }
  }
  if (LIST_RE.test(q) && !/\b(?:open|launch|close)\b/i.test(q)) {
    return { actions: [mkAppList(null)], notice: null };
  }

  // Questions that are NOT app queries → let the model answer normally -------
  if (QUESTIONISH_RE.test(m)) return empty;

  // Imperative clauses ------------------------------------------------------
  const clauses = q
    .split(/\s+(?:and\s+then|and|then|after\s+that)\s*|,\s*/i)
    .map((c) => c.trim())
    .filter(Boolean);

  const actions = [];
  for (const clause of clauses) {
    // strip politeness per clause ("…, please", "then switch to…")
    const c = clause
      .replace(POLITE_RE, '')
      .replace(/^(?:and\s+then|then|after\s+that)\s+/i, '')
      .replace(/\s+please$/i, '')
      .trim();
    if (!c) continue;

    const verb = VERBS.find((v) => v.re.test(c));
    if (!verb) continue;

    const phrase = cleanAppPhrase(c.replace(verb.re, ''));
    if (!phrase || PRONOUN_RE.test(phrase)) continue;

    const norm = normalizeAppName(phrase);
    if (!norm) continue;

    // "Open Chrome/Edge/Chromium" belongs to the browser module (it opens a
    // real signed-in browser window). Window control of them stays here.
    if (verb.tool === 'app.open' && BROWSER_MODULE_APPS.includes(norm.name)) continue;

    if (verb.tool === 'app.open') actions.push(mkOpen(norm.name));
    else if (verb.tool === 'app.close') actions.push(mkClose(norm.name));
    else if (verb.tool === 'app.focus') actions.push(mkFocus(norm.name));
    else actions.push(mkWindowOp(verb.tool, norm.name));
  }

  // Level 2/3 gate — detected, never executed -------------------------------
  const appPhrase = actions.length ? actions[0].args.app : null;
  const risky = highRiskIntent(m, appPhrase);
  if (risky) {
    // Even if a Level-1 clause matched, a risky intent in the same message
    // means NOTHING runs until a human decides — honest refusal instead.
    return { actions: [], notice: explanationFor(risky) };
  }

  return { actions, notice: null };
}

module.exports = { plan };
