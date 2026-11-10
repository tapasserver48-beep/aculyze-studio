/**
 * Permission levels for Zara Computer Control.
 *
 * LEVEL 1 (safe)   — allowed without confirmation: open/close/focus apps,
 *                    list apps, minimize/maximize/restore windows, show desktop.
 * LEVEL 2 (confirm)— NOT implemented in v1 (settings changes, installs,
 *                    scripts, startup items, permissions…). The router detects
 *                    these intents and answers honestly — it never executes them.
 * LEVEL 3 (high)   — NOT implemented in v1 (passwords, financial actions,
 *                    purchases, account deletion, disabling security controls).
 *
 * The router classifies a message; the routes layer independently enforces the
 * operation whitelist, so the model/UI can never reach an unimplemented op.
 */

const LEVEL_1_OPS = [
  'app.open', 'app.close', 'app.focus', 'app.list',
  'window.minimize', 'window.maximize', 'window.restore',
  'desktop.show',
  'screen.capture', // read-only screenshot — safe, used by the visual loop
];

// The ONLY tools the /execute endpoint will ever run.
const ALLOWED_TOOLS = new Set(LEVEL_1_OPS);

// Level 2/3 intents — detected so Zara can answer honestly instead of
// silently doing nothing. None of these are ever executed in v1.
const HIGH_RISK_RE = new RegExp(
  '\\b('
  + 'install(?:ing|ed)?|uninstall|reinstall'
  + '|delete|deleting|deleted|erase|erasing|wipe|wiping|format(?:ting)?'
  + '|shut\\s*down|power\\s*off|restart\\s+(?:(?:the|my)\\s+)?(?:pc|computer|laptop|machine)'
  + '|change\\s+(?:the\\s+|my\\s+)?(?:system\\s+)?settings|change\\s+(?:the\\s+)?permissions?'
  + '|run\\s+(?:a\\s+|the\\s+|this\\s+|some\\s+)?(?:script|command|powershell|shell)'
  + '|execute\\s+(?:a\\s+|the\\s+|this\\s+)?(?:script|command)'
  + '|modify\\s+(?:the\\s+)?startup|startup\\s+(?:apps?|programs?|items?)'
  + '|password|credential'
  + '|disable\\s+(?:the\\s+)?(?:antivirus|defender|firewall|security)'
  + '|security\\s+settings'
  + '|buy|purchase|pay|transfer\\s+(?:money|funds)'
  + '|delete\\s+(?:my\\s+)?account'
  + ')\\b',
  'i',
);

/**
 * Detect a Level 2/3 intent that is NOT just an app name.
 * Returns the matched phrase or null. `appPhrase` (if any) lets us avoid
 * flagging "Open PowerShell" — the sensitive word IS the app being opened.
 */
function highRiskIntent(message, appPhrase) {
  const m = HIGH_RISK_RE.exec(String(message || ''));
  if (!m) return null;
  const phrase = String(appPhrase || '').toLowerCase();
  // The match must not be simply the name of the app in an otherwise-safe op
  // ("Open PowerShell" / "Open Settings" are Level 1).
  if (phrase && phrase.includes(m[1].toLowerCase())) return null;
  return m[1];
}

function explanationFor(match) {
  return `“${match}” is a higher-risk system action (Level ${/password|credential|buy|purchase|pay|account|security|disable/i.test(match) ? '3' : '2'}). `
    + "Zara's computer control doesn't perform those yet — nothing was changed. "
    + 'It only opens, closes, focuses apps and controls their windows.';
}

module.exports = { LEVEL_1_OPS, ALLOWED_TOOLS, HIGH_RISK_RE, highRiskIntent, explanationFor };
