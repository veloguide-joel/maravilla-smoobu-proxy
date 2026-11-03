// Stage E7.1 — pure recovery planner: state × operation × evidence matrix, identity and proof mismatches. No I/O.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createIntent, transition, allowedEvents } from "../lib/checkout/intent-state.js";
import {
  planRecovery, paymentIntentProofObservation, RECOVERY_EVENT_ID, FRESH_AFTER_DISPATCH_MS, OP, piCapturedProof
} from "../lib/checkout/recovery-plan.js";

const MIN = 60000;
const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);
const at = (m) => T0 + m * MIN;
const ATT = "11111111-2222-4333-8444-555555555555";
const PI = "pi_test_abc";
const PRICE = {
  version: "final-price-v1", quoteBasis: "x", listingId: 603566, from: "2026-12-20", to: "2026-12-24", guests: 2, nights: 4, currency: "USD",
  standardTotalMinor: 100000, eligibleMinor: 100000, discountMinor: 10000, finalTotalMinor: 90000, policyVersion: "direct-v1", rateBps: 1000,
  lines: [{ kind: "accommodation", code: "baseRate", label: "A", amountMinor: 90000 }], charge: { currency: "usd", amountMinor: 90000, quantity: 1, description: "d" },
  quoteHash: "b".repeat(64)
};
const RID = "7001";
const RES = { reservationId: RID, listingId: 603566, from: "2026-12-20", to: "2026-12-24", totalMinor: 90000, currency: "USD" };

function step(i, e, m) { const r = transition(i, e, { now: at(m) }); assert.equal(r.ok, true, `${e.type}: ${r.error}`); return r.intent; }
function base(upTo) {
  let i = createIntent({ id: "int-1", ref: "MV-ABC123", listingId: 603566, from: "2026-12-20", to: "2026-12-24", guests: 2, now: at(0) });
  i = step(i, { type: "PRICE_CONFIRMED", price: PRICE }, 0);
  i = step(i, { type: "DETAILS_COLLECTED" }, 1);
  i = step(i, { type: "CHECKOUT_PREPARED", sessionId: "cs_test_1" }, 2);
  i = step(i, { type: "PAYMENT_AUTHORIZED", paymentIntentId: PI, sessionId: "cs_test_1", amountMinor: 90000, currency: "usd", livemode: false,
    authorizationCreatedAt: at(4), captureBefore: at(4) + 7 * 24 * 60 * MIN }, 5);
  i = step(i, { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: true, priceSame: true } }, 6);
  i = step(i, { type: "RESERVATION_DISPATCHED", workerId: "w1" }, 6);
  if (upTo === "reservation_pending") return i;
  if (upTo === "reservation_unknown") return step(i, { type: "RESERVATION_OUTCOME_UNKNOWN" }, 7);
  if (upTo === "reservation_failed") return step(i, { type: "RESERVATION_FAILED", definite: true }, 7);
  i = step(i, { type: "RESERVATION_SUCCEEDED", reservation: RES }, 7);
  if (upTo === "reservation_confirmed") return i;
  if (upTo === "capture_unknown") return step(i, { type: "CAPTURE_OUTCOME_UNKNOWN" }, 8);
  if (upTo === "capture_failed") return step(i, { type: "CAPTURE_FAILED", definite: true, code: "card_declined" }, 8);
  if (upTo === "payment_captured") return step(i, { type: "CAPTURE_SUCCEEDED", amountMinor: 90000, currency: "usd" }, 8);
  throw new Error(upTo);
}
const op = (opType, state, extra = {}) => ({ id: "op-1", opType, state, dispatchedAt: at(10), payload: {}, resultRef: null, errorCode: null, ...extra });
const capOp = (state, attempt = 1) => op(OP.CAPTURE, state, { payload: { paymentIntentId: PI, attempt, amountMinor: 90000 } });
const piObs = (status, over = {}, chargeOver = {}) => ({
  proofVersion: "pi-proof-v2", object: "payment_intent", paymentIntentId: PI, accountVerified: true, livemode: false, metadataIntentId: "int-1", metadataAttemptId: ATT,
  captureMethod: "manual", status, amountMinor: 90000, amountReceivedMinor: status === "succeeded" ? 90000 : 0,
  amountCapturableMinor: status === "requires_capture" ? 90000 : 0, currency: "USD",
  latestCharge: { object: "charge", id: "ch_1", paymentIntent: PI, status: "succeeded", captured: status === "succeeded", amountMinor: 90000,
    amountCapturedMinor: status === "succeeded" ? 90000 : 0, amountRefundedMinor: 0, currency: "USD", livemode: false, ...chargeOver }, ...over
});
let evn = 0;
const piEv = (status, over, chargeOver, m = 13) => ({ id: `ev-${++evn}`, kind: "payment_intent", readOpType: "stripe.retrieve_payment_intent", requestRef: PI, externalRef: PI,
  status: over && over.status ? over.status : status, observed: piObs(status, over, chargeOver), observedAt: at(m) });
