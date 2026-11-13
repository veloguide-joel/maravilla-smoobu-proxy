// test/e7-c21-hostaway-charge-contract-doc-derived.test.mjs — C21 OFFLINE compatibility audit of the accepted Hostaway guest-charge contract
// (pin 5a094b16: lib/checkout/offline-charge-proof.js, lib/hostaway-reservations.js, scripts/e7-connected/http-transports.mjs) against the
// OFFICIAL PUBLIC documentation https://api.hostaway.com/documentation (sections "Guest payment" → guest charge object, Get guest charges list,
// Create offline charge, Update / Refund offline charge, the list QUERY-PARAMETER table; standard response description; changelog 2026-10-02 /
// 2026-09-23) as READ on 2026-11-13 (C22 re-read of the query table).
// EVERY fixture here is DOC-DERIVED (shape + example values from the public docs) with SANITIZED SYNTHETIC identities (reservation 88000001,
// listing 990001, acct-test-1) — NONE is a live observation. The REAL accepted normalizers / proofs / transport grammar from E7_TOOLING_DIR run
// unchanged; the merged probe (scripts/e7-hosted-charge-list-probe.mjs) runs over a FAKE exchange. Zero network (throwing guards), zero DB,
// zero credentials. Where the docs do not state something it is marked UNKNOWN; nothing is loosened to pass. Provenance note:
// claude/e7-hosted/c21-hostaway-charge-contract-doc-audit-2026-11-13.md.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const GUARD = { request: 0, Agent: 0, fetch: 0 };
https.request = () => { GUARD.request += 1; throw new Error("network refused"); };
https.Agent = class { constructor() { GUARD.Agent += 1; throw new Error("network refused"); } };
globalThis.fetch = async () => { GUARD.fetch += 1; throw new Error("network refused"); };
syncBuiltinESMExports();
const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const TOOLING = realpathSync(process.env.E7_TOOLING_DIR || join(ROOT, "..", "tooling"));
const tool = (p) => import(pathToFileURL(join(TOOLING, p)).href);
const [P, H, T, PR] = await Promise.all([tool("lib/checkout/offline-charge-proof.js"), tool("lib/hostaway-reservations.js"), tool("scripts/e7-connected/http-transports.mjs"), import("../scripts/e7-hosted-charge-list-probe.mjs")]);
after(() => { assert.deepEqual(GUARD, { request: 0, Agent: 0, fetch: 0 }, "no real network primitive was touched"); });

