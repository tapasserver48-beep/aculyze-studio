/**
 * AculyzeLMSProvider — API-key integration with an Aculyze LMS instance.
 *
 * Zara NEVER touches the LMS database: every call goes through the LMS's own
 * HTTP API using the stored key (server-side, encrypted, shown masked only).
 * The base URL + key come from the user (like the Sales plugin) — nothing is
 * hard-coded. Resources the LMS doesn't expose answer with a clear HTTP 404
 * message rather than fabricated data (§7).
 *
 * Spec §8 endpoints:
 *   GET /sales
 *   GET /sales/summary
 *   GET /customers
 *   GET /leads
 *   GET /employees
 *   GET /lms/summary
 *
 * Base URL is normalized (trailing slash removed) before appending paths.
 *
 * ALL HTTP transport, auth, error mapping, pagination and envelope
 * normalization live in the single shared client: src/lms/client.js.
 * This adapter only maps tool ids → paths and formats payloads for chat.
 */
const { IntegrationError } = require('./base');
const { lmsRequest, verifyConnection } = require('../../lms/client');

const PATHS = {
  'sales.getSales': '/sales',
  'sales.getSummary': '/sales/summary',
  'customers.search': '/customers',
  'leads.getLeads': '/leads',
  'employees.getEmployees': '/employees',
  'lms.getSummary': '/lms/summary',
};

const PERMISSIONS = [
  'sales:read',
  'customers:read',
  'leads:read',
  'employees:read',
  'lms:read',
  'reports:read',
];

function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 12) return '••••••••••••';
  return `${k.slice(0, 7)}${'•'.repeat(12)}${k.slice(-4)}`;
}

function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) return '';
  // Remove trailing slash to prevent double slashes when appending paths
  return String(baseUrl).replace(/\/+$/, '');
}

// ---- response → chat-friendly text + source items --------------------------

/** Field order/labels used when picking a record's display title. */
const TITLE_FIELDS = ['company_name', 'name', 'customer', 'proposal_number', 'contact_person', 'company', 'email', 'role', 'title', 'subject', 'stage'];
/** Secondary fields worth showing as item meta (Sources list). */
const META_FIELDS = ['contact_person', 'industry', 'city', 'status', 'temperature', 'stage', 'amount', 'currency', 'role', 'manager', 'telephone', 'mobile', 'email'];
/** Noisy/internal fields never shown to the model. */
const SKIP_FIELDS = /^(id|organization_id|created_by|created_at|updated_at|deleted_at|password|token|api_key|token_hash|token_prefix)$/i;

function pickField(row, fields) {
  for (const f of fields) if (row[f] !== undefined && row[f] !== null && row[f] !== '') return String(row[f]).slice(0, 80);
  return '';
}

function itemMeta(row) {
  const bits = [];
  for (const f of META_FIELDS) {
    if (row[f] !== undefined && row[f] !== null && row[f] !== '' && typeof row[f] !== 'object') {
      bits.push(`${f === 'amount' ? '₹' + row[f] : String(row[f]).slice(0, 40)}`);
    }
    if (bits.length >= 2) break;
  }
  return bits.join(' · ');
}

const PATH_LABELS = {
  '/sales': 'Sales', '/sales/summary': 'Sales summary', '/customers': 'Customers',
  '/leads': 'Leads', '/employees': 'Employees', '/lms/summary': 'LMS summary',
};

/**
 * Turn the LMS JSON envelope ({success, data, pagination}) into dense
 * `field: value` lines a small model can actually read, plus Sources items
 * carrying real record names. Never echoes the API key.
 */
