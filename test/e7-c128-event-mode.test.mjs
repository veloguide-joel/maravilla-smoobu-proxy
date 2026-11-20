// C128 — event-boundary TEST / LIVE mismatch refusal. checkEventMode is pure; processVerifiedStripeEvent runs it in TEST mode
// only, after the existing malformed / livemode / Connect checks and BEFORE anything is recorded. Offline: the pool and the
// Stripe client below throw on any use, so a refusal proves nothing was stored, read or sent. No network, no SDK, no keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkEventMode, checkoutModeGate, stripeTestGate } from "../lib/checkout/stripe-test-mode.js";
import { processVerifiedStripeEvent } from "../lib/checkout/stripe-test-webhook.js";

const NOW = Date.UTC(2026, 10, 2, 20, 0, 0);
const SESSION = (o = {}) => ({ object: "checkout.session", id: "cs_test_a1B2c3", livemode: false, status: "complete", metadata: {}, ...o });
const EVENT = (o = {}, obj = SESSION()) => ({ id: "evt_C128a", object: "event", type: "checkout.session.completed", livemode: false,
  created: Math.floor(NOW / 1000), api_version: "2026-01-28.clover", data: { object: obj }, ...o });

const REACHED_POOL = new Error("REACHED_POOL");
function untouchable() {
  const used = [];
  const pool = { query: async (sql) => { used.push(String(sql).slice(0, 40)); throw REACHED_POOL; }, connect: async () => { used.push("connect"); throw REACHED_POOL; } };
  const stripe = new Proxy({}, { get: (_t, k) => { used.push(`stripe.${String(k)}`); throw new Error("stripe must not be used"); } });
  return { pool, stripe, used };
}
const run = async (ev) => {
  const u = untouchable();
  try { return { out: await processVerifiedStripeEvent(u.pool, ev, { stripe: u.stripe, now: NOW, accountId: "acct_TESTACCOUNT01" }), used: u.used }; }
  catch (e) { if (e === REACHED_POOL) return { reachedPool: true, used: u.used }; throw e; }
};

test("E1 checkEventMode (pure): TEST default accepts a consistent TEST event; refuses every LIVE marker", () => {
  assert.equal(checkEventMode(EVENT()), null);
  assert.equal(checkEventMode(EVENT(), { mode: "test" }), null);
  // objects without a livemode field (as Stripe test fixtures for some types are) are not refused for that alone
  const { livemode: _l, ...noLm } = SESSION();
  assert.equal(checkEventMode(EVENT({}, noLm)), null);
  assert.equal(checkEventMode(EVENT({ type: "customer.created" }, { id: "cus_X1", object: "customer" })), null);
  for (const [ev, code] of [
    [EVENT({ livemode: true }), "LIVEMODE_REFUSED"], [EVENT({ livemode: undefined }), "LIVEMODE_REFUSED"], [EVENT({ livemode: "false" }), "LIVEMODE_REFUSED"],
    [EVENT({}, SESSION({ livemode: true })), "OBJECT_LIVEMODE_MISMATCH"], [EVENT({}, SESSION({ livemode: null })), "OBJECT_LIVEMODE_MISMATCH"],
    [EVENT({}, SESSION({ id: "cs_live_a1B2c3" })), "OBJECT_MODE_MISMATCH"],
    [EVENT({ type: "payment_intent.payment_failed" }, { id: "pi_1", object: "payment_intent", livemode: true }), "OBJECT_LIVEMODE_MISMATCH"]
  ]) assert.equal(checkEventMode(ev), code, code);
});