// ---------------------------------------------------------------------------------------------------------------------------------
// DOC SNAPSHOT (public docs as read 2026-11-13) — the provenance table reviewers compare against; values are the documented ones or UNKNOWN
export const DOC = Object.freeze({
  readOn: "2026-11-13",
  chargeTypes: ["charge", "preAuth", "refund"],                                            // documented (changelog 2026-10-02 added refund)
  paymentProviders: ["stripe", "braintree", "authorizeNet", "offline"],                   // documented closed list on the charge object
  // §"Guest charge object" table: status / paymentMethod are given as EXAMPLES ending in "etc." (OPEN sets)
  statusObjectExamples: ["awaiting", "paid", "failed", "pause", "cancelled", "awaitingHold"],
  paymentMethodObjectExamples: ["credit_card_online", "credit_card", "bank_transfer"],
  refundStatusExample: "succeeded",                                                        // §"Refund offline charge": result status "succeeded"
  // §"Get guest charges list" QUERY-PARAMETER table (filter vocabularies; the fullest documented enumerations, bracket-form arrays)
  statusListFilter: ["paid", "failed", "awaiting", "waitingForConfirmation", "pause", "cancelled", "awaitingHold", "holdSuccess", "holdFail", "holdCancelled", "captureSuccess", "captureFail", "holdReleased", "holdReleasedFail", "succeeded", "pending"],
  paymentMethodListFilter: ["bank_check", "bank_transfer", "cash", "credit_card", "paypal", "vcc", "venmo", "credit_card_online", "payment_link", "ota", "other"],
  paymentProviderListFilter: ["stripe", "braintree", "authorizeNet", "offline"],         // single-value query parameter, same closed list as the object
  typesListFilter: ["charge", "preAuth", "refund"],
  createPaymentMethods: ["credit_card", "vcc", "cash", "paypal", "venmo", "bank_transfer", "bank_check", "ota", "other"], // Create offline charge: closed list
  createStatuses: ["awaiting", "paid"],                                                    // Create offline charge: closed list
  createMandatory: ["title", "amount", "paymentMethod", "status", "scheduledDate"],        // "All fields but description are mandatory"
  createOptional: ["description"],
  createPath: "/v1/guestPayments/charges/{reservationId}",                                 // POST; reservationId in the PATH
  refundPath: "/v1/guestPayments/charges/{reservationId}/{chargeId}/refund",              // POST; stored refund charge has NEGATIVE amount
  updatePath: "/v1/guestPayments/charges/{reservationId}/{chargeId}",                      // PUT; only `awaiting` charges; status paid|cancelled
  listPath: "/v1/guestPayments/charges",                                                   // GET
  listSelectors: ["reservationId", "reservationIds[]"],                                    // both documented; changelog: reservationIds max 200 ids
  listLimit: { default: 100, max: 500 },
  listCountSemantics: "count = total number of matching charges, ignoring limit and offset",  // documented (§Get guest charges list)
  listOffset: "documented paging parameter; the accepted PROOF never reads it; the merged PROBE separately refuses a non-zero offset",
  listEnvelopeExampleKeys: ["status", "result", "count", "offset"],                        // example: offset null; NO limit / page / totalPages
  genericEnvelopeKeys: ["status", "result", "limit", "offset", "count", "page", "totalPages"], // page-wide "standard response" description
  amountType: "float", amountUnits: "UNKNOWN (not stated; examples 10 / 100 are whole numbers)",
  scheduledDateFormat: "YYYY-MM-DD HH:MM:SS (datetime; examples)", chargeDateFormat: "date (format not stated; example 'YYYY-MM-DD HH:MM:SS')",
  createReplyHttpStatus: "UNKNOWN (docs: 'Created charge object or error response'; no code stated)",
  errorEnvelopes: "standard fail envelope {status:'fail', message} and 400 validation failures ARE documented page-wide / per parameter; the charge-specific full error matrix is UNKNOWN",
});
// what the ACCEPTED pin assumes beyond the docs (provenance; asserted below so a change in either side is visible)
export const ACCEPTED = Object.freeze({
  approvedPaymentMethods: ["credit_card", "other"], approvedCurrencies: ["USD"], listLimit: 500, countMustEqualPageLength: true,
  rowStringFields: ["type", "title", "currency", "status", "paymentProvider", "paymentMethod"], amountUnits: "ASSUMED major units, ≤ 2 decimals (amountToMinor)",
  createReplyHttpStatus: [200, 201], requestFields: ["amount", "paymentMethod", "scheduledDate", "status", "title"], wireSelector: "limit=500&reservationIds=<id>",
});

const INTENT_ID = "0f8fad5b-d9cb-469f-a165-70867728950e"; const OP_ID = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const NOW = Date.UTC(2027, 0, 5, 13, 0, 0); const RECORDED = Date.UTC(2027, 0, 5, 12, 30, 45, 678);
const TITLE = `maraVilla payment mvoch1-${INTENT_ID}`;
const cfg = (o = {}) => ({ accountRef: "acct-test-1", channelId: 2000, currency: "USD", listingId: 990001, paymentMethod: "credit_card", refFieldId: 777007, ...o });
const intent = (o = {}) => ({ intentId: INTENT_ID, status: "payment_captured", version: 7, ref: "MV-ABC123", listingId: 990001, from: "2027-02-10", to: "2027-02-14",
  finalTotalMinor: 123456, capturedMinor: 123456, currency: "USD", reservationId: "88000001", recordedPaymentAt: RECORDED, ...o });
