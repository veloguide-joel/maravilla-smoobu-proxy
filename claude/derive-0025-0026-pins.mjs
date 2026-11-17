// claude/derive-0025-0026-pins.mjs — derives the PRE (exactly 0001-0024), MID (0001-0025) and POST (0001-0026) schema-identity pins for the 0025 + 0026
// SQL-editor apply packet (C116) on a DISPOSABLE PostgreSQL (tooling test/db/harness.mjs + db/lib/migrate.js migrateUp — the accepted migrator, the
// merged files, verbatim). LABELLED SPECIALISATION of the accepted claude/derive-0024-pins.mjs for TWO in-place function replacements (0025
// gn_recipient_in_scope, 0026 claim_pipeline_kickoff): no table / column is added or dropped (DERIVED by catalog difference, asserted). Also records,
// as the RUNTIME APP ROLE, (a) the hosted kickoff runner's catalog probe at PRE (= the 0024 packet's pins) and at POST (= scripts/e7-hosted-kickoff.mjs
// CATALOG_PINS on main adacbdad), and (b) the hosted notification runner's own CATALOG_SQL identity at POST (= scripts/e7-hosted-booking-confirmation.mjs
// CONSTANTS.catalogPin26 on main adacbdad), read from a LOCAL checkout of that main commit (E7_MAIN_DIR). Writes claude/e7-0025-0026-pins-v1.json.
// NEVER touches a shared database. Usage: PG_BIN=… E7_MAIN_DIR=<main adacbdad checkout> node claude/derive-0025-0026-pins.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { startPostgres } from "../test/db/harness.mjs";
import { migrateUp, loadMigrations } from "../db/lib/migrate.js";
import { kickoffCatalog } from "./derive-0024-pins.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INVENTORY = readFileSync(join(ROOT, "claude/e7-0025-0026-inventory.sql"), "utf8");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const MAIN = Object.freeze({ commit: "adacbdad5aad0f28c7d1ce4e6ac10a0abe657eb1", tree: "601fb09191989f8f6cb9f866eef4c9c70025bb75",
  kickoff: "scripts/e7-hosted-kickoff.mjs", notification: "scripts/e7-hosted-booking-confirmation.mjs" });
const COLS = "SELECT c.relname AS t, array_agg(a.attname::text ORDER BY a.attnum) AS c FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'booking' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped GROUP BY c.relname";

/** the notification runner's OWN catalog identity (its CATALOG_SQL, as the runtime app role, REPEATABLE READ READ ONLY) — exactly its admission probe */
export async function notificationCatalog(appClient, N) {
  await appClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const id = (await appClient.query(N.CATALOG_SQL, [[...N.READ_PATH_FUNCTIONS]])).rows[0].id;
    const sections = {}; for (const k of ["con", "col", "fn", "pol", "rel", "trg"]) sections[k] = id.sections[k] ?? null;
    return { catalog: sha(N.canonical(sections)), readPath: id.readPath, readPathCount: id.readPathCount, sections };
  } finally { await appClient.query("ROLLBACK"); }
}

if (import.meta.main === true) {
  const mainDir = process.env.E7_MAIN_DIR; if (!mainDir) throw new Error("E7_MAIN_DIR (a local checkout of main adacbdad) is required");
  const kickSrc = readFileSync(join(mainDir, MAIN.kickoff)); const notSrc = readFileSync(join(mainDir, MAIN.notification));
  const K = await import(pathToFileURL(join(mainDir, MAIN.kickoff)).href); const N = await import(pathToFileURL(join(mainDir, MAIN.notification)).href);
  const M = loadMigrations(); const m25 = M.find((m) => m.version === 25); const m26 = M.find((m) => m.version === 26);
  if (M.at(-1).version !== 26) throw new Error("the packet covers exactly 0025 + 0026");
  const db = await startPostgres();
  const c = new pg.Client({ connectionString: db.adminUrl }); await c.connect();
  try {
    await migrateUp(c, { env: "test", to: 24 });
    await c.query("CREATE ROLE test_app LOGIN IN ROLE mv_booking_app");
    const app = new pg.Client({ connectionString: db.appUrl() }); await app.connect();
    try {
      const pre = (await c.query(INVENTORY)).rows[0].e7_inventory; const preCols = Object.fromEntries((await c.query(COLS)).rows.map((r) => [r.t, r.c]));
      const kickoffCatalogPre = await kickoffCatalog(app);
      await migrateUp(c, { env: "test", to: 25 }); const mid = (await c.query(INVENTORY)).rows[0].e7_inventory;
      await migrateUp(c, { env: "test", to: 26 }); const post = (await c.query(INVENTORY)).rows[0].e7_inventory;
      const postCols = Object.fromEntries((await c.query(COLS)).rows.map((r) => [r.t, r.c]));
      if (JSON.stringify(Object.entries(preCols).sort()) !== JSON.stringify(Object.entries(postCols).sort())) throw new Error("0025 / 0026 changed a table or column set");
      const kickoffCatalogPins = await kickoffCatalog(app); const notificationCatalogPin = await notificationCatalog(app, N);
      const pgVersion = (await c.query("SHOW server_version")).rows[0].server_version;
      const pins = { schema: "e7-0025-0026-pins-v1", inventorySql: sha(INVENTORY), derivedOnPg: pgVersion,
        files: { up25: m25.upChecksum, down25: m25.downChecksum, name25: m25.name, up26: m26.upChecksum, down26: m26.downChecksum, name26: m26.name },
        tables: Object.keys(preCols).sort(), addedColumns: {}, newTables: [], kickoffCatalogPre, kickoffCatalogPins, notificationCatalogPin,
        runners: { mainCommit: MAIN.commit, mainTree: MAIN.tree,
          kickoff: { path: MAIN.kickoff, sha256: sha(kickSrc), export: "CATALOG_PINS" }, notification: { path: MAIN.notification, sha256: sha(notSrc), export: "CONSTANTS.catalogPin26" } },
        pre, mid, post };
      if (JSON.stringify(kickoffCatalogPins) !== JSON.stringify(JSON.parse(JSON.stringify(K.CATALOG_PINS)))) throw new Error("POST kickoff catalog != the main runner's CATALOG_PINS");
      if (JSON.stringify(notificationCatalogPin) !== JSON.stringify(JSON.parse(JSON.stringify(N.CONSTANTS.catalogPin26)))) throw new Error("POST notification catalog != the main runner's catalogPin26");
      writeFileSync(join(ROOT, "claude/e7-0025-0026-pins-v1.json"), `${JSON.stringify(pins, null, 2)}\n`);
      console.log(JSON.stringify({ wrote: "claude/e7-0025-0026-pins-v1.json", pg: pgVersion, pre: pre.functions, mid: mid.functions, post: post.functions,
        aggregate24: pre.migrations.aggregate, aggregate26: post.migrations.aggregate, notificationCatalog: notificationCatalogPin.catalog }));
    } finally { await app.end(); }
  } finally { await c.end(); db.stop(); }
}
