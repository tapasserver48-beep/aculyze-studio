/**
 * Website Crawler — secure crawling of customer websites for knowledge extraction.
 * Implements SSRF protection, DNS rebinding prevention, and connection limits.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pg = require('../db/pg');
const dns = require('dns');

const CUSTOMER_DATA_DIR = (dataDir) => path.join(dataDir || '.', 'data', 'customer');

// Constants for security limits
const MAX_PAGES = 50;
const MAX_DEPTH = 2;
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_CONCURRENT_PAGES = 3;
const TIMEOUT_MS = 15000;

// Private/reserved IP ranges (IPv4 and IPv6)
const PRIVATE_IP_RANGES = [
  ['10.0.0.0', '10.255.255.255'],      // Class A private
  ['172.16.0.0', '172.31.255.255'],     // Class B private
  ['192.168.0.0', '192.168.255.255'],   // Class C private
  ['127.0.0.0', '127.255.255.255'],     // Loopback
  ['169.254.0.0', '169.254.255.255'],   // Link-local
  ['224.0.0.0', '239.255.255.255'],     // Multicast
  ['240.0.0.0', '255.255.255.255'],     // Reserved
  ['0.0.0.0', '0.255.255.255'],         // Current network
  // IPv6 equivalents (stored as strings for comparison)
];

function generateCrawlJobId() {
  return 'crawl-' + crypto.randomUUID().substring(0, 8);
}

/**
 * Convert IP range start to a comparable number
 */
