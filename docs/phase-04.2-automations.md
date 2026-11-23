# Phase 04.2: Automations

AI employees start work on their own, at a set time or when something happens.

> **When** something happens → **who** (an AI employee) → **does what** (an instruction)

Each firing creates a **normal task** for that AI employee and runs it in the background, exactly like Run with AI. The task uses the automation owner's own connected apps. Anything that sends or creates something externally still waits for the owner's approval. Results arrive in the owner's Inbox.

## Triggers (v1)

| Trigger | Fires | Who can create it | Duplicate guard |
|---|---|---|---|
| **Schedule** | Daily at a time on chosen weekdays, or every N hours (within working hours) | anyone | one run per time slot |
| **New email** | A new Gmail message matches a filter (from / subject / words). Checked every 5 minutes with the owner's Gmail | anyone | message id; emails already there when the automation is switched on are skipped |
| **New website lead** | The website chatbot captures a lead (optionally from one chatbot only) | managers, admins | lead id |
| **Task overdue** | An open task passes its due date | managers, admins | task id |

The trigger's details (the email's sender, subject and preview; the lead's name, email and phone; the overdue task and its assignee) are added to the task description, so the AI employee knows what to act on.

## New built-in task tools

Automations often need to reach people inside the company, so the runtime gains two internal tools. Neither touches external apps, and both are logged on the task:

| Tool | Does | Allowed for capabilities |
|---|---|---|
| `task__notify_person` | Sends an Inbox message from the AI employee to a colleague (by name or email) | inbox_communication, task_assignment, delegation, employee_monitoring, task_management |
| `task__create_followup` | Creates a follow-up task for a colleague (title, details, due in N days) | task_assignment, delegation, task_management |

When these tools are available, the AI employee gets a short list of the company's people (name, role, email).

## Guardrails

- **Max runs per day** for each automation (default 10, at most 50). When the limit is reached, further triggers are skipped and logged.
- **Pause / resume** and **Test now** (fires once, immediately, with sample context).
- **Run history:** each firing records the trigger, the task it created, and the outcome.
- If a trigger can't run (for example Gmail isn't connected), the error shows on the automation instead of failing silently.

## Pages

- **Automations** (sidebar, everyone): ready-made templates, the list of automations (trigger, AI employee, runs today, last run, on/off), and a create form.
  - Managers and admins see everyone's automations and can pause them.
  - Only the owner, or an admin, can edit or delete one.

## Code

- `src/automations/store.js`: automations, run history and seen keys (`data/automations/*.json`)
- `src/automations/events.js`: in-process event bus (`lead.created`)
- `src/automations/service.js`: clock (every minute, with email polling every 5 minutes), trigger evaluation, firing
- `src/automations/routes.js`: `/api/automations`
- `src/execution/toolPolicy.js` + `agentRuntime.js`: the internal tools and the people list
- `public/js/automations-view.js` + the `view-automations` section
- Tests: `test/automations.test.js`

## Out of scope (later)

- Outlook email trigger, webhooks, multi-step workflows (Phase 04.3)
- Postgres storage (all of 04.x stores JSON today)
