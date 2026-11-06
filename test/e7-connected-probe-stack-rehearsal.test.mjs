// E7 PROBE-STACK REHEARSAL (TESTS + REPORT ONLY; OFFLINE): ACCEPTED P (readonly-probe.mjs, 27c0ea11) → ACCEPTED T (http-transports.mjs,
// 0830f9a4) → ACCEPTED X (real-exchange.mjs, af1b4db0) → a FAKE https primitive (request / Agent doubles). Report:
// claude/e7-connected-probe-stack-rehearsal.md.
// LABELS
//   * REAL (accepted, unchanged): P, T, X. No runtime hook was added; T's injected `exchange` is X's `exchange`; P's injected sends are T's.
//   * FAKE (TEST-ONLY): the https primitive (FakeReq / FakeRes / FakeAgent — a labelled COPY of the conventions in
//     test/e7-connected-real-exchange.test.mjs, modelled on the documented Node http.request event orders; NOT native ordering), P's
//     monotonic clock + timers (time moves only when a test advances it; no sleeps), and every reply. node:https request / Agent are
//     replaced by counting GUARDS before X loads (X's accepted test technique); the guards must count 0.
//   * SYNTHETIC: token / key / ids / listing / reservation / PaymentIntent values; reply sentinels must never reach a summary.
//   * No credential, env, network, DNS, TLS, socket, loopback, provider, PG or install. Protected ids appear ONLY inside fake replies (negative tests).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

const GUARD = { request: 0, Agent: 0 };
const realRequest = https.request; const RealAgent = https.Agent;
https.request = function guardRequest() { GUARD.request += 1; throw new Error("real https.request refused (offline rehearsal)"); };
https.Agent = function GuardAgent() { GUARD.Agent += 1; throw new Error("real https.Agent refused (offline rehearsal)"); };
syncBuiltinESMExports();
const X = await import("../scripts/e7-connected/real-exchange.mjs");
https.request = realRequest; https.Agent = RealAgent; syncBuiltinESMExports();
const T = await import("../scripts/e7-connected/http-transports.mjs");
const P = await import("../scripts/e7-connected/readonly-probe.mjs");

let netAttempts = 0; const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline rehearsal)"); };
let unhandled = 0; const onU = () => { unhandled += 1; }; process.on("unhandledRejection", onU);
let uncaught = 0; const onX = () => { uncaught += 1; }; process.on("uncaughtException", onX);
after(() => {
  globalThis.fetch = realFetch; process.off("unhandledRejection", onU); process.off("uncaughtException", onX);
  assert.deepEqual([netAttempts, GUARD.request, GUARD.Agent, unhandled, uncaught], [0, 0, 0, 0, 0], "no network / native primitive / unhandled / uncaught");
});

// ---- SYNTHETIC values -------------------------------------------------------------------------------------------------------------
const HTOKEN = "synthetic-hostaway-token"; const SKEY = "sk_test_Fake1"; const VERSION = "2026-01-28.clover";
const L = 871001; const L1 = 871001; const L2 = 871002; const R1 = "6100001"; const R2 = "6100002"; const ACCT = "acct_1SyntheticProbe"; const PI = "pi_test_syntheticProbe1";
const SENT = ["SENTINEL_GUEST_NAME", "sentinel.guest@mv-test.invalid", "SENTINEL_TITLE", "SENTINEL_PROVIDER_TEXT"];
const tick = () => new Promise((r) => setImmediate(r));
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await tick(); };

