// Stage E2B — E3-compatible persistence: round trip, version semantics, audit, DB-enforced invariants, privileges.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent, loadIntentRow, beginPayStep } from "../../db/lib/repo.js";
import { rowToIntent, intentToRow } from "../../db/lib/codec.js";
import { STATES } from "../../lib/checkout/intent-state.js";
import { completeOperation } from "../../db/lib/operations.js";
import { applyResolution } from "../../db/lib/repo.js";
import { adminResolveIntent } from "../../db/lib/admin.js";

let db, report;
before(async () => { db = await startMigratedDatabase(); report = new pg.Pool({ connectionString: db.reportUrl(), max: 2 }); });
after(async () => { await report.end(); await db.close(); });

const strip = (i) => { const { history, seenEventIds, ...rest } = i; return JSON.parse(JSON.stringify(rest)); };
const reached = new Set();
/** apply + assert: the persisted row decodes to exactly the intent E3 returned, and one audit row per version */
async function step(id, event, minutes, opts = {}) {
  const r = await applyEvent(db.app, id, event, { now: F.at(minutes), ...opts });
  F.ok(r, `${event.type}`);
  if (!r.duplicate) {
    const fromDb = await loadIntent(db.app, id);
    assert.deepEqual(strip(fromDb), strip(r.intent), `round trip after ${event.type}`);
    reached.add(r.intent.status);
  }
  const v = r.intent.version;
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.intent_transitions WHERE intent_id = $1", [id]), v + 1);
  return r;
}

test("every E3 state is reachable through persisted transitions, with exact round trips", async () => {
  // happy path
  const h = await F.confirmed(db.app);
  reached.add("created").add("price_confirmed").add("details_collected").add("payment_pending").add("payment_authorized")
    .add("reservation_pending").add("reservation_confirmed").add("payment_captured").add("confirmed");
  assert.equal(await F.state(db.app, h.id), "confirmed");

  // validation_failed / expired
  let id = await F.newIntent(db.app, { from: "2027-01-01", to: "2027-01-03" });
  await step(id, { type: "VALIDATION_FAILED", code: "NOT_BOOKABLE" }, 0);
  id = await F.priced(db.app, { from: "2027-01-05", to: "2027-01-08" });
  await step(id, { type: "EXPIRE" }, 31);

  // payment_failed / payment_expired
  let p = await F.pending(db.app, { from: "2027-01-10", to: "2027-01-12" });
  await F.sessionExpired(db.app, p);   // E2B.1 (C3): only a verified expiry ends a payment attempt
  await step(p.id, { type: "PAYMENT_FAILED", code: "PAYMENT_INTENT_CANCELED" }, 34);
  p = await F.pending(db.app, { from: "2027-01-13", to: "2027-01-15" });
  await F.sessionExpired(db.app, p);
  await step(p.id, { type: "CHECKOUT_EXPIRED", id: "evt_exp_1" }, 33);

  // reservation_failed -> authorization_released
  let a = await F.authorized(db.app, { from: "2027-01-16", to: "2027-01-18" });
  await step(a.id, { type: "RESERVATION_STARTED", workerId: "w9", recheck: { bookable: false } }, 6);
  await F.runOp(db.app, a.id, "stripe.void_payment_intent", 7);           // E2B.1: void reported only after it succeeded
  await step(a.id, { type: "VOID_SUCCEEDED" }, 7);

  // reservation_unknown -> reconciled found; capture_unknown -> captured
  let d = await F.dispatched(db.app, { from: "2027-01-20", to: "2027-01-22" });
  await step(d.id, { type: "RESERVATION_OUTCOME_UNKNOWN", code: "TIMEOUT" }, 7);
  await step(d.id, { type: "RECONCILED_RESERVATION_FOUND", reservation: F.reservationFor({ from: "2027-01-20", to: "2027-01-22" }, 9101) }, 8);
  await step(d.id, { type: "CAPTURE_OUTCOME_UNKNOWN", code: "TIMEOUT" }, 9);
  await step(d.id, { type: "RECONCILED_CAPTURE_SUCCEEDED", amountMinor: 576000, currency: "MXN" }, 10);

  // capture_failed -> cancelled
  d = await F.dispatched(db.app, { from: "2027-01-24", to: "2027-01-26" });
  await step(d.id, { type: "RESERVATION_SUCCEEDED", reservation: F.reservationFor({ from: "2027-01-24", to: "2027-01-26" }, 9102) }, 7);
  await step(d.id, { type: "CAPTURE_FAILED", definite: true, code: "CARD_DECLINED" }, 8);
  await F.runOp(db.app, d.id, "hostaway.cancel_reservation", 9);           // E2B.1 (C5): verified cancellation
  await F.reservationStatus(db.app, d.id, "9102", "cancelled", {}, 9);
  await step(d.id, { type: "RESERVATION_CANCELLED" }, 9);                  // E3.2: leg 1 of 2 (still capture_failed)
  await F.runOp(db.app, d.id, "stripe.void_payment_intent", 10);           // E3.2: leg 2 — authorization voided
  await step(d.id, { type: "VOID_SUCCEEDED" }, 10);

  // reconciliation_required -> RESOLVE (evidence)
  a = await F.authorized(db.app, { from: "2027-01-28", to: "2027-01-30" });
  await step(a.id, { type: "ESCALATE", code: "MANUAL_REVIEW" }, 6);
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'", [a.id]), 1);
  // E2B.1 (C4): the owner decision is a persisted resolution citing provider evidence, not booleans
  await F.runOp(db.app, a.id, "alert.owner", 7);
  const ev = await F.piStatus(db.app, a.id, a.piId, "canceled", {}, 30);
  const res = F.ok(await adminResolveIntent(db.reconciler, { intentId: a.id, decision: "released", evidenceIds: [ev], resolver: "owner", justification: "VOIDED_IN_STRIPE", at: F.at(59) }));
  const rr = F.ok(await applyResolution(db.app, a.id, res.id, { now: F.at(60) }));
  assert.equal(rr.intent.status, "authorization_released");
  reached.add(rr.intent.status);
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'resolved'", [a.id]), 1);

  for (const s of Object.values(STATES)) assert.ok(reached.has(s), `state ${s} persisted`);
});

