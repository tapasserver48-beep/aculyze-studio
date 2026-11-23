# Phase 04.1: Working AI Employee Runtime

## Goal

Let an AI employee actually carry out an assigned task. It reads data from connected apps, reasons over several steps, asks a person before any action that writes or sends, and hands back a result for human review.

Today `POST /api/agents/:employeeId/execute` makes one model call with no tools. It never finishes the task, and it ignores the employee's own instructions.

## Current problems this phase fixes

| # | Problem | Where |
|---|---|---|
| 1 | One model call, no tools, no loop | `src/execution/agentRuntime.js` `executeTask` |
| 2 | Employee instructions never used: the lookup key built from `employee_code` never matches, and the registry's `system_instructions` is ignored | `agentRuntime.js` `buildPrompt` |
| 3 | `maxSteps`, `allowedTools` and `getToolCapability` exist but nothing uses them | `src/execution/context.js` |
| 4 | Nothing ever moves a task to review or completed; `completeTask` has no callers | `agentRuntime.js` |
| 5 | The hybrid router gives the primary model only 5 seconds unless `timeoutMs` is passed | `src/services/ai/router.js` |
| 6 | No UI for running a task with its AI employee | `public/js/tasks-view.js` |

## Design

### Whose accounts the agent uses

App connections are stored per user, and the key is the login account id. An AI employee **acts on behalf of the person who started the run** (`initiatingUserId`) and can only use apps that person has connected. Nothing new is stored about AI identities, and a run can never reach another user's accounts.

### Which tools an employee gets (two filters, both required)

1. **The person's connections:** `buildToolSchemas(manager.listApps(uid))`, the same filter the chat tool agent uses.
2. **The employee's capabilities:** a new policy table in `src/execution/toolPolicy.js` maps each capability to the tool ids it allows. Example: `gmail_readwrite` allows `gmail.*` and `outlook.*`, while `reporting` allows only read tools for Sheets, Docs, Drive and LMS summaries.

The policy is checked again when a tool call is executed, not only when the tool list is built.

### Built-in task tools (always available)

| Tool | Effect |
|---|---|
| `task__report_progress` | `{ note, percent }` → adds an activity entry and updates `progress` |
| `task__request_info` | `{ question }` → task becomes `pending` / `waiting_for_info`, a comment is added, the requester gets an Inbox message, and the run stops |
| `task__submit_result` | `{ summary, result }` → a result comment is added, the task becomes `under_review` with progress 100, the requester gets an Inbox message, and the run stops |

The agent never marks a task `completed` itself. A person approves the result through the normal task flow.

### The run loop

```
load employee (registry instructions) + task + allowed tools
loop (at most maxSteps rounds, within a wall-clock budget):
  model call with tools
  no tool calls → its text becomes the submitted result → stop
  for each tool call:
    unknown / not allowed → return an error to the model, keep going
    read tool             → manager.runTool(uid, …), capped result goes back
    task__* tool          → apply it, maybe stop
    write tool            → save an APPROVAL REQUEST with the run state, stop
```

Limits: `maxSteps` 8 by default (capped at 20), 6000 characters per tool result, a 4-minute total budget, and 60 seconds per model call. Each tool call is logged as a task activity: `agent_tool_call`, `agent_tool_error` or `agent_approval_requested`.

### Approval of writes (sending email, creating events, etc.)

- When the agent wants to send or create something, the run pauses. The task becomes `pending` / `awaiting_approval`. An approval record is saved, holding the tool, its arguments, a preview from `manager.buildConfirmation`, and the saved conversation so the run can continue. The requester gets an Inbox message.
- `GET  /api/agents/approvals`: pending approvals for the signed-in user.
- `POST /api/agents/approvals/:id/approve`: only the person who started the run may approve, because it runs on their account. The action runs through `manager.execute(uid, { confirm: true })`, its result goes back into the conversation, and the run **resumes**.
- `POST /api/agents/approvals/:id/reject`: an optional reason goes back to the agent as the tool result, and the run resumes so the agent can change course or submit what it has.
- Approvals are stored in `data/agent-approvals.json`. Postgres storage is a follow-up item.

### Prompt

```
system:  registry system_instructions (fallback: role default) + runtime rules
         (use tools, never invent data, writes need approval, finish with task__submit_result)
user:    task title / description / expected deliverable / priority / due /
         recent comments (latest 5)
```

### API changes

- `POST /api/agents/:employeeId/execute` returns `{ executionId, status, outcome, result?, approval?, question?, steps, provider, model }`, where `outcome` is one of `submitted | needs_approval | needs_info | failed`.
- New: the approval endpoints listed above.

### UI

- Tasks view: tasks assigned to an AI employee get a **Run with AI** button, shown to founders, admins and managers. The button shows the run steps and its outcome.
- If an approval is waiting, the task shows a card with a preview and Approve / Reject buttons.

## Files

| File | Change |
|---|---|
| `src/execution/toolPolicy.js` | **new**: maps capabilities to tools, plus the built-in task tool schemas |
| `src/execution/approvals.js` | **new**: JSON store for approval requests |
| `src/execution/agentRuntime.js` | rewrite: run loop, prompt fix, resume after approval |
| `src/agents/routes.js` | new response shape and approval endpoints; creates its own `IntegrationManager` (options `manager` / `runtimeProvider` let tests inject fakes), so `server.js` is unchanged |
| `public/js/api.js`, `public/js/tasks-view.js` | Run with AI button and approval card |
| `test/agent-runtime.test.js` | **new**: scripted fake model and fake integration manager |

## Tests (`node test/agent-runtime.test.js`)

1. The employee's registry instructions reach the system prompt.
2. A read tool runs and its result goes back to the model; the run ends with `submit_result` and the task becomes `under_review`.
3. A tool outside the employee's capabilities is refused, even if the model calls it.
4. A tool from an app that isn't connected is never offered.
5. A write tool pauses the run: the approval is saved, the task becomes `awaiting_approval`, and the requester gets an Inbox message.
6. Approve: the action runs and the conversation resumes and finishes. Reject: the reason goes back to the agent.
7. Only the person who started the run can approve it; anyone else gets 403.
8. `request_info` pauses the run with `waiting_for_info`.
9. The step limit is enforced, and a model error leaves the task blocked.
10. Existing tests `test/agent-execution.test.js` still pass.

## Status (2026-11-23)

- Built: everything above. `test/agent-runtime.test.js` passes 41 checks, and the existing agent, Chief of Staff, staff monitor, customer executive and admin-setup suites still pass.
- `test/admin-permissions.test.js` was already failing before this phase (a `PAGE_LIST` mismatch). This phase did not touch it.
- Not yet verified: a real end-to-end run with a live model (LM Studio or NVIDIA) and a connected Gmail account.
- Known follow-ups: approvals stored in Postgres; the agents router and the integrations router each create their own `IntegrationManager`, so token refreshes are not serialized across the two.

## Out of scope (later phases)

- Scheduled or event-triggered runs (04.2), the workflow engine (04.3), agent memory (04.4).
- Computer and browser control inside agent runs. These stay chat-only for now because they act on the server's own desktop.
- Postgres storage for approvals.
