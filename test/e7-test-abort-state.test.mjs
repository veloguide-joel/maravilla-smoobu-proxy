// E7 operator TEST abort — E3 reducer + expectation + static boundary (pure; no I/O, no DB, no network, no provider).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createIntent, transition, publicStatus, allowedEvents, voidKey, STATES as S, DEFAULT_CONFIG, EVENTS, TEST_ABORT_REASON, testAbortEventId }
  from "../lib/checkout/intent-state.js";
import { validAbortExpectation, bindAbortExpectation, requestTestAbort, testAbortGate, listingAllowed, TEST_ABORT_EXPECTATION_KEYS } from "../lib/booking-db/test-abort.js";
import { buildAbortExpectation, abortPlanHash, classify, executeOperatorAbort } from "../scripts/e7-operator/test-abort.mjs";

const T0 = Date.UTC(2026, 9, 21, 15, 0, 0);
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const PRICE = { listingId: 606998, from: "2027-01-18", to: "2027-01-20", guests: 1, nights: 2, currency: "USD",
  standardTotalMinor: 25000, eligibleMinor: 20000, discountMinor: 2000, finalTotalMinor: 23000,
  policyVersion: "direct-v1", rateBps: 1000, lines: [], charge: { currency: "usd", amountMinor: 23000, quantity: 1 }, quoteHash: "a".repeat(64) };
const AUTH = { type: "PAYMENT_AUTHORIZED", paymentIntentId: "pi_TESTabort0001", sessionId: "cs_test_abort0001", amountMinor: 23000, currency: "usd", livemode: false,
  authorizationCreatedAt: T0 + 4 * MIN, captureBefore: T0 + 4 * MIN + 7 * DAY };
const RES = { reservationId: 61000001, listingId: 606998, from: "2027-01-18", to: "2027-01-20", totalMinor: 23000, currency: "USD" };
const CFG = Object.freeze({ testAbortEnabled: true, expectedLivemode: false });
function drive(intent, steps) {
  let cur = intent;
  for (const [ev, m] of steps) { const r = transition(cur, ev, { now: T0 + m * MIN }); assert.equal(r.ok, true, `${ev.type}: ${r.error}`); cur = r.intent; }
  return cur;
}
const authorized = () => drive(createIntent({ id: "int_ab", ref: "MV-AB0RT1", listingId: 606998, from: "2027-01-18", to: "2027-01-20", guests: 1, now: T0 }), [
  [{ type: "PRICE_CONFIRMED", price: PRICE }, 0], [{ type: "DETAILS_COLLECTED" }, 1], [{ type: "CHECKOUT_PREPARED", sessionId: "cs_test_abort0001" }, 2], [AUTH, 5]]);
const reserved = () => drive(authorized(), [[{ type: "RESERVATION_STARTED", workerId: "w", recheck: { bookable: true, priceSame: true } }, 6],
  [{ type: "RESERVATION_DISPATCHED", workerId: "w" }, 6], [{ type: "RESERVATION_SUCCEEDED", reservation: RES }, 7]]);
const abEv = (i, o = {}) => ({ type: "TEST_ABORT_REQUESTED", id: testAbortEventId(i.id, "pi_TESTabort0001", "61000001"), paymentIntentId: "pi_TESTabort0001", reservationId: "61000001", ...o });

