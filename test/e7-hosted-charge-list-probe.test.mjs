// test/e7-hosted-charge-list-probe.test.mjs — C17/C18 read-only charge-LIST shape probe: FAKE exchange / FAKE node:https primitive only (every real
// network primitive is replaced with a throwing guard before anything is imported); REAL accepted transport, REAL accepted real-exchange module
// and REAL pure proofs from the pinned tooling (E7_TOOLING_DIR = 4ed7a636; C25 repin). Zero live network, zero DB, zero credentials.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const GUARD = { request: 0, Agent: 0, fetch: 0 };
https.request = () => { GUARD.request += 1; throw new Error("network refused"); };
https.Agent = class { constructor() { GUARD.Agent += 1; throw new Error("network refused"); } };
globalThis.fetch = async () => { GUARD.fetch += 1; throw new Error("network refused"); };
syncBuiltinESMExports();
const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const TOOLING = realpathSync(process.env.E7_TOOLING_DIR || join(ROOT, "..", "tooling"));
const P = await import("../scripts/e7-hosted-charge-list-probe.mjs");
after(() => { assert.deepEqual(GUARD, { request: 0, Agent: 0, fetch: 0 }, "no real network primitive was touched"); });

const T = P.TARGET; const RID = T.reservationId;
const SENTINEL = "OUTPUT_SENTINEL"; const CONTACT = "joel.tester@example.invalid +52 322 000 0000\nline2"; const BIG = "X".repeat(5000);
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
const reply = (status, x) => ({ status, contentType: "application/json", bytes: enc(x) });
const reservation = (over = {}) => ({ id: Number(RID), listingMapId: T.listingId, channelId: 2000, arrivalDate: T.from, departureDate: T.to, totalPrice: T.finalTotalMinor / 100, currency: "USD", status: "new",
  customFieldValues: [{ customFieldId: P.CONFIG.refFieldId, value: T.ref }], guestName: "SHOULD-NEVER-APPEAR", guestEmail: "never@example.invalid", ...over });
const listEnv = (rows, over = {}) => ({ status: "success", result: rows, count: rows.length, limit: 500, offset: 0, ...over });
const chargeRow = (over = {}) => ({ id: 7700777, listingMapId: T.listingId, reservationId: Number(RID), type: "charge", title: "unrelated manual charge", currency: "USD", paymentMethod: "credit_card", amount: 5, status: "paid", paymentProvider: "offline", ...over });
function fakeExchange(o = {}) {
  const calls = [];
  const ex = async (req) => {
    calls.push({ method: req.method, url: req.url, hasAuth: typeof req.headers?.Authorization === "string", maxBytes: req.maxBytes, hasSignal: req.signal instanceof AbortSignal });
    const u = new URL(req.url);
    if (o.throwOn === calls.length) throw Object.assign(new Error("socket reset: raw provider text MUST NOT leak"), { code: "EXCHANGE_NETWORK_ERROR" });
    if (/^\/v1\/reservations\/\d+$/.test(u.pathname)) return o.identity ?? reply(200, { status: "success", result: reservation() });
    if (u.pathname === "/v1/guestPayments/charges") return o.list ?? reply(200, listEnv([]));
    return reply(404, { status: "fail" });
  };
  return { ex, calls };
}
let tooling = null;
const load = async () => tooling ??= (await (async () => { const lt = await P.loadTooling(TOOLING); assert.equal(lt.ok, true, JSON.stringify(lt)); return lt.tooling; })());
const run = async (o = {}) => { const f = fakeExchange(o); const r = await P.runProbe({ tooling: await load(), exchange: f.ex, credential: () => "synthetic-hostaway-token", clientSnapshotId: "c17-test", ...o.over }); return { r, calls: f.calls }; };
const LEAK = /SHOULD-NEVER-APPEAR|example\.invalid|synthetic-hostaway-token|Authorization|Bearer|OUTPUT_SENTINEL|socket reset|raw provider|322 000|XXXXXXXXXX/;
const noLeak = (r) => { const s = JSON.stringify(r) + P.formatResult(r); assert.doesNotMatch(s, LEAK, "no raw body / guest / token / sentinel / exception text in the result or the formatted line"); assert.doesNotMatch(P.formatResult(r), /\n.+/, "one output line"); };

