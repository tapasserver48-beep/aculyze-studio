/**
 * CanvaProvider — Canva's official REST API authorization
 * (OAuth 2.0 authorization code + PKCE S256, per Canva's docs).
 *
 * Implemented capability: finding/searching authorized Canva designs.
 * Operations Canva's API does not expose are NOT faked — the tool layer
 * returns a clear "not available" message instead (§6).
 *
 * Endpoints are overridable (CANVA_AUTH_URL / CANVA_TOKEN_URL / CANVA_API_BASE)
 * for automated testing against local fakes.
 */
const crypto = require('crypto');
const { http, request, IntegrationError } = require('./base');

const SCOPES = ['design:meta:read', 'profile:read'];

const SCOPE_PERMISSIONS = [[/^design:meta:read$/, 'READ_DESIGNS'], [/^profile:read$/, 'READ_PROFILE']];

class CanvaProvider {
  constructor(env = process.env) {
    this.id = 'canva';
    this.clientId = env.CANVA_CLIENT_ID || '';
    this.clientSecret = env.CANVA_CLIENT_SECRET || '';
    this.authUrl = env.CANVA_AUTH_URL || 'https://www.canva.com/api/oauth/authorize';
    this.tokenUrl = env.CANVA_TOKEN_URL || 'https://api.canva.com/rest/v1/oauth/token';
    this.api = (env.CANVA_API_BASE || 'https://api.canva.com/rest/v1').replace(/\/$/, '');
    this.scopes = String(env.CANVA_SCOPES || SCOPES.join(' ')).split(/\s+/).filter(Boolean);
  }

  get configured() { return !!(this.clientId && this.clientSecret); }

  scopesFor() { return this.scopes; }

  permissionsFromScopes(scopes) {
    const perms = new Set();
    for (const s of scopes) for (const [rx, p] of SCOPE_PERMISSIONS) if (rx.test(String(s))) perms.add(p);
    return [...perms];
  }

  buildAuthUrl({ redirectUri, state, codeChallenge }) {
    const u = new URL(this.authUrl);
    u.searchParams.set('client_id', this.clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', this.scopesFor().join(' '));
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    return u.toString();
  }

  /** Canva token endpoint uses HTTP Basic client authentication (PKCE body). */
  authHeader() {
    return `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`;
  }

  async exchangeCode({ code, codeVerifier }) {
    const r = await request(this.tokenUrl, {
      method: 'POST',
      headers: { Authorization: this.authHeader() },
      form: { grant_type: 'authorization_code', code, code_verifier: codeVerifier },
    });
    if (!r.ok) {
      throw new IntegrationError('Canva rejected the authorization code — try connecting again.', {
        code: 'exchange_failed', status: r.status,
      });
    }
    return this.readTokens(r.json);
  }

  async refreshToken(refreshToken) {
    const r = await request(this.tokenUrl, {
      method: 'POST',
      headers: { Authorization: this.authHeader() },
      form: { grant_type: 'refresh_token', refresh_token: refreshToken },
    });
    if (!r.ok) throw new IntegrationError('session expired', { code: 'reauth', status: r.status });
    return this.readTokens(r.json, refreshToken);
  }

  readTokens(json, prevRefresh = '') {
    const j = json || {};
    return {
      accessToken: j.access_token || '',
      refreshToken: j.refresh_token || prevRefresh,
      expiresIn: Number(j.expires_in) || 14400,
      scope: j.scope || '',
    };
  }

  async fetchAccount(accessToken) {
    try {
      const r = await http('Canva', `${this.api}/users/me/profile`, {
        headers: { Authorization: `Bearer ${accessToken}` }, timeoutMs: 8000,
      });
      const name = r.json && (r.json.display_name || r.json.name || r.json.user_id);
      return name || '';
    } catch { return ''; }
  }

  /** Best-effort token revocation on disconnect (Canva revokes the lineage). */
  async revoke(token) {
    await request(`${this.api}/oauth/revoke`, {
      method: 'POST', headers: { Authorization: this.authHeader() },
      form: { token }, timeoutMs: 6000,
    }).catch(() => null);
  }

  async test(conn) {
    const r = await request(`${this.api}/users/me`, {
      headers: { Authorization: `Bearer ${conn.__token}` }, timeoutMs: 8000,
    });
    if (r.ok) return { ok: true, detail: 'signed in' };
    return { ok: false, detail: `HTTP ${r.status}` };
  }

  async call(toolId, conn, args, token) {
    if (toolId !== 'canva.search_designs') {
      throw new IntegrationError(
        `"${toolId}" isn't available through Canva's API yet — Zara won't fake it. Try finding designs instead.`,
        { code: 'unsupported' },
      );
    }
    return this.tool_canva_search_designs(conn, args, token);
  }

  async prepareWrite(toolId) {
    throw new IntegrationError(
      `Writing to Canva ("${toolId}") isn't supported by Canva's API yet — Zara won't fake it.`,
      { code: 'unsupported' },
    );
  }

  async tool_canva_search_designs(conn, args, token) {
    const q = String(args.q || '').trim().slice(0, 255);
    const url = `${this.api}/designs?limit=25${q ? `&query=${encodeURIComponent(q)}` : ''}`;
    const r = await http('Canva', url, { headers: { Authorization: `Bearer ${token}` } });
    const designs = (r.json && (r.json.items || r.json.designs)) || [];
    const items = designs.map((d) => ({
      title: d.title || '(untitled design)',
      meta: `updated ${(d.updated_at || d.created_at || '').slice(0, 10)}`,
      url: d.url || '',
    }));
    return {
      count: items.length,
      items: items.slice(0, 10).map(({ title, meta }) => ({ title, meta })),
      text: items.slice(0, 12).map((it, i) => `${i + 1}. ${it.title}${it.meta ? ` — ${it.meta}` : ''}${it.url ? `\n   ${it.url}` : ''}`).join('\n'),
      raw: items,
    };
  }
}

module.exports = {
  CanvaProvider,
  makeCodeVerifier: () => crypto.randomBytes(48).toString('base64url'),
  makeChallenge: (v) => crypto.createHash('sha256').update(v).digest('base64url'),
};
