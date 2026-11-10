/**
 * App catalog — the single source of truth for Apps & Integrations.
 *
 * The frontend receives this catalog from `GET /api/integrations` and renders
 * it verbatim; it contains NO provider logic. Apps that are architected but
 * not yet implemented are listed with state 'soon' and shown as "Coming soon"
 * — never as fake working integrations.
 *
 * `permissions` follow the spec's permission model (§16): each app declares
 * permission ids + human labels; only tools whose required permissions are
 * granted on the connection become available to the assistant.
 */

const CATEGORIES = [
  { id: 'work', label: 'Work & Communication' },
  { id: 'productivity', label: 'Productivity' },
  { id: 'creative', label: 'Creative' },
  { id: 'crm', label: 'CRM & Sales' },
  { id: 'erp', label: 'Business & ERP' },
  { id: 'aculyze', label: 'Aculyze' },
];

const P = (id, label) => ({ id, label });

const APPS = [
  // ---------------- WORK & COMMUNICATION ----------------
  {
    id: 'gmail', name: 'Gmail', icon: '✉️', category: 'work', state: 'ready', featured: true,
    provider: 'google', auth: 'oauth', connectLabel: 'Continue with Google',
    desc: 'Read and work with your Gmail messages through Zara.',
    permissions: [P('READ_EMAIL', 'Read mail'), P('CREATE_DRAFT', 'Create drafts'), P('SEND_EMAIL', 'Send mail when you approve')],
    consent: ['Search your emails', 'Read authorized email content', 'Create drafts', 'Send emails when you approve'],
    tools: ['gmail.search', 'gmail.get_message', 'gmail.create_draft', 'gmail.send_message'],
  },
  {
    id: 'gcal', name: 'Google Calendar', icon: '📅', category: 'work', state: 'ready',
    provider: 'google', auth: 'oauth', connectLabel: 'Continue with Google',
    desc: 'See, search and schedule events on your Google Calendar.',
    permissions: [P('READ_CALENDAR', 'Read events'), P('CREATE_EVENT', 'Create events when you ask'), P('UPDATE_EVENT', 'Update events when you ask')],
    consent: ['See your calendar events', 'Search your schedule', 'Create events when you ask', 'Update events when you ask'],
    tools: ['calendar.list_events', 'calendar.search_events', 'calendar.create_event', 'calendar.update_event'],
  },
  {
    id: 'gdrive', name: 'Google Drive', icon: '📁', category: 'work', state: 'ready', featured: true,
    provider: 'google', auth: 'oauth', connectLabel: 'Continue with Google',
    desc: 'Find and read files stored in your Google Drive.',
    permissions: [P('READ_FILES', 'Search & read files')],
    consent: ['Search your Drive files', 'Read file details', 'Read supported document content'],
    tools: ['drive.search_files', 'drive.get_file'],
  },
  {
    id: 'gdocs', name: 'Google Docs', icon: '📄', category: 'work', state: 'ready',
    provider: 'google', auth: 'oauth', connectLabel: 'Continue with Google',
    desc: 'Read Google Docs documents when you ask for them.',
    permissions: [P('READ_DOCS', 'Read documents')],
    consent: ['Read Google Docs you authorize', 'Extract document text'],
    tools: ['docs.get_document'],
  },
  {
    id: 'gsheets', name: 'Google Sheets', icon: '📊', category: 'work', state: 'ready',
    provider: 'google', auth: 'oauth', connectLabel: 'Continue with Google',
    desc: 'Read spreadsheet data from Google Sheets.',
    permissions: [P('READ_SHEETS', 'Read spreadsheets')],
    consent: ['Read Google Sheets you authorize', 'Read cell values'],
    tools: ['sheets.get_values'],
  },
  {
    id: 'gmeet', name: 'Google Meet', icon: '🎥', category: 'work', state: 'soon',
    desc: 'Google Meet meeting information — coming soon (calendar meeting details already work).',
    permissions: [P('READ_MEETINGS', 'Read meeting info')],
    consent: ['Read your Meet meeting information'],
    tools: [],
  },
  {
    id: 'gchat', name: 'Google Chat', icon: '💬', category: 'work', state: 'soon',
    desc: 'Google Chat spaces and messages — coming soon.',
    permissions: [P('READ_MESSAGES', 'Read messages')],
    consent: ['Read your Google Chat messages'],
    tools: [],
  },
  {
    id: 'outlook', name: 'Microsoft Outlook', icon: '📮', category: 'work', state: 'ready', featured: true,
    provider: 'microsoft', auth: 'oauth', connectLabel: 'Continue with Microsoft',
    desc: 'Search and work with your Outlook email through Microsoft Graph.',
    permissions: [P('READ_EMAIL', 'Read mail'), P('CREATE_DRAFT', 'Create drafts'), P('SEND_EMAIL', 'Send mail when you approve')],
    consent: ['Search your Outlook email', 'Read authorized messages', 'Create drafts', 'Send emails when you approve'],
    tools: ['outlook.search_mail', 'outlook.get_mail', 'outlook.create_draft', 'outlook.send_mail'],
  },
  {
    id: 'mscal', name: 'Microsoft Calendar', icon: '📆', category: 'work', state: 'ready',
    provider: 'microsoft', auth: 'oauth', connectLabel: 'Continue with Microsoft',
    desc: 'Read, search and schedule events in your Microsoft 365 calendar.',
    permissions: [P('READ_CALENDAR', 'Read events'), P('CREATE_EVENT', 'Create events when you ask'), P('UPDATE_EVENT', 'Update events when you ask')],
    consent: ['See your calendar events', 'Search your schedule', 'Create events when you ask', 'Update events when you ask'],
    tools: ['mscalendar.list_events', 'mscalendar.search_events', 'mscalendar.create_event', 'mscalendar.update_event'],
  },
  {
    id: 'teams', name: 'Microsoft Teams', icon: '👥', category: 'work', state: 'ready', featured: true,
    provider: 'microsoft', auth: 'oauth', connectLabel: 'Continue with Microsoft',
    desc: 'Search Teams chats and messages you have access to.',
    permissions: [P('READ_MESSAGES', 'Read messages'), P('SEND_MESSAGES', 'Send messages when you approve')],
    consent: ['Find your Teams chats', 'Read messages you can access', 'Send messages only after you approve'],
    tools: ['teams.search_messages', 'teams.get_messages', 'teams.send_message'],
  },
  {
    id: 'onedrive', name: 'OneDrive', icon: '☁️', category: 'work', state: 'ready',
    provider: 'microsoft', auth: 'oauth', connectLabel: 'Continue with Microsoft',
    desc: 'Search files and documents in your OneDrive.',
    permissions: [P('READ_FILES', 'Search & read files')],
    consent: ['Search your OneDrive files', 'Read file details and supported documents'],
    tools: ['onedrive.search_files'],
  },
  {
    id: 'sharepoint', name: 'SharePoint', icon: '🔗', category: 'work', state: 'ready',
    provider: 'microsoft', auth: 'oauth', connectLabel: 'Continue with Microsoft',
    desc: 'Search authorized SharePoint sites, files and documents.',
    permissions: [P('READ_SITES', 'Search sites & files')],
    consent: ['Search your accessible SharePoint sites and files', 'Read authorized documents'],
    tools: ['sharepoint.search_files'],
  },
  {
    id: 'excel', name: 'Microsoft Excel', icon: '📈', category: 'work', state: 'soon',
    desc: 'Read workbooks with Microsoft Graph — coming soon.',
    permissions: [P('READ_SHEETS', 'Read workbooks')],
    consent: ['Read Excel workbooks you authorize'],
    tools: [],
  },
  {
    id: 'word', name: 'Microsoft Word', icon: '📝', category: 'work', state: 'soon',
    desc: 'Read Word documents with Microsoft Graph — coming soon.',
    permissions: [P('READ_DOCS', 'Read documents')],
    consent: ['Read Word documents you authorize'],
    tools: [],
  },

  // ---------------- PRODUCTIVITY ----------------
  { id: 'slack', name: 'Slack', icon: '🗨️', category: 'productivity', state: 'soon',
    desc: 'Slack channels and messages — coming soon.', permissions: [P('READ_MESSAGES', 'Read messages')], consent: ['Read your Slack messages'], tools: [] },
  { id: 'notion', name: 'Notion', icon: '🗂', category: 'productivity', state: 'soon',
    desc: 'Notion pages and databases — coming soon.', permissions: [P('READ_PAGES', 'Read pages')], consent: ['Read your Notion pages'], tools: [] },
  { id: 'trello', name: 'Trello', icon: '📋', category: 'productivity', state: 'soon',
    desc: 'Boards, lists and cards — coming soon.', permissions: [P('READ_BOARDS', 'Read boards')], consent: ['Read your Trello boards'], tools: [] },
  { id: 'asana', name: 'Asana', icon: '🎯', category: 'productivity', state: 'soon',
    desc: 'Projects and tasks — coming soon.', permissions: [P('READ_TASKS', 'Read tasks')], consent: ['Read your Asana projects'], tools: [] },
  { id: 'clickup', name: 'ClickUp', icon: '🚀', category: 'productivity', state: 'soon',
    desc: 'Spaces, lists and tasks — coming soon.', permissions: [P('READ_TASKS', 'Read tasks')], consent: ['Read your ClickUp tasks'], tools: [] },
  { id: 'dropbox', name: 'Dropbox', icon: '📦', category: 'productivity', state: 'soon',
    desc: 'Files and folders in Dropbox — coming soon.', permissions: [P('READ_FILES', 'Read files')], consent: ['Read your Dropbox files'], tools: [] },

  // ---------------- CREATIVE ----------------
  {
    id: 'canva', name: 'Canva', icon: '🎨', category: 'creative', state: 'ready',
    provider: 'canva', auth: 'oauth', connectLabel: 'Connect Canva',
    desc: 'Find and open your Canva designs through Zara.',
    permissions: [P('READ_DESIGNS', 'Read design metadata')],
    consent: ['Find your Canva designs', 'Read authorized design details', 'Open designs in Canva'],
    tools: ['canva.search_designs'],
  },

  // ---------------- CRM & SALES ----------------
  { id: 'salesforce', name: 'Salesforce', icon: '☁️', category: 'crm', state: 'soon',
    desc: 'Salesforce CRM data — coming soon.', permissions: [P('READ_CRM', 'Read CRM records')], consent: ['Read your Salesforce records'], tools: [] },
  { id: 'hubspot', name: 'HubSpot', icon: '⚡', category: 'crm', state: 'soon',
    desc: 'HubSpot contacts, deals and tickets — coming soon.', permissions: [P('READ_CRM', 'Read CRM records')], consent: ['Read your HubSpot records'], tools: [] },
  { id: 'zoho', name: 'Zoho CRM', icon: '🧮', category: 'crm', state: 'soon',
    desc: 'Zoho CRM records — coming soon.', permissions: [P('READ_CRM', 'Read CRM records')], consent: ['Read your Zoho records'], tools: [] },

  // ---------------- BUSINESS & ERP ----------------
  { id: 'sap', name: 'SAP', icon: '🏭', category: 'erp', state: 'soon',
    desc: 'SAP data through a native connector — coming soon (use Aculyze Sales AI for API access today).',
    permissions: [P('READ_ERP', 'Read ERP data')], consent: ['Read your SAP data'], tools: [] },
  { id: 'oracle', name: 'Oracle', icon: '🔴', category: 'erp', state: 'soon',
    desc: 'Oracle ERP — coming soon (use Aculyze Sales AI for API access today).',
    permissions: [P('READ_ERP', 'Read ERP data')], consent: ['Read your Oracle data'], tools: [] },
  { id: 'dynamics', name: 'Microsoft Dynamics', icon: '📉', category: 'erp', state: 'soon',
    desc: 'Microsoft Dynamics 365 — coming soon.', permissions: [P('READ_ERP', 'Read ERP data')], consent: ['Read your Dynamics data'], tools: [] },

  // ---------------- ACULYZE ----------------
  {
    id: 'aculyze-lms', name: 'Aculyze LMS', icon: '🎓', category: 'aculyze', state: 'ready', featured: true,
    provider: 'aculyze-lms', auth: 'apikey',
    desc: 'Connect Zara to your Aculyze LMS business data (API key — stored server-side).',
    permissions: [P('sales:read', 'Read sales data'), P('customers:read', 'Read customers'),
      P('leads:read', 'Read leads'), P('employees:read', 'Read employees'), P('lms:read', 'Read LMS summary'), P('reports:read', 'Read reports / summaries')],
    consent: ['Read sales, customers, leads, employees and LMS summary data your LMS exposes', 'Communicate only through the LMS API — never its database'],
    tools: ['sales.getSales', 'sales.getSummary', 'customers.search', 'leads.getLeads', 'employees.getEmployees', 'lms.getSummary'],
  },
  {
    id: 'aculyze-sales', name: 'Aculyze Sales AI', icon: '💼', category: 'aculyze', state: 'ready',
    link: 'sales-detail',
    desc: 'Your SAP/ERP connection — sales orders, customers, revenue and stock.',
    permissions: [P('READ_ERP', 'Read ERP data')], consent: [], tools: [],
  },
  { id: 'aculyze-api', name: 'Aculyze Business API', icon: '⚙️', category: 'aculyze', state: 'soon',
    desc: 'Aculyze Business API — coming soon.', permissions: [P('READ_BUSINESS', 'Read business data')], consent: ['Read your Aculyze business data'], tools: [] },
];

const FEATURED = ['gmail', 'gdrive', 'teams', 'outlook', 'aculyze-lms'];

function getApp(appId) {
  return APPS.find((a) => a.id === appId) || null;
}

module.exports = { CATEGORIES, APPS, FEATURED, getApp };