// ---------------------------------------------------------------------------------------------------------------------------------
test("F4 closure manifest: the independent transitive scan of the four roots at E7_TOOLING_DIR equals the pinned 8-file manifest (set + digests); a drifted TRANSITIVE dependency (compensation-proof), an extra transitive import, or a missing dependency is refused BEFORE any import, with zero module imports and zero exchange calls", async () => {
  const lt = await P.loadTooling(TOOLING);
  assert.equal(lt.ok, true, JSON.stringify(lt)); assert.deepEqual(lt.manifest, P.MANIFEST);
  assert.deepEqual(Object.keys(P.MANIFEST).sort(), ["lib/checkout/capture-proof.js", "lib/checkout/compensation-proof.js", "lib/checkout/intent-state.js", "lib/checkout/offline-charge-proof.js", "lib/checkout/recovery-plan.js", "lib/hostaway-reservations.js", "scripts/e7-connected/http-transports.mjs", "scripts/e7-connected/real-exchange.mjs"]);
  const imports = []; const importModule = async (p) => { imports.push(p); throw new Error("must not import"); };
  const read = (mut) => async (p) => { const b = readFileSync(p); return mut(p, b); };
  const drift = await P.loadTooling(TOOLING, { importModule, readFile: read((p, b) => p.endsWith("lib/checkout/compensation-proof.js") ? Buffer.concat([b, Buffer.from("\n// drift")]) : b) });
  assert.deepEqual([drift.ok, drift.code, drift.file, drift.extra, drift.missing], [false, "TOOLING_CLOSURE_MISMATCH", "lib/checkout/compensation-proof.js", [], []]);
  const extra = await P.loadTooling(TOOLING, { importModule, readFile: read((p, b) => p.endsWith("lib/checkout/recovery-plan.js") ? Buffer.concat([b, Buffer.from('\nimport "./final-price.js";\n')]) : b) });
  assert.deepEqual([extra.ok, extra.code, extra.extra.includes("lib/checkout/final-price.js"), extra.extra.length > 0, extra.missing], [false, "TOOLING_CLOSURE_MISMATCH", true, true, []], JSON.stringify(extra));
  const missing = await P.loadTooling(TOOLING, { importModule, readFile: read((p) => { if (p.endsWith("lib/checkout/intent-state.js")) throw new Error("ENOENT"); return readFileSync(p); }) });
  assert.deepEqual([missing.ok, missing.code, missing.file], [false, "TOOLING_INVALID", "lib/checkout/intent-state.js"]);
  const rootDrift = await P.loadTooling(TOOLING, { importModule, readFile: read((p, b) => p.endsWith("real-exchange.mjs") ? Buffer.from(b.toString("utf8").replace("keepAlive: false", "keepAlive: true")) : b) });
  assert.deepEqual([rootDrift.ok, rootDrift.code, rootDrift.file], [false, "TOOLING_CLOSURE_MISMATCH", "scripts/e7-connected/real-exchange.mjs"]);
  assert.deepEqual([imports, (await P.loadTooling("/nonexistent/dir", { importModule })).code, GUARD.request, GUARD.Agent], [[], "TOOLING_INVALID", 0, 0], "no import, no exchange, no network on any refusal");
});

test("P1 happy shape: ONE identity GET then ONE list GET with the exact accepted selector; identity bound; empty list → SHAPE_COMPATIBLE, matching 0; exactly 2 calls, both GET, each with an AbortSignal and the probe's maxBytes; Authorization on the wire but never in the result", async () => {
  const { r, calls } = await run();
  assert.equal(r.stop, null, JSON.stringify(r)); assert.equal(r.outcome, "SHAPE_COMPATIBLE");
  assert.deepEqual(calls.map((c) => [c.method, c.url, c.hasAuth, c.maxBytes, c.hasSignal]), [["GET", `https://api.hostaway.com/v1/reservations/${RID}`, true, P.BUDGETS.maxBytes, true], ["GET", `https://api.hostaway.com/v1/guestPayments/charges?limit=500&reservationIds=${RID}`, true, P.BUDGETS.maxBytes, true]]);
  assert.deepEqual([r.calls, r.attempted, r.urls], [2, 2, [`GET /v1/reservations/${RID}`, `GET /v1/guestPayments/charges?limit=500&reservationIds=${RID}`]]);
  assert.deepEqual(r.identity, { httpStatus: 200, envelope: "success", ok: true, code: null, reservation: { reservationId: RID, listingId: T.listingId, channelId: 2000, from: T.from, to: T.to, totalMinor: T.finalTotalMinor, currency: "USD", status: "new", bookingRefMatches: true } });
  assert.deepEqual([r.list.ok, r.list.rowCount, r.list.matchingChargeCount, r.list.unknownValues, r.list.typesSeen, r.list.pagination], [true, 0, 0, 0, [], { offset: 0, limit: 500, continuationKeys: [] }]);
  assert.deepEqual(r.budgets, { ...P.BUDGETS }); assert.ok(Number.isSafeInteger(r.elapsedMs));
  noLeak(r);
});

