// test/e7-hosted-integrated-rehearsal.test.mjs — TEST-ONLY OFFLINE integrated rehearsal of the FIVE frozen hosted runners on main at THEIR OWN
// immutable tooling pins, composed on ONE disposable database migrated to 0021 with FAKE provider exchanges. NOT a runtime change: no runner,
// worker, wrapper, state, schema or closure file is touched; nothing here reads the runners' `executeEnabled` (R0 only records the shipped flags).
//
//   purpose      cross-version composition: Slice 1 (tooling 40779e34) → Slice 2 (59178b04, C1 fix: no final_capture) → Slice 4 recording (4ed7a636, C24 repin) → Slice 5 recorded cleanup (e41b654a),
//                and Slice 1 / 2 → Slice 4 refusal → Slice 3 pristine captured cleanup (9d86bfa1), all against schema 0021. The per-phase hosted
//                tests each seed their START state with their own pin's fixtures; none of them proves that the version N runner accepts the
//                version M runner's actual OUTPUT rows. This file carries the SAME intent / reservation / payment intent / charge / price through.
//   REAL         the five runner cores exactly as exported on main; from EACH pin's checkout: its workers (runOrchestratorStep, runCaptureStep,
//                runRecordingStep, runTestCleanupStep, runMirrorStep), its repo loadIntent, its request functions (requestTestCleanup,
//                requestRecordedTestCleanup), its transports / executors / proofs / lock constants. The seed goes through the LATEST (e41b654a)
//                accepted repo + server pricer only. The worker / request functions are never replaced by fakes and no core is patched.
//   FAKE         the Stripe and Hostaway EXCHANGES only (`{ status, contentType, bytes }` replies from ONE owned fake provider world that is
//                carried through all phases of a scenario), the credentials (synthetic strings), the runner digest (zeros).
//   clock        the REAL clock (Date.now) in every phase — the recording and recorded-cleanup workers compare against the database clock, and
//                the seed is stamped at the real now so the Stripe `capture_before` window (now + 7 d) is honoured by the accepted proofs.
//   scheduling   TEST-HARNESS SCHEDULING ONLY, labelled and measured: where a runner would `sleep(delayMs)` in real time between worker steps,
//                this harness waits the REAL delay (≤ REAL_WAIT_CAP_MS = 150 s; the accepted E7.1 "reads ≥ 2 min after the create" freshness
//                window is therefore honoured in real time) and THROWS on any longer wait — there is no owner-side rescheduling fallback. Before
//                scenario B's second session it waits in real time until the worker's OWN next_action_at. Every sleep is logged (`# scheduling`)
//                and Z asserts every entry is a real wait. The workers' own leases, proof windows, schedules and deadlines are untouched.
//   bootstrap    the closure gate (`closureGate`) is an UNCONDITIONAL awaited top-level step: when the DB section is enabled, every runner's
//                closure bytes at its pin are verified BEFORE any tooling import / database start, independent of test filters; a mismatch throws
//                and nothing below it runs (the child-process control N2 proves zero tooling resolution / zero DB activity on a tampered pin).
//   isolation    no network (https / fetch refused at module load), no env secrets, no live DB: a throwaway cluster from the e41b654a harness.
//   opt-in       E7_REHEARSAL_DB_TESTS=1 and E7_REHEARSAL_TOOLING_ROOT=<dir holding checkouts 40779e34/ 59178b04/ 9d86bfa1/ 4ed7a636/ e41b654a/ (each with
//                node_modules)>. Without the flag the file only checks the declared pins and exits.
//
// scenario A (ref ECHOED): reservation → capture → recording → recorded cleanup. Ends cancelled, all three settlement legs, claim released; EXACTLY
//   1 create POST, 1 capture POST, 1 record POST, 1 cancel PUT, 1 Stripe refund POST, 1 mirror POST; create / capture / recording history preserved;
//   the guest.notify queued by recording is SUPPRESSED (audited) and never dispatched.
// scenario B (ref NOT echoed — the observed live Hostaway case): reservation confirms (no relabel, no PUT), capture succeeds, recording REFUSES
//   REF_NOT_ECHOED with ZERO record POST (before the worker), then the PRISTINE captured cleanup cancels + refunds with ZERO record / mirror /
//   notify and the claim released.
// Both: an intermediate BASELINE active booking (seeded first, never named in any plan) is byte-identical before and after, and NO row of any
//   foreign intent changes (per-intent row counts + fingerprints over every booking.* table with an intent_id column).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { realpathSync, existsSync, mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const GUARD = { request: 0, Agent: 0, fetch: 0 };
https.request = () => { GUARD.request += 1; throw new Error("network refused"); };
https.Agent = class { constructor() { GUARD.Agent += 1; throw new Error("network refused"); } };
globalThis.fetch = async () => { GUARD.fetch += 1; throw new Error("network refused"); };
syncBuiltinESMExports();

const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const [RES, CAP, TCL, REC, RCL] = await Promise.all(["reservation", "capture", "test-cleanup", "recording", "recorded-cleanup"].map((n) => import(pathToFileURL(join(ROOT, "scripts", `e7-hosted-${n}.mjs`)).href)));
/** the five frozen runners and the tooling commit each one pins (the composition under test) */
const RUNNERS = Object.freeze([
  { name: "reservation", E: RES, pin: "40779e34e8c65ac5c4494bc5a18cd4223ef723fa" },
  { name: "capture", E: CAP, pin: "59178b0468469b6570beab861bbc8e48b3a887d1" },        // C2: Slice 2 at the merged C1 fix (omits final_capture); Slice 1 stays at 40779e34
  { name: "test-cleanup", E: TCL, pin: "9d86bfa1e60779b3794de88bbae151670e8fe515" },
  { name: "recording", E: REC, pin: "4ed7a636fee57981262b9c02574190d225b8a1fc" },         // C24: Slice 4 at the merged C21-F1 fix (null-provider list rows); Slices 1 / 2 / 3 / 5 unchanged
  { name: "recorded-cleanup", E: RCL, pin: "e41b654a667cb0ba8775b5bd0040c28a3d14fda0" },
]);
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
const MINUTE = 60000; const DAY = 86400000;
const REAL_WAIT_CAP_MS = 150000;                      // test-harness scheduling: REAL wait up to 150 s per sleep (covers the E7.1 two-minute read freshness window); longer → throw (see header)

test("R0 the five runners declare the expected immutable tooling pins; shipped executeEnabled = [false, false, false, true, false] (C29 prepared enable revision: only the Slice 4 recording flag OPEN, pending D-a / D-b / D-c; Slices 1–3 and 5 CLOSED). The rehearsal itself never reads the flag", () => {
  assert.deepEqual(RUNNERS.map((r) => r.E.CONSTANTS.executeEnabled), [false, false, false, true, false]);   // C29 prepared enable revision: Slice 4 flag OPEN (pending D-a / D-b / D-c)
  for (const r of RUNNERS) {
    assert.equal(r.E.CONSTANTS.toolingCommit, r.pin, r.name);
    assert.ok(Array.isArray(r.E.CONSTANTS.closure) && /^[0-9a-f]{64}$/.test(r.E.CONSTANTS.closureDigest), `${r.name} closure`);
  }
  assert.deepEqual(RUNNERS.map((r) => r.E.CONSTANTS.toolingCommit.slice(0, 8)), ["40779e34", "59178b04", "9d86bfa1", "4ed7a636", "e41b654a"]);
});

/** the closure gate: every runner's closure BYTES at its pin checkout == its frozen digest (the runner's OWN exported prefix). Pure: reads
 *  files only, imports nothing from the pins, touches no database. Throws `CLOSURE_MISMATCH:<runner>@<pin>` (or `CHECKOUT_MISSING`). */
export async function closureGate(pinRoot) {
  const out = [];
  for (const r of RUNNERS) {
    const dir = join(pinRoot, r.pin.slice(0, 8));
    if (!existsSync(join(dir, "package.json"))) throw new Error(`CHECKOUT_MISSING:${r.name}@${r.pin.slice(0, 8)}`);
    const got = await RES.framedDigest(dir, r.E.CONSTANTS.closure, r.E.CLOSURE_DIGEST_PREFIX).catch((e) => { throw new Error(`CLOSURE_UNREADABLE:${r.name}@${r.pin.slice(0, 8)}:${e && e.code ? e.code : e}`); });
    if (got !== r.E.CONSTANTS.closureDigest) throw new Error(`CLOSURE_MISMATCH:${r.name}@${r.pin.slice(0, 8)}`);
    out.push({ name: r.name, pin: r.pin.slice(0, 8), files: r.E.CONSTANTS.closure.length, digest: got });
  }
  return out;
}

