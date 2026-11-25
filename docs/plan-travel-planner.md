# Plan: AI Travel Planner (based on awesome-llm-apps `ai_travel_agent`)

Status: **plan only, nothing built yet** (2026-11-25)

## 1. What the reference app does

`starter_ai_agents/ai_travel_agent/travel_agent.py` (Streamlit, about 150 lines, Apache-2.0):

1. **Researcher agent** (GPT-4o + SerpAPI Google search): makes 3 search terms for the destination and number of days, searches each one, and keeps the 10 most relevant results.
2. **Planner agent** (GPT-4o): turns those results into a day-by-day itinerary as free text.
3. **Calendar export**: splits the text on `Day N` with a regex and writes one all-day `.ics` event per day.

It needs an OpenAI key and a SerpAPI key typed into the page, keeps nothing after a refresh, and has no login.

### The repo has three stronger travel versions; we borrow from them

| Repo folder | What it adds | What we take |
|---|---|---|
| `advanced_ai_agents/multi_agent_apps/agent_teams/ai_travel_planner_agent_team` ("TripCraft", FastAPI + Next.js + Postgres) | Specialist agents (destination, flights, hotels, food, budget, itinerary) running in parallel; a `plan_tasks` table that tracks progress; retry a failed plan | Split our planner into specialist steps run in parallel; save progress per step so a plan can be retried |
| `mcp_ai_agents/ai_travel_planner_mcp_agent_team` | Airbnb MCP for real stays, Google Maps MCP for distances and travel times, weather | Later: connect these MCP servers through our existing `src/services/mcp/manager.js` |
| `advanced_llm_apps/llm_apps_with_memory_tutorials/ai_travel_agent_memory` | Remembers the user's preferences across trips | "You prefer vegetarian food and slow mornings" carried into the next trip (with 04.4 agent memory) |

See `plan-awesome-llm-apps.md` for the review of the whole repo.

## 2. Decision: rebuild it in Node inside Aculyze Studio (don't run the Python app)

| | Run the Streamlit app as-is | **Rebuild in Node (recommended)** |
|---|---|---|
| Deploy | Second Render service (Python), extra cost | Same service, nothing new to deploy |
| Keys | New OpenAI and SerpAPI keys | Reuses NVIDIA / LM Studio and DuckDuckGo search, which are already configured |
| Login and saving | None, lost on refresh | Uses our sign-in and saves trips in Postgres (docstore) |
| Look | Streamlit UI, can't match Aurora | Native Aurora page plus Zara chat |
| Exports | .ics only | PDF, Word, .ics, Google Calendar (all already in the codebase) |

We keep the idea (researcher → planner → calendar) and credit the original repo in the code header. No Python code is copied.

## 3. How it fits the project

- **New AI employee: "Travel Planner"** with its own identity colour `--agent-travel` (sky blue, `#0284c7` light / `#38bdf8` dark), following the Aurora rule that each AI employee has a colour.
- **New sidebar page: Trips**, for the full planning experience.
- **Zara chat hook**: "Plan a 5-day trip to Munnar in January" in the Zara panel runs the same pipeline and shows a trip card with "Open in Trips".

### Reused pieces

| Need | Existing code |
|---|---|
| LLM | `provider.sendMessage` (`src/services/ai/router.js`) |
| Web search | `searchProvider.search()` (`src/services/search/duckduckgo.js`) |
| Saving trips | `src/db/docstore.js` (readJson / writeJson, Postgres on Render) |
| PDF / Word itinerary | `src/documents/render.js` (`renderDocument`) |
| Add to Google Calendar | `src/integrations/providers/google.js` (`calendar.events` scope already requested) |
| Approval before writing to the calendar | Same confirm pattern as Gmail send in the Zara panel |
| Sign-in | `requireUser` (`src/auth/session.js`) |

## 4. Backend design: `src/travel/`