test("F3 safe enums + adversarial strings: provider-controlled values (type / status / paymentProvider / paymentMethod / currency / reservation status) are mapped to approved enums or UNKNOWN; sentinels, contact-like strings, newlines and 5000-char labels never reach the result or the formatted line; any UNKNOWN downgrades the outcome to SHAPE_COMPATIBLE_WITH_UNKNOWN_VALUES; codes outside the allowlist become UNKNOWN_CODE", async () => {
  const rows = [chargeRow({ status: SENTINEL, paymentProvider: SENTINEL, paymentMethod: CONTACT, title: BIG }), chargeRow({ id: 7700778, type: "refund", amount: -5, status: "paid", currency: "USD" }), chargeRow({ id: 7700779, currency: "EUR", title: CONTACT })];
  const { r } = await run({ list: reply(200, listEnv(rows)) });
  assert.equal(r.stop, null, JSON.stringify(r)); assert.equal(r.outcome, "SHAPE_COMPATIBLE_WITH_UNKNOWN_VALUES");
  assert.deepEqual(r.list.rows[0], { chargeId: "7700777", type: "charge", status: "UNKNOWN", amountMinor: 500, currency: "USD", paymentProvider: "UNKNOWN", paymentMethod: "UNKNOWN" });
  assert.deepEqual(r.list.rows[2].currency, "UNKNOWN"); assert.equal(r.list.unknownValues, 4); assert.deepEqual(r.list.typesSeen, ["charge", "refund"]);
  noLeak(r);
  // reservation status / currency enums on the identity summary (status must be "new" to pass the proof; currency is validated by the proof; enums still applied)
  const ok = await run(); assert.deepEqual([ok.r.identity.reservation.status, ok.r.identity.reservation.currency], ["new", "USD"]);
  assert.deepEqual([P.safeEnum("chargeStatus", SENTINEL), P.safeEnum("currency", "usd"), P.safeEnum("paymentMethod", null), P.safeCode("NOT_A_REAL_CODE"), P.safeCode(SENTINEL), P.safeCode("LIST_HTTP_STATUS")], ["UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN_CODE", "UNKNOWN_CODE", "LIST_HTTP_STATUS"]);
  // an exception message is never stored: only its allowlisted code
  const thrown = await run({ throwOn: 1 }); assert.deepEqual([thrown.r.stop, thrown.r.transportCode], ["IDENTITY_TRANSPORT_ERROR", "EXCHANGE_FAILED"], "the accepted transport normalises every exchange rejection to EXCHANGE_FAILED; the probe stores only that allowlisted code"); noLeak(thrown.r);
  const f = fakeExchange(); f.ex = async () => { throw new Error(SENTINEL); };
  const weird = await P.runProbe({ tooling: await load(), exchange: f.ex, credential: () => "synthetic-hostaway-token" });
  assert.deepEqual([weird.stop, weird.transportCode], ["IDENTITY_TRANSPORT_ERROR", "EXCHANGE_FAILED"]); noLeak(weird);
});

test("N1 (C25 / C21-F1 at 4ed7a636): the DOCUMENTED null-provider list row (public Hostaway docs 2026-11-13) is accepted by the NEW pinned proof as an UNRELATED row → outcome SHAPE_COMPATIBLE_WITH_UNKNOWN_VALUES (provider null → enum UNKNOWN, never inferred offline; awaiting / credit_card_online → UNKNOWN), matching 0, exactly 2 GETs; a missing / undefined / numeric / array provider still STOPs LIST_REFUSED / LIST_ROW_PAYMENTPROVIDER_INVALID; no raw title / description / contact / sentinel leaks; GET-only observation — no eligibility or readiness claim", async () => {
  const docRow = (over = {}) => ({ id: 8700001, listingMapId: T.listingId, reservationId: Number(RID), autopaymentId: 34231, type: "charge", title: "Charge " + SENTINEL, description: CONTACT, currency: "USD", paymentMethod: "credit_card_online",
    amount: 10, capturedAmount: null, status: "awaiting", paymentProvider: null, paymentProviderMessage: null, paymentProviderInvoiceId: null, paymentProviderChargeId: null, scheduledDate: null, chargeDate: null, holdReleaseDate: null, isManual: 0, autoChargeId: null, triggerEvent: null, triggerTimeDelta: 0, flatFee: null, percentageFee: null, transactions: [], ...over });
  const { r, calls } = await run({ list: reply(200, listEnv([docRow()])) });
  assert.equal(r.stop, null, JSON.stringify(r)); assert.equal(r.outcome, "SHAPE_COMPATIBLE_WITH_UNKNOWN_VALUES");
  assert.deepEqual(r.list.rows[0], { chargeId: "8700001", type: "charge", status: "UNKNOWN", amountMinor: 1000, currency: "USD", paymentProvider: "UNKNOWN", paymentMethod: "UNKNOWN" });
  assert.deepEqual([r.list.rowCount, r.list.matchingChargeCount, r.list.unknownValues, r.list.sameAmountPaidCount, r.list.lookalikeCount, calls.length, r.calls], [1, 0, 3, 0, 0, 2, 2]);
  assert.doesNotMatch(JSON.stringify(r) + P.formatResult(r), /offline/, "a null provider is never inferred to \"offline\" anywhere in the output"); noLeak(r);
  const missing = docRow(); delete missing.paymentProvider;
  for (const [row, label] of [[missing, "missing"], [docRow({ paymentProvider: undefined }), "undefined"], [docRow({ paymentProvider: 0 }), "number"], [docRow({ paymentProvider: ["offline"] }), "array"], [docRow({ paymentProvider: { offline: true } }), "object"]]) {
    const x = await run({ list: reply(200, listEnv([row])) });
    assert.deepEqual([x.r.stop, x.r.list.ok, x.r.list.code, x.calls.length], ["LIST_REFUSED", false, "LIST_ROW_PAYMENTPROVIDER_INVALID", 2], label); noLeak(x.r); }
  // a null-provider row that carries the exact marker title for the fixed target is still counted as a marker by the accepted observation (title decides)
  const m = await run({ list: reply(200, listEnv([docRow({ id: 8700002, title: `maraVilla payment mvoch1-${T.intentId}`, amount: 140, status: "paid" })])) });
  assert.deepEqual([m.r.stop, m.r.list.matchingChargeCount, m.r.list.rows[0].paymentProvider], [null, 1, "UNKNOWN"], JSON.stringify(m.r.list));
});