const op = (o = {}) => ({ id: OP_ID, opType: "hostaway.record_offline_charge", state: "pending", attempts: 0, dispatchedAt: null, idempotencyKey: `och:${INTENT_ID}:1`, payload: { reservationId: "88000001", amountMinor: 123456 }, ...o });
const resv = () => ({ id: 88000001, listingMapId: 990001, channelId: 2000, arrivalDate: "2027-02-10", departureDate: "2027-02-14", totalPrice: 1234.56, currency: "USD", status: "new", customFieldValues: [{ customFieldId: 777007, value: "MV-ABC123" }] });
const identityOk = () => P.assessIdentitySnapshot({ snapshot: { accountRef: "acct-test-1", clientSnapshotId: "client-A", observedAt: NOW - 1000, httpStatus: 200, json: { status: "success", result: resv() } }, intent: intent(), config: cfg(), now: NOW });

/** DOC-DERIVED: the documented "Get guest charges list" example row, VERBATIM SHAPE (every documented key, documented example values and nulls),
 *  identities sanitized to the synthetic reservation / listing. Note the documented example has paymentProvider: null and scheduledDate: null. */
const DOC_LIST_ROW = Object.freeze({ id: 1, listingMapId: 990001, reservationId: 88000001, autopaymentId: 34231, type: "charge", title: "Charge", description: "Charge description",
  currency: "USD", paymentMethod: "credit_card_online", amount: 10, capturedAmount: null, status: "awaiting", paymentProvider: null, paymentProviderMessage: null,
  paymentProviderInvoiceId: null, paymentProviderChargeId: null, scheduledDate: null, chargeDate: null, holdReleaseDate: null, isManual: 0, autoChargeId: null,
  triggerEvent: null, triggerTimeDelta: 0, flatFee: null, percentageFee: null, transactions: [] });
/** DOC-DERIVED: the documented "Create offline charge" example RESULT, verbatim shape; identities sanitized; title/amount/method bound to the test intent. */
const DOC_CREATE_RESULT = Object.freeze({ id: 1, listingMapId: 990001, reservationId: 88000001, autopaymentId: null, type: "charge", title: TITLE, description: null,
  currency: "USD", paymentMethod: "credit_card", amount: 1234.56, capturedAmount: 0, status: "paid", paymentProvider: "offline", paymentProviderMessage: null,
  paymentProviderInvoiceId: null, paymentProviderChargeId: null, scheduledDate: "2023-08-15 18:56:49", chargeDate: "2023-08-21 09:25:36", holdReleaseDate: null,
  isManual: 0, autoChargeId: null, triggerEvent: null, triggerTimeDelta: 0, flatFee: 0, percentageFee: 0, transactions: [] });
/** DOC-DERIVED: the documented list ENVELOPE example — status / result / count / offset:null; no limit, page or totalPages. */
const docListEnvelope = (rows, over = {}) => ({ status: "success", result: rows, count: rows.length, offset: null, ...over });
const read = (rows, jo = {}, o = {}) => ({ accountRef: "acct-test-1", clientSnapshotId: "client-A", observedAt: NOW - 500, httpStatus: 200, request: { reservationId: "88000001", limit: 500 }, json: docListEnvelope(rows, jo), ...o });
const assess = (rows, jo = {}, o = {}) => P.assessChargeList({ read: read(rows, jo, o), intent: intent(), config: cfg(), now: NOW });

