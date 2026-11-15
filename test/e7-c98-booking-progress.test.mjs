// C98 — the additive READ-ONLY bookingProgress projection (lib/checkout/intent-api-core.js bookingProgress). Pure; no DB, no network.
// publicStatus / the state machine are UNCHANGED: "confirmed" still covers payment_captured AND confirmed; only the projection tells them apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bookingProgress, BOOKING_STAGES } from "../lib/checkout/intent-api-core.js";
import { publicStatus, STATES as S } from "../lib/checkout/intent-state.js";

const base = (o = {}) => ({ id: "11111111-2222-4333-8444-555555555555", ref: "MV-VBQL2LQY", status: S.CONFIRMED, price: { currency: "USD", finalTotalMinor: 14000 },
  payment: { paymentIntentId: "pi_x", capturedMinor: 14000 }, reservation: { reservationId: "71789623" }, offlineChargeId: "35735899", ...o });

test("P1 complete ONLY with confirmed + bound reservation id + capturedMinor == final total + linked offline charge id; the ONE exposed identifier is the guest's own ref; output frozen with exactly {stage, bookingRef}", () => {
  const p = bookingProgress(base());
  assert.deepEqual(p, { stage: "complete", bookingRef: "MV-VBQL2LQY" }); assert.ok(Object.isFrozen(p)); assert.deepEqual(Object.keys(p), ["stage", "bookingRef"]);
  assert.deepEqual(bookingProgress(base({ reservation: { reservationId: 71789623 } })).stage, "complete", "a safe-integer id (pg bigint as number) is accepted");
  assert.doesNotMatch(JSON.stringify(p), /pi_|71789623|35735899|11111111/, "no PI / reservation / charge / intent id");
  assert.deepEqual(BOOKING_STAGES, ["not_paid", "processing", "payment_received_finalizing", "complete", "needs_review", "ended"]);
});

test("P2 malformed / missing / conflicting proof facts are NEVER complete (needs_review, no ref)", () => {
  for (const [label, o] of [["no reservation", { reservation: null }], ["reservation id 0", { reservation: { reservationId: "0" } }], ["reservation id text", { reservation: { reservationId: "abc" } }],
    ["reservation id fraction", { reservation: { reservationId: 1.5 } }], ["reservation id object", { reservation: { reservationId: {} } }], ["no offline charge", { offlineChargeId: null }],
    ["offline charge empty", { offlineChargeId: "" }], ["offline charge text", { offlineChargeId: "och:1" }], ["captured short", { payment: { capturedMinor: 13999 } }],
    ["captured over", { payment: { capturedMinor: 14001 } }], ["captured missing", { payment: { capturedMinor: null } }], ["captured string", { payment: { capturedMinor: "14000" } }],
    ["no payment", { payment: null }], ["no price", { price: null }], ["total zero", { price: { finalTotalMinor: 0 }, payment: { capturedMinor: 0 } }],
    ["total negative", { price: { finalTotalMinor: -1 }, payment: { capturedMinor: -1 } }], ["ref malformed", { ref: "MV-x" }], ["ref missing", { ref: null }], ["ref injected", { ref: "<b>MV-VBQL2LQY</b>" }]]) {
    assert.deepEqual(bookingProgress(base(o)), { stage: "needs_review", bookingRef: null }, label);
  }
});

test("P3 payment_captured is payment_received_finalizing (never complete), and needs_review when the captured amount does not match; publicStatus still says 'confirmed' for both (unchanged)", () => {
  const cap = base({ status: S.PAYMENT_CAPTURED, offlineChargeId: null });
  assert.deepEqual(bookingProgress(cap), { stage: "payment_received_finalizing", bookingRef: null });
  assert.deepEqual(bookingProgress({ ...cap, offlineChargeId: "35735899" }), { stage: "payment_received_finalizing", bookingRef: null }, "even with a charge id: the state is not confirmed");
  assert.equal(bookingProgress(base({ status: S.PAYMENT_CAPTURED, payment: { capturedMinor: 1 } })).stage, "needs_review");
  assert.deepEqual([publicStatus(cap), publicStatus(base())], ["confirmed", "confirmed"], "publicStatus semantics unchanged");
});

test("P4 every state maps into the closed enum: uncertain / queued-release states stay processing; reconciliation / unknown / non-object are needs_review; terminal no-charge states are ended", () => {
  const want = { created: "not_paid", price_confirmed: "not_paid", details_collected: "not_paid", payment_pending: "not_paid", payment_authorized: "processing",
    reservation_pending: "processing", reservation_unknown: "processing", reservation_confirmed: "processing", capture_unknown: "processing", reservation_failed: "processing",
    capture_failed: "processing", test_cleanup_pending: "processing", authorization_released: "ended", cancelled: "ended", payment_failed: "ended", payment_expired: "ended",
    expired: "ended", validation_failed: "ended", reconciliation_required: "needs_review" };
  for (const st of Object.values(S)) if (st !== S.CONFIRMED && st !== S.PAYMENT_CAPTURED) assert.ok(Object.hasOwn(want, st), `state ${st} is covered`);
  for (const [st, stage] of Object.entries(want)) {
    const p = bookingProgress(base({ status: st }));
    assert.deepEqual(p, { stage, bookingRef: null }, st); assert.ok(BOOKING_STAGES.includes(p.stage));
  }
  for (const x of [null, undefined, 1, "confirmed", [], {}, { status: 7 }, { status: "made_up" }]) assert.deepEqual(bookingProgress(x), { stage: "needs_review", bookingRef: null }, String(JSON.stringify(x)));
});
