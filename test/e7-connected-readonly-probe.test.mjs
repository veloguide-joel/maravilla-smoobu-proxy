// E7 connected-test runner SLICE P — read-only probe orchestration (OFFLINE unit tests; no network, provider, credential, env, PG or
// install). LABELS: every `send`, exchange, clock and timer is an INJECTED FAKE; the fake clock never sleeps (time moves only when a test
// advances it). Reply sentinels (guest / provider strings) are SYNTHETIC and must never appear in any summary. The accepted T transports
// are used unchanged over an injected fake exchange for the integration case.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateProbePlan, runReadonlyProbes, canonicalJson, amountToMinor, CODES, VOCABULARY, T_ERROR_CODES, RESERVATION_STATUSES, CHARGE_TYPES, PROBE_IDS, MAX_PLAN_STRING }
  from "../scripts/e7-connected/readonly-probe.mjs";
import { ERROR_CODES as T_CODES, createE7HostawaySend, createE7StripeTestSend } from "../scripts/e7-connected/http-transports.mjs";
import { RESERVATION_STATUSES as RS, amountToMinor as libAmountToMinor } from "../lib/hostaway-reservations.js";
import { providerIdToCanonical } from "../lib/checkout/offline-charge-proof.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let netAttempts = 0; const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline Slice P suite)"); };
let unhandled = 0; const onU = () => { unhandled += 1; }; process.on("unhandledRejection", onU);
after(() => { globalThis.fetch = realFetch; process.off("unhandledRejection", onU); assert.deepEqual([netAttempts, unhandled], [0, 0]); });

// ---- SYNTHETIC values + sentinels ---------------------------------------------------------------------------------------------------
const L = 871001; const L1 = 871001; const L2 = 871002; const R1 = "6100001"; const R2 = "6100002"; const ACCT = "acct_1SyntheticProbe"; const PI = "pi_test_syntheticProbe1";
const SENT = ["SENTINEL_GUEST_NAME", "sentinel.guest@mv-test.invalid", "SENTINEL_TITLE", "SENTINEL_PROVIDER_TEXT", "SENTINEL_LISTING_NAME"];
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const plan0 = (o = {}) => ({ version: "e7-probe-plan-v1",
  metadata: { reviewedCommit: "a56c2db1fe0b944cac86e9971156937e84b1c91d", nodeVersion: "22.22.0", stripeVersion: "2026-08-26.dahlia", approvalRef: "synthetic-approval-ref" },
  hostaway: { listingId: L, calendar: { startDate: "2026-12-01", endDate: "2026-12-03" }, lookup: null, sample: { reservationId: R1, listingId: L1 }, control: { reservationId: R2, listingId: L2 } },
  stripe: { accountId: ACCT, paymentIntentId: PI }, probes: ["P-H1", "P-H2", "P-H4", "P-H5", "P-H6", "P-S1", "P-S2"], limits: { perProbeMs: 15000, runMs: 180000, tailMs: 5000 }, ...o });
const valid = (o) => { const v = validateProbePlan(plan0(o)); assert.equal(v.ok, true, v.code); return v.plan; };

// ---- SYNTHETIC replies (T-shaped) -----------------------------------------------------------------------------------------------------
const H = (json, httpStatus = 200) => ({ httpStatus, json });
const listingR = () => H({ status: "success", result: { id: L, currencyCode: "USD", name: SENT[4] } });
const calendarR = (days = ["2026-12-01", "2026-12-02", "2026-12-03"]) => H({ status: "success", result: days.map((date) => ({ date, isAvailable: 1, status: "available", minimumStay: 1, maximumStay: 90 })) });
const resRow = (o = {}) => ({ id: Number(R1), listingMapId: L1, channelId: 2000, arrivalDate: "2026-12-04", departureDate: "2026-12-06", totalPrice: 500, currency: "USD", status: "new",
  guestName: SENT[0], guestEmail: SENT[1], customFieldValues: [], ...o });
const reservationR = (o) => H({ status: "success", result: resRow(o) });
const chargeRow = (rid, lid, id, o = {}) => ({ id, reservationId: Number(rid), listingMapId: lid, type: "charge", title: SENT[2], currency: "USD", status: "paid", paymentProvider: "offline", paymentMethod: "credit_card", amount: 500, ...o });
const chargesR = (rows, extra = {}) => H({ status: "success", result: rows, count: rows.length, offset: null, ...extra });
const ACCOUNT = () => ({ object: "account", id: ACCT, email: SENT[1] });
const PIOBJ = (o = {}, lc = {}) => ({ object: "payment_intent", id: PI, livemode: false, status: "requires_capture", capture_method: "manual", amount: 50000, amount_capturable: 50000, amount_received: 0,
  currency: "usd", metadata: { note: SENT[3] }, latest_charge: lc === null ? null : { object: "charge", id: "ch_test_1", payment_intent: PI, status: "succeeded", paid: true, captured: false, amount: 50000,
    amount_captured: 0, amount_refunded: 0, currency: "usd", livemode: false, payment_method_details: { card: { capture_before: 1798761600 } }, ...lc }, ...o });