test("A1 TEST abort: off by default; only reservation_confirmed; ONE cancel + ONE void + the existing queued alert; truthful reason; capture never claimed; queued != not charged", () => {
  assert.equal(DEFAULT_CONFIG.testAbortEnabled, false);
  assert.ok(EVENTS.includes("TEST_ABORT_REQUESTED"));
  assert.deepEqual(allowedEvents(S.RESERVATION_CONFIRMED).filter((e) => e === "TEST_ABORT_REQUESTED"), ["TEST_ABORT_REQUESTED"]);
  for (const st of Object.values(S)) if (st !== S.RESERVATION_CONFIRMED) assert.equal(allowedEvents(st).includes("TEST_ABORT_REQUESTED"), false, st);
  const i = reserved();
  assert.equal(i.counters.captureAttempts, 1);
  assert.equal(transition(i, abEv(i), { now: T0 + 8 * MIN }).error, "TEST_ABORT_DISABLED");
  assert.equal(transition(i, abEv(i), { now: T0 + 8 * MIN, config: { testAbortEnabled: true, expectedLivemode: true } }).error, "TEST_ABORT_TEST_MODE_ONLY");
  const r = transition(i, abEv(i), { now: T0 + 8 * MIN, config: CFG });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual([r.intent.status, r.intent.reasonCode], [S.CAPTURE_FAILED, TEST_ABORT_REASON]);
  assert.deepEqual(r.effects.map((e) => e.type), ["hostaway.cancel_reservation", "stripe.void_payment_intent", "alert.owner"]);
  assert.equal(r.effects[1].idempotencyKey, voidKey("int_ab", "pi_TESTabort0001"));
  assert.deepEqual(r.intent.settlement, { reservationCancelled: false, authorizationSettled: false });
  assert.deepEqual([r.intent.counters.cancelAttempts, r.intent.counters.voidAttempts, r.intent.counters.captureAttempts], [1, 0, 1]);
  assert.equal(r.effects.some((e) => e.type === "stripe.capture_payment_intent"), false, "no capture effect");
  assert.equal(publicStatus(r.intent), "release_requested");
  const again = transition(r.intent, abEv(i), { now: T0 + 9 * MIN, config: CFG });
  assert.deepEqual([again.ok, again.duplicate, again.effects.length], [true, true, 0]);
  // an ordinary capture_failed keeps its existing label; the accepted legs still finish it
  const cf = transition(i, { type: "CAPTURE_FAILED", definite: true, code: "card_declined" }, { now: T0 + 8 * MIN });
  assert.equal(publicStatus(cf.intent), "not_completed_not_charged");
  // the abort never fabricates a CAPTURE_FAILED event
  assert.equal(r.intent.history.at(-1).event, "TEST_ABORT_REQUESTED");
});

test("A2 TEST abort refusals: other states, wrong PI / reservation / id, non-TEST or captured payment, lease / settlement / counter history", () => {
  const a = authorized();
  assert.equal(transition(a, abEv(a), { now: T0 + 6 * MIN, config: CFG }).error, "ILLEGAL_TRANSITION");
  const i = reserved();
  const cap = transition(i, { type: "CAPTURE_SUCCEEDED", id: "evt_cap", amountMinor: 23000, currency: "usd" }, { now: T0 + 8 * MIN });
  assert.equal(transition(cap.intent, abEv(i), { now: T0 + 9 * MIN, config: CFG }).error, "ILLEGAL_TRANSITION", "payment_captured refused");
  const unk = transition(i, { type: "CAPTURE_OUTCOME_UNKNOWN", code: "TIMEOUT" }, { now: T0 + 8 * MIN });
  assert.equal(transition(unk.intent, abEv(i), { now: T0 + 9 * MIN, config: CFG }).error, "ILLEGAL_TRANSITION", "capture_unknown refused");
  assert.equal(transition(i, abEv(i, { paymentIntentId: "pi_OTHERabort001" }), { now: T0 + 8 * MIN, config: CFG }).error, "TEST_ABORT_PAYMENT_MISMATCH");
  assert.equal(transition(i, abEv(i, { reservationId: "61000002" }), { now: T0 + 8 * MIN, config: CFG }).error, "TEST_ABORT_RESERVATION_MISMATCH");
  assert.equal(transition(i, abEv(i, { id: "client-chosen" }), { now: T0 + 8 * MIN, config: CFG }).error, "TEST_ABORT_EVENT_ID");
  assert.equal(transition({ ...i, payment: { ...i.payment, livemode: true } }, abEv(i), { now: T0 + 8 * MIN, config: CFG }).error, "TEST_ABORT_PAYMENT_NOT_TEST");
  assert.equal(transition({ ...i, payment: { ...i.payment, capturedMinor: 1 } }, abEv(i), { now: T0 + 8 * MIN, config: CFG }).error, "TEST_ABORT_PAYMENT_NOT_TEST");
  for (const over of [{ lease: { workerId: "w", until: T0 + 9 * MIN } }, { dispatch: null }, { settlement: { reservationCancelled: false, authorizationSettled: false } },
    { counters: { ...i.counters, captureAttempts: 2 } }, { counters: { ...i.counters, voidAttempts: 1 } }, { counters: { ...i.counters, cancelAttempts: 1 } },
    { counters: { ...i.counters, offlineChargeAttempts: 1 } }]) {
    assert.equal(transition({ ...i, ...over }, abEv(i), { now: T0 + 8 * MIN, config: CFG }).error, "TEST_ABORT_HISTORY", JSON.stringify(over));
  }
});

