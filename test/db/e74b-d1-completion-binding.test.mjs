// Stage E7.4b-D1 D5 — migration 0014: CLAIM-TO-CONFIRMATION BINDING of the Hostaway payment recording (claude/e74b-completion-binding-contract.md
// at cb532dc + root addendum A–E). The first proof link of a recording claimed through the 0012 / 0013 fence must carry executorAccountRef = the
// claimed assessment's account_ref (= cfg.accountRef) and paymentMethod = that assessment's cfg.paymentMethod. Labels are TRUST, not provider
// authentication; 'credit_card' / 'other' / 'acct-test-*' are FIXTURE values (no owner paymentMethod choice is implied).
// Throwaway local PostgreSQL only; repository code runs as the runtime login (test_app ∈ mv_booking_app), owner decisions as test_admin
// (∈ mv_booking_admin); test_report for privilege probes; the schema owner only for probes and explicitly-labelled TEST SETUP / HISTORY (triggers
// bypassed). Every provider observation is a SYNTHETIC fixture; no provider, notification or network call exists in this file.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startMigratedDatabase, startPostgres } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent } from "../../db/lib/repo.js";
import { claimNextOperation, completeOperation, completeRecordingWithEvidence, linkRecordingEvidence, requestRead, recordRecordingAssessment,
  recordReleaseReviewAssessment, openRecordingPreflightHold, openRecordingVisibilityHold } from "../../db/lib/operations.js";
import { adminResolveOperation, adminResolveRecordingHold, adminReleasePreflightHold } from "../../db/lib/admin.js";
import { migrateDown, migrateUp } from "../../db/lib/migrate.js";

let db; let report;
before(async () => { db = await startMigratedDatabase(); report = new pg.Pool({ connectionString: db.reportUrl(), max: 2 }); });
after(async () => { await report.end().catch(() => {}); await db.close(); });

const MIN = 60 * 1000;
const OCH = ["hostaway.record_offline_charge"];
const ACCT2 = "acct-test-2";                                                                 // a second well-formed FIXTURE label
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stayN = 0;
const stay = () => { stayN += 1; const d = new Date(Date.UTC(2033, 0, 1) + stayN * 6 * 86400000).toISOString().slice(0, 10);
  const e = new Date(Date.UTC(2033, 0, 1) + (stayN * 6 + 3) * 86400000).toISOString().slice(0, 10); return { listingId: 860000 + stayN, from: d, to: e }; };
let idN = 996000;
const cid = () => String(++idN);

// ---- helpers --------------------------------------------------------------------------------------------------------
const facts = async (pool, id) => (await pool.query("SELECT version, listing_id, state FROM booking.intents WHERE id = $1", [id])).rows[0];
async function capturedIntent(d = db) { const st = stay(); const c = await F.captured(d.app, st); const f = await facts(d.app, c.id); return { ...c, ...st, listingId: f.listing_id }; }
const obs = (c, id, o = {}) => F.recordingObserved(c, id, o);
const cnt = (ids) => ({ matchingChargeCount: ids.length, matchingChargeIds: ids.map(String) });
const evAt = (c, observed, t = Date.now(), d = db) => F.chargeListEvidence(d.app, c, observed, t);
const opRow = async (id, d = db) => (await d.owner.query("SELECT * FROM booking.external_operations WHERE id = $1", [id])).rows[0];
const audits = async (opId, d = db) => (await d.owner.query("SELECT * FROM booking.recording_claim_assessments WHERE operation_id = $1", [opId])).rows;
/** captured + claimed initial recording (real eligible preflight; work lease w1); pf = optional preflight overrides (claimed method / label) */
async function claimed({ at = Date.now(), leaseMs = 10 * MIN, pf, d = db } = {}) {
  const c = await capturedIntent(d);
  await d.app.query("UPDATE booking.intent_work SET work_worker_id = 'w1', work_lease_until = $2 WHERE intent_id = $1", [c.id, new Date(Math.max(at, Date.now()) + 10 * MIN)]);
  const op = await F.claimHealthyRecording(d.app, { workerId: "w1", now: at, intentId: c.id, opTypes: OCH, leaseMs, ...(pf ? { preflight: pf } : {}) });
  assert.ok(op, "claimable");
  return { c, op, t: at };
}
const complete = async (c, opId, ev, id, { worker = "w1", d = db } = {}) =>
  completeRecordingWithEvidence(d.app, opId, { workerId: worker, evidenceId: ev, resultRef: id, expectedVersion: (await facts(d.app, c.id)).version });
const errMsg = (p) => p.then(() => "ok", (e) => String(e.message));
/** the exact database refusal text (the JS helpers return only the safety code) */
const rawComplete = async (c, opId, ev, id, worker = "w1") => errMsg(db.app.query("SELECT booking.complete_recording_with_evidence($1, $2, $3, $4, $5)",
  [opId, worker, ev, id, (await facts(db.app, c.id)).version]));
const rawLink = (opId, ev) => errMsg(db.app.query("SELECT booking.link_recording_evidence($1, $2)", [opId, ev]));
const resolveSucceeded = (opId, ev0, id, at = F.at(60), d = db) => adminResolveOperation(d.reconciler, { operationId: opId, decision: "succeeded", evidenceIds: [ev0],
  resultRef: Number(id), resolver: "owner", justification: "CHARGE_FOUND_IN_HOSTAWAY", at });
/** claimed (dispatched F.at(9)), reported outcome_unknown, owner-resolved succeeded from count-only evidence: succeeded, UNLINKED, WITH claim audit */
async function ownerSucceededUnlinked({ pf, d = db } = {}) {
  const c = await capturedIntent(d); const id = cid();
  const op = await F.claimHealthyRecording(d.app, { workerId: "w1", now: F.at(9), intentId: c.id, opTypes: OCH, ...(pf ? { preflight: pf } : {}) });
  assert.ok(op);
  F.ok(await completeOperation(d.app, op.id, { workerId: "w1", now: F.at(9.2), outcome: { status: "outcome_unknown" } }));
  const ev0 = await F.readEvidence(d.app, c.id, "hostaway_offline_charges", String(c.reservationId), "listed", cnt([id]), 30);
  F.ok(await resolveSucceeded(op.id, ev0, id, F.at(60), d));
  return { c, opId: op.id, id, ev0 };
}
/** labelled inherited HISTORY (schema owner, triggers bypassed): the initial recording put in flight WITHOUT any claim audit (pre-0012 style) */
async function inheritedInFlight({ t = Date.now(), d = db } = {}) {
  const c = await capturedIntent(d);
  const opId = await F.initialRecordingId(d.app, c.id);
  await d.app.query("UPDATE booking.intent_work SET work_worker_id = 'w1', work_lease_until = $2 WHERE intent_id = $1", [c.id, new Date(Math.max(t, Date.now()) + 10 * MIN)]);
  await F.ownerManagedHistory(d.owner, `UPDATE booking.external_operations SET state = 'in_flight', attempts = 1, dispatched_at = $2, lease_worker_id = 'w1',
      lease_until = $3, updated_at = $2 WHERE id = $1 AND state = 'pending'`, [opId, new Date(t), new Date(t + 10 * MIN)]);
  assert.equal((await audits(opId, d)).length, 0, "no claim audit");
  return { c, opId, t };
}
/** inherited no-audit row, reported unknown and owner-resolved succeeded: succeeded, UNLINKED, NO claim audit (historical maintenance) */
async function inheritedSucceededUnlinked(d = db) {
  const { c, opId } = await inheritedInFlight({ t: F.at(9), d }); const id = cid();
  F.ok(await completeOperation(d.app, opId, { workerId: "w1", now: F.at(9.2), outcome: { status: "outcome_unknown" } }));
  const ev0 = await F.readEvidence(d.app, c.id, "hostaway_offline_charges", String(c.reservationId), "listed", cnt([id]), 30);
  F.ok(await resolveSucceeded(opId, ev0, id, F.at(60), d));
  return { c, opId, id, ev0 };
}
/** a hash of every data row this stage could touch (atomicity: a refusal changes NOTHING) */
const DATA = ["external_operations", "intents", "intent_transitions", "recording_claim_assessments", "recording_assessments", "recording_holds",
  "recording_hold_decisions", "reconciliation_cases", "recording_conflict_inbox", "intent_work"];