// ---- FAKE time + sends --------------------------------------------------------------------------------------------------------------
function fakeTime() {
  const c = { t: 0, timers: [], arms: 0 };
  c.monotonic = () => c.t;
  c.arm = (ms) => { c.arms += 1; let res, rej; const promise = new Promise((a, b) => { res = a; rej = b; }); const e = { at: c.t + ms, res, rej, cancels: 0, fired: false }; c.timers.push(e);
    if (c.onArm) c.onArm(e); return { promise, cancel: () => { e.cancels += 1; } }; };
  c.advance = async (ms) => { c.t += ms; for (const e of c.timers) if (!e.cancels && !e.fired && e.at <= c.t) { e.fired = true; e.res(); } await flush(); };
  c.deps = () => ({ monotonic: c.monotonic, timers: { arm: c.arm } });
  return c;
}
const defaultReply = (req) => {
  if (req.op === "accounts.retrieve") return ACCOUNT();
  if (req.op === "paymentIntents.retrieve") return PIOBJ();
  if (req.path === `/v1/listings/${L}`) return listingR();
  if (req.path.endsWith("/calendar")) return calendarR();
  if (req.path.startsWith("/v1/reservations/")) return reservationR();
  if (req.path === "/v1/guestPayments/charges") return req.query.reservationId === R1 ? chargesR([chargeRow(R1, L1, 9001)]) : chargesR([chargeRow(R2, L2, 9002)]);
  throw new Error("unmapped");
};
/** a fake T-like send: records calls; `behave(req, call)` returns a value (fulfil), { reject: e }, { hold: true } or { raw: anyValue } */
function fakeSend(behave = () => undefined) {
  const s = { calls: [], held: [] };
  s.send = (req, opts) => {
    s.calls.push({ req, opts, signalAbortedAtCall: opts.signal.aborted });
    const b = behave(req, s.calls.length);
    if (b && b.raw !== undefined) return b.raw;
    if (b && b.hold) { let res, rej; const p = new Promise((a, c) => { res = a; rej = c; }); s.held.push({ res, rej, signal: opts.signal }); return p; }
    if (b && b.reject) return Promise.reject(b.reject);
    return Promise.resolve(b !== undefined ? b : defaultReply(req));
  };
  s.transport = { send: s.send };
  return s;
}
const run = (plan, { h = fakeSend(), s = fakeSend(), time = fakeTime(), signal } = {}) => {
  const needH = plan.probes.some((x) => x.startsWith("P-H")); const needS = plan.probes.some((x) => x.startsWith("P-S"));
  const r = runReadonlyProbes({ plan, ...(needH ? { hostaway: h.transport } : {}), ...(needS ? { stripe: s.transport } : {}), deps: time.deps(), ...(signal ? { signal } : {}) });
  assert.equal(r.ok, true, r.code); return { ...r, h, s, time };
};
const byId = (sum) => Object.fromEntries(sum.probes.map((p) => [p.id, p]));
function stringsOf(v, out = []) { if (typeof v === "string") out.push(v); else if (v && typeof v === "object") for (const k of Object.keys(v)) { out.push(k); stringsOf(v[k], out); } return out; }
const KEY_VOCAB = new Set(["schema", "planHash", "metadata", "reviewedCommit", "nodeVersion", "stripeVersion", "approvalRef", "outcome", "stopCode", "stopProbe", "probes", "id", "code", "httpStatus",
  "transportCode", "elapsed", "evidence", "gates", "idMatches", "currencyUSD", "dayCount", "inWindow", "complete", "rowCount", "allScoped", "typesOk", "pageFull", "listingMatches", "status",
  "allRowsMatch", "accountIdMatches", "livemode", "latestCharge", "proofFieldsTyped", "G_AUTH_charges_read", "G_FILTER", "G_SHAPE_listing", "G_SHAPE_calendar", "G_SHAPE_lookup",
  "G_SHAPE_reservation", "G_SHAPE_charges", "B4_pi_read", "TEST_mode_pi", ...T_ERROR_CODES]);
function assertRedacted(sum, plan) {
  const allowed = new Set([...VOCABULARY, plan.planHash, ...Object.values(plan.metadata)]);
  for (const s of stringsOf(sum)) assert.ok(allowed.has(s) || KEY_VOCAB.has(s) || /^[0-9]+$/.test(s), `non-whitelisted string in summary: ${s}`);
  const txt = JSON.stringify(sum);
  for (const s of [...SENT, R1, R2, String(L), ACCT, PI, "ch_test_1"]) assert.ok(!txt.includes(s), `leak: ${s}`);
  const frozen = (v) => { if (v && typeof v === "object") { assert.ok(Object.isFrozen(v)); Object.values(v).forEach(frozen); } };
  frozen(sum);
}

