// C118 / N1 — migration 0027 (DRAFT, LOCAL ONLY): owner-attested MANUAL external cancellation of a CONFIRMED booking.
// Throwaway local PostgreSQL only; synthetic fixtures only; no network, no provider, no credentials.
//   REAL      = reached through the accepted repo / operations / admin API (no direct state writes).
//   SIMULATED = a statement issued by the schema owner to exercise a trigger on a path the runnable code would reach through a
//               larger worker chain (labelled at the call). It never bypasses triggers.
// Invariant ids I1–I8 refer to the header of db/migrations/0027_external_cancellation_disposition.up.sql.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startMigratedDatabase, startPostgres } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { beginPayStep, claimReleaseBlockers, releaseCompletedStayClaims, loadIntent, purgeGuestData } from "../../lib/booking-db/repo.js";
import { requestRead, claimNextOperation } from "../../lib/booking-db/operations.js";
import { migrateUp, migrateDown, loadMigrations } from "../../db/lib/migrate.js";
import { adminRecordEvidence } from "../../db/lib/admin.js";
import { intentStatus } from "../../lib/checkout/intent-api-core.js";

let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline C118 suite)"); };

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { globalThis.fetch = realFetch; await db.close(); assert.equal(netAttempts, 0, "no network"); });

const L = (n) => 880000 + n;                          // one synthetic listing per scenario
const FN = "booking.admin_record_external_cancellation($1,$2,$3::uuid[],$4,$5,$6,$7,$8,$9,$10,$11)";
let keyN = 0;
const key = () => `c118-test-key-${++keyN}`;
const activeClaim = async (id) => (await db.owner.query("SELECT * FROM booking.inventory_claims WHERE intent_id = $1 AND released_at IS NULL", [id])).rows[0];
const version = async (id) => (await db.owner.query("SELECT version FROM booking.intents WHERE id = $1", [id])).rows[0].version;
const n = async (sql, p = []) => F.count(db.owner, sql, p);
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };

/** REAL owner-attested dashboard observation (admin login), observed now: after every earlier read of the reservation. */
async function ownerSaw(c, status, observed = {}, at = Date.now()) {
  return F.ok(await adminRecordEvidence(db.reconciler, { intentId: c.id, kind: "hostaway_reservation", externalRef: String(c.reservationId), status, observed,
    observedAt: at, attestedBy: "owner", reference: `hostaway-dashboard-${status}` }), "owner evidence").id;
}
/** A confirmed booking whose Hostaway reservation was then cancelled BY A PERSON in Hostaway; the owner records what they saw. */
async function manuallyCancelled(stay) {
  const c = await F.confirmed(db.app, stay);
  const evidenceId = await ownerSaw(c, "cancelled");
  return { ...c, evidenceId };
}
const args = (c, o = {}) => [c.id, o.version, o.evidence ?? [c.evidenceId], o.cancellationEvidence ?? c.evidenceId,
  o.refundStatus ?? "pending", o.refundedMinor ?? null, o.refundReference ?? null, o.attestedBy ?? "owner", o.reference ?? "hostaway-dash-check-1",
  o.justification ?? "OWNER_CANCELLED_IN_HOSTAWAY", o.key ?? key()];
async function record(c, o = {}, pool = db.reconciler) {
  const v = o.version ?? (await version(c.id));
  return (await pool.query(`SELECT ${FN} AS r`, args(c, { ...o, version: v }))).rows[0].r;
}
/** A second guest's checkout on the same nights, up to the Pay step (which takes the claim). */
async function secondGuestPay(stay) {
  const id = await F.withDetails(db.app, stay);
  return { id, r: await beginPayStep(db.app, id, { now: F.at(2) }) };
}
/** Everything the record must leave untouched (I3 / I4). */
async function history(id) {
  const q = async (sql) => (await db.owner.query(sql, [id])).rows;
  return {
    intent: await q(`SELECT state, version, captured_minor, final_total_minor, currency, offline_charge_id, hostaway_reservation_id, stripe_payment_intent_id,
                       updated_at FROM booking.intents WHERE id = $1`),
    ledger: await q("SELECT * FROM booking.payment_ledger WHERE intent_id = $1 ORDER BY 1"),
    refunds: await q("SELECT * FROM booking.payment_refunds WHERE intent_id = $1 ORDER BY 1"),
    ops: await q("SELECT id, op_type, state, attempts, dispatched_at, completed_at, result_ref, settled_evidence_id, updated_at FROM booking.external_operations WHERE intent_id = $1 ORDER BY id"),
    transitions: await q("SELECT * FROM booking.intent_transitions WHERE intent_id = $1 ORDER BY 1"),
    renders: await q("SELECT r.* FROM booking.notification_renders r JOIN booking.external_operations o ON o.id = r.operation_id WHERE o.intent_id = $1"),
    evidence: await q("SELECT * FROM booking.provider_evidence WHERE intent_id = $1 ORDER BY id")
  };
}

// ---------------------------------------------------------------------------------------------
test("REPRODUCTION (pre-fix behaviour, unchanged without a record): a manual Hostaway cancel leaves our claim blocking resale", async () => {
  const stay = { listingId: L(1) };
  const c = await manuallyCancelled(stay);
  assert.equal(await F.state(db.app, c.id), "confirmed");
  assert.ok(await activeClaim(c.id), "claim still held");
  assert.deepEqual(await claimReleaseBlockers(db.app, c.id), ["STAY_NOT_COMPLETED"]);
  assert.equal(await releaseCompletedStayClaims(db.app), 0, "the after-stay release does not apply to a future stay");
  const g = await secondGuestPay(stay);
  assert.deepEqual(g.r, { ok: false, error: "DATES_CLAIMED" }, "the same nights stay unsellable on our own checkout");
});

