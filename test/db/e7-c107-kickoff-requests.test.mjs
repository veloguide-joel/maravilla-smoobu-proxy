// Stage E7 C107 — CLOSED durable accepted-checkout → pipeline kickoff REQUEST / HANDOFF foundation against a DISPOSABLE local PostgreSQL.
// REAL schema (0001..0024), REAL repo / E3 state machine, REAL webhook authorization path (processVerifiedStripeEvent with an in-memory
// FAKE Stripe, as test/db/e5a-stripe-test-webhook.test.mjs), REAL kickoff consumer; the dispatcher is a FAKE (no network, no GitHub, no key).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { createIntentRecord, applyEvent, collectGuestDetails, loadIntent } from "../../lib/booking-db/repo.js";
import { startTestCheckout, processVerifiedStripeEvent } from "../../lib/checkout/stripe-test-webhook.js";
import { intentStatus } from "../../lib/checkout/intent-api-core.js";
import { migrateDown } from "../../db/lib/migrate.js";
import { runPipelineKickoffOnce, KICKOFF_CONSTANTS } from "../../lib/booking-db/pipeline-kickoff.js";
import { kickoffDispatch, WORKFLOW_INPUT_KEYS, PINNED_REVISION } from "../../lib/checkout/pipeline-kickoff-plan.js";
import { ENV_OK } from "../e5a-fixtures.mjs";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });

const ACCT = ENV_OK.STRIPE_TEST_ACCOUNT_ID;
const OPEN = Object.freeze({ ...KICKOFF_CONSTANTS, dispatchEnabled: true });           // the test-local OPEN seam (shipped constants stay closed)
const CUTOFF = Date.parse("2026-11-15T22:58:01Z");
const clone = (o) => JSON.parse(JSON.stringify(o));
const sec = (ms) => Math.floor(ms / 1000);
let seq = 0;
let stayN = 0;
const q1 = async (sql, p) => (await db.app.query(sql, p)).rows;
const req = async (id) => (await q1(`SELECT intent_id::text AS intent_id, ref, authorized_version, payment_intent_id, amount_minor::text AS amount_minor, currency, listing_id,
  state, claim_worker, plan_hash, dispatch_inputs, outcome_code, (settled_at IS NOT NULL) AS settled FROM booking.pipeline_kickoff_requests WHERE intent_id = $1`, [id]));
const nReq = async () => (await q1("SELECT count(*)::int AS n FROM booking.pipeline_kickoff_requests"))[0].n;

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
/** a fake dispatcher that records every invocation (never touches the network) */
const fakeDispatch = (reply = async () => ({ accepted: true })) => { const calls = []; const fn = async (call, opts) => { calls.push(clone(call)); return reply(call, opts); }; fn.calls = calls; return fn; };

test("P1 the authorization COMMIT seam: ONE fresh TEST authorization through the REAL webhook path records exactly ONE request bound to the server facts; duplicate / replayed deliveries and repeated status reads create nothing; status stays processing", async () => {
  const before0 = await nReq();
  const k = await paidCheckout();
  assert.equal(await nReq(), before0, "no request before the authorization commits (payment_pending)");
  const ev = k.w.event(k.sessionId);
  assert.deepEqual(await deliver(k, ev), { http: 200, code: "APPLIED", state: "payment_authorized" });
  const i = await loadIntent(db.app, k.id);
  const rows = await req(k.id);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { intent_id: k.id, ref: i.ref, authorized_version: i.version, payment_intent_id: k.piId, amount_minor: String(i.price.finalTotalMinor), currency: "USD",
    listing_id: 606998, state: "requested", claim_worker: null, plan_hash: null, dispatch_inputs: null, outcome_code: null, settled: false });
  // the same event redelivered, a second event id for the same session, and repeated status reads: nothing new
  assert.equal((await deliver(k, ev)).code, "ALREADY_PROCESSED");
  assert.equal((await deliver(k, k.w.event(k.sessionId))).code, "DUPLICATE");
  for (let n = 0; n < 3; n++) {
    const s = await intentStatus({ pool: db.app }, k.id);
    assert.equal(s.http ?? s.status ?? 200, 200);
    const body = s.body ?? s;
    assert.equal(body.status, "processing"); assert.deepEqual(body.bookingProgress, { stage: "processing", bookingRef: null });
  }
  assert.deepEqual(await req(k.id), rows, "unchanged");
  assert.equal(await nReq(), before0 + 1, "exactly one row in total");
  assert.equal((await loadIntent(db.app, k.id)).version, i.version, "a duplicate never advances the intent");
});

