// claude/derive-0028-pins.mjs — derives the PRE (exactly 0001-0027) and POST (0001-0028) schema-identity pins for the 0028 SQL-editor apply packet
// (C119 S4) on a DISPOSABLE PostgreSQL (tooling test/db/harness.mjs + db/lib/migrate.js migrateUp — the accepted migrator, the merged files, verbatim).
// LABELLED SPECIALISATION of the accepted claude/derive-0027-pins.mjs for ONE migration that replaces ONE function body (booking.claim_pipeline_kickoff:
// only the expected_source_digest literal 880db5b3… → 5294b6b4…): the table / column delta is DERIVED by catalog difference (expected: NONE; asserted)
// and the claim body difference is asserted to be EXACTLY that literal. Also records, as the RUNTIME APP ROLE:
//   (a) the hosted kickoff runner's catalog probe at PRE (must equal scripts/e7-hosted-kickoff.mjs CATALOG_PINS on the PRE-S4 main 5b9c0677) and at POST
//       (must equal CATALOG_PINS on the MERGED S4 main a86437a8 — the runtime runner that will read the shared database after this apply);
//   (b) the hosted notification runner's own CATALOG_SQL identity at PRE (must equal catalogPin27 on main 5b9c0677) and POST (must equal catalogPin28 on
//       main a86437a8; the status runner's labelled copy is the same pin).
// Both runner modules are read from LOCAL checkouts (E7_MAIN_PRE_DIR = 5b9c0677, E7_MAIN_DIR = a86437a8). Writes claude/e7-0028-pins-v1.json.
// NEVER touches a shared database. Usage: PG_BIN=… E7_MAIN_PRE_DIR=… E7_MAIN_DIR=… node claude/derive-0028-pins.mjs
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
const INVENTORY = readFileSync(join(ROOT, "claude/e7-0028-inventory.sql"), "utf8");
const sha = (s) => createHash("sha256").update(s).digest("hex");
export const MAIN_PRE = Object.freeze({ commit: "5b9c06774757c9b84036fbc91773c3a098835d8f", tree: "0a85f9e33181501eab761f24011ff32fe20d03a4" });
export const MAIN_POST = Object.freeze({ commit: "a86437a8738b176f132e1661cabffaa82c2515c2", tree: "7c2ebc99fe985ed77d97a1b6c33a9edf925920d0" });
export const RUNNER_PATHS = Object.freeze({ kickoff: "scripts/e7-hosted-kickoff.mjs", notification: "scripts/e7-hosted-booking-confirmation.mjs", status: "scripts/e7-hosted-status.mjs" });
export const LITERAL = Object.freeze({ old: "880db5b33024edbf0879fbaf5a3826e3622db12fd1808e8c2047238da507fe1b", new: "5294b6b467839e1dd825e56063abc1ad1267eafdfb2973f2c2129e9b1f29c3f5" });
const CLAIM = "booking.claim_pipeline_kickoff(uuid,text,text,jsonb)";
const COLS = "SELECT c.relname AS t, array_agg(a.attname::text ORDER BY a.attnum) AS c FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid "
  + "JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'booking' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped GROUP BY c.relname";