// ---------------------------------------------------------------------------------------------------------------------------------
test("D1 documented list ENVELOPE: the documented example keys (status/result/count/offset:null; no limit/page/totalPages) with an EMPTY result pass the accepted proof — the same shape the C20 live probe observed; the page-wide generic envelope keys (page/totalPages) are IGNORED by the proof but STOP the merged probe (fail-closed divergence, documented here)", () => {
  const r = assess([]); assert.equal(r.ok, true, JSON.stringify(r)); assert.deepEqual([r.count, r.rows.length, r.complete], [0, 0, true]);
  assert.deepEqual(Object.keys(docListEnvelope([])), DOC.listEnvelopeExampleKeys);
  // proof: extra generic keys do not change acceptance (only status/result/count are read; offset is NEVER read by the proof)
  assert.equal(assess([], { limit: 500, page: 1, totalPages: 1 }).ok, true);
  assert.equal(assess([], { offset: 500 }).ok, true, "the PROOF ignores offset entirely");
  assert.equal(PR.paginationRefusal(docListEnvelope([], { offset: 500 }), 0), "OFFSET_NOT_ZERO", "the merged PROBE separately refuses a non-zero offset");
  // merged probe: documented GENERIC envelope keys are continuation markers → STOP before any second request (no next-page path exists)
  assert.deepEqual([PR.paginationRefusal({ status: "success", result: [], count: 0, offset: null }, 0), PR.paginationRefusal({ ...docListEnvelope([]), page: 1, totalPages: 1 }, 0), PR.paginationRefusal({ ...docListEnvelope([]), limit: 100 }, 0)],
    [null, "CONTINUATION_MARKER_PRESENT", "LIMIT_INCOMPATIBLE"]);
  assert.ok(DOC.genericEnvelopeKeys.filter((k) => !DOC.listEnvelopeExampleKeys.includes(k)).every((k) => k === "limit" || PR.CONTINUATION_KEYS.includes(k)), "every generic-envelope key absent from the guest-charges example is either the limit rule or a continuation key");
});

