/**
 * Zara tool system (§9) — the catalog of tools the assistant may call.
 *
 * A tool only becomes available when:
 *   1. its app is connected (per-user OAuth / API key), AND
 *   2. every permission in `requires` was granted on that connection.
 *
 * Execution lives in each provider adapter (provider-specific logic stays on
 * the backend — the frontend never sees a provider call). `kind: 'write'`
 * tools always require an explicit user confirmation before they run.
 */

const TOOLS = {
  // ---- Gmail (Google) ----
  'gmail.search': { app: 'gmail', kind: 'read', requires: ['READ_EMAIL'], unit: 'emails',
    progress: 'Searching your inbox…', done: 'relevant emails' },
  'gmail.get_message': { app: 'gmail', kind: 'read', requires: ['READ_EMAIL'], unit: 'message',
    progress: 'Reading the email…', done: 'email loaded' },
  'gmail.create_draft': { app: 'gmail', kind: 'write', requires: ['CREATE_DRAFT'], unit: 'draft',
    progress: 'Creating the draft…', done: 'Draft created', verb: 'Create draft' },
  'gmail.send_message': { app: 'gmail', kind: 'write', requires: ['SEND_EMAIL'], unit: 'email',
    progress: 'Sending the email…', done: 'Email sent', verb: 'Send' },

  // ---- Google Calendar ----
  'calendar.list_events': { app: 'gcal', kind: 'read', requires: ['READ_CALENDAR'], unit: 'events',
    progress: 'Checking your calendar…', done: 'events found' },
  'calendar.search_events': { app: 'gcal', kind: 'read', requires: ['READ_CALENDAR'], unit: 'events',
    progress: 'Searching your calendar…', done: 'events found' },
  'calendar.create_event': { app: 'gcal', kind: 'write', requires: ['CREATE_EVENT'], unit: 'event',
    progress: 'Creating the event…', done: 'Event created', verb: 'Create event' },
  'calendar.update_event': { app: 'gcal', kind: 'write', requires: ['UPDATE_EVENT'], unit: 'event',
    progress: 'Updating the event…', done: 'Event updated', verb: 'Update event' },

  // ---- Google Drive / Docs / Sheets ----
  'drive.search_files': { app: 'gdrive', kind: 'read', requires: ['READ_FILES'], unit: 'files',
    progress: 'Searching your Drive…', done: 'files found' },
  'drive.get_file': { app: 'gdrive', kind: 'read', requires: ['READ_FILES'], unit: 'file',
    progress: 'Opening the file…', done: 'file loaded' },
  'docs.get_document': { app: 'gdocs', kind: 'read', requires: ['READ_DOCS'], unit: 'document',
    progress: 'Reading the document…', done: 'document loaded' },
  'sheets.get_values': { app: 'gsheets', kind: 'read', requires: ['READ_SHEETS'], unit: 'spreadsheet',
    progress: 'Reading the spreadsheet…', done: 'spreadsheet loaded' },

  // ---- Microsoft 365 (Graph) ----
  'outlook.search_mail': { app: 'outlook', kind: 'read', requires: ['READ_EMAIL'], unit: 'emails',
    progress: 'Searching your mailbox…', done: 'relevant emails' },
  'outlook.get_mail': { app: 'outlook', kind: 'read', requires: ['READ_EMAIL'], unit: 'message',
    progress: 'Reading the email…', done: 'email loaded' },
  'outlook.create_draft': { app: 'outlook', kind: 'write', requires: ['CREATE_DRAFT'], unit: 'draft',
    progress: 'Creating the draft…', done: 'Draft created', verb: 'Create draft' },
  'outlook.send_mail': { app: 'outlook', kind: 'write', requires: ['SEND_EMAIL'], unit: 'email',
    progress: 'Sending the email…', done: 'Email sent', verb: 'Send' },

  'mscalendar.list_events': { app: 'mscal', kind: 'read', requires: ['READ_CALENDAR'], unit: 'events',
    progress: 'Checking your calendar…', done: 'events found' },
  'mscalendar.search_events': { app: 'mscal', kind: 'read', requires: ['READ_CALENDAR'], unit: 'events',
    progress: 'Searching your calendar…', done: 'events found' },
  'mscalendar.create_event': { app: 'mscal', kind: 'write', requires: ['CREATE_EVENT'], unit: 'event',
    progress: 'Creating the event…', done: 'Event created', verb: 'Create event' },
  'mscalendar.update_event': { app: 'mscal', kind: 'write', requires: ['UPDATE_EVENT'], unit: 'event',
    progress: 'Updating the event…', done: 'Event updated', verb: 'Update event' },

  'teams.search_messages': { app: 'teams', kind: 'read', requires: ['READ_MESSAGES'], unit: 'messages',
    progress: 'Searching Teams conversations…', done: 'messages found' },
  'teams.get_messages': { app: 'teams', kind: 'read', requires: ['READ_MESSAGES'], unit: 'messages',
    progress: 'Reading Teams messages…', done: 'messages found' },
  'teams.send_message': { app: 'teams', kind: 'write', requires: ['SEND_MESSAGES'], unit: 'message',
    progress: 'Sending the Teams message…', done: 'Message sent', verb: 'Send message' },

  'onedrive.search_files': { app: 'onedrive', kind: 'read', requires: ['READ_FILES'], unit: 'files',
    progress: 'Searching OneDrive…', done: 'files found' },
  'sharepoint.search_files': { app: 'sharepoint', kind: 'read', requires: ['READ_SITES'], unit: 'items',
    progress: 'Searching SharePoint…', done: 'items found' },

  // ---- Canva ----
  'canva.search_designs': { app: 'canva', kind: 'read', requires: ['READ_DESIGNS'], unit: 'designs',
    progress: 'Looking for your Canva designs…', done: 'designs found' },

  // ---- Aculyze LMS (per spec §8) ----
  'sales.getSales': { app: 'aculyze-lms', kind: 'read', requires: ['sales:read'], unit: 'records',
    progress: 'Fetching sales data…', done: 'sales records' },
  'sales.getSummary': { app: 'aculyze-lms', kind: 'read', requires: ['sales:read'], unit: 'summary',
    progress: 'Fetching sales summary…', done: 'sales summary' },
  'customers.search': { app: 'aculyze-lms', kind: 'read', requires: ['customers:read'], unit: 'customers',
    progress: 'Searching customers…', done: 'customers' },
  'leads.getLeads': { app: 'aculyze-lms', kind: 'read', requires: ['leads:read'], unit: 'leads',
    progress: 'Fetching leads…', done: 'leads' },
  'employees.getEmployees': { app: 'aculyze-lms', kind: 'read', requires: ['employees:read'], unit: 'employees',
    progress: 'Fetching employees…', done: 'employees' },
  'lms.getSummary': { app: 'aculyze-lms', kind: 'read', requires: ['lms:read'], unit: 'summary',
    progress: 'Fetching LMS summary…', done: 'LMS summary' },
};

function getTool(toolId) {
  return TOOLS[toolId] || null;
}

module.exports = { TOOLS, getTool };
