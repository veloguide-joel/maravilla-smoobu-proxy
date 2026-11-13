// claude/derive-0021-pins.mjs — derives the PRE (exactly 0001-0020) and POST (0001-0021) schema-identity pins for the 0021-ONLY SQL-editor apply
// wrapper on a DISPOSABLE PostgreSQL (tooling test/db/harness.mjs + db/lib/migrate.js migrateUp — the accepted migrator, the accepted files, verbatim).
// LABELLED SPECIALISATION of the accepted claude/derive-0019-0020-pins.mjs. Deterministic: every pin is a sha256 over catalog text keyed by
// schema.name(identity args) — no OIDs, no timestamps, no search_path dependence. Writes claude/e7-0021-pins-v1.json. NEVER touches a shared
// database (PG_BIN disposable cluster only). Usage: node claude/derive-0021-pins.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { startPostgres } from "../test/db/harness.mjs";
import { migrateUp, loadMigrations } from "../db/lib/migrate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INVENTORY = readFileSync(join(ROOT, "claude/e7-0021-inventory.sql"), "utf8");
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const ms = loadMigrations();
const m21 = ms.find((m) => m.version === 21);
const db = await startPostgres();
const c = new pg.Client({ connectionString: db.adminUrl }); await c.connect();
try {
  await migrateUp(c, { env: "test", to: 20 });
  const pre = (await c.query(INVENTORY)).rows[0].e7_inventory;
  await migrateUp(c, { env: "test", to: 21 });
  const post = (await c.query(INVENTORY)).rows[0].e7_inventory;
  const pg_version = (await c.query("SHOW server_version")).rows[0].server_version;
  const pins = { schema: "e7-0021-pins-v1", inventorySql: sha(INVENTORY), derivedOnPg: pg_version,
    files: { up21: m21.upChecksum, down21: m21.downChecksum, name21: m21.name },
    pre, post };
  writeFileSync(join(ROOT, "claude/e7-0021-pins-v1.json"), `${JSON.stringify(pins, null, 2)}\n`);
  console.log(JSON.stringify({ wrote: "claude/e7-0021-pins-v1.json", pg: pg_version, preFunctions: pre.functions, postFunctions: post.functions, aggregate20: pre.migrations.aggregate, postMax: post.migrations.max }));
} finally { await c.end(); db.stop(); }
