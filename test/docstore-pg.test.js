/**
 * Document store on PostgreSQL (pg-mem): what used to be files under data/
 * survives a "Render wipe" (files deleted) and a restart.
 *
 *   node test/docstore-pg.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { newDb } = require('pg-mem');

delete process.env.DATABASE_URL;
delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
delete process.env.AUTH_SESSION_KEY;

const pgPath = require.resolve('pg');
function useMemDb(mem) {
  require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: mem.adapters.createPg() };
}

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`PASS ${name}`);
  else { failures += 1; console.log(`FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

function writeFile(dir, rel, body) {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docstore-'));
  // Legacy files, as a server running in file mode would have left them.
  const authKey = 'a'.repeat(64);
  const integKey = 'b'.repeat(64);
  writeFile(dir, '.auth-key', authKey);
  writeFile(dir, '.integrations-key', integKey);
  writeFile(dir, 'automations/automations.json', { items: [{ id: 'auto-legacy', name: 'Legacy automation', active: true, trigger: { type: 'lead' }, employeeId: 'emp-ai-x', instruction: 'Old instruction text', maxRunsPerDay: 10, ownerId: 'u1', created_at: 1 }] });
  writeFile(dir, 'agent-approvals.json', { items: [{ id: 'appr-1', status: 'pending', taskId: 't1', initiatingUserId: 'u1', created_at: 1 }] });
  writeFile(dir, 'executive/checkins.json', { items: [{ id: 'chk-1', title: 'Daily sales', created_at: 1 }] });
  writeFile(dir, 'integrations/user-0001.json', { connections: { gmail: { status: 'connected', account: 'me@x.com' } }, pending: {} });
  writeFile(dir, 'delegation/plans.json', { plans: [{ id: 'plan-1' }] });

  const mem = newDb();
  useMemDb(mem);
  const pg = require('../src/db/pg');
  await pg.init('postgres://test@localhost/test');
  const docstore = require('../src/db/docstore');

  try {
    console.log('\n=== 1. First boot on Postgres imports the files ===');
    const info = await docstore.init(dir);
    check('mode is postgres', info.mode === 'postgres');
    check('all 7 legacy documents imported', info.imported === 7, JSON.stringify(info));

    console.log('\n=== 2. Render wipes the disk: everything still readable ===');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const autoStore = require('../src/automations/store');
    const approvals = require('../src/execution/approvals');
    const exec = require('../src/executive/store');
    const integ = require('../src/integrations/store');
    const plans = require('../src/chiefOfStaff/plans');
    check('automations survive', autoStore.list(dir).some((a) => a.id === 'auto-legacy'));
    check('pending approvals survive', approvals.getApproval(dir, 'appr-1') && approvals.getApproval(dir, 'appr-1').status === 'pending');
    check('Executive check-ins survive', exec.listCheckins(dir).some((c) => c.id === 'chk-1'));
    check('Gmail connection survives', integ.loadUser(dir, 'user-0001').connections.gmail.account === 'me@x.com');
    check('Chief of Staff plans survive', (plans.listPlans ? null : null) === null && docstore.readJson(dir, path.join(dir, 'delegation/plans.json'), {}).plans[0].id === 'plan-1');
    check('session key survives (nobody logged out)', docstore.readText(dir, path.join(dir, '.auth-key')) === authKey);
    check('app-connection key survives (tokens stay readable)', docstore.readText(dir, path.join(dir, '.integrations-key')) === integKey);
    const secret = integ.encrypt(dir, 'gmail-refresh-token');
    check('encryption uses the stored key (round trip)', integ.decrypt(dir, secret) === 'gmail-refresh-token');
    check('no files were recreated on disk', fs.readdirSync(dir).length === 0, fs.readdirSync(dir).join(','));

    console.log('\n=== 3. New writes go to Postgres ===');
    const created = autoStore.create(dir, { name: 'Morning briefing', instruction: 'Summarize my emails every morning.', employeeId: 'emp-ai-chief', trigger: { type: 'schedule', mode: 'daily', time: '09:00', days: [1] } }, 'u1');
    approvals.createApproval(dir, { taskId: 't2', employeeId: 'emp-ai-x', initiatingUserId: 'u1', tool: 'gmail.send_message', args: {} });
    integ.saveUser(dir, 'user-0002', { connections: { gmail: { status: 'connected' } }, pending: {} });
    await docstore.flush();
    const { rows } = await pg.query('SELECT path, body FROM app_documents ORDER BY path');
    const byPath = Object.fromEntries(rows.map((r) => [r.path, r.body]));
    check('automation row updated', (byPath['automations/automations.json'] || '').includes(created.id));
    check('approval row updated', (byPath['agent-approvals.json'] || '').includes('"t2"'));
    check('new user connection row created', !!byPath['integrations/user-0002.json']);
    check('rows use forward-slash paths', rows.every((r) => !r.path.includes('\\')));

    console.log('\n=== 4. Restart: a fresh process loads from Postgres ===');
    delete require.cache[require.resolve('../src/db/docstore')];
    const docstore2 = require('../src/db/docstore');
    const info2 = await docstore2.init(dir);
    check('nothing re-imported on restart', info2.imported === 0, JSON.stringify(info2));
    const doc = docstore2.readJson(dir, path.join(dir, 'automations/automations.json'), { items: [] });
    check('restart sees the automation created before it', doc.items.some((a) => a.id === created.id));
    docstore2.remove(dir, path.join(dir, 'integrations/user-0002.json'));
    await docstore2.flush();
    const left = await pg.query("SELECT path FROM app_documents WHERE path = 'integrations/user-0002.json'");
    check('remove deletes the row', left.rows.length === 0);
  } catch (err) {
    failures += 1;
    console.error('FAIL (exception)', err);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (failures) { console.log(`\nRESULT: ${failures} failed`); process.exit(1); }
  console.log('\nRESULT: OK - document store survives wipes and restarts');
  process.exit(0);
}

main();
