// claude/derive-0027-pins.mjs — derives the PRE (exactly 0001-0026) and POST (0001-0027) schema-identity pins for the 0027 SQL-editor apply packet
// (C118) on a DISPOSABLE PostgreSQL (tooling test/db/harness.mjs + db/lib/migrate.js migrateUp — the accepted migrator, the merged files, verbatim).
// LABELLED SPECIALISATION of the accepted claude/derive-0025-0026-pins.mjs for ONE migration that adds two tables, functions, triggers and policies:
// the table / column delta is DERIVED by catalog difference (expected: two new tables, no column added to a pre-existing table; asserted). Also records,
// as the RUNTIME APP ROLE: (a) the hosted kickoff runner's catalog probe at PRE and POST (both must equal scripts/e7-hosted-kickoff.mjs CATALOG_PINS on
// main 92c1b674 — 0027 must NOT change the kickoff catalog), and (b) the hosted notification runner's own CATALOG_SQL identity at PRE (must equal
// scripts/e7-hosted-booking-confirmation.mjs CONSTANTS.catalogPin26) and at POST (expected to DIFFER: that runner then refuses schema 27 — recorded, not
// repinned). Both runner modules are read from a LOCAL checkout of main 92c1b674 (E7_MAIN_DIR). Writes claude/e7-0027-pins-v1.json.
// NEVER touches a shared database. Usage: PG_BIN=… E7_MAIN_DIR=<main 92c1b674 checkout> node claude/derive-0027-pins.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { startPostgres } from "../test/db/harness.mjs";
import { migrateUp, loadMigrations } from "../db/lib/migrate.js";
import { kickoffCatalog } from "./derive-0024-pins.mjs";
import { notificationCatalog } from "./derive-0025-0026-pins.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INVENTORY = readFileSync(join(ROOT, "claude/e7-0027-inventory.sql"), "utf8");
const sha = (s) => createHash("sha256").update(s).digest("hex");
export const MAIN = Object.freeze({ commit: "92c1b6748a719654bf324063242afd3c07ccb9d3", tree: "601fb09191989f8f6cb9f866eef4c9c70025bb75",
  kickoff: "scripts/e7-hosted-kickoff.mjs", notification: "scripts/e7-hosted-booking-confirmation.mjs" });
const COLS = "SELECT c.relname AS t, array_agg(a.attname::text ORDER BY a.attnum) AS c FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid "
  + "JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'booking' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped GROUP BY c.relname";

if (import.meta.main === true) {
  const mainDir = process.env.E7_MAIN_DIR; if (!mainDir) throw new Error("E7_MAIN_DIR (a local checkout of main 92c1b674) is required");
  const kickSrc = readFileSync(join(mainDir, MAIN.kickoff)); const notSrc = readFileSync(join(mainDir, MAIN.notification));
  const K = await import(pathToFileURL(join(mainDir, MAIN.kickoff)).href); const N = await import(pathToFileURL(join(mainDir, MAIN.notification)).href);
  const M = loadMigrations(); const m27 = M.find((m) => m.version === 27);
  if (M.at(-1).version !== 27) throw new Error("the packet covers exactly 0027");
  const db = await startPostgres();
  const c = new pg.Client({ connectionString: db.adminUrl }); await c.connect();
  try {
    await migrateUp(c, { env: "test", to: 26 });
    await c.query("CREATE ROLE test_app LOGIN IN ROLE mv_booking_app");
    const app = new pg.Client({ connectionString: db.appUrl() }); await app.connect();
    try {
      const pre = (await c.query(INVENTORY)).rows[0].e7_inventory; const preCols = Object.fromEntries((await c.query(COLS)).rows.map((r) => [r.t, r.c]));
      const kickoffCatalogPre = await kickoffCatalog(app); const notificationCatalogPre = await notificationCatalog(app, N);
      await migrateUp(c, { env: "test", to: 27 }); const post = (await c.query(INVENTORY)).rows[0].e7_inventory;
      const postCols = Object.fromEntries((await c.query(COLS)).rows.map((r) => [r.t, r.c]));
      const newTables = Object.keys(postCols).filter((t) => !(t in preCols)).sort();
      const addedColumns = {}; for (const t of Object.keys(preCols)) { const add = postCols[t].filter((x) => !preCols[t].includes(x)); if (add.length) addedColumns[t] = add; }
      if (Object.keys(preCols).some((t) => !(t in postCols) || preCols[t].some((x) => !postCols[t].includes(x)))) throw new Error("0027 dropped a table or column");
      if (JSON.stringify(newTables) !== JSON.stringify(["external_cancellations", "external_refund_attestations"]) || Object.keys(addedColumns).length) {
        throw new Error(`unexpected 0027 table delta: ${JSON.stringify({ newTables, addedColumns })}`);
      }
      const kickoffCatalogPins = await kickoffCatalog(app); const notificationCatalogPost = await notificationCatalog(app, N);
      const pgVersion = (await c.query("SHOW server_version")).rows[0].server_version;
      const mainKick = JSON.parse(JSON.stringify(K.CATALOG_PINS)); const mainNot = JSON.parse(JSON.stringify(N.CONSTANTS.catalogPin26));
      if (JSON.stringify(kickoffCatalogPre) !== JSON.stringify(mainKick) || JSON.stringify(kickoffCatalogPins) !== JSON.stringify(mainKick)) throw new Error("kickoff catalog != main CATALOG_PINS at PRE or POST");
      if (JSON.stringify(notificationCatalogPre) !== JSON.stringify(mainNot)) throw new Error("PRE notification catalog != main catalogPin26");
      if (notificationCatalogPost.catalog === mainNot.catalog) throw new Error("POST notification catalog unexpectedly equals catalogPin26");
      const pins = { schema: "e7-0027-pins-v1", inventorySql: sha(INVENTORY), derivedOnPg: pgVersion,
        files: { up27: m27.upChecksum, down27: m27.downChecksum, name27: m27.name },
        preTables: Object.keys(preCols).sort(), addedColumns, newTables, kickoffCatalogPre, kickoffCatalogPins, notificationCatalogPre, notificationCatalogPost,
        notificationSectionsChanged: Object.keys(mainNot.sections).filter((k) => notificationCatalogPost.sections[k] !== mainNot.sections[k]).sort(),
        runners: { mainCommit: MAIN.commit, mainTree: MAIN.tree,
          kickoff: { path: MAIN.kickoff, sha256: sha(kickSrc), export: "CATALOG_PINS" }, notification: { path: MAIN.notification, sha256: sha(notSrc), export: "CONSTANTS.catalogPin26" } },
        pre, post };
      writeFileSync(join(ROOT, "claude/e7-0027-pins-v1.json"), `${JSON.stringify(pins, null, 2)}\n`);
      console.log(JSON.stringify({ wrote: "claude/e7-0027-pins-v1.json", pg: pgVersion, pre: pre.functions, post: post.functions,
        aggregate26: pre.migrations.aggregate, aggregate27: post.migrations.aggregate, notificationPost: notificationCatalogPost.catalog, changed: pins.notificationSectionsChanged }));
    } finally { await app.end(); }
  } finally { await c.end(); db.stop(); }
}