// ---- FAKE https primitive (labelled COPY of the accepted X test doubles) ----------------------------------------------------------
class FakeRes extends EventEmitter {
  constructor(req, statusCode, rawHeaders) { super(); this.req = req; this.statusCode = statusCode; this.rawHeaders = rawHeaders; this.complete = false; this.destroyCalls = 0; this.closed = false; }
  destroy() { this.destroyCalls += 1; if (this._d) return; this._d = true; process.nextTick(() => { if (!this.closed) { this.closed = true; this.emit("close"); } this.req._closeOnce(); }); }
}
class FakeReq extends EventEmitter {
  constructor(fx, options) { super(); this.fx = fx; this.options = options; this.endCalls = 0; this.endArgs = null; this.destroyCalls = 0; this.res = null; this.closed = false; }
  end(...a) { this.endCalls += 1; this.endArgs = a; if (this.fx.onEnd) this.fx.onEnd(this); }
  _closeOnce() { if (!this.closed) { this.closed = true; this.emit("close"); } }
  /** documented orders: before a response → error(ECONNRESET), close; after a response → res aborted, req close, res error, res close */
  destroy() {
    this.destroyCalls += 1; if (this._d) return; this._d = true;
    process.nextTick(() => {
      const res = this.res;
      if (res === null) { this.emit("error", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })); this._closeOnce(); return; }
      if (!res.closed) { res.emit("aborted"); this._closeOnce(); res.emit("error", Object.assign(new Error("aborted"), { code: "ECONNRESET" })); res.closed = true; res.emit("close"); }
      else this._closeOnce();
    });
  }
}
const ownEvents = ["error", "close", "response", "data", "end", "aborted"];
const listeners = (em) => (em ? ownEvents.reduce((n, ev) => n + em.listenerCount(ev), 0) : 0);
/** a routed fake primitive: `route(options, req)` → { status, json, raw? } | { hold: true } | { holdBody: { status, json, firstBytes } } */
function routedPrimitive(route) {
  const fx = { agents: [], reqs: [], log: [] };
  class FakeAgent { constructor(opts) { this.opts = opts; this.destroyCalls = 0; fx.agents.push(this); } destroy() { this.destroyCalls += 1; } }
  fx.Agent = FakeAgent;
  fx.request = (options) => { const r = new FakeReq(fx, options); fx.reqs.push(r); return r; };
  fx.onEnd = (req) => setImmediate(() => {
    const o = req.options;
    fx.log.push({ host: o.hostname, method: o.method, path: o.path, headerNames: Object.keys(o.headers).sort().join(","), auth: o.headers.Authorization ? "<redacted>" : null,
      version: o.headers["Stripe-Version"] ?? null, endArgs: req.endArgs.length });
    const r = route(o, req);
    if (r.hold) return;
    const body = Buffer.from(JSON.stringify(r.json ?? {}));
    const res = new FakeRes(req, r.status, r.raw ?? ["Content-Type", "application/json"]); req.res = res; req.emit("response", res);
    if (r.status >= 300 && r.status < 400) return;                      // X destroys a 3xx without reading it
    if (r.holdBody) { res.emit("data", body.subarray(0, 5)); return; }
    res.emit("data", body.subarray(0, 7)); res.emit("data", body.subarray(7)); res.complete = true; res.emit("end"); req._closeOnce(); if (!res.closed) { res.closed = true; res.emit("close"); }
  });
  return fx;
}
/** the FULL stack: X over the fake primitive, T over X, P over T (no wrapper anywhere) */
function stack(route) {
  const fx = routedPrimitive(route);
  const hx = X.createE7RealExchange({ provider: "hostaway", primitive: { request: fx.request, Agent: fx.Agent } });
  const sx = X.createE7RealExchange({ provider: "stripe", primitive: { request: fx.request, Agent: fx.Agent } });
  const h = T.createE7HostawaySend({ exchange: hx.exchange, credential: () => HTOKEN });
  const s = T.createE7StripeTestSend({ exchange: sx.exchange, credential: () => SKEY, accountId: ACCT, apiVersion: VERSION });
  assert.deepEqual([hx.ok, sx.ok, h.ok, s.ok], [true, true, true, true]);
  return { fx, hostaway: h.transport, stripe: s.transport };
}
function fakeTime() {
  const c = { t: 0, timers: [] };
  c.monotonic = () => c.t;
  c.arm = (ms) => { let res; const promise = new Promise((a) => { res = a; }); const e = { at: c.t + ms, res, cancels: 0, fired: false }; c.timers.push(e); return { promise, cancel: () => { e.cancels += 1; } }; };
  c.advance = async (ms) => { c.t += ms; for (const e of c.timers) if (!e.cancels && !e.fired && e.at <= c.t) { e.fired = true; e.res(); } await flush(); };
  c.deps = () => ({ monotonic: c.monotonic, timers: { arm: c.arm } });
  return c;
}

// ---- SYNTHETIC replies -------------------------------------------------------------------------------------------------------------
const listing = { status: "success", result: { id: L, currencyCode: "USD", name: SENT[3] } };
const calendar = { status: "success", result: ["2026-12-01", "2026-12-02", "2026-12-03"].map((date) => ({ date, isAvailable: 1, status: "available", minimumStay: 1, maximumStay: 90 })) };
const reservation = { status: "success", result: { id: Number(R1), listingMapId: L1, channelId: 2000, arrivalDate: "2026-12-04", departureDate: "2026-12-06", totalPrice: 500, currency: "USD",
  status: "new", guestName: SENT[0], guestEmail: SENT[1], customFieldValues: [] } };
