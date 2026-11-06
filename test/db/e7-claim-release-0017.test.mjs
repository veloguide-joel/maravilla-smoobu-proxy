// 0017 (LOCAL MIGRATION CANDIDATE, root ruling a1dcea0d) — claim release for a CANCELLED intent whose capture row was never sent.
// Throwaway local PostgreSQL only. Runtime code runs as mv_booking_app; owner/admin logins are used ONLY where labelled.
//   REAL      = reached through the accepted repo / operations API (applyEvent, runOp, evidence), no direct state writes.
//   SYNTHETIC = a controlled malformed-state fixture written by the schema owner INSIDE a transaction that is ROLLED BACK; it exists
//               only to evaluate booking.claim_release_blockers on states the runnable path cannot produce. Never committed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { startMigratedDatabase, startPostgres } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent, claimReleaseBlockers, recordHostawayCreateResult } from "../../lib/booking-db/repo.js";
import { claimNextOperation, completeOperation } from "../../lib/booking-db/operations.js";
import { migrateUp, migrateDown } from "../../db/lib/migrate.js";
import { transition, EVENTS } from "../../lib/checkout/intent-state.js";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });

const CAP = "stripe.capture_payment_intent", VOID = "stripe.void_payment_intent", CANCEL = "hostaway.cancel_reservation";
const L = (n) => 870000 + n;
const held = async (id) => (await F.count(db.app, "SELECT count(*) AS n FROM booking.inventory_claims WHERE intent_id = $1 AND released_at IS NULL", [id])) === 1;
const blockers = (id) => claimReleaseBlockers(db.app, id);
const capRows = async (id) => (await db.owner.query(`SELECT id, state, attempts, dispatched_at, lease_worker_id, lease_until, updated_at, payload
  FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 ORDER BY created_at, id`, [id, CAP])).rows;
const PENDING_CAP = "PROVIDER_OPERATION_UNRESOLVED:stripe.capture_payment_intent:pending";

// REAL P class (accepted e74a precedent): reservation_confirmed with its capture row queued, then a definite CAPTURE_FAILED; the
// capture row is never claimed. Same intent shape the TEST abort produces (capture_failed, capture row pending/0/undispatched).
async function pFailed(n) {
  const r = await F.reserved(db.app, { listingId: L(n) });
  F.ok(await applyEvent(db.app, r.id, { type: "CAPTURE_FAILED", definite: true, code: "CARD_DECLINED" }, { now: F.at(8) }));
  return r;
}
// REAL D class (accepted e32 path): the capture was sent and definitely refused.
async function dFailed(n) {
  const r = await F.reserved(db.app, { listingId: L(n) });
  await F.runOp(db.app, r.id, CAP, 8, { status: "failed_definite", errorCode: "CARD_DECLINED" });
  F.ok(await applyEvent(db.app, r.id, { type: "CAPTURE_FAILED", definite: true, code: "CARD_DECLINED" }, { now: F.at(8) }));
  return r;
}
// REAL Z class (accepted e74a precedent): the reservation succeeded after the capture deadline -> capture_failed, no capture row.
async function zFailed(n) {
  const stay = { listingId: L(n) };
  const p = await F.pending(db.app, stay);
  const piId = `pi_test_${p.id.slice(0, 8)}`;
  const cb = F.at(4) + 12 * 60 * F.MIN + 30 * F.MIN;
  F.ok(await applyEvent(db.app, p.id, F.authEvent(p.sessionId, piId, 5, { captureBefore: cb }), { now: F.at(5), actor: "webhook" }));
  F.ok(await applyEvent(db.app, p.id, { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: true, priceSame: true } }, { now: F.at(6), actor: "worker", workerId: "w1" }));
  F.ok(await applyEvent(db.app, p.id, { type: "RESERVATION_DISPATCHED", workerId: "w1" }, { now: F.at(6), actor: "worker", workerId: "w1" }));
  const rid = F.nextReservationId();
  const op = await F.claimOp(db.app, p.id, "hostaway.create_reservation", F.at(6));
  const tAfter = (cb - F.T0) / F.MIN + 1;
  await recordHostawayCreateResult(db.app, p.id, { httpStatus: 201, reservation: F.reservationFor(stay, rid) }, { now: F.at(tAfter) });
  F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(6), outcome: { status: "succeeded", resultRef: rid } }));
  F.ok(await applyEvent(db.app, p.id, { type: "RESERVATION_SUCCEEDED", reservation: F.reservationFor(stay, rid) }, { now: F.at(tAfter), actor: "worker" }));
  return { ...p, piId, reservationId: rid, t: tAfter };
}
// REAL legs (accepted operations + evidence API)
async function cancelLeg(r, t) {
  await F.runOp(db.app, r.id, CANCEL, t);
  await F.reservationStatus(db.app, r.id, String(r.reservationId), "cancelled", {}, t);
  F.ok(await applyEvent(db.app, r.id, { type: "RESERVATION_CANCELLED" }, { now: F.at(t) }));
}
async function voidLeg(r, t) {
  await F.runOp(db.app, r.id, VOID, t);
  F.ok(await applyEvent(db.app, r.id, { type: "VOID_SUCCEEDED" }, { now: F.at(t) }));
}

