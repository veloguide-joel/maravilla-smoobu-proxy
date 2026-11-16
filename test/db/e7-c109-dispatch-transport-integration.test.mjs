// Stage E7 C109 — the GitHub workflow_dispatch TRANSPORT behind the REAL C108 consumer against a DISPOSABLE local PostgreSQL.
// REAL schema 0024 + REAL webhook authorization path + REAL owned-claim consumer; the GitHub side is a FAKE exchange (no network, no
// credential: a synthetic token string). Proves: the claim COMMIT is durable before the GET / POST, the main pin gates the POST, every
// post-POST uncertainty settles dispatch_unknown and is never re-posted, and an accepted handoff leaves the booking "processing".
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { createIntentRecord, applyEvent, collectGuestDetails, loadIntent } from "../../lib/booking-db/repo.js";
import { startTestCheckout, processVerifiedStripeEvent } from "../../lib/checkout/stripe-test-webhook.js";
import { intentStatus } from "../../lib/checkout/intent-api-core.js";
import { runPipelineKickoffOnce, KICKOFF_CONSTANTS } from "../../lib/booking-db/pipeline-kickoff.js";
import { createGithubWorkflowDispatch, GITHUB_DISPATCH_CONSTANTS, GithubExchangeError } from "../../lib/booking-db/pipeline-dispatch-transport.js";
import { ENV_OK } from "../e5a-fixtures.mjs";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });

const ACCT = ENV_OK.STRIPE_TEST_ACCOUNT_ID;
const OPEN_CONSUMER = Object.freeze({ ...KICKOFF_CONSTANTS, dispatchEnabled: true });
const OPEN_TRANSPORT = Object.freeze({ ...GITHUB_DISPATCH_CONSTANTS, enabled: true });
const TOKEN = ["synthetic", "token", "for", "tests", "only", "0000"].join("_");
const PIN = "9455bc9ee15370b5321b7a04a96e893e9e80080b"; const CLOSED_MAIN = "a726d8ca80ec55c4334ba1bc88e4cd7cac8aa4fb";
const clone = (o) => JSON.parse(JSON.stringify(o));
const sec = (ms) => Math.floor(ms / 1000);
let seq = 0;
let stayN = 0;
const q1 = async (sql, p) => (await db.app.query(sql, p)).rows;
const row = async (id) => (await q1("SELECT state, claim_worker, outcome_code FROM booking.pipeline_kickoff_requests WHERE intent_id = $1", [id]))[0];