const byId = (status, over = {}, m = 13, extRef = RID) => ({ id: `ev-${++evn}`, kind: "hostaway_reservation", readOpType: "hostaway.retrieve_reservation", requestRef: RID, externalRef: extRef, status,
  observed: { reservationId: RID, listingId: 603566, from: "2026-12-20", to: "2026-12-24", totalMinor: 90000, currency: "USD", ...over }, observedAt: at(m) });
const byRef = (status = "found_active", over = {}, m = 13) => ({ id: `ev-${++evn}`, kind: "hostaway_reservation", readOpType: "hostaway.lookup_reservation",
  requestRef: "MV-ABC123", externalRef: over.reservationId ?? RID, status,
  observed: { bookingRef: "MV-ABC123", matchCount: 1, reservationId: RID, listingId: 603566, from: "2026-12-20", to: "2026-12-24", totalMinor: 90000, currency: "USD", ...over },
  observedAt: at(m) });
const plan = (intent, o, evidence = [], extra = {}) => planRecovery({ intent, op: o, evidence, appliedEventIds: [], paymentAttemptId: ATT, now: at(20), ...extra });

test("every planned event is legal in the current state (checked with E3) and carries a deterministic id", () => {
  const cases = [
    [base("reservation_pending"), op(OP.CREATE, "outcome_unknown")],
    [base("reservation_pending"), op(OP.CREATE, "succeeded"), [byRef(), byId("found_active")]],
    [base("reservation_unknown"), op(OP.CREATE, "outcome_unknown"), [byRef(), byId("found_active")]],
    [base("reservation_confirmed"), capOp("succeeded")],
    [base("capture_unknown"), capOp("outcome_unknown"), [piEv("succeeded")]],
    [base("capture_unknown"), capOp("outcome_unknown"), [piEv("requires_capture")]],
    [base("capture_unknown"), capOp("outcome_unknown"), [piEv("canceled")]],
    [base("reservation_failed"), op(OP.VOID, "outcome_unknown", { payload: { paymentIntentId: PI, attempt: 1 } }), [piEv("canceled")]],
    [base("capture_failed"), op(OP.CANCEL, "outcome_unknown", { payload: { reservationId: RID, attempt: 1 } }), [byId("cancelled")]],
    [base("payment_captured"), op(OP.OFFLINE_CHARGE, "succeeded", { resultRef: "och-9" })]
  ];
  for (const [i, o, e] of cases) {
    const p = plan(i, o, e);
    assert.equal(p.kind, "event", `${i.status}/${o.opType}: ${p.code}`);
    assert.ok(allowedEvents(i.status).includes(p.event.type), `${p.event.type} legal in ${i.status}`);
    assert.match(p.event.id, /^op-(outcome|unknown|inconclusive):op-1/);
    assert.equal(p.intentVersion, i.version);
    assert.deepEqual(plan(i, o, e), p, "deterministic");
  }
});