if (import.meta.main === true) {
  const preDir = process.env.E7_MAIN_PRE_DIR; const postDir = process.env.E7_MAIN_DIR;
  if (!preDir || !postDir) throw new Error("E7_MAIN_PRE_DIR (main 5b9c0677) and E7_MAIN_DIR (main a86437a8) checkouts are required");
  const load = async (dir) => ({ K: await import(pathToFileURL(join(dir, RUNNER_PATHS.kickoff)).href), N: await import(pathToFileURL(join(dir, RUNNER_PATHS.notification)).href),
    S: await import(pathToFileURL(join(dir, RUNNER_PATHS.status)).href),
    sha: Object.fromEntries(Object.entries(RUNNER_PATHS).map(([k, p]) => [k, sha(readFileSync(join(dir, p)))])) });
  const PREM = await load(preDir); const POSTM = await load(postDir);
  const M = loadMigrations(); const m28 = M.find((m) => m.version === 28);
  if (M.at(-1).version !== 28) throw new Error("the packet covers exactly 0028");
  const db = await startPostgres();
  const c = new pg.Client({ connectionString: db.adminUrl }); await c.connect();
  try {
    await migrateUp(c, { env: "test", to: 27 });
    await c.query("CREATE ROLE test_app LOGIN IN ROLE mv_booking_app");
    const app = new pg.Client({ connectionString: db.appUrl() }); await app.connect();
    try {
      const src = async () => (await c.query("SELECT prosrc FROM pg_catalog.pg_proc WHERE oid = $1::regprocedure", [CLAIM])).rows[0].prosrc;
      const pre = (await c.query(INVENTORY)).rows[0].e7_inventory; const preCols = Object.fromEntries((await c.query(COLS)).rows.map((r) => [r.t, r.c]));
      const kickoffCatalogPre = await kickoffCatalog(app); const notificationCatalogPre = await notificationCatalog(app, PREM.N); const claimPre = await src();
      await migrateUp(c, { env: "test", to: 28 }); const post = (await c.query(INVENTORY)).rows[0].e7_inventory;
      const postCols = Object.fromEntries((await c.query(COLS)).rows.map((r) => [r.t, r.c])); const claimPost = await src();
      if (JSON.stringify(preCols) !== JSON.stringify(postCols)) throw new Error("0028 must not change any table / column");
      if (claimPre.split(LITERAL.old).length !== 2 || claimPost.split(LITERAL.new).length !== 2 || claimPost.includes(LITERAL.old) || claimPre.replace(LITERAL.old, LITERAL.new) !== claimPost) {
        throw new Error("the claim body must differ ONLY by the one source literal");
      }
      const kickoffCatalogPost = await kickoffCatalog(app); const notificationCatalogPost = await notificationCatalog(app, POSTM.N);
      const pgVersion = (await c.query("SHOW server_version")).rows[0].server_version;
      const J = (x) => JSON.stringify(JSON.parse(JSON.stringify(x)));
      if (J(kickoffCatalogPre) !== J(PREM.K.CATALOG_PINS)) throw new Error("PRE kickoff catalog != main 5b9c0677 CATALOG_PINS");
      if (J(kickoffCatalogPost) !== J(POSTM.K.CATALOG_PINS)) throw new Error("POST kickoff catalog != main a86437a8 CATALOG_PINS");
      if (J(notificationCatalogPre) !== J(PREM.N.CONSTANTS.catalogPin27)) throw new Error("PRE notification catalog != main 5b9c0677 catalogPin27");
      if (J(notificationCatalogPost) !== J(POSTM.N.CONSTANTS.catalogPin28) || J(POSTM.S.CONSTANTS.catalogPin28) !== J(POSTM.N.CONSTANTS.catalogPin28)) throw new Error("POST notification / status catalog != main a86437a8 catalogPin28");
      const changedKeys = Object.keys(pre).filter((k) => k !== "migrations" && JSON.stringify(pre[k]) !== JSON.stringify(post[k])).sort();
      const pins = { schema: "e7-0028-pins-v1", inventorySql: sha(INVENTORY), derivedOnPg: pgVersion,
        files: { up28: m28.upChecksum, down28: m28.downChecksum, name28: m28.name },
        literal: { ...LITERAL }, claimSrcMd5: { pre: createHash("md5").update(claimPre).digest("hex"), post: createHash("md5").update(claimPost).digest("hex") },
        tables: Object.keys(preCols).sort(), identityKeysChanged: changedKeys,
        kickoffCatalogPre, kickoffCatalogPost, notificationCatalogPre, notificationCatalogPost,
        notificationSectionsChanged: Object.keys(notificationCatalogPre.sections).filter((k) => notificationCatalogPost.sections[k] !== notificationCatalogPre.sections[k]).sort(),
        runners: { pre: { ...MAIN_PRE, sha256: PREM.sha }, post: { ...MAIN_POST, sha256: POSTM.sha }, paths: { ...RUNNER_PATHS } },
        pre, post };
      writeFileSync(join(ROOT, "claude/e7-0028-pins-v1.json"), `${JSON.stringify(pins, null, 2)}\n`);
      console.log(JSON.stringify({ wrote: "claude/e7-0028-pins-v1.json", pg: pgVersion, pre: pre.functions, post: post.functions, changedKeys,
        aggregate27: pre.migrations.aggregate, aggregate28: post.migrations.aggregate, claimSrcMd5: pins.claimSrcMd5, notificationPost: notificationCatalogPost.catalog }));
    } finally { await app.end(); }
  } finally { await c.end(); db.stop(); }
}
