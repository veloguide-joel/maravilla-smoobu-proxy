// Stage E5a — Stripe TEST-mode Checkout create + signed-webhook processing against a throwaway local PostgreSQL.
// The Stripe client is an in-memory fake (no network, no SDK client, no keys). Events reach processVerifiedStripeEvent as
// if Stripe's signature check had passed (that check is covered offline in test/e5a-webhook-http.test.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { loadIntent } from "../../db/lib/repo.js";
import { recoverExpiredOperations } from "../../db/lib/operations.js";
import { startTestCheckout, processVerifiedStripeEvent } from "../../lib/checkout/stripe-test-webhook.js";
import { ENV_OK } from "../e5a-fixtures.mjs";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });

const ACCT = ENV_OK.STRIPE_TEST_ACCOUNT_ID;
const clone = (o) => JSON.parse(JSON.stringify(o));
let seq = 0;
const L = (n) => 850000 + n;
const sec = (ms) => Math.floor(ms / 1000);

/** In-memory Stripe TEST account. Only the calls the slice is allowed to make exist. */
function world() {
  const w = { creates: [], reads: [], sessions: new Map(), pis: new Map(), account: { object: "account", id: ACCT }, createImpl: null, readFail: false };
  const strip = (s) => { const { _pid, ...rest } = s; return clone(rest); };
  w.stripe = {
    accounts: { retrieve: async (...a) => { assert.equal(a.length, 0); w.reads.push("account"); return clone(w.account); } },
    checkout: { sessions: {
      create: async (params, opts) => {
        w.creates.push({ params: clone(params), opts: clone(opts) });
        if (w.createImpl) return w.createImpl(params, opts);
        const id = `cs_test_S${++seq}`;
        const pd = params.line_items[0].price_data;
        const s = { object: "checkout.session", id, livemode: false, mode: "payment", status: "open", payment_status: "unpaid", amount_total: pd.unit_amount,
          currency: pd.currency, client_reference_id: params.client_reference_id, metadata: { ...params.metadata }, expires_at: params.expires_at,
          url: `https://checkout.stripe.com/c/pay/${id}`, payment_intent: null, customer_details: null, _pim: params.payment_intent_data };
        w.sessions.set(id, s);
        return strip(s);
      },
      retrieve: async (id, ...rest) => {
        assert.equal(rest.length, 0); w.reads.push(`session:${id}`);
        if (w.readFail) throw Object.assign(new Error("down"), { type: "StripeConnectionError" });
        const s = w.sessions.get(id);
        if (!s) throw Object.assign(new Error("No such checkout.session"), { type: "StripeInvalidRequestError", statusCode: 404 });
        return strip(s);
      } } },
    paymentIntents: { retrieve: async (id, opts) => {
      assert.deepEqual(opts, { expand: ["latest_charge"] }); w.reads.push(`pi:${id}`);
      if (w.readFail) throw Object.assign(new Error("down"), { type: "StripeConnectionError" });
      return clone(w.pis.get(id));
    } }
  };
  /** The guest completes Checkout: Stripe authorizes (manual capture). */
  w.pay = (sessionId, { authAtMs = F.at(4), captureBeforeMs = F.at(4) + 7 * F.DAY, pi = {}, charge = {} } = {}) => {
    const s = w.sessions.get(sessionId);
    const piId = `pi_P${++seq}`;
    s.status = "complete"; s.payment_status = "unpaid"; s.payment_intent = piId;
    s.customer_details = { email: "guest@example.invalid", name: "Guest Person" };
    w.pis.set(piId, { object: "payment_intent", id: piId, livemode: false, status: "requires_capture", capture_method: s._pim.capture_method,
      amount: s.amount_total, amount_capturable: s.amount_total, currency: s.currency, metadata: { ...s._pim.metadata },
      latest_charge: { object: "charge", id: `ch_C${seq}`, livemode: false, payment_intent: piId, captured: false, amount_captured: 0, amount_refunded: 0,
        status: "succeeded", paid: true, created: sec(authAtMs), payment_method_details: { card: { capture_before: sec(captureBeforeMs), last4: "4242" } },
        billing_details: { email: "guest@example.invalid" }, ...charge }, ...pi });
    return piId;
  };
  w.expire = (sessionId) => { w.sessions.get(sessionId).status = "expired"; };
  w.event = (type, sessionId, id = `evt_E${++seq}`) => ({ id, object: "event", type, livemode: false, created: sec(F.at(5)), api_version: "2026-01-28.clover",
    data: { object: strip(w.sessions.get(sessionId)) } });
  return w;
}