test("create: reservation_pending -> unknown / definite / needs reads / proven; requested ref and attempts row are not proof", () => {
  const i = base("reservation_pending");
  assert.equal(plan(i, op(OP.CREATE, "outcome_unknown")).event.type, "RESERVATION_OUTCOME_UNKNOWN");
  assert.equal(plan(i, op(OP.CREATE, "outcome_unknown")).event.id, RECOVERY_EVENT_ID.unknown("op-1"));
  const f = plan(i, op(OP.CREATE, "failed_definite", { errorCode: "LISTING_BLOCKED" }));
  assert.deepEqual([f.event.type, f.event.definite, f.event.code], ["RESERVATION_FAILED", true, "LISTING_BLOCKED"]);
  // succeeded with no evidence: a fresh lookup by ref first, then the reservation by id
  assert.deepEqual(plan(i, op(OP.CREATE, "succeeded")).read, { opType: "hostaway.lookup_reservation", ref: "MV-ABC123" });
  assert.deepEqual(plan(i, op(OP.CREATE, "succeeded"), [byRef()]).read, { opType: "hostaway.retrieve_reservation", ref: RID });
  const ok = plan(i, op(OP.CREATE, "succeeded"), [byRef(), byId("found_active")]);
  assert.deepEqual([ok.event.type, ok.event.reservation], ["RESERVATION_SUCCEEDED", RES]);
  // evidence not observed >= 2 min after dispatch is not fresh: ignored
  const early = at(10) + FRESH_AFTER_DISPATCH_MS - 1;
  assert.equal(plan(i, op(OP.CREATE, "succeeded"), [{ ...byRef(), observedAt: early }, byId("found_active")]).kind, "needs_fresh_read");
  // missing currency in the by-id read: never filled in from the intent -> not proven (no reservation event)
  const noCur = byId("found_active"); delete noCur.observed.currency;
  assert.deepEqual([plan(i, op(OP.CREATE, "succeeded"), [byRef(), noCur]).event.type, plan(i, op(OP.CREATE, "succeeded"), [byRef(), noCur]).event.code],
    ["RESERVATION_OUTCOME_UNKNOWN", "RESERVATION_NOT_PROVEN"]);
  // identity mismatches
  for (const over of [{ listingId: 1 }, { from: "2026-12-21" }, { to: "2026-12-25" }, { totalMinor: 89999 }, { currency: "MXN" }, { reservationId: "7002" }]) {
    assert.equal(plan(i, op(OP.CREATE, "succeeded"), [byRef(), byId("found_active", over)]).event.type, "ESCALATE", JSON.stringify(over));
  }
  // lookup not proving one same-id match -> unknown (pending); duplicates -> escalate
  assert.equal(plan(i, op(OP.CREATE, "succeeded"), [byRef("not_found")]).event.type, "RESERVATION_OUTCOME_UNKNOWN");
  // a lookup answered for another booking ref contradicts the request (the database refuses to record it): escalate
  assert.equal(plan(i, op(OP.CREATE, "succeeded"), [byRef("found_active", { bookingRef: "MV-OTHER1" })]).event.code, "RESERVATION_IDENTITY_MISMATCH");
  assert.deepEqual(plan(i, op(OP.CREATE, "succeeded"), [byRef("found_active", { matchCount: 2 })]).event.code, "DUPLICATE_BOOKING_REF");
  assert.equal(plan(i, op(OP.CREATE, "succeeded"), [byRef("found_active", { reservationId: "7002" }), byId("found_active")]).kind, "needs_fresh_read",
    "the by-id read must be for the id the lookup returned");
  // a by-id read that is not found_active after a positive lookup: not proven
  assert.equal(plan(i, op(OP.CREATE, "succeeded"), [byRef(), byId("cancelled")]).event.type, "RESERVATION_OUTCOME_UNKNOWN");
});

test("create: reservation_unknown -> FOUND only with proof; otherwise bounded INCONCLUSIVE per evidence; never ABSENT", () => {
  const i = base("reservation_unknown");
  const o = op(OP.CREATE, "outcome_unknown");
  assert.equal(plan(i, o).kind, "needs_fresh_read");
  assert.equal(plan(i, o, [byRef(), byId("found_active")]).event.type, "RECONCILED_RESERVATION_FOUND");
  const nf = byRef("not_found", { matchCount: 0 });
  const inc = plan(i, o, [nf]);
  assert.deepEqual([inc.event.type, inc.event.id], ["RECONCILIATION_INCONCLUSIVE", RECOVERY_EVENT_ID.inconclusive("op-1", nf.id)]);
  // the same evidence never counts twice: a newer read is needed
  assert.equal(plan(i, o, [nf], { appliedEventIds: [inc.event.id] }).kind, "needs_fresh_read");
  for (let k = 0; k < 20; k++) assert.notEqual(plan(i, o, [byRef("not_found")]).event?.type, "RECONCILED_RESERVATION_ABSENT");
});

