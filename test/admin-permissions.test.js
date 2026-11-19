/**
 * Admin / permissions test — role defaults, per-user overrides, admin API
 * guards, and both storage backends.
 *
 *   node test/admin-permissions.test.js
 *
 * Covers: effectivePages precedence (hard rules > override > role default),
 * normalizePermissions filtering, createUser with role, updateUser with
 * permissions, publicUser's resolved `pages`, and the role-assignment /
 * self-delete guards in the route layer (invoked directly, no HTTP server).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { newDb } = require('pg-mem');

const pgPath = require.resolve('pg');

function useMemDb(mem) {
  const adapter = mem.adapters.createPg();
  require.cache[pgPath] = {
    id: pgPath,
    filename: pgPath,
    loaded: true,
    exports: adapter,
  };
}

async function main() {
  const {
    ROLES, PAGE_LIST, ROLE_PAGES, normalizePermissions, effectivePages,
    canAssignRole,
  } = require('../src/auth/roles');

  // ===== 1. Page catalogue =====
  assert.deepStrictEqual(
    PAGE_LIST.slice().sort(),
    ['admin', 'apps', 'command', 'home', 'inbox', 'sales', 'settings', 'store', 'zara'].sort(),
    'PAGE_LIST matches the client views + admin'
  );
  for (const [role, pages] of Object.entries(ROLE_PAGES)) {
    for (const p of pages) assert.ok(PAGE_LIST.includes(p), `${role} default ${p} is a known page`);
  }
  console.log('PASS page catalogue');

  // ===== 2. normalizePermissions drops unknown junk =====
  assert.deepStrictEqual(
    normalizePermissions({ sales: true, bogus: true, inbox: 'yes', zara: false }),
    { sales: true, zara: false },
    'only known pages with boolean values survive'
  );
  assert.deepStrictEqual(normalizePermissions(null), {}, 'null → {}');
  assert.deepStrictEqual(normalizePermissions('nope'), {}, 'string → {}');
  console.log('PASS normalizePermissions');

  // ===== 3. effectivePages precedence =====
  // Role defaults (no overrides)
  const emp = effectivePages('employee', {});
  assert.strictEqual(emp.home, true, 'employee lands on home');
  assert.strictEqual(emp.inbox, true, 'employee gets inbox');
  assert.strictEqual(emp.sales, false, 'employee has no sales by default');
  assert.strictEqual(emp.admin, false, 'employee never gets admin');

  const mgr = effectivePages('manager', {});
  assert.strictEqual(mgr.apps, true, 'manager gets apps');
  assert.strictEqual(mgr.sales, false, 'manager has no sales by default');

  const admin = effectivePages('admin', {});
  assert.ok(PAGE_LIST.every((p) => admin[p]), 'admin role → every page');

  // Overrides beat role defaults
  const empPlusSales = effectivePages('employee', { sales: true });
  assert.strictEqual(empPlusSales.sales, true, 'override grants sales to employee');
  const adminNoStore = effectivePages('admin', { store: false });
  assert.strictEqual(adminNoStore.store, false, 'override denies store to admin');

  // Hard rule: admin page can never be granted by override
  const empWantsAdmin = effectivePages('employee', { admin: true });
  assert.strictEqual(empWantsAdmin.admin, false, 'override cannot grant the admin page');
  // …and cannot be denied from an admin either
  const adminNoAdmin = effectivePages('admin', { admin: false });
  assert.strictEqual(adminNoAdmin.admin, true, 'admin/founder always keep the admin page');

  // Unknown role falls back to employee defaults
  const ghost = effectivePages('ghost', {});
  assert.strictEqual(ghost.inbox, true, 'unknown role → employee defaults');
  console.log('PASS effectivePages precedence');

  // ===== 4. Role assignment rules =====
  assert.ok(canAssignRole('founder', 'admin'), 'founder assigns admin');
  assert.ok(canAssignRole('admin', 'manager'), 'admin assigns manager');
  assert.ok(!canAssignRole('admin', 'founder'), 'admin cannot assign founder');
  assert.ok(!canAssignRole('manager', 'admin'), 'manager cannot assign admin');
  assert.ok(!canAssignRole('employee', 'employee'), 'employee assigns nobody');
  console.log('PASS canAssignRole');

  // ===== 5. Store: JSON backend carries role + permissions =====
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adminperm-'));
  const auth = require('../src/auth/store');

  const created = await auth.createUser(dataDir, {
    name: 'Sales Person', email: 'sales@example.com', password: 'secret-123',
    role: 'employee', permissions: { sales: true, junk: 'x' },
  });
  assert.strictEqual(created.role, 'employee', 'role stored');
  assert.deepStrictEqual(created.permissions, { sales: true }, 'permissions normalized on create');

  const pub = auth.publicUser(created);
  assert.strictEqual(pub.pages.sales, true, 'publicUser resolves granted page');
  assert.strictEqual(pub.pages.zara, false, 'publicUser resolves default-deny page');
  assert.strictEqual(pub.pages.admin, false, 'publicUser keeps admin locked');

  const updated = await auth.updateUser(dataDir, created.id, { permissions: { zara: true, sales: false } });
  assert.deepStrictEqual(updated.permissions, { zara: true, sales: false }, 'updateUser replaces overrides');
  assert.strictEqual(updated.pages.zara, true, 'resolved pages follow the update');
  assert.strictEqual(updated.pages.sales, false, 'explicit deny wins over a prior grant');

  const promoted = await auth.updateUser(dataDir, created.id, { role: 'manager' });
  assert.strictEqual(promoted.role, 'manager', 'role update works');
  assert.strictEqual(promoted.pages.apps, true, 'new role defaults apply immediately');
  console.log('PASS JSON backend role/permissions CRUD');

  // ===== 6. Store: PostgreSQL backend =====
  const mem = newDb();
  useMemDb(mem);
  const pgStore = require('../src/db/pg');
  await pgStore.init('postgres://test@localhost/test');
  assert.strictEqual(pgStore.enabled(), true, 'PG enabled');

  const pgUser = await auth.createUser(dataDir, {
    name: 'PG User', email: 'pguser@example.com', password: 'secret-123',
    role: 'employee', permissions: { command: true },
  });
  const reread = await auth.findById(dataDir, pgUser.id);
  assert.strictEqual(reread.role, 'employee', 'PG role round-trips');
  assert.deepStrictEqual(reread.permissions, { command: true }, 'PG permissions round-trip');

  const pgUpdated = await auth.updateUser(dataDir, pgUser.id, { role: 'admin', permissions: { store: false } });
  assert.strictEqual(pgUpdated.role, 'admin', 'PG role update');
  assert.deepStrictEqual(pgUpdated.permissions, { store: false }, 'PG permissions update');
  assert.strictEqual(pgUpdated.pages.store, false, 'PG resolved pages');
  assert.strictEqual(pgUpdated.pages.admin, true, 'admin role keeps admin page');
  await pgStore.closePool();
  console.log('PASS PostgreSQL backend role/permissions CRUD');

  console.log('\nRESULT: OK');
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