// =================================================================================================================================
test("P1. plan validation: exact keys / types / ranges / enums; hostile shapes refused without getters; protected / order / dependency / unused rules; snapshot once; canonical planHash", () => {
  const ok = validateProbePlan(plan0()); assert.equal(ok.ok, true);
  assert.match(ok.plan.planHash, /^[0-9a-f]{64}$/);
  // canonical: key order independent; equals SHA-256 of canonical JSON of the plan body
  const reordered = Object.fromEntries(Object.entries(plan0()).reverse());
  assert.equal(validateProbePlan(reordered).plan.planHash, ok.plan.planHash);
  assert.equal(canonicalJson({ b: 1, a: [true, null, "x"] }), '{"a":[true,null,"x"],"b":1}');
  const { planHash, ...body } = ok.plan;
  assert.equal(planHash, (await_hash(canonicalJson(body))));
  let getterRuns = 0;
  const cases = [
    ["missing key", (() => { const p = plan0(); delete p.limits; return p; })(), "PLAN_SHAPE"], ["extra key", { ...plan0(), extra: 1 }, "PLAN_SHAPE"],
    ["version", plan0({ version: "v2" }), "PLAN_SHAPE"], ["proxy", new Proxy(plan0(), {}), "PLAN_SHAPE"],
    ["accessor", Object.defineProperty(plan0(), "probes", { enumerable: true, get() { getterRuns += 1; return ["P-H1"]; } }), "PLAN_SHAPE"],
    ["toJSON", { ...plan0(), toJSON: () => ({}) }, "PLAN_SHAPE"], ["__proto__", JSON.parse(`{"__proto__":{"x":1}}`), "PLAN_SHAPE"],
    ["thenable", { ...plan0(), then: () => {} }, "PLAN_SHAPE"], ["symbol key", { ...plan0(), [Symbol("s")]: 1 }, "PLAN_SHAPE"],
    ["commit", plan0({ metadata: { ...plan0().metadata, reviewedCommit: "abc" } }), "PLAN_SHAPE"], ["node label", plan0({ metadata: { ...plan0().metadata, nodeVersion: "22.22.1" } }), "PLAN_SHAPE"],
    ["stripe version endive", plan0({ metadata: { ...plan0().metadata, stripeVersion: "2026-10-28.endive" } }), "PLAN_STRIPE_VERSION"],
    ["synthetic version", plan0({ metadata: { ...plan0().metadata, stripeVersion: "2099-01-01.synthetic" } }), "PLAN_STRIPE_VERSION"],
    ["perProbe", plan0({ limits: { perProbeMs: 15001, runMs: 180000, tailMs: 0 } }), "PLAN_SHAPE"], ["run < probe", plan0({ limits: { perProbeMs: 15000, runMs: 14000, tailMs: 0 } }), "PLAN_SHAPE"],
    ["tail", plan0({ limits: { perProbeMs: 15000, runMs: 180000, tailMs: 10001 } }), "PLAN_SHAPE"],
    ["calendar > 31 days", plan0({ hostaway: { ...plan0().hostaway, calendar: { startDate: "2026-12-01", endDate: "2027-01-01" } } }), "PLAN_SHAPE"],
    ["bad date", plan0({ hostaway: { ...plan0().hostaway, calendar: { startDate: "2026-02-30", endDate: "2026-03-01" } } }), "PLAN_SHAPE"],
    ["lookup without optIn", plan0({ hostaway: { ...plan0().hostaway, lookup: { arrivalDate: "2026-12-04", optIn: false } } }), "PLAN_SHAPE"],
    ["protected sample", plan0({ hostaway: { ...plan0().hostaway, sample: { reservationId: "70636076", listingId: L1 } } }), "PLAN_PROTECTED"],
    ["protected control", plan0({ hostaway: { ...plan0().hostaway, control: { reservationId: "71081885", listingId: L2 } } }), "PLAN_PROTECTED"],
    ["leading zero id", plan0({ hostaway: { ...plan0().hostaway, sample: { reservationId: "070636076", listingId: L1 } } }), "PLAN_SHAPE"],
    ["numeric id", plan0({ hostaway: { ...plan0().hostaway, sample: { reservationId: 6100001, listingId: L1 } } }), "PLAN_SHAPE"],
    ["control = sample", plan0({ hostaway: { ...plan0().hostaway, control: { reservationId: R1, listingId: L1 } } }), "PLAN_CONTROL_SAME"],
    ["duplicate", plan0({ probes: ["P-H1", "P-H1"] }), "PLAN_PROBE_DUPLICATE"], ["order", plan0({ probes: ["P-S1", "P-H1"] }), "PLAN_PROBE_ORDER"],
    ["unknown id", plan0({ probes: ["P-X"] }), "PLAN_SHAPE"], ["empty", plan0({ probes: [] }), "PLAN_SHAPE"],
    ["H5 without H4", plan0({ probes: ["P-H1", "P-H2", "P-H5", "P-H6", "P-S1", "P-S2"] }), "PLAN_DEPENDENCY"],
    ["S2 without S1", plan0({ probes: ["P-H1", "P-H2", "P-H4", "P-H5", "P-H6", "P-S2"] }), "PLAN_DEPENDENCY"],
    ["H3 without lookup", plan0({ probes: ["P-H1", "P-H2", "P-H3", "P-H4", "P-H5", "P-H6", "P-S1", "P-S2"] }), "PLAN_DEPENDENCY"],
    ["unused calendar", plan0({ probes: ["P-H1", "P-H4", "P-H5", "P-H6", "P-S1", "P-S2"] }), "PLAN_UNUSED_INPUT"],
    ["unused pi", plan0({ probes: ["P-H1", "P-H2", "P-H4", "P-H5", "P-H6", "P-S1"] }), "PLAN_UNUSED_INPUT"],
    ["pi too long", plan0({ stripe: { accountId: ACCT, paymentIntentId: "pi_" + "a".repeat(251) } }), "PLAN_SHAPE"]];
  for (const [label, p, code] of cases) assert.equal(validateProbePlan(p).code, code, label);
  assert.equal(getterRuns, 0, "no caller getter ran");
  // the exact effective string bound = 253 (aligned with T's PI regex): a 253-char PI id passes, 254 refused at snapshot
  assert.equal(MAX_PLAN_STRING, 253);
  assert.equal(validateProbePlan(plan0({ stripe: { accountId: ACCT, paymentIntentId: "pi_" + "a".repeat(250) } })).ok, true);
  // snapshot once: mutating the caller object afterwards changes nothing
  const src = plan0(); const v = validateProbePlan(src); src.hostaway.listingId = 1; src.probes.push("P-S2");
  assert.deepEqual([v.plan.hostaway.listingId, v.plan.probes.length], [L, 7]);
  assert.ok(Object.isFrozen(v.plan) && Object.isFrozen(v.plan.hostaway) && Object.isFrozen(v.plan.probes));
  // a copy of a validated plan is not branded
  assert.deepEqual({ ...runReadonlyProbes({ plan: { ...v.plan }, deps: fakeTime().deps() }) }, { ok: false, code: "PLAN_NOT_VALIDATED" });
});
import { createHash } from "node:crypto";
function await_hash(s) { return createHash("sha256").update(s).digest("hex"); }

test("P2. exact T inputs per probe (H8 internal SINGULAR reservationId), one send per probe, each with P's own genuine, distinct signal; full default plan COMPLETED", async () => {
  const plan = valid(); const r = run(plan);
  const sum = await r.result;
  assert.equal(sum.outcome, "COMPLETED", JSON.stringify(sum));
  assert.deepEqual(r.h.calls.map((c) => c.req), [
    { method: "GET", path: `/v1/listings/${L}`, query: {} },
    { method: "GET", path: `/v1/listings/${L}/calendar`, query: { startDate: "2026-12-01", endDate: "2026-12-03" } },
    { method: "GET", path: `/v1/reservations/${R1}`, query: {} },
    { method: "GET", path: "/v1/guestPayments/charges", query: { reservationId: R1, limit: 500 } },
    { method: "GET", path: "/v1/guestPayments/charges", query: { reservationId: R2, limit: 500 } }]);
  assert.deepEqual(r.s.calls.map((c) => c.req), [{ op: "accounts.retrieve" }, { op: "paymentIntents.retrieve", id: PI, params: { expand: ["latest_charge"] } }]);
  const sigs = [...r.h.calls, ...r.s.calls].map((c) => c.opts.signal);
  assert.ok(sigs.every((s) => s instanceof AbortSignal) && new Set(sigs).size === 7, "one genuine signal per probe");
  assert.ok([...r.h.calls, ...r.s.calls].every((c) => Object.isFrozen(c.req) && Object.keys(c.opts).join() === "signal" && c.signalAbortedAtCall === false));
  assert.deepEqual(sum.gates, { G_AUTH_charges_read: "OBSERVED", G_FILTER: "OBSERVED", G_SHAPE_listing: "OBSERVED", G_SHAPE_calendar: "OBSERVED", G_SHAPE_lookup: "NOT_PROBED",
    G_SHAPE_reservation: "OBSERVED", G_SHAPE_charges: "OBSERVED", B4_pi_read: "OBSERVED", TEST_mode_pi: "OBSERVED" });
  const p = byId(sum);
  assert.deepEqual([p["P-H5"].httpStatus, p["P-S1"].httpStatus, p["P-S2"].httpStatus], [200, null, null], "Stripe probes never carry an HTTP status");
  assert.deepEqual({ ...p["P-S2"].evidence }, { status: "requires_capture", livemode: false, latestCharge: "VERIFIED_TEST_CHARGE", proofFieldsTyped: true });
  assertRedacted(sum, plan);
  assert.equal((await r.finalize()).tail, "NONE");
});