const deliver = (w, event, now = F.at(5), hooks) => processVerifiedStripeEvent(db.app, event, { stripe: w.stripe, now, accountId: ACCT, accountCache: {}, hooks });
const q1 = async (sql, p) => (await db.app.query(sql, p)).rows;
const evRow = async (id) => (await q1("SELECT status, error_code, attempts, intent_id FROM booking.stripe_webhook_events WHERE event_id = $1", [id]))[0];
const authTransitions = async (id) => F.count(db.app, "SELECT count(*) AS n FROM booking.intent_transitions WHERE intent_id = $1 AND event_type = 'PAYMENT_AUTHORIZED'", [id]);
const ledger = async (id, entry) => F.count(db.app, "SELECT count(*) AS n FROM booking.payment_ledger WHERE intent_id = $1 AND entry = $2", [id, entry]);
const createOps = async (id) => q1("SELECT state, attempts, result_ref FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'stripe.create_checkout_session' ORDER BY created_at", [id]);
const noHostawayOrMoneyMove = async (id) => {
  const rows = await q1("SELECT op_type, state FROM booking.external_operations WHERE intent_id = $1 AND (op_type LIKE 'hostaway.%' OR op_type IN ('stripe.capture_payment_intent'))", [id]);
  assert.deepEqual(rows, [], "no Hostaway operation and no capture is ever queued by this slice");
  const sent = await q1("SELECT op_type FROM booking.external_operations WHERE intent_id = $1 AND dispatched_at IS NOT NULL AND op_type NOT LIKE 'stripe.retrieve_%' AND op_type <> 'stripe.create_checkout_session'", [id]);
  assert.deepEqual(sent, [], "nothing but the one create and reads was ever handed to a sender");
};
async function checkoutReady(w, n) {
  const id = await F.withDetails(db.app, { listingId: L(n) });
  const r = await startTestCheckout(db.app, id, { env: ENV_OK, stripe: w.stripe, now: F.at(2), workerId: "w-pay" });
  F.ok(r, "start");
  return { id, sessionId: r.sessionId };
}

test("happy path: one create through the outbox row (settled), signed completion -> server reads -> PAYMENT_AUTHORIZED + processed in one commit", async () => {
  const w = world();
  const { id, sessionId } = await checkoutReady(w, 1);
  assert.equal(w.creates.length, 1);
  assert.deepEqual(w.creates[0].opts, { idempotencyKey: `cs:${id}:1` });
  assert.equal(w.creates[0].params.payment_intent_data.capture_method, "manual");
  assert.equal(w.creates[0].params.line_items[0].price_data.unit_amount, 576000);           // the intent's confirmed price, from the row
  assert.deepEqual((await createOps(id)).map((o) => [o.state, o.attempts, o.result_ref]), [["succeeded", 1, sessionId]]);  // settled, not runnable
  assert.equal(await F.state(db.app, id), "payment_pending");
  assert.deepEqual((await q1("SELECT status, checkout_session_id FROM booking.payment_attempts WHERE intent_id = $1", [id])), [{ status: "open", checkout_session_id: sessionId }]);
  // a second "pay" request reuses the open session: never a second create
  const again = await startTestCheckout(db.app, id, { env: ENV_OK, stripe: w.stripe, now: F.at(3) });
  assert.deepEqual([again.ok, again.reused, again.sessionId], [true, true, sessionId]); assert.equal(w.creates.length, 1);
  // reuse never extends or reprices: past the session's own expiry it is refused (no create, no change)
  const expiresMs = w.sessions.get(sessionId).expires_at * 1000;
  const before1 = (await loadIntent(db.app, id)).version;
  assert.deepEqual(await startTestCheckout(db.app, id, { env: ENV_OK, stripe: w.stripe, now: expiresMs }), { ok: false, error: "SESSION_EXPIRED_NOT_REUSABLE" });
  assert.equal(w.creates.length, 1); assert.equal((await loadIntent(db.app, id)).version, before1);
  assert.equal(w.sessions.get(sessionId).expires_at * 1000, expiresMs);

  const piId = w.pay(sessionId);
  const ev = w.event("checkout.session.completed", sessionId);
  const r = await deliver(w, ev);
  assert.deepEqual(r, { http: 200, code: "APPLIED", state: "payment_authorized" });
  const intent = await loadIntent(db.app, id);
  assert.equal(intent.payment.paymentIntentId, piId);
  assert.equal(intent.payment.captureBefore, sec(F.at(4) + 7 * F.DAY) * 1000);            // Stripe's own deadline, not an assumption
  assert.deepEqual(await evRow(ev.id), { status: "processed", error_code: null, attempts: 1, intent_id: id });
  assert.equal(await ledger(id, "authorization_accepted"), 1);
  const evid = await q1("SELECT kind, status, source, observed FROM booking.provider_evidence WHERE intent_id = $1 ORDER BY kind", [id]);
  assert.deepEqual(evid.map((e) => [e.kind, e.status, e.source]), [["checkout_session", "complete", "stripe_api"], ["payment_intent", "requires_capture", "stripe_api"]]);
  assert.doesNotMatch(JSON.stringify(evid), /guest|example\.invalid|4242/);
  // replays after completion: permanently de-duplicated
  for (const m of [6, 60 * 24, 60 * 24 * 3]) assert.deepEqual(await deliver(w, ev, F.at(m)), { http: 200, code: "ALREADY_PROCESSED" });
  assert.equal(await authTransitions(id), 1);
  assert.deepEqual(w.reads.filter((r) => r !== "account"), [`session:${sessionId}`, `pi:${piId}`]);   // replays read nothing
  await noHostawayOrMoneyMove(id);
});