test("P2 failure BEFORE the authorization COMMIT records nothing (the request lives in the authorizing transaction); the redelivery then records exactly ONE", async () => {
  const k = await paidCheckout(); const ev = k.w.event(k.sessionId);
  const r = await deliver(k, ev, { inTx: async () => { throw new Error("crash inside the authorizing transaction"); } });
  assert.equal(r.http, 503);
  assert.equal((await loadIntent(db.app, k.id)).status, "payment_pending"); assert.deepEqual(await req(k.id), []);
  assert.equal((await deliver(k, ev)).code, "APPLIED"); assert.equal((await req(k.id)).length, 1);
});

test("P3 scope is server-derived: a pilot listing, a non-USD price, an intent created before 2026-11-15T22:58:01Z and the known historical ids (C103 1d6e770f, C95 669da884) are authorized normally but never requested", async () => {
  const pilot = await authorizedFresh({ listingId: 603566 });
  const mxn = await authorizedFresh({ currency: "MXN" });
  const old = await authorizedFresh({ created: CUTOFF - 1000 });
  const c103 = await authorizedFresh({ id: "1d6e770f-ba3d-40f7-92c1-ee01be7da532" });
  const c95 = await authorizedFresh({ id: "669da884-02e8-4105-8825-f908e5d22ae9" });
  for (const k of [pilot, mxn, old, c103, c95]) {
    assert.equal((await loadIntent(db.app, k.id)).status, "payment_authorized", "the authorization itself is never refused by the kickoff table");
    assert.deepEqual(await req(k.id), [], k.id);
  }
  const edge = await authorizedFresh({ created: CUTOFF });
  assert.equal((await req(edge.id)).length, 1, "the cutoff instant itself is in scope");
});

test("P4 SHIPPED CLOSED / no dispatcher: refused before any read; the request stays requested and is never dispatched", async () => {
  const k = await authorizedFresh(); let reads = 0;
  const spy = { query: async (...a) => { reads += 1; return db.app.query(...a); }, connect: async () => { reads += 1; return db.app.connect(); } };
  const d = fakeDispatch();
  assert.equal((await runPipelineKickoffOnce(spy, { workerId: "kw-c", dispatch: d, intentId: k.id })).code, "KICKOFF_CLOSED");
  assert.equal((await runPipelineKickoffOnce(spy, { workerId: "kw-c", constants: OPEN, intentId: k.id })).code, "DISPATCH_ABSENT");
  assert.deepEqual([reads, d.calls.length, (await req(k.id))[0].state], [0, 0, "requested"]);
});