test("P3. reply checks: STOP codes, protected / foreign rows code-only, completeness → INCONCLUSIVE, empty-list rule, G-FILTER scopes, P-H3 opt-in, P-S2 latest_charge cases", async () => {
  const one = async (probes, reply, o = {}) => {
    const plan = valid({ probes, ...o });
    const h = fakeSend((req) => (reply.match(req) ? reply.value(req) : undefined)); const s = fakeSend((req) => (reply.match(req) ? reply.value(req) : undefined));
    const r = run(plan, { h, s }); const sum = await r.result; assertRedacted(sum, plan); return { sum, h, s, p: byId(sum) };
  };
  const H1only = { hostaway: { ...plan0().hostaway, calendar: null, sample: null, control: null }, stripe: null };
  const m = (path) => (req) => req.path === path;
  for (const [label, value, code] of [["401", H({ status: "fail" }, 401), "PROBE_AUTH_REFUSED"], ["403", H({ status: "fail" }, 403), "PROBE_AUTH_REFUSED"], ["500", H({ status: "fail" }, 500), "PROBE_HTTP_STATUS"],
    ["json null", H(null), "PROBE_SHAPE_MISMATCH"], ["status fail", H({ status: "fail", result: {} }), "PROBE_SHAPE_MISMATCH"], ["other listing", H({ status: "success", result: { id: 1, currencyCode: "USD" } }), "PROBE_LISTING_MISMATCH"],
    ["MXN", H({ status: "success", result: { id: L, currencyCode: "MXN" } }), "PROBE_LISTING_MISMATCH"],
    ["getter result", { httpStatus: 200, get json() { throw new Error(SENT[3]); } }, "PROBE_SHAPE_MISMATCH"]]) {
    const { p, sum } = await one(["P-H1"], { match: m(`/v1/listings/${L}`), value: () => value }, H1only);
    assert.deepEqual([p["P-H1"].outcome, p["P-H1"].code, sum.stopCode], ["STOP", code, code], label);
  }
  // calendar: foreign day STOP, missing day INCONCLUSIVE
  const calO = { hostaway: { ...plan0().hostaway, sample: null, control: null }, stripe: null };
  assert.equal((await one(["P-H1", "P-H2"], { match: (r) => r.path.endsWith("/calendar"), value: () => calendarR(["2026-12-01", "2026-12-09"]) }, calO)).p["P-H2"].code, "PROBE_FOREIGN_ROW");
  { const x = await one(["P-H1", "P-H2"], { match: (r) => r.path.endsWith("/calendar"), value: () => calendarR(["2026-12-01", "2026-12-02"]) }, calO);
    assert.deepEqual([x.p["P-H2"].outcome, x.p["P-H2"].code, x.sum.gates.G_SHAPE_calendar, x.sum.outcome], ["INCONCLUSIVE", "PROBE_INCOMPLETE", "INCONCLUSIVE", "COMPLETED"]); }
  // reservation P-H4: protected / mismatch / types (custom-field CONTENT not checked: no refFieldId in P)
  const resO = { hostaway: { ...plan0().hostaway, calendar: null, control: null }, stripe: null };
  for (const [label, row, code] of [["protected id", { id: 70636076 }, "PROBE_PROTECTED_SEEN"], ["protected alias", { hostawayReservationId: "71045356" }, "PROBE_PROTECTED_SEEN"],
    ["other id", { id: 6100009 }, "PROBE_RESERVATION_MISMATCH"], ["other listing", { listingMapId: 999 }, "PROBE_RESERVATION_MISMATCH"], ["bad status", { status: "weird" }, "PROBE_SHAPE_MISMATCH"],
    ["inexact money", { totalPrice: 500.123 }, "PROBE_SHAPE_MISMATCH"], ["dates reversed", { departureDate: "2026-12-01" }, "PROBE_SHAPE_MISMATCH"]]) {
    const x = await one(["P-H1", "P-H4", "P-H5"], { match: (r) => r.path === `/v1/reservations/${R1}`, value: () => reservationR(row) }, resO);
    assert.deepEqual([x.p["P-H4"].code, x.p["P-H5"].code, x.h.calls.length], [code, "AFTER_STOP", 2], label);
  }
  // charges: protected / foreign / duplicate / pagination / empty
  const chO = { hostaway: { ...plan0().hostaway, calendar: null }, stripe: null };
  const ch = (rows, extra) => ({ match: (r) => r.path === "/v1/guestPayments/charges" && r.query.reservationId === R1, value: () => chargesR(rows, extra) });
  for (const [label, rows, extra, code, outcome] of [
    ["protected row", [chargeRow("70636076", L1, 9001)], {}, "PROBE_PROTECTED_SEEN", "STOP"], ["foreign reservation", [chargeRow(R2, L1, 9001)], {}, "PROBE_FOREIGN_ROW", "STOP"],
    ["foreign listing", [chargeRow(R1, 5, 9001)], {}, "PROBE_FOREIGN_ROW", "STOP"], ["string reservationId", [{ ...chargeRow(R1, L1, 9001), reservationId: R1 }], {}, "PROBE_FOREIGN_ROW", "STOP"],
    ["duplicate id", [chargeRow(R1, L1, 9001), chargeRow(R1, L1, 9001)], {}, "PROBE_SHAPE_MISMATCH", "STOP"], ["bad type", [chargeRow(R1, L1, 9001, { type: "x" })], {}, "PROBE_SHAPE_MISMATCH", "STOP"],
    ["count mismatch", [chargeRow(R1, L1, 9001)], { count: 2 }, "PROBE_SHAPE_MISMATCH", "STOP"], ["hasMore string", [chargeRow(R1, L1, 9001)], { hasMore: "yes" }, "PROBE_SHAPE_MISMATCH", "STOP"],
    ["total < count", [chargeRow(R1, L1, 9001)], { total: 0 }, "PROBE_SHAPE_MISMATCH", "STOP"], ["hasMore", [chargeRow(R1, L1, 9001)], { hasMore: true }, "PROBE_LIMIT_REACHED", "INCONCLUSIVE"],
    ["offset", [chargeRow(R1, L1, 9001)], { offset: 500 }, "PROBE_LIMIT_REACHED", "INCONCLUSIVE"], ["total > count", [chargeRow(R1, L1, 9001)], { total: 7 }, "PROBE_LIMIT_REACHED", "INCONCLUSIVE"],
    ["empty", [], {}, "PROBE_EMPTY_SAMPLE", "INCONCLUSIVE"]]) {
    const x = await one(["P-H1", "P-H4", "P-H5", "P-H6"], ch(rows, extra), chO);
    assert.deepEqual([x.p["P-H5"].outcome, x.p["P-H5"].code], [outcome, code], label);
    if (outcome === "INCONCLUSIVE") assert.deepEqual([x.p["P-H6"].code, x.h.calls.length, x.sum.gates.G_FILTER], ["PREREQ_INCONCLUSIVE", 3, "OPEN"], `${label}: no control request, no silent closure`);
  }
  { const x = await one(["P-H1", "P-H4", "P-H5", "P-H6"], ch(Array.from({ length: 500 }, (_, i) => chargeRow(R1, L1, 10000 + i))), chO);
    assert.equal(x.p["P-H5"].code, "PROBE_LIMIT_REACHED", "500 rows: never complete"); }
  // control overlap: fixed INCONCLUSIVE, gate OPEN
  { const x = await one(["P-H1", "P-H4", "P-H5", "P-H6"], { match: (r) => r.query && r.query.reservationId === R2, value: () => chargesR([chargeRow(R2, L2, 9001)]) }, chO);
    assert.deepEqual([x.p["P-H6"].outcome, x.p["P-H6"].code, x.sum.gates.G_FILTER], ["INCONCLUSIVE", "PROBE_CONTROL_OVERLAP", "OPEN"]); }
  // no control approved → SINGLE_SAMPLE only
  { const x = await one(["P-H1", "P-H4", "P-H5"], { match: () => false }, { hostaway: { ...plan0().hostaway, calendar: null, control: null }, stripe: null });
    assert.equal(x.sum.gates.G_FILTER, "SINGLE_SAMPLE"); }
  // P-H3 only with explicit opt-in; foreign / protected rows; page full
  const lkO = { hostaway: { ...plan0().hostaway, calendar: null, sample: null, control: null, lookup: { arrivalDate: "2026-12-04", optIn: true } }, stripe: null };
  const lk = (rows) => ({ match: (r) => r.path === "/v1/reservations", value: () => H({ status: "success", result: rows }) });
  assert.equal((await one(["P-H1", "P-H3"], lk([resRow({ listingMapId: L })]), lkO)).p["P-H3"].code, "PROBE_OK");
  assert.equal((await one(["P-H1", "P-H3"], lk([resRow({ listingMapId: L, channelId: 2002 })]), lkO)).p["P-H3"].code, "PROBE_FOREIGN_ROW");
  assert.equal((await one(["P-H1", "P-H3"], lk([resRow({ listingMapId: L, arrivalDate: "2026-12-05", departureDate: "2026-12-07" })]), lkO)).p["P-H3"].code, "PROBE_FOREIGN_ROW");
  assert.equal((await one(["P-H1", "P-H3"], lk([resRow({ listingMapId: L, id: 71072615 })]), lkO)).p["P-H3"].code, "PROBE_PROTECTED_SEEN");
  assert.equal((await one(["P-H1", "P-H3"], lk(Array.from({ length: 100 }, (_, i) => resRow({ listingMapId: L, id: 6200000 + i }))), lkO)).p["P-H3"].code, "PROBE_PAGE_FULL");
  // Stripe: Account without livemode accepted; P-S1 alone never sets TEST; P-S2 latest_charge cases
  const sO = { hostaway: null };
  { const x = await one(["P-S1"], { match: () => false }, { ...sO, stripe: { accountId: ACCT, paymentIntentId: null } });
    assert.deepEqual([x.p["P-S1"].code, x.sum.gates.TEST_mode_pi, x.sum.gates.B4_pi_read], ["PROBE_OK", "NOT_PROBED", "NOT_PROBED"]); }
  const pi = (v) => ({ match: (r) => r.op === "paymentIntents.retrieve", value: () => v });
  for (const [label, v, code, outcome] of [["null charge", PIOBJ({}, null), "PROBE_CHARGE_ABSENT", "INCONCLUSIVE"], ["string charge", PIOBJ({ latest_charge: "ch_test_1" }), "PROBE_SHAPE_MISMATCH", "STOP"],
    ["charge live", PIOBJ({}, { livemode: true }), "PROBE_LIVEMODE_REFUSED", "STOP"], ["pi live", PIOBJ({ livemode: true }), "PROBE_LIVEMODE_REFUSED", "STOP"],
    ["pi livemode missing", (() => { const o = PIOBJ(); delete o.livemode; return o; })(), "PROBE_LIVEMODE_REFUSED", "STOP"],
    ["charge for other pi", PIOBJ({}, { payment_intent: "pi_other" }), "PROBE_SHAPE_MISMATCH", "STOP"], ["capture_before string", PIOBJ({}, { payment_method_details: { card: { capture_before: "x" } } }), "PROBE_SHAPE_MISMATCH", "STOP"],
    ["status unknown", PIOBJ({ status: "weird" }), "PROBE_SHAPE_MISMATCH", "STOP"], ["expanded pi object", PIOBJ({}, { payment_intent: { id: PI } }), "PROBE_OK", "OK"]]) {
    const x = await one(["P-S1", "P-S2"], pi(v), sO);
    assert.deepEqual([x.p["P-S2"].outcome, x.p["P-S2"].code], [outcome, code], label);
    if (code === "PROBE_CHARGE_ABSENT") assert.deepEqual([x.p["P-S2"].evidence.latestCharge, x.sum.gates.TEST_mode_pi, x.sum.gates.B4_pi_read], ["ABSENT", "OPEN", "OPEN"], "absent charge ≠ verified TEST charge");
  }
});