test("codec: row -> intent -> row is lossless for the persisted columns", async () => {
  const c = await F.captured(db.app, { from: "2027-02-01", to: "2027-02-04" });
  const row = await loadIntentRow(db.app, c.id);
  const again = intentToRow(rowToIntent(row));
  for (const [k, v] of Object.entries(again)) {
    if (["from_date", "to_date"].includes(k)) { assert.equal(v, row[`${k}_s`]); continue; }
    const dbv = row[k];
    const norm = (x) => (x instanceof Date ? x.getTime() : typeof x === "string" && /^\d+$/.test(x) ? Number(x) : x);
    assert.deepEqual(norm(v instanceof Date ? v : v), norm(dbv), k);
  }
});

test("version semantics: exactly +1 per update, enforced by the database", async () => {
  const id = await F.priced(db.app, { from: "2027-02-10", to: "2027-02-12" });
  const row = await loadIntentRow(db.app, id);
  await assert.rejects(db.app.query("UPDATE booking.intents SET version = version + 2, updated_at = now() WHERE id = $1", [id]), /exactly 1/);
  await assert.rejects(db.app.query("UPDATE booking.intents SET reason_code = 'X' WHERE id = $1", [id]), /exactly 1/);
  assert.equal((await loadIntentRow(db.app, id)).version, row.version);
});

