// E7 OPERATOR TEST release (lost guest token recovery) — O1..O15 on a throwaway local PostgreSQL. OFFLINE ONLY.
// LABELS:
//   * Every Stripe / Hostaway object is an in-memory FAKE (no network, SDK client, key or credential). Webhook events reach
//     processVerifiedStripeEvent as if Stripe's signature check passed (that check is covered offline elsewhere).
//   * Runtime code runs as the app role. "OWNER FIXTURE" = a superuser write with session_replication_role=replica (triggers off) that NO
//     runtime writer can perform; it exists only to put a fact the guards must refuse in front of them. It is never evidence of a
//     production path. Every refusal is checked byte-for-byte against a full owner snapshot of the intent's rows.
//   * O12 (accepted cleanup runner compatibility) is OPT-IN: E7_PINNED_RUNNER_DIR (main 5b60d705 worktree) + E7_PINNED_TOOLING_DIR (6d703acd
//     worktree); both are digest-verified with the runner's own framedDigest before anything is imported from them.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { startMigratedDatabase } from "./harness.mjs";
import { createIntentApiHandler } from "../../lib/checkout/intent-api-http.js";
import { processVerifiedStripeEvent } from "../../lib/checkout/stripe-test-webhook.js";
import { loadIntent, applyEvent, requestTestRelease, validOperatorExpectation, tryReleaseClaim } from "../../lib/booking-db/repo.js";
import { runCleanupStep } from "../../lib/booking-db/compensation-worker.js";
import { _internal as RW, WORK_STATES as RESERVATION_WORK_STATES } from "../../lib/booking-db/reservation-worker.js";
import { validateAdapterConfig } from "../../lib/hostaway-reservations.js";
import { voidKey, testReleaseEventId } from "../../lib/checkout/intent-state.js";
import { ENV_OK } from "../e5a-fixtures.mjs";
import { addDays } from "../../lib/bookability.js";
import * as OP from "../../scripts/e7-operator/test-release.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused"); };

let db, pool2;
before(async () => { db = await startMigratedDatabase(); pool2 = new pg.Pool({ connectionString: db.appUrl(), max: 4 }); });
after(async () => { globalThis.fetch = realFetch; await pool2.end(); await db.close(); assert.equal(netAttempts, 0); });

const LISTING = 606998;
const ORIGIN = "https://preview.example.invalid";
const RUNNER_ACCT = "acct_1TyHE42B9LTneQgw";                     // = the accepted runner's CONSTANTS.accountId (O12 binds to it)
const ENV = Object.freeze({ ...ENV_OK, STRIPE_TEST_ACCOUNT_ID: RUNNER_ACCT, MV_CHECKOUT_TEST_API: "enabled", MV_CHECKOUT_ALLOWED_ORIGIN: ORIGIN,
  MV_CHECKOUT_TEST_LISTINGS: `${LISTING}:USD`, MV_RATE_LIMIT_SALT: "s".repeat(40), MV_CHECKOUT_TERMS_VERSION: "terms-2026-11", MV_CHECKOUT_TEST_RELEASE: "enabled" });
const ENV_K = Object.freeze({ VERCEL_ENV: "development", MV_E7_COMPENSATION_WORKER: "enabled" });
const ACCT = RUNNER_ACCT;
const NOW0 = Date.UTC(2026, 10, 2, 20, 0, 0);
const MIN = 60 * 1000; const DAY = 24 * 60 * MIN;
const T_REL = NOW0 + 6 * MIN;
const LABEL = "joel-e7-guest-test-run2-lost-token-20261106";
const GUEST = { firstName: "Zanabria", lastName: "Quintessa", email: "zq.operator.guest@example.test" };
const clone = (o) => JSON.parse(JSON.stringify(o));
const sec = (ms) => Math.floor(ms / 1000);
const pad = (n) => String(n).padStart(8, "0");
let seq = 0; let stayN = 0;