test("concurrency: the same event x4 and two DIFFERENT event ids for the same session/PaymentIntent -> exactly one transition; all finished", async () => {
  const w = world();
  const { id, sessionId } = await checkoutReady(w, 2);
  w.pay(sessionId);
  const a = w.event("checkout.session.completed", sessionId, "evt_SAME1");
  const b = w.event("checkout.session.completed", sessionId, "evt_OTHER2");
  const out = await Promise.all([deliver(w, a), deliver(w, a), deliver(w, b), deliver(w, a), deliver(w, b)]);
  assert.ok(out.every((o) => o.http === 200), JSON.stringify(out));
  assert.equal(out.filter((o) => o.code === "APPLIED").length, 1, JSON.stringify(out));
  assert.equal(await authTransitions(id), 1);
  assert.equal(await ledger(id, "authorization_accepted"), 1);
  assert.equal((await evRow("evt_SAME1")).status, "processed");
  assert.equal((await evRow("evt_OTHER2")).status, "processed");
  assert.equal(await F.state(db.app, id), "payment_authorized");
  await noHostawayOrMoneyMove(id);
});

test("crash safety: a failure INSIDE the commit rolls back transition + completion together; a crash after a duplicate, before its finish, is not stranded", async () => {
  const w = world();
  const { id, sessionId } = await checkoutReady(w, 3);
  w.pay(sessionId);
  const ev = w.event("checkout.session.completed", sessionId, "evt_CRASH1");
  // (1) the process dies inside the transaction, after the event was marked processed: nothing commits
  const r1 = await deliver(w, ev, F.at(5), { inTx: async () => { throw Object.assign(new Error("killed"), { code: "SIMULATED_CRASH" }); } });
  assert.deepEqual(r1, { http: 503, code: "SIMULATED_CRASH" });
  assert.equal(await F.state(db.app, id), "payment_pending");
  assert.equal(await authTransitions(id), 0);
  assert.equal((await evRow(ev.id)).status, "failed_retryable");
  // Stripe redelivers: applied exactly once
  assert.deepEqual(await deliver(w, ev, F.at(6)), { http: 200, code: "APPLIED", state: "payment_authorized" });
  // (2) a second event for the same PaymentIntent is a duplicate; the process dies before finishing it
  const ev2 = w.event("checkout.session.completed", sessionId, "evt_CRASH2");
  const r2 = await deliver(w, ev2, F.at(7), { beforeDuplicateFinish: async () => { throw Object.assign(new Error("killed"), { code: "SIMULATED_CRASH" }); } });
  assert.equal(r2.http, 503);
  assert.equal((await evRow(ev2.id)).status, "failed_retryable");
  assert.deepEqual(await deliver(w, ev2, F.at(8)), { http: 200, code: "DUPLICATE", state: "payment_authorized" });
  assert.equal((await evRow(ev2.id)).status, "processed");
  // (3) a crash between recording and processing (row left 'received') is picked up by the redelivery
  const ev3 = w.event("checkout.session.completed", sessionId, "evt_CRASH3");
  const { recordStripeEvent } = await import("../../db/lib/webhooks.js");
  await recordStripeEvent(db.app, { eventId: ev3.id, type: ev3.type, livemode: false, createdAt: F.at(5), objectId: sessionId }, { now: F.at(8) });
  assert.equal((await evRow(ev3.id)).status, "received");
  assert.deepEqual(await deliver(w, ev3, F.at(9)), { http: 200, code: "DUPLICATE", state: "payment_authorized" });
  assert.equal(await authTransitions(id), 1);
  assert.equal(await ledger(id, "authorization_accepted"), 1);
});

