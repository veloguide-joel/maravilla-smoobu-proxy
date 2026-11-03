// Stage E7.4b-0 — pure offline-charge proof. Contract: claude/e74b-evidence-contract.md revision 2 (§5–§7, P1–P14).
// EVERY provider fixture below is DOC-DERIVED / SYNTHETIC (shapes from https://api.hostaway.com/documentation as read on
// 2026-11-03: #get-guest-charges-list, #create-offline-charge, Retrieve a reservation). NONE is live-verified.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as P from "../lib/checkout/offline-charge-proof.js";
import { PROTECTED_HOSTAWAY_RESERVATION_IDS } from "../lib/checkout/compensation-proof.js";

const INTENT_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OTHER_INTENT = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const OP_ID = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const NOW = Date.UTC(2027, 0, 5, 13, 0, 0);
const RECORDED = Date.UTC(2027, 0, 5, 12, 30, 45, 678);
const cfg = (o = {}) => ({ accountRef: "acct-test-1", channelId: 2000, currency: "USD", listingId: 990001, paymentMethod: "credit_card", refFieldId: 777007, ...o });
const intent = (o = {}) => ({ intentId: INTENT_ID, status: "payment_captured", version: 7, ref: "MV-ABC123", listingId: 990001, from: "2027-02-10", to: "2027-02-14",
  finalTotalMinor: 123456, capturedMinor: 123456, currency: "USD", reservationId: "88000001", recordedPaymentAt: RECORDED, ...o });
const op = (o = {}) => ({ id: OP_ID, opType: "hostaway.record_offline_charge", state: "pending", attempts: 0, dispatchedAt: null,
  idempotencyKey: `och:${INTENT_ID}:1`, payload: { reservationId: "88000001", amountMinor: 123456 }, ...o });
const TITLE = `maraVilla payment mvoch1-${INTENT_ID}`;

// DOC-DERIVED / SYNTHETIC reservation object (Retrieve a reservation)
const resv = (o = {}) => ({ id: 88000001, listingMapId: 990001, channelId: 2000, arrivalDate: "2027-02-10", departureDate: "2027-02-14", totalPrice: 1234.56,
  currency: "USD", status: "new", customFieldValues: [{ customFieldId: 777007, value: "MV-ABC123" }], ...o });
const snap = (o = {}, r = {}) => ({ accountRef: "acct-test-1", clientSnapshotId: "client-A", observedAt: NOW - 1000, httpStatus: 200,
  json: { status: "success", result: resv(r) }, ...o });
// DOC-DERIVED / SYNTHETIC guest charge rows (#guest-charge-object)
const row = (o = {}) => ({ id: 501, listingMapId: 990001, reservationId: 88000001, autopaymentId: null, type: "charge", title: "Accommodation payment",
  description: null, currency: "USD", paymentMethod: "credit_card", amount: 10, capturedAmount: 0, status: "paid", paymentProvider: "offline",
  transactions: [], ...o });
const list = (rows, o = {}, jo = {}) => ({ accountRef: "acct-test-1", clientSnapshotId: "client-A", observedAt: NOW - 500, httpStatus: 200,
  request: { reservationId: "88000001", limit: 500 }, json: { status: "success", result: rows, count: rows.length, offset: null, ...jo }, ...o });

const identityOk = (o = {}) => P.assessIdentitySnapshot({ snapshot: snap(), intent: intent(), config: cfg(), now: NOW, ...o });
const listOk = (rows = [], o = {}) => P.assessChargeList({ read: list(rows), intent: intent(), config: cfg(), now: NOW, ...o });
const eligible = () => P.qualifyPreflight({ identity: identityOk(), list: listOk([row()]), intent: intent(), recordingOp: op(), config: cfg(), now: NOW });
const built = () => P.buildOfflineChargeRequest({ eligibility: eligible(), intent: intent(), recordingOp: op(), config: cfg(), now: NOW });
const reply = (o = {}) => ({ httpStatus: 200, json: { status: "success", result: row({ id: 777, title: TITLE, amount: 1234.56, isManual: 0, ...o }) } });

// ---------------------------------------------------------------------------------------------
test("module header states its limits; imports stay pure (no I/O / env / clock)", () => {
  const src = readFileSync(new URL("../lib/checkout/offline-charge-proof.js", import.meta.url), "utf8");
  for (const s of ["execution provenance", "account authentication", "current DB facts", "snapshot completeness", "AUTHORIZATION TO SEND", "LABELS"]) assert.ok(src.includes(s), s);
  assert.deepEqual([...src.matchAll(/^import .* from "([^"]+)";?$/gm)].map((m) => m[1]).concat([...src.matchAll(/from "([^"]+)";\n/g)].map((m) => m[1])).filter((v, i, a) => a.indexOf(v) === i).sort(),
    ["../hostaway-reservations.js", "./compensation-proof.js"].sort());
  for (const bad of ["Date.now", "new Date()", "process.env", "fetch(", "node:"]) assert.equal(src.includes(bad), false, bad);
});

test("P1 marker / title: exact canonical format from a lower-case UUID only", () => {
  assert.equal(P.offlineChargeMarker(INTENT_ID), `mvoch1-${INTENT_ID}`);
  assert.equal(P.offlineChargeTitle(INTENT_ID), TITLE);
  assert.equal(TITLE.length, 61);
  assert.ok(/^[\x20-\x7e]+$/.test(TITLE));
  for (const bad of [INTENT_ID.toUpperCase(), INTENT_ID.replace(/-/g, ""), ` ${INTENT_ID}`, `${INTENT_ID}x`, "", null, 7, undefined]) {
    assert.equal(P.offlineChargeMarker(bad), null, String(bad)); assert.equal(P.offlineChargeTitle(bad), null);
  }
});

test("P2 title equality is exact; substrings / look-alikes are SUSPICIOUS, never absent", () => {
  assert.equal(P.classifyTitle(TITLE, INTENT_ID), "exact");
  for (const t of [`${TITLE} `, ` ${TITLE}`, `${TITLE}x`, TITLE.toUpperCase(), `refund ${TITLE}`, `mvoch1-${INTENT_ID}`, TITLE.replace("-", "‑") + ` mvoch1-${INTENT_ID}`,
    `maraVilla payment MVOCH1-${INTENT_ID}`, `maraVilla payment mvoch1-${INTENT_ID.replace(/-/g, "")}`, `maraVilla payment mvoch1-​${INTENT_ID}`,
    `maraVilla payment ｍｖｏｃｈ１-${INTENT_ID}`]) assert.equal(P.classifyTitle(t, INTENT_ID), "suspicious", JSON.stringify(t));
  assert.equal(P.classifyTitle("Accommodation payment", INTENT_ID), "none");
  assert.equal(P.classifyTitle(`maraVilla payment mvoch1-${OTHER_INTENT}`, INTENT_ID), "none");
  assert.equal(P.classifyTitle(undefined, INTENT_ID), "none");
});

