#!/usr/bin/env node
// scripts/mv-db-setup.mjs -- P3-1: bring the PRODUCTION booking database to the current schema and give the runtime its login.
// Design: PRODUCTION.md, "P3-1".
//
// One run (action "setup"), as the schema owner over the Supabase session pooler (port 5432, verified TLS, CA pinned by SHA-256):
//   1. db/lib/migrate.js migrateUp with environment "live" (checksums, order, advisory lock; an up-to-date database is a no-op);
//   2. the runtime login mv_booking_app_live: created if absent with the reviewed attributes (LOGIN, no super / createdb / createrole /
//      replication / bypassrls, INHERIT, connection limit, member of mv_booking_app only) and the two role-level timeouts;
//   3. its password: the SCRAM-SHA-256 VERIFIER is computed here and sent (the password itself never reaches the server or its logs);
//   4. proof: a login AS that role (same pooler) reads its identity, the marker "live", its timeouts, and is denied the migration table.
// Action "status" only reports applied / pending versions.
//
// Secrets come from the job environment and are never printed: the owner password and the runtime password. Output: ONE JSON line of
// codes, counts and booleans. This script can never target the TEST project and never runs a down migration.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

export const MV_DB_SETUP_VERSION = "mv-db-setup-v1";
export const DB_ENV = "live";
export const APP_ROLE = "mv_booking_app_live";
export const GROUP_ROLE = "mv_booking_app";
export const NEVER_PROJECT_REFS = Object.freeze(["mxotevtiscernhqilyiu"]);   // the shared TEST database (maraVilla Booking DEV)
export const OFFICIAL_CA_SHA256 = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7";
export const ENV_NAMES = Object.freeze({ action: "MV_DB_ACTION", host: "MV_DB_HOST", projectRef: "MV_DB_PROJECT_REF", ownerPassword: "MV_DB_OWNER_PASSWORD",
  appPassword: "MV_DB_APP_PASSWORD", caFile: "MV_DB_CA_FILE" });
const HOST_RE = /^aws-[0-9]{1,2}-[a-z0-9-]{3,30}\.pooler\.supabase\.com$/;
const REF_RE = /^[a-z]{20}$/;
const APP_PASSWORD_RE = /^[A-Za-z0-9]{24,128}$/;   // letters and digits only: no SASLprep or URL-encoding ambiguity
const SCRAM_ITERATIONS = 4096;

/** PostgreSQL SCRAM-SHA-256 verifier for `password` (RFC 5802 / 7677), as stored in pg_authid.rolpassword. */
export function scramVerifier(password, salt = randomBytes(16), iterations = SCRAM_ITERATIONS) {
  if (typeof password !== "string" || !APP_PASSWORD_RE.test(password)) throw new TypeError("scramVerifier: password format");
  if (!Buffer.isBuffer(salt) || salt.length < 8) throw new TypeError("scramVerifier: salt");
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}
const VERIFIER_RE = /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{12,64}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/;

/** Validate the job environment. -> { ok, cfg } | { ok:false, code } (codes only; never a value). */
export function parseSetupEnv(env) {
  const get = (k) => (typeof env[ENV_NAMES[k]] === "string" ? env[ENV_NAMES[k]] : "");
  const action = get("action");
  if (action !== "status" && action !== "setup") return { ok: false, code: "ACTION_INVALID" };
  if (!HOST_RE.test(get("host"))) return { ok: false, code: "HOST_INVALID" };
  const ref = get("projectRef");
  if (!REF_RE.test(ref)) return { ok: false, code: "PROJECT_REF_INVALID" };
  if (NEVER_PROJECT_REFS.includes(ref)) return { ok: false, code: "PROJECT_IS_TEST_DATABASE" };
  const owner = get("ownerPassword");
  if (owner.length < 8 || owner.length > 256 || /[\x00-\x20\x7f]/.test(owner)) return { ok: false, code: "OWNER_PASSWORD_REQUIRED" };
  const app = get("appPassword");
  if (action === "setup") {
    if (!APP_PASSWORD_RE.test(app)) return { ok: false, code: "APP_PASSWORD_FORMAT" };   // 24-128 letters and digits
    if (app === owner) return { ok: false, code: "APP_PASSWORD_EQUALS_OWNER" };
  }
  if (!get("caFile")) return { ok: false, code: "CA_FILE_REQUIRED" };
  const url = (user, pw) => `postgresql://${user}.${ref}:${encodeURIComponent(pw)}@${get("host")}:5432/postgres`;
  return { ok: true, cfg: { action, caFile: get("caFile"), ownerUrl: url("postgres", owner), appUrl: action === "setup" ? url(APP_ROLE, app) : null, appPassword: action === "setup" ? app : null } };
}

