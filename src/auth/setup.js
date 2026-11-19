/**
 * First-admin bootstrap — the ONE door that can create the first
 * admin/founder on a deployment that has none.
 *
 * Why this exists: the Admin page is locked to admin/founder, and production
 * (Render) was seeded before roles existed, so it has accounts but nobody who
 * can open it. A permanently open "create admin" endpoint would hand the keys
 * to whoever found the URL first, so every path here obeys ONE rule:
 *
 *     The bootstrap runs only while countAdmins() === 0, and then it is
 *     permanently disabled — no exception, no expiry, no way back in.
 *
 * Three ways in, all gated by that same rule:
 *
 *   1. GET/POST /api/auth/setup  — the in-app setup form. POST additionally
 *      demands a one-time setup code (see below), so even inside the window
 *      a stranger cannot claim the workspace.
 *   2. BOOTSTRAP_ADMIN_EMAIL      — env var applied at boot (Render-friendly):
 *      promotes an existing account to founder, or creates one when
 *      BOOTSTRAP_ADMIN_PASSWORD is also set.
 *   3. The Render SQL console     — always available, needs no code:
 *        UPDATE users SET role = 'founder' WHERE email = 'you@company.com';
 *
 * SETUP CODE: `SETUP_CODE` env var if set (stable across restarts), otherwise
 * a random code minted per process and printed to the boot log. 12 characters
 * from an unambiguous alphabet (31^12 ≈ 10^17 combinations) makes guessing
 * impractical; a wrong code is slowed by a fixed delay rather than locked out
 * — see WRONG_CODE_DELAY_MS for why a lockout would be a footgun here.
 *
 * This module is storage-agnostic: it uses ../store for every account read
 * and write, so it works identically on PostgreSQL and on data/users.json.
 */
const crypto = require('crypto');
const {
  countAdmins,
  createUser,
  findByEmail,
  normalizeEmail,
  updateUser,
} = require('./store');
const { ROLE_LIST } = require('./roles');

// No I/L/O/0/1 — the code is read out of a log by a human.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 12;

/**
 * Delay applied after a wrong code.
 *
 * Deliberately NOT a lockout. A shared "N wrong guesses → locked out" counter
 * would be trivially weaponised: on Render the service sits behind a proxy and
 * req.ip is the proxy address, so every visitor shares one bucket — anyone
 * could burn the attempts and deny the legitimate founder the setup form for
 * as long as they cared to keep trying. Guessing is already hopeless (31^12 ≈
 * 10^17 codes), so a lockout would only ever protect against an attack that
 * cannot succeed, while creating an attack that can.
 */
const WRONG_CODE_DELAY_MS = 500;

let generatedCode = null;

function delayWrongCode() {
  return new Promise((resolve) => setTimeout(resolve, WRONG_CODE_DELAY_MS));
}

/** Strip the separators a human would naturally type or paste. */
function normalizeCode(raw) {
  return String(raw == null ? '' : raw).toUpperCase().replace(/[\s-]+/g, '');
}

function generateCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * The code POST /api/auth/setup demands.
 * `SETUP_CODE` wins when present and non-empty; otherwise one code is minted
 * for the life of the process (a restart mints a new one — fine, since the
 * code is only needed once and the new one is printed at boot).
 */
function setupCode(env = process.env) {
  const fromEnv = normalizeCode(env.SETUP_CODE);
  if (fromEnv) return fromEnv;
  if (!generatedCode) generatedCode = generateCode();
  return generatedCode;
}

