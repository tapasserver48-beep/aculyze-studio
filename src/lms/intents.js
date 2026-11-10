/**
 * Shared LMS question intents (A3) — ONE classifier + answer formatter for
 * "our business data" questions.
 *
 * Previously `server.js /api/sales/chat` and `src/integrations/router.js`
 * each had their own regex stack for the same question (D9): fixing a keyword
 * in one and forgetting the other made them drift. Both now import from here.
 *
 * Two consumers:
 *   • server.js Sales Agent → classify + format direct answers (count/list)
 *   • integrations/router.js → classify → which read tools to plan
 *
 * Pure functions, no I/O, no side effects.
 */

/**
 * @param {string} question raw user question
 * @returns {{ isLead, isCustomer, isSale, isEmployee, isSummary,
 *             wantsCount, wantsList, wantsValue, wantsTop,
 *             resources: string[], wantsSummaryTool: boolean }}
 */
function classifyLmsIntent(question) {
  const q = String(question || '').toLowerCase();

  const isLead = /\bleads?\b/.test(q);
  const isCustomer = /\bcustomers?\b|\bcompanies\b|\bprospects\b/.test(q);
  const isSale = /\bsales?\b|\bproposals?\b|\brevenue\b|\borders?\b/.test(q);
  const isEmployee = /\bemployees?\b|\bsalespersons?\b|\bstaff\b|\bteam members?\b|\bheadcount\b|\btop\b/.test(q);
  const isSummary = /\bsummary\b|\btotals?\b|\boverview\b|\bdashboard\b|\bsnapshot\b|\bhealth\b/.test(q);

  const wantsCount = /\bhow many\b|\bcount\b|\btotal\b|\bnumber\b/.test(q);
  const wantsList = /\bshow\b|\blist\b|\bdisplay\b|\bpipeline\b|\blatest\b|\brecent\b|\bwho\b|\bwhich\b/.test(q);
  const wantsValue = /\bhow much\b|\btotal\b|\bvalue\b|\bamount\b/.test(q);
  const wantsTop = /\btop\b|\bbest\b|\bperformance\b/.test(q);

  // Which resources to fetch (deduped, stable order). A "summary" question
  // needs the sales summary regardless of which noun appears.
  const resources = [];
  if (isLead) resources.push('leads');
  if (isCustomer) resources.push('customers');
  if (isSale) resources.push('sales');
  if (isEmployee) resources.push('employees');

  return {
    isLead, isCustomer, isSale, isEmployee, isSummary,
    wantsCount, wantsList, wantsValue, wantsTop,
    resources,
    wantsSummaryTool: isSummary || wantsTop || (isSale && /\bsummary\b|\bmonth\b|\bperformance\b|\bfigures\b/.test(q)),
    // Fallback rule (matches the original Sales Agent): a question with NO
    // recognized business noun still means "my data" → start at leads.
    isEmpty: !resources.length && !isSummary,
  };
}

/** Rows → "- line" bullets (max n). */
function bullets(rows, lineOf, n = 10) {
  return (rows || []).slice(0, n).map((r) => `- ${lineOf(r)}`).join('\n');
}

/**
 * Build the deterministic direct answer for a classified intent.
 * Returns { directAnswer, lmsFacts } — either may be '' when the question
 * doesn't map to a canned shape (the caller then falls back to facts + LLM).
 *
 * @param {ReturnType<typeof classifyLmsIntent>} intent
 * @param {string} qLower lowercased question
 * @param {{ leads?, customers?, sales?, summary? }} fetched
 *        fetched.leads/customers/sales = { rows, total } from getRecords
 *        fetched.summary = getSalesSummary result
 */