// ---------- fake provider world (ids long enough for the operator / runner id patterns) ----------
function world() {
  const w = { calls: [], wire: [], writes: { cancelPaymentIntent: 0, hostaway: 0 }, sessions: new Map(), pis: new Map() };
  const strip = (s) => { const { _pim, ...r } = s; return clone(r); };
  w.stripe = {
    accounts: { retrieve: async () => { w.calls.push("sdk:account"); return { object: "account", id: ACCT }; } },
    checkout: { sessions: {
      create: async (params) => {
        w.calls.push("sdk:session.create");
        const id = `cs_test_Op${pad(++seq)}`; const pd = params.line_items[0].price_data;
        const s = { object: "checkout.session", id, livemode: false, mode: "payment", status: "open", payment_status: "unpaid", amount_total: pd.unit_amount, currency: pd.currency,
          client_reference_id: params.client_reference_id, metadata: { ...params.metadata }, expires_at: params.expires_at, url: `https://checkout.stripe.com/c/pay/${id}`,
          payment_intent: null, customer_details: null, _pim: params.payment_intent_data };
        w.sessions.set(id, s); return strip(s);
      },
      retrieve: async (id) => { w.calls.push("sdk:session.retrieve"); return strip(w.sessions.get(id)); } } },
    paymentIntents: { retrieve: async (id) => { w.calls.push("sdk:pi.retrieve"); return clone(w.pis.get(id)); } }
  };
  w.hostaway = {
    get: async (path, opts = {}) => {
      w.calls.push(`hostaway GET ${path}`);
      const m = /^\/listings\/(\d+)(\/calendar)?$/.exec(path);
      if (!m[2]) return { status: 200, json: { result: { id: Number(m[1]), currencyCode: "USD", personCapacity: 4, minNights: 1, maxNights: 90 } } };
      const out = []; for (let d = opts.query.startDate; d <= opts.query.endDate; d = addDays(d, 1)) out.push({ date: d, status: "available", isAvailable: 1, minimumStay: 1, maximumStay: 90, closedOnArrival: 0, closedOnDeparture: 0 });
      return { status: 200, json: { result: out } };
    },
    post: async (path, body) => {
      w.calls.push(`hostaway POST ${path}`);
      const nights = Math.round((Date.parse(body.endingDate) - Date.parse(body.startingDate)) / DAY);
      const comps = [{ id: 1, type: "accommodation", name: "baseRate", title: "Base rate", quantity: 1, value: 125, total: 125 * nights, isIncludedInTotalPrice: 1, isMandatory: 1, isOverriddenByUser: 0, isDeleted: 0, units: nights }];
      return { status: 200, json: { status: "success", result: { totalPrice: comps[0].total, components: comps } } };
    }
  };
  w.pay = (sessionId, authAtMs) => {
    const s = w.sessions.get(sessionId); const piId = `pi_Op${pad(++seq)}`;
    s.status = "complete"; s.payment_intent = piId; s.customer_details = { email: "guest@example.invalid", name: "Guest Person" };
    w.pis.set(piId, { object: "payment_intent", id: piId, livemode: false, status: "requires_capture", capture_method: s._pim.capture_method, amount: s.amount_total,
      amount_capturable: s.amount_total, amount_received: 0, currency: s.currency, metadata: { ...s._pim.metadata },
      latest_charge: { object: "charge", id: `ch_Op${pad(seq)}`, livemode: false, payment_intent: piId, captured: false, amount: s.amount_total, amount_captured: 0, amount_refunded: 0,
        currency: s.currency, status: "succeeded", paid: true, created: sec(authAtMs), payment_method_details: { type: "card", card: { capture_before: sec(authAtMs + 7 * DAY), last4: "4242" } } } });
    return piId;
  };
  w.event = (sessionId, t) => ({ id: `evt_Op${pad(++seq)}`, object: "event", type: "checkout.session.completed", livemode: false, created: sec(t), api_version: "2026-01-28.clover",
    data: { object: strip(w.sessions.get(sessionId)) } });
  const hostawayNever = (k) => async () => { w.calls.push(`exec:${k}`); w.writes.hostaway += 1; throw new Error(`${k} must not be called`); };
  w.cleanup = {
    retrieveAccount: async () => { w.calls.push("exec:retrieveAccount"); return { object: "account", id: ACCT }; },
    retrievePaymentIntent: async (id) => { w.calls.push("exec:retrievePaymentIntent"); return clone(w.pis.get(id)); },
    cancelPaymentIntent: async (id, params, opts) => {
      w.calls.push("exec:cancelPaymentIntent"); w.writes.cancelPaymentIntent += 1; w.voidKeys = [...(w.voidKeys || []), opts && opts.idempotencyKey];
      const p = w.pis.get(id); p.status = "canceled"; p.amount_capturable = 0; return clone(p);
    },
    retrieveReservation: hostawayNever("retrieveReservation"), lookupPage: hostawayNever("lookupPage"), cancelReservation: hostawayNever("cancelReservation")
  };
  // HTTP side for the accepted runner's REAL transport (O12)
  const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
  w.exchange = (req) => {
    const reply = (o) => Promise.resolve({ status: 200, contentType: "application/json", bytes: enc(o) });
    if (req.method === "GET" && req.url === "https://api.stripe.com/v1/account") { w.wire.push("account"); return reply({ object: "account", id: ACCT }); }
    const m = /^https:\/\/api\.stripe\.com\/v1\/payment_intents\/(pi_[A-Za-z0-9]+)(\/cancel|\?expand%5B%5D=latest_charge)$/.exec(req.url);
    if (m && req.method === "GET" && m[2].startsWith("?")) { w.wire.push("pi"); return reply(clone(w.pis.get(m[1]))); }
    if (m && req.method === "POST" && m[2] === "/cancel") { w.wire.push("cancel"); const p = w.pis.get(m[1]); p.status = "canceled"; p.amount_capturable = 0; return reply(clone(p)); }
    w.wire.push("UNEXPECTED"); return Promise.reject(new Error("unexpected"));
  };
  return w;
}
function handlers(w, { clock }) {
  const deps = {
    createPool: () => db.app, loadCore: async () => import("../../lib/checkout/intent-api-core.js"), loadAccess: async () => import("../../lib/booking-db/intent-access.js"),
    createStripe: () => w.stripe, createHostaway: () => w.hostaway,
    loadStripe: async () => { throw new Error("SDK must not load"); }, loadHostaway: async () => { throw new Error("real Hostaway must not load"); },
    now: () => clock.now, log: () => {}, onError: (e) => { throw e; }
  };
  return { intents: createIntentApiHandler({ route: "intents", env: ENV, deps }), step: createIntentApiHandler({ route: "step", env: ENV, deps }) };
}
function call(handler, { method = "POST", body, token } = {}) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method; req.url = "/api/checkout/x";
  req.headers = { origin: ORIGIN, ...(method === "POST" ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const res = { statusCode: 0, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b ? JSON.parse(b) : null; } };
  return handler(req, res).then(() => res);
}
const q = async (sql, p = []) => (await db.app.query(sql, p)).rows;
const idOfToken = async (token) => (await import("../../lib/booking-db/intent-access.js")).findIntentIdByTokenHash(db.app, (await import("../../lib/checkout/intent-api-http.js")).hashToken(token));

/** HTTP create -> details -> pay -> the guest pays -> verified completed webhook -> payment_authorized. The token is then "lost". */
async function booking() {
  const w = world(); const clock = { now: NOW0 }; const h = handlers(w, { clock });
  const from = addDays("2027-05-01", 4 * stayN++);
  const c = await call(h.intents, { body: { listingId: LISTING, from, to: addDays(from, 3), guests: 2 } });
  assert.equal(c.statusCode, 201, JSON.stringify(c.body));
  const token = c.body.token; const id = await idOfToken(token);
  clock.now += 1000;
  assert.equal((await call(h.step, { body: { step: "details", ...GUEST, termsVersion: "terms-2026-11" }, token })).statusCode, 200);
  clock.now += 1000;
  assert.equal((await call(h.step, { body: { step: "pay" }, token })).statusCode, 200);
  const sessionId = [...w.sessions.keys()][0];
  clock.now = NOW0 + 4 * MIN;
  const piId = w.pay(sessionId, clock.now - 30 * 1000);
  const ev = w.event(sessionId, clock.now);
  assert.deepEqual(await processVerifiedStripeEvent(db.app, ev, { stripe: w.stripe, now: clock.now, accountId: ACCT, accountCache: {} }),
    { http: 200, code: "APPLIED", state: "payment_authorized" });
  return { w, h, clock, token, id, sessionId, piId, eventId: ev.id };
}
/** the operator's expectation, built from what the owner reads back for this intent (the G9-style binding SELECT) */
async function expectation(b, over = {}) {
  const i = await loadIntent(db.app, b.id);
  const a = (await q("SELECT id::text AS id FROM booking.payment_attempts WHERE intent_id = $1 AND status = 'completed'", [b.id]))[0];
  const e = OP.buildOperatorExpectation({ intentId: b.id, expectedVersion: i.version, listingId: LISTING, from: i.from, to: i.to, guests: i.guests, currency: "USD",
    finalTotalMinor: i.price.finalTotalMinor, authorizedMinor: i.payment.amountMinor, paymentIntentId: i.payment.paymentIntentId, sessionId: i.checkout.sessionId,
    attemptId: a.id, approvalRef: LABEL, ...over });
  assert.ok(e, "expectation must validate");
  return e;
}
/** OWNER FIXTURE (superuser, triggers off): a fact no runtime writer can produce. Committed. */
async function own(sql, p = []) {
  const c = await db.owner.connect();
  try { await c.query("BEGIN"); await c.query("SET LOCAL session_replication_role = replica"); const r = await c.query(sql, p); await c.query("COMMIT"); return r; }
  catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}
