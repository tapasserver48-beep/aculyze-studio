# Zara Computer Control (Zara Desktop Agent — Phase 1)

Control the user's computer from Zara Chat using **only** explicitly
implemented, whitelisted operations. No Playwright, no Selenium, no arbitrary
shell/PowerShell/AppleScript — ever.

```
ZARA CHAT UI (thinking steps, honest ⚠ failures)
    ↓  fetch /api/computer/*  (Bearer token, per-install secret)
ZARA COMPUTER ROUTER  (src/computer/computerRouter.js — deterministic NL,
    ↓                   zero model calls, unit-tested)
PERMISSION GATE       (src/computer/permissions.js — Level 1/2/3)
    ↓
DESKTOP AGENT SURFACE (src/computer/routes.js — re-plans the message
    ↓                   server-side; whitelist enforced again)
OS ADAPTER
    ├── Windows (adapters/windows.js): spawn resolved .exe (shell:false),
    │     UWP via explorer.exe shell:AppsFolder, fixed user32.dll scripts
    │     for window ops, Start Menu + App Paths + PATH discovery
    └── macOS  (adapters/macos.js): `open -a` (NSWorkspace), fixed
          osascript templates, /Applications scan, Accessibility permission
          detected and explained — never bypassed
    ↓
USER'S COMPUTER
```

## Implemented operations (Level 1 — no confirmation needed)

| Tool | Windows mechanism | macOS mechanism |
|---|---|---|
| `app.open` | spawn resolved exe / UWP AUMID; waits for the process | `open -a "<App>"` |
| `app.close` | graceful `WM_CLOSE` to the app's windows (never taskkill) | `tell app to quit` |
| `app.focus` | `SetForegroundWindow` + `AttachThreadInput` + ALT fallback | `tell app to activate` |
| `app.list` | cached Start Menu + App Paths + PATH index | cached /Applications scan |
| `window.minimize` | `ShowWindow(SW_MINIMIZE)` | AXMiniaturized = true |
| `window.maximize` | `ShowWindow(SW_MAXIMIZE)` | AXZoom action |
| `window.restore` | `ShowWindow(SW_RESTORE)` | AXMiniaturized = false |
| `desktop.show` | Win+D via `keybd_event` | ⌘F3 via osascript |

**Level 2/3 (install, uninstall, delete, settings changes, scripts, terminal
commands, startup items, passwords, purchases, disabling security) are
detected by the router and answered honestly — they are NOT implemented and
nothing runs.** There is no `shell.execute` tool to bypass.

## Security model

1. **Token auth** — every `/api/computer` call needs the per-install Bearer
   token (`data/computer-agent.json`, generated on first use, 0600). Only
   `/session` is unauthenticated, and it is same-Origin-guarded so only this
   app's own web UI can read the token. Other websites (CSRF) and casual local
   scripts get `401`.
2. **No client-supplied tool calls** — the client sends the raw chat message
   only; the server re-plans it deterministically and executes only whitelisted
   operations (checked twice: router output + route whitelist).
3. **App names are data, never code** — they travel as validated spawn
   arguments and `[ValidatePattern]` script parameters. The PowerShell/AppleScript
   files are fixed templates.
4. **App discovery is real** — Start Menu shortcuts, App Paths registry, PATH
   (Windows) and /Applications (macOS); no single hard-coded install path.
5. **"Open Chrome/Edge/Chromium" belongs to browser automation** (it opens a
   real signed-in browser window); Computer Control handles every other app
   plus window control of browsers.

## Chat integration

- Runs **after** the browser router, **before** connected apps and web search
  (and skips them for that message), mirroring the browser feature.
- Live steps: `● Opening Visual Studio Code…` → `✓ Visual Studio Code opened.`
  or honest `⚠ Zara couldn't find Visual Studio Code on this computer.`
- App questions ("Do I have VS Code?", "What apps are installed?", "Which
  browser do I have?") are answered **deterministically in the frontend** —
  the model is never involved, so the answer can't be hallucinated and works
  fully offline.
- The full installed-app list never leaves the machine (no cloud lookup).

## Logging

`data/logs/computer-control.log`, one line per operation:

```
2026-10-27T… [ZARA COMPUTER] Command received: app.open | Application: Notepad | Platform: windows | Result: success
```

Never logs tokens, passwords, credentials or file contents. Set
`ZARA_COMPUTER_LOG=0` in `.env` to disable; delete the file to clear.

## Tests

```
node test-computer-router.js   # 37 deterministic router tests (any OS)
node test-computer.js          # 31 live Windows tests + HTTP auth stack
node test-computer-macos.js    # live macOS tests (skips itself off-Mac)
```

Live suites only touch apps they open themselves (Notepad/Calculator on
Windows, Terminal on macOS) and always close them again; missing apps are
skipped, not failed.

## Phase 2 — standalone agent + installers (plan, not yet implemented)

The Phase-1 surface **is** the agent API; extracting it is mechanical:

1. **`zara-desktop-agent` package** — same `src/computer` core plus a tiny
   loopback HTTP host with the token auth above. Packaged with a bundled
   runtime (electron-builder / pkg) so end users install **one thing** — no
   Python, Node.js, npm, pip, Playwright or developer tools required.
2. **Windows**: `Zara-Desktop-Agent-Setup.exe` (per-user install, no admin
   for core ops; window control needs no elevation), optional auto-start.
3. **macOS**: signed `Zara-Desktop-Agent.dmg` / app bundle; first run shows
   "Zara needs Accessibility permission to control application windows" with
   a button that opens System Settings → Privacy & Security → Accessibility.
   We never attempt to bypass macOS security.
4. **Device pairing** — the agent shows a 6-digit code + device name
   ("My Windows PC"); Zara Chat registers it and stores a per-device token in
   the encrypted per-user store; devices are revocable from Zara later. The
   Phase-1 token schema matches this already.
5. **Offline** — launching/controlling local apps needs no internet at all;
   the agent keeps working when cloud services are down.

## Known limitations (v1)

- Window ops on Windows match top-level visible windows by process name; apps
  with multiple processes report the first window.
- `focus` can be refused by Windows' foreground-lock rules while you are
  actively typing — Zara reports honestly instead of pretending.
- "Close" is polite (`WM_CLOSE` / `quit`): apps with unsaved work may show
  their own save prompt — that's the OS protecting you.
- Compound messages mixing a browser command and a computer command in one
  sentence are resolved in favor of the browser module; send them separately.
- The macOS adapter is written to spec but only testable on a real Mac.
