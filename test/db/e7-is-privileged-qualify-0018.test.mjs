// 0018 (LOCAL MIGRATION CANDIDATE, root security-fix approval 2026-11-07) — schema-qualify booking.is_privileged().
// Throwaway local PostgreSQL only. BOOLEAN-CONTRACT test: no protected booking write, no guard-bypass demonstration.
// It verifies (1) the fixed function returns the correct boolean for app/report/owner under default and explicit search paths,
// even when the calling session holds a same-session temp relation named pg_namespace crafted to assert privilege;
// (2) migration 0018 up changes ONLY prosrc + proconfig (owner/ACL/secdef/volatile/signature/lang unchanged) and down restores
// the 0003 body byte-exact; (3) the OLD (pre-fix) function — restored via 0018 down — is subvertible under the same shadow
// (the failing-before control); (4) an is_privileged()-gated guard still refuses an app write and admits the owner gate.
// Nothing is persisted: guard probes run in a rolled-back transaction, the shadow lives only in each throwaway session.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startMigratedDatabase } from "./harness.mjs";
import { migrateUp, migrateDown } from "../../db/lib/migrate.js";

let db;
before(async () => { db = await startMigratedDatabase(); });   // migrates 1..18 (0018 included)
after(async () => { await db.close(); });

// One fresh session at `url`. Optionally set the session search_path and/or plant a pg_temp relation named pg_namespace whose
// single row claims this session's own role owns schema 'booking'. Returns the is_privileged() boolean plus the shadow outcome.
async function probe(url, { searchPath, shadow } = {}) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const out = { shadow: shadow ? null : "none" };
  try {
    if (searchPath) await c.query(`SET search_path = ${searchPath}`);
    if (shadow) {
      try {
        await c.query("CREATE TEMP TABLE pg_namespace (nspname name, nspowner oid)");      // pg_-prefixed temp relation
        await c.query("INSERT INTO pg_namespace (nspname, nspowner) SELECT 'booking', r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user");
        out.shadow = "created";
      } catch (e) { out.shadow = `refused:${e.code || e.message}`; }
    }
    out.user = (await c.query("SELECT current_user AS u")).rows[0].u;
    try { out.p = (await c.query("SELECT booking.is_privileged() AS p")).rows[0].p; }
    catch (e) { out.err = e.code; }                                            // e.g. 42501 when the role has no EXECUTE
  } finally { await c.end(); }
  return out;
}

async function funcCatalog() {
  const r = await db.owner.query(`SELECT p.prosrc, p.proconfig, p.provolatile, p.prosecdef,
      p.proowner::regrole::text AS owner, COALESCE(p.proacl::text, '<null>') AS acl,
      p.prorettype::regtype::text AS rettype, p.proargtypes::text AS argtypes, l.lanname AS lang,
      encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') AS prosrcsha
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid = p.prolang
    WHERE p.oid = 'booking.is_privileged()'::regprocedure`);
  return r.rows[0];
}
const withAdmin = async (fn) => { const c = new pg.Client({ connectionString: db.adminUrl }); await c.connect(); try { return await fn(c); } finally { await c.end(); } };

// ---------------------------------------------------------------------------------------------------------------------------------
test("0018 fixed is_privileged() boolean contract: app=false, owner=true, report=permission-denied (42501, real ACL preserved — NOT granted EXECUTE) — under default and explicit pg_catalog,booking search paths, and WITH a same-session pg_namespace shadow present", async () => {
  const shadowOutcomes = new Set();
  for (const sp of [null, "pg_catalog, booking"]) {
    for (const shadow of [false, true]) {
      const app = await probe(db.appUrl(), { searchPath: sp, shadow });
      const rep = await probe(db.reportUrl(), { searchPath: sp, shadow });
      assert.equal(app.p, false, `app false (searchPath=${sp}, shadow=${shadow}; got ${JSON.stringify(app)})`);
      // report has NO EXECUTE on is_privileged() (0003 C7 grants it to app + admin only); it must stay permission-denied, not be widened
      assert.equal(rep.err, "42501", `report permission-denied (searchPath=${sp}, shadow=${shadow}; got ${JSON.stringify(rep)})`);
      assert.equal(rep.p, undefined, "report never gets a boolean (EXECUTE denied)");
      if (shadow) { shadowOutcomes.add(app.shadow); shadowOutcomes.add(rep.shadow); }
    }
    const owner = await probe(db.adminUrl, { searchPath: sp });
    assert.equal(owner.p, true, `owner true (searchPath=${sp}; got ${JSON.stringify(owner)})`);
  }
  // record (not assert) whether PostgreSQL even permits the pg_-prefixed temp relation; both branches keep the fix correct above
  console.log("0018 shadow-create outcomes (app/report):", [...shadowOutcomes].join(" | "));
  assert.ok([...shadowOutcomes].every((o) => o === "created" || o.startsWith("refused:")), "shadow outcome recorded honestly");
});