/** SYNTHETIC: run `mutate` as the schema owner inside a transaction (user triggers off), read the blockers, ROLL BACK. */
async function syntheticBlockers(intentId, mutate) {
  const c = await db.owner.connect();
  try {
    await c.query("BEGIN");
    await c.query("ALTER TABLE booking.external_operations DISABLE TRIGGER USER");
    await c.query("ALTER TABLE booking.intents DISABLE TRIGGER USER");
    await mutate(c);
    return (await c.query("SELECT booking.claim_release_blockers($1) AS b", [intentId])).rows[0].b;
  } finally { await c.query("ROLLBACK").catch(() => {}); c.release(); }
}

test("Q1 REAL P class (precedent): claim held after ONE leg (either order), released only when the SECOND leg lands in cancelled; capture row untouched", async () => {
  for (const [n, first, second] of [[1, cancelLeg, voidLeg], [2, voidLeg, cancelLeg]]) {
    const r = await pFailed(n);
    const cap0 = await capRows(r.id);
    assert.deepEqual(cap0.map((o) => [o.state, o.attempts, o.dispatched_at, o.lease_worker_id, o.lease_until]), [["pending", 0, null, null, null]]);
    assert.equal(await held(r.id), true);
    assert.deepEqual(await blockers(r.id), ["STATE_NOT_RELEASABLE:capture_failed"]);
    await first(r, 9);
    assert.equal(await F.state(db.app, r.id), "capture_failed", `order ${n}: one leg only`);
    assert.equal(await held(r.id), true, `order ${n}: held after one leg`);
    await second(r, 10);
    assert.equal(await F.state(db.app, r.id), "cancelled");
    assert.equal(await held(r.id), false, `order ${n}: released after both legs (0017)`);
    assert.deepEqual(await blockers(r.id), []);
    assert.deepEqual(await capRows(r.id), cap0, "capture row byte-identical: never written, superseded or deleted");
    assert.equal(await claimNextOperation(db.app, { workerId: "x", now: F.at(500), intentId: r.id, opTypes: [CAP] }), null, "0007 fence: never claimable");
  }
});

test("Q2 REAL D and Z classes unchanged: released on cancelled exactly as before (no capture row pending)", async () => {
  const d = await dFailed(3);
  await cancelLeg(d, 9); assert.equal(await held(d.id), true);
  await voidLeg(d, 10);
  assert.deepEqual([await F.state(db.app, d.id), await held(d.id)], ["cancelled", false]);
  assert.deepEqual((await capRows(d.id)).map((o) => o.state), ["failed_definite"]);
  const z = await zFailed(4);
  assert.equal(await F.state(db.app, z.id), "capture_failed");
  assert.equal((await capRows(z.id)).length, 0);
  await cancelLeg(z, z.t + 1); assert.equal(await held(z.id), true);
  await voidLeg(z, z.t + 2);
  assert.deepEqual([await F.state(db.app, z.id), await held(z.id)], ["cancelled", false]);
});

