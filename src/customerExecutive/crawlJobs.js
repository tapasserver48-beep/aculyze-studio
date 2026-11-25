/**
 * Background website crawls for the Customer Executive page (Phase 04.4 Stage A).
 *
 * One crawl per workspace at a time. Progress lives in memory for live polling;
 * the last result is saved through the docstore (Postgres on Render) so the
 * page can show "Last crawled … 24 pages" after a restart. A finished crawl
 * replaces the workspace's earlier pages from the same site.
 */

const path = require('path');
const crypto = require('crypto');
const docstore = require('../db/docstore');
const { crawlSite, toKnowledgeContent } = require('./siteCrawler');
const { addKnowledge, getKnowledge, deleteKnowledge } = require('./knowledge');

const running = new Map(); // workspaceId → job

const summaryFile = (dataDir, workspaceId) => path.join(dataDir, 'customer', 'crawls', `${workspaceId}.json`);

function publicJob(job) {
  if (!job) return null;
  const { controller, ...rest } = job;
  return rest;
}

function lastCrawl(dataDir, workspaceId) {
  return docstore.readJson(dataDir, summaryFile(dataDir, workspaceId), null);
}

function status(dataDir, workspaceId) {
  return publicJob(running.get(workspaceId)) || lastCrawl(dataDir, workspaceId);
}

function siteOf(u) {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

/**
 * Start a crawl. Returns the job immediately; work continues in the background.
 * @param {{ dataDir, workspaceId, url, maxPages?, userId?, crawl? }} p  crawl is for tests
 */
function start({ dataDir, workspaceId, url, maxPages, userId = null, crawl = crawlSite }) {
  const current = running.get(workspaceId);
  if (current && current.status === 'running') return { error: 'A crawl is already running for this workspace.', job: publicJob(current) };

  const controller = new AbortController();
  const job = {
    id: `crawl-${crypto.randomUUID().slice(0, 8)}`,
    workspaceId,
    url,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    startedBy: userId,
    done: 0,
    saved: 0,
    queued: 0,
    current: url,
    pagesSaved: 0,
    pagesRemoved: 0,
    errors: [],
    error: null,
    controller,
  };
  running.set(workspaceId, job);

  (async () => {
    try {
      const result = await crawl(url, {
        maxPages,
        signal: controller.signal,
        onProgress: (p) => { job.done = p.done; job.saved = p.saved; job.queued = p.queued; if (p.current) job.current = p.current; },
      });
      if (controller.signal.aborted) { job.status = 'cancelled'; return; }
      if (!result.pages.length) {
        job.status = 'failed';
        job.error = result.errors.length ? `No pages could be read. First error: ${result.errors[0].error}` : 'No readable pages were found.';
        job.errors = result.errors;
        return;
      }
      // Replace earlier pages from the same site, then save the new ones.
      const site = siteOf(url);
      const existing = await getKnowledge(dataDir, workspaceId);
      for (const k of existing) {
        if (siteOf(k.source_url) === site) { await deleteKnowledge(dataDir, workspaceId, k.id); job.pagesRemoved++; }
      }
      for (const page of result.pages) {
        await addKnowledge(dataDir, { workspaceId, sourceUrl: page.url, content: toKnowledgeContent(page), contentType: 'crawl_result' });
        job.pagesSaved++;
      }
      job.errors = result.errors;
      job.status = 'done';
    } catch (err) {
      job.status = 'failed';
      job.error = err.message || 'The crawl failed.';
    } finally {
      job.finishedAt = Date.now();
      job.current = null;
      try { docstore.writeJson(dataDir, summaryFile(dataDir, workspaceId), publicJob(job)); } catch { /* best effort */ }
      // Keep the finished job briefly so the poll that follows sees it.
      setTimeout(() => { if (running.get(workspaceId) === job) running.delete(workspaceId); }, 60000).unref?.();
    }
  })();

  return { job: publicJob(job) };
}

function cancel(workspaceId) {
  const job = running.get(workspaceId);
  if (!job || job.status !== 'running') return false;
  job.controller.abort();
  return true;
}

module.exports = { start, cancel, status, lastCrawl };