/** lock probe: an owner FOR UPDATE NOWAIT on the row; 55P03 = the row is share-locked by the open transaction */
async function lockedNow(table, where, p) {
  const c = await db.owner.connect();
  try { await c.query("BEGIN"); await c.query(`SELECT 1 FROM booking.${table} WHERE ${where} FOR UPDATE NOWAIT`, p); return false; }
  catch (e) { if (e.code === "55P03") return true; throw e; } finally { await c.query("ROLLBACK").catch(() => {}); c.release(); }
}
const SNAP_TABLES = [["intents", "id"], ["intent_transitions", "intent_id"], ["intent_applied_events", "intent_id"], ["external_operations", "intent_id"],
  ["payment_ledger", "intent_id"], ["inventory_claims", "intent_id"], ["payment_attempts", "intent_id"], ["stripe_webhook_events", "intent_id"], ["intent_work", "intent_id"],
  ["hostaway_reservation_attempts", "intent_id"], ["reconciliation_cases", "intent_id"]];
/** every row of every table bound to the intent, as owner-read JSON (byte-equality = nothing persisted) */
async function fullSnap(id) {
  const out = {};
  for (const [t, col] of SNAP_TABLES) out[t] = (await db.owner.query(`SELECT to_jsonb(x)::text AS j FROM booking.${t} x WHERE x.${col} = $1 ORDER BY 1`, [id])).rows.map((r) => r.j);
  return out;
}
const counts = async (id) => ({
  transitions: Number((await q("SELECT count(*) AS n FROM booking.intent_transitions WHERE intent_id = $1", [id]))[0].n),
  voids: Number((await q("SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'stripe.void_payment_intent'", [id]))[0].n)
});
const once = (fn) => { let done = false; return async (...a) => { if (done) return; done = true; await fn(...a); }; };
/** direct helper call; the refusal must leave every bound row byte-equal to the snapshot taken AFTER the fixture/barrier write */
async function refusedAtomically(b, e, code, { fixture = null, barrier = null, extra = {} } = {}) {
  if (fixture) await fixture();
  let s0 = fixture || !barrier ? await fullSnap(b.id) : null;
  const seen = [];
  const hooks = { afterLoad: async (attempt) => { seen.push(attempt); if (barrier && attempt === 0) { await barrier(); s0 = await fullSnap(b.id); } }, ...extra };
  const calls0 = b.w.calls.length;
  const r = await requestTestRelease(db.app, b.id, { now: T_REL, operator: e, hooks });
  assert.deepEqual(r, { ok: false, error: code });
  assert.deepEqual(await fullSnap(b.id), s0, `${code}: nothing persisted`);
  assert.equal(b.w.calls.length, calls0, "zero provider calls");
  return { seen };
}
const cleanup = (b, t) => runCleanupStep(db.app, { workerId: "op-cln", env: ENV_K,
  adapterConfig: validateAdapterConfig({ allowedListingIds: [LISTING], refFieldId: 777011, channelId: 2000, currency: "USD" }),
  listings: new Map([[LISTING, { currency: "USD", timeZone: "America/Mazatlan" }]]), executors: b.w.cleanup, clock: () => t, stripeAccountId: ACCT, intentId: b.id });
function F_ok(r, msg) { assert.equal(r && r.ok, true, `${msg || ""} ${JSON.stringify(r && (r.error || r))}`); return r; }

// =====================================================================================================================
test("O1 guest path unchanged: releaseIntent passes no operator (static); a guest HTTP release still writes actor 'guest'", async () => {
  const core = readFileSync(join(ROOT, "lib/checkout/intent-api-core.js"), "utf8");
  assert.ok(core.includes("const r = await requestTestRelease(ctx.pool, intentId, { now: ctx.now });"));
  assert.doesNotMatch(core, /operator|TEST_RELEASE_OPERATOR/);
  assert.doesNotMatch(readFileSync(join(ROOT, "lib/checkout/intent-api-http.js"), "utf8"), /operator|TEST_RELEASE_OPERATOR/);
  const b = await booking();
  b.clock.now = T_REL;
  const r = await call(b.h.step, { body: { step: "release" }, token: b.token });
  assert.deepEqual([r.statusCode, r.body], [202, { status: "release_requested", release: "REQUESTED" }]);
  assert.deepEqual(await q("SELECT actor, event_type FROM booking.intent_transitions WHERE intent_id = $1 AND event_type = 'TEST_RELEASE_REQUESTED'", [b.id]),
    [{ actor: "guest", event_type: "TEST_RELEASE_REQUESTED" }]);
});

test("O2 happy: wrapper ELIGIBLE -> ONE helper call -> REQUESTED: actor admin at expectedVersion+1, one pristine void (row key v<n>, provider key = voidKey), claim held, ledger unchanged, zero provider calls", async () => {
  const b = await booking();
  const e = await expectation(b);
  const ledger0 = await q("SELECT entry, amount_minor FROM booking.payment_ledger WHERE intent_id = $1 ORDER BY id", [b.id]);
  const calls0 = b.w.calls.length;
  let n = 0;
  const spy = (...a) => { n += 1; return requestTestRelease(...a); };
  const pre = await OP.classify(db.app, e);
  assert.deepEqual([pre.class, pre.code, pre.version], ["ELIGIBLE", null, e.expectedVersion]);
  const r = await OP.executeOperatorRelease(db.app, e, { now: T_REL, deps: { requestTestRelease: spy } });
  assert.equal(r.outcome, "REQUESTED", JSON.stringify(r));
  assert.equal(n, 1, "one logical call");
  assert.deepEqual([r.reconciled.class, r.reconciled.releaseVersion, r.reconciled.releaseActor, r.reconciled.releasedAtExpectedVersion, r.reconciled.claimAnomaly],
    ["ALREADY_REQUESTED", e.expectedVersion + 1, "admin", true, false]);
  const tr = await q("SELECT version_after, event_id, actor, reason_code FROM booking.intent_transitions WHERE intent_id = $1 AND event_type = 'TEST_RELEASE_REQUESTED'", [b.id]);
  assert.deepEqual(tr, [{ version_after: e.expectedVersion + 1, event_id: testReleaseEventId(b.id, b.piId), actor: "admin", reason_code: "TEST_RELEASE_REQUESTED" }]);
  const v = await q(`SELECT state, attempts, dispatched_at, idempotency_key, payload ->> 'providerIdempotencyKey' AS pk FROM booking.external_operations
    WHERE intent_id = $1 AND op_type = 'stripe.void_payment_intent'`, [b.id]);
  assert.deepEqual(v, [{ state: "pending", attempts: 0, dispatched_at: null, idempotency_key: `void:${b.id}:v${e.expectedVersion + 1}`, pk: voidKey(b.id, b.piId) }]);
  assert.equal((await q("SELECT released_at FROM booking.inventory_claims WHERE intent_id = $1", [b.id]))[0].released_at, null);
  assert.deepEqual(await q("SELECT entry, amount_minor FROM booking.payment_ledger WHERE intent_id = $1 ORDER BY id", [b.id]), ledger0);
  assert.equal(b.w.calls.length, calls0);
  // a second execute: precheck ALREADY_REQUESTED -> no call at all
  const again = await OP.executeOperatorRelease(db.app, e, { now: T_REL + MIN, deps: { requestTestRelease: spy } });
  assert.deepEqual([again.outcome, n], ["NOT_EXECUTED_ALREADY_REQUESTED", 1]);
});