test("Q3 REAL unknown leg: an ambiguous void keeps capture_failed and the claim held (no exemption outside cancelled)", async () => {
  const r = await pFailed(5);
  await cancelLeg(r, 9);
  await F.runOp(db.app, r.id, VOID, 10, { status: "outcome_unknown", errorCode: "NETWORK_ERROR" });
  F.ok(await applyEvent(db.app, r.id, { type: "VOID_OUTCOME_UNKNOWN", code: "NETWORK_ERROR" }, { now: F.at(10) }));
  assert.equal(await F.state(db.app, r.id), "capture_failed");
  assert.equal(await held(r.id), true);
  assert.deepEqual(await blockers(r.id), ["STATE_NOT_RELEASABLE:capture_failed"]);
  assert.equal(await claimNextOperation(db.app, { workerId: "x", now: F.at(500), intentId: r.id, opTypes: [VOID] }), null, "no blind re-void");
});

test("Q4 SYNTHETIC negative matrix on a REAL cancelled P-class intent (rolled back): every non-pristine capture field, every other op type / state, every other intent state still blocks", async () => {
  const r = await pFailed(6);
  await cancelLeg(r, 9); await voidLeg(r, 10);
  assert.deepEqual(await blockers(r.id), [], "baseline: pristine capture row in cancelled does not block");
  const capId = (await capRows(r.id))[0].id;
  const leaseCheck = (await db.owner.query(`SELECT conname FROM pg_constraint WHERE conrelid = 'booking.external_operations'::regclass
    AND pg_get_constraintdef(oid) LIKE '%lease_worker_id IS NULL%lease_until IS NULL%'`)).rows.map((x) => x.conname);
  assert.equal(leaseCheck.length, 1, "the paired-lease CHECK exists (a single lease field is unreachable without dropping it)");
  const upd = (set) => (c) => c.query(`UPDATE booking.external_operations SET ${set} WHERE id = $1`, [capId]);
  const cases = [
    ["attempts=1", upd("attempts = 1"), [PENDING_CAP]],
    ["dispatched_at set", upd("dispatched_at = now()"), [PENDING_CAP]],
    ["both lease fields", upd("lease_worker_id = 'w', lease_until = now()"), [PENDING_CAP]],
    ["lease_worker_id only (CHECK dropped in-tx)", async (c) => { await c.query(`ALTER TABLE booking.external_operations DROP CONSTRAINT ${leaseCheck[0]}`); await upd("lease_worker_id = 'w'")(c); }, [PENDING_CAP]],
    ["lease_until only (CHECK dropped in-tx)", async (c) => { await c.query(`ALTER TABLE booking.external_operations DROP CONSTRAINT ${leaseCheck[0]}`); await upd("lease_until = now()")(c); }, [PENDING_CAP]],
    ["capture in_flight", upd("state = 'in_flight', attempts = 1, dispatched_at = now(), lease_worker_id = 'w', lease_until = now()"), ["PROVIDER_OPERATION_UNRESOLVED:stripe.capture_payment_intent:in_flight"]],
    ["capture outcome_unknown", upd("state = 'outcome_unknown', attempts = 1, dispatched_at = now()"), ["PROVIDER_OPERATION_UNRESOLVED:stripe.capture_payment_intent:outcome_unknown"]],
    ["capture escalated", upd("state = 'escalated'"), ["PROVIDER_OPERATION_UNRESOLVED:stripe.capture_payment_intent:escalated"]]
  ];
  // another pending provider write of every other blocking type (pristine fields), cloned from the capture row
  for (const t of [VOID, CANCEL, "stripe.create_checkout_session", "hostaway.create_reservation", "hostaway.record_offline_charge"]) {
    // the intent's existing row of that type is put back to pristine pending; a type with no row gets a pristine clone
    cases.push([`pending ${t}`, async (c) => {
      const u = await c.query(`UPDATE booking.external_operations SET state = 'pending', attempts = 0, dispatched_at = NULL, lease_worker_id = NULL, lease_until = NULL
        WHERE intent_id = $1 AND op_type = $2`, [r.id, t]);
      if (u.rowCount === 0) await c.query(`INSERT INTO booking.external_operations SELECT (jsonb_populate_record(NULL::booking.external_operations,
        jsonb_set(jsonb_set(jsonb_set(to_jsonb(o), '{id}', to_jsonb(gen_random_uuid())), '{op_type}', to_jsonb($2::text)), '{idempotency_key}', to_jsonb(gen_random_uuid()::text))
        || CASE WHEN $2 IN ('hostaway.create_reservation', 'hostaway.record_offline_charge') THEN '{"retry_class":"non_idempotent","max_attempts":1}'::jsonb ELSE '{}'::jsonb END)).*
        FROM booking.external_operations o WHERE o.id = $1`, [capId, t]);
    }, [`PROVIDER_OPERATION_UNRESOLVED:${t}:pending`]]);
  }
  for (const s of ["authorization_released", "expired", "payment_failed", "payment_expired", "validation_failed"]) {
    cases.push([`intent state ${s}`, (c) => c.query("UPDATE booking.intents SET state = $2 WHERE id = $1", [r.id, s]), [PENDING_CAP]]);
  }
  for (const s of ["capture_unknown", "reservation_confirmed", "reconciliation_required", "capture_failed"]) {
    cases.push([`intent state ${s}`, (c) => c.query("UPDATE booking.intents SET state = $2 WHERE id = $1", [r.id, s]), [`STATE_NOT_RELEASABLE:${s}`]]);
  }
  for (const [label, mutate, want] of cases) assert.deepEqual(await syntheticBlockers(r.id, mutate), want, label);
  assert.deepEqual(await blockers(r.id), [], "every synthetic fixture was rolled back");
  assert.deepEqual((await capRows(r.id)).map((o) => [o.state, o.attempts, o.dispatched_at]), [["pending", 0, null]]);
});