const row = (rid, lid, id, o = {}) => ({ id, reservationId: Number(rid), listingMapId: lid, type: "charge", title: SENT[2], currency: "USD", status: "paid", paymentProvider: "offline",
  paymentMethod: "credit_card", amount: 500, ...o });
const charges = (rows, extra = {}) => ({ status: "success", result: rows, count: rows.length, offset: null, ...extra });
const account = { object: "account", id: ACCT, email: SENT[1] };                                     // the true Account shape: NO livemode
const piObj = (card = { capture_before: 1798761600 }) => ({ object: "payment_intent", id: PI, livemode: false, status: "requires_capture", capture_method: "manual", amount: 50000,
  amount_capturable: 50000, amount_received: 0, currency: "usd", metadata: { note: SENT[3] }, latest_charge: { object: "charge", id: "ch_test_1", payment_intent: PI, status: "succeeded",
    paid: true, captured: false, amount: 50000, amount_captured: 0, amount_refunded: 0, currency: "usd", livemode: false, payment_method_details: { card } } });
const defaultRoute = (o) => {
  const u = new URL(`https://${o.hostname}${o.path}`); const q = Object.fromEntries(u.searchParams);
  if (o.hostname === "api.stripe.com") return { status: 200, json: u.pathname === "/v1/account" ? account : piObj() };
  if (u.pathname === `/v1/listings/${L}`) return { status: 200, json: listing };
  if (u.pathname.endsWith("/calendar")) return { status: 200, json: calendar };
  if (u.pathname === `/v1/reservations/${R1}`) return { status: 200, json: reservation };
  if (u.pathname === "/v1/guestPayments/charges") return { status: 200, json: q.reservationIds === R1 ? charges([row(R1, L1, 9001)]) : charges([row(R2, L2, 9002)]) };
  return { status: 404, json: { status: "fail" } };
};
const planInput = (o = {}) => ({ version: "e7-probe-plan-v1",
  metadata: { reviewedCommit: "27c0ea1152db904f9fdeb285d0682a28cb89ac17", nodeVersion: "22.22.0", stripeVersion: VERSION, approvalRef: "synthetic-rehearsal" },
  hostaway: { listingId: L, calendar: { startDate: "2026-12-01", endDate: "2026-12-03" }, lookup: null, sample: { reservationId: R1, listingId: L1 }, control: { reservationId: R2, listingId: L2 } },
  stripe: { accountId: ACCT, paymentIntentId: PI }, probes: ["P-H1", "P-H2", "P-H4", "P-H5", "P-H6", "P-S1", "P-S2"], limits: { perProbeMs: 15000, runMs: 180000, tailMs: 5000 }, ...o });