test("I3/I4/I6: the record releases the claim atomically and changes nothing else; the nights become sellable again", async () => {
  const stay = { listingId: L(2) };
  const c = await manuallyCancelled(stay);
  const before = await history(c.id);
  const claim = await activeClaim(c.id);
  const r = await record(c);
  assert.equal(r.replayed, false);
  assert.equal(Number(r.releasedClaimId), Number(claim.id));
  const rel = (await db.owner.query("SELECT released_at, release_reason FROM booking.inventory_claims WHERE id = $1", [claim.id])).rows[0];
  assert.ok(rel.released_at); assert.equal(rel.release_reason, "EXTERNAL_CANCELLATION_ATTESTED");
  assert.deepEqual(await history(c.id), before, "intent row, ledger, refunds, operations, transitions, renders and evidence untouched");
  assert.equal((await loadIntent(db.app, c.id)).status, "confirmed", "state stays confirmed: cancellation is a separate linked fact");
  const x = (await db.owner.query("SELECT * FROM booking.external_cancellations WHERE id = $1", [r.cancellationId])).rows[0];
  assert.equal(x.intent_state, "confirmed"); assert.equal(Number(x.captured_minor), 576000); assert.equal(x.resolver_session_user, "test_admin");
  const f = (await db.owner.query("SELECT * FROM booking.external_refund_attestations WHERE cancellation_id = $1", [r.cancellationId])).rows;
  assert.equal(f.length, 1); assert.equal(f[0].refund_status, "pending"); assert.equal(f[0].refunded_minor, null);
  const g = await secondGuestPay(stay);
  assert.equal(g.r.ok, true, "a new guest can now take the same nights");
});

test("I3: refund disposition is separate, stated, bounded by the captured amount and append-only; money columns never move", async () => {
  const c = await manuallyCancelled({ listingId: L(3) });
  for (const [s, m, code] of [["none", 5, "REFUND_AMOUNT_INVALID"], ["partial", 576000, "REFUND_AMOUNT_INVALID"], ["partial", 0, "REFUND_AMOUNT_INVALID"],
                              ["full", 1, "REFUND_AMOUNT_INVALID"], ["pending", 10, "REFUND_AMOUNT_INVALID"], ["refunded", 1, "REFUND_STATUS_INVALID"]]) {
    const e = await errOf(record(c, { refundStatus: s, refundedMinor: m }));
    assert.match(e?.message ?? "", new RegExp(code), `${s}/${m}`);
  }
  assert.ok(await activeClaim(c.id), "a refused call writes nothing and releases nothing");
  const r = await record(c, { refundStatus: "none", refundedMinor: 0 });
  const att = (o) => db.reconciler.query("SELECT booking.admin_attest_external_refund($1,$2,$3,$4,$5,$6,$7) AS r",
    [r.cancellationId, o.s, o.m ?? null, o.p ?? null, "owner", "stripe-dash-check-2", o.k ?? key()]).then((x) => x.rows[0].r);
  const a2 = await att({ s: "partial", m: 200000, p: "re_synthetic_partial_1" });
  assert.equal(a2.seq, 2);
  assert.match((await errOf(att({ s: "partial", m: 100000 })))?.message ?? "", /REFUND_DECREASE/);
  assert.match((await errOf(att({ s: "pending" })))?.message ?? "", /REFUND_DECREASE/);
  const k = key();
  const a3 = await att({ s: "full", m: 576000, p: "re_synthetic_full_1", k });
  assert.equal(a3.seq, 3);
  assert.deepEqual(await att({ s: "full", m: 576000, p: "re_synthetic_full_1", k }), { replayed: true, refundAttestationId: a3.refundAttestationId, seq: 3 });
  assert.match((await errOf(att({ s: "full", m: 576000, p: "other", k })))?.message ?? "", /REQUEST_KEY_CONFLICT/);
  assert.match((await errOf(att({ s: "full", m: 576000 })))?.message ?? "", /REFUND_ALREADY_FULL/);
  const i = (await db.owner.query("SELECT captured_minor FROM booking.intents WHERE id = $1", [c.id])).rows[0];
  assert.equal(Number(i.captured_minor), 576000, "captured total never reduced");
  assert.equal(await n("SELECT count(*) AS n FROM booking.payment_refunds WHERE intent_id = $1", [c.id]), 0, "no refund operation / record");
  assert.equal(await n("SELECT count(*) AS n FROM booking.payment_ledger WHERE intent_id = $1 AND entry LIKE 'refund%'", [c.id]), 0, "no ledger refund");
  assert.equal(await n("SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type LIKE '%refund%'", [c.id]), 0);
});

