/**
 * Cross-platform app resolver for Zara Computer Control.
 *
 * Normalizes the app phrase via aliases, then asks the platform adapter to
 * find it through real discovery (Start Menu / registry / PATH on Windows,
 * /Applications on macOS) — never a single hard-coded path.
 *
 * Returns entries shaped like:
 *   { name, platform, launch_target, source }
 * where source is "builtin" | "start-menu" | "app-paths" | "path" |
 * "applications".
 */

const { normalizeAppName } = require('./aliases');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

function createResolver({ dataDir }) {
  const adapter = isMac
    ? require('./adapters/macos').createMacosAdapter({ dataDir })
    : isWin
      ? require('./adapters/windows').createWindowsAdapter({ dataDir })
      : null;

  const platform = isMac ? 'macos' : isWin ? 'windows' : 'unsupported';

  return {
    platform,
    supported: !!adapter,

    /** Resolve a (possibly aliased) app phrase to an installed app, or null. */
    async resolveApp(phrase) {
      if (!adapter) return null;
      const norm = normalizeAppName(phrase);
      const name = norm ? norm.name : phrase;
      const entry = adapter ? await adapter.resolveApp(name) : null;
      return entry;
    },

    async listApps(opts) {
      if (!adapter) return [];
      return adapter.listApps(opts);
    },

    /** Adapter passthroughs used by /execute. */
    async launch(entry) { return adapter.launch(entry); },
    async close(entry) { return adapter.close(entry); },
    async windowOp(entry, op) { return adapter.windowOp(entry, op); },
    async listWindows(entry) { return adapter.listWindows(entry); },
    async isRunning(entry) { return adapter.isRunning(entry); },
    async showDesktop() { return adapter.showDesktop(); },
    async captureScreen() { return adapter.captureScreen(); },

    /** Installed browsers, for "Which browser do I have?" */
    async installedBrowsers() {
      const wanted = isMac
        ? ['Safari', 'Google Chrome', 'Firefox', 'Brave Browser', 'Opera']
        : ['Google Chrome', 'Microsoft Edge', 'Mozilla Firefox', 'Brave Browser', 'Opera'];
      const out = [];
      for (const b of wanted) {
        const e = await this.resolveApp(b);
        if (e) out.push(e.name);
      }
      return out;
    },
  };
}

module.exports = { createResolver };