test("ordering: completion delivered before our session record commits -> 503 (unresolved); recovery records the SAME session by a read; redelivery applies", async () => {
  const w = world();
  const id = await F.withDetails(db.app, { listingId: L(4) });
  const crash = Object.assign(new Error("killed"), { code: "SIMULATED_CRASH" });
  await assert.rejects(startTestCheckout(db.app, id, { env: ENV_OK, stripe: w.stripe, now: F.at(2), hooks: { beforeRecord: async () => { throw crash; } } }), /killed/);
  const [sessionId] = [...w.sessions.keys()];
  assert.deepEqual((await createOps(id)).map((o) => o.state), ["succeeded"]);               // the create row is settled, never runnable again
  assert.equal((await q1("SELECT status FROM booking.payment_attempts WHERE intent_id = $1", [id]))[0].status, "creating");
  w.pay(sessionId);
  const ev = w.event("checkout.session.completed", sessionId, "evt_EARLY1");
  assert.deepEqual(await deliver(w, ev), { http: 503, code: "SESSION_NOT_YET_RECORDED" });
  assert.equal((await evRow(ev.id)).status, "failed_retryable");
  assert.equal(await F.state(db.app, id), "details_collected");
  // the guest/app retries "pay": the session is recorded from a READ of the known session id; no second create
  // (here the session is already complete, so the read refuses to record it as open; the claim review / E7 owns that case)
  const rec = await startTestCheckout(db.app, id, { env: ENV_OK, stripe: w.stripe, now: F.at(3) });
  assert.deepEqual(rec, { ok: false, error: "RECORDED_SESSION_NOT_OPEN" });
  assert.equal(w.creates.length, 1);

  // same crash, but the recovery happens while the session is still open
  const w2 = world();
  const id2 = await F.withDetails(db.app, { listingId: L(5) });
  await assert.rejects(startTestCheckout(db.app, id2, { env: ENV_OK, stripe: w2.stripe, now: F.at(2), hooks: { beforeRecord: async () => { throw crash; } } }));
  const [s2] = [...w2.sessions.keys()];
  const rec2 = await startTestCheckout(db.app, id2, { env: ENV_OK, stripe: w2.stripe, now: F.at(3) });
  assert.deepEqual([rec2.ok, rec2.recovered, rec2.sessionId], [true, true, s2]);
  assert.equal(w2.creates.length, 1);
  assert.equal(await F.state(db.app, id2), "payment_pending");
  w2.pay(s2);
  assert.equal((await deliver(w2, w2.event("checkout.session.completed", s2))).code, "APPLIED");

  // recovery never records a session that a read shows is not bound to this intent/attempt, or not TEST mode
  for (const [n, tamper] of [[11, (x) => { x.metadata.mv_payment_attempt_id = "00000000-0000-4000-8000-000000000000"; }],
    [12, (x) => { x.metadata.mv_intent_id = "00000000-0000-4000-8000-000000000000"; }], [13, (x) => { x.livemode = true; }]]) {
    const w4 = world();
    const id4 = await F.withDetails(db.app, { listingId: L(n) });
    await assert.rejects(startTestCheckout(db.app, id4, { env: ENV_OK, stripe: w4.stripe, now: F.at(2), hooks: { beforeRecord: async () => { throw crash; } } }));
    const [s4] = [...w4.sessions.keys()];
    tamper(w4.sessions.get(s4));
    assert.deepEqual(await startTestCheckout(db.app, id4, { env: ENV_OK, stripe: w4.stripe, now: F.at(3) }), { ok: false, error: "RECORDED_SESSION_NOT_BOUND" });
    assert.equal((await q1("SELECT status FROM booking.payment_attempts WHERE intent_id = $1", [id4]))[0].status, "creating");
    assert.equal(await F.state(db.app, id4), "details_collected");
    assert.equal(w4.creates.length, 1);
  }

  // crash BETWEEN the attempt becoming open and CHECKOUT_PREPARED (recordCheckoutSession's two steps)
  const w3 = world();
  const id3 = await F.withDetails(db.app, { listingId: L(6) });
  await assert.rejects(startTestCheckout(db.app, id3, { env: ENV_OK, stripe: w3.stripe, now: F.at(2), hooks: { beforeRecord: async () => { throw crash; } } }));
  const [s3] = [...w3.sessions.keys()];
  const att = (await q1("SELECT id FROM booking.payment_attempts WHERE intent_id = $1", [id3]))[0].id;
  await db.app.query(`UPDATE booking.payment_attempts SET status = 'open', checkout_session_id = $2, session_expires_at = $3, updated_at = $4 WHERE id = $1`,
    [att, s3, new Date(w3.sessions.get(s3).expires_at * 1000), new Date(F.at(2))]);       // first half committed, then the process died
  w3.pay(s3);
  const e3 = w3.event("checkout.session.completed", s3, "evt_HALF1");
  assert.deepEqual(await deliver(w3, e3), { http: 503, code: "NOT_APPLICABLE_IN_DETAILS_COLLECTED" });
  const fin = await startTestCheckout(db.app, id3, { env: ENV_OK, stripe: w3.stripe, now: F.at(3) });
  assert.deepEqual([fin.ok, fin.reused, fin.sessionId], [true, true, s3]);
  assert.equal(await F.state(db.app, id3), "payment_pending");
  assert.deepEqual(await deliver(w3, e3, F.at(6)), { http: 200, code: "APPLIED", state: "payment_authorized" });
  assert.equal(w3.creates.length, 1);
  for (const x of [id, id2, id3]) await noHostawayOrMoneyMove(x);
});

