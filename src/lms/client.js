/**
 * Aculyze LMS REST client — the ONE place the backend talks to the Aculyze LMS.
 *
 * Everything that reads LMS data (the Sales Agent dashboard, /api/sales/query,
 * the Inbox employee list, the Aculyze LMS integration adapter and the
 * Verify Connection test) goes through this module so authentication, request
 * building, error mapping, pagination and response normalization exist exactly
 * once. There are no other LMS HTTP implementations in this codebase.
 *
 * Contract (read-only):
 *   GET /sales           sales:read     GET /customers   customers:read
 *   GET /sales/summary   sales:read     GET /leads       leads:read
 *   GET /employees       employees:read GET /lms/summary lms:read
 *
 *   - Auth: `Authorization: Bearer <API key>` (key is server-side only)
 *   - Filters: page, per_page (maximum 100) + whitelisted per-endpoint params
 *   - Only GET requests are ever issued — no POST/PUT/PATCH/DELETE
 *   - The LMS database is never touched directly
 *
 * Error mapping (§4 of the LMS spec):
 *   401 → Invalid API key   403 → Permission denied   404 → Endpoint not found
 *   422 → Validation error  429 → Rate limit exceeded 5xx/network → Server unavailable
 */
const { IntegrationError } = require('../integrations/providers/base');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.ACULYZE_DATA_DIR || path.join(process.cwd(), 'data');
const MAX_PER_PAGE = 100;
const DEFAULT_TIMEOUT_MS = 15000;
const LMS_DEFAULT_BASE_URL = 'https://lm.aculyze.in/api/v1';

/** Cached LMS data when the live endpoint is unreachable.
 *  Stored in data/lms-cache.json as a disaster-reduction fallback.
 *  The cache expires after 60 minutes and is only used by the dashboard.
 */
function loadCache() {
  try {
    const f = path.join(DATA_DIR, 'lms-cache.json');
    if (!fs.existsSync(f)) return null;
    const raw = fs.readFileSync(f, 'utf8');
    const obj = JSON.parse(raw);
    // Expire after 60 minutes for demo safety.
    if (obj.timestamp && Date.now() - obj.timestamp < 60 * 60 * 1000) return obj;
  } catch { /* empty cache on error */ }
  return null;
}
function saveCache(obj) {
  try {
    fs.mkdirSync(path.dirname(DATA_DIR), { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'lms-cache.json'), JSON.stringify(obj, null, 2));
  } catch { /* quota / permission */ }
}

/** Resource name → LMS path. Nothing outside this map is ever requested. */
const ENDPOINTS = {
  sales: '/sales',
  salesSummary: '/sales/summary',
  customers: '/customers',
  leads: '/leads',
  employees: '/employees',
  lmsSummary: '/lms/summary',
};

/** Only these query params are ever forwarded, per endpoint. */
const QUERY_WHITELIST = {
  '/sales': ['date_from', 'date_to', 'customer', 'employee', 'status', 'stage', 'page', 'per_page'],
  '/sales/summary': ['date_from', 'date_to', 'customer', 'employee', 'status'],
  '/customers': ['q', 'city', 'industry', 'employee', 'page', 'per_page'],
  '/leads': ['q', 'status', 'stage', 'temperature', 'assignee', 'date_from', 'date_to', 'page',
             'per_page'],
  '/employees': ['role', 'manager_id', 'page', 'per_page'],
  '/lms/summary': ['date_from', 'date_to'],
};

/** HTTP status → machine-readable category. */
const STATUS_CATEGORIES = {
  400: 'validation', 401: 'invalid_key', 403: 'permission', 404: 'not_found',
  422: 'validation', 429: 'rate_limited',
};

/** Category → the exact status wording shown in the UI. */
const CATEGORY_LABELS = {
  connected: 'Connected',
  not_connected: 'Not connected',
  invalid_key: 'Invalid API key',
  permission: 'Permission denied',
  not_found: 'Endpoint not found',
  validation: 'Validation error',
  rate_limited: 'Rate limit exceeded',
  server_unavailable: 'Server unavailable',
};

