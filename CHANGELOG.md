# Changelog — Aculyze Studio (Zara Orchestrator)

All notable changes to this project. The product is **Aculyze Studio**; the assistant remains **Zara**.

---

## [2.1.0] — 2026-10-28 — Research, Evidence, Verification & Reasoning Engine

### Added

#### Research/reasoning pipeline (`src/orchestrator/research/`)
A new intelligence layer that teaches Zara to **UNDERSTAND → RESEARCH → SELECT → VERIFY → REASON → ANSWER**, layered *around* the existing tools (nothing replaced).

- **`intent.js`** — intent understanding. Classifies whether a request needs research at all (`conversation | knowledge | research | comparison | recommendation | technical_research | current | calculation | internal`). Default is "no research" — only clearly research-shaped questions are promoted. Computer/browser/youtube are never claimed here (existing routers keep those).
- **`planner.js`** — structured research plan with bounded subtasks (`id/objective/query/requiredEvidence/status/dependsOn/result`). Deterministic templates; optional LLM query-phrasing is never required.
- **`toolRegistry.js`** — the ONLY seam to the web. A bounded adapter over the **existing** search provider (`search` + `fetchPage`), enforcing `MAX_TOOL_CALLS`/`MAX_SOURCES`, dedup, and SSRF refusal. Where a future "Lightpanda | Chrome" browser-agent split plugs in.
- **`researcher.js`** — the bounded research loop (search → fetch → extract claims → build evidence). Hard-capped by `MAX_RESEARCH_ROUNDS`.
- **`evidence.js`** — structured evidence records traceable to a real source URL. Deterministic source-quality scoring (official docs/repos/primary high, snippets low), page-level relevance labels (`RELEVANT/PARTIALLY_RELEVANT/IRRELEVANT`), freshness, and dedup keys.
- **`verifier.js`** — verification (`VERIFIED/PARTIALLY_VERIFIED/UNVERIFIED/CONFLICTED`), contradiction detection (explicit conflict records, never silently resolved), and gap detection (unanswered subtasks, missing/weak/stale sources, unresolved conflicts, missing dimensions).
- **`confidence.js`** — honest `HIGH/MEDIUM/LOW` + numeric confidence from source quality, independent-source count, agreement, freshness, directness. Penalizes conflicts and single-source answers.
- **`reasoning.js`** — structured reasoning metadata (known/unknown/conclusions/notConcluded/recommendation). No hidden chain-of-thought.
- **`synthesis.js`** — builds the internal `ANSWER_CONTEXT` and the prompt that forces the final LLM answer to be grounded in that context (no invented facts, honest about uncertainties/conflicts).
- **`stateMachine.js`** — explicit `RECEIVED→…→COMPLETED` state transitions + a structured trace (requestId/state/events). Terminal states are declared; no hidden loops.
- **`limits.js`** — the hard bounds (`MAX_RESEARCH_ROUNDS/SUBTASKS/SOURCES/TOOL_CALLS/...`), env-tunable but never unbounded.
- **`pipeline.js`** — wires it all together behind `runResearch(question, { searchProvider, llm })`. The LLM is injected (never hard-coded) and used only for final synthesis; if the model is offline it degrades honestly, still returning the evidence-grounded `ANSWER_CONTEXT`.

#### Orchestrator routes
- `POST /api/orchestrator/research` — run a full research pass (evidence + confidence + answer context + optional synthesized answer + trace).
- `POST /api/orchestrator/research/classify` — classify-only (no tools, no model): does this need research?
- `server.js` now injects the **existing** search provider and LLM provider into the orchestrator router — no new providers, no hard-coded model.

#### Tests (new)
- **`test-research.js`** — 44/44. Intent classification, planning, source scoring, evidence relevance, dedup, contradiction detection, gap detection, verification, confidence, tool bounds/SSRF, research stop conditions, max-rounds enforcement, graceful tool failure, and LLM synthesis (fake provider + fake model, fully offline/deterministic).

### Security (unchanged guarantees)
- The research engine reaches the web only through the existing search provider behind `ToolRegistry` — no arbitrary code, no shell, no new browser. Internal/localhost URLs are refused (no SSRF).
- The LLM never makes security/routing/permission decisions; deterministic code owns routing, scoring, limits, dedup, validation, and termination.

---

## [2.0.0] — 2026-10-28 — Zara Orchestrator + Visual Screen Interaction

### Added

#### Aculyze Studio branding
- Product renamed to **Aculyze Studio** across `public/index.html` (title, meta, og tags, sidebar, header, About page), `server.js` (`branding` object + startup log), and `README.md`.
- Assistant identity kept as **Zara** — system-prompt identity and assistant UI strings unchanged.

#### Zara Orchestrator (`src/orchestrator/`)
- **`intentRouter.js`** — deterministic intent classifier sitting *before* the existing blocks. Composes the existing `browserRouter` + `computerRouter` and adds clause-based YouTube detection. Handles compound commands ("Open Chrome and play X on YouTube"). Only claims YouTube/visual intents (`orchestratorRan` flag); all other intents fall through to the existing, untouched browser/computer/apps/web blocks — no duplicate routing, no rewrite.
- **`youtubeWorkflow.js`** — fixed-op visual-loop executor: `open → navigate → find_visible → click_visible → video_state → video_control`. One action at a time (PLAN→ACTION→VERIFY), `MAX_ACTIONS = 10`, and an honest STOP message when the target is not found. Never clicks blind coordinates.
- **`routes.js`** — HTTP surface: `/api/orchestrator/classify`, `/api/orchestrator/run`, `/api/orchestrator/status`.

