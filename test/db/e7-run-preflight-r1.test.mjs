// E7 M2-G1 — runPreflightR1 / readExclusionBaselineR1 on a DISPOSABLE local PG (migrations as the accepted DB suites; never a shared DB)
// with FAKE provider exchanges behind the ACCEPTED Slice T transports. No network, no real provider, no credential file, no env read.
//
// LABELS
//   * REAL: disposable local PG with the harness's real mv_booking_app / mv_booking_report logins; the accepted repo booking path
//     (createIntentRecord → PRICE_CONFIRMED → guest → beginPayStep → checkout op → PAYMENT_AUTHORIZED, the M2-D lane path) and the
//     REAL accepted reservation worker for the historical stand-in rows; the accepted T transports (createE7HostawaySend /
//     createE7StripeTestSend) and the module under test, unchanged.
//   * SYNTHETIC (TEST-ONLY): the provider world and booking setup are a LABELLED COPY of test/db/e7-run-core-abort-v2.test.mjs:66–203 (itself
//     the accepted rehearsals' copy), reduced to the reads this slice performs; the fake HTTP exchange is a LABELLED COPY of
//     test/db/e7-connected-http-stack-rehearsal.test.mjs:209–286 (write routes kept so any write would be LOGGED, then asserted absent);
//     timeDriver / FaultPool / FaultClient are a LABELLED COPY of test/db/e7-run-core-abort-v2.test.mjs:250–317. Credentials are explicit
//     SYNTHETIC strings. Plans / packages / env snapshots / clocks are SYNTHETIC.
//   * HISTORICAL STAND-INS (TEST-ONLY, disposable DB): intents created through the accepted path with the EXACT ledger Run1 / Run3 intent
//     ids (and Run3's PaymentIntent id) so the exclusion baseline has existing rows to fingerprint; Run2 stays ABSENT. They are labelled
//     stand-ins, never claimed to be the historical rows.
//   * OUT-OF-BAND MUTATIONS: the accepted F.ownerManagedHistory (schema owner, triggers bypassed, disposable cluster only).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent, createIntentRecord, collectGuestDetails, beginPayStep, recordCheckoutSession } from "../../lib/booking-db/repo.js";
import { claimNextOperation, completeOperation } from "../../lib/booking-db/operations.js";
import { runOrchestratorStep, DEFAULT_TIMEOUTS } from "../../lib/booking-db/reservation-worker.js";
import { priceStay } from "../../lib/checkout/server-pricer.js";
import { readDirectPolicyFromEnv } from "../../lib/direct-policy.js";
import { todayInTimeZone } from "../../lib/public-api.js";
import { createE7HostawaySend, createE7StripeTestSend } from "../../scripts/e7-connected/http-transports.mjs";
import { validateGuardDeps, createGuard, LIMITS } from "../../scripts/e7-connected/run-guard.mjs";
import { SQL as FACTS_SQL } from "../../scripts/e7-connected/run-facts.mjs";
import { SQL as CORE_SQL, checkSameDatabase as coreCheckSameDatabase } from "../../scripts/e7-connected/run-core.mjs";
import { P0_BUDGET_MS as CORE_P0, PHASE_LIMITS as CORE_PHASES } from "../../scripts/e7-connected/run-core-abort-v2.mjs";
import { BRIDGE_LIMITS } from "../../scripts/e7-connected/run-test-abort.mjs";
import { buildRunPackageV1, sourceDigestV1, RUN_PLAN_CLOSURE, HISTORICAL_EXCLUSIONS, ALLOWED_OPS } from "../../scripts/e7-connected/run-plan-v1.mjs";
import { canonicalJson } from "../../scripts/e7-connected/run-manifest.mjs";
import * as R from "../../scripts/e7-connected/run-binding-r1.mjs";
import * as P from "../../scripts/e7-connected/run-preflight-r1.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LISTING = 606998;
let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused in the offline M2-G1 suite"); };
let db; let reportPool;
before(async () => { db = await startMigratedDatabase(); reportPool = new pg.Pool({ connectionString: db.reportUrl(), max: 8 }); });
after(async () => { globalThis.fetch = realFetch; await reportPool.end().catch(() => {}); await db.close(); assert.equal(netAttempts, 0); });

const SEC = 1000; const MIN = 60 * SEC; const DAY = 24 * 60 * MIN;
const ENV_R = Object.freeze({ VERCEL_ENV: "development", MV_E7_RESERVATION_WORKER: "enabled" });
const POLICY = readDirectPolicyFromEnv(ENV_R).policy;
const ACCT = "acct_1AdapterRehearsal";                            // FIXTURE Stripe account id (mock world)
const REF_FIELD = 777009;
const TZ = "America/Mazatlan";
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN1 = HISTORICAL_EXCLUSIONS.runs[0]; const RUN2 = HISTORICAL_EXCLUSIONS.runs[1]; const RUN3 = HISTORICAL_EXCLUSIONS.runs[2];
const PATH_A_PI = HISTORICAL_EXCLUSIONS.otherPaymentIntentIds[0];

