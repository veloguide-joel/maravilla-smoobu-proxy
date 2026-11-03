// Stage E7.2 — offline reservation worker on a throwaway local PostgreSQL with FAKE Hostaway executors (no network,
// no SDK, no credentials). Runtime code runs as mv_booking_app. The clock is a test-controlled function: no real sleeps.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent, createIntentRecord, collectGuestDetails, beginPayStep, recordCheckoutSession } from "../../lib/booking-db/repo.js";
import { claimNextOperation, completeOperation, recoverExpiredOperations, requestRead } from "../../lib/booking-db/operations.js";
import { reissueOrphanRead } from "../../lib/booking-db/recovery.js";
import { runOrchestratorStep, reservationWorkerGate, LIMITS, PROTECTED_HOSTAWAY_RESERVATION_IDS, isProtectedReservationId, DEFAULT_TIMEOUTS, _internal } from "../../lib/booking-db/reservation-worker.js";
import { priceStay } from "../../lib/checkout/server-pricer.js";
import { readDirectPolicyFromEnv } from "../../lib/direct-policy.js";
import { todayInTimeZone } from "../../lib/public-api.js";
import { validateAdapterConfig } from "../../lib/hostaway-reservations.js";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });

const ENV = Object.freeze({ VERCEL_ENV: "development", MV_E7_RESERVATION_WORKER: "enabled" });
const REF_FIELD = 777001;
const L = (n) => 860000 + n;
const MIN = F.MIN;
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const STAY = { from: "2026-12-20", to: "2026-12-24", guests: 2 };

// ---------- fake Hostaway world (pricing reads, reservation reads, create) ----------
// Provider reservation ids are unique per world: each world gets its own disjoint block of 1000 ids (deterministic). A random
// base (one of 1000 buckets of 100 ids, drawn per world) let two worlds in this file mint the SAME Hostaway id, which the UNIQUE
// hostaway_reservation_id columns then refused (see claude/e7-db-suite-reliability.md).
let nextWorldIdBlock = 700000;
function world({ currency = "MXN", blocked = new Set(), nightly = 1600 } = {}) {
  const w = { calls: [], reservations: [], nextId: (nextWorldIdBlock += 1000), createMode: "ok", lookupMode: "ok", retrieveMode: "ok",
    pricingMode: "ok", onCreate: null, onPricing: null, nightly, currency, signals: [] };
  const hang = (signal) => { w.signals.push(signal); return new Promise(() => {}); };
  const days = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push({ date: d, status: blocked.has(d) ? "booked" : "available", isAvailable: blocked.has(d) ? 0 : 1, minimumStay: 1, maximumStay: 90, closedOnArrival: 0, closedOnDeparture: 0 }); return out; };
  const full = (r) => ({ id: r.id, listingMapId: r.listingMapId, channelId: 2000, arrivalDate: r.arrivalDate, departureDate: r.departureDate, totalPrice: r.totalPrice,
    currency: r.currency, status: r.status, customFieldValues: [{ customFieldId: REF_FIELD, value: r.ref }] });
  w.pricing = {
    get: async (path, opts = {}) => {
      w.calls.push(`GET ${path}`);
      if (w.pricingMode === "hang") return hang(opts.signal);
      if (w.onPricing) await w.onPricing();
      if (w.pricingMode === "down") return { status: 503, json: null };
      const m = /^\/listings\/(\d+)(\/calendar)?$/.exec(path); const id = Number(m[1]);
      if (!m[2]) return { status: 200, json: { result: { id, currencyCode: w.currency, personCapacity: 4, minNights: 1, maxNights: 90 } } };
      return { status: 200, json: { result: days(opts.query.startDate, opts.query.endDate) } };
    },
    post: async (path, body) => {
      w.calls.push(`POST ${path}`);
      const nights = Math.round((Date.parse(body.endingDate) - Date.parse(body.startingDate)) / 86400000);
      const comps = [{ id: 1, type: "accommodation", name: "baseRate", title: "Base rate", quantity: 1, value: w.nightly, total: w.nightly * nights, isIncludedInTotalPrice: 1, isMandatory: 1, isOverriddenByUser: 0, isDeleted: 0, units: nights }];
      return { status: 200, json: { status: "success", result: { totalPrice: comps[0].total, components: comps } } };
    }
  };
  w.executors = {
    pricing: w.pricing,
    lookupPage: async (req, o = {}) => {
      w.calls.push(`LOOKUP ${req.query.listingId}${req.query.afterId ? ` after ${req.query.afterId}` : ""}`);
      if (w.lookupMode === "hang") return hang(o.signal);
      if (w.lookupMode === "error") return { httpStatus: 500, json: null };
      if (req.query.afterId) return { httpStatus: 200, json: { status: "success", result: [] } };
      const items = w.reservations.filter((r) => r.listingMapId === req.query.listingId && r.arrivalDate === req.query.arrivalStartDate).map(full);
      if (w.lookupMode === "noCurrency") for (const i of items) delete i.currency;
      return { httpStatus: 200, json: { status: "success", result: items } };
    },
    retrieveReservation: async (req, o = {}) => {
      w.calls.push(`RETRIEVE ${req.path}`);
      if (w.retrieveMode === "hang") return hang(o.signal);
      const id = Number(/\/reservations\/(\d+)$/.exec(req.path)[1]);
      const r = w.reservations.find((x) => x.id === id);
      if (!r) return { httpStatus: 404, json: { status: "fail" } };
      if (w.retrieveMode === "malformed") return { httpStatus: 200, json: { status: "success", result: { id: "x" } } };
      return { httpStatus: 200, json: { status: "success", result: full(r) } };
    },
    createReservation: async (req, o = {}) => {
      w.calls.push(`CREATE ${req.body.customFieldValues[0].value}`);
      w.signals.push(o.signal);
      assert.equal(req.method, "POST"); assert.deepEqual(req.query, {}, "no query (never forceOverbooking)");
      assert.ok(!JSON.stringify(req).toLowerCase().includes("forceoverbooking"));
      if (w.onCreate) await w.onCreate(req);
      const store = () => { const r = { id: w.nextId++, listingMapId: req.body.listingMapId, arrivalDate: req.body.arrivalDate, departureDate: req.body.departureDate,
        totalPrice: req.body.totalPrice, currency: req.body.currency, status: "new", ref: req.body.customFieldValues[0].value }; w.reservations.push(r); return r; };
      switch (w.createMode) {
        case "ok": return { httpStatus: 201, json: { status: "success", result: full(store()) } };
        case "refNotEchoed": { const r = full(store()); delete r.customFieldValues; return { httpStatus: 201, json: { status: "success", result: r } }; }
        case "refNotEchoedOtherId": { const r = full(store()); delete r.customFieldValues; r.id += 50; return { httpStatus: 201, json: { status: "success", result: r } }; }
        case "mismatch": { const r = full(store()); r.listingMapId = 1; return { httpStatus: 201, json: { status: "success", result: r } }; }
        case "createdThen503": store(); return { httpStatus: 503, json: null };
        case "503": return { httpStatus: 503, json: null };
        case "429": return { httpStatus: 429, json: { status: "fail" } };
        case "400": return { httpStatus: 400, json: { status: "fail" } };
        case "malformed": store(); return { httpStatus: 201, json: { status: "success", result: "nope" } };
        case "timeoutCreated": store(); throw new Error("timeout");
        case "timeout": throw new Error("timeout");
        case "late": return new Promise((resolve) => { w.releaseLate = () => resolve({ httpStatus: 201, json: { status: "success", result: full(store()) } }); });
        default: throw new Error(`mode ${w.createMode}`);
      }
    }
  };
  w.count = (prefix) => w.calls.filter((c) => c.startsWith(prefix)).length;
  return w;
}

const cfgFor = (ids, currency = "MXN") => validateAdapterConfig({ allowedListingIds: ids, refFieldId: REF_FIELD, channelId: 2000, currency });
const POLICY = readDirectPolicyFromEnv(ENV).policy;