test("P3 identity refusals STOP before any list call (exactly 1 call); codes are allowlisted; nothing from the reply is echoed", async () => {
  const cases = [
    [reply(200, { status: "success", result: reservation({ status: "cancelled" }) }), "IDENTITY_STATUS_NOT_ACTIVE"],
    [reply(200, { status: "success", result: reservation({ status: SENTINEL }) }), "IDENTITY_STATUS_INVALID"],
    [reply(200, { status: "success", result: reservation({ listingMapId: 603566 }) }), "IDENTITY_LISTING_MISMATCH"],
    [reply(200, { status: "success", result: reservation({ departureDate: "2026-11-25" }) }), "IDENTITY_DEPARTURE_MISMATCH"],
    [reply(200, { status: "success", result: reservation({ totalPrice: 150 }) }), "IDENTITY_TOTAL_MISMATCH"],
    [reply(200, { status: "success", result: reservation({ customFieldValues: [] }) }), "IDENTITY_REF_MISMATCH"],
    [reply(200, { status: "success", result: reservation({ customFieldValues: [{ customFieldId: P.CONFIG.refFieldId, value: "MV-OTHER01" }] }) }), "IDENTITY_REF_MISMATCH"],
    [reply(200, { status: "success", result: reservation({ channelId: 2018 }) }), "IDENTITY_CHANNEL_MISMATCH"],
    [reply(200, { status: "success", result: reservation({ id: 71700932 }) }), "IDENTITY_RESERVATION_ID_MISMATCH"],
    [reply(200, { status: "success", result: reservation({ currency: "EUR" }) }), "IDENTITY_CURRENCY_MISMATCH"],
    [reply(200, { status: "fail", result: null, message: SENTINEL }), "IDENTITY_FAIL_ENVELOPE"],
    [reply(200, { result: reservation() }), "IDENTITY_MALFORMED_ENVELOPE"],
    [reply(404, { status: "fail", message: CONTACT }), "IDENTITY_HTTP_STATUS"],
    [reply(200, { status: "success", result: SENTINEL }), "IDENTITY_RESULT_NOT_OBJECT"],
  ];
  for (const [identity, code] of cases) {
    const { r, calls } = await run({ identity });
    assert.deepEqual([r.stop, r.identity.ok, r.identity.code, r.identity.reservation, calls.length, r.list], ["IDENTITY_REFUSED", false, code, null, 1, undefined], `${code}: ${JSON.stringify(r)}`);
    assert.ok(P.CODE_ALLOWLIST.includes(r.identity.code)); noLeak(r);
  }
});