// ===== LABELLED COPY (reduced) of test/db/e7-run-core-abort-v2.test.mjs:66–203: world + booking =====
let block = 7100000;
function world({ nightly = 250 } = {}) {
  block += 1000;
  const w = { nightly, calls: [], res: new Map(), pis: new Map(), nextRes: block, accountId: ACCT, calendar: "available", listingCurrency: "USD", lookupExtra: [] };
  const days = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push({ date: d, status: w.calendar, isAvailable: w.calendar === "available" ? 1 : 0, minimumStay: 1, maximumStay: 90, closedOnArrival: 0, closedOnDeparture: 0 }); return out; };
  const full = (r) => ({ id: r.id, listingMapId: r.listingMapId, channelId: 2000, arrivalDate: r.arrivalDate, departureDate: r.departureDate, totalPrice: r.totalPrice,
    currency: r.currency, status: r.status, customFieldValues: [{ customFieldId: REF_FIELD, value: r.ref }] });
  w.piObj = (p) => ({ object: "payment_intent", id: p.id, livemode: false, status: p.status, capture_method: "manual", amount: p.amount, amount_received: 0,
    amount_capturable: p.status === "requires_capture" ? p.amount : 0, currency: "usd", metadata: { mv_intent_id: p.intentId, mv_payment_attempt_id: p.attemptId },
    latest_charge: { object: "charge", id: p.chargeId, payment_intent: p.id, status: "succeeded", paid: true, captured: false, amount: p.amount, amount_captured: 0,
      amount_refunded: 0, currency: "usd", livemode: false, payment_method_details: { card: { capture_before: p.captureBeforeSec } } } });
  w.pricing = {
    get: async (path, opts = {}) => {
      w.calls.push(`pricing GET ${path}`);
      const m = /^\/listings\/(\d+)(\/calendar)?$/.exec(path); const id = Number(m[1]);
      if (!m[2]) return { status: 200, json: { result: { id, currencyCode: w.listingCurrency, personCapacity: 4, minNights: 1, maxNights: 90 } } };
      return { status: 200, json: { result: days(opts.query.startDate, opts.query.endDate) } };
    },
    post: async (path, body) => {
      w.calls.push(`pricing POST ${path}`);
      const nights = Math.round((Date.parse(body.endingDate) - Date.parse(body.startingDate)) / DAY);
      const comps = [{ id: 1, type: "accommodation", name: "baseRate", title: "Base rate", quantity: 1, value: w.nightly, total: w.nightly * nights, isIncludedInTotalPrice: 1,
        isMandatory: 1, isOverriddenByUser: 0, isDeleted: 0, units: nights }];
      return { status: 200, json: { status: "success", result: { totalPrice: comps[0].total, components: comps } } };
    }
  };
  w.exec = { R: {
    pricing: w.pricing,
    lookupPage: async (req) => {
      w.calls.push("lookupPage");
      if (req.query.afterId) return { httpStatus: 200, json: { status: "success", result: [] } };
      const items = [...w.res.values()].filter((r) => r.listingMapId === req.query.listingId && r.arrivalDate === req.query.arrivalStartDate).map(full);
      return { httpStatus: 200, json: { status: "success", result: [...items, ...w.lookupExtra] } };
    },
    retrieveReservation: async (req) => {
      w.calls.push("retrieveReservation");
      const r = w.res.get(Number(/\/reservations\/(\d+)/.exec(req.path)[1]));
      return r ? { httpStatus: 200, json: { status: "success", result: full(r) } } : { httpStatus: 404, json: { status: "fail" } };
    },
    createReservation: async (req) => {
      w.calls.push("createReservation");
      const r = { id: w.nextRes++, listingMapId: req.body.listingMapId, arrivalDate: req.body.arrivalDate, departureDate: req.body.departureDate,
        totalPrice: req.body.totalPrice, currency: req.body.currency, status: "new", ref: req.body.customFieldValues[0].value };
      w.res.set(r.id, r);
      return { httpStatus: 201, json: { status: "success", result: full(r) } };
    }
  }, stripe: {
    retrieveAccount: async () => { w.calls.push("retrieveAccount"); return { object: "account", id: w.accountId }; },
    retrievePaymentIntent: async (id) => { w.calls.push("retrievePaymentIntent"); return w.piObj(w.pis.get(id)); }
  } };
  return w;
}
let laneN = 0;
/** fresh payment_authorized USD booking through the accepted repo path; `id` / `piId` overrides are for the labelled historical stand-ins */
async function authorizedBooking(w, o = {}) {
  laneN += 1;
  const stay = { from: addDays("2027-05-01", 6 * laneN), to: addDays("2027-05-01", 6 * laneN + 4), guests: 2 };
  const base = Date.now() - 20 * MIN;
  const priced = await priceStay({ request: { listingId: LISTING, ...stay }, listingConfig: { currency: "USD" }, client: w.pricing, policy: POLICY,
    today: todayInTimeZone(undefined, new Date(base)), now: base });
  assert.ok(priced.ok, priced.error);
  w.calls.length = 0;
  const intent = await createIntentRecord(db.app, { ...(o.id ? { id: o.id } : {}), ref: F.nextRef(), accessTokenHash: F.tokenHash(), environment: "test", now: base, listingId: LISTING, ...stay });
  F.ok(await applyEvent(db.app, intent.id, { type: "PRICE_CONFIRMED", price: priced.price }, { now: base, actor: "guest" }));
  F.ok(await collectGuestDetails(db.app, intent.id, F.GUEST, { now: base + SEC, termsVersion: "terms-2026-10" }));
  const b = F.ok(await beginPayStep(db.app, intent.id, { now: base + 2 * SEC }));
  const op = await claimNextOperation(db.app, { workerId: "w-pay", now: base + 2 * SEC, intentId: intent.id, opTypes: ["stripe.create_checkout_session"] });
  const sessionId = `cs_test_m2g1Lane${String(laneN).padStart(4, "0")}`;
  F.ok(await completeOperation(db.app, op.id, { workerId: "w-pay", now: base + 2 * SEC, outcome: { status: "succeeded", resultRef: sessionId } }));
  F.ok(await recordCheckoutSession(db.app, intent.id, b.attempt.id, { sessionId, expiresAt: base + 30 * MIN, now: base + 2 * SEC }));
  const piId = o.piId ?? `pi_M2G1Lane${String(laneN).padStart(4, "0")}`;
  const captureBefore = Math.floor((base + 7 * DAY) / 1000) * 1000;
  F.ok(await applyEvent(db.app, intent.id, { type: "PAYMENT_AUTHORIZED", id: `evt_auth_${piId}`, paymentIntentId: piId, sessionId, amountMinor: priced.price.finalTotalMinor,
    currency: "usd", livemode: false, authorizationCreatedAt: base + 3 * SEC, captureBefore }, { now: base + 4 * SEC, actor: "webhook" }));
  const pa = (await db.app.query("SELECT id FROM booking.payment_attempts WHERE intent_id = $1 AND status = 'completed'", [intent.id])).rows[0].id;
  w.pis.set(piId, { id: piId, intentId: intent.id, attemptId: pa, status: "requires_capture", amount: priced.price.finalTotalMinor, chargeId: `ch_test_g1${laneN}`,
    captureBeforeSec: captureBefore / 1000 });
  return { id: intent.id, ref: intent.ref, stay, piId, price: priced.price, total: priced.price.finalTotalMinor, paymentAttemptId: pa, base };
}
// ===== end of the labelled world / booking copy =====

// ===== LABELLED COPY (reduced) of test/db/e7-connected-http-stack-rehearsal.test.mjs:209–286: SYNTHETIC credentials + FAKE exchange =====
const HTOKEN = "synthetic-hostaway-token";                 // SYNTHETIC
const SKEY = "sk_test_Fake1";                              // SYNTHETIC test-prefix key (never a real key shape)
const SVERSION = "2099-01-01.synthetic";                   // SYNTHETIC Stripe-Version pin
const encJ = (v) => new TextEncoder().encode(JSON.stringify(v));
const reply = (status, json) => ({ status, contentType: "application/json", bytes: encJ(json) });
function httpExchange(w, o = {}) {
  const x = { log: [], violations: [] };
  const wrap = (r) => reply(r.httpStatus ?? r.status, r.json);
  x.hostaway = async (req) => {
    const u = new URL(req.url); const p = u.pathname; const q = Object.fromEntries(u.searchParams); const m = req.method;
    const body = req.body === null ? undefined : JSON.parse(req.body);
    if (u.origin !== "https://api.hostaway.com" || req.headers.Authorization !== `Bearer ${HTOKEN}`) { x.violations.push(`${m} ${p}`); return reply(400, { status: "fail" }); }
    x.log.push({ provider: "hostaway", method: m, path: p, search: u.search });
    if (o.holdH5 && m === "POST" && /priceDetails$/.test(p)) { await new Promise((r) => { if (req.signal.aborted) r(); else req.signal.addEventListener("abort", r, { once: true }); }); x.heldAborted = req.signal.aborted; }
    if (m === "GET" && /^\/v1\/listings\/\d+$/.test(p)) return wrap(await w.pricing.get(p.slice(3)));
    if (m === "GET" && /^\/v1\/listings\/\d+\/calendar$/.test(p)) return wrap(await w.pricing.get(p.slice(3), { query: q }));
    if (m === "POST" && /^\/v1\/listings\/\d+\/calendar\/priceDetails$/.test(p)) return wrap(await w.pricing.post(p.slice(3), body));
    if (m === "GET" && p === "/v1/reservations") {
      const query = { ...q, listingId: Number(q.listingId), channelId: 2000, limit: 100, includeResources: 1, ...(q.afterId ? { afterId: Number(q.afterId) } : {}) };
      return wrap(await w.exec.R.lookupPage({ method: m, path: p, query }));
    }
    if (m === "GET" && /^\/v1\/reservations\/\d+$/.test(p)) return wrap(await w.exec.R.retrieveReservation({ method: m, path: p, query: {} }));
    if (m === "POST" && p === "/v1/reservations") return wrap(await w.exec.R.createReservation({ method: m, path: p, query: {}, body }));   // LOGGED write (must never occur)
    x.violations.push(`unmapped ${m} ${p}`); return reply(400, { status: "fail" });
  };
  x.stripe = async (req) => {
    const u = new URL(req.url); const p = u.pathname; const m = req.method;
    if (u.origin !== "https://api.stripe.com" || req.headers.Authorization !== `Bearer ${SKEY}`) { x.violations.push(`${m} ${p}`); return reply(400, { error: {} }); }
    x.log.push({ provider: "stripe", method: m, path: p.replace(/pi_[A-Za-z0-9_]+/, "{pi}"), search: u.search });
    if (m === "GET" && p === "/v1/account") return reply(200, await w.exec.stripe.retrieveAccount());
    const pi = /^\/v1\/payment_intents\/(pi_[A-Za-z0-9_]+)$/.exec(p);
    if (m === "GET" && pi && u.search === "?expand%5B%5D=latest_charge") return reply(200, await w.exec.stripe.retrievePaymentIntent(pi[1]));
    x.violations.push(`unmapped ${m} ${p}`); return reply(400, { error: {} });                 // capture / cancel would be LOGGED above, then refused
  };
  return x;
}
function httpTransports(w, o) {
  const x = httpExchange(w, o); const creds = { hostaway: 0, stripe: 0 };
  const h = createE7HostawaySend({ exchange: x.hostaway, credential: () => { creds.hostaway += 1; return HTOKEN; } });
  const s = createE7StripeTestSend({ exchange: x.stripe, credential: () => { creds.stripe += 1; return SKEY; }, accountId: ACCT, apiVersion: SVERSION });
  assert.deepEqual([h.ok, s.ok], [true, true]);
  return { x, creds, transports: { hostaway: h.transport, stripe: s.transport } };
}
// ===== end of the labelled exchange copy =====