const plan = (o) => { const v = P.validateProbePlan(planInput(o)); assert.equal(v.ok, true, v.code); return v.plan; };
const runStack = (pl, route = defaultRoute, { time = fakeTime(), signal } = {}) => {
  const st = stack(route);
  const needH = pl.probes.some((x) => x.startsWith("P-H")); const needS = pl.probes.some((x) => x.startsWith("P-S"));
  const r = P.runReadonlyProbes({ plan: pl, ...(needH ? { hostaway: st.hostaway } : {}), ...(needS ? { stripe: st.stripe } : {}), deps: time.deps(), ...(signal ? { signal } : {}) });
  assert.equal(r.ok, true, r.code);
  return { ...r, ...st, time };
};
const byId = (sum) => Object.fromEntries(sum.probes.map((x) => [x.id, x]));
function assertSafe(sum, pl) {
  const txt = JSON.stringify(sum);
  for (const s of [...SENT, HTOKEN, SKEY, R1, R2, String(L), ACCT, PI, "ch_test_1", "api.hostaway.com", "api.stripe.com"]) assert.ok(!txt.includes(s), `leak: ${s}`);
  // [FIRST-RUN FIX, labelled: P's exported VOCABULARY does not contain T's ERROR_CODES, which `transportCode` legitimately carries; the
  //  accepted P test whitelists P.T_ERROR_CODES separately (test/e7-connected-readonly-probe.test.mjs KEY_VOCAB) — same convention here]
  const allowed = new Set([...P.VOCABULARY, ...P.T_ERROR_CODES, pl.planHash, ...Object.values(pl.metadata)]);
  const walk = (v) => { if (typeof v === "string") assert.ok(allowed.has(v), `non-whitelisted value: ${v}`); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
  walk(sum);
  const frozen = (v) => { if (v && typeof v === "object") { assert.ok(Object.isFrozen(v)); Object.values(v).forEach(frozen); } }; frozen(sum);
}
const assertClean = async (fx) => {
  await flush();
  assert.ok(fx.agents.length === fx.reqs.length && fx.agents.every((a) => a.destroyCalls === 1), "one Agent per dispatched request, each destroyed exactly once");
  for (const r of fx.reqs) { assert.ok(r.destroyCalls <= 1 && (!r.res || r.res.destroyCalls <= 1), "destroyed at most once"); assert.equal(listeners(r) - (r.foreign ? 1 : 0), 0, "no module listener left on the request"); assert.equal(listeners(r.res), 0, "no module listener left on the response"); }
};

// =================================================================================================================================
test("R1. default approved-inventory-shaped plan (P-H3 excluded) through P → T → X → fake primitive: exact GET wire, headers, framing, one request + Agent per probe, G_FILTER + full B4, safe summary, clean resources", async () => {
  const pl = plan();
  let foreignReq = null;
  const r = runStack(pl, (o, req) => { if (o.path === `/v1/listings/${L}`) { req.on("close", () => {}); req.foreign = true; foreignReq = req; } return defaultRoute(o); });
  const sum = await r.result;
  assert.equal(sum.outcome, "COMPLETED", JSON.stringify(sum));
  assert.deepEqual(r.fx.log.map((e) => `${e.method} ${e.host}${e.path}`), [
    `GET api.hostaway.com/v1/listings/${L}`, `GET api.hostaway.com/v1/listings/${L}/calendar?endDate=2026-12-03&startDate=2026-12-01`, `GET api.hostaway.com/v1/reservations/${R1}`,
    `GET api.hostaway.com/v1/guestPayments/charges?limit=500&reservationIds=${R1}`, `GET api.hostaway.com/v1/guestPayments/charges?limit=500&reservationIds=${R2}`,
    "GET api.stripe.com/v1/account", `GET api.stripe.com/v1/payment_intents/${PI}?expand%5B%5D=latest_charge`], "H8 internal singular → wire plural; S1 current account");
  for (const req of r.fx.reqs) {
    const o = req.options; const isH = o.hostname === "api.hostaway.com";
    assert.deepEqual(Object.keys(o.headers).sort(), isH ? ["Accept", "Authorization", "Cache-control"] : ["Authorization", "Stripe-Version"], "GET: no body headers / Content-Length");
    assert.equal(o.headers.Authorization, `Bearer ${isH ? HTOKEN : SKEY}`, "synthetic Bearer only");
    if (!isH) assert.equal(o.headers["Stripe-Version"], "2026-01-28.clover", "the fixed proposed version header");
    assert.deepEqual([o.method, o.port, o.servername, o.rejectUnauthorized, o.insecureHTTPParser, o.maxHeaderSize, req.endCalls, req.endArgs.length], ["GET", 443, o.hostname, true, false, 16384, 1, 0]);
    assert.deepEqual(o.agent.opts, { keepAlive: false, maxSockets: 1, maxCachedSessions: 0 });
  }
  assert.deepEqual([r.fx.reqs.length, r.fx.agents.length], [7, 7], "one request + one Agent per dispatched probe, no retry / follow-up");
  assert.deepEqual({ ...sum.gates }, { G_AUTH_charges_read: "OBSERVED", G_FILTER: "OBSERVED", G_SHAPE_listing: "OBSERVED", G_SHAPE_calendar: "OBSERVED", G_SHAPE_lookup: "NOT_PROBED",
    G_SHAPE_reservation: "OBSERVED", G_SHAPE_charges: "OBSERVED", B4_pi_read: "OBSERVED", TEST_mode_pi: "OBSERVED" });
  const p = byId(sum);
  assert.deepEqual({ ...p["P-S1"].evidence }, { accountIdMatches: true }); assert.equal(p["P-S1"].httpStatus, null, "Stripe: no fabricated HTTP status");
  assert.deepEqual({ ...p["P-S2"].evidence }, { status: "requires_capture", livemode: false, latestCharge: "VERIFIED_TEST_CHARGE", proofFieldsTyped: true });
  assert.deepEqual({ ...p["P-H5"].evidence }, { rowCount: 1, allRowsMatch: true, typesOk: true, complete: true });
  assert.deepEqual({ ...sum.timerCleanup }, { cancelFailed: 0, uncancellable: 0 });
  assertSafe(sum, pl);
  assert.ok(!JSON.stringify(r.fx.log).includes(HTOKEN) && !JSON.stringify(r.fx.log).includes(SKEY), "test log keeps no credential");
  await assertClean(r.fx);
  assert.equal(foreignReq.listenerCount("close"), 1, "the foreign listener is preserved");
  assert.deepEqual({ ...(await r.finalize()) }.tail, "NONE");
});

test("R2. refusals that cross X / T / P: Hostaway 401 on the sample charge list stops there (no jwt / re-mint / retry); 302, oversize body and a protected id in a reply map to exact codes with scoped gates", async () => {
  { // 401 on P-H5: one response, no alternate auth, control + Stripe NOT_RUN
    const pl = plan(); const r = runStack(pl, (o) => (o.path.includes(`reservationIds=${R1}`) ? { status: 401, json: { status: "fail", message: SENT[3] } } : defaultRoute(o)));
    const sum = await r.result; const p = byId(sum);
    assert.deepEqual([p["P-H5"].code, p["P-H5"].httpStatus, p["P-H6"].code, p["P-S1"].code, p["P-S2"].code, sum.gates.G_AUTH_charges_read, sum.gates.G_FILTER, r.fx.reqs.length],
      ["PROBE_AUTH_REFUSED", 401, "AFTER_STOP", "AFTER_STOP", "AFTER_STOP", "OPEN", "OPEN", 4]);
    assert.ok(r.fx.reqs.every((q) => q.options.headers.Authorization === `Bearer ${HTOKEN}` && !("jwt" in q.options.headers)), "no jwt header switch");
    assertSafe(sum, pl); await assertClean(r.fx);
  }
  const H1 = plan({ hostaway: { ...planInput().hostaway, calendar: null, sample: null, control: null }, stripe: null, probes: ["P-H1"] });
  { // 302: X resolves an empty-bodied 3xx without reading Location; T refuses REDIRECT_REFUSED; P maps to TRANSPORT_FAILED with the T code
    const r = runStack(H1, () => ({ status: 302, json: {}, raw: ["Location", "https://evil.example/", "Content-Type", "text/html"] }));
    const sum = await r.result;
    assert.deepEqual([sum.probes[0].code, sum.probes[0].transportCode, sum.probes[0].httpStatus, r.fx.reqs.length, r.fx.reqs[0].res.listenerCount("data")],
      ["PROBE_TRANSPORT_FAILED", "REDIRECT_REFUSED", null, 1, 0]);
    assert.equal(sum.gates.G_SHAPE_listing, "OPEN"); assertSafe(sum, H1); await assertClean(r.fx);
  }
  { // response over T's Hostaway bound (Content-Length 2 MiB): X refuses before body work; T maps the rejection to EXCHANGE_FAILED
    const r = runStack(H1, () => ({ status: 200, json: listing, raw: ["Content-Type", "application/json", "Content-Length", String(2 * 1024 * 1024)] }));
    const sum = await r.result;
    assert.deepEqual([sum.probes[0].code, sum.probes[0].transportCode, r.fx.reqs.length], ["PROBE_TRANSPORT_FAILED", "EXCHANGE_FAILED", 1]); await assertClean(r.fx);
  }
  { // a protected reservation id INSIDE a fake charge-list reply (never a dispatched target): P refuses with the code only
    const pl = plan({ hostaway: { ...planInput().hostaway, calendar: null, control: null }, stripe: null, probes: ["P-H1", "P-H4", "P-H5"] });
    const r = runStack(pl, (o) => (o.path.startsWith("/v1/guestPayments/charges") ? { status: 200, json: charges([row("70636076", L1, 9001)]) } : defaultRoute(o)));
    const sum = await r.result;
    assert.deepEqual([byId(sum)["P-H5"].code, byId(sum)["P-H5"].evidence, sum.gates.G_FILTER, r.fx.reqs.length], ["PROBE_PROTECTED_SEEN", null, "OPEN", 3]);
    assert.ok(r.fx.reqs.every((q) => !q.options.path.includes("70636076")), "the protected id was never a dispatched target");
    assert.ok(!JSON.stringify(sum).includes("70636076")); assertSafe(sum, pl); await assertClean(r.fx);
  }
});

test("R3. a held request / response past P's fake deadline: P's AbortController propagates T → X, the fake request is destroyed once, bounded STOP, no later probe; late tail observed; final-handoff abort sends nothing", async () => {
  const pl = plan({ hostaway: { ...planInput().hostaway, sample: null, control: null }, stripe: null, probes: ["P-H1", "P-H2"] });
  { // no response at all (connect / header phase)
    const r = runStack(pl, () => ({ hold: true })); await flush();
    assert.equal(r.fx.reqs.length, 1);
    await r.time.advance(15000);
    const sum = await r.result; const req = r.fx.reqs[0];
    assert.deepEqual([byId(sum)["P-H1"].code, byId(sum)["P-H2"].code, sum.stopCode, r.fx.reqs.length], ["PROBE_TIMEOUT", "AFTER_STOP", "PROBE_TIMEOUT", 1], "P's own deadline is the recorded cause");
    await flush();
    assert.deepEqual([req.destroyCalls, req.endCalls, r.fx.agents[0].destroyCalls, listeners(req)], [1, 1, 1, 0], "X destroyed the fake request once; Agent destroyed; listeners removed");
    // T's later rejection (X EXCHANGE_ABORTED → T ABORTED_IN_FLIGHT on the aborted genuine signal) reaches P only as a LATE tail kind
    assert.equal((await r.finalize()).tail, "LATE_REJECTED");
    assertSafe(sum, pl);
  }
  { // response headers received, body held mid-stream
    const r = runStack(pl, (o) => (o.path === `/v1/listings/${L}` ? { status: 200, json: listing, holdBody: true } : defaultRoute(o))); await flush();
    await r.time.advance(15000);
    const sum = await r.result; const req = r.fx.reqs[0];
    await flush();
    assert.deepEqual([byId(sum)["P-H1"].code, r.fx.reqs.length, req.destroyCalls, req.res.destroyCalls, r.fx.agents[0].destroyCalls, listeners(req), listeners(req.res)], ["PROBE_TIMEOUT", 1, 1, 1, 1, 0, 0]);
    assert.equal((await r.finalize()).tail, "LATE_REJECTED");
  }
  { // root PC1 through the full stack: the injected clock aborts the caller at the final handoff → zero fake requests
    const ac = new AbortController(); let calls = 0; const st = stack(defaultRoute);
    const one = plan({ hostaway: { ...planInput().hostaway, calendar: null, sample: null, control: null }, stripe: null, probes: ["P-H1"], limits: { perProbeMs: 1000, runMs: 1000, tailMs: 0 } });
    const r = P.runReadonlyProbes({ plan: one, hostaway: st.hostaway, signal: ac.signal, deps: { monotonic: () => { calls += 1; if (calls === 3) ac.abort(); return 0; }, timers: { arm: () => ({ promise: new Promise(() => {}), cancel() {} }) } } });
    const sum = await r.result;
    assert.deepEqual([sum.probes[0].code, st.fx.reqs.length, st.fx.agents.length], ["PROBE_CANCELLED", 0, 0]);
  }
});

test("R4. evidence qualification through the full stack: card without capture_before keeps B4 OPEN (TEST observed separately); empty / truncated / overlapping charge controls stay INCONCLUSIVE / OPEN and never page or resend", async () => {
  { const pl = plan({ hostaway: null, probes: ["P-S1", "P-S2"] });
    const r = runStack(pl, (o) => (o.path.startsWith("/v1/payment_intents/") ? { status: 200, json: piObj({}) } : defaultRoute(o)));
    const sum = await r.result; const p = byId(sum)["P-S2"];
    assert.deepEqual([p.outcome, p.code, p.evidence.proofFieldsTyped, sum.gates.B4_pi_read, sum.gates.TEST_mode_pi, r.fx.reqs.length], ["INCONCLUSIVE", "PROBE_PROOF_FIELDS_INCOMPLETE", false, "OPEN", "OBSERVED", 2]);
    assertSafe(sum, pl); await assertClean(r.fx); }
  const pl = plan({ hostaway: { ...planInput().hostaway, calendar: null }, stripe: null, probes: ["P-H1", "P-H4", "P-H5", "P-H6"] });
  for (const [label, route, code, h6, gate, requests] of [
    ["empty sample", (o) => (o.path.includes(`reservationIds=${R1}`) ? { status: 200, json: charges([]) } : defaultRoute(o)), "PROBE_EMPTY_SAMPLE", "PREREQ_INCONCLUSIVE", "OPEN", 3],
    ["truncated (count 500)", (o) => (o.path.includes(`reservationIds=${R1}`) ? { status: 200, json: charges(Array.from({ length: 500 }, (_, i) => row(R1, L1, 20000 + i))) } : defaultRoute(o)), "PROBE_LIMIT_REACHED", "PREREQ_INCONCLUSIVE", "OPEN", 3],
    ["hasMore", (o) => (o.path.includes(`reservationIds=${R1}`) ? { status: 200, json: charges([row(R1, L1, 9001)], { hasMore: true }) } : defaultRoute(o)), "PROBE_LIMIT_REACHED", "PREREQ_INCONCLUSIVE", "OPEN", 3]]) {
    const r = runStack(pl, route); const sum = await r.result; const p = byId(sum);
    assert.deepEqual([p["P-H5"].code, p["P-H6"].code, sum.gates.G_FILTER, r.fx.reqs.length], [code, h6, gate, requests], label);
    assert.ok(r.fx.log.every((e) => !/offset|afterId|page/.test(e.path)), `${label}: no follow-up page`);
    await assertClean(r.fx);
  }
  { // overlapping control ids: P-H6 runs once, INCONCLUSIVE overlap, G_FILTER OPEN
    const r = runStack(pl, (o) => (o.path.includes(`reservationIds=${R2}`) ? { status: 200, json: charges([row(R2, L2, 9001)]) } : defaultRoute(o)));
    const sum = await r.result; const p = byId(sum);
    assert.deepEqual([p["P-H5"].code, p["P-H6"].code, sum.gates.G_FILTER, r.fx.reqs.length], ["PROBE_OK", "PROBE_CONTROL_OVERLAP", "OPEN", 4]);
    assertSafe(sum, pl); await assertClean(r.fx);
  }
});

// ===== G6B (OFFLINE, test-only): the exact proposed hosted scope P-H2 + P-S1 + P-S2 through the REAL P → T → X stack ==============
// Plan values = the proposed G6B package: listing 606998, calendar 2027-01-18 → 2027-01-20, the canceled Run-3 TEST PaymentIntent id.
// Every REPLY is FAKE / SYNTHETIC (labelled): nothing here is a claim about a real provider shape for Stripe-Version 2026-01-28.clover.
const G6B = Object.freeze({ listingId: 606998, startDate: "2027-01-18", endDate: "2027-01-20", pi: "pi_3UYqhH2B9LTneQgw1Q0IoYtz" });
const g6bPlan = () => plan({ hostaway: { listingId: G6B.listingId, calendar: { startDate: G6B.startDate, endDate: G6B.endDate }, lookup: null, sample: null, control: null },
  stripe: { accountId: ACCT, paymentIntentId: G6B.pi }, probes: ["P-H2", "P-S1", "P-S2"], limits: { perProbeMs: 10000, runMs: 30000, tailMs: 5000 } });
const g6bCalendar = { status: "success", result: [G6B.startDate, "2027-01-19", G6B.endDate].map((date) => ({ date, isAvailable: 1, status: "available", minimumStay: 1, maximumStay: 90 })) };
const g6bRoute = (o) => {
  const u = new URL(`https://${o.hostname}${o.path}`);
  if (o.hostname === "api.stripe.com") return { status: 200, json: u.pathname === "/v1/account" ? account : { ...piObj(), id: G6B.pi, status: "canceled", amount_capturable: 0,
    latest_charge: { ...piObj().latest_charge, payment_intent: G6B.pi, status: "succeeded", captured: false } } };
  if (u.pathname === `/v1/listings/${G6B.listingId}/calendar`) return { status: 200, json: g6bCalendar };
  return { status: 404, json: { status: "fail" } };
};
test("R5. G6B exact scope: ≤ 3 GETs in order P-H2 → P-S1 → P-S2 (exact listing / dates / PI), Stripe-Version 2026-01-28.clover ON THE WIRE, no POST / mint / capture / booking, one request per probe, no retry; P-S1 failure stops P-S2; P-H2 failure stops both; safe summary", async () => {
  const pl = g6bPlan();
  assert.equal(pl.metadata.stripeVersion, "2026-01-28.clover");
  const r = runStack(pl, g6bRoute); const sum = await r.result;
  assert.deepEqual(r.fx.log.map((e) => `${e.method} ${e.host}${e.path}`), [
    `GET api.hostaway.com/v1/listings/606998/calendar?endDate=2027-01-20&startDate=2027-01-18`, "GET api.stripe.com/v1/account",
    "GET api.stripe.com/v1/payment_intents/pi_3UYqhH2B9LTneQgw1Q0IoYtz?expand%5B%5D=latest_charge"], "exactly the 3 proposed GETs, in order");
  assert.deepEqual(r.fx.log.filter((e) => e.host === "api.stripe.com").map((e) => e.version), ["2026-01-28.clover", "2026-01-28.clover"], "the Clover header is what is SENT");
  assert.ok(r.fx.log.every((e) => e.method === "GET" && !/accessTokens|capture|cancel|reservations|refund|charges/.test(e.path)), "no POST, token mint, capture, cancel, booking, refund");
  assert.deepEqual([r.fx.reqs.length, r.fx.agents.length], [3, 3], "one request + one Agent per probe; no retry / follow-up");
  assert.deepEqual(sum.probes.map((x) => x.id), ["P-H2", "P-S1", "P-S2"]);
  assert.ok(sum.probes.every((x) => P.CODES.probe.includes(x.code)), JSON.stringify(sum.probes.map((x) => x.code)));
  const txt = JSON.stringify(sum);
  for (const s of [...SENT, HTOKEN, SKEY, ACCT, G6B.pi, "ch_test_1", "api.hostaway.com", "api.stripe.com", "2027-01-19"]) assert.ok(!txt.includes(s), `leak: ${s}`);
  await assertClean(r.fx);
  // P-S1 refused (Stripe 401) → P-S2 never dispatched
  { const r2 = runStack(g6bPlan(), (o) => (o.path === "/v1/account" ? { status: 401, json: { error: { message: SENT[3] } } } : g6bRoute(o))); const s2 = await r2.result; const p = byId(s2);
    assert.equal(p["P-S1"].outcome, "STOP"); assert.deepEqual([p["P-S2"].outcome, p["P-S2"].code], ["NOT_RUN", "AFTER_STOP"]);
    assert.equal(r2.fx.reqs.length, 2); assert.ok(!r2.fx.log.some((e) => e.path.includes(G6B.pi)), "the PI was never requested"); await assertClean(r2.fx); }
  // P-S1 account mismatch → P-S2 never dispatched
  { const r3 = runStack(g6bPlan(), (o) => (o.path === "/v1/account" ? { status: 200, json: { ...account, id: "acct_1SomebodyElse" } } : g6bRoute(o))); const s3 = await r3.result; const p = byId(s3);
    assert.equal(p["P-S1"].outcome, "STOP"); assert.equal(p["P-S2"].code, "AFTER_STOP"); assert.equal(r3.fx.reqs.length, 2); await assertClean(r3.fx); }
  // P-H2 refused → nothing after it
  { const r4 = runStack(g6bPlan(), (o) => (o.hostname === "api.hostaway.com" ? { status: 403, json: { status: "fail" } } : g6bRoute(o))); const s4 = await r4.result; const p = byId(s4);
    assert.equal(p["P-H2"].outcome, "STOP"); assert.deepEqual([p["P-S1"].code, p["P-S2"].code], ["AFTER_STOP", "AFTER_STOP"]); assert.equal(r4.fx.reqs.length, 1); await assertClean(r4.fx); }
  // a different PI / listing / dates is a different plan (hash changes); the plan is the only source of request values
  const g6bInput = (o = {}) => planInput({ hostaway: { listingId: G6B.listingId, calendar: { startDate: G6B.startDate, endDate: G6B.endDate }, lookup: null, sample: null, control: null },
    stripe: { accountId: ACCT, paymentIntentId: G6B.pi }, probes: ["P-H2", "P-S1", "P-S2"], limits: { perProbeMs: 10000, runMs: 30000, tailMs: 5000 }, ...o });
  assert.equal(P.validateProbePlan(g6bInput()).plan.planHash, pl.planHash);
  for (const o of [{ stripe: { accountId: ACCT, paymentIntentId: "pi_3SomeOtherIntent00000" } }, { hostaway: { ...g6bInput().hostaway, calendar: { startDate: "2027-01-17", endDate: "2027-01-20" } } }])
    assert.notEqual(P.validateProbePlan(g6bInput(o)).plan.planHash, pl.planHash);
});
