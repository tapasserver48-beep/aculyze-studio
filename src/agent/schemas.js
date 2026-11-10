/**
 * OpenAI function-calling schemas for the Zara tool catalog (Tier 2).
 *
 * One schema per tool in src/integrations/tools.js, filtered at runtime by:
 *   1. the app is connected for this user, AND
 *   2. every permission in `requires` was granted (same gate as runTool —
 *      runTool re-checks, so a schema slip can never execute something the
 *      user didn't authorize).
 *
 * Tool names use `__` instead of `.` because some backends reject dots in
 * function names; `schemaName ↔ toolId` maps are provided both ways.
 */
const { TOOLS } = require('../integrations/tools');
const { getApp } = require('../integrations/catalog');

// ---- parameter schemas (match what the provider adapters read) ----
const PARAMS = {
  'gmail.search': { q: { type: 'string', description: 'Gmail search query, e.g. "from:boss subject:invoice newer_than:7d"' }, max: { type: 'integer', description: 'max results (1-8)' } },
  'gmail.get_message': { id: { type: 'string', description: 'Gmail message id from gmail.search' } },
  'gmail.create_draft': { to: { type: 'string', description: 'recipient email' }, subject: { type: 'string' }, body: { type: 'string' } },
  'gmail.send_message': { to: { type: 'string', description: 'recipient email' }, subject: { type: 'string' }, body: { type: 'string' } },
  'calendar.list_events': { from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD' }, max: { type: 'integer' } },
  'calendar.search_events': { q: { type: 'string' }, from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD' }, max: { type: 'integer' } },
  'calendar.create_event': { summary: { type: 'string' }, start: { type: 'string', description: 'ISO datetime' }, end: { type: 'string', description: 'ISO datetime' }, description: { type: 'string' } },
  'calendar.update_event': { id: { type: 'string' }, summary: { type: 'string' }, start: { type: 'string', description: 'ISO datetime' }, end: { type: 'string', description: 'ISO datetime' }, description: { type: 'string' } },
  'drive.search_files': { q: { type: 'string', description: 'file name / full-text query' }, max: { type: 'integer' } },
  'drive.get_file': { id: { type: 'string', description: 'file id from drive.search_files' } },
  'docs.get_document': { id: { type: 'string', description: 'Google Doc id' } },
  'sheets.get_values': { id: { type: 'string', description: 'spreadsheet id' }, range: { type: 'string', description: 'A1 range, default A1:Z60' } },
  'outlook.search_mail': { q: { type: 'string' }, max: { type: 'integer' } },
  'outlook.get_mail': { id: { type: 'string' } },
  'outlook.create_draft': { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } },
  'outlook.send_mail': { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } },
  'mscalendar.list_events': { from: { type: 'string' }, to: { type: 'string' }, max: { type: 'integer' } },
  'mscalendar.search_events': { q: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, max: { type: 'integer' } },
  'mscalendar.create_event': { summary: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, description: { type: 'string' } },
  'mscalendar.update_event': { id: { type: 'string' }, summary: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' } },
  'teams.search_messages': { q: { type: 'string' }, max: { type: 'integer' } },
  'teams.get_messages': { q: { type: 'string', description: 'chat to resolve (chatQuery)' }, max: { type: 'integer' } },
  'teams.send_message': { chatQuery: { type: 'string', description: 'chat/channel name or title to resolve' }, text: { type: 'string', description: 'message text to send' } },
  'onedrive.search_files': { q: { type: 'string' }, max: { type: 'integer' } },
  'sharepoint.search_files': { q: { type: 'string' }, max: { type: 'integer' } },
  'canva.search_designs': { q: { type: 'string' }, max: { type: 'integer' } },
  'sales.getSales': { page: { type: 'integer' }, per_page: { type: 'integer', description: 'max 100' }, date_from: { type: 'string', description: 'YYYY-MM-DD' }, date_to: { type: 'string', description: 'YYYY-MM-DD' }, status: { type: 'string' } },
  'sales.getSummary': { date_from: { type: 'string' }, date_to: { type: 'string' }, status: { type: 'string' } },
  'customers.search': { q: { type: 'string', description: 'name/city/industry search' }, page: { type: 'integer' }, per_page: { type: 'integer' } },
  'leads.getLeads': { q: { type: 'string' }, status: { type: 'string' }, stage: { type: 'string' }, temperature: { type: 'string' }, assignee: { type: 'string' }, page: { type: 'integer' }, per_page: { type: 'integer' } },
  'employees.getEmployees': { role: { type: 'string' }, page: { type: 'integer' }, per_page: { type: 'integer' } },
  'lms.getSummary': { date_from: { type: 'string' }, date_to: { type: 'string' } },
};

// ---- human descriptions (what the model needs to pick the right tool) ----
const DESCRIPTIONS = {
  'gmail.search': 'Search the Gmail inbox (threads, senders, subjects).',
  'gmail.get_message': 'Read the full content of one Gmail message by id.',
  'gmail.create_draft': 'Create a Gmail draft (does NOT send).',
  'gmail.send_message': 'Send an email via Gmail. Requires user confirmation.',
  'calendar.list_events': 'List Google Calendar events in a date window.',
  'calendar.search_events': 'Search Google Calendar events by keyword + window.',
  'calendar.create_event': 'Create a Google Calendar event. Requires user confirmation.',
  'calendar.update_event': 'Update an existing Google Calendar event. Requires user confirmation.',
  'drive.search_files': 'Search Google Drive files by name/full text.',
  'drive.get_file': 'Open one Drive file (metadata + text when available).',
  'docs.get_document': 'Read a Google Doc by id.',
  'sheets.get_values': 'Read cell values from a Google Sheet.',
  'outlook.search_mail': 'Search the Outlook mailbox.',
  'outlook.get_mail': 'Read one Outlook message by id.',
  'outlook.create_draft': 'Create an Outlook draft (does NOT send).',
  'outlook.send_mail': 'Send an email via Outlook. Requires user confirmation.',
  'mscalendar.list_events': 'List Outlook calendar events in a window.',
  'mscalendar.search_events': 'Search Outlook calendar events.',
  'mscalendar.create_event': 'Create an Outlook calendar event. Requires user confirmation.',
  'mscalendar.update_event': 'Update an Outlook calendar event. Requires user confirmation.',
  'teams.search_messages': 'Search Microsoft Teams messages.',
  'teams.get_messages': 'Read messages from a Teams chat.',
  'teams.send_message': 'Send a Teams message. Requires user confirmation.',
  'onedrive.search_files': 'Search OneDrive files.',
  'sharepoint.search_files': 'Search SharePoint files.',
  'canva.search_designs': 'Search Canva designs.',
  'sales.getSales': 'Fetch sales records from Aculyze LMS (live ERP data).',
  'sales.getSummary': 'Fetch sales summary/aggregates from Aculyze LMS.',
  'customers.search': 'Search customers in Aculyze LMS.',
  'leads.getLeads': 'Fetch leads pipeline from Aculyze LMS.',
  'employees.getEmployees': 'Fetch employees from Aculyze LMS.',
  'lms.getSummary': 'Fetch overall Aculyze LMS business summary.',
};

const NAME_TO_ID = new Map(); // schemaName (dots → __) → toolId
const ID_TO_NAME = new Map(); // toolId → schemaName

for (const id of Object.keys(TOOLS)) {
  const name = id.replace(/\./g, '__');
  NAME_TO_ID.set(name, id);
  ID_TO_NAME.set(id, name);
}

/** Build the filtered OpenAI `tools` array for a user's connected apps. */
function buildToolSchemas(connectedViews) {
  const connected = new Map((connectedViews || []).map((v) => [v.id, v]));
  const out = [];
  for (const [id, def] of Object.entries(TOOLS)) {
    const view = connected.get(def.app);
    if (!view || view.status !== 'connected') continue;
    // Permission gate: every required permission must be granted.
    // (Env-key API apps report granted via the catalog — runTool re-checks.)
    const granted = new Set(view.granted || []);
    const appDef = getApp(def.app);
    const envBacked = appDef && appDef.auth === 'apikey' && view.hasKey;
    if (!envBacked && def.requires.some((p) => !granted.has(p))) continue;

    const name = ID_TO_NAME.get(id);
    out.push({
      type: 'function',
      function: {
        name,
        description: DESCRIPTIONS[id] || `${def.progress || id} (${def.done || 'done'})`,
        parameters: {
          type: 'object',
          properties: PARAMS[id] || {},
          required: [],
        },
      },
    });
  }
  return out;
}

module.exports = { buildToolSchemas, NAME_TO_ID, ID_TO_NAME };