test("capture: reservation_confirmed -> CAPTURE_OUTCOME_UNKNOWN for every completed state; never RECONCILED_* there", () => {
  const i = base("reservation_confirmed");
  for (const s of ["succeeded", "failed_definite", "outcome_unknown"]) {
    const p = plan(i, capOp(s), [piEv("succeeded")]);
    assert.deepEqual([p.event.type, p.event.id, p.settle], ["CAPTURE_OUTCOME_UNKNOWN", RECOVERY_EVENT_ID.unknown("op-1"), undefined], s);
  }
  assert.deepEqual(plan(i, capOp("succeeded", 2)), { kind: "none", code: "STALE_ATTEMPT" });
  assert.equal(plan(i, capOp("succeeded", 0)).code, "STALE_ATTEMPT");
});

test("capture: capture_unknown -> reconciled outcomes only with full proof; any difference escalates", () => {
  const i = base("capture_unknown");
  const o = capOp("outcome_unknown");
  assert.deepEqual(plan(i, o).read, { opType: "stripe.retrieve_payment_intent", ref: PI });
  const s = piEv("succeeded");
  const p = plan(i, o, [s]);
  assert.deepEqual([p.event.type, p.event.amountMinor, p.event.currency, p.settle], ["RECONCILED_CAPTURE_SUCCEEDED", 90000, "USD", s.id]);
  assert.equal(plan(i, o, [piEv("requires_capture")]).event.type, "RECONCILED_STILL_AUTHORIZED");
  assert.equal(plan(i, o, [piEv("canceled")]).event.type, "RECONCILED_AUTHORIZATION_GONE");
  const mism = [
    [{ paymentIntentId: "pi_test_other" }], [{ accountVerified: false }], [{ livemode: true }], [{ metadataIntentId: "int-2" }],
    [{ metadataAttemptId: "other" }], [{ captureMethod: "automatic" }], [{ amountMinor: 89999 }], [{ currency: "MXN" }], [{ amountReceivedMinor: 89999 }],
    [{ latestCharge: null }], [{}, { paymentIntent: "pi_test_other" }], [{}, { captured: false }], [{}, { amountCapturedMinor: 1 }],
    [{}, { amountRefundedMinor: 1 }], [{}, { livemode: true }]
  ];
  for (const [over, ch] of mism) {
    const r = plan(i, o, [piEv("succeeded", over, ch)]);
    assert.deepEqual([r.event.type, r.event.code], ["ESCALATE", "CAPTURE_PROOF_MISMATCH"], JSON.stringify([over, ch]));
  }
  // missing attempt binding (no completed payment attempt) is not proof
  assert.equal(plan(i, o, [piEv("succeeded")], { paymentAttemptId: null }).event.code, "CAPTURE_PROOF_MISMATCH");
  // evidence status and observed status must agree (no lost/changed values)
  assert.equal(plan(i, o, [{ ...piEv("succeeded"), status: "requires_capture" }]).event.code, "CAPTURE_PROOF_MISMATCH");
  // contradictions with the row's own recorded outcome
  assert.equal(plan(i, capOp("succeeded"), [piEv("requires_capture")]).event.code, "CAPTURE_EVIDENCE_CONTRADICTS_OPERATION");
  assert.equal(plan(i, capOp("failed_definite"), [piEv("succeeded")]).event.code, "CAPTURE_EVIDENCE_CONTRADICTS_OPERATION");
  // a settled row needs no settle step
  assert.equal(plan(i, capOp("succeeded"), [piEv("succeeded")]).settle, undefined);
  // processing etc.: bounded inconclusive
  assert.equal(plan(i, o, [piEv("processing")]).event.type, "RECONCILIATION_INCONCLUSIVE");
  // still authorized after the internal deadline: escalate instead of a new capture attempt
  assert.equal(plan(i, o, [piEv("requires_capture")], { now: i.payment.authorizationDeadline }).event.code, "AUTHORIZATION_DEADLINE_PASSED");
  // stale attempt row in capture_unknown
  assert.equal(plan(i, capOp("outcome_unknown", 2), [piEv("succeeded")]).code, "STALE_ATTEMPT");
});

test("capture: not awaited in later/other states", () => {
  for (const s of ["payment_captured", "capture_failed", "reservation_pending", "reservation_unknown"]) {
    assert.deepEqual(plan(base(s), capOp("succeeded"), [piEv("succeeded")]), { kind: "none", code: "NOT_AWAITING" }, s);
  }
});