/** A payment_authorized intent priced EXACTLY like the server would (fresh priceStay), with guest details. */
async function authorizedIntent(w, listingId, stay = STAY) {
  const priced = await priceStay({ request: { listingId, ...stay }, listingConfig: { currency: "MXN" }, client: w.pricing, policy: POLICY,
    today: todayInTimeZone(undefined, new Date(F.at(0))), now: F.at(0) });
  assert.ok(priced.ok, priced.error);
  w.calls.length = 0;
  const intent = await createIntentRecord(db.app, { ref: F.nextRef(), accessTokenHash: F.tokenHash(), environment: "test", now: F.at(0), listingId, ...stay });
  F.ok(await applyEvent(db.app, intent.id, { type: "PRICE_CONFIRMED", price: priced.price }, { now: F.at(0) }));
  F.ok(await collectGuestDetails(db.app, intent.id, F.GUEST, { now: F.at(1), termsVersion: "terms-2026-10" }));
  const b = F.ok(await beginPayStep(db.app, intent.id, { now: F.at(2) }));
  const op = await claimNextOperation(db.app, { workerId: "w-pay", now: F.at(2), intentId: intent.id, opTypes: ["stripe.create_checkout_session"] });
  const sessionId = `cs_test_${intent.id.slice(0, 8)}`;
  F.ok(await completeOperation(db.app, op.id, { workerId: "w-pay", now: F.at(2), outcome: { status: "succeeded", resultRef: sessionId } }));
  F.ok(await recordCheckoutSession(db.app, intent.id, b.attempt.id, { sessionId, expiresAt: F.at(32), now: F.at(2) }));
  const piId = `pi_test_${intent.id.slice(0, 8)}`;
  F.ok(await applyEvent(db.app, intent.id, F.authEvent(sessionId, piId, 5, { amountMinor: priced.price.finalTotalMinor }), { now: F.at(5) }));
  return { id: intent.id, ref: intent.ref, piId, price: priced.price };
}

function harness(w, listingIds, { start = F.at(10) } = {}) {
  const clk = { t: start };
  const h = {
    clk, w,
    opts: (extra = {}) => ({ workerId: "w1", env: ENV, adapterConfig: cfgFor(listingIds), listings: new Map(listingIds.map((id) => [id, { currency: "MXN" }])),
      executors: w.executors, clock: () => clk.t, ...extra }),
    step: (extra = {}) => runOrchestratorStep(db.app, h.opts(extra)),
    /** Run steps (advancing the clock) until pred(state) or max steps; returns the steps' results. */
    until: async (intentId, pred, { max = 40, advanceMs = 30 * 1000, extra = {} } = {}) => {
      const out = [];
      for (let k = 0; k < max; k++) {
        const st = (await loadIntent(db.app, intentId)).status;
        if (pred(st)) return out;
        out.push(await h.step({ intentId, ...extra }));
        clk.t += advanceMs;
      }
      assert.fail(`not reached after ${max} steps: ${(await loadIntent(db.app, intentId)).status}`);
    }
  };
  return h;
}
const opsOf = async (id, type) => (await db.app.query("SELECT * FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 ORDER BY created_at, id", [id, type])).rows;
const PROVIDER_WRITES = ["stripe.capture_payment_intent", "stripe.void_payment_intent", "hostaway.cancel_reservation", "hostaway.record_offline_charge"];
async function noWriteExecuted(id) {
  // capture / void / cancel / offline charge / notifications may be QUEUED but are never claimed by this slice
  const n = await F.count(db.app, `SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1
    AND op_type <> ALL($2) AND op_type NOT IN ('stripe.retrieve_payment_intent', 'stripe.create_checkout_session') AND dispatched_at IS NOT NULL`,
    [id, ["hostaway.lookup_reservation", "hostaway.retrieve_reservation", "hostaway.create_reservation"]]);
  assert.equal(n, 0, "no capture/void/cancel/offline-charge/notification row was ever claimed");
}

// ---------------------------------------------------------------------------------------------

test("gate: every refusal has ZERO effects (no claim, no row change, no provider call)", async () => {
  const w = world();
  const id = L(1);
  const a = await authorizedIntent(w, id);
  const snap = async () => (await db.app.query("SELECT state, version FROM booking.intents WHERE id = $1", [a.id])).rows[0].version * 1000
    + await F.count(db.app, "SELECT count(*) AS n FROM booking.external_operations WHERE dispatched_at IS NOT NULL");
  const before0 = await snap();
  const h = harness(w, [id]);
  const cases = [
    [{ env: undefined }, "ENV_REQUIRED"], [{ env: { ...ENV, VERCEL_ENV: "production" } }, "PRODUCTION_REFUSED"],
    [{ env: { MV_E7_RESERVATION_WORKER: "enabled" } }, "ENVIRONMENT_NOT_ALLOWED"], [{ env: { VERCEL_ENV: "preview" } }, "NOT_ENABLED"],
    [{ env: { ...ENV, MV_E7_RESERVATION_WORKER: "true" } }, "NOT_ENABLED"],
    [{ executors: undefined }, "NO_EXECUTORS"], [{ executors: { ...w.executors, createReservation: undefined } }, "NO_EXECUTORS"],
    [{ executors: { ...w.executors, capturePaymentIntent: async () => assert.fail("never called") } }, "EXECUTOR_NOT_ALLOWED"],
    [{ executors: { ...w.executors, notify: async () => assert.fail("never called") } }, "EXECUTOR_NOT_ALLOWED"],
    [{ adapterConfig: { allowedListingIds: [603566], refFieldId: REF_FIELD, channelId: 2000, currency: "MXN" } }, "ADAPTER_CONFIG_INVALID"],
    [{ adapterConfig: { allowedListingIds: [id], refFieldId: REF_FIELD, channelId: 2000, currency: "MXN", forceOverbooking: true } }, "ADAPTER_CONFIG_INVALID"],
    [{ listings: new Map() }, "LISTINGS_REQUIRED"], [{ listings: new Map([[id + 1, { currency: "MXN" }]]) }, "LISTING_NOT_ALLOWLISTED"],
    [{ listings: new Map([[id, { currency: "USD" }]]) }, "LISTING_NOT_ALLOWLISTED"],
    [{ clock: undefined }, "CLOCK_REQUIRED"], [{ workerId: "bad id!" }, "WORKER_ID_INVALID"]
  ];
  for (const [over, code] of cases) {
    const r = await h.step(over);
    assert.deepEqual([r.status, r.code, r.sends], ["refused", code, 0], JSON.stringify(Object.keys(over)));
  }
  // a database not marked "test": refused after a single read of the marker
  const queries = [];
  const fakePool = { query: async (sql) => { queries.push(sql); return { rows: [{ environment: "live" }] }; } };
  const r = await runOrchestratorStep(fakePool, h.opts());
  assert.deepEqual([r.status, r.code], ["refused", "DATABASE_NOT_TEST"]);
  assert.deepEqual(queries, ["SELECT environment FROM booking.instance"]);
  assert.equal(w.calls.length, 0, "no provider call of any kind");
  assert.equal(await snap(), before0, "no intent change, no claimed row");
  assert.equal(reservationWorkerGate({ env: ENV, adapterConfig: cfgFor([id]), listings: new Map([[id, { currency: "MXN" }]]), executors: w.executors, clock: () => 1 }).ok, true);
});