/** Constant-time comparison; hashes also sidestep any length difference. */
function checkSetupCode(raw, env = process.env) {
  const a = crypto.createHash('sha256').update(normalizeCode(raw)).digest();
  const b = crypto.createHash('sha256').update(setupCode(env)).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Is the setup door still open?
 * → { needed, codeSource }  — `codeSource` tells the login screen where the
 *   code lives ('env' | 'generated') so its hint can be accurate.
 * Once `needed` is false it stays false for the life of the database.
 */
async function setupState(dataDir, env = process.env) {
  const needed = (await countAdmins(dataDir)) === 0;
  return {
    needed,
    codeSource: normalizeCode(env.SETUP_CODE) ? 'env' : 'generated',
  };
}

/**
 * Serialises the check-then-create in POST /api/auth/setup so two concurrent
 * requests cannot both observe zero admins and both mint a founder.
 * Single-process service, so an in-memory chain is the right tool.
 */
let setupLock = Promise.resolve();
function withSetupLock(fn) {
  const run = setupLock.then(fn, fn);
  setupLock = run.then(() => {}, () => {});
  return run;
}

/**
 * BOOTSTRAP_ADMIN_EMAIL fallback, applied once during boot (server.js).
 *
 *   BOOTSTRAP_ADMIN_EMAIL     required to activate; the account to elevate
 *   BOOTSTRAP_ADMIN_PASSWORD  required only when that email has no account
 *   BOOTSTRAP_ADMIN_NAME      optional, defaults to the email's local part
 *   BOOTSTRAP_ADMIN_ROLE      'founder' (default) or 'admin'
 *
 * Idempotent and inert once an admin exists — same single rule as the HTTP
 * route. Returns a result object; the caller decides what to log.
 */
async function bootstrapAdminFromEnv(dataDir, env = process.env) {
  const email = normalizeEmail(env.BOOTSTRAP_ADMIN_EMAIL);
  if (!email) return { acted: false, reason: 'unset' };

  if ((await countAdmins(dataDir)) > 0) {
    return { acted: false, reason: 'already_has_admin' };
  }

  let role = String(env.BOOTSTRAP_ADMIN_ROLE || 'founder').trim().toLowerCase();
  if (!ROLE_LIST.includes(role) || (role !== 'founder' && role !== 'admin')) {
    role = 'founder';
  }

  const existing = await findByEmail(dataDir, email);
  if (existing) {
    if (existing.role === 'admin' || existing.role === 'founder') {
      return { acted: false, reason: 'already_admin', email, role: existing.role };
    }
    await updateUser(dataDir, existing.id, { role });
    return { acted: true, action: 'promoted', email, role };
  }

  const password = String(env.BOOTSTRAP_ADMIN_PASSWORD || '');
  if (!password) {
    return { acted: false, reason: 'missing_password', email };
  }

  const name = String(env.BOOTSTRAP_ADMIN_NAME || '').trim() || email.split('@')[0];
  const user = await createUser(dataDir, { name, email, password, role });
  return { acted: true, action: 'created', email, role, userId: user.id };
}

/**
 * Boot-time bootstrap: apply BOOTSTRAP_ADMIN_* first (it may close the door
 * by creating the first admin), then announce the setup code only if the
 * door is STILL open — a settled deployment never advertises a dead endpoint.
 * Never throws: a bootstrap failure must not keep the server from starting.
 */
async function firstAdminBootstrap(dataDir, env = process.env, log = console.log) {
  try {
    const result = await bootstrapAdminFromEnv(dataDir, env);
    if (result.acted) {
      log(`  SETUP    : ${result.action} ${result.email} as ${result.role} (BOOTSTRAP_ADMIN_EMAIL)`);
    } else if (result.reason === 'missing_password') {
      log(`  SETUP    : ${result.email} has no account — set BOOTSTRAP_ADMIN_PASSWORD, or use the setup code below`);
    } else if (result.reason === 'already_has_admin') {
      log('  SETUP    : an admin already exists — BOOTSTRAP_ADMIN_* ignored');
    }

    const state = await setupState(dataDir, env);
    if (state.needed) {
      // Echo the generated code — the operator has no other copy of it. A code
      // they chose via SETUP_CODE is not re-printed: it already lives in their
      // config, and logs have a habit of ending up in third-party services.
      const where = state.codeSource === 'env'
        ? 'code: SETUP_CODE (from the environment)'
        : `first-admin code ${setupCode(env)}`;
      log(`  SETUP    : no admin yet — ${where}`);
      log('  SETUP    : open the app and choose "Set up first admin"');
    }
  } catch (err) {
    log(`  SETUP    : bootstrap skipped — ${String((err && err.message) || err).slice(0, 160)}`);
  }
}

module.exports = {
  CODE_ALPHABET,
  CODE_LENGTH,
  WRONG_CODE_DELAY_MS,
  bootstrapAdminFromEnv,
  checkSetupCode,
  delayWrongCode,
  firstAdminBootstrap,
  normalizeCode,
  setupCode,
  setupState,
  withSetupLock,
};