test("P5 OPEN seam + FAKE dispatcher: ONE claim, ONE dispatch of the EXACT pinned inputs (main, the reviewed workflow), dispatch_accepted; the intent, its money, operations and public status are untouched; a re-run finds nothing", async () => {
  const k = await authorizedFresh(); const i0 = await loadIntent(db.app, k.id);
  const ops0 = await q1("SELECT op_type, state FROM booking.external_operations WHERE intent_id = $1 ORDER BY created_at, id", [k.id]);
  const d = fakeDispatch();
  const r = await runPipelineKickoffOnce(db.app, { workerId: "kw-1", dispatch: d, constants: OPEN, intentId: k.id });
  assert.deepEqual({ ...r }, { code: "HANDOFF_ACCEPTED", intentId: k.id, claimed: true, dispatchAttempted: true, outcome: "dispatch_accepted", settled: true });
  assert.equal(d.calls.length, 1);
  const nb = (await q1(`SELECT to_char(date_trunc('milliseconds', created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS nb FROM booking.intents WHERE id = $1`, [k.id]))[0].nb;
  const exp = kickoffDispatch({ intentId: k.id, ref: i0.ref, authorizedVersion: i0.version, paymentIntentId: k.piId, amountMinor: i0.price.finalTotalMinor, currency: "USD", listingId: 606998, notBefore: nb });
  assert.deepEqual(d.calls[0], { workflow: PINNED_REVISION.workflowFile, ref: "main", inputs: { ...exp.inputs } });
  assert.deepEqual(Object.keys(d.calls[0].inputs), [...WORKFLOW_INPUT_KEYS]);
  assert.ok(Date.parse(nb) <= i0.createdAt && Date.parse(nb) >= CUTOFF);
  const row = (await req(k.id))[0];
  assert.deepEqual([row.state, row.claim_worker, row.plan_hash, row.outcome_code, row.settled], ["dispatch_accepted", "kw-1", exp.planHash, "HANDOFF_ACCEPTED", true]);
  assert.deepEqual(row.dispatch_inputs, { ...exp.inputs });
  const i1 = await loadIntent(db.app, k.id);
  assert.deepEqual([i1.status, i1.version, i1.payment.capturedMinor, i1.reservation], ["payment_authorized", i0.version, 0, null], "a handoff is not an execution");
  assert.deepEqual(await q1("SELECT op_type, state FROM booking.external_operations WHERE intent_id = $1 ORDER BY created_at, id", [k.id]), ops0, "no operation queued");
  const s = await intentStatus({ pool: db.app }, k.id); const body = s.body ?? s;
  assert.deepEqual([body.status, body.bookingProgress.stage], ["processing", "processing"], "HTTP acceptance is not a booking");
  const again = await runPipelineKickoffOnce(db.app, { workerId: "kw-2", dispatch: d, constants: OPEN, intentId: k.id });
  assert.equal(again.code, "SKIPPED:NOT_REQUESTED:DISPATCH_ACCEPTED"); assert.equal(d.calls.length, 1);
});

test("P6 duplicate consumers race on ONE request (both pass admission, then claim concurrently) → exactly ONE claim and ONE dispatch", async () => {
  const k = await authorizedFresh(); const d = fakeDispatch();
  let arrived = 0; let release; const gate = new Promise((r) => { release = r; });
  const beforeClaim = async () => { arrived += 1; if (arrived === 2) release(); await gate; };
  const [a, b] = await Promise.all(["kw-a", "kw-b"].map((wk) => runPipelineKickoffOnce(db.app, { workerId: wk, dispatch: d, constants: OPEN, intentId: k.id, hooks: { beforeClaim } })));
  assert.equal([a, b].filter((x) => x.dispatchAttempted).length, 1); assert.equal(d.calls.length, 1);
  assert.ok([a.code, b.code].includes("HANDOFF_ACCEPTED")); assert.ok([a.code, b.code].some((c) => c.startsWith("SKIPPED:NOT_REQUESTED:")));
  // concurrent duplicate authorization deliveries for a fresh checkout: ONE request, ONE dispatch
  const k2 = await paidCheckout(); const ev = k2.w.event(k2.sessionId);
  const rs = await Promise.all([deliver(k2, ev), deliver(k2, ev), deliver(k2, k2.w.event(k2.sessionId))]);
  assert.equal(rs.filter((x) => x.code === "APPLIED").length, 1, JSON.stringify(rs));
  assert.equal((await req(k2.id)).length, 1);
  const d2 = fakeDispatch();
  await Promise.all([1, 2, 3].map((n) => runPipelineKickoffOnce(db.app, { workerId: `kw-r${n}`, dispatch: d2, constants: OPEN, intentId: k2.id })));
  assert.equal(d2.calls.length, 1);
});

/** a POOL whose clients misbehave at a chosen statement: mode 'after' runs it then throws (reply lost after it landed); 'before' throws instead */
const faultyPool = (match, nth = 1, mode = "after") => { let seen = 0;
  return { connect: async () => { const cl = await db.app.connect();
    return { query: async (sql, p) => { const hit = match(String(sql)) && ++seen === nth;
      if (hit && mode === "before") throw new Error("connection lost before the statement");
      const out = await cl.query(sql, p); if (hit) throw new Error("connection lost after the statement"); return out; },
    release: (x) => cl.release(x) }; } }; };
