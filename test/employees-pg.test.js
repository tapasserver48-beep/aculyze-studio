/**
 * AI employee registry on PostgreSQL (pg-mem). Regression for Render:
 * "invalid input syntax for type json" because capabilities (a JS array)
 * were sent to a JSONB column as a Postgres array literal, so no AI
 * employees could ever be created.
 *
 *   node test/employees-pg.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { newDb } = require('pg-mem');

delete process.env.DATABASE_URL;
const pgPath = require.resolve('pg');
const mem = newDb();
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: mem.adapters.createPg() };

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`PASS ${name}`);
  else { failures += 1; console.log(`FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emp-pg-'));
  process.env.ACULYZE_DATA_DIR = dir;
  const pg = require('../src/db/pg');
  await pg.init('postgres://test@localhost/test');
  const emps = require('../src/employees/store');
  await emps.ensureSchema();

  try {
    console.log('\n=== 1. Initialize AI employees on Postgres ===');
    for (const code of ['AI-CHIEF-001', 'AI-EXEC-001', 'AI-CUSTOMER-001']) {
      const r = await emps.initializeEmployee(dir, code);
      check(`${code} created`, r.created === true, JSON.stringify(r).slice(0, 160));
    }
    const again = await emps.initializeEmployee(dir, 'AI-CHIEF-001');
    check('initializing twice does not duplicate', again.created === false && again.reason === 'already_exists');

    console.log('\n=== 2. Reads return full employees ===');
    const list = await emps.listEmployees(dir);
    check('list has all 3', list.length === 3, String(list.length));
    const chief = list.find((e) => e.employee_code === 'AI-CHIEF-001');
    check('list includes capabilities (tools/permissions depend on them)', Array.isArray(chief.capabilities) && chief.capabilities.includes('gmail_readwrite'), JSON.stringify(chief.capabilities));
    check('list includes system instructions', /Chief of Staff/.test(chief.system_instructions || ''));
    const byCode = await emps.findByCode(dir, 'AI-EXEC-001');
    check('findByCode returns capabilities as an array', Array.isArray(byCode.capabilities) && byCode.capabilities.includes('inbox_communication'));
    check('permissions come back as an object', byCode.permissions && byCode.permissions.inbox === true, JSON.stringify(byCode.permissions));

    console.log('\n=== 3. Partial update keeps the other fields ===');
    const paused = await emps.updateEmployee(dir, chief.id, { status: 'inactive' });
    check('status-only update succeeds', paused && paused.status === 'inactive');
    const after = await emps.findById(dir, chief.id);
    check('name and capabilities kept', after.name === 'Chief of Staff' && after.capabilities.length === chief.capabilities.length);
    await emps.updateEmployee(dir, chief.id, { status: 'active', capabilities: [...chief.capabilities, 'reporting'] });
    const after2 = await emps.findById(dir, chief.id);
    check('capabilities update stored as JSON', after2.status === 'active' && Array.isArray(after2.capabilities));

    console.log('\n=== 4. Chief of Staff team view works on Postgres ===');
    const auth = require('../src/auth/store');
    await auth.createUser(dir, { name: 'Founder', email: 'f@t.com', password: 'TestPass-12345!', role: 'founder' });
    const { buildRegistry } = require('../src/chiefOfStaff/index');
    const reg = await buildRegistry(dir, (await auth.listUsers(dir))[0].id);
    const ai = (reg.ai || reg.candidates || []).filter((c) => String(c.id).startsWith('emp-ai-'));
    check('registry lists the AI employees with skills', ai.length === 3 && ai.some((c) => (c.skills || []).length > 0), JSON.stringify(ai).slice(0, 200));

    console.log('\n=== 5. Admin "Initialize AI Employees" button (real route) ===');
    const express = require('express');
    const { attachAuth } = require('../src/auth/session');
    const { createAuthRouter } = require('../src/auth/routes');
    const { createEmployeesRouter } = require('../src/employees/routes');
    const app = express();
    app.use(express.json());
    app.use(attachAuth(dir));
    app.use('/api/auth', createAuthRouter({ dataDir: dir }));
    app.use('/api/employees', createEmployeesRouter({ dataDir: dir }));
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'f@t.com', password: 'TestPass-12345!' }) });
      const cookie = (login.headers.getSetCookie() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('zara_session='));
      await emps.deleteEmployee(dir, byCode.id); // Executive Agent missing, like a fresh database
      const res = await fetch(`${base}/api/employees/initialize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ codes: ['AI-CHIEF-001', 'AI-CUSTOMER-001', 'AI-EXEC-001'] }),
      });
      const data = await res.json();
      const by = Object.fromEntries((data.results || []).map((r) => [r.code, r]));
      check('no "unknown_code" for the real codes', !(data.results || []).some((r) => r.reason === 'unknown_code'), JSON.stringify(data));
      check('missing Executive Agent is created', by['AI-EXEC-001'] && by['AI-EXEC-001'].created === true);
      check('existing ones are reported as already there', by['AI-CHIEF-001'] && by['AI-CHIEF-001'].reason === 'already_exists');
      const list2 = await fetch(`${base}/api/employees`).then((r) => r.json());
      check('GET /api/employees lists all 3 AI employees', (list2.employees || []).length === 3, JSON.stringify(list2).slice(0, 200));
    } finally {
      server.close();
    }
  } catch (err) {
    failures += 1;
    console.error('FAIL (exception)', err);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (failures) { console.log(`\nRESULT: ${failures} failed`); process.exit(1); }
  console.log('\nRESULT: OK - AI employees work on PostgreSQL');
  process.exit(0);
}

main();