test("O3 invalid shape: every unknown / missing / ill-typed key, intentId mismatch, final != authorized, bad dates / guests / scope -> OPERATOR_INVALID with ZERO DB access", async () => {
  const b = await booking();
  const e = await expectation(b);
  const dead = { query: async () => { throw new Error("DB touched"); }, connect: async () => { throw new Error("DB touched"); } };
  const bad = [
    { ...e, extra: 1 }, (() => { const { guests, ...x } = e; return x; })(), { ...e, expectedVersion: "4" }, { ...e, expectedVersion: -1 }, { ...e, expectedVersion: 1.5 },
    { ...e, intentId: "9b1d2c4b-5a69-4e7d-8f01-23456789abcd" }, { ...e, authorizedMinor: e.finalTotalMinor + 1 }, { ...e, finalTotalMinor: 0, authorizedMinor: 0 },
    { ...e, from: "2027-02-30" }, { ...e, from: e.to }, { ...e, to: "2027/05/04" }, { ...e, guests: 0 }, { ...e, guests: 17 }, { ...e, guests: 2.5 },
    { ...e, listingId: 606999 }, { ...e, listingId: "606998" }, { ...e, currency: "EUR" }, { ...e, paymentIntentId: "pi_short" }, { ...e, sessionId: "cs_live_Abcdefgh123" },
    { ...e, attemptId: "not-a-uuid" }, { ...e, approvalRef: "bad label!" }, { ...e, planHash: "A".repeat(64) }, { ...e, planHash: "0".repeat(63) },
    Object.assign(Object.create({ inherited: true }), e), Object.assign(Object.create(null), e), [e], null, "x"
  ];
  for (const x of bad) {
    assert.deepEqual(await requestTestRelease(dead, b.id, { now: T_REL, operator: x }), { ok: false, error: "TEST_RELEASE_OPERATOR_INVALID" }, JSON.stringify(x));
    assert.equal((await OP.classify(dead, x)).class, "INVALID");
  }
  // well-shaped but the plan hash does not bind the fields: the HELPER accepts the shape; the WRAPPER refuses before any DB access
  const rebound = { ...e, guests: e.guests + 1 };
  assert.equal(validOperatorExpectation(rebound, b.id), true);
  assert.deepEqual([(await OP.classify(dead, rebound)).class, (await OP.executeOperatorRelease(dead, rebound, { now: T_REL })).outcome], ["INVALID", "NOT_EXECUTED_INVALID"]);
  assert.equal(OP.buildOperatorExpectation({ ...e }), null, "planHash supplied by the caller is refused");
});

test("O4 stale fail-fast: expectedVersion behind the intent -> OPERATOR_STALE before any transaction; the wrapper classifies NOT_ELIGIBLE:STALE and never calls", async () => {
  const b = await booking();
  const e = await expectation(b, { expectedVersion: (await loadIntent(db.app, b.id)).version - 1 });
  let connects = 0;
  const counting = { query: (...a) => db.app.query(...a), connect: async () => { connects += 1; return db.app.connect(); } };
  const s0 = await fullSnap(b.id);
  assert.deepEqual(await requestTestRelease(counting, b.id, { now: T_REL, operator: e }), { ok: false, error: "TEST_RELEASE_OPERATOR_STALE" });
  assert.equal(connects, 0, "no transaction was opened");
  let n = 0;
  const r = await OP.executeOperatorRelease(db.app, e, { now: T_REL, deps: { requestTestRelease: async () => { n += 1; return { ok: false, error: "X" }; } } });
  assert.deepEqual([r.outcome, r.code, n], ["NOT_EXECUTED_NOT_ELIGIBLE", "STALE", 0]);
  assert.deepEqual(await fullSnap(b.id), s0);
});

test("O5 stale guard under the lock: (a) OWNER FIXTURE bumps the version of a STILL-ELIGIBLE intent between load and lock -> CAS reload -> OPERATOR_STALE, never adopted; (b) separate REAL-writer race (not a stale-guard proof)", async () => {
  // (a) the transition accepts the reloaded intent (still payment_authorized, same facts); ONLY O-a can refuse it
  const a = await booking();
  const e = await expectation(a);
  const { seen } = await refusedAtomically(a, e, "TEST_RELEASE_OPERATOR_STALE", { barrier: async () => {
    // OWNER FIXTURE: no runtime writer bumps without a transition. The PAYMENT_AUTHORIZED row moves with it so it stays the LATEST
    // transition: O-f then passes and ONLY the in-lock stale guard (O-a) can refuse (mutant M1 commits here).
    await own("UPDATE booking.intents SET version = version + 1 WHERE id = $1", [a.id]);
    await own("UPDATE booking.intent_transitions SET version_after = version_after + 1 WHERE intent_id = $1 AND event_type = 'PAYMENT_AUTHORIZED'", [a.id]);
  } });
  assert.deepEqual(seen, [0, 1], "the lost version race reloaded once and the reload reached inTx");
  const i = await loadIntent(db.app, a.id);
  assert.deepEqual([i.status, i.version], ["payment_authorized", e.expectedVersion + 1], "the newer version is still eligible by state: only the stale guard refused");
  assert.deepEqual(await counts(a.id), { transitions: 5, voids: 0 });
  // (b) REAL writers (reservation start + recovery) commit between load and lock: the newer version is back in payment_authorized but the
  //     transition itself refuses (history). This is a state-machine refusal and is NOT offered as proof of the stale guard.
  const b = await booking();
  const eb = await expectation(b);
  const r = await requestTestRelease(db.app, b.id, { now: T_REL, operator: eb, hooks: { afterLoad: once(async () => {
    F_ok(await applyEvent(pool2, b.id, { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: true, priceSame: true } }, { now: T_REL, actor: "worker", workerId: "w1" }));
    F_ok(await applyEvent(pool2, b.id, { type: "RECOVER_INTERRUPTED", id: "rec-o5" }, { now: T_REL + 30 * MIN, actor: "reconciler" }));
  }) } });
  assert.deepEqual([r.ok, r.error], [false, "TEST_RELEASE_HISTORY"]);
  assert.deepEqual([(await loadIntent(db.app, b.id)).status, (await counts(b.id)).voids], ["payment_authorized", 0]);
});