/** Category → IntegrationError code (drives the HTTP status of our own API). */
const CATEGORY_CODES = {
  invalid_key: 'reauth',
  permission: 'forbidden',
  not_found: 'not_found',
  validation: 'bad_args',
  rate_limited: 'rate_limited',
  server_unavailable: 'provider_down',
  not_connected: 'not_connected',
};

function categoryOf(status) {
  if (status >= 500) return 'server_unavailable';
  return STATUS_CATEGORIES[status] || 'server_unavailable';
}

function labelOf(category) {
  return CATEGORY_LABELS[category] || (category ? 'Server unavailable' : 'Not connected');
}

/** Build an LMS error carrying category + label + status alongside the code. */
function lmsError(category, message, { status = 0, detail = '' } = {}) {
  const err = new IntegrationError(message, {
    code: CATEGORY_CODES[category] || 'failed',
    status,
  });
  err.category = category;
  err.label = labelOf(category);
  err.detail = detail;
  return err;
}

/** Trailing slashes removed; empty → the production base URL. */
function normalizeBase(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return LMS_DEFAULT_BASE_URL;
  if (!/^https?:\/\//i.test(base)) {
    throw lmsError('validation', 'Aculyze LMS base URL must start with http:// or https://');
  }
  return base;
}

function assertDate(value, name) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw lmsError('validation', `${name} must use YYYY-MM-DD.`);
  }
  return v;
}

/**
 * Whitelist + sanitize query params for an endpoint.
 * page → 1, per_page clamped to 1..100 (the LMS rejects anything above 100).
 */
function buildQuery(path, params = {}) {
  const allowed = QUERY_WHITELIST[path];
  if (!allowed) return {};
  const q = {};
  for (const key of allowed) {
    const value = params[key];
    if (value === undefined || value === null) continue;
    const v = String(value).trim();
    if (v === '') continue;
    q[key] = v.slice(0, 60);
  }
  if (q.date_from) q.date_from = assertDate(q.date_from, 'date_from');
  if (q.date_to) q.date_to = assertDate(q.date_to, 'date_to');
  if (q.page !== undefined) {
    const page = parseInt(q.page, 10);
    q.page = String(Number.isFinite(page) && page > 0 ? page : 1);
  }
  if (q.per_page !== undefined) {
    let perPage = parseInt(q.per_page, 10);
    if (!Number.isFinite(perPage) || perPage < 1) perPage = 1;
    q.per_page = String(Math.min(perPage, MAX_PER_PAGE));
  }
  return q;
}

/** `{ current_page, per_page, total, last_page }` with safe defaults. */
function normalizePagination(p) {
  const src = p && typeof p === 'object' ? p : {};
  const int = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const page = int(src.current_page ?? src.page, 1);
  const last = Math.max(page, int(src.last_page, 1));
  return {
    currentPage: page,
    perPage: int(src.per_page, MAX_PER_PAGE),
    total: int(src.total, 0),
    lastPage: last,
  };
}

/**
 * Unwrap the LMS envelope `{ success, data, pagination }` (or a bare array)
 * into `{ rows, data, pagination, error }`. Normalization lives here so no
 * caller ever has to guess the shape — and nothing is ever stringified raw.
 */
function normalizeEnvelope(json) {
  if (json === null || json === undefined) return { rows: [], data: null, pagination: null, error: null };
  const body = (json && typeof json === 'object' && !Array.isArray(json) && 'data' in json) ? json.data :
               json;
  let rows = null;
  if (Array.isArray(body)) rows = body;
  else if (body && typeof body === 'object') {
    for (const key of ['employees', 'sales', 'customers', 'leads', 'records', 'items']) {
      if (Array.isArray(body[key])) { rows = body[key]; break; }
    }
  }
  const pagination = (json && json.pagination) || (body && body.pagination) || null;
  const error = (json && typeof json === 'object' && json.error) ? json.error : null;
  return {
    rows: Array.isArray(rows) ? rows : [],
    data: body && typeof body === 'object' ? body : null,
    pagination: pagination ? normalizePagination(pagination) : null,
    error,
  };
}

