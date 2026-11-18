// E7 C119 S4 — migration 0028 (booking.claim_pipeline_kickoff: rebind ONLY the reviewed ENABLE expected_source_digest literal 880db5b3… → 5294b6b4…) on
// DISPOSABLE local PostgreSQL (16 and 17 via PG_BIN). Proves: in-place replacement on base schema 27 — same OID / owner / ACL / volatility /
// SECURITY DEFINER / search_path / signature / return / language; the new body is the 0026 body with EXACTLY that one literal replaced (closure literal
// f7d7cad6… and every condition unchanged); NO privilege change for any role; every OTHER booking object byte-identical; exact down restores the 0026
// definition; re-up identical. The claim behaviour itself (bound / unbound inputs) is exercised by test/db/e7-c107-kickoff-requests.test.mjs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startPostgres } from "./harness.mjs";
import { migrateDown, migrateUp, loadMigrations } from "../../db/lib/migrate.js";
import { PINNED_REVISION } from "../../lib/checkout/pipeline-kickoff-plan.js";

const OLD = "880db5b33024edbf0879fbaf5a3826e3622db12fd1808e8c2047238da507fe1b";
const NEW = "5294b6b467839e1dd825e56063abc1ad1267eafdfb2973f2c2129e9b1f29c3f5";
const CLOSURE = "f7d7cad646eaed2fb37a63e031157732ee6e2a44824f9d935d6b9104e08f7273";
let db; let c;
before(async () => { db = await startPostgres(); c = new pg.Client({ connectionString: db.adminUrl }); await c.connect(); });
after(async () => { await c.end().catch(() => {}); db.stop(); });

const q1 = async (sql, p = []) => (await c.query(sql, p)).rows[0];
const FN = "booking.claim_pipeline_kickoff(uuid,text,text,jsonb)";
const attrs = () => q1(`SELECT p.oid::int AS oid, pg_get_userbyid(p.proowner) AS owner, coalesce(p.proacl::text, '<null>') AS acl, p.provolatile AS vol, p.prosecdef AS secdef,
  p.proconfig::text AS config, (SELECT lanname FROM pg_language WHERE oid = p.prolang) AS lang, pg_get_function_identity_arguments(p.oid) AS args, pg_get_function_result(p.oid) AS ret,
  p.proisstrict AS strict, p.proparallel AS parallel, p.prosrc AS src, md5(p.prosrc) AS srcmd5, pg_get_functiondef(p.oid) AS def FROM pg_proc p WHERE p.oid = $1::regprocedure`, [FN]);
const privs = () => q1(`SELECT jsonb_build_object('public', has_function_privilege('public', $1, 'EXECUTE'), 'mv_booking_app', has_function_privilege('mv_booking_app', $1, 'EXECUTE'),
  'mv_booking_report', has_function_privilege('mv_booking_report', $1, 'EXECUTE'), 'mv_booking_admin', has_function_privilege('mv_booking_admin', $1, 'EXECUTE')) AS p`, [FN]);
const others = () => q1(`SELECT md5(string_agg(x, E'\\n' ORDER BY x)) AS h FROM (
    SELECT 'fn|' || p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(p.proacl::text,'') AS x FROM pg_proc p
      WHERE p.pronamespace = 'booking'::regnamespace AND p.prokind = 'f' AND p.oid <> $1::regprocedure
    UNION ALL SELECT 'rel|' || c.relname || '|' || c.relkind::text || '|' || coalesce(c.relacl::text,'') FROM pg_class c WHERE c.relnamespace = 'booking'::regnamespace
    UNION ALL SELECT 'col|' || a.attrelid::regclass::text || '.' || a.attname || '|' || format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'booking'::regnamespace AND a.attnum > 0 AND NOT a.attisdropped
    UNION ALL SELECT 'con|' || conrelid::regclass::text || '|' || conname || '|' || pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace = 'booking'::regnamespace
    UNION ALL SELECT 'trg|' || tgrelid::regclass::text || '|' || tgname || '|' || pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'booking'::regnamespace)
    UNION ALL SELECT 'pol|' || polrelid::regclass::text || '|' || polname || '|' || coalesce(pg_get_expr(polqual, polrelid), '') || '|' || coalesce(pg_get_expr(polwithcheck, polrelid), '') FROM pg_policy
      WHERE polrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'booking'::regnamespace)
  ) s`, [FN]);

test("C119-S4-D1 0028 on base schema 27: claim_pipeline_kickoff replaced IN PLACE with ONLY the expected_source_digest literal changed (880db5b3 → 5294b6b4 == PINNED_REVISION.sourceDigest); OID / owner / ACL / volatility / definer / search_path / signature / return / language unchanged; no privilege change; every other booking object identical (0027 untouched); exact down restores the 0026 body; re-up identical", async () => {
  assert.equal(PINNED_REVISION.sourceDigest, NEW, "SQL literal == tooling PINNED_REVISION.sourceDigest");
  const M = loadMigrations(); const m28 = M.find((m) => m.version === 28); assert.equal(m28.name, "pipeline_kickoff_source_rebind_s4"); assert.equal(M.length, 28);
  assert.deepEqual(await migrateUp(c, { env: "test", to: 27 }), Array.from({ length: 27 }, (_, i) => i + 1));
  const a27 = await attrs(); const p27 = await privs(); const o27 = await others();
  assert.deepEqual([a27.srcmd5, a27.secdef, a27.vol, a27.config, a27.lang], ["fb103173762c5dc6565338d2a15dd067", true, "v", "{\"search_path=pg_catalog, booking\"}", "plpgsql"], "base = the reviewed 0026 claim (the kickoff CATALOG_PINS src at schema 26 / 27)");
  assert.equal(a27.src.split(OLD).length, 2); assert.equal(a27.src.split(CLOSURE).length, 2);

  assert.deepEqual(await migrateUp(c, { env: "test", to: 28 }), [28]);
  const a28 = await attrs();
  for (const k of ["oid", "owner", "acl", "vol", "secdef", "config", "lang", "args", "ret", "strict", "parallel"]) assert.equal(a28[k], a27[k], `0028 preserves ${k}`);
  assert.equal(a28.src, a27.src.replace(OLD, NEW), "the body is the 0026 body with EXACTLY the one literal replaced");
  assert.equal(a28.src.split(NEW).length, 2); assert.equal(a28.src.includes(OLD), false); assert.equal(a28.src.split(CLOSURE).length, 2, "closure literal unchanged");
  assert.equal(a28.def, a27.def.replace(OLD, NEW), "full definition differs ONLY by the literal");
  assert.deepEqual(await privs(), p27, "no privilege change for any role"); assert.equal((await others()).h, o27.h, "every other booking object byte-identical");
  assert.deepEqual(p27.p, { public: false, mv_booking_app: true, mv_booking_report: false, mv_booking_admin: false });

  assert.deepEqual(await migrateDown(c, { env: "test", to: 27 }), [28]);
  const d27 = await attrs(); for (const k of Object.keys(a27)) assert.equal(d27[k], a27[k], `down restores ${k} exactly (the 0026 body)`);
  assert.deepEqual(await privs(), p27); assert.equal((await others()).h, o27.h);

  assert.deepEqual(await migrateUp(c, { env: "test", to: 28 }), [28]);
  const r28 = await attrs(); for (const k of Object.keys(a28)) assert.equal(r28[k], a28[k], `re-up identical ${k}`);
  console.log(`# C119 S4 claim prosrc md5 at 28: ${a28.srcmd5}`);
});