test("void and cancel legs", () => {
  const rf = base("reservation_failed");
  const v = (st) => op(OP.VOID, st, { payload: { paymentIntentId: PI, attempt: 1 } });
  assert.equal(plan(rf, v("outcome_unknown")).event.type, "VOID_OUTCOME_UNKNOWN");
  assert.equal(plan(rf, v("outcome_unknown"), [], { appliedEventIds: [RECOVERY_EVENT_ID.unknown("op-1")] }).kind, "needs_fresh_read");
  assert.equal(plan(rf, v("succeeded")).kind, "needs_fresh_read", "a read first, even after a succeeded void");
  assert.equal(plan(rf, v("succeeded"), [piEv("canceled")]).event.type, "VOID_SUCCEEDED");
  assert.equal(plan(rf, v("succeeded"), [piEv("requires_capture")]).event.code, "VOID_EVIDENCE_CONTRADICTS_OPERATION");
  assert.equal(plan(rf, v("outcome_unknown"), [piEv("requires_capture")]).event.type, "RECONCILED_STILL_AUTHORIZED");
  assert.equal(plan(rf, v("failed_definite")).event.type, "VOID_FAILED");
  assert.equal(plan(rf, v("outcome_unknown"), [piEv("succeeded")]).event.code, "CAPTURED_WHILE_VOIDING");
  const cf = base("capture_failed");
  assert.equal(plan(cf, v("outcome_unknown"), [piEv("succeeded")]).event.type, "RECONCILED_CAPTURE_SUCCEEDED");
  assert.equal(plan(cf, v("outcome_unknown"), [piEv("canceled", { metadataIntentId: "x" })]).event.code, "VOID_PROOF_MISMATCH");
  const c = (st) => op(OP.CANCEL, st, { payload: { reservationId: RID, attempt: 1 } });
  assert.equal(plan(cf, c("outcome_unknown")).event.type, "RESERVATION_CANCEL_OUTCOME_UNKNOWN");
  assert.equal(plan(cf, c("succeeded")).kind, "needs_fresh_read");
  assert.equal(plan(cf, c("succeeded"), [byId("cancelled")]).event.type, "RESERVATION_CANCELLED");
  assert.equal(plan(cf, c("succeeded"), [byId("found_active")]).event.code, "CANCEL_EVIDENCE_CONTRADICTS_OPERATION");
  assert.equal(plan(cf, c("outcome_unknown"), [byId("found_active")]).event.type, "RECONCILED_RESERVATION_STILL_ACTIVE");
  assert.equal(plan(cf, c("failed_definite")).event.type, "RESERVATION_CANCEL_FAILED");
  assert.equal(plan(cf, op(OP.CANCEL, "succeeded", { payload: { reservationId: "9999" } })).code, "CANCEL_RESERVATION_MISMATCH");
});

test("offline charge: recorded only with the row's own charge id; unknown -> operator, never re-recorded", () => {
  const pc = base("payment_captured");
  assert.deepEqual(plan(pc, op(OP.OFFLINE_CHARGE, "succeeded", { resultRef: "och-9" })).event.chargeId, "och-9");
  assert.equal(plan(pc, op(OP.OFFLINE_CHARGE, "succeeded")).code, "OFFLINE_CHARGE_ID_MISSING");
  assert.equal(plan(pc, op(OP.OFFLINE_CHARGE, "failed_definite")).event.type, "OFFLINE_CHARGE_FAILED");
  assert.deepEqual(plan(pc, op(OP.OFFLINE_CHARGE, "outcome_unknown")), { kind: "operator", code: "OFFLINE_CHARGE_OUTCOME_UNKNOWN" });
});

test("guards: uncompleted, undispatched, already handled, unknown op types, dashboard evidence ignored", () => {
  const i = base("capture_unknown");
  for (const s of ["pending", "in_flight", "superseded", "escalated"]) assert.equal(plan(i, capOp(s)).code, "OPERATION_NOT_COMPLETED");
  assert.equal(plan(i, { ...capOp("outcome_unknown"), dispatchedAt: null }).code, "OPERATION_NEVER_DISPATCHED");
  assert.equal(plan(i, capOp("outcome_unknown"), [piEv("succeeded")], { appliedEventIds: [RECOVERY_EVENT_ID.outcome("op-1")] }).code, "ALREADY_HANDLED");
  assert.equal(plan(i, op("guest.notify", "succeeded")).code, "NOT_A_RECOVERABLE_WRITE");
  const dash = { ...piEv("succeeded"), readOpType: undefined };
  assert.equal(plan(i, capOp("outcome_unknown"), [dash]).kind, "needs_fresh_read");
  assert.throws(() => planRecovery({ intent: i, op: capOp("outcome_unknown") }), TypeError);
});

