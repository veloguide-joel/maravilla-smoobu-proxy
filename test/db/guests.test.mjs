// Stage E2B — minimal guest data, restrictive access, provisional configurable retention (O6).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, collectGuestDetails, purgeGuestData, validateGuest } from "../../db/lib/repo.js";
import { PROVISIONAL_RETENTION, retentionFromEnv } from "../../db/lib/config.js";

let db, report;
before(async () => { db = await startMigratedDatabase(); report = new pg.Pool({ connectionString: db.reportUrl(), max: 2 }); });
after(async () => { await report.end(); await db.close(); });
const guests = async (id) => F.count(db.app, "SELECT count(*) AS n FROM booking.intent_guests WHERE intent_id = $1", [id]);

test("guest input is allowlisted and validated; stored only with DETAILS_COLLECTED, atomically", async () => {
  assert.equal(validateGuest({ ...F.GUEST, address: "x" }), "GUEST_UNKNOWN_FIELD");
  assert.equal(validateGuest({ ...F.GUEST, email: "nope" }), "GUEST_EMAIL");
  assert.equal(validateGuest({ ...F.GUEST, firstName: "<script>" }), "GUEST_FIRST_NAME");
  assert.equal(validateGuest({ ...F.GUEST, phone: "call me" }), "GUEST_PHONE");
  assert.equal(validateGuest({ firstName: "A", lastName: "B", email: "a@b.co" }), null, "phone optional");
  const id = await F.priced(db.app, { listingId: 760001 });
  assert.equal((await collectGuestDetails(db.app, id, F.GUEST, { now: F.at(1) })).error, "TERMS_VERSION_REQUIRED");
  assert.equal(await guests(id), 0);
  // expired quote: E3 refuses, so nothing is stored
  assert.equal((await collectGuestDetails(db.app, id, F.GUEST, { now: F.at(31), termsVersion: "t1" })).error, "QUOTE_EXPIRED");
  assert.equal(await guests(id), 0);
  F.ok(await collectGuestDetails(db.app, id, F.GUEST, { now: F.at(1), termsVersion: "t1" }));
  assert.equal(await guests(id), 1);
  assert.equal((await collectGuestDetails(db.app, id, F.GUEST, { now: F.at(2), termsVersion: "t1" })).error, "ILLEGAL_TRANSITION");
});

test("personal data appears ONLY in intent_guests (full-database scan after complete flows)", async () => {
  await F.confirmed(db.app, { listingId: 760002 });
  const d = await F.dispatched(db.app, { listingId: 760003 });
  await applyEvent(db.app, d.id, { type: "ESCALATE", code: "MANUAL_REVIEW" }, { now: F.at(7) });
  const tables = (await db.owner.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'booking' AND table_type = 'BASE TABLE'")).rows.map((r) => r.table_name);
  const needles = [F.GUEST.firstName, F.GUEST.lastName, F.GUEST.email, "555 0199"];
  for (const t of tables) {
    if (t === "intent_guests") continue;
    const rows = (await db.owner.query(`SELECT row_to_json(x)::text AS j FROM booking.${t} x`)).rows;
    for (const r of rows) for (const n of needles) assert.ok(!r.j.toLowerCase().includes(n.toLowerCase()), `PII "${n}" found in ${t}`);
  }
  assert.ok(tables.length === 17); // 14 core + provider_evidence, reconciliation_resolutions, definite_refusal_codes (E2B.1)
});

test("access: report role cannot read guests; runtime role cannot update or delete them", async () => {
  const id = await F.withDetails(db.app, { listingId: 760004 });
  await assert.rejects(report.query("SELECT email FROM booking.intent_guests"), /permission denied/);
  await assert.rejects(db.app.query("UPDATE booking.intent_guests SET email = 'x@y.z' WHERE intent_id = $1", [id]), /permission denied/);
  await assert.rejects(db.app.query("DELETE FROM booking.intent_guests WHERE intent_id = $1", [id]), /permission denied/);
});

test("O6 retention is provisional and configurable; purge never touches in-progress or under-review intents", async () => {
  assert.equal(PROVISIONAL_RETENTION.status, "provisional-pending-legal-privacy-review");
  assert.deepEqual({ ...retentionFromEnv({ BOOKING_RETENTION_FAILED_DAYS: "7", BOOKING_RETENTION_POST_CHECKOUT_DAYS: "45" }) },
    { failedAttemptDays: 7, postCheckoutDays: 45, status: PROVISIONAL_RETENTION.status });
  assert.throws(() => retentionFromEnv({ BOOKING_RETENTION_FAILED_DAYS: "0" }), /between 1 and 3650/);

  const failed = await F.pending(db.app, { listingId: 760005 });                        // will expire (no booking)
  await F.sessionExpired(db.app, failed);                                               // verified expiry (E2B.1, C3)
  F.ok(await applyEvent(db.app, failed.id, { type: "CHECKOUT_EXPIRED", id: "evt_g5" }, { now: F.at(33) }));
  const booked = await F.confirmed(db.app, { listingId: 760006, from: "2026-12-20", to: "2026-12-24" }); // check-out 2026-12-24
  const live = await F.authorized(db.app, { listingId: 760007 });                       // in progress
  const review = await F.dispatched(db.app, { listingId: 760008 });
  await applyEvent(db.app, review.id, { type: "ESCALATE", code: "MANUAL_REVIEW" }, { now: F.at(7) });

  const day = 24 * 60;
  const ret = { failedAttemptDays: 30, postCheckoutDays: 90 };
  assert.equal(await purgeGuestData(db.app, { now: F.at(29 * day), retention: ret }), 0, "nothing due yet");
  await purgeGuestData(db.app, { now: F.at(31 * day), retention: ret });
  assert.equal(await guests(failed.id), 0, "failed attempt purged after 30 days");
  assert.equal(await guests(booked.id), 1, "booking kept");
  const ninety = Date.UTC(2026, 11, 24) + 90 * 86400000;
  await purgeGuestData(db.app, { now: ninety - 1000, retention: ret });
  assert.equal(await guests(booked.id), 1);
  await purgeGuestData(db.app, { now: ninety + 1000, retention: ret });
  assert.equal(await guests(booked.id), 0, "booking purged 90 days after check-out");
  await purgeGuestData(db.app, { now: F.at(5000 * day), retention: ret });
  assert.equal(await guests(live.id), 1, "in-progress intent never purged");
  assert.equal(await guests(review.id), 1, "open reconciliation case blocks purge");
  // a shorter configured period takes effect without any migration
  const quick = await F.pending(db.app, { listingId: 760009 });
  await F.sessionExpired(db.app, quick);
  F.ok(await applyEvent(db.app, quick.id, { type: "CHECKOUT_EXPIRED", id: "evt_g9" }, { now: F.at(33) }));
  await purgeGuestData(db.app, { now: F.at(33 + 2 * day), retention: { failedAttemptDays: 1, postCheckoutDays: 90 } });
  assert.equal(await guests(quick.id), 0);
  await assert.rejects(purgeGuestData(db.app, { now: F.at(0), retention: { failedAttemptDays: 0, postCheckoutDays: 90 } }), /invalid retention/);
});