test("create outcomes: ambiguous -> outcome_unknown + case, never retried; definite refusal -> not_created; crash after send -> lease expiry -> unknown", async () => {
  const w = world();
  w.createImpl = async () => { throw Object.assign(new Error("socket hang up"), { type: "StripeConnectionError" }); };
  const id = await F.withDetails(db.app, { listingId: L(7) });
  assert.deepEqual(await startTestCheckout(db.app, id, { env: ENV_OK, stripe: w.stripe, now: F.at(2) }), { ok: false, error: "CONNECTION", state: "outcome_unknown" });
  assert.deepEqual((await createOps(id)).map((o) => o.state), ["outcome_unknown"]);
  assert.equal((await q1("SELECT status FROM booking.payment_attempts WHERE intent_id = $1", [id]))[0].status, "outcome_unknown");
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND kind = 'CHECKOUT_CREATE_OUTCOME_UNKNOWN' AND status = 'open'", [id]), 1);
  for (const m of [3, 10, 25]) assert.deepEqual(await startTestCheckout(db.app, id, { env: ENV_OK, stripe: w.stripe, now: F.at(m) }), { ok: false, error: "CHECKOUT_CREATE_UNRESOLVED" });
  // after the quote window the refusal reason changes, the safety does not: no create, claim held, attempt and case kept
  for (const m of [60, 60 * 24]) assert.deepEqual(await startTestCheckout(db.app, id, { env: ENV_OK, stripe: w.stripe, now: F.at(m) }), { ok: false, error: "QUOTE_EXPIRED" });
  assert.equal(w.creates.length, 1);
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.inventory_claims WHERE intent_id = $1 AND released_at IS NULL", [id]), 1);
  assert.deepEqual((await q1("SELECT status FROM booking.payment_attempts WHERE intent_id = $1", [id])).map((a) => a.status), ["outcome_unknown"]);
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND kind = 'CHECKOUT_CREATE_OUTCOME_UNKNOWN' AND status = 'open'", [id]), 1);
  assert.deepEqual((await createOps(id)).map((o) => o.state), ["outcome_unknown"]);

  const w2 = world();
  w2.createImpl = async () => { throw Object.assign(new Error("bad"), { type: "StripeInvalidRequestError", statusCode: 400, code: "parameter_invalid_integer" }); };
  const id2 = await F.withDetails(db.app, { listingId: L(8) });
  assert.deepEqual(await startTestCheckout(db.app, id2, { env: ENV_OK, stripe: w2.stripe, now: F.at(2) }), { ok: false, error: "STRIPE_REFUSED_400", state: "failed_definite" });
  assert.equal((await q1("SELECT status FROM booking.payment_attempts WHERE intent_id = $1", [id2]))[0].status, "not_created");

  const w3 = world();
  const id3 = await F.withDetails(db.app, { listingId: L(9) });
  await assert.rejects(startTestCheckout(db.app, id3, { env: ENV_OK, stripe: w3.stripe, now: F.at(2), hooks: { afterSend: async () => { throw new Error("killed"); } } }));
  assert.deepEqual((await createOps(id3)).map((o) => o.state), ["in_flight"]);
  assert.deepEqual(await startTestCheckout(db.app, id3, { env: ENV_OK, stripe: w3.stripe, now: F.at(2) + 1000 }), { ok: false, error: "CHECKOUT_CREATE_IN_PROGRESS" });
  await recoverExpiredOperations(db.app, { now: F.at(5) });
  assert.deepEqual((await createOps(id3)).map((o) => o.state), ["outcome_unknown"]);
  assert.deepEqual(await startTestCheckout(db.app, id3, { env: ENV_OK, stripe: w3.stripe, now: F.at(6) }), { ok: false, error: "CHECKOUT_CREATE_UNRESOLVED" });
  assert.equal(w3.creates.length, 1);
  // the gate is checked before any database or Stripe call
  const id4 = await F.withDetails(db.app, { listingId: L(10) });
  const reads0 = w3.reads.length;
  for (const [env, code] of [[{ ...ENV_OK, VERCEL_ENV: "production" }, "PRODUCTION_REFUSED"], [{}, "ENVIRONMENT_NOT_ALLOWED"], [{ ...ENV_OK, MV_STRIPE_TEST_WEBHOOK: "no" }, "NOT_ENABLED"]]) {
    assert.deepEqual(await startTestCheckout(db.app, id4, { env, stripe: w3.stripe, now: F.at(2) }), { ok: false, error: code });
  }
  assert.equal(w3.reads.length, reads0);                                                      // not even the account read
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.payment_attempts WHERE intent_id = $1", [id4]), 0);
  assert.equal(w3.creates.length, 1);
});