```
src/travel/
  researcher.js  LLM writes 4-6 search queries → search → dedupe → top 12 results with URLs
  planner.js     LLM writes a structured JSON itinerary from the research (schema below)
  schema.js      validates the JSON, makes one repair retry, then falls back to Markdown
  ics.js         pure-JS .ics writer (no dependency): one event per activity with a time, all-day otherwise
  store.js       docstore key "travel-trips/<uid>"
  routes.js      /api/travel/*
```

### Itinerary JSON (replaces the original's "Day N" regex, which is fragile)

```json
{
  "destination": "Munnar, Kerala",
  "startDate": "2027-01-12", "days": 5, "travellers": 2,
  "budget": { "currency": "INR", "level": "mid", "estimateTotal": 42000,
              "breakdown": [{ "label": "Stay", "amount": 18000 }] },
  "summary": "…",
  "stays": [{ "name": "…", "area": "…", "pricePerNight": "₹3,500", "why": "…", "source": 3 }],
  "dayPlans": [{
    "day": 1, "date": "2027-01-12", "title": "Arrival and tea gardens",
    "items": [{ "time": "09:00", "slot": "morning", "activity": "…", "place": "…",
                "durationMin": 120, "cost": "₹200", "source": 1 }]
  }],
  "tips": ["…"], "packing": ["…"],
  "sources": [{ "id": 1, "title": "…", "url": "https://…" }]
}
```

Every fact that comes from research points at a source id. Anything the model added on its own is shown as "suggestion, not verified".

### API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/travel/plan` | Server-sent events: `step` (query, sources found) → `plan` (JSON) → `done` |
| GET | `/api/travel/trips` | List my saved trips |
| GET / DELETE | `/api/travel/trips/:id` | One trip |
| POST | `/api/travel/trips/:id/revise` | "Make day 2 more relaxed": re-plans one day or the whole trip |
| GET | `/api/travel/trips/:id/export?format=pdf\|docx\|ics` | Downloads |
| POST | `/api/travel/trips/:id/calendar` | Adds events to Google Calendar, **only after the user confirms** |

## 5. UI/UX design (Aurora theme)

### Trips page: before planning

```
┌───────────────────────────────────────────────────────────────────────────┐
│ Trips                                                     [+ New trip]    │
├──────────────────────────────┬────────────────────────────────────────────┤
│ PLAN A TRIP                  │  Your trips                                │
│ Where to?   [Munnar, Kerala] │  ┌──────────┐ ┌──────────┐ ┌──────────┐    │
│ Dates  [12 Jan] → [16 Jan]   │  │ Munnar   │ │ Goa      │ │ Jaipur   │    │
│ Travellers   [ - 2 + ]       │  │ 5 days   │ │ 3 days   │ │ 4 days   │    │
│ Budget  (•Low) (Mid) (Lux)   │  │ Jan 12   │ │ Dec 20   │ │ Draft    │    │
│ Interests                    │  └──────────┘ └──────────┘ └──────────┘    │
│ [Nature✓][Food✓][Culture]    │                                            │
│ [Adventure][Shopping][Relax] │                                            │
│ Pace  (Relaxed)(•Balanced)   │                                            │
│ Notes [vegetarian, no treks] │                                            │
│        [ Plan my trip → ]    │                                            │
└──────────────────────────────┴────────────────────────────────────────────┘
```

### While planning: live progress (the user can see why it takes 20-40 seconds)

```
 ● Understanding your trip                         done
 ● Searching the web                               4 / 5
     ✓ "Munnar 5 day itinerary January"            6 results
     ✓ "Munnar vegetarian restaurants"             5 results
     … "Munnar homestays mid budget"
 ○ Writing your day-by-day plan
 ○ Checking sources
                                                   [ Stop ]
```

### Result