test("full path: fresh recheck -> lookup -> write-before-send -> ONE create -> reservation_confirmed with exactly ONE capture PENDING, zero writes executed", async () => {
  const w = world();
  const id = L(2);
  const a = await authorizedIntent(w, id);
  const h = harness(w, [id]);
  const s1 = await h.step({ intentId: a.id });
  assert.deepEqual(s1.actions.filter((x) => !x.startsWith("RECOVERY")), ["RESERVATION_STARTED->reservation_pending"]);
  assert.deepEqual(w.calls, [`GET /listings/${id}`, `GET /listings/${id}/calendar`, `POST /listings/${id}/calendar/priceDetails`]);
  const s2 = await h.step({ intentId: a.id });
  assert.deepEqual(s2.actions, ["RESERVATION_DISPATCHED", "CREATE_CLAIMED", "RESERVATION_SUCCEEDED->reservation_confirmed"]);
  assert.equal(s2.sends, 1);
  assert.deepEqual([w.count("LOOKUP"), w.count("CREATE")], [1, 1], "lookup (one empty page = documented end: not found) BEFORE the single create");
  assert.ok(w.calls.indexOf(`CREATE ${a.ref}`) > w.calls.findIndex((c) => c.startsWith("LOOKUP")));
  const i = await loadIntent(db.app, a.id);
  assert.equal(i.status, "reservation_confirmed");
  assert.equal(i.reservation.reservationId, String(w.reservations[0].id));
  const caps = await opsOf(a.id, "stripe.capture_payment_intent");
  assert.deepEqual(caps.map((c) => [c.state, c.dispatched_at]), [["pending", null]], "exactly one capture, queued, never claimed");
  // more steps never touch it (reservation_confirmed is not a worker state; capture is not a worker op type)
  for (let k = 0; k < 3; k++) { h.clk.t += MIN; const r = await h.step({ intentId: a.id }); assert.equal(r.status, "idle"); }
  assert.equal((await opsOf(a.id, "stripe.capture_payment_intent"))[0].state, "pending");
  await noWriteExecuted(a.id);
  assert.equal(w.count("CREATE"), 1);
  // the attempts row carries the request's ref and the provider reply (version-independent record)
  const att = (await db.app.query("SELECT state, booking_ref, hostaway_reservation_id, http_status, send_started_at FROM booking.hostaway_reservation_attempts WHERE intent_id = $1", [a.id])).rows[0];
  assert.deepEqual([att.state, att.booking_ref, att.hostaway_reservation_id, att.http_status, att.send_started_at !== null], ["succeeded", a.ref, String(w.reservations[0].id), 201, true]);
});

test("two workers race over the whole path: exactly one create, one confirmed reservation", async () => {
  const w = world();
  const id = L(3);
  const a = await authorizedIntent(w, id);
  const h = harness(w, [id]);
  // deterministic overlap: worker A is paused right after its claim (work lease held); B must not get the intent
  await h.step({ intentId: a.id, workerId: "wa" });
  let bDuring = null;
  const sa = await h.step({ intentId: a.id, workerId: "wa", hooks: { afterClaim: async () => { bDuring = await h.step({ intentId: a.id, workerId: "wb" }); } } });
  assert.equal(bDuring.status, "idle", "B cannot take an intent whose work lease A holds");
  assert.equal(sa.sends, 1);
  // free-running races afterwards change nothing
  for (let k = 0; k < 4; k++) {
    await Promise.all(["wa", "wb"].map((wid) => h.step({ intentId: a.id, workerId: wid })));
    h.clk.t += 1000;
  }
  assert.equal((await loadIntent(db.app, a.id)).status, "reservation_confirmed");
  assert.equal(w.count("CREATE"), 1);
  assert.equal((await opsOf(a.id, "hostaway.create_reservation")).length, 1);
});

test("price changed / no longer bookable -> reservation_failed with a void QUEUED (never executed); zero creates", async () => {
  const cases = [
    [L(11), (w) => { w.nightly = 1700; }, "PRICE_CHANGED"],
    [L(12), (w) => { w.executors.pricing = world({ blocked: new Set(["2026-12-21"]) }).pricing; }, "NO_LONGER_AVAILABLE"],
    [L(13), (w) => { w.currency = "USD"; }, "PRICE_CHANGED"]
  ];
  for (const [id, mut, code] of cases) {
    const w = world();
    const a = await authorizedIntent(w, id);
    mut(w);
    const h = harness(w, [id]);
    const s = await h.step({ intentId: a.id });
    assert.equal(s.actions.at(-1), "RESERVATION_STARTED->reservation_failed", code);
    const i = await loadIntent(db.app, a.id);
    assert.deepEqual([i.status, i.reasonCode], ["reservation_failed", code]);
    assert.deepEqual((await opsOf(a.id, "stripe.void_payment_intent")).map((o) => [o.state, o.dispatched_at]), [["pending", null]]);
    assert.equal(w.count("CREATE") + w.count("LOOKUP"), 0);
    await noWriteExecuted(a.id);
  }
});

test("transient pricing failure: no event, rescheduled (no busy loop); later success proceeds", async () => {
  const w = world();
  const id = L(20);
  const a = await authorizedIntent(w, id);
  w.pricingMode = "down";
  const h = harness(w, [id]);
  const s = await h.step({ intentId: a.id });
  assert.deepEqual([s.actions.at(-1), s.delayMs], ["WAIT:LISTING_UNAVAILABLE", LIMITS.waitMs]);
  assert.equal((await loadIntent(db.app, a.id)).status, "payment_authorized");
  assert.equal((await h.step({ intentId: a.id })).status, "idle", "not due again before the delay");
  w.pricingMode = "ok"; h.clk.t += LIMITS.waitMs;
  assert.equal((await h.step({ intentId: a.id })).actions.at(-1), "RESERVATION_STARTED->reservation_pending");
});

test("existing booking ref BEFORE the first create -> escalate, never adopted, zero creates", async () => {
  const w = world();
  const id = L(21);
  const a = await authorizedIntent(w, id);
  w.reservations.push({ id: 991, listingMapId: id, arrivalDate: STAY.from, departureDate: STAY.to, totalPrice: 5760, currency: "MXN", status: "new", ref: a.ref });
  const h = harness(w, [id]);
  await h.step({ intentId: a.id });
  const s = await h.step({ intentId: a.id });
  assert.equal(s.actions.at(-1), "ESCALATE:EXISTING_BOOKING_REF_BEFORE_CREATE");
  assert.equal((await loadIntent(db.app, a.id)).status, "reconciliation_required");
  assert.equal(w.count("CREATE"), 0);
  assert.equal((await opsOf(a.id, "hostaway.create_reservation")).length, 0);
});

test("lookup items without a currency fail closed (never invented): zero creates, bounded escalation", async () => {
  const w = world();
  const id = L(22);
  const a = await authorizedIntent(w, id);
  w.reservations.push({ id: 992, listingMapId: id, arrivalDate: STAY.from, departureDate: STAY.to, totalPrice: 5760, currency: "MXN", status: "new", ref: "MV-OTHER99" });
  w.lookupMode = "noCurrency";
  const h = harness(w, [id]);
  await h.until(a.id, (s) => s === "reconciliation_required", { max: 60, advanceMs: 45 * 1000 });
  assert.equal(w.count("CREATE"), 0);
  assert.equal((await opsOf(a.id, "hostaway.create_reservation")).length, 0);
});