test("F2 pagination (explicit, no truthiness) + P4 list refusals: offset500/count0 → STOP; nonzero / malformed offset, incompatible / malformed limit, ANY continuation key (even false / null / 0) → STOP; full page → STOP; absent or null offset/limit are the defined defaults; proof refusals (fail envelope, non-200, count mismatch, foreign rows, duplicate, malformed) → STOP; never a third call, never another selector", async () => {
  const full = Array.from({ length: 500 }, (_, i) => chargeRow({ id: 7800000 + i }));
  const cases = [
    [listEnv([], { offset: 500 }), "LIST_OFFSET_NOT_ZERO", "OFFSET_NOT_ZERO"],
    [listEnv([chargeRow()], { offset: 1 }), "LIST_OFFSET_NOT_ZERO", "OFFSET_NOT_ZERO"],
    [listEnv([], { offset: "0" }), "LIST_OFFSET_MALFORMED", "OFFSET_MALFORMED"],
    [listEnv([], { offset: 0.5 }), "LIST_OFFSET_MALFORMED", "OFFSET_MALFORMED"],
    [listEnv([], { offset: false }), "LIST_OFFSET_MALFORMED", "OFFSET_MALFORMED"],
    [listEnv([], { limit: 100 }), "LIST_LIMIT_INCOMPATIBLE", "LIMIT_INCOMPATIBLE"],
    [listEnv([], { limit: "500" }), "LIST_LIMIT_MALFORMED", "LIMIT_MALFORMED"],
    [listEnv([], { hasMore: false }), "LIST_CONTINUATION_MARKER_PRESENT", "CONTINUATION_MARKER_PRESENT"],
    [listEnv([], { nextPage: null }), "LIST_CONTINUATION_MARKER_PRESENT", "CONTINUATION_MARKER_PRESENT"],
    [listEnv([], { page: 0 }), "LIST_CONTINUATION_MARKER_PRESENT", "CONTINUATION_MARKER_PRESENT"],
    [listEnv([], { cursor: "" }), "LIST_CONTINUATION_MARKER_PRESENT", "CONTINUATION_MARKER_PRESENT"],
    [listEnv([], { totalPages: 1 }), "LIST_CONTINUATION_MARKER_PRESENT", "CONTINUATION_MARKER_PRESENT"],
    [listEnv(full), "LIST_PAGE_FULL_AMBIGUOUS", "PAGE_FULL"],
    [{ status: "fail", result: [], message: SENTINEL }, "LIST_REFUSED", "LIST_FAIL_ENVELOPE"],
    [listEnv([chargeRow()], { count: 2 }), "LIST_REFUSED", "LIST_COUNT_LENGTH_MISMATCH"],
    [listEnv([chargeRow({ reservationId: 71700932 })]), "LIST_REFUSED", "LIST_FOREIGN_RESERVATION_ROW"],
    [listEnv([chargeRow({ listingMapId: 603566 })]), "LIST_REFUSED", "LIST_FOREIGN_LISTING_ROW"],
    [listEnv([chargeRow(), chargeRow()]), "LIST_REFUSED", "LIST_DUPLICATE_ID"],
    [listEnv([chargeRow({ amount: "5" })]), "LIST_REFUSED", "LIST_ROW_AMOUNT_INVALID"],
    [listEnv([chargeRow({ type: SENTINEL })]), "LIST_REFUSED", "LIST_ROW_TYPE_UNKNOWN"],
  ];
  for (const [json, stop, code] of cases) {
    const { r, calls } = await run({ list: reply(200, json) });
    assert.deepEqual([r.stop, r.identity.ok, r.list.ok, r.list.code, calls.length, r.calls], [stop, true, false, code, 2, 2], `${code}: ${JSON.stringify(r)}`);
    assert.ok(P.CODE_ALLOWLIST.includes(r.list.code)); noLeak(r);
  }
  const s500 = await run({ list: reply(500, { status: "fail" }) }); assert.deepEqual([s500.r.stop, s500.r.list.code], ["LIST_REFUSED", "LIST_HTTP_STATUS"]);
  for (const over of [{ offset: null }, { limit: null }, { offset: undefined, limit: undefined }]) {
    const json = listEnv([chargeRow()]); for (const k of Object.keys(over)) { if (over[k] === undefined) delete json[k]; else json[k] = over[k]; }
    const { r } = await run({ list: reply(200, json) });
    assert.equal(r.stop, null, "absent / null offset or limit are the defined defaults: " + JSON.stringify(r.list));
  }
  assert.deepEqual([P.paginationRefusal({ offset: 0, limit: 500 }, 499), P.paginationRefusal({ offset: 0, limit: 500 }, 500), P.paginationRefusal({}, 0), P.paginationRefusal({ nextOffset: 0 }, 0)], [null, "PAGE_FULL", null, "CONTINUATION_MARKER_PRESENT"]);
});

