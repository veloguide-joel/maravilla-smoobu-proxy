// E7 C116 — migration 0025 (gn_recipient_in_scope: `.invalid` OR exactly delivered@resend.dev) on DISPOSABLE local PostgreSQL (16 and 17 via PG_BIN).
// Proves: in-place replacement on base schema 24 — same OID / owner / ACL / volatility / SECURITY INVOKER / search_path / signature / return type;
// NO privilege change for any role (PUBLIC, runtime, report, admin); every OTHER booking function / table definition byte-identical; JS ↔ SQL parity on the
// shared vector table; NULL → false; exact down restores the 0016 definition (catalog identical to the forward-built schema 24); re-up identical.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startPostgres } from "./harness.mjs";
import { migrateDown, migrateUp, loadMigrations } from "../../db/lib/migrate.js";
import { isRecipientInScope } from "../../lib/checkout/guest-notification.js";
import { SCOPE_VECTORS } from "../e7-c116-scope-vectors.mjs";

let db; let c;
before(async () => { db = await startPostgres(); c = new pg.Client({ connectionString: db.adminUrl }); await c.connect(); });
after(async () => { await c.end().catch(() => {}); db.stop(); });

const q1 = async (sql, p = []) => (await c.query(sql, p)).rows[0];
const FN = "booking.gn_recipient_in_scope(text)";
const attrs = () => q1(`SELECT p.oid::int AS oid, pg_get_userbyid(p.proowner) AS owner, coalesce(p.proacl::text, '<null>') AS acl, p.provolatile AS vol, p.prosecdef AS secdef,
  p.proconfig::text AS config, (SELECT lanname FROM pg_language WHERE oid = p.prolang) AS lang, pg_get_function_identity_arguments(p.oid) AS args, pg_get_function_result(p.oid) AS ret, p.proisstrict AS strict,
  p.proparallel AS parallel, md5(pg_get_functiondef(p.oid)) AS def FROM pg_proc p WHERE p.oid = $1::regprocedure`, [FN]);
const privs = () => q1(`SELECT jsonb_object_agg(r, has_function_privilege(r, $1, 'EXECUTE')) AS p FROM unnest(ARRAY['public','mv_booking_app','mv_booking_report','mv_booking_admin']) AS r`, [FN]).catch(async () =>
  q1(`SELECT jsonb_build_object('mv_booking_app', has_function_privilege('mv_booking_app', $1, 'EXECUTE'), 'mv_booking_report', has_function_privilege('mv_booking_report', $1, 'EXECUTE'),
    'mv_booking_admin', has_function_privilege('mv_booking_admin', $1, 'EXECUTE'), 'acl', (SELECT coalesce(proacl::text,'') FROM pg_proc WHERE oid = $1::regprocedure)) AS p`, [FN]));
/** every OTHER object in schema booking (functions by full definition + ACL, tables / columns / constraints / triggers / indexes) → one md5 */
const others = () => q1(`SELECT md5(string_agg(x, E'\\n' ORDER BY x)) AS h FROM (
    SELECT 'fn|' || p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(p.proacl::text,'') AS x FROM pg_proc p
      WHERE p.pronamespace = 'booking'::regnamespace AND p.prokind = 'f' AND p.oid <> $1::regprocedure
    UNION ALL SELECT 'rel|' || c.relname || '|' || c.relkind::text || '|' || coalesce(c.relacl::text,'') FROM pg_class c WHERE c.relnamespace = 'booking'::regnamespace
    UNION ALL SELECT 'col|' || a.attrelid::regclass::text || '.' || a.attname || '|' || format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'booking'::regnamespace AND a.attnum > 0 AND NOT a.attisdropped
    UNION ALL SELECT 'con|' || conrelid::regclass::text || '|' || conname || '|' || pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace = 'booking'::regnamespace
    UNION ALL SELECT 'trg|' || tgrelid::regclass::text || '|' || tgname || '|' || pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'booking'::regnamespace)
  ) s`, [FN]);
const sqlScope = async (v) => (await q1("SELECT booking.gn_recipient_in_scope($1) AS r", [v])).r;

test("C116-D1 0025 on base schema 24: in-place replacement (same OID / owner / ACL / volatility / invoker / search_path / signature / return / strict / parallel), no privilege change for any role, every other booking object identical; JS ↔ SQL parity on every shared vector and NULL; exact down restores the 0016 definition; re-up identical", async () => {
  const M = loadMigrations(); assert.equal(M.at(-1).version, 25); assert.equal(M.at(-1).name, "gn_sink_recipient_scope");
  assert.deepEqual(await migrateUp(c, { env: "test", to: 24 }), Array.from({ length: 24 }, (_, i) => i + 1));
  const a24 = await attrs(); const p24 = await privs(); const o24 = await others();
  assert.deepEqual([a24.vol, a24.secdef, a24.config, a24.lang, a24.args, a24.ret], ["i", false, "{\"search_path=pg_catalog, booking\"}", "sql", "p_email text", "boolean"]);
  const SQLV = SCOPE_VECTORS.filter(([v]) => !v.includes("\u0000"));   // PostgreSQL text cannot hold NUL (asserted below): such a value can never be a stored email
  for (const [v, want] of SQLV) if (v !== "delivered@resend.dev") assert.equal(await sqlScope(v), want, `schema 24 ${JSON.stringify(v)}`);
  assert.equal(await sqlScope("delivered@resend.dev"), false, "schema 24: the sink is out of scope");

  assert.deepEqual(await migrateUp(c, { env: "test" }), [25]);
  const a25 = await attrs();
  for (const k of ["oid", "owner", "acl", "vol", "secdef", "config", "lang", "args", "ret", "strict", "parallel"]) assert.equal(a25[k], a24[k], `0025 preserves ${k}`);
  assert.notEqual(a25.def, a24.def, "the body changed");
  assert.deepEqual(await privs(), p24, "no privilege change for any role");
  assert.equal((await others()).h, o24.h, "every other booking object is byte-identical");
  for (const [v, want] of SQLV) {
    assert.equal(await sqlScope(v), want, `SQL ${JSON.stringify(v)}`);
    assert.equal(isRecipientInScope(v), want, `JS ${JSON.stringify(v)}`);
  }
  assert.equal(await sqlScope(null), false, "NULL → false");
  for (const [v, want] of SCOPE_VECTORS.filter(([x]) => x.includes("\u0000"))) {
    assert.equal(isRecipientInScope(v), want); await assert.rejects(sqlScope(v), (e) => e.code === "22021", "NUL is not representable in PostgreSQL text");
  }

  assert.deepEqual(await migrateDown(c, { env: "test", to: 24 }), [25]);
  const d24 = await attrs();
  for (const k of Object.keys(a24)) assert.equal(d24[k], a24[k], `down restores ${k} exactly (incl. the 0016 definition)`);
  assert.deepEqual(await privs(), p24); assert.equal((await others()).h, o24.h);
  assert.equal(await sqlScope("delivered@resend.dev"), false, "down: the sink is out of scope again");

  assert.deepEqual(await migrateUp(c, { env: "test" }), [25]);
  const r25 = await attrs(); for (const k of Object.keys(a25)) assert.equal(r25[k], a25[k], `re-up identical ${k}`);
});