test("P3 ids: provider ids are safe positive JSON integers; internal ids canonical decimal strings", () => {
  assert.equal(P.providerIdToCanonical(88000001), "88000001");
  for (const v of [0, -1, 1.5, "88000001", 2 ** 53, Number.MAX_SAFE_INTEGER + 2, NaN, null, undefined, 1e21]) assert.equal(P.providerIdToCanonical(v), null, String(v));
  assert.equal(P.isCanonicalId("88000001"), true);
  for (const s of ["088000001", "+1", "1e3", " 1", "1 ", "0", "-5", "9007199254740993", "1.0", "", 5]) assert.equal(P.isCanonicalId(s), false, String(s));
});

test("P4/P5 list assessment: malformed counts, duplicates, foreign rows -> incomplete/untrusted", () => {
  assert.equal(listOk([row(), row({ id: 502 })]).ok, true);
  assert.equal(listOk([]).ok, true);
  const bad = (rows, o, jo) => P.assessChargeList({ read: list(rows, o, jo), intent: intent(), config: cfg(), now: NOW }).code;
  assert.equal(bad([row()], {}, { count: 2 }), "LIST_COUNT_LENGTH_MISMATCH");
  assert.equal(bad([row()], {}, { count: "1" }), "LIST_COUNT_INVALID");
  assert.equal(bad([row()], {}, { count: 1.5 }), "LIST_COUNT_INVALID");
  assert.equal(bad([], {}, { count: -1 }), "LIST_COUNT_INVALID");
  assert.equal(bad([], {}, { count: 501 }), "LIST_COUNT_INVALID");
  assert.equal(bad([row()], {}, { count: undefined }), "LIST_COUNT_INVALID");
  assert.equal(bad([row(), row()]), "LIST_DUPLICATE_ID");
  assert.equal(bad([row({ reservationId: 88000002 })]), "LIST_FOREIGN_RESERVATION_ROW");          // silent filter failure
  assert.equal(bad([row({ reservationId: "88000001" })]), "LIST_FOREIGN_RESERVATION_ROW");        // string id at the boundary
  assert.equal(bad([row({ listingMapId: 990002 })]), "LIST_FOREIGN_LISTING_ROW");
  assert.equal(bad([row({ id: 2 ** 53 })]), "LIST_ROW_ID_INVALID");
  assert.equal(bad([row({ id: "501" })]), "LIST_ROW_ID_INVALID");
  assert.equal(bad([row({ title: null })]), "LIST_ROW_TITLE_INVALID");
  assert.equal(bad([row({ amount: "10" })]), "LIST_ROW_AMOUNT_INVALID");
  assert.equal(bad([5]), "LIST_ROW_MALFORMED");
  const sparse = [row()]; sparse.length = 2;
  assert.equal(bad(sparse, {}, { count: 2 }), "LIST_ROW_MALFORMED");
  assert.equal(bad([], { httpStatus: 201 }), "LIST_HTTP_STATUS");
  assert.equal(bad([], { request: { reservationId: "88000001", limit: 100 } }), "LIST_REQUEST_NOT_CANONICAL");
  assert.equal(bad([], { request: { reservationIds: ["88000001"], limit: 500 } }), "LIST_REQUEST_NOT_CANONICAL");
  assert.equal(bad([], { request: { reservationId: "88000002", limit: 500 } }), "LIST_REQUEST_NOT_CANONICAL");
  assert.equal(bad([], { accountRef: "acct-other" }), "LIST_ACCOUNT_REF_MISMATCH");
  assert.equal(bad([], { json: { status: "fail", result: "x" } }), "LIST_FAIL_ENVELOPE");
  assert.equal(bad([], { json: { status: "success", result: {}, count: 0 } }), "LIST_RESULT_NOT_ARRAY");
  assert.equal(bad([], { extra: 1 }), "LIST_READ_SHAPE");
  // a refund row (negative amount) is a valid row with no exact positive amount
  const r = listOk([row({ id: 9, type: "refund", amount: -10, status: "succeeded" })]);
  assert.equal(r.ok, true); assert.equal(r.rows[0].amountMinor, -1000);
  // malformed money is untrusted (never "absent"): non-round-trippable paid charges, negative charges, positive refunds, unknown types
  assert.equal(bad([row({ amount: 1234.567 })]), "LIST_ROW_AMOUNT_NOT_EXACT");
  assert.equal(bad([row({ amount: -10 })]), "LIST_ROW_AMOUNT_NOT_EXACT");
  assert.equal(bad([row({ type: "refund", amount: 10 })]), "LIST_ROW_AMOUNT_NOT_EXACT");
  assert.equal(bad([row({ type: "refund", amount: -10.001 })]), "LIST_ROW_AMOUNT_NOT_EXACT");
  assert.equal(bad([row({ amount: 1e21 })]), "LIST_ROW_AMOUNT_NOT_EXACT");
  assert.equal(bad([row({ amount: Infinity })]), "LIST_ROW_AMOUNT_INVALID");
  assert.equal(bad([row({ type: "deposit" })]), "LIST_ROW_TYPE_UNKNOWN");
});

test("freshness: inclusive max age, future / invalid / missing times refused", () => {
  const at = (t) => P.assessChargeList({ read: list([], { observedAt: t }), intent: intent(), config: cfg(), now: NOW }).code ?? "OK";
  assert.equal(at(NOW), "OK");
  assert.equal(at(NOW - P.SNAPSHOT_MAX_AGE_MS), "OK");
  assert.equal(at(NOW - P.SNAPSHOT_MAX_AGE_MS - 1), "LIST_STALE");
  assert.equal(at(NOW + 1), "LIST_OBSERVED_IN_FUTURE");
  for (const t of [0, -5, 1.5, NaN, null, undefined, "1"]) assert.equal(at(t), "LIST_OBSERVED_AT_INVALID", String(t));
  assert.equal(P.assessChargeList({ read: list([]), intent: intent(), config: cfg(), now: undefined }).code, "LIST_NOW_INVALID");
});