test("PLANNED_EVENT_REJECTED: an event E3 refuses is never returned as an event", () => {
  // RESERVATION_SUCCEEDED requires a dispatch; a forged intent without one makes E3 refuse
  const i = { ...base("reservation_pending") };
  const p = planRecovery({ intent: { ...i, status: "reservation_unknown", dispatch: null }, op: op(OP.CREATE, "succeeded"), evidence: [byRef(), byId("found_active")],
    appliedEventIds: [], paymentAttemptId: ATT, now: at(20) });
  assert.equal(p.kind, "event"); // reservation_unknown FOUND does not need a dispatch
  const q = planRecovery({ intent: { ...i, dispatch: null }, op: op(OP.CREATE, "outcome_unknown"), evidence: [], appliedEventIds: [], paymentAttemptId: ATT, now: at(20) });
  assert.equal(q.code, "NOT_DISPATCHED");
  const bad = planRecovery({ intent: { ...base("capture_unknown"), price: { ...PRICE, finalTotalMinor: 90000 }, reservation: null },
    op: capOp("outcome_unknown"), evidence: [piEv("succeeded")], appliedEventIds: [], paymentAttemptId: ATT, now: at(20) });
  assert.equal(bad.kind, "operator");
  assert.match(bad.code, /^PLANNED_EVENT_REJECTED/);
  // E3 refuses (without throwing) an offline charge id that is blank after trimming
  assert.deepEqual(plan(base("payment_captured"), op(OP.OFFLINE_CHARGE, "succeeded", { resultRef: "   " })),
    { kind: "operator", code: "PLANNED_EVENT_REJECTED:INVALID_CHARGE" });
});

test("paymentIntentProofObservation copies provider values, never invents them", () => {
  const pi = { id: PI, object: "payment_intent", livemode: false, capture_method: "manual", status: "succeeded", amount: 90000, amount_received: 90000,
    amount_capturable: 0, currency: "usd", metadata: { mv_intent_id: "int-1", mv_payment_attempt_id: ATT, other: "x" },
    latest_charge: { object: "charge", id: "ch_1", payment_intent: PI, status: "succeeded", captured: true, amount: 90000, amount_captured: 90000,
      amount_refunded: 0, currency: "usd", livemode: false, billing_details: { email: "a@b.c" } } };
  const o = paymentIntentProofObservation(pi, { accountVerified: true });
  assert.deepEqual(o, piObs("succeeded"));
  assert.ok(!JSON.stringify(o).includes("a@b.c"), "no customer data");
  const bare = paymentIntentProofObservation({ id: PI }, {});
  assert.deepEqual([bare.object, bare.accountVerified, bare.livemode, bare.amountReceivedMinor, bare.currency, bare.latestCharge], [null, false, null, null, null, null]);
  // an UNEXPANDED latest_charge keeps only its real id; nothing else is filled in, so it can never prove a capture
  const unexpanded = paymentIntentProofObservation({ ...pi, latest_charge: "ch_1" }, { accountVerified: true });
  assert.deepEqual(unexpanded.latestCharge, { object: null, id: "ch_1", paymentIntent: null, status: null, captured: null, amountMinor: null,
    amountCapturedMinor: null, amountRefundedMinor: null, currency: null, livemode: null });
  const i = base("capture_unknown");
  const evRow = (observed) => ({ id: "e", kind: "payment_intent", readOpType: "stripe.retrieve_payment_intent", requestRef: PI, externalRef: PI, status: "succeeded", observed });
  assert.equal(piCapturedProof(evRow(o), i, ATT), true);
  assert.equal(piCapturedProof(evRow(unexpanded), i, ATT), false);
  assert.equal(piCapturedProof(evRow(bare), i, ATT), false);
  // mistyped provider values stay null (not coerced)
  const odd = paymentIntentProofObservation({ ...pi, amount_received: "90000", livemode: "false", latest_charge: { ...pi.latest_charge, id: 7, captured: "true" } }, { accountVerified: true });
  assert.deepEqual([odd.amountReceivedMinor, odd.livemode, odd.latestCharge.id, odd.latestCharge.captured], [null, null, "7", null]);
  assert.equal(piCapturedProof(evRow(odd), i, ATT), false);
});