test("P4. deadlines (fake clock, no sleeps): hanging send → TIMEOUT within budget; arm crossing deadline / caller abort during preparation → ZERO sends; settlement at the deadline; budget; early fire; no second probe after stop", async () => {
  const p1 = valid({ probes: ["P-H1", "P-H2"], hostaway: { ...plan0().hostaway, sample: null, control: null }, stripe: null, limits: { perProbeMs: 15000, runMs: 180000, tailMs: 5000 } });
  { // hanging send: timeout at the per-probe deadline; run STOPS; later probe NOT_RUN; summary unaffected by a late reply
    const h = fakeSend(() => ({ hold: true })); const r = run(p1, { h });
    await flush(); assert.equal(h.calls.length, 1);
    await r.time.advance(15000);
    const sum = await r.result;
    assert.deepEqual([byId(sum)["P-H1"].code, byId(sum)["P-H2"].code, sum.stopCode, h.calls.length, h.held[0].signal.aborted], ["PROBE_TIMEOUT", "AFTER_STOP", "PROBE_TIMEOUT", 1, true]);
    h.held[0].res(listingR()); await flush();
    assert.equal(byId(await r.result)["P-H1"].code, "PROBE_TIMEOUT", "late reply never changes the frozen summary");
    const f1 = r.finalize(); assert.equal(r.finalize(), f1, "finalize idempotent: same native promise");
    assert.equal((await f1).tail, "LATE_FULFILLED");
    assert.equal(r.time.timers[0].cancels, 0, "fired timer never cancelled");
  }
  { // late REJECTION after timeout is observed (no unhandled rejection)
    const h = fakeSend(() => ({ hold: true })); const r = run(p1, { h }); await flush(); await r.time.advance(15000); await r.result;
    h.held[0].rej(Object.assign(new Error(SENT[3]), { code: "EXCHANGE_FAILED" })); await flush();
    assert.equal((await r.finalize()).tail, "LATE_REJECTED");
  }
  { // never-settling send: finalize → UNSETTLED after tailMs (own tail timer)
    const h = fakeSend(() => ({ hold: true })); const r = run(p1, { h }); await flush(); await r.time.advance(15000); await r.result;
    const f = r.finalize(); await flush(); await r.time.advance(5000);
    assert.equal((await f).tail, "UNSETTLED");
  }
  { // tailMs = 0 → UNSETTLED immediately, no tail timer armed
    const p0 = valid({ probes: ["P-H1"], hostaway: { ...plan0().hostaway, calendar: null, sample: null, control: null }, stripe: null, limits: { perProbeMs: 15000, runMs: 180000, tailMs: 0 } });
    const h = fakeSend(() => ({ hold: true })); const r = run(p0, { h }); await flush(); await r.time.advance(15000); await r.result; const arms = r.time.arms;
    assert.equal((await r.finalize()).tail, "UNSETTLED"); assert.equal(r.time.arms, arms);
  }
  { // timer arm advancing the clock beyond the deadline → ZERO sends (even before its callback ran)
    const time = fakeTime(); time.onArm = (e) => { time.t = e.at; };
    const h = fakeSend(); const r = run(p1, { h, time });
    const sum = await r.result;
    assert.deepEqual([byId(sum)["P-H1"].code, h.calls.length], ["PROBE_TIMEOUT", 0]);
    assert.equal(time.timers[0].cancels, 1, "armed handle cancelled exactly once");
  }
  { // caller abort during preparation (inside arm) → ZERO sends
    const ac = new AbortController(); const time = fakeTime(); time.onArm = () => ac.abort();
    const h = fakeSend(); const r = run(p1, { h, time, signal: ac.signal }); const sum = await r.result;
    assert.deepEqual([byId(sum)["P-H1"].code, h.calls.length, time.timers[0].cancels], ["PROBE_CANCELLED", 0, 1]);
  }
  { // caller aborted before start
    const ac = new AbortController(); ac.abort(); const h = fakeSend(); const r = run(p1, { h, signal: ac.signal }); const sum = await r.result;
    assert.deepEqual([sum.stopCode, h.calls.length, r.time.arms], ["PROBE_CANCELLED", 0, 0]);
  }
  { // caller abort while awaiting → CANCELLED, P aborts its own signal, no second send
    const ac = new AbortController(); const h = fakeSend(() => ({ hold: true })); const r = run(p1, { h, signal: ac.signal }); await flush(); ac.abort();
    const sum = await r.result; assert.deepEqual([sum.stopCode, h.calls.length, h.held[0].signal.aborted], ["PROBE_CANCELLED", 1, true]);
  }
  { // settlement observed AT the deadline counts as a timeout (deadline-first tie rule)
    const time = fakeTime(); const h = fakeSend(() => ({ hold: true })); const r = run(p1, { h, time }); await flush();
    time.t = 15000; h.held[0].res(listingR()); await flush();
    const sum = await r.result; assert.deepEqual([byId(sum)["P-H1"].code, h.calls.length], ["PROBE_TIMEOUT", 1]);
  }
  { // run budget governs: remaining < perProbeMs → the deadline code is BUDGET_EXHAUSTED, and below minStart nothing starts
    const pb = valid({ probes: ["P-H1", "P-H2"], hostaway: { ...plan0().hostaway, sample: null, control: null }, stripe: null, limits: { perProbeMs: 15000, runMs: 20000, tailMs: 0 } });
    const time = fakeTime(); const h = fakeSend((req, n) => (n === 1 ? (time.t += 10000, listingR()) : { hold: true })); const r = run(pb, { h, time }); await flush();
    await time.advance(10000);
    const sum = await r.result; assert.deepEqual([byId(sum)["P-H1"].code, byId(sum)["P-H2"].code, h.calls.length], ["PROBE_OK", "PROBE_BUDGET_EXHAUSTED", 2]);
    const pc = valid({ probes: ["P-H1", "P-H2"], hostaway: { ...plan0().hostaway, sample: null, control: null }, stripe: null, limits: { perProbeMs: 15000, runMs: 15000, tailMs: 0 } });
    const t2 = fakeTime(); const h2 = fakeSend((req, n) => (t2.t += 14500, listingR())); const r2 = run(pc, { h: h2, time: t2 });
    const s2 = await r2.result; assert.deepEqual([byId(s2)["P-H2"].code, h2.calls.length], ["PROBE_BUDGET_EXHAUSTED", 1], "below minStart: no send");
  }
  { // early timer fire → fixed dependency failure, no re-arm loop
    const time = fakeTime(); const h = fakeSend(() => ({ hold: true })); const r = run(p1, { h, time }); await flush();
    time.timers[0].fired = true; time.timers[0].res(); await flush();
    const sum = await r.result; assert.deepEqual([sum.stopCode, time.arms, h.calls.length], ["PROBE_DEPENDENCY_FAILED", 1, 1]);
  }
});

