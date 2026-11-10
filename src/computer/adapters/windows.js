/**
 * Windows OS adapter for Zara Computer Control.
 *
 * Native mechanisms ONLY — no Playwright, no Selenium:
 *   launch : spawn the resolved .exe directly (shell:false), or explorer.exe
 *            with a shell:AppsFolder AUMID for Store/UWP apps, or a URI
 *            (ms-settings:) via explorer.exe.
 *   window : fixed PowerShell scripts driving user32.dll (ShowWindow,
 *            SetForegroundWindow with AttachThreadInput fallback, WM_CLOSE).
 *   discover: built-in system apps + Start Menu .lnk scan + App Paths
 *            registry + PATH executables (cached; refreshable).
 *
 * Nothing here ever builds a shell command from user input: app names travel
 * as validated script PARAMETERS and spawn ARGUMENTS, never as code.
 */

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPTS = path.join(__dirname, '..', 'scripts', 'win');
const SYSTEM = process.env.SystemRoot || 'C:\\Windows';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const APP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._+&()'-]*$/;

// Built-ins that are always present (UWP Store apps launch via AUMID, the
// classic system tools via their real exe path).
function builtinEntries() {
  const list = [
    { name: 'Notepad', launch: { type: 'exe', path: path.join(SYSTEM, 'System32', 'notepad.exe') }, process: 'notepad.exe' },
    { name: 'Command Prompt', launch: { type: 'exe', path: path.join(SYSTEM, 'System32', 'cmd.exe') }, process: 'cmd.exe' },
    { name: 'PowerShell', launch: { type: 'exe', path: path.join(SYSTEM, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') }, process: 'powershell.exe' },
    { name: 'File Explorer', launch: { type: 'exe', path: path.join(SYSTEM, 'explorer.exe') }, process: 'explorer.exe' },
    { name: 'Paint', launch: { type: 'exe', path: path.join(SYSTEM, 'System32', 'mspaint.exe') }, process: 'mspaint.exe' },
    { name: 'Task Manager', launch: { type: 'exe', path: path.join(SYSTEM, 'System32', 'Taskmgr.exe') }, process: 'Taskmgr.exe' },
    { name: 'Calculator', launch: { type: 'uwp', aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' }, process: 'CalculatorApp.exe' },
    { name: 'Settings', launch: { type: 'uwp', aumid: 'windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel' }, process: 'SystemSettings.exe' },
    { name: 'Snipping Tool', launch: { type: 'uwp', aumid: 'Microsoft.ScreenSketch_8wekyb3d8bbwe!App' }, process: 'SnippingTool.exe' },
    { name: 'Microsoft Store', launch: { type: 'uwp', aumid: 'Microsoft.WindowsStore_8wekyb3d8bbwe!App' }, process: 'WinStore.App.exe' },
  ];
  const wt = which('wt.exe');
  if (wt) list.push({ name: 'Windows Terminal', launch: { type: 'exe', path: wt }, process: 'WindowsTerminal.exe' });
  return list;
}

function which(cmd) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    try {
      const p = path.join(dir, cmd);
      if (fs.existsSync(p)) return p;
    } catch { /* ignore unreadable PATH entries */ }
  }
  return null;
}

function runPs(script, args = [], timeout = 20000) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
      { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        // The script's JSON is always the last parseable line.
        const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          try { return resolve({ ok: !err, data: JSON.parse(lines[i]), err: err ? String(err.message).slice(0, 200) : null }); } catch { /* keep looking */ }
        }
        resolve({ ok: false, data: null, err: err ? String(err.message).slice(0, 200) : 'no output' });
      },
    );
  });
}