// ===== LABELLED COPY of test/db/e7-run-core-abort-v2.test.mjs:250–317 (timeDriver, FaultPool, FaultClient) =====
function timeDriver(K) {
  const t0 = performance.now(); let offset = 0;
  const now = () => (performance.now() - t0) * K + offset;
  const arm = (ms) => { let h; let res; const promise = new Promise((r) => { res = r; }); h = setTimeout(() => res(), Math.max(0, ms / K)); return { promise, cancel: () => clearTimeout(h) }; };
  return { deps: { monotonic: () => now(), timers: { arm } }, now };
}
const synthErr = () => Object.assign(new Error("synthetic fault"), { code: "XX000" });
let clientSeq = 0;
class FaultPool {
  constructor(pool, name) { this.pool = pool; this.name = name; this.log = []; this.faults = []; this.clients = []; this.connects = 0; }
  addFault(f) { this.faults.push({ seen: 0, used: false, ...f }); }
  match(kind, sql) {
    for (const f of this.faults) {
      if (f.used || (f.kind !== "any" && f.kind !== kind) || (f.sql !== undefined && f.sql !== sql)) continue;
      f.seen += 1; if (f.nth && f.seen !== f.nth) continue;
      f.used = true; return f;
    }
    return null;
  }
  apply(f, real, client) {
    if (f.mode === "reject") return Promise.reject(synthErr());
    if (f.mode === "hang") return new Promise(() => {});
    return (async () => { const r = await real(); await f.fn(client, this); return r; })();
  }
  async connect() {
    this.connects += 1;
    const f = this.match("connect");
    if (f && f.mode === "reject") throw synthErr();
    const c = await this.pool.connect();
    const w = new FaultClient(this, c); this.clients.push(w);
    if (f && f.mode === "late") await sleep(f.ms);
    if (f && f.mode === "inject") w.injectOn = f.event;
    return w;
  }
  sqlLog() { return this.log.map((x) => x.sql); }
  async cleanup() { for (const c of this.clients) if (!c.released) { c.released = true; try { c.c.release(true); } catch { /* gone */ } } }
}
class FaultClient {
  constructor(p, c) { this.p = p; this.c = c; this.id = ++clientSeq; this.events = []; this.released = false; }
  query(sql, params) {
    this.p.log.push({ via: this.id, sql }); this.events.push("query");
    const f = this.p.match("query", sql);
    return f ? this.p.apply(f, () => this.c.query(sql, params), this) : this.c.query(sql, params);
  }
  release(x) { this.events.push(x === true ? "release(true)" : "release()"); if (this.released) return undefined; this.released = true; return this.c.release(x); }
  on(e, h) { this.events.push(`on:${e}`); this.c.on(e, h); if (this.injectOn === e) { this.injectOn = null; this.events.push(`inject:${e}`); h(); } return this; }
  removeListener(e, h) { this.events.push(`off:${e}`); this.c.removeListener(e, h); return this; }
  pid() { return this.c.processID; }
}
async function terminate(fc) {
  const ended = new Promise((r) => { fc.c.once("end", r); });
  await db.owner.query("SELECT pg_terminate_backend($1)", [fc.pid()]);
  await Promise.race([ended, sleep(2000)]);
}
// ===== end of the labelled harness copy =====

