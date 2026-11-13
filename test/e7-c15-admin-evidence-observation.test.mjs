// test/e7-c15-admin-evidence-observation.test.mjs — C15 regression EVIDENCE (ROOT review 5898784499 on PR #93): what an owner-attested
// `booking.admin_record_evidence` INSERT does and does not change. OPT-IN real PostgreSQL only (E7_C15_DB_TESTS=1; PG_BIN; tooling with its
// pinned pg via E7_TOOLING_DIR = the accepted e7-test checkout). Reuses the ACCEPTED harness / fixtures / admin helpers; no runtime, schema,
// provider or shared-database action; nothing here is imported by any hosted runner (not in any `runnerFiles`).
//
// Proves on a disposable schema-21 database:
//   O1  an admin (dashboard-sourced, attested) evidence INSERT leaves the intent row (whole-row digest), version, every external_operations row,
//       inventory_claims, payment_ledger and intent_transitions BYTE-IDENTICAL — and yet CHANGES the results of booking.reservation_blockers /
//       booking.authorization_blockers / booking.claim_release_blockers, because those predicates select the latest evidence by observed_at
//       with NO source filter (0003:146-193 / 0019:289); claim_release_blockers (0021:243) short-circuits on a non-releasable state first, else appends both.
//   O2  consumption order is observed_at DESC, created_at DESC — regardless of source (API read vs dashboard) and regardless of INSERTION time:
//       a dashboard row whose observed_at is NEWER than an API row governs; a later-inserted row with an OLDER observed_at does not override a
//       newer one; a later-inserted row whose observed_at is newer than everything stored DOES govern even though it was inserted "historically".
//   O3  admin_record_evidence refuses the dashboard-only shapes that the schema forbids (kind stripe_refund via the admin path; missing attestation).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));

