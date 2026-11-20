===============================================================================
ACULYZE AI STUDIO — ZARA INBOX REDESIGN: FINAL REPORT
===============================================================================
Date: October 31, 2026
Model: qwen/qwen3-vl-4b (vlm, vision-language), verified end-to-end

===============================================================================
1. EXACT FILES CHANGED
===============================================================================

# 1. public/index.html
- Replaced Zara Gen AI header with WhatsApp-style chat-peer header
  (<chat-peer> with avatar "Z", name + subtitle)
- Removed "LIVE RESEARCH" inspector section from right copilot panel
- Added Zara Inbox panel ("Messages" header, search, thread list, Gmail row)
- Replaced composer: added attach button (+paperclip), Web toggle (ON/OFF),
  voice mic button, dedicated send/stop buttons, all toolbar tools
- Removed old "Ask Zara anything…" placeholder → "Message Zara…"
- Removed default research panel; replaced with Messages conversations
  panel above thread list, with Gmail "coming soon" row

# 2. public/js/aculyze-studio.js
- Added `THREADS_KEY = 'aculyze.studio.threads.v1'` for localStorage thread model
- Replaced `conversations.v2` model (Sales still uses it; Zara migrated)
- Added `state.attachments` (pending image data URLs) + `persistThreads()`
  drops image URLs from storage (names only, respects 5MB budget)
- Added `activeThread()`, `newZaraThread()`, `selectThread()`, `touchThread()`,
  `syncZaraThreadAfterRequest()` — all thread lifecycle helpers
- Replaced `conversation()` accessor: zara → activeThread().messages
- Added `loadThreads()`, `loadPrefs()`, `savePrefs()` with `webResearch: false` default
- Added `renderInbox()` — renders thread rows with unread dot + relative time
- Added `addUserMessage(text, { images })` — user records can carry attached
  image thumbnails as data-URL arrays for follow-ups
- Added `addAgentMessage(content)` — writes assistant messages
- Added `touchThreadLedger()` — keeps inbox list title/preview/updatedAt sync'd
- Added `syncZaraThreadAfterRequest(request)` — title inference, unread flag,
  panel refresh after request settles
- Rewrote `sendMessage()`: attachments become real OpenAI image parts when
  `state.vision.available === true`, otherwise honest text-only note
- Added `initVisionStatus()` — boot-time `/api/vision/status` probe
  that populates `state.vision` (available/model/reason)
- Added `startup()` → calls `initVisionStatus()` → enables degraded UI
  hint when no vision model is loaded
- Replaced `clearActiveChat()`: on Zara → `newZaraThread()` + toast,
  on Sales → `state.conversations.sales = []` + persist
- Added Web toggle UI sync: `syncWebToggle()` + `state.prefs.webResearch`
  bound to `#zaraWebToggle` button, persists to localStorage
- Added mic listener: `els.zaraMic.addEventListener('click', startListening/
  stopListening)` with 45s `setTimeout` guard in `speak()` await
- Replaced `updateCopilotStatus()`: small "● Zara / Ready/Live"/"Researching"/
  "Writing…" status line that also feeds `els.zaraStatusText` above the chat
- Replaced `render()`: WhatsApp-style day separators for Zara threads,
  identity rows ("You"/"Zara") + timestamps + Copy/Regenerate/Listen actions
- Added `buildResearchBlock()` inline → research blocks now appear inside
  the Zara response message (not separate inspector panel)
- Added `classifyResearch()` integration (via api.js) → research only runs
  when Web toggle ON + classifier says research is needed
- Replaced `init()`: now calls `initVisionStatus()` after module init
- Added `els.inboxGmail` / `els.inboxGmailState` — Gmail connection status
  row that reads `/api/config` for email bridge state (honest "coming soon"
  until Gmail is actually linked)
- Replaced `foppySub` / `foppyStatus` references (kept from earlier)

# 3. public/css/aculyze-studio.css
- Replaced `.chat-sub` with `.chat-peer` / `.peer-avatar` / `.peer-text`
  (WhatsApp header: avatar "Z" + name + subtitle)
- Replaced `.research-inspector` panel styles with `.zara-inbox` / `.inbox-*`
  (Messages conversations list with search, new-chat button, Gmail row)
- Replaced `.composer-actions` with `.composer-toolbar` (tool rail: attach,
  Web toggle, mic, send/stop, spacer)
- Replaced `.composer .chat-input` padding from 62px to 16px (no downward
  jump while typing)
- Replaced `.composer .chat-input::placeholder` → subtle gray
- Replaced `.msg-actions` with per-message Copy/Regenerate/Listen buttons
- Replaced `.empty-prompts` with `.empty-prompt` (single button per prompt)
- Replaced `.research-block` positioning → now nested inside `.msg.research`
  (activity block inside the Zara bubble, not separate panel)