test("database invariants: price immutable, identity immutable, terminal states closed, money exact", async () => {
  const c = await F.captured(db.app, { from: "2027-02-14", to: "2027-02-17" });
  const bump = "version = version + 1";
  await assert.rejects(db.app.query(`UPDATE booking.intents SET ${bump}, final_total_minor = 1, standard_total_minor = 65, discount_minor = 64 WHERE id = $1`, [c.id]));
  await assert.rejects(db.app.query(`UPDATE booking.intents SET ${bump}, to_date = '2027-02-20' WHERE id = $1`, [c.id]), /immutable/);
  await assert.rejects(db.app.query(`UPDATE booking.intents SET ${bump}, stripe_payment_intent_id = 'pi_other' WHERE id = $1`, [c.id]), /immutable/);
  await assert.rejects(db.app.query(`UPDATE booking.intents SET ${bump}, hostaway_reservation_id = '1' WHERE id = $1`, [c.id]), /immutable/);
  await assert.rejects(db.app.query(`UPDATE booking.intents SET ${bump}, dispatch_at = NULL, dispatch_attempt = NULL WHERE id = $1`, [c.id]), /immutable/);
  await assert.rejects(db.app.query(`UPDATE booking.intents SET ${bump}, state = 'confirmed', captured_minor = 1 WHERE id = $1`, [c.id]));
  // no capture without reservation; no reservation state without a PaymentIntent
  const p = await F.pending(db.app, { from: "2027-02-20", to: "2027-02-22" });
  await assert.rejects(db.app.query(`UPDATE booking.intents SET ${bump}, captured_minor = 576000 WHERE id = $1`, [p.id]), /no_capture_without_reservation/);
  await assert.rejects(db.app.query(`UPDATE booking.intents SET ${bump}, state = 'reservation_pending' WHERE id = $1`, [p.id]), /auth_required/);
  // terminal intent can only escalate
  const e = await F.priced(db.app, { from: "2027-02-24", to: "2027-02-26" });
  F.ok(await applyEvent(db.app, e.valueOf(), { type: "EXPIRE" }, { now: F.at(40) }));
  await assert.rejects(db.app.query(`UPDATE booking.intents SET ${bump}, state = 'price_confirmed' WHERE id = $1`, [e]), /terminal state/);
  // E3 also refuses illegal transitions before the DB is touched
  const r = await applyEvent(db.app, e, { type: "DETAILS_COLLECTED" }, { now: F.at(41) });
  assert.equal(r.error, "ILLEGAL_TRANSITION");
});

test("payment attempts: amount must equal the confirmed price; key format is fixed", async () => {
  const id = await F.withDetails(db.app, { from: "2027-03-01", to: "2027-03-03" });
  F.ok(await beginPayStep(db.app, id, { now: F.at(2) })); // E2B.1 (C6): an attempt needs the intent's active claim
  const ins = (amount, key) => db.app.query(
    `INSERT INTO booking.payment_attempts (id, intent_id, attempt, idempotency_key, status, amount_minor, currency, planned_session_expires_at, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, 9, $2, 'creating', $3, 'MXN', now(), now(), now())`, [id, key, amount]);
  await assert.rejects(ins(1, `cs:${id}:9`), /confirmed price/);
  await assert.rejects(ins(576000, `cs:other:9`), /check constraint/);
});

test("audit and money tables are append-only for the runtime role; no DELETE anywhere", async () => {
  const c = await F.confirmed(db.app, { from: "2027-03-05", to: "2027-03-08" });
  await assert.rejects(db.app.query("UPDATE booking.intent_transitions SET actor = 'admin' WHERE intent_id = $1", [c.id]), /not allowed|permission/);
  await assert.rejects(db.app.query("DELETE FROM booking.intent_transitions WHERE intent_id = $1", [c.id]), /permission denied/);
  await assert.rejects(db.app.query("UPDATE booking.payment_ledger SET amount_minor = 0 WHERE intent_id = $1", [c.id]), /permission denied/);
  await assert.rejects(db.app.query("DELETE FROM booking.intents WHERE id = $1", [c.id]), /permission denied/);
  await assert.rejects(db.app.query("DELETE FROM booking.intent_guests WHERE intent_id = $1", [c.id]), /permission denied/);
  // even the owner cannot rewrite history
  await assert.rejects(db.owner.query("DELETE FROM booking.intent_transitions WHERE intent_id = $1", [c.id]), /not allowed/);
  await assert.rejects(db.owner.query("TRUNCATE booking.payment_ledger"), /not allowed/);
  const ledger = (await db.app.query("SELECT entry, amount_minor FROM booking.payment_ledger WHERE intent_id = $1 ORDER BY id", [c.id])).rows;
  assert.deepEqual(ledger.map((l) => `${l.entry}:${l.amount_minor}`), ["authorization_accepted:576000", "capture_succeeded:576000", "offline_charge_recorded:576000"]);
});