const dataHash = async (d = db) => (await d.owner.query(`SELECT ${DATA.map((t) => `(SELECT md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY to_jsonb(x)::text), '')) FROM booking.${t} x)`).join(" || ")} AS h`)).rows[0].h;
const OBJECTS = `
  SELECT 'fn|' || p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(array_to_string(p.proacl, ','), '') || '|' ||
         p.prosecdef::text || '|' || p.provolatile::text || '|' || coalesce(array_to_string(p.proconfig, ','), '') AS o FROM pg_proc p WHERE p.pronamespace = 'booking'::regnamespace
  UNION ALL SELECT 'trg|' || tgrelid::regclass::text || '|' || tgname || '|' || pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text LIKE 'booking.%'
  UNION ALL SELECT 'col|' || table_name || '|' || column_name || '|' || data_type || '|' || is_nullable FROM information_schema.columns WHERE table_schema = 'booking'
  UNION ALL SELECT 'tbl|' || grantee || '|' || table_name || '|' || privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'booking'
  UNION ALL SELECT 'pol|' || tablename || '|' || policyname || '|' || array_to_string(roles, ',') || '|' || cmd FROM pg_policies WHERE schemaname = 'booking'
  UNION ALL SELECT 'con|' || conrelid::regclass::text || '|' || conname || '|' || pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace = 'booking'::regnamespace
  UNION ALL SELECT 'idx|' || indexrelid::regclass::text || '|' || pg_get_indexdef(indexrelid) FROM pg_index WHERE indrelid::regclass::text LIKE 'booking.%'
  UNION ALL SELECT 'rls|' || relname || '|' || relrowsecurity::text FROM pg_class WHERE relnamespace = 'booking'::regnamespace AND relkind = 'r'
  ORDER BY 1`;
