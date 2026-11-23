/**
 * Tool policy for AI employee runs (Phase 04.1).
 *
 * An AI employee may call an integration tool only if BOTH hold:
 *   1. the initiating human has that app connected and authorized
 *      (enforced by buildToolSchemas + IntegrationManager.runTool), AND
 *   2. one of the employee's capabilities allows that tool id (this file).
 *
 * The check runs twice: when the tool list is built, and again when a call
 * is executed — the model can never reach a tool it wasn't offered.
 *
 * The built-in task__* tools are always available: they only touch the task
 * being executed.
 */

const { buildToolSchemas, NAME_TO_ID } = require('../agent/schemas');
const { getTool } = require('../integrations/tools');

const EMAIL_READ = ['gmail.search', 'gmail.get_message', 'outlook.search_mail', 'outlook.get_mail'];
const EMAIL_DRAFT = ['gmail.create_draft', 'outlook.create_draft'];
const EMAIL_SEND = ['gmail.send_message', 'outlook.send_mail'];
const CAL_READ = ['calendar.list_events', 'calendar.search_events', 'mscalendar.list_events', 'mscalendar.search_events'];
const CAL_WRITE = ['calendar.create_event', 'calendar.update_event', 'mscalendar.create_event', 'mscalendar.update_event'];
const FILES_READ = ['drive.search_files', 'drive.get_file', 'docs.get_document', 'sheets.get_values', 'onedrive.search_files', 'sharepoint.search_files'];
const TEAMS_READ = ['teams.search_messages', 'teams.get_messages'];
const TEAMS_SEND = ['teams.send_message'];
const LMS_READ = ['sales.getSales', 'sales.getSummary', 'customers.search', 'leads.getLeads', 'employees.getEmployees', 'lms.getSummary'];

/** capability → integration tool ids it unlocks. */
const CAPABILITY_TOOLS = {
  gmail_readwrite: [...EMAIL_READ, ...EMAIL_DRAFT, ...EMAIL_SEND],
  inbox_communication: [...EMAIL_READ, ...EMAIL_DRAFT, ...TEAMS_READ, ...TEAMS_SEND],
  planning: [...CAL_READ, ...FILES_READ],
  delegation: [...CAL_READ, ...CAL_WRITE],
  reporting: [...FILES_READ, ...LMS_READ],
  task_tracking: [...CAL_READ],
  employee_monitoring: ['employees.getEmployees', ...TEAMS_READ],
  employee_oversight: ['employees.getEmployees'],
  website_analysis: [...FILES_READ],
  knowledge_extraction: [...FILES_READ, 'customers.search', 'leads.getLeads'],
  chatbot_development: ['canva.search_designs'],
};

/** Built-in task tools — schema names use `__` like the integration tools. */
const TASK_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'task__report_progress',
      description: 'Record a progress note on the task you are executing.',
      parameters: {
        type: 'object',
        properties: {
          note: { type: 'string', description: 'what you just did or found' },
          percent: { type: 'integer', description: 'estimated completion 0-99' },
        },
        required: ['note'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task__request_info',
      description: 'Stop and ask the requester for information you cannot find with your tools. Use only when truly blocked.',
      parameters: {
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task__submit_result',
      description: 'Finish the task: submit your final deliverable for human review. Always end with this.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'one-line summary of the outcome' },
          result: { type: 'string', description: 'the full deliverable (markdown allowed)' },
        },
        required: ['summary', 'result'],
      },
    },
  },
];
/**
 * Internal "people" tools (Phase 04.2): reach colleagues inside Aculyze.
 * No external app is touched, so no approval step; every use is logged on
 * the task. Offered only to employees whose capabilities allow it.
 */
const PEOPLE_TOOLS = [
  {
    caps: ['inbox_communication', 'task_assignment', 'delegation', 'employee_monitoring', 'task_management'],
    schema: {
      type: 'function',
      function: {
        name: 'task__notify_person',
        description: 'Send an Inbox message to a colleague in the company (by name or email from the people list).',
        parameters: {
          type: 'object',
          properties: {
            person: { type: 'string', description: 'colleague name or email, exactly as in the people list' },
            message: { type: 'string', description: 'the message (plain text or light markdown)' },
          },
          required: ['person', 'message'],
        },
      },
    },
  },
  {
    caps: ['task_assignment', 'delegation', 'task_management'],
    schema: {
      type: 'function',
      function: {
        name: 'task__create_followup',
        description: 'Create a follow-up task for a colleague (a person, not an AI employee).',
        parameters: {
          type: 'object',
          properties: {
            person: { type: 'string', description: 'colleague name or email from the people list' },
            title: { type: 'string', description: 'short imperative title' },
            details: { type: 'string', description: 'what to do and why' },
            due_in_days: { type: 'integer', description: 'days from today, 0-30' },
          },
          required: ['person', 'title'],
        },
      },
    },
  },
];

const TASK_TOOL_NAMES = new Set([...TASK_TOOLS, ...PEOPLE_TOOLS.map((p) => p.schema)].map((t) => t.function.name));

/** People tools this employee may use. */
function peopleToolsFor(employee) {
  const caps = new Set((employee && employee.capabilities) || []);
  return PEOPLE_TOOLS.filter((p) => p.caps.some((c) => caps.has(c))).map((p) => p.schema);
}

/** Integration tool ids this employee's capabilities allow. */
function allowedToolIds(employee) {
  const out = new Set();
  for (const cap of (employee && employee.capabilities) || []) {
    for (const id of CAPABILITY_TOOLS[cap] || []) out.add(id);
  }
  return out;
}

/** Is this integration tool id allowed for this employee? (execution-time check) */
function isAllowed(employee, toolId) {
  return !!getTool(toolId) && allowedToolIds(employee).has(toolId);
}

/**
 * Tool schemas offered to the model: connected+authorized for the user,
 * filtered by the employee's capabilities, plus the built-in task tools.
 */
function buildEmployeeTools(employee, connectedViews) {
  const allowed = allowedToolIds(employee);
  const integration = buildToolSchemas(connectedViews).filter((s) => allowed.has(NAME_TO_ID.get(s.function.name)));
  return [...integration, ...TASK_TOOLS, ...peopleToolsFor(employee)];
}

module.exports = {
  CAPABILITY_TOOLS,
  TASK_TOOLS,
  TASK_TOOL_NAMES,
  peopleToolsFor,
  allowedToolIds,
  isAllowed,
  buildEmployeeTools,
};
