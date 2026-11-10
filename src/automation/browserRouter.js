/**
 * Browser router — deterministic natural-language → whitelisted browser actions.
 *
 * Runs BEFORE the app-integrations router (so "Open aculyze.in" is treated as a
 * browser command, not an LMS query). Pure local heuristics — no model call.
 *
 * plan(message) → {
 *   actions: [ { id, tool, args, label, progress, done(r), context(r) } ],
 *   sensitive: null | { title, detail, reason, preview[], verb },
 *   notice: null | string
 * }
 *
 * Security: sensitive intents (buy/pay/send/submit/delete/password…) are
 * flagged and NEVER executed without explicit user confirmation in the UI.
 * The Node/Python layers only accept the fixed action whitelist.
 */

const SITE_LABELS = { google: 'Google', youtube: 'YouTube', bing: 'Bing', duckduckgo: 'DuckDuckGo' };

// Friendly names the Python layer also understands (browser.normalize_url).
const ALIASES = [
  'youtube', 'google', 'gmail', 'github', 'wikipedia', 'amazon', 'twitter', 'linkedin',
  'instagram', 'facebook', 'reddit', 'stackoverflow', 'chatgpt', 'aculyze',
];

const DOMAIN_RE = /(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]+)+(?:\/[^\s]*)?/i;

// Anything that buys, sends, submits, deletes or touches credentials → confirm first.
const SENSITIVE_RE = /\b(buy|purchase|checkout|pay(?:ment|ing)?|place\s+(?:an?\s+)?order|order\s+now|transfer\s+(?:money|funds)|send\s+(?:an?\s+)?(?:email|e-?mail|mail|message|whatsapp)|submit(?:ting)?|delete|deleting|remove|removing|erase|wipe|cancel\s+(?:my\s+)?(?:account|subscription|order)|change\s+(?:my\s+)?password|reset\s+(?:my\s+)?password|sign\s*up|log\s*in|sign\s*in|credit\s*card|bank\s*(?:account|transfer)|payment|book\s+(?:a\s+)?(?:ticket|flight|hotel|appointment)|install|uninstall)\b/i;

// "How do I open Chrome?" is a question, not a command.
const QUESTIONISH_RE = /^(how|why|what|when|where|who|whose|does|did|explain|tell me|describe)\b/i;

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return String(url || '').slice(0, 40); }
}

// ---------------------------------------------------------------------------
// Action builders (each carries its UI texts + context line)
// ---------------------------------------------------------------------------

function mkOpen() {
  return {
    id: 'br-open',
    tool: 'open',
    args: {},
    label: 'Open Chrome',
    progress: '● Browser opening…',
    done: (r) => `✓ Chrome is open.${(r && r.note) ? ` ${r.note}` : ''}`,
    context: (r) => `Browser opened${(r && r.profile === 'signed-in') ? ' (your signed-in Chrome profile)' : ''}.${(r && r.note) ? ` Note: ${r.note}` : ''}`,
  };
}

function mkNavigate(target) {
  const host = hostOf(target);
  return {
    id: 'br-nav',
    tool: 'navigate',
    args: { url: target },
    label: `Open ${host}`,
    progress: `● Opening ${host}…`,
    done: (r) => `✓ Opened ${hostOf((r && r.url) || target)}.`,
    context: (r) => `Navigated to ${(r && r.url) || target}.`,
  };
}

function mkSearch(query, site) {
  const label = SITE_LABELS[site] || 'Google';
  return {
    id: 'br-search',
    tool: 'search',
    args: { query, site },
    label: `Search ${label} for “${query}”`,
    progress: `● Searching ${label} for “${query}”…`,
    done: (r) => `✓ Search completed${(r && typeof r.engine === 'string' && r.engine.startsWith('Bing')) ? ' (via Bing — Google asked for verification)' : ''}.`,
    context: (r) => `Searched ${(r && r.engine) || label} for “${query}”. Results page: ${(r && r.url) || ''}`,
  };
}

function mkBack() {
  return {
    id: 'br-back',
    tool: 'back',
    args: {},
    label: 'Go back',
    progress: '● Going back…',
    done: () => '✓ Went back.',
    context: (r) => `Went back. Now on ${(r && r.url) || 'the previous page'}.`,
  };
}

function mkClose() {
  return {
    id: 'br-close',
    tool: 'close',
    args: {},
    label: 'Close the browser',
    progress: '● Closing browser…',
    done: () => '✓ Browser closed.',
    context: () => 'Browser closed.',
  };
}

function mkRead() {
  return {
    id: 'br-read',
    tool: 'read',
    args: {},
    label: 'Read the current page',
    progress: '● Reading page…',
    done: (r) => `✓ Page read (${((r && r.text) || '').length} chars).`,
    context: (r) => {
      const text = String((r && r.text) || '').slice(0, 4000);
      return `Current page: ${(r && r.title) || ''} (${(r && r.url) || ''})\n${text}`;
    },
  };
}

// ---------------------------------------------------------------------------
// Clause parsing helpers
// ---------------------------------------------------------------------------