const isCommit = (sql) => sql === "COMMIT";
test("P7 uncertainty is human-owned, NEVER re-dispatched: claim COMMIT landed + reply lost → 0 dispatch, row claimed; failure BEFORE the claim COMMIT → 0 dispatch, row requested (a later clean run may dispatch once); accepted-then-lost / timeout / malformed → dispatch_unknown; settle lost after / before its COMMIT → terminal / claimed; re-runs never re-dispatch", async () => {
  // (a) the claim COMMIT lands, its reply is lost
  { const k = await authorizedFresh(); const d = fakeDispatch();
    const r = await runPipelineKickoffOnce(faultyPool(isCommit, 1, "after"), { workerId: "kw-l", dispatch: d, constants: OPEN, intentId: k.id });
    assert.deepEqual([r.code, r.claimed, r.dispatchAttempted, d.calls.length], ["CLAIM_UNCERTAIN", false, false, 0]);
    assert.deepEqual([(await req(k.id))[0].state, (await req(k.id))[0].claim_worker], ["claimed", "kw-l"], "durable: the COMMIT landed");
    assert.equal((await runPipelineKickoffOnce(db.app, { workerId: "kw-l2", dispatch: d, constants: OPEN, intentId: k.id })).code, "SKIPPED:NOT_REQUESTED:CLAIMED");
    assert.equal(d.calls.length, 0, "a claimed row is never re-claimed"); }
  // (b) failure BEFORE the claim COMMIT (the COMMIT never runs; the connection is destroyed → rolled back)
  { const k = await authorizedFresh(); const d = fakeDispatch();
    const r = await runPipelineKickoffOnce(faultyPool(isCommit, 1, "before"), { workerId: "kw-b", dispatch: d, constants: OPEN, intentId: k.id });
    assert.deepEqual([r.code, d.calls.length], ["CLAIM_UNCERTAIN", 0]);
    assert.deepEqual([(await req(k.id))[0].state, (await req(k.id))[0].claim_worker], ["requested", null], "durable: nothing committed");
    assert.equal((await runPipelineKickoffOnce(db.app, { workerId: "kw-b2", dispatch: d, constants: OPEN, intentId: k.id })).code, "HANDOFF_ACCEPTED");
    assert.equal(d.calls.length, 1, "exactly one dispatch in total (the first claim never committed)"); }
  // (c) the provider accepted, the reply is lost / a hung dispatcher times out / a malformed reply
  for (const [label, reply, extra] of [
    ["accepted then lost", async () => { throw new Error("socket hang up"); }, {}],
    ["timeout", () => new Promise(() => {}), { constants: { ...OPEN, dispatchTimeoutMs: 20 } }],
    ["malformed", async () => ({ status: 204 }), {}]]) {
    const k = await authorizedFresh(); const d = fakeDispatch(reply);
    const r = await runPipelineKickoffOnce(db.app, { workerId: "kw-u", dispatch: d, constants: OPEN, intentId: k.id, ...extra });
    assert.deepEqual([r.outcome, r.settled, d.calls.length], ["dispatch_unknown", true, 1], label);
    assert.deepEqual([(await req(k.id))[0].state, /^DISPATCH_/.test((await req(k.id))[0].outcome_code)], ["dispatch_unknown", true], label);
    assert.equal((await runPipelineKickoffOnce(db.app, { workerId: "kw-u2", dispatch: d, constants: OPEN, intentId: k.id })).code, "SKIPPED:NOT_REQUESTED:DISPATCH_UNKNOWN", label);
    assert.equal(d.calls.length, 1, `${label}: never re-dispatched`);
  }
  // (d) the settle COMMIT lands, its reply is lost → terminal; (e) failure before the settle COMMIT → still claimed. Neither re-dispatches.
  for (const [mode, want] of [["after", "dispatch_accepted"], ["before", "claimed"]]) {
    const k = await authorizedFresh(); const d = fakeDispatch();
    const r = await runPipelineKickoffOnce(faultyPool(isCommit, 2, mode), { workerId: "kw-s", dispatch: d, constants: OPEN, intentId: k.id });
    assert.deepEqual([r.code, r.claimed, d.calls.length], ["SETTLE_UNCERTAIN", true, 1], mode);
    assert.equal((await req(k.id))[0].state, want, `${mode}: durable row`);
    await runPipelineKickoffOnce(db.app, { workerId: "kw-s2", dispatch: d, constants: OPEN, intentId: k.id });
    assert.equal(d.calls.length, 1, `${mode}: never re-dispatched`);
  }
});

