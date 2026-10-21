// db/lib/migrate.js — Stage E2B. Versioned SQL migrations for the booking schema.
//
// - Files: db/migrations/NNNN_name.up.sql + NNNN_name.down.sql (both required).
// - Bookkeeping lives in schema booking_migrations (survives `down` of 0001, which drops schema booking).
// - Each migration runs in its own transaction under a transaction-scoped advisory lock (pooler-safe).
// - Refuses to run when an applied file's checksum changed, when the environment flag does not match the
//   database's booking.instance marker, or when files are missing/out of order.
// Not imported by any route. Never reads DATABASE_URL.

import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const LOCK_KEY = 7_302_215_001; // arbitrary constant for pg_advisory_xact_lock
const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/;
const ENVIRONMENTS = new Set(["test", "live"]);

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

export class MigrationError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.code = code; }
}

/** Load and validate migration files. Returns [{ version, name, up, down, upChecksum, downChecksum }] ascending. */
export function loadMigrations(dir = DEFAULT_MIGRATIONS_DIR) {
  const byVersion = new Map();
  for (const f of readdirSync(dir).sort()) {
    const m = FILE_RE.exec(f);
    if (!m) { if (f.endsWith(".sql")) throw new MigrationError("BAD_FILENAME", f); continue; }
    const version = Number(m[1]);
    const e = byVersion.get(version) || { version, name: m[2] };
    if (e.name !== m[2]) throw new MigrationError("NAME_MISMATCH", f);
    const sql = readFileSync(join(dir, f), "utf8");
    e[m[3]] = sql;
    e[`${m[3]}Checksum`] = sha256(sql);
    byVersion.set(version, e);
  }
  const list = [...byVersion.values()].sort((a, b) => a.version - b.version);
  list.forEach((e, i) => {
    if (e.version !== i + 1) throw new MigrationError("GAP", `expected ${i + 1}, found ${e.version}`);
    if (!e.up || !e.down) throw new MigrationError("MISSING_PAIR", `${e.version}_${e.name}`);
  });
  return list;
}

async function ensureBookkeeping(client) {
  await client.query("CREATE SCHEMA IF NOT EXISTS booking_migrations");
  await client.query("REVOKE ALL ON SCHEMA booking_migrations FROM PUBLIC");
  await client.query(`CREATE TABLE IF NOT EXISTS booking_migrations.applied (
    version integer PRIMARY KEY, name text NOT NULL, up_checksum text NOT NULL, down_checksum text NOT NULL,
    environment text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
}

async function databaseEnvironment(client) {
  const r = await client.query("SELECT to_regclass('booking.instance') AS t");
  if (!r.rows[0].t) return null;
  return (await client.query("SELECT environment FROM booking.instance")).rows[0]?.environment ?? null;
}

/** Verify applied rows against files; throws on drift. Returns applied rows. */
async function verify(client, migrations, env) {
  const applied = (await client.query("SELECT version, name, up_checksum, down_checksum, environment FROM booking_migrations.applied ORDER BY version")).rows;
  for (const row of applied) {
    const m = migrations.find((x) => x.version === row.version);
    if (!m) throw new MigrationError("UNKNOWN_APPLIED", `version ${row.version} is applied but has no file`);
    if (m.name !== row.name || m.upChecksum !== row.up_checksum || m.downChecksum !== row.down_checksum) {
      throw new MigrationError("CHECKSUM_MISMATCH", `${row.version}_${row.name} changed after it was applied`);
    }
    if (row.environment !== env) throw new MigrationError("ENV_MISMATCH", `applied as ${row.environment}, requested ${env}`);
  }
  const dbEnv = await databaseEnvironment(client);
  if (dbEnv !== null && dbEnv !== env) throw new MigrationError("ENV_MISMATCH", `database is ${dbEnv}, requested ${env}`);
  return applied;
}

async function inTx(client, fn) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock($1)", [LOCK_KEY]);
    const out = await fn();
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

function checkEnv(env) {
  if (!ENVIRONMENTS.has(env)) throw new MigrationError("BAD_ENV", "environment must be 'test' or 'live'");
}

/** status → { applied:[versions], pending:[versions], environment } */
export async function migrationStatus(client, { env, dir } = {}) {
  checkEnv(env);
  const migrations = loadMigrations(dir);
  await ensureBookkeeping(client);
  const applied = await verify(client, migrations, env);
  const done = new Set(applied.map((r) => r.version));
  return { applied: [...done], pending: migrations.filter((m) => !done.has(m.version)).map((m) => m.version), environment: await databaseEnvironment(client) };
}

/** Apply pending migrations up to `to` (default: all). Repeatable: an up-to-date database is a no-op. */
export async function migrateUp(client, { env, dir, to = Infinity } = {}) {
  checkEnv(env);
  const migrations = loadMigrations(dir);
  await ensureBookkeeping(client);
  const ran = [];
  for (const m of migrations) {
    if (m.version > to) break;
    const did = await inTx(client, async () => {
      const applied = await verify(client, migrations, env); // re-verified under the lock
      if (applied.some((r) => r.version === m.version)) return false;
      if (applied.length !== m.version - 1) throw new MigrationError("ORDER", `cannot apply ${m.version} before ${applied.length + 1}`);
      await client.query("SELECT set_config('booking.migration_environment', $1, true)", [env]);
      await client.query(m.up);
      await client.query("INSERT INTO booking_migrations.applied (version, name, up_checksum, down_checksum, environment) VALUES ($1,$2,$3,$4,$5)",
        [m.version, m.name, m.upChecksum, m.downChecksum, env]);
      return true;
    });
    if (did) ran.push(m.version);
  }
  return ran;
}

/** Roll back applied migrations down to (but not including) `to` (default 0 = everything). DEV/test only. */
export async function migrateDown(client, { env, dir, to = 0 } = {}) {
  checkEnv(env);
  if (env === "live") throw new MigrationError("LIVE_DOWN_REFUSED", "down migrations are not run against live databases (forward-only policy)");
  const migrations = loadMigrations(dir);
  await ensureBookkeeping(client);
  const ran = [];
  for (const m of [...migrations].reverse()) {
    if (m.version <= to) break;
    const did = await inTx(client, async () => {
      const applied = await verify(client, migrations, env);
      if (!applied.some((r) => r.version === m.version)) return false;
      if (applied[applied.length - 1].version !== m.version) throw new MigrationError("ORDER", `${m.version} is not the latest applied`);
      await client.query(m.down);
      await client.query("DELETE FROM booking_migrations.applied WHERE version = $1", [m.version]);
      return true;
    });
    if (did) ran.push(m.version);
  }
  return ran;
}
