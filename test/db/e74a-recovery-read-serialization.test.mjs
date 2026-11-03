// requestRecoveryRead concurrency — deterministic interleaving (no sleeps, no whole-suite reruns).
// A test-only pool wrapper pauses ONE call's transaction right before its "count existing rr:* keys" statement, so the
// suspected READ COMMITTED sequence can be forced exactly:
//   B: open-read check sees none -> PAUSED before its count
//   A: open-read check sees none, counts 0, inserts rr:..:1, commits      (unless A is blocked by B's lock: then A waits)
//   B: resumes, counts, inserts
// Old code: A completes, B counts 1 and inserts rr:..:2 -> TWO pending reads. Corrected code: B holds the owning intent
// (FOR NO KEY UPDATE) from before its open-read check, so A is OBSERVED waiting on that lock; after B commits, A reuses B's read.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { claimNextOperation, completeOperation } from "../../lib/booking-db/operations.js";
import { requestRecoveryRead, MAX_RECOVERY_READS } from "../../lib/booking-db/recovery.js";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });

const PIREAD = "stripe.retrieve_payment_intent";
const COUNT_STMT = /SELECT count\(\*\) AS n FROM booking\.external_operations WHERE idempotency_key LIKE/;
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

/** A pool whose transactions pause once, right before the first statement matching `pattern`, until `gate.release` resolves. */
function pausingPool(pool, pattern) {
  const reached = deferred(); const release = deferred();
  return {
    reached: reached.promise, release: () => release.resolve(),
    query: (...a) => pool.query(...a),
    connect: async () => {
      const c = await pool.connect();
      const orig = c.query.bind(c); const origRelease = c.release.bind(c);
      let paused = false;
      c.query = async (text, params) => {
        const sql = typeof text === "string" ? text : text.text;
        if (!paused && pattern.test(sql)) { paused = true; reached.resolve(); await release.promise; }
        return orig(text, params);
      };
      c.release = (...a) => { c.query = orig; c.release = origRelease; return origRelease(...a); };
      return c;
    }
  };
}
/** Bounded wait until another backend waits on a lock; resolves false (no throw) if none appears within the bound. */
async function lockWaiterSeen(timeoutMs = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await db.owner.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
                                      AND pid <> pg_backend_pid()`);
    if (r.rows[0].n >= 1) return true;
    await new Promise((res) => setTimeout(res, 10));
  }
  return false;
}
const pendingReads = async (intentId) => (await db.app.query(
  `SELECT id, idempotency_key, state, payload FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 AND state = 'pending' ORDER BY idempotency_key`,
  [intentId, PIREAD])).rows;

async function capturedOp(n) {
  const r = await F.reserved(db.app, { listingId: 998000 + n });
  const { op } = await F.runOp(db.app, r.id, "stripe.capture_payment_intent", 8, { status: "succeeded", resultRef: r.piId });
  return { r, op };
}

test("forced interleaving: B paused after its open-read check, A runs -> exactly ONE pending read; the later caller reuses it", async () => {
  const { r, op } = await capturedOp(1);
  const read = { opType: PIREAD, ref: r.piId };
  const pp = pausingPool(db.app, COUNT_STMT);
  const bP = requestRecoveryRead(pp, op.id, read, { now: F.at(10) });          // B
  await pp.reached;                                                            // B is paused right before its count
  let aDone = false;
  const aP = requestRecoveryRead(db.app, op.id, read, { now: F.at(10) }).then((x) => { aDone = true; return x; });   // A
  // either A completes (unserialised code) or A is observed waiting on B's intent lock (serialised code)
  const aWaited = await Promise.race([aP.then(() => false), lockWaiterSeen().then((seen) => seen && !aDone)]);
  pp.release();
  const [a, b] = await Promise.all([aP, bP]);
  const rows = await pendingReads(r.id);
  const evidence = { a, b, aWaitedOnLock: aWaited, pending: rows.map((x) => [x.idempotency_key.replace(op.id, "<op>"), x.state]) };
  assert.equal(rows.length, 1, `duplicate recovery reads: ${JSON.stringify(evidence)}`);
  assert.ok(aWaited, `A must have been serialised behind B: ${JSON.stringify(evidence)}`);
  assert.deepEqual([b.ok, b.reused, a.ok, a.reused, a.readOpId === b.readOpId], [true, false, true, true, true], JSON.stringify(evidence));
});

test("bounds and reuse preserved: an existing open read is reused; at most MAX_RECOVERY_READS per (op, read, ref), then exhausted", async () => {
  const { r, op } = await capturedOp(2);
  const read = { opType: PIREAD, ref: r.piId };
  const first = await requestRecoveryRead(db.app, op.id, read, { now: F.at(10) });
  assert.deepEqual([first.ok, first.reused], [true, false]);
  const again = await requestRecoveryRead(db.app, op.id, read, { now: F.at(10) });
  assert.deepEqual([again.ok, again.reused, again.readOpId], [true, true, first.readOpId], "open read reused");
  let cur = first.readOpId;
  for (let k = 2; k <= MAX_RECOVERY_READS + 1; k++) {
    const c = await claimNextOperation(db.app, { workerId: "w", now: F.at(10 + k), opId: cur });
    F.ok(await completeOperation(db.app, c.id, { workerId: "w", now: F.at(10 + k), outcome: { status: "succeeded" } }));
    const x = await requestRecoveryRead(db.app, op.id, read, { now: F.at(10 + k) });
    if (k <= MAX_RECOVERY_READS) { assert.deepEqual([x.ok, x.reused], [true, false], `read ${k}`); cur = x.readOpId; }
    else assert.deepEqual(x, { ok: false, error: "RECOVERY_READS_EXHAUSTED" });
  }
  const keys = (await db.app.query("SELECT idempotency_key FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 ORDER BY idempotency_key", [r.id, PIREAD])).rows
    .map((x) => x.idempotency_key.replace(op.id, "<op>"));
  assert.deepEqual(keys, Array.from({ length: MAX_RECOVERY_READS }, (_, i) => `rr:<op>:${PIREAD}:${r.piId}:${i + 1}`));
  assert.deepEqual(await requestRecoveryRead(db.app, "00000000-0000-4000-8000-000000000000", read, { now: F.at(30) }), { ok: false, error: "NOT_FOUND" });
});

test("plain concurrency (no pause): two simultaneous calls insert one row and one of them reuses it", async () => {
  const { r, op } = await capturedOp(3);
  const read = { opType: PIREAD, ref: r.piId };
  const [a, b] = await Promise.all([requestRecoveryRead(db.app, op.id, read, { now: F.at(10) }), requestRecoveryRead(db.app, op.id, read, { now: F.at(10) })]);
  assert.equal((await pendingReads(r.id)).length, 1);
  assert.deepEqual([a.reused, b.reused].sort(), [false, true], "exactly one inserted; the other reused it");
  assert.equal(a.readOpId, b.readOpId);
});