test("P5 transport: redirects are refused by the accepted transport (never followed); a thrown exchange is final (no retry); an identity transport error means ZERO list calls; an invalid credential never reaches the wire; the per-call deadline aborts a stalled exchange and the overall deadline stops the run (fake timers / clock; timers released)", async () => {
  let x = await run({ identity: reply(302, {}) });
  assert.deepEqual([x.r.stop, x.r.transportCode, x.calls.length], ["IDENTITY_TRANSPORT_ERROR", "REDIRECT_REFUSED", 1]);
  x = await run({ list: reply(301, {}) });
  assert.deepEqual([x.r.stop, x.r.transportCode, x.calls.length], ["LIST_TRANSPORT_ERROR", "REDIRECT_REFUSED", 2]);
  x = await run({ throwOn: 1 }); assert.deepEqual([x.r.stop, x.calls.length, x.r.attempted], ["IDENTITY_TRANSPORT_ERROR", 1, 1], "no retry, no list");
  x = await run({ throwOn: 2 }); assert.deepEqual([x.r.stop, x.calls.length, x.r.attempted], ["LIST_TRANSPORT_ERROR", 2, 2], "no retry");
  x = await run({ over: { credential: () => "" } }); assert.deepEqual([x.r.stop, x.r.transportCode, x.calls.length], ["IDENTITY_TRANSPORT_ERROR", "CREDENTIAL_INVALID", 0]);
  const bad = await P.runProbe({ tooling: await load(), exchange: "nope", credential: () => "t" }); assert.deepEqual([bad.stop, bad.calls], ["TRANSPORT_INVALID", 0]);
  // stall: the exchange never settles until its signal aborts → the probe's per-call timer fires (fake timers), the transport reports ABORTED, no retry
  const fired = []; const timers = { setTimeout: (fn, ms) => { fired.push(ms); const h = { fn }; setImmediate(() => h.fn()); return h; }, clearTimeout: (h) => { h.cleared = true; } };
  const stall = { calls: 0, ex: (req) => new Promise((_, rej) => { stall.calls += 1; req.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { code: "EXCHANGE_ABORTED" })), { once: true }); }) };
  const s = await P.runProbe({ tooling: await load(), exchange: stall.ex, credential: () => "synthetic-hostaway-token", timers });
  assert.deepEqual([s.stop, s.transportCode, stall.calls, fired], ["IDENTITY_TRANSPORT_ERROR", "ABORTED_IN_FLIGHT", 1, [P.BUDGETS.callMs]], JSON.stringify(s));
  // overall deadline: a clock that jumps past totalMs after the first call → the second call is never attempted (DEADLINE), timer released
  let now = 1_000_000; const clock = () => now; const t2 = { handles: [], setTimeout: (fn, ms) => { const h = { fn, ms, cleared: false }; t2.handles.push(h); return h; }, clearTimeout: (h) => { h.cleared = true; } };
  const f2 = fakeExchange(); const jump = async (req) => { const r = await f2.ex(req); now += P.BUDGETS.totalMs + 1; return r; };
  const d = await P.runProbe({ tooling: await load(), exchange: jump, credential: () => "synthetic-hostaway-token", clock, timers: t2 });
  assert.deepEqual([d.stop, d.calls, d.identity.ok, t2.handles.length, t2.handles.every((h) => h.cleared), t2.handles[0].ms], ["DEADLINE", 1, true, 1, true, Math.min(P.BUDGETS.callMs, P.BUDGETS.totalMs)], JSON.stringify(d));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// F1: the ACCEPTED pinned real exchange (createE7RealExchange, provider hostaway) over a FAKE node:https primitive — exactly what --probe wires
class FakeRes extends EventEmitter { constructor(req, statusCode, rawHeaders) { super(); this.req = req; this.statusCode = statusCode; this.rawHeaders = rawHeaders; this.complete = false; this.destroyCalls = 0; this.closed = false; }
  destroy() { this.destroyCalls += 1; if (this._d) return; this._d = true; process.nextTick(() => { if (!this.closed) { this.closed = true; this.emit("close"); } this.req._closeOnce(); }); } }
class FakeReq extends EventEmitter { constructor(fx, options) { super(); this.fx = fx; this.options = options; this.endCalls = 0; this.destroyCalls = 0; this.res = null; this.closed = false; }
  end() { this.endCalls += 1; if (this.fx.onEnd) this.fx.onEnd(this); }
  _closeOnce() { if (!this.closed) { this.closed = true; this.emit("close"); } }
  destroy() { this.destroyCalls += 1; if (this._d) return; this._d = true; process.nextTick(() => { const res = this.res; if (res === null) { this.emit("error", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })); this._closeOnce(); return; }
    if (!res.closed) { res.emit("aborted"); this._closeOnce(); res.emit("error", Object.assign(new Error("aborted"), { code: "ECONNRESET" })); res.closed = true; res.emit("close"); } else this._closeOnce(); }); } }
function fakePrimitive(script) {
  const fx = { agents: [], reqs: [], onEnd: null };
  class FakeAgent { constructor(opts) { this.opts = opts; this.destroyCalls = 0; fx.agents.push(this); } destroy() { this.destroyCalls += 1; } }
  fx.primitive = { request: (options) => { const r = new FakeReq(fx, options); fx.reqs.push(r); return r; }, Agent: FakeAgent };
  fx.onEnd = (req) => script(req, fx.reqs.length);
  return fx;
}
const respond = (req, status, body, raw = ["Content-Type", "application/json"]) => { const res = new FakeRes(req, status, raw); req.res = res; req.emit("response", res); if (body !== undefined) { res.emit("data", body); res.complete = true; res.emit("end"); req._closeOnce(); res.closed = true; res.emit("close"); } return res; };
const RESV = () => enc({ status: "success", result: reservation() });
async function realRun(script, over = {}) {
  const tl = await load(); const fx = fakePrimitive(script);
  const rx = tl.createE7RealExchange({ provider: "hostaway", primitive: fx.primitive }); assert.equal(rx.ok, true, JSON.stringify(rx));
  fx.exchangeCodes = []; const spy = (req) => rx.exchange(req).catch((e) => { fx.exchangeCodes.push(e?.code ?? null); throw e; });
  const r = await P.runProbe({ tooling: tl, exchange: spy, credential: () => "synthetic-hostaway-token", clientSnapshotId: "c17-real", ...over });
  await new Promise((res) => setImmediate(res)); await new Promise((res) => setImmediate(res));
  return { r, fx };
}
const settled = (fx) => ({ agents: fx.agents.length, reqs: fx.reqs.length, agentDestroyed: fx.agents.map((a) => a.destroyCalls), reqDestroyed: fx.reqs.map((q) => q.destroyCalls), ends: fx.reqs.map((q) => q.endCalls), keepAlive: fx.agents.map((a) => a.opts.keepAlive) });