test("P6 money and currency: exact USD; amount round-trip; overflow / rounding refused", () => {
  assert.equal(P.exactAmount(123456), 1234.56); assert.equal(P.exactAmount(100), 1); assert.equal(P.exactAmount(5), 0.05); assert.equal(P.exactAmount(1010), 10.1);
  for (const v of [0, -1, 1.5, Number.MAX_SAFE_INTEGER, "100", null]) assert.equal(P.exactAmount(v), null, String(v));
  assert.equal(P.intentRefusal(intent({ currency: "MXN" }), cfg()), "CURRENCY_MISMATCH");
  assert.equal(P.configRefusal(cfg({ currency: "MXN" })), "CURRENCY_NOT_APPROVED");
  assert.equal(P.configRefusal(cfg({ currency: "usd" })), "CURRENCY_NOT_APPROVED");
  assert.equal(P.intentRefusal(intent({ capturedMinor: 123455 }), cfg()), "CAPTURED_NOT_EXACT_TOTAL");
  assert.equal(P.intentRefusal(intent({ finalTotalMinor: Number.MAX_SAFE_INTEGER, capturedMinor: Number.MAX_SAFE_INTEGER }), cfg()), "AMOUNT_NOT_EXACT");
  for (const cur of ["usd", "MXN", undefined, " USD"]) {
    assert.equal(P.assessIdentitySnapshot({ snapshot: snap({}, { currency: cur }), intent: intent(), config: cfg(), now: NOW }).code, "IDENTITY_CURRENCY_MISMATCH", String(cur));
  }
});

test("P7 scheduledDate: formatted from the supplied recorded-payment time (UTC, seconds); missing -> refuse; never a guessed now", () => {
  assert.equal(P.formatScheduledDate(RECORDED), "2027-01-05 12:30:45");
  assert.equal(P.formatScheduledDate(Date.UTC(2027, 11, 31, 23, 59, 59, 999)), "2027-12-31 23:59:59");
  for (const v of [null, undefined, 0, -1, 1.5, "2027-01-05", 8.64e15 + 1]) assert.equal(P.formatScheduledDate(v), null, String(v));
  assert.equal(P.formatScheduledDate(253402300800000), null);                                      // year 10000: not YYYY
  assert.equal(P.intentRefusal(intent({ recordedPaymentAt: null }), cfg()), "RECORDED_PAYMENT_TIME_REQUIRED");
  const b = built();
  assert.equal(b.request.body.scheduledDate, "2027-01-05 12:30:45");
});

test("P8 paymentMethod: explicit, approved, no default; unset or unapproved fails closed everywhere", () => {
  const { paymentMethod, ...noMethod } = cfg();
  assert.equal(P.configRefusal(noMethod), "PAYMENT_METHOD_UNSET");
  assert.equal(P.configRefusal(cfg({ paymentMethod: undefined })), "PAYMENT_METHOD_UNSET");
  assert.equal(P.configRefusal(cfg({ paymentMethod: null })), "PAYMENT_METHOD_UNSET");
  for (const m of ["credit_card_online", "cash", "", "CREDIT_CARD", "payment_link"]) assert.equal(P.configRefusal(cfg({ paymentMethod: m })), "PAYMENT_METHOD_NOT_APPROVED", m);
  assert.equal(P.configRefusal(cfg({ paymentMethod: "other" })), null);
  assert.equal(P.assessIdentitySnapshot({ snapshot: snap(), intent: intent(), config: noMethod, now: NOW }).code, "PAYMENT_METHOD_UNSET");
  assert.equal(P.configRefusal(cfg({ channelId: 2002 })), "CHANNEL_NOT_DIRECT");
  assert.equal(P.configRefusal(cfg({ listingId: 603566 })), "ADAPTER_CONFIG_PILOT_LISTING_FORBIDDEN");
  assert.equal(P.configRefusal(cfg({ extra: 1 })), "CONFIG_SHAPE");
  assert.equal(P.configRefusal(cfg({ accountRef: "" })), "ACCOUNT_REF_INVALID");
});

test("P9 identity snapshot: every field individually; cancelled / stale / other account refused", () => {
  assert.equal(identityOk().ok, true);
  const code = (o, r) => P.assessIdentitySnapshot({ snapshot: snap(o, r), intent: intent(), config: cfg(), now: NOW }).code;
  assert.equal(code({}, { id: 88000002 }), "IDENTITY_RESERVATION_ID_MISMATCH");
  assert.equal(code({}, { listingMapId: 990002 }), "IDENTITY_LISTING_MISMATCH");
  assert.equal(code({}, { channelId: 2002 }), "IDENTITY_CHANNEL_MISMATCH");
  assert.equal(code({}, { arrivalDate: "2027-02-11" }), "IDENTITY_ARRIVAL_MISMATCH");
  assert.equal(code({}, { departureDate: "2027-02-15" }), "IDENTITY_DEPARTURE_MISMATCH");
  assert.equal(code({}, { totalPrice: 1234.55 }), "IDENTITY_TOTAL_MISMATCH");
  assert.equal(code({}, { totalPrice: 1234.567 }), "IDENTITY_AMOUNT_NOT_EXACT");
  assert.equal(code({}, { customFieldValues: [{ customFieldId: 777007, value: "MV-XYZ999" }] }), "IDENTITY_REF_MISMATCH");
  assert.equal(code({}, { customFieldValues: [] }), "IDENTITY_REF_MISMATCH");                       // ref required, not optional
  assert.equal(code({}, { status: "cancelled" }), "IDENTITY_STATUS_NOT_ACTIVE");
  assert.equal(code({}, { status: "modified" }), "IDENTITY_STATUS_NOT_ACTIVE");                     // conservative v1: new only
  assert.equal(code({}, { id: "88000001" }), "IDENTITY_RESERVATION_ID_INVALID");
  assert.equal(code({ accountRef: "acct-other" }), "IDENTITY_ACCOUNT_REF_MISMATCH");
  assert.equal(code({ clientSnapshotId: "" }), "IDENTITY_CLIENT_LABEL_INVALID");
  assert.equal(code({ observedAt: NOW - P.SNAPSHOT_MAX_AGE_MS - 1 }), "IDENTITY_STALE");
  assert.equal(code({ observedAt: NOW + 1 }), "IDENTITY_OBSERVED_IN_FUTURE");
  assert.equal(code({ httpStatus: 404 }), "IDENTITY_HTTP_STATUS");
  assert.equal(code({ json: { status: "fail", result: "x" } }), "IDENTITY_FAIL_ENVELOPE");
  assert.equal(code({ json: { status: "success", result: [] } }), "IDENTITY_RESULT_NOT_OBJECT");
  assert.equal(P.assessIdentitySnapshot({ snapshot: snap(), intent: intent({ reservationId: PROTECTED_HOSTAWAY_RESERVATION_IDS[0] }), config: cfg(), now: NOW }).code,
    "PROTECTED_RESERVATION_ID");
  assert.equal(P.assessIdentitySnapshot({ snapshot: snap(), intent: intent({ status: "confirmed" }), config: cfg(), now: NOW }).code, "NOT_PAYMENT_CAPTURED");
});