test("authorization deadline: passed before start / crossed during pricing / crossed between claim and send -> ZERO sends", async () => {
  const w = world();
  // (a) already past at the start: E3 escalates
  const a = await authorizedIntent(w, L(23));
  const deadline = (await loadIntent(db.app, a.id)).payment.authorizationDeadline;
  const h = harness(w, [L(23), L(24), L(25)], { start: deadline + 1 });
  const s = await h.step({ intentId: a.id });
  assert.equal(s.actions.at(-1), "RESERVATION_STARTED->reconciliation_required");
  assert.equal(w.count("GET") + w.count("CREATE"), 0, "no pricing read once past the deadline");
  // (b) crossed while awaiting the pricing reads: the event uses a FRESH clock -> E3 escalates
  const b = await authorizedIntent(w, L(24));
  const db2 = (await loadIntent(db.app, b.id)).payment.authorizationDeadline;
  h.clk.t = db2 - 1000;
  w.onPricing = async () => { h.clk.t = db2 + 1; };
  assert.equal((await h.step({ intentId: b.id })).actions.at(-1), "RESERVATION_STARTED->reconciliation_required");
  w.onPricing = null;
  // (c) crossed between the claim and the send: the claimed row is "possibly sent" -> unknown; nothing sent
  const c = await authorizedIntent(w, L(25));
  const dc = (await loadIntent(db.app, c.id)).payment.authorizationDeadline;
  h.clk.t = dc - 60 * 1000;                                            // start: E3 lease until dc + 60 s
  await h.step({ intentId: c.id });
  h.clk.t = dc - 50 * 1000;                                            // room for call (20 s) + margin (15 s) at dispatch
  // after the claim only the DEADLINE runs short (op/work leases 40 s left, E3 lease 90 s)
  const r = await h.step({ intentId: c.id, hooks: { afterClaim: async () => { h.clk.t = dc - 30 * 1000; } } });
  assert.deepEqual(r.actions, ["RESERVATION_DISPATCHED", "CREATE_CLAIMED", "SEND_ABORTED:DEADLINE", "RESERVATION_OUTCOME_UNKNOWN:SEND_ABORTED_DEADLINE"]);
  assert.equal(r.sends, 0);
  assert.equal(w.count("CREATE"), 0);
  assert.equal((await opsOf(c.id, "hostaway.create_reservation"))[0].state, "outcome_unknown");
  assert.equal((await loadIntent(db.app, c.id)).status, "reservation_unknown");
});

test("crash after RESERVATION_DISPATCHED, before the claim: the create is superseded, never sent, never recreated; durable escalation", async () => {
  const w = world();
  const a = await authorizedIntent(w, L(30));
  const h = harness(w, [L(30)]);
  await h.step({ intentId: a.id });
  await assert.rejects(h.step({ intentId: a.id, hooks: { afterDispatch: async () => { throw new Error("crash"); } } }), /crash/);
  h.clk.t += 5 * MIN;                                                   // E3 lease (2 min) long gone
  await h.until(a.id, (s) => s === "reconciliation_required", { max: 6 });
  const cr = await opsOf(a.id, "hostaway.create_reservation");
  assert.deepEqual(cr.map((o) => [o.state, o.dispatched_at]), [["superseded", null]]);
  assert.equal(w.count("CREATE"), 0);
  assert.equal((await loadIntent(db.app, a.id)).reasonCode, "CREATE_NEVER_SENT_UNPROVEN");
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'", [a.id]), 1);
});

test("crash after the claim, before the actual send: possibly sent -> unknown + read recovery; never recreated", async () => {
  const w = world();
  const a = await authorizedIntent(w, L(31));
  const h = harness(w, [L(31)]);
  await h.step({ intentId: a.id });
  await assert.rejects(h.step({ intentId: a.id, hooks: { afterClaim: async () => { throw new Error("crash"); } } }), /crash/);
  assert.equal(w.count("CREATE"), 0);
  await h.until(a.id, (s) => s === "reconciliation_required", { max: 60, advanceMs: 60 * 1000 });
  assert.equal(w.count("CREATE"), 0, "never sent, never recreated");
  assert.deepEqual((await opsOf(a.id, "hostaway.create_reservation")).map((o) => o.state), ["outcome_unknown"]);
  assert.ok(w.count("LOOKUP") <= 30, `reads are bounded (${w.count("LOOKUP")})`);
});

test("crash after the send + reply record, before completion: recovery proves the reservation by ref + by id (known id agrees)", async () => {
  const w = world();
  const a = await authorizedIntent(w, L(32));
  const h = harness(w, [L(32)]);
  await h.step({ intentId: a.id });
  await assert.rejects(h.step({ intentId: a.id, hooks: { afterRecord: async () => { throw new Error("crash"); } } }), /crash/);
  assert.equal(w.count("CREATE"), 1);
  await h.until(a.id, (s) => s === "reservation_confirmed", { max: 30, advanceMs: 60 * 1000 });
  assert.equal(w.count("CREATE"), 1);
  assert.equal((await loadIntent(db.app, a.id)).reservation.reservationId, String(w.reservations[0].id));
  assert.equal((await opsOf(a.id, "stripe.capture_payment_intent")).length, 1);
  // the provider reply was recorded BEFORE completion (version-independent), so it survived the crash
  const att = (await db.app.query("SELECT hostaway_reservation_id, http_status, responded_at FROM booking.hostaway_reservation_attempts WHERE intent_id = $1", [a.id])).rows[0];
  assert.deepEqual([att.hostaway_reservation_id, att.http_status, att.responded_at !== null], [String(w.reservations[0].id), 201, true]);
});

test("only reservation-phase rows are claimed: a queued notification on the same intent is never touched", async () => {
  const w = world();
  const a = await authorizedIntent(w, L(34));
  const h = harness(w, [L(34)]);
  await h.step({ intentId: a.id });
  w.createMode = "503";
  await h.step({ intentId: a.id });                                     // reservation_unknown (+ E3 lookup read)
  await db.app.query(`INSERT INTO booking.external_operations (id, intent_id, op_type, idempotency_key, retry_class, state, payload, source_version, max_attempts,
     next_attempt_at, created_at, updated_at) VALUES (gen_random_uuid(), $1, 'guest.notify', $2, 'idempotent', 'pending', '{"template":"t"}', 1, 5, $3, $3, $3)`,
    [a.id, `test-notify:${a.id}`, new Date(F.at(0))]);
  for (let k = 0; k < 8; k++) { h.clk.t += 60 * 1000; await h.step({ intentId: a.id }); }
  assert.deepEqual((await opsOf(a.id, "guest.notify")).map((o) => [o.state, o.dispatched_at]), [["pending", null]]);
});

test("work-lease fence: a step that outlived its intent_work lease cannot apply its event", async () => {
  const w = world();
  const a = await authorizedIntent(w, L(35));
  const h = harness(w, [L(35)]);
  w.onPricing = async () => { h.clk.t += LIMITS.workLeaseMs + 1000; };
  const s = await h.step({ intentId: a.id });
  assert.equal(s.actions.at(-1), "RESERVATION_STARTED!WORK_LEASE_LOST");
  assert.equal((await loadIntent(db.app, a.id)).status, "payment_authorized");
});

test("send margins: too little authorization time to dispatch -> escalate without dispatch; E3 lease running short at the send -> abort", async () => {
  const w = world();
  const a = await authorizedIntent(w, L(36));
  const da = (await loadIntent(db.app, a.id)).payment.authorizationDeadline;
  const h = harness(w, [L(36), L(37)], { start: da - 60 * 1000 });
  await h.step({ intentId: a.id });
  h.clk.t = da - 30 * 1000;                                            // > margin (15 s) but < call (20 s) + margin
  const s = await h.step({ intentId: a.id });
  assert.equal(s.actions.at(-1), "ESCALATE:AUTHORIZATION_DEADLINE_PASSED");
  assert.equal((await opsOf(a.id, "hostaway.create_reservation")).length, 0, "nothing dispatched or claimed");
  const b = await authorizedIntent(w, L(37));
  h.clk.t = F.at(10);
  await h.step({ intentId: b.id });
  const until = (await loadIntent(db.app, b.id)).lease.until;
  h.clk.t = until - 50 * 1000;                                          // claim here: operation and work leases run to until + 10 s
  // after the claim only the E3 lease runs short (30 s < call 20 s + margin 15 s); op/work leases still have 40 s
  const r = await h.step({ intentId: b.id, hooks: { afterClaim: async () => { h.clk.t = until - 30 * 1000; } } });
  assert.deepEqual(r.actions.slice(-2), ["SEND_ABORTED:E3_LEASE_TOO_SHORT", "RESERVATION_OUTCOME_UNKNOWN:SEND_ABORTED_E3_LEASE_TOO_SHORT"]);
  assert.equal(w.count("CREATE"), 0);
});

