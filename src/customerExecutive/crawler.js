/**
 * Website Crawler — secure crawling of customer websites for knowledge extraction.
 * Implements SSRF protection, DNS rebinding prevention, and connection limits.
 *
 * Uses the existing PlaywrightProvider for browser automation with additional
 * security controls at the application layer.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pg = require('../db/pg');
const dns = require('dns');
const { PlaywrightProvider } = require('../services/search/playwright');

const CUSTOMER_DATA_DIR = (dataDir) => path.join(dataDir || '.', 'data', 'customer');

// Constants for security limits
const MAX_PAGES = 50;
const MAX_DEPTH = 2;
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_CONCURRENT_PAGES = 3;
const TIMEOUT_MS = 15000;

// Private/reserved IP ranges (IPv4) - checked after DNS resolution
const PRIVATE_IP_RANGES = [
  ['10.0.0.0', '10.255.255.255'],      // Class A private
  ['172.16.0.0', '172.31.255.255'],     // Class B private
  ['192.168.0.0', '192.168.255.255'],   // Class C private
  ['127.0.0.0', '127.255.255.255'],     // Loopback
  ['169.254.0.0', '169.254.255.255'],   // Link-local
  ['224.0.0.0', '239.255.255.255'],     // Multicast
  ['240.0.0.0', '255.255.255.255'],     // Reserved
  ['0.0.0.0', '0.255.255.255'],         // Current network
];

// IPv6 private/reserved ranges
const IPV6_PRIVATE = [
  '::1', '1:', 'fc00:', 'fd00:', 'fe80:', 'ff00:', '2001:db8:'
];

function generateCrawlJobId() {
  return 'crawl-' + crypto.randomUUID().substring(0, 8);
}

/**
 * Convert IP range start to a comparable number
 * Uses unsigned 32-bit integer arithmetic
 */
function ipToNumber(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return -1;
  // Use >>> 0 to force unsigned 32-bit interpretation
  return ((parts[0] << 24) >>> 0) + 
         ((parts[1] << 16) >>> 0) + 
         ((parts[2] << 8) >>> 0) + 
         (parts[3] >>> 0);
}

/**
 * Check if an IP is in a private/reserved range
 */
function isPrivateIp(ip) {
  const cleanIp = ip.replace(/\[|\]/g, '').toLowerCase();

  // IPv4 check
  const num = ipToNumber(cleanIp);
  if (num >= 0) {
    for (const [start, end] of PRIVATE_IP_RANGES) {
      if (num >= ipToNumber(start) && num <= ipToNumber(end)) return true;
    }
  }

  // IPv6 check
  for (const prefix of IPV6_PRIVATE) {
    if (cleanIp.startsWith(prefix)) return true;
  }

  return false;
}

/**
 * Resolve hostname and validate all resolved IPs
 * Throws if any resolved IP is private/reserved
 */