test("P10 wrong account: a valid EMPTY list without a positive identity snapshot is never eligible", () => {
  const empty = listOk([]);
  assert.equal(empty.ok, true);
  const q = (identity, l = empty) => P.qualifyPreflight({ identity, list: l, intent: intent(), recordingOp: op(), config: cfg(), now: NOW });
  assert.equal(q(undefined).code, "POSITIVE_IDENTITY_REQUIRED");
  assert.equal(q({ ...identityOk() }).code, "POSITIVE_IDENTITY_REQUIRED");                          // cloned / forged
  assert.equal(q(Object.freeze({ ok: true, kind: "identity", reservationId: "88000001", accountRef: "acct-test-1", clientSnapshotId: "client-A", observedAt: NOW })).code,
    "POSITIVE_IDENTITY_REQUIRED");
  assert.equal(q(identityOk(), { ...empty }).code, "COMPLETE_LIST_REQUIRED");
  // different client labels between identity and list
  const otherClient = P.assessChargeList({ read: list([], { clientSnapshotId: "client-B" }), intent: intent(), config: cfg(), now: NOW });
  assert.equal(q(identityOk(), otherClient).code, "CLIENT_LABEL_BINDING_MISMATCH");
  // identity issued for another config account cannot be used with this config
  const idOther = P.assessIdentitySnapshot({ snapshot: snap({ accountRef: "acct-test-2" }), intent: intent(), config: cfg({ accountRef: "acct-test-2" }), now: NOW });
  assert.equal(q(idOther).code, "ACCOUNT_REF_BINDING_MISMATCH");
  // identity for another reservation
  const idRes = P.assessIdentitySnapshot({ snapshot: snap({}, { id: 88000009 }), intent: intent({ reservationId: "88000009" }), config: cfg(), now: NOW });
  assert.equal(q(idRes).code, "RESERVATION_BINDING_MISMATCH");
  // with a positive identity the same empty list IS (qualified) eligible
  const e = q(identityOk());
  assert.equal(e.ok, true); assert.equal(e.qualified, P.QUALIFIED_RESULT); assert.equal(e.sendAuthorization, false);
});

test("P11 preflight table: marker present / look-alike / same-amount unmarked paid -> case-only; incomplete -> not eligible", () => {
  const q = (rows) => P.qualifyPreflight({ identity: identityOk(), list: listOk(rows), intent: intent(), recordingOp: op(), config: cfg(), now: NOW });
  assert.deepEqual([q([row({ title: TITLE })]).code, q([row({ title: TITLE })]).disposition], ["PRIOR_RECORDING_MARKER_PRESENT", "case_only"]);
  assert.equal(q([row({ title: TITLE, status: "cancelled" })]).code, "PRIOR_RECORDING_MARKER_PRESENT");
  assert.equal(q([row({ title: `${TITLE}!` })]).code, "MARKER_LOOKALIKE_CONFLICT");
  assert.equal(q([row({ title: TITLE.toUpperCase() })]).code, "MARKER_LOOKALIKE_CONFLICT");
  assert.equal(q([row({ amount: 1234.56 })]).code, "SAME_AMOUNT_PAID_UNMARKED_CONFLICT");
  assert.equal(q([row({ amount: 1234.56, status: "awaiting" })]).ok, true);                        // not paid: no conflict
  assert.equal(q([row({ amount: -1234.56, type: "refund", status: "succeeded" })]).ok, true);      // lawful refund row: no conflict
  assert.equal(q([row({ amount: 1234.56, type: "refund" })]).code, "COMPLETE_LIST_REQUIRED");          // positive refund = malformed money
  assert.equal(q([row()]).ok, true);
  const inc = P.qualifyPreflight({ identity: identityOk(), list: P.assessChargeList({ read: list([row(), row()]), intent: intent(), config: cfg(), now: NOW }),
    intent: intent(), recordingOp: op(), config: cfg(), now: NOW });
  assert.deepEqual([inc.code, inc.disposition], ["COMPLETE_LIST_REQUIRED", "not_eligible"]);
  // recording row bindings
  const qo = (o) => P.qualifyPreflight({ identity: identityOk(), list: listOk([]), intent: intent(), recordingOp: op(o), config: cfg(), now: NOW }).code;
  assert.equal(qo({ idempotencyKey: `och:${INTENT_ID}:2` }), "NOT_INITIAL_ATTEMPT");                // attempt > 1 is never eligible
  assert.equal(qo({ attempts: 1 }), "RECORDING_OP_CLAIMED_OR_SENT");
  assert.equal(qo({ dispatchedAt: NOW - 5 }), "RECORDING_OP_CLAIMED_OR_SENT");
  assert.equal(qo({ state: "in_flight" }), "RECORDING_OP_CLAIMED_OR_SENT");
  assert.equal(qo({ payload: { reservationId: "88000001", amountMinor: 123457 } }), "PAYLOAD_AMOUNT_MISMATCH");
  assert.equal(qo({ payload: { reservationId: "88000002", amountMinor: 123456 } }), "PAYLOAD_RESERVATION_MISMATCH");
  assert.equal(qo({ payload: { reservationId: "88000001", amountMinor: 123456, currency: "USD" } }), "RECORDING_PAYLOAD_SHAPE");
  assert.equal(qo({ opType: "hostaway.create_reservation" }), "NOT_A_RECORDING_OP");
  // stale carried observations
  const old = P.assessIdentitySnapshot({ snapshot: snap({ observedAt: NOW - 100000 }), intent: intent(), config: cfg(), now: NOW });
  assert.equal(P.qualifyPreflight({ identity: old, list: listOk([]), intent: intent(), recordingOp: op(), config: cfg(), now: NOW + 30000 }).code, "IDENTITY_STALE");
});