test("crash after completion, before the event: recovery applies the outcome once (reads, full identity)", async () => {
  const w = world();
  const a = await authorizedIntent(w, L(33));
  const h = harness(w, [L(33)]);
  await h.step({ intentId: a.id });
  await assert.rejects(h.step({ intentId: a.id, hooks: { afterComplete: async () => { throw new Error("crash"); } } }), /crash/);
  await h.until(a.id, (s) => s === "reservation_confirmed", { max: 30, advanceMs: 60 * 1000 });
  assert.equal(w.count("CREATE"), 1);
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.intent_transitions WHERE intent_id = $1 AND to_state = 'reservation_confirmed'", [a.id]), 1);
});

test("ambiguous create replies (5xx, 429, uncatalogued 4xx, timeout, malformed) -> unknown, no retry; created ones are found by reads", async () => {
  for (const [mode, created] of [["503", false], ["429", false], ["400", false], ["timeout", false], ["createdThen503", true], ["timeoutCreated", true], ["malformed", true]]) {
    const w = world();
    const id = L(40 + ["503", "429", "400", "timeout", "createdThen503", "timeoutCreated", "malformed"].indexOf(mode));
    const a = await authorizedIntent(w, id);
    const h = harness(w, [id]);
    await h.step({ intentId: a.id });
    w.createMode = mode;
    const s = await h.step({ intentId: a.id });
    assert.match(s.actions.at(-1), /^RESERVATION_OUTCOME_UNKNOWN:/, mode);
    assert.equal((await loadIntent(db.app, a.id)).status, "reservation_unknown", mode);
    // never an automatic retry, whatever happens next
    const end = created ? "reservation_confirmed" : "reconciliation_required";
    await h.until(a.id, (st) => st === end, { max: 60, advanceMs: 60 * 1000 });
    assert.equal(w.count("CREATE"), 1, mode);
    assert.equal((await opsOf(a.id, "hostaway.create_reservation")).length, 1, mode);
    await noWriteExecuted(a.id);
  }
});

test("reply without the ref echo: id recorded, waits for evidence freshness, then by-ref + by-id reads prove it", async () => {
  const w = world();
  const a = await authorizedIntent(w, L(50));
  const h = harness(w, [L(50)]);
  await h.step({ intentId: a.id });
  w.createMode = "refNotEchoed";
  const s = await h.step({ intentId: a.id });
  assert.equal(s.actions.at(-1), "CREATE_REF_NOT_ECHOED:READS_REQUIRED");
  assert.equal((await loadIntent(db.app, a.id)).status, "reservation_pending", "not confirmed from the reply alone");
  const lookupsBefore = w.count("LOOKUP");
  h.clk.t += 30 * 1000;
  const early = await h.step({ intentId: a.id });
  assert.ok(early.status === "idle" || early.actions.includes("WAIT:EVIDENCE_FRESHNESS") || early.actions.includes("WAIT:NO_READ_DUE"));
  assert.equal(w.count("LOOKUP"), lookupsBefore, "no read before dispatch + 2 min");
  await h.until(a.id, (st) => st === "reservation_confirmed", { max: 30, advanceMs: 45 * 1000 });
  assert.ok(w.count("RETRIEVE") >= 1 && w.count("LOOKUP") > lookupsBefore);
  assert.equal(w.count("CREATE"), 1);
});

test("known-id conflict: the reply's id differs from what reads prove -> escalate RESERVATION_ID_CONFLICT", async () => {
  const w = world();
  const a = await authorizedIntent(w, L(51));
  const h = harness(w, [L(51)]);
  await h.step({ intentId: a.id });
  w.createMode = "refNotEchoedOtherId";
  await h.step({ intentId: a.id });
  await h.until(a.id, (st) => st === "reconciliation_required", { max: 30, advanceMs: 45 * 1000 });
  assert.equal((await loadIntent(db.app, a.id)).reasonCode, "RESERVATION_ID_CONFLICT");
  assert.equal(w.count("CREATE"), 1);
});

test("explicit contradiction in the create reply -> escalate (no adoption); malformed by-id proof never settles", async () => {
  const w = world();
  const a = await authorizedIntent(w, L(52));
  const h = harness(w, [L(52)]);
  await h.step({ intentId: a.id });
  w.createMode = "mismatch";
  const s = await h.step({ intentId: a.id });
  assert.equal(s.actions.at(-1), "ESCALATE:CREATE_REPLY_CONTRADICTION");
  assert.equal((await loadIntent(db.app, a.id)).status, "reconciliation_required");
  // malformed by-id replies: the read is retried (bounded), no evidence is recorded, nothing is confirmed
  const w2 = world();
  const b = await authorizedIntent(w2, L(53));
  const h2 = harness(w2, [L(53)]);
  await h2.step({ intentId: b.id });
  w2.createMode = "refNotEchoed"; w2.retrieveMode = "malformed";
  await h2.step({ intentId: b.id });
  for (let k = 0; k < 25; k++) { h2.clk.t += 45 * 1000; await h2.step({ intentId: b.id }); }
  assert.notEqual((await loadIntent(db.app, b.id)).status, "reservation_confirmed");
  assert.equal(await F.count(db.app, `SELECT count(*) AS n FROM booking.provider_evidence e JOIN booking.external_operations o ON o.id = e.read_operation_id
     WHERE e.intent_id = $1 AND o.op_type = 'hostaway.retrieve_reservation'`, [b.id]), 0);
  assert.equal(w2.count("CREATE"), 1);
});

test("lost operation lease while sending: the late result applies NO event; recovery settles by reads", async () => {
  const w = world();
  const a = await authorizedIntent(w, L(54));
  const h = harness(w, [L(54)]);
  await h.step({ intentId: a.id });
  w.onCreate = async () => { h.clk.t += 2 * MIN; await recoverExpiredOperations(db.app, { now: h.clk.t }); };  // another worker recovers the row
  const s = await h.step({ intentId: a.id });
  assert.ok(s.actions.some((x) => x.startsWith("LEASE_LOST")), JSON.stringify(s.actions));
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.intent_transitions WHERE intent_id = $1 AND event_type = 'RESERVATION_SUCCEEDED'", [a.id]), 0);
  w.onCreate = null;
  await h.until(a.id, (st) => st === "reservation_confirmed", { max: 30, advanceMs: 60 * 1000 });
  assert.equal(w.count("CREATE"), 1);
});

test("repeated delivery: many extra steps after confirmation change nothing; reads stay bounded on a stuck intent", async () => {
  const w = world();
  const a = await authorizedIntent(w, L(55));
  const h = harness(w, [L(55)]);
  await h.until(a.id, (st) => st === "reservation_confirmed", { max: 5 });
  const v = (await loadIntent(db.app, a.id)).version;
  for (let k = 0; k < 10; k++) { h.clk.t += 10 * MIN; await h.step({ intentId: a.id }); }
  assert.equal((await loadIntent(db.app, a.id)).version, v);
  assert.equal(w.count("CREATE"), 1);
  // a stuck unknown (provider has nothing): reads and events are bounded, ending in a durable escalation
  const w2 = world();
  const b = await authorizedIntent(w2, L(56));
  const h2 = harness(w2, [L(56)]);
  await h2.step({ intentId: b.id });
  w2.createMode = "503";
  await h2.step({ intentId: b.id });
  await h2.until(b.id, (st) => st === "reconciliation_required", { max: 60, advanceMs: 60 * 1000 });
  const reads = w2.count("LOOKUP") + w2.count("RETRIEVE");
  for (let k = 0; k < 10; k++) { h2.clk.t += 10 * MIN; await h2.step({ intentId: b.id }); }
  assert.equal(w2.count("LOOKUP") + w2.count("RETRIEVE"), reads, "no reads after escalation");
  assert.ok(reads <= 30, `bounded reads (${reads})`);
  assert.equal(w2.count("CREATE"), 1);
});