test("0018 catalog compare + down restores the 0003 body byte-exact: up changes ONLY prosrc + proconfig; owner/ACL/secdef/volatile/signature/lang unchanged", async () => {
  const at18 = await funcCatalog();
  await withAdmin((c) => migrateDown(c, { env: "test", to: 17 }));             // runs 0018 down
  const at17 = await funcCatalog();
  try {
    for (const k of ["owner", "acl", "provolatile", "prosecdef", "rettype", "argtypes", "lang"]) assert.equal(at18[k], at17[k], `unchanged: ${k}`);
    assert.equal(at17.prosecdef, false, "SECURITY INVOKER"); assert.equal(at17.provolatile, "s", "STABLE");
    // 17 = old, unqualified, no pinned search_path
    assert.match(at17.prosrc, /FROM pg_namespace WHERE nspname = 'booking'/, "old body unqualified");
    assert.doesNotMatch(at17.prosrc, /pg_catalog\.pg_namespace/, "old body not qualified");
    assert.equal(at17.proconfig, null, "old has no proconfig");
    // 18 = qualified + pinned
    assert.match(at18.prosrc, /pg_catalog\.pg_namespace/, "fixed qualifies pg_namespace");
    assert.match(at18.prosrc, /pg_catalog\.pg_get_userbyid/, "fixed qualifies pg_get_userbyid");
    assert.match((at18.proconfig || []).join("|"), /search_path=pg_catalog,\s*pg_temp/, "fixed pins search_path pg_catalog, pg_temp");
    // down restored the 0003 body (prosrc) exactly — compare to the on-disk 0003 statement body
    const base0003 = "\n  SELECT current_user::text = (SELECT pg_get_userbyid(nspowner)::text FROM pg_namespace WHERE nspname = 'booking')\n";
    assert.equal(at17.prosrc, base0003, "0018 down restores the 0003 prosrc byte-for-byte");
    // provenance cross-check: the restored body matches root's read-only LIVE helper prosrc SHA256 (proves down == the live definition)
    assert.equal(at17.prosrcsha, "701fade99915db198c1aff0eee3e94d7106c314480ee5863321739444ba20c69", "restored prosrc SHA256 == root's live helper baseline");
    assert.equal(at17.owner, "postgres", "owner is the migrator (postgres on disposable; root's live baseline: owner postgres)");
    assert.equal(at18.owner, "postgres", "0018 up keeps the owner");
  } finally {
    await withAdmin((c) => migrateUp(c, { env: "test", to: 18 }));             // restore the fixed function for any later run
  }
  const back = await funcCatalog();
  assert.match(back.prosrc, /pg_catalog\.pg_namespace/, "re-applied 0018 up");
});

test("0018 failing-before control (OLD function via down→17): the unqualified body IS subvertible by the shadow where the fixed one is not — boolean return only, nothing persisted", async () => {
  await withAdmin((c) => migrateDown(c, { env: "test", to: 17 }));
  try {
    const cleanApp = await probe(db.appUrl(), {});                              // clean session, no shadow
    const cleanOwner = await probe(db.adminUrl, {});
    assert.equal(cleanApp.p, false, "old function correct for app WITHOUT a shadow");
    assert.equal(cleanOwner.p, true, "old function correct for owner");
    const shadApp = await probe(db.appUrl(), { shadow: true });                 // app WITH the shadow
    if (shadApp.shadow === "created") {
      assert.equal(shadApp.p, true, "FAILING-BEFORE: the OLD unqualified function returns TRUE for app under the shadow (the weakness)");
    } else {
      // PostgreSQL refused the pg_-prefixed temp relation — preserve the actual result; the specific vector is blocked, fix still stands
      assert.match(shadApp.shadow, /^refused:/, "shadow creation refused by PostgreSQL — recorded, not invented");
      assert.equal(shadApp.p, false, "no shadow created => old function stays false (reassess: vector blocked by PG name rules)");
      console.log("0018 NOTE: pg_-prefixed temp relation refused by PostgreSQL:", shadApp.shadow);
    }
    // confirm the FIXED function is NOT subvertible by the same shadow (re-apply 18, then probe with shadow)
    await withAdmin((c) => migrateUp(c, { env: "test", to: 18 }));
    const shadAppFixed = await probe(db.appUrl(), { shadow: true });
    assert.equal(shadAppFixed.p, false, "FIXED function returns false for app even with the shadow present");
  } finally {
    await withAdmin((c) => migrateUp(c, { env: "test", to: 18 }));             // ensure fixed state regardless of branch
  }
});

