// Stage E2B — concurrency evidence: compare-and-swap races, duplicate events, overlapping claims.
// Races are forced deterministically with barriers (both workers read the same version before either writes).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, beginPayStep, loadIntentRow } from "../../db/lib/repo.js";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });

export const evidence = [];
const transitionsOf = async (id) => (await db.app.query("SELECT version_after, to_state, event_type FROM booking.intent_transitions WHERE intent_id = $1 ORDER BY version_after", [id])).rows;

test("CAS race: two workers, same version, conflicting events -> exactly one commits; loser re-evaluates", async () => {
  const p = await F.pending(db.app, { from: "2027-04-01", to: "2027-04-03" });
  await F.sessionExpired(db.app, p, 5); // E2B.1: expiry must be verified; the race is between two valid events
  const v0 = (await loadIntentRow(db.app, p.id)).version;
  const wait = F.barrier(2);
  const hooks = { afterLoad: async (attempt) => { if (attempt === 0) await wait(); } };
  const [a, b] = await Promise.all([
    applyEvent(db.app, p.id, F.authEvent(p.sessionId, "pi_race_a"), { now: F.at(5), actor: "webhook", hooks }),
    applyEvent(db.app, p.id, { type: "CHECKOUT_EXPIRED", id: "evt_race_exp" }, { now: F.at(5), actor: "webhook", hooks })
  ]);
  const row = await loadIntentRow(db.app, p.id);
  const winners = [a, b].filter((r) => r.ok && !r.duplicate && r.casRetries === 0);
  assert.equal(winners.length, 1, "exactly one first-try commit");
  const loser = winners[0] === a ? b : a;
  assert.ok(loser.casRetries >= 1 || loser.ok === false, "loser lost the version race and re-evaluated");
  // whichever order: the persisted history is a single consistent chain with one audit row per version
  const tr = await transitionsOf(p.id);
  assert.deepEqual(tr.map((t) => t.version_after), [...Array(row.version + 1).keys()]);
  assert.ok(row.version === v0 + 1 || row.version === v0 + 2);
  if (row.state === "reconciliation_required") {
    // expiry won, then the late authorization escalated with a void — money is never silently kept
    assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'stripe.void_payment_intent'", [p.id]), 1);
  } else {
    assert.equal(row.state, "payment_authorized");
  }
  evidence.push({ case: "cas_conflict", final: row.state, versions: tr.length, loserRetries: loser.casRetries ?? null, loserError: loser.error ?? null });
});

test("CAS race: 8 concurrent workers try to start the reservation -> one lease, seven refusals", async () => {
  const a = await F.authorized(db.app, { from: "2027-04-05", to: "2027-04-07" });
  const wait = F.barrier(8);
  const results = await Promise.all([...Array(8).keys()].map((i) => applyEvent(db.app, a.id,
    { type: "RESERVATION_STARTED", workerId: `w${i}`, recheck: { bookable: true, priceSame: true } },
    { now: F.at(6), actor: "worker", workerId: `w${i}`, hooks: { afterLoad: async (n) => { if (n === 0) await wait(); } } })));
  const won = results.filter((r) => r.ok && !r.duplicate);
  assert.equal(won.length, 1);
  assert.ok(results.filter((r) => !r.ok).every((r) => r.error === "ILLEGAL_TRANSITION"));
  const row = await loadIntentRow(db.app, a.id);
  assert.equal(row.state, "reservation_pending");
  assert.equal(row.lease_worker_id, won[0].intent.lease.workerId);
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.intent_transitions WHERE intent_id = $1 AND event_type = 'RESERVATION_STARTED'", [a.id]), 1);
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'hostaway.lookup_reservation'", [a.id]), 1);
  evidence.push({ case: "eight_way_start", winners: won.length, refused: results.length - won.length, retriesSeen: results.map((r) => r.casRetries ?? "-") });
});

test("duplicate event id delivered concurrently -> applied once, second is a duplicate", async () => {
  const p = await F.pending(db.app, { from: "2027-04-09", to: "2027-04-11" });
  const ev = F.authEvent(p.sessionId, "pi_dup_1");
  const wait = F.barrier(2);
  const hooks = { afterLoad: async (n) => { if (n === 0) await wait(); } };
  const [x, y] = await Promise.all([1, 2].map(() => applyEvent(db.app, p.id, ev, { now: F.at(5), actor: "webhook", hooks })));
  assert.equal([x, y].filter((r) => r.ok && !r.duplicate).length, 1);
  assert.equal([x, y].filter((r) => r.ok && r.duplicate).length, 1);
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.intent_applied_events WHERE intent_id = $1 AND event_id = $2", [p.id, ev.id]), 1);
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.payment_ledger WHERE intent_id = $1", [p.id]), 1);
  // and much later, the same id is still a duplicate (permanent, not a bounded window)
  for (let i = 0; i < 120; i++) await applyEvent(db.app, p.id, { type: "ESCALATE", id: `noise_${i}`, code: "NOISE" }, { now: F.at(6) }).catch(() => {});
  const z = await applyEvent(db.app, p.id, ev, { now: F.at(500), actor: "webhook" });
  assert.equal(z.duplicate, true);
  evidence.push({ case: "duplicate_event", applied: 1, duplicates: 2 });
});

