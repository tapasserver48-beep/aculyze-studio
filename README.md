# Aculyze Studio

### The new AI era for company #1

**Aculyze Studio** is where your team and your AI employees work side by side. Ask Zara anything, hand work to AI employees, and let automations run the routine. The people on your team stay in control: nothing is sent or created outside the company without a human's approval.

![Aculyze Studio](aculyze-studio-home.png)

---

## What's inside

### Zara, your AI copilot
The right-side panel on every page.
- **Answers with sources**: live web research, with the pages it actually read.
- **Connected apps**: reads Gmail and Google Calendar, drafts replies, and asks before sending anything.
- **Documents**: "Create a PDF about our Q4 plan", "Make a PowerPoint on AI agents", "Convert this to Word". It creates **PDF, Word and PowerPoint** files and reads PDF, Word, PowerPoint, text and CSV files you attach.
- **Images**: attach screenshots and photos for the vision model to read.
- **Voice**: talk to Zara and hear the answer.
- **Memory**: remembers your role, team and how you like answers, so you don't repeat yourself. See and edit everything in Settings → Memory.

### AI employees
Each AI employee has a role, permissions and its own colour, and does real work on tasks:

| AI employee | What it does |
|---|---|
| **Chief of Staff** | Plans work, delegates to people and AI employees, watches progress |
| **Executive Agent** | Daily check-ins in the Inbox, chases late replies, team performance with Excel export |
| **Customer Executive** | Reads your website and answers visitors from it with sources, via a one-line chat widget; collects leads when it can't help |
| **Sales Agent** | Answers sales, lead and customer questions from Aculyze LMS data only, never invented numbers |

### Work together
- **Tasks**: one task engine for people and AI employees. AI results arrive *under review*; a person accepts them.
- **Automations**: "when X happens, an AI employee does Y": on a schedule, a new email, a new website lead, or an overdue task.
- **Inbox and Channels**: direct messages and team channels, with AI employees in the conversation.
- **Command Centre**: staff, usage and token monitoring.

---

## Quick start

Requirements: **Node.js 18+**. An AI model: an NVIDIA API key, or [LM Studio](https://lmstudio.ai) running locally.

```bash
git clone https://github.com/tapasserver48-beep/aculyze-studio.git
cd aculyze-studio
npm install
# create a .env file with your keys (see the table below), then:
npm start                 # http://localhost:3000
```

A minimal `.env`:

```env
AI_PROVIDER=hybrid
NVIDIA_API_KEY=your-nvidia-key
APP_TIMEZONE=Asia/Kolkata
```

The first start prints a one-time setup code in the log for creating the first admin account.

### Main settings (`.env`)

| Variable | Purpose |
|---|---|
| `AI_PROVIDER` | `hybrid` (NVIDIA first, LM Studio fallback), `nvidia` or `lmstudio` |
| `NVIDIA_API_KEY` | NVIDIA model API key |
| `LM_STUDIO_BASE_URL` | Local LM Studio, default `http://127.0.0.1:1234` |
| `DATABASE_URL` | PostgreSQL. Without it, data is stored in local files under `data/` |
| `SEARCH_PROVIDER` | `duckduckgo` (default) or `google` with `GOOGLE_SEARCH_KEY` / `GOOGLE_SEARCH_CX` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google sign-in, Gmail and Calendar |
| `LMS_API_KEY` / `ACULYZE_LMS_BASE_URL` | Aculyze LMS data for the Sales Agent |
| `APP_TIMEZONE` | Clock for check-ins and automations, e.g. `Asia/Kolkata` |

## Deploy on Render

`render.yaml` sets up the web service and a PostgreSQL database. Add the secret keys in the Render dashboard (they are marked `sync: false`), then deploy. Render's disk is wiped on every deploy, so all saved data lives in PostgreSQL.

## Tests

```bash
node test/documents.test.js
node test/automations.test.js
node test/executive.test.js
# … one file per feature in test/
```

## Docs

| Phase | Doc |
|---|---|
| 04.1 Agent runtime (tool loop and approvals) | [docs/phase-04.1-agent-runtime.md](docs/phase-04.1-agent-runtime.md) |
| 04.2 Automations | [docs/phase-04.2-automations.md](docs/phase-04.2-automations.md) |
| 04.2a Executive Agent | [docs/phase-04.2a-executive-agent.md](docs/phase-04.2a-executive-agent.md) |
| 04.3 Zara documents (PDF, Word, PowerPoint) | [docs/phase-04.3-documents.md](docs/phase-04.3-documents.md) |
| 04.4 Customer Executive website assistant | [docs/phase-04.4-customer-executive.md](docs/phase-04.4-customer-executive.md) |
| 04.4 Memory (Zara and AI employees remember you) | [docs/phase-04.4b-memory.md](docs/phase-04.4b-memory.md) |
| Next: new AI employees from awesome-llm-apps | [docs/plan-awesome-llm-apps.md](docs/plan-awesome-llm-apps.md) |
| Next: Travel Planner | [docs/plan-travel-planner.md](docs/plan-travel-planner.md) |

## Tech

Node.js · Express · PostgreSQL / SQLite · WebSockets · Playwright · MCP · pdfkit, docx, pptxgenjs, mammoth, unpdf

---

Built by **Aculyze**. Some feature ideas are adapted from [awesome-llm-apps](https://github.com/Shubhamsaboo/awesome-llm-apps) (Apache-2.0).