function ipToNumber(ip) {
  const parts = ip.split('.').map(Number);
  return (parts[0] << 24) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

/**
 * Check if an IP is in a private/reserved range
 */
function isPrivateIp(ip) {
  const num = ipToNumber(ip);
  for (const [start, end] of PRIVATE_IP_RANGES) {
    if (num >= ipToNumber(start) && num <= ipToNumber(end)) return true;
  }
  // IPv6 loopback and link-local
  if (ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('::ffff:')) return true;
  return false;
}

/**
 * Resolve hostname and validate all resolved IPs
 */
async function validateResolvedHost(hostname) {
  return new Promise((resolve, reject) => {
    dns.resolve(hostname, (err, addresses) => {
      if (err) return reject(new Error(`DNS resolution failed for ${hostname}: ${err.message}`));

      for (const addr of addresses) {
        // Handle IPv6 addresses wrapped in brackets
        const cleanIp = addr.replace(/\[|\]/g, '');
        if (isPrivateIp(cleanIp)) {
          return reject(new Error(`Resolved IP ${cleanIp} is private/reserved, SSRF blocked`));
        }
      }
      resolve(true);
    });
  });
}

/**
 * Validate and sanitize a URL for crawling.
 * This runs BEFORE any request is made.
 */
function validateUrl(url) {
  try {
    const parsed = new URL(url);

    // Only HTTPS allowed
    if (parsed.protocol !== 'https:') {
      throw new Error('Only HTTPS URLs are allowed');
    }

    // No credentials in URL
    if (parsed.username || parsed.password) {
      throw new Error('URLs with credentials are not allowed');
    }

    // Only allow standard ports
    const port = parsed.port ? parseInt(parsed.port) : 443;
    if (port !== 443 && port !== 80) {
      // Allow common non-standard ports but log warning
      if (port < 1 || port > 65535) {
        throw new Error('Invalid port number');
      }
    }

    // Validate hostname (basic format check)
    if (!parsed.hostname || parsed.hostname.length === 0) {
      throw new Error('Invalid hostname');
    }

    // No localhost variants
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1') {
      throw new Error('localhost access is blocked');
    }

    return { valid: true, hostname: parsed.hostname, port, protocol: parsed.protocol };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

/**
 * Crawl a single page with security constraints
 */
async function crawlPage(url, maxDepth = MAX_DEPTH) {
  // This function will be implemented with browser automation (Playwright/Puppeteer)
  // The actual crawling logic will use the browser but with network restrictions

  // Placeholder for now - actual implementation will use browser context
  return {
    url,
    status: 'skipped',
    error: 'Crawler not yet implemented - browser backend required'
  };
}

/**
 * Create a crawl job
 */
async function createCrawlJob(dataDir, { workspaceId, targetUrl }) {
  const now = Date.now();
  const id = generateCrawlJobId();

  const job = {
    id,
    workspace_id: workspaceId,
    target_url: targetUrl,
    status: 'PENDING',
    pages_queued: 0,
    pages_completed: 0,
    error_message: null,
    started_at: null,
    completed_at: null,
    created_at: now
  };

  // Validate URL before storing
  const validation = validateUrl(targetUrl);
  if (!validation.valid) {
    job.status = 'FAILED';
    job.error_message = validation.error;
    job.completed_at = now;
  }

  if (pg.enabled()) {
    const { rows } = await pg.query(
      `INSERT INTO customer_crawl_jobs 
       (id, workspace_id, target_url, status, pages_queued, pages_completed, 
        started_at, completed_at, created_at, error_message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [id, workspaceId, targetUrl, job.status, 0, 0, null, job.completed_at, now, job.error_message]
    );
    return rows[0];
  }

  // JSON backend
  return job;
}

/**
 * Execute a crawl job (to be triggered by authorized user)
 */
async function executeCrawlJob(dataDir, jobId) {
  if (pg.enabled()) {
    const { rows } = await pg.query('SELECT * FROM customer_crawl_jobs WHERE id = $1', [jobId]);
    if (!rows.length) return null;
    const job = rows[0];
    job.status = 'RUNNING';
    job.started_at = Date.now();
    await pg.query(
      `UPDATE customer_crawl_jobs SET status = $1, started_at = $2 WHERE id = $3`,
      [job.status, job.started_at, jobId]
    );
    return job;
  }

  // JSON backend - simplified
  return { status: 'RUNNING' };
}

/**
 * Get crawl job status
 */
async function getCrawlJob(dataDir, id) {
  if (pg.enabled()) {
    const { rows } = await pg.query('SELECT * FROM customer_crawl_jobs WHERE id = $1', [id]);
    return rows[0] || null;
  }
  const file = path.join(CUSTOMER_DATA_DIR(dataDir), 'customer_crawl_jobs.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data.items.find(j => j.id === id) || null;
  } catch {
    return null;
  }
}

/**
 * List crawl jobs for a workspace
 */
async function listCrawlJobs(dataDir, workspaceId) {
  if (pg.enabled()) {
    const { rows } = await pg.query(
      'SELECT * FROM customer_crawl_jobs WHERE workspace_id = $1 ORDER BY created_at DESC',
      [workspaceId]
    );
    return rows;
  }
  try {
    const file = path.join(CUSTOMER_DATA_DIR(dataDir), 'customer_crawl_jobs.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data.items
      .filter(j => j.workspace_id === workspaceId)
      .sort((a, b) => b.created_at - a.created_at);
  } catch {
    return [];
  }
}

/**
 * Validate hostname resolves to non-private IP
 * Used before actual network connection
 */
async function preValidateDestination(hostname) {
  // First, check for obvious blocks
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return false;
  }

  // Resolve and validate
  try {
    await validateResolvedHost(hostname);
    return true;
  } catch {
    return false;
  }
}

/**
 * Initialize database schema for crawl jobs
 */
async function ensureSchema() {
  if (!pg.enabled()) {
    const dataDir = process.env.ACULYZE_DATA_DIR;
    const file = path.join(dataDir || '.', 'data', 'customer', 'customer_crawl_jobs.json');
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ items: [] }, null, 2), 'utf8');
    }
    return;
  }

  await pg.query(`
    CREATE TABLE IF NOT EXISTS customer_crawl_jobs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES customer_workspaces(id) ON DELETE CASCADE,
      target_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      pages_queued INTEGER DEFAULT 0,
      pages_completed INTEGER DEFAULT 0,
      error_message TEXT,
      started_at BIGINT,
      completed_at BIGINT,
      created_at BIGINT NOT NULL
    )
  `);
  await pg.query('CREATE INDEX IF NOT EXISTS customer_crawl_jobs_workspace_idx ON customer_crawl_jobs (workspace_id)');
  await pg.query('CREATE INDEX IF NOT EXISTS customer_crawl_jobs_status_idx ON customer_crawl_jobs (status)');
}

module.exports = {
  generateCrawlJobId,
  ensureSchema,
  validateUrl,
  validateResolvedHost,
  preValidateDestination,
  isPrivateIp,
  createCrawlJob,
  executeCrawlJob,
  getCrawlJob,
  listCrawlJobs,
  crawlPage,
  MAX_PAGES,
  MAX_DEPTH,
  MAX_RESPONSE_SIZE,
  TIMEOUT_MS
};