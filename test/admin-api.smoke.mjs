/**
 * Admin API smoke test — exercises the real HTTP routes on localhost:3000.
 *
 *   node test/admin-api.smoke.mjs
 *
 * Seeds a temp admin + temp employee directly through the store (JSON mode),
 * logs both in over HTTP, then verifies:
 *   - admin can list users/pages, create, set permissions, delete
 *   - permission resolution flows back through /me
 *   - an employee is blocked from admin routes (403)
 *   - requirePage gates /api/sales/summary for a denied employee (403)
 *   - self-delete and unknown-user guards
 * Cleans up every account it created, even on failure.
 */
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const BASE = 'http://localhost:3000';
const DATA_DIR = path.resolve(process.cwd(), 'data');

const stamp = Date.now().toString(36);
const ADMIN_EMAIL = `admin-smoke-${stamp}@example.com`;
const EMP_EMAIL = `emp-smoke-${stamp}@example.com`;
const NEW_EMAIL = `new-smoke-${stamp}@example.com`;
const PW = 'Smoke-Pass-12345!';

const auth = require('../src/auth/store');
const createdIds = [];

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`PASS ${name}${extra ? ' — ' + extra : ''}`);
  else { failures += 1; console.log(`FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

/** fetch with a cookie jar so the session sticks between calls. */
function makeClient() {
  let cookie = '';
  return async function call(method, url, body) {
    const res = await fetch(BASE + url, {
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

async function cleanup() {
  for (const id of createdIds) {
    try { await auth.deleteUser(DATA_DIR, id); } catch { /* already gone */ }
  }
  // Belt and braces: remove by email too (in case an id was never recorded).
  for (const email of [ADMIN_EMAIL, EMP_EMAIL, NEW_EMAIL]) {
    try {
      const u = await auth.findByEmail(DATA_DIR, email);
      if (u) await auth.deleteUser(DATA_DIR, u.id);
    } catch { /* ignore */ }
  }
}

async function main() {
  // ===== Seed: temp admin + temp employee (JSON backend) =====
  const admin = await auth.createUser(DATA_DIR, {
    name: 'Smoke Admin', email: ADMIN_EMAIL, password: PW, role: 'admin',
  });
  createdIds.push(admin.id);
  const emp = await auth.createUser(DATA_DIR, {
    name: 'Smoke Employee', email: EMP_EMAIL, password: PW, role: 'employee',
  });
  createdIds.push(emp.id);

  const adminCall = makeClient();
  const empCall = makeClient();

  // ===== Login =====
  let r = await adminCall('POST', '/api/auth/login', { email: ADMIN_EMAIL, password: PW });
  check('admin login', r.status === 200 && r.data.user && r.data.user.role === 'admin', `status ${r.status}`);
  check('admin /me pages.admin = true', r.data.user.pages && r.data.user.pages.admin === true);

  r = await empCall('POST', '/api/auth/login', { email: EMP_EMAIL, password: PW });
  check('employee login', r.status === 200, `status ${r.status}`);
  const empPages = r.data.user.pages || {};
  check('employee pages: home+inbox on, sales/admin off',
    empPages.home === true && empPages.inbox === true && empPages.sales === false && empPages.admin === false,
    JSON.stringify(empPages));

  // ===== Catalogue =====
  r = await adminCall('GET', '/api/auth/pages');
  check('GET /pages', r.status === 200 && Array.isArray(r.data.pages) && r.data.pages.includes('admin'));
  check('/pages assignable includes admin', (r.data.assignable || []).includes('admin'));
  check('/pages assignable excludes founder', !(r.data.assignable || []).includes('founder'));

  // ===== List =====
  r = await adminCall('GET', '/api/auth/users');
  const listed = r.data.users || [];
  check('GET /users lists seeded accounts',
    r.status === 200 && listed.some((u) => u.email === ADMIN_EMAIL) && listed.some((u) => u.email === EMP_EMAIL),
    `count ${listed.length}`);

  // ===== Create =====
  r = await adminCall('POST', '/api/auth/users', {
    name: 'Smoke Created', email: NEW_EMAIL, password: PW, role: 'manager',
  });
  check('POST /users creates manager', r.status === 201 && r.data.user && r.data.user.role === 'manager', `status ${r.status}`);
  const newId = r.data.user && r.data.user.id;
  if (newId) createdIds.push(newId);

  // Assigning a role above the actor must fail (admin cannot make founders)
  r = await adminCall('POST', '/api/auth/users', {
    name: 'Too Big', email: `toobig-${stamp}@example.com`, password: PW, role: 'founder',
  });
  check('POST /users rejects founder assignment', r.status === 403, `status ${r.status}`);

  // Unknown role → 422
  r = await adminCall('POST', '/api/auth/users', {
    name: 'Weird', email: `weird-${stamp}@example.com`, password: PW, role: 'wizard',
  });
  check('POST /users rejects unknown role', r.status === 422, `status ${r.status}`);

  // ===== Permissions =====
  r = await adminCall('PUT', `/api/auth/users/${emp.id}/permissions`, {
    permissions: { sales: true, zara: false, junk: 'nope' },
  });
  check('PUT permissions saves', r.status === 200, `status ${r.status}`);
  check('PUT permissions normalizes junk away', r.data.permissions && !('junk' in r.data.permissions));
  check('PUT permissions resolves sales=true', r.data.pages && r.data.pages.sales === true);
  check('PUT permissions resolves zara=false', r.data.pages && r.data.pages.zara === false);

  r = await empCall('GET', '/api/auth/me');
  check('employee /me reflects the grant', r.data.user.pages.sales === true, JSON.stringify(r.data.user.pages));
  check('employee /me still has no admin', r.data.user.pages.admin === false);

  // ===== requirePage enforcement (employee was granted sales above) =====
  r = await empCall('GET', '/api/sales/summary');
  check('granted employee can hit /api/sales/summary', r.status !== 403, `status ${r.status}`);

  // Deny it again → 403
  r = await adminCall('PUT', `/api/auth/users/${emp.id}/permissions`, {
    permissions: { sales: false },
  });
  check('deny sales saves', r.status === 200 && r.data.pages.sales === false);
  r = await empCall('GET', '/api/sales/summary');
  check('denied employee blocked from /api/sales/summary', r.status === 403, `status ${r.status}`);

  // ===== Employee is locked out of admin routes =====
  r = await empCall('GET', '/api/auth/users');
  check('employee GET /users → 403', r.status === 403, `status ${r.status}`);
  r = await empCall('GET', '/api/auth/pages');
  check('employee GET /pages → 403', r.status === 403, `status ${r.status}`);
  r = await empCall('POST', '/api/auth/users', { name: 'X', email: `x-${stamp}@e.com`, password: PW, role: 'employee' });
  check('employee POST /users → 403', r.status === 403, `status ${r.status}`);
  r = await empCall('PUT', `/api/auth/users/${admin.id}/permissions`, { permissions: {} });
  check('employee PUT permissions → 403', r.status === 403, `status ${r.status}`);

  // ===== Guards =====
  r = await adminCall('DELETE', `/api/auth/users/${admin.id}`);
  check('self-delete rejected', r.status === 400, `status ${r.status}`);
  r = await adminCall('DELETE', '/api/auth/users/does-not-exist-id');
  check('unknown user delete → 404', r.status === 404, `status ${r.status}`);

  // ===== Delete the created user =====
  r = await adminCall('DELETE', `/api/auth/users/${newId}`);
  check('admin deletes created user', r.status === 200 && r.data.ok === true, `status ${r.status}`);
  r = await adminCall('GET', '/api/auth/users');
  check('deleted user is gone', !(r.data.users || []).some((u) => u.id === newId));

  await cleanup();
  console.log(failures ? `\nRESULT: ${failures} FAILURE(S)` : '\nRESULT: OK');
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error('FAIL (exception)', err);
  await cleanup();
  process.exit(1);
});