```
┌───────────────────────────────────────────────────────────────────────────┐
│ MUNNAR, KERALA                       [PDF] [Word] [Calendar ▾] [Share]    │
│ 12–16 Jan 2027 · 2 travellers · Mid budget · est. ₹42,000                 │
├──────────────────────────────────────────────┬────────────────────────────┤
│ [Day 1] [Day 2] [Day 3] [Day 4] [Day 5]      │ WHERE TO STAY              │
│                                              │ ▸ Tea Valley Homestay      │
│ DAY 1 · Tue 12 Jan · Arrival & tea gardens   │   ₹3,500/night · [source]  │
│ ┃ 09:00  Morning  Tea Museum      ₹200   [1] │ ▸ …                        │
│ ┃ 13:00  Lunch    Saravana Bhavan ₹400   [3] │ BUDGET                     │
│ ┃ 15:00  Afternoon Mattupetty Dam  free  [2] │ Stay ████████ 18k          │
│ ┃ 19:00  Evening  Spice market          sugg.│ Food ████ 8k               │
│                         [↻ Redo this day]    │ TIPS · PACKING             │
├──────────────────────────────────────────────┴────────────────────────────┤
│ Ask to change: [ make day 2 more relaxed and add a boat ride      ] [→]   │
│ Sources (12) ▾                                                            │
└───────────────────────────────────────────────────────────────────────────┘
```

### Design rules

- **Colour**: Travel Planner uses `--agent-travel` (sky) for the avatar, the timeline rail and day tabs. Main buttons stay `--accent` indigo, with `--on-accent` text.
- **Layout**: frosted shell and near-solid cards, matching the other pages. Two columns on desktop, one column below 900px (side cards move under the timeline, and the action bar sticks to the bottom).
- **Timeline items**: time, slot chip (Morning / Afternoon / Evening in soft tints), activity, place, cost, and a source badge `[n]` that opens the link. Unverified items show a muted "suggestion" chip.
- **Empty and error states**: if search fails, say so and offer "Plan from model knowledge (unverified)". Never fake sources.
- **Accessibility**: day tabs use `role="tablist"`, progress is announced with `aria-live="polite"`, everything works by keyboard, and contrast is checked in both themes.
- **Check**: Playwright screenshots in light and dark, desktop and mobile, before calling it done.

### Zara panel card

```
┌─────────────────────────────────────────┐
│ ✈  Munnar · 5 days · 12–16 Jan          │
│ Tea gardens, Mattupetty, Eravikulam…    │
│ est. ₹42,000 · 12 sources               │
│ [Open in Trips]  [PDF]  [Calendar]      │
└─────────────────────────────────────────┘
```

## 6. Build steps

| Step | Work | Size |
|---|---|---|
| A | `researcher.js`, `planner.js`, `schema.js` + unit tests with a stub LLM | 1 day |
| B | `routes.js` (SSE plan, trips CRUD), `store.js` + pg-mem docstore test | 0.5 day |
| C | Trips page UI (form, progress, timeline, side cards) in both themes | 1.5 days |
| D | Exports: PDF/Word via `renderDocument`, `.ics`, Google Calendar with confirm | 0.5 day |
| E | Zara chat hook ("plan a trip…") + trip card; revise-a-day | 0.5 day |
| F | Register the Travel Planner AI employee + `--agent-travel`, sidebar entry, screenshots | 0.5 day |

## 7. Risks

- **DuckDuckGo can rate-limit or block Render's IP.** Retry with backoff, cap at 5 queries, and if search fails offer an "unverified" plan clearly labelled as such. Google Custom Search (`src/services/search/google.js`) can be used if it's configured.
- **The model returns broken JSON.** Validate it, make one repair retry, then fall back to the Markdown itinerary (still exportable as PDF/Word).
- **Stale prices and opening hours.** Label every cost as "estimate" and link its source. No booking or payments (out of scope).
- **Response time.** 20-40 seconds in total, so live progress steps are required, and the user can stop the run.

## 8. Open questions

1. A separate AI employee and Trips page (as planned), or only a Zara chat feature?
2. Should "Add to Google Calendar" be in the first version?
3. Is INR the default currency, or should it be detected from the destination?
