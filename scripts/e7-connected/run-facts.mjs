// scripts/e7-connected/run-facts.mjs — E7 connected-test runner SLICE C: persisted-facts reader + pure recovery-candidate derivation.
// Contract: claude/e7-connected-runner-contract.md §2.3, §4, §5. OFFLINE foundation over a CALLER-SUPPLIED client:
//   * this module never connects / ends a pool, never releases or destroys a client, never unlocks, never calls a worker or provider;
//   * READ-ONLY statements only, every one parameterized by the canonical intent id and observed through the accepted run-guard
//     (`guard.observe`) with absolute deadlines (per statement and a whole-snapshot cap). No timer, env, fs, fetch or SDK of its own;
//   * after ANY rejected / timed-out / unobservable statement or COMMIT, NO further statement (no ROLLBACK, no count refresh) is issued;
//     the result says the caller's client must be destroyed. A timeout does NOT cancel the server-side statement or COMMIT.
// Facts are explicit selected fields, copied and frozen; no guest / contact data and no raw provider body is ever selected by the
// report-role snapshot. The separate guest read is one app-role statement and its values live only in the returned object.
// A frozen snapshot is a basis, NEVER a fence: accepted workers may commit new facts concurrently after it (contract §4).
import { createLifecycle, LIMITS } from "./run-guard.mjs";
import { PROTECTED_HOSTAWAY_RESERVATION_IDS } from "../../lib/checkout/compensation-proof.js";

export const RUN_FACTS_VERSION = "e7-run-facts-v1";
/** hard row caps (each query uses LIMIT cap+1; more than cap rows → FACT_LIMIT_EXCEEDED, never a silent truncation) */
export const FACT_CAPS = Object.freeze({ operations: 200, reservationAttempts: 1, reservationEvidence: 200, cases: 32, transitions: 200 });
export const PAYLOAD_KEYS = Object.freeze(["amountMinor", "attempt", "currency", "expiresAt", "listingId", "paymentAttemptId", "paymentIntentId",
  "providerIdempotencyKey", "ref", "reissueDepth", "reissueOf", "reservationId", "sessionId", "template"]);
export const RESERVATION_PHASE_STATES = Object.freeze(["payment_authorized", "reservation_pending", "reservation_unknown"]);
export const OP_TYPES = Object.freeze({ CREATE: "hostaway.create_reservation", LOOKUP: "hostaway.lookup_reservation", RETRIEVE: "hostaway.retrieve_reservation" });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RES_ID_RE = /^[1-9][0-9]{0,18}$/;
const REF_RE = /^MV-[A-Z0-9]{6,10}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const freeze = Object.freeze;
const getDesc = Object.getOwnPropertyDescriptor;
const getProto = Object.getPrototypeOf;
const DATE_PROTO = Date.prototype;
const dateTime = Date.prototype.getTime;
const apply = Reflect.apply;
const PROTECTED = new Set(PROTECTED_HOSTAWAY_RESERVATION_IDS);