test("I1/I2: admin-only execution; no direct writes; append-only; runtime role cannot even read", async () => {
  const c = await manuallyCancelled({ listingId: L(4) });
  const v = await version(c.id);
  for (const [pool, label] of [[db.app, "runtime"], [new pg.Pool({ connectionString: db.reportUrl(), max: 1 }), "report"]]) {
    const e = await errOf(pool.query(`SELECT ${FN}`, args(c, { version: v })));
    assert.equal(e?.code, "42501", `${label} has no EXECUTE`);
    if (label === "report") await pool.end();
  }
  assert.equal((await errOf(db.app.query("SELECT * FROM booking.external_cancellations")))?.code, "42501", "runtime has no SELECT");
  const r = await record(c);
  const ins = await errOf(db.owner.query(`INSERT INTO booking.external_cancellations (id, intent_id, request_key, hostaway_reservation_id, cancellation_evidence_id,
     evidence_ids, expected_version, intent_state, captured_minor, currency, notify_dispositions, attested_by, reference, justification_code, resolver_session_user)
     VALUES (gen_random_uuid(), $1, 'direct-insert-1', 'x', $2, ARRAY[$2]::uuid[], 0, 'confirmed', 0, 'MXN', '[]', 'owner', 'x', 'X', 'x')`, [c.id, c.evidenceId]));
  assert.match(ins?.message ?? "", /EXTERNAL_DISPOSITION_AUTHORITY|duplicate/, "even the schema owner cannot insert outside the function");
  for (const sql of ["UPDATE booking.external_cancellations SET reference = 'changed' WHERE id = $1", "DELETE FROM booking.external_cancellations WHERE id = $1"]) {
    assert.match((await errOf(db.owner.query(sql, [r.cancellationId])))?.message ?? "", /append-only/);
  }
  assert.match((await errOf(db.owner.query("UPDATE booking.external_refund_attestations SET reference = 'changed' WHERE id = $1", [r.refundAttestationId])))?.message ?? "", /append-only/);
  assert.match((await errOf(db.owner.query("TRUNCATE booking.external_refund_attestations, booking.external_cancellations")))?.message ?? "", /append-only/);
  const acl = (await db.owner.query(`SELECT p.proname, array_agg(DISTINCT r.rolname::text ORDER BY r.rolname::text) AS who FROM pg_proc p
      JOIN pg_namespace s ON s.oid = p.pronamespace AND s.nspname = 'booking'
      CROSS JOIN pg_roles r WHERE p.proname IN ('admin_record_external_cancellation', 'admin_attest_external_refund')
        AND r.rolname IN ('mv_booking_app', 'mv_booking_admin', 'mv_booking_report', 'public') AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
      GROUP BY p.proname ORDER BY 1`)).rows;
  assert.deepEqual(acl, [{ proname: "admin_attest_external_refund", who: ["mv_booking_admin"] }, { proname: "admin_record_external_cancellation", who: ["mv_booking_admin"] }]);
  const pub = (await db.owner.query(`SELECT bool_or(has_function_privilege('public', p.oid, 'EXECUTE')) AS any FROM pg_proc p
      JOIN pg_namespace s ON s.oid = p.pronamespace AND s.nspname = 'booking'
      WHERE p.proname IN ('admin_record_external_cancellation', 'admin_attest_external_refund', 'externally_cancelled', 'external_refund_check')`)).rows[0].any;
  assert.equal(pub, false, "PUBLIC executes none of the 0027 functions");
});

test("I8: replay returns the original record; a reused key with different arguments and a second record are refused", async () => {
  const c = await manuallyCancelled({ listingId: L(5) });
  const k = key();
  const r1 = await record(c, { key: k });
  const r2 = await record(c, { key: k, version: r1 && (await version(c.id)) });
  assert.deepEqual(r2, { ...r1, replayed: true });
  assert.match((await errOf(record(c, { key: k, reference: "different-ref" })))?.message ?? "", /REQUEST_KEY_CONFLICT/);
  assert.match((await errOf(record(c, { key: k, refundStatus: "none", refundedMinor: 0 })))?.message ?? "", /REQUEST_KEY_CONFLICT/);
  assert.match((await errOf(record(c)))?.message ?? "", /ALREADY_RECORDED/);
  assert.equal(await n("SELECT count(*) AS n FROM booking.external_cancellations WHERE intent_id = $1", [c.id]), 1);
  assert.equal(await n("SELECT count(*) AS n FROM booking.external_refund_attestations WHERE intent_id = $1", [c.id]), 1);
});

test("I5: stale version, wrong state and bad / contradicted evidence are refused with nothing written", async () => {
  const c = await manuallyCancelled({ listingId: L(6) });
  const v = await version(c.id);
  const cases = [
    [{ version: v - 1 }, /STALE_VERSION/],
    [{ version: v + 1 }, /STALE_VERSION/],
    [{ evidence: [c.proofEvidenceId], cancellationEvidence: c.evidenceId }, /CANCELLATION_EVIDENCE_REQUIRED/],
    [{ evidence: [c.proofEvidenceId], cancellationEvidence: c.proofEvidenceId }, /CANCELLATION_EVIDENCE_MISMATCH/],
    [{ attestedBy: "Owner Name" }, /check constraint|violates/]
  ];
  for (const [o, re] of cases) assert.match((await errOf(record(c, o)))?.message ?? "", re, JSON.stringify(o));
  // evidence of another intent
  const other = await manuallyCancelled({ listingId: L(7) });
  assert.match((await errOf(record(c, { evidence: [c.evidenceId, other.evidenceId] })))?.message ?? "", /EVIDENCE_NOT_FOR_THIS_INTENT/);
  // a later owner observation says the reservation is active again: the cancellation evidence is superseded (contradiction)
  await ownerSaw(c, "found_active", { listingId: L(6), from: "2026-12-20", to: "2026-12-24", totalMinor: 576000 }, Date.now() + 1000);
  assert.match((await errOf(record(c)))?.message ?? "", /EVIDENCE_SUPERSEDED/);
  // cancellation evidence older than the reservation itself
  const d = await F.confirmed(db.app, { listingId: L(8) });
  const early = await F.dashboardEvidence(db.reconciler, d.id, "hostaway_reservation", d.reservationId, "cancelled", {}, 1);
  assert.match((await errOf(record({ ...d, evidenceId: early })))?.message ?? "", /EVIDENCE_PREDATES_RESERVATION/);
  // not confirmed
  const p = await F.reserved(db.app, { listingId: L(9) });
  const pe = await ownerSaw(p, "cancelled");
  assert.match((await errOf(record({ ...p, evidenceId: pe })))?.message ?? "", /NOT_CONFIRMED: reservation_confirmed/);
  for (const id of [c.id, d.id, p.id]) {
    assert.equal(await n("SELECT count(*) AS n FROM booking.external_cancellations WHERE intent_id = $1", [id]), 0);
    assert.ok(await activeClaim(id), "claim still held");
  }
});