// ---------------------------------------------------------------------------------------------------------------------------------
// SYNTHETIC plan / package / bind input for one booking
const BASE_COMMIT = "58a88f691ac88dcb260cdf407a73785cd96949cd";
const u8 = (p) => new Uint8Array(readFileSync(join(ROOT, p)));
const FOUND = RUN_PLAN_CLOSURE.map((path) => ({ path, bytes: u8(path) }));
const EXEC = R.R1_EXECUTOR_CLOSURE.map((path) => ({ path, bytes: u8(path) }));
const ENV = () => ({ schema: "e7-probe-env-snapshot-v1", nodeVersion: "22.22.0", platform: "linux", execArgvCount: 0, uidAvailable: true,
  present: Object.fromEntries(["NODE_OPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "SSLKEYLOGFILE",
    "OPENSSL_CONF", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"].map((k) => [k, false])) });
const iso = (t) => new Date(t).toISOString();
function bindFor(bk, clock, over = () => {}) {
  const plan = { version: "e7-run-plan-v1", kind: "reservation-test-abort-v1", runId: `synthetic-g1-${bk.id.slice(0, 8)}`, createdAt: iso(clock - MIN),
    baseline: { repoCommit: BASE_COMMIT, sourceDigest: sourceDigestV1(FOUND) },
    environment: { stripe: { mode: "test", accountId: ACCT }, hostaway: { accountRef: "acct-test-1", clientSnapshotId: "client-CAR" },
      db: { instanceEnvironment: "test", appRole: "mv_booking_app", reportRole: "mv_booking_report" } },
    listing: { id: LISTING, currency: "USD", refFieldId: REF_FIELD, connection: "disconnected", timeZone: TZ },
    phases: { capture: false, recording: false, testAbortAfterReservation: true }, allowedOps: [...ALLOWED_OPS],
    checkpoints: ["CALENDAR_BASELINE", "CALENDAR_BLOCKED", "CALENDAR_REOPENED"], deadlines: { quoteMaxAgeMinutes: 30, authorizationMaxAgeHours: 24 },
    stayRules: { minLeadDays: 7, maxNights: 7 }, exclusions: JSON.parse(JSON.stringify(HISTORICAL_EXCLUSIONS)),
    binding: { intentId: bk.id, expectedRef: bk.ref, paymentIntentId: bk.piId, stay: { arrival: bk.stay.from, departure: bk.stay.to, guests: bk.stay.guests },
      amountMinor: bk.total, rateBps: bk.price.rateBps, quote: { totalMinor: bk.total, currency: "USD", quotedAt: iso(clock - 10 * MIN) }, authorizedAt: iso(clock - 5 * MIN) } };
  over(plan);
  const planBytes = new TextEncoder().encode(`${canonicalJson(plan)}\n`);
  const built = buildRunPackageV1({ planBytes, sourceEntries: FOUND, envSnapshot: ENV(), planClock: clock });
  assert.ok(built.ok, `package build ${built.code}`);
  return { packageBytes: new TextEncoder().encode(`${canonicalJson(built.package)}\n`), planBytes, foundationSources: FOUND, executorSources: EXEC, envSnapshot: ENV(),
    expected: { packageHash: built.packageHash, executorDigest: R.executorDigestR1(EXEC) } };
}
/** one preflight lane over wrapped real pools + the accepted T transports; `starts()` counts EVERY actual start (connect / statement / exchange) */
function lane(bk, w, { clock = Date.now(), K = 1, over, exchange, blocked } = {}) {
  const T = timeDriver(K);
  const guard = createGuard(validateGuardDeps(T.deps).deps);
  const rep = new FaultPool(reportPool, "report"); const app = new FaultPool(db.app, "app");
  const ht = httpTransports(w, exchange);
  const L = { rep, app, ht, guard, clock, bind: bindFor(bk, clock, over) };
  L.starts = () => rep.connects + app.connects + rep.log.length + app.log.length + ht.x.log.length;
  L.run = (extra = {}) => P.runPreflightR1({ bind: L.bind, pools: { app, report: rep }, transports: ht.transports, guard, blocked: blocked ? () => blocked(L) : () => false,
    clock: () => L.clock, ...extra });
  L.allSql = () => [...rep.sqlLog(), ...app.sqlLog()];
  return L;
}
const BOOKING_TABLES = ["intents", "intent_transitions", "intent_applied_events", "intent_work", "intent_guests", "inventory_claims", "external_operations", "provider_evidence",
  "hostaway_reservation_attempts", "payment_attempts", "payment_ledger", "payment_refunds", "reconciliation_cases", "reconciliation_resolutions", "stripe_webhook_events"];
/** owner-side fingerprint of every booking table (count + ordered row text digest) — proves zero booking mutation */
async function dbFingerprint() {
  const out = {};
  for (const t of BOOKING_TABLES) out[t] = (await db.owner.query(`SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM booking.${t} x`)).rows[0];
  return out;
}
const READ_ONLY_SQL = (s) => /^\s*SELECT\b/.test(s) || s === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" || s === "COMMIT" || s === "ROLLBACK";
const OK_KEYS = ["automaticBudgetMs", "baselineDigest", "code", "counts", "dbUncertainty", "executable", "executorDigest", "marginMs", "ok", "packageHash", "permissions",
  "preflightDigest", "schema", "step", "transportUncertainty"];
const BASE_KEYS = ["automaticBudgetMs", "code", "counts", "dbUncertainty", "executable", "ok", "permissions", "schema", "step", "transportUncertainty"];
function assertVerdictShape(v) {
  assert.equal(v.schema, "e7-run-preflight-r1-verdict"); assert.equal(v.executable, false);
  assert.deepEqual(Object.keys(v.permissions).sort(), ["adopt", "cleanup", "dbRead", "dbWrite", "execute", "providerRead", "providerWrite"]);
  assert.ok(Object.values(v.permissions).every((x) => x === false));
  assert.ok(P.PREFLIGHT_CODES.includes(v.code), v.code);
  const extra = Object.keys(v).filter((k) => !OK_KEYS.includes(k) && k !== "binderCode");
  assert.deepEqual(extra, [], "whitelisted verdict keys only");
  for (const k of BASE_KEYS) assert.ok(k in v, k);
  const s = JSON.stringify(v);
  for (const g of [F.GUEST.firstName, F.GUEST.lastName, F.GUEST.email]) assert.ok(!s.includes(g), "no guest data");
  assert.ok(!s.includes(SKEY) && !s.includes(HTOKEN), "no credential");
  assert.ok(Object.isFrozen(v) && Object.isFrozen(v.counts));
}
let historical = null;
/** labelled historical STAND-INS (exact ledger ids) through the accepted path; Run3's stand-in gets REAL worker-derived ops / attempts / evidence */
async function ensureHistorical() {
  if (historical) return historical;
  const wH = world();
  const run3 = await authorizedBooking(wH, { id: RUN3.intentId, piId: RUN3.paymentIntentId });
  let t = run3.base + 10 * SEC;                                             // the worker's business clock starts just after the stand-in's authorization
  for (let i = 0; i < 24; i++) {
    const r = await runOrchestratorStep(db.app, { workerId: "w-hist", env: ENV_R, adapterConfig: { allowedListingIds: [LISTING], refFieldId: REF_FIELD, channelId: 2000, currency: "USD" },
      listings: new Map([[LISTING, { currency: "USD" }]]), executors: wH.exec.R, clock: () => t, intentId: RUN3.intentId });
    t += 30 * SEC; void r;
    if ((await loadIntent(db.app, RUN3.intentId)).status === "reservation_confirmed") break;
  }
  const reached = await loadIntent(db.app, RUN3.intentId);                // whatever state the REAL worker reached; only its rows matter here
  await createIntentRecord(db.app, { id: RUN1.intentId, ref: F.nextRef(), accessTokenHash: F.tokenHash(), environment: "test", now: Date.now(), listingId: LISTING,
    from: "2027-09-01", to: "2027-09-03", guests: 2 });
  const counts = async () => (await db.owner.query(`SELECT (SELECT count(*) FROM booking.external_operations WHERE intent_id = $1)::int AS ops,
    (SELECT count(*) FROM booking.provider_evidence WHERE intent_id = $1)::int AS ev, (SELECT count(*) FROM booking.hostaway_reservation_attempts WHERE intent_id = $1)::int AS att`, [RUN3.intentId])).rows[0];
  historical = { run3, counts, state: reached.status, reason: reached.reasonCode ?? null };   // memoized BEFORE asserting (no cascade on failure)
  const c = await counts();
  assert.ok(c.ops >= 1 && c.ev >= 1 && c.att >= 1, `stand-in has real worker rows ${JSON.stringify({ ...c, state: historical.state, reason: historical.reason })}`);
  return historical;
}

// =================================================================================================================================
test("P0 copied constants / SQL: exact parity with the accepted origins (imported HERE in the test only) + origin pins", () => {
  for (const [p, h] of Object.entries(P.COPIED_ORIGINS)) assert.equal(createHash("sha256").update(readFileSync(join(ROOT, p))).digest("hex"), h, p);
  assert.equal(P.SQL_SAME_DB, CORE_SQL.SAME_DB);
  assert.equal(P.SQL_BEGIN, FACTS_SQL.BEGIN); assert.equal(P.SQL_COMMIT, FACTS_SQL.COMMIT);
  assert.ok(readFileSync(join(ROOT, "lib/booking-db/recovery.js"), "utf8").includes(P.SQL_PAYMENT_ATTEMPT));
  assert.equal(P.P0_BUDGET_MS, CORE_P0);
  assert.deepEqual({ ...P.PHASE_BUDGET_MS }, { reservation: CORE_PHASES.reservation.budgetMs, cleanup: CORE_PHASES.cleanup.budgetMs });
  assert.deepEqual({ ...P.BRIDGE_LIMITS_COPY }, { ...BRIDGE_LIMITS });
  assert.deepEqual({ ...P.PROVIDER_TIMEOUTS_COPY }, { pricingCallMs: DEFAULT_TIMEOUTS.pricingCallMs, readCallMs: DEFAULT_TIMEOUTS.readCallMs });
  // checkSameDatabase copy behaves exactly like the accepted one on every branch
  const rep = { environment: "test", is_report: true, is_app: false, privileged: false, created_at: "c", db: "d", started: "s", port: 5432 };
  const app = { ...rep, is_report: false, is_app: true };
  const cases = [[[rep], [app]], [[], [app]], [[{ ...rep, environment: "dev" }], [app]], [[{ ...rep, is_app: true }], [app]], [[rep], []], [[rep], [{ ...app, environment: "x" }]],
    [[rep], [{ ...app, privileged: true }]], [[rep], [{ ...app, db: "other" }]], [[rep], [{ ...app, port: 1 }]], [[{ ...rep, port: null }], [{ ...app, port: null }]], [null, null]];
  for (const [a, b] of cases) assert.deepEqual({ ...P.checkSameDatabase(a, b) }, { ...coreCheckSameDatabase(a, b) }, JSON.stringify([a, b]));
  // the automatic budget is EXACTLY the documented sum of accepted bounds (no new number) and is not a completion claim
  const L = LIMITS;
  assert.equal(P.AUTOMATIC_WORK_BUDGET_MS, CORE_P0 + L.JOURNAL_MS + CORE_PHASES.reservation.budgetMs + L.CONNECT_MS + L.SNAPSHOT_MS + 3 * BRIDGE_LIMITS.journalMs
    + BRIDGE_LIMITS.abortMs + BRIDGE_LIMITS.postcheckMs + L.JOURNAL_MS + CORE_PHASES.cleanup.budgetMs + L.CONNECT_MS + 2 * L.STATEMENT_MS + 4 * L.JOURNAL_MS);
  assert.deepEqual([...P.AUTOMATIC_BUDGET_OMITS], ["ownerAttestationWaits", "fsyncBeyondObservationBounds", "lateServerOrProviderTails", "finalizeQuiescence", "processScheduling"]);
});

test("D1 valid real-path booking → PREFLIGHT_OK; exact start counts; zero booking mutation; reads only; deterministic digest; executable false", async () => {
  await ensureHistorical();
  const w = world(); const bk = await authorizedBooking(w);
  const clock = Date.now();
  const before = await dbFingerprint();
  const L = lane(bk, w, { clock });
  const v = await L.run();
  assert.equal(v.code, "PREFLIGHT_OK", JSON.stringify(v)); assert.equal(v.ok, true); assert.equal(v.step, "DONE");
  assertVerdictShape(v);
  assert.deepEqual(Object.keys(v).sort(), OK_KEYS);
  assert.equal(v.dbUncertainty, "none"); assert.equal(v.transportUncertainty, "none");
  // every actual start counted at the pools / exchange matches the verdict's own counts
  assert.equal(v.counts.connects, L.rep.connects + L.app.connects); assert.equal(v.counts.statements, L.rep.log.length + L.app.log.length);
  assert.equal(v.counts.exchanges, L.ht.x.log.length);
  assert.deepEqual({ ...v.counts }, { connects: 2, statements: 2 + 10 + 1 + 1 + 1 + 1 + P.BASELINE_FAMILIES.length + 1, exchanges: 6 });
  assert.ok(L.allSql().every(READ_ONLY_SQL), "read-only SQL + read-only transaction control only");
  assert.deepEqual(L.ht.x.log.map((e) => `${e.provider} ${e.method} ${e.path}`), ["stripe GET /v1/account", "stripe GET /v1/payment_intents/{pi}",
    `hostaway GET /v1/listings/${LISTING}`, `hostaway GET /v1/listings/${LISTING}/calendar`, `hostaway POST /v1/listings/${LISTING}/calendar/priceDetails`, "hostaway GET /v1/reservations"]);
  assert.deepEqual(L.ht.x.violations, []);
  assert.ok(!L.ht.x.log.some((e) => e.method === "PUT" || (e.method === "POST" && !/priceDetails$/.test(e.path))), "no provider write (H5 is the accepted read-calculation POST)");
  assert.equal(w.calls.filter((c) => c === "createReservation").length, 0);
  assert.deepEqual(await dbFingerprint(), before, "zero booking-table mutation");
  for (const c of [...L.rep.clients, ...L.app.clients]) assert.deepEqual(c.events.filter((e) => e.startsWith("release")), ["release()"], "healthy clients released once, for reuse");
  // determinism: identical facts and time → identical digests
  const L2 = lane(bk, w, { clock }); const v2 = await L2.run();
  assert.equal(v2.code, "PREFLIGHT_OK"); assert.equal(v2.preflightDigest, v.preflightDigest); assert.equal(v2.baselineDigest, v.baselineDigest);
  // a different verdict clock changes the digest (time is bound)
  const L3 = lane(bk, w, { clock: clock + 1 }); const v3 = await L3.run();
  assert.equal(v3.code, "PREFLIGHT_OK"); assert.notEqual(v3.preflightDigest, v.preflightDigest); assert.equal(v3.baselineDigest, v.baselineDigest);
});

test("D2 L failures refuse and stop later steps (L1 roles, L2 identity/eligibility, L4 account/PI proof, L5 margin −1/0/+1, L6 calendar/quote/lookup/protected)", async () => {
  await ensureHistorical();
  // L1: the report pool is an app login → ROLE_NOT_REPORT before any facts read
  { const w = world(); const bk = await authorizedBooking(w); const L = lane(bk, w);
    const appAsReport = new FaultPool(db.app, "report-as-app");
    const v = await L.run({ pools: { app: L.app, report: appAsReport } });
    assert.equal(v.code, "ROLE_NOT_REPORT"); assertVerdictShape(v); assert.equal(L.ht.x.log.length, 0); assert.equal(appAsReport.log.length + L.app.log.length, 2); }
  // L2: identity mismatch (a plan for a different guest count) → no provider exchange
  { const w = world(); const bk = await authorizedBooking(w); const L = lane(bk, w, { over: (p) => { p.binding.stay.guests = 3; } });
    const v = await L.run(); assert.equal(v.code, "INTENT_IDENTITY_MISMATCH"); assert.equal(v.step, "L2"); assert.equal(L.ht.x.log.length, 0); }
  // L4: account mismatch → the PI is never fetched, no Hostaway exchange
  { const w = world(); const bk = await authorizedBooking(w); w.accountId = "acct_1OtherAccount0"; const L = lane(bk, w);
    const v = await L.run(); assert.ok(["ACCOUNT_MISMATCH", "PROVIDER_FAILURE"].includes(v.code), v.code); assert.equal(v.step, "L4");
    assert.deepEqual(L.ht.x.log.map((e) => e.path), ["/v1/account"]); }
  // L4: PI proof failures (status / captureBefore / metadata attempt) → no Hostaway exchange
  for (const mut of [(p) => { p.status = "canceled"; }, (p) => { p.captureBeforeSec += 60; }, (p) => { p.attemptId = "00000000-0000-4000-8000-00000000dead"; }]) {
    const w = world(); const bk = await authorizedBooking(w); mut(w.pis.get(bk.piId)); const L = lane(bk, w);
    const v = await L.run(); assert.equal(v.code, "PAYMENT_INTENT_PROOF_FAILED"); assert.equal(L.ht.x.log.filter((e) => e.provider === "hostaway").length, 0);
  }
  // L5: strict margin at the verdict clock: deadline − clock = budget → refused; budget + 1 → ok; budget − 1 → refused
  for (const [d, want] of [[-1, "AUTHORIZATION_MARGIN_INSUFFICIENT"], [0, "AUTHORIZATION_MARGIN_INSUFFICIENT"], [1, "PREFLIGHT_OK"]]) {
    const w = world(); const bk = await authorizedBooking(w); const clock = Date.now();
    await F.ownerManagedHistory(db.owner, "UPDATE booking.intents SET authorization_deadline = to_timestamp($2::double precision / 1000) WHERE id = $1",
      [bk.id, clock + P.AUTOMATIC_WORK_BUDGET_MS + d]);
    const L = lane(bk, w, { clock }); const v = await L.run();
    assert.equal(v.code, want, `margin ${d}`); assertVerdictShape(v);
    if (want !== "PREFLIGHT_OK") assert.equal(v.marginMs, P.AUTOMATIC_WORK_BUDGET_MS + d); else assert.equal(v.marginMs, P.AUTOMATIC_WORK_BUDGET_MS + 1);
  }
  // L6: calendar blocked / listing currency / quote changed → pricing refused, NO lookup exchange
  for (const [mut, want] of [[(w) => { w.calendar = "booked"; }, "NOT_BOOKABLE_OR_PRICE_REFUSED"], [(w) => { w.listingCurrency = "MXN"; }, null], [(w) => { w.nightly = 251; }, "QUOTE_CHANGED"]]) {
    const w = world(); const bk = await authorizedBooking(w); mut(w); const L = lane(bk, w);
    const v = await L.run(); if (want) assert.equal(v.code, want); else assert.ok(["NOT_BOOKABLE_OR_PRICE_REFUSED", "PRICING_PROOF_INCOMPLETE"].includes(v.code), v.code);
    assert.equal(L.ht.x.log.filter((e) => e.path === "/v1/reservations").length, 0, "no lookup after a pricing refusal");
  }
  // L6: ref lookup not empty / protected id in a reply (later reads stop)
  { const w = world(); const bk = await authorizedBooking(w); const L = lane(bk, w);
    w.res.set(1, { id: 1, listingMapId: LISTING, arrivalDate: bk.stay.from, departureDate: bk.stay.to, totalPrice: 1, currency: "USD", status: "new", ref: "MV-OTHER1" });
    const v = await L.run(); assert.equal(v.code, "REF_LOOKUP_NOT_EMPTY"); }
  { const w = world(); const bk = await authorizedBooking(w); const L = lane(bk, w);
    w.lookupExtra.push({ id: 70636076, listingMapId: LISTING, channelId: 2000, arrivalDate: bk.stay.from, departureDate: bk.stay.to, status: "new" });
    const v = await L.run(); assert.ok(["PROTECTED_REFERENCE", "PROVIDER_FAILURE"].includes(v.code), v.code); assertVerdictShape(v);   // the module's scan or the accepted transport's own protected-id refusal
    assert.equal(L.ht.x.log.filter((e) => e.path === "/v1/reservations").length, 1, "the lookup was the last exchange"); }
});

test("D3 stop-before-start at EVERY actual start (connect / nested statement / exchange): blocked at k ⇒ exactly k starts, STOPPED, no booking mutation", async () => {
  await ensureHistorical();
  const w = world(); const bk = await authorizedBooking(w); const clock = Date.now();
  const full = lane(bk, w, { clock }); const v0 = await full.run(); assert.equal(v0.code, "PREFLIGHT_OK");
  const N = full.starts(); assert.equal(N, v0.counts.connects + v0.counts.statements + v0.counts.exchanges);
  const before = await dbFingerprint();
  for (let k = 0; k <= N; k++) {
    const L = lane(bk, w, { clock, blocked: (l) => l.starts() >= k });
    const v = await L.run();
    assert.equal(v.code, "STOPPED", `k=${k}: ${v.code}`); assert.equal(L.starts(), k, `k=${k}: exactly k actual starts`);
    assertVerdictShape(v); assert.equal(v.ok, false);
    // a client stopped mid-transaction is DESTROYED (never released for reuse); all others are released once
    for (const c of [...L.rep.clients, ...L.app.clients]) {
      const rel = c.events.filter((e) => e.startsWith("release"));
      assert.equal(rel.length, 1, `k=${k}: each client disposed exactly once`);
      const inTx = (() => { let open = false; for (const x of L.rep.log.concat(L.app.log).filter((y) => y.via === c.id)) { if (x.sql.startsWith("BEGIN")) open = true; if (x.sql === "COMMIT") open = false; } return open; })();
      if (inTx) assert.equal(rel[0], "release(true)", `k=${k}: mid-transaction client destroyed`);
    }
    assert.ok(L.allSql().every(READ_ONLY_SQL));
  }
  assert.deepEqual(await dbFingerprint(), before);
});

test("D4 ownership: connect timeout (late client destroyed, never queried), statement timeout (destroyed, may still run), client loss, provider timeout (aborted in flight)", async () => {
  await ensureHistorical();
  const K = 20;                                                            // scaled guard time: 5 s bounds → 250 ms real
  // late connect: the lifecycle times out (CONNECT_MS / K real) and destroys the late client once it arrives; it is never queried
  { const w = world(); const bk = await authorizedBooking(w); const L = lane(bk, w, { K });
    L.rep.addFault({ kind: "connect", mode: "late", ms: 800 });
    const v = await L.run(); assert.equal(v.code, "TIMEOUT_DB_CONNECT"); assert.equal(v.dbUncertainty, "destroyed_client"); assertVerdictShape(v);
    await sleep(1200);
    const c = L.rep.clients[0]; assert.deepEqual(c.events.filter((e) => e === "query"), []); assert.ok(c.events.includes("release(true)"), "late client destroyed");
    assert.equal(L.app.connects, 0); assert.equal(L.ht.x.log.length, 0); }
  // statement hang on the app SAME_DB: destroyed (never released), statement may still run; nothing after it
  { const w = world(); const bk = await authorizedBooking(w); const L = lane(bk, w, { K });
    L.app.addFault({ kind: "query", sql: P.SQL_SAME_DB, mode: "hang" });
    const v = await L.run(); assert.equal(v.code, "TIMEOUT_DB_READ"); assert.equal(v.dbUncertainty, "statement_may_still_run"); assertVerdictShape(v);
    assert.deepEqual(L.app.clients[0].events.filter((e) => e.startsWith("release")), ["release(true)"]);
    assert.deepEqual(L.rep.clients[0].events.filter((e) => e.startsWith("release")), ["release()"]);
    assert.equal(L.rep.log.length + L.app.log.length, 2); assert.equal(L.ht.x.log.length, 0); }
  // client lost at handoff (synthetic 'error' on subscribe) → CLIENT_LOST, destroyed once, never queried
  { const w = world(); const bk = await authorizedBooking(w); const L = lane(bk, w, { K });
    L.rep.addFault({ kind: "connect", mode: "inject", event: "error" });
    const v = await L.run(); assert.equal(v.code, "CLIENT_LOST"); assertVerdictShape(v);
    assert.deepEqual(L.rep.clients[0].events.filter((e) => e === "query"), []); assert.equal(L.rep.clients[0].events.filter((e) => e === "release(true)").length, 1); }
  // backend terminated mid-snapshot (after the MARKER statement) → refused, the client destroyed, no later statement / exchange
  { const w = world(); const bk = await authorizedBooking(w); const L = lane(bk, w, { K: 1 });
    L.rep.addFault({ kind: "query", sql: FACTS_SQL.MARKER, mode: "after", fn: async (c) => { await terminate(c); } });
    const v = await L.run(); assert.ok(["CLIENT_LOST", "DB_FAILURE"].includes(v.code), v.code); assertVerdictShape(v);
    assert.ok(L.rep.clients[0].events.includes("release(true)")); assert.equal(L.ht.x.log.length, 0);
    const markerAt = L.rep.sqlLog().indexOf(FACTS_SQL.MARKER); assert.ok(L.rep.sqlLog().length <= markerAt + 2, "at most the one statement already in flight after the loss"); }
  // provider timeout: H5 held until the preflight's own signal aborts → TIMEOUT_PROVIDER, aborted in flight, no H1
  { const w = world(); const bk = await authorizedBooking(w); const L = lane(bk, w, { K, exchange: { holdH5: true } });
    const v = await L.run(); assert.equal(v.code, "TIMEOUT_PROVIDER"); assert.equal(v.transportUncertainty, "aborted_in_flight"); assertVerdictShape(v);
    await sleep(50); assert.equal(L.ht.x.heldAborted, true); assert.equal(L.ht.x.log.filter((e) => e.path === "/v1/reservations").length, 0); }
});

/** LABELLED STAND-IN for the FOURTH, non-run exclusion (exact ledger id; actor not established): priced-only through the accepted path
 *  (CREATED → PRICE_CONFIRMED, no session / PI / claim). It is a disposable-DB stand-in, never the shared row. */
const UNATTRIBUTED = HISTORICAL_EXCLUSIONS.unattributedIntents[0];
let unattributedMade = false;
async function ensureUnattributedStandIn(listingId, from, to) {
  if (unattributedMade) return UNATTRIBUTED.intentId;
  const now = Date.now() - 2 * DAY;
  await createIntentRecord(db.app, { id: UNATTRIBUTED.intentId, ref: F.nextRef(), accessTokenHash: F.tokenHash(), environment: "test", now, listingId, from, to, guests: 2 });
  F.ok(await applyEvent(db.app, UNATTRIBUTED.intentId, { type: "PRICE_CONFIRMED", price: F.priceFor({ listingId, from, to, guests: 2, currency: "USD" }) }, { now, actor: "guest" }), "stand-in price");
  unattributedMade = true;
  return UNATTRIBUTED.intentId;
}

test("D5 exclusion baseline: existing-row changes with EQUAL counts detected; append / delete; explicit ABSENT; protected ref in the run intent; cap", async () => {
  const H = await ensureHistorical();
  const w = world(); const bk = await authorizedBooking(w); const clock = Date.now();
  const digest = async () => { const v = await lane(bk, w, { clock }).run(); assert.equal(v.code, "PREFLIGHT_OK", v.code); return v.baselineDigest; };
  const d0 = await digest(); assert.equal(await digest(), d0, "deterministic");
  const c0 = await H.counts();
  const mutate = async (sql) => { await F.ownerManagedHistory(db.owner, sql, [RUN3.intentId]); };
  // existing OPERATION row content (one column) — counts unchanged
  await mutate("UPDATE booking.external_operations SET error_code = 'SYNTHETIC_OUT_OF_BAND' WHERE id = (SELECT id FROM booking.external_operations WHERE intent_id = $1 ORDER BY id LIMIT 1)");
  const d1 = await digest(); assert.notEqual(d1, d0, "operation row change detected"); assert.deepEqual(await H.counts(), c0);
  // existing EVIDENCE row content
  await mutate("UPDATE booking.provider_evidence SET observed = observed || '{\"syntheticOutOfBand\": true}'::jsonb WHERE id = (SELECT id FROM booking.provider_evidence WHERE intent_id = $1 ORDER BY id LIMIT 1)");
  const d2 = await digest(); assert.notEqual(d2, d1, "evidence row change detected"); assert.deepEqual(await H.counts(), c0);
  // existing ATTEMPT row content
  await mutate("UPDATE booking.hostaway_reservation_attempts SET lookup_count = lookup_count + 1 WHERE intent_id = $1");
  const d3 = await digest(); assert.notEqual(d3, d2, "attempt row change detected"); assert.deepEqual(await H.counts(), c0);
  // existing TRANSITION row content (append-only table, out-of-band)
  await mutate("UPDATE booking.intent_transitions SET reason_code = 'SYNTHETIC_X' WHERE id = (SELECT id FROM booking.intent_transitions WHERE intent_id = $1 ORDER BY id LIMIT 1)");
  const d4 = await digest(); assert.notEqual(d4, d3, "transition row change detected");
  // APPEND then DELETE of a case row for the Run1 stand-in: the digest changes, then returns to the previous value
  const caseId = "00000000-0000-4000-8000-00000000c0de";
  await F.ownerManagedHistory(db.owner, "INSERT INTO booking.reconciliation_cases (id, intent_id, kind, status, opened_at, opened_by, evidence) VALUES ($1, $2, 'SYNTHETIC_CASE', 'open', now(), 'test', '{}'::jsonb)",
    [caseId, RUN1.intentId]);
  const d5 = await digest(); assert.notEqual(d5, d4, "append detected");
  await F.ownerManagedHistory(db.owner, "DELETE FROM booking.reconciliation_cases WHERE id = $1", [caseId]);
  assert.equal(await digest(), d4, "delete detected (back to the previous state)");
  // explicit ABSENT / PRESENT (direct read through a test-side runner in ONE RR READ ONLY transaction on the report login)
  const c = await reportPool.connect();
  try {
    await c.query(P.SQL_BEGIN);
    const r = await P.readExclusionBaselineR1({ statement: async (sql, p) => ({ ok: true, rows: (await c.query(sql, p)).rows }), ids: P.exclusionIdentifiers(HISTORICAL_EXCLUSIONS), currentIntentId: bk.id });
    await c.query(P.SQL_COMMIT);
    assert.equal(r.ok, true);
    assert.deepEqual(r.baseline.identifiers.intents.map((x) => [x.id, x.presence]), [[RUN1.intentId, "PRESENT"], [RUN2.intentId, "ABSENT"], [RUN3.intentId, "PRESENT"],
      [UNATTRIBUTED.intentId, "ABSENT"]]);                                                     // the fourth (non-run) identity is covered: explicit ABSENT here
    assert.deepEqual([...r.baseline.identifiers.paymentIntentIds], [RUN3.paymentIntentId, PATH_A_PI]);
    assert.deepEqual([...r.baseline.identifiers.reservationIds], ["70636076", "71045356", "71072615", "71081885"]);
    const fams = new Set(r.baseline.rows.map((x) => x.family));
    for (const f of ["intents", "external_operations", "provider_evidence", "hostaway_reservation_attempts", "payment_attempts", "intent_transitions"]) assert.ok(fams.has(f), f);
    const s = JSON.stringify(r.baseline);
    for (const g of [F.GUEST.firstName, F.GUEST.email]) assert.ok(!s.includes(g), "no guest data");
    assert.ok(r.baseline.rows.every((x) => Object.keys(x).sort().join() === "family,fingerprint,intentId,key"), "identity + fingerprint only; content never returned");
  } finally { c.release(); }
  // a protected / historical reference inside the RUN intent's own rows → refused at L3
  { const w2 = world(); const bk2 = await authorizedBooking(w2);
    await F.ownerManagedHistory(db.owner, `INSERT INTO booking.stripe_webhook_events (event_id, event_type, livemode, api_version, stripe_created_at, object_id, intent_id, received_at, status, attempts)
      VALUES ('evt_synthetic_g1', 'payment_intent.succeeded', false, '2099-01-01', now(), $1, $2, now(), 'processed', 1)`, [PATH_A_PI, bk2.id]);
    const v = await lane(bk2, w2).run(); assert.equal(v.code, "PROTECTED_REFERENCE_IN_RUN_INTENT"); assert.equal(v.step, "L3"); assertVerdictShape(v);
    assert.equal((await lane(bk2, w2).run()).counts.exchanges, 0, "no provider exchange after the L3 refusal"); }
  // cap: > BASELINE_CAP rows in one family → fail closed
  await F.ownerManagedHistory(db.owner, `INSERT INTO booking.intent_transitions (intent_id, version_after, from_state, to_state, event_type, actor, at, recorded_at)
    SELECT $1, 1000 + g, 'created', 'created', 'SYNTHETIC', 'guest', now(), now() FROM generate_series(1, ${P.BASELINE_CAP + 1}) g`, [RUN1.intentId]);
  const vc = await lane(bk, w, { clock }).run(); assert.equal(vc.code, "BASELINE_LIMIT_EXCEEDED"); assertVerdictShape(vc);
  await F.ownerManagedHistory(db.owner, "DELETE FROM booking.intent_transitions WHERE intent_id = $1 AND version_after > 1000", [RUN1.intentId]);
});

test("D5b fourth (unattributed, non-run) intent: covered by the baseline — appearance, unchanged equality, equal-count content changes; PRESENT identity; never a run", async () => {
  await ensureHistorical();
  const w = world(); const bk = await authorizedBooking(w); const clock = Date.now();
  const digest = async () => { const v = await lane(bk, w, { clock }).run(); assert.equal(v.code, "PREFLIGHT_OK", v.code); return v.baselineDigest; };
  const a0 = await digest();
  await ensureUnattributedStandIn(LISTING, "2027-10-01", "2027-10-05");
  const d0 = await digest(); assert.notEqual(d0, a0, "the fourth intent's appearance changes the baseline");
  assert.equal(await digest(), d0, "an UNCHANGED fourth intent preserves equality");
  const n = async () => (await db.owner.query(`SELECT (SELECT count(*) FROM booking.intent_transitions WHERE intent_id = $1)::int AS tr,
    (SELECT count(*) FROM booking.intent_applied_events WHERE intent_id = $1)::int AS ap, (SELECT count(*) FROM booking.intent_work WHERE intent_id = $1)::int AS wk`, [UNATTRIBUTED.intentId])).rows[0];
  const c0 = await n(); assert.ok(c0.tr >= 2 && c0.wk === 1, JSON.stringify(c0));      // the accepted guest PRICE_CONFIRMED path writes no applied-event row
  await F.ownerManagedHistory(db.owner, "UPDATE booking.intent_transitions SET reason_code = 'SYNTHETIC_U' WHERE id = (SELECT id FROM booking.intent_transitions WHERE intent_id = $1 ORDER BY id LIMIT 1)", [UNATTRIBUTED.intentId]);
  const d1 = await digest(); assert.notEqual(d1, d0, "transition content change at equal counts detected"); assert.deepEqual(await n(), c0);
  await F.ownerManagedHistory(db.owner, "UPDATE booking.intent_work SET next_action_at = next_action_at + interval '1 second' WHERE intent_id = $1", [UNATTRIBUTED.intentId]);
  const d2 = await digest(); assert.notEqual(d2, d1, "work row content change detected"); assert.deepEqual(await n(), c0);
  await F.ownerManagedHistory(db.owner, "UPDATE booking.intents SET updated_at = updated_at + interval '1 second' WHERE id = $1", [UNATTRIBUTED.intentId]);
  const d3 = await digest(); assert.notEqual(d3, d2, "intent row content change detected");
  const c = await reportPool.connect();
  try {
    await c.query(P.SQL_BEGIN);
    const r = await P.readExclusionBaselineR1({ statement: async (sql, p) => ({ ok: true, rows: (await c.query(sql, p)).rows }), ids: P.exclusionIdentifiers(HISTORICAL_EXCLUSIONS), currentIntentId: bk.id });
    await c.query(P.SQL_COMMIT);
    assert.equal(r.ok, true);
    assert.deepEqual(r.baseline.identifiers.intents.at(-1), { id: UNATTRIBUTED.intentId, presence: "PRESENT" });
    assert.deepEqual([...r.baseline.identifiers.paymentIntentIds], [RUN3.paymentIntentId, PATH_A_PI], "no PI inferred for the non-run record");
    assert.deepEqual([...r.baseline.identifiers.reservationIds], ["70636076", "71045356", "71072615", "71081885"], "no reservation inferred");
    const fams = new Set(r.baseline.rows.filter((x) => x.intentId === UNATTRIBUTED.intentId).map((x) => x.family));
    for (const f of ["intents", "intent_transitions", "intent_work"]) assert.ok(fams.has(f), f);
  } finally { c.release(); }
  assert.ok(!HISTORICAL_EXCLUSIONS.runs.some((x) => x.intentId === UNATTRIBUTED.intentId) && UNATTRIBUTED.label !== "run4");
  assert.equal((await loadIntent(db.app, UNATTRIBUTED.intentId)).status, "price_confirmed", "stand-in never advanced / adopted");
});

test("D6 hostile / malformed preflight input → INPUT_INVALID with ZERO starts and zero getter calls; caller mutation after the call is irrelevant", async () => {
  await ensureHistorical();
  const w = world(); const bk = await authorizedBooking(w); const clock = Date.now();
  let ran = 0;
  const base = lane(bk, w, { clock });
  const cases = {
    proxy: (i) => new Proxy(i, {}), getter: (i) => Object.defineProperty(i, "clock", { get() { ran++; return () => clock; }, enumerable: true }),
    protoKey: (i) => Object.defineProperty(i, "__proto__", { value: null, enumerable: true, writable: true, configurable: true }), extra: (i) => { i.more = 1; },
    fakeGuard: (i) => { i.guard = { observe: async () => ({}), now: () => ({ ok: true, value: 0 }) }; }, badClock: (i) => { i.clock = () => 1.5; },
    bindWithExecClock: (i) => { i.bind = { ...base.bind, execClock: clock }; }, proxyPool: (i) => { i.pools = { app: new Proxy(base.app, {}), report: base.rep }; },
    badBind: (i) => { i.bind = { ...base.bind, expected: { ...base.bind.expected, packageHash: "0".repeat(64) } }; }
  };
  for (const [k, patch] of Object.entries(cases)) {
    const L = lane(bk, w, { clock }); let inp = { bind: L.bind, pools: { app: L.app, report: L.rep }, transports: L.ht.transports, guard: L.guard, blocked: () => false, clock: () => clock };
    const r = patch(inp); if (r !== undefined) inp = r;
    const v = await P.runPreflightR1(inp);
    assert.ok(["INPUT_INVALID", "CLOCK_INVALID"].includes(v.code), `${k}: ${v.code}`); assert.equal(L.starts(), 0, `${k}: zero starts`); assertVerdictShape(v);
  }
  assert.equal(ran, 0, "no getter executed");
  // mutation of the caller's bytes / objects while the preflight is in flight does not change the verdict (bound synchronously, before any await)
  const L = lane(bk, w, { clock });
  const want = L.bind.expected.packageHash;
  const pending = L.run();
  L.bind.packageBytes.fill(0); L.bind.planBytes.fill(0); L.bind.expected.packageHash = "f".repeat(64);
  const v = await pending; assert.equal(v.code, "PREFLIGHT_OK"); assert.equal(v.packageHash, want);
  // never rejects
  assert.equal((await P.runPreflightR1(undefined)).code, "INPUT_INVALID");
});