if (process.env.E7_C15_DB_TESTS !== "1") {
  test("C15 admin-evidence observation regression is OPT-IN (E7_C15_DB_TESTS=1 with PG_BIN + pinned tooling)", () => { assert.ok(true); });
} else {
  const TOOLING = realpathSync(process.env.E7_TOOLING_DIR || join(ROOT, "..", "tooling"));
  const tool = (p) => import(pathToFileURL(join(TOOLING, p)).href);
  const [{ startMigratedDatabase }, F, O, A] = await Promise.all([tool("test/db/harness.mjs"), tool("test/db/fixtures.mjs"), tool("lib/booking-db/operations.js"), tool("db/lib/admin.js")]);
  const db = await startMigratedDatabase();
  after(async () => { await db.close(); });
  const LIST = 606998;
  let k = 0;
  const stay = () => { k += 1; return { listingId: LIST, currency: "USD", from: F.addDays("2027-07-01", 3 * k), to: F.addDays("2027-07-01", 3 * k + 2) }; };
  const iso = (d) => new Date(d).toISOString();
  /** byte-level snapshot of everything an observation must NOT change */
  async function snap(id) {
    const q = (s, p = [id]) => db.owner.query(s, p);
    return {
      intent: (await q("SELECT md5(i::text) AS fp, i.state, i.version FROM booking.intents i WHERE i.id = $1")).rows[0],
      ops: (await q("SELECT md5(coalesce(string_agg(o::text, '|' ORDER BY o::text), '')) AS fp, count(*)::int AS n FROM booking.external_operations o WHERE o.intent_id = $1")).rows[0],
      claims: (await q("SELECT md5(coalesce(string_agg(c::text, '|' ORDER BY c::text), '')) AS fp, count(*)::int AS n FROM booking.inventory_claims c WHERE c.intent_id = $1")).rows[0],
      ledger: (await q("SELECT md5(coalesce(string_agg(l::text, '|' ORDER BY l::text), '')) AS fp, count(*)::int AS n FROM booking.payment_ledger l WHERE l.intent_id = $1")).rows[0],
      transitions: (await q("SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS fp, count(*)::int AS n FROM booking.intent_transitions t WHERE t.intent_id = $1")).rows[0],
      refunds: (await q("SELECT count(*)::int AS n FROM booking.payment_refunds WHERE intent_id = $1")).rows[0].n,
      cases: (await q("SELECT count(*)::int AS n FROM booking.reconciliation_cases WHERE intent_id = $1")).rows[0].n
    };
  }
  async function blockers(id) {
    const r = (await db.owner.query("SELECT booking.authorization_blockers($1) AS a, booking.reservation_blockers($1) AS r, booking.claim_release_blockers($1) AS c", [id])).rows[0];
    return { auth: r.a, res: r.r, claim: r.c };
  }
  const latest = async (id, kind, ref) => (await db.owner.query(
    "SELECT source, status, observed_at FROM booking.provider_evidence WHERE intent_id = $1 AND kind = $2 AND external_ref = $3 ORDER BY observed_at DESC, created_at DESC LIMIT 1", [id, kind, ref])).rows[0];
  const PI_OBS = (over = {}) => ({ amountMinor: 576000, currency: "USD", amountReceivedMinor: 576000, amountCapturableMinor: 0, captured: true, refunded: false, amountRefundedMinor: 0, ...over });

  test("O1 an owner-attested admin evidence INSERT leaves intent / version / ops / claims / ledger / transitions byte-identical, but CHANGES blocker results (no source filter)", async () => {
    const c = await F.captured(db.app, stay());
    const rid = String(c.reservationId); const pi = c.piId;
    const s0 = await snap(c.id); const b0 = await blockers(c.id);
    assert.equal(s0.intent.state, "payment_captured");
    assert.deepEqual([b0.auth, b0.res], [[`AUTHORIZATION_UNSETTLED:${pi}`], [`RESERVATION_NOT_VERIFIED_CANCELLED:${rid}`]], "captured + reserved with no evidence: both blockers set");
    assert.ok(b0.claim.length > 0, "claim release blocked");
    // C: captured / no refund — corroboration only; blockers unchanged
    const e1 = F.ok(await A.adminRecordEvidence(db.reconciler, { intentId: c.id, kind: "payment_intent", externalRef: pi, status: "succeeded", observed: PI_OBS(),
      observedAt: new Date(Date.now() - 60_000), attestedBy: "owner", reference: "stripe dashboard PI page (synthetic C15 fixture)" }));
    assert.deepEqual(await snap(c.id), s0, "C: nothing but provider_evidence changed");
    assert.deepEqual(await blockers(c.id), b0, "C: a succeeded PI reading changes no blocker");
    // A: reservation cancelled (dashboard, attested) — intent/ops/claims/ledger identical, reservation_blockers CHANGES
    F.ok(await A.adminRecordEvidence(db.reconciler, { intentId: c.id, kind: "hostaway_reservation", externalRef: rid, status: "cancelled",
      observed: { reservationId: rid, listingId: LIST, from: c.from, to: c.to, totalMinor: 576000, cancelledBy: "host" }, observedAt: new Date(Date.now() - 50_000),
      attestedBy: "owner", reference: "hostaway reservation logs (synthetic C15 fixture)" }));
    const s1 = await snap(c.id); const b1 = await blockers(c.id);
    assert.deepEqual(s1, s0, "A: intent/version/ops/claims/ledger/transitions byte-identical");
    assert.deepEqual(b1.res, [], "A: reservation_blockers now EMPTY — the dashboard row is consumed (no source filter)");
    assert.deepEqual(b1.auth, b0.auth, "A: payment blockers untouched by a reservation observation (independence)");
    // B-cancelled analogue: a dashboard 'canceled' PI reading — authorization_blockers CHANGES, rows still identical (synthetic; a captured PI never reads 'canceled' live)
    F.ok(await A.adminRecordEvidence(db.reconciler, { intentId: c.id, kind: "payment_intent", externalRef: pi, status: "canceled", observed: PI_OBS({ amountReceivedMinor: 0, captured: false }),
      observedAt: new Date(Date.now() - 40_000), attestedBy: "owner", reference: "SYNTHETIC conflicting dashboard reading (C15 fixture)" }));
    const s2 = await snap(c.id); const b2 = await blockers(c.id);
    assert.deepEqual(s2, s0, "B: still byte-identical");
    assert.deepEqual(b2.auth, [], "B: authorization_blockers now EMPTY from a DASHBOARD row — downstream semantics changed without any intent/op/claim/ledger change");
    assert.deepEqual([b0.claim, b2.claim], [["STATE_NOT_RELEASABLE:payment_captured"], ["STATE_NOT_RELEASABLE:payment_captured"]], "claim_release_blockers short-circuits on a non-releasable state BEFORE consulting evidence (0021:243): unchanged here; in a releasable state it appends authorization_blockers || reservation_blockers and WOULD change");
    assert.equal(s2.refunds, 0); assert.equal(s2.cases, 0);
    void e1;
  });

  test("O2 consumption is observed_at DESC, created_at DESC — source-blind and insertion-time-blind (a 'historical' observed_at is operative whenever it is the newest stored)", async () => {
    const c = await F.captured(db.app, stay());
    const pi = c.piId;
    const T = Date.now();
    // API-verified row at T-30s: succeeded (a succeeded Stripe PI read through the accepted read-op path)
    const readId = await O.requestRead(db.app, c.id, "stripe.retrieve_payment_intent", pi, { now: T - 31_000 });
    assert.ok(await O.claimNextOperation(db.app, { workerId: "w-read", now: T - 31_000, opId: readId }));
    F.ok(await O.completeOperation(db.app, readId, { workerId: "w-read", now: T - 30_000, outcome: { status: "succeeded" } }));
    F.ok(await O.recordProviderEvidence(db.app, { readOpId: readId, kind: "payment_intent", externalRef: pi, status: "succeeded", observed: PI_OBS(), providerRequestId: "req_c15_api" }));
    assert.deepEqual((await latest(c.id, "payment_intent", pi)).source, "stripe_api");
    assert.deepEqual((await blockers(c.id)).auth, [`AUTHORIZATION_UNSETTLED:${pi}`]);
    // dashboard row with a NEWER observed_at (T-20s) governs over the API row
    F.ok(await A.adminRecordEvidence(db.reconciler, { intentId: c.id, kind: "payment_intent", externalRef: pi, status: "canceled", observed: PI_OBS({ amountReceivedMinor: 0, captured: false }),
      observedAt: new Date(T - 20_000), attestedBy: "owner", reference: "SYNTHETIC newer dashboard reading" }));
    assert.deepEqual([(await latest(c.id, "payment_intent", pi)).source, (await blockers(c.id)).auth], ["stripe_dashboard", []], "newer dashboard observed_at wins over an API row");
    // a row inserted LATER but with an OLDER observed_at (T-60s) does NOT override the newer stored reading
    F.ok(await A.adminRecordEvidence(db.reconciler, { intentId: c.id, kind: "payment_intent", externalRef: pi, status: "requires_capture", observed: PI_OBS({ amountReceivedMinor: 0, amountCapturableMinor: 576000, captured: false }),
      observedAt: new Date(T - 60_000), attestedBy: "owner", reference: "SYNTHETIC historical insertion (older observed_at)" }));
    assert.deepEqual([(await latest(c.id, "payment_intent", pi)).status, (await blockers(c.id)).auth], ["canceled", []], "older observed_at inserted later is history: not consumed as current");
    // a row inserted later whose observed_at is NEWER than everything stored (T-10s) DOES govern — 'historical insertion' is operative, not inert
    F.ok(await A.adminRecordEvidence(db.reconciler, { intentId: c.id, kind: "payment_intent", externalRef: pi, status: "succeeded", observed: PI_OBS(),
      observedAt: new Date(T - 10_000), attestedBy: "owner", reference: "SYNTHETIC later-inserted, newest observed_at" }));
    assert.deepEqual([(await latest(c.id, "payment_intent", pi)).status, (await blockers(c.id)).auth], ["succeeded", [`AUTHORIZATION_UNSETTLED:${pi}`]], "newest observed_at governs regardless of insertion order / source");
    // tie on observed_at: created_at DESC (the later INSERT) wins
    const tie = new Date(T - 5_000);
    F.ok(await A.adminRecordEvidence(db.reconciler, { intentId: c.id, kind: "payment_intent", externalRef: pi, status: "canceled", observed: PI_OBS({ amountReceivedMinor: 0, captured: false }), observedAt: tie, attestedBy: "owner", reference: "tie-1" }));
    F.ok(await A.adminRecordEvidence(db.reconciler, { intentId: c.id, kind: "payment_intent", externalRef: pi, status: "succeeded", observed: PI_OBS(), observedAt: tie, attestedBy: "owner", reference: "tie-2" }));
    assert.deepEqual((await latest(c.id, "payment_intent", pi)).status, "succeeded", "equal observed_at: the later-created row is consumed");
    const n = (await db.owner.query("SELECT count(*)::int AS n FROM booking.provider_evidence WHERE intent_id = $1", [c.id])).rows[0].n;
    assert.equal(n, 6, "six append-only rows; none updated or deleted");
  });

  test("O3 schema limits on the admin path: a dashboard-sourced stripe_refund row is impossible (0019: admin_record_evidence deliberately not extended); attestation + reference are mandatory; the runtime role cannot call it", async () => {
    const c = await F.captured(db.app, stay());
    const r1 = await A.adminRecordEvidence(db.reconciler, { intentId: c.id, kind: "stripe_refund", externalRef: "re_x", status: "succeeded", observed: { amountMinor: 1 }, observedAt: new Date(), attestedBy: "owner", reference: "x" });
    assert.equal(r1.ok, false, "stripe_refund via the admin (dashboard) path is refused: " + JSON.stringify(r1));
    const r2 = await A.adminRecordEvidence(db.reconciler, { intentId: c.id, kind: "payment_intent", externalRef: c.piId, status: "succeeded", observed: PI_OBS(), observedAt: new Date(), attestedBy: null, reference: null });
    assert.equal(r2.ok, false, "attestation required");
    await assert.rejects(db.app.query("SELECT booking.admin_record_evidence($1, 'payment_intent', $2, 'succeeded', '{}', now(), 'a', 'b')", [c.id, c.piId]), /permission denied/);
    assert.equal((await snap(c.id)).refunds, 0);
  });
}