test("request: frozen, built only from a branded eligibility; exact five fields; immutable / forged / changed snapshots refused", () => {
  const b = built();
  assert.equal(b.ok, true); assert.equal(b.sendAuthorization, false);
  assert.deepEqual(b.request, { method: "POST", path: "/v1/guestPayments/charges/88000001", query: {},
    body: { title: TITLE, amount: 1234.56, paymentMethod: "credit_card", status: "paid", scheduledDate: "2027-01-05 12:30:45" } });
  assert.ok(Object.isFrozen(b.request) && Object.isFrozen(b.request.body));
  assert.equal("currency" in b.request.body || "description" in b.request.body, false);
  const e = eligible();
  const B = (o) => P.buildOfflineChargeRequest({ eligibility: e, intent: intent(), recordingOp: op(), config: cfg(), now: NOW, ...o });
  assert.equal(B({ eligibility: { ...e } }).code, "ELIGIBILITY_REQUIRED");
  assert.equal(B({ eligibility: JSON.parse(JSON.stringify(e)) }).code, "ELIGIBILITY_REQUIRED");
  assert.throws(() => { e.context.capturedMinor = 1; });
  assert.throws(() => { e.request.body.amount = 1; });
  assert.throws(() => { e.recording.payloadAmountMinor = 1; });
  assert.equal(B({ intent: intent({ version: 8 }) }).code, "ELIGIBILITY_SNAPSHOT_CHANGED");
  assert.equal(B({ config: cfg({ paymentMethod: "other" }) }).code, "ELIGIBILITY_SNAPSHOT_CHANGED");
  assert.equal(B({ intent: intent({ recordedPaymentAt: RECORDED + 1000 }) }).code, "ELIGIBILITY_SNAPSHOT_CHANGED");
  assert.equal(B({ recordingOp: op({ id: "6ba7b811-9dad-41d1-80b4-00c04fd430c8" }) }).code, "ELIGIBILITY_SNAPSHOT_CHANGED");
  assert.equal(B({ recordingOp: op({ attempts: 1 }) }).code, "RECORDING_OP_CLAIMED_OR_SENT");
  assert.equal(B({ now: NOW + P.SNAPSHOT_MAX_AGE_MS }).code, "CARRIED_IDENTITY_STALE");
  assert.equal(B({ extra: 1 }).code, "UNEXPECTED_INPUT");
  // validator: every field and extra key
  const V = (req) => P.validateOfflineChargeRequest(req, { intent: intent(), recordingOp: op(), config: cfg() }).code ?? "OK";
  assert.equal(V(b.request), "OK");
  const mut = (bo, top = {}) => ({ ...b.request, body: { ...b.request.body, ...bo }, ...top });
  assert.equal(V(mut({ status: "awaiting" })), "BODY_STATUS");
  assert.equal(V(mut({ amount: 1234.5 })), "BODY_AMOUNT");
  assert.equal(V(mut({ title: `${TITLE} ` })), "BODY_TITLE");
  assert.equal(V(mut({ paymentMethod: "cash" })), "BODY_PAYMENTMETHOD");
  assert.equal(V(mut({ scheduledDate: "2027-01-05 12:30:46" })), "BODY_SCHEDULEDDATE");
  assert.equal(V(mut({ currency: "USD" })), "BODY_SHAPE");
  assert.equal(V(mut({ description: "x" })), "BODY_SHAPE");
  assert.equal(V(mut({}, { method: "PUT" })), "METHOD");
  assert.equal(V(mut({}, { path: "/v1/guestPayments/charges/88000002" })), "PATH");
  assert.equal(V(mut({}, { query: { x: 1 } })), "QUERY_NOT_EMPTY");
  assert.equal(V({ ...b.request, headers: {} }), "REQUEST_SHAPE");
});

test("P12 reply alone is a CANDIDATE (insufficient); every field broken individually -> unknown case", () => {
  const e = eligible();
  const b = P.buildOfflineChargeRequest({ eligibility: e, intent: intent(), recordingOp: op(), config: cfg(), now: NOW });
  const A = (r, o = {}) => P.assessCreateReply({ reply: r, request: b.request, eligibility: e, intent: intent(), config: cfg(), ...o });
  const c = A(reply());
  assert.equal(c.ok, true); assert.equal(c.sufficient, false); assert.equal(c.chargeId, "777");
  assert.equal(A({ httpStatus: 201, json: reply().json }).ok, true);
  for (const [o, code] of [[{ id: "777" }, "REPLY_CHARGE_ID_INVALID"], [{ id: 2 ** 53 }, "REPLY_CHARGE_ID_INVALID"], [{ reservationId: 88000002 }, "REPLY_RESERVATION_MISMATCH"],
    [{ listingMapId: 1 }, "REPLY_LISTING_MISMATCH"], [{ type: "refund" }, "REPLY_TYPE"], [{ paymentProvider: "stripe" }, "REPLY_PROVIDER"], [{ status: "awaiting" }, "REPLY_STATUS"],
    [{ paymentMethod: "cash" }, "REPLY_METHOD"], [{ title: `${TITLE}x` }, "REPLY_TITLE"], [{ currency: "usd" }, "REPLY_CURRENCY"], [{ amount: 1234.55 }, "REPLY_AMOUNT"],
    [{ amount: "1234.56" }, "REPLY_AMOUNT"]]) {
    const r = A(reply(o));
    assert.deepEqual([r.code, r.disposition], [code, "unknown_case"], JSON.stringify(o));
  }
  assert.equal(A({ httpStatus: 500, json: reply().json }).code, "REPLY_HTTP_STATUS");
  assert.equal(A({ httpStatus: 200, json: { status: "fail", result: "x" } }).code, "REPLY_FAIL_ENVELOPE");
  assert.equal(A(reply(), { request: { ...b.request, body: { ...b.request.body, amount: 1 } } }).code, "REQUEST_NOT_BOUND_BODY_AMOUNT");
});

