// claude/derive-0022-0023-pins.mjs — derives the PRE (exactly 0001-0021), MID (0001-0022) and POST (0001-0023) schema-identity pins for the 0022 + 0023
// SQL-editor apply packet (C46) on a DISPOSABLE PostgreSQL (tooling test/db/harness.mjs + db/lib/migrate.js migrateUp — the accepted migrator, the merged
// files, verbatim). LABELLED SPECIALISATION of the accepted claude/derive-0021-pins.mjs for TWO migrations applied in ONE transaction. Deterministic: every
// pin is a sha256 over catalog text keyed by schema.name(identity args) — no OIDs, no timestamps, no search_path dependence. The ADDED columns (per
// pre-existing table) and the NEW tables are DERIVED here by catalog difference PRE → POST (never hand-listed) and pinned, so the wrapper's row
// fingerprints are taken over the exact PRE column / table set. Writes claude/e7-0022-0023-pins-v1.json. NEVER touches a shared database.
// Usage: PG_BIN=… node claude/derive-0022-0023-pins.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { startPostgres } from "../test/db/harness.mjs";
import { migrateUp, loadMigrations } from "../db/lib/migrate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INVENTORY = readFileSync(join(ROOT, "claude/e7-0022-0023-inventory.sql"), "utf8");
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const ms = loadMigrations();
const m22 = ms.find((m) => m.version === 22); const m23 = ms.find((m) => m.version === 23);
const COLS = "SELECT table_name AS t, array_agg(column_name::text ORDER BY ordinal_position) AS c FROM information_schema.columns WHERE table_schema = 'booking' AND table_name IN (SELECT relname FROM pg_catalog.pg_class k JOIN pg_catalog.pg_namespace s ON s.oid = k.relnamespace WHERE s.nspname = 'booking' AND k.relkind IN ('r', 'p')) GROUP BY table_name ORDER BY table_name";
const db = await startPostgres();
const c = new pg.Client({ connectionString: db.adminUrl }); await c.connect();
try {
  await migrateUp(c, { env: "test", to: 21 });
  const pre = (await c.query(INVENTORY)).rows[0].e7_inventory;
  const preCols = Object.fromEntries((await c.query(COLS)).rows.map((r) => [r.t, r.c]));
  await migrateUp(c, { env: "test", to: 22 });
  const mid = (await c.query(INVENTORY)).rows[0].e7_inventory;
  await migrateUp(c, { env: "test", to: 23 });
  const post = (await c.query(INVENTORY)).rows[0].e7_inventory;
  const postCols = Object.fromEntries((await c.query(COLS)).rows.map((r) => [r.t, r.c]));
  const newTables = Object.keys(postCols).filter((t) => !(t in preCols)).sort();
  const droppedTables = Object.keys(preCols).filter((t) => !(t in postCols));
  const addedColumns = {}; const droppedColumns = {};
  for (const t of Object.keys(preCols)) {
    const add = (postCols[t] ?? []).filter((x) => !preCols[t].includes(x)); if (add.length) addedColumns[t] = add;
    const drop = preCols[t].filter((x) => !(postCols[t] ?? []).includes(x)); if (drop.length) droppedColumns[t] = drop;
  }
  if (droppedTables.length || Object.keys(droppedColumns).length) throw new Error("0022 / 0023 dropped a pre-existing table / column: the packet's preservation model would not hold");
  const pg_version = (await c.query("SHOW server_version")).rows[0].server_version;
  const pins = { schema: "e7-0022-0023-pins-v1", inventorySql: sha(INVENTORY), derivedOnPg: pg_version,
    files: { up22: m22.upChecksum, down22: m22.downChecksum, name22: m22.name, up23: m23.upChecksum, down23: m23.downChecksum, name23: m23.name },
    preTables: Object.keys(preCols).sort(), addedColumns, newTables, preColumnsOf: Object.fromEntries(Object.keys(addedColumns).map((t) => [t, preCols[t]])),
    pre, mid, post };
  writeFileSync(join(ROOT, "claude/e7-0022-0023-pins-v1.json"), `${JSON.stringify(pins, null, 2)}\n`);
  console.log(JSON.stringify({ wrote: "claude/e7-0022-0023-pins-v1.json", pg: pg_version, preFunctions: pre.functions, midFunctions: mid.functions, postFunctions: post.functions,
    aggregate21: pre.migrations.aggregate, postMax: post.migrations.max, addedColumns, newTables }));
} finally { await c.end(); db.stop(); }