test("Q5 REAL non-cancelled states with a pristine capture row keep blocking: reservation_confirmed, reconciliation_required, capture_unknown", async () => {
  const a = await F.reserved(db.app, { listingId: L(7) });
  assert.deepEqual(await blockers(a.id), ["STATE_NOT_RELEASABLE:reservation_confirmed"]);
  const b = await F.reserved(db.app, { listingId: L(8) });
  F.ok(await applyEvent(db.app, b.id, { type: "ESCALATE", code: "MANUAL_REVIEW" }, { now: F.at(8) }));
  assert.deepEqual([await F.state(db.app, b.id), (await capRows(b.id)).map((o) => o.state)], ["reconciliation_required", ["pending"]]);
  assert.deepEqual(await blockers(b.id), ["STATE_NOT_RELEASABLE:reconciliation_required"]);
  assert.equal(await held(b.id), true);
  const c = await F.reserved(db.app, { listingId: L(9) });
  await F.runOp(db.app, c.id, CAP, 8, { status: "outcome_unknown", errorCode: "TIMEOUT" });
  F.ok(await applyEvent(db.app, c.id, { type: "CAPTURE_OUTCOME_UNKNOWN", code: "TIMEOUT" }, { now: F.at(8) }));
  assert.deepEqual(await blockers(c.id), ["STATE_NOT_RELEASABLE:capture_unknown"]);
});

test("Q6 REAL later legal events on a released cancelled P-class intent: late same-PI and different-PI PAYMENT_AUTHORIZED escalate to reconciliation_required; never reservation_confirmed; the old capture never claimable", async () => {
  for (const [n, same] of [[10, true], [11, false]]) {
    const r = await pFailed(n);
    await cancelLeg(r, 9); await voidLeg(r, 10);
    assert.equal(await held(r.id), false);
    const cap0 = await capRows(r.id);
    const pi = same ? r.piId : `pi_test_other${n}`;
    if (same) {   // a REDELIVERY of the original event id is the accepted exactly-once duplicate (no transition)
      const dup = F.ok(await applyEvent(db.app, r.id, F.authEvent(r.sessionId, pi, 11), { now: F.at(11), actor: "webhook" }));
      assert.equal(dup.duplicate, true); assert.equal(await F.state(db.app, r.id), "cancelled");
    }
    F.ok(await applyEvent(db.app, r.id, F.authEvent(r.sessionId, pi, 11, { id: `evt_late_${n}` }), { now: F.at(11), actor: "webhook" }));
    const i = await loadIntent(db.app, r.id);
    assert.deepEqual([i.status, i.reasonCode], ["reconciliation_required", "AUTHORIZATION_ON_CLOSED_INTENT"], same ? "same PI" : "different PI");
    assert.equal(await claimNextOperation(db.app, { workerId: "x", now: F.at(600), intentId: r.id, opTypes: [CAP] }), null, "0007 fence");
    assert.deepEqual(await capRows(r.id), cap0, "capture row untouched");
    assert.deepEqual(await blockers(r.id), ["STATE_NOT_RELEASABLE:reconciliation_required"]);
    assert.equal(await held(r.id), false, "an already released claim is not re-taken");
  }
});

