// E7 recorded TEST cleanup — PURE proofs of the Hostaway offline-refund mirror (lib/checkout/mirror-proof.js). No I/O.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mirrorMarker, mirrorTitle, classifyMirrorTitle, mirrorIntentRefusal, mirrorOpRefusal, assessMirrorList, mirrorDiscovery, buildMirrorRequest, validateMirrorRequest,
  assessMirrorReply, mirrorConfirmingObservation, mirrorCountObservation, MIRROR_EVIDENCE_OBSERVED_KEYS, MIRROR_REFUND_ROW_KEYS, MIRROR_OP, PROOF_MAX_AGE_MS } from "../lib/checkout/mirror-proof.js";
import { offlineChargeTitle } from "../lib/checkout/offline-charge-proof.js";

const ID = "11111111-2222-4333-8444-555555555555"; const RID = "20001"; const OCH = "520001"; const AMT = 576000; const NOW = 1_800_000_000_000;
const intent = (over = {}) => ({ id: ID, version: 9, status: "test_cleanup_pending", listingId: 606998, price: { currency: "USD", finalTotalMinor: AMT }, payment: { paymentIntentId: "pi_test_x", capturedMinor: AMT, livemode: false },
  reservation: { reservationId: RID }, settlement: { reservationCancelled: true, authorizationSettled: true, recordingMirrored: false }, offlineChargeId: OCH, ...over });
const op = (over = {}) => ({ id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", opType: MIRROR_OP, state: "pending", attempts: 0, dispatchedAt: null, idempotencyKey: `ochr:${ID}:1`,
  payload: { reservationId: RID, offlineChargeId: OCH, amountMinor: AMT, currency: "USD" }, resultRef: null, ...over });
const cfg = { accountRef: "acct-test-1", channelId: 2000, currency: "USD", listingId: 606998, paymentMethod: "credit_card", refFieldId: 777004 };
const orig = (over = {}) => ({ id: Number(OCH), reservationId: Number(RID), listingMapId: 606998, type: "charge", title: offlineChargeTitle(ID), amount: 5760, currency: "USD", status: "paid", paymentProvider: "offline", paymentMethod: "credit_card", ...over });
const refund = (over = {}) => ({ id: 520009, reservationId: Number(RID), listingMapId: 606998, type: "refund", title: mirrorTitle(ID), amount: -5760, currency: "USD", status: "succeeded", paymentProvider: "offline", paymentMethod: "credit_card",
  refundInfo: { id: 7, chargeId: 520009, refundedChargeId: Number(OCH) }, ...over });
const read = (rows, over = {}) => ({ accountRef: "acct-test-1", clientSnapshotId: "hostaway-client-test-1", httpStatus: 200, json: { status: "success", result: rows, count: rows.length, limit: 500 }, observedAt: NOW - 1000,
  request: { limit: 500, reservationId: RID }, ...over });
const list = (rows, over = {}, i = intent()) => assessMirrorList({ read: read(rows, over), intent: i, config: cfg, now: NOW });

test("marker / title: own prefix, exact vs lookalike (NFKC, case, zero-width) vs none; the original's marker never classifies as the mirror's", () => {
  assert.equal(mirrorMarker(ID), `mvochr1-${ID}`); assert.equal(mirrorTitle(ID), `maraVilla refund mvochr1-${ID}`); assert.equal(mirrorTitle("x"), null);
  assert.equal(classifyMirrorTitle(mirrorTitle(ID), ID), "exact");
  assert.equal(classifyMirrorTitle(`MARAVILLA REFUND MVOCHR1-${ID.toUpperCase()}​`, ID), "suspicious");
  assert.equal(classifyMirrorTitle(offlineChargeTitle(ID), ID), "none", "the original's mvoch1- marker is not the mirror marker");
  assert.equal(classifyMirrorTitle("unrelated", ID), "none"); assert.equal(classifyMirrorTitle(42, ID), "none");
});