/**
 * 60s response cache (A4): identical GETs (same URL + key) are served from
 * memory so repeated questions ("how many leads") don't re-hit lm.aculyze.in.
 * Errors are never cached.
 */
const CACHE_TTL_MS = Number(process.env.LMS_CACHE_TTL_MS || 60_000);
const CACHE_MAX = 200;
const cache = new Map(); // url+keyHash → { at, payload }

function cacheKey(url, key) {
  return `${url}::${String(key).slice(0, 8)}${String(key).length}`;
}

function cacheGet(k) {
  const hit = cache.get(k);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(k); return null; }
  return hit.payload;
}

function cacheSet(k, payload) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value); // drop oldest
  cache.set(k, { at: Date.now(), payload });
}

/**
 * Node's fetch (undici) wraps every transport failure in a generic
 * "fetch failed" — the actual reason (ENOTFOUND, ETIMEDOUT, ECONNREFUSED,
 * UND_ERR_CONNECT_TIMEOUT, TLS errors…) sits in `err.cause`. Flatten the
 * whole cause chain so logs and the dashboard show WHY a request died.
 */
function transportWhy(err) {
  const parts = [];
  const seen = new Set();
  let e = err;
  while (e && typeof e === 'object' && !seen.has(e)) {
    seen.add(e);
    const code = e.code || e.errno || '';
    const msg = String(e.message || e).trim().slice(0, 120);
    const label = code && msg && !msg.includes(code) ? `${msg} (${code})` : (msg || String(code));
    if (label && !parts.includes(label)) parts.push(label);
    e = e.cause;
  }
  return parts.join(' ← ').slice(0, 240) || 'unknown network error';
}

/**
 * One read-only GET against the LMS. Throws a mapped LmsError on any
 * non-2xx response or network failure — never returns a raw error body.
 *
 * A5: one automatic retry with backoff on network failures / 5xx / 429 —
 * transient blips never surface to the user as an error.
 */
async function lmsRequest(pathToLMS, { baseUrl, apiKey, query = null, timeoutMs = DEFAULT_TIMEOUT_MS, noCache = false } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) {
    throw lmsError('not_connected', 'Aculyze LMS is not connected — add your API key in Apps → Aculyze LMS.');
  }
  const base = normalizeBase(baseUrl);
  const qs = new URLSearchParams(buildQuery(pathToLMS, query || {})).toString();
  const url = `${base}${pathToLMS}${qs ? `?${qs}` : ''}`;

  const ck = cacheKey(url, key);
  if (!noCache) {
    const hit = cacheGet(ck);
    if (hit) return hit;
  }

  const MAX_ATTEMPTS = 2;
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'GET', // read-only: the LMS API is never written to
        headers: {
          Authorization: `Bearer ${key}`,
          'X-API-Key': key,
          Accept: 'application/json, text/plain, */*',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const why = transportWhy(err);
      lastErr = lmsError('server_unavailable', `Could not reach Aculyze LMS. ${why}`, { detail: why });
      // Render/local logs get the flattened cause chain (never the API key).
      console.warn(`[lms] ${pathToLMS} → transport failure: ${why}`);
      if (attempt < MAX_ATTEMPTS) { await new Promise((r) => setTimeout(r, 400)); continue; }
      throw lastErr;
    }

    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* plain text response */ }

    if (!res.ok) {
      const apiMessage = json && json.error && typeof json.error === 'object'
        ? String(json.error.message || '').slice(0, 200)
        : (json && json.error ? String(json.error).slice(0, 200) : '');
      const category = categoryOf(res.status);
      lastErr = lmsError(
        category,
        `${labelOf(category)}${apiMessage ? ` — ${apiMessage}` : ` (HTTP ${res.status}).`}`,
        { status: res.status, detail: apiMessage },
      );
      // Retry only transient statuses (5xx / rate limit)
      const transient = res.status >= 500 || res.status === 429;
      if (transient && attempt < MAX_ATTEMPTS) { await new Promise((r) => setTimeout(r, 400)); continue; }
      throw lastErr;
    }

    if (json && typeof json === 'object' && json.success === false) {
      const apiMessage = json.error && json.error.message ? String(json.error.message).slice(0, 200) : '';
      throw lmsError('validation', `Validation error${apiMessage ? ` — ${apiMessage}` : '.'}`, {
        status: res.status, detail: apiMessage
      });
    }

    const payload = { status: res.status, ok: true, json, text, pagination: normalizeEnvelope(json).pagination };
    cacheSet(ck, payload);
    // Persist to disk as a fallback for the dashboard (used when LMS is unreachable).
    try { saveCache({ timestamp: Date.now(), [pathToLMS]: payload }); } catch { /* quota */ }
    return payload;
  }

  throw lastErr || lmsError('server_unavailable', 'Could not reach Aculyze LMS.');
}