const INVALID_DATES = Object.freeze([{ from: "2027-13-01" }, { from: "2027-00-10" }, { from: "2027-01-00" }, { to: "2027-01-99" }, { to: "2027-13-20" },
  { to: "2027-01-00" }, { from: "2027-02-30", to: "2027-03-05" }, { from: "2027-02-29", to: "2027-03-05" }, { from: "2027-01-20", to: "2027-01-18" },
  { from: "2027-01-18", to: "2027-01-18" }]);   // month 13 / 00, day 00 / 99, Feb rollover (2027 is not a leap year), reversed, empty stay
const FIELDS = Object.freeze({ intentId: "00000000-0000-4000-8000-00000000ab01", expectedVersion: 7, listingId: 606998, from: "2027-01-18", to: "2027-01-20", guests: 1,
  currency: "USD", finalTotalMinor: 23000, authorizedMinor: 23000, paymentIntentId: "pi_TESTabort0001", sessionId: "cs_test_abort0001",
  attemptId: "00000000-0000-4000-8000-00000000ab02", reservationId: "61000001", approvalRef: "synthetic-abort-1" });

test("A3 expectation: exact 15 keys, typed, allowlisted listing 606998 / USD only; plan hash over every field + schema + scope; gate disabled by default", () => {
  const e = buildAbortExpectation({ ...FIELDS });
  assert.ok(e);
  assert.deepEqual(Object.keys(e).sort(), [...TEST_ABORT_EXPECTATION_KEYS]);
  assert.equal(e.planHash, abortPlanHash(e));
  assert.equal(validAbortExpectation(e), true);
  for (const [k, v] of [["listingId", 603566], ["currency", "MXN"], ["authorizedMinor", 22999], ["reservationId", "0123"], ["from", "2027-02-30"], ["paymentIntentId", "pi_x"],
    ["sessionId", "cs_live_abcdefgh1"], ["guests", 0], ["expectedVersion", -1], ["approvalRef", "a b"]]) assert.equal(buildAbortExpectation({ ...FIELDS, [k]: v }), null, k);
  assert.equal(validAbortExpectation({ ...e, extra: 1 }), false);
  const g = { ...e }; delete g.approvalRef; assert.equal(validAbortExpectation(g), false);
  assert.equal(validAbortExpectation(Object.defineProperty({ ...e }, "guests", { get: () => 1, enumerable: true })), false, "accessor refused");
  assert.equal(validAbortExpectation(Object.assign(Object.create(null), e)), false, "exotic prototype refused");
  // root a1dcea0d: RegExp.test coerces — every regex-checked field must be a PRIMITIVE string (arrays, boxed values, numbers refused)
  const coerced = [];
  for (const k of ["intentId", "attemptId", "paymentIntentId", "sessionId", "approvalRef", "planHash"]) {
    coerced.push([k, [e[k]]], [k, new String(e[k])], [k, { toString: () => e[k] }]);
  }
  coerced.push(["approvalRef", 123], ["approvalRef", 123.5], ["approvalRef", new Number(123)], ["reservationId", 61000001], ["reservationId", [e.reservationId]],
    ["reservationId", new String(e.reservationId)], ["currency", ["USD"]], ["currency", new String("USD")], ["from", [e.from]], ["to", new String(e.to)],
    ["expectedVersion", new Number(7)], ["guests", "1"], ["listingId", new Number(606998)], ["finalTotalMinor", [23000]], ["authorizedMinor", new Number(23000)]);
  for (const [k, v] of coerced) {
    assert.equal(validAbortExpectation({ ...e, [k]: v }), false, `validAbortExpectation ${k}=${Object.prototype.toString.call(v)}`);
    assert.equal(bindAbortExpectation({ ...e, [k]: v }), null, `bind ${k}`);
    if (k !== "planHash") assert.equal(buildAbortExpectation({ ...FIELDS, [k]: v }), null, `build ${k}`);
  }
  // root (4dc4b4e review): regex-shaped but invalid / rolled-over / reversed dates are REFUSED (false / null), never thrown
  for (const over of INVALID_DATES) {
    assert.doesNotThrow(() => validAbortExpectation({ ...e, ...over }), JSON.stringify(over));
    assert.equal(validAbortExpectation({ ...e, ...over }), false, JSON.stringify(over));
    assert.equal(bindAbortExpectation({ ...e, ...over }), null, JSON.stringify(over));
    assert.equal(buildAbortExpectation({ ...FIELDS, ...over }), null, JSON.stringify(over));
  }
  // buildAbortExpectation never invokes a supplied getter (and refuses it), nor reads a planHash / extra / symbol key
  let getterCalls = 0;
  const withGetter = Object.defineProperty({ ...FIELDS }, "paymentIntentId", { get: () => { getterCalls += 1; return FIELDS.paymentIntentId; }, enumerable: true });
  assert.equal(buildAbortExpectation(withGetter), null); assert.equal(getterCalls, 0, "no getter invoked");
  for (const bad of [{ ...FIELDS, planHash: e.planHash }, { ...FIELDS, extra: 1 }, { ...FIELDS, [Symbol("x")]: 1 }, [FIELDS], null, "x"]) assert.equal(buildAbortExpectation(bad), null);
  // the bound copy is frozen and independent of the caller object
  const src = { ...e }; const b = bindAbortExpectation(src); src.paymentIntentId = "pi_TESTotherOne99"; src.expectedVersion = 99;
  assert.ok(Object.isFrozen(b)); assert.deepEqual([b.paymentIntentId, b.expectedVersion], [e.paymentIntentId, e.expectedVersion]);
  for (const k of Object.keys(FIELDS)) {
    const changed = { ...FIELDS, [k]: k === "approvalRef" ? "synthetic-abort-2" : k === "reservationId" ? "61000009" : typeof FIELDS[k] === "number" ? FIELDS[k] + (k === "listingId" ? 0 : 1) : FIELDS[k] };
    if (k === "listingId" || k === "currency" || k === "authorizedMinor" || k === "finalTotalMinor") continue;
    if (changed[k] === FIELDS[k]) continue;
    const ch = buildAbortExpectation(changed);
    if (ch) assert.notEqual(ch.planHash, e.planHash, `plan hash binds ${k}`);
  }
  assert.deepEqual([listingAllowed(606998, "USD"), listingAllowed(606998, "MXN"), listingAllowed(603566, "USD")], [true, false, false]);
  assert.deepEqual(testAbortGate(undefined), { ok: false, code: "ENV_REQUIRED" });
  assert.deepEqual(testAbortGate({}), { ok: false, code: "ENVIRONMENT_NOT_ALLOWED" });
  assert.deepEqual(testAbortGate({ VERCEL_ENV: "production", MV_E7_TEST_ABORT: "enabled" }), { ok: false, code: "PRODUCTION_REFUSED" });
  assert.deepEqual(testAbortGate({ VERCEL_ENV: "preview" }), { ok: false, code: "NOT_ENABLED" });
  assert.deepEqual(testAbortGate({ VERCEL_ENV: "preview", MV_E7_TEST_ABORT: "enabled" }), { ok: true });
});