test("I5: active leases, unsettled / pending operations and open cases are refused (prior worker and claim fences respected)", async () => {
  // work lease
  const a = await manuallyCancelled({ listingId: L(10) });
  await db.owner.query("UPDATE booking.intent_work SET work_worker_id = 'w-other', work_lease_until = now() + interval '5 minutes' WHERE intent_id = $1", [a.id]); // SIMULATED: a worker holds the intent
  assert.match((await errOf(record(a)))?.message ?? "", /WORK_LEASE_PRESENT/);
  // a never-attempted provider READ does not block; once a worker leases it, it does
  const b = await manuallyCancelled({ listingId: L(11) });
  const readId = await requestRead(db.app, b.id, "hostaway.retrieve_reservation", String(b.reservationId), { now: Date.now() });
  assert.ok(await claimNextOperation(db.app, { workerId: "w-read", now: Date.now(), opId: readId }), "read leased");
  assert.match((await errOf(record(b)))?.message ?? "", /OPERATION_LEASED: hostaway.retrieve_reservation/);
  // a pending provider-side operation that is not a read (SIMULATED owner-queued owner alert row: our own unsent work)
  const b2 = await manuallyCancelled({ listingId: L(19) });
  await db.owner.query(`INSERT INTO booking.external_operations (id, intent_id, op_type, idempotency_key, retry_class, state, payload, source_version,
     max_attempts, next_attempt_at, created_at, updated_at) VALUES (gen_random_uuid(), $1, 'alert.owner', $2, 'idempotent', 'pending', '{}', $3, 3, now(), now(), now())`,
    [b2.id, `alert:${b2.id}:c118`, await version(b2.id)]);
  assert.match((await errOf(record(b2)))?.message ?? "", /OPERATION_PENDING: alert.owner/);
  // open reconciliation case
  const c = await manuallyCancelled({ listingId: L(12) });
  await db.owner.query(`INSERT INTO booking.reconciliation_cases (id, intent_id, kind, status, opened_at, opened_by)
     VALUES (gen_random_uuid(), $1, 'MANUAL_REVIEW', 'open', now(), 'owner-test')`, [c.id]);   // SIMULATED owner-opened case
  assert.match((await errOf(record(c)))?.message ?? "", /OPEN_CASE/);
  for (const x of [a, b, b2, c]) assert.ok(await activeClaim(x.id));
});

test("I7: after the record — the queued confirmation is fenced, no new notify / provider-write / claim / TEST cleanup; reads still allowed", async () => {
  const c = await manuallyCancelled({ listingId: L(13) });
  const notify = (await db.owner.query("SELECT * FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'guest.notify'", [c.id])).rows;
  const r = await record(c);
  assert.deepEqual(r.notify.map((x) => x.disposition), notify.map((o) => (o.state === "pending" ? "latched_unsent" : o.state === "succeeded" ? "sent_preserved" : "terminal_preserved")));
  for (const o of notify.filter((x) => x.state === "pending")) {
    const l = (await db.owner.query("SELECT code FROM booking.notification_latches WHERE operation_id = $1", [o.id])).rows[0];
    assert.equal(l?.code, "EXTERNALLY_CANCELLED", "the queued confirmation is latched in the same transaction");
  }
  // SIMULATED claim step (the worker's claim function performs exactly this UPDATE): our fence fires first
  for (const o of notify.filter((x) => x.state === "pending")) {
    const e = await errOf(db.owner.query("UPDATE booking.external_operations SET state = 'in_flight', attempts = 1, dispatched_at = now(), lease_worker_id = 'w-n', lease_until = now() + interval '1 minute' WHERE id = $1", [o.id]));
    assert.match(e?.message ?? "", /EXTERNALLY_CANCELLED: the queued notification/);
  }
  // control: the same statement on a booking WITHOUT a record is refused by the existing notification fence instead (not ours)
  const ctl = await F.confirmed(db.app, { listingId: L(14) });
  const ctlOp = (await db.owner.query("SELECT id FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'guest.notify' AND state = 'pending'", [ctl.id])).rows[0];
  if (ctlOp) {
    const e = await errOf(db.owner.query("UPDATE booking.external_operations SET state = 'in_flight', attempts = 1, dispatched_at = now(), lease_worker_id = 'w-n', lease_until = now() + interval '1 minute' WHERE id = $1", [ctlOp.id]));
    assert.match(e?.message ?? "", /NOTIFY_CLAIM/); assert.doesNotMatch(e.message, /EXTERNALLY_CANCELLED/);
  }
  // no new operation of any write / notify kind
  for (const op of ["guest.notify", "stripe.capture_payment_intent", "hostaway.cancel_reservation", "stripe.refund_payment_intent"]) {
    const e = await errOf(db.owner.query(`INSERT INTO booking.external_operations (id, intent_id, op_type, idempotency_key, retry_class, state, payload, source_version, max_attempts, next_attempt_at, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, $3, 'idempotent', 'pending', '{}', 0, 1, now(), now(), now())`, [c.id, op, `x:${op}:${c.id}`]));
    assert.match(e?.message ?? "", /EXTERNALLY_CANCELLED|check constraint/, op);
  }
  // reads still allowed (reconciliation may look at the provider)
  assert.ok(await requestRead(db.app, c.id, "hostaway.retrieve_reservation", String(c.reservationId), { now: Date.now() }));
  // no new claim, by any path (SIMULATED privileged insert, as admin_acquire_claim would do)
  const e1 = await errOf(db.owner.query("INSERT INTO booking.inventory_claims (intent_id, listing_id, stay, kind, claimed_at, review_after) SELECT id, listing_id, stay, 'reserved', now(), now() + interval '1 day' FROM booking.intents WHERE id = $1", [c.id]));
  assert.match(e1?.message ?? "", /EXTERNALLY_CANCELLED: no new claim/);
  // no TEST cleanup entry (SIMULATED transition statement; the recorded-cleanup request performs this state move)
  const e2 = await errOf(db.owner.query("UPDATE booking.intents SET state = 'test_cleanup_pending' WHERE id = $1", [c.id]));
  assert.match(e2?.message ?? "", /EXTERNALLY_CANCELLED: TEST cleanup/);
});