test("intent / op refusals: both legs proven + mirror leg OPEN + canonical ids (never a Stripe id, never the reservation id); the pristine single mirror row", () => {
  assert.equal(mirrorIntentRefusal(intent()), null);
  assert.equal(mirrorIntentRefusal(intent({ settlement: { reservationCancelled: true, authorizationSettled: false, recordingMirrored: false } })), "LEGS_NOT_SETTLED");
  assert.equal(mirrorIntentRefusal(intent({ settlement: { reservationCancelled: true, authorizationSettled: true } })), "MIRROR_LEG_ABSENT");
  assert.equal(mirrorIntentRefusal(intent({ settlement: { reservationCancelled: true, authorizationSettled: true, recordingMirrored: true } })), "MIRROR_ALREADY_SETTLED");
  assert.equal(mirrorIntentRefusal(intent({ offlineChargeId: "ch_test_1" })), "OFFLINE_CHARGE_ID_INVALID");
  assert.equal(mirrorIntentRefusal(intent({ offlineChargeId: RID })), "OFFLINE_CHARGE_ID_IS_RESERVATION");
  assert.equal(mirrorIntentRefusal(intent({ status: "confirmed" })), "NOT_TEST_CLEANUP_PENDING");
  assert.equal(mirrorIntentRefusal(intent({ price: { currency: "MXN", finalTotalMinor: AMT } })), "CURRENCY_NOT_APPROVED");
  assert.equal(mirrorOpRefusal(op(), intent()), null);
  assert.equal(mirrorOpRefusal(op({ idempotencyKey: `ochr:${ID}:2` }), intent()), "NOT_THE_SINGLE_MIRROR_KEY");
  assert.equal(mirrorOpRefusal(op({ payload: { reservationId: RID, offlineChargeId: "520002", amountMinor: AMT, currency: "USD" } }), intent()), "PAYLOAD_OFFLINE_CHARGE_MISMATCH");
  assert.equal(mirrorOpRefusal(op({ attempts: 1, state: "pending" }), intent()), "MIRROR_OP_CLAIMED_OR_SENT");
  assert.equal(mirrorOpRefusal(op({ state: "in_flight", attempts: 1, dispatchedAt: NOW }), intent(), { held: true }), null);
  assert.equal(mirrorOpRefusal(op(), intent(), { held: true }), "MIRROR_OP_NOT_HELD");
});

test("list assessment: complete typed page only; refund links kept typed or null (never dropped); foreign / malformed rows refuse the whole read", () => {
  const l = list([orig(), refund()]);
  assert.equal(l.ok, true); assert.equal(l.rows.length, 2); assert.deepEqual(l.rows[1].link, { id: "7", chargeId: "520009", refundedChargeId: OCH }); assert.equal(l.rows[1].amountMinor, -AMT);
  assert.deepEqual(list([orig(), refund({ refundInfo: { id: "7", chargeId: 520009, refundedChargeId: Number(OCH) } })]).rows[1].link, null, "a string id is not typed");
  assert.equal(list([orig()], { httpStatus: 201 }).code, "LIST_HTTP_STATUS");
  assert.equal(list([orig()], { json: { status: "success", result: [orig()], count: 2 } }).code, "LIST_COUNT_LENGTH_MISMATCH");
  assert.equal(list([orig(), orig()]).code, "LIST_DUPLICATE_ID");
  assert.equal(list([orig({ reservationId: 20002 })]).code, "LIST_FOREIGN_RESERVATION_ROW");
  assert.equal(list([orig({ listingMapId: 1 })]).code, "LIST_FOREIGN_LISTING_ROW");
  assert.equal(list([refund({ amount: 5760 })]).code, "LIST_ROW_AMOUNT_NOT_EXACT", "a positive refund amount is malformed money");
  assert.equal(list([orig({ amount: 57.601 })]).code, "LIST_ROW_AMOUNT_NOT_EXACT");
  assert.equal(list([orig()], { observedAt: NOW - PROOF_MAX_AGE_MS - 1 }).code, "LIST_STALE");
  assert.equal(list([orig()], { request: { limit: 100, reservationId: RID } }).code, "LIST_REQUEST_NOT_CANONICAL");
  assert.equal(list([orig()], { accountRef: "other" }).code, "LIST_ACCOUNT_REF_MISMATCH");
  assert.equal(list([orig()], {}, intent({ settlement: { reservationCancelled: true, authorizationSettled: false, recordingMirrored: false } })).code, "LEGS_NOT_SETTLED");
});