test("binding failures are never applied and never acknowledged: captured, no deadline, wrong metadata, partial, account mismatch, read failure", async () => {
  const cases = [
    ["CAPTURED_BEFORE_RESERVATION", (w, s) => w.pay(s, { pi: { status: "succeeded" } })],
    ["AUTHORIZATION_DEADLINE_UNKNOWN", (w, s) => w.pay(s, { charge: { payment_method_details: { card: {} } } })],
    ["PAYMENT_INTENT_METADATA_MISMATCH", (w, s) => w.pay(s, { pi: { metadata: { mv_intent_id: "00000000-0000-4000-8000-000000000000" } } })],
    ["PARTIAL_AUTHORIZATION", (w, s) => w.pay(s, { pi: { amount_capturable: 100 } })],
    ["NOT_MANUAL_CAPTURE", (w, s) => w.pay(s, { pi: { capture_method: "automatic" } })],
    ["ACCOUNT_MISMATCH", (w, s) => { w.pay(s); w.account = { object: "account", id: "acct_SOMEONEELSE" }; }],
    ["STRIPE_READ_FAILED", (w, s) => { w.pay(s); w.readFail = true; }]
  ];
  let n = 20;
  for (const [code, setup] of cases) {
    const w = world();
    const { id, sessionId } = await checkoutReady(w, n++);
    setup(w, sessionId);
    const ev = w.event("checkout.session.completed", sessionId);
    assert.deepEqual(await deliver(w, ev), { http: 503, code }, code);
    assert.equal(await F.state(db.app, id), "payment_pending", code);
    assert.equal(await authTransitions(id), 0, code);
    const row = await evRow(ev.id);
    assert.deepEqual([row.status, row.error_code], ["failed_retryable", code], code);
    if (code === "ACCOUNT_MISMATCH") assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.provider_evidence WHERE intent_id = $1", [id]), 0);
    await noHostawayOrMoneyMove(id);
  }
});

test("money or timing that E3 must refuse: identity exact -> E3 escalates (case + void QUEUED, not sent), and the event is finished", async () => {
  for (const [n, setup, reason] of [
    [40, (w, s) => w.pay(s, { pi: { amount: 500000, amount_capturable: 500000 } }), "AUTHORIZATION_AMOUNT_MISMATCH"],
    [41, (w, s) => w.pay(s, { captureBeforeMs: F.at(5) + 60 * F.MIN }), "AUTHORIZATION_DEADLINE_PASSED"]
  ]) {
    const w = world();
    const { id, sessionId } = await checkoutReady(w, n);
    setup(w, sessionId);
    const ev = w.event("checkout.session.completed", sessionId);
    assert.deepEqual(await deliver(w, ev), { http: 200, code: "APPLIED", state: "reconciliation_required" });
    assert.equal((await loadIntent(db.app, id)).reasonCode, reason);
    assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'", [id]), 1);
    const v = await q1("SELECT state, dispatched_at FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'stripe.void_payment_intent'", [id]);
    assert.deepEqual(v, [{ state: "pending", dispatched_at: null }]);                       // queued for E7; nothing sent
    assert.equal((await evRow(ev.id)).status, "processed");
    await noHostawayOrMoneyMove(id);
  }
});

