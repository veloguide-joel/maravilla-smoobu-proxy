// claude/derive-0024-pins.mjs — derives the PRE (exactly 0001-0023) and POST (0001-0024) schema-identity pins for the 0024-only SQL-editor apply packet
// (C112a) on a DISPOSABLE PostgreSQL (tooling test/db/harness.mjs + db/lib/migrate.js migrateUp — the accepted migrator, the merged files, verbatim).
// LABELLED SPECIALISATION of the accepted claude/derive-0022-0023-pins.mjs for ONE migration (no MID). Deterministic: every pin is a sha256 over catalog
// text keyed by schema.name(identity args) — no OIDs, no timestamps, no search_path dependence. The ADDED columns (per pre-existing table) and the NEW
// tables are DERIVED by catalog difference PRE → POST (never hand-listed). Also records, as the RUNTIME APP ROLE, the hosted kickoff runner's exact
// catalog probe (scripts/e7-hosted-kickoff.mjs CATALOG_PINS on main 8503716b) so the packet proves parity with the merged runner. Writes
// claude/e7-0024-pins-v1.json. NEVER touches a shared database.
// Usage: PG_BIN=… node claude/derive-0024-pins.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { startPostgres } from "../test/db/harness.mjs";
import { migrateUp, loadMigrations } from "../db/lib/migrate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INVENTORY = readFileSync(join(ROOT, "claude/e7-0024-inventory.sql"), "utf8");
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const m24 = loadMigrations().find((m) => m.version === 24);
const COLS = "SELECT table_name AS t, array_agg(column_name::text ORDER BY ordinal_position) AS c FROM information_schema.columns WHERE table_schema = 'booking' AND table_name IN (SELECT relname FROM pg_catalog.pg_class k JOIN pg_catalog.pg_namespace s ON s.oid = k.relnamespace WHERE s.nspname = 'booking' AND k.relkind IN ('r', 'p')) GROUP BY table_name ORDER BY table_name";
/** = scripts/e7-hosted-kickoff.mjs (main 8503716b) QUERIES.fn / QUERIES.table and CATALOG_PINS signature order — copied verbatim, labelled */
export const KICKOFF_FN_SQL = `/*e7hko:fn*/ SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS src, p.prosecdef AS secdef, p.provolatile::text AS vol, coalesce(array_to_string(p.proconfig, ','), '') AS cfg,
    coalesce((SELECT string_agg(a.grantee::regrole::text || ':' || a.privilege_type, ',' ORDER BY a.grantee::regrole::text, a.privilege_type) FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner), '') AS acl
    FROM pg_proc p WHERE p.oid = to_regprocedure($1)`;
export const KICKOFF_TABLE_SQL = `/*e7hko:table*/ SELECT c.relrowsecurity AS rls, has_table_privilege(c.oid, 'SELECT') AS sel, has_table_privilege(c.oid, 'INSERT') AS ins, has_table_privilege(c.oid, 'UPDATE') AS upd,
    has_table_privilege(c.oid, 'DELETE') AS del, (SELECT count(*)::int FROM pg_trigger g WHERE g.tgrelid = 'booking.intents'::regclass AND g.tgname = 'intents_pipeline_kickoff'
    AND g.tgfoid = to_regprocedure('booking.pipeline_kickoff_record()')) AS trg FROM pg_class c WHERE c.oid = to_regclass('booking.pipeline_kickoff_requests')`;
export const KICKOFF_SIGS = ["booking.claim_pipeline_kickoff(uuid,text,text,jsonb)", "booking.refuse_pipeline_kickoff(uuid,text)", "booking.settle_pipeline_kickoff(uuid,text,text,text)",
  "booking.pipeline_kickoff_record()", "booking.pipeline_kickoff_refusal(booking.intents,booking.pipeline_kickoff_requests)", "booking.pipeline_kickoff_excluded(uuid)",
  "booking.pipeline_kickoff_guard()"];
export async function kickoffCatalog(client) {
  const functions = [];
  for (const s of KICKOFF_SIGS) functions.push((await client.query(KICKOFF_FN_SQL, [s])).rows[0] ?? null);
  return { functions, table: (await client.query(KICKOFF_TABLE_SQL)).rows[0] ?? null };
}

if (import.meta.main === true) {
  const db = await startPostgres();
  const c = new pg.Client({ connectionString: db.adminUrl }); await c.connect();
  try {
    await migrateUp(c, { env: "test", to: 23 });
    await c.query("CREATE ROLE test_app LOGIN IN ROLE mv_booking_app");
    const pre = (await c.query(INVENTORY)).rows[0].e7_inventory;
    const preCols = Object.fromEntries((await c.query(COLS)).rows.map((r) => [r.t, r.c]));
    await migrateUp(c, { env: "test", to: 24 });
    const post = (await c.query(INVENTORY)).rows[0].e7_inventory;
    const postCols = Object.fromEntries((await c.query(COLS)).rows.map((r) => [r.t, r.c]));
    const newTables = Object.keys(postCols).filter((t) => !(t in preCols)).sort();
    const addedColumns = {}; const dropped = [];
    for (const t of Object.keys(preCols)) {
      const add = (postCols[t] ?? []).filter((x) => !preCols[t].includes(x)); if (add.length) addedColumns[t] = add;
      if (!(t in postCols) || preCols[t].some((x) => !postCols[t].includes(x))) dropped.push(t);
    }
    if (dropped.length) throw new Error("0024 dropped a pre-existing table / column: the packet's preservation model would not hold");
    const app = new pg.Client({ connectionString: db.appUrl() }); await app.connect();
    let kickoffCatalogPins; try { kickoffCatalogPins = await kickoffCatalog(app); } finally { await app.end(); }
    const pgVersion = (await c.query("SHOW server_version")).rows[0].server_version;
    const pins = { schema: "e7-0024-pins-v1", inventorySql: sha(INVENTORY), derivedOnPg: pgVersion,
      files: { up24: m24.upChecksum, down24: m24.downChecksum, name24: m24.name },
      preTables: Object.keys(preCols).sort(), addedColumns, newTables, kickoffCatalogPins,
      kickoffRunner: { mainCommit: "8503716bbe0eca27197b59818487a7200895f603", path: "scripts/e7-hosted-kickoff.mjs",
        sha256: "66f3001424c2adf85026e89bb3eb9d20c73275c7493e41fc81f18276bddeb60b", export: "CATALOG_PINS" },
      pre, post };
    writeFileSync(join(ROOT, "claude/e7-0024-pins-v1.json"), `${JSON.stringify(pins, null, 2)}\n`);
    console.log(JSON.stringify({ wrote: "claude/e7-0024-pins-v1.json", pg: pgVersion, preFunctions: pre.functions, postFunctions: post.functions,
      aggregate23: pre.migrations.aggregate, aggregate24: post.migrations.aggregate, addedColumns, newTables }));
  } finally { await c.end(); db.stop(); }
}
