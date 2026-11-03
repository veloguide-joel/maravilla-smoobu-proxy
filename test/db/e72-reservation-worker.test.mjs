// Stage E7.2 — offline reservation worker on a throwaway local PostgreSQL with FAKE Hostaway executors (no network,
// no SDK, no credentials). Runtime code runs as mv_booking_app. The clock is a test-controlled function: no real sleeps.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent, createIntentRecord, collectGuestDetails, beginPayStep, recordCheckoutSession } from "../../lib/booking-db/repo.js";
import { claimNextOperation, completeOperation, recoverExpiredOperations } from "../../lib/booking-db/operations.js";
import { runOrchestratorStep, reservationWorkerGate, LIMITS } from "../../lib/booking-db/reservation-worker.js";
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
function world({ currency = "MXN", blocked = new Set(), nightly = 1600 } = {}) {
  const w = { calls: [], reservations: [], nextId: 700000 + Math.floor(Math.random() * 1000) * 100, createMode: "ok", lookupMode: "ok", retrieveMode: "ok",
    pricingMode: "ok", onCreate: null, onPricing: null, nightly, currency };
  const days = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push({ date: d, status: blocked.has(d) ? "booked" : "available", isAvailable: blocked.has(d) ? 0 : 1, minimumStay: 1, maximumStay: 90, closedOnArrival: 0, closedOnDeparture: 0 }); return out; };
  const full = (r) => ({ id: r.id, listingMapId: r.listingMapId, channelId: 2000, arrivalDate: r.arrivalDate, departureDate: r.departureDate, totalPrice: r.totalPrice,
    currency: r.currency, status: r.status, customFieldValues: [{ customFieldId: REF_FIELD, value: r.ref }] });
  w.pricing = {
    get: async (path, opts = {}) => {
      w.calls.push(`GET ${path}`);
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
    lookupPage: async (req) => {
      w.calls.push(`LOOKUP ${req.query.listingId}${req.query.afterId ? ` after ${req.query.afterId}` : ""}`);
      if (w.lookupMode === "error") return { httpStatus: 500, json: null };
      if (req.query.afterId) return { httpStatus: 200, json: { status: "success", result: [] } };
      const items = w.reservations.filter((r) => r.listingMapId === req.query.listingId && r.arrivalDate === req.query.arrivalStartDate).map(full);
      if (w.lookupMode === "noCurrency") for (const i of items) delete i.currency;
      return { httpStatus: 200, json: { status: "success", result: items } };
    },
    retrieveReservation: async (req) => {
      w.calls.push(`RETRIEVE ${req.path}`);
      const id = Number(/\/reservations\/(\d+)$/.exec(req.path)[1]);
      const r = w.reservations.find((x) => x.id === id);
      if (!r) return { httpStatus: 404, json: { status: "fail" } };
      if (w.retrieveMode === "malformed") return { httpStatus: 200, json: { status: "success", result: { id: "x" } } };
      return { httpStatus: 200, json: { status: "success", result: full(r) } };
    },
    createReservation: async (req) => {
      w.calls.push(`CREATE ${req.body.customFieldValues[0].value}`);
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
  h.clk.t = dc - 30 * 1000;                                            // enough time to dispatch (margin 15 s)
  const r = await h.step({ intentId: c.id, hooks: { afterClaim: async () => { h.clk.t = dc - 10 * 1000; } } });   // op lease still valid
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
  h.clk.t = da - 10 * 1000;                                            // < sendMarginMs left
  const s = await h.step({ intentId: a.id });
  assert.equal(s.actions.at(-1), "ESCALATE:AUTHORIZATION_DEADLINE_PASSED");
  assert.equal((await opsOf(a.id, "hostaway.create_reservation")).length, 0, "nothing dispatched");
  const b = await authorizedIntent(w, L(37));
  h.clk.t = F.at(10);
  await h.step({ intentId: b.id });
  const until = (await loadIntent(db.app, b.id)).lease.until;
  h.clk.t = until - 50 * 1000;                                          // claim here: operation lease runs to until + 10 s
  const r = await h.step({ intentId: b.id, hooks: { afterClaim: async () => { h.clk.t = until - 10 * 1000; } } });   // E3 lease < margin
  assert.deepEqual(r.actions.slice(-2), ["SEND_ABORTED:LEASE", "RESERVATION_OUTCOME_UNKNOWN:SEND_ABORTED_LEASE"]);
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