test("P5. dependency faults and transport faults: monotonic throw / non-finite / backwards, arm throw / bad handle / non-native promise / timer rejection, cancel throw contained; send throw / thenable / patched promise; T code mapping; never rejects", async () => {
  const p1 = valid({ probes: ["P-H1", "P-H2"], hostaway: { ...plan0().hostaway, sample: null, control: null }, stripe: null });
  const depRun = async (deps, h = fakeSend()) => { const r = runReadonlyProbes({ plan: p1, hostaway: h.transport, deps }); assert.equal(r.ok, true); return { sum: await r.result, h }; };
  const goodArm = fakeTime();
  for (const [label, deps] of [["monotonic throws", { monotonic: () => { throw new Error(SENT[3]); }, timers: { arm: goodArm.arm } }], ["monotonic NaN", { monotonic: () => NaN, timers: { arm: goodArm.arm } }],
    ["arm throws", { monotonic: () => 0, timers: { arm: () => { throw new Error("x"); } } }], ["arm bad handle", { monotonic: () => 0, timers: { arm: () => ({ promise: Promise.resolve() }) } }],
    ["arm thenable", { monotonic: () => 0, timers: { arm: () => ({ promise: { then() {} }, cancel() {} }) } }],
    ["arm patched promise", { monotonic: () => 0, timers: { arm: () => ({ promise: Object.assign(new Promise(() => {}), { then: () => {} }), cancel() {} }) } }]]) {
    const { sum, h } = await depRun(deps); assert.deepEqual([sum.outcome, sum.stopCode, h.calls.length], ["STOPPED", "PROBE_DEPENDENCY_FAILED", 0], label);
  }
  { let t = 100; const tb = fakeTime(); const deps = { monotonic: () => (t -= 50), timers: { arm: tb.arm } }; const { sum } = await depRun(deps); assert.equal(sum.stopCode, "PROBE_DEPENDENCY_FAILED", "backwards clock"); }
  { const tr = fakeTime(); const deps = { monotonic: tr.monotonic, timers: { arm: (ms) => { const h = tr.arm(ms); queueMicrotask(() => tr.timers.at(-1).rej(new Error("timer fault"))); return h; } } };
    const { sum } = await depRun(deps, fakeSend(() => ({ hold: true }))); assert.equal(sum.stopCode, "PROBE_DEPENDENCY_FAILED", "timer rejection"); }
  { let cancels = 0; const tc = fakeTime(); const deps = { monotonic: tc.monotonic, timers: { arm: (ms) => { const h = tc.arm(ms); return { promise: h.promise, cancel: () => { cancels += 1; throw new Error("cancel fault"); } }; } } };
    const { sum } = await depRun(deps); assert.deepEqual([sum.outcome, cancels], ["COMPLETED", 2], "cancel fault contained; exactly once per handle"); }
  assert.equal(runReadonlyProbes({ plan: p1, hostaway: fakeSend().transport, deps: { monotonic: () => 0 } }).code, "RUN_DEPS_INVALID");
  assert.equal(runReadonlyProbes({ plan: p1, hostaway: fakeSend().transport, deps: new Proxy(fakeTime().deps(), {}) }).code, "RUN_DEPS_INVALID");
  assert.equal(runReadonlyProbes({ plan: p1, deps: fakeTime().deps() }).code, "RUN_TRANSPORT_INVALID");
  assert.equal(runReadonlyProbes({ plan: p1, hostaway: fakeSend().transport, stripe: fakeSend().transport, deps: fakeTime().deps() }).code, "RUN_TRANSPORT_INVALID");
  assert.equal(runReadonlyProbes({ plan: p1, hostaway: fakeSend().transport, deps: fakeTime().deps(), signal: { aborted: false } }).code, "RUN_SIGNAL_INVALID");
  assert.equal(runReadonlyProbes({ plan: p1, hostaway: fakeSend().transport, deps: fakeTime().deps(), extra: 1 }).code, "RUN_SHAPE");
  // transport faults
  for (const [label, behave, tail] of [["send throws", () => { throw new Error(SENT[3]); }, "NONE"], ["thenable", () => ({ raw: { then: (r) => r(listingR()) } }), "UNOBSERVABLE"],
    ["patched promise", () => ({ raw: Object.defineProperty(Promise.resolve(listingR()), "then", { value: () => {} }) }), "UNOBSERVABLE"]]) {
    const h = fakeSend(); h.send = (req, opts) => { h.calls.push(req); const b = behave(); return b.raw; };
    const r = runReadonlyProbes({ plan: p1, hostaway: { send: h.send }, deps: fakeTime().deps() }); const sum = await r.result;
    assert.deepEqual([sum.stopCode, h.calls.length, (await r.finalize()).tail], ["PROBE_TRANSPORT_FAILED", 1, tail], label);
  }
  // T code mapping: own-data code only; getter-bearing code never invoked; unknown → TRANSPORT_FAILED
  let getterRuns = 0;
  for (const [label, err, code, tc] of [["T EXCHANGE_FAILED", Object.assign(new Error("x"), { code: "EXCHANGE_FAILED" }), "PROBE_TRANSPORT_FAILED", "EXCHANGE_FAILED"],
    ["T ACCOUNT_MISMATCH", { code: "ACCOUNT_MISMATCH" }, "PROBE_ACCOUNT_MISMATCH", "ACCOUNT_MISMATCH"], ["T LIVEMODE", { code: "LIVEMODE_REFUSED" }, "PROBE_LIVEMODE_REFUSED", "LIVEMODE_REFUSED"],
    ["T STRIPE_HTTP_5XX", { code: "STRIPE_HTTP_5XX" }, "PROBE_TRANSPORT_FAILED", "STRIPE_HTTP_5XX"], ["unknown code", { code: SENT[3] }, "PROBE_TRANSPORT_FAILED", null],
    ["getter code", Object.defineProperty({}, "code", { get() { getterRuns += 1; return "EXCHANGE_FAILED"; } }), "PROBE_TRANSPORT_FAILED", null],
    ["proxy", new Proxy({ code: "EXCHANGE_FAILED" }, {}), "PROBE_TRANSPORT_FAILED", null], ["string", SENT[3], "PROBE_TRANSPORT_FAILED", null]]) {
    const plan = valid({ probes: ["P-S1"], hostaway: null, stripe: { accountId: ACCT, paymentIntentId: null } });
    const s = fakeSend(() => ({ reject: err })); const r = run(plan, { s }); const sum = await r.result;
    assert.deepEqual([sum.probes[0].code, sum.probes[0].transportCode, sum.probes[0].httpStatus], [code, tc, null], label);
    assertRedacted(sum, plan);
  }
  assert.equal(getterRuns, 0);
});