/** in-memory Stripe TEST account (the e5a fake, with caller times) */
function world(now) {
  const w = { sessions: new Map(), pis: new Map() };
  const strip = (s) => { const { _pim, ...rest } = s; return clone(rest); };
  w.stripe = {
    accounts: { retrieve: async () => ({ object: "account", id: ACCT }) },
    checkout: { sessions: {
      create: async (params) => {
        const id = `cs_test_K${++seq}`; const pd = params.line_items[0].price_data;
        const s = { object: "checkout.session", id, livemode: false, mode: "payment", status: "open", payment_status: "unpaid", amount_total: pd.unit_amount, currency: pd.currency,
          client_reference_id: params.client_reference_id, metadata: { ...params.metadata }, expires_at: params.expires_at, url: `https://checkout.stripe.com/c/pay/${id}`,
          payment_intent: null, customer_details: null, _pim: params.payment_intent_data };
        w.sessions.set(id, s); return strip(s);
      },
      retrieve: async (id) => strip(w.sessions.get(id)) } },
    paymentIntents: { retrieve: async (id) => clone(w.pis.get(id)) }
  };
  w.pay = (sessionId) => {
    const s = w.sessions.get(sessionId); const piId = `pi_K${++seq}x`;
    s.status = "complete"; s.payment_intent = piId; s.customer_details = { email: "guest@example.invalid", name: "Guest Person" };
    w.pis.set(piId, { object: "payment_intent", id: piId, livemode: false, status: "requires_capture", capture_method: s._pim.capture_method, amount: s.amount_total,
      amount_capturable: s.amount_total, currency: s.currency, metadata: { ...s._pim.metadata },
      latest_charge: { object: "charge", id: `ch_K${seq}`, livemode: false, payment_intent: piId, captured: false, amount_captured: 0, amount_refunded: 0, status: "succeeded",
        paid: true, created: sec(now - 60000), payment_method_details: { card: { capture_before: sec(now + 6 * F.DAY), last4: "4242" } }, billing_details: { email: "guest@example.invalid" } } });
    return piId;
  };
  w.event = (sessionId, id = `evt_K${++seq}`) => ({ id, object: "event", type: "checkout.session.completed", livemode: false, created: sec(now), api_version: "2026-01-28.clover",
    data: { object: strip(w.sessions.get(sessionId)) } });
  return w;
}
/** a fresh checkout on the TEST listing (USD), created at `created` (default: now, after the cutoff), paid but NOT yet authorized */
async function paidCheckout({ listingId = 606998, currency = "USD", created = Date.now(), id } = {}) {
  const now = Math.max(created, Date.now());
  const w = world(now);
  const d0 = Date.UTC(2027, 0, 4) + (++stayN) * 5 * F.DAY;                         // a distinct 4-night stay per checkout (claims never overlap)
  const ymd = (t) => new Date(t).toISOString().slice(0, 10);
  const stay = { listingId, from: ymd(d0), to: ymd(d0 + 4 * F.DAY), guests: 2 };
  const intent = await createIntentRecord(db.app, { ...(id ? { id } : {}), ref: F.nextRef(), accessTokenHash: F.tokenHash(), environment: "test", now: created, ...stay });
  F.ok(await applyEvent(db.app, intent.id, { type: "PRICE_CONFIRMED", id: `price:${intent.id}`, price: F.priceFor({ ...stay, currency }) }, { now: created + 1000, actor: "guest" }));
  F.ok(await collectGuestDetails(db.app, intent.id, F.GUEST, { now: created + 2000, termsVersion: "terms-2026-10" }));
  const r = F.ok(await startTestCheckout(db.app, intent.id, { env: ENV_OK, stripe: w.stripe, now: created + 3000, workerId: "w-pay" }));
  const piId = w.pay(r.sessionId);
  return { id: intent.id, sessionId: r.sessionId, piId, w, now };
}
const deliver = (k, event, hooks) => processVerifiedStripeEvent(db.app, event, { stripe: k.w.stripe, now: k.now, accountId: ACCT, accountCache: {}, hooks });
async function authorizedFresh(o) { const k = await paidCheckout(o); const r = await deliver(k, k.w.event(k.sessionId)); assert.equal(r.code, "APPLIED", JSON.stringify(r)); return k; }
const reply = (status, bytes = Buffer.alloc(0)) => Object.freeze({ status, contentType: "application/json; charset=utf-8", contentEncoding: null, bytes, complete: true });
const refJson = (sha) => Buffer.from(JSON.stringify({ ref: "refs/heads/main", node_id: "REF_x", url: "u", object: { type: "commit", sha, url: "u" } }));
/** a FAKE GitHub exchange; every call records the DURABLE request row state at that instant (read through the pool) */
function fakeGithub(intentId, script = {}) {
  const calls = [];
  const ex = async (spec) => {
    calls.push({ kind: spec.kind, rowAtCall: (await row(intentId)).state, body: spec.body ? JSON.parse(spec.body.toString()) : null });
    const f = script[spec.kind] ?? (spec.kind === "getMain" ? async () => reply(200, refJson(PIN)) : async () => reply(204));
    return f(spec);
  };
  ex.calls = calls; return ex;
}
let credReads = 0;
const transport = (ex, constants = OPEN_TRANSPORT) => createGithubWorkflowDispatch({ credential: () => { credReads += 1; return TOKEN; }, constants, exchange: ex });
const kick = (k, dispatch, workerId = "kw-gh", consumer = OPEN_CONSUMER) => runPipelineKickoffOnce(db.app, { workerId, dispatch, constants: consumer, intentId: k.id });

test("I1 fresh authorized request → ONE owned claim COMMIT (durable 'claimed' already at the GET and at the POST) → main pin → ONE POST → 204 → dispatch_accepted; the booking stays processing; a re-run with a new transport posts nothing", async () => {
  const k = await authorizedFresh(); const i0 = await loadIntent(db.app, k.id);
  const ex = fakeGithub(k.id);
  const r = await kick(k, transport(ex));
  assert.deepEqual([r.code, r.claimed, r.dispatchAttempted, r.outcome], ["HANDOFF_ACCEPTED", true, true, "dispatch_accepted"]);
  assert.deepEqual(ex.calls.map((c) => [c.kind, c.rowAtCall]), [["getMain", "claimed"], ["dispatch", "claimed"]], "the claim COMMIT preceded every network step");
  assert.deepEqual(ex.calls[1].body.ref, "main"); assert.equal(ex.calls[1].body.return_run_details, false);
  assert.equal(ex.calls[1].body.inputs.intent_id, k.id); assert.equal(ex.calls[1].body.inputs.payment_intent_id, k.piId);
  assert.deepEqual([(await row(k.id)).state, (await row(k.id)).outcome_code], ["dispatch_accepted", "HANDOFF_ACCEPTED"]);
  const i1 = await loadIntent(db.app, k.id);
  assert.deepEqual([i1.status, i1.version, i1.payment.capturedMinor, i1.reservation], ["payment_authorized", i0.version, 0, null], "HTTP acceptance is not a booking");
  const s = await intentStatus({ pool: db.app }, k.id); assert.deepEqual([s.body.status, s.body.bookingProgress.stage], ["processing", "processing"]);
  const ex2 = fakeGithub(k.id);
  assert.equal((await kick(k, transport(ex2), "kw-gh2")).code, "SKIPPED:NOT_REQUESTED:DISPATCH_ACCEPTED"); assert.equal(ex2.calls.length, 0);
});