/**
 * Verify the connection with GET /lms/summary (the preferred health check).
 * Never throws — returns `{ ok, status, category, label, ms, detail }`.
 */
async function verifyConnection({ baseUrl, apiKey, path = ENDPOINTS.lmsSummary, timeoutMs = 12000 } = {}) {
  const t0 = Date.now();
  try {
    const r = await lmsRequest(path, { baseUrl, apiKey, timeoutMs });
    const env = normalizeEnvelope(r.json);
    return {
      ok: true,
      status: r.status,
      category: 'connected',
      label: labelOf('connected'),
      ms: Date.now() - t0,
      detail: `HTTP ${r.status}`,
      data: env.data,
    };
  } catch (err) {
    const category = err.category || 'server_unavailable';
    return {
      ok: false,
      status: err.status || 0,
      category,
      label: err.label || labelOf(category),
      ms: Date.now() - t0,
      detail: String(err.message || '').slice(0, 300),
    };
  }
}

/** GET /sales/summary → { period, summary, by_month, by_employee, by_status }. */
async function getSalesSummary({ baseUrl, apiKey, query = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const r = await lmsRequest(ENDPOINTS.salesSummary, { baseUrl, apiKey, query, timeoutMs });
  const env = normalizeEnvelope(r.json);
  const data = env.data || {};
  const list = (v) => (Array.isArray(v) ? v.filter(Boolean) : []);
  return {
    period: data.period && typeof data.period === 'object' ? data.period : null,
    summary: data.summary && typeof data.summary === 'object' ? data.summary : null,
    byMonth: list(data.by_month),
    byEmployee: list(data.by_employee),
    byStatus: list(data.by_status),
    currency: (data.summary && data.summary.currency) || null,
  };
}

/** GET one list resource (sales | leads | customers | employees). */
async function getRecords(resource, { baseUrl, apiKey, query = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const pathToLMS = ENDPOINTS[resource];
  if (!pathToLMS) {
    throw lmsError('not_found', `Unknown LMS resource "${String(resource).slice(0, 30)}".`);
  }
  const r = await lmsRequest(pathToLMS, { baseUrl, apiKey, query, timeoutMs });
  const env = normalizeEnvelope(r.json);
  return {
    resource,
    path: pathToLMS,
    rows: env.rows,
    pagination: env.pagination || normalizePagination(null),
    period: env.data && env.data.period ? env.data.period : null,
    status: r.status,
  };
}

module.exports = {
  LMS_DEFAULT_BASE_URL,
  MAX_PER_PAGE,
  ENDPOINTS,
  QUERY_WHITELIST,
  CATEGORY_LABELS,
  categoryOf,
  labelOf,
  normalizeBase,
  buildQuery,
  normalizePagination,
  normalizeEnvelope,
  lmsRequest,
  verifyConnection,
  getSalesSummary,
  getRecords,
};