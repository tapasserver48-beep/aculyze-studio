/**
 * /api/executive — Executive Agent page (founder / admin / manager only).
 *
 *   GET    /dashboard                      team performance (tasks + check-ins, last 7 days)
 *   GET    /checkins                       check-ins with today's status
 *   POST   /checkins                       create  { title, question, fields, askTime, deadlineTime, days, audienceRole }
 *   PATCH  /checkins/:id                   edit / pause (active:false) / resume
 *   DELETE /checkins/:id
 *   GET    /checkins/:id/report?date=      who answered, numbers, totals, missing
 *   POST   /checkins/:id/ask               ask today now (or again with { force:true })
 *   POST   /checkins/:id/remind            run the deadline step now: reminders + managers' list
 */

const express = require('express');
const { requireUser } = require('../auth/authorize');
const store = require('./store');
const service = require('./service');
const { listTasks } = require('../tasks/store');

const MANAGER_ROLES = ['founder', 'admin', 'manager'];

function createExecutiveRouter({ dataDir }) {
  const router = express.Router();
  router.use(requireUser);
  router.use((req, res, next) => {
    if (!MANAGER_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Only managers and admins can use the Executive Agent page.' });
    next();
  });

  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
    if (!err.status) console.warn(`[executive] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(err.status || 500).json({ error: err.message || 'Something went wrong.' });
  });
  const found = (c) => { if (!c) throw Object.assign(new Error('Check-in not found'), { status: 404 }); return c; };
  const dateOf = (req) => {
    const d = String(req.query.date || (req.body && req.body.date) || '');
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : service.localParts().date;
  };

  router.get('/dashboard', wrap(async (req, res) => {
    res.json(await service.dashboard(dataDir, { listTasks }));
  }));

  router.get('/checkins', wrap(async (req, res) => {
    const today = service.localParts().date;
    const items = [];
    for (const c of store.listCheckins(dataDir)) {
      const report = await service.buildReport(dataDir, c, today);
      items.push({ ...c, today: { date: today, asked: report.asked, submitted: report.submitted, total: report.total, totals: report.totals, escalatedAt: report.escalatedAt } });
    }
    res.json({ checkins: items, today, timeZone: service.timeZone() });
  }));

  router.post('/checkins', wrap(async (req, res) => {
    const checkin = store.createCheckin(dataDir, req.body || {}, req.user.id);
    res.status(201).json({ checkin });
  }));

  router.patch('/checkins/:id', wrap(async (req, res) => {
    found(store.getCheckin(dataDir, req.params.id));
    res.json({ checkin: store.updateCheckin(dataDir, req.params.id, req.body || {}) });
  }));

  router.delete('/checkins/:id', wrap(async (req, res) => {
    found(store.getCheckin(dataDir, req.params.id));
    store.deleteCheckin(dataDir, req.params.id);
    res.json({ ok: true });
  }));

  router.get('/checkins/:id/report', wrap(async (req, res) => {
    const c = found(store.getCheckin(dataDir, req.params.id));
    const dates = store.listRuns(dataDir, c.id).map((r) => r.date).slice(0, 60);
    res.json({ report: await service.buildReport(dataDir, c, dateOf(req)), dates });
  }));

  router.post('/checkins/:id/ask', wrap(async (req, res) => {
    const c = found(store.getCheckin(dataDir, req.params.id));
    const out = await service.askNow(dataDir, c, service.localParts().date, { force: !!(req.body && req.body.force) });
    if (!out.asked && out.reason === 'already asked') throw Object.assign(new Error('Already asked today. Use "Ask again" to send it a second time.'), { status: 409 });
    res.json(out);
  }));

  router.post('/checkins/:id/remind', wrap(async (req, res) => {
    const c = found(store.getCheckin(dataDir, req.params.id));
    const date = service.localParts().date;
    const run = store.getRun(dataDir, c.id, date);
    if (!run || !run.askedAt) throw Object.assign(new Error('Nobody has been asked today yet. Click "Ask now" first.'), { status: 409 });
    res.json(await service.escalate(dataDir, c, date));
  }));

  return router;
}

module.exports = { createExecutiveRouter };