/** Steps 2 + 3 on an owner connection. Idempotent. -> { created: boolean } */
export async function ensureRuntimeLogin(client, verifier) {
  if (!VERIFIER_RE.test(verifier)) throw Object.assign(new Error("verifier"), { code: "VERIFIER_INVALID" });
  await client.query("BEGIN");
  try {
    const group = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1 AND NOT rolcanlogin", [GROUP_ROLE]);
    if (group.rowCount !== 1) throw Object.assign(new Error("group"), { code: "GROUP_ROLE_MISSING" });
    const had = (await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [APP_ROLE])).rowCount === 1;
    if (!had) await client.query(`CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT CONNECTION LIMIT 20 IN ROLE ${GROUP_ROLE}`);
    await client.query(`ALTER ROLE ${APP_ROLE} SET statement_timeout = '5s'`);
    await client.query(`ALTER ROLE ${APP_ROLE} SET idle_in_transaction_session_timeout = '10s'`);
    await client.query(`ALTER ROLE ${APP_ROLE} PASSWORD '${verifier}'`);
    const r = (await client.query(`SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AS safe,
      (SELECT array_agg(g.rolname::text ORDER BY g.rolname) FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid) AS groups
      FROM pg_roles r WHERE rolname = $1`, [APP_ROLE])).rows[0];
    if (!r || r.safe !== true || JSON.stringify(r.groups) !== JSON.stringify([GROUP_ROLE])) throw Object.assign(new Error("attrs"), { code: "ROLE_ATTRIBUTES_UNEXPECTED" });
    await client.query("COMMIT");
    return { created: !had };
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; }
}

/** Step 4 on a connection opened AS the runtime login. -> { ok, checks } */
export async function proveRuntimeLogin(client) {
  const checks = {};
  const who = (await client.query("SELECT current_user::text AS cu, session_user::text AS su")).rows[0];
  checks.identity = who.cu === APP_ROLE && who.su === APP_ROLE;
  checks.marker = (await client.query("SELECT environment FROM booking.instance")).rows.map((r) => r.environment).join(",") === DB_ENV;
  checks.statementTimeout = (await client.query("SELECT current_setting('statement_timeout') AS v")).rows[0].v === "5s";
  try { await client.query("SELECT 1 FROM booking_migrations.applied LIMIT 1"); checks.migrationTableDenied = false; } catch (e) { checks.migrationTableDenied = e.code === "42501"; }
  return { ok: Object.values(checks).every((v) => v === true), checks };
}

const safe = (c, d) => (typeof c === "string" && /^[A-Z0-9_]{1,60}$/.test(c) ? c : d);

export async function main(env = process.env, out = (line) => process.stdout.write(`${line}\n`), deps = {}) {
  const say = (r) => { out(JSON.stringify({ version: MV_DB_SETUP_VERSION, environment: DB_ENV, ...r })); return r.outcome === "OK" ? 0 : 1; };
  const p = parseSetupEnv(env);
  if (!p.ok) return say({ outcome: "REFUSED", code: p.code });
  let ownerPool = null; let appPool = null; let stage = "CA";
  try {
    const [{ createBookingPool }, { migrateUp, migrationStatus }, { readFile }] = await Promise.all([import("../lib/booking-db/pool.js"), import("../db/lib/migrate.js"), import("node:fs/promises")]);
    let ca; try { ca = await readFile(p.cfg.caFile); } catch { return say({ outcome: "REFUSED", code: "CA_UNREADABLE" }); }
    if (ca.length > 16384 || createHash("sha256").update(ca).digest("hex") !== OFFICIAL_CA_SHA256) return say({ outcome: "REFUSED", code: "CA_INVALID" });
    const mk = deps.createPool || ((connectionString) => createBookingPool({ connectionString, caPem: ca.toString("utf8"), max: 1, statementTimeoutMs: 120000 }));
    stage = "OWNER_CONNECT";
    ownerPool = mk(p.cfg.ownerUrl);
    const owner = await ownerPool.connect();
    let result;
    try {
      stage = "STATUS";
      if (p.cfg.action === "status") {
        const s = await migrationStatus(owner, { env: DB_ENV });
        return say({ outcome: "OK", code: "STATUS", applied: s.applied.length, pending: s.pending.length, marker: s.environment });
      }
      stage = "MIGRATE";
      const ran = await migrateUp(owner, { env: DB_ENV });
      const s = await migrationStatus(owner, { env: DB_ENV });
      if (s.pending.length !== 0 || s.environment !== DB_ENV) return say({ outcome: "ATTENTION", code: "MIGRATIONS_INCOMPLETE", applied: s.applied.length, pending: s.pending.length });
      stage = "ROLE";
      const role = await ensureRuntimeLogin(owner, scramVerifier(p.cfg.appPassword));
      result = { migrationsRun: ran.length, applied: s.applied.length, roleCreated: role.created };
    } finally { owner.release(); }
    stage = "APP_LOGIN";
    let proof = null; let last = "APP_LOGIN_FAILED";
    const attempts = deps.loginAttempts ?? 6;
    for (let i = 0; i < attempts && proof === null; i++) {   // the pooler may take a few seconds to learn a new credential
      if (i > 0) await new Promise((r) => setTimeout(r, deps.loginDelayMs ?? 5000));
      appPool = mk(p.cfg.appUrl);
      try { const c = await appPool.connect(); try { proof = await proveRuntimeLogin(c); } finally { c.release(); } }
      catch (e) { last = safe(e && e.code, "APP_LOGIN_FAILED"); }
      finally { await appPool.end().catch(() => {}); appPool = null; }
    }
    if (proof === null) return say({ outcome: "ATTENTION", code: "APP_LOGIN_FAILED", detail: last, ...result });
    return say({ outcome: proof.ok ? "OK" : "ATTENTION", code: proof.ok ? "READY" : "APP_LOGIN_CHECK_FAILED", ...result, checks: proof.checks });
  } catch (e) {
    return say({ outcome: "ATTENTION", code: "SETUP_FAILED", stage, detail: safe(e && e.code, "ERROR") });
  } finally { if (appPool) await appPool.end().catch(() => {}); if (ownerPool) await ownerPool.end().catch(() => {}); }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().then((code) => { process.exitCode = code; }, () => { process.exitCode = 1; });
}