test("I2 every post-POST uncertainty → dispatch_unknown, exactly ONE POST, never re-posted: 204-then-lost reply, 500, 200 with run details, POST timeout", async () => {
  for (const [label, dispatch] of [
    ["204 then lost reply", async () => { throw new GithubExchangeError("EXCHANGE_PREMATURE_CLOSE"); }],
    ["500", async () => reply(500, Buffer.from("{}"))],
    ["200 run details", async () => reply(200, Buffer.from(JSON.stringify({ workflow_run_id: 1 })))],
    ["timeout", async () => { throw new GithubExchangeError("EXCHANGE_TIMEOUT"); }]]) {
    const k = await authorizedFresh(); const ex = fakeGithub(k.id, { dispatch });
    const r = await kick(k, transport(ex));
    assert.deepEqual([r.outcome, r.settled], ["dispatch_unknown", true], label);
    assert.deepEqual(ex.calls.map((c) => c.kind), ["getMain", "dispatch"], label);
    assert.equal((await row(k.id)).state, "dispatch_unknown", label);
    const ex2 = fakeGithub(k.id);
    assert.equal((await kick(k, transport(ex2), "kw-gh-r")).code, "SKIPPED:NOT_REQUESTED:DISPATCH_UNKNOWN", label); assert.equal(ex2.calls.length, 0, `${label}: never re-posted`);
    const s = await intentStatus({ pool: db.app }, k.id); assert.equal(s.body.status, "processing", label);
  }
});

test("I3 main is not the reviewed ENABLE pin (e.g. today's CLOSED main) or unreadable → typed notSent → dispatch_refused with 0 POST; the authorization is untouched; a re-run posts nothing", async () => {
  for (const [label, getMain, code] of [["closed main", async () => reply(200, refJson(CLOSED_MAIN)), "NOT_SENT:MAIN_NOT_PINNED_ENABLE"],
    ["404", async () => reply(404, Buffer.from("{}")), "NOT_SENT:MAIN_READ_STATUS"], ["network", async () => { throw new GithubExchangeError("EXCHANGE_NETWORK_ERROR"); }, "NOT_SENT:MAIN_READ_FAILED"]]) {
    const k = await authorizedFresh(); const ex = fakeGithub(k.id, { getMain });
    const r = await kick(k, transport(ex));
    assert.deepEqual([r.code, r.outcome], [code, "dispatch_refused"], label);
    assert.deepEqual(ex.calls.map((c) => [c.kind, c.rowAtCall]), [["getMain", "claimed"]], `${label}: 0 POST`);
    assert.deepEqual([(await row(k.id)).state, (await loadIntent(db.app, k.id)).status], ["dispatch_refused", "payment_authorized"], label);
    const ex2 = fakeGithub(k.id); await kick(k, transport(ex2), "kw-gh-r"); assert.equal(ex2.calls.length, 0, label);
  }
});

test("I4 CLOSED: the shipped consumer refuses before any DB read, credential read or network; an open consumer with the shipped CLOSED transport records dispatch_refused (NOT_SENT:TRANSPORT_CLOSED) with 0 credential reads and 0 network", async () => {
  { const k = await authorizedFresh(); const ex = fakeGithub(k.id); const before = credReads; let reads = 0;
    const spy = { connect: async () => { reads += 1; return db.app.connect(); } };
    const r = await runPipelineKickoffOnce(spy, { workerId: "kw-c", dispatch: transport(ex), intentId: k.id });
    assert.deepEqual([r.code, reads, credReads - before, ex.calls.length, (await row(k.id)).state], ["KICKOFF_CLOSED", 0, 0, 0, "requested"]); }
  { const k = await authorizedFresh(); const ex = fakeGithub(k.id); const before = credReads;
    const r = await kick(k, transport(ex, GITHUB_DISPATCH_CONSTANTS));
    assert.deepEqual([r.code, r.outcome, credReads - before, ex.calls.length, (await row(k.id)).state], ["NOT_SENT:TRANSPORT_CLOSED", "dispatch_refused", 0, 0, "dispatch_refused"]); }
});
