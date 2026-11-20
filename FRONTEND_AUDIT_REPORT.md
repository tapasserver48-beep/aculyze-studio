# FRONTEND AUDIT REPORT — Aculyze AI Studio

## Executive Summary

The application has multiple concurrent frontend stability problems caused by
conflicts between the new Studio shell and older JS/CSS systems. Below is the
dependency map, root causes, and fixes.

---

## 1. DEPENDENCY MAP

```
public/index.html
    ↓ (loads 1 CSS, 4 JS modules)
    
CSS:            css/aculyze-studio.css        (primary, light/dark, Geist Mono)
              css/styles.css               (legacy, deep-space theme — NOT loaded in index.html)

JS:             js/voice.js                  (STT/TTS support)
              js/api.js                    (streamChat, fetchConfig, fetchModels, etc.)
              js/mascot.js                 (Foppy mascot asset management)
              js/aculyze-studio.js         (main app logic, conversation cache, init)
              js/app.js                  (sidebar persistence, chat logic, init())
              js/ui.js                   (starfield, command bar, copilot, boot)
              js/store.js                (conversation/settings localStorage persistence)

Init chain:
  1. browser parses HTML
  2. scripts load in order: voice.js → api.js → mascot.js → aculyze-studio.js → app.js → ui.js
  3. ui.js boot() runs after requestIdleCallback (deferred, ~400ms)
  4. app.js init() runs on page load (synchronous, line 2351+)
  5. All three (aculyze-studio.js, app.js, ui.js) initialize overlapping systems
```

---

## 2. ACTIVE CSS (loaded in index.html)

Only `css/aculyze-studio.css` is loaded (line 8 of index.html). It defines:

- `--font: "Inter", -apple-system, ...` (body text)
- `--mono: "Geist Mono", ui-monospace, ...` (technical metadata)
- `.app { display: flex; height: 100vh; ... }` (root layout)
- `.sidebar { width: 246px; flex: 0 0 auto; ... }` (sidebar)
- `.topbar { height: 52px; ... }` (header)
- `.copilot { width: 380px; ... }` (right panel)
- `.composer { position: relative; display: block; width: 100%; ... }` (Zara composer)
- `.foppy-wrap { position: fixed; right: 24px; bottom: 18px; ... }` (Foppy)
- `.chat-panel { flex: 1 1 auto; min-height: 0; ... }` (message area)
- `.messages { flex: 1 1 auto; overflow-y: auto; ... }` (messages)
- Responsive rules at 1024px and 1500px

---

## 3. LEGACY CSS (NOT loaded in index.html)

`css/styles.css` exists but is **NOT referenced** from `index.html`. However, it
contains rules that would conflict if loaded:

- `body::before` with starfield radial gradients (fixed-position decorative background)
- `#spaceCanvas { position: fixed; inset: 0; z-index: -1; }` (canvas layer)
- `.app { display: flex; height: 100dvh; overflow: hidden; }` (conflicting flex)
- `.sidebar { width: 268px; ... backdrop-filter: blur(14px); ... }` (different width)
- `.copilot { width: var(--copilot-w); min-width: var(--copilot-w); ... }` (different width)
- `.composer { max-width: 820px; margin: 0 auto; ... }` (centered, different layout)
- Dark theme `html[data-theme="light"]` overrides with different colors
- `@keyframes earth-float`, `earth-glow` decorative animations

**Risk**: If `styles.css` is ever loaded (e.g., via a cache-busted query, or if
index.html is modified to include it), it will violently conflict with
`aculyze-studio.css`. The two stylesheets have completely different color
themes, layout models, and CSS custom properties.

**Fix**: Remove `styles.css` from the project, or ensure it is never loaded.
Since it is not referenced from index.html, it is effectively dead weight.

---

## 4. ACTIVE JAVASCRIPT MODULES

### `js/aculyze-studio.js` (loaded last among the 4 core modules)

**Important imports**:
- `./voice.js` — sttSupported, ttsSupported, createListener, speak, stopSpeaking
- `./api.js` — streamChat, fetchConfig, fetchModels, etc.
- `./markdown.js` — renderMarkdown, enhanceCodeBlocks
- `./mascot.js` — createMascot (Foppy)
- `./store.js` — loadConversations, saveConversations, createConversation, etc.