const objects = async (c) => (await c.query(OBJECTS)).rows.map((x) => x.o);
const version = async (c) => (await c.query("SELECT max(version)::int AS v FROM booking_migrations.applied")).rows[0].v;
async function adminClient(d) { const c = new pg.Client({ connectionString: d.adminUrl }); c.on("error", () => {}); await c.connect(); return c; }
async function appClient(d) { const c = new pg.Client({ connectionString: d.appUrl() }); c.on("error", () => {}); await c.connect(); return c; }
async function waitForLockWaiters(d, n = 1, timeoutMs = 8000) {
  const t0 = Date.now();
  for (;;) {
    const r = await d.owner.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`);
    if (r.rows[0].n >= n) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`no lock waiter observed within ${timeoutMs} ms`);
    await sleep(10);
  }
}
/** owner PROBE transaction, always rolled back: optional replica-mode TEST SETUP, then triggers back ON for the measured statement */
async function probe(setup, measure, d = db) {
  const c = await d.owner.connect();
  try {
    await c.query("BEGIN");
    if (setup) { await c.query("SET LOCAL session_replication_role = replica"); await setup(c); await c.query("SET LOCAL session_replication_role = origin"); }
    return await measure(c);
  } finally { await c.query("ROLLBACK").catch(() => {}); c.release(); }
}
const pred = (c, op, ev, w) => c.query("SELECT booking.recording_completion_binding_refusal($1, $2, $3) AS r", [op, ev, w]).then((x) => x.rows[0].r);
const sqlErr = (c, sql, p) => c.query(sql, p).then(() => "ok", (e) => String(e.message));
// A refused full proof stays STORED evidence, and the unchanged D2 rule then treats any later different same-intent candidate as a positive
// contradiction. So the guard's answer for several candidates on ONE recording is measured in rolled-back probes: the stored (matching) proof's
// observed is patched inside the probe (TEST SETUP, triggers bypassed), the real function then runs with every trigger ON, and nothing persists.
const J = (o) => `observed || '${JSON.stringify(o)}'::jsonb`;
const patchEv = (ev, expr) => async (x) => { await x.query(`UPDATE booking.provider_evidence SET observed = ${expr} WHERE id = $1`, [ev]); };
const guardComplete = async (c, opId, ev, id, expr = null, worker = "w1") => { const ver = (await facts(db.app, c.id)).version;
  return probe(expr ? patchEv(ev, expr) : null, (x) => sqlErr(x, "SELECT booking.complete_recording_with_evidence($1, $2, $3, $4, $5)", [opId, worker, ev, id, ver])); };
const guardLink = (opId, ev, expr = null) => probe(expr ? patchEv(ev, expr) : null, (x) => sqlErr(x, "SELECT booking.link_recording_evidence($1, $2)", [opId, ev]));

// ---- release-cycle helpers (0013) -------------------------------------------------------------------------------------
const lease = (intentId, worker = "w1", ms = 10 * MIN) =>
  db.app.query("UPDATE booking.intent_work SET work_worker_id = $2, work_lease_until = $3 WHERE intent_id = $1", [intentId, worker, new Date(Date.now() + ms)]);
async function readAt(s, opType, done = Date.now()) {
  const id = await requestRead(db.app, s.c.id, opType, s.f.hostaway_reservation_id, { now: Math.max(done, Date.now()) });
  assert.ok(await claimNextOperation(db.app, { workerId: "w-read", now: Math.max(done, Date.now()), opId: id }));
  F.ok(await completeOperation(db.app, id, { workerId: "w-read", now: done, outcome: { status: "succeeded" } }));
  return id;
}
async function parts(s, { acct = F.PREFLIGHT_ACCOUNT_REF, list = {} } = {}) {
  const identityReadId = await readAt(s, "hostaway.retrieve_reservation");
  const identityEvidenceId = await F.readEvidenceOf(db.app, identityReadId, "hostaway_reservation", s.f.hostaway_reservation_id, "found_active",
    F.identityObserved(s.f, { executorAccountRef: acct }));
  const listReadId = await readAt(s, "hostaway.list_offline_charges");
  const listEvidenceId = await F.readEvidenceOf(db.app, listReadId, "hostaway_offline_charges", s.f.hostaway_reservation_id, "listed",
    F.preflightListObserved({ executorAccountRef: acct, ...list }));
  return { identityReadId, identityEvidenceId, listReadId, listEvidenceId };
}
const refresh = async (s) => { s.f = await F.preflightFacts(db.app, s.c.id); return s; };
const common = (s, { acct = F.PREFLIGHT_ACCOUNT_REF, method = "credit_card" } = {}) => ({ workerId: "w1", expectedVersion: s.f.version, moduleVersion: F.PROOF_MODULE_VERSION,
  clientLabel: F.PREFLIGHT_CLIENT_LABEL, accountRef: acct, config: F.preflightConfig(s.f, { accountRef: acct, paymentMethod: method }) });
const eligibleAs = async (s, cfg = {}) => recordRecordingAssessment(db.app, s.opId, { ...common(s, cfg), outcome: "eligible", ...(await parts(s, cfg)) });
const conflictList = { matchingChargeCount: 1, matchingChargeIds: ["700001"], rowCount: 1 };
const conflictAs = async (s, cfg = {}) => recordRecordingAssessment(db.app, s.opId, { ...common(s, cfg), outcome: "conflict_marker", code: "PRIOR_RECORDING_MARKER_PRESENT",
  ...(await parts(s, { ...cfg, list: conflictList })) });
const reviewAs = async (s, holdId) => recordReleaseReviewAssessment(db.app, holdId, { ...common(s), outcome: "eligible", ...(await parts(s)) });
async function releaseCycle(s, cfg) {
  F.ok(await eligibleAs(s, cfg)); F.ok(await conflictAs(s, cfg));
  const h = F.ok(await openRecordingPreflightHold(db.app, s.opId, { by: "test-opener" })).holdId;
  const r = F.ok(await reviewAs(s, h)).id;
  F.ok(await adminReleasePreflightHold(db.reconciler, { holdId: h, reviewId: r, resolver: "owner", justification: "PREFLIGHT_RECHECKED_CLEAN", at: Date.now() }));
  await refresh(s);
}

// =============================================================================================
test("C-1: the claimed method + account match → succeeded + link; finalisation unchanged; an 'other' claim with an 'other' proof is equally bound", async () => {
  const { c, op, t } = await claimed(); const id = cid();
  const ev = await evAt(c, obs(c, id), t + 5);
  assert.deepEqual(await complete(c, op.id, ev, id), { ok: true, state: "succeeded" });
  const o = await opRow(op.id);
  assert.deepEqual([o.state, o.settled_evidence_id, o.result_ref], ["succeeded", ev, id]);
  F.ok(await applyEvent(db.app, c.id, { type: "OFFLINE_CHARGE_RECORDED", chargeId: id }, { now: Date.now() }));
  assert.equal((await facts(db.app, c.id)).state, "confirmed");
  const x = await claimed({ pf: { config: { paymentMethod: "other" } } }); const xid = cid();
  assert.deepEqual(await complete(x.c, x.op.id, await evAt(x.c, obs(x.c, xid, { paymentMethod: "other" }), x.t + 5), xid), { ok: true, state: "succeeded" });
  const y = await claimed({ pf: { accountRef: ACCT2 } }); const yid = cid();
  assert.deepEqual(await complete(y.c, y.op.id, await evAt(y.c, obs(y.c, yid, { executorAccountRef: ACCT2 }), y.t + 5), yid), { ok: true, state: "succeeded" },
    "a claim under another well-formed label binds that label (TRUST, not provider authentication)");
});

test("C-2 / C-11: account-only and method-only mismatches (both directions) → RECORDING_CLAIM_BINDING with the exact step; nothing changes (committed refusal, one per recording)", async () => {
  const cases = [
    ["account (claim 1, proof 2)", {}, { executorAccountRef: ACCT2 }, "EXECUTOR_ACCOUNT_MISMATCH", {}],
    ["account (claim 2, proof 1)", { accountRef: ACCT2 }, {}, "EXECUTOR_ACCOUNT_MISMATCH", { executorAccountRef: ACCT2 }],
    ["method (claim credit_card, proof other)", {}, { paymentMethod: "other" }, "PAYMENT_METHOD_MISMATCH", {}],
    ["method (claim other, proof credit_card)", { config: { paymentMethod: "other" } }, {}, "PAYMENT_METHOD_MISMATCH", { paymentMethod: "other" }],
  ];
  for (const [name, pf, bad, step, good] of cases) {
    const { c, op, t } = await claimed({ pf }); const id = cid();
    const ev = await evAt(c, obs(c, id, bad), t + 5);
    const h0 = await dataHash();
    assert.equal(await rawComplete(c, op.id, ev, id), `RECORDING_CLAIM_BINDING: ${step}`, name);
    assert.deepEqual(await complete(c, op.id, ev, id), { ok: false, error: "RECORDING_CLAIM_BINDING" }, name);
    assert.equal(await dataHash(), h0, `${name}: op / link / audit / intent byte-identical`);
    const o = await opRow(op.id);
    assert.deepEqual([o.state, o.settled_evidence_id, (await audits(op.id)).length], ["in_flight", null, 1], name);
    // the refused candidate is stored evidence: a later matching candidate is a positive contradiction under the unchanged D2 rule (no bypass)
    assert.equal((await complete(c, op.id, await evAt(c, obs(c, id, good), t + 6), id)).error, "RECORDING_EVIDENCE_CONFLICT", name);
  }
  // the same four answers in rolled-back probes on ONE recording, whose matching proof then completes
  const { c, op, t } = await claimed(); const id = cid();
  const ev = await evAt(c, obs(c, id), t + 5);
  assert.equal(await guardComplete(c, op.id, ev, id, J({ executorAccountRef: ACCT2 })), "RECORDING_CLAIM_BINDING: EXECUTOR_ACCOUNT_MISMATCH");
  assert.equal(await guardComplete(c, op.id, ev, id, J({ paymentMethod: "other" })), "RECORDING_CLAIM_BINDING: PAYMENT_METHOD_MISMATCH");
  assert.equal(await guardComplete(c, op.id, ev, id, J({ executorAccountRef: ACCT2, paymentMethod: "other" })), "RECORDING_CLAIM_BINDING: EXECUTOR_ACCOUNT_MISMATCH", "account checked first");
  assert.deepEqual(await complete(c, op.id, ev, id), { ok: true, state: "succeeded" });
});

test("C-3: malformed / mistyped / NULL / missing D5 fields stay the 0010 proof refusal (format / approved set) — D5 is never reached", async () => {
  const { c, op, t } = await claimed();
  const variants = [{ executorAccountRef: undefined }, { executorAccountRef: null }, { executorAccountRef: 7 }, { executorAccountRef: "" },
    { executorAccountRef: "ACCT TEST" }, { paymentMethod: undefined }, { paymentMethod: null }, { paymentMethod: 5 }, { paymentMethod: "cash" }];
  const id = cid();
  const ev = await evAt(c, obs(c, id), t + 5);
  for (const v of variants) {
    const k = Object.keys(v)[0];
    const expr = v[k] === undefined ? `observed - '${k}'` : J(v);
    assert.match(await guardComplete(c, op.id, ev, id, expr), /^RECORDING_PROOF_REFUSED: /, JSON.stringify(v));
  }
  // one committed malformed candidate on another recording: refused by the proof, nothing changes
  const b = await claimed(); const bid = cid();
  const bev = await evAt(b.c, obs(b.c, bid, { paymentMethod: "cash" }), b.t + 5);
  const h0 = await dataHash();
  assert.equal((await complete(b.c, b.op.id, bev, bid)).error, "RECORDING_PROOF_REFUSED");
  assert.equal(await dataHash(), h0);
  F.ok(await complete(c, op.id, ev, id), "probes rolled back");
});

test("C-4: evidence of another intent / another kind → the existing proof refusals; D5 is not reached", async () => {
  const a = await claimed(); const b = await claimed(); const id = cid();
  const foreign = await evAt(b.c, obs(b.c, id), b.t + 5);                                    // full proof, but of intent b
  assert.match(await rawComplete(a.c, a.op.id, foreign, id), /^RECORDING_PROOF_REFUSED: /);
  const idRead = (await db.owner.query("SELECT identity_evidence AS e FROM booking.recording_assessments WHERE operation_id = $1", [a.op.id])).rows[0].e;
  assert.match(await rawComplete(a.c, a.op.id, idRead, id), /^RECORDING_PROOF_REFUSED: /, "identity evidence is not proof");
  assert.match(await rawComplete(a.c, a.op.id, "00000000-0000-4000-8000-00000000ee01", id), /^RECORDING_PROOF_REFUSED: /);
  assert.equal((await opRow(a.op.id)).state, "in_flight");
});

test("C-5 (addendum C / E): NO claim audit — worker completion fails closed (NO_CLAIM_AUDIT); historical owner maintenance keeps the legacy policy under the existing owner-resolved + owner_historical rules; never a link merely because the audit is absent", async () => {
  const { c, opId, t } = await inheritedInFlight(); const id = cid();
  const ev = await evAt(c, obs(c, id), t + 5);
  const h0 = await dataHash();
  assert.equal(await rawComplete(c, opId, ev, id), "RECORDING_CLAIM_BINDING: NO_CLAIM_AUDIT");
  assert.deepEqual(await complete(c, opId, ev, id), { ok: false, error: "RECORDING_CLAIM_BINDING" });
  assert.equal(await dataHash(), h0);
  // historical maintenance (no audit): owner-resolved succeeded row, full owner_historical proof with ANY well-formed approved fields
  const u = await inheritedSucceededUnlinked();
  assert.equal((await linkRecordingEvidence(db.app, u.opId, { evidenceId: await evAt(u.c, obs(u.c, u.id, { executorAccountRef: ACCT2, paymentMethod: "other" }), F.at(9 + 14)) })).error,
    "RECORDING_PROOF_REFUSED", "the 15-minute owner_historical rule still applies");
  assert.deepEqual(await linkRecordingEvidence(db.app, u.opId, { evidenceId: await evAt(u.c, obs(u.c, u.id, { executorAccountRef: ACCT2, paymentMethod: "other" }), F.at(40)) }),
    { ok: true, state: "linked" }, "legacy policy: no claim, nothing to bind to");
  // link_full_proof on a no-audit row: same legacy policy
  const v = await inheritedSucceededUnlinked();
  const hv = F.ok(await openRecordingVisibilityHold(db.app, v.opId, { reason: "SUCCEEDED_UNPROVEN", by: "m" }));
  F.ok(await adminResolveRecordingHold(db.reconciler, { holdId: hv.holdId, decision: "link_full_proof", resolver: "owner", justification: "HISTORICAL_PROOF",
    linkedEvidenceId: await evAt(v.c, obs(v.c, v.id, { paymentMethod: "other" }), F.at(40)), at: F.at(110) }));
  // the absence of an audit never attaches a link by itself: a no-audit row that is not owner-resolved succeeded is not linkable
  const w = await inheritedInFlight({ t: F.at(9) }); const wid = cid();
  F.ok(await completeOperation(db.app, w.opId, { workerId: "w1", now: F.at(9.2), outcome: { status: "outcome_unknown" } }));
  assert.equal((await linkRecordingEvidence(db.app, w.opId, { evidenceId: await evAt(w.c, obs(w.c, wid), F.at(40)) })).error, "RECORDING_STATE");
  assert.equal((await opRow(w.opId)).settled_evidence_id, null);
});

test("C-5b (addendum C): the worker branch never runs in NULL / owner mode — a privileged direct transition into succeeded with a link and no old lease worker is CLAIM_WORKER (audit or not); a different lease worker than the claim worker is CLAIM_WORKER", async () => {
  const DIRECT_SUCCESS = `UPDATE booking.external_operations SET state = 'succeeded', settled_evidence_id = $2, result_ref = $3, completed_at = clock_timestamp(),
     updated_at = clock_timestamp() WHERE id = $1`;
  // a claimed (audit) recording reported unknown: lease cleared
  const a = await claimed(); const aid = cid();
  F.ok(await completeOperation(db.app, a.op.id, { workerId: "w1", now: Date.now(), outcome: { status: "outcome_unknown" } }));
  const aev = await evAt(a.c, obs(a.c, aid), a.t + 5);
  assert.equal(await probe(null, (c) => sqlErr(c, DIRECT_SUCCESS, [a.op.id, aev, aid])), "RECORDING_CLAIM_BINDING: CLAIM_WORKER");
  // a no-audit row in the same shape: still CLAIM_WORKER (the owner-mode NO_CLAIM_AUDIT exemption is only the succeeded NULL -> link branch)
  const n = await inheritedInFlight(); const nid = cid();
  F.ok(await completeOperation(db.app, n.opId, { workerId: "w1", now: Date.now(), outcome: { status: "outcome_unknown" } }));
  const nev = await evAt(n.c, obs(n.c, nid), n.t + 5);
  assert.equal(await probe(null, (c) => sqlErr(c, DIRECT_SUCCESS, [n.opId, nev, nid])), "RECORDING_CLAIM_BINDING: CLAIM_WORKER");
  // lease handed to w2 (TEST SETUP inside the rolled-back probe): the claim worker is w1
  const b = await claimed(); const bid = cid();
  const bev = await evAt(b.c, obs(b.c, bid), b.t + 5);
  const ver = (await facts(db.app, b.c.id)).version;
  assert.equal(await probe(async (c) => {
    await c.query("UPDATE booking.external_operations SET lease_worker_id = 'w2' WHERE id = $1", [b.op.id]);
    await c.query("UPDATE booking.intent_work SET work_worker_id = 'w2' WHERE intent_id = $1", [b.c.id]);
  }, (c) => sqlErr(c, "SELECT booking.complete_recording_with_evidence($1, 'w2', $2, $3, $4)", [b.op.id, bev, bid, ver])), "RECORDING_CLAIM_BINDING: CLAIM_WORKER");
  assert.deepEqual(await complete(b.c, b.op.id, bev, bid), { ok: true, state: "succeeded" }, "probe rolled back; the claim worker completes");
});

test("C-6: two release cycles → claim at epoch 2 → the epoch-2 claimed assessment governs; proofs matching an older epoch's different method / account are each refused", async () => {
  const c0 = await F.captured(db.app, stay()); await lease(c0.id);
  const s = { c: c0, opId: await F.initialRecordingId(db.app, c0.id), f: await F.preflightFacts(db.app, c0.id) };
  await releaseCycle(s, { acct: ACCT2, method: "other" });                                 // epoch 0: both fields different
  await releaseCycle(s, { method: "other" });                                              // epoch 1: method different
  assert.equal((await db.owner.query("SELECT booking.recording_preflight_epoch($1) AS e", [s.opId])).rows[0].e, 2);
  const e2 = F.ok(await eligibleAs(s)).id;                                                 // epoch 2: acct-test-1 / credit_card
  await lease(c0.id);
  const op = await claimNextOperation(db.app, { workerId: "w1", now: Date.now(), intentId: c0.id, opTypes: OCH, leaseMs: 10 * MIN });
  assert.ok(op && op.id === s.opId);
  const [au] = await audits(s.opId);
  assert.deepEqual([au.assessment_id, au.epoch], [e2, 2]);
  const c = { ...c0, listingId: s.f.listing_id }; const t = Date.now(); const id = cid();
  const ev = await evAt(c, obs(c, id), t + 5);
  const tries = [["epoch-0 cfg (acct 2 + other)", { executorAccountRef: ACCT2, paymentMethod: "other" }, "EXECUTOR_ACCOUNT_MISMATCH"],
    ["epoch-1 cfg (other)", { paymentMethod: "other" }, "PAYMENT_METHOD_MISMATCH"], ["older account only", { executorAccountRef: ACCT2 }, "EXECUTOR_ACCOUNT_MISMATCH"]];
  for (const [name, o, step] of tries) assert.equal(await guardComplete(c, s.opId, ev, id, J(o)), `RECORDING_CLAIM_BINDING: ${step}`, name);
  assert.deepEqual(await complete(c, s.opId, ev, id), { ok: true, state: "succeeded" }, "epoch-2 cfg governs");
});

test("C-7: an injected LATER assessment / release review (TEST SETUP, triggers bypassed) never replaces the immutable claim anchor", async () => {
  const { c, op, t } = await claimed();
  const [au] = await audits(op.id);
  for (const phase of ["preflight", "release_review"]) {
    await F.ownerManagedHistory(db.owner, `INSERT INTO booking.recording_assessments (id, operation_id, intent_id, phase, epoch, outcome, code, identity_read_op, list_read_op,
        identity_evidence, list_evidence, intent_version, worker, module_version, cfg, client_label, account_ref, recorded_at, hold_id)
      SELECT gen_random_uuid(), operation_id, intent_id, $2, epoch, outcome, code, gen_random_uuid(), gen_random_uuid(), identity_evidence, list_evidence, intent_version,
        worker, module_version, cfg || '{"paymentMethod": "other", "accountRef": "acct-test-2"}'::jsonb, client_label, 'acct-test-2', clock_timestamp() + interval '1 second',
        CASE WHEN $2 = 'release_review' THEN gen_random_uuid() END
      FROM booking.recording_assessments WHERE id = $1`, [au.assessment_id, phase]);
  }
  assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM booking.recording_assessments WHERE operation_id = $1", [op.id])).rows[0].n, 3);
  const id = cid();
  const ev = await evAt(c, obs(c, id), t + 5);
  assert.equal(await guardComplete(c, op.id, ev, id, J({ paymentMethod: "other", executorAccountRef: ACCT2 })), "RECORDING_CLAIM_BINDING: EXECUTOR_ACCOUNT_MISMATCH",
    "the later rows' cfg is never used");
  assert.equal(await guardComplete(c, op.id, ev, id, J({ paymentMethod: "other" })), "RECORDING_CLAIM_BINDING: PAYMENT_METHOD_MISMATCH");
  assert.deepEqual(await complete(c, op.id, ev, id), { ok: true, state: "succeeded" }, "the claimed assessment governs");
});

test("C-8 / E: an op WITH audit cannot evade D5 through owner resolution — link_recording_evidence and link_full_proof refuse a mismatched method or account (link_full_proof rolls back its decision, link, hold release and case closure) and accept the matching proof", async () => {
  // owner resolution then app maintenance link
  for (const [name, bad, step] of [["account", { executorAccountRef: ACCT2 }, "EXECUTOR_ACCOUNT_MISMATCH"], ["method", { paymentMethod: "other" }, "PAYMENT_METHOD_MISMATCH"]]) {
    const u = await ownerSucceededUnlinked();
    const ev = await evAt(u.c, obs(u.c, u.id, bad), F.at(40));
    const h0 = await dataHash();
    assert.equal(await rawLink(u.opId, ev), `RECORDING_CLAIM_BINDING: ${step}`, name);
    assert.deepEqual(await linkRecordingEvidence(db.app, u.opId, { evidenceId: ev }), { ok: false, error: "RECORDING_CLAIM_BINDING" }, name);
    assert.equal(await dataHash(), h0, `${name}: nothing changed`);
  }
  {
    const u = await ownerSucceededUnlinked();
    assert.deepEqual(await linkRecordingEvidence(db.app, u.opId, { evidenceId: await evAt(u.c, obs(u.c, u.id), F.at(40)) }), { ok: true, state: "linked" });
  }
  // owner resolution then link_full_proof
  for (const [name, bad] of [["account", { executorAccountRef: ACCT2 }], ["method", { paymentMethod: "other" }]]) {
    const u = await ownerSucceededUnlinked();
    const h = F.ok(await openRecordingVisibilityHold(db.app, u.opId, { reason: "SUCCEEDED_UNPROVEN", by: "m" }));
    const ev = await evAt(u.c, obs(u.c, u.id, bad), F.at(40));
    const before = { hold: (await db.owner.query("SELECT * FROM booking.recording_holds WHERE id = $1", [h.holdId])).rows[0] };
    const h0 = await dataHash();
    const r = await adminResolveRecordingHold(db.reconciler, { holdId: h.holdId, decision: "link_full_proof", linkedEvidenceId: ev, resolver: "owner",
      justification: "HISTORICAL_PROOF", at: F.at(110) });
    assert.equal(r.error, "RECORDING_CLAIM_BINDING", name);
    assert.equal(await dataHash(), h0, `${name}: decision / link / hold release / case closure all rolled back`);
    const hold = (await db.owner.query("SELECT * FROM booking.recording_holds WHERE id = $1", [h.holdId])).rows[0];
    const k = (await db.owner.query("SELECT status FROM booking.reconciliation_cases WHERE id = $1", [hold.case_id])).rows[0];
    assert.deepEqual([hold.released_at, hold.release_decision_id, k.status, (await opRow(u.opId)).settled_evidence_id], [null, null, "open", null]);
    assert.deepEqual(hold, before.hold);
    assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM booking.recording_hold_decisions WHERE hold_id = $1", [h.holdId])).rows[0].n, 0);
  }
  {
    // the matching proof: link + decision + release + case closure together
    const u = await ownerSucceededUnlinked();
    const h = F.ok(await openRecordingVisibilityHold(db.app, u.opId, { reason: "SUCCEEDED_UNPROVEN", by: "m" }));
    const ev = await evAt(u.c, obs(u.c, u.id), F.at(40));
    assert.equal(await probe(patchEv(ev, J({ paymentMethod: "other" })), (x) => sqlErr(x,
      "SELECT booking.admin_resolve_recording_hold($1, 'link_full_proof', '{}'::uuid[], $2, 'owner', 'HISTORICAL_PROOF', $3)", [h.holdId, ev, new Date(F.at(110))])),
      "RECORDING_CLAIM_BINDING: PAYMENT_METHOD_MISMATCH", "the same proof, patched in a rolled-back probe");
    const d = F.ok(await adminResolveRecordingHold(db.reconciler, { holdId: h.holdId, decision: "link_full_proof", linkedEvidenceId: ev, resolver: "owner",
      justification: "HISTORICAL_PROOF", at: F.at(110) }));
    const hold = (await db.owner.query("SELECT * FROM booking.recording_holds WHERE id = $1", [h.holdId])).rows[0];
    const k = (await db.owner.query("SELECT status FROM booking.reconciliation_cases WHERE id = $1", [hold.case_id])).rows[0];
    assert.deepEqual([(await opRow(u.opId)).settled_evidence_id, hold.release_decision_id, k.status], [ev, d.id, "resolved"]);
  }
});

test("C-8b (addendum A): claimed recordings that become outcome_unknown or escalated (TEST SETUP state) and are owner-resolved stay governed by D5", async () => {
  // outcome_unknown (real path) — covered by ownerSucceededUnlinked; escalated: labelled TEST SETUP (a recording is non_idempotent and never escalates
  // through markUnknown, but admin_resolve_operation accepts the state, 0005:303)
  const c = await capturedIntent(); const id = cid();
  const op = await F.claimHealthyRecording(db.app, { workerId: "w1", now: F.at(9), intentId: c.id, opTypes: OCH });
  await F.ownerManagedHistory(db.owner, "UPDATE booking.external_operations SET state = 'escalated', lease_worker_id = NULL, lease_until = NULL WHERE id = $1", [op.id]);
  const ev0 = await F.readEvidence(db.app, c.id, "hostaway_offline_charges", String(c.reservationId), "listed", cnt([id]), 30);
  F.ok(await resolveSucceeded(op.id, ev0, id));
  const ev = await evAt(c, obs(c, id), F.at(40));
  assert.equal(await guardLink(op.id, ev, J({ executorAccountRef: ACCT2 })), "RECORDING_CLAIM_BINDING: EXECUTOR_ACCOUNT_MISMATCH");
  assert.equal(await guardLink(op.id, ev, J({ paymentMethod: "other" })), "RECORDING_CLAIM_BINDING: PAYMENT_METHOD_MISMATCH");
  assert.deepEqual(await linkRecordingEvidence(db.app, op.id, { evidenceId: ev }), { ok: true, state: "linked" });
  // outcome_unknown (real path) with audit, owner-resolved: the same answers on the app maintenance link
  const u = await ownerSucceededUnlinked();
  const uev = await evAt(u.c, obs(u.c, u.id), F.at(40));
  assert.equal(await guardLink(u.opId, uev, J({ executorAccountRef: ACCT2 })), "RECORDING_CLAIM_BINDING: EXECUTOR_ACCOUNT_MISMATCH");
  assert.equal(await guardLink(u.opId, uev, J({ paymentMethod: "other" })), "RECORDING_CLAIM_BINDING: PAYMENT_METHOD_MISMATCH");
  assert.deepEqual(await linkRecordingEvidence(db.app, u.opId, { evidenceId: uev }), { ok: true, state: "linked" });
});

test("C-9: op / work lease expiry and proof ageing keep their existing refusals; D5 requires no claim-time freshness at completion", async () => {
  const a = await claimed({ leaseMs: 1 }); const aid = cid();
  await sleep(25);
  assert.equal((await complete(a.c, a.op.id, await evAt(a.c, obs(a.c, aid), a.t + 5), aid)).error, "RECORDING_LEASE_LOST");
  const b = await claimed(); const bid = cid();
  await db.app.query("UPDATE booking.intent_work SET work_lease_until = $2 WHERE intent_id = $1", [b.c.id, new Date(Date.now() - 1000)]);
  assert.equal((await complete(b.c, b.op.id, await evAt(b.c, obs(b.c, bid), b.t + 5), bid)).error, "RECORDING_WORK_LEASE_LOST");
  const s = await claimed(); const sid = cid();
  assert.equal((await complete(s.c, s.op.id, await evAt(s.c, obs(s.c, sid), s.t - 60 * 1000), sid)).error, "RECORDING_PROOF_REFUSED", "proof older than the dispatch");
  // TEST SETUP: the claimed assessment and its audit backdated three days; completion with the matching proof still succeeds
  const o = await claimed(); const oid = cid();
  await F.ownerManagedHistory(db.owner, "UPDATE booking.recording_assessments SET recorded_at = recorded_at - interval '3 days' WHERE operation_id = $1", [o.op.id]);
  await F.ownerManagedHistory(db.owner, "UPDATE booking.recording_claim_assessments SET claimed_at = claimed_at - interval '3 days' WHERE operation_id = $1", [o.op.id]);
  assert.deepEqual(await complete(o.c, o.op.id, await evAt(o.c, obs(o.c, oid), o.t + 5), oid), { ok: true, state: "succeeded" });
});

test("C-10: unchanged — no repoint / clear, positive-contradiction refusal, active-hold refusal, 15-minute historical rule (with D5-matching proofs)", async () => {
  const { c, op, t } = await claimed(); const id = cid();
  const ev = await evAt(c, obs(c, id), t + 5);
  F.ok(await complete(c, op.id, ev, id));
  const ev2 = await evAt(c, obs(c, id), t + 6);
  assert.match(await probe(null, (x) => sqlErr(x, "UPDATE booking.external_operations SET settled_evidence_id = $2 WHERE id = $1", [op.id, ev2])), /SETTLED_EVIDENCE_IMMUTABLE/);
  assert.match(await probe(null, (x) => sqlErr(x, "UPDATE booking.external_operations SET settled_evidence_id = NULL WHERE id = $1", [op.id])), /SETTLED_EVIDENCE_IMMUTABLE/);
  const u = await ownerSucceededUnlinked();
  assert.equal((await linkRecordingEvidence(db.app, u.opId, { evidenceId: await evAt(u.c, obs(u.c, u.id), F.at(9 + 14)) })).error, "RECORDING_PROOF_REFUSED", "< 15 min");
  await db.reconciler.query("SELECT booking.admin_record_evidence($1,'hostaway_offline_charges',$2,'listed',$3,$4::timestamptz,'owner','dash') AS id",
    [u.c.id, String(u.c.reservationId), cnt([cid()]), new Date(F.at(35))]);
  assert.equal((await linkRecordingEvidence(db.app, u.opId, { evidenceId: await evAt(u.c, obs(u.c, u.id), F.at(40)) })).error, "RECORDING_EVIDENCE_CONFLICT");
  const v = await ownerSucceededUnlinked();
  F.ok(await openRecordingVisibilityHold(db.app, v.opId, { reason: "SUCCEEDED_UNPROVEN", by: "m" }));
  assert.equal((await linkRecordingEvidence(db.app, v.opId, { evidenceId: await evAt(v.c, obs(v.c, v.id), F.at(40)) })).error, "RECORDING_HOLD_ACTIVE");
});

test("C-11b (addendum C): the private predicate — anchor / binding / worker / config / evidence steps, each NULL-safe, via rolled-back probes", async () => {
  const { c, op, t } = await claimed(); const id = cid();
  const ev = await evAt(c, obs(c, id), t + 5);
  const other = await claimed();
  const [oau] = await audits(other.op.id);
  const foreignEv = await evAt(other.c, obs(other.c, id), other.t + 5);
  const nonRecording = (await db.owner.query("SELECT identity_read_op AS id FROM booking.recording_assessments WHERE operation_id = $1", [op.id])).rows[0].id;
  const P = (setup, a = [op.id, ev, "w1"]) => probe(setup, (x) => pred(x, ...a));
  assert.equal(await P(null), null, "bound (worker mode)");
  assert.equal(await P(null, [op.id, ev, null]), null, "bound (owner mode)");
  assert.equal(await P(null, [op.id, ev, "w2"]), "CLAIM_WORKER");
  assert.equal(await P(null, [null, ev, "w1"]), "BINDING_INPUT");
  assert.equal(await P(null, [op.id, null, "w1"]), "BINDING_INPUT");
  assert.equal(await P(null, [nonRecording, ev, "w1"]), "NOT_A_RECORDING");
  assert.equal(await P(null, ["00000000-0000-4000-8000-00000000ee02", ev, "w1"]), "NOT_A_RECORDING");
  assert.equal(await P(null, [op.id, foreignEv, "w1"]), "EVIDENCE_BINDING");
  assert.equal(await P(null, [op.id, "00000000-0000-4000-8000-00000000ee03", "w1"]), "EVIDENCE_BINDING");
  const inh = await inheritedInFlight();
  assert.equal(await P(null, [inh.opId, ev, "w1"]), "NO_CLAIM_AUDIT");
  const A = "UPDATE booking.recording_assessments SET ";
  const CA = "UPDATE booking.recording_claim_assessments SET ";
  const W = " WHERE operation_id = $1";
  const run = (sql, p = [op.id]) => async (x) => { await x.query(sql, p); };
  const binding = [
    ["assessment missing", run("DELETE FROM booking.recording_assessments" + W)],
    ["anchor = another recording's assessment", async (x) => { await x.query("DELETE FROM booking.recording_claim_assessments WHERE operation_id = $1", [other.op.id]);
      await x.query(CA + "assessment_id = $2" + W, [op.id, oau.assessment_id]); }],
    ["anchor = another recording's assessment of the SAME intent (only operation_id differs)", async (x) => {
      await x.query("DELETE FROM booking.recording_claim_assessments WHERE operation_id = $1", [other.op.id]);
      await x.query("UPDATE booking.recording_assessments SET intent_id = $2 WHERE id = $1", [oau.assessment_id, c.id]);
      await x.query(CA + "assessment_id = $2" + W, [op.id, oau.assessment_id]); }],
    ["audit intent", run(CA + "intent_id = $2" + W, [op.id, other.c.id])],
    ["assessment intent", run(A + "intent_id = $2" + W, [op.id, other.c.id])],
    ["phase release_review", run(A + "phase = 'release_review', hold_id = gen_random_uuid()" + W)],
    ["outcome not eligible", run(A + "outcome = 'conflict_marker', code = 'PRIOR_RECORDING_MARKER_PRESENT'" + W)],
    ["assessment epoch <> audit epoch", run(A + "epoch = 1" + W)],
    ["audit epoch <> current epoch (both 1)", async (x) => { await x.query(A + "epoch = 1" + W, [op.id]); await x.query(CA + "epoch = 1" + W, [op.id]); }],
    ["assessment worker <> audit worker", run(A + "worker = 'w9'" + W)],
    ["audit worker <> assessment worker", run(CA + "worker = 'w9'" + W)],
  ];
  for (const [name, setup] of binding) {
    assert.equal(await P(setup), "CLAIM_AUDIT_BINDING", `${name} (worker mode)`);
    assert.equal(await P(setup, [op.id, ev, null]), "CLAIM_AUDIT_BINDING", `${name} (owner mode: not exempt)`);
  }
  const cfg = [
    ["cfg.accountRef number", `cfg = jsonb_set(cfg, '{accountRef}', '7')`],
    ["cfg.accountRef missing", `cfg = cfg - 'accountRef'`],
    ["cfg.accountRef <> account_ref", `cfg = jsonb_set(cfg, '{accountRef}', '"acct-test-2"')`],
    ["account_ref <> cfg.accountRef", `account_ref = 'acct-test-2'`],
    ["cfg.paymentMethod number", `cfg = jsonb_set(cfg, '{paymentMethod}', '5')`],
    ["cfg.paymentMethod null", `cfg = jsonb_set(cfg, '{paymentMethod}', 'null')`],
    ["cfg.paymentMethod missing", `cfg = cfg - 'paymentMethod'`],
    ["cfg.paymentMethod unapproved", `cfg = jsonb_set(cfg, '{paymentMethod}', '"cash"')`],
  ];
  for (const [name, set] of cfg) assert.equal(await P(run(A + set + W)), "CLAIM_CONFIG_INVALID", name);
  // evidence field typing (the persisted proof row itself, TEST SETUP inside the probe)
  const E = (set) => run(`UPDATE booking.provider_evidence SET ${set} WHERE id = $1`, [ev]);
  for (const [name, set, step] of [["executorAccountRef missing", "observed = observed - 'executorAccountRef'", "EXECUTOR_ACCOUNT_MISMATCH"],
    ["executorAccountRef number", "observed = jsonb_set(observed, '{executorAccountRef}', '7')", "EXECUTOR_ACCOUNT_MISMATCH"],
    ["paymentMethod missing", "observed = observed - 'paymentMethod'", "PAYMENT_METHOD_MISMATCH"],
    ["paymentMethod number", "observed = jsonb_set(observed, '{paymentMethod}', '5')", "PAYMENT_METHOD_MISMATCH"]]) {
    assert.equal(await P(E(set)), step, name);
  }
  // and the guard surfaces a corrupted anchor on the worker path (not exempt, not a proof refusal)
  const ver = (await facts(db.app, c.id)).version;
  assert.equal(await probe(run(CA + "epoch = 1" + W), (x) => sqlErr(x, "SELECT booking.complete_recording_with_evidence($1, 'w1', $2, $3, $4)", [op.id, ev, id, ver])),
    "RECORDING_CLAIM_BINDING: CLAIM_AUDIT_BINDING");
  // the owner (NULL -> link) path surfaces a corrupted anchor too: only NO_CLAIM_AUDIT is exempt there
  const u = await ownerSucceededUnlinked();
  const uev = await evAt(u.c, obs(u.c, u.id), F.at(40));
  assert.equal(await probe(run(CA + "epoch = 1" + W, [u.opId]), (x) => sqlErr(x, "SELECT booking.link_recording_evidence($1, $2)", [u.opId, uev])),
    "RECORDING_CLAIM_BINDING: CLAIM_AUDIT_BINDING");
  assert.equal(await probe(run(A + "cfg = jsonb_set(cfg, '{paymentMethod}', '\"cash\"')" + W, [u.opId]), (x) => sqlErr(x, "SELECT booking.link_recording_evidence($1, $2)", [u.opId, uev])),
    "RECORDING_CLAIM_BINDING: CLAIM_CONFIG_INVALID");
  F.ok(await complete(c, op.id, ev, id), "every probe rolled back");
  F.ok(await linkRecordingEvidence(db.app, u.opId, { evidenceId: uev }));
});

test("C-12: the predicate is private (app / admin / report denied, PUBLIC revoked); SECURITY DEFINER VOLATILE with a fixed search_path; the guard keeps INVOKER / search_path / ACL / trigger", async () => {
  for (const [pool, who] of [[db.app, "app"], [db.reconciler, "admin"], [report, "report"]]) {
    await assert.rejects(pool.query("SELECT booking.recording_completion_binding_refusal(gen_random_uuid(), gen_random_uuid(), 'w1')"), (e) => e.code === "42501", who);
  }
  const p = (await db.owner.query(`SELECT prosecdef, provolatile, proconfig, proacl::text AS acl FROM pg_proc WHERE oid = 'booking.recording_completion_binding_refusal(uuid,uuid,text)'::regprocedure`)).rows[0];
  assert.deepEqual([p.prosecdef, p.provolatile, p.proconfig], [true, "v", ["search_path=pg_catalog, booking"]]);
  assert.doesNotMatch(p.acl, /(^|[{,])=X|mv_booking|test_/, "no PUBLIC / role EXECUTE");
  const g = (await db.owner.query(`SELECT prosecdef, proconfig FROM pg_proc WHERE oid = 'booking.recording_lifecycle_guard()'::regprocedure`)).rows[0];
  assert.deepEqual([g.prosecdef, g.proconfig], [false, ["search_path=pg_catalog, booking"]]);
  assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'zz0_recording_lifecycle_guard'")).rows[0].n, 1);
});

test("D (addendum D): the 0014 guard is the 0010 body verbatim plus exactly the two marked blocks, after the existing proof acceptance", async () => {
  const src = (await db.owner.query("SELECT prosrc FROM pg_proc WHERE oid = 'booking.recording_lifecycle_guard()'::regprocedure")).rows[0].prosrc;
  const fresh = await startPostgres(); const f13 = new pg.Client({ connectionString: fresh.adminUrl }); await f13.connect();
  try {
    await migrateUp(f13, { env: "test", to: 13 });
    const src13 = (await f13.query("SELECT prosrc FROM pg_proc WHERE oid = 'booking.recording_lifecycle_guard()'::regprocedure")).rows[0].prosrc;
    const lines = src.split("\n"); const kept = []; let k = 0; let skip = false;
    for (const l of lines) {
      if (l.includes("-- 0014 (D5)")) { skip = true; k += 1; }
      if (!skip) kept.push(l);
      if (skip && l.includes("RAISE EXCEPTION 'RECORDING_CLAIM_BINDING: %'")) skip = false;
    }
    assert.equal(k, 2, "two marked blocks");
    assert.equal(kept.join("\n"), src13, "otherwise byte-identical to the 0010 / fresh-13 body");
    const iOwn = src.indexOf("'owner_historical', t);"); const iWrk = src.indexOf("'worker_fresh', NEW.completed_at);");
    const b = [...src.matchAll(/-- 0014 \(D5\)/g)].map((m) => m.index);
    assert.ok(iOwn < b[0] && b[0] < src.indexOf("RETURN NEW;", iOwn) && iWrk < b[1], "each block follows its proof acceptance");
  } finally { await f13.end(); fresh.stop(); }
});

// ---- up / down ------------------------------------------------------------------------------------------------------
test("U-1 (addendum B): up refuses with MIGRATION_0014_PRECONDITION_UNBOUND_LINK when a linked CLAIMED recording carries unbound proof — schema and data untouched; never rewritten / resolved", async () => {
  const d = await startMigratedDatabase(); const o = await adminClient(d);
  try {
    assert.deepEqual(await migrateDown(o, { env: "test", to: 13 }), [15, 14]);   // E7 (0015): mechanical prefix
    const at13 = await objects(o);
    const x = await claimed({ d }); const id = cid();
    assert.deepEqual(await complete(x.c, x.op.id, await evAt(x.c, obs(x.c, id, { paymentMethod: "other" }), x.t + 5, d), id, { d }), { ok: true, state: "succeeded" },
      "schema 13: no binding");
    const h0 = await dataHash(d);
    await assert.rejects(migrateUp(o, { env: "test" }), /MIGRATION_0014_PRECONDITION_UNBOUND_LINK: 1 linked claimed recording/);
    assert.deepEqual([await version(o), await objects(o), await dataHash(d)], [13, at13, h0], "nothing changed");
  } finally { await o.end(); await d.close(); }
});

test("U-2 (addendum B): up keeps MATCHING linked audits, linked historical no-audit rows (any labels) and unlinked claims, and installs exactly a fresh 14", async () => {
  const d = await startMigratedDatabase(); const o = await adminClient(d);
  const fresh = await startPostgres(); const f14 = new pg.Client({ connectionString: fresh.adminUrl }); await f14.connect();
  try {
    assert.deepEqual(await migrateDown(o, { env: "test", to: 13 }), [15, 14]);   // E7 (0015): mechanical prefix
    const m = await claimed({ d }); const mid = cid();
    F.ok(await complete(m.c, m.op.id, await evAt(m.c, obs(m.c, mid), m.t + 5, d), mid, { d }));
    const n = await inheritedInFlight({ d }); const nid = cid();
    F.ok(await complete(n.c, n.opId, await evAt(n.c, obs(n.c, nid, { executorAccountRef: ACCT2, paymentMethod: "other" }), n.t + 5, d), nid, { d }), "no-audit link at 13");
    await claimed({ d });                                                                    // a claimed, still UNLINKED recording: not inspected by up
    const h0 = await dataHash(d);
    assert.deepEqual(await migrateUp(o, { env: "test", to: 14 }), [14]);   // E7 (0015): explicit target 14 (this test measures 0014 itself)
    await migrateUp(f14, { env: "test", to: 14 });
    assert.deepEqual(await objects(o), await objects(f14), "== fresh cluster at 14");
    assert.equal(await dataHash(d), h0, "no link / audit rewritten");
  } finally { await o.end(); await f14.end(); fresh.stop(); await d.close(); }
});

test("U-3 (addendum B): up vs a concurrent unbound completion — up WAITS on its migration-level table lock, then sees the committed link and refuses", async () => {
  const d = await startMigratedDatabase(); const o = await adminClient(d);
  try {
    assert.deepEqual(await migrateDown(o, { env: "test", to: 13 }), [15, 14]);   // E7 (0015): mechanical prefix
    const at13 = await objects(o);
    const x = await claimed({ d }); const id = cid();
    const ev = await evAt(x.c, obs(x.c, id, { executorAccountRef: ACCT2 }), x.t + 5, d);
    const w = await appClient(d);
    try {
      await w.query("BEGIN");
      await w.query("SELECT booking.complete_recording_with_evidence($1, 'w1', $2, $3, $4)", [x.op.id, ev, id, (await facts(d.app, x.c.id)).version]);
      const up = migrateUp(o, { env: "test" }).then(() => "applied", (e) => String(e.message));
      await waitForLockWaiters(d);
      assert.deepEqual((await d.owner.query("SELECT DISTINCT locktype FROM pg_locks WHERE NOT granted")).rows.map((r) => r.locktype), ["relation"]);
      await w.query("COMMIT");
      assert.match(await up, /MIGRATION_0014_PRECONDITION_UNBOUND_LINK/);
    } finally { await w.end(); }
    assert.deepEqual([await version(o), await objects(o)], [13, at13]);
  } finally { await o.end(); await d.close(); }
});

test("D-1 (addendum A): down refuses for each D5-governed state — claimed in_flight, outcome_unknown, escalated (TEST SETUP), owner-resolved succeeded-unlinked, failed_definite with audit, and an unclaimed in_flight row; each refusal changes nothing", async () => {
  const d = await startMigratedDatabase(); const o = await adminClient(d);
  const fresh = await startPostgres(); const f13 = new pg.Client({ connectionString: fresh.adminUrl }); await f13.connect();
  try {
    assert.deepEqual(await migrateDown(o, { env: "test", to: 14 }), [15]);   // E7 (0015): explicit target 14 (this test measures the 0014 gate at 14)
    const at14 = await objects(o);
    const refuses = async (name) => {
      const h0 = await dataHash(d);
      await assert.rejects(migrateDown(o, { env: "test", to: 13 }), /DOWNGRADE_REFUSED_RECORDING_COMPLETION_BINDING/, name);
      assert.deepEqual([await version(o), await objects(o), await dataHash(d)], [14, at14, h0], `${name}: nothing changed`);
    };
    // R1 walks in_flight -> outcome_unknown -> succeeded-unlinked -> linked
    const c1 = await capturedIntent(d); const id1 = cid();
    const op1 = await F.claimHealthyRecording(d.app, { workerId: "w1", now: F.at(9), intentId: c1.id, opTypes: OCH });
    await refuses("claimed in_flight");
    F.ok(await completeOperation(d.app, op1.id, { workerId: "w1", now: F.at(9.2), outcome: { status: "outcome_unknown" } }));
    await refuses("claimed outcome_unknown");
    const ev01 = await F.readEvidence(d.app, c1.id, "hostaway_offline_charges", String(c1.reservationId), "listed", cnt([id1]), 30);
    F.ok(await resolveSucceeded(op1.id, ev01, id1, F.at(60), d));
    await refuses("claimed owner-resolved succeeded-unlinked");
    F.ok(await linkRecordingEvidence(d.app, op1.id, { evidenceId: await evAt(c1, obs(c1, id1), F.at(40), d) }));
    // R2: escalated with audit (TEST SETUP state), then owner-resolved and linked
    const c2 = await capturedIntent(d); const id2 = cid();
    const op2 = await F.claimHealthyRecording(d.app, { workerId: "w1", now: F.at(9), intentId: c2.id, opTypes: OCH });
    await F.ownerManagedHistory(d.owner, "UPDATE booking.external_operations SET state = 'escalated', lease_worker_id = NULL, lease_until = NULL WHERE id = $1", [op2.id]);
    await refuses("claimed escalated");
    const ev02 = await F.readEvidence(d.app, c2.id, "hostaway_offline_charges", String(c2.reservationId), "listed", cnt([id2]), 30);
    F.ok(await resolveSucceeded(op2.id, ev02, id2, F.at(60), d));
    F.ok(await linkRecordingEvidence(d.app, op2.id, { evidenceId: await evAt(c2, obs(c2, id2), F.at(40), d) }));
    // R3: unclaimed in_flight (inherited history), then reported unknown: no longer in flight, no audit -> allowed
    const r3 = await inheritedInFlight({ d });
    await refuses("unclaimed in_flight");
    F.ok(await completeOperation(d.app, r3.opId, { workerId: "w1", now: Date.now(), outcome: { status: "outcome_unknown" } }));
    // allowed: linked audits (R1, R2), a no-audit non-in-flight row (R3) -> exactly a fresh 13; all audit kept; identical re-up
    const auditN = (await d.owner.query("SELECT count(*)::int AS n FROM booking.recording_claim_assessments")).rows[0].n;
    const h0 = await dataHash(d);
    assert.deepEqual(await migrateDown(o, { env: "test", to: 13 }), [14]);
    await migrateUp(f13, { env: "test", to: 13 });
    assert.deepEqual(await objects(o), await objects(f13), "down 0014 == fresh cluster at 13 (guard body / ACL / security / search_path / triggers / all objects)");
    assert.deepEqual([(await d.owner.query("SELECT count(*)::int AS n FROM booking.recording_claim_assessments")).rows[0].n, await dataHash(d)], [auditN, h0], "data kept");
    assert.deepEqual(await migrateUp(o, { env: "test", to: 14 }), [14]);   // E7 (0015): explicit target 14
    assert.deepEqual(await objects(o), at14, "re-up identical");
    // failed_definite WITH audit: refuses (state-agnostic clause; this row is permanent, so it is checked last)
    const c4 = await capturedIntent(d);
    const op4 = await F.claimHealthyRecording(d.app, { workerId: "w1", now: F.at(9), intentId: c4.id, opTypes: OCH });
    F.ok(await completeOperation(d.app, op4.id, { workerId: "w1", now: F.at(9.2), outcome: { status: "outcome_unknown" } }));
    const api = await F.readEvidence(d.app, c4.id, "hostaway_offline_charges", String(c4.reservationId), "listed", cnt([]), 40);
    const dsh = await F.dashboardEvidence(d.reconciler, c4.id, "hostaway_offline_charges", String(c4.reservationId), "listed", cnt([]), 45);
    F.ok(await adminResolveOperation(d.reconciler, { operationId: op4.id, decision: "failed_definite", evidenceIds: [api, dsh], resolver: "owner",
      justification: "NO_CHARGE_IN_HOSTAWAY", at: F.at(60) }));
    assert.equal((await opRow(op4.id, d)).state, "failed_definite");
    await refuses("claimed failed_definite (unlinked)");
  } finally { await o.end(); await f13.end(); fresh.stop(); await d.close(); }
});

test("D-2 (addendum A): down vs a concurrent NEW claim — down WAITS on its migration-level table lock, then sees the committed claim audit and refuses", async () => {
  const d = await startMigratedDatabase(); const o = await adminClient(d);
  try {
    assert.deepEqual(await migrateDown(o, { env: "test", to: 14 }), [15]);   // E7 (0015): explicit target 14 (this test measures the 0014 gate at 14)
    const at14 = await objects(o);
    const c = await capturedIntent(d);
    const opId = await F.initialRecordingId(d.app, c.id);
    await d.app.query("UPDATE booking.intent_work SET work_worker_id = 'w1', work_lease_until = $2 WHERE intent_id = $1", [c.id, new Date(Date.now() + 10 * MIN)]);
    F.ok((await F.preflight(d.app, c.id, opId, { workerId: "w1" })).r);
    const w = await appClient(d);
    try {
      await w.query("BEGIN");
      await w.query(`UPDATE booking.external_operations SET state = 'in_flight', lease_worker_id = 'w1', lease_until = now() + interval '5 minutes',
        attempts = attempts + 1, dispatched_at = now(), updated_at = now() WHERE id = $1`, [opId]);
      const down = migrateDown(o, { env: "test", to: 13 }).then((v) => JSON.stringify(v), (e) => String(e.message));
      await waitForLockWaiters(d);
      await w.query("COMMIT");
      assert.match(await down, /DOWNGRADE_REFUSED_RECORDING_COMPLETION_BINDING/);
    } finally { await w.end(); }
    assert.equal((await audits(opId, d)).length, 1, "the claim committed with its audit");
    assert.deepEqual([await version(o), await objects(o)], [14, at14]);
  } finally { await o.end(); await d.close(); }
});