test("F1a real exchange happy path over a fake primitive: TWO ClientRequests on TWO fresh non-keep-alive Agents, GET only, exact paths, Authorization set by the transport, bodies streamed under maxBytes, every Agent destroyed (teardown), SHAPE_COMPATIBLE", async () => {
  const { r, fx } = await realRun((req, n) => process.nextTick(() => respond(req, 200, n === 1 ? RESV() : enc(listEnv([chargeRow()])))));
  assert.equal(r.stop, null, JSON.stringify(r)); assert.equal(r.outcome, "SHAPE_COMPATIBLE");
  assert.deepEqual(fx.reqs.map((q) => [q.options.method, q.options.path, q.options.hostname, typeof q.options.headers.Authorization]), [["GET", `/v1/reservations/${RID}`, "api.hostaway.com", "string"], ["GET", `/v1/guestPayments/charges?limit=500&reservationIds=${RID}`, "api.hostaway.com", "string"]]);
  assert.deepEqual(settled(fx), { agents: 2, reqs: 2, agentDestroyed: [1, 1], reqDestroyed: [0, 0], ends: [1, 1], keepAlive: [false, false] });
  noLeak(r); assert.deepEqual([GUARD.request, GUARD.Agent], [0, 0]);
});

test("F1b oversized / streaming responses: a Content-Length above the probe's maxBytes is refused before any body work; a streamed body that crosses maxBytes is refused mid-stream (exchange code EXCHANGE_BODY_TOO_LARGE, surfaced by the accepted transport as EXCHANGE_FAILED), the request + response are destroyed, NO retry, no list call; the Agent is torn down", async () => {
  const big = new Uint8Array(P.BUDGETS.maxBytes + 1);
  let x = await realRun((req) => process.nextTick(() => { const res = new FakeRes(req, 200, ["Content-Type", "application/json", "Content-Length", String(big.length)]); req.res = res; req.emit("response", res); }));
  assert.deepEqual([x.r.stop, x.r.transportCode, x.fx.exchangeCodes, x.r.calls, x.fx.reqs.length, x.fx.reqs[0].destroyCalls >= 1, x.fx.agents[0].destroyCalls], ["IDENTITY_TRANSPORT_ERROR", "EXCHANGE_FAILED", ["EXCHANGE_BODY_TOO_LARGE"], 1, 1, true, 1], JSON.stringify(x.r));
  x = await realRun((req) => process.nextTick(() => { const res = new FakeRes(req, 200, ["Content-Type", "application/json"]); req.res = res; req.emit("response", res); res.emit("data", big.subarray(0, 200_000)); res.emit("data", big.subarray(0, 70_000)); }));
  assert.deepEqual([x.r.stop, x.r.transportCode, x.fx.exchangeCodes, x.r.calls, x.fx.reqs.length, x.fx.reqs[0].destroyCalls >= 1, x.fx.reqs[0].res.destroyCalls >= 1, x.fx.agents[0].destroyCalls], ["IDENTITY_TRANSPORT_ERROR", "EXCHANGE_FAILED", ["EXCHANGE_BODY_TOO_LARGE"], 1, 1, true, true, 1], JSON.stringify(x.r));
  noLeak(x.r);
});

test("F1c stall / abort / teardown: a request that never responds is aborted by the probe's per-call deadline (fake timer) → EXCHANGE_ABORTED → ABORTED_IN_FLIGHT, the ClientRequest and Agent are destroyed, exactly one request, no list; a 3xx is never followed (zero Location read, one request); gzip is refused", async () => {
  const timers = { setTimeout: (fn) => { const h = { fn }; setImmediate(() => setImmediate(() => h.fn())); return h; }, clearTimeout: (h) => { h.cleared = true; } };
  let x = await realRun(() => { /* never respond */ }, { timers });
  assert.deepEqual([x.r.stop, x.r.transportCode, x.fx.exchangeCodes, x.r.calls, x.fx.reqs.length, x.fx.reqs[0].destroyCalls >= 1, x.fx.agents[0].destroyCalls], ["IDENTITY_TRANSPORT_ERROR", "ABORTED_IN_FLIGHT", ["EXCHANGE_ABORTED"], 1, 1, true, 1], JSON.stringify(x.r));
  x = await realRun((req) => process.nextTick(() => respond(req, 302, undefined, ["Location", "https://api.hostaway.com/v1/reservations/71700932", "Content-Type", "application/json"])));
  assert.deepEqual([x.r.stop, x.r.transportCode, x.fx.exchangeCodes, x.r.calls, x.fx.reqs.length], ["IDENTITY_TRANSPORT_ERROR", "REDIRECT_REFUSED", [], 1, 1]);
  x = await realRun((req) => process.nextTick(() => respond(req, 200, RESV(), ["Content-Type", "application/json", "Content-Encoding", "gzip"])));
  assert.deepEqual([x.r.stop, x.r.transportCode, x.fx.exchangeCodes, x.r.calls], ["IDENTITY_TRANSPORT_ERROR", "EXCHANGE_FAILED", ["EXCHANGE_ENCODING_REFUSED"], 1]);
  noLeak(x.r);
});