test("O6 reservation race both orders through the wrapper: start committed after the precheck -> REFUSED, zero release rows; release first -> the start refuses, no Hostaway effect", async () => {
  const a = await booking();
  const ea = await expectation(a);
  const r = await OP.executeOperatorRelease(db.app, ea, { now: T_REL, hooks: { afterLoad: once(async () => {
    F_ok(await applyEvent(pool2, a.id, { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: true, priceSame: true } }, { now: T_REL, actor: "worker", workerId: "w1" }));
  }) } });
  assert.deepEqual([r.precheck.class, r.outcome, r.code, r.reconciled.class], ["ELIGIBLE", "REFUSED", "ILLEGAL_TRANSITION", "NOT_ELIGIBLE"]);
  assert.deepEqual([(await loadIntent(db.app, a.id)).status, (await counts(a.id)).voids], ["reservation_pending", 0]);
  const b = await booking();
  assert.equal((await OP.executeOperatorRelease(db.app, await expectation(b), { now: T_REL })).outcome, "REQUESTED");
  const rs = await applyEvent(db.app, b.id, { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: true, priceSame: true } }, { now: T_REL + MIN, actor: "worker", workerId: "w1" });
  assert.deepEqual([rs.ok, rs.error], [false, "ILLEGAL_TRANSITION"]);
  assert.deepEqual(await q("SELECT op_type FROM booking.external_operations WHERE intent_id = $1 AND op_type LIKE 'hostaway.%'", [b.id]), []);
});

test("O7 payment / attempt drift: precheck-to-write barriers (wrapper ELIGIBLE, then the fact moves before the lock) and static mismatches -> OPERATOR_PAYMENT / OPERATOR_ATTEMPT, rolled back; the attempt row is share-locked to commit", async () => {
  const attemptDrift = [
    ["amount", "UPDATE booking.payment_attempts SET amount_minor = amount_minor + 1 WHERE intent_id = $1"],
    ["pi", "UPDATE booking.payment_attempts SET payment_intent_id = 'pi_OpForeign00000001' WHERE intent_id = $1"],
    ["livemode", "UPDATE booking.payment_attempts SET livemode = true WHERE intent_id = $1"],
    ["currency", "UPDATE booking.payment_attempts SET currency = 'MXN' WHERE intent_id = $1"]
  ];
  for (const [label, sql] of attemptDrift) {
    const b = await booking();
    const e = await expectation(b);
    let s0;
    const r = await OP.executeOperatorRelease(db.app, e, { now: T_REL, hooks: { afterLoad: once(async () => { await own(sql, [b.id]); s0 = await fullSnap(b.id); }) } });
    assert.deepEqual([r.precheck.class, r.outcome, r.code], ["ELIGIBLE", "REFUSED", "TEST_RELEASE_OPERATOR_ATTEMPT"], `${label} ${r.errorClass}`);
    assert.deepEqual([r.reconciled.class, r.reconciled.code], ["NOT_ELIGIBLE", "ATTEMPT_MISMATCH"], label);
    assert.deepEqual(await fullSnap(b.id), s0, `${label}: rolled back`);
  }
  // payment: the DB facts cannot be made inconsistent without the state machine / CHECKs refusing first (PI -> TEST_RELEASE_PAYMENT_MISMATCH,
  // amount / currency -> price_snapshot_matches), so O-c is exercised from the EXPECTATION side: a foreign PI in a well-formed expectation
  const p1 = await booking();
  await refusedAtomically(p1, await expectation(p1, { paymentIntentId: "pi_OpForeign00000002" }), "TEST_RELEASE_OPERATOR_PAYMENT");
  // ... and every runtime intents write bumps the version, so moved intent facts surface as STALE at the barrier (O5 owner fixture)
  // lock-held proof: inside the release transaction (beforeCommit) the attempt row cannot be locked for update; after commit it can
  const k = await booking();
  let during = null;
  F_ok(await requestTestRelease(db.app, k.id, { now: T_REL, operator: await expectation(k), hooks: { beforeCommit: async () => {
    during = await lockedNow("payment_attempts", "intent_id = $1", [k.id]);
  } } }));
  assert.equal(during, true, "payment_attempts FOR SHARE held until commit");
  assert.equal(await lockedNow("payment_attempts", "intent_id = $1", [k.id]), false);
});

test("O8 evidence: missing / unprocessed / livemode / foreign webhook row, unsettled reads, a second or non-latest PAYMENT_AUTHORIZED -> OPERATOR_EVIDENCE, rolled back; barriers + webhook / op lock-held proofs", async () => {
  const statics = [
    ["missing", (id) => own("UPDATE booking.stripe_webhook_events SET intent_id = NULL WHERE intent_id = $1", [id])],
    ["unprocessed", (id) => own("UPDATE booking.stripe_webhook_events SET status = 'received' WHERE intent_id = $1", [id])],
    ["livemode", (id) => own("UPDATE booking.stripe_webhook_events SET livemode = true WHERE intent_id = $1", [id])],
    ["foreign object", (id) => own("UPDATE booking.stripe_webhook_events SET object_id = 'cs_test_OpForeign0001' WHERE intent_id = $1", [id])],
    ["no settled PI read", (id) => own("UPDATE booking.external_operations SET state = 'failed_definite' WHERE intent_id = $1 AND op_type = 'stripe.retrieve_payment_intent'", [id])],
    ["no settled session read", (id) => own("UPDATE booking.external_operations SET state = 'superseded' WHERE intent_id = $1 AND op_type = 'stripe.retrieve_checkout_session'", [id])],
    ["second PAYMENT_AUTHORIZED", (id) => own(`UPDATE booking.intent_transitions SET event_type = 'PAYMENT_AUTHORIZED'
      WHERE intent_id = $1 AND to_state = 'payment_pending'`, [id])],
    ["PAYMENT_AUTHORIZED not latest", (id) => own(`UPDATE booking.intent_transitions SET event_type = CASE WHEN to_state = 'payment_pending' THEN 'PAYMENT_AUTHORIZED' ELSE 'PAYMENT_STARTED' END
      WHERE intent_id = $1 AND to_state IN ('payment_pending', 'payment_authorized')`, [id])]
  ];
  for (const [label, fx] of statics) {
    const b = await booking();
    const e = await expectation(b);
    await fx(b.id);
    assert.equal((await OP.classify(db.app, e)).class === "ELIGIBLE", false, `${label}: the wrapper precheck refuses too`);
    await refusedAtomically(b, e, "TEST_RELEASE_OPERATOR_EVIDENCE");
  }
  // precheck-to-write barriers through the wrapper
  for (const [label, sql] of [["webhook moved", "UPDATE booking.stripe_webhook_events SET status = 'failed_retryable' WHERE intent_id = $1"],
    ["read moved", "UPDATE booking.external_operations SET state = 'failed_definite' WHERE intent_id = $1 AND op_type = 'stripe.retrieve_payment_intent'"]]) {
    const b = await booking();
    let s0;
    const r = await OP.executeOperatorRelease(db.app, await expectation(b), { now: T_REL, hooks: { afterLoad: once(async () => { await own(sql, [b.id]); s0 = await fullSnap(b.id); }) } });
    assert.deepEqual([r.precheck.class, r.outcome, r.code, r.reconciled.code], ["ELIGIBLE", "REFUSED", "TEST_RELEASE_OPERATOR_EVIDENCE", "EVIDENCE"], label);
    assert.deepEqual(await fullSnap(b.id), s0, label);
  }
  const k = await booking();
  const held = {};
  F_ok(await requestTestRelease(db.app, k.id, { now: T_REL, operator: await expectation(k), hooks: { beforeCommit: async () => {
    held.webhook = await lockedNow("stripe_webhook_events", "intent_id = $1", [k.id]);
    held.ops = await lockedNow("external_operations", "intent_id = $1 AND op_type LIKE 'stripe.retrieve_%'", [k.id]);
  } } }));
  assert.deepEqual(held, { webhook: true, ops: true });
});