test("pre-send discovery fails CLOSED: original present / unchanged / unique; zero linked, zero marker (exact or lookalike), zero same-amount refund; any untyped refund link → ambiguous HOLD", () => {
  assert.equal(mirrorDiscovery({ list: list([orig()]), intent: intent() }).ok, true);
  assert.equal(mirrorDiscovery({ list: list([orig(), orig({ id: 520002, type: "preAuth", title: "deposit hold", amount: 100 })]), intent: intent() }).ok, true, "unrelated rows are fine");
  const d = (rows) => mirrorDiscovery({ list: list(rows), intent: intent() });
  assert.deepEqual([d([]).code, d([]).hold], ["ORIGINAL_MISSING", true]);
  assert.equal(d([orig({ status: "refunded" })]).code, "ORIGINAL_STATUS");
  assert.equal(d([orig({ amount: 5000 })]).code, "ORIGINAL_AMOUNT");
  assert.equal(d([orig({ title: "maraVilla payment x" })]).code, "ORIGINAL_TITLE");
  assert.equal(d([orig(), orig({ id: 520003, title: `MARAVILLA PAYMENT MVOCH1-${ID}` })]).code, "ORIGINAL_MARKER_NOT_UNIQUE");
  assert.equal(d([orig(), refund()]).code, "MIRROR_ALREADY_LINKED");
  assert.equal(d([orig(), refund({ title: "legacy", refundInfo: undefined, amount: -100 })]).code, "MIRROR_DISCOVERY_AMBIGUOUS");
  assert.equal(d([orig(), refund({ title: `maravilla refund mvochr1-${ID}`, refundInfo: { id: 1, chargeId: 2, refundedChargeId: 3 }, amount: -100 })]).code, "MIRROR_MARKER_PRESENT");
  assert.equal(d([orig(), refund({ title: "other", refundInfo: { id: 1, chargeId: 2, refundedChargeId: 3 } })]).code, "MIRROR_AMOUNT_PRESENT");
  assert.equal(mirrorDiscovery({ list: { rows: [] }, intent: intent() }).code, "COMPLETE_LIST_REQUIRED", "unbranded input");
});

test("request: field-exact POST body (title, full POSITIVE amount, isIncludeInPriceBreakdown 0), path from the pinned reservation / original; validation refuses any change", () => {
  const b = buildMirrorRequest({ intent: intent(), mirrorOp: op() });
  assert.deepEqual(b.request, { method: "POST", path: `/v1/guestPayments/charges/${RID}/${OCH}/refund`, query: {}, body: { title: mirrorTitle(ID), amount: 5760, isIncludeInPriceBreakdown: 0 } });
  const held = op({ state: "in_flight", attempts: 1, dispatchedAt: NOW });
  assert.equal(validateMirrorRequest(b.request, { intent: intent(), mirrorOp: held }).ok, true);
  assert.equal(validateMirrorRequest({ ...b.request, body: { ...b.request.body, amount: 5759 } }, { intent: intent(), mirrorOp: held }).code, "REQUEST_CHANGED");
  assert.equal(validateMirrorRequest(b.request, { intent: intent(), mirrorOp: op() }).code, "MIRROR_OP_NOT_HELD");
  assert.equal(validateMirrorRequest(b.request, { intent: intent({ offlineChargeId: "520002" }), mirrorOp: held }).code, "PAYLOAD_OFFLINE_CHARGE_MISMATCH");
  assert.equal(buildMirrorRequest({ intent: intent({ settlement: { reservationCancelled: true, authorizationSettled: true, recordingMirrored: true } }), mirrorOp: op() }).code, "MIRROR_ALREADY_SETTLED");
});

test("reply is a CANDIDATE only: 200 + success envelope + typed result.id === refundInfo.chargeId, refundedChargeId === original, not the original, succeeded / offline; everything else refused", () => {
  const req = buildMirrorRequest({ intent: intent(), mirrorOp: op() }).request;
  const reply = (result, status = 200) => assessMirrorReply({ reply: { httpStatus: status, json: { status: "success", result } }, request: req, intent: intent() });
  const good = { id: 520009, refundInfo: { id: 7, chargeId: 520009, refundedChargeId: Number(OCH) }, status: "succeeded", paymentProvider: "offline" };
  assert.deepEqual(reply(good), { ok: true, refundId: "520009" });
  assert.equal(reply(good, 201).code, "REPLY_HTTP_STATUS", "an undocumented code is never assumed");
  assert.equal(reply({ ...good, refundInfo: { id: 7, chargeId: Number(OCH), refundedChargeId: 520009 } }).code, "REPLY_REFUNDED_ID_NOT_ORIGINAL", "inverted ids");
  assert.equal(reply({ ...good, refundInfo: { id: 7, chargeId: 520010, refundedChargeId: Number(OCH) } }).code, "REPLY_ID_NOT_LINK_CHARGE_ID");
  assert.equal(reply({ ...good, id: Number(OCH), refundInfo: { id: 7, chargeId: Number(OCH), refundedChargeId: Number(OCH) } }).code, "REPLY_ID_IS_ORIGINAL");
  assert.equal(reply({ ...good, refundInfo: { id: "7", chargeId: 520009, refundedChargeId: Number(OCH) } }).code, "REPLY_LINK_UNTYPED");
  assert.equal(reply({ id: 520009, status: "succeeded", paymentProvider: "offline" }).code, "REPLY_LINK_MISSING");
  assert.equal(reply({ ...good, status: "pending" }).code, "REPLY_STATUS"); assert.equal(reply({ ...good, paymentProvider: "stripe" }).code, "REPLY_PROVIDER");
  assert.equal(reply({ ...good, id: "520009" }).code, "REPLY_ID_UNTYPED");
  assert.equal(assessMirrorReply({ reply: { httpStatus: 200, json: { status: "fail" } }, request: req, intent: intent() }).code, "REPLY_FAIL_ENVELOPE");
});

