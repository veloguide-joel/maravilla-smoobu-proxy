// P2d / 0030: the guest-notification recipient scope follows the database's environment marker. Throwaway local PostgreSQL only.
// No email is sent anywhere: this tests the SQL predicate and its JavaScript mirror.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMigratedDatabase } from "./harness.mjs";
import { isRecipientInScope, isLiveRecipient, isRecipientInScopeFor, SINK_RECIPIENT } from "../../lib/checkout/guest-notification.js";
import { migrateDown, migrateUp } from "../../db/lib/migrate.js";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });

const REAL = ["guest@example.com", "First.Last+trip@Mail.Example.co", "a_b%c@sub.domain.travel"];
const TEST_SCOPE = ["zq.fixture.guest@example.invalid", SINK_RECIPIENT];
const NEVER = ["", "no-at-sign", "a@b", "a@b.c", "two@@example.com", "spa ce@example.com", "x@exa_mple.com", "x@example.c0m", `${"a".repeat(65)}@example.com`,
  `x@${"d".repeat(250)}.com`, "x@example.com\n", " x@example.com", "x@example.com ", "X@EXAMPLE.INVALID", "Delivered@Resend.dev"];
const sql = async (pool, e) => (await pool.query("SELECT booking.gn_recipient_in_scope($1) AS ok", [e])).rows[0].ok;
const marker = (v) => db.owner.query("UPDATE booking.instance SET environment = $1", [v]);

test("S1 TEST database (marker 'test'): exactly the 0025 scope; a real guest address is NEVER admitted; SQL == the JavaScript TEST predicate", async () => {
  for (const e of TEST_SCOPE) assert.deepEqual([await sql(db.owner, e), isRecipientInScope(e), isRecipientInScopeFor(e, "test")], [true, true, true], e);
  for (const e of [...REAL, ...NEVER.filter((x) => x !== "X@EXAMPLE.INVALID")]) assert.deepEqual([await sql(db.owner, e), isRecipientInScopeFor(e, "test")], [false, false], JSON.stringify(e));
  assert.equal(await sql(db.owner, null), false);
});

test("S2 LIVE database (marker exactly one 'live' row): a valid real address is admitted; `.invalid`, the sink and malformed input never; SQL == the JavaScript LIVE predicate", async () => {
  await marker("live");
  try {
    for (const e of REAL) assert.deepEqual([await sql(db.owner, e), isLiveRecipient(e), isRecipientInScopeFor(e, "live")], [true, true, true], e);
    for (const e of [...TEST_SCOPE, ...NEVER]) assert.deepEqual([await sql(db.owner, e), isLiveRecipient(e)], [false, false], JSON.stringify(e));
    assert.equal(await sql(db.owner, null), false);
  } finally { await marker("test"); }
  assert.equal(await sql(db.owner, REAL[0]), false, "marker restored: a real address is out of scope again");
});

test("S3 a missing or duplicated marker fails to the TEST scope (never to real addresses)", async () => {
  const c = await db.owner.connect();
  try {
    await c.query("BEGIN"); await c.query("SET LOCAL session_replication_role = replica");
    await c.query("DELETE FROM booking.instance");
    assert.deepEqual([(await c.query("SELECT booking.gn_recipient_in_scope($1) AS ok", [REAL[0]])).rows[0].ok, (await c.query("SELECT booking.gn_recipient_in_scope($1) AS ok", [SINK_RECIPIENT])).rows[0].ok], [false, true]);
    await c.query("ROLLBACK");
  } finally { await c.query("ROLLBACK").catch(() => {}); c.release(); }
  assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM booking.instance")).rows[0].n, 1);
});

test("S4 0030 replaces the function in place (same oid, owner, ACL, security, search_path); only IMMUTABLE -> STABLE; down restores the 0025 body and volatility", async () => {
  const attrs = async () => (await db.owner.query(`SELECT p.oid::int AS oid, p.provolatile AS vol, p.prosecdef AS secdef, p.proconfig::text AS cfg, p.proowner::regrole::text AS owner,
    coalesce(p.proacl::text, '') AS acl, md5(p.prosrc) AS src FROM pg_proc p WHERE p.oid = 'booking.gn_recipient_in_scope(text)'::regprocedure`)).rows[0];
  const a30 = await attrs();
  assert.deepEqual([a30.vol, a30.secdef], ["s", false]);
  const own = await db.owner.connect();
  let a29;
  try {
    assert.deepEqual(await migrateDown(own, { env: "test", to: 29 }), [31, 30]);
    a29 = await attrs();
    assert.equal(await sql(db.owner, SINK_RECIPIENT), true);
    assert.deepEqual(await migrateUp(own, { env: "test" }), [30, 31]);
  } finally { own.release(); }
  const again = await attrs();
  assert.deepEqual([a29.vol, a29.oid, a29.owner, a29.acl, a29.cfg, a29.secdef], ["i", a30.oid, a30.owner, a30.acl, a30.cfg, false]);
  assert.notEqual(a29.src, a30.src);
  assert.deepEqual(again, a30, "up re-applies identically");
});