test("least privilege: runtime role has no DDL; report role cannot read guest data; RLS on every table", async () => {
  await assert.rejects(db.app.query("CREATE TABLE booking.x (a int)"), /permission denied/);
  await assert.rejects(db.app.query("ALTER TABLE booking.intents DISABLE ROW LEVEL SECURITY"), /must be owner/);
  await assert.rejects(report.query("SELECT * FROM booking.intent_guests"), /permission denied/);
  assert.ok((await report.query("SELECT count(*) FROM booking.intents")).rows[0]);
  await assert.rejects(report.query("UPDATE booking.intent_work SET next_action_at = NULL"), /permission denied/);
  const rls = (await db.owner.query("SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'booking'::regnamespace AND relkind = 'r'")).rows;
  assert.equal(rls.length, 17);
  assert.ok(rls.every((r) => r.relrowsecurity), "RLS enabled everywhere");
  const pub = (await db.owner.query("SELECT has_schema_privilege('public', 'booking', 'USAGE') AS u")).rows[0].u;
  assert.equal(pub, false, "PUBLIC has no access to schema booking");
});

test("refunds can never exceed the captured amount (DB trigger)", async () => {
  const c = await F.confirmed(db.app, { from: "2027-03-10", to: "2027-03-13" });
  const refund = (seq, amount, st = "requested") => db.app.query(
    `INSERT INTO booking.payment_refunds (id, intent_id, seq, idempotency_key, amount_minor, currency, reason_code, requested_by, state, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'MXN', 'GUEST_CANCELLED', 'admin', $5, now(), now())`, [c.id, seq, `ref:${c.id}:${seq}`, amount, st]);
  await refund(1, 300000);
  await assert.rejects(refund(2, 276001), /exceed captured/);
  await refund(2, 276000);
  await refund(3, 100000, "failed"); // failed refunds do not count
  await assert.rejects(refund(4, 1), /exceed captured/);
});

test("outbox completion is required before E3 records a Hostaway payment as recorded", async () => {
  const c = await F.captured(db.app, { from: "2027-03-15", to: "2027-03-18" });
  const r = await applyEvent(db.app, c.id, { type: "OFFLINE_CHARGE_RECORDED", chargeId: 77 }, { now: F.at(9) });
  assert.equal(r.error, "OFFLINE_CHARGE_NOT_VERIFIED");
  const op = await F.claimOp(db.app, c.id, "hostaway.record_offline_charge", F.at(9));
  F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(9), outcome: { status: "succeeded", resultRef: 77 } }));
  assert.equal((await applyEvent(db.app, c.id, { type: "OFFLINE_CHARGE_RECORDED", chargeId: 78 }, { now: F.at(9) })).error, "OFFLINE_CHARGE_NOT_VERIFIED");
  F.ok(await applyEvent(db.app, c.id, { type: "OFFLINE_CHARGE_RECORDED", chargeId: 77 }, { now: F.at(9) }));
});

test("a provider reference already booked on another intent aborts the transition (ledger conflict)", async () => {
  const first = await F.confirmed(db.app, { from: "2027-03-20", to: "2027-03-23" });
  const c = await F.captured(db.app, { from: "2027-03-25", to: "2027-03-28" });
  const op = await F.claimOp(db.app, c.id, "hostaway.record_offline_charge", F.at(9));
  F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(9), outcome: { status: "succeeded", resultRef: first.chargeId } }));
  await assert.rejects(applyEvent(db.app, c.id, { type: "OFFLINE_CHARGE_RECORDED", chargeId: first.chargeId }, { now: F.at(9) }), (e) => e.code === "LEDGER_REFERENCE_CONFLICT");
  assert.equal(await F.state(db.app, c.id), "payment_captured", "nothing committed");
});
