// beginPayStep availability correction: claim inserts are serialised per listing by a transaction advisory lock taken
// (after the intent row lock) immediately before INSERT inventory_claims. Throwaway local PostgreSQL; no providers.
// The guard test identifies the SPECIFIC waiting backend: an ungranted advisory lock on exactly this listing's key,
// held by an app-pool (runtime role login) backend whose current statement is the helper's pg_advisory_xact_lock call.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { beginPayStep } from "../../lib/booking-db/repo.js";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });

const L = (n) => 996000 + n;
const KEY_SQL = "hashtext('booking.inventory_claims')";

/** Hold the per-listing advisory lock in an open owner transaction; returns { release }. */
async function holdListingLock(listingId) {
  const c = await db.owner.connect();
  await c.query("BEGIN");
  await c.query(`SELECT pg_advisory_xact_lock(${KEY_SQL}, $1::int)`, [listingId]);
  return { pid: (await c.query("SELECT pg_backend_pid() AS p")).rows[0].p,
    release: async () => { try { await c.query("ROLLBACK"); } finally { c.release(); } } };
}
/** The backend(s) waiting (ungranted) on exactly this listing's advisory key. */
const listingLockWaiters = async (listingId) => (await db.owner.query(
  `SELECT l.pid, a.usename, a.query FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE l.locktype = 'advisory' AND NOT l.granted AND l.objsubid = 2 AND l.objid = $1::oid
      AND l.classid::bigint = (${KEY_SQL}::bigint & 4294967295) AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
  [listingId])).rows;
async function waitForListingWaiter(listingId, done, timeoutMs = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs && !done()) {
    const w = await listingLockWaiters(listingId);
    if (w.length) return w;
    await new Promise((r) => setTimeout(r, 10));
  }
  return [];
}
const rowsOf = async (ids) => ({
  claims: (await db.app.query("SELECT intent_id FROM booking.inventory_claims WHERE intent_id = ANY($1) AND released_at IS NULL", [ids])).rows.map((r) => r.intent_id),
  attempts: (await db.app.query("SELECT intent_id, status FROM booking.payment_attempts WHERE intent_id = ANY($1)", [ids])).rows,
  ops: (await db.app.query("SELECT intent_id, state FROM booking.external_operations WHERE intent_id = ANY($1) AND op_type = 'stripe.create_checkout_session'", [ids])).rows
});
const overlaps = (listingId) => F.count(db.app, `SELECT count(*) AS n FROM booking.inventory_claims x JOIN booking.inventory_claims y
  ON x.id < y.id AND x.listing_id = y.listing_id AND x.stay && y.stay WHERE x.released_at IS NULL AND y.released_at IS NULL AND x.listing_id = $1`, [listingId]);

// =============================================================================================
test("guard: the helper waits on THIS listing's advisory lock before inserting its claim, then completes once it is released", async () => {
  const id = await F.withDetails(db.app, { listingId: L(1), from: "2027-09-01", to: "2027-09-04" });
  const hold = await holdListingLock(L(1));
  let done = false;
  const p = beginPayStep(db.app, id, { now: F.at(2) }).finally(() => { done = true; });
  let waiters;
  try {
    waiters = await waitForListingWaiter(L(1), () => done);
    assert.equal(waiters.length, 1, `helper must wait on listing ${L(1)}'s advisory lock (completed without waiting: ${done})`);
    assert.equal(waiters[0].usename, (await db.app.query("SELECT session_user AS u")).rows[0].u, "the waiter is an app-pool backend");
    assert.match(waiters[0].query, /pg_advisory_xact_lock\(hashtext\('booking\.inventory_claims'\)/);
    assert.notEqual(waiters[0].pid, hold.pid);
    assert.deepEqual((await rowsOf([id])).claims, [], "no committed claim while waiting");
  } finally { await hold.release(); }
  const r = await p;
  assert.deepEqual([r.ok, r.reused], [true, false]);
  const after = await rowsOf([id]);
  assert.deepEqual([after.claims.length, after.attempts.length, after.ops.length], [1, 1, 1]);
});

test("another listing proceeds while a listing's lock is held", async () => {
  const id = await F.withDetails(db.app, { listingId: L(3), from: "2027-09-01", to: "2027-09-04" });
  const hold = await holdListingLock(L(2));
  try {
    const r = await beginPayStep(db.app, id, { now: F.at(2) });
    assert.deepEqual([r.ok, r.reused], [true, false]);
    assert.deepEqual(await listingLockWaiters(L(2)), []);
  } finally { await hold.release(); }
});

test("competing same-listing calls: each ok or DATES_CLAIMED, no overlaps, refused calls leave no claim/attempt/outbox", async () => {
  const days = (n) => new Date(Date.UTC(2027, 9, 1) + n * 86400000).toISOString().slice(0, 10);
  const ids = [];
  for (let i = 0; i < 12; i++) { const s = (i * 7) % 20; const len = 2 + (i % 4); ids.push(await F.withDetails(db.app, { listingId: L(4), from: days(s), to: days(s + len) })); }
  const res = await Promise.all(ids.map((id) => beginPayStep(db.app, id, { now: F.at(2) })));
  assert.ok(res.every((r) => r.ok || r.error === "DATES_CLAIMED"), JSON.stringify(res.map((r) => r.ok || r.error)));
  assert.equal(await overlaps(L(4)), 0);
  const refused = ids.filter((_, i) => !res[i].ok); const granted = ids.filter((_, i) => res[i].ok);
  assert.ok(granted.length >= 1 && refused.length >= 1);
  assert.deepEqual(await rowsOf(refused), { claims: [], attempts: [], ops: [] });
  const g = await rowsOf(granted);
  assert.deepEqual([g.claims.length, g.attempts.length, g.ops.length], [granted.length, granted.length, granted.length]);
});

test("adjacent stays (check-out day = next check-in) both succeed concurrently", async () => {
  const a = await F.withDetails(db.app, { listingId: L(5), from: "2027-11-01", to: "2027-11-05" });
  const b = await F.withDetails(db.app, { listingId: L(5), from: "2027-11-05", to: "2027-11-08" });
  const [ra, rb] = await Promise.all([beginPayStep(db.app, a, { now: F.at(2) }), beginPayStep(db.app, b, { now: F.at(2) })]);
  assert.deepEqual([ra.ok, rb.ok], [true, true]);
  assert.equal((await rowsOf([a, b])).claims.length, 2);
});

test("same intent, repeated (concurrent) calls reuse the one unresolved attempt and its single outbox row", async () => {
  const id = await F.withDetails(db.app, { listingId: L(6), from: "2027-12-01", to: "2027-12-03" });
  const [x, y] = await Promise.all([beginPayStep(db.app, id, { now: F.at(2) }), beginPayStep(db.app, id, { now: F.at(2) })]);
  const z = await beginPayStep(db.app, id, { now: F.at(3) });
  assert.deepEqual([x.ok, y.ok, z.ok], [true, true, true]);
  assert.deepEqual([[x.reused, y.reused].sort(), z.reused], [[false, true], true]);
  assert.equal(new Set([x.attempt.id, y.attempt.id, z.attempt.id]).size, 1);
  const r = await rowsOf([id]);
  assert.deepEqual([r.claims.length, r.attempts.length, r.ops.length], [1, 1, 1]);
});
