/**
 * Zara Orchestrator — deterministic intent router.
 *
 * Composes the EXISTING browser and computer routers (never duplicates them)
 * and adds a YouTube/visual-workflow detector on top. It decides whether a
 * message needs:
 *
 *   • normal conversation      → 'conversation' (falls through to the LLM)
 *   • computer control         → 'computer'     (existing /api/computer)
 *   • browser interaction      → 'browser'      (existing /api/browser)
 *   • a YouTube/visual workflow→ 'youtube'      (new orchestrator workflow)
 *
 * It is pure local heuristics — NO model call, no side effects. The LLM is
 * never asked to emit tool calls; it only ever produces the final natural
 * language answer after a whitelisted local tool ran.
 *
 * Security: this router only classifies. Execution is enforced again by the
 * capability it delegates to (the browser/computer whitelist, or the
 * orchestrator workflow's fixed action list). There is no path by which a raw
 * shell/command string reaches an OS or browser.
 */

const browserRouter = require('../automation/browserRouter');
const computerRouter = require('../computer/computerRouter');

// ---------------------------------------------------------------------------
// YouTube / visual-workflow detection
// ---------------------------------------------------------------------------

// Strip leading politeness the way the other routers do.
const POLITE_RE = /^\s*(?:hey\s+|ok\s+|yo\s+)?(?:zara\s*[,.]?\s*)?(?:(?:can|could|would|will)\s+)?(?:you\s+)?(?:please\s+)?/i;

// "play Believer on YouTube" / "play believer" (with youtube implied later)
const PLAY_RE = /^(?:play|watch|put\s+on)\s+(.+?)(?:\s+(?:on|from|via)\s+youtube)?\s*$/i;
// "search YouTube for relaxing music" / "search youtube for X" / "youtube search X"
const YT_SEARCH_RE = /^(?:search|look\s*up|find)\s+(?:youtube|yt)\s*(?:for)?\s*[:\-–]?\s*(.+?)\s*$/i
  ;
// "pause the (youtube) video" / "stop the video"
const PAUSE_RE = /^(?:pause|stop)\s+(?:the\s+)?(?:youtube\s+)?(?:video|music|song|player)\s*$/i;
// "resume/continue/unpause the video" / "play the video" (current video)
const RESUME_RE = /^(?:resume|continue|unpause|keep\s+playing)\s+(?:the\s+)?(?:youtube\s+)?(?:video|music|song|player)?\s*(?:again)?\s*$/i;
const PLAY_CURRENT_RE = /^(?:play|start)\s+(?:the\s+)?(?:youtube\s+)?(?:video|music|song|player)\s*$/i;
// "scroll down on youtube" / "scroll the page"
const SCROLL_RE = /^(?:scroll|swipe)\s+(?:(?:the\s+)?(?:page|video|results?|window)\s+)?(?:down|up|a\s+little|more)\b|^scroll\s+(?:the\s+)?(?:page|video|results?|window)\s*$/i;
// "click the first visible video" / "click the first result" / "open this youtube video"
const CLICK_RE = /^(?:click|select|choose|open)\s+(?:(?:the|a|an|this|that|first|top|visible|next|most|best)\s+)*(?:youtube\s+)?(?:video|result|link)\s*$/i;

function looksLikeYouTube(m) {
  return /\byou\s*tube\b|\byt\b/i.test(m);
}

/**
 * Detect a YouTube/visual workflow intent. Clause-based so compound messages
 * ("Open Chrome and play X on YouTube") are handled — the workflow opens the
 * browser itself.
 * Returns { workflow, query } or null.
 */