test("P11 C108-F1 ROOT reproducer: a caller-held transaction can never carry the claim — BEGIN → consumer(client) → ROLLBACK → consumer(pool): the client is refused (0 dispatch), a pool handing out that dirty connection fails the clean-boundary proof (0 dispatch), the row stays requested, and the pool run dispatches exactly ONCE in total", async () => {
  const k = await authorizedFresh(); const d = fakeDispatch();
  const c = await db.app.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT 1");
    const first = await runPipelineKickoffOnce(c, { workerId: "root-tx", dispatch: d, constants: OPEN, intentId: k.id });
    assert.deepEqual([first.code, first.claimed, d.calls.length], ["POOL_CONTRACT_REFUSED", false, 0]);
    const dirtyPool = { connect: async () => ({ query: (sql, p) => c.query(sql, p), release: () => {} }) };   // hands out the caller's open transaction
    const second = await runPipelineKickoffOnce(dirtyPool, { workerId: "root-tx", dispatch: d, constants: OPEN, intentId: k.id });
    assert.deepEqual([second.code, second.claimed, d.calls.length], ["TX_NOT_CLEAN", false, 0]);
    await c.query("ROLLBACK");
  } finally { c.release(); }
  assert.deepEqual([(await req(k.id))[0].state, (await req(k.id))[0].claim_worker], ["requested", null], "durable: never claimed by the caller transaction");
  const third = await runPipelineKickoffOnce(db.app, { workerId: "root-tx2", dispatch: d, constants: OPEN, intentId: k.id });
  assert.equal(third.code, "HANDOFF_ACCEPTED");
  assert.equal(d.calls.length, 1, "total dispatches across all three runs <= 1");
  assert.deepEqual([(await req(k.id))[0].state, (await req(k.id))[0].claim_worker], ["dispatch_accepted", "root-tx2"]);
});

test("P12 C108-F2 the SQL claim binds the reviewed source / closure digests as literals: drifting either one (or both, or the key set) → REFUSED:INPUTS_NOT_BOUND, nothing claimed, 0 dispatch; the exact inputs still claim", async () => {
  const goodFor = async (k) => { const i = await loadIntent(db.app, k.id);
    const nb = (await q1(`SELECT to_char(date_trunc('milliseconds', created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS nb FROM booking.intents WHERE id = $1`, [k.id]))[0].nb;
    return kickoffDispatch({ intentId: k.id, ref: i.ref, authorizedVersion: i.version, paymentIntentId: k.piId, amountMinor: i.price.finalTotalMinor, currency: "USD", listingId: 606998, notBefore: nb }); };
  for (const [label, drift] of [["source", { expected_source_digest: "a".repeat(64) }], ["C116 source (pre-S4 frame)", { expected_source_digest: "880db5b33024edbf0879fbaf5a3826e3622db12fd1808e8c2047238da507fe1b" }], ["closure", { expected_closure_digest: "b".repeat(64) }],
    ["both", { expected_source_digest: "a".repeat(64), expected_closure_digest: "b".repeat(64) }], ["extra key", { extra: "x" }]]) {
    const k = await authorizedFresh(); const g = await goodFor(k);
    const bad = { ...g.inputs, ...drift };
    assert.equal((await q1("SELECT booking.claim_pipeline_kickoff($1, 'root-pins', $2, $3) AS r", [k.id, g.planHash, bad]))[0].r, "REFUSED:INPUTS_NOT_BOUND", label);
    assert.deepEqual([(await req(k.id))[0].state, (await req(k.id))[0].outcome_code, (await req(k.id))[0].plan_hash], ["refused", "INPUTS_NOT_BOUND", null], label);
  }
  const k = await authorizedFresh(); const g = await goodFor(k);
  assert.deepEqual(Object.keys(g.inputs), [...WORKFLOW_INPUT_KEYS]);
  assert.equal(g.inputs.expected_source_digest, "5294b6b467839e1dd825e56063abc1ad1267eafdfb2973f2c2129e9b1f29c3f5");   // C119 S4 (0028; C116 880db5b3)
  assert.equal(g.inputs.expected_closure_digest, "f7d7cad646eaed2fb37a63e031157732ee6e2a44824f9d935d6b9104e08f7273");
  assert.equal((await q1("SELECT booking.claim_pipeline_kickoff($1, 'root-pins', $2, $3) AS r", [k.id, g.planHash, g.inputs]))[0].r, "CLAIMED");
});