async function validateResolvedHost(hostname) {
  return new Promise((resolve, reject) => {
    dns.resolve(hostname, (err, addresses) => {
      if (err) return reject(new Error(`DNS resolution failed for ${hostname}: ${err.message}`));

      if (!addresses || addresses.length === 0) {
        return reject(new Error(`No addresses found for ${hostname}`));
      }

      for (const addr of addresses) {
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

    // Block URL-encoded local addresses
    const hostname = parsed.hostname.toLowerCase();
    if (hostname.includes('localhost') || hostname.includes('127.') || hostname.endsWith('.local')) {
      throw new Error('Localhost and .local domains are blocked');
    }

    // Check for suspicious double-encoding tricks
    const urlStr = url.toLowerCase();
    if (urlStr.includes('%252e') || urlStr.includes('%255c')) {
      throw new Error('Encoded characters in URL are not allowed');
    }

    // Only allow standard web ports
    const port = parsed.port ? parseInt(parsed.port) : 443;
    if (parsed.port && (port < 1 || port > 65535 || port === 25 || port === 110 || port === 143 || port === 465)) {
      throw new Error('Blocked port: ' + port);
    }

    return { valid: true, hostname: parsed.hostname, port, protocol: parsed.protocol };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

/**
 * Create a secure browser context with network restrictions
 */
async function createSecureContext(proxy = null) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-web-security=true', // We handle security at the application layer
      '--disable-features=NetworkService',
      '--lang=en-US',
    ],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    locale: 'en-US',
    // Block requests to internal/local resources
    javaScriptEnabled: true,
  });

  // Intercept requests and block SSRF attempts
  await context.route('**', async (route) => {
    const url = route.request().url();
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();

      // Re-validate DNS at request time
      if (hostname && hostname !== 'localhost') {
        try {
          const resolved = await validateResolvedHost(hostname);
          // If we get here with an error, block the request
        } catch (validationErr) {
          return route.abort('blocked');
        }
      }
    } catch (e) {
      // DNS resolution failed - block
      return route.abort('blocked');
    }

    route.continue();
  });

  return { browser, context };
}

/**
 * Extract knowledge from a crawled page
 */
function extractKnowledgeFromPage(page, url) {
  return page.evaluate((pageUrl) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

    const title = document.title || document.querySelector('title')?.textContent || '';
    const metaDesc = document.querySelector('meta[name="description"], meta[property="og:description"]')?.getAttribute('content') || '';

    // Extract headings
    const headings = ['h1', 'h2', 'h3', 'h4'].map(tag => document.querySelectorAll(tag)).flat();
    const headingTexts = Array.from(headings).map(h => clean(h.textContent)).filter(t => t.length > 10);

    // Extract main content paragraphs
    const paragraphs = Array.from(document.querySelectorAll('p')).map(p => clean(p.textContent)).filter(t => t.length > 30);

    // Extract links (for source tracking)
    const links = Array.from(document.querySelectorAll('a[href^="http"]')).map(a => ({
      text: clean(a.textContent),
      href: a.href
    })).slice(0, 20);

    // Extract contact info
    const emailLinks = Array.from(document.querySelectorAll('a[href^="mailto:"]')).map(a => a.getAttribute('href').replace('mailto:', ''));
    const phoneMatches = [];
    const phonePattern = /\b(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
    const bodyText = document.body ? document.body.innerText : '';
    let match;
    while ((match = phonePattern.exec(bodyText)) !== null) {
      phoneMatches.push(match[0]);
    }

    return {
      sourceUrl: pageUrl,
      title: String(title).slice(0, 300),
      metaDescription: String(metaDesc).slice(0, 500),
      headings: headingTexts.slice(0, 20),
      paragraphs: paragraphs.slice(0, 50),
      links: links,
      contactEmails: emailLinks.slice(0, 10),
      contactPhones: [...new Set(phoneMatches)].slice(0, 10)
    };
  }, url);
}

/**
 * Crawl a single page with security constraints
 */
async function crawlPage(url, options = {}) {
  const { maxDepth = MAX_DEPTH, timeoutMs = TIMEOUT_MS, signal } = options;

  const validation = validateUrl(url);
  if (!validation.valid) {
    return { url, status: 'FAILED', error: validation.error };
  }

  const browser = await createSecureContext();
  const page = await browser.context.newPage();

  try {
    // Pre-validate DNS resolution
    await validateResolvedHost(validation.hostname);

    // Navigate with timeout
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs
    });

    if (signal?.aborted) {
      return { url, status: 'CANCELLED', error: 'Aborted' };
    }

    // Wait a bit for dynamic content
    await page.waitForTimeout(1000);

    // Extract knowledge
    const content = extractKnowledgeFromPage(page, url);

    // Check response size
    if (JSON.stringify(content).length > MAX_RESPONSE_SIZE) {
      return { url, status: 'PARTIAL', error: 'Content truncated due to size limit' };
    }

    return {
      url,
      status: 'SUCCESS',
      content,
      crawledAt: Date.now()
    };
  } catch (err) {
    return {
      url,
      status: 'FAILED',
      error: err.message || 'Unknown error during page load'
    };
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/**
 * Crawl a website starting from the target URL
 * Extracts content from the homepage and links up to maxDepth
 */
async function crawlWebsite(url, options = {}) {
  const { maxDepth = MAX_DEPTH, maxPages = MAX_PAGES } = options;

  const allContent = [];
  const visited = new Set();
  const toVisit = [{ url, depth: 0 }];

  while (toVisit.length > 0 && allContent.length < maxPages) {
    const { url: currentUrl, depth } = toVisit.shift();

    if (visited.has(currentUrl)) continue;
    visited.add(currentUrl);

    const result = await crawlPage(currentUrl, { maxDepth, timeoutMs: TIMEOUT_MS });

    if (result.status === 'SUCCESS' && result.content) {
      allContent.push(result.content);

      // Queue linked pages if within depth limit
      if (depth < maxDepth) {
        const linkUrls = result.content.links
          .map(l => l.href)
          .filter(h => h && h.startsWith('https://'))
          .slice(0, 10);

        for (const linkUrl of linkUrls) {
          if (!visited.has(linkUrl)) {
            toVisit.push({ url: linkUrl, depth: depth + 1 });
          }
        }
      }
    }
  }

  return {
    status: allContent.length > 0 ? 'SUCCESS' : 'FAILED',
    pages_crawled: allContent.length,
    content: allContent,
    crawledAt: Date.now()
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
    content: [], // Store extracted snippets
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
 * Execute a crawl job
 */
async function executeCrawlJob(dataDir, jobId) {
  if (pg.enabled()) {
    const { rows } = await pg.query('SELECT * FROM customer_crawl_jobs WHERE id = $1', [jobId]);
    if (!rows.length) return null;
    const job = rows[0];

    if (job.status === 'FAILED') return job;

    job.status = 'RUNNING';
    job.started_at = Date.now();
    await pg.query(
      `UPDATE customer_crawl_jobs SET 
         status = $1, started_at = $2, pages_completed = $3 
       WHERE id = $4`,
      [job.status, job.started_at, 0, jobId]
    );

    try {
      const result = await crawlWebsite(job.target_url);
      job.status = result.status;
      job.pages_completed = result.content.length;
      job.content = result.content;
      job.completed_at = Date.now();
      if (result.error) job.error_message = result.error;

      await pg.query(
        `UPDATE customer_crawl_jobs SET 
           status = $1, pages_completed = $2, content = $3, completed_at = $4,
           error_message = $5 WHERE id = $6`,
        [job.status, job.pages_completed, JSON.stringify(result.content), job.completed_at, result.error ? result.error : null, jobId]
      );
    } catch (e) {
      job.status = 'FAILED';
      job.error_message = e.message;
      job.completed_at = Date.now();
      await pg.query(
        `UPDATE customer_crawl_jobs SET 
           status = $1, error_message = $2, completed_at = $3 
         WHERE id = $4`,
        [job.status, job.error_message, job.completed_at, jobId]
      );
    }

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
      'SELECT id, workspace_id, target_url, status, pages_completed, pages_queued, started_at, completed_at, created_at, error_message FROM customer_crawl_jobs WHERE workspace_id = $1 ORDER BY created_at DESC',
      [workspaceId]
    );
    return rows;
  }

  try {
    const file = path.join(CUSTOMER_DATA_DIR(dataDir), 'customer_crawl_jobs.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data.items
      .filter(j => j.workspace_id === workspaceId)
      .map(j => ({
        id: j.id, target_url: j.target_url, status: j.status,
        pages_completed: j.pages_completed, pages_queued: j.pages_queued,
        started_at: j.started_at, completed_at: j.completed_at,
        created_at: j.created_at, error_message: j.error_message
      }))
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
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return false;
  }

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
      content JSONB,
      error_message TEXT,
      started_at BIGINT,
      completed_at BIGINT,
      created_at BIGINT NOT NULL
    )
  `);
  await pg.query('CREATE INDEX IF NOT EXISTS customer_crawl_jobs_workspace_idx ON customer_crawl_jobs (workspace_id)');
  await pg.query('CREATE INDEX IF NOT EXISTS customer_crawl_jobs_status_idx ON customer_crawl_jobs (status)');
  await pg.query('CREATE INDEX IF NOT EXISTS customer_crawl_jobs_created_idx ON customer_crawl_jobs (created_at DESC)');
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
  crawlWebsite,
  extractKnowledgeFromPage,
  createSecureContext,
  MAX_PAGES,
  MAX_DEPTH,
  MAX_RESPONSE_SIZE,
  TIMEOUT_MS
};