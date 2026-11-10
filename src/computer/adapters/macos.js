/**
 * macOS OS adapter for Zara Computer Control.
 *
 * Native mechanisms ONLY — no Playwright, no Selenium:
 *   launch : `open -a "<App>"` (NSWorkspace under the hood) — the standard,
 *            safe Launch Services mechanism.
 *   focus  : AppleScript `tell app to activate` (NSWorkspace activate).
 *   quit   : AppleScript `tell app to quit` — graceful, lets the app save.
 *   window : fixed osascript templates via System Events (AXMiniaturized /
 *            AXZoom). These require the Accessibility permission — which we
 *            DETECT and explain, never bypass.
 *   discover: /Applications, /Applications/Utilities, ~/Applications .app
 *            scan (cached; refreshable).
 *
 * NOTE: written to spec but only executable on a real Mac — the automated
 * test file skips itself on other platforms.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Always-available Apple apps (Launch Services knows them regardless of folder).
const BUILTIN = [
  { name: 'Finder' },
  { name: 'Safari' },
  { name: 'Terminal' },
  { name: 'System Settings' },
  { name: 'Calculator' },
  { name: 'Activity Monitor' },
  { name: 'Notes' },
  { name: 'Mail' },
  { name: 'Messages' },
  { name: 'Music' },
  { name: 'App Store' },
];

function asApplescript(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function run(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const errText = `${stderr || ''}${err ? ` ${err.message}` : ''}`;
      const permission = /not authorized to send apple events|not allowed assistive access|assistive access|-1743|-25211/i.test(errText);
      resolve({ ok: !err, stdout: String(stdout || '').trim(), stderr: errText.trim().slice(0, 300), permission });
    });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function createMacosAdapter({ dataDir }) {
  const cacheFile = path.join(dataDir || os.tmpdir(), 'computer-apps-mac.json');
  let memCache = null;

  async function scan() {
    const dirs = ['/Applications', '/Applications/Utilities', path.join(os.homedir(), 'Applications')];
    const out = [];
    for (const dir of dirs) {
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f.endsWith('.app')) out.push({ name: f.slice(0, -4), source: 'applications' });
        }
      } catch { /* dir may not exist */ }
    }
    return out;
  }

  async function buildIndex(refresh = false) {
    if (memCache && !refresh) return memCache;
    if (!refresh) {
      try {
        const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (raw && Date.now() - raw.scannedAt < CACHE_TTL_MS && Array.isArray(raw.entries)) {
          memCache = raw.entries;
          return memCache;
        }
      } catch { /* no cache yet */ }
    }
    const byName = new Map();
    for (const b of BUILTIN) byName.set(b.name.toLowerCase(), { name: b.name, source: 'builtin' });
    for (const e of await scan()) if (!byName.has(e.name.toLowerCase())) byName.set(e.name.toLowerCase(), e);
    memCache = [...byName.values()];
    try { fs.writeFileSync(cacheFile, JSON.stringify({ scannedAt: Date.now(), entries: memCache }), 'utf8'); } catch { /* best-effort */ }
    return memCache;
  }

  function entryOf(b) {
    return {
      name: b.name,
      platform: 'macos',
      launch: { type: 'open-a', name: b.name },
      launch_target: `open -a "${b.name}"`,
      source: b.source || 'builtin',
      process: b.name, // System Events process name ≈ app name
    };
  }

  return {
    platform: 'macos',

    async listApps({ refresh = false } = {}) {
      return (await buildIndex(refresh)).slice().sort((a, b) => a.name.localeCompare(b.name)).map(entryOf);
    },

    async resolveApp(name) {
      const q = String(name || '').trim().toLowerCase();
      if (!q) return null;
      const idx = await buildIndex();
      const exact = idx.find((e) => e.name.toLowerCase() === q);
      if (exact) return entryOf(exact);
      if (q.length >= 3) {
        const fuzzy = idx.find((e) => e.name.toLowerCase().includes(q) || q.includes(e.name.toLowerCase()));
        if (fuzzy) return entryOf(fuzzy);
      }
      return null;
    },

    async launch(entry) {
      const r = await run('open', ['-a', entry.name]);
      if (!r.ok) return { launched: false, error: 'the app could not be started' };
      // `open` returning 0 means Launch Services launched it; give it a beat.
      await sleep(800);
      return { launched: true };
    },

    async isRunning() { return null; }, // no cheap portable check; `open` exit code is the signal

    async windowOp(entry, op) {
      const app = asApplescript(entry.name);
      const scripts = {
        minimize: `tell application "System Events" to tell process "${app}" to set miniaturized of window 1 to true`,
        restore: `tell application "System Events" to tell process "${app}" to set miniaturized of window 1 to false`,
        maximize: `tell application "System Events" to tell process "${app}" to perform action "AXZoom" of window 1`,
        focus: `tell application "${app}" to activate`,
        close: `tell application "${app}" to quit`,
        list: `tell application "System Events" to tell process "${app}" to get {name of windows, miniaturized of windows}`,
      };
      const r = await run('osascript', ['-e', scripts[op] || scripts.list]);
      if (!r.ok) {
        if (r.permission) {
          return {
            found: false,
            op,
            code: 'permission',
            error: 'Zara needs Accessibility permission to control application windows. '
              + 'Open System Settings → Privacy & Security → Accessibility and allow Zara.',
          };
        }
        return { found: false, op, error: r.stderr || 'window operation failed' };
      }
      return { found: true, op, output: r.stdout };
    },

    async listWindows(entry) {
      return this.windowOp(entry, 'list');
    },

    async close(entry) {
      const r = await this.windowOp(entry, 'close');
      return { closed: !!(r.found || r.output), wasRunning: true, error: r.error };
    },

    async showDesktop() {
      // ⌘F3 (Show Desktop) — the native chord for this single whitelisted op.
      const r = await run('osascript', ['-e', 'tell application "System Events" to key code 119 using command down']);
      return { done: r.ok, error: r.ok ? null : (r.stderr || 'could not show the desktop') };
    },

    async captureScreen() {
      const out = path.join(os.tmpdir(), `zara-screen-${Date.now()}.png`);
      // `screencapture -x` is the native macOS screenshot tool (silent, no sound).
      const r = await run('screencapture', ['-x', out], 20000);
      if (r.ok) {
        try {
          const st = fs.statSync(out);
          return { ok: true, path: out, bytes: st.size };
        } catch { return { ok: false, error: 'screenshot file was not written' }; }
      }
      return { ok: false, error: r.stderr || 'screen capture failed (screen recording permission may be needed)' };
    },
  };
}

module.exports = { createMacosAdapter };