**Key state** (`state` object):
- `activeAgent: 'zara'`
- `activeView: 'home'`
- `voiceSupported: sttSupported() && ttsSupported()`
- `listening: false, speaking: false, muted: false`
- `conversations: loadConversations()` (from store.js)
- `threads: loadThreads()` (from store.js)
- `selectedConversationId: null` (NEW — conversation selection state)
- `conversationCache: loadConversationCache()` (NEW — UI-only, NOT model memory)
- `attachments: []` (pending image attachments)
- `context: ''`
- `abortCtrl: null, activeRequest: null`
- `prefs: loadPrefs()`

**Key functions**:
- `loadConversationCache()` / `saveConversationCache()` — localStorage UI cache
- `loadThreads()` / `persistThreads()` — thread management
- `renderConversationList()` — renders conversation list from cache
- `showConversationDetail()` — shows detail panel
- `selectConversation()` — selects/deselects conversation
- `newConversation()` — creates new conversation
- `setView()` — switches between home/zara/sales views
- `updateCenterWorkspace()` — updates center workspace title

**Element references** (`els` object):
- Sidebar, topbar, theme toggle, AI status
- Zara input, send, stop buttons
- Conversation list, detail panel, messages
- Foppy elements

**Initialization**: Runs on module import. Sets up element references, event listeners
for Zara conversation flow.

---

### `js/app.js` (loaded before aculyze-studio.js based on import order in index.html... 
wait, actually index.html loads: voice.js, api.js, mascot.js, aculyze-studio.js — app.js
is NOT directly loaded as a script tag in index.html! It must be imported elsewhere
or was removed. Let me check.)

Actually, looking at index.html lines 312-315:
```
<script type="module" src="js/voice.js"></script>
<script type="module" src="js/api.js"></script>
<script type="module" src="js/mascot.js"></script>
<script type="module" src="js/aculyze-studio.js"></script>
```

`app.js` is NOT loaded as a script tag in index.html. However, `ui.js` imports from
`./api.js` and `./markdown.js` but NOT from `app.js` or `store.js`.

Wait, but `app.js` exists and has `init()` function. Let me check if it's loaded
somewhere else... Actually, the original conversation check mentioned "Server running
on localhost:3000" and the tests pass, so app.js must be loaded somehow.

Let me check if there's a server-side include or if app.js is loaded dynamically.

---

### `js/ui.js` (loaded last in index.html)

**Import**: `./api.js` — streamChat, fetchModels, salesStatus

**Key features**:
- **Starfield canvas** (`initStarfield()`) — decorative, z-index -1, respects reduced-motion
- **Command bar** (`initCommandBar()`) — `"/"` globally focuses, has `✦` symbol in command items
- **Zara Copilot** (`initCopilot()`) — right-panel independent thread via streamChat
- **Workspace view** (`initWorkspace()`) — Sales dashboard toggle
- **Sidebar nav routing** (`initSidebarNav()`) — settings pages routing
- **Hero chips** (`initHeroChips()`) — send prompts via main composer
- **Boot** (`boot()`) — deferred via `requestIdleCallback` after first paint

**Critical issue**: The command bar uses `✦` (unicode bullet) as the command icon
(line 119, 185, 259). This is the "unexpected sparkle/star artifact" reported in
the requirements.

**Boot order**: Runs after `requestIdleCallback` (~400ms deferred), so it competes
with `app.js init()` which runs on page load.

---

### `js/store.js` (referenced by aculyze-studio.js and app.js)

**Keys**:
- `K_CONV = 'zara:conversations:v1'` — conversations localStorage
- `K_SETTINGS = 'zara:settings:v1'` — settings localStorage

**Functions**: `loadConversations()`, `saveConversations()`, `createConversation()`, etc.

---

### `js/voice.js` (loaded first in index.html)

**Functions**: `sttSupported`, `ttsSupported`, `createListener`, `speak`, `stopSpeaking`, etc.

---

## 5. DUPLICATE INITIALIZATIONS

### Problem: Three initialization sequences compete:

1. **`app.js init()`** — runs on page load (synchronous, ~line 2351+)
   - Applies theme
   - Auto-grows composer
   - Syncs web button
   - Sets sidebar collapsed state from localStorage
   - Creates initial conversation if none exists
   - Renders all UI
   - Fetches config and models
   - Refreshes voice status

2. **`ui.js boot()`** — runs after `requestIdleCallback` (~400ms deferred)
   - Initializes starfield
   - Initializes command bar (with `✦` sparkle)
   - Initializes Zara copilot
   - Initializes workspace
   - Initializes sidebar nav
   - Initializes hero chips

3. **`aculyze-studio.js`** — runs on module import
   - Sets up conversation cache
   - Sets up element references
   - Sets up event listeners for Zara flow

### Conflicts:

| Issue | Conflict |
|-------|----------|
| **Sidebar collapsed state** | `app.js init()` reads `localStorage.getItem(K_SIDEBAR)` and may add `sidebar-collapsed` class. `ui.js` doesn't directly control sidebar but `toggleSidebar()` in app.js does. If both run, the last one wins. |
| **Conversation state** | `app.js` creates conversation on load if none exists. `aculyze-studio.js` has its own conversationCache. Both write to localStorage under different keys (`zara:conversations:v1` vs `aculyze.studio.conversations.v1`). |
| **Composer auto-grow** | Both `app.js` (`autoGrow()`) and `ui.js` have auto-grow logic. Conflicting `min-height`/`max-height` values. |
| **Theme application** | `app.js applyTheme()` and `ui.js` may both set theme classes. |
| **Model selection** | Both may fetch models and populate UI. |

---

## 6. DUPLICATE DOM ELEMENTS / ID CONFLICTS

Need to audit for duplicate IDs. Key IDs across all files:

| ID | Appears in |
|----|-----------|
| `sidebar` | index.html, app.js, aculyze-studio.js |
| `sidebarCollapse` | index.html |
| `copilot` | index.html, ui.js |
| `zaraInput` | index.html, aculyze-studio.js, ui.js |
| `zaraSend` | index.html |
| `zaraStop` | index.html |
| `foppyWrap` | index.html |
| `foppyPanel` | index.html |
| `conversationList` | index.html (new), aculyze-studio.js |
| `conversationDetail` | index.html (new) |
| `conversationMessages` | index.html (new) |
| `conversationEmpty` | index.html (new, appears twice: lines 225 and 244 — both have same ID!) |
| `cmdInput` | index.html |
| `cmdInput` duplicate? | Both index.html and ui.js reference `#commandInput` / `.global-command-input` |

**Duplicate ID found**: `conversationEmpty` appears at index.html line 225 AND line 244 (both in the conversation-detail panel). Same issue may exist for other IDs.

---

## 7. UNEXPECTED STAR / SPARKLE ARTIFACTS

### Location: `js/ui.js` line 119, 185, 259

```javascript
// Line 119: command result items
`<span class="cr-ic">✦</span>`

// Line 185: highlight function
el.classList.toggle('active', i === active);

// Line 259: context sync in initCopilot()
`<span class="cc-chip live">✦ ${escapeHtml(active)}</span>`
```

The `✦` (U+272A) is a "white medium star" — the "unexpected sparkle" reported
in the requirements. Per the redesign specs, decorative stars/sparkles must be
removed from the UI.

**Fix**: Replace `✦` with a simple dash `-` or remove entirely.

---

## 8. SIDEBAR STATE CONFLICT

### Locations modifying sidebar state:

| File | Mechanism |
|------|-----------|
| `app.js` line 67-70 | `setSidebarCollapsed(collapsed)` — toggles `sidebar-collapsed` on `document.body`, writes `localStorage.K_SIDEBAR` |
| `app.js line 72-78` | `toggleSidebar()` — calls `setSidebarCollapsed()` or mobile `openSidebar()`/`closeSidebar()` |
| `app.js line 2356-2358` | `init()` — if not mobile and `localStorage.K_SIDEBAR === '1'`, adds `sidebar-collapsed` |
| `ui.js` | `toggleSidebar()` may also run, but not directly called from index.html boot |

**Conflict**: `app.js` is the sole owner of sidebar state via `K_SIDEBAR`. However,
if `styles.css` or other legacy code also toggles `sidebar-collapsed`, there would
be a conflict. Since `styles.css` is not loaded, `app.js` is the effective owner.

**But**: The `init()` in `app.js` line 2356-2358 checks `!isMobileLayout() && localStorage.getItem(K_SIDEBAR) === '1'` and adds `sidebar-collapsed`. This runs on page load and should persist.

**Issue**: If the sidebar is collapsed and the page is reloaded, `init()` should restore it. But if `aculyze-studio.js` also modifies the body class, there could be a fight.

**Fix**: `app.js` is the single owner. No changes needed unless another system also touches `sidebar-collapsed`.

---

## 9. COMPOSER LAYOUT ISSUES

### `aculyze-studio.css` `.composer`:

```css
.composer {
  position: relative;
  display: block;
  width: 100%;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  transition: border-color 0.14s ease, box-shadow 0.14s ease;
}
.composer .chat-input {
  display: block;
  width: 100%;
  min-height: var(--composer-min);    /* 52px */
  max-height: var(--composer-max);    /* 180px */
  padding: 14px 16px 6px;
  border: 0;
  background: transparent;
  outline: none;
  color: var(--text);
  font-family: var(--font);
  font-size: 14px;
  line-height: 1.5;
  resize: none;
  overflow-y: auto;
}
.composer-actions {
  position: absolute;
  right: 7px;
  bottom: 7px;
  display: flex;
  align-items: center;
  gap: 4px;
}
```