test("P13 confirming read: exact-1 equal to the candidate after dispatch; zero / multiple / look-alike / mismatch / incomplete distinct", () => {
  const e = eligible();
  const b = P.buildOfflineChargeRequest({ eligibility: e, intent: intent(), recordingOp: op(), config: cfg(), now: NOW });
  const cand = P.assessCreateReply({ reply: reply(), request: b.request, eligibility: e, intent: intent(), config: cfg() });
  const DISPATCH = NOW - 2000;
  const C = (rows, o = {}, lo = {}) => P.assessConfirmingRead({ candidate: cand, eligibility: e, intent: intent(), config: cfg(), dispatchedAt: DISPATCH, now: NOW,
    list: P.assessChargeList({ read: list(rows, lo), intent: intent(), config: cfg(), now: NOW }), ...o });
  const good = C([row({ id: 777, title: TITLE, amount: 1234.56 }), row()]);
  assert.equal(good.ok, true); assert.equal(good.chargeId, "777"); assert.equal(good.sendAuthorization, false);
  assert.deepEqual(Object.keys(good.observed).sort(), [...P.EVIDENCE_OBSERVED_KEYS].sort());
  assert.deepEqual([good.observed.matchingChargeCount, good.observed.matchingChargeIds, good.observed.readCount], [1, ["777"], 2]);
  assert.equal(C([row()]).code, "CONFIRM_ZERO_MATCH");
  assert.equal(C([]).code, "CONFIRM_ZERO_MATCH");
  assert.equal(C([row({ id: 777, title: TITLE, amount: 1234.56 }), row({ id: 778, title: TITLE, amount: 1234.56 })]).code, "CONFIRM_MULTIPLE_MATCHES");
  assert.equal(C([row({ id: 777, title: TITLE, amount: 1234.56 }), row({ id: 778, title: `${TITLE}.` })]).code, "CONFIRM_MARKER_LOOKALIKE");
  assert.equal(C([row({ id: 778, title: TITLE, amount: 1234.56 })]).code, "CONFIRM_ID_MISMATCH");
  assert.equal(C([row({ id: 777, title: TITLE, amount: 1234.5 })]).code, "CONFIRM_AMOUNT_MISMATCH");
  assert.equal(C([row({ id: 777, title: TITLE, amount: 1234.56, currency: "MXN" })]).code, "CONFIRM_CURRENCY_MISMATCH");
  assert.equal(C([row({ id: 777, title: TITLE, amount: 1234.56, status: "cancelled" })]).code, "CONFIRM_STATE_MISMATCH");
  assert.equal(C([row({ id: 777, title: TITLE, amount: 1234.56, paymentMethod: "cash" })]).code, "CONFIRM_METHOD_MISMATCH");
  assert.equal(C([row(), row()]).code, "CONFIRM_LIST_INCOMPLETE");
  assert.equal(C([row({ id: 777, title: TITLE, amount: 1234.56 })], {}, { clientSnapshotId: "client-B" }).code, "CONFIRM_CLIENT_LABEL_MISMATCH");
  assert.equal(C([row({ id: 777, title: TITLE, amount: 1234.56 })], { dispatchedAt: NOW - 500 }).code, "CONFIRM_NOT_AFTER_DISPATCH");   // observedAt == dispatch
  assert.equal(C([row({ id: 777, title: TITLE, amount: 1234.56 })], { dispatchedAt: NOW + 1 }).code, "DISPATCH_TIME_INVALID");
  assert.equal(C([row({ id: 777, title: TITLE, amount: 1234.56 })], { candidate: { ...cand } }).code, "REPLY_CANDIDATE_REQUIRED");
  assert.equal(C([row({ id: 777, title: TITLE, amount: 1234.56 })], { candidate: undefined }).code, "REPLY_CANDIDATE_REQUIRED");   // reply missing
  for (const r of [C([row()]), C([row(), row()])]) assert.equal(r.disposition, "unknown_case");
});

test("P14 owner-resolution evidence: full observed identity + API / read / time / dispatch bindings; count-only fails", () => {
  const DISPATCH = NOW - 20 * 60 * 1000;
  const full = { ...{ amountMinor: 123456, chargeId: "777", currency: "USD", executorAccountRef: "acct-test-1", listingMapId: 990001, marker: `mvoch1-${INTENT_ID}`,
    matchingChargeCount: 1, matchingChargeIds: ["777"], paymentMethod: "credit_card", paymentProvider: "offline", readCount: 3, reservationId: "88000001", status: "paid",
    title: TITLE, type: "charge" } };
  const ev = (o = {}, ob = {}) => ({ source: "hostaway_api", kind: "hostaway_offline_charges", status: "listed", externalRef: "88000001",
    readOpType: "hostaway.list_offline_charges", readOpState: "succeeded", observedAt: DISPATCH + P.OWNER_RESOLUTION_SETTLE_MS, observed: { ...full, ...ob }, ...o });
  const R = (e, o = {}) => P.assessOwnerResolutionEvidence({ evidence: e, intent: intent(), config: cfg(), dispatchedAt: DISPATCH, resultRef: "777", now: NOW, ...o });
  assert.deepEqual(R(ev()), { ok: true, chargeId: "777" });
  const countOnly = ev({}, {}); countOnly.observed = { matchingChargeCount: 1, matchingChargeIds: ["777"] };
  assert.deepEqual([R(countOnly).code, R(countOnly).disposition], ["EVIDENCE_OBSERVED_FIELDS_INCOMPLETE", "case_only"]);
  assert.equal(R(ev({ source: "hostaway_dashboard" })).code, "EVIDENCE_NOT_API");
  assert.equal(R(ev({ readOpState: "failed_definite" })).code, "EVIDENCE_NOT_FROM_SUCCEEDED_LIST_READ");
  assert.equal(R(ev({ readOpType: "hostaway.retrieve_reservation" })).code, "EVIDENCE_NOT_FROM_SUCCEEDED_LIST_READ");
  assert.equal(R(ev({ externalRef: "88000002" })).code, "EVIDENCE_RESERVATION_MISMATCH");
  assert.equal(R(ev({ observedAt: DISPATCH + P.OWNER_RESOLUTION_SETTLE_MS - 1 })).code, "EVIDENCE_TOO_EARLY");
  assert.equal(R(ev({ kind: "hostaway_reservation" })).code, "EVIDENCE_KIND");
  assert.equal(R(ev(), { resultRef: "778" }).code, "EVIDENCE_MATCHING_IDS");
  assert.equal(R(ev(), { resultRef: 777 }).code, "RESULT_REF_INVALID");
  for (const [k, v] of [["amountMinor", 123455], ["currency", "MXN"], ["executorAccountRef", "acct-x"], ["listingMapId", 990002], ["marker", "mvoch1-x"],
    ["matchingChargeCount", 2], ["paymentMethod", "cash"], ["paymentProvider", "stripe"], ["reservationId", "88000002"], ["status", "awaiting"], ["title", `${TITLE} `],
    ["type", "refund"], ["chargeId", "778"]]) {
    assert.match(R(ev({}, { [k]: v })).code, /^EVIDENCE_.*MISMATCH$/, k);
  }
  assert.equal(R(ev({}, { readCount: 0 })).code, "EVIDENCE_READ_COUNT_INVALID");
  assert.equal(R(ev({}, { matchingChargeIds: ["777", "778"] })).code, "EVIDENCE_MATCHING_IDS");
  assert.equal(R(ev({}, { extra: 1 })).code, "EVIDENCE_OBSERVED_FIELDS_INCOMPLETE");
});