test("Q7 reducer reachability (accepted transition(), no event suppressed): from a REAL cancelled P-class intent, every ACCEPTED event sequence (depth 4, every EVENTS type incl. late same/different-PI PAYMENT_AUTHORIZED and every RESOLVE outcome) stays in {cancelled, reconciliation_required, confirmed, authorization_released}; reservation_confirmed is unreachable; no capture effect is ever emitted", async () => {
  const r = await pFailed(12);
  await cancelLeg(r, 9); await voidLeg(r, 10);
  const start = await loadIntent(db.app, r.id);
  assert.equal(start.status, "cancelled");
  const money = { amountMinor: start.price.finalTotalMinor, currency: start.price.currency };
  const menu = (it, k) => {
    const pi = it.payment && it.payment.paymentIntentId;
    const ev = [];
    for (const p of [pi, `pi_test_late_${k}`]) for (const livemode of [false, true]) for (const amt of [money.amountMinor, money.amountMinor + 1]) {
      ev.push({ type: "PAYMENT_AUTHORIZED", paymentIntentId: p, livemode, amountMinor: amt, currency: money.currency, sessionId: it.checkout && it.checkout.sessionId,
        authorizationCreatedAt: F.at(20 + k), captureBefore: F.at(20 + k) + 6 * F.DAY });
    }
    for (const outcome of ["confirmed", "released", "cancelled", "bogus"]) {
      ev.push({ type: "RESOLVE", outcome, evidence: { reservationId: String(r.reservationId), capturedMinor: money.amountMinor, currency: money.currency,
        authorizationVoided: true, noReservation: true, reservationCancelled: true, notCaptured: true }, resolvedBy: "o", resolutionId: randomUUID() });
      ev.push({ type: "RESOLVE", outcome, evidence: {}, resolvedBy: "o", resolutionId: randomUUID() });
    }
    for (const amt of [money.amountMinor, money.amountMinor - 1]) ev.push({ type: "CAPTURE_SUCCEEDED", amountMinor: amt, currency: money.currency });
    for (const t of EVENTS) if (!["PAYMENT_AUTHORIZED", "RESOLVE", "CAPTURE_SUCCEEDED"].includes(t)) ev.push({ type: t, workerId: "w", code: "X", paymentIntentId: pi, reservationId: String(r.reservationId) });
    return ev.map((e, j) => ({ ...e, id: `q7-${k}-${j}` }));
  };
  const allowed = new Set(["cancelled", "reconciliation_required", "confirmed", "authorization_released"]);
  const seen = new Set(["cancelled"]);
  let frontier = [start]; let accepted = 0;
  for (let depth = 0; depth < 4; depth++) {
    const nextF = []; const keys = new Set();
    for (const it of frontier) for (const e of menu(it, depth)) {
      const out = transition(it, e, { now: F.at(30 + depth) });
      if (!out.ok || out.duplicate) continue;
      accepted += 1;
      seen.add(out.intent.status);
      assert.ok(allowed.has(out.intent.status), `${e.type} from ${it.status} -> ${out.intent.status}`);
      assert.ok(!out.effects.some((x) => x.type === CAP), `${e.type} from ${it.status} emitted a capture`);
      const key = `${out.intent.status}|${out.intent.payment && out.intent.payment.paymentIntentId}|${out.intent.reasonCode}`;
      if (!keys.has(key)) { keys.add(key); nextF.push(out.intent); }
    }
    frontier = nextF;
  }
  assert.ok(accepted > 0 && seen.has("reconciliation_required"), "late authorization is accepted (escalation), not suppressed");
  assert.ok(!seen.has("reservation_confirmed"));
});