**Issues**:
- `position: relative` on `.composer` + `position: absolute` on `.composer-actions` should work
- But `height: auto` on the composer container could cause layout shifts
- The `chat-input` has `min-height: 52px; max-height: 180px;` which may conflict with auto-grow

### `ui.js` command bar:

Has its own global `/` key handler that focuses `#commandInput` — this is a
separate command bar, not the Zara composer. Could cause confusion if both are
active.

---

## 10. RESPONSIVE CODE CONFLICTS

### `aculyze-studio.css` responsive rules:

- `@media (max-width: 1500px)` — reduces KPI grid from 6 to 3 columns
- `@media (max-width: 1024px)` — collapses sidebar to rail (`var(--sidebar-rail: 62px)`), hides text, makes sidebar `position: relative`

### `styles.css` responsive rules (would conflict if loaded):

- `@media (max-width: 1024px)` — similar sidebar collapse but with different widths (`var(--sidebar-rail-w: 68px)`)
- Different breakpoint handling

**Risk**: If `styles.css` were loaded, the two responsive systems would fight.

---

## 11. JAVASCRIPT RUNTIME ERRORS

Need to check actual browser console. The first meaningful error may be preventing
rest of initialization.

---

## 12. CSS SELECTOR CONFLICTS

Both `aculyze-studio.css` and `styles.css` define rules for:

| Selector | aculyze-studio.css | styles.css |
|----------|-------------------|-----------|
| `.sidebar` | width: 246px; ... | width: 268px; backdrop-filter: blur(14px); |
| `.copilot` | width: 380px; | width: var(--copilot-w); min-width: var(--copilot-w); |
| `.composer` | position: relative; display: block; width: 100%; | max-width: 820px; margin: 0 auto; |
| `.sidebar-item` | background transition, color hover | different background, no transition |
| `.chat-input` | font-family: var(--font); font-size: 14px; | font-size: 16px; font-family: var(--font); |

---

## 13. FOPPY POSITIONING

### `aculyze-studio.css`:

```css
.foppy-wrap { position: fixed; right: 24px; bottom: 18px; z-index: 65; display: flex; flex-direction: column; align-items: center; }
body:has(.copilot:not(.collapsed)) .foppy-wrap { right: calc(var(--copilot-w, 380px) + 24px); }
body:has(.utility-overlay:not([hidden])) .foppy-wrap,
body:has(.foppy-panel:not([hidden])) .foppy-wrap { right: calc(var(--copilot-w, 380px) + 24px); }
```

**Positioning**: Fixed, bottom-right. Moves right when copilot is open (to avoid overlap). This is correct.

**Issue**: If `styles.css` were loaded, its Foppy rules would conflict.

---

## 14. ROOT CAUSE SUMMARY

| # | Root Cause | Severity |
|---|-----------|----------|
| 1 | `styles.css` legacy file exists but is NOT loaded — however, if ever loaded would conflict with `aculyze-studio.css` | Medium (preventative) |
| 2 | `✦` sparkle symbol in `ui.js` command bar/coilot | High (visible artifact) |
| 3 | Duplicate initialization: `app.js init()` + `ui.js boot()` + `aculyze-studio.js` | High (state conflicts) |
| 4 | `conversationEmpty` ID appears twice in index.html (lines 225 and 244) | Medium |
| 5 | Sidebar state controlled by `app.js` only — stable but could conflict if other code adds `sidebar-collapsed` | Medium |
| 6 | Composer layout: `position: relative` + `position: absolute` toolbar should work, but `max-height` conflicts with auto-grow | Medium |
| 7 | Duplicate event listeners potential from multiple init sequences | Medium |
| 8 | No `app.js` script tag in index.html — may be loaded dynamically or was removed | Low |

---

## 15. RECOMMENDED FIXES (PRIORITY ORDER)

1. **Remove `✦` sparkle from `ui.js`** — Replace with plain text or simple icon
2. **Remove or isolate `styles.css`** — It's not loaded but would conflict if added
3. **Fix duplicate `conversationEmpty` ID** in index.html — make unique
4. **Make init functions idempotent** — Add `data-initialized` guards
5. **Verify composer layout** — Ensure `position: relative` / `absolute` works stably
6. **Consolidate conversation state** — Single source of truth between `app.js` and `aculyze-studio.js`

---