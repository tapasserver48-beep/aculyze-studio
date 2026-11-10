/**
 * Desktop-agent authentication + local logging for Zara Computer Control.
 *
 * Phase 1: a per-install Bearer token, auto-generated on first use and stored
 * in the data dir (0600 where the OS supports it). Every /api/computer call —
 * except the same-origin-protected /session bootstrap — must present it, so
 * other websites (CSRF) and casual local scripts cannot drive the computer.
 * Phase 2 (standalone agent) reuses this token as the device-pairing secret.
 *
 * Logging: one line per operation to data/logs/computer-control.log, with an
 * explicit "never log" rule — no tokens, passwords, credentials or file
 * contents. Set ZARA_COMPUTER_LOG=0 to disable entirely; delete the log file
 * to clear it.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function agentFile(dataDir) {
  return path.join(dataDir, 'computer-agent.json');
}

function getAgentToken(dataDir) {
  const file = agentFile(dataDir);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw.token === 'string' && raw.token.length >= 32) return raw.token;
  } catch { /* first run */ }
  const token = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ token, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* Windows: best-effort */ }
  } catch { /* storage is best-effort; token still valid for this run */ }
  return token;
}

function verifyToken(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string' || !presented || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Append one structured line. NEVER pass tokens, secrets or file contents. */
function logOperation(dataDir, { op, application, platform, result, detail }) {
  if (process.env.ZARA_COMPUTER_LOG === '0') return;
  const line = `${new Date().toISOString()} [ZARA COMPUTER] Command received: ${op}`
    + ` | Application: ${application || '-'} | Platform: ${platform || '-'} | Result: ${result || '-'}`
    + `${detail ? ` | ${detail}` : ''}\n`;
  try {
    const dir = path.join(dataDir, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'computer-control.log'), line, 'utf8');
  } catch { /* logging is best-effort */ }
}

module.exports = { getAgentToken, verifyToken, logOperation };