test("P6 the probe's own guard: anything but the two exact GET URLs on api.hostaway.com is refused before the exchange (POST / other host / other reservation / list root / wrong or extra query / body / third call)", async () => {
  const st = () => ({ attempted: 0, sent: 0, urls: [], guardRefusals: [] });
  const ex = async () => reply(200, {});
  for (const [req, why] of [
    [{ method: "POST", url: `https://api.hostaway.com/v1/guestPayments/charges/${RID}`, headers: {}, body: "{}" }, "NOT_GET"],
    [{ method: "GET", url: `https://api.evil.example/v1/reservations/${RID}`, headers: {}, body: null }, "ORIGIN"],
    [{ method: "GET", url: "https://api.hostaway.com/v1/reservations/71700932", headers: {}, body: null }, "PATH"],
    [{ method: "GET", url: "https://api.hostaway.com/v1/reservations", headers: {}, body: null }, "PATH"],
    [{ method: "GET", url: `https://api.hostaway.com/v1/guestPayments/charges?limit=500&reservationIds=71700932`, headers: {}, body: null }, "QUERY"],
    [{ method: "GET", url: `https://api.hostaway.com/v1/guestPayments/charges?limit=100&reservationIds=${RID}`, headers: {}, body: null }, "QUERY"],
    [{ method: "GET", url: `https://api.hostaway.com/v1/guestPayments/charges?limit=500&reservationIds=${RID}&offset=500`, headers: {}, body: null }, "QUERY"],
    [{ method: "GET", url: `https://api.hostaway.com/v1/reservations/${RID}?includeResources=1`, headers: {}, body: null }, "QUERY"],
    [{ method: "GET", url: `https://api.hostaway.com/v1/reservations/${RID}`, headers: {}, body: "{}" }, "BODY"],
    [{ method: "GET", url: "not a url", headers: {}, body: null }, "URL"],
  ]) { const s = st(); await assert.rejects(P.guardedExchange(ex, s)(req), /GUARD_REFUSED/); assert.deepEqual([s.guardRefusals, s.sent], [[why], 0], why); }
  const s = st(); const g = P.guardedExchange(ex, s);
  const ok = { method: "GET", url: `https://api.hostaway.com/v1/reservations/${RID}`, headers: {}, body: null };
  await g(ok); await g(ok); await assert.rejects(g(ok), /GUARD_REFUSED/); assert.deepEqual([s.sent, s.guardRefusals], [2, ["BUDGET"]]);
});

test("P7 static: node built-ins only; no fetch / arrayBuffer / POST / PUT / DELETE / DB / worker / record / cancel / refund / notify / Stripe text in code; no executor phase; env only after the main guard; --probe wires createE7RealExchange only; fixed frozen target / budgets; every code the probe can emit is in CODE_ALLOWLIST", () => {
  const src = readFileSync(join(ROOT, "scripts/e7-hosted-charge-list-probe.mjs"), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.deepEqual([...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]), ["node:crypto", "node:fs/promises", "node:path", "node:url"]);
  assert.doesNotMatch(code, /fetch\(|arrayBuffer|method: "(POST|PUT|DELETE|PATCH)"|createPhaseExecutors|createOfflineCharge|recording-worker|repo\.js|operations\.js|statuses\/cancelled|refund_|notify|api\.stripe\.com|createE7StripeTestSend|\/guestPayments\/charges\/\$/);
  assert.match(code, /createE7RealExchange\(\{ provider: "hostaway" \}\)/);
  assert.ok(src.indexOf("process.env") > src.indexOf("import.meta.main === true"), "env only after the main guard");
  assert.deepEqual([T.listingId, T.reservationId, T.ref, T.from, T.to, T.currency, T.finalTotalMinor, T.capturedMinor, P.MAX_CALLS, P.LIST_LIMIT], [606998, "71700931", "MV-8L79DEJ7", "2026-11-23", "2026-11-24", "USD", 14000, 14000, 2, 500]);
  assert.ok([T, P.CONFIG, P.ALLOWED, P.BUDGETS, P.MANIFEST, P.ENUMS, P.CODE_ALLOWLIST].every(Object.isFrozen));
  for (const c of [...P.STOP_CODES, "PAGE_FULL", "OFFSET_NOT_ZERO", "OFFSET_MALFORMED", "LIMIT_INCOMPATIBLE", "LIMIT_MALFORMED", "CONTINUATION_MARKER_PRESENT"]) assert.ok(P.CODE_ALLOWLIST.includes(c), c);
});