test("policy: only the initial attempt; protected ids; constants", () => {
  assert.deepEqual([...P.APPROVED_CURRENCIES], ["USD"]);
  assert.deepEqual([...P.APPROVED_PAYMENT_METHODS], ["credit_card", "other"]);
  assert.equal(P.LIST_LIMIT, 500);
  for (const id of PROTECTED_HOSTAWAY_RESERVATION_IDS) assert.equal(P.intentRefusal(intent({ reservationId: id }), cfg()), "PROTECTED_RESERVATION_ID");
  assert.equal(P.recordingOpRefusal(op({ idempotencyKey: `och:${INTENT_ID}:2` }), intent()), "NOT_INITIAL_ATTEMPT");
  assert.equal(P.recordingOpRefusal(op({ idempotencyKey: `och:${OTHER_INTENT}:1` }), intent()), "NOT_INITIAL_ATTEMPT");
});

// =============================================================================================
// root HOLD on 42ee156: cross-context replay regressions (each failed at 42ee156: root probe {true,true,true,true})

const CHANGES = Object.freeze({
  amount: [{ capturedMinor: 223456, finalTotalMinor: 223456 }, {}],
  from: [{ from: "2027-02-09" }, {}],
  to: [{ to: "2027-02-15" }, {}],
  ref: [{ ref: "MV-XYZ999" }, {}],
  version: [{ version: 8 }, {}],
  recordedPaymentAt: [{ recordedPaymentAt: RECORDED + 1000 }, {}],
  intentId: [{ intentId: OTHER_INTENT }, {}],
  paymentMethod: [{}, { paymentMethod: "other" }],
  accountRef: [{}, { accountRef: "acct-test-2" }],
  refFieldId: [{}, { refFieldId: 777008 }]
});
const opFor = (it) => op({ idempotencyKey: `och:${it.intentId}:1`, payload: { reservationId: it.reservationId, amountMinor: it.capturedMinor } });

test("HOLD-1 identity / list replay: branded results minted for one context are refused for EVERY changed intent / config field", () => {
  const id0 = identityOk(); const l0 = listOk([row()]);
  assert.equal(id0.context.capturedMinor, 123456); assert.ok(Object.isFrozen(id0.context) && Object.isFrozen(id0.observed));
  for (const [name, [io, co]] of Object.entries(CHANGES)) {
    const it = intent(io); const c = cfg(co);
    const r = P.qualifyPreflight({ identity: id0, list: l0, intent: it, recordingOp: opFor(it), config: c, now: NOW });
    assert.equal(r.ok, false, name);
    assert.ok(["IDENTITY_CONTEXT_CHANGED", "ACCOUNT_REF_BINDING_MISMATCH"].includes(r.code), `${name}: ${r.code}`);
    // a list minted for the old context with an identity minted for the NEW context is refused too
    const snapNew = snap({ accountRef: c.accountRef }, { totalPrice: it.capturedMinor / 100, arrivalDate: it.from, departureDate: it.to,
      customFieldValues: [{ customFieldId: c.refFieldId, value: it.ref }] });
    const idNew = P.assessIdentitySnapshot({ snapshot: snapNew, intent: it, config: c, now: NOW });
    assert.equal(idNew.ok, true, `${name}: ${idNew.code}`);
    const r2 = P.qualifyPreflight({ identity: idNew, list: l0, intent: it, recordingOp: opFor(it), config: c, now: NOW });
    assert.ok(["LIST_CONTEXT_CHANGED", "ACCOUNT_REF_BINDING_MISMATCH"].includes(r2.code), `${name}: ${r2.code}`);
  }
  // root's exact repro: old identity / list, new stay + amount + version, same reservation
  const changed = intent({ capturedMinor: 223456, finalTotalMinor: 223456, from: "2027-03-10", to: "2027-03-14", version: 8 });
  assert.equal(P.qualifyPreflight({ identity: id0, list: l0, intent: changed, recordingOp: opFor(changed), config: cfg(), now: NOW }).code, "IDENTITY_CONTEXT_CHANGED");
});

test("HOLD-2 candidate + eligibility replay: a confirm for changed facts is refused for EVERY changed field; cross-eligibility refused", () => {
  const e = eligible();
  const b = P.buildOfflineChargeRequest({ eligibility: e, intent: intent(), recordingOp: op(), config: cfg(), now: NOW });
  const cand = P.assessCreateReply({ reply: reply(), request: b.request, eligibility: e, intent: intent(), config: cfg() });
  assert.equal(cand.ok, true); assert.ok(Object.isFrozen(cand.returned) && cand.eligibility === e);
  for (const [name, [io, co]] of Object.entries(CHANGES)) {
    const it = intent(io); const c = cfg(co);
    const l = P.assessChargeList({ read: list([row({ id: 777, title: P.offlineChargeTitle(it.intentId) ?? TITLE, amount: it.capturedMinor / 100,
      paymentMethod: c.paymentMethod })], { observedAt: NOW, accountRef: c.accountRef }), intent: it, config: c, now: NOW });
    const r = P.assessConfirmingRead({ candidate: cand, eligibility: e, list: l, intent: it, config: c, dispatchedAt: NOW - 1, now: NOW });
    assert.equal(r.ok, false, name);
    assert.equal(r.disposition, "unknown_case", name);
    // a reply assessed under changed facts with the OLD eligibility is refused as well
    assert.equal(P.assessCreateReply({ reply: reply(), request: b.request, eligibility: e, intent: it, config: c }).ok, false, `${name} reply`);
  }
  // root's exact repro
  const changed = intent({ capturedMinor: 223456, finalTotalMinor: 223456, from: "2027-03-10", to: "2027-03-14", version: 8 });
  const cl = P.assessChargeList({ read: list([row({ id: 777, title: TITLE, amount: 2234.56 })], { observedAt: NOW }), intent: changed, config: cfg(), now: NOW });
  assert.equal(P.assessConfirmingRead({ candidate: cand, eligibility: e, list: cl, intent: changed, config: cfg(), dispatchedAt: NOW - 1, now: NOW }).code, "CONFIRM_CONTEXT_CHANGED");
  // a DIFFERENT (but valid) eligibility for the same facts cannot be paired with this candidate
  const e2 = eligible();
  const l = P.assessChargeList({ read: list([row({ id: 777, title: TITLE, amount: 1234.56 })], { observedAt: NOW }), intent: intent(), config: cfg(), now: NOW });
  assert.equal(P.assessConfirmingRead({ candidate: cand, eligibility: e2, list: l, intent: intent(), config: cfg(), dispatchedAt: NOW - 1, now: NOW }).code, "CANDIDATE_ELIGIBILITY_MISMATCH");
  assert.equal(P.assessConfirmingRead({ candidate: cand, eligibility: e, list: l, intent: intent(), config: cfg(), dispatchedAt: NOW - 1, now: NOW }).ok, true);
  // post-claim: the recording row is NOT an input; its initial identity travels in the eligibility
  assert.deepEqual({ ...e.recording }, { opId: OP_ID, opType: "hostaway.record_offline_charge", idempotencyKey: `och:${INTENT_ID}:1`, payloadReservationId: "88000001", payloadAmountMinor: 123456 });
  // a reply with an eligibility that is not branded
  assert.equal(P.assessCreateReply({ reply: reply(), request: b.request, eligibility: { ...e }, intent: intent(), config: cfg() }).code, "ELIGIBILITY_REQUIRED");
});