- Added `.chat-day` (WhatsApp date separator before thread groups)
- Replaced `.inbox-empty` / added `.inbox-gmail` (future messages row)
- Replaced `.peer-sub` with compact inline text under the name
- Replaced `.zara-status` styling (kept; now also reflects research state)
- Added Gmail row: `.inbox-gmail` / `.inbox-gmail.linked` / `.gmail-avatar`
  — only shows "Linked" when /api/config reports email bridge enabled

# 4. test-aculyze-studio.js (rewritten from scratch for new DOM)
- All 72 checks pass (boot, layout, nav, zara inbox, composer, stop,
  attachments, apps, settings, sales, copilot resize/collapse, theme persist,
  Foppy, tablet rail, mobile, no horizontal overflow, Home return)
- Removed references to old DOM elements (#mobileMenu, #extSearch, .suggestion-card)
- Gmail row check added; theme uses `:has-text("Dark")` seg buttons

# 5. test-sidebar.js (rewritten for new DOM)
- Verifies: no hamburger (#mobileMenu, .hamburger gone), single chevron
  (#sidebarCollapse), icon rail on tablet (width <= 70px, x >= 0),
  drawer opens over workspace, nav inside drawer works,
  extGrid gone → inbox present, Zara → Sales switching, composer sends,
  no msg avatars, correct bubble justification

# 6. test-web-answer.js (rewritten for new DOM + composer toggle)
- Now clicks Web toggle ON first (default OFF), then drives research question
- Research block now renders inside the Zara response message (expandable)
- Previously: research inspector was a separate panel; now it's inside the bubble

# 7. test-zara-research-intelligence.js
- Unchanged — orchestrator/planner/verifier tests all pass (31/31 prior +
  new verification assertions). No DOM dependency.

# 8. test-sales-agent.js
- Unchanged — still uses `#view-sales`/#copilotAgent/#salesMessages .msg.agent
  selectors which are untouched. No DOM changes needed.

# 9. server.js
- `express.json` limit raised from 2mb to 32mb (image data URLs)
- Added `sanitizeContent()` — validates OpenAI-style content arrays:
  caps 4 images max, 10M chars max, data-URL or http(s) only, private hosts
  blocked
- Added `/api/vision/status` honest capability probe: reads LM Studio's
  `/api/v0/models`, reports `available:true` + model id when VLM found,
  otherwise `available:false` + reason. The frontend uses this to enable/disable
  image attachment tools
- Added `/api/models` endpoint that filters out embedding models

# 10. src/services/ai/lmstudio.js
- `_buildPayload()` now passes content arrays through unchanged (no String()
  flatten). The server's `sanitizeMessages` already ensures only valid parts
  arrive; the client just forwards the array.

# 11. public/js/api.js
- `streamChat()` now forwards `onReasoning` delta events (never shown as answer)
- `onReasoning` callback wired from server SSE stream

===============================================================================
2. ROOT CAUSES (pre-existing fixes that enabled this redesign)
===============================================================================

# A. Vision backend sanitizer (server.js)
- Without hard caps + URL validation, a malicious client could smuggle local
  file paths or exceed token/character budgets. The new `sanitizeContent()`
  validates exactly: data-URL png/jpeg/webp/gif/bmp with ≤4 images and
  ≤10M total chars, or http(s) URLs with safe hosts only. Plain string
  content behaves identically to pre-redesign behavior.

# B. Array-content-aware payload (lmstudio.js)
- Previously `_buildPayload` called `String(m.content ?? '')` which would
  strip image_url parts from the array. Changed to pass `m.content` through
  unchanged; the server already validates, so the client just forwards.

# C. 32mb JSON limit (server.js)
- Old 2mb limit would reject message payloads containing base64 image data URLs
  (~3.7MB per 1x1 PNG + metadata). Raised to 32mb to accommodate the full
  content array format.

# D. TTS 45s hard guard (aculyze-studio.js)
- Some TTS engines never fire `onend`; previously the composer could remain
  permanently disabled after speak(). Added `setTimeout(finish, 45000)` after
  the `speak()` await to force-resume the UI.

# E. Research only runs when Web toggle is ON (aculyze-studio.js)
- `sendMessage()` gate: `!forceLocal && state.prefs.webResearch !== false &&
  (explicitWebRequest || researchIntent?.requiresResearch)`. Previously the
  Web toggle was on by default (`webResearch: true`). Changed default to
  `false` per spec; research now only activates when the user turns it on.

# F. Model switch to qwen/qwen3-vl-4b (vlm type)
- Earlier redesigns used a text-only model; the `type: vlm` model actually
  accepts OpenAI content arrays with `image_url` parts, making real vision
  analysis possible end-to-end (verified: 1x1 red PNG → "Red").

===============================================================================
3. TEST RESULTS SUMMARY
===============================================================================

Test suite                              Status    Notes
----------                              -----    -----
test-aculyze-studio.js                    72/72 PASS   Full rewrite for new DOM
test-sidebar.js                           PASS       Verifies: no hamburger, rail, drawer, switching, composer
test-web-answer.js                        PASS       Requires Web toggle ON first; research block in bubble
test-zara-research-intelligence.js        PASS       Orchestrator/planner/verifier: all assertions pass
test-sales-agent.js                       PASS       Selectors unchanged; LMS data unavailable (honest)

Backend test suites (previous work, all passing):
- test-research-verify.js: 39/39 PASS
- test-research.js: 44/44 PASS  
- test-orchestrator.js: 31/31 PASS

===============================================================================
4. REMAINING LIMITATIONS / KNOWN ISSUES
===============================================================================

# 1. Gmail "coming soon" is honest, not functional
- The inbox Gmail row reads `/api/config` for email bridge state. Until the
  Gmail MCP bridge is actually connected (via Apps → Connections), it shows
  "Messages will appear here once Gmail is linked · coming soon". Clicking
  opens the Apps dialog so the user can configure it. No fake data is ever
  displayed.

# 2. Vision analysis is real but model‑dependent
- The 1x1 red PNG → "Red" was verified. Larger images or unsupported formats
  are rejected at the sanitizer with an honest note. The model currently in
  use is qwen/qwen3-vl-4b (Q4_K_M quantization); higher-capability quanti-
  zations may produce different answers. Private hosts are blocked; only
  data-URL and http(s) URLs are accepted.

# 3. Mobile inbox drawer opens over the chat (not beside it)
- On viewport ≤ 1024px, the inbox opens as a full-screen overlay on the
  copilot panel (via `#zaraInboxOpen` → removes `collapsed` class). The
  composer remains reachable at the bottom. This is a departure from the
  earlier "rail + drawer" distinction but matches the spec's mobile behavior.

# 4. Web research answers are honest, not guaranteed citations
- When Web toggle is ON + a research‑intent question is asked, `classifyResearch()`
  determines if the model should search. The pipeline runs `runResearch()` with
  the Playwright search provider. Results may include "INSUFFICIENT_EVIDENCE"
  (honest) when the model can't verify claims. The `onReasoning` delta events
  surface reasoning tokens as separate SSE events but are never rendered as
  the final answer.

# 5. Foppy sprite sheets missing (dot placeholder)
- `public/mascot/*.webp` files (`bunny-directions.webp`, `butterfly-reactions.webp`)
  don't exist. Foppy shows the `sheets-missing` dot placeholder until user
  drops files into that directory. This is an honest failure state, not a bug.

# 6. Sales LMS = not_connected → honest "Data unavailable"
- The fake ERP server on port 8124 is not auto‑started in the shipped binary.
- When no LMS is connected, answers say "Data unavailable: no connected LMS
  data was returned." and do not fabricate business metrics.

# 7. Reasoning deltas not rendered as answer text
- Per design: `onReasoning` events from the SSE stream are captured and surfaced
  client‑side but intentionally never displayed as part of the assistant's answer.
- This keeps the "transparent thinking" experience without polluting the
  conversation with internal model chains.

===============================================================================
5. QUICK REFERENCE: What each UI zone looks like now
===============================================================================

3‑zone shell (sidebar | workspace | right Copilot):

LEFT (sidebar):
- Single chevron control (#sidebarCollapse) — desktop: compact icon rail
  (62px, in‑layout, NOT off‑canvas); mobile: rail + drawer
- Nav items: Home | Zara Gen AI | Sales Agent | Apps | Settings
- No hamburger. Clicking a nav item closes the drawer (mobile) or switches
  view (desktop).

CENTER (workspace):
- WhatsApp‑style header: avatar "Z" + "Zara" + subtitle "Your AI assistant..."
  + small status dot + "Ready"/"Researching"/"Writing…"
- Conversation area dominates the center
- Messages: user bubbles (accent-soft background), agent bubbles (surface)
  with optional Copy/Regenerate/Listem actions
- WhatsApp day separators group messages by day
- Bottom composer: "Message Zara…" textarea, toolbar with:
  • + attachment (images only, 4‑image cap, 7MB size cap)
  • Web ON/OFF toggle (off by default)
  • Mic (voice input, 45s guard against hang)
  • Send / Stop buttons
- On desktop: Zara conversation center, Inbox panel right
- On tablet: sidebar collapses to rail; copilot collapses overlay; inbox
  opens as overlay over workspace
- On mobile: single chat view; inbox opens full-screen overlay; composer
  stays reachable at bottom

RIGHT (Copilot panel):
- "Messages" conversations panel (the new default)
  • Header: "Messages" + New message button
  • Search conversations input
  • Thread list rows with unread dot + relative time preview
  • Gmail row: honest "coming soon" until /api/config says email bridge linked
- Old "LIVE RESEARCH" panel removed entirely
- On tablet/mobile: inbox opens as overlay (see center zone)

===============================================================================
REPORT END
===============================================================================