test("P8 a dispatch refusal never rolls back the authorized payment nor advances the booking: typed notSent → dispatch_refused; the intent stays payment_authorized with its accepted authorization", async () => {
  const k = await authorizedFresh(); const i0 = await loadIntent(db.app, k.id);
  const d = fakeDispatch(async () => ({ notSent: true, code: "WORKFLOW_GATE_CLOSED" }));
  const r = await runPipelineKickoffOnce(db.app, { workerId: "kw-n", dispatch: d, constants: OPEN, intentId: k.id });
  assert.deepEqual([r.code, r.outcome], ["NOT_SENT:WORKFLOW_GATE_CLOSED", "dispatch_refused"]);
  const i1 = await loadIntent(db.app, k.id);
  assert.deepEqual([i1.status, i1.version, i1.payment.paymentIntentId, i1.payment.amountMinor], ["payment_authorized", i0.version, k.piId, i0.payment.amountMinor]);
  assert.equal((await q1("SELECT count(*)::int AS n FROM booking.payment_ledger WHERE intent_id = $1 AND entry = 'authorization_accepted'", [k.id]))[0].n, 1);
  const s = await intentStatus({ pool: db.app }, k.id); assert.equal((s.body ?? s).status, "processing");
});

test("P9 stale / unsafe facts refuse BEFORE any dispatch (durably): open case, state / version change, and drift injected AFTER the consumer's fresh read is caught by the locked SQL claim", async () => {
  const openCase = (id) => db.owner.query(`INSERT INTO booking.reconciliation_cases (id, intent_id, kind, status, opened_at, opened_by) VALUES (gen_random_uuid(), $1, 'KICKOFF_TEST_CASE', 'open', now(), 'c107-test')`, [id]);
  { const k = await authorizedFresh(); await openCase(k.id); const d = fakeDispatch();
    assert.equal((await runPipelineKickoffOnce(db.app, { workerId: "kw-x", dispatch: d, constants: OPEN, intentId: k.id })).code, "REFUSED:OPEN_CASE");
    assert.deepEqual([d.calls.length, (await req(k.id))[0].state, (await req(k.id))[0].outcome_code], [0, "refused", "OPEN_CASE"]); }
  { const k = await authorizedFresh(); const d = fakeDispatch();
    F.ok(await applyEvent(db.app, k.id, { type: "ESCALATE", id: `esc:${k.id}`, code: "KICKOFF_TEST" }, { now: Date.now(), actor: "reconciler" }));
    assert.equal((await runPipelineKickoffOnce(db.app, { workerId: "kw-x", dispatch: d, constants: OPEN, intentId: k.id })).code, "REFUSED:STATE_NOT_PAYMENT_AUTHORIZED");
    assert.equal(d.calls.length, 0); }
  { const k = await authorizedFresh(); const d = fakeDispatch();
    const r = await runPipelineKickoffOnce(db.app, { workerId: "kw-x", dispatch: d, constants: OPEN, intentId: k.id, hooks: { afterRead: async () => { await openCase(k.id); } } });
    assert.equal(r.code, "REFUSED:OPEN_CASE", "the SQL claim re-proves under locks"); assert.deepEqual([d.calls.length, r.claimed], [0, false]); }
  { const k = await authorizedFresh(); const d = fakeDispatch();
    const r = await runPipelineKickoffOnce(db.app, { workerId: "kw-x", dispatch: d, constants: OPEN, intentId: k.id,
      hooks: { afterRead: async () => { F.ok(await applyEvent(db.app, k.id, { type: "ESCALATE", id: `esc2:${k.id}`, code: "KICKOFF_TEST" }, { now: Date.now(), actor: "reconciler" })); } } });
    assert.equal(r.code, "REFUSED:STATE_NOT_PAYMENT_AUTHORIZED"); assert.equal(d.calls.length, 0); }
});