test("root (1): an inconclusive read is followed by a read with its ORIGINAL request selector, never a returned entity id", () => {
  const i = base("reservation_unknown");
  const o = op(OP.CREATE, "succeeded");
  const lk = byRef(); const cancelled = byId("cancelled");
  const p1 = plan(i, o, [lk, cancelled]);
  assert.deepEqual([p1.event.type, p1.event.id], ["RECONCILIATION_INCONCLUSIVE", RECOVERY_EVENT_ID.inconclusive("op-1", cancelled.id)]);
  assert.deepEqual(plan(i, o, [lk, cancelled], { appliedEventIds: [p1.event.id] }).read, { opType: "hostaway.retrieve_reservation", ref: RID });
  // a not_found lookup whose recorded externalRef is some provider value: the follow-up lookup still uses the booking ref
  const nf = { ...byRef("not_found", { matchCount: 0 }), externalRef: "7001" };
  const p2 = plan(i, o, [nf]);
  assert.equal(p2.event.type, "RECONCILIATION_INCONCLUSIVE");
  assert.deepEqual(plan(i, o, [nf], { appliedEventIds: [p2.event.id] }).read, { opType: "hostaway.lookup_reservation", ref: "MV-ABC123" });
  // evidence requested with ANOTHER selector is not evidence for this question
  assert.equal(plan(i, o, [{ ...lk, requestRef: "MV-OTHER1" }]).kind, "needs_fresh_read");
  assert.equal(plan(i, o, [lk, { ...byId("found_active"), requestRef: "7002" }]).kind, "needs_fresh_read");
  assert.equal(plan(base("capture_unknown"), capOp("outcome_unknown"), [{ ...piEv("succeeded"), requestRef: "pi_test_other" }]).kind, "needs_fresh_read");
  // a PaymentIntent inconclusive follows up with the PaymentIntent id
  const proc = piEv("processing");
  const p3 = plan(base("capture_unknown"), capOp("outcome_unknown"), [proc]);
  assert.deepEqual(plan(base("capture_unknown"), capOp("outcome_unknown"), [proc], { appliedEventIds: [p3.event.id] }).read, { opType: "stripe.retrieve_payment_intent", ref: PI });
});

test("root (2): both reservation proofs must carry the full, consistent identity; known provider ids must agree", () => {
  for (const st of ["reservation_pending", "reservation_unknown"]) {
    const i = base(st); const o = op(OP.CREATE, "succeeded");
    const good = plan(i, o, [byRef(), byId("found_active")]);
    assert.equal(good.kind, "event", st);
    assert.notEqual(good.event.type, "ESCALATE");
    // contradictory lookup identity, even with a valid by-id read
    for (const over of [{ listingId: 999 }, { from: "2026-12-21" }, { to: "2026-12-25" }, { totalMinor: 1 }, { currency: "MXN" }]) {
      const r = plan(i, o, [byRef("found_active", over), byId("found_active")]);
      assert.deepEqual([r.event.type, r.event.code], ["ESCALATE", "RESERVATION_IDENTITY_MISMATCH"], `${st} ${JSON.stringify(over)}`);
    }
    // lookup externalRef contradicting its observed reservation id
    assert.equal(plan(i, o, [{ ...byRef(), externalRef: "7002" }, byId("found_active")]).event.code, "RESERVATION_IDENTITY_MISMATCH");
    // by-id externalRef / observed id contradicting
    assert.equal(plan(i, o, [byRef(), byId("found_active", { reservationId: "9999" })]).event.code, "RESERVATION_IDENTITY_MISMATCH");
    assert.equal(plan(i, o, [byRef(), byId("found_active", {}, 13, "9999")]).event.code, "RESERVATION_IDENTITY_MISMATCH");
    // known provider-returned ids that disagree with the proven id
    const conflict = plan(i, op(OP.CREATE, "succeeded", { resultRef: "9999" }), [byRef(), byId("found_active")]);
    assert.deepEqual([conflict.event.type, conflict.event.code], ["ESCALATE", "RESERVATION_ID_CONFLICT"], st);
    assert.equal(plan(i, o, [byRef(), byId("found_active")], { knownReservationIds: ["9999"] }).event.code, "RESERVATION_ID_CONFLICT");
    assert.equal(plan(i, op(OP.CREATE, "succeeded", { resultRef: RID }), [byRef(), byId("found_active")], { knownReservationIds: [RID] }).event.type, good.event.type);
    // missing fields on either proof: never a reservation event (not proven), never invented
    for (const k of ["reservationId", "listingId", "from", "to", "totalMinor", "currency"]) {
      const lk = byRef(); delete lk.observed[k];
      const bi = byId("found_active"); delete bi.observed[k];
      for (const evs of [[lk, byId("found_active")], [byRef(), bi]]) {
        const r = plan(i, o, evs);
        assert.ok(!["RESERVATION_SUCCEEDED", "RECONCILED_RESERVATION_FOUND"].includes(r.event?.type), `${st} missing ${k}`);
      }
    }
    // the requested booking ref is never provider proof: no lookup evidence -> a read, whatever the op or attempts row says
    assert.equal(plan(i, op(OP.CREATE, "succeeded", { resultRef: RID }), [byId("found_active")], { knownReservationIds: [RID] }).kind, "needs_fresh_read");
  }
});

