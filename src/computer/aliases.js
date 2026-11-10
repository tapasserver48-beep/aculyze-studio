/**
 * App-name aliases / normalization for Zara Computer Control.
 *
 * Pure data + pure functions — no OS calls. The router normalizes whatever
 * phrase the user typed into a canonical app name; the platform resolver then
 * decides whether that canonical name actually exists on this machine.
 *
 * Canonical names are display names ("Visual Studio Code"), NOT paths. The
 * resolver performs discovery (Start Menu / Applications folder / registry /
 * PATH) — nothing here hard-codes an install location.
 */

const ALIASES = {
  // Browsers --------------------------------------------------------------
  'chrome': 'Google Chrome',
  'google chrome': 'Google Chrome',
  'google-chrome': 'Google Chrome',
  'chromium': 'Chromium',
  'edge': 'Microsoft Edge',
  'msedge': 'Microsoft Edge',
  'microsoft edge': 'Microsoft Edge',
  'firefox': 'Mozilla Firefox',
  'mozilla firefox': 'Mozilla Firefox',
  'brave': 'Brave Browser',
  'brave browser': 'Brave Browser',
  'opera': 'Opera',
  'safari': 'Safari',

  // Editors / dev tools ---------------------------------------------------
  'vscode': 'Visual Studio Code',
  'vs code': 'Visual Studio Code',
  'vs-code': 'Visual Studio Code',
  'visual studio code': 'Visual Studio Code',
  'code editor': 'Visual Studio Code',
  'my code editor': 'Visual Studio Code',
  'visual studio': 'Visual Studio',
  'sublime': 'Sublime Text',
  'sublime text': 'Sublime Text',
  'notepad++': 'Notepad++',
  'notepad plus plus': 'Notepad++',
  'intellij': 'IntelliJ IDEA',
  'intellij idea': 'IntelliJ IDEA',
  'pycharm': 'PyCharm',
  'android studio': 'Android Studio',
  'github desktop': 'GitHub Desktop',

  // Microsoft Office -------------------------------------------------------
  'word': 'Microsoft Word',
  'microsoft word': 'Microsoft Word',
  'excel': 'Microsoft Excel',
  'microsoft excel': 'Microsoft Excel',
  'powerpoint': 'Microsoft PowerPoint',
  'microsoft powerpoint': 'Microsoft PowerPoint',
  'outlook': 'Microsoft Outlook',
  'microsoft outlook': 'Microsoft Outlook',
  'onenote': 'Microsoft OneNote',
  'teams': 'Microsoft Teams',
  'microsoft teams': 'Microsoft Teams',

  // Built-in Windows / macOS apps -----------------------------------------
  'notepad': 'Notepad',
  'calculator': 'Calculator',
  'calc': 'Calculator',
  'terminal': 'Terminal',
  'command prompt': 'Command Prompt',
  'cmd': 'Command Prompt',
  'command line': 'Command Prompt',
  'powershell': 'PowerShell',
  'windows terminal': 'Windows Terminal',
  'file explorer': 'File Explorer',
  'explorer': 'File Explorer',
  'files': 'File Explorer',
  'finder': 'Finder',
  'settings': 'Settings',
  'system settings': 'Settings',
  'windows settings': 'Settings',
  'control panel': 'Control Panel',
  'task manager': 'Task Manager',
  'activity monitor': 'Activity Monitor',
  'paint': 'Paint',
  'mspaint': 'Paint',
  'snipping tool': 'Snipping Tool',
  'snip': 'Snipping Tool',
  'screenshot': 'Snipping Tool',
  'calculator app': 'Calculator',

  // Creative ---------------------------------------------------------------
  'photoshop': 'Adobe Photoshop',
  'adobe photoshop': 'Adobe Photoshop',
  'illustrator': 'Adobe Illustrator',
  'premiere': 'Adobe Premiere Pro',
  'premiere pro': 'Adobe Premiere Pro',
  'after effects': 'Adobe After Effects',
  'figma': 'Figma',
  'gimp': 'GIMP',
  'blender': 'Blender',
  'obs': 'OBS Studio',
  'obs studio': 'OBS Studio',

  // Communication / media --------------------------------------------------
  'spotify': 'Spotify',
  'discord': 'Discord',
  'slack': 'Slack',
  'zoom': 'Zoom',
  'whatsapp': 'WhatsApp',
  'whatsapp desktop': 'WhatsApp',
  'telegram': 'Telegram',
  'notion': 'Notion',
  'vlc': 'VLC media player',
  'vlc player': 'VLC media player',
  'vlc media player': 'VLC media player',
  'itunes': 'iTunes',
  'music': 'Music',
  'app store': 'Microsoft Store',
  'store': 'Microsoft Store',
};

// Apps whose "open" belongs to the browser-automation module instead
// (it opens a real, signed-in browser window). Window control of these apps
// (minimize/focus/close…) is still Computer Control's job.
const BROWSER_MODULE_APPS = ['Google Chrome', 'Chromium', 'Microsoft Edge'];

// The OS decides which terminal is appropriate.
function platformTerminal() {
  return process.platform === 'darwin' ? 'Terminal' : 'Windows Terminal';
}

// "Settings" means different apps per OS.
function platformSettings() {
  return 'Settings'; // resolved per-OS (UWP on Windows, System Settings on macOS)
}

/**
 * Normalize a free-form phrase to a canonical app name.
 * Returns { name, fromAlias } or null when the phrase is empty/unsuitable.
 */
function normalizeAppName(raw) {
  let t = String(raw || '').trim().toLowerCase();
  if (!t) return null;

  // strip filler words around the name
  t = t
    .replace(/[?.!,]+$/g, '')
    .replace(/^(?:the|my|our|a|an)\s+/, '')
    .replace(/\s+(?:app|application|program|software|on my (?:computer|pc|laptop|mac|desktop))$/i, '')
    .trim();
  if (!t) return null;

  // platform-dependent names first
  if (t === 'terminal' || t === 'command line') return { name: platformTerminal(), fromAlias: true };
  if (t === 'system settings' || t === 'settings app') return { name: platformSettings(), fromAlias: true };
  if (t === 'finder' && process.platform !== 'darwin') return { name: 'File Explorer', fromAlias: true };

  const hit = ALIASES[t];
  if (hit) return { name: hit, fromAlias: true };

  // "open up visual studio code" etc. — try matching a multi-word alias
  // inside the phrase (longest alias wins).
  const keys = Object.keys(ALIASES).filter((k) => k.includes(' ') && t.includes(k));
  if (keys.length) {
    keys.sort((a, b) => b.length - a.length);
    return { name: ALIASES[keys[0]], fromAlias: true };
  }

  // Unknown word(s) → keep as-is; the resolver decides if it exists
  // (e.g. "Open Blender" works even though Blender isn't in this table).
  return { name: t.replace(/\b\w/g, (c) => c.toUpperCase()), fromAlias: false };
}

module.exports = { ALIASES, BROWSER_MODULE_APPS, normalizeAppName };