// ---- (0) UNCONDITIONAL awaited bootstrap: the closure gate runs here, at module top level, BEFORE any tooling import or database start. It does
//      not depend on which tests are selected; a mismatch throws out of the module and nothing below executes.
const DB_ON = process.env.E7_REHEARSAL_DB_TESTS === "1";
const PIN_ROOT = DB_ON ? realpathSync(process.env.E7_REHEARSAL_TOOLING_ROOT) : null;
const GATE = DB_ON ? await closureGate(PIN_ROOT) : null;
if (GATE) for (const g of GATE) console.log(`# gate ${g.name} @ ${g.pin}: ${g.files} files, digest ${g.digest.slice(0, 16)}… == pin (verified before any tooling import)`);

if (DB_ON) {
  const pinDir = (pin) => join(PIN_ROOT, pin.slice(0, 8));
  const at = (pin, p) => import(pathToFileURL(join(pinDir(pin), p)).href);
  const P1 = RUNNERS[0].pin, P2 = RUNNERS[1].pin, P3 = RUNNERS[2].pin, P4 = RUNNERS[3].pin, P5 = RUNNERS[4].pin;

  test("R1 tooling closure bytes (report): the awaited bootstrap gate verified all five runners' closures at their pins before any tooling import; re-checked here", async () => {
    assert.equal(GATE.length, 5);
    const again = await closureGate(PIN_ROOT);
    assert.deepEqual(again, GATE);
    for (const g of GATE) console.log(`# R1 ${g.name} @ ${g.pin}: ${g.files} files, digest ${g.digest.slice(0, 16)}… == pin`);
  });

  // ---- latest (e41b654a) harness + fixtures + repo: the ONE disposable database at 0021 and the ONE seed path ------------------------------------
  const [{ startMigratedDatabase }, F, R, O, SP, DP, PA] = await Promise.all([at(P5, "test/db/harness.mjs"), at(P5, "test/db/fixtures.mjs"), at(P5, "lib/booking-db/repo.js"),
    at(P5, "lib/booking-db/operations.js"), at(P5, "lib/checkout/server-pricer.js"), at(P5, "lib/direct-policy.js"), at(P5, "lib/public-api.js")]);
  const db = await startMigratedDatabase();
  after(async () => { await db.close(); });

  // ---- per-pin REAL tooling (the SAME construction as each runner's own I-tests, from ITS checkout) ------------------------------------------------
  const [T1, EA1, HR1, CP1, LK1, IS1, W1res, R1] = await Promise.all([at(P1, "scripts/e7-connected/http-transports.mjs"), at(P1, "scripts/e7-connected/executor-adapters.mjs"),
    at(P1, "lib/hostaway-reservations.js"), at(P1, "lib/checkout/capture-proof.js"), at(P1, "scripts/e7-connected/run-lock-precheck.mjs"), at(P1, "lib/checkout/intent-state.js"),
    at(P1, "lib/booking-db/reservation-worker.js"), at(P1, "lib/booking-db/repo.js")]);
  const toolingRes = { runOrchestratorStep: W1res.runOrchestratorStep, loadIntent: R1.loadIntent, createPhaseExecutors: EA1.createPhaseExecutors, createStripeSend: T1.createE7StripeTestSend,
    createHostawaySend: T1.createE7HostawaySend, validateAdapterConfig: HR1.validateAdapterConfig, paymentIntentProofObservationV3: CP1.paymentIntentProofObservationV3,
    stillAuthorizedV3Refusal: CP1.stillAuthorizedV3Refusal, LOCK_KEY: LK1.LOCK_KEY, LOCK_PRECHECK_SQL: LK1.LOCK_PRECHECK_SQL };
  // C2: Slice 2's tooling comes from ITS OWN pin (59178b04, the C1 fix) — a DIFFERENT checkout from Slice 1's 40779e34
  const [T2, EA2, HR2, CP2, LK2, IS2, W2cap, R2] = await Promise.all([at(P2, "scripts/e7-connected/http-transports.mjs"), at(P2, "scripts/e7-connected/executor-adapters.mjs"),
    at(P2, "lib/hostaway-reservations.js"), at(P2, "lib/checkout/capture-proof.js"), at(P2, "scripts/e7-connected/run-lock-precheck.mjs"), at(P2, "lib/checkout/intent-state.js"),
    at(P2, "lib/booking-db/capture-worker.js"), at(P2, "lib/booking-db/repo.js")]);
  const toolingCap = { runCaptureStep: W2cap.runCaptureStep, captureKey: IS2.captureKey, loadIntent: R2.loadIntent, createPhaseExecutors: EA2.createPhaseExecutors, createStripeSend: T2.createE7StripeTestSend,
    createHostawaySend: T2.createE7HostawaySend, validateAdapterConfig: HR2.validateAdapterConfig, paymentIntentProofObservationV3: CP2.paymentIntentProofObservationV3,
    stillAuthorizedV3Refusal: CP2.stillAuthorizedV3Refusal, LOCK_KEY: LK2.LOCK_KEY, LOCK_PRECHECK_SQL: LK2.LOCK_PRECHECK_SQL };

  const [TT3, T3, EX3, HR3, CP3, RP3, TP3, CO3, IS3, LK3, W3, TCR3, R3] = await Promise.all([at(P3, "scripts/e7-connected/test-cleanup-transports.mjs"), at(P3, "scripts/e7-connected/http-transports.mjs"),
    at(P3, "scripts/e7-connected/test-cleanup-executors.mjs"), at(P3, "lib/hostaway-reservations.js"), at(P3, "lib/checkout/capture-proof.js"), at(P3, "lib/checkout/recovery-plan.js"),
    at(P3, "lib/checkout/test-cleanup-proof.js"), at(P3, "lib/checkout/compensation-proof.js"), at(P3, "lib/checkout/intent-state.js"), at(P3, "scripts/e7-connected/run-lock-precheck.mjs"),
    at(P3, "lib/booking-db/cleanup-worker.js"), at(P3, "lib/booking-db/test-cleanup.js"), at(P3, "lib/booking-db/repo.js")]);
  const toolingTcl = { runTestCleanupStep: W3.runTestCleanupStep, requestTestCleanup: TCR3.requestTestCleanup, loadIntent: R3.loadIntent,
    createTestCleanupExecutors: EX3.createTestCleanupExecutors, createStripeSend: TT3.createE7StripeTestCleanupSend, createHostawaySend: T3.createE7HostawaySend, validateAdapterConfig: HR3.validateAdapterConfig,
    unwrapEnvelope: HR3.unwrapEnvelope, normalizeReservation: HR3.normalizeReservation, lookupByRef: HR3.lookupByRef, activeReservationProof: CO3.activeReservationProof,
    paymentIntentProofObservationV3: CP3.paymentIntentProofObservationV3, piIdentityOk: RP3.piIdentityOk, rawPiPreSendRefusal: TP3.rawPiPreSendRefusal, refundObservation: TP3.refundObservation,
    arrivalStrictlyFuture: CO3.arrivalStrictlyFuture, refundKey: IS3.refundKey, publicStatus: IS3.publicStatus, LOCK_KEY: LK3.LOCK_KEY, LOCK_PRECHECK_SQL: LK3.LOCK_PRECHECK_SQL };

  const [EX4, T4, HR4, CO4, OP4, IS4, LK4, W4, R4] = await Promise.all([at(P4, "scripts/e7-connected/executor-adapters.mjs"), at(P4, "scripts/e7-connected/http-transports.mjs"),
    at(P4, "lib/hostaway-reservations.js"), at(P4, "lib/checkout/compensation-proof.js"), at(P4, "lib/checkout/offline-charge-proof.js"), at(P4, "lib/checkout/intent-state.js"),
    at(P4, "scripts/e7-connected/run-lock-precheck.mjs"), at(P4, "lib/booking-db/recording-worker.js"), at(P4, "lib/booking-db/repo.js")]);
  const toolingRec = { runRecordingStep: W4.runRecordingStep, loadIntent: R4.loadIntent, createPhaseExecutors: EX4.createPhaseExecutors, createHostawaySend: T4.createE7HostawaySend,
    validateAdapterConfig: HR4.validateAdapterConfig, unwrapEnvelope: HR4.unwrapEnvelope, normalizeReservation: HR4.normalizeReservation, activeReservationProof: CO4.activeReservationProof,
    assessChargeList: OP4.assessChargeList, preflightListObservation: OP4.preflightListObservation, classifyTitle: OP4.classifyTitle, providerIdToCanonical: OP4.providerIdToCanonical, amountToMinor: HR4.amountToMinor,
    publicStatus: IS4.publicStatus, LOCK_KEY: LK4.LOCK_KEY, LOCK_PRECHECK_SQL: LK4.LOCK_PRECHECK_SQL };

  const [TT5, T5, EX5, HR5, CP5, RP5, TP5, CO5, IS5, MP5, OP5, LK5, W5, MW5, TR5, MT5] = await Promise.all([at(P5, "scripts/e7-connected/test-cleanup-transports.mjs"), at(P5, "scripts/e7-connected/http-transports.mjs"),
    at(P5, "scripts/e7-connected/test-cleanup-executors.mjs"), at(P5, "lib/hostaway-reservations.js"), at(P5, "lib/checkout/capture-proof.js"), at(P5, "lib/checkout/recovery-plan.js"),
    at(P5, "lib/checkout/test-cleanup-proof.js"), at(P5, "lib/checkout/compensation-proof.js"), at(P5, "lib/checkout/intent-state.js"), at(P5, "lib/checkout/mirror-proof.js"),
    at(P5, "lib/checkout/offline-charge-proof.js"), at(P5, "scripts/e7-connected/run-lock-precheck.mjs"), at(P5, "lib/booking-db/cleanup-worker.js"), at(P5, "lib/booking-db/mirror-worker.js"),
    at(P5, "lib/booking-db/test-cleanup-recorded.js"), at(P5, "lib/booking-db/mirror-transport.js")]);
  const toolingRcl = { runTestCleanupStep: W5.runTestCleanupStep, runMirrorStep: MW5.runMirrorStep, requestRecordedTestCleanup: TR5.requestRecordedTestCleanup, loadIntent: R.loadIntent,
    createTestCleanupExecutors: EX5.createTestCleanupExecutors, buildHostawayMirrorExecutors: MT5.buildHostawayMirrorExecutors, createStripeSend: TT5.createE7StripeTestCleanupSend,
    createHostawaySend: T5.createE7HostawaySend, validateAdapterConfig: HR5.validateAdapterConfig, unwrapEnvelope: HR5.unwrapEnvelope, normalizeReservation: HR5.normalizeReservation,
    activeReservationProof: CO5.activeReservationProof, paymentIntentProofObservationV3: CP5.paymentIntentProofObservationV3, piIdentityOk: RP5.piIdentityOk, rawPiPreSendRefusal: TP5.rawPiPreSendRefusal,
    refundObservation: TP5.refundObservation, arrivalStrictlyFuture: CO5.arrivalStrictlyFuture, refundKey: IS5.refundKey, publicStatus: IS5.publicStatus, mirrorTitle: MP5.mirrorTitle, classifyTitle: OP5.classifyTitle,
    classifyMirrorTitle: MP5.classifyMirrorTitle, providerIdToCanonical: OP5.providerIdToCanonical, amountToMinor: HR5.amountToMinor, LOCK_KEY: LK5.LOCK_KEY, LOCK_PRECHECK_SQL: LK5.LOCK_PRECHECK_SQL };

  for (const [name, E, tooling] of [["reservation", RES, toolingRes], ["capture", CAP, toolingCap], ["test-cleanup", TCL, toolingTcl], ["recording", REC, toolingRec], ["recorded-cleanup", RCL, toolingRcl]]) {
    if (Array.isArray(E.TOOLING_KEYS)) { const missing = E.TOOLING_KEYS.filter((k) => typeof tooling[k] !== "function" && !(k in tooling)); assert.deepEqual(missing, [], `${name}: tooling keys`); }
  }

  // ---- the ONE seed path (LATEST accepted repo + pricer; = the Slice 1 I-test's labelled `authorizedIntent`, stamped at the REAL now) ------------------
  const C1 = RES.CONSTANTS, C2 = CAP.CONSTANTS, C3 = TCL.CONSTANTS, C4 = REC.CONSTANTS, C5 = RCL.CONSTANTS;
  const LIST = 606998; const ACCT = C1.accountId;
  assert.equal(C1.refFieldId, C4.refFieldId); assert.equal(C1.refFieldId, C5.refFieldId); assert.equal(C1.refFieldId, C3.refFieldId);
  assert.deepEqual([C2.accountId, C3.accountId, C5.accountId], [ACCT, ACCT, ACCT]);
  const NIGHTLY = 1600; const POLICY = DP.readDirectPolicyFromEnv({ VERCEL_ENV: "development", MV_E7_RESERVATION_WORKER: "enabled" }).policy;
  const dayRows = (from, to) => { const out = []; for (let d = from; d <= to; d = F.addDays(d, 1)) out.push({ date: d, status: "available", isAvailable: 1, minimumStay: 1, maximumStay: 90, closedOnArrival: 0, closedOnDeparture: 0 }); return out; };
  const pricing = {
    get: async (path, opts = {}) => { const m = /^\/listings\/(\d+)(\/calendar)?$/.exec(path); if (!m[2]) return { status: 200, json: { result: { id: Number(m[1]), currencyCode: "USD", personCapacity: 4, minNights: 1, maxNights: 90 } } };
      return { status: 200, json: { result: dayRows(opts.query.startDate, opts.query.endDate) } }; },
    post: async (path, body) => { const nights = Math.round((Date.parse(body.endingDate) - Date.parse(body.startingDate)) / 86400000);
      return { status: 200, json: { status: "success", result: { totalPrice: NIGHTLY * nights, components: [{ id: 1, type: "accommodation", name: "baseRate", title: "Base rate", quantity: 1, value: NIGHTLY, total: NIGHTLY * nights, isIncludedInTotalPrice: 1, isMandatory: 1, isOverriddenByUser: 0, isDeleted: 0, units: nights }] } } }; }
  };
  let stayK = 0; const OURS = new Set();
  async function authorizedIntent(label) {
    stayK += 1;
    const stay = { listingId: LIST, from: F.addDays("2027-03-01", 5 * stayK), to: F.addDays("2027-03-01", 5 * stayK + 4), guests: 2 };
    const base = Date.now() - 10 * MINUTE;                                                  // REAL clock: authorised ten minutes ago, capture window now + 7 d
    const priced = await SP.priceStay({ request: { ...stay }, listingConfig: { currency: "USD" }, client: pricing, policy: POLICY, today: PA.todayInTimeZone(undefined, new Date(base)), now: base });
    assert.ok(priced.ok, priced.error);
    const intent = await R.createIntentRecord(db.app, { ref: F.nextRef(), accessTokenHash: F.tokenHash(), environment: "test", now: base, ...stay });
    F.ok(await R.applyEvent(db.app, intent.id, { type: "PRICE_CONFIRMED", price: priced.price }, { now: base, actor: "guest" }));
    F.ok(await R.collectGuestDetails(db.app, intent.id, F.GUEST, { now: base + 1000, termsVersion: "terms-2026-10" }));
    const b = F.ok(await R.beginPayStep(db.app, intent.id, { now: base + 2000 }));
    const op = await O.claimNextOperation(db.app, { workerId: "w-pay", now: base + 2000, intentId: intent.id, opTypes: ["stripe.create_checkout_session"] });
    const sessionId = `cs_test_reh${label}${String(stayK).padStart(5, "0")}`;
    F.ok(await O.completeOperation(db.app, op.id, { workerId: "w-pay", now: base + 2000, outcome: { status: "succeeded", resultRef: sessionId } }));
    F.ok(await R.recordCheckoutSession(db.app, intent.id, b.attempt.id, { sessionId, expiresAt: base + 30 * MINUTE, now: base + 2000 }));
    const piId = `pi_REH${label}${String(stayK).padStart(9, "0")}`;
    const captureBefore = Math.floor((base + 7 * DAY) / 1000) * 1000;
    F.ok(await R.applyEvent(db.app, intent.id, { type: "PAYMENT_AUTHORIZED", id: `evt_auth_${piId}`, paymentIntentId: piId, sessionId, amountMinor: priced.price.finalTotalMinor,
      currency: "usd", livemode: false, authorizationCreatedAt: base + 3000, captureBefore }, { now: base + 4000, actor: "webhook" }));
    const pa = (await db.app.query("SELECT id::text AS id FROM booking.payment_attempts WHERE intent_id = $1 AND status = 'completed'", [intent.id])).rows[0].id;
    const i = await R.loadIntent(db.app, intent.id);
    assert.equal(i.status, "payment_authorized"); OURS.add(intent.id);
    return { id: intent.id, base, piId, attemptId: pa, sessionId, stay: { ...stay, currency: "USD" }, ref: i.ref, intent: i, total: i.price.finalTotalMinor, chargeId: `ch_REH${label}${intent.id.replace(/-/g, "").slice(0, 14)}` };
  }

  // ---- the ONE owned fake provider world per scenario: Stripe + Hostaway, carried through every phase ----------------------------------------------
  function world(a, o = {}) {
    const w = { calls: [], writes: [], echoRef: o.echoRef ?? true, res: null, nextRes: 73000000 + stayK * 10, captured: false, refunded: 0, refundId: `re_REH${a.id.replace(/-/g, "").slice(0, 16)}`,
      refundOpId: null, refundCreated: null, resStatus: "new", charges: [], nextCharge: 7700000 + stayK * 100, mirrorSeq: 900000 + stayK * 100, bodies: {} };
    const reply = (status, x) => Promise.resolve({ status, contentType: "application/json", bytes: enc(x) });
    const pi = () => ({ object: "payment_intent", id: a.piId, livemode: false, status: w.captured ? "succeeded" : "requires_capture", capture_method: "manual", amount: a.total,
      amount_received: w.captured ? a.total : 0, amount_capturable: w.captured ? 0 : a.total, currency: "usd", metadata: { mv_intent_id: a.id, mv_payment_attempt_id: a.attemptId },
      latest_charge: { object: "charge", id: a.chargeId, payment_intent: a.piId, status: "succeeded", paid: true, captured: w.captured, amount: a.total, amount_captured: w.captured ? a.total : 0,
        amount_refunded: w.refunded, refunded: w.refunded >= a.total, disputed: false, currency: "usd", livemode: false, payment_method_details: { card: { capture_before: a.intent.payment.captureBefore / 1000 } } } });
    const refund = () => ({ object: "refund", id: w.refundId, payment_intent: a.piId, charge: a.chargeId, amount: a.total, currency: "usd", status: "succeeded", created: w.refundCreated, reason: null, failure_reason: null,
      metadata: { mv_refund_op: w.refundOpId, mv_refund_key: `ref:${a.id}:1` } });
    const full = (echo = w.echoRef) => ({ id: w.res, listingMapId: LIST, channelId: 2000, arrivalDate: a.stay.from, departureDate: a.stay.to, totalPrice: a.total / 100, currency: "USD", status: w.resStatus,
      customFieldValues: echo ? [{ customFieldId: C1.refFieldId, value: a.ref }] : [] });
    w.stripe = (req) => {
      const p = req.url.replace("https://api.stripe.com", ""); w.calls.push(`S ${req.method} ${p}`);
      if (p === "/v1/account") return reply(200, { object: "account", id: ACCT });
      if (req.method === "POST") {
        w.writes.push(`S POST ${p}`);
        if (p === `/v1/payment_intents/${a.piId}/capture`) {
          w.bodies.capture = { key: req.headers["Idempotency-Key"], body: req.body };
          assert.equal(req.body, `amount_to_capture=${a.total}&expand%5B%5D=latest_charge`, "C1/C2 wire: no final_capture");
          w.captured = true; return reply(200, pi());
        }
        if (p === "/v1/refunds") {
          const m = /^payment_intent=([^&]+)&amount=(\d+)&metadata%5Bmv_refund_op%5D=([^&]+)&metadata%5Bmv_refund_key%5D=([^&]+)$/.exec(req.body);
          assert.ok(m, req.body); assert.deepEqual([m[1], Number(m[2]), decodeURIComponent(m[4]), req.headers["Idempotency-Key"]], [a.piId, a.total, `ref:${a.id}:1`, `ref:${a.id}:1`]);
          w.refundOpId = m[3]; w.refundCreated = Math.floor(Date.now() / 1000); w.refunded = a.total; w.bodies.refund = req.body; return reply(200, refund());
        }
        return reply(400, { error: { type: "invalid_request_error", message: `unexpected ${p}` } });
      }
      if (p.startsWith("/v1/refunds/")) return reply(200, refund());
      if (p.startsWith("/v1/refunds?")) return reply(200, { object: "list", url: "/v1/refunds", has_more: false, data: w.refunded ? [refund()] : [] });
      return reply(200, pi());
    };
    w.hostaway = (req) => {
      const u = new URL(req.url); const p = req.url.replace("https://api.hostaway.com", ""); w.calls.push(`H ${req.method} ${p}`);
      if (req.method !== "GET" && !/priceDetails$/.test(u.pathname)) w.writes.push(`H ${req.method} ${u.pathname}`);   // priceDetails is a pricing READ over POST
      if (req.method === "GET" && /^\/v1\/listings\/\d+$/.test(p)) return pricing.get(p.slice(3)).then((x) => reply(x.status, x.json));
      if (req.method === "GET" && /^\/v1\/listings\/\d+\/calendar$/.test(u.pathname)) return pricing.get(u.pathname.slice(3), { query: Object.fromEntries(u.searchParams) }).then((x) => reply(x.status, x.json));
      if (req.method === "POST" && /priceDetails$/.test(p)) return pricing.post(p.slice(3), JSON.parse(req.body)).then((x) => reply(x.status, x.json));
      if (req.method === "GET" && p.startsWith("/v1/reservations?")) return reply(200, { status: "success", result: u.searchParams.has("afterId") || w.res === null ? [] : [full(true)] });
      if (req.method === "POST" && p === "/v1/reservations") { assert.equal(w.res, null, "exactly one create"); w.res = w.nextRes++; w.bodies.create = JSON.parse(req.body); return reply(201, { status: "success", result: full() }); }
      let m = /^\/v1\/reservations\/(\d+)$/.exec(u.pathname);
      if (req.method === "GET" && m) return Number(m[1]) === w.res ? reply(200, { status: "success", result: full() }) : reply(404, { status: "fail" });
      m = /^\/v1\/reservations\/(\d+)\/statuses\/cancelled$/.exec(u.pathname);
      if (req.method === "PUT" && m) { assert.equal(Number(m[1]), w.res); assert.equal(req.body, JSON.stringify({ cancelledBy: "host" })); w.resStatus = "cancelled"; return reply(200, { status: "success", result: full() }); }
      if (req.method === "GET" && u.pathname === "/v1/guestPayments/charges") {
        w.bodies.lists = (w.bodies.lists ?? []).concat(u.search);
        return reply(200, { status: "success", result: w.charges.map((x) => JSON.parse(JSON.stringify(x))), count: w.charges.length, limit: 500, offset: null });
      }
      m = /^\/v1\/guestPayments\/charges\/(\d+)$/.exec(u.pathname);
      if (req.method === "POST" && m) {
        assert.equal(Number(m[1]), w.res); const body = JSON.parse(req.body); w.bodies.record = body;
        const ch = { id: w.nextCharge++, listingMapId: LIST, reservationId: w.res, type: "charge", title: body.title, currency: "USD", paymentMethod: "credit_card", amount: body.amount, status: "paid", paymentProvider: "offline" };
        w.charges.push(ch); return reply(201, { status: "success", result: { ...ch } });
      }
      m = /^\/v1\/guestPayments\/charges\/(\d+)\/(\d+)\/refund$/.exec(u.pathname);
      if (req.method === "POST" && m) {
        assert.equal(Number(m[1]), w.res); const body = JSON.parse(req.body); w.bodies.mirror = { body, headers: Object.keys(req.headers).sort(), chargeId: m[2] };
        w.mirrorSeq += 1;
        const row = { id: w.mirrorSeq, reservationId: w.res, listingMapId: LIST, type: "refund", title: body.title, amount: -a.total / 100, currency: "USD", status: "succeeded", paymentProvider: "offline", paymentMethod: "credit_card",
          refundInfo: { id: w.mirrorSeq + 1000000, chargeId: w.mirrorSeq, refundedChargeId: Number(m[2]) } };
        w.charges.push(row); return reply(200, { status: "success", result: { id: row.id, refundInfo: { ...row.refundInfo }, status: "succeeded", paymentProvider: "offline" } });
      }
      return reply(404, { status: "fail", message: `unexpected ${req.method} ${p}` });
    };
    return w;
  }

  // ---- test-harness scheduling (labelled, measured) -------------------------------------------------------------------------------------------------
  const schedule = [];
  const harnessSleep = (phase) => async (ms) => {
    const n = Math.max(0, Number(ms) || 0);
    if (n > REAL_WAIT_CAP_MS) { schedule.push({ phase, ms: n, path: "REFUSED" }); throw new Error(`REHEARSAL_WAIT_BEYOND_CAP:${phase}:${n}`); }   // never rescheduled by the harness
    schedule.push({ phase, ms: n, path: "real-wait" }); await new Promise((r) => setTimeout(r, n));
  };
  const creds = { stripe: () => "sk_test_Fake1", hostaway: () => "synthetic-hostaway-token" };
  const ZERO = "0".repeat(64);
  const nb = (a) => new Date(a.base - MINUTE).toISOString();                  // the plan's notBefore: one minute before the intent's own creation stamp
  const ver = async (id) => (await db.app.query("SELECT version FROM booking.intents WHERE id = $1", [id])).rows[0].version;

  // ---- DB observation: per-intent row counts + fingerprints across every booking.* table with an intent_id column (foreign-write / baseline guard) ----
  const TABLES = (await db.owner.query("SELECT table_name FROM information_schema.columns WHERE table_schema = 'booking' AND column_name = 'intent_id' ORDER BY table_name")).rows.map((r) => r.table_name);
  assert.ok(!TABLES.includes("intents"), "intents has no intent_id column: it is fingerprinted separately below, keyed by id");
  /** per-intent fingerprints: the FULL booking.intents row (keyed by id, every column incl. version / updated_at) + every child table with an
   *  intent_id column (row count + md5 over the whole rows). `q` is any query runner (pool or a transaction client), so a guard can observe
   *  inside a transaction it later rolls back. */
  const fingerprints = async (q = db.owner, { childrenOnly = false } = {}) => {
    const out = {};
    if (!childrenOnly) for (const r of (await q.query("SELECT id::text AS id, md5(x::text) AS fp FROM booking.intents x")).rows) (out[r.id] ??= {}).intents = `1:${r.fp}`;
    for (const t of TABLES) {
      const rows = (await q.query(`SELECT intent_id::text AS id, count(*)::int AS n, md5(string_agg(x::text, '|' ORDER BY x::text)) AS fp FROM booking.${t} x GROUP BY intent_id`)).rows;
      for (const r of rows) (out[r.id] ??= {})[t] = `${r.n}:${r.fp}`;
    }
    return out;
  };
  /** the migration ledger the harness's own migrator writes (booking_migrations.applied): EXACT 0001..0021, in order */
  const appliedMigrations = async () => (await db.owner.query("SELECT version FROM booking_migrations.applied ORDER BY version")).rows.map((r) => String(r.version).padStart(4, "0"));
  const snap = async (id) => ({
    st: (await db.app.query("SELECT state, version, reason_code, hostaway_reservation_id::text AS rid, offline_charge_id::text AS och, captured_minor::text AS cap, settlement_reservation_cancelled AS c, settlement_authorization_settled AS a, settlement_recording_mirrored AS m FROM booking.intents WHERE id = $1", [id])).rows[0],
    ops: (await db.app.query("SELECT op_type, state, attempts, (dispatched_at IS NOT NULL) AS d, result_ref FROM booking.external_operations WHERE intent_id = $1 ORDER BY created_at, op_type", [id])).rows,
    transitions: (await db.app.query("SELECT from_state, to_state FROM booking.intent_transitions WHERE intent_id = $1 ORDER BY recorded_at, id", [id])).rows.map((x) => `${x.from_state}>${x.to_state}`),
    claim: (await db.app.query("SELECT (released_at IS NOT NULL) AS released FROM booking.inventory_claims WHERE intent_id = $1", [id])).rows,
    refunds: (await db.app.query("SELECT seq, state, stripe_refund_id, amount_minor::text AS amt FROM booking.payment_refunds WHERE intent_id = $1 ORDER BY seq", [id])).rows,
    ledger: (await db.app.query("SELECT entry FROM booking.payment_ledger WHERE intent_id = $1 ORDER BY id", [id])).rows.map((x) => x.entry),
    suppressions: Number((await db.app.query("SELECT count(*)::int AS n FROM booking.notification_suppressions WHERE intent_id = $1", [id])).rows[0].n),
    cases: Number((await db.app.query("SELECT count(*)::int AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'", [id])).rows[0].n),
    locks: Number((await db.app.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'")).rows[0].n) });
  const opsOf = (s, t) => s.ops.filter((x) => x.op_type === t).map((x) => [x.state, x.attempts, x.d]);
  const findings = [];
  const budgetLine = (phase, r, C) => { const b = {}; for (const k of ["steps", "dbQueries", "dbTeardownQueries", "exchanges", "hostawayReads", "chargeLists", "lookupPages", "pricingCalls"]) if (k in r) b[k] = r[k]; findings.push({ phase, outcome: r.outcome, code: r.code, budgets: b, ceilings: C.budgets }); return b; };

  // ---- the intermediate BASELINE active booking (seeded FIRST through the latest fixtures, never named in any plan) --------------------------------------
  const baseline = await F.confirmed(db.app);                 // the fixtures' default confirmed booking (its own listing / currency / dates)
  const BASE_ID = baseline.id;
  assert.equal((await R.loadIntent(db.app, BASE_ID)).status, "confirmed");
  const fp0 = await fingerprints();
  const APPLIED = await appliedMigrations();
  assert.deepEqual(APPLIED, Array.from({ length: 21 }, (_, i) => String(i + 1).padStart(4, "0")), "booking_migrations.applied is EXACTLY 0001..0021");
  console.log(`# DB: disposable cluster from e41b654a harness; booking_migrations.applied = ${APPLIED[0]}..${APPLIED[APPLIED.length - 1]} (${APPLIED.length} rows, exact); child tables with intent_id: ${TABLES.length} (+ intents by id); baseline booking ${BASE_ID} confirmed`);

  // ---- phase drivers: each core as exported on main, each with ITS pin's tooling and the shared world ---------------------------------------------------
  const phaseRes = async (a, w) => RES.runReservationCore({ plan: RES.buildPlan(C1, { approvalRef: "SYNTHETIC-rehearsal", intentId: a.id, expectedVersion: await ver(a.id), notBefore: nb(a), admission: "authorized", reservationId: "", runnerDigest: ZERO }).plan,
    pool: db.app, tooling: toolingRes, exchanges: { stripe: w.stripe, hostaway: w.hostaway }, credentials: creds, clock: () => Date.now(), sleep: harnessSleep("reservation@40779e34") });
  const phaseCap = async (a, w, rid) => CAP.runCaptureCore({ plan: CAP.buildPlan(C2, { approvalRef: "SYNTHETIC-rehearsal", intentId: a.id, expectedVersion: await ver(a.id), notBefore: nb(a), paymentIntentId: a.piId, reservationId: rid, amountMinor: a.total, runnerDigest: ZERO }).plan,
    pool: db.app, tooling: toolingCap, exchanges: { stripe: w.stripe, hostaway: w.hostaway }, credentials: creds, clock: () => Date.now(), sleep: harnessSleep("capture@59178b04") });
  const recPlan = async (a, rid, chargeId) => REC.buildPlan(C4, { approvalRef: "SYNTHETIC-rehearsal", intentId: a.id, expectedVersion: await ver(a.id), notBefore: nb(a), paymentIntentId: a.piId, reservationId: rid, chargeId, capturedMinor: a.total,
    from: a.stay.from, to: a.stay.to, guests: a.intent.guests, attemptId: a.attemptId, sessionId: a.sessionId, runnerDigest: ZERO });
  const phaseRec = async (a, w, rid, chargeId, k) => { const b = await recPlan(a, rid, chargeId);
    return REC.runRecordingCore({ plan: b.plan, planHash: b.planHash, runId: `rehearsal-${k}-rec`, pool: db.app, tooling: toolingRec, exchanges: { hostaway: w.hostaway }, credentials: { hostaway: creds.hostaway }, clock: () => Date.now(), sleep: harnessSleep("recording@4ed7a636") }); };
  const phaseRcl = async (a, w, rid, chargeId, offlineChargeId, k) => { const b = RCL.buildPlan(C5, { approvalRef: "SYNTHETIC-rehearsal", intentId: a.id, expectedVersion: await ver(a.id), notBefore: nb(a), paymentIntentId: a.piId, reservationId: rid, chargeId, offlineChargeId, capturedMinor: a.total,
      from: a.stay.from, to: a.stay.to, guests: a.intent.guests, attemptId: a.attemptId, sessionId: a.sessionId, runnerDigest: ZERO });
    return RCL.runRecordedCleanupCore({ plan: b.plan, planHash: b.planHash, runId: `rehearsal-${k}-rcl`, pool: db.app, tooling: toolingRcl, exchanges: { stripe: w.stripe, hostaway: w.hostaway }, credentials: creds, clock: () => Date.now(), sleep: harnessSleep("recorded-cleanup@e41b654a") }); };
  const phaseTcl = async (a, w, rid, chargeId) => { const b = TCL.buildPlan(C3, { approvalRef: "SYNTHETIC-rehearsal", intentId: a.id, expectedVersion: await ver(a.id), notBefore: nb(a), paymentIntentId: a.piId, reservationId: rid, chargeId, capturedMinor: a.total,
      from: a.stay.from, to: a.stay.to, guests: a.intent.guests, attemptId: a.attemptId, sessionId: a.sessionId, runnerDigest: ZERO });
    return TCL.runTestCleanupCore({ plan: b.plan, planHash: b.planHash, pool: db.app, tooling: toolingTcl, exchanges: { stripe: w.stripe, hostaway: w.hostaway }, credentials: creds, clock: () => Date.now(), sleep: harnessSleep("test-cleanup@9d86bfa1") }); };

  /** the shared Slice 1 → Slice 2 prefix of both scenarios: reservation (40779e34) then capture (59178b04, C1 fix) on the SAME intent / PI / price */
  const phaseResPending = async (a, w) => RES.runReservationCore({ plan: RES.buildPlan(C1, { approvalRef: "SYNTHETIC-rehearsal", intentId: a.id, expectedVersion: await ver(a.id), notBefore: nb(a), admission: "pending", reservationId: String(w.res), runnerDigest: ZERO }).plan,
    pool: db.app, tooling: toolingRes, exchanges: { stripe: w.stripe, hostaway: w.hostaway }, credentials: creds, clock: () => Date.now(), sleep: harnessSleep("reservation@40779e34(pending)") });
  /** test-harness scheduling: REAL wait until the worker's OWN next_action_at (its E7.1 freshness schedule) has passed; nothing is rewritten */
  const waitUntilDue = async (phase, id) => {
    const row = (await db.owner.query("SELECT next_action_at FROM booking.intent_work WHERE intent_id = $1", [id])).rows[0];
    const ms = row && row.next_action_at ? Math.max(0, new Date(row.next_action_at).getTime() - Date.now()) + 500 : 0;
    schedule.push({ phase, ms, path: "real-wait-until-next_action_at" });
    await new Promise((r) => setTimeout(r, ms));
  };
  async function reserveAndCapture(a, w, tag) {
    let r1 = await phaseRes(a, w);
    budgetLine(`${tag}.1 reservation@40779e34 (authorized)`, r1, C1);
    if (!w.echoRef) {
      // FINDING F1 (real clock): the 40779e34 reservation worker requires reads ≥ 2 min after the create when the ref is NOT echoed and parks the
      // intent (next_action_at = create + 2 min); the main runner's step loop sleeps only 5 s per idle step, so 12 steps (≈ 60–80 s) end in
      // STEP_BUDGET_EXHAUSTED with the intent reservation_pending, ONE succeeded create and the reservation id known. The ACCEPTED continuation is
      // the runner's own `pending` admission (reservationId pinned) in a SECOND session — exercised here after a REAL wait until the worker's
      // own schedule is due. The per-phase I1 test only confirms the not-echoed case in one session because its fake clock advances ≥ 30 s per sleep.
      assert.deepEqual([r1.outcome, r1.code, r1.finalState, r1.createInvocations, r1.createOutcome, r1.createOps, r1.lock], ["STEP_BUDGET_EXHAUSTED", "STEPS", "reservation_pending", 1, "REPLIED", ["succeeded"], "released"], JSON.stringify(r1));
      assert.ok(r1.actions.includes("CREATE_REF_NOT_ECHOED:READS_REQUIRED"), JSON.stringify(r1.actions));
      findings.push({ finding: "F1", phase: `${tag}.1`, note: "not-echoed ref under a REAL clock: session 1 STEP_BUDGET_EXHAUSTED at reservation_pending (12 idle steps × 5 s < the worker's 2-min read freshness); continued via the accepted pending admission in session 2", session1: { outcome: r1.outcome, code: r1.code, steps: r1.steps, actions: r1.actions } });
      const s0 = await snap(a.id);
      assert.deepEqual([s0.st.state, s0.claim[0].released, s0.locks], ["reservation_pending", false, 0]);
      assert.deepEqual(opsOf(s0, "hostaway.create_reservation"), [["succeeded", 1, true]]);
      assert.deepEqual(s0.ops.filter((x) => x.op_type === "hostaway.create_reservation").map((x) => x.result_ref), [String(w.res)], "the create's result_ref is the reservation id the pending admission pins");
      await waitUntilDue(`${tag}.1 → pending`, a.id);
      r1 = await phaseResPending(a, w);
      budgetLine(`${tag}.1b reservation@40779e34 (pending)`, r1, C1);
      assert.equal(r1.admission, "pending");
      assert.deepEqual(w.writes, ["H POST /v1/reservations"], "the second session never re-creates");
    }
    assert.equal(r1.outcome, "RESERVATION_CONFIRMED_INTERMEDIATE", JSON.stringify(r1));
    assert.deepEqual([w.echoRef ? r1.createInvocations : 0, w.echoRef ? r1.createOutcome : "NONE", r1.captureQueuedPristine, r1.lock, r1.admission, String(w.res)], [w.echoRef ? 1 : 0, w.echoRef ? "REPLIED" : "NONE", true, "released", w.echoRef ? "authorized" : "pending", r1.reservationId]);
    assert.deepEqual(w.writes, ["H POST /v1/reservations"], "phase 1 writes");
    assert.ok(!w.calls.some((x) => /^H PUT/.test(x)), "no relabel / status PUT in phase 1 (echoed or not)");
    let s = await snap(a.id);
    assert.deepEqual([s.st.state, s.st.rid, s.claim[0].released, s.locks], ["reservation_confirmed", r1.reservationId, false, 0]);
    assert.deepEqual(opsOf(s, "stripe.capture_payment_intent"), [["pending", 0, false]], "capture queued pristine by the 40779e34 reservation worker");
    const r2 = await phaseCap(a, w, r1.reservationId);
    budgetLine(`${tag}.2 capture@59178b04`, r2, C2);
    assert.equal(r2.outcome, "PAYMENT_CAPTURED_INTERMEDIATE", JSON.stringify(r2));
    assert.deepEqual([r2.captureInvocations, r2.chargeId, r2.capturedMinor, r2.reservationId, w.captured, w.bodies.capture.key], [1, a.chargeId, a.total, r1.reservationId, true, `cap:${a.id}:${a.piId}`]);
    assert.deepEqual(w.writes, ["H POST /v1/reservations", `S POST /v1/payment_intents/${a.piId}/capture`], "phase 1+2 writes");
    s = await snap(a.id);
    assert.deepEqual([s.st.state, s.st.cap, s.claim[0].released, s.locks], ["payment_captured", String(a.total), false, 0]);
    assert.deepEqual(opsOf(s, "stripe.capture_payment_intent"), [["succeeded", 1, true]]);
    assert.deepEqual(opsOf(s, "hostaway.record_offline_charge"), [["pending", 0, false]], "recording row queued pristine by the 40779e34 capture worker");
    assert.deepEqual(s.ops.filter((x) => x.op_type === "stripe.capture_payment_intent").map((x) => x.result_ref), [a.chargeId], "the capture op carries the Stripe charge id the later phases pin");
    return { rid: r1.reservationId, chargeId: r2.chargeId, transitions: s.transitions, opsAfter2: s.ops.map((x) => `${x.op_type}:${x.state}`) };
  }

  test("A echoed ref: reservation(40779e34) → capture(59178b04, C1 fix) → recording(4ed7a636) → recorded cleanup(e41b654a) on schema 0021: cancelled, 3 legs, claim released; exactly 1 create / 1 capture / 1 record / 1 cancel / 1 Stripe refund / 1 mirror; history preserved; notify suppressed never dispatched", async () => {
    const a = await authorizedIntent("A"); const w = world(a, { echoRef: true });
    const pre = await reserveAndCapture(a, w, "A");
    // ---- phase 3: Slice 4 recording at 4ed7a636 on the 40779e34-produced payment_captured row
    const r3 = await phaseRec(a, w, pre.rid, pre.chargeId, "A");
    budgetLine("A.3 recording@4ed7a636", r3, C4);
    assert.equal(r3.outcome, "RECORDING_CONFIRMED", JSON.stringify(r3));
    const recordedId = r3.postcheck.offlineChargeId;
    assert.deepEqual([r3.recordInvocations, r3.writes.record, r3.notifyOps, w.charges.length, String(w.charges[0].id)], [1, 1, ["pristine"], 1, recordedId]);
    assert.deepEqual(w.bodies.record, { title: OP4.offlineChargeTitle(a.id), amount: a.total / 100, paymentMethod: "credit_card", status: "paid", scheduledDate: w.bodies.record.scheduledDate });
    assert.equal(OP5.offlineChargeTitle(a.id), w.bodies.record.title, "the e41b654a title grammar reads the 4ed7a636 title (cleanup classifies it next)");
    let s = await snap(a.id);
    assert.deepEqual([s.st.state, s.st.och, s.claim[0].released, s.cases, s.locks], ["confirmed", recordedId, false, 0, 0]);
    assert.deepEqual(opsOf(s, "guest.notify"), [["pending", 0, false]], "ONE guest.notify queued pristine");
    assert.deepEqual(w.writes, ["H POST /v1/reservations", `S POST /v1/payment_intents/${a.piId}/capture`, `H POST /v1/guestPayments/charges/${pre.rid}`]);
    // ---- phase 4: Slice 5 recorded cleanup at e41b654a on the 4ed7a636-produced confirmed row
    const r4 = await phaseRcl(a, w, pre.rid, pre.chargeId, recordedId, "A");
    budgetLine("A.4 recorded-cleanup@e41b654a", r4, C5);
    assert.equal(r4.outcome, "RECORDED_CLEANUP_COMPLETED", JSON.stringify(r4));
    assert.deepEqual([r4.requestInvocations, r4.cancelInvocations, r4.cancelOutcome, r4.refundInvocations, r4.refundOutcome, r4.mirrorInvocations, r4.mirrorOutcome, r4.mirrorTransportPosts, r4.capturedMinor, r4.reservationId, r4.chargeId, r4.offlineChargeId, r4.refundId, r4.publicStatus, r4.lock],
      [1, 1, "REPLIED", 1, "REPLIED", 1, "REPLIED", 1, a.total, pre.rid, pre.chargeId, recordedId, w.refundId, "not_completed_refunded", "released"]);
    assert.deepEqual(w.writes, ["H POST /v1/reservations", `S POST /v1/payment_intents/${a.piId}/capture`, `H POST /v1/guestPayments/charges/${pre.rid}`, `H PUT /v1/reservations/${pre.rid}/statuses/cancelled`, "S POST /v1/refunds", `H POST /v1/guestPayments/charges/${pre.rid}/${recordedId}/refund`],
      "the complete write order of scenario A: exactly 1 create, 1 capture, 1 record, 1 cancel, 1 Stripe refund, 1 mirror");
    assert.deepEqual([w.bodies.mirror.body, w.bodies.mirror.headers], [{ title: MP5.mirrorTitle(a.id), amount: a.total / 100, isIncludeInPriceBreakdown: 0 }, ["Accept", "Authorization", "Cache-control", "Content-Type"]]);
    s = await snap(a.id);
    assert.deepEqual([s.st.state, s.st.reason_code, s.st.c, s.st.a, s.st.m, s.st.och, s.st.cap, s.claim[0].released, s.cases, s.suppressions, s.locks], ["cancelled", "TEST_CLEANUP_REQUESTED", true, true, true, recordedId, String(a.total), true, 0, 1, 0]);
    assert.deepEqual(opsOf(s, "guest.notify"), [["superseded", 0, false]], "the queued notify was SUPERSEDED by the recorded request (audited in notification_suppressions), never dispatched");
    assert.deepEqual(opsOf(s, "hostaway.create_reservation"), [["succeeded", 1, true]], "create history preserved");
    assert.deepEqual(opsOf(s, "stripe.capture_payment_intent"), [["succeeded", 1, true]], "capture history preserved");
    assert.deepEqual(opsOf(s, "hostaway.record_offline_charge"), [["succeeded", 1, true]], "recording history preserved (not retired)");
    assert.deepEqual(opsOf(s, "hostaway.cancel_reservation"), [["succeeded", 1, true]]);
    assert.deepEqual(opsOf(s, "stripe.refund_payment_intent").length + opsOf(s, "stripe.refund").length + s.refunds.length > 0, true);
    assert.deepEqual(s.refunds.map((x) => [x.seq, x.state, x.stripe_refund_id, x.amt]), [[1, "succeeded", w.refundId, String(a.total)]]);
    assert.ok(s.transitions.slice(0, pre.transitions.length).every((t, i) => t === pre.transitions[i]), "phase 1/2 transitions preserved verbatim");
    assert.equal((await db.app.query("SELECT booking.recorded_state_cleanup_ok($1) AS ok", [a.id])).rows[0].ok, true, "0021 end predicate");
    for (const t of ["stripe.void_payment_intent", "alert.owner"]) assert.equal(opsOf(s, t).length, 0, t);
    findings.push({ scenario: "A", intent: a.id, reservation: pre.rid, pi: a.piId, charge: pre.chargeId, offlineCharge: recordedId, refund: w.refundId, transitions: s.transitions, writeOrder: w.writes, ops: s.ops.map((x) => `${x.op_type}:${x.state}:${x.attempts}`), ledger: s.ledger });
  });

  test("B ref NOT echoed (observed live case): reservation confirms with no relabel, capture succeeds, recording(4ed7a636) refuses REF_NOT_ECHOED with ZERO record POST, pristine captured cleanup(9d86bfa1) cancels + refunds with ZERO record / mirror / notify, claim released", async () => {
    const a = await authorizedIntent("B"); const w = world(a, { echoRef: false });
    const pre = await reserveAndCapture(a, w, "B");
    const r3 = await phaseRec(a, w, pre.rid, pre.chargeId, "B");
    budgetLine("B.3 recording@4ed7a636 (refusal)", r3, C4);
    assert.deepEqual([r3.outcome, r3.code, r3.steps, r3.recordInvocations, r3.holds, w.charges.length], ["PROVIDER_PROOF_FAILED", "REF_NOT_ECHOED", 0, 0, null, 0]);
    assert.deepEqual(w.writes, ["H POST /v1/reservations", `S POST /v1/payment_intents/${a.piId}/capture`], "ZERO record POST");
    let s = await snap(a.id);
    assert.deepEqual([s.st.state, s.st.och, s.claim[0].released, s.locks], ["payment_captured", null, false, 0]);
    assert.deepEqual(opsOf(s, "hostaway.record_offline_charge"), [["pending", 0, false]], "recording row still pristine");
    assert.deepEqual(opsOf(s, "guest.notify"), [], "no notify ever queued");
    const r4 = await phaseTcl(a, w, pre.rid, pre.chargeId);
    budgetLine("B.4 test-cleanup@9d86bfa1", r4, C3);
    assert.equal(r4.outcome, "TEST_CLEANUP_COMPLETED", JSON.stringify(r4));
    assert.deepEqual([r4.requestInvocations, r4.cancelInvocations, r4.cancelOutcome, r4.refundInvocations, r4.refundOutcome, r4.capturedMinor, r4.reservationId, r4.chargeId, r4.refundId, r4.publicStatus, r4.lock],
      [1, 1, "REPLIED", 1, "REPLIED", a.total, pre.rid, pre.chargeId, w.refundId, "not_completed_refunded", "released"]);
    assert.deepEqual(w.writes, ["H POST /v1/reservations", `S POST /v1/payment_intents/${a.piId}/capture`, `H PUT /v1/reservations/${pre.rid}/statuses/cancelled`, "S POST /v1/refunds"], "scenario B write order: ZERO record / mirror / notify");
    assert.equal(w.charges.length, 0, "no charge row ever created at the provider");
    s = await snap(a.id);
    // 0021 semantics: settlement_recording_mirrored NULL = the pristine / non-recorded path (never FALSE here); the 9d86bfa1 request predates the column and leaves it NULL
    assert.deepEqual([s.st.state, s.st.reason_code, s.st.c, s.st.a, s.st.m, s.st.och, s.claim[0].released, s.cases, s.suppressions, s.locks], ["cancelled", "TEST_CLEANUP_REQUESTED", true, true, null, null, true, 0, 0, 0]);
    assert.deepEqual(opsOf(s, "guest.notify"), []);
    assert.deepEqual(opsOf(s, "hostaway.record_offline_charge"), [["superseded", 0, false]], "the pristine recording row retired by the 9d86bfa1 request, never dispatched");
    assert.equal((await db.app.query("SELECT booking.test_refund_settled_for($1, $2) AS ok", [a.id, a.piId])).rows[0].ok, true, "0019 refund settlement predicate");
    assert.deepEqual((await db.app.query("SELECT booking.claim_release_blockers($1) AS b", [a.id])).rows[0].b, [], "0019 claim-release blockers empty");
    assert.deepEqual(opsOf(s, "hostaway.create_reservation"), [["succeeded", 1, true]]);
    assert.deepEqual(opsOf(s, "stripe.capture_payment_intent"), [["succeeded", 1, true]]);
    assert.deepEqual(s.refunds.map((x) => [x.seq, x.state, x.stripe_refund_id, x.amt]), [[1, "succeeded", w.refundId, String(a.total)]]);
    assert.ok(s.transitions.slice(0, pre.transitions.length).every((t, i) => t === pre.transitions[i]), "phase 1/2 transitions preserved verbatim");
    findings.push({ scenario: "B", intent: a.id, reservation: pre.rid, pi: a.piId, charge: pre.chargeId, refund: w.refundId, recordingRow: opsOf(s, "hostaway.record_offline_charge"), transitions: s.transitions, writeOrder: w.writes, ops: s.ops.map((x) => `${x.op_type}:${x.state}:${x.attempts}`), ledger: s.ledger });
  });

  /** the foreign-write guard shared by Z and the negative control: every non-rehearsal intent (the baseline included) must fingerprint identically, and no new one may appear */
  const foreignDiff = (before, afterFp, ours) => {
    const changed = Object.keys(before).filter((id) => !ours.has(id) && JSON.stringify(afterFp[id]) !== JSON.stringify(before[id]));
    const added = Object.keys(afterFp).filter((id) => !ours.has(id) && !before[id]);
    return { changed, added };
  };

  test("N1 negative guard (disposable, rolled back): the EXACT injected mutation — UPDATE booking.intents SET version = version + 1, updated_at = updated_at + 1 s on the baseline — is caught by the full-row intents fingerprint (RED under the former child-only fingerprint, GREEN now); a new foreign intent is caught too", async () => {
    const c = await db.owner.connect();
    try {
      await c.query("BEGIN");
      const before = await fingerprints(c); const beforeChildren = await fingerprints(c, { childrenOnly: true });
      await c.query("UPDATE booking.intents SET version = version + 1, updated_at = updated_at + interval '1 second' WHERE id = $1", [BASE_ID]);
      const after = await fingerprints(c); const afterChildren = await fingerprints(c, { childrenOnly: true });
      assert.deepEqual(foreignDiff(beforeChildren, afterChildren, OURS), { changed: [], added: [] }, "RED (documented former gap): a child-only fingerprint does NOT see the intents-row mutation");
      assert.deepEqual(foreignDiff(before, after, OURS), { changed: [BASE_ID], added: [] }, "GREEN: the full-row intents fingerprint catches exactly the mutated baseline");
      assert.notEqual(after[BASE_ID].intents, before[BASE_ID].intents); assert.deepEqual({ ...after[BASE_ID], intents: before[BASE_ID].intents }, before[BASE_ID], "only the intents row differs");
      // a NEW foreign intent (the latest fixtures' minimal row) is caught as `added`
      // (the latest fixtures' minimal intent, written INSIDE this rolled-back transaction through a savepoint shim of the pool interface)
      const shim = { connect: async () => ({ release() {}, query: (q, ...a) => c.query(q === "BEGIN" ? "SAVEPOINT n1" : q === "COMMIT" ? "RELEASE SAVEPOINT n1" : q === "ROLLBACK" ? "ROLLBACK TO SAVEPOINT n1" : q, ...a) }), query: (...a) => c.query(...a) };
      const extra = await F.newIntent(shim);
      const after2 = await fingerprints(c);
      assert.deepEqual(foreignDiff(before, after2, OURS), { changed: [BASE_ID], added: [extra] });
      await c.query("ROLLBACK");
    } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
    const now = await fingerprints();
    assert.deepEqual(now[BASE_ID], fp0[BASE_ID], "rolled back: the baseline fingerprint is exactly the pre-rehearsal one again");
  });

  test("N2 negative control (child process): a tampered byte in ONE closure file at ONE pin → the awaited bootstrap gate throws CLOSURE_MISMATCH and the module never imports any pin tooling, never starts a database and runs no scenario (import-resolution hook + PG_BIN pointed at nothing)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "e7-rehearsal-gate-"));
    try {
      // a minimal tampered tooling root: only the closure files (copied bytes) of every pin, one byte flipped in the capture worker at 40779e34
      for (const r of RUNNERS) { const dir = join(tmp, r.pin.slice(0, 8)); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "package.json"), "{}\n");
        for (const rel of r.E.CONSTANTS.closure) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); cpSync(join(pinDir(r.pin), rel), join(dir, rel)); } }
      const victim = join(tmp, "59178b04", "lib/booking-db/capture-worker.js");
      writeFileSync(victim, readFileSync(victim, "utf8").replace("workerId", "workerID"));
      const hook = join(tmp, "hook.mjs");
      writeFileSync(hook, `import { register } from "node:module"; register(new URL("./hooks.mjs", import.meta.url));`);
      writeFileSync(join(tmp, "hooks.mjs"), `export async function resolve(spec, ctx, next) { const r = await next(spec, ctx); if (String(r.url).includes(${JSON.stringify(tmp)})) process.stderr.write("TOOLING_RESOLVED " + r.url + "\\n"); return r; }`);
      const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? "/tmp", E7_REHEARSAL_DB_TESTS: "1", E7_REHEARSAL_TOOLING_ROOT: tmp, PG_BIN: join(tmp, "no-such-pg-bin") };
      const r = spawnSync(process.execPath, ["--import", pathToFileURL(hook).href, "--test", fileURLToPath(import.meta.url)], { env, encoding: "utf8", timeout: 120000 });
      const all = r.stdout + "\n" + r.stderr;
      assert.notEqual(r.status, 0, "the file fails to load");
      assert.match(all, /CLOSURE_MISMATCH:capture@59178b04/, all.slice(-2000));
      assert.doesNotMatch(all, /CLOSURE_MISMATCH:reservation@/, "the reservation closure (its own pin 40779e34, untouched) passed first: files are verified in runner order");
      assert.doesNotMatch(r.stderr, /TOOLING_RESOLVED/, "ZERO tooling imports resolved under the tampered root");
      assert.doesNotMatch(all, /initdb|no-such-pg-bin|# DB:|Subtest: A |Subtest: B |scheduling/, "ZERO database / scenario activity");
      assert.doesNotMatch(r.stdout, /# gate /, "the gate reports digests only after ALL five verified; nothing was reported on mismatch");
      console.log(`# N2 child: status=${r.status}, mismatch surfaced, tooling resolutions under tampered root: ${(r.stderr.match(/TOOLING_RESOLVED/g) || []).length}`);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("Z guards + report: baseline active booking byte-identical (full intents row + children), NO foreign intent row changed or added, exact 0001..0021 ledger unchanged, every scheduling entry a REAL wait, zero network, lock count 0; scheduling + budgets + findings printed", async () => {
    const fp1 = await fingerprints();
    assert.deepEqual(fp1[BASE_ID], fp0[BASE_ID], "the intermediate baseline active booking is untouched (intents row + every child row)");
    assert.equal((await R.loadIntent(db.app, BASE_ID)).status, "confirmed");
    assert.deepEqual(foreignDiff(fp0, fp1, OURS), { changed: [], added: [] }, "no foreign intent row changed, no foreign intent added");
    assert.ok(OURS.size === 2 && [...OURS].every((id) => fp1[id] && fp1[id].intents && fp1[id].intents !== (fp0[id] ?? {}).intents), "exactly the two rehearsal intents changed");
    assert.deepEqual(await appliedMigrations(), APPLIED, "the migration ledger is exactly as at bootstrap (0001..0021)");
    assert.ok(schedule.length > 0 && schedule.every((e) => e.path === "real-wait" || e.path === "real-wait-until-next_action_at"), "every scheduling entry was a REAL wait: " + JSON.stringify(schedule.filter((e) => !/^real-wait/.test(e.path))));
    assert.deepEqual(GUARD, { request: 0, Agent: 0, fetch: 0 }, "no external call anywhere");
    assert.equal(Number((await db.app.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'")).rows[0].n), 0);
    console.log("# scheduling (test-harness only, all real waits): " + JSON.stringify(schedule));
    for (const f of findings) console.log("# " + JSON.stringify(f));
  });
}
