// Stage E2B — durable Stripe webhook de-duplication (mocked, already-"verified" events; no Stripe calls).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { recordStripeEvent, finishStripeEvent } from "../../db/lib/webhooks.js";
import { applyEvent } from "../../db/lib/repo.js";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });
const ev = (n, extra = {}) => ({ eventId: `evt_test_${n}`, type: "checkout.session.completed", livemode: false, createdAt: F.at(5), objectId: `cs_test_${n}`, ...extra });

/** Simulated webhook handler: dedupe -> (fresh Stripe read, mocked) -> E3 transition -> finish. */
async function deliver(intent, n, now) {
  const rec = await recordStripeEvent(db.app, ev(n, { intentId: intent.id }), { now });
  if (!rec.shouldProcess) return { skipped: true, rec };
  const r = await applyEvent(db.app, intent.id, { ...F.authEvent(intent.sessionId, `pi_wh_${n}`), id: `evt_test_${n}` }, { now: F.at(5), actor: "webhook" });
  await finishStripeEvent(db.app, `evt_test_${n}`, { status: "processed", intentId: intent.id, now });
  return { skipped: false, r, rec };
}

test("first delivery processes; replays after completion are skipped (permanent de-dup)", async () => {
  const p = await F.pending(db.app, { listingId: 720001 });
  const first = await deliver(p, 1, F.at(5));
  assert.equal(first.skipped, false);
  assert.equal(first.r.intent.status, "payment_authorized");
  for (const m of [6, 60, 60 * 24 * 3, 60 * 24 * 365]) { // minutes, hours, Stripe's 3-day retry window, a year later
    const again = await deliver(p, 1, F.at(m));
    assert.equal(again.skipped, true);
    assert.equal(again.rec.status, "processed");
  }
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.payment_ledger WHERE intent_id = $1", [p.id]), 1);
});

test("concurrent duplicate deliveries: at most one transition, even when both are told to process", async () => {
  const p = await F.pending(db.app, { listingId: 720002 });
  const results = await Promise.all([1, 2, 3, 4].map(() => deliver(p, 2, F.at(5))));
  const transitioned = results.filter((x) => !x.skipped && x.r.ok && !x.r.duplicate);
  assert.equal(transitioned.length, 1);
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.intent_transitions WHERE intent_id = $1 AND event_type = 'PAYMENT_AUTHORIZED'", [p.id]), 1);
  const row = (await db.app.query("SELECT status, attempts FROM booking.stripe_webhook_events WHERE event_id = 'evt_test_2'")).rows[0];
  assert.equal(row.status, "processed");
  assert.ok(row.attempts >= 1);
});

test("crash between recording and processing: the retry is processed; transition still applied once", async () => {
  const p = await F.pending(db.app, { listingId: 720003 });
  const rec = await recordStripeEvent(db.app, ev(3, { intentId: p.id }), { now: F.at(5) }); // ...then the function died
  assert.equal(rec.first, true);
  const retry = await deliver(p, 3, F.at(8));
  assert.equal(retry.skipped, false);
  assert.equal(retry.rec.first, false);
  assert.equal(retry.r.intent.status, "payment_authorized");
  // a failed_retryable event is retried; processed is final
  await recordStripeEvent(db.app, ev(4), { now: F.at(9) });
  await finishStripeEvent(db.app, "evt_test_4", { status: "failed_retryable", errorCode: "DB_UNAVAILABLE", now: F.at(9) });
  assert.equal((await recordStripeEvent(db.app, ev(4), { now: F.at(10) })).shouldProcess, true);
  await finishStripeEvent(db.app, "evt_test_4", { status: "ignored", now: F.at(10) });
  assert.equal((await recordStripeEvent(db.app, ev(4), { now: F.at(11) })).shouldProcess, false);
  await assert.rejects(db.app.query("UPDATE booking.stripe_webhook_events SET status = 'received' WHERE event_id = 'evt_test_4'"), /final/);
});

test("livemode mismatch is refused and not stored; no payload columns exist; events cannot be deleted", async () => {
  const r = await recordStripeEvent(db.app, ev(5, { livemode: true }), { now: F.at(5) });
  assert.equal(r.error, "LIVEMODE_MISMATCH");
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.stripe_webhook_events WHERE event_id = 'evt_test_5'"), 0);
  const cols = (await db.app.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'booking' AND table_name = 'stripe_webhook_events'")).rows.map((c) => c.column_name);
  assert.ok(!cols.some((c) => /payload|body|data|email|name/.test(c)), cols.join(","));
  await assert.rejects(db.app.query("DELETE FROM booking.stripe_webhook_events"), /permission denied/);
  await assert.rejects(recordStripeEvent(db.app, { ...ev(6), eventId: "not-an-event" }, { now: F.at(5) }), /eventId/);
});