// ---- SQL (read-only, intent-scoped, explicit fields, deterministic order, LIMIT cap+1) ------------------------------------------
const P = PAYLOAD_KEYS.map((k) => `o.payload -> '${k}' AS "p_${k}"`).join(", ");
export const SQL = freeze({
  BEGIN: "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  MARKER: `SELECT environment, created_at,
      pg_has_role(current_user, 'mv_booking_report', 'MEMBER') AS is_report,
      pg_has_role(current_user, 'mv_booking_app', 'MEMBER') AS is_app,
      (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS privileged
    FROM booking.instance`,
  INTENT: `SELECT id, ref, environment, state, version, listing_id, from_date::text AS from_date, to_date::text AS to_date, guests,
      currency, final_total_minor::text AS final_total_minor, rate_bps, policy_version, stripe_payment_intent_id,
      authorized_minor::text AS authorized_minor, captured_minor::text AS captured_minor, hostaway_reservation_id, reservation_confirmed_at,
      dispatch_at, dispatch_attempt, offline_charge_id, reservation_attempts, reason_code, updated_at
    FROM booking.intents WHERE id = $1`,
  WORK: "SELECT next_action_at, work_worker_id, work_lease_until FROM booking.intent_work WHERE intent_id = $1",
  OPERATIONS: `SELECT o.id, o.intent_id, o.op_type, o.idempotency_key, o.retry_class, o.state, o.source_version, o.attempts, o.max_attempts,
      o.requires_provider_read, o.lease_worker_id, o.lease_until, o.next_attempt_at, o.dispatched_at, o.completed_at, o.result_ref, o.error_code,
      o.late_result_status, o.late_result_ref, o.settled_evidence_id, o.created_at, ${P},
      (SELECT count(*)::int FROM jsonb_object_keys(o.payload) k WHERE k <> ALL($2::text[])) AS payload_unlisted
    FROM booking.external_operations o WHERE o.intent_id = $1 ORDER BY o.created_at, o.id LIMIT ${FACT_CAPS.operations + 1}`,
  ATTEMPTS: `SELECT id, operation_id, booking_ref, state, dispatched_at, responded_at, http_status, refusal_code, hostaway_reservation_id,
      lookup_count, last_lookup_result
    FROM booking.hostaway_reservation_attempts WHERE intent_id = $1 ORDER BY dispatched_at, id LIMIT ${FACT_CAPS.reservationAttempts + 1}`,
  EVIDENCE: `SELECT e.id, e.intent_id, e.kind, e.source, e.external_ref, e.status, e.observed_at, e.read_operation_id,
      r.intent_id AS read_intent_id, r.op_type AS read_op_type, r.payload ->> 'ref' AS sel_ref, r.payload ->> 'reservationId' AS sel_reservation_id,
      e.observed -> 'bookingRef' AS o_booking_ref, e.observed -> 'matchCount' AS o_match_count, e.observed -> 'reservationId' AS o_reservation_id,
      e.observed -> 'listingId' AS o_listing_id, e.observed -> 'from' AS o_from, e.observed -> 'to' AS o_to,
      e.observed -> 'totalMinor' AS o_total_minor, e.observed -> 'currency' AS o_currency
    FROM booking.provider_evidence e LEFT JOIN booking.external_operations r ON r.id = e.read_operation_id
    WHERE e.intent_id = $1 AND e.kind = 'hostaway_reservation' ORDER BY e.observed_at, e.id LIMIT ${FACT_CAPS.reservationEvidence + 1}`,
  CASES: `SELECT id, kind, status, opened_at, opened_by, resolution, resolved_at FROM booking.reconciliation_cases
    WHERE intent_id = $1 ORDER BY opened_at, id LIMIT ${FACT_CAPS.cases + 1}`,
  TRANSITIONS: `SELECT version_after, from_state, to_state, event_type, reason_code, actor, at FROM booking.intent_transitions
    WHERE intent_id = $1 ORDER BY version_after LIMIT ${FACT_CAPS.transitions + 1}`,
  COMMIT: "COMMIT",
  GUEST: `SELECT g.first_name, g.last_name, g.email,
      pg_has_role(current_user, 'mv_booking_app', 'MEMBER') AS is_app,
      pg_has_role(current_user, 'mv_booking_report', 'MEMBER') AS is_report,
      (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS privileged
    FROM (SELECT 1) one LEFT JOIN booking.intent_guests g ON g.intent_id = $1`
});

// ---- value codecs (throw MalformedFact on anything unexpected; never default) -----------------------------------------------------
class MalformedFact extends Error { constructor() { super("FACT_MALFORMED"); } }
const bad = () => { throw new MalformedFact(); };
const ms = (v, nullable = true) => {
  if (v === null && nullable) return null;
  if (v === null || typeof v !== "object" || getProto(v) !== DATE_PROTO) bad();
  const t = apply(dateTime, v, []); return Number.isFinite(t) ? t : bad();
};
const text = (v, nullable = true, max = 500) => (v === null && nullable ? null : typeof v === "string" && v.length >= 1 && v.length <= max ? v : bad());
const int = (v, nullable = true) => {
  if (v === null && nullable) return null;
  if (typeof v === "number" && Number.isSafeInteger(v)) return v;
  if (typeof v === "string" && /^-?\d{1,16}$/.test(v) && Number.isSafeInteger(Number(v))) return Number(v);
  return bad();
};
const bool = (v) => (typeof v === "boolean" ? v : bad());
const uuid = (v, nullable = false) => (v === null && nullable ? null : typeof v === "string" && UUID_RE.test(v) ? v : bad());
/** a jsonb sub-value as parsed by the driver: only primitives (or null) are kept; objects / arrays → malformed (no raw dumps) */
const scalar = (v) => (v === null || v === undefined ? null : ["string", "number", "boolean"].includes(typeof v) ? v : bad());
const rowsOf = (res) => {
  const d = res !== null && typeof res === "object" ? getDesc(res, "rows") : undefined;
  return d && "value" in d && Array.isArray(d.value) ? d.value : null;
};

// ---- guarded statement execution ----------------------------------------------------------------------------------------------------
/** validate the caller-supplied dependencies; the guard must be one created by the accepted createGuard (checked through the accepted
 *  createLifecycle provenance check — a throwaway lifecycle, no side effects) */
function deps(input) {
  if (input === null || typeof input !== "object") return null;
  const { client, intentId, guard, deadline } = input;
  if (typeof intentId !== "string" || !UUID_RE.test(intentId) || typeof deadline !== "number" || !Number.isFinite(deadline)) return null;
  try { createLifecycle({ guard }); } catch { return null; }
  if (client === null || typeof client !== "object") return null;
  const query = client.query;
  if (typeof query !== "function") return null;
  return { client, query, intentId, guard, deadline };
}
const failure = (code, failureKind, clientDisposition, statementsIssued, extra = {}) =>
  freeze({ ok: false, code, failure: failureKind, clientDisposition, statementsIssued, ...extra });

/** run ONE statement through guard.observe → { ok:true, rows } | { ok:false, result } (the result already says what the caller owns) */
async function run(ctx, sql, params) {
  const now = ctx.guard.now();
  if (!now.ok) return { ok: false, result: ctx.issued === 0 ? failure(now.code, "not_started", "unused", 0) : failure(now.code, "db", "destroy", ctx.issued) };
  const d = Math.min(now.value + LIMITS.STATEMENT_MS, ctx.deadline);
  const r = await ctx.guard.observe(d, () => apply(ctx.query, ctx.client, [sql, params]));
  if (r.kind === "not_started") {
    if (ctx.issued === 0) return { ok: false, result: failure(r.code === "EXPIRED_BEFORE_START" ? "SNAPSHOT_BUDGET_EXHAUSTED" : r.code, "not_started", "unused", 0) };
    // mid-sequence: an open transaction can no longer be closed inside the bound → the caller must destroy the client
    return { ok: false, result: failure(r.code === "EXPIRED_BEFORE_START" ? "TIMEOUT_DB_READ" : r.code, "db", "destroy", ctx.issued) };
  }
  ctx.issued += 1;
  if (r.kind === "timeout") return { ok: false, result: failure("TIMEOUT_DB_READ", "db", "destroy", ctx.issued) };
  if (r.kind === "rejected") return { ok: false, result: failure("DB_FAILURE", "db", "destroy", ctx.issued) };
  if (r.kind === "observation_failed") return { ok: false, result: failure(r.code, "db", "destroy", ctx.issued) };
  const rows = rowsOf(r.value);
  if (!rows) return { ok: false, result: failure("DB_RESULT_INVALID", "db", "destroy", ctx.issued) };
  return { ok: true, rows };
}

// ---- row mappers ----------------------------------------------------------------------------------------------------------------------
function mapIntent(r, intentId) {
  if (r.id !== intentId) bad();
  return freeze({ id: uuid(r.id), ref: REF_RE.test(r.ref) ? r.ref : bad(), environment: text(r.environment, false), state: text(r.state, false, 40),
    version: int(r.version, false), listingId: int(r.listing_id, false), from: DATE_RE.test(r.from_date) ? r.from_date : bad(),
    to: DATE_RE.test(r.to_date) ? r.to_date : bad(), guests: int(r.guests, false), currency: text(r.currency, true, 3),
    finalTotalMinor: int(r.final_total_minor), rateBps: int(r.rate_bps), policyVersion: text(r.policy_version),
    stripePaymentIntentId: text(r.stripe_payment_intent_id, true, 200), authorizedMinor: int(r.authorized_minor), capturedMinor: int(r.captured_minor, false),
    hostawayReservationId: text(r.hostaway_reservation_id, true, 200), reservationConfirmedAt: ms(r.reservation_confirmed_at),
    dispatchAt: ms(r.dispatch_at), dispatchAttempt: int(r.dispatch_attempt), offlineChargeId: text(r.offline_charge_id, true, 200),
    reservationAttempts: int(r.reservation_attempts, false), reasonCode: text(r.reason_code, true, 64), updatedAt: ms(r.updated_at, false) });
}
function mapOperation(r, intentId) {
  if (r.intent_id !== intentId) bad();
  const payload = {};
  for (const k of PAYLOAD_KEYS) { const v = scalar(r[`p_${k}`]); if (v !== null) payload[k] = v; }
  return freeze({ id: uuid(r.id), opType: text(r.op_type, false, 80), idempotencyKey: text(r.idempotency_key, false, 200), retryClass: text(r.retry_class, false, 20),
    state: text(r.state, false, 20), sourceVersion: int(r.source_version, false), attempts: int(r.attempts, false), maxAttempts: int(r.max_attempts, false),
    requiresProviderRead: bool(r.requires_provider_read), leaseWorkerId: text(r.lease_worker_id, true, 200), leaseUntil: ms(r.lease_until),
    nextAttemptAt: ms(r.next_attempt_at, false), dispatchedAt: ms(r.dispatched_at), completedAt: ms(r.completed_at), resultRef: text(r.result_ref, true, 200),
    errorCode: text(r.error_code, true, 64), lateResultStatus: text(r.late_result_status, true, 20), lateResultRef: text(r.late_result_ref, true, 200),
    settledEvidenceId: uuid(r.settled_evidence_id, true), createdAt: ms(r.created_at, false), payload: freeze(payload),
    payloadUnlistedKeys: int(r.payload_unlisted, false) });
}
const mapAttempt = (r) => freeze({ id: uuid(r.id), operationId: uuid(r.operation_id), bookingRef: text(r.booking_ref, false, 40), state: text(r.state, false, 20),
  dispatchedAt: ms(r.dispatched_at, false), respondedAt: ms(r.responded_at), httpStatus: int(r.http_status), refusalCode: text(r.refusal_code, true, 64),
  hostawayReservationId: text(r.hostaway_reservation_id, true, 200), lookupCount: int(r.lookup_count, false), lastLookupResult: text(r.last_lookup_result, true, 20) });
function mapEvidence(r, intentId) {
  if (r.intent_id !== intentId) bad();
  return freeze({ id: uuid(r.id), kind: text(r.kind, false, 40), source: text(r.source, false, 40), externalRef: text(r.external_ref, false, 200),
    status: text(r.status, false, 40), observedAt: ms(r.observed_at, false), readOperationId: uuid(r.read_operation_id, true),
    readIntentId: uuid(r.read_intent_id, true), readOpType: text(r.read_op_type, true, 80),
    selector: freeze({ ref: text(r.sel_ref, true, 40), reservationId: text(r.sel_reservation_id, true, 200) }),
    observed: freeze({ bookingRef: scalar(r.o_booking_ref), matchCount: scalar(r.o_match_count), reservationId: scalar(r.o_reservation_id),
      listingId: scalar(r.o_listing_id), from: scalar(r.o_from), to: scalar(r.o_to), totalMinor: scalar(r.o_total_minor), currency: scalar(r.o_currency) }) });
}
const mapCase = (r) => freeze({ id: uuid(r.id), kind: text(r.kind, false, 64), status: text(r.status, false, 20), openedAt: ms(r.opened_at, false),
  openedBy: text(r.opened_by, false, 200), resolution: text(r.resolution, true, 20), resolvedAt: ms(r.resolved_at) });
const mapTransition = (r) => freeze({ versionAfter: int(r.version_after, false), fromState: text(r.from_state, true, 40), toState: text(r.to_state, false, 40),
  eventType: text(r.event_type, false, 64), reasonCode: text(r.reason_code, true, 64), actor: text(r.actor, false, 20), at: ms(r.at, false) });

// ---- public API -----------------------------------------------------------------------------------------------------------------------
/**
 * readRunSnapshot({ client, intentId, guard, deadline }) → Promise<frozen Snapshot>
 *   client   a CALLER-OWNED connected mv_booking_report client ({ query(text, params) → native promise }); never released / destroyed here
 *   intentId canonical lowercase uuid
 *   guard    an accepted run-guard guard (createGuard)
 *   deadline absolute monotonic cap for the WHOLE snapshot (caller: now + LIMITS.SNAPSHOT_MS); each statement also ≤ now + STATEMENT_MS
 * → { ok:true, facts, statementsIssued }                                            acknowledged COMMIT; client healthy
 * | { ok:false, code, failure:'refusal', clientDisposition:'healthy', statementsIssued }    acknowledged facts refused (COMMIT acknowledged)
 * | { ok:false, code, failure:'db', clientDisposition:'destroy', statementsIssued, refusal? }  rejected / timed-out / unobservable statement
 *       or COMMIT: NO further statement was issued; the caller must destroy this client (the server may still finish the statement)
 * | { ok:false, code, failure:'not_started', clientDisposition:'unused', statementsIssued:0 }   nothing was sent
 * | { ok:false, code:'FACTS_ARGUMENT_INVALID', failure:'not_started', clientDisposition:'unused', statementsIssued:0 }
 */
export async function readRunSnapshot(input) {
  const c = deps(input);
  if (!c) return failure("FACTS_ARGUMENT_INVALID", "not_started", "unused", 0);
  const ctx = { ...c, issued: 0 };
  const id = c.intentId;
  let r = await run(ctx, SQL.BEGIN, []);
  if (!r.ok) return r.result;
  let refusal = null;
  const facts = { version: RUN_FACTS_VERSION, intentId: id };
  const steps = [
    ["marker", SQL.MARKER, [], (rows) => {
      if (rows.length !== 1) return "MARKER_INVALID";
      const m = rows[0];
      if (m.privileged !== false || m.is_report !== true || m.is_app !== false) return "ROLE_NOT_REPORT";
      if (m.environment !== "test") return "DATABASE_NOT_TEST";
      facts.marker = freeze({ environment: "test", createdAt: ms(m.created_at, false) });
      return null;
    }],
    ["intent", SQL.INTENT, [id], (rows) => {
      if (rows.length === 0) return "INTENT_NOT_FOUND";
      if (rows.length !== 1) return "FACT_MALFORMED";
      facts.intent = mapIntent(rows[0], id);
      if (facts.intent.environment !== "test") return "INTENT_NOT_TEST";
      return null;
    }],
    ["work", SQL.WORK, [id], (rows) => {
      if (rows.length > 1) return "FACT_MALFORMED";
      facts.work = rows.length ? freeze({ nextActionAt: ms(rows[0].next_action_at), workerId: text(rows[0].work_worker_id, true, 200), leaseUntil: ms(rows[0].work_lease_until) }) : null;
      return null;
    }],
    ["operations", SQL.OPERATIONS, [id, [...PAYLOAD_KEYS]], (rows) => {
      if (rows.length > FACT_CAPS.operations) return "FACT_LIMIT_EXCEEDED";
      facts.operations = freeze(rows.map((x) => mapOperation(x, id)));
      return null;
    }],
    ["attempts", SQL.ATTEMPTS, [id], (rows) => {
      if (rows.length > FACT_CAPS.reservationAttempts) return "FACT_LIMIT_EXCEEDED";
      facts.reservationAttempts = freeze(rows.map(mapAttempt));
      return null;
    }],
    ["evidence", SQL.EVIDENCE, [id], (rows) => {
      if (rows.length > FACT_CAPS.reservationEvidence) return "FACT_LIMIT_EXCEEDED";
      facts.reservationEvidence = freeze(rows.map((x) => mapEvidence(x, id)));
      return null;
    }],
    ["cases", SQL.CASES, [id], (rows) => {
      if (rows.length > FACT_CAPS.cases) return "FACT_LIMIT_EXCEEDED";
      facts.cases = freeze(rows.map(mapCase));
      return null;
    }],
    ["transitions", SQL.TRANSITIONS, [id], (rows) => {
      if (rows.length > FACT_CAPS.transitions) return "FACT_LIMIT_EXCEEDED";
      facts.transitions = freeze(rows.map(mapTransition));
      return null;
    }]
  ];
  for (const [, sql, params, accept] of steps) {
    r = await run(ctx, sql, params);
    if (!r.ok) return r.result;
    try { refusal = accept(r.rows); } catch { refusal = "FACT_MALFORMED"; }   // any mapping fault is a malformed fact, never a default
    if (refusal) break;                                  // stop reading; close the read-only transaction normally below
  }
  r = await run(ctx, SQL.COMMIT, []);
  if (!r.ok) return refusal ? freeze({ ...r.result, refusal }) : r.result;
  if (refusal) return failure(refusal, "refusal", "healthy", ctx.issued);
  facts.limits = FACT_CAPS;
  return freeze({ ok: true, facts: freeze(facts), statementsIssued: ctx.issued });
}

/**
 * readGuestBinding({ client, intentId, guard, deadline }) → Promise<frozen GuestResult>   (ONE app-role statement; no transaction)
 * → { ok:true, guest:{ firstName, lastName, email }, statementsIssued:1 }   values in memory only; never journaled or logged
 * | { ok:false, code:'GUEST_NOT_FOUND' | 'ROLE_NOT_APP' | 'FACT_MALFORMED', failure:'refusal', clientDisposition:'healthy', statementsIssued:1 }
 * | db / not_started failures exactly as readRunSnapshot. A report login cannot read the table at all (permission denied → db failure).
 */
export async function readGuestBinding(input) {
  const c = deps(input);
  if (!c) return failure("FACTS_ARGUMENT_INVALID", "not_started", "unused", 0);
  const ctx = { ...c, issued: 0 };
  const r = await run(ctx, SQL.GUEST, [c.intentId]);
  if (!r.ok) return r.result;
  if (r.rows.length !== 1) return failure("FACT_MALFORMED", "refusal", "healthy", 1);
  const g = r.rows[0];
  if (g.privileged !== false || g.is_app !== true || g.is_report !== false) return failure("ROLE_NOT_APP", "refusal", "healthy", 1);
  if (g.first_name === null && g.last_name === null && g.email === null) return failure("GUEST_NOT_FOUND", "refusal", "healthy", 1);
  try {
    return freeze({ ok: true, guest: freeze({ firstName: text(g.first_name, false, 100), lastName: text(g.last_name, false, 100), email: text(g.email, false, 254) }), statementsIssued: 1 });
  } catch { return failure("FACT_MALFORMED", "refusal", "healthy", 1); }
}

// ---- pure candidate derivation (contract §5.1) ---------------------------------------------------------------------------------------
const isProtected = (v) => v !== null && v !== undefined && PROTECTED.has(String(v));
const refuse = (code) => freeze({ ok: false, code });

/**
 * deriveRecoveryCandidate(facts) → frozen { ok:true, id, sources:['a'|'b'|'c'…], adopted:string|null } | frozen { ok:false, code }
 * PURE and read-only: it never builds a factory, starts an operation or touches the DB. `facts` is a readRunSnapshot().facts object
 * (or a synthetic object of the same shape, for unit tests). Refusal codes (first match wins):
 *   FACT_MALFORMED, FACTS_INCONSISTENT, PROTECTED_REFERENCE, NOT_RESERVATION_PHASE, EVIDENCE_IDENTITY_MISMATCH, DUPLICATE_BOOKING_REF,
 *   CANDIDATE_CONFLICT, RESERVATION_ID_CONFLICT, OPEN_READ_CONFLICT, KNOWN_ID_WITHOUT_CANDIDATE, CANDIDATE_BEFORE_CREATE, NO_CANDIDATE
 */
export function deriveRecoveryCandidate(facts) {
  let f;
  try { f = collect(facts); } catch (e) { return refuse(e && e.message === "FACTS_INCONSISTENT" ? "FACTS_INCONSISTENT" : "FACT_MALFORMED"); }
  if (f.protectedSeen) return refuse("PROTECTED_REFERENCE");
  if (!RESERVATION_PHASE_STATES.includes(f.intent.state)) return refuse("NOT_RESERVATION_PHASE");
  if (f.identityMismatch) return refuse("EVIDENCE_IDENTITY_MISMATCH");
  if (f.duplicateRef) return refuse("DUPLICATE_BOOKING_REF");
  const ids = [...new Set(f.candidates.map((x) => x[1]))];
  if (ids.length > 1) return refuse("CANDIDATE_CONFLICT");
  if (ids.length === 0) return refuse(f.known.size > 0 || f.selectors.length > 0 ? "KNOWN_ID_WITHOUT_CANDIDATE" : "NO_CANDIDATE");
  const id = ids[0];
  if ([...f.known].some((k) => k !== id)) return refuse("RESERVATION_ID_CONFLICT");
  for (const s of f.selectors) {
    if (s.id !== id) return refuse(s.open ? "OPEN_READ_CONFLICT" : "RESERVATION_ID_CONFLICT");
  }
  if (f.pendingCreate) return refuse("CANDIDATE_BEFORE_CREATE");
  return freeze({ ok: true, id, sources: freeze([...new Set(f.candidates.map((x) => x[0]))].sort()), adopted: f.intent.hostawayReservationId ?? null });
}

const inconsistent = () => { throw new Error("FACTS_INCONSISTENT"); };
const canonId = (v) => (v === null || v === undefined ? null : typeof v === "string" && RES_ID_RE.test(v) ? v : typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? String(v) : bad());
const arr = (v) => (Array.isArray(v) ? v : bad());

function collect(facts) {
  if (facts === null || typeof facts !== "object" || facts.version !== RUN_FACTS_VERSION) bad();
  const intentId = uuid(facts.intentId);
  const intent = facts.intent;
  if (intent === null || typeof intent !== "object" || intent.id !== intentId || typeof intent.ref !== "string" || typeof intent.state !== "string") bad();
  const ops = arr(facts.operations); const attempts = arr(facts.reservationAttempts); const evidence = arr(facts.reservationEvidence);
  const opById = new Map();
  for (const o of ops) { if (!o || typeof o.id !== "string" || typeof o.opType !== "string" || typeof o.state !== "string" || !o.payload) bad(); if (opById.has(o.id)) inconsistent(); opById.set(o.id, o); }
  const out = { intent, candidates: [], known: new Set(), selectors: [], protectedSeen: false, identityMismatch: false, duplicateRef: false, pendingCreate: false };
  const seen = (v) => { if (isProtected(v)) out.protectedSeen = true; };
  seen(intent.hostawayReservationId);
  const adopted = canonId(intent.hostawayReservationId);
  if (adopted) { out.candidates.push(["c", adopted]); out.known.add(adopted); }
  const creates = ops.filter((o) => o.opType === OP_TYPES.CREATE);
  if (creates.length > 1) inconsistent();
  for (const o of ops) { seen(o.resultRef); seen(o.lateResultRef); seen(o.payload.reservationId); }
  for (const o of creates) {
    if (o.state === "pending") out.pendingCreate = true;
    const rr = canonId(o.resultRef); const lr = canonId(o.lateResultRef);
    if (rr) { out.known.add(rr); if (o.state === "succeeded") out.candidates.push(["a", rr]); }
    if (lr) out.known.add(lr);
  }
  if (attempts.length > 1) inconsistent();
  for (const a of attempts) {
    if (!a || typeof a.operationId !== "string") bad();
    seen(a.hostawayReservationId);
    const op = opById.get(a.operationId);
    if (!op || op.opType !== OP_TYPES.CREATE || a.bookingRef !== intent.ref) inconsistent();
    const hid = canonId(a.hostawayReservationId);
    if (hid) out.known.add(hid);
  }
  for (const o of ops) {
    if (o.opType !== OP_TYPES.RETRIEVE) continue;
    const sid = canonId(o.payload.reservationId);
    if (!sid) inconsistent();
    out.selectors.push({ id: sid, open: o.state === "pending" || o.state === "in_flight" });
  }
  for (const e of evidence) {
    if (!e || !e.observed || !e.selector) bad();
    seen(e.externalRef); seen(e.observed.reservationId); seen(e.selector.reservationId);
    if (e.kind !== "hostaway_reservation") inconsistent();
    if (e.source !== "hostaway_api") continue;                        // attested dashboard evidence is never a candidate source
    const op = e.readOperationId ? opById.get(e.readOperationId) : null;
    if (!op || e.readIntentId !== intentId || op.opType !== e.readOpType || ![OP_TYPES.LOOKUP, OP_TYPES.RETRIEVE].includes(op.opType)) inconsistent();
    if (e.status !== "found_active") continue;
    const ext = canonId(e.externalRef);
    const obsId = canonId(e.observed.reservationId);
    if (obsId && obsId !== ext) { out.identityMismatch = true; continue; }
    out.known.add(ext);
    if (op.opType === OP_TYPES.RETRIEVE) {
      if (e.selector.reservationId !== ext) out.identityMismatch = true;      // a by-id read returned another id
      continue;
    }
    // by-REF lookup evidence: selector must be this intent's ref; observed identity must match the intent
    if (e.selector.ref !== intent.ref) inconsistent();
    if (e.observed.bookingRef !== intent.ref) { out.identityMismatch = true; continue; }
    const mc = e.observed.matchCount;
    if (Number.isInteger(mc) && mc > 1) { out.duplicateRef = true; continue; }
    if (mc !== 1) continue;
    const o = e.observed;
    const checks = [[o.listingId, (v) => v === intent.listingId], [o.from, (v) => v === intent.from], [o.to, (v) => v === intent.to],
      [o.totalMinor, (v) => v === intent.finalTotalMinor], [o.currency, (v) => typeof v === "string" && v.toUpperCase() === intent.currency]];
    let missing = false; let mismatch = false;
    for (const [v, ok] of checks) { if (v === null || v === undefined || v === "") missing = true; else if (!ok(v)) mismatch = true; }
    if (mismatch) { out.identityMismatch = true; continue; }
    if (!missing) out.candidates.push(["b", ext]);
  }
  return out;
}