test("O9 claim: released / wrong stay / wrong kind -> OPERATOR_CLAIM; the real claim writer refuses concurrently; a concurrent intent-locked writer queues behind the release (no deadlock) and resolves deterministically", async () => {
  const statics = [
    ["released", (id) => own("UPDATE booking.inventory_claims SET released_at = now(), release_reason = 'INTENT_PAYMENT_EXPIRED' WHERE intent_id = $1", [id])],
    ["wrong stay", (id) => own("UPDATE booking.inventory_claims SET stay = daterange(lower(stay), upper(stay) + 1) WHERE intent_id = $1", [id])],
    // (two active claims for one intent are impossible: unique inventory_one_active_claim_per_intent)
    ["wrong kind", (id) => own("UPDATE booking.inventory_claims SET kind = 'reserved' WHERE intent_id = $1", [id])]
  ];
  for (const [label, fx] of statics) {
    const b = await booking();
    const e = await expectation(b);
    await fx(b.id);
    assert.notEqual((await OP.classify(db.app, e)).class, "ELIGIBLE", label);
    // a RELEASED claim never reaches O-e: the existing DB trigger (CLAIM_REQUIRED) refuses the transition first, equally atomically
    await refusedAtomically(b, e, label === "released" ? "CLAIM_REQUIRED" : "TEST_RELEASE_OPERATOR_CLAIM");
  }
  const k = await booking();
  const ek = await expectation(k);
  let claimHeld = null; let concurrent = null;
  const r = await requestTestRelease(db.app, k.id, { now: T_REL, operator: ek, hooks: { beforeCommit: async () => {
    claimHeld = await tryReleaseClaim(pool2, k.id);                                  // the REAL claim writer, concurrently: refused by its blockers
    concurrent = requestTestRelease(pool2, k.id, { now: T_REL });                     // the GUEST release, same lock order (intent row first)
    await new Promise((res) => setTimeout(res, 80));
  } } });
  F_ok(r);
  const c = await concurrent;
  assert.equal(claimHeld, false, "release_claim_if_safe refuses while the committed state is payment_authorized");
  assert.equal((await q("SELECT released_at FROM booking.inventory_claims WHERE intent_id = $1", [k.id]))[0].released_at, null);
  assert.equal(await tryReleaseClaim(db.app, k.id), false, "and after the commit (void unresolved)");
  assert.deepEqual([c.ok, c.duplicate], [true, true], "queued on the intent row, then saw the committed release: duplicate, never 40P01");
  assert.deepEqual(await counts(k.id), { transitions: 6, voids: 1 });
  assert.equal((await q("SELECT actor FROM booking.intent_transitions WHERE intent_id = $1 AND event_type = 'TEST_RELEASE_REQUESTED'", [k.id]))[0].actor, "admin");
});

test("O10 work lease acquired between the precheck and the write (barrier) -> the existing TEST_RELEASE_WORK_LEASE_HELD, zero release rows", async () => {
  const b = await booking();
  let s0;
  const r = await OP.executeOperatorRelease(db.app, await expectation(b), { now: T_REL, hooks: { afterLoad: once(async () => {
    assert.equal(await RW.claimWork(pool2, { workerId: "res-o10", now: T_REL, leaseMs: 60000, states: [...RESERVATION_WORK_STATES], intentId: b.id, listingIds: [LISTING] }), b.id);
    s0 = await fullSnap(b.id);
  }) } });
  assert.deepEqual([r.precheck.class, r.outcome, r.code], ["ELIGIBLE", "REFUSED", "TEST_RELEASE_WORK_LEASE_HELD"]);
  assert.deepEqual(await fullSnap(b.id), s0);
});

test("O11 ambiguity: reply lost AFTER commit (wrapper layer) -> REQUEST_OUTCOME_UNKNOWN, read-only reconcile ALREADY_REQUESTED, no retry; a throw BEFORE commit only rolls back -> reconcile ELIGIBLE", async () => {
  const a = await booking();
  const ea = await expectation(a);
  let n = 0;
  const spy = (...x) => { n += 1; return requestTestRelease(...x); };
  const r = await OP.executeOperatorRelease(db.app, ea, { now: T_REL, deps: { requestTestRelease: spy, afterReply: async (res) => {
    assert.equal(res.ok, true, "the helper committed and replied"); throw new Error("reply lost");
  } } });
  assert.equal(r.outcome, "REQUEST_OUTCOME_UNKNOWN");
  assert.equal(n, 1, "never re-sent");
  assert.deepEqual([r.reconciled.class, r.reconciled.releasedAtExpectedVersion, r.reconciled.releaseActor], ["ALREADY_REQUESTED", true, "admin"]);
  assert.deepEqual(await counts(a.id), { transitions: 6, voids: 1 });
  const b = await booking();
  const eb = await expectation(b);
  const s0 = await fullSnap(b.id);
  n = 0;
  const rb = await OP.executeOperatorRelease(db.app, eb, { now: T_REL, deps: { requestTestRelease: spy }, hooks: { beforeCommit: async () => { throw new Error("connection dropped before COMMIT"); } } });
  assert.deepEqual([rb.outcome, rb.reconciled.class, n], ["REQUEST_OUTCOME_UNKNOWN", "ELIGIBLE", 1]);
  assert.deepEqual(await fullSnap(b.id), s0, "rolled back");
});

