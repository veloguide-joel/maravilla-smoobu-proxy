// P2b: the booking workers compare the database marker against their CONFIGURED run mode ("test" unless mode:"live").
// Throwaway local PostgreSQL only; no provider call is ever made (no work exists; executors are inert).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMigratedDatabase } from "./harness.mjs";
import { runOrchestratorStep } from "../../lib/booking-db/reservation-worker.js";
import { runCaptureStep } from "../../lib/booking-db/capture-worker.js";
import { runRecordingStep, RECORDING_EXECUTOR_KEYS } from "../../lib/booking-db/recording-worker.js";
import { runCleanupStep } from "../../lib/booking-db/compensation-worker.js";
import { validateAdapterConfig } from "../../lib/hostaway-reservations.js";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });

const L = 777001; const REF_FIELD = 99001; const ACCT = "acct_1RunModeFixture";
const never = () => { throw new Error("no provider call is expected"); };
const inert = new Proxy({}, { get: () => never, has: () => true, ownKeys: () => [], getOwnPropertyDescriptor: () => undefined });
const adapterConfig = validateAdapterConfig({ allowedListingIds: [L], refFieldId: REF_FIELD, channelId: 2000, currency: "USD" });
const dev = (flag) => Object.freeze({ VERCEL_ENV: "development", [flag]: "enabled" });
const WORKERS = {
  reservation: (o) => runOrchestratorStep(db.app, { workerId: "rm-res", env: dev("MV_E7_RESERVATION_WORKER"), adapterConfig, listings: new Map([[L, { currency: "USD" }]]), executors: EX.reservation, clock: Date.now, ...o }),
  capture: (o) => runCaptureStep(db.app, { workerId: "rm-cap", env: dev("MV_E7_CAPTURE_WORKER"), adapterConfig, listings: new Map([[L, { currency: "USD" }]]), executors: EX.capture, clock: Date.now, stripeAccountId: ACCT, ...o }),
  recording: (o) => runRecordingStep(db.app, { workerId: "rm-rec", env: dev("MV_E7_RECORDING_WORKER"), listings: new Map([[L, { accountRef: "acct-test-1", channelId: 2000, currency: "USD", listingId: L, paymentMethod: "credit_card", refFieldId: REF_FIELD }]]), executors: EX.recording, clock: Date.now, ...o }),
  compensation: (o) => runCleanupStep(db.app, { workerId: "rm-cln", env: dev("MV_E7_COMPENSATION_WORKER"), adapterConfig, listings: new Map([[L, { currency: "USD", timeZone: "America/Mexico_City" }]]), executors: EX.compensation, clock: Date.now, stripeAccountId: ACCT, ...o })
};
const EX = {
  reservation: { pricing: { get: never, post: never }, lookupPage: never, retrieveReservation: never, createReservation: never }, capture: inert, compensation: inert,
  recording: { ...Object.fromEntries(RECORDING_EXECUTOR_KEYS.map((k) => [k, never])), label: { accountRef: "acct-test-1", clientSnapshotId: "client-RM" } }
};
const marker = (v) => db.owner.query("UPDATE booking.instance SET environment = $1", [v]);
const brief = (r) => [r.status, r.code ?? null];

for (const [name, step] of Object.entries(WORKERS)) {
  test(`M-${name}: TEST by default; mode "live" needs a 'live' database and a 'test' database refuses it; a 'live' database refuses the default; junk modes are refused before the database`, async () => {
    // TEST database
    assert.equal((await step({})).status, "idle", "default mode on a TEST database: nothing refused (no work)");
    assert.equal((await step({ mode: "test" })).status, "idle");
    assert.deepEqual(brief(await step({ mode: "live" })), ["refused", "DATABASE_NOT_TEST"], "a LIVE worker never runs on a TEST database");
    for (const bad of ["", "LIVE", "prod", null, 1, true]) assert.deepEqual(brief(await step({ mode: bad })), ["refused", "MODE_INVALID"], String(bad));
    // LIVE-marked database (owner change on the throwaway cluster; restored below)
    await marker("live");
    try {
      assert.deepEqual(brief(await step({})), ["refused", "DATABASE_NOT_TEST"], "a TEST worker never runs on a LIVE database");
      assert.deepEqual(brief(await step({ mode: "test" })), ["refused", "DATABASE_NOT_TEST"]);
      assert.equal((await step({ mode: "live" })).status, "idle", "the configured LIVE worker passes the marker (no work, no call)");
    } finally { await marker("test"); }
    assert.equal((await db.owner.query("SELECT environment FROM booking.instance")).rows[0].environment, "test");
  });
}