test("expiry: verified by a session READ (evidence), then E3 CHECKOUT_EXPIRED; a contradicting read is unresolved; a late authorization escalates", async () => {
  const w = world();
  const { id, sessionId } = await checkoutReady(w, 50);
  // Stripe says expired in the event, but our read still sees it open: not trusted
  const early = w.event("checkout.session.expired", sessionId, "evt_EXPEARLY");
  assert.deepEqual(await deliver(w, early, F.at(40)), { http: 503, code: "SESSION_NOT_EXPIRED" });
  assert.equal(await F.state(db.app, id), "payment_pending");
  w.expire(sessionId);
  assert.deepEqual(await deliver(w, early, F.at(41)), { http: 200, code: "EXPIRY_APPLIED", state: "payment_expired" });
  assert.equal((await q1("SELECT status FROM booking.payment_attempts WHERE intent_id = $1", [id]))[0].status, "expired");
  assert.deepEqual(await deliver(w, early, F.at(42)), { http: 200, code: "ALREADY_PROCESSED" });

  // completion and expiry raced: the expiry won in our database; a later verified authorization escalates with a queued void
  const w2 = world();
  const p = await checkoutReady(w2, 51);
  w2.pay(p.sessionId);
  const completed = w2.event("checkout.session.completed", p.sessionId, "evt_LATE1");
  w2.expire(p.sessionId);
  assert.equal((await deliver(w2, w2.event("checkout.session.expired", p.sessionId, "evt_EXP2"), F.at(41))).code, "EXPIRY_APPLIED");
  w2.sessions.get(p.sessionId).status = "complete";                                          // (contrived) the read now shows complete
  const late = await deliver(w2, completed, F.at(42));
  assert.equal(late.http, 200); assert.equal(late.state, "reconciliation_required");
  assert.equal((await loadIntent(db.app, p.id)).reasonCode, "AUTHORIZATION_ON_CLOSED_INTENT");
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'stripe.void_payment_intent' AND state = 'pending'", [p.id]), 1);
  await noHostawayOrMoneyMove(p.id);
});

test("other events: declined card in an open session is informational; unknown types and foreign sessions ignored; live/Connect refused unstored", async () => {
  const w = world();
  const { id, sessionId } = await checkoutReady(w, 60);
  const failed = { id: "evt_PF1", object: "event", type: "payment_intent.payment_failed", livemode: false, created: sec(F.at(5)),
    data: { object: { id: "pi_PF1", object: "payment_intent", metadata: { mv_intent_id: id } } } };
  assert.deepEqual(await deliver(w, failed), { http: 200, code: "IGNORED_NOT_TERMINAL" });
  assert.equal(await F.state(db.app, id), "payment_pending");                                 // the guest can still pay in this session
  assert.deepEqual([(await evRow("evt_PF1")).status, (await evRow("evt_PF1")).error_code], ["ignored", "NOT_TERMINAL_SESSION_OPEN"]);
  const other = { ...failed, id: "evt_OT1", type: "customer.created", data: { object: { id: "cus_X1", object: "customer" } } };
  assert.deepEqual(await deliver(w, other), { http: 200, code: "IGNORED_TYPE" });
  w.sessions.set("cs_test_FOREIGN1", { object: "checkout.session", id: "cs_test_FOREIGN1", livemode: false, status: "complete", metadata: {} });
  assert.deepEqual(await deliver(w, w.event("checkout.session.completed", "cs_test_FOREIGN1", "evt_FOR1")), { http: 200, code: "IGNORED_FOREIGN_SESSION" });
  const async1 = w.event("checkout.session.async_payment_succeeded", sessionId, "evt_ASY1");
  assert.deepEqual(await deliver(w, async1), { http: 503, code: "UNEXPECTED_EVENT_TYPE" });
  for (const [ev, code] of [[{ ...w.event("checkout.session.completed", sessionId, "evt_LIVE1"), livemode: true }, "LIVEMODE_REFUSED"],
    [{ ...w.event("checkout.session.completed", sessionId, "evt_CON1"), account: "acct_CONNECTED1" }, "CONNECT_EVENT_REFUSED"],
    [{ ...w.event("checkout.session.completed", sessionId, "evt_BAD1"), data: null }, "EVENT_MALFORMED"],
    [{ ...w.event("checkout.session.completed", sessionId), id: "not-an-event" }, "EVENT_MALFORMED"]]) {
    assert.deepEqual(await deliver(w, ev), { http: 400, code });
    if (/^evt_/.test(ev.id)) assert.equal(await evRow(ev.id), undefined, code);
  }
  assert.equal(w.reads.filter((r) => r.startsWith("pi:")).length, 0);
  await noHostawayOrMoneyMove(id);
});