test("D2 REPRODUCER — documented NON-EMPTY list example row (paymentProvider: null) is REFUSED by the accepted proof (LIST_ROW_PAYMENTPROVIDER_INVALID): the whole page becomes untrusted; the merged probe would STOP LIST_REFUSED on the same row; the identical row with a documented STRING provider passes and normalises amount 10 → 1000 minor (ASSUMED major units)", async () => {
  const bad = assess([DOC_LIST_ROW]);
  assert.deepEqual([bad.ok, bad.code], [false, "LIST_ROW_PAYMENTPROVIDER_INVALID"], "documented example row: paymentProvider null vs accepted ROW_STRING_FIELDS");
  assert.ok(ACCEPTED.rowStringFields.includes("paymentProvider"));
  // the other documented nulls (description / scheduledDate / capturedAmount / chargeDate …) are NOT consulted: provider is the only refusing field
  const ok = assess([{ ...DOC_LIST_ROW, paymentProvider: "stripe" }]);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(ok.rows[0], { chargeId: "1", reservationId: "88000001", listingMapId: 990001, type: "charge", title: "Charge", amountMinor: 1000, currency: "USD", status: "awaiting", paymentProvider: "stripe", paymentMethod: "credit_card_online" });
  // documented-but-untitled awaiting online charge: no marker, not paid, not same-amount → no conflict for the preflight observation
  const obs = P.preflightListObservation({ list: ok, intent: intent(), config: cfg() });
  assert.deepEqual([obs.rowCount, obs.matchingChargeCount, obs.lookalikeCount, obs.sameAmountPaidCount], [1, 0, 0, 0]);
  // the merged probe over a FAKE exchange: same documented row for the fixed TEST target → LIST_REFUSED / LIST_ROW_PAYMENTPROVIDER_INVALID, exactly 2 GETs, nothing echoed
  const lt = await PR.loadTooling(TOOLING); assert.equal(lt.ok, true, JSON.stringify(lt));
  const enc = (o) => new TextEncoder().encode(JSON.stringify(o)); const RID = PR.TARGET.reservationId;
  const targetResv = { id: Number(RID), listingMapId: PR.TARGET.listingId, channelId: 2000, arrivalDate: PR.TARGET.from, departureDate: PR.TARGET.to, totalPrice: PR.TARGET.finalTotalMinor / 100, currency: "USD", status: "new", customFieldValues: [{ customFieldId: PR.CONFIG.refFieldId, value: PR.TARGET.ref }] };
  const docRowForTarget = (over = {}) => ({ ...DOC_LIST_ROW, listingMapId: PR.TARGET.listingId, reservationId: Number(RID), ...over });
  const fake = (rows) => async (req) => ({ status: 200, contentType: "application/json", bytes: enc(/\/v1\/reservations\//.test(req.url) ? { status: "success", result: targetResv } : docListEnvelope(rows)) });
  const stop = await PR.runProbe({ tooling: lt.tooling, exchange: fake([docRowForTarget()]), credential: () => "synthetic-token", clientSnapshotId: "c21" });
  assert.deepEqual([stop.stop, stop.list.ok, stop.list.code, stop.calls], ["LIST_REFUSED", false, "LIST_ROW_PAYMENTPROVIDER_INVALID", 2], JSON.stringify(stop));
  assert.doesNotMatch(JSON.stringify(stop) + PR.formatResult(stop), /Charge description|synthetic-token/);
  // same documented row with a string provider: the probe accepts the page but every documented value outside its enums is UNKNOWN → never "fully compatible"
  const unk = await PR.runProbe({ tooling: lt.tooling, exchange: fake([docRowForTarget({ paymentProvider: "stripe" })]), credential: () => "synthetic-token", clientSnapshotId: "c21" });
  assert.deepEqual([unk.stop, unk.outcome, unk.list.rows[0].status, unk.list.rows[0].paymentMethod, unk.list.rows[0].paymentProvider, unk.list.unknownValues], [null, "SHAPE_COMPATIBLE_WITH_UNKNOWN_VALUES", "UNKNOWN", "UNKNOWN", "stripe", 2], JSON.stringify(unk.list));
});

test("D3 documented CREATE reply example (result with paymentProvider offline, capturedAmount 0, chargeDate string, documented nulls) bound to the accepted request → REPLY CANDIDATE (insufficient by design) at HTTP 200 and 201 (documented status code UNKNOWN); every documented extra key is ignored; a documented `awaiting` status or a non-offline provider in the reply is an unknown case", () => {
  const eligibility = P.qualifyPreflight({ identity: identityOk(), list: assess([]), intent: intent(), recordingOp: op(), config: cfg(), now: NOW });
  assert.equal(eligibility.ok, true, JSON.stringify(eligibility));
  const built = P.buildOfflineChargeRequest({ eligibility, intent: intent(), recordingOp: op(), config: cfg(), now: NOW }); assert.equal(built.ok, true, JSON.stringify(built));
  assert.deepEqual(built.request, { method: "POST", path: "/v1/guestPayments/charges/88000001", query: {}, body: { title: TITLE, amount: 1234.56, paymentMethod: "credit_card", status: "paid", scheduledDate: "2027-01-05 12:30:45" } });
  assert.deepEqual(Object.keys(built.request.body).sort(), DOC.createMandatory.slice().sort(), "accepted request = exactly the documented mandatory fields; optional description omitted");
  assert.ok(DOC.createPaymentMethods.includes(built.request.body.paymentMethod) && DOC.createStatuses.includes(built.request.body.status));
  assert.match(built.request.body.scheduledDate, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, "documented scheduledDate example format");
  for (const httpStatus of ACCEPTED.createReplyHttpStatus) {
    const c = P.assessCreateReply({ reply: { httpStatus, json: { status: "success", result: { ...DOC_CREATE_RESULT } } }, request: built.request, eligibility, intent: intent(), config: cfg() });
    assert.deepEqual([c.ok, c.sufficient, c.chargeId, c.returned.amountMinor, c.returned.paymentProvider], [true, false, "1", 123456, "offline"], `${httpStatus}: ${JSON.stringify(c)}`);
  }
  const u = (over, code) => { const c = P.assessCreateReply({ reply: { httpStatus: 200, json: { status: "success", result: { ...DOC_CREATE_RESULT, ...over } } }, request: built.request, eligibility, intent: intent(), config: cfg() }); assert.deepEqual([c.ok, c.code, c.disposition], [false, code, "unknown_case"], code); };
  u({ status: "awaiting" }, "REPLY_STATUS"); u({ paymentProvider: "stripe" }, "REPLY_PROVIDER"); u({ paymentProvider: null }, "REPLY_PROVIDER"); u({ paymentMethod: "cash" }, "REPLY_METHOD");
  u({ amount: "1234.56" }, "REPLY_AMOUNT"); u({ currency: "EUR" }, "REPLY_CURRENCY"); u({ type: "preAuth" }, "REPLY_TYPE"); u({ id: "1" }, "REPLY_CHARGE_ID_INVALID");
  // documented refund-path result shape (type refund, negative amount, status succeeded) is never a create candidate
  u({ type: "refund", amount: -1234.56, status: "succeeded" }, "REPLY_TYPE");
});

test("D4 transport grammar vs docs: H9 POST path carries the reservation id (documented create path), body = the five mandatory fields, no description, documented-but-unapproved `cash` refused (fail-closed by policy, not by docs); H8 wire selector is the documented `reservationIds` filter with limit=500 (documented max) and never the singular `reservationId`; the documented refund / update paths are NOT in the grammar", async () => {
  const sent = []; const exchange = async (req) => { sent.push(req); return { status: 200, contentType: "application/json", bytes: new TextEncoder().encode(JSON.stringify({ status: "success", result: [], count: 0, offset: null })) }; };
  const tr = T.createE7HostawaySend({ exchange, credential: () => "synthetic-token" }); assert.equal(tr.ok, true);
  const sig = new AbortController().signal;
  await tr.transport.send({ method: "GET", path: "/v1/guestPayments/charges", query: { limit: 500, reservationId: "88000001" } }, { signal: sig });
  assert.equal(sent[0].url, "https://api.hostaway.com/v1/guestPayments/charges?limit=500&reservationIds=88000001"); assert.doesNotMatch(sent[0].url, /[?&]reservationId=/);
  assert.equal(P.LIST_LIMIT, DOC.listLimit.max);
  const body = { title: TITLE, amount: 1234.56, paymentMethod: "credit_card", status: "paid", scheduledDate: "2027-01-05 12:30:45" };
  await tr.transport.send({ method: "POST", path: "/v1/guestPayments/charges/88000001", query: {}, body }, { signal: sig });
  assert.deepEqual([sent[1].method, sent[1].url, JSON.parse(sent[1].body)], ["POST", "https://api.hostaway.com/v1/guestPayments/charges/88000001", body]);
  const refused = async (r) => { try { await tr.transport.send(r, { signal: sig }); return null; } catch (e) { return e.code; } };
  assert.equal(await refused({ method: "POST", path: "/v1/guestPayments/charges/88000001", query: {}, body: { ...body, paymentMethod: "cash" } }), "REQUEST_NOT_ALLOWED", "documented `cash` is not approved by policy");
  assert.equal(await refused({ method: "POST", path: "/v1/guestPayments/charges/88000001", query: {}, body: { ...body, description: "x" } }), "REQUEST_NOT_ALLOWED", "optional description never sent");
  assert.equal(await refused({ method: "POST", path: "/v1/guestPayments/charges/88000001", query: {}, body: { ...body, status: "awaiting" } }), "REQUEST_NOT_ALLOWED", "documented `awaiting` not approved");
  assert.equal(await refused({ method: "POST", path: "/v1/guestPayments/charges/88000001/1/refund", query: {}, body: { title: "r", amount: 1 } }), "REQUEST_NOT_ALLOWED", "documented refund path is outside the grammar");
  assert.equal(await refused({ method: "PUT", path: "/v1/guestPayments/charges/88000001/1", query: {}, body }), "REQUEST_NOT_ALLOWED", "documented update path is outside the grammar");
  assert.equal(await refused({ method: "GET", path: "/v1/guestPayments/charges", query: { limit: 100, reservationId: "88000001" } }), "REQUEST_NOT_ALLOWED", "documented default limit 100 is not the accepted selector");
  assert.equal(sent.length, 2);
  for (const m of ACCEPTED.approvedPaymentMethods) assert.ok(DOC.createPaymentMethods.includes(m), m);
});

test("D5 money: docs type `amount` as float with UNSTATED units — the accepted ASSUMPTION is major units with ≤ 2 decimals; documented examples 10 → 1000 and 100 → 10000 minor; the documented refund result (negative amount, status succeeded) is a lawful list row with negative minor units; strings, 3-decimal and exponent forms are refused", () => {
  assert.deepEqual([H.amountToMinor(10), H.amountToMinor(100), H.amountToMinor(1234.56), H.amountToMinor(0), H.amountToMinor("10"), H.amountToMinor(1.005), H.amountToMinor(1e21), H.amountToMinor(-1)], [1000, 10000, 123456, 0, null, null, null, null]);
  assert.deepEqual([P.exactAmount(123456), P.exactAmount(1000), P.exactAmount(0)], [1234.56, 10, null]);
  const r = assess([{ ...DOC_LIST_ROW, paymentProvider: "offline", type: "refund", amount: -100, status: "succeeded", title: "Refund" }]);
  assert.equal(r.ok, true, JSON.stringify(r)); assert.deepEqual([r.rows[0].type, r.rows[0].amountMinor, r.rows[0].status], ["refund", -10000, "succeeded"]);
  const obs = P.preflightListObservation({ list: r, intent: intent(), config: cfg() }); assert.deepEqual([obs.sameAmountPaidCount, obs.lookalikeCount, obs.matchingChargeCount], [0, 0, 0]);
  assert.equal(assess([{ ...DOC_LIST_ROW, paymentProvider: "offline", amount: 10.005 }]).code, "LIST_ROW_AMOUNT_NOT_EXACT");
  assert.equal(assess([{ ...DOC_LIST_ROW, paymentProvider: "offline", amount: "10" }]).code, "LIST_ROW_AMOUNT_INVALID");
  assert.equal(DOC.amountUnits.startsWith("UNKNOWN"), true);
});

test("D6 list count semantics: docs say `count` ignores limit/offset (TOTAL matching), the accepted proof requires count == page length and ≤ 500 — they coincide only for ≤ 500 total rows at offset 0; any other documented case fails CLOSED (LIST_COUNT_INVALID / LIST_COUNT_LENGTH_MISMATCH), never silently", () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ ...DOC_LIST_ROW, paymentProvider: "offline", id: 1000 + i }));
  assert.equal(assess(rows(2)).ok, true);
  assert.equal(assess(rows(2), { count: 3 }).code, "LIST_COUNT_LENGTH_MISMATCH", "documented total 3 > page of 2 (would mean offset paging) → untrusted");
  assert.equal(assess(rows(500), { count: 501 }).code, "LIST_COUNT_INVALID", "documented total above the 500 cap → untrusted");
  assert.equal(assess(rows(500)).ok, true, "exactly 500 == count passes the proof; the merged probe additionally STOPs a full page");
  assert.equal(PR.paginationRefusal(docListEnvelope(rows(500)), 500), "PAGE_FULL");
  assert.equal(ACCEPTED.countMustEqualPageLength, true);
});