test("E2 checkEventMode (pure): LIVE refuses every TEST marker; invalid mode refused first", () => {
  const LIVE_EV = EVENT({ livemode: true }, SESSION({ id: "cs_live_a1B2c3", livemode: true }));
  assert.equal(checkEventMode(LIVE_EV, { mode: "live" }), null);
  assert.equal(checkEventMode(EVENT(), { mode: "live" }), "LIVEMODE_REFUSED");
  assert.equal(checkEventMode(EVENT({ livemode: true }, SESSION({ id: "cs_live_a1B2c3" })), { mode: "live" }), "OBJECT_LIVEMODE_MISMATCH");
  assert.equal(checkEventMode(EVENT({ livemode: true }, SESSION({ livemode: true })), { mode: "live" }), "OBJECT_MODE_MISMATCH");
  for (const mode of ["", "LIVE", "prod", null, 1]) assert.equal(checkEventMode(EVENT(), { mode }), "MODE_INVALID", String(mode));
});

test("E3 runtime boundary: mismatched TEST-signed payloads are refused 400 before any database, Stripe or record step", async () => {
  for (const [ev, code] of [
    [EVENT({}, SESSION({ livemode: true })), "OBJECT_LIVEMODE_MISMATCH"],
    [EVENT({}, SESSION({ id: "cs_live_a1B2c3" })), "OBJECT_MODE_MISMATCH"],
    [EVENT({ type: "payment_intent.payment_failed" }, { id: "pi_1", object: "payment_intent", livemode: true }), "OBJECT_LIVEMODE_MISMATCH"],
    [EVENT({ type: "customer.created" }, { id: "cus_X1", object: "customer", livemode: true }), "OBJECT_LIVEMODE_MISMATCH"]
  ]) {
    const r = await run(ev);
    assert.deepEqual(r.out, { http: 400, code }, code);
    assert.deepEqual(r.used, [], `${code}: nothing touched`);
  }
});

test("E4 runtime boundary: existing refusals and their order are unchanged; consistent TEST events still reach recording", async () => {
  for (const [ev, code] of [
    [{ ...EVENT(), data: null }, "EVENT_MALFORMED"], [EVENT({ id: "not-an-event" }), "EVENT_MALFORMED"],
    [EVENT({ livemode: true }), "LIVEMODE_REFUSED"], [EVENT({ livemode: true }, SESSION({ livemode: true, id: "cs_live_a1" })), "LIVEMODE_REFUSED"],
    [EVENT({ account: "acct_CONNECTED1" }), "CONNECT_EVENT_REFUSED"],
    // Connect is still reported first when the payload is also mismatched (the C128 check runs after it)
    [EVENT({ account: "acct_CONNECTED1" }, SESSION({ livemode: true })), "CONNECT_EVENT_REFUSED"]
  ]) {
    const r = await run(ev);
    assert.deepEqual(r.out, { http: 400, code }, code);
    assert.deepEqual(r.used, []);
  }
  const { livemode: _l, ...noLm } = SESSION();
  for (const ev of [EVENT(), EVENT({}, noLm), EVENT({ type: "customer.created" }, { id: "cus_X1", object: "customer" }),
    EVENT({ type: "payment_intent.payment_failed" }, { id: "pi_PF1", object: "payment_intent", metadata: {} })]) {
    const r = await run(ev);
    assert.equal(r.reachedPool, true, ev.type);           // passed the boundary exactly as before, into recordStripeEvent
    assert.equal(r.used.some((x) => x.startsWith("stripe.")), false);
  }
});

test("E5 (P2a) the event boundary checks the CONFIGURED mode; TEST is the default and LIVE stays refused without activation", () => {
  assert.equal(checkoutModeGate({ MV_CHECKOUT_MODE: "live" }).ok, false);
  assert.equal(stripeTestGate({ MV_CHECKOUT_MODE: "live" }).ok, false);
  const wh = readFileSync(new URL("../lib/checkout/stripe-test-webhook.js", import.meta.url), "utf8");
  const calls = wh.match(/checkEventMode\([^)]*\)/g) || [];
  assert.deepEqual(calls, ["checkEventMode(event, { mode })"]);
  assert.match(wh, /if \(event\.livemode !== \(mode === "live"\)\) return reply\(400, "LIVEMODE_REFUSED"\);/);
  assert.match(wh, /recordStripeEvent\(pool, \{ eventId: event\.id, type: event\.type, livemode: mode === "live",/);
});