#### Visual screen interaction
- **Browser DOM-visual ops** (`browser_automation/browser.py`, whitelisted in `browser_automation/server.py`):
  - `screenshot`, `find_visible` (role+text → bounding box), `click_visible`, `video_state`, `video_control` (play/pause/toggle + `mute` param).
  - Module-level `ROLE_SELECTORS` map + `role_selectors_for` — no caller-supplied selectors (security).
  - `find_visible` waits for the target role to appear (SPA results hydrate after load) before scanning.
  - `video_state` sanitizes non-finite numbers (`NaN`/`Infinity`) to avoid invalid JSON, and computes `playing` null-safely.
- **Computer screen capture** — new Level-1 (read-only) op `computer.screen.capture`:
  - `permissions.js` (`LEVEL_1_OPS`), `computerRouter.js` (`SCREENSHOT_RE` + `mkScreenshot`), `routes.js` (`runAction`), `resolver.js` (`captureScreen` passthrough).
  - Windows adapter + new `src/computer/scripts/win/capture-screen.ps1` (System.Drawing `CopyFromScreen`, JSON via `ConvertTo-Json`).
  - macOS adapter (`screencapture -x`).
- Local test fixture `browser_automation/fixtures/visual.html` for deterministic visual-loop testing.

#### Tests (new)
- **`test-orchestrator.js`** — 31/31. Routing table, compound YouTube, conversation fall-through, no-shell security.
- **`test-visual-screen.js`** — 15/15. Deterministic visual loop against the local fixture (port 8799) + computer `screen.capture`.
- **`test-youtube.js`** — 13/13. Real browser against real YouTube (Creative-Commons "Big Buck Bunny", muted playback): search → identify → click → verify playing → verify `currentTime` advances → pause → verify paused → honest failure with no video.

---

### Fixed

#### Computer Control — UWP app close
- `src/computer/adapters/windows.js` `close()` — UWP (Store) apps (e.g. Calculator) host their window under `ApplicationFrameHost.exe`, so a WM_CLOSE sent to the app's own process finds no window and the app lingers. `close()` now detects `launch.type === 'uwp'` and terminates that specific process (`taskkill /IM <app>.exe /F`) **before** the window-op path. Win32 apps (e.g. Notepad) keep the polite WM_CLOSE + graceful "save your work" reporting. `test-computer.js` **31/31**.

#### Browser automation bugs
- `video_state` — Python `page.evaluate` returning `NaN`/`Infinity` produced invalid JSON that Node's `JSON.parse` rejected → numbers sanitized.
- `video_control` — added `mute` param (tests mute playback so verification never blasts audio).

---

### Architecture / Security (unchanged guarantees)

- **Flow:** USER → Studio → Zara → Orchestrator → Intent Router → Permission Gate → Whitelist → Agent → OS/Browser.
- The LLM **never** executes arbitrary commands. Deterministic routing → permission gate → whitelisted ops only. No PowerShell/CMD/Bash/AppleScript/shell execution is ever exposed to the model.
- LM Studio + Llama-1B remain the provider behind the existing clean abstraction (generate/stream/health). API keys stay server-side. No hard-coded model in the orchestrator. No new npm dependencies.

---

## Regression status (all passing)

| Suite | Result |
|---|---|
| `test-research.js` (new) | 44/44 |
| `test-orchestrator.js` | 31/31 |
| `test-computer-router.js` | 37/37 |
| `test-computer.js` | 31/31 |
| `test-computer-chat.js` | 9/9 |
| `test-computer-macos.js` | skip (macOS-only) |
| `test-visual-screen.js` | 15/15 |
| `test-youtube.js` | 13/13 |
| `test-browser-router.js` | all pass |
| `test-chat-e2e.js` | exit 0 |
| `test-thinking.js` / `test-thinking-cancel.js` | exit 0 |
| `test-sidebar.js` / `test-visual.js` / `test-redesign.js` | exit 0 |
| `test-responsive.js` | sweep passed |
| `test-voice-mode.js` / `test-sales-agent.js` / `test-web-answer.js` | exit 0 |

### Known limitations (honest reporting)
- **macOS adapter** (incl. `captureScreen`) written to spec but untested on this Windows machine — needs a real Mac.
- **Visual target identification uses Playwright DOM locators, not pixel vision.** Llama-1B has no vision model, so "identify the visible target" is satisfied deterministically via role+text → bounding box. OS-level blind coordinate clicking is deliberately **not** implemented (it would violate the "identify before coordinates" rule without a vision/UIA layer). Only read-only `computer.screen.capture` was added at the OS level; mouse/keyboard desktop ops are deferred.
- **Live YouTube is nondeterministic** — an ad or player restart can rewind `currentTime` mid-test, causing a rare flaky failure in `test-youtube.js`. Re-running passes 13/13. Playback verification is real (video element `paused`/`currentTime`), and the test runs muted.

---

## Start command

```bash
node server.js
```

Server runs on `http://localhost:3000`. Orchestrator status: `GET /api/orchestrator/status`.