test("P10 the fence: app has no write path except the three functions; inputs that differ from the server binding are refused; only the claiming worker settles; the 0024 down refuses while dispatch evidence exists", async () => {
  const k = await authorizedFresh();
  await assert.rejects(db.app.query("UPDATE booking.pipeline_kickoff_requests SET state = 'claimed' WHERE intent_id = $1", [k.id]), /permission denied/);
  await assert.rejects(db.app.query("DELETE FROM booking.pipeline_kickoff_requests WHERE intent_id = $1", [k.id]), /permission denied/);
  await assert.rejects(db.app.query(`INSERT INTO booking.pipeline_kickoff_requests (intent_id, ref, authorized_version, payment_intent_id, amount_minor, currency, listing_id,
    intent_created_at, requested_at, state) SELECT id, ref, version, 'pi_x', 1, 'USD', 606998, now(), now(), 'requested' FROM booking.intents WHERE id = $1`, [k.id]), /permission denied/);
  await assert.rejects(db.owner.query("UPDATE booking.pipeline_kickoff_requests SET state = 'dispatch_accepted' WHERE intent_id = $1", [k.id]), /KICKOFF_/);
  const i = await loadIntent(db.app, k.id);
  const nb = (await q1(`SELECT to_char(date_trunc('milliseconds', created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS nb FROM booking.intents WHERE id = $1`, [k.id]))[0].nb;
  const good = kickoffDispatch({ intentId: k.id, ref: i.ref, authorizedVersion: i.version, paymentIntentId: k.piId, amountMinor: i.price.finalTotalMinor, currency: "USD", listingId: 606998, notBefore: nb });
  const bad = { ...good.inputs, amount_minor: String(i.price.finalTotalMinor + 1) };
  assert.equal((await q1("SELECT booking.claim_pipeline_kickoff($1, 'kw-p', $2, $3) AS r", [k.id, good.planHash, bad]))[0].r, "REFUSED:INPUTS_NOT_BOUND");
  assert.equal((await req(k.id))[0].state, "refused");
  // only the claiming worker settles
  const k2 = await authorizedFresh(); const i2 = await loadIntent(db.app, k2.id);
  const nb2 = (await q1(`SELECT to_char(date_trunc('milliseconds', created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS nb FROM booking.intents WHERE id = $1`, [k2.id]))[0].nb;
  const g2 = kickoffDispatch({ intentId: k2.id, ref: i2.ref, authorizedVersion: i2.version, paymentIntentId: k2.piId, amountMinor: i2.price.finalTotalMinor, currency: "USD", listingId: 606998, notBefore: nb2 });
  assert.equal((await q1("SELECT booking.claim_pipeline_kickoff($1, 'kw-p', $2, $3) AS r", [k2.id, g2.planHash, g2.inputs]))[0].r, "CLAIMED");
  assert.equal((await q1("SELECT booking.settle_pipeline_kickoff($1, 'kw-other', 'dispatch_accepted', 'X') AS r", [k2.id]))[0].r, "NOT_CLAIM_WORKER");
  assert.equal((await q1("SELECT booking.claim_pipeline_kickoff($1, 'kw-q', $2, $3) AS r", [k2.id, g2.planHash, g2.inputs]))[0].r, "NOT_REQUESTED:CLAIMED");
  // dispatch evidence exists in this database → the 0024 down refuses and changes nothing
  const before = await nReq();
  const own = await db.owner.connect();
  try { await assert.rejects(migrateDown(own, { env: "test", to: 23 }), /MIGRATION_0024_DOWN_REFUSED/); } finally { own.release(); }
  assert.equal(await nReq(), before);
  assert.ok((await q1("SELECT to_regclass('booking.pipeline_kickoff_requests') IS NOT NULL AS t"))[0].t);
});