test("confirming observation: exactly ONE row typed-linked to the original and it IS the candidate, link.chargeId = its id, unique exact mirror title, succeeded / offline / full NEGATIVE amount / currency, original unchanged → the exact 0021 key set; each deviation refused", () => {
  const o = mirrorConfirmingObservation({ list: list([orig(), refund()]), intent: intent(), refundId: "520009" });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.deepEqual(Object.keys(o.observed).sort(), [...MIRROR_EVIDENCE_OBSERVED_KEYS].sort()); assert.deepEqual(Object.keys(o.observed.refundRow).sort(), [...MIRROR_REFUND_ROW_KEYS].sort());
  assert.deepEqual([o.observed.matchingChargeIds, o.observed.matchingRefundIds, o.observed.linkedRefundCount, o.observed.refundRow.amountMinor, o.observed.refundRow.refundInfo], [[OCH], ["520009"], 1, -AMT, { chargeId: "520009", id: "7", refundedChargeId: OCH }]);
  const c = (rows, refundId = "520009") => mirrorConfirmingObservation({ list: list(rows), intent: intent(), refundId }).code;
  assert.equal(c([orig()]), "LINKED_ROW_MISSING");
  assert.equal(c([orig(), refund(), refund({ id: 520010, refundInfo: { id: 8, chargeId: 520010, refundedChargeId: Number(OCH) } })]), "LINKED_ROW_DUPLICATE");
  assert.equal(c([orig(), refund()], "520010"), "LINKED_ROW_NOT_THE_REPLY");
  assert.equal(c([orig(), refund({ refundInfo: { id: 7, chargeId: 520010, refundedChargeId: Number(OCH) } })]), "LINK_CHARGE_ID_NOT_ROW");
  assert.equal(c([orig(), refund({ amount: -2000 })]), "MIRROR_ROW_AMOUNT"); assert.equal(c([orig(), refund({ status: "pending" })]), "MIRROR_ROW_STATUS");
  assert.equal(c([orig(), refund({ paymentProvider: "stripe" })]), "MIRROR_ROW_PROVIDER"); assert.equal(c([orig(), refund({ currency: "MXN" })]), "MIRROR_ROW_CURRENCY");
  assert.equal(c([orig(), refund({ title: `${mirrorTitle(ID)}​` })]), "MIRROR_TITLE_NOT_UNIQUE_EXACT", "lookalike title");
  assert.equal(c([orig(), refund(), refund({ id: 520011, title: mirrorTitle(ID), amount: -100, refundInfo: { id: 9, chargeId: 520011, refundedChargeId: 999 } })]), "MIRROR_TITLE_NOT_UNIQUE_EXACT", "a second marker row");
  assert.equal(c([orig(), refund(), refund({ id: 520012, title: "legacy", amount: -100, refundInfo: undefined })]), "LINK_UNTYPED");
  assert.equal(c([orig({ status: "refunded" }), refund()]), "ORIGINAL_STATUS");
  assert.equal(c([orig(), refund()], OCH), "REFUND_ID_IS_ORIGINAL");
  const count = mirrorCountObservation({ list: list([orig(), refund()]), intent: intent() });
  assert.deepEqual([count.matchingChargeCount, count.matchingChargeIds, count.lookalikeCount, count.rowCount, count.complete], [1, [OCH], 0, 2, true]);
});