test("evidence freshness: right after an ambiguous create the intent is due, but no read runs before dispatch + 2 min", async () => {
  const w = world();
  const a = await authorizedIntent(w, L(38));
  const h = harness(w, [L(38)]);
  await h.step({ intentId: a.id });
  w.createMode = "createdThen503";
  await h.step({ intentId: a.id });                                     // -> reservation_unknown, rescheduled immediately
  const reads = () => w.count("LOOKUP") + w.count("RETRIEVE");
  const before = reads();
  const s = await h.step({ intentId: a.id });
  assert.equal(s.status, "worked");
  assert.equal(s.actions.at(-1), "WAIT:EVIDENCE_FRESHNESS");
  assert.equal(reads(), before, "no early read (its evidence could never count)");
  assert.ok(s.delayMs > 0 && s.delayMs <= 2 * MIN);
});

test("scope: the worker's recovery pass never acts on capture rows (reservation phase only)", async () => {
  const w = world();
  const a = await authorizedIntent(w, L(39));
  const h = harness(w, [L(39)]);
  await h.until(a.id, (s) => s === "reservation_confirmed", { max: 5 });
  // some OTHER component claimed the capture and its outcome became unknown (nothing of this slice is involved)
  const cap = await claimNextOperation(db.app, { workerId: "other-capture-component", now: h.clk.t, intentId: a.id, opTypes: ["stripe.capture_payment_intent"] });
  F.ok(await completeOperation(db.app, cap.id, { workerId: "other-capture-component", now: h.clk.t, outcome: { status: "outcome_unknown", errorCode: "TIMEOUT" } }));
  for (let k = 0; k < 4; k++) { h.clk.t += 5 * MIN; await h.step({ intentId: a.id }); }
  assert.equal((await loadIntent(db.app, a.id)).status, "reservation_confirmed", "no CAPTURE_OUTCOME_UNKNOWN (or any capture recovery) from this worker");
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.intent_transitions WHERE intent_id = $1 AND event_type LIKE 'CAPTURE%'", [a.id]), 0);
});


// =============================================================================================
// root review of 8df0b43 — corrections

test("root (1): pre-send verification — expired/short operation lease (E3 lease fine), row already recovered, work lease stolen -> ZERO sends", async () => {
  const w = world();
  const ids = [L(80), L(81), L(82), L(83)];
  const h = harness(w, ids);
  // (a) root's exact case: op lease 60 s, clock after the claim = claim + 61 s; E3 lease and deadline far away
  const a = await authorizedIntent(w, ids[0]);
  await h.step({ intentId: a.id });
  let r = await h.step({ intentId: a.id, hooks: { afterClaim: async (op) => { h.clk.t = new Date(op.lease_until).getTime() + 1000; } } });
  assert.equal(r.sends, 0);
  assert.ok(r.actions.includes("SEND_ABORTED:OPERATION_LEASE_TOO_SHORT"), JSON.stringify(r.actions));
  // (b) still a few seconds of op lease, but less than call + margin (E3 lease 2 min): no send
  const b = await authorizedIntent(w, ids[1]);
  h.clk.t = F.at(10); await h.step({ intentId: b.id });
  r = await h.step({ intentId: b.id, hooks: { afterClaim: async (op) => { h.clk.t = new Date(op.lease_until).getTime() - 30 * 1000; } } });
  assert.deepEqual([r.sends, r.actions.includes("SEND_ABORTED:OPERATION_LEASE_TOO_SHORT")], [0, true]);
  // (c) the row was already recovered as unknown by someone else while this worker's clock still looks fine
  const c = await authorizedIntent(w, ids[2]);
  h.clk.t = F.at(10); await h.step({ intentId: c.id });
  r = await h.step({ intentId: c.id, hooks: { afterClaim: async (op) => { await recoverExpiredOperations(db.app, { now: new Date(op.lease_until).getTime() + 1 }); } } });
  assert.deepEqual([r.sends, r.actions.includes("SEND_ABORTED:OPERATION_NOT_HELD")], [0, true]);
  assert.ok(r.actions.some((x) => x.startsWith("LEASE_LOST")), "no event from this worker");
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.intent_transitions WHERE intent_id = $1 AND event_type = 'RESERVATION_OUTCOME_UNKNOWN' AND actor = 'worker'", [c.id]), 0);
  // (d) the intent's work lease was taken over between claim and send
  const d = await authorizedIntent(w, ids[3]);
  h.clk.t = F.at(10); await h.step({ intentId: d.id });
  r = await h.step({ intentId: d.id, hooks: { afterClaim: async () => { await db.app.query("UPDATE booking.intent_work SET work_worker_id = 'thief' WHERE intent_id = $1", [d.id]); } } });
  assert.deepEqual([r.sends, r.actions.includes("SEND_ABORTED:WORK_LEASE_NOT_HELD")], [0, true]);
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.intent_transitions WHERE intent_id = $1 AND event_type = 'RESERVATION_OUTCOME_UNKNOWN'", [d.id]), 0, "the fenced event is refused");
  assert.equal((await opsOf(d.id, "hostaway.create_reservation"))[0].state, "outcome_unknown", "claimed => possibly sent => unknown");
  assert.equal(w.count("CREATE"), 0, "zero sends in all four cases");
});

test("root (2): every provider call is bounded — hanging pricing / lookup / retrieve wait boundedly; a timed-out create is UNKNOWN and its late result is only late evidence", async () => {
  const T = { pricingCallMs: 30, readCallMs: 30, createCallMs: 40, stepBudgetMs: 2000 };
  const w = world();
  const ids = [L(84), L(85), L(86)];
  const h = harness(w, ids);
  // pricing hangs: aborted, step returns, no event
  const a = await authorizedIntent(w, ids[0]);
  w.pricingMode = "hang";
  const t0 = Date.now();
  let r = await h.step({ intentId: a.id, timeouts: T });
  assert.ok(Date.now() - t0 < 1500);
  assert.equal(r.actions.at(-1), "WAIT:LISTING_UNAVAILABLE");
  assert.ok(w.signals.length >= 1 && w.signals.every((sg) => sg.aborted), "the executor's AbortSignal was aborted");
  assert.equal((await loadIntent(db.app, a.id)).status, "payment_authorized");
  w.pricingMode = "ok"; w.signals.length = 0;
  // lookup hangs: the read is retried later (bounded), nothing dispatched
  h.clk.t += LIMITS.waitMs; await h.step({ intentId: a.id, timeouts: T });
  w.lookupMode = "hang";
  r = await h.step({ intentId: a.id, timeouts: T });
  assert.equal(r.actions.at(-1), "WAIT:LOOKUP_ERROR");
  assert.equal((await opsOf(a.id, "hostaway.create_reservation")).length, 0);
  w.lookupMode = "ok";
  // create hangs, then completes LATE at the provider
  const b = await authorizedIntent(w, ids[1]);
  h.clk.t = F.at(10);
  await h.step({ intentId: b.id, timeouts: T });
  w.createMode = "late";
  r = await h.step({ intentId: b.id, timeouts: T });
  assert.deepEqual(r.actions.slice(-1), ["RESERVATION_OUTCOME_UNKNOWN:CREATE_TIMEOUT"]);
  assert.equal(r.sends, 1);
  assert.equal(w.signals.at(-1).aborted, true);
  w.releaseLate();
  await r.late;
  const op = (await opsOf(b.id, "hostaway.create_reservation"))[0];
  assert.deepEqual([op.state, op.late_result_status, op.late_result_ref], ["outcome_unknown", "succeeded", String(w.reservations.at(-1).id)]);
  const att = (await db.app.query("SELECT http_status, hostaway_reservation_id FROM booking.hostaway_reservation_attempts WHERE intent_id = $1", [b.id])).rows[0];
  assert.deepEqual([att.http_status, att.hostaway_reservation_id], [201, String(w.reservations.at(-1).id)]);
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.intent_transitions WHERE intent_id = $1 AND event_type = 'RESERVATION_SUCCEEDED'", [b.id]), 0, "no event from a late result");
  w.createMode = "ok";
  await h.until(b.id, (st) => st === "reservation_confirmed", { max: 30, advanceMs: 60 * 1000, extra: { timeouts: T } });
  assert.equal(w.count("CREATE"), 1, "exactly one create ever (b's timed-out one; never retried; a never dispatched)");
  // retrieve hangs: bounded read retry, never a conclusion
  const c = await authorizedIntent(w, ids[2]);
  h.clk.t = F.at(10);
  await h.step({ intentId: c.id, timeouts: T });
  w.createMode = "refNotEchoed"; w.retrieveMode = "hang";
  await h.step({ intentId: c.id, timeouts: T });
  for (let k = 0; k < 6; k++) { h.clk.t += 60 * 1000; await h.step({ intentId: c.id, timeouts: T }); }
  assert.notEqual((await loadIntent(db.app, c.id)).status, "reservation_confirmed");
  assert.equal(await F.count(db.app, `SELECT count(*) AS n FROM booking.provider_evidence e JOIN booking.external_operations o ON o.id = e.read_operation_id
     WHERE e.intent_id = $1 AND o.op_type = 'hostaway.retrieve_reservation'`, [c.id]), 0);
  // caller timeouts may only SHORTEN the defaults
  const r2 = await h.step({ intentId: c.id, timeouts: { createCallMs: 10 ** 9 } });
  assert.notEqual(r2.status, "refused");
});

