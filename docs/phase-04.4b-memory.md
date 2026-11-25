# Phase 04.4 Stage B: Memory

Zara and the AI employees remember a few lasting things about each person, like their role, team, ongoing work and how they like answers, so people don't have to repeat themselves.

## What people can do
- **Just chat.** When someone mentions something lasting about themselves ("I manage the Chennai sales team"), it's remembered. A small "Remembered: …" note appears under that answer and opens Settings → Memory.
- **Say it directly in Zara:** "remember that …", "forget …", "forget everything about me", "what do you remember about me?"
- **Settings → Memory:** see everything remembered, add, edit, delete, switch "Learn from my chats" off, or forget everything.

## Where memory is used
| Place | How |
|---|---|
| Zara chat | Added to Zara's instructions for each message (preferences always, plus memories that match the question) |
| AI employee Inbox replies | Same, for the person in the thread; Inbox messages are also learned from |
| AI task runs ("Run with AI", automations) | The memories of the person who started the work |

## How learning works (`src/memory/learn.js`)
1. A cheap filter skips messages with nothing personal in them (questions, requests), so most messages cost no extra AI call. At most one learning call per person every 15 seconds.
2. The AI sees the existing memories (with ids) and the message, and returns small changes: add new lasting facts, update one that changed ("moved to the Bengaluru team"), remove one the person says is wrong.
3. Never saved: passwords, codes, PINs, keys, card numbers (blocked by pattern before and after the AI), sensitive topics, facts about other people, one-off questions.

Checked with the real model: it saved role and preference, skipped a GST question and an email request, updated the team when the person moved, and saved nothing from a message containing a bank PIN.

## Storage (`src/memory/store.js`)
One document per account through the docstore (`memory/<userId>.json`), so it lives in Postgres on Render. Up to 200 memories per person (least recently used dropped first), 300 characters each. Near-duplicates update the existing memory instead of adding a copy. Only the person can see or change their memories.

## API (`/api/memory`, sign-in required)
| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Settings + memories |
| POST | `/` | Add by hand |
| PATCH / DELETE | `/:id` | Edit / forget one |
| DELETE | `/` | Forget everything |
| PUT | `/settings` | `{ autoLearn }` |
| GET | `/context?q=` | Memory text for one Zara request |
| POST | `/command` | "remember / forget / what do you remember" |
| POST | `/learn` | Learn from one Zara turn |

## Tests
`node test/memory.test.js` (14): store, secret filter, duplicates, cap, context, commands, third-person wording, learning (add / update / remove, unknown ids ignored, filter, off, cooldown, broken AI output), routes with per-user isolation, and Inbox replies including memory. Browser check on a temporary app copy with the real model: remember command, learned note, list, personalised answer, Settings edit / add / delete / switch off.

Inspired by `llm_apps_with_memory_tutorials` in Shubhamsaboo/awesome-llm-apps (Apache-2.0); no code copied.