test("overlapping claims race (application path): two guests, same nights -> one claim, one DATES_CLAIMED", async () => {
  const stay = { listingId: 700001, from: "2027-05-01", to: "2027-05-05" };
  const g1 = await F.withDetails(db.app, stay);
  const g2 = await F.withDetails(db.app, { ...stay, from: "2027-05-03", to: "2027-05-06" });
  const [r1, r2] = await Promise.all([beginPayStep(db.app, g1, { now: F.at(2) }), beginPayStep(db.app, g2, { now: F.at(2) })]);
  assert.equal([r1, r2].filter((r) => r.ok).length, 1);
  assert.equal([r1, r2].filter((r) => r.error === "DATES_CLAIMED").length, 1);
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.inventory_claims WHERE listing_id = 700001 AND released_at IS NULL"), 1);
  // the loser created no payment attempt and no Stripe operation
  const loser = r1.ok ? g2 : g1;
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.payment_attempts WHERE intent_id = $1", [loser]), 0);
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1", [loser]), 0);
});

test("overlapping claims race (raw SQL, two open transactions): PostgreSQL blocks the second until the first commits, then rejects it", async () => {
  const stay = { listingId: 700002, from: "2027-05-10", to: "2027-05-14" };
  const i1 = await F.withDetails(db.app, stay);
  const i2 = await F.withDetails(db.app, { ...stay, from: "2027-05-13", to: "2027-05-15" });
  const c1 = new pg.Client({ connectionString: db.appUrl() }); const c2 = new pg.Client({ connectionString: db.appUrl() });
  await c1.connect(); await c2.connect();
  const ins = (c, id, from, to) => c.query(`INSERT INTO booking.inventory_claims (intent_id, listing_id, stay, kind, claimed_at, review_after)
                                            VALUES ($1, 700002, daterange($2::date, $3::date, '[)'), 'checkout', now(), now())`, [id, from, to]);
  try {
    await c1.query("BEGIN"); await c2.query("BEGIN");
    await ins(c1, i1, "2027-05-10", "2027-05-14");
    const t0 = Date.now();
    const second = ins(c2, i2, "2027-05-13", "2027-05-15").then(() => "inserted", (e) => e.code);
    await new Promise((r) => setTimeout(r, 300));
    const stillWaiting = await Promise.race([second.then(() => false), Promise.resolve(true)]);
    assert.equal(stillWaiting, true, "second transaction is blocked by the first one's uncommitted claim");
    await c1.query("COMMIT");
    assert.equal(await second, "23P01", "exclusion_violation after the first commits");
    await c2.query("ROLLBACK");
    evidence.push({ case: "raw_overlap", blockedMs: Date.now() - t0, result: "23P01 exclusion_violation" });
  } finally { await c1.end(); await c2.end(); }
});

test("claims: adjacent stays and other listings never conflict; 12 random concurrent claims never overlap", async () => {
  const base = { listingId: 700003 };
  const a = await F.withDetails(db.app, { ...base, from: "2027-06-01", to: "2027-06-05" });
  const b = await F.withDetails(db.app, { ...base, from: "2027-06-05", to: "2027-06-08" }); // check-out day = next check-in
  const c = await F.withDetails(db.app, { listingId: 700004, from: "2027-06-01", to: "2027-06-05" });
  for (const id of [a, b, c]) F.ok(await beginPayStep(db.app, id, { now: F.at(2) }), "non-conflicting claim");

  const days = (n) => new Date(Date.UTC(2027, 7, 1) + n * 86400000).toISOString().slice(0, 10);
  const ids = [];
  for (let i = 0; i < 12; i++) {
    const s = (i * 7) % 20; const len = 2 + (i % 4);
    ids.push(await F.withDetails(db.app, { listingId: 700005, from: days(s), to: days(s + len) }));
  }
  const res = await Promise.all(ids.map((id) => beginPayStep(db.app, id, { now: F.at(2) })));
  assert.ok(res.every((r) => r.ok || r.error === "DATES_CLAIMED"));
  const overlaps = await F.count(db.app, `SELECT count(*) AS n FROM booking.inventory_claims x JOIN booking.inventory_claims y
      ON x.id < y.id AND x.listing_id = y.listing_id AND x.stay && y.stay WHERE x.released_at IS NULL AND y.released_at IS NULL`);
  assert.equal(overlaps, 0);
  evidence.push({ case: "random_claims", attempted: 12, granted: res.filter((r) => r.ok).length, refused: res.filter((r) => !r.ok).length, overlapsFound: overlaps });
});

test("pay step and quote expiry are serialised on the intent row (no orphan claim on an expired intent)", async () => {
  const id = await F.withDetails(db.app, { listingId: 700006, from: "2027-07-01", to: "2027-07-03" });
  const [pay, exp] = await Promise.all([
    beginPayStep(db.app, id, { now: F.at(29) }),
    applyEvent(db.app, id, { type: "EXPIRE" }, { now: F.at(31) })
  ]);
  const row = await loadIntentRow(db.app, id);
  const claim = await F.claimOf(db.app, id);
  if (pay.ok) {
    assert.equal(row.state, exp.ok ? "expired" : "details_collected");
    if (exp.ok) {
      // E2B.1: the Stripe create was queued but never handed to a sender, so no session can exist: the operation is
      // retired, the attempt is provably not_created, and only then may the database release the nights.
      const op = (await db.app.query("SELECT state, dispatched_at FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'stripe.create_checkout_session'", [id])).rows[0];
      assert.deepEqual([op.state, op.dispatched_at], ["superseded", null]);
      assert.equal((await db.app.query("SELECT status FROM booking.payment_attempts WHERE intent_id = $1", [id])).rows[0].status, "not_created");
      assert.ok(claim.released_at, "released only because the attempt is proven never sent");
    } else {
      assert.ok(claim && claim.released_at === null);
    }
  } else {
    assert.equal(pay.error, "NOT_READY_FOR_PAYMENT");
    assert.equal(claim, undefined);
  }
});

test("print concurrency evidence", () => { console.log(JSON.stringify(evidence, null, 1)); });