test("HOLD-3 reply assessment validates the WHOLE request (method / path / query / extras) -> unknown case", () => {
  const e = eligible();
  const b = P.buildOfflineChargeRequest({ eligibility: e, intent: intent(), recordingOp: op(), config: cfg(), now: NOW });
  const A = (req) => P.assessCreateReply({ reply: reply(), request: req, eligibility: e, intent: intent(), config: cfg() });
  for (const [req, code] of [[{ ...b.request, method: "DELETE", path: "/wrong", query: { unexpected: true } }, "REQUEST_NOT_BOUND_METHOD"],
    [{ ...b.request, method: "PUT" }, "REQUEST_NOT_BOUND_METHOD"], [{ ...b.request, path: "/wrong" }, "REQUEST_NOT_BOUND_PATH"],
    [{ ...b.request, path: "/v1/guestPayments/charges/88000002" }, "REQUEST_NOT_BOUND_PATH"], [{ ...b.request, query: { unexpected: true } }, "REQUEST_NOT_BOUND_QUERY_NOT_EMPTY"],
    [{ ...b.request, headers: {} }, "REQUEST_NOT_BOUND_REQUEST_SHAPE"], [{ ...b.request, body: { ...b.request.body, currency: "USD" } }, "REQUEST_NOT_BOUND_BODY_SHAPE"],
    [{ ...b.request, body: { ...b.request.body, status: "awaiting" } }, "REQUEST_NOT_BOUND_BODY_STATUS"], [null, "REQUEST_NOT_BOUND_REQUEST_SHAPE"]]) {
    const r = A(req);
    assert.deepEqual([r.ok, r.code, r.disposition], [false, code, "unknown_case"], code);
  }
  assert.equal(A(b.request).ok, true);
  assert.equal(A({ ...b.request }).ok, true);                                                      // a structurally equal copy is fine (validated by value)
});

test("HOLD-4 owner evidence: explicit now; future / missing / invalid times refused; boundaries inclusive; no max age", () => {
  const DISPATCH = NOW - 20 * 60 * 1000;
  const full = { amountMinor: 123456, chargeId: "777", currency: "USD", executorAccountRef: "acct-test-1", listingMapId: 990001, marker: `mvoch1-${INTENT_ID}`,
    matchingChargeCount: 1, matchingChargeIds: ["777"], paymentMethod: "credit_card", paymentProvider: "offline", readCount: 1, reservationId: "88000001", status: "paid",
    title: TITLE, type: "charge" };
  const ev = (observedAt) => ({ source: "hostaway_api", kind: "hostaway_offline_charges", status: "listed", externalRef: "88000001",
    readOpType: "hostaway.list_offline_charges", readOpState: "succeeded", observedAt, observed: full });
  const R = (observedAt, o = {}) => P.assessOwnerResolutionEvidence({ evidence: ev(observedAt), intent: intent(), config: cfg(), dispatchedAt: DISPATCH, resultRef: "777", now: NOW, ...o });
  assert.equal(R(NOW + 86400000, { dispatchedAt: NOW - 1 }).code, "EVIDENCE_IN_FUTURE");          // root's repro
  assert.equal(R(NOW + 1).code, "EVIDENCE_IN_FUTURE");
  assert.equal(R(NOW).ok, true);                                                                  // observedAt == now
  assert.equal(R(DISPATCH + P.OWNER_RESOLUTION_SETTLE_MS).ok, true);                              // settle boundary inclusive
  assert.equal(R(DISPATCH + P.OWNER_RESOLUTION_SETTLE_MS - 1).code, "EVIDENCE_TOO_EARLY");
  assert.equal(R(NOW, { dispatchedAt: NOW + 1 }).code, "DISPATCH_IN_FUTURE");
  for (const n of [undefined, null, 0, -1, 1.5, NaN, Infinity, "1"]) assert.equal(R(NOW, { now: n }).code, "NOW_INVALID", String(n));
  // historical immutable evidence: no artificial maximum age
  assert.equal(R(DISPATCH + P.OWNER_RESOLUTION_SETTLE_MS, { now: NOW + 365 * 86400000 }).ok, true);
});

test("freshness maxAge must be a safe non-negative integer (never disables freshness)", () => {
  for (const m of [NaN, Infinity, -1, 1.5, "120000", null]) assert.equal(P.freshnessRefusal(NOW - 1, NOW, m), "MAX_AGE_INVALID", String(m));
  assert.equal(P.freshnessRefusal(NOW, NOW, 0), null);
  assert.equal(P.freshnessRefusal(NOW - 1, NOW, 0), "STALE");
  assert.equal(P.freshnessRefusal(NOW - 1, NOW, undefined), null);                                // default applies
});

test("branded results are deeply immutable", () => {
  const id = identityOk(); const l = listOk([row()]); const e = eligible();
  for (const o of [id, id.context, id.observed, l, l.rows, l.rows[0], l.context, e, e.context, e.recording, e.request, e.request.body, e.request.query]) assert.ok(Object.isFrozen(o));
});

test("HOLD-2b confirm: a complete list minted under ANOTHER context is refused even when eligibility / candidate match", () => {
  const e = eligible();
  const b = P.buildOfflineChargeRequest({ eligibility: e, intent: intent(), recordingOp: op(), config: cfg(), now: NOW });
  const cand = P.assessCreateReply({ reply: reply(), request: b.request, eligibility: e, intent: intent(), config: cfg() });
  const good = [row({ id: 777, title: TITLE, amount: 1234.56 })];
  for (const [name, io] of [["version", { version: 8 }], ["ref", { ref: "MV-XYZ999" }], ["recordedPaymentAt", { recordedPaymentAt: RECORDED + 1 }]]) {
    const other = P.assessChargeList({ read: list(good, { observedAt: NOW }), intent: intent(io), config: cfg(), now: NOW });
    assert.equal(other.ok, true, name);
    const r = P.assessConfirmingRead({ candidate: cand, eligibility: e, list: other, intent: intent(), config: cfg(), dispatchedAt: NOW - 1, now: NOW });
    assert.deepEqual([r.code, r.disposition], ["CONFIRM_LIST_CONTEXT_CHANGED", "unknown_case"], name);
  }
});
