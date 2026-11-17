// E7 C116 — migration 0026 (booking.claim_pipeline_kickoff: rebind ONLY the reviewed ENABLE expected_source_digest literal f09bcbbd… → 880db5b3…) on
// DISPOSABLE local PostgreSQL (16 and 17 via PG_BIN). Proves: in-place replacement on base schema 25 — same OID / owner / ACL / volatility /
// SECURITY DEFINER / search_path / signature / return / language; the new body is the 0024 body with EXACTLY that one literal replaced (closure literal
// f7d7cad6… and every condition unchanged); NO privilege change for any role; every OTHER booking object byte-identical; exact down restores the 0024
// definition; re-up identical. The claim behaviour itself (bound / unbound inputs) is exercised by test/db/e7-c107-kickoff-requests.test.mjs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startPostgres } from "./harness.mjs";
import { migrateDown, migrateUp, loadMigrations } from "../../db/lib/migrate.js";
import { PINNED_REVISION } from "../../lib/checkout/pipeline-kickoff-plan.js";

const OLD = "f09bcbbdfac88ca8dfd212a386d2af03698f9b710a49189b0ac9262531510999";
const NEW = "880db5b33024edbf0879fbaf5a3826e3622db12fd1808e8c2047238da507fe1b";
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

test("C116-D2 0026 on base schema 25: claim_pipeline_kickoff replaced IN PLACE with ONLY the expected_source_digest literal changed (f09bcbbd → 880db5b3 == PINNED_REVISION.sourceDigest); OID / owner / ACL / volatility / definer / search_path / signature / return / strict / parallel kept; no privilege change; every other booking object identical; exact down; re-up identical", async () => {
  assert.equal(PINNED_REVISION.sourceDigest, NEW, "SQL literal == tooling PINNED_REVISION.sourceDigest");
  const M = loadMigrations(); const m26 = M.find((m) => m.version === 26); assert.equal(m26.name, "pipeline_kickoff_source_rebind");   // C118 draft: 0027 may follow
  assert.deepEqual(await migrateUp(c, { env: "test", to: 25 }), Array.from({ length: 25 }, (_, i) => i + 1));
  const a25 = await attrs(); const p25 = await privs(); const o25 = await others();
  assert.deepEqual([a25.srcmd5, a25.secdef, a25.vol, a25.config, a25.lang], ["ede022a83e0869ec2194470665cab759", true, "v", "{\"search_path=pg_catalog, booking\"}", "plpgsql"], "base = the reviewed 0024 claim (the kickoff CATALOG_PINS src)");
  assert.equal(a25.src.split(OLD).length, 2); assert.equal(a25.src.split(CLOSURE).length, 2);

  assert.deepEqual(await migrateUp(c, { env: "test", to: 26 }), [26]);
  const a26 = await attrs();
  for (const k of ["oid", "owner", "acl", "vol", "secdef", "config", "lang", "args", "ret", "strict", "parallel"]) assert.equal(a26[k], a25[k], `0026 preserves ${k}`);
  assert.equal(a26.src, a25.src.replace(OLD, NEW), "the body is the 0024 body with EXACTLY the one literal replaced");
  assert.equal(a26.src.split(NEW).length, 2); assert.equal(a26.src.includes(OLD), false); assert.equal(a26.src.split(CLOSURE).length, 2, "closure literal unchanged");
  assert.equal(a26.def, a25.def.replace(OLD, NEW), "full definition differs ONLY by the literal");
  assert.deepEqual(await privs(), p25, "no privilege change for any role"); assert.equal((await others()).h, o25.h, "every other booking object byte-identical");
  assert.deepEqual(p25.p, { public: false, mv_booking_app: true, mv_booking_report: false, mv_booking_admin: false });

  assert.deepEqual(await migrateDown(c, { env: "test", to: 25 }), [26]);
  const d25 = await attrs(); for (const k of Object.keys(a25)) assert.equal(d25[k], a25[k], `down restores ${k} exactly (the 0024 body)`);
  assert.deepEqual(await privs(), p25); assert.equal((await others()).h, o25.h);

  assert.deepEqual(await migrateUp(c, { env: "test", to: 26 }), [26]);
  const r26 = await attrs(); for (const k of Object.keys(a26)) assert.equal(r26[k], a26[k], `re-up identical ${k}`);
  console.log(`# C116 claim prosrc md5 at 26: ${a26.srcmd5}`);
});
