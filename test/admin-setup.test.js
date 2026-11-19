/**
 * First-admin bootstrap test — the self-disabling setup door.
 *
 *   node test/admin-setup.test.js
 *
 * Covers the ONE rule that makes this safe: every bootstrap path works only
 * while zero admin/founder accounts exist, and then never again.
 *
 *   - store.countAdmins on the JSON backend
 *   - setup.js: setup state, generated vs SETUP_CODE codes, timing-safe
 *     checking, attempt lockout, BOOTSTRAP_ADMIN_* env fallback
 *   - routes: GET/POST /api/auth/setup over real HTTP on a throwaway
 *     dataDir — wrong code, right code, founder created, cookie issued,
 *     and the door slamming shut (403) for good afterwards
 *
 * Uses a temp dataDir + an ephemeral port, so it never touches data/users.json
 * or the server on :3000.
 */
const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/auth/store');
const setup = require('../src/auth/setup');
const { createAuthRouter } = require('../src/auth/routes');

const PW = 'Founder-Pass-12345!';
const EMAIL = 'founder@example.com';

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`PASS ${name}${extra ? ' — ' + extra : ''}`);
  else { failures += 1; console.log(`FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'adminsetup-'));
}

/** Minimal cookie-jar client against an ephemeral server. */
function makeClient(base) {
  let cookie = '';
  return async function call(method, url, body) {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of setCookie) {
      const pair = c.split(';')[0];
      if (pair.startsWith('zara_session=')) cookie = pair;
    }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, data, cookie };
  };
}

async function main() {
  // ===== 1. countAdmins on the JSON backend =====
  const dir = tempDir();
  assert.strictEqual(await store.countAdmins(dir), 0, 'empty store → 0 admins');
  check('countAdmins empty store', true);

  const emp = await store.createUser(dir, {
    name: 'Employee', email: 'emp@example.com', password: PW, role: 'employee',
  });
  const mgr = await store.createUser(dir, {
    name: 'Manager', email: 'mgr@example.com', password: PW, role: 'manager',
  });
  assert.strictEqual(await store.countAdmins(dir), 0, 'employee + manager → still 0');
  check('countAdmins ignores employee/manager', true);

  await store.updateUser(dir, emp.id, { role: 'admin' });
  assert.strictEqual(await store.countAdmins(dir), 1, 'one admin counted');
  await store.updateUser(dir, mgr.id, { role: 'founder' });
  assert.strictEqual(await store.countAdmins(dir), 2, 'admin + founder counted');
  check('countAdmins counts admin and founder', true);

  // ===== 2. setup state follows countAdmins =====
  const open = await setup.setupState(tempDir());
  assert.deepStrictEqual(open, { needed: true, codeSource: 'generated' }, 'fresh dir → open');
  const closed = await setup.setupState(dir);
  assert.strictEqual(closed.needed, false, 'admin present → permanently closed');
  check('setupState open/closed', true);

  // ===== 3. setup code: generated vs env, and the normaliser =====
  const genA = setup.setupCode({});
  const genB = setup.setupCode({});
  assert.strictEqual(genA, genB, 'one code per process');
  assert.strictEqual(genA.length, setup.CODE_LENGTH, '12 characters');
  assert.ok(setup.checkSetupCode(genA, {}), 'generated code matches itself');
  assert.ok(!setup.checkSetupCode('definitely-wrong', {}), 'wrong code rejected');
  check('setupCode generated + checked', true, genA);

  assert.strictEqual(setup.setupCode({ SETUP_CODE: 'AbCd-1234' }), 'ABCD1234', 'env wins, normalised');
  assert.strictEqual(setup.setupCode({ SETUP_CODE: '   ' }), genA, 'blank env falls back to generated');
  assert.ok(setup.checkSetupCode('  abcd-1234 ', { SETUP_CODE: 'AbCd-1234' }), 'user input normalised too');
  assert.ok(!setup.checkSetupCode('abcd1235', { SETUP_CODE: 'AbCd-1234' }), 'near-miss rejected');
  check('setupCode env override + normalisation', true);

  // ===== 4. wrong-code delay (deliberately NOT a lockout) =====
  // A shared lockout would let anyone deny the founder the setup form — on
  // Render every visitor shares the proxy's req.ip. Guessing is already
  // hopeless, so a wrong code only costs the guesser a fixed delay, which
  // must never apply to a correct code.
  assert.strictEqual(setup.WRONG_CODE_DELAY_MS > 0, true, 'delay is configured');
  const t0 = Date.now();
  await setup.delayWrongCode();
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= setup.WRONG_CODE_DELAY_MS - 20,
    `wrong code delayed at least ${setup.WRONG_CODE_DELAY_MS}ms (took ${elapsed}ms)`);
  check('wrong code is delayed, never locked out', true, `${elapsed}ms`);

  // ===== 5. BOOTSTRAP_ADMIN_EMAIL env fallback =====
  const envDir = tempDir();

  const unset = await setup.bootstrapAdminFromEnv(envDir, {});
  assert.strictEqual(unset.acted, false);
  assert.strictEqual(unset.reason, 'unset', 'no env var → inert');
  check('bootstrap inert without BOOTSTRAP_ADMIN_EMAIL', true);

  // No account + no password → must not invent one.
  const noPw = await setup.bootstrapAdminFromEnv(envDir, { BOOTSTRAP_ADMIN_EMAIL: 'ghost@example.com' });
  assert.strictEqual(noPw.acted, false);
  assert.strictEqual(noPw.reason, 'missing_password', 'no account and no password → refuse');
  assert.strictEqual(await store.countAdmins(envDir), 0, 'and nothing was created');
  check('bootstrap refuses to create without a password', true);

  // Existing employee + password present → promoted to founder.
  const victim = await store.createUser(envDir, {
    name: 'Barathi', email: 'barathi@example.com', password: PW, role: 'employee',
  });
  const promoted = await setup.bootstrapAdminFromEnv(envDir, {
    BOOTSTRAP_ADMIN_EMAIL: 'Barathi@Example.com', // case-insensitive
  });
  assert.strictEqual(promoted.acted, true, 'promoted');
  assert.strictEqual(promoted.action, 'promoted');
  assert.strictEqual(promoted.role, 'founder');
  assert.strictEqual(await store.countAdmins(envDir), 1, 'now exactly one admin');
  const after = await store.findById(envDir, victim.id);
  assert.strictEqual(after.role, 'founder', 'role actually updated');
  check('bootstrap promotes an existing employee', true);

  // Now that an admin exists the env var must go inert, forever.
  const again = await setup.bootstrapAdminFromEnv(envDir, {
    BOOTSTRAP_ADMIN_EMAIL: 'someone-else@example.com',
    BOOTSTRAP_ADMIN_PASSWORD: PW,
  });
  assert.strictEqual(again.acted, false);
  assert.strictEqual(again.reason, 'already_has_admin', 'closed once an admin exists');
  assert.strictEqual(await store.countAdmins(envDir), 1, 'no second admin appeared');
  check('bootstrap closes permanently after the first admin', true);

  // Missing-password warning is reported without acting.
  const warnDir = tempDir();
  const warned = await setup.bootstrapAdminFromEnv(warnDir, { BOOTSTRAP_ADMIN_EMAIL: 'new@example.com' });
  assert.strictEqual(warned.reason, 'missing_password');
  check('bootstrap reports missing password', true);

  // BOOTSTRAP_ADMIN_ROLE is honoured but clamped to a privileged role.
  const roleDir = tempDir();
  await store.createUser(roleDir, { name: 'M', email: 'm@example.com', password: PW, role: 'employee' });
  const clamped = await setup.bootstrapAdminFromEnv(roleDir, {
    BOOTSTRAP_ADMIN_EMAIL: 'm@example.com',
    BOOTSTRAP_ADMIN_ROLE: 'manager', // nonsense for a bootstrap → founder
  });
  assert.strictEqual(clamped.role, 'founder', 'role clamped to founder');
  check('bootstrap clamps BOOTSTRAP_ADMIN_ROLE', true);

  // ===== 5b. firstAdminBootstrap — the boot banner Render will actually run =====
  const bootLog = [];
  const log = (...a) => bootLog.push(a.join(' '));

  // Open window, no env → the generated code is printed (operator's only copy).
  const openDir = tempDir();
  bootLog.length = 0;
  await setup.firstAdminBootstrap(openDir, {}, log);
  const openLines = bootLog.join('\n');
  assert.ok(openLines.includes('no admin yet'), 'announces the open window');
  assert.ok(/first-admin code [A-Z0-9]{12}/.test(openLines), 'prints the generated code');
  check('boot banner prints the code when the window is open', true);

  // Operator's own SETUP_CODE is referenced, never echoed.
  bootLog.length = 0;
  await setup.firstAdminBootstrap(openDir, { SETUP_CODE: 'MY-SECRET-CODE' }, log);
  const envLines = bootLog.join('\n');
  assert.ok(envLines.includes('SETUP_CODE'), 'points at the env var');
  assert.ok(!envLines.includes('MYSECRETCODE'), 'does not echo the chosen code');
  check('boot banner never echoes SETUP_CODE', true);

  // Closed window → no code is advertised at all (no dead door in the logs).
  const closedDir = tempDir();
  await store.createUser(closedDir, { name: 'A', email: 'a@example.com', password: PW, role: 'admin' });
  bootLog.length = 0;
  await setup.firstAdminBootstrap(closedDir, {}, log);
  const closedLines = bootLog.join('\n');
  assert.ok(!closedLines.includes('first-admin code'), 'no code once an admin exists');
  check('boot banner stays silent when an admin exists', true);

  // A bootstrap failure must never stop the server from starting.
  // (A hostile dataDir is NOT enough — readJsonDoc swallows read errors — so
  // break the env read itself, which is the realistic failure mode.)
  const hostileEnv = {};
  Object.defineProperty(hostileEnv, 'BOOTSTRAP_ADMIN_EMAIL', {
    get() { throw new Error('boom'); },
  });
  bootLog.length = 0;
  await setup.firstAdminBootstrap(tempDir(), hostileEnv, log);
  assert.ok(bootLog.join('\n').includes('bootstrap skipped'), 'failure is caught and logged');
  check('boot bootstrap never throws', true);

  // ===== 6. HTTP: the real /api/auth/setup lifecycle =====
  const webDir = tempDir();
  const app = express();
  app.use(express.json());
  // Mirror server.js: attachAuth resolves the session cookie into req.user
  // before the router, which is what the admin guards check.
  app.use(require('../src/auth/session').attachAuth(webDir));
  app.use('/api/auth', createAuthRouter({ dataDir: webDir }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const anon = makeClient(base);
  const CODE = 'SETUP-CODE-99';

  // Point the server's code at a known value for this process.
  const prevCode = process.env.SETUP_CODE;
  process.env.SETUP_CODE = CODE;

  try {
    let r = await anon('GET', '/api/auth/setup');
    assert.strictEqual(r.status, 200, 'GET /setup answers 200');
    assert.strictEqual(r.data.needed, true, 'no admins yet → needed');
    assert.strictEqual(r.data.codeSource, 'env', 'codeSource follows SETUP_CODE');
    check('GET /setup reports the window open', true);

    // Wrong code → 401, and no account is created.
    r = await anon('POST', '/api/auth/setup', {
      name: 'Fake', email: 'fake@example.com', password: PW, code: 'nope-nope-nope',
    });
    assert.strictEqual(r.status, 401, 'wrong code → 401');
    assert.strictEqual(r.data.code, 'bad_setup_code');
    assert.strictEqual(await store.countUsers(webDir), 0, 'nothing created on a bad code');
    check('POST /setup rejects a wrong code', true);

    // Missing code → 401 too (falsy fails checkSetupCode).
    r = await anon('POST', '/api/auth/setup', {
      name: 'Fake', email: 'fake@example.com', password: PW,
    });
    assert.strictEqual(r.status, 401, 'missing code → 401');
    check('POST /setup requires a code', true);

    // Right code → 201 founder + session cookie.
    r = await anon('POST', '/api/auth/setup', {
      name: 'First Founder', email: EMAIL, password: PW, code: CODE,
    });
    assert.strictEqual(r.status, 201, 'correct code → 201');
    assert.strictEqual(r.data.user.role, 'founder', 'first account is a founder');
    assert.strictEqual(r.data.user.email, EMAIL);
    assert.strictEqual(r.data.user.pages.admin, true, 'founder sees the Admin page');
    assert.ok(r.cookie.includes('zara_session='), 'session cookie issued');
    check('POST /setup creates the founder', true);

    // Validation still applies (short password) even with the right code.
    // — door is now closed, so this must 403 before it even validates.

    // Window is shut for good.
    r = await anon('GET', '/api/auth/setup');
    assert.strictEqual(r.data.needed, false, 'one founder → window closed');
    check('GET /setup reports closed afterwards', true);

    r = await anon('POST', '/api/auth/setup', {
      name: 'Second', email: 'second@example.com', password: PW, code: CODE,
    });
    assert.strictEqual(r.status, 403, 'second attempt → 403');
    assert.strictEqual(r.data.code, 'setup_complete');
    assert.strictEqual(await store.countUsers(webDir), 1, 'still only the one founder');
    check('POST /setup is refused forever after', true);

    // A signed-in founder can use the normal admin API (door really worked).
    r = await anon('GET', '/api/auth/users');
    assert.strictEqual(r.status, 200, 'founder reaches the admin user list');
    check('bootstrap founder can use the Admin API', true, `${r.data.users.length} user(s)`);

    // A wrong code on a closed door must not even be evaluated (403 first),
    // so it costs no delay and can never be used to probe the code.
    const probeStart = Date.now();
    r = await anon('POST', '/api/auth/setup', {
      name: 'X', email: 'x@example.com', password: PW, code: 'wrong',
    });
    const probeMs = Date.now() - probeStart;
    assert.strictEqual(r.status, 403, 'closed door checks closure before the code');
    assert.ok(probeMs < setup.WRONG_CODE_DELAY_MS,
      `no wrong-code delay on a closed door (took ${probeMs}ms)`);
    check('closed door short-circuits before the code check', true, `${probeMs}ms`);
  } finally {
    if (prevCode === undefined) delete process.env.SETUP_CODE;
    else process.env.SETUP_CODE = prevCode;
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(envDir, { recursive: true, force: true });
    fs.rmSync(warnDir, { recursive: true, force: true });
    fs.rmSync(roleDir, { recursive: true, force: true });
    fs.rmSync(openDir, { recursive: true, force: true });
    fs.rmSync(closedDir, { recursive: true, force: true });
    fs.rmSync(webDir, { recursive: true, force: true });
  }

  if (failures) {
    console.log(`\nRESULT: ${failures} failed`);
    process.exit(1);
  }
  console.log('\nRESULT: OK');
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
