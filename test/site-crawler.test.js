/**
 * Phase 04.4 Stage A — website crawler (HTML extraction, same-site BFS,
 * sitemap, robots.txt, boilerplate removal, SSRF guard) and the background
 * crawl job that saves pages as knowledge. No network: a fake site is served
 * through the injectable fetcher.
 * Run with: node test/site-crawler.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

delete process.env.DATABASE_URL;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-test-'));
process.env.ACULYZE_DATA_DIR = dataDir;

const { crawlSite, extractPage, parseRobots, normalise, safeLookup } = require('../src/customerExecutive/siteCrawler');
const crawlJobs = require('../src/customerExecutive/crawlJobs');
const knowledge = require('../src/customerExecutive/knowledge');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (err) { console.error(`  ✗ ${name}\n    ${err.stack}`); process.exitCode = 1; }
}

const FOOTER = '<footer><p>© 2026 Acme Learning Pvt Ltd. All rights reserved.</p><p>Call +91 44 1234 5678</p></footer>';
const NAV = '<nav><a href="/">Home</a><a href="/pricing">Pricing</a><a href="/contact">Contact</a><a href="https://other.example/x">Partner</a></nav>';
const page = (title, body) => `<!doctype html><html><head><title>${title}</title><meta name="description" content="${title} at Acme"><script>var x = "<p>not text</p>";</script><style>p{color:red}</style></head><body>${NAV}<main>${body}</main>${FOOTER}</body></html>`;

const SITE = {
  'https://acme.example/robots.txt': 'User-agent: *\nDisallow: /private\n',
  'https://acme.example/sitemap.xml': '<urlset><url><loc>https://acme.example/about</loc></url><url><loc>https://acme.example/private/secret</loc></url></urlset>',
  'https://acme.example/': page('Acme Learning', '<h1>Learning software for schools</h1><p>Acme helps schools run classes online.</p><a href="/pricing?utm_source=x">See pricing</a><a href="/brochure.pdf">Brochure</a><a href="mailto:hello@acme.example">Mail us</a>'),
  'https://acme.example/pricing': page('Pricing', '<h2>Plans</h2><ul><li>Starter: ₹999 per month</li><li>Growth: ₹2,499 per month</li></ul><table><tr><td>Users</td><td>10</td></tr></table>'),
  'https://acme.example/contact': page('Contact', '<h2>Contact us</h2><p>Support hours are Monday to Saturday, 9am to 7pm.</p><a href="https://www.acme.example/team">Team</a>'),
  'https://acme.example/about': page('About', '<h2>About Acme</h2><p>Founded in 2015 by two teachers in Chennai.</p>'),
  'https://www.acme.example/team': page('Team', '<h2>Our team</h2><p>Twelve people across Chennai and Bengaluru.</p>'),
  'https://acme.example/private/secret': page('Secret', '<p>Should never be crawled.</p>'),
};
const fetched = [];
const fakeFetch = async (url) => {
  fetched.push(url);
  const body = SITE[url];
  if (body === undefined) return { status: 404, headers: { 'content-type': 'text/html' }, body: 'not found', url };
  const type = url.endsWith('.txt') ? 'text/plain' : url.endsWith('.xml') ? 'application/xml' : 'text/html; charset=utf-8';
  return { status: 200, headers: { 'content-type': type }, body, url };
};

(async () => {
  console.log('extraction');
  await test('extracts title, description, headings, text lines, links, contacts', () => {
    const p = extractPage(SITE['https://acme.example/pricing'], 'https://acme.example/pricing');
    assert.strictEqual(p.title, 'Pricing');
    assert.strictEqual(p.metaDescription, 'Pricing at Acme');
    assert.deepStrictEqual(p.headings, ['Plans']);
    assert.ok(p.lines.includes('• Starter: ₹999 per month'), JSON.stringify(p.lines));
    assert.ok(p.lines.some((l) => /Users \| 10/.test(l)), 'table cells kept on one line');
    assert.ok(!p.lines.some((l) => /not text|color:red/.test(l)), 'scripts and styles dropped');
    assert.ok(!p.lines.includes('Home'), 'nav menu dropped');
    assert.ok(p.phones.includes('+91 44 1234 5678'));
    const home = extractPage(SITE['https://acme.example/'], 'https://acme.example/');
    assert.deepStrictEqual(home.emails, ['hello@acme.example']);
  });
  await test('robots.txt rules and URL normalisation', () => {
    const allowed = parseRobots('User-agent: googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\nDisallow: /tmp*\n');
    assert.strictEqual(allowed('/pricing'), true);
    assert.strictEqual(allowed('/private/x'), false);
    assert.strictEqual(allowed('/tmpfiles'), false);
    assert.strictEqual(normalise('https://a.example/x/?utm_source=y#top'), 'https://a.example/x');
    assert.strictEqual(normalise('https://a.example/x?page=2'), 'https://a.example/x?page=2');
    assert.strictEqual(normalise('https://a.example/x/'), 'https://a.example/x');
  });
  await test('DNS guard refuses private addresses', async () => {
    const err = await new Promise((resolve) => safeLookup('localhost', {}, (e) => resolve(e)));
    assert.ok(err && /Blocked address/.test(err.message), String(err));
  });

  console.log('crawl');
  let result;
  await test('crawls the same site only: sitemap + links, www counts as same site', async () => {
    result = await crawlSite('https://acme.example/', { fetcher: fakeFetch });
    const urls = result.pages.map((p) => p.url).sort();
    assert.deepStrictEqual(urls, ['https://acme.example', 'https://acme.example/about', 'https://acme.example/contact', 'https://acme.example/pricing', 'https://www.acme.example/team'].sort().map((u) => (u === 'https://acme.example' ? 'https://acme.example/' : u)));
    assert.ok(!fetched.some((u) => u.includes('other.example')), 'other sites not fetched');
    assert.ok(!fetched.some((u) => u.includes('/private')), 'robots.txt respected');
    assert.ok(!fetched.some((u) => u.endsWith('.pdf')), 'files skipped');
  });
  await test('footer repeated on every page is kept only on the first page', () => {
    const withFooter = result.pages.filter((p) => p.lines.some((l) => /All rights reserved/.test(l)));
    assert.strictEqual(withFooter.length, 1);
  });
  await test('page limit is respected', async () => {
    const r = await crawlSite('https://acme.example/', { fetcher: fakeFetch, maxPages: 2 });
    assert.strictEqual(r.pages.length, 2);
  });
  await test('rejects non-HTTPS and local addresses up front', async () => {
    await assert.rejects(crawlSite('http://acme.example/', { fetcher: fakeFetch }), /HTTPS/);
    await assert.rejects(crawlSite('https://localhost/', { fetcher: fakeFetch }), /Localhost/);
  });

  console.log('background job');
  await test('crawl job saves pages as knowledge and replaces old pages from the same site', async () => {
    const ws = 'ws-crawl-1';
    await knowledge.ensureSchema();
    await knowledge.addKnowledge(dataDir, { workspaceId: ws, sourceUrl: 'https://acme.example/old-page', content: { paragraphs: ['old'] }, contentType: 'crawl_result' });
    await knowledge.addKnowledge(dataDir, { workspaceId: ws, sourceUrl: 'https://manual.example/faq', content: { paragraphs: ['keep me'] }, contentType: 'manual' });
    const crawl = (url, opts) => crawlSite(url, { ...opts, fetcher: fakeFetch });
    const started = crawlJobs.start({ dataDir, workspaceId: ws, url: 'https://acme.example/', crawl });
    assert.strictEqual(started.job.status, 'running');
    assert.ok(crawlJobs.start({ dataDir, workspaceId: ws, url: 'https://acme.example/', crawl }).error, 'second crawl refused while running');
    let job;
    for (let i = 0; i < 100; i++) { job = crawlJobs.status(dataDir, ws); if (job.status !== 'running') break; await new Promise((r) => setTimeout(r, 20)); }
    assert.strictEqual(job.status, 'done', JSON.stringify(job));
    assert.strictEqual(job.pagesSaved, 5);
    assert.strictEqual(job.pagesRemoved, 1);
    const items = await knowledge.getKnowledge(dataDir, ws);
    assert.ok(items.some((k) => k.source_url === 'https://manual.example/faq'), 'other sites kept');
    assert.ok(!items.some((k) => k.source_url.endsWith('/old-page')), 'old page replaced');
    const pricing = items.find((k) => k.source_url.endsWith('/pricing'));
    assert.match(pricing.content_content, /Growth: ₹2,499 per month/);
    assert.strictEqual(pricing.content_headings[0], 'Pricing', 'page title stored as first heading');
    assert.ok(crawlJobs.lastCrawl(dataDir, ws).finishedAt, 'summary saved');
  });
  await test('a site with no readable pages ends as failed with the reason', async () => {
    const r = crawlJobs.start({ dataDir, workspaceId: 'ws-crawl-2', url: 'https://nothing.example/', crawl: (url, opts) => crawlSite(url, { ...opts, fetcher: fakeFetch }) });
    let job = r.job;
    for (let i = 0; i < 100 && job.status === 'running'; i++) { await new Promise((res) => setTimeout(res, 20)); job = crawlJobs.status(dataDir, 'ws-crawl-2'); }
    assert.strictEqual(job.status, 'failed');
    assert.match(job.error, /HTTP 404/);
  });

  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
  process.exit(process.exitCode || 0);
})();