test("root (3): >100 unrelated unresolved rows (other listing) never starve this worker's create recovery or reservation orphans", async () => {
  const other = L(90);
  // 105 unrelated capture rows whose outcome is unknown (awaiting recovery), all OLDER than the target
  for (let k = 0; k < 105; k++) {
    const r = await F.reserved(db.app, { listingId: other, from: addDays("2027-01-01", 5 * k), to: addDays("2027-01-01", 5 * k + 4) });
    await F.runOp(db.app, r.id, "stripe.capture_payment_intent", 8, { status: "outcome_unknown", errorCode: "TIMEOUT" });
  }
  // 105 unrelated orphan PI reads (distinct selectors), also older
  const host = await F.reserved(db.app, { listingId: other, from: "2029-06-01", to: "2029-06-05" });     // after the 105 stays above
  for (let k = 0; k < 105; k++) {
    const id = await requestRead(db.app, host.id, "stripe.retrieve_payment_intent", `pi_test_noise_${k}`, { now: F.at(8) });
    const c = await claimNextOperation(db.app, { workerId: "noise", now: F.at(8), opId: id });
    F.ok(await completeOperation(db.app, c.id, { workerId: "noise", now: F.at(8), outcome: { status: "succeeded" } }));
  }
  const unrelated = await db.app.query("SELECT id, state, updated_at FROM booking.external_operations WHERE intent_id IN (SELECT id FROM booking.intents WHERE listing_id = $1) ORDER BY id", [other]);
  // target: a create whose completion was recorded but whose event was lost (crash) — recovery must reach it
  const w = world();
  const t = await authorizedIntent(w, L(91));
  const h = harness(w, [L(91)]);
  await h.step({ intentId: t.id });
  await assert.rejects(h.step({ intentId: t.id, hooks: { afterComplete: async () => { throw new Error("crash"); } } }), /crash/);
  // UNSCOPED steps (no intentId): only the configured listing is visible to the worker
  for (let k = 0; k < 30 && (await loadIntent(db.app, t.id)).status !== "reservation_confirmed"; k++) { h.clk.t += 60 * 1000; await h.step(); }
  assert.equal((await loadIntent(db.app, t.id)).status, "reservation_confirmed");
  const after = await db.app.query("SELECT id, state, updated_at FROM booking.external_operations WHERE intent_id IN (SELECT id FROM booking.intents WHERE listing_id = $1) ORDER BY id", [other]);
  assert.deepEqual(after.rows, unrelated.rows, "no unrelated row was touched");
  // a reservation-phase orphan behind the 105 unrelated orphans is re-issued
  const t2 = await authorizedIntent(w, L(92));
  const h2 = harness(w, [L(92)], { start: h.clk.t });
  await h2.step({ intentId: t2.id });                                       // reservation_pending, lookup queued
  const lk = (await opsOf(t2.id, "hostaway.lookup_reservation"))[0];
  const c = await claimNextOperation(db.app, { workerId: "w-crash", now: h2.clk.t, opId: lk.id });
  F.ok(await completeOperation(db.app, c.id, { workerId: "w-crash", now: h2.clk.t, outcome: { status: "succeeded" } }));   // crash before evidence
  h2.clk.t += 3 * MIN;
  const s = await h2.step();
  assert.ok(s.actions.includes("RECOVERY:REISSUE"), JSON.stringify(s.actions));
});

test("root (4): scoped maintenance/claims — unrelated intents and operation types are untouched, unconfigured intents never escalated", async () => {
  const other = L(93);
  // unrelated: expired in-flight capture and void rows, an expired E3 reservation lease, an authorized intent — all on an unconfigured listing
  const cap = await F.reserved(db.app, { listingId: other, from: "2027-02-01", to: "2027-02-04" });
  await claimNextOperation(db.app, { workerId: "x", now: F.at(8), intentId: cap.id, opTypes: ["stripe.capture_payment_intent"] });
  const vd = await F.reserved(db.app, { listingId: other, from: "2027-03-01", to: "2027-03-04" });
  await F.runOp(db.app, vd.id, "stripe.capture_payment_intent", 8, { status: "failed_definite", errorCode: "CARD_DECLINED" });
  F.ok(await applyEvent(db.app, vd.id, { type: "CAPTURE_FAILED", definite: true, code: "CARD_DECLINED" }, { now: F.at(8) }));
  await claimNextOperation(db.app, { workerId: "x", now: F.at(9), intentId: vd.id, opTypes: ["stripe.void_payment_intent"] });
  const pend = await F.dispatched(db.app, { listingId: other, from: "2027-04-01", to: "2027-04-04" });
  const w = world();
  const auth = await authorizedIntent(w, other, { from: "2027-05-01", to: "2027-05-05", guests: 2 });
  const snap = async () => ({
    ops: (await db.app.query("SELECT id, state, error_code, updated_at FROM booking.external_operations WHERE intent_id = ANY($1) ORDER BY id", [[cap.id, vd.id, pend.id, auth.id]])).rows,
    intents: (await db.app.query("SELECT id, state, version FROM booking.intents WHERE id = ANY($1) ORDER BY id", [[cap.id, vd.id, pend.id, auth.id]])).rows,
    work: (await db.app.query("SELECT intent_id, work_worker_id, next_action_at FROM booking.intent_work WHERE intent_id = ANY($1) ORDER BY intent_id", [[cap.id, vd.id, pend.id, auth.id]])).rows
  });
  const before0 = await snap();
  // a configured target, worked with AND without intentId scoping, far in the future (every unrelated lease long expired)
  const t = await authorizedIntent(w, L(94));
  const h = harness(w, [L(94)], { start: F.at(600) });
  await h.until(t.id, (st) => st === "reservation_confirmed", { max: 5 });
  for (let k = 0; k < 4; k++) { h.clk.t += 10 * MIN; await h.step(); }
  assert.deepEqual(await snap(), before0, "unconfigured / unrelated rows unchanged by scoped steps");
  // the old global defaults are unchanged: an UNSCOPED helper call still recovers them
  const g = await recoverExpiredOperations(db.app, { now: F.at(10 ** 4) });
  assert.ok(g.some((x) => x.opType === "stripe.capture_payment_intent"));
});