test("P6. accepted T over an injected FAKE exchange: exact wire for the default plan (H8 wire plural), true Account shape without livemode, zero network", async () => {
  const wire = [];
  const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
  const route = (req) => {
    const u = new URL(req.url); wire.push(`${req.method} ${u.pathname}${u.search}`);
    const q = Object.fromEntries(u.searchParams);
    if (u.pathname === "/v1/account") return ACCOUNT();
    if (u.pathname.startsWith("/v1/payment_intents/")) return PIOBJ();
    if (u.pathname === `/v1/listings/${L}`) return listingR().json;
    if (u.pathname.endsWith("/calendar")) return calendarR().json;
    if (u.pathname.startsWith("/v1/reservations/")) return reservationR().json;
    if (u.pathname === "/v1/guestPayments/charges") return q.reservationIds === R1 ? chargesR([chargeRow(R1, L1, 9001)]).json : chargesR([chargeRow(R2, L2, 9002)]).json;
    throw new Error("unmapped");
  };
  const exchange = async (req) => ({ status: 200, contentType: "application/json", bytes: enc(route(req)) });
  const h = createE7HostawaySend({ exchange, credential: () => "synthetic-hostaway-token" }).transport;
  const s = createE7StripeTestSend({ exchange, credential: () => "sk_test_Fake1", accountId: ACCT, apiVersion: "2026-08-26.dahlia" }).transport;
  const plan = valid(); const time = fakeTime();
  const r = runReadonlyProbes({ plan, hostaway: h, stripe: s, deps: time.deps() }); const sum = await r.result;
  assert.equal(sum.outcome, "COMPLETED", JSON.stringify(sum));
  assert.deepEqual(wire, [`GET /v1/listings/${L}`, `GET /v1/listings/${L}/calendar?endDate=2026-12-03&startDate=2026-12-01`, `GET /v1/reservations/${R1}`,
    `GET /v1/guestPayments/charges?limit=500&reservationIds=${R1}`, `GET /v1/guestPayments/charges?limit=500&reservationIds=${R2}`, "GET /v1/account",
    `GET /v1/payment_intents/${PI}?expand%5B%5D=latest_charge`]);
  assert.equal(sum.gates.G_FILTER, "OBSERVED");
  assertRedacted(sum, plan);
  assert.equal(netAttempts, 0);
});