test("concurrency: a new booking racing the record waits on the claim and wins only if the record commits", async () => {
  for (const outcome of ["COMMIT", "ROLLBACK"]) {
    const stay = { listingId: L(outcome === "COMMIT" ? 15 : 16) };
    const c = await manuallyCancelled(stay);
    const id2 = await F.withDetails(db.app, stay);
    const admin = await db.reconciler.connect();
    try {
      await admin.query("BEGIN");
      await admin.query(`SELECT ${FN} AS r`, args(c, { version: await version(c.id) }));
      let settled = false;
      const racer = beginPayStep(db.app, id2, { now: F.at(2) }).then((r) => { settled = true; return r; });
      await new Promise((res) => setTimeout(res, 400));
      assert.equal(settled, false, "the second guest's claim waits for the record's transaction");
      await admin.query(outcome);
      const r = await racer;
      if (outcome === "COMMIT") assert.equal(r.ok, true, "released → the new claim succeeds");
      else { assert.deepEqual(r, { ok: false, error: "DATES_CLAIMED" }); assert.ok(await activeClaim(c.id), "rolled back → original claim held"); }
    } finally { admin.release(); }
  }
});

test("after-stay release and retention: compatible in both orders; purge keeps working", async () => {
  const today = await F.dbToday(db.owner, "America/Mexico_City");
  // a stay that has already ended: release_completed_stays releases it first, then the record still documents the cancellation
  const past1 = await manuallyCancelled({ listingId: L(17), from: F.addDays(today, -6), to: F.addDays(today, -2) });
  assert.ok((await releaseCompletedStayClaims(db.app)) >= 1);
  const r1 = await record(past1);
  assert.equal(r1.releasedClaimId, null, "nothing left to release");
  // the record first, then the after-stay release finds nothing for it
  const past2 = await manuallyCancelled({ listingId: L(18), from: F.addDays(today, -6), to: F.addDays(today, -2) });
  const r2 = await record(past2);
  assert.ok(r2.releasedClaimId);
  assert.equal(await n("SELECT count(*) AS n FROM booking.inventory_claims WHERE intent_id = $1 AND released_at IS NULL", [past2.id]), 0);
  // retention: guest data of the confirmed, ended stay is purged as before; the disposition rows carry no guest data and stay
  const purged = await purgeGuestData(db.app, { retention: { failedAttemptDays: 1, postCheckoutDays: 1 } });
  assert.ok(purged >= 2);
  assert.equal(await n("SELECT count(*) AS n FROM booking.intent_guests WHERE intent_id = ANY($1::uuid[])", [[past1.id, past2.id]]), 0);
  assert.equal(await n("SELECT count(*) AS n FROM booking.external_cancellations WHERE intent_id = ANY($1::uuid[])", [[past1.id, past2.id]]), 2);
  const cols = (await db.owner.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'booking'
     AND table_name IN ('external_cancellations', 'external_refund_attestations') AND column_name ~ '(email|phone|name)'`)).rows;
  assert.deepEqual(cols, [], "no guest personal-data column");
});

test("migration: 0027 (C119 S4: only the literal-rebind 0028 follows); down refused once records exist; on a fresh cluster down restores 0021's claim_release_blockers exactly", async () => {
  const M = loadMigrations(); assert.equal(M.find((m) => m.version === 27).name, "external_cancellation_disposition"); assert.deepEqual(M.filter((m) => m.version > 27).map((m) => m.name), ["pipeline_kickoff_source_rebind_s4", "price_tax"]);   // P1: + 0029 (mechanical)
  const e = await errOf((async () => { const cl = new pg.Client({ connectionString: db.adminUrl }); await cl.connect();
    try { await migrateDown(cl, { to: 26, env: "test" }); } finally { await cl.end(); } })());
  assert.match(e?.message ?? "", /DOWN_REFUSED/);
  const fresh = await startPostgres();
  const cl = new pg.Client({ connectionString: fresh.adminUrl }); await cl.connect();
  try {
    await migrateUp(cl, { env: "test", to: 26 });
    const def26 = (await cl.query("SELECT pg_get_functiondef('booking.claim_release_blockers(uuid)'::regprocedure) AS d")).rows[0].d;
    await migrateUp(cl, { env: "test" });
    assert.notEqual((await cl.query("SELECT pg_get_functiondef('booking.claim_release_blockers(uuid)'::regprocedure) AS d")).rows[0].d, def26);
    await migrateDown(cl, { to: 26, env: "test" });
    assert.equal((await cl.query("SELECT pg_get_functiondef('booking.claim_release_blockers(uuid)'::regprocedure) AS d")).rows[0].d, def26);
    assert.equal((await cl.query("SELECT to_regclass('booking.external_cancellations') AS t")).rows[0].t, null);
    await migrateUp(cl, { env: "test" });
  } finally { await cl.end(); fresh.stop(); }
});

test("F1 (I9): the actual bearer status handler reports the cancellation honestly, refund as a separate label; no admin / evidence data; runtime role reads only the projection", async () => {
  const c = await manuallyCancelled({ listingId: L(20) });
  const view = async () => (await intentStatus({ pool: db.app }, c.id));
  const v0 = await view();
  assert.equal(v0.http, 200); assert.equal(v0.body.status, "confirmed"); assert.equal(v0.body.bookingProgress.stage, "complete");
  const r = await record(c, { reference: "hostaway-dash-check-secretish", attestedBy: "owner" });
  const v1 = await view();
  assert.deepEqual(Object.keys(v1.body).sort(), ["bookingProgress", "price", "quoteExpiresAt", "status"], "same reply shape as before");
  assert.equal(v1.body.status, "booking_cancelled");
  assert.deepEqual({ ...v1.body.bookingProgress }, { stage: "cancelled", bookingRef: (await loadIntent(db.app, c.id)).ref, refundStatus: "pending" });
  assert.ok(Object.isFrozen(v1.body.bookingProgress));
  assert.doesNotMatch(JSON.stringify(v1.body), /secretish|owner|OWNER_CANCELLED|attest|evidence|[0-9a-f]{8}-[0-9a-f]{4}-|refundedMinor/i, "no admin / evidence / id data");
  const att = (st, m, k) => db.reconciler.query("SELECT booking.admin_attest_external_refund($1,$2,$3,$4,$5,$6,$7) AS r", [r.cancellationId, st, m, null, "owner", "stripe-dash-1", k]);
  await att("partial", 100000, key());
  assert.equal((await view()).body.bookingProgress.refundStatus, "partial");
  await att("full", 576000, key());
  assert.equal((await view()).body.bookingProgress.refundStatus, "full");
  assert.equal((await loadIntent(db.app, c.id)).status, "confirmed", "the intent itself is unchanged; only the projection differs");
  // the runtime role: EXECUTE on the projection only; the projection returns exactly two keys
  const pj = (await db.app.query("SELECT booking.external_cancellation_public($1) AS x", [c.id])).rows[0].x;
  assert.deepEqual(Object.keys(pj).sort(), ["cancelled", "refundStatus"]);
  assert.equal((await db.app.query("SELECT booking.external_cancellation_public($1) AS x", [(await F.confirmed(db.app, { listingId: L(21) })).id])).rows[0].x, null);
  assert.equal((await errOf(db.app.query("SELECT * FROM booking.external_refund_attestations")))?.code, "42501");
});

test("F3: request-key bounds are consistent — 116 accepted (child key fits), 117 refused before any write; replay at the bound; a refused call burns no key; refund keys up to 120", async () => {
  const c = await manuallyCancelled({ listingId: L(22) });
  const k116 = "k".repeat(116), k117 = "k".repeat(117);
  assert.match((await errOf(record(c, { key: k117 })))?.message ?? "", /REQUEST_KEY_INVALID/);
  assert.match((await errOf(record(c, { key: k116, refundStatus: "full", refundedMinor: 1 })))?.message ?? "", /REFUND_AMOUNT_INVALID/, "rolled back mid-way");
  assert.equal(await n("SELECT count(*) AS n FROM booking.external_cancellations WHERE intent_id = $1", [c.id]), 0);
  assert.ok(await activeClaim(c.id), "nothing released by the refused calls");
  const r1 = await record(c, { key: k116 });
  assert.equal((await db.owner.query("SELECT request_key FROM booking.external_refund_attestations WHERE id = $1", [r1.refundAttestationId])).rows[0].request_key, `${k116}:r1`);
  assert.deepEqual(await record(c, { key: k116 }), { ...r1, replayed: true }, "replay at the bound");
  const att = (k) => db.reconciler.query("SELECT booking.admin_attest_external_refund($1,'none',0,null,'owner','stripe-dash-2',$2) AS r", [r1.cancellationId, k]);
  assert.equal((await att("a".repeat(120))).rows[0].r.seq, 2);
  assert.match((await errOf(att("a".repeat(121))))?.message ?? "", /REQUEST_KEY_INVALID/);
  assert.match((await errOf(att("short")))?.message ?? "", /REQUEST_KEY_INVALID/);
});

test("I1 (corrected): direct DML is denied to app / report / admin by ACL even with a spoofed coordination setting; the schema owner is trusted (the setting is not a capability)", async () => {
  const c = await manuallyCancelled({ listingId: L(23) });
  const r = await record(c);
  const pools = [["runtime", db.app], ["report", new pg.Pool({ connectionString: db.reportUrl(), max: 1 })], ["admin", db.reconciler]];
  for (const [label, pool] of pools) {
    const cl = await pool.connect();
    try {
      for (const sql of [
        `INSERT INTO booking.external_cancellations (id, intent_id, request_key, hostaway_reservation_id, cancellation_evidence_id, evidence_ids, expected_version,
           intent_state, captured_minor, currency, notify_dispositions, attested_by, reference, justification_code, resolver_session_user)
         VALUES (gen_random_uuid(), '${c.id}', 'spoofed-key-1', 'x', '${c.evidenceId}', ARRAY['${c.evidenceId}']::uuid[], 0, 'confirmed', 0, 'MXN', '[]', 'owner', 'x', 'X', 'x')`,
        `INSERT INTO booking.external_refund_attestations (id, cancellation_id, intent_id, seq, request_key, refund_status, refunded_minor, currency, attested_by, reference, resolver_session_user)
         VALUES (gen_random_uuid(), '${r.cancellationId}', '${c.id}', 9, 'spoofed-key-2', 'full', 576000, 'MXN', 'owner', 'x', 'x')`,
        `UPDATE booking.external_cancellations SET reference = 'x' WHERE id = '${r.cancellationId}'`,
        `DELETE FROM booking.external_refund_attestations WHERE cancellation_id = '${r.cancellationId}'`,
        `UPDATE booking.inventory_claims SET released_at = now(), release_reason = 'SPOOFED' WHERE intent_id = '${c.id}'`]) {
        await cl.query("BEGIN");
        await cl.query("SELECT set_config('booking.external_disposition_txn', pg_current_xact_id()::text, true)");   // spoofed coordination setting
        const e = await errOf(cl.query(sql));
        await cl.query("ROLLBACK");
        assert.equal(e?.code, "42501", `${label}: ${sql.slice(0, 40)} → permission denied (${e?.message})`);
      }
    } finally { cl.release(); if (label === "report") await pool.end(); }
  }
  // TRUSTED schema owner: with the setting it CAN insert — documented, not claimed as prevented (rolled back here)
  const o = await db.owner.connect();
  try {
    await o.query("BEGIN");
    await o.query("SELECT set_config('booking.external_disposition_txn', pg_current_xact_id()::text, true)");
    const ok = await errOf(o.query(`INSERT INTO booking.external_refund_attestations (id, cancellation_id, intent_id, seq, request_key, refund_status, refunded_minor, currency, attested_by, reference, resolver_session_user)
         VALUES (gen_random_uuid(), $1, $2, 9, 'owner-trusted-1', 'none', 0, 'MXN', 'owner', 'x', 'x')`, [r.cancellationId, c.id]));
    assert.equal(ok, null, "the schema owner is trusted: the coordination setting is not a capability boundary");
  } finally { await o.query("ROLLBACK"); o.release(); }
  assert.equal(await n("SELECT count(*) AS n FROM booking.external_refund_attestations WHERE cancellation_id = $1", [r.cancellationId]), 1);
});

// ---------------------------------------------------------------------------------------------
// F1b (ROOT review 6963601053): three explicit projection outcomes through the ACTUAL intentStatus handler.
// SIMULATED where labelled: a pool wrapper answers ONLY the projection query (every other query, incl. loadIntent, is the real runtime pool).
function projectionPool(base, answer) {
  return { query: (sql, params) => (/external_cancellation_public|to_regprocedure/.test(sql) ? answer(sql, params) : base.query(sql, params)) };
}
const UNDER_REVIEW = (b) => {
  assert.equal(b.status, "under_review");
  assert.deepEqual({ ...b.bookingProgress }, { stage: "needs_review", bookingRef: null });
  assert.doesNotMatch(JSON.stringify(b), /MV-|refund|cancelled|complete/i, "no booking ref, no refund / cancellation / success claim");
};
const err = (code, message = "x") => Object.assign(new Error(message), { code });

test("F1b: valid null = no record (complete stays); valid object = cancelled; every malformed / missing / failed projection = under_review with no ref or refund claim", async () => {
  const c = await F.confirmed(db.app, { listingId: L(24) });
  const status = async (pool) => (await intentStatus({ pool }, c.id)).body;
  // 1. valid single-row SQL null (REAL): no record → the normal complete projection
  const real = await status(db.app);
  assert.deepEqual([real.status, real.bookingProgress.stage], ["confirmed", "complete"]);
  // 2. valid cancellation object (SIMULATED answer of the exact shape the SQL returns)
  for (const label of ["pending", "none", "partial", "full"]) {
    const b = await status(projectionPool(db.app, async () => ({ rows: [{ x: { cancelled: true, refundStatus: label } }] })));
    assert.deepEqual([b.status, b.bookingProgress.stage, b.bookingProgress.refundStatus], ["booking_cancelled", "cancelled", label]);
  }
  // 3. malformed / missing (SIMULATED answers)
  const bad = [
    ["no rows", { rows: [] }], ["two rows", { rows: [{ x: null }, { x: null }] }], ["missing alias", { rows: [{ y: null }] }], ["no rows field", {}],
    ["row not object", { rows: [null] }], ["string json", { rows: [{ x: "{\"cancelled\":true}" }] }], ["number", { rows: [{ x: 1 }] }], ["array", { rows: [{ x: [] }] }],
    ["boolean value", { rows: [{ x: true }] }], ["empty object", { rows: [{ x: {} }] }],
    ["cancelled false", { rows: [{ x: { cancelled: false, refundStatus: "none" } }] }], ["cancelled 'true'", { rows: [{ x: { cancelled: "true", refundStatus: "none" } }] }],
    ["cancelled 1", { rows: [{ x: { cancelled: 1, refundStatus: "none" } }] }], ["label unknown", { rows: [{ x: { cancelled: true, refundStatus: "refunded" } }] }],
    ["label null", { rows: [{ x: { cancelled: true, refundStatus: null } }] }], ["label missing", { rows: [{ x: { cancelled: true } }] }],
    ["extra key", { rows: [{ x: { cancelled: true, refundStatus: "none", amountMinor: 1 } }] }]];
  for (const [label, ans] of bad) UNDER_REVIEW(await status(projectionPool(db.app, async () => ans)), label);
  // 4. query errors (SIMULATED): permission, connection, timeout, unexpected
  for (const e of [err("42501", "permission denied"), err("ECONNRESET"), err("57P01", "terminating connection"), err("57014", "canceling statement"), new Error("boom")]) {
    UNDER_REVIEW(await status(projectionPool(db.app, async () => { throw e; })));
  }
  // 5. 42883 is pre-0027 ONLY with verified absence (SIMULATED both reads); unverifiable / present → under_review
  const pre = projectionPool(db.app, async (sql) => { if (/to_regprocedure/.test(sql)) return { rows: [{ absent: true }] }; throw err("42883"); });
  assert.deepEqual([(await status(pre)).status, (await status(pre)).bookingProgress.stage], ["confirmed", "complete"]);
  for (const second of [async () => ({ rows: [{ absent: false }] }), async () => ({ rows: [] }), async () => ({ rows: [{ absent: "true" }] }), async () => { throw err("ECONNRESET"); }]) {
    UNDER_REVIEW(await status(projectionPool(db.app, async (sql) => { if (/to_regprocedure/.test(sql)) return second(); throw err("42883"); })));
  }
});

test("F1b REAL clusters: genuinely pre-0027 schema → unchanged confirmed / complete; existing projection raising an INTERNAL undefined function → under_review; revoked EXECUTE → under_review", async () => {
  // a disposable cluster at schema 26 with the same login roles as the harness (no 0027 objects at all)
  const mk = async (to) => {
    const p = await startPostgres(); const a = new pg.Client({ connectionString: p.adminUrl }); await a.connect();
    try {
      await migrateUp(a, { env: "test", ...(to ? { to } : {}) });
      await a.query("CREATE ROLE test_app LOGIN IN ROLE mv_booking_app");
    } finally { await a.end(); }
    return { p, app: new pg.Pool({ connectionString: p.appUrl(), max: 4 }), owner: new pg.Pool({ connectionString: p.adminUrl, max: 2 }) };
  };
  const c26 = await mk(26);
  try {
    assert.equal((await c26.owner.query("SELECT to_regprocedure('booking.external_cancellation_public(uuid)') AS f")).rows[0].f, null, "0027 genuinely absent");
    const k = await F.confirmed(c26.app, { listingId: L(25) });
    const b = (await intentStatus({ pool: c26.app }, k.id)).body;
    assert.deepEqual([b.status, b.bookingProgress.stage], ["confirmed", "complete"], "pre-0027 behaviour unchanged");
  } finally { await c26.app.end(); await c26.owner.end(); c26.p.stop(); }
  const c27 = await mk(null);
  try {
    const k = await F.confirmed(c27.app, { listingId: L(26) });
    const s = async () => (await intentStatus({ pool: c27.app }, k.id)).body;
    assert.equal((await s()).bookingProgress.stage, "complete", "baseline on this cluster");
    // TEST-ONLY owner change on this throwaway cluster: the projection exists but calls an undefined function internally
    await c27.owner.query("SET check_function_bodies = off");
    const o = await c27.owner.connect();
    try {
      await o.query("SET check_function_bodies = off");
      await o.query(`CREATE OR REPLACE FUNCTION booking.external_cancellation_public(p_intent uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
                     SET search_path = pg_catalog, booking AS $$ SELECT booking.c118_no_such_function(p_intent) $$`);
    } finally { o.release(); }
    const e = await errOf(c27.app.query("SELECT booking.external_cancellation_public(gen_random_uuid())"));
    assert.equal(e?.code, "42883", "the internal call really raises undefined_function");
    UNDER_REVIEW(await s());
    // and a REAL permission failure: EXECUTE revoked from the runtime role on this throwaway cluster
    await c27.owner.query("REVOKE EXECUTE ON FUNCTION booking.external_cancellation_public(uuid) FROM mv_booking_app");
    assert.equal((await errOf(c27.app.query("SELECT booking.external_cancellation_public(gen_random_uuid())")))?.code, "42501");
    UNDER_REVIEW(await s());
  } finally { await c27.app.end(); await c27.owner.end(); c27.p.stop(); }
});
