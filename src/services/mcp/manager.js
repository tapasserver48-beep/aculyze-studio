/**
 * Generic MCP bridge for Zara AI.
 *
 * Spawns a configured MCP server over stdio (via @modelcontextprotocol/sdk),
 * lists its tools, and calls them — one shot per request (spawn → connect →
 * call → close). Simple and stateless; suitable for low-volume use like
 * sending an email.
 *
 * Used for Gmail today; any other MCP server can reuse this manager.
 * All configuration comes from env — nothing is hard-coded.
 */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

function splitArgs(raw) {
  return String(raw || '').trim().split(/\s+/).filter(Boolean);
}

class MCPBridge {
  /**
   * @param {{ command?: string, args?: string, env?: object, timeoutMs?: number }} opts
   */
  constructor({ command = '', args = '', env = {}, timeoutMs = 60000 } = {}) {
    this.command = command;
    this.args = Array.isArray(args) ? args : splitArgs(args);
    this.extraEnv = env || {};
    this.timeoutMs = timeoutMs;
  }

  get configured() {
    return !!this.command;
  }

  async _withClient(fn) {
    if (!this.configured) throw new Error('MCP server is not configured.');
    const transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      env: { ...process.env, ...this.extraEnv },
    });
    const client = new Client({ name: 'zara-ai', version: '1.0.0' }, { capabilities: {} });
    const timer = setTimeout(() => {
      try { transport.close(); } catch { /* noop */ }
    }, this.timeoutMs);
    try {
      await client.connect(transport);
      return await fn(client);
    } finally {
      clearTimeout(timer);
      try { await transport.close(); } catch { /* noop */ }
    }
  }

  /** @returns {Promise<Array<{ name: string, description?: string }>>} */
  async listTools() {
    return this._withClient(async (client) => {
      const res = await client.listTools();
      return (res.tools || []).map((t) => ({ name: t.name, description: t.description || '' }));
    });
  }

  async callTool(name, args = {}) {
    return this._withClient(async (client) => client.callTool({ name, arguments: args }));
  }
}

module.exports = { MCPBridge, splitArgs };
