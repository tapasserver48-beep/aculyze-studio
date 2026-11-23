# Phase 04.2a: Executive Agent daily check-ins

## What it does

A manager sets up a daily check-in, for example "every Mon–Sat at 15:00, ask every employee how many sales and calls they did; deadline 16:00". Then:

| Time | What the Executive Agent does |
|---|---|
| 15:00 | Sends each person in the audience the question in the **Inbox** |
| Replies | Reads the numbers from the chat ("sales 5, calls 20", "5 sales and 20 calls", "no sales, 12 calls"), confirms them, asks for any missing number, and accepts corrections the same day |
| Everyone answered before the deadline | Sends managers the summary with totals straight away |
| 16:00 deadline | Reminds each person who hasn't answered. Tells each of those people's **"reports to"** person (acting TL) who on their team is missing. Sends **every manager**, every admin and the creator the summary: submitted count, totals, and who is missing |

Each summary carries **Open report** and **Download Excel** buttons. These appear only for managers and admins. The Excel file lists each person, their numbers, on time / late / missing, when they answered, and a totals row.

## Pages

- **Executive Agent** (sidebar; founder/admin/manager):
  - **Daily check-ins:** create, pause or resume, delete, Ask now, Remind now, and a per-day report with an Excel download.
  - **Team performance:** for each person, open tasks, overdue tasks, tasks completed in the last 30 days, check-ins answered, and the numbers they reported over the last 7 days.
- **Admin:** a new **Reports to** column. This sets who acts as each person's TL.
- **Chief of Staff:** now shows only **Team**. "Plan work" and "Plans" are hidden, because Tasks covers planning with the Ask bar and Run with AI.

## Code

- `src/executive/store.js`: check-ins, daily runs and responses (`data/executive/*.json`)
- `src/executive/service.js`: scheduler (`tick` every minute), ask, reply parsing, escalation, summary, dashboard
- `src/executive/routes.js`: `/api/executive/*`
- `src/inbox/routes.js`: a message to the Executive Agent first tries `handleReply`; anything that isn't a check-in answer gets a normal chat reply
- `public/js/executive-view.js` plus the `view-executive` section in `index.html`
- Tests: `test/executive.test.js` (39 checks, uses a fake clock)

## Notes

- Times use `APP_TIMEZONE` from `.env` if it is set, otherwise the server's time zone. On Render the server runs in UTC, so set `APP_TIMEZONE=Asia/Kolkata` (or your zone) there.
- The scheduler checks once a minute. It only asks between the ask time and the deadline, so a server that was down at 15:00 still asks when it comes back up, as long as that is before the deadline.
- Storage is JSON only for now (`data/executive/`). Postgres is a follow-up, the same as for agent approvals.