test("P7. parity + source pins: copied constants equal their sources; imports exactly node:crypto / node:util / compensation-proof; no fetch / https / process / timers / console / fs / env / T / X / A / core", () => {
  assert.deepEqual([...T_ERROR_CODES], [...T_CODES]);
  assert.deepEqual([...RESERVATION_STATUSES], [...RS]);
  const proofSrc = readFileSync(join(ROOT, "lib/checkout/offline-charge-proof.js"), "utf8");
  assert.match(proofSrc, /const CHARGE_TYPES = Object\.freeze\(\["charge", "preAuth", "refund"\]\);/); assert.deepEqual([...CHARGE_TYPES], ["charge", "preAuth", "refund"]);
  assert.match(proofSrc, /const ROW_STRING_FIELDS = \["type", "title", "currency", "status", "paymentProvider", "paymentMethod"\];/);
  for (const v of [0, 1, 500, 500.5, 500.55, 500.555, -1, 1e21, NaN, "5", 0.1, 123.45]) assert.equal(amountToMinor(v), libAmountToMinor(v), String(v));
  const src = readFileSync(join(ROOT, "scripts/e7-connected/readonly-probe.mjs"), "utf8");
  for (const v of [9001, 0, -1, 1.5, "9001", 2 ** 53]) assert.equal(src.includes("posInt(v) ? String(v) : null") && (Number.isSafeInteger(v) && v >= 1 ? String(v) : null), providerIdToCanonical(v), String(v));
  assert.deepEqual([...src.matchAll(/^import\s.*?from\s+"([^"]+)";$/gm)].map((m) => m[1]).sort(), ["../../lib/checkout/compensation-proof.js", "node:crypto", "node:util"]);
  const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const re of [/\bfetch\s*\(/, /node:(https?|net|tls|dns|fs|child_process|timers)/, /process\./, /setTimeout|setInterval|setImmediate|queueMicrotask/, /console\./, /\bretry\b/i,
    /http-transports|real-exchange|run-manifest|run-core|run-guard|booking-db|hostaway-reservations/]) assert.doesNotMatch(code, re, String(re));
  assert.ok(PROBE_IDS.length === 8 && CODES.probe.includes("PROBE_CONTROL_OVERLAP"));
});