function isRunning(processName) {
  const exe = processName.endsWith('.exe') ? processName : `${processName}.exe`;
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', `IMAGENAME eq ${exe}`, '/NH'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      resolve(!err && String(stdout || '').toLowerCase().includes(exe.toLowerCase()));
    });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function entryOf(b) {
  const launchTarget = b.launch.type === 'exe' ? b.launch.path
    : b.launch.type === 'uwp' ? `shell:AppsFolder\\${b.launch.aumid}`
      : String(b.launch.uri || '');
  return {
    name: b.name,
    platform: 'windows',
    launch: b.launch,
    launch_target: launchTarget,
    source: b.source || 'builtin',
    process: b.process || (b.launch.type === 'exe' ? path.basename(b.launch.path) : null),
  };
}

function createWindowsAdapter({ dataDir }) {
  const cacheFile = path.join(dataDir || os.tmpdir(), 'computer-apps-win.json');
  let memCache = null;

  async function scanSystem() {
    const r = await runPs(path.join(SCRIPTS, 'scan-apps.ps1'), [], 40000);
    const rows = Array.isArray(r.data) ? r.data : (r.data ? [r.data] : []);
    const out = [];
    for (const row of rows) {
      if (!row || !row.name || !row.target) continue;
      if (!APP_NAME_RE.test(String(row.name))) continue;
      out.push({ name: String(row.name), launch: { type: 'exe', path: String(row.target) }, source: row.source || 'start-menu' });
    }
    return out;
  }

  function pathEntries() {
    const out = [];
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      try {
        if (!dir || !fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir).slice(0, 400)) {
          if (!f.toLowerCase().endsWith('.exe')) continue;
          const base = f.slice(0, -4);
          if (!APP_NAME_RE.test(base)) continue;
          out.push({ name: base, launch: { type: 'exe', path: path.join(dir, f) }, source: 'path' });
        }
      } catch { /* ignore unreadable dirs */ }
    }
    return out.slice(0, 3000);
  }

  async function buildIndex(refresh = false) {
    if (memCache && !refresh) return memCache;
    if (!refresh) {
      try {
        const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (raw && Date.now() - raw.scannedAt < CACHE_TTL_MS && Array.isArray(raw.entries)) {
          memCache = raw.entries.map(entryOf);
          return memCache;
        }
      } catch { /* no cache yet */ }
    }

    const byName = new Map();
    const add = (b) => {
      const key = String(b.name).toLowerCase();
      if (!byName.has(key)) byName.set(key, entryOf(b));
    };
    builtinEntries().forEach(add);
    (await scanSystem()).forEach(add);
    pathEntries().forEach(add);

    memCache = [...byName.values()];
    try {
      fs.writeFileSync(cacheFile, JSON.stringify({ scannedAt: Date.now(), entries: memCache }), 'utf8');
    } catch { /* cache is best-effort */ }
    return memCache;
  }

  async function resolve(name, index) {
    const q = String(name || '').trim().toLowerCase();
    if (!q) return null;
    const idx = index || await buildIndex();

    // "Terminal" on Windows → Windows Terminal, else classic Command Prompt.
    if (q === 'terminal') {
      const wt = idx.find((e) => e.name.toLowerCase() === 'windows terminal');
      if (wt) return wt;
      return idx.find((e) => e.name.toLowerCase() === 'command prompt') || null;
    }

    const exact = idx.find((e) => e.name.toLowerCase() === q);
    if (exact) return exact;

    const byProcess = idx.find((e) => e.process && e.process.toLowerCase().replace(/\.exe$/, '') === q.replace(/\.exe$/, ''));
    if (byProcess) return byProcess;

    if (q.length >= 3) {
      const fuzzy = idx.find((e) => e.name.toLowerCase().includes(q) || q.includes(e.name.toLowerCase()));
      if (fuzzy) return fuzzy;
    }
    return null;
  }

  return {
    platform: 'windows',

    async listApps({ refresh = false } = {}) {
      const idx = await buildIndex(refresh);
      return idx.slice().sort((a, b) => a.name.localeCompare(b.name));
    },

    async resolveApp(name) { return resolve(name); },

    async launch(entry) {
      const l = entry.launch;
      let child = null;
      if (l.type === 'exe') {
        child = spawn(l.path, [], { shell: false, detached: true, stdio: 'ignore', windowsHide: false });
      } else if (l.type === 'uwp') {
        child = spawn('explorer.exe', [`shell:AppsFolder\\${l.aumid}`], { shell: false, detached: true, stdio: 'ignore' });
      } else if (l.type === 'uri') {
        child = spawn('explorer.exe', [l.uri], { shell: false, detached: true, stdio: 'ignore' });
      } else {
        return { launched: false, error: 'unsupported launch type' };
      }
      child.unref();
      child.on('error', () => { /* observed via the running poll below */ });

      // Wait for the process to actually appear (spec: wait, then report).
      if (entry.process) {
        for (let i = 0; i < 16; i++) {
          await sleep(500);
          if (await isRunning(entry.process)) return { launched: true, waitedMs: (i + 1) * 500 };
        }
        return { launched: false, error: 'the app did not start in time' };
      }
      return { launched: true };
    },

    async isRunning(entry) {
      if (!entry.process) return null;
      return isRunning(entry.process);
    },

    async windowOp(entry, op) {
      if (!entry.process) return { found: false, error: 'no known process for this app' };
      const r = await runPs(path.join(SCRIPTS, 'window-op.ps1'), ['-ProcessName', entry.process, '-Operation', op]);
      if (!r.data) return { found: false, error: r.err || 'window operation failed' };
      return { ...r.data, op };
    },

    async listWindows(entry) {
      const r = await runPs(path.join(SCRIPTS, 'window-op.ps1'), ['-ProcessName', entry.process || 'null.exe', '-Operation', 'list']);
      return r.data || { found: false, windows: [] };
    },

    async close(entry) {
      const running = entry.process ? await isRunning(entry.process) : null;
      if (running === false) return { closed: false, wasRunning: false };

      // UWP (Store) apps host their window under ApplicationFrameHost.exe, so
      // a WM_CLOSE sent to the app's own process finds no window. Terminate the
      // specific process directly to actually close the app.
      if (entry.launch && entry.launch.type === 'uwp' && entry.process) {
        const exe = entry.process.endsWith('.exe') ? entry.process : `${entry.process}.exe`;
        await new Promise((resolve) => {
          execFile('taskkill', ['/IM', exe, '/F'], { timeout: 8000, windowsHide: true }, () => resolve());
        });
        for (let i = 0; i < 6; i++) {
          if (!(await isRunning(entry.process))) return { closed: true, wasRunning: true, via: 'terminate' };
          await sleep(500);
        }
        return { closed: false, wasRunning: true, note: 'the app did not close' };
      }

      const op = await this.windowOp(entry, 'close');
      if (!op.found) return { closed: false, wasRunning: running, error: op.error };
      // WM_CLOSE is asynchronous — poll for the process to exit.
      if (entry.process) {
        for (let i = 0; i < 12; i++) {
          await sleep(500);
          if (!(await isRunning(entry.process))) return { closed: true, wasRunning: true };
        }
        return { closed: false, wasRunning: true, note: 'the app may have asked to save your work first' };
      }
      return { closed: true, wasRunning: running };
    },

    async showDesktop() {
      const r = await runPs(path.join(SCRIPTS, 'show-desktop.ps1'));
      return { done: !!(r.data && r.data.done), error: r.err };
    },

    async captureScreen() {
      const out = path.join(os.tmpdir(), `zara-screen-${Date.now()}.png`);
      const r = await runPs(path.join(SCRIPTS, 'capture-screen.ps1'), ['-OutPath', out], 20000);
      if (r.data && r.data.done) {
        return { ok: true, path: r.data.path, bytes: r.data.bytes, width: r.data.width, height: r.data.height };
      }
      return { ok: false, error: (r.data && r.data.error) || r.err || 'screen capture failed' };
    },
  };
}

module.exports = { createWindowsAdapter };