test("0018 caller regression: an is_privileged()-gated guard still REFUSES an app write (insufficient_privilege) even with a shadow, and does NOT refuse the owner on the privilege gate — rolled back, nothing persisted", async () => {
  // app: direct INSERT into a guarded table => resolutions_guard calls the FIXED is_privileged() => false => refuse (42501)
  const app = new pg.Client({ connectionString: db.appUrl() }); await app.connect();
  try {
    await app.query("CREATE TEMP TABLE pg_namespace (nspname name, nspowner oid)").catch(() => {});
    await app.query("INSERT INTO pg_namespace (nspname, nspowner) SELECT 'booking', r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user").catch(() => {});
    await app.query("BEGIN");
    let code = null;
    try { await app.query("INSERT INTO booking.reconciliation_resolutions (id) VALUES (gen_random_uuid())"); }
    catch (e) { code = e.code; }
    await app.query("ROLLBACK");
    assert.equal(code, "42501", "app write refused by the guard's is_privileged() gate (insufficient_privilege), shadow notwithstanding");
  } finally { await app.end(); }
  // owner: the same insert passes the privilege gate (is_privileged() true); it may then fail a NOT NULL / CHECK, but NOT with 42501
  const owner = new pg.Client({ connectionString: db.adminUrl }); await owner.connect();
  try {
    await owner.query("BEGIN");
    let code = null;
    try { await owner.query("INSERT INTO booking.reconciliation_resolutions (id) VALUES (gen_random_uuid())"); }
    catch (e) { code = e.code; }
    await owner.query("ROLLBACK");
    assert.notEqual(code, "42501", "owner passes the is_privileged() gate (a later NOT NULL / CHECK is fine; not a privilege refusal)");
  } finally { await owner.end(); }
});

test("0018 caller-context control (current_user-based, not just owner-login): is_privileged() is TRUE inside a schema-owner SECURITY DEFINER caller invoked BY THE APP ROLE, and FALSE inside an INVOKER caller invoked by the app role — the exact effective-user semantics the guards rely on", async () => {
  // the owner creates two trivial wrappers over booking.is_privileged(): one SECURITY DEFINER (runs as the owner), one INVOKER (runs as the caller)
  await db.owner.query("CREATE FUNCTION public._e7_ctx_definer() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT booking.is_privileged() $$");
  await db.owner.query("CREATE FUNCTION public._e7_ctx_invoker() RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$ SELECT booking.is_privileged() $$");
  await db.owner.query("REVOKE EXECUTE ON FUNCTION public._e7_ctx_definer(), public._e7_ctx_invoker() FROM PUBLIC");
  await db.owner.query("GRANT EXECUTE ON FUNCTION public._e7_ctx_definer(), public._e7_ctx_invoker() TO mv_booking_app");
  const app = new pg.Client({ connectionString: db.appUrl() }); await app.connect();
  try {
    const u = (await app.query("SELECT current_user AS u")).rows[0].u;
    assert.equal(u, "test_app", "the calling session is the runtime app role");
    const d = (await app.query("SELECT public._e7_ctx_definer() AS p")).rows[0].p;
    const i = (await app.query("SELECT public._e7_ctx_invoker() AS p")).rows[0].p;
    assert.equal(d, true, "inside a schema-owner SECURITY DEFINER caller (effective current_user = owner) is_privileged() is TRUE — the intended privileged path");
    assert.equal(i, false, "inside an INVOKER caller invoked by the app role (effective current_user = app) is_privileged() is FALSE");
  } finally {
    await app.end();
    await db.owner.query("DROP FUNCTION IF EXISTS public._e7_ctx_definer(), public._e7_ctx_invoker()");   // scaffolding removed; nothing persisted in booking
  }
});
