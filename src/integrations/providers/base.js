/**
 * Shared helpers for provider adapters: HTTP with timeout/retry and
 * friendly (never stack-trace) error mapping per §22.
 */

/** Normalized integration error — `code` drives the UI wording + reconnect flows. */
class IntegrationError extends Error {
  constructor(message, { code = 'failed', status = 0, appId = '' } = {}) {
    super(message);
    this.name = 'IntegrationError';
    this.code = code;
    this.status = status;
    this.appId = appId;
  }
}

function friendly(appName, status, detail = '') {
  const d = String(detail || '');
  if (status === 401 || /invalid_grant|token.*expired|unauthorized/i.test(d)) {
    return new IntegrationError(`${appName} needs to be reconnected.`, { code: 'reauth', status, });
  }
  if (status === 403 || /insufficient scope|forbidden|permission/i.test(d)) {
    return new IntegrationError(`Zara doesn't have permission for that in ${appName}.`, { code: 'forbidden', status });
  }
  if (status === 404) {
    return new IntegrationError(`${appName} couldn't find that resource.`, { code: 'not_found', status });
  }
  if (status === 429) {
    return new IntegrationError(`${appName} is rate-limiting requests — try again in a moment.`, { code: 'rate_limited', status });
  }
  if (status >= 500) {
    return new IntegrationError(`${appName} is having trouble right now (HTTP ${status}).`, { code: 'provider_down', status });
  }
  return new IntegrationError(`${appName} returned an error${status ? ` (HTTP ${status})` : ''}.`, { code: 'failed', status });
}

/**
 * fetch JSON/form with timeout. Returns { status, ok, json, text }.
 * Never throws on HTTP status — callers decide (some flows read error bodies).
 */
async function request(url, {
  method = 'GET', headers = {}, form = null, json = null, timeoutMs = 15000, signal = null,
} = {}) {
  const timeouts = [AbortSignal.timeout(timeoutMs)];
  if (signal) timeouts.push(signal);
  const init = {
    method,
    headers: { Accept: 'application/json, text/plain, */*', ...headers },
    signal: timeouts.length > 1 ? AbortSignal.any(timeouts) : timeouts[0],
  };
  if (form) {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(form).toString();
  } else if (json !== null) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new IntegrationError('network', { code: 'network', detail: String(err.message || err) });
  }
  const text = await res.text().catch(() => '');
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* plain text */ }
  return { ok: res.ok, status: res.status, json: parsed, text };
}

/** Wrap `request` so network failures become a friendly per-app error. */
async function http(appName, url, opts = {}) {
  let r;
  try {
    r = await request(url, opts);
  } catch (err) {
    if (err instanceof IntegrationError && err.code === 'network') {
      throw new IntegrationError(`Couldn't reach ${appName}. Check your connection and try again.`, {
        code: 'network', appId: opts.appId || '',
      });
    }
    throw err;
  }
  if (!r.ok) {
    throw friendly(appName, r.status, `${r.text || ''} ${JSON.stringify(r.json || {})}`.slice(0, 300));
  }
  return r;
}

/** Strip HTML tags for Graph/HTML bodies (keeps plain text previews readable). */
function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { IntegrationError, friendly, request, http, stripHtml };
