/**
 * Phase 1 storage test — runs the real schema + store SQL against pg-mem
 * (an in-memory PostgreSQL emulator), so no server or Docker is needed.
 *
 *   node test/pg-phase1.test.js
 *
 * Covers: schema DDL, account CRUD/auth (JSON + PG backends), the directory
 * mirror, one-time migrations, and the inbox box model (send/unread/read/
 * poll/trim) on PostgreSQL.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { newDb } = require('pg-mem');

const pgPath = require.resolve('pg');

/** Swap the `pg` module in the require cache for pg-mem's adapter. */
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
  // ---------- fixture data dir (JSON backend) ----------
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-'));
  const auth = require('../src/auth/store');
  const inbox = require('../src/inbox/store');
  const pgStore = require('../src/db/pg');

  // ===== 1. JSON backend (no DATABASE_URL) still works =====
  assert.strictEqual(pgStore.enabled(), false, 'PG disabled without DATABASE_URL');
  const jsonUser = await auth.createUser(dataDir, {
    name: 'JSON User', email: 'json@example.com', password: 'secret-123',
  });
  assert.ok(jsonUser.id, 'createUser returns an id');
  assert.ok(fs.existsSync(path.join(dataDir, 'users.json')), 'users.json written');
  const authed = await auth.authenticate(dataDir, 'JSON@example.com', 'secret-123');
  assert.ok(authed && authed.id === jsonUser.id, 'authenticate (JSON)');
  assert.strictEqual(await auth.authenticate(dataDir, 'json@example.com', 'nope'), null, 'bad password rejected');
  assert.ok(auth.readDoc(dataDir).users.some((u) => u.id === jsonUser.id), 'readDoc sees JSON user');
  console.log('PASS json backend: create/authenticate/readDoc');

  // ===== 2. Boot against pg-mem: schema + one-time account import =====
  const mem = newDb();
  useMemDb(mem);
  await pgStore.init('postgres://test@localhost/test');
  assert.strictEqual(pgStore.enabled(), true, 'PG enabled after init');

  const migrated = await auth.migrateToPostgres(dataDir);
  assert.strictEqual(migrated.migrated, 1, 'exactly one legacy user imported');
  const again = await auth.migrateToPostgres(dataDir);
  assert.strictEqual(again.migrated, 0, 'second migration is a no-op (PG wins)');
  const imported = await auth.authenticate(dataDir, 'json@example.com', 'secret-123');
  assert.ok(imported && imported.id === jsonUser.id, 'imported credentials verify');
  assert.ok(auth.readDoc(dataDir).users.some((u) => u.id === jsonUser.id), 'directory mirror loaded');
  console.log('PASS schema + account migration');

  // ===== 3. Account CRUD on PG =====
  const pgUser = await auth.createUser(dataDir, {
    name: 'PG User', email: 'pg@example.com', password: 'secret-456',
  });
  await assert.rejects(
    () => auth.createUser(dataDir, { name: 'Dup', email: 'pg@example.com', password: 'secret-456' }),
    (err) => err.status === 409, 'duplicate email → 409'
  );
  assert.ok(auth.readDoc(dataDir).users.some((u) => u.id === pgUser.id), 'mirror refreshed after create');
  const listed = await auth.listUsers(dataDir);
  assert.strictEqual(listed.length, 2, 'listUsers returns both accounts');
  assert.strictEqual(listed[0].pw, undefined, 'publicUser never leaks credentials');
  const updated = await auth.updateUser(dataDir, pgUser.id, { role: 'admin' });
  assert.strictEqual(updated.role, 'admin', 'role updated');
  assert.strictEqual((await auth.findById(dataDir, pgUser.id)).role, 'admin', 'findById sees the role');
  const deleted = await auth.deleteUser(dataDir, pgUser.id);
  assert.strictEqual(deleted.email, 'pg@example.com', 'deleteUser returns the account');
  assert.strictEqual(await auth.findById(dataDir, pgUser.id), null, 'gone from PG');
  assert.ok(!auth.readDoc(dataDir).users.some((u) => u.id === pgUser.id), 'mirror refreshed after delete');
  console.log('PASS account CRUD on PostgreSQL');

  // ===== 4. Inbox on PG: send / threads / unread / read / poll =====
  const A = 'usr-aaaaaaaa-1111';
  const B = 'usr-bbbbbbbb-2222';
  const m1 = await inbox.sendMessage(dataDir, {
    from: A, fromName: 'Alice', to: B, toName: 'Bob', peerRole: 'Local account',
    body: 'Hello Bob',
  });
  assert.ok(m1.id && m1.ts, 'message gets id + ts');

  const threadsA = await inbox.listThreads(dataDir, A);
  assert.strictEqual(threadsA.length, 1, 'sender sees one thread');
  assert.strictEqual(threadsA[0].peerId, B, 'thread keyed by recipient');
  assert.strictEqual(threadsA[0].peerName, 'Bob', 'recipient name stored');
  assert.strictEqual(threadsA[0].preview, 'Hello Bob', 'preview from last message');
  assert.strictEqual(threadsA[0].unread, 0, 'sending counts as reading');

  const threadsB = await inbox.listThreads(dataDir, B);
  assert.strictEqual(threadsB.length, 1, 'recipient sees one thread');
  assert.strictEqual(threadsB[0].unread, 1, 'recipient has one unread');
  assert.strictEqual(threadsB[0].peerName, 'Alice', 'sender name on recipient side');

  const hist = await inbox.listMessages(dataDir, B, A, 0);
  assert.strictEqual(hist.messages.length, 1, 'history returns the message');
  assert.strictEqual(hist.messages[0].body, 'Hello Bob', 'body round-trips');
  assert.ok(hist.messages[0].ts > 0, 'ts numeric');

  const readTs = await inbox.markRead(dataDir, B, A);
  assert.ok(readTs >= m1.ts, 'markRead advances read_ts');
  const threadsB2 = await inbox.listThreads(dataDir, B);
  assert.strictEqual(threadsB2[0].unread, 0, 'unread cleared');

  await inbox.sendMessage(dataDir, { from: A, fromName: 'Alice', to: B, toName: 'Bob', body: 'Second' });
  const delta = await inbox.listMessages(dataDir, B, A, readTs);
  assert.strictEqual(delta.messages.length, 1, '`since` cursor returns only new messages');
  const empty = await inbox.listMessages(dataDir, B, 'usr-unknown-9999', 0);
  assert.strictEqual(empty.messages.length, 0, 'unknown peer → empty history');

  // markRead on a thread that does not exist must not fabricate one.
  const noopTs = await inbox.markRead(dataDir, B, 'usr-ghost-0000');
  assert.ok(noopTs > 0, 'markRead on empty thread returns now');
  assert.strictEqual((await inbox.listThreads(dataDir, B)).length, 1, 'no phantom thread created');
  console.log('PASS inbox: send/threads/unread/read/poll on PostgreSQL');

  // ===== 5. Trim keeps MAX_MESSAGES_PER_THREAD (500) rows per box =====
  // Bulk-insert 501 older messages (one statement — pg-mem is slow row-by-row),
  // then one real send must trim the box back to 500.
  const values = [];
  const params = [];
  for (let i = 0; i < 501; i += 1) {
    const base = i * 7;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, FALSE)`);
    params.push(`bulk-${i}`, B, A, A, B, `bulk body ${i}`, 1600000000000 + i);
  }
  await pgStore.query(
    `INSERT INTO inbox_messages (id, box_owner, peer_id, from_id, to_id, body, ts, generated)
     VALUES ${values.join(',')}`,
    params
  );
  await inbox.sendMessage(dataDir, { from: A, fromName: 'Alice', to: B, toName: 'Bob', body: 'newest' });
  const { rows } = await pgStore.query(
    'SELECT count(*)::int AS n FROM inbox_messages WHERE box_owner = $1', [B]
  );
  assert.strictEqual(rows[0].n, 500, `box trimmed to 500 (got ${rows[0].n})`);
  const newest = await inbox.listMessages(dataDir, B, A, 1600000600000);
  const bodies = newest.messages.map((m) => m.body);
  assert.ok(bodies.includes('newest'), `newest message survives the trim (got ${bodies.join(' | ')})`);
  console.log('PASS inbox trim: 500 messages per box');

  // ===== 6. Inbox file migration into a fresh database =====
  await pgStore.closePool();
  const mem2 = newDb();
  useMemDb(mem2);
  await pgStore.init('postgres://test@localhost/test2');
  // Legacy box file: one thread, two messages.
  const inboxDir = path.join(dataDir, 'inbox');
  fs.mkdirSync(inboxDir, { recursive: true });
  const legacy = {
    owner: 'usr-legacy-1234',
    threads: {
      'usr-peer-5678': {
        peerId: 'usr-peer-5678', peerName: 'Peer', peerRole: 'Local account',
        readTs: 1700000000000,
        messages: [
          { id: 'msg-1', from: 'usr-peer-5678', to: 'usr-legacy-1234', body: 'old one', ts: 1690000000000, generated: false },
          { id: 'msg-2', from: 'usr-legacy-1234', to: 'usr-peer-5678', body: 'old two', ts: 1690000001000, generated: true },
        ],
      },
    },
  };
  fs.writeFileSync(path.join(inboxDir, 'legacy_box.json'), JSON.stringify(legacy), 'utf8');
  const im = await inbox.migrateToPostgres(dataDir);
  assert.ok(im.migrated >= 2, `legacy inbox messages imported (${im.migrated})`);
  const legacyThreads = await inbox.listThreads(dataDir, 'usr-legacy-1234');
  assert.strictEqual(legacyThreads.length, 1, 'imported thread listed');
  assert.strictEqual(legacyThreads[0].preview, 'old two', 'imported preview correct');
  assert.strictEqual(legacyThreads[0].unread, 0, 'read_ts imported (no false unread)');
  const im2 = await inbox.migrateToPostgres(dataDir);
  assert.strictEqual(im2.migrated, 0, 'second inbox migration is a no-op');
  console.log('PASS inbox migration from data/inbox/*.json');

  // ===== 7. JSON inbox backend still works with PG off =====
  await pgStore.closePool();
  assert.strictEqual(pgStore.enabled(), false, 'back to JSON mode after closePool');
  const dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-json-'));
  await inbox.sendMessage(dataDir2, {
    from: 'usr-json-a1', fromName: 'A', to: 'usr-json-b2', toName: 'B', body: 'file mode',
  });
  const jt = await inbox.listThreads(dataDir2, 'usr-json-b2');
  assert.strictEqual(jt.length, 1, 'JSON inbox thread listed');
  assert.strictEqual(jt[0].unread, 1, 'JSON inbox unread works');
  console.log('PASS inbox JSON backend unaffected');

  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(dataDir2, { recursive: true, force: true });
  console.log('\nRESULT: OK');
}

main().catch((err) => {
  console.error('RESULT: FAILED');
  console.error(err);
  process.exit(1);
});