test("pre-create checks: a LIVE-marked database or a different/unreadable Stripe account -> refused before ANY database write or Stripe create", async () => {
  // the throwaway cluster is migrated as 'test'; a live marker is simulated by answering only the marker query differently
  const liveMarked = { query: (sql, p) => (/FROM booking\.instance/.test(sql) ? Promise.resolve({ rows: [{ environment: "live" }] }) : db.app.query(sql, p)),
    connect: () => db.app.connect() };
  const counts = async (id) => [await F.count(db.app, "SELECT count(*) AS n FROM booking.payment_attempts WHERE intent_id = $1", [id]),
    await F.count(db.app, "SELECT count(*) AS n FROM booking.inventory_claims WHERE intent_id = $1", [id]),
    await F.count(db.app, "SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1", [id]), (await loadIntent(db.app, id)).version];
  const w = world();
  const id = await F.withDetails(db.app, { listingId: L(70) });
  const before0 = await counts(id);
  assert.deepEqual(await startTestCheckout(liveMarked, id, { env: ENV_OK, stripe: w.stripe, now: F.at(2) }), { ok: false, error: "DATABASE_NOT_TEST" });
  assert.deepEqual([w.creates.length, w.reads.length], [0, 0]);                              // not even the account read
  const brokenDb = { query: () => Promise.reject(new Error("unreachable")), connect: () => Promise.reject(new Error("unreachable")) };
  assert.deepEqual(await startTestCheckout(brokenDb, id, { env: ENV_OK, stripe: w.stripe, now: F.at(2) }), { ok: false, error: "DATABASE_NOT_TEST" });
  w.account = { object: "account", id: "acct_SOMEONEELSE" };
  assert.deepEqual(await startTestCheckout(db.app, id, { env: ENV_OK, stripe: w.stripe, now: F.at(2) }), { ok: false, error: "ACCOUNT_MISMATCH" });
  w.account = { object: "customer", id: ACCT };
  assert.deepEqual(await startTestCheckout(db.app, id, { env: ENV_OK, stripe: w.stripe, now: F.at(2) }), { ok: false, error: "ACCOUNT_MISMATCH" });
  w.stripe.accounts.retrieve = async () => { throw Object.assign(new Error("down"), { type: "StripeConnectionError" }); };
  assert.deepEqual(await startTestCheckout(db.app, id, { env: ENV_OK, stripe: w.stripe, now: F.at(2) }), { ok: false, error: "ACCOUNT_READ_FAILED" });
  assert.equal(w.creates.length, 0);
  assert.deepEqual(await counts(id), before0);                                                 // nothing written at all
  assert.equal(await F.state(db.app, id), "details_collected");
});

test("interrupted-create recovery refuses a read session that differs in object, mode, reference, amount, currency or expiry: no 2nd create, nothing overwritten", async () => {
  const crash = Object.assign(new Error("killed"), { code: "SIMULATED_CRASH" });
  let n = 80;
  for (const [tamper, code, now] of [
    [(x) => { x.object = "payment_intent"; }, "RECORDED_SESSION_NOT_BOUND"],
    [(x) => { x.mode = "setup"; }, "RECORDED_SESSION_NOT_BOUND"],
    [(x) => { x.client_reference_id = "00000000-0000-4000-8000-000000000000"; }, "RECORDED_SESSION_NOT_BOUND"],
    [(x) => { x.amount_total = 575999; }, "RECORDED_SESSION_AMOUNT_MISMATCH"],
    [(x) => { x.amount_total = "576000"; }, "RECORDED_SESSION_AMOUNT_MISMATCH"],
    [(x) => { x.currency = "usd"; }, "RECORDED_SESSION_AMOUNT_MISMATCH"],
    [(x) => { x.expires_at = sec(F.at(2)); }, "RECORDED_SESSION_EXPIRY_INVALID"],                 // already past at minute 3
    [(x) => { x.expires_at = sec(F.at(3) + 25 * 3600 * 1000); }, "RECORDED_SESSION_EXPIRY_INVALID"],
    [(x) => { x.status = "expired"; }, "RECORDED_SESSION_NOT_OPEN"]
  ]) {
    const w = world();
    const id = await F.withDetails(db.app, { listingId: L(n++) });
    await assert.rejects(startTestCheckout(db.app, id, { env: ENV_OK, stripe: w.stripe, now: F.at(2), hooks: { beforeRecord: async () => { throw crash; } } }));
    const [sid] = [...w.sessions.keys()];
    tamper(w.sessions.get(sid));
    assert.deepEqual(await startTestCheckout(db.app, id, { env: ENV_OK, stripe: w.stripe, now: F.at(3) }), { ok: false, error: code }, code);
    assert.deepEqual(await q1("SELECT status, checkout_session_id FROM booking.payment_attempts WHERE intent_id = $1", [id]), [{ status: "creating", checkout_session_id: null }], code);
    assert.equal(await F.state(db.app, id), "details_collected", code);
    assert.equal(w.creates.length, 1, code);
    assert.deepEqual((await createOps(id)).map((o) => o.state), ["succeeded"], code);
  }
});