function formatPayload(path, raw, key) {
  const scrub = (s) => String(s || '').split(String(key || '')).join('•••');
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* plain text */ }

  if (!parsed || parsed === null) {
    return { text: scrub(raw).slice(0, 6000), items: [{ title: PATH_LABELS[path] || path, meta: 'response' }], count: 1 };
  }

  const rows = Array.isArray(parsed) ? parsed
    : (parsed && Array.isArray(parsed.data) ? parsed.data : null);

  // Object payloads (e.g. /sales/summary) → pretty JSON (small) + headline meta.
  if (!rows) {
    const headline = pickField(parsed && parsed.summary ? parsed.summary : parsed, ['total_sales', 'currency', 'orders']);
    return {
      text: scrub(JSON.stringify(parsed, null, 1)).slice(0, 6000),
      items: [{ title: PATH_LABELS[path] || path, meta: headline }],
      count: 1,
    };
  }

  if (!rows.length) {
    return {
      text: `${PATH_LABELS[path] || path} — 0 records: the search returned no matching customers. Say plainly that nothing matched — do not invent records.`,
      items: [],
      count: 0,
    };
  }

  const lines = rows.map((row, i) => {
    if (!row || typeof row !== 'object') return `${i + 1}. ${String(row).slice(0, 120)}`;
    const bits = [];
    for (const [k, v] of Object.entries(row)) {
      if (v === null || v === undefined || v === '') continue;
      if (SKIP_FIELDS.test(k)) continue;
      if (typeof v === 'object') continue;
      const vs = String(v);
      if (vs.length > 90) continue;
      bits.push(`${k}: ${vs}`);
    }
    return `${i + 1}. ${bits.join(' | ')}`;
  });

  const pag = parsed.pagination
    ? `\n(page ${parsed.pagination.current_page} of ${parsed.pagination.last_page} — ${parsed.pagination.total} total in the LMS)`
    : '';
  const text = `${PATH_LABELS[path] || path} — ${rows.length} record(s):${pag}\n${lines.join('\n')}`;

  const items = rows.slice(0, 5).map((row) => ({
    title: (row && typeof row === 'object' ? pickField(row, TITLE_FIELDS) : '') || `#${row && row.id != null ? row.id : ''}`.trim(),
    meta: row && typeof row === 'object' ? itemMeta(row) : '',
  })).filter((it) => it.title && it.title !== '#');

  const label = (PATH_LABELS[path] || path).toLowerCase();
  return { text: scrub(text).slice(0, 6000), items, count: rows.length, summary: `${rows.length} ${label} records loaded` };
}

class AculyzeLMSProvider {
  constructor(env = process.env) {
    this.id = 'aculyze-lms';
    this.defaultBase = env.ACULYZE_LMS_BASE_URL || '';
  }

  // API-key connections are "configured" by definition — the user supplies
  // the credentials in Settings (they are never hard-coded).
  get configured() { return true; }

  scopesFor() { return []; }

  permissionsFromScopes() {
    return PERMISSIONS;
  }

  headers(conn) {
    const key = conn.__key;
    return {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json, text/plain, */*',
    };
  }

  /** Health check via GET /lms/summary through the shared LMS client. */
  async test(conn) {
    const v = await verifyConnection({ baseUrl: conn.baseUrl, apiKey: conn.__key, timeoutMs: 12000 });
    return {
      ok: v.ok,
      ms: v.ms,
      status: v.status,
      category: v.category,
      label: v.label,
      detail: v.detail || v.label,
    };
  }

  async fetchAccount(conn) {
    const host = (() => { try { return new URL(conn.baseUrl).hostname; } catch { return ''; } })();
    return host ? `Aculyze LMS · ${host}` : 'Aculyze LMS';
  }

  async call(toolId, conn, args, key) {
    const path = PATHS[toolId];
    if (!path) throw new IntegrationError(`Tool ${toolId} is not available.`, { code: 'unsupported' });
    const base = normalizeBaseUrl(conn.baseUrl);
    if (!base) throw new IntegrationError('Your Aculyze LMS connection has no base URL.', { code: 'not_connected' });
    let r;
    try {
      r = await lmsRequest(path, { baseUrl: base, apiKey: key, query: args || {} });
    } catch (err) {
      if (err && (err.category === 'invalid_key' || err.category === 'not_connected')) {
        err.message = `${err.message} Update it in Apps → Aculyze LMS.`;
      }
      throw err;
    }
    return formatPayload(path, r.text, key);
  }

  async prepareWrite() {
    throw new IntegrationError('Aculyze LMS is read-only in Zara — write operations are not supported.', { code: 'unsupported' });
  }
}

module.exports = { AculyzeLMSProvider, maskKey, LMS_PATHS: PATHS };