test("D7 enum provenance for the merged probe's OUTPUT enums (hygiene only, never acceptance), derived against the UNION of the documented vocabularies with section provenance: charge-object EXAMPLES (open, 'etc.') ∪ list-filter QUERY TABLE (fullest enumeration) ∪ create / refund sections; documented-not-in-probe values map to UNKNOWN (outcome downgrade, never refusal); probe-only values are recorded; no claim that any documented value was live-observed", () => {
  const E = PR.ENUMS;
  const uniq = (a) => [...new Set(a)];
  const docStatuses = uniq([...DOC.statusObjectExamples, DOC.refundStatusExample, ...DOC.statusListFilter]);
  const docMethods = uniq([...DOC.paymentMethodObjectExamples, ...DOC.createPaymentMethods, ...DOC.paymentMethodListFilter]);
  const docProviders = uniq([...DOC.paymentProviders, ...DOC.paymentProviderListFilter]);
  // the query table is the superset of the object examples (every object example appears in the filter vocabulary)
  assert.ok(DOC.statusObjectExamples.every((v) => DOC.statusListFilter.includes(v)) && DOC.statusListFilter.includes(DOC.refundStatusExample));
  assert.ok(DOC.paymentMethodObjectExamples.every((v) => DOC.paymentMethodListFilter.includes(v)) && DOC.createPaymentMethods.every((v) => DOC.paymentMethodListFilter.includes(v)));
  assert.ok(DOC.paymentMethodListFilter.includes("payment_link") && DOC.statusListFilter.includes("pending") && DOC.statusListFilter.includes("waitingForConfirmation"));
  const documentedNotInProbe = { chargeStatus: docStatuses.filter((v) => !E.chargeStatus.includes(v)), paymentMethod: docMethods.filter((v) => !E.paymentMethod.includes(v)), paymentProvider: docProviders.filter((v) => !E.paymentProvider.includes(v)) };
  assert.deepEqual(documentedNotInProbe, {
    chargeStatus: ["awaiting", "pause", "awaitingHold", "succeeded", "waitingForConfirmation", "holdSuccess", "holdFail", "holdCancelled", "captureSuccess", "captureFail", "holdReleased", "holdReleasedFail"],
    paymentMethod: ["credit_card_online", "bank_transfer", "vcc", "cash", "paypal", "venmo", "bank_check", "ota", "payment_link"],
    paymentProvider: ["braintree", "authorizeNet"] });
  for (const [k, vals] of Object.entries(documentedNotInProbe)) for (const v of vals) assert.equal(PR.safeEnum(k, v), "UNKNOWN", `${k}:${v}`);
  const probeOnly = { chargeStatus: E.chargeStatus.filter((v) => !docStatuses.includes(v)), paymentMethod: E.paymentMethod.filter((v) => !docMethods.includes(v)), paymentProvider: E.paymentProvider.filter((v) => !docProviders.includes(v)), chargeType: E.chargeType.filter((v) => !DOC.typesListFilter.includes(v)) };
  assert.deepEqual(probeOnly, { chargeStatus: ["unpaid", "refunded"], paymentMethod: [], paymentProvider: ["hostaway"], chargeType: [] }, "probe enum values no documented section names (output labels only; `pending` IS documented in the list-filter table)");
  assert.deepEqual([...E.chargeType], DOC.chargeTypes, "charge types: probe == proof CHARGE_TYPES == object table == list-filter table");
  assert.ok(docProviders.includes("offline") && E.paymentProvider.includes("offline"));
});

test("D8 constants cross-check between docs, proof and probe (a drift on any side fails here): types, approved methods ⊂ documented create methods, status `paid` ∈ documented create statuses, LIST_LIMIT == documented max, probe target config method approved", () => {
  assert.deepEqual([...P.APPROVED_PAYMENT_METHODS], ACCEPTED.approvedPaymentMethods); assert.deepEqual([...P.APPROVED_CURRENCIES], ACCEPTED.approvedCurrencies);
  assert.equal(P.LIST_LIMIT, 500); assert.equal(PR.LIST_LIMIT, P.LIST_LIMIT);
  assert.ok(DOC.createStatuses.includes("paid")); assert.ok(P.APPROVED_PAYMENT_METHODS.every((m) => DOC.createPaymentMethods.includes(m)));
  assert.ok(P.APPROVED_PAYMENT_METHODS.includes(PR.CONFIG.paymentMethod));
  assert.deepEqual(DOC.createPath, "/v1/guestPayments/charges/{reservationId}");
});