test("Q8 MIGRATION: 0017 changes ONLY the function body; down restores the 0016 schema exactly (definition, owner, ACL, SECURITY DEFINER, volatility, config, every object); up re-applies identically; behavior toggles accordingly", async () => {
  const fnAttrs = async (c) => (await c.query(`SELECT md5(pg_get_functiondef(p.oid)) AS def, pg_get_userbyid(p.proowner) AS owner, coalesce(array_to_string(p.proacl, ','), '') AS acl,
      p.prosecdef, p.provolatile, coalesce(array_to_string(p.proconfig, ','), '') AS cfg, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p WHERE p.oid = 'booking.claim_release_blockers(uuid)'::regprocedure`)).rows[0];
  const objects = async (c) => (await c.query(`
      SELECT 'fn|' || p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(array_to_string(p.proacl, ','), '') || '|' || pg_get_userbyid(p.proowner) AS o
        FROM pg_proc p WHERE p.pronamespace = 'booking'::regnamespace
      UNION ALL SELECT 'con|' || conrelid::regclass::text || '|' || conname || '|' || pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace = 'booking'::regnamespace
      UNION ALL SELECT 'idx|' || indexrelid::regclass::text || '|' || pg_get_indexdef(indexrelid) FROM pg_index WHERE indrelid::regclass::text LIKE 'booking.%'
      UNION ALL SELECT 'trg|' || tgrelid::regclass::text || '|' || tgname || '|' || tgenabled::text FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text LIKE 'booking.%'
      UNION ALL SELECT 'tbl|' || c.relname || '|' || coalesce(array_to_string(c.relacl, ','), '') FROM pg_class c WHERE c.relnamespace = 'booking'::regnamespace
      ORDER BY 1`)).rows.map((x) => x.o);
  // fresh cluster at 16 = the accepted baseline
  const fresh = await startPostgres(); const c16 = new pg.Client({ connectionString: fresh.adminUrl }); await c16.connect();
  let base16, base16Objs;
  try { await migrateUp(c16, { env: "test", to: 16 }); base16 = await fnAttrs(c16); base16Objs = await objects(c16); } finally { await c16.end(); fresh.stop(); }
  const c = new pg.Client({ connectionString: db.adminUrl }); await c.connect();
  try {
    const at17 = await fnAttrs(c); const at17Objs = await objects(c);
    assert.notEqual(at17.def, base16.def, "body changed");
    assert.deepEqual({ ...at17, def: null }, { ...base16, def: null }, "owner, ACL, SECURITY DEFINER, volatility, search_path, signature unchanged");
    assert.deepEqual(at17Objs.filter((o) => !o.startsWith("fn|booking.claim_release_blockers(uuid)|")), base16Objs.filter((o) => !o.startsWith("fn|booking.claim_release_blockers(uuid)|")),
      "no other object differs");
    // behavior across down/up on a REAL P-class intent whose second leg lands while 0017 is rolled back
    const r = await pFailed(13);
    await cancelLeg(r, 9);
    assert.deepEqual(await migrateDown(c, { env: "test", to: 16 }), [17]);
    assert.deepEqual(await fnAttrs(c), base16, "down = 0016 function definition, owner, ACL exactly");
    assert.deepEqual(await objects(c), base16Objs, "down = 0016 schema exactly");
    await voidLeg(r, 10);
    assert.deepEqual([await F.state(db.app, r.id), await held(r.id)], ["cancelled", true], "0016 behavior restored: precedent claim stays held");
    assert.deepEqual(await blockers(r.id), [PENDING_CAP]);
    assert.deepEqual(await migrateUp(c, { env: "test" }), [17]);
    assert.deepEqual(await fnAttrs(c), at17); assert.deepEqual(await objects(c), at17Objs, "up re-applies identically");
    assert.deepEqual(await blockers(r.id), []);
    const rel = await db.app.query("SELECT booking.release_claim_if_safe($1, 'SAFE_RELEASE') AS ok", [r.id]);
    assert.equal(rel.rows[0].ok, true);
    assert.equal(await held(r.id), false);
  } finally { await c.end(); }
});