const PINNED_RUNNER = process.env.E7_PINNED_RUNNER_DIR; const PINNED_TOOLING = process.env.E7_PINNED_TOOLING_DIR;
test("O12 accepted cleanup runner (main 5b60d705, tooling 6d703acd, digest-verified): its REAL inspect accepts the admin-actor release; its REAL core + T + worker with a fake Stripe exchange -> RELEASED; repeat -> ALREADY_RELEASED",
  { skip: !(PINNED_RUNNER && PINNED_TOOLING) && "set E7_PINNED_RUNNER_DIR and E7_PINNED_TOOLING_DIR" }, async () => {
    const E = await import(pathToFileURL(join(PINNED_RUNNER, "scripts/e7-checkout-test-cleanup.mjs")).href);
    const C = E.CONSTANTS;
    assert.equal(await E.framedDigest(PINNED_RUNNER, [...C.runnerFiles], E.RUNNER_DIGEST_PREFIX), "eb3fc63c68b4dcf9e6a4ee7ca6992c98ee238fb50f610af66489bc5f6b2a6c62");
    assert.equal(await E.framedDigest(PINNED_TOOLING, [...C.closure], E.CLOSURE_DIGEST_PREFIX), "ce0a418a8b07ed27b6167e2b4b6fbce0e8b2e2e69dcad29318210b799e923c8f");
    assert.equal(C.closureDigest, "ce0a418a8b07ed27b6167e2b4b6fbce0e8b2e2e69dcad29318210b799e923c8f");
    const tool = (p) => import(pathToFileURL(join(PINNED_TOOLING, p)).href);
    const W = await tool("lib/booking-db/compensation-worker.js"); const R = await tool("lib/booking-db/repo.js"); const IS = await tool("lib/checkout/intent-state.js");
    const EA = await tool("scripts/e7-connected/executor-adapters.mjs"); const T = await tool("scripts/e7-connected/http-transports.mjs"); const HR = await tool("lib/hostaway-reservations.js");
    const tooling = { runCleanupStep: W.runCleanupStep, loadIntent: R.loadIntent, voidKey: IS.voidKey, testReleaseEventId: IS.testReleaseEventId,
      createPhaseExecutors: EA.createPhaseExecutors, createStripeSend: T.createE7StripeTestSend, validateAdapterConfig: HR.validateAdapterConfig };
    const b = await booking();
    assert.equal((await OP.executeOperatorRelease(db.app, await expectation(b), { now: T_REL })).outcome, "REQUESTED");
    const plan = E.buildPlan(C, { approvalRef: LABEL, intentId: b.id, paymentIntentId: b.piId, runnerDigest: "0".repeat(64) }).plan;
    const ins = await E.inspect(db.app, plan, tooling);
    assert.deepEqual([ins.ok, ins.terminal, ins.cancelBudget, ins.intent && ins.intent.status], [true, false, 1, "reservation_failed"], JSON.stringify(ins.code));
    const run = () => E.runCleanupCore({ plan, pool: db.app, tooling, exchange: b.w.exchange, credential: () => "sk_test_Fake1", clock: () => NOW0 + 8 * MIN, sleep: async () => {} });
    const r = await run();
    assert.equal(r.outcome, "RELEASED", JSON.stringify(r));
    assert.deepEqual([r.cancelInvocations, r.hostawayCalls, r.voidOpState, r.claimReleased], [1, 0, "succeeded", true]);
    assert.deepEqual(b.w.wire.filter((x) => x === "cancel").length, 1);
    assert.ok(!b.w.wire.includes("UNEXPECTED"));
    const again = await run();
    assert.deepEqual([again.outcome, again.exchanges], ["ALREADY_RELEASED", 0]);
    const cls = await OP.classify(db.app, await expectation(b, { expectedVersion: (await expectationVersionBeforeRelease(b.id)) }));
    assert.deepEqual([cls.class, cls.releaseActor, cls.releasedAtExpectedVersion, cls.claimAnomaly], ["ALREADY_RELEASED", "admin", true, false]);
  });
async function expectationVersionBeforeRelease(id) {
  return (await q("SELECT version_after FROM booking.intent_transitions WHERE intent_id = $1 AND event_type = 'PAYMENT_AUTHORIZED'", [id]))[0].version_after;
}