test("root (5): orphan re-issue exhaustion becomes a durable owner case (scope + current state checked), not silent rescheduling", async () => {
  const w = world();
  const a = await authorizedIntent(w, L(95));
  const h = harness(w, [L(95)]);
  await h.step({ intentId: a.id });                                          // reservation_pending + lookup queued
  let readId = (await opsOf(a.id, "hostaway.lookup_reservation"))[0].id;
  let t = h.clk.t;
  for (let depth = 0; depth <= 3; depth++) {
    const c = await claimNextOperation(db.app, { workerId: "w-crash", now: t, opId: readId });
    F.ok(await completeOperation(db.app, c.id, { workerId: "w-crash", now: t, outcome: { status: "succeeded" } }));   // never any evidence
    t += 3 * MIN;
    if (depth === 3) break;
    const re = await reissueOrphanRead(db.app, readId, { now: t });
    F.ok(re); readId = re.readOpId;
  }
  h.clk.t = t;
  const s = await h.step({ intentId: a.id });
  assert.ok(s.actions.includes("RECOVERY:REISSUE!REISSUE_DEPTH_EXHAUSTED"));
  assert.ok(s.actions.includes("RECOVERY:ESCALATE:READ_REISSUE_EXHAUSTED"), JSON.stringify(s.actions));
  const i = await loadIntent(db.app, a.id);
  assert.deepEqual([i.status, i.reasonCode], ["reconciliation_required", "READ_REISSUE_EXHAUSTED"]);
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'", [a.id]), 1);
  assert.equal(w.count("CREATE"), 0);
});

test("root (6): protected historical reservation ids are never adopted, confirmed or captured (full reply / missing ref / recovery known id / read evidence)", async () => {
  assert.deepEqual([...PROTECTED_HOSTAWAY_RESERVATION_IDS], ["70636076", "71045356", "71072615", "71081885"]);
  assert.ok(Object.isFrozen(PROTECTED_HOSTAWAY_RESERVATION_IDS));
  assert.throws(() => { PROTECTED_HOSTAWAY_RESERVATION_IDS.push("1"); });
  assert.equal(isProtectedReservationId(71081885), true);
  const cases = [["ok", 71081885, "full reply"], ["refNotEchoed", 70636076, "missing ref"], ["crashAfterRecord", 71045356, "recovery known id"],
    ["createdThen503", 71072615, "read evidence"]];
  for (const [mode, pid, label] of cases) {
    const w = world();
    w.nextId = pid;
    const id = L(96 + cases.findIndex((c) => c[2] === label));
    const a = await authorizedIntent(w, id);
    const h = harness(w, [id]);
    await h.step({ intentId: a.id });
    if (mode === "crashAfterRecord") {
      await assert.rejects(h.step({ intentId: a.id, hooks: { afterRecord: async () => { throw new Error("crash"); } } }), /crash/);
    } else {
      w.createMode = mode;
      await h.step({ intentId: a.id });
    }
    await h.until(a.id, (st) => st === "reconciliation_required" || st === "reservation_confirmed", { max: 30, advanceMs: 60 * 1000 });
    const i = await loadIntent(db.app, a.id);
    assert.deepEqual([i.status, i.reasonCode], ["reconciliation_required", "PROTECTED_RESERVATION_ID"], label);
    assert.equal(i.reservation, null, `${label}: never adopted`);
    assert.equal((await opsOf(a.id, "stripe.capture_payment_intent")).length, 0, `${label}: no capture queued`);
    assert.equal(w.count("CREATE"), 1, label);
  }
});

test("root (1/2): work lease running short, step budget exhausted, late result racing the unknown settlement; timeouts only shorten", async () => {
  const w = world();
  const ids = [L(100), L(101), L(102)];
  const h = harness(w, ids);
  // (e) the work lease is still this worker's but too short for the bounded call (operation lease untouched)
  const a = await authorizedIntent(w, ids[0]);
  await h.step({ intentId: a.id });
  let r = await h.step({ intentId: a.id, hooks: { afterClaim: async () => {
    await db.app.query("UPDATE booking.intent_work SET work_lease_until = $2 WHERE intent_id = $1", [a.id, new Date(h.clk.t + 20 * 1000)]); } } });
  assert.deepEqual([r.sends, r.actions.includes("SEND_ABORTED:WORK_LEASE_TOO_SHORT")], [0, true]);
  // (f) the real-time step budget is nearly spent at the send (deterministic monotonic source)
  const b = await authorizedIntent(w, ids[1]);
  h.clk.t = F.at(10); await h.step({ intentId: b.id });
  const m = { t: 0 };
  r = await h.step({ intentId: b.id, monotonic: () => m.t, hooks: { afterClaim: async () => { m.t = DEFAULT_TIMEOUTS.stepBudgetMs - 1000; } } });
  assert.deepEqual([r.sends, r.actions.includes("SEND_ABORTED:STEP_BUDGET")], [0, true]);
  // (g) the provider answers right after the timeout, WHILE the unknown settlement runs: the result is late evidence only
  const c = await authorizedIntent(w, ids[2]);
  h.clk.t = F.at(10); await h.step({ intentId: c.id, timeouts: { createCallMs: 30 } });
  w.createMode = "late";
  r = await h.step({ intentId: c.id, timeouts: { createCallMs: 30 }, hooks: { beforeSettleUnknown: async () => {
    // the provider's answer arrives while the unknown settlement has not yet touched the row: give a late handler every chance
    w.releaseLate(); await new Promise((res) => setTimeout(res, 150)); } } });
  await r.late;
  const op = (await opsOf(c.id, "hostaway.create_reservation"))[0];
  assert.deepEqual([op.state, op.late_result_status], ["outcome_unknown", "succeeded"], "never completed as succeeded by the late result");
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.intent_transitions WHERE intent_id = $1 AND event_type = 'RESERVATION_SUCCEEDED'", [c.id]), 0);
  // caller timeouts can only shorten the fixed defaults
  assert.deepEqual(_internal.resolveTimeouts({ createCallMs: 10 ** 9, readCallMs: 5, pricingCallMs: -1, stepBudgetMs: "x" }),
    { pricingCallMs: DEFAULT_TIMEOUTS.pricingCallMs, readCallMs: 5, createCallMs: DEFAULT_TIMEOUTS.createCallMs, stepBudgetMs: DEFAULT_TIMEOUTS.stepBudgetMs });
});

test("root (5): an exhausted re-issue never escalates an intent that left the reservation phase meanwhile (in-transaction state check)", async () => {
  const w = world();
  const a = await authorizedIntent(w, L(103));
  const h = harness(w, [L(103)]);
  await h.step({ intentId: a.id });
  let readId = (await opsOf(a.id, "hostaway.lookup_reservation"))[0].id;
  let t = h.clk.t;
  for (let depth = 0; depth <= 3; depth++) {
    const c = await claimNextOperation(db.app, { workerId: "w-crash", now: t, opId: readId });
    F.ok(await completeOperation(db.app, c.id, { workerId: "w-crash", now: t, outcome: { status: "succeeded" } }));
    t += 3 * MIN;
    if (depth === 3) break;
    const re = await reissueOrphanRead(db.app, readId, { now: t }); F.ok(re); readId = re.readOpId;
  }
  h.clk.t = t;
  const s = await h.step({ intentId: a.id, hooks: { afterReissueExhausted: async () => {
    // meanwhile another actor moves the intent out of the reservation phase (still a state where ESCALATE is legal)
    const cur = await loadIntent(db.app, a.id);
    assert.equal(cur.status, "payment_authorized");   // the expired E3 lease was recovered by the scoped maintenance
    F.ok(await applyEvent(db.app, a.id, { type: "RESERVATION_STARTED", id: "other-actor", workerId: "other", recheck: { bookable: true, priceSame: false } }, { now: h.clk.t }));
  } } });
  assert.ok(s.actions.includes("RECOVERY:ESCALATE!OUT_OF_SCOPE"), JSON.stringify(s.actions));
  const i = await loadIntent(db.app, a.id);
  assert.deepEqual([i.status, i.reasonCode], ["reservation_failed", "PRICE_CHANGED"], "not escalated by the stale exhaustion");
});