test("A4 static boundary: no route / guest API reaches the abort; the modules import no provider, network, env or fs; release tooling untouched", () => {
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  for (const p of ["lib/checkout/intent-api-core.js", "lib/checkout/intent-api-http.js", "api/checkout/intent-step.js", "api/checkout/intents.js", "api/checkout/stripe-webhook.js"]) {
    const s = read(p);
    assert.equal(/test-abort|TEST_ABORT|requestTestAbort/.test(s), false, p);
  }
  for (const p of ["lib/booking-db/test-abort.js", "scripts/e7-operator/test-abort.mjs"]) {
    const code = read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const imports = [...code.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
    for (const m of imports) assert.ok((/^\.\.?\//.test(m) || m === "node:crypto") && !/stripe|hostaway-reservations|executor|transport|exchange/.test(m), `${p}: ${m}`);
    for (const bad of ["process.env", "fetch(", "node:fs", "node:http", "node:net", "import("]) assert.equal(code.includes(bad), false, `${p}: ${bad}`);
  }
});

test("A5 bounded helper: malformed expectations cause ZERO DB calls (requestTestAbort / classify / executeOperatorAbort); the expectation is bound before the first await, so caller mutation after invocation cannot alter what is checked", async () => {
  const e = buildAbortExpectation({ ...FIELDS });
  const ENV = { VERCEL_ENV: "preview", MV_E7_TEST_ABORT: "enabled" };
  const counting = () => { const p = { calls: 0, query() { p.calls += 1; return Promise.reject(new Error("no DB in this test")); }, connect() { p.calls += 1; return Promise.reject(new Error("no DB in this test")); } }; return p; };
  const malformed = [{ ...e, paymentIntentId: [e.paymentIntentId] }, { ...e, sessionId: new String(e.sessionId) }, { ...e, intentId: [e.intentId] },
    { ...e, attemptId: [e.attemptId] }, { ...e, approvalRef: 123 }, { ...e, planHash: [e.planHash] }, Object.defineProperty({ ...e }, "guests", { get: () => 1, enumerable: true }), null, [e]];
  for (const over of INVALID_DATES) malformed.push({ ...e, ...over });
  for (const m of malformed) {
    const pool = counting();
    assert.deepEqual(await requestTestAbort(pool, FIELDS.intentId, { now: T0, env: ENV, operator: m }), { ok: false, error: "TEST_ABORT_EXPECTATION_INVALID" });
    assert.equal((await classify(pool, m)).class, "INVALID");
    const x = await executeOperatorAbort(pool, m, { now: T0, env: ENV });
    assert.deepEqual([x.outcome, x.invocations], ["NOT_EXECUTED_INVALID", 0]);
    assert.equal(pool.calls, 0, "zero DB calls for a malformed expectation");
  }
  // binding happens synchronously: the FIRST DB call already sees the original intent id, and a mutation made right after invocation
  // (before any await resolves) is not observed by the helper (its later failure path reports the bound values, not the mutated ones)
  const seen = [];
  const pool = { query(sql, params) { seen.push(params ? [...params] : []); return Promise.resolve({ rows: [] }); }, connect() { return Promise.reject(new Error("no tx")); } };
  const callerObj = { ...e };
  const pending = requestTestAbort(pool, FIELDS.intentId, { now: T0, env: ENV, operator: callerObj });
  callerObj.intentId = "00000000-0000-4000-8000-0000000000ff"; callerObj.paymentIntentId = "pi_TESTmutated001"; callerObj.listingId = 603566;
  const out = await pending;
  assert.deepEqual(out, { ok: false, error: "NOT_FOUND" }, "the bound expectation (606998 / original intent) passed; the mutated listing would have been refused");
  assert.ok(seen.length >= 1 && seen.every((p) => !p.includes("00000000-0000-4000-8000-0000000000ff")), "no DB call carried the mutated id");
});