test("O13 classification is identity + lineage, independent of expectedVersion and actor; ALREADY_RELEASED reports the claim (held = anomaly, no write); foreign intent / PI -> NOT_ELIGIBLE; duplicate / postcheck mapping", async () => {
  // guest-applied release
  const g = await booking();
  const vg = (await loadIntent(db.app, g.id)).version;
  g.clock.now = T_REL;
  assert.equal((await call(g.h.step, { body: { step: "release" }, token: g.token })).statusCode, 202);
  const atV = await OP.classify(db.app, await expectation(g, { expectedVersion: vg }));
  assert.deepEqual([atV.class, atV.releaseActor, atV.releaseVersion, atV.releasedAtExpectedVersion], ["ALREADY_REQUESTED", "guest", vg + 1, true]);
  const offV = await OP.classify(db.app, await expectation(g, { expectedVersion: vg - 2 }));
  assert.deepEqual([offV.class, offV.releaseActor, offV.releasedAtExpectedVersion], ["ALREADY_REQUESTED", "guest", false], "never inferred from actor + version");
  // operator-applied, then the release is executed by the accepted worker (fake executors)
  const o = await booking();
  const eo = await expectation(o);
  assert.equal((await OP.executeOperatorRelease(db.app, eo, { now: T_REL })).outcome, "REQUESTED");
  assert.equal((await OP.classify(db.app, await expectation(o, { expectedVersion: eo.expectedVersion + 3 }))).releasedAtExpectedVersion, false);
  assert.equal((await cleanup(o, NOW0 + 8 * MIN)).status, "worked");
  const rel = await OP.classify(db.app, eo);
  assert.deepEqual([rel.class, rel.claimReleased, rel.claimAnomaly, rel.voidState], ["ALREADY_RELEASED", true, false, "succeeded"]);
  // OWNER FIXTURE: the claim held after a verified void -> still ALREADY_RELEASED, flagged, and execute writes nothing
  await own("UPDATE booking.inventory_claims SET released_at = NULL, release_reason = NULL WHERE intent_id = $1", [o.id]);
  const s0 = await fullSnap(o.id);
  let n = 0;
  const x = await OP.executeOperatorRelease(db.app, eo, { now: T_REL + 9 * MIN, deps: { requestTestRelease: async () => { n += 1; return { ok: true }; } } });
  assert.deepEqual([x.outcome, x.precheck.claimAnomaly, x.precheck.claimReleased, n], ["NOT_EXECUTED_ALREADY_RELEASED", true, false, 0]);
  assert.deepEqual(await fullSnap(o.id), s0);
  // foreign PI / foreign intent
  const f = await booking(); const f2 = await booking();
  assert.deepEqual([(await OP.classify(db.app, await expectation(f, { paymentIntentId: f2.piId }))).code], ["PAYMENT_MISMATCH"]);
  const fe = await expectation(f2);
  const foreignIntent = OP.buildOperatorExpectation({ ...Object.fromEntries(Object.entries(fe).filter(([k]) => k !== "planHash")), intentId: f.id });
  assert.equal((await OP.classify(db.app, foreignIntent)).class, "NOT_ELIGIBLE");
  // the operator path never sees a duplicate (a committed release bumped the version; fail-fast STALE comes first) -> REFUSED + reconcile
  const d = await booking();
  const ed = await expectation(d);
  const r = await OP.executeOperatorRelease(db.app, ed, { now: T_REL, deps: { requestTestRelease: async (p, id, opts) => {
    F_ok(await requestTestRelease(pool2, id, { now: T_REL }));            // the guest release wins first (same intent)
    return requestTestRelease(p, id, opts);
  } } });
  assert.deepEqual([r.outcome, r.code, r.reconciled.class, r.reconciled.releaseActor], ["REFUSED", "TEST_RELEASE_OPERATOR_STALE", "ALREADY_REQUESTED", "guest"]);
  // mapping only (stub replies): a duplicate reply is reconciled, never success; a non-admin release behind an ok reply is POSTCHECK_MISMATCH
  const m = await booking();
  const em = await expectation(m);
  const dup = await OP.executeOperatorRelease(db.app, em, { now: T_REL, deps: { requestTestRelease: async () => ({ ok: true, duplicate: true }) } });
  assert.deepEqual([dup.outcome, dup.reconciled.class], ["DUPLICATE_RECONCILED", "ELIGIBLE"]);
  const pm = await OP.executeOperatorRelease(db.app, em, { now: T_REL, deps: { requestTestRelease: async (p, id) => {
    F_ok(await requestTestRelease(pool2, id, { now: T_REL })); return { ok: true, duplicate: false };
  } } });
  assert.deepEqual([pm.outcome, pm.reconciled.class, pm.reconciled.releaseActor], ["POSTCHECK_MISMATCH", "ALREADY_REQUESTED", "guest"]);
});

test("O14 every operator code refuses atomically (full owner snapshot of every bound row byte-equal), one fixture per code", async () => {
  const cases = [
    ["TEST_RELEASE_OPERATOR_STALE", async (b, e) => ({ e, barrier: () => own("UPDATE booking.intents SET version = version + 1 WHERE id = $1", [b.id]) })],
    ["TEST_RELEASE_OPERATOR_IDENTITY", async (b) => ({ e: await expectation(b, { guests: (await loadIntent(db.app, b.id)).guests + 1 }) })],   // identity columns are immutable + snapshot-bound: expectation side
    ["TEST_RELEASE_OPERATOR_PAYMENT", async (b) => ({ e: await expectation(b, { paymentIntentId: "pi_OpForeign00000004" }) })],
    ["TEST_RELEASE_OPERATOR_ATTEMPT", async (b) => ({ e: await expectation(b, { attemptId: "9b1d2c4b-5a69-4e7d-8f01-23456789abcd" }) })],
    ["TEST_RELEASE_OPERATOR_CLAIM", async (b, e) => ({ e, fixture: () => own("UPDATE booking.inventory_claims SET stay = daterange(lower(stay) - 1, upper(stay)) WHERE intent_id = $1", [b.id]) })],
    ["TEST_RELEASE_OPERATOR_EVIDENCE", async (b, e) => ({ e, fixture: () => own("UPDATE booking.stripe_webhook_events SET status = 'received' WHERE intent_id = $1", [b.id]) })]
  ];
  for (const [code, mk] of cases) {
    const b = await booking();
    const { e, fixture, barrier } = await mk(b, await expectation(b));
    await refusedAtomically(b, e, code, { fixture, barrier });
  }
  // INVALID is O3 (zero DB access at all)
});

test("O15 static: no token hash / guest table / bare payload / write SQL in the wrapper or the operator helpers; the wrapper closure has no provider import", () => {
  const walk = (entry) => {
    const seen = new Set();
    const go = (f) => {
      if (seen.has(f)) return; seen.add(f);
      for (const m of readFileSync(join(ROOT, f), "utf8").matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)) {
        if (m[1].startsWith(".")) go(relative(ROOT, resolve(dirname(join(ROOT, f)), m[1])).replace(/\\/g, "/"));
        else assert.match(m[1], /^node:crypto$/, `external import ${m[1]} in ${f}`);
      }
    };
    go(entry); return [...seen].sort();
  };
  assert.deepEqual(walk("scripts/e7-operator/test-release.mjs"), ["lib/booking-db/codec.js", "lib/booking-db/config.js", "lib/booking-db/repo.js", "lib/checkout/intent-state.js",
    "scripts/e7-operator/test-release.mjs"]);
  const wrapper = readFileSync(join(ROOT, "scripts/e7-operator/test-release.mjs"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  const repo = readFileSync(join(ROOT, "lib/booking-db/repo.js"), "utf8");
  const helper = repo.slice(repo.indexOf("// ---- OPERATOR expectation"), repo.indexOf("/**\n * requestTestRelease(")).replace(/^\s*\/\/.*$/gm, "");
  assert.ok(helper.length > 2000 && helper.includes("assertOperatorExpectation"));
  for (const [name, src] of [["wrapper", wrapper], ["helper", helper]]) {
    assert.doesNotMatch(src, /access_token|intent_guests|price_snapshot|quote_hash|\bref\b\s*,|result_ref|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b|process\.env|fetch\(|https?:\/\//, name);
    assert.doesNotMatch(src.replace(/payload ->> 'providerIdempotencyKey' AS provider_key, payload ->> 'paymentIntentId' AS payload_pi/g, ""), /payload\s*(?:->|,|\bFROM\b|$)|\bpayload\b(?! of)/m, `${name}: only the runner's two scalar projections`);
    assert.doesNotMatch(src, /SELECT \*/, name);
  }
  // every wrapper SQL statement is a SELECT filtered to the named intent (instance excepted)
  for (const [k, sql] of Object.entries(OP.QUERIES)) {
    assert.match(sql, /^\/\*e7op:\w+\*\/ SELECT /, k);
    if (k !== "instance") assert.match(sql, /WHERE intent_id = \$1/, k);
  }
});