function extractSearchQuery(clause) {
  return clause
    .replace(/^\s*(?:please\s+)?(?:can|could|would)?\s*(?:you\s+)?/i, '')
    .replace(/^.*?\b(?:search|look\s*up|google)\b(?:\s+(?:google|youtube|bing|duckduckgo|the\s+web))?\s*(?:for)?\s*[:\-–]?\s*/i, '')
    .replace(/[?.!,]+$/g, '')
    .trim()
    .slice(0, 120);
}

function extractNavigateTarget(clause) {
  const t = clause
    .replace(/^\s*(?:please\s+)?(?:can|could|would)?\s*(?:you\s+)?/i, '')
    .replace(/^\s*(?:go|navigate|visit|head|jump|open|take\s*me(?:\s*to)?)\b\s*(?:to|over)?\s*/i, '')
    .replace(/[?.!,]+$/g, '')
    .trim();
  if (!t) return null;
  const dom = DOMAIN_RE.exec(t);
  if (dom) return dom[0];
  const first = t.toLowerCase().split(/\s+/)[0];
  if (ALIASES.includes(first)) return first;
  return null;
}

function dedupe(actions) {
  // Collapse accidental duplicates (e.g. two searches from overlapping clauses).
  const seen = new Set();
  return actions.filter((a) => {
    const key = `${a.tool}:${JSON.stringify(a.args)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// plan()
// ---------------------------------------------------------------------------

function plan(message) {
  const m = String(message || '').trim();
  const low = m.toLowerCase();
  const empty = { actions: [], sensitive: null, notice: null };
  if (!m || m.length > 400) return empty;

  const questionish = QUESTIONISH_RE.test(m);
  const site = /youtube/.test(low) ? 'youtube'
    : /\bbing\b/.test(low) ? 'bing'
      : /duckduckgo/.test(low) ? 'duckduckgo'
        : 'google';

  const clauses = m
    .split(/\s+(?:and\s+then|and|then|after\s+that)\s*|,\s*/i)
    .map((c) => c.trim())
    .filter(Boolean);

  const actions = [];

  for (const clause of clauses) {
    const c = clause.toLowerCase();

    // Go back --------------------------------------------------------------
    if (/\b(go back|navigate back|previous page|back to the (?:previous|last) page)\b/.test(c)) {
      actions.push(mkBack());
      continue;
    }

    // Close browser --------------------------------------------------------
    if (/\b(?:close|exit|quit)\b.*\b(?:browser|chrome|window)\b/.test(c)) {
      actions.push(mkClose());
      continue;
    }

    // Read page ------------------------------------------------------------
    if (
      /\b(?:read|what(?:'s|\s+is)\s+on|whats\s+on|check|describe|summar(?:ize|ise)|extract|find)\b.*\b(?:this|the|current)?\s*page\b/.test(c)
      || /\bwhat does (?:this|the) page\b/.test(c)
    ) {
      actions.push(mkRead());
      continue;
    }

    // Open the browser (not a question) ------------------------------------
    if (
      !questionish
      && /\b(?:open|launch|start|run)\b.*\b(?:chrome|chromium|browser|edge)\b/.test(c)
    ) {
      actions.push(mkOpen());
      continue;
    }

    // Search ---------------------------------------------------------------
    if (/\b(?:search|look\s*up|google)\b/.test(c) && !/\b(?:chrome|browser)\b/.test(c)) {
      const q = extractSearchQuery(clause);
      if (q) {
        actions.push(mkSearch(q, site));
        continue;
      }
    }

    // Navigate -------------------------------------------------------------
    if (/\b(?:go|navigate|visit|head|jump|open|take\s*me)\b/.test(c)) {
      const target = extractNavigateTarget(clause);
      if (target && !/^(?:chrome|browser|window|tab|it|one)$/i.test(target)) {
        actions.push(mkNavigate(target));
        continue;
      }
    }
  }

  // Sensitive-action gate --------------------------------------------------
  const sens = SENSITIVE_RE.exec(m);
  const sensitive = sens ? {
    title: 'This looks sensitive — run it anyway?',
    reason: sens[0],
    detail: `⚠ Zara detected “${sens[0]}”. Local browser actions that buy, send, submit, delete or touch credentials always need your confirmation first. Nothing runs until you allow it.`,
    preview: actions.length ? actions.map((a) => a.label) : ['No browsing action prepared yet'],
    verb: 'Allow & run',
  } : null;

  if (!actions.length) {
    // A sensitive-sounding *question* ("How do I send an email?") is not a
    // command — only imperative sensitive phrases get the confirmation notice.
    const imperativeSensitive = sensitive && !questionish ? sensitive : null;
    return {
      actions: [],
      sensitive: null,
      notice: imperativeSensitive
        ? 'I can prepare that, but I need your confirmation before anything is sent, submitted, purchased or deleted.'
        : null,
    };
  }

  return { actions: dedupe(actions), sensitive, notice: null };
}

module.exports = { plan };
