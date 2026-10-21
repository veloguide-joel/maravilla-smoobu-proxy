// test/db/harness.mjs — Stage E2B. Throwaway local PostgreSQL for deterministic offline tests.
//
// - initdb into a fresh temp directory, listen on 127.0.0.1 only (random free port), trust auth, fsync off.
// - Nothing hosted, no credentials, no network beyond loopback. The cluster and its directory are deleted on stop().
// - When run as root (CI/container), the server runs as the "postgres" OS user (PostgreSQL refuses root).
// - Binaries: $PG_BIN, else `pg_config --bindir`, else /usr/lib/postgresql/16/bin.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, chownSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import pg from "pg";
import { migrateUp } from "../../db/lib/migrate.js";

function pgBinDir() {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  try { return execFileSync("pg_config", ["--bindir"], { encoding: "utf8" }).trim(); } catch { /* fall through */ }
  for (const v of ["17", "16", "15"]) { const d = `/usr/lib/postgresql/${v}/bin`; if (existsSync(join(d, "initdb"))) return d; }
  throw new Error("PostgreSQL binaries not found (set PG_BIN)");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

function run(bin, args) {
  const cmd = isRoot ? "runuser" : bin;
  const argv = isRoot ? ["-u", "postgres", "--", bin, ...args] : args;
  const r = spawnSync(cmd, argv, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${bin} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** Start a throwaway cluster. Returns { adminUrl, appUrl(), reportUrl(), stop() }. */
export async function startPostgres() {
  const bin = pgBinDir();
  const dir = mkdtempSync(join(tmpdir(), "mv-booking-pg-"));
  if (isRoot) {
    const uid = Number(execFileSync("id", ["-u", "postgres"], { encoding: "utf8" }).trim());
    const gid = Number(execFileSync("id", ["-g", "postgres"], { encoding: "utf8" }).trim());
    chownSync(dir, uid, gid);
  }
  const data = join(dir, "data");
  run(join(bin, "initdb"), ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--no-locale", "--no-sync"]);
  const port = await freePort();
  const opts = `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=60 -c timezone=UTC`;
  run(join(bin, "pg_ctl"), ["-D", data, "-o", opts, "-l", join(dir, "log"), "-w", "start"]);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { run(join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]); } catch { /* already down */ }
    rmSync(dir, { recursive: true, force: true });
  };
  process.once("exit", stop);
  const base = `postgresql://%USER%@127.0.0.1:${port}/postgres`;
  return {
    port,
    adminUrl: base.replace("%USER%", "postgres"),
    appUrl: () => base.replace("%USER%", "test_app"),
    reportUrl: () => base.replace("%USER%", "test_report"),
    stop
  };
}

/** Start a cluster, apply all migrations as owner, and create login users for the runtime and report roles. */
export async function startMigratedDatabase() {
  const db = await startPostgres();
  const admin = new pg.Client({ connectionString: db.adminUrl });
  await admin.connect();
  try {
    await migrateUp(admin, { env: "test" });
    await admin.query("CREATE ROLE test_app LOGIN IN ROLE mv_booking_app");
    await admin.query("CREATE ROLE test_report LOGIN IN ROLE mv_booking_report");
  } finally {
    await admin.end();
  }
  // All repository code under test runs as the least-privilege runtime role, never as the owner.
  const app = new pg.Pool({ connectionString: db.appUrl(), max: 12 });
  const owner = new pg.Pool({ connectionString: db.adminUrl, max: 4 });
  return {
    ...db,
    app,
    owner,
    async close() { await app.end().catch(() => {}); await owner.end().catch(() => {}); db.stop(); }
  };
}
