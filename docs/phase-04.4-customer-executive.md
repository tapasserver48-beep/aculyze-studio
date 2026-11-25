# Phase 04.4 Stage A: Customer Executive website assistant

The Customer Executive now works end to end: a business adds its website, the assistant reads it, the owner tests it, publishes it, and pastes one line of code onto their site. Visitors get answers from the website's own pages, with sources. When the website doesn't cover a question, the assistant says so and offers to take contact details, which become leads.

Stages B (memory) and C (research upgrade) of 04.4 are not built yet.

## What was broken before

The Customer Executive existed on the server but could not be used:

| Problem | Effect |
|---|---|
| The page was a placeholder; its buttons did nothing | Nobody could reach the feature |
| Visitor endpoints sat behind the sign-in check | Every website visitor got "Please sign in" |
| `getChatbotByPublishKey` and `crypto` were never imported | Visitor chat and lead capture crashed |
| `knowledge` used outside its block in the chat route | Crashed whenever an answer had sources |
| Answers were the raw text of matching pages glued together, no AI | Visitors got walls of page text |
| The crawler never awaited its page extraction; did nothing without Postgres; launched Chrome per page; followed links to other sites | No website could be read |
| `updateChatbot` pasted request keys into SQL and numbered parameters wrongly | SQL injection, and on Postgres no chatbot could be edited, approved or published |
| `store.js` created an older design of five tables first | On Postgres every chatbot, lead, conversation and knowledge insert failed |
| `leads.conversation` was `TEXT[]` but written as JSON | Leads failed on Postgres |
| `getWorkspaceInfo` read only the JSON file; `listConversations` always queried Postgres | Approve failed on Postgres; conversations failed without it |
| The public chatbot info returned the private instructions | Internal prompt visible to anyone |

## How it works now

```
Business website ──crawl──► knowledge (pages) ──BM25 passages──► AI answer with [1] citations
                                                     │
                                         weak / NO_ANSWER ──► "I don't know" + contact form ──► lead
```

### Crawler (`src/customerExecutive/siteCrawler.js`, `crawlJobs.js`)
- Downloads HTML directly (no browser), so it runs on Render.
- Same site only (`www.` counts as the same site), seeds from `sitemap.xml`, honours `robots.txt`, skips files, logins and carts.
- SSRF safe: HTTPS only, and every connection's resolved IP is checked at connect time (custom DNS lookup), including after redirects.
- Limits: 10, 30 or 60 pages (80 max), 2 MB and 12 s per page, 3 requests at a time.
- Drops menus, scripts and styles, and keeps lines repeated on most pages (footers) only on the first page.
- Runs in the background with live progress; a new crawl replaces earlier pages from the same site.

### Answers (`retrieval.js`, `answer.js`)
- Pages are split into ~140-word passages, ranked with BM25 plus boosts for words in the page title or URL, for the visitor's words in the same order, and for a page's opening passage. Duplicate text across pages (translations) is dropped.
- The AI answers only from the top passages and cites them; citations are mapped back to page links, and the same page in several languages counts as one source.
- Corrective steps: a short follow-up borrows the previous question; if retrieval is still weak, the AI is not called; if the AI says the passages don't cover it, the visitor gets "I don't know" plus the contact form.
- Without an AI model, the best passage is shown as a short excerpt.

Keyword search can't connect different words with the same meaning ("open on Sunday" vs "Monday to Saturday"). That needs embeddings, which are not configured.

### Visitor safety
- Rate limits: 12 messages a minute per visitor IP, 2,000 a day per assistant (`CUSTOMER_BOT_PER_MIN`, `CUSTOMER_BOT_PER_DAY`).
- Conversation history comes from the server, never the browser; a conversation id from another assistant is ignored.
- Leads need consent; the chat transcript is attached to the lead.
- The edit endpoint only changes name, description and instructions. Approval and publishing have their own endpoints.

### Database (`schema.js`)
One definition per Customer Executive table. At boot it creates missing tables and repairs tables in the older design without dropping data: adds missing columns, removes NOT NULL from old columns, converts `leads.conversation` to JSONB.

## The page (`public/js/customer-view.js`)
- **First run:** business name + website address → reads up to 30 pages.
- **Assistant:** name, welcome message, instructions; a test chat using the same engine as the widget, showing sources and "Answered from your website" / "Not on your website"; Approve and publish; embed code with Copy.
- **Website pages:** read again with live progress and Stop; table of pages with word counts; remove a page.
- **Leads** and **Conversations** from the widget.
- Managers can now see the page (founders and admins already could).

## The widget (`public/widget/aculyze-chat.js`)
```html
<script src="https://YOUR-STUDIO/widget/aculyze-chat.js" data-key="pub_…" async></script>
```
Chat bubble and panel in Shadow DOM (the host site's CSS can't break it), clickable citations, contact form when the assistant doesn't know, full-screen on phones, Escape closes. Optional `data-color` and `data-position="left"`.

## New API
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/customer/workspaces/:id/overview` | Workspace, pages, assistant(s) with lead counts, crawl status |
| POST / GET / DELETE | `/api/customer/workspaces/:id/site-crawl` | Start / watch / stop reading the website |
| POST | `/api/customer/chatbots/:id/test` | Owner's test chat (works in draft) |
| POST | `/api/customer/chatbots/:id/unpublish` | Take the assistant offline |
| GET | `/api/customer/chatbots/:id/conversations` | Recent visitor conversations |

## Tests
- `node test/customer-answers.test.js` (18): retrieval, grounded answers, corrective "don't know", public endpoints, rate limit, leads, owner test chat.
- `node test/customer-pg.test.js`: the same stores on Postgres (pg-mem), starting from the OLD table design to prove the repair.
- `node test/site-crawler.test.js` (9): extraction, same-site crawling, sitemap, robots.txt, boilerplate, SSRF guard, background job.
- End to end in a browser on a temporary app copy: onboarding read 30 real pages from apachefriends.org, test chat answered with sources, publish, widget on a separate page answered, offered the contact form, saved the lead, and the lead and conversation appeared in the app. Light and dark themes, desktop and mobile.