function detectYouTube(message) {
  const raw = String(message || '').trim();
  if (!raw || raw.length > 400) return null;
  const cleaned = raw.replace(POLITE_RE, '').trim();
  const yt = looksLikeYouTube(raw);

  const clauses = cleaned
    .split(/\s+(?:and\s+then|and|then|after\s+that)\s*|,\s*/i)
    .map((c) => c.trim())
    .filter(Boolean);

  for (const clause of clauses) {
    const c = clause;
    if (PAUSE_RE.test(c) && (yt || /video|music|song|player/i.test(c))) {
      return { workflow: 'youtube.pause', query: null };
    }
    if (RESUME_RE.test(c) && (yt || /video|music|song|player/i.test(c))) {
      return { workflow: 'youtube.resume', query: null };
    }
    if (PLAY_CURRENT_RE.test(c) && (yt || /video|music|song|player/i.test(c))) {
      return { workflow: 'youtube.resume', query: null };
    }
    if (SCROLL_RE.test(c) && (yt || /video|results?|page/i.test(c))) {
      return { workflow: 'youtube.scroll', query: null };
    }
    if (CLICK_RE.test(c) && (yt || /video|result/i.test(c))) {
      return { workflow: 'youtube.click', query: null };
    }
    // "search YouTube for X"
    const s = YT_SEARCH_RE.exec(c);
    if (s && s[1]) return { workflow: 'youtube.search', query: cleanQuery(s[1]) };
    // "play X on YouTube" (YouTube named in the clause or the whole message)
    const p = PLAY_RE.exec(c);
    if (p && p[1] && (yt || /\bon\s+youtube\b/i.test(raw))) {
      return { workflow: 'youtube.play', query: cleanQuery(p[1]) };
    }
  }

  // Bare "open youtube" / "go to youtube" → navigate there.
  if (/^(?:open|go\s+to|visit|take\s+me\s+to)\s+(?:the\s+)?(?:official\s+)?youtube\s*$/i.test(cleaned)) {
    return { workflow: 'youtube.open', query: null };
  }

  return null;
}

function cleanQuery(s) {
  return String(s || '')
    .replace(/[?.!,]+$/g, '')
    .replace(/^(?:the\s+|a\s+|an\s+)/i, '')
    .trim()
    .slice(0, 120);
}

// ---------------------------------------------------------------------------
// plan() — the central classification
// ---------------------------------------------------------------------------

/**
 * plan(message) → {
 *   intent:   'conversation' | 'computer' | 'browser' | 'youtube',
 *   workflow: null | 'youtube.play' | 'youtube.search' | …,
 *   query:    null | string,
 *   browser:  browserRouter plan | null,
 *   computer: computerRouter plan | null,
 *   reason:   short human-readable classification note (for logs/tests),
 * }
 */
function plan(message) {
  const m = String(message || '').trim();

  // 1. YouTube / visual workflow — highest priority for its specific phrases.
  const yt = detectYouTube(m);
  if (yt) {
    return {
      intent: 'youtube',
      workflow: yt.workflow,
      query: yt.query,
      browser: null,
      computer: null,
      reason: `YouTube workflow: ${yt.workflow}`,
    };
  }

  // 2. Compose the EXISTING routers (no duplication — pure delegation).
  const b = browserRouter.plan(m);
  const c = computerRouter.plan(m);

  const hasBrowser = b && b.actions && b.actions.length;
  const hasComputer = c && c.actions && c.actions.length;

  // Browser runs first (matches the existing frontend order), so browser
  // commands are never hijacked by the computer router.
  if (hasBrowser || (b && b.notice)) {
    return {
      intent: 'browser', workflow: null, query: null,
      browser: b, computer: null,
      reason: hasBrowser ? 'browser action' : 'browser sensitive notice',
    };
  }
  if (hasComputer || (c && c.notice)) {
    return {
      intent: 'computer', workflow: null, query: null,
      browser: null, computer: c,
      reason: hasComputer ? 'computer action' : 'computer risk notice',
    };
  }

  // 3. Nothing local matched → normal conversation (the LLM answers).
  return { intent: 'conversation', workflow: null, query: null, browser: null, computer: null, reason: 'no local tool matched' };
}

module.exports = { plan, detectYouTube };