test("root (3): a cancellation (or still-active) result needs the same fully identified reservation", () => {
  const cf = base("capture_failed");
  const c = (st) => op(OP.CANCEL, st, { payload: { reservationId: RID, attempt: 1 } });
  for (const st of ["succeeded", "outcome_unknown"]) {
    assert.equal(plan(cf, c(st), [byId("cancelled", { reservationId: "9999" })]).event.code, "CANCEL_IDENTITY_MISMATCH", st);
    assert.equal(plan(cf, c(st), [byId("cancelled", { listingId: 999 })]).event.code, "CANCEL_IDENTITY_MISMATCH", st);
    assert.equal(plan(cf, c(st), [byId("cancelled", { from: "2027-01-01" })]).event.code, "CANCEL_IDENTITY_MISMATCH", st);
    for (const k of ["reservationId", "listingId", "from", "to", "totalMinor", "currency"]) {
      const e = byId("cancelled"); delete e.observed[k];
      const r = plan(cf, c(st), [e]);
      assert.equal(r.event?.type === "RESERVATION_CANCELLED" || r.settle !== undefined, false, `${st} missing ${k}`);
      assert.equal(r.event.type, "RECONCILIATION_INCONCLUSIVE");
      assert.deepEqual(plan(cf, c(st), [e], { appliedEventIds: [r.event.id] }).read, { opType: "hostaway.retrieve_reservation", ref: RID });
    }
  }
  assert.equal(plan(cf, c("outcome_unknown"), [byId("found_active", { totalMinor: 1 })]).event.code, "CANCEL_IDENTITY_MISMATCH");
  const ok = plan(cf, c("outcome_unknown"), [byId("cancelled")]);
  assert.deepEqual([ok.event.type, typeof ok.settle], ["RESERVATION_CANCELLED", "string"]);
});

test("root (4): a captured outcome needs a real, canonical Charge bound to this PaymentIntent", () => {
  const i = base("capture_unknown"); const o = capOp("outcome_unknown");
  assert.equal(plan(i, o, [piEv("succeeded")]).event.type, "RECONCILED_CAPTURE_SUCCEEDED");
  const bad = [
    [{}, { id: null }], [{}, { id: "" }], [{}, { id: "x_1" }], [{}, { id: "ch_" }], [{}, { object: null }], [{}, { object: "refund" }],
    [{}, { status: "pending" }], [{}, { status: null }], [{}, { amountMinor: 1 }], [{}, { amountMinor: null }], [{}, { currency: "MXN" }],
    [{}, { currency: null }], [{}, { paymentIntent: null }], [{ object: null }], [{ object: "setup_intent" }]
  ];
  for (const [over, ch] of bad) {
    const r = plan(i, o, [piEv("succeeded", over, ch)]);
    assert.deepEqual([r.event.type, r.event.code, r.settle], ["ESCALATE", "CAPTURE_PROOF_MISMATCH", undefined], JSON.stringify([over, ch]));
  }
  assert.equal(plan(i, o, [piEv("succeeded", {}, { id: "py_123" })]).event.type, "RECONCILED_CAPTURE_SUCCEEDED");
});