function formatLmsAnswer(intent, qLower, fetched = {}) {
  let directAnswer = '';
  let lmsFacts = '';

  if ((intent.isLead || intent.isEmpty) && fetched.leads) {
    const { rows = [], total = 0 } = fetched.leads;
    if (intent.wantsCount) {
      directAnswer = `According to Aculyze LMS, we have ${total} lead${total !== 1 ? 's' : ''}.`;
    } else if (intent.wantsList) {
      const list = bullets(rows, (r) => {
        const emp = r.assigned_employee ? r.assigned_employee.name : 'unassigned';
        return `${r.company || 'Unknown'} — ${r.status_label || r.status}, ${r.stage}, ${r.temperature_label || r.temperature}, assigned to ${emp}`;
      });
      directAnswer = `According to Aculyze LMS, here are your leads (${total} total):\n${list}`;
    }
    lmsFacts = `Leads: ${total} total. Recent: ${(rows || []).slice(0, 5).map((r) => `${r.company || 'Unknown'} (${r.status_label || r.status})`).join(', ')}.`;
  }

  if (intent.isCustomer && fetched.customers) {
    const { rows = [], total = 0 } = fetched.customers;
    if (intent.wantsCount) {
      directAnswer = `According to Aculyze LMS, we have ${total} customer${total !== 1 ? 's' : ''}.`;
    } else if (intent.wantsList) {
      const list = bullets(rows, (r) => {
        const emp = r.assigned_employee ? r.assigned_employee.name : 'unassigned';
        return `${r.company_name || r.company || 'Unknown'} — ${r.city || '—'}, ${r.industry || '—'}, assigned to ${emp}`;
      });
      directAnswer = `According to Aculyze LMS, here are your customers (${total} total):\n${list}`;
    }
    lmsFacts = `Customers: ${total} total.`;
  }

  if ((intent.isSale || intent.isSummary) && fetched.sales) {
    const rows = fetched.sales.rows || [];
    const totalAmt = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
    if (intent.wantsValue) {
      directAnswer = `According to Aculyze LMS, total sales value is ${totalAmt.toLocaleString()} across ${rows.length} record${rows.length !== 1 ? 's' : ''}.`;
    } else if (intent.wantsList) {
      const list = bullets(rows, (r) =>
        `${r.proposal_number || r.id} — ${r.customer || '—'}, ${r.amount} ${r.currency || 'INR'}, ${r.status}, ${r.date || '—'}`);
      directAnswer = `According to Aculyze LMS, here are your latest sales (${rows.length} records, total ${totalAmt.toLocaleString()}):\n${list}`;
    }
    lmsFacts = `Sales: ${rows.length} records, total value ${totalAmt.toLocaleString()}.`;
  }

  if ((intent.isEmployee || intent.isSummary) && fetched.summary) {
    const summary = fetched.summary;
    if (intent.wantsTop && !directAnswer) {
      const byEmp = summary.byEmployee || [];
      if (byEmp.length) {
        const sorted = [...byEmp].sort((a, b) => Number(b.total_sales || 0) - Number(a.total_sales || 0));
        const top = sorted[0];
        directAnswer = `According to Aculyze LMS, your top salesperson is ${top.employee} with ${top.orders} order${top.orders !== 1 ? 's' : ''} and ${top.total_sales} total sales.`;
      }
    }
    if (intent.wantsCount && !directAnswer && summary.summary) {
      const s = summary.summary;
      directAnswer = `According to Aculyze LMS, we have ${s.total_sales} total sales (${s.currency}), ${s.orders} orders, ${s.customers} customers, average order value ${s.average_order_value} ${s.currency}.`;
    }
    if (!lmsFacts) {
      lmsFacts = `Summary: ${summary.summary?.total_sales || 0} total sales, ${summary.summary?.orders || 0} orders, ${summary.summary?.customers || 0} customers.`;
    }
  }

  return { directAnswer, lmsFacts };
}

/** Guard: general-knowledge questions ("what is a sales funnel") are NOT
 *  about the user's data — answer from the model, skip the LMS entirely. */
function isGeneralKnowledge(question) {
  const q = String(question || '').trim().toLowerCase();
  const startsRight = /^(what|who|where|when|why|how)\s+(is|are|was|were|do|does|can|could|would|should)\b/.test(q);
  if (!startsRight) return false;
  const aboutUser = /\b(my|our|us|we|the company|this|current|latest|recent|today)\s/.test(q);
  if (aboutUser) return false;
  return /\bmean|definition|concept|term|explain\b/.test(q) || /\bis a\b|\bare a\b/.test(q);
}

module.exports = { classifyLmsIntent, formatLmsAnswer, isGeneralKnowledge, bullets };
