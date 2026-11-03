// lib/booking-db/reservation-worker.js — Stage E7.2 (offline). Bounded RESERVATION-PHASE orchestrator step.
//
// INTERNAL LIBRARY ONLY: no route, cron, frontend, SDK client, network adapter or default provider function. Every
// provider call goes through an INJECTED executor; with none injected (the default) nothing is claimed and nothing is sent.
//
// Scope: payment_authorized -> reservation_pending -> (reservation_confirmed | reservation_failed | reservation_unknown |
// reconciliation_required). The only provider calls this module can make are
//   * Hostaway pricing READS for the fresh recheck (listing, calendar, priceDetails calculation) via executors.pricing
//   * Hostaway reservation READS: lookup by booking ref (executors.lookupPage) and retrieve by id (executors.retrieveReservation)
//   * ONE Hostaway create per intent, ever (executors.createReservation), only for a row claimed from the outbox.
// Capture, void, cancel, offline-charge recording and notifications stay QUEUED: they are never claimed or executed here,
// and no other outbox type is dispatched (claims are restricted to RESERVATION_WORKER_OP_TYPES).
//
// Rules (E7 contract + errata, root E7.2 brief):
//   * Short transactions only, never a network call inside one; E3 transitions through applyEvent (version CAS) with an
//     in-transaction check that this worker still holds the intent's WORK lease. Deterministic event ids.
//   * The clock is an injected trusted function, read FRESH at every decision point (never a value from before an await).
//   * Fresh stored-stay recheck (listing, calendar, server price via priceStay + compareFinalPrice; exact configured listing
//     currency; no browser amount; no FX) before RESERVATION_STARTED.
//   * Lookup by ref first. An existing reservation with our ref BEFORE the first dispatch -> escalate (never adopted).
//     Absence counts only before the FIRST dispatch; after any uncertainty it is never proof.
//   * RESERVATION_DISPATCHED (+ unique create row + attempts row) is committed BEFORE the claim; the claim is the point of
//     no return. authorizationDeadline and the E3 lease are re-checked with a fresh clock IMMEDIATELY before the send; a
//     claimed row that is not sent is still "possibly sent" -> outcome_unknown -> read recovery. A create is never retried.
//   * The provider reply is recorded (version-independent attempts row) immediately after the call, before completion.
//     Only a fully verified reply (id, listing, ref, dates, total, currency, channel, status) yields RESERVATION_SUCCEEDED.
//     A reply whose only gap is a missing ref echo is settled by READS (by ref + by id, full identity; E7.1 planner).
//     Explicit contradiction -> escalate. 5xx / 429 / timeout / uncatalogued refusal (catalogue empty) -> unknown.
//   * A worker whose operation lease or work lease was lost applies no outcome event; recovery (E7.1) takes over.
//   * Recovery reads respect the 2-minute evidence freshness rule (the worker WAITS; it never sleeps).
//   * Planner operator codes become a durable escalation (reconciliation case); nothing is left silently stuck.
//   * Inventory claims are held until verified settlement (unchanged database rules).
import { applyEvent, loadIntent, RepoError, recordHostawayCreateResult, recoverInterruptedReservations } from "./repo.js";
import { claimNextOperation, completeOperation, recordProviderEvidence, recoverExpiredOperations } from "./operations.js";
import { assertEnvironment } from "./pool.js";
import {
  findMissedOutcomes, loadRecoveryFacts, requestRecoveryRead, findOrphanReads, reissueOrphanRead, applyRecoveryPlan, escalateOperatorPlan, orphanReissueExhausted
} from "./recovery.js";
import { planRecovery, FRESH_AFTER_DISPATCH_MS } from "../checkout/recovery-plan.js";
import { STATES as S } from "../checkout/intent-state.js";
import { priceStay } from "../checkout/server-pricer.js";
import { compareFinalPrice } from "../checkout/final-price.js";
import { readDirectPolicyFromEnv } from "../direct-policy.js";
import { todayInTimeZone } from "../public-api.js";
import {
  validateAdapterConfig, buildCreateReservationRequest, classifyCreateResponse, assessRefNotEchoed, unwrapEnvelope, normalizeReservation,
  lookupByRef, AdapterError
} from "../hostaway-reservations.js";

export const RESERVATION_WORKER_VERSION = "e7-reservation-worker-v1";
export const OPS = Object.freeze({ LOOKUP: "hostaway.lookup_reservation", RETRIEVE: "hostaway.retrieve_reservation", CREATE: "hostaway.create_reservation" });
export const RESERVATION_WORKER_OP_TYPES = Object.freeze([OPS.LOOKUP, OPS.RETRIEVE, OPS.CREATE]);
export const EXECUTOR_KEYS = Object.freeze(["pricing", "lookupPage", "retrieveReservation", "createReservation"]);
export const WORK_STATES = Object.freeze([S.PAYMENT_AUTHORIZED, S.RESERVATION_PENDING, S.RESERVATION_UNKNOWN]);
export const LIMITS = Object.freeze({
  workLeaseMs: 60 * 1000,          // intent_work lease for one step
  sendMarginMs: 15 * 1000,         // minimum remaining E3 lease AND authorization time at the moment of a create send
  waitMs: 30 * 1000,               // reschedule delay when waiting (never a busy loop)
  maxReservationStarts: 3,         // RESERVATION_STARTED attempts per intent (each only after a lease-expiry recovery)
  recoveryBatch: 10,               // missed outcomes / orphan reads handled per step
  maintenanceBatch: 20
});

/**
 * Historical Hostaway reservation ids from the E4 tests (owner-run, closed). FIXED here, not caller-overridable: a provider
 * reply, a recorded known id or recovery evidence naming one of them is never adopted, never confirmed and never leads
 * to a capture; it becomes a durable owner case. The historical evidence and journals themselves are untouched.
 */
export const PROTECTED_HOSTAWAY_RESERVATION_IDS = Object.freeze(["70636076", "71045356", "71072615", "71081885"]);
const PROTECTED_IDS = new Set(PROTECTED_HOSTAWAY_RESERVATION_IDS);
export const isProtectedReservationId = (id) => id != null && PROTECTED_IDS.has(String(id));

/**
 * Upper bounds for every provider call (real time, enforced with a timer and an AbortSignal passed to the executor) and
 * for one step. A caller may only SHORTEN them (tests use short timers); an injected executor that ignores the signal is
 * still cut off by the timer, but its eventual result can only be recorded as late evidence, never applied.
 */
export const DEFAULT_TIMEOUTS = Object.freeze({ pricingCallMs: 8000, readCallMs: 10000, createCallMs: 20000, stepBudgetMs: 45000 });
function resolveTimeouts(t) {
  const out = {};
  for (const [k, d] of Object.entries(DEFAULT_TIMEOUTS)) {
    const v = t !== null && typeof t === "object" ? t[k] : undefined;
    out[k] = Number.isFinite(v) && v > 0 ? Math.min(v, d) : d;
  }
  return Object.freeze(out);
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const result = (status, extra = {}) => Object.freeze({ status, ...extra });

export class ProviderCallTimeout extends Error { constructor() { super("PROVIDER_CALL_TIMEOUT"); this.code = "PROVIDER_CALL_TIMEOUT"; } }
/**
 * Start ONE provider call now (synchronously, no await before it) bounded by min(per-call timeout, remaining step budget).
 * -> { promise (settles by the deadline: result, provider error, or ProviderCallTimeout), raw (the executor's own promise) }
 */
function startBounded(ctx, kind, fn) {
  const ms = Math.min(ctx.timeouts[kind], ctx.stepEndsAt - ctx.mono());
  if (!(ms > 0)) return { promise: Promise.reject(new ProviderCallTimeout()), raw: null };
  const ac = new AbortController();
  let raw;
  try { raw = Promise.resolve(fn(ac.signal)); } catch (e) { raw = Promise.reject(e); }
  let timer;
  const promise = new Promise((resolve, reject) => {
    timer = setTimeout(() => { ac.abort(); reject(new ProviderCallTimeout()); }, ms);
    raw.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
  return { promise, raw };
}
const boundedPricing = (ctx) => Object.freeze({
  get: (path, o = {}) => startBounded(ctx, "pricingCallMs", (signal) => ctx.executors.pricing.get(path, { ...o, signal })).promise,
  post: (path, body, o = {}) => startBounded(ctx, "pricingCallMs", (signal) => ctx.executors.pricing.post(path, body, { ...o, signal })).promise
});

// ---------------------------------------------------------------------------------------------
// gate (pure; nothing touched before it passes)

/**
 * reservationWorkerGate({ env, adapterConfig, listings, executors, clock })
 *   env           the caller's environment OBJECT (never read implicitly): VERCEL_ENV development|preview (production and
 *                 anything else refused) and MV_E7_RESERVATION_WORKER === "enabled" (explicit TEST gate)
 *   adapterConfig E4 Hostaway adapter config (allowlist; pilots refused unless the minted connected-test config)
 *   listings      Map listingId -> { currency }: every listing must be in the adapter allowlist with the adapter currency
 *   executors     exactly the injected EXECUTOR_KEYS (all functions / a { get, post } pricing client); no others
 *   clock         () => trusted epoch ms
 */
export function reservationWorkerGate({ env, adapterConfig, listings, executors, clock } = {}) {
  const e = isObj(env) ? env : null;
  if (!e) return { ok: false, code: "ENV_REQUIRED" };
  if (e.VERCEL_ENV === "production") return { ok: false, code: "PRODUCTION_REFUSED" };
  if (e.VERCEL_ENV !== "development" && e.VERCEL_ENV !== "preview") return { ok: false, code: "ENVIRONMENT_NOT_ALLOWED" };
  if (e.MV_E7_RESERVATION_WORKER !== "enabled") return { ok: false, code: "NOT_ENABLED" };
  let cfg;
  try { cfg = validateAdapterConfig(adapterConfig); } catch { return { ok: false, code: "ADAPTER_CONFIG_INVALID" }; }
  if (!(listings instanceof Map) || listings.size === 0) return { ok: false, code: "LISTINGS_REQUIRED" };
  for (const [id, lc] of listings) {
    if (!cfg.allowedListingIds.includes(id) || !isObj(lc) || lc.currency !== cfg.currency) return { ok: false, code: "LISTING_NOT_ALLOWLISTED" };
  }
  if (!isObj(executors)) return { ok: false, code: "NO_EXECUTORS" };
  for (const k of Object.keys(executors)) if (!EXECUTOR_KEYS.includes(k)) return { ok: false, code: "EXECUTOR_NOT_ALLOWED" };
  const p = executors.pricing;
  if (!isObj(p) || typeof p.get !== "function" || typeof p.post !== "function") return { ok: false, code: "NO_EXECUTORS" };
  for (const k of ["lookupPage", "retrieveReservation", "createReservation"]) if (typeof executors[k] !== "function") return { ok: false, code: "NO_EXECUTORS" };
  if (typeof clock !== "function" || !Number.isFinite(clock())) return { ok: false, code: "CLOCK_REQUIRED" };
  const pol = readDirectPolicyFromEnv(e);
  if (!pol.ok) return { ok: false, code: "PRICING_POLICY_INVALID" };
  return { ok: true, cfg, policy: pol.policy };
}

// ---------------------------------------------------------------------------------------------
// small DB helpers (short statements / transactions; no network inside)

class WorkerStop extends Error { constructor(code) { super(code); this.code = code; } }

/** applyEvent, fenced on this worker's intent_work lease (checked inside the event transaction, intent row locked first). */
async function applyFenced(ctx, intentId, event, opts = {}) {
  const now = ctx.clock();
  try {
    return await applyEvent(ctx.pool, intentId, event, {
      now, actor: "worker", workerId: ctx.workerId, ...opts,
      inTx: async (c) => {
        const w = (await c.query("SELECT work_worker_id, work_lease_until FROM booking.intent_work WHERE intent_id = $1 FOR SHARE", [intentId])).rows[0];
        if (!w || w.work_worker_id !== ctx.workerId || !(new Date(w.work_lease_until).getTime() >= ctx.clock())) throw new RepoError("WORK_LEASE_LOST");
      }
    });
  } catch (e) {
    if (e instanceof RepoError && e.code === "WORK_LEASE_LOST") return { ok: false, error: "WORK_LEASE_LOST" };
    throw e;
  }
}

async function releaseWork(ctx, intentId, delayMs) {
  await ctx.pool.query(
    `UPDATE booking.intent_work SET work_worker_id = NULL, work_lease_until = NULL,
            next_action_at = CASE WHEN next_action_at IS NULL THEN NULL ELSE $3::timestamptz END
      WHERE intent_id = $1 AND work_worker_id = $2`, [intentId, ctx.workerId, new Date(ctx.clock() + delayMs)]);
}

async function loadGuest(q, intentId) {
  const g = (await q.query("SELECT first_name, last_name, email FROM booking.intent_guests WHERE intent_id = $1", [intentId])).rows[0];
  return g ? { firstName: g.first_name, lastName: g.last_name, email: g.email } : null;
}

const opsOf = async (q, intentId, opType) => (await q.query(
  `SELECT o.*, EXISTS (SELECT 1 FROM booking.provider_evidence e WHERE e.read_operation_id = o.id) AS has_evidence
     FROM booking.external_operations o WHERE o.intent_id = $1 AND o.op_type = $2 ORDER BY o.created_at DESC, o.id DESC`, [intentId, opType])).rows;

const escalateId = (intent, code) => `w-escalate:${intent.id}:${code}:v${intent.version}`;
async function escalate(ctx, intent, code) {
  const r = await applyFenced(ctx, intent.id, { type: "ESCALATE", id: escalateId(intent, code), code });
  ctx.actions.push(`ESCALATE:${code}`);
  return r;
}

// ---------------------------------------------------------------------------------------------
// provider READ execution (only the three reservation-phase types; results become immutable API evidence)

/** Reservation observation from a NORMALIZED Hostaway reservation (copied values; nothing defaulted). */
const observedReservation = (r) => ({ reservationId: String(r.reservationId), listingId: r.listingId, from: r.from, to: r.to,
  totalMinor: r.totalMinor, currency: r.currency, status: r.status, ...(r.bookingRef ? { bookingRef: r.bookingRef } : {}) });

/** Execute one claimed read row and persist its evidence. Returns { recorded, outcome } (outcome for the caller's decision). */
async function executeRead(ctx, intent, op) {
  const finish = (status, errorCode) => completeOperation(ctx.pool, op.id, { workerId: ctx.workerId, now: ctx.clock(),
    outcome: { status, ...(errorCode ? { errorCode } : {}) } });
  if (op.op_type === OPS.LOOKUP) {
    const ref = op.payload.ref;
    if (ref !== intent.ref) { await finish("outcome_unknown", "READ_SELECTOR_INVALID"); return { outcome: "error" }; }
    let lk;
    try {
      lk = await lookupByRef({ ref, listingId: intent.listingId, arrivalDate: intent.from, departureDate: intent.to }, ctx.cfg,
        (req) => startBounded(ctx, "readCallMs", (signal) => ctx.executors.lookupPage(req, { signal })).promise);   // timeout -> error, retried
    } catch { lk = { outcome: "error", code: "LOOKUP_FAILED" }; }
    ctx.calls.push(`lookup:${ref}`);
    if (lk.outcome === "found" || lk.outcome === "not_found") {
      const done = await finish("succeeded");
      if (!done.ok) return { outcome: "lease_lost" };
      const r = lk.reservation;
      const ev = lk.outcome === "found"
        ? { externalRef: String(r.reservationId), status: r.status === "cancelled" ? "cancelled" : "found_active",
          observed: { bookingRef: ref, matchCount: 1, ...observedReservation(r) } }
        : { externalRef: ref, status: "not_found", observed: { bookingRef: ref, matchCount: 0 } };
      const rec = await recordProviderEvidence(ctx.pool, { readOpId: op.id, kind: "hostaway_reservation", ...ev });
      return { outcome: lk.outcome, recorded: rec.ok, reservation: r };
    }
    if (lk.outcome === "conflict") {
      // explicit provider contradiction (duplicate ref / a match disagreeing with the stay): a durable escalation
      await finish("succeeded");
      return { outcome: "conflict", code: lk.code === "DUPLICATE_REF" ? "DUPLICATE_BOOKING_REF" : "LOOKUP_MATCH_CONTRADICTS_STAY" };
    }
    await finish("outcome_unknown", "LOOKUP_INCONCLUSIVE");     // incomplete / error: a bounded read retry, never a conclusion
    return { outcome: "error" };
  }
  if (op.op_type === OPS.RETRIEVE) {
    const id = op.payload.reservationId;
    if (typeof id !== "string" || !/^[1-9][0-9]{0,15}$/.test(id)) { await finish("outcome_unknown", "READ_SELECTOR_INVALID"); return { outcome: "error" }; }
    let resp;
    const req = Object.freeze({ method: "GET", path: `/reservations/${id}`, query: {} });
    try { resp = await startBounded(ctx, "readCallMs", (signal) => ctx.executors.retrieveReservation(req, { signal })).promise; }
    catch { resp = { transportError: true }; }                     // timeout / abort / transport: a bounded read retry
    ctx.calls.push(`retrieve:${id}`);
    if (isObj(resp) && resp.httpStatus === 404) {
      const done = await finish("succeeded");
      if (!done.ok) return { outcome: "lease_lost" };
      const rec = await recordProviderEvidence(ctx.pool, { readOpId: op.id, kind: "hostaway_reservation", externalRef: id, status: "not_found", observed: {} });
      return { outcome: "not_found", recorded: rec.ok };
    }
    const env = isObj(resp) && resp.httpStatus === 200 ? unwrapEnvelope(resp.json) : { ok: false };
    const n = env.ok ? normalizeReservation(env.result, ctx.cfg) : { ok: false };
    if (!n.ok) { await finish("outcome_unknown", "READ_REPLY_NOT_USABLE"); return { outcome: "error" }; }
    if (String(n.reservation.reservationId) !== id) {
      await finish("succeeded");
      return { outcome: "conflict", code: "BY_ID_READ_CONTRADICTS_REQUEST" };
    }
    const done = await finish("succeeded");
    if (!done.ok) return { outcome: "lease_lost" };
    const r = n.reservation;
    const rec = await recordProviderEvidence(ctx.pool, { readOpId: op.id, kind: "hostaway_reservation", externalRef: id,
      status: r.status === "cancelled" ? "cancelled" : "found_active", observed: observedReservation(r) });
    return { outcome: "found", recorded: rec.ok };
  }
  throw new WorkerStop("READ_TYPE_NOT_ALLOWED");
}

// ---------------------------------------------------------------------------------------------
// per-state handlers (each returns { delayMs } for rescheduling, or throws WorkerStop)

async function handlePaymentAuthorized(ctx, intent) {
  if (intent.counters.reservationAttempts >= LIMITS.maxReservationStarts) { await escalate(ctx, intent, "RESERVATION_START_EXHAUSTED"); return { delayMs: 0 }; }
  const lc = ctx.listings.get(intent.listingId);
  if (!lc || !intent.price || lc.currency !== intent.price.currency || !ctx.cfg.allowedListingIds.includes(intent.listingId)) {
    await escalate(ctx, intent, "LISTING_NOT_CONFIGURED"); return { delayMs: 0 };
  }
  let recheck = null;
  if (ctx.clock() < intent.payment.authorizationDeadline) {
    const now = ctx.clock();
    const priced = await priceStay({ request: { listingId: intent.listingId, from: intent.from, to: intent.to, guests: intent.guests },
      listingConfig: lc, client: boundedPricing(ctx), policy: ctx.policy, today: todayInTimeZone(undefined, new Date(now)), now });
    ctx.calls.push("pricing");
    if (priced.ok) recheck = { bookable: true, priceSame: compareFinalPrice(intent.price, priced.price).same };
    else if (priced.error === "NOT_BOOKABLE") recheck = { bookable: false, priceSame: false };
    else if (priced.error === "PRICE_REFUSED" || priced.error === "CURRENCY_NOT_CONFIGURED") recheck = { bookable: true, priceSame: false };
    else { ctx.actions.push(`WAIT:${priced.error}`); return { delayMs: LIMITS.waitMs }; }   // transient read failure: no event
  }
  // fresh clock (after the awaits): E3 itself escalates if the authorization deadline has passed meanwhile
  const r = await applyFenced(ctx, intent.id, { type: "RESERVATION_STARTED", id: `w-start:${intent.id}:${intent.counters.reservationAttempts + 1}`,
    workerId: ctx.workerId, recheck: recheck || {} });
  ctx.actions.push(r.ok ? `RESERVATION_STARTED->${r.intent.status}` : `RESERVATION_STARTED!${r.error}`);
  return { delayMs: 0 };
}

async function handleReservationPending(ctx, intent) {
  if (intent.dispatch) {
    const create = (await opsOf(ctx.pool, intent.id, OPS.CREATE))[0];
    // the create was already handed on (or settled): only reads remain; the E3 lease is irrelevant for reads
    if (!create || create.state !== "pending") return readsStep(ctx, intent, create);
  }
  const now0 = ctx.clock();
  if (!intent.lease || intent.lease.workerId !== ctx.workerId || !(now0 <= intent.lease.until)) {
    ctx.actions.push("WAIT:E3_LEASE_NOT_HELD"); return { delayMs: LIMITS.waitMs };          // recovery (lease expiry) takes over
  }
  if (intent.dispatch) return createStep(ctx, intent);
  // 1. lookup by ref FIRST (the read E3 queued at RESERVATION_STARTED)
  const lookups = (await opsOf(ctx.pool, intent.id, OPS.LOOKUP)).filter((o) => o.source_version === intent.version && o.payload.ref === intent.ref);
  let done = lookups.find((o) => o.state === "succeeded" && o.has_evidence);
  if (!done) {
    if (lookups.some((o) => o.state === "escalated")) { await escalate(ctx, intent, "PRE_CREATE_LOOKUP_FAILED"); return { delayMs: 0 }; }
    const pend = lookups.find((o) => o.state === "pending");
    if (!pend) { ctx.actions.push("WAIT:LOOKUP_IN_PROGRESS"); return { delayMs: LIMITS.waitMs }; }
    const op = await claimNextOperation(ctx.pool, { workerId: ctx.workerId, now: ctx.clock(), opId: pend.id, opTypes: [OPS.LOOKUP] });
    if (!op) { ctx.actions.push("WAIT:LOOKUP_NOT_CLAIMED"); return { delayMs: LIMITS.waitMs }; }
    const x = await executeRead(ctx, intent, op);
    if (x.outcome === "conflict") { await escalate(ctx, intent, x.code); return { delayMs: 0 }; }
    if (x.outcome !== "found" && x.outcome !== "not_found") { ctx.actions.push(`WAIT:LOOKUP_${x.outcome.toUpperCase()}`); return { delayMs: LIMITS.waitMs }; }
    done = { ...op, has_evidence: x.recorded };
    if (!x.recorded) { ctx.actions.push("WAIT:LOOKUP_EVIDENCE_NOT_RECORDED"); return { delayMs: LIMITS.waitMs }; }
  }
  const ev = (await ctx.pool.query("SELECT status FROM booking.provider_evidence WHERE read_operation_id = $1", [done.id])).rows[0];
  if (!ev || ev.status !== "not_found") {
    // a reservation carrying our booking ref already exists BEFORE our first create: never adopted
    await escalate(ctx, intent, "EXISTING_BOOKING_REF_BEFORE_CREATE"); return { delayMs: 0 };
  }
  // absence is acceptable only before the FIRST dispatch: no create row may exist for this intent at all
  if ((await opsOf(ctx.pool, intent.id, OPS.CREATE)).length > 0) { await escalate(ctx, intent, "CREATE_ALREADY_RECORDED"); return { delayMs: 0 }; }
  // 2. the full create plan must be valid BEFORE anything is dispatched (listing allowlist, exact currency, guest data)
  const guest = await loadGuest(ctx.pool, intent.id);
  if (!guest) { await escalate(ctx, intent, "GUEST_DETAILS_MISSING"); return { delayMs: 0 }; }
  const plan = planOf(intent, guest);
  try { buildCreateReservationRequest(plan, ctx.cfg); } catch (e) {
    await escalate(ctx, intent, e instanceof AdapterError && /^[A-Z_]{1,40}$/.test(e.code) ? `CREATE_PLAN_${e.code}` : "CREATE_PLAN_INVALID"); return { delayMs: 0 };
  }
  // 3. fresh clock: enough authorization time and E3 lease left for the WHOLE bounded send (call timeout + margin)
  const need = ctx.timeouts.createCallMs + LIMITS.sendMarginMs;
  const now1 = ctx.clock();
  if (!(intent.payment.authorizationDeadline - now1 > need)) { await escalate(ctx, intent, "AUTHORIZATION_DEADLINE_PASSED"); return { delayMs: 0 }; }
  if (!(intent.lease.until - now1 > need)) { ctx.actions.push("WAIT:E3_LEASE_TOO_SHORT"); return { delayMs: LIMITS.waitMs }; }
  // 4. write-before-send: RESERVATION_DISPATCHED + unique create row + attempts row, committed
  const d = await applyFenced(ctx, intent.id, { type: "RESERVATION_DISPATCHED", id: `w-dispatch:${intent.id}:${intent.counters.reservationAttempts}`, workerId: ctx.workerId });
  ctx.actions.push(d.ok ? "RESERVATION_DISPATCHED" : `RESERVATION_DISPATCHED!${d.error}`);
  if (!d.ok) return { delayMs: LIMITS.waitMs };
  if (ctx.hooks.afterDispatch) await ctx.hooks.afterDispatch(intent.id);
  return createStep(ctx, await loadIntent(ctx.pool, intent.id));
}

const planOf = (intent, guest) => ({ ref: intent.ref, listingId: intent.listingId, arrivalDate: intent.from, departureDate: intent.to,
  guests: intent.guests, guest, totalMinor: intent.price.finalTotalMinor, currency: intent.price.currency });

/** Claim the (single) create row, re-check deadline + E3 lease with a fresh clock, send once, record, classify. */
async function createStep(ctx, intent) {
  const creates = await opsOf(ctx.pool, intent.id, OPS.CREATE);
  if (creates.length !== 1 || creates[0].state !== "pending") { ctx.actions.push(`WAIT:CREATE_${creates[0]?.state ?? "MISSING"}`.toUpperCase()); return { delayMs: LIMITS.waitMs }; }
  const guest = await loadGuest(ctx.pool, intent.id);
  let request;
  try { request = buildCreateReservationRequest(planOf(intent, guest || {}), ctx.cfg); }
  catch { await escalate(ctx, intent, "CREATE_PLAN_INVALID"); return { delayMs: 0 }; }    // nothing claimed: the row is superseded by E3
  const op = await claimNextOperation(ctx.pool, { workerId: ctx.workerId, now: ctx.clock(), opId: creates[0].id, opTypes: [OPS.CREATE] });
  if (!op) { ctx.actions.push("WAIT:CREATE_NOT_CLAIMED"); return { delayMs: LIMITS.waitMs }; }
  ctx.actions.push("CREATE_CLAIMED");
  // ---- point of no return: from here the create is "possibly sent" ----
  if (ctx.hooks.afterClaim) await ctx.hooks.afterClaim(op);
  const refused = await preSendCheck(ctx, intent.id, op.id);
  if (refused) {
    ctx.actions.push(`SEND_ABORTED:${refused}`);
    return settleUnknown(ctx, intent.id, op, `SEND_ABORTED_${refused}`);
  }
  // no await between the last check and the start of the call
  const call = startBounded(ctx, "createCallMs", (signal) => ctx.executors.createReservation(request, { signal }));
  ctx.calls.push(`create:${intent.ref}`);
  ctx.sends += 1;
  const plan = planOf(intent, guest);
  let response; let timedOut = false;
  try { response = await call.promise; } catch (e) { timedOut = e instanceof ProviderCallTimeout; response = { transportError: true }; }
  if (timedOut) {
    // the create may still complete at the provider: UNKNOWN (never "not sent", never retried). A result that arrives
    // later is recorded ONLY as late evidence after the unknown settlement committed; it never applies an event.
    if (ctx.hooks.onCreateTimeout) await ctx.hooks.onCreateTimeout(op);
    const settled = settleUnknown(ctx, intent.id, op, "CREATE_TIMEOUT");
    ctx.late.push(Promise.all([call.raw, settled]).then(([resp]) => lateCreateResult(ctx, intent.id, op, resp, plan)).catch(() => {}));
    return settled;
  }
  const cls = classifyCreateResponse(response, plan, ctx.cfg);
  const refGap = cls.outcome === "conflict" ? assessRefNotEchoed(response, plan, ctx.cfg) : { eligible: false };
  // record the provider's reply IMMEDIATELY (version-independent; survives any later lost lease)
  const replyReservation = normalizedReply(ctx, response);
  await recordHostawayCreateResult(ctx.pool, intent.id, { httpStatus: Number.isSafeInteger(response?.httpStatus) ? response.httpStatus : null,
    reservation: replyReservation }, { now: ctx.clock() });
  if (ctx.hooks.afterRecord) await ctx.hooks.afterRecord(op);
  // protected historical reservation ids: never adopted, confirmed or captured
  const replyIds = [cls.reservation?.reservationId, cls.reservationId, refGap.reservationId, replyReservation?.reservationId];
  if (replyIds.some(isProtectedReservationId)) {
    const u = await completeOperation(ctx.pool, op.id, { workerId: ctx.workerId, now: ctx.clock(), outcome: { status: "outcome_unknown", errorCode: "PROTECTED_RESERVATION_ID" } });
    if (!u.ok) { ctx.actions.push(`LEASE_LOST:${u.error}`); return { delayMs: 0 }; }
    const r = await applyFenced(ctx, intent.id, { type: "ESCALATE", id: `op-outcome:${op.id}`, code: "PROTECTED_RESERVATION_ID" });
    ctx.actions.push(r.ok ? "ESCALATE:PROTECTED_RESERVATION_ID" : `ESCALATE!${r.error}`);
    return { delayMs: 0 };
  }
  if (cls.outcome === "created") {
    const c = await completeOperation(ctx.pool, op.id, { workerId: ctx.workerId, now: ctx.clock(), outcome: { status: "succeeded", resultRef: String(cls.reservation.reservationId) } });
    if (!c.ok) { ctx.actions.push(`LEASE_LOST:${c.error}`); return { delayMs: 0 }; }
    if (ctx.hooks.afterComplete) await ctx.hooks.afterComplete(op);
    const r = await applyFenced(ctx, intent.id, { type: "RESERVATION_SUCCEEDED", id: `op-outcome:${op.id}`, reservation: { ...cls.reservation, reservationId: String(cls.reservation.reservationId) } });
    ctx.actions.push(r.ok ? `RESERVATION_SUCCEEDED->${r.intent.status}` : `RESERVATION_SUCCEEDED!${r.error}`);
    return { delayMs: 0 };
  }
  if (refGap.eligible) {
    // only the ref echo is missing: the provider's id is recorded; READS (by ref + by id) must prove the full identity
    const c = await completeOperation(ctx.pool, op.id, { workerId: ctx.workerId, now: ctx.clock(), outcome: { status: "succeeded", resultRef: String(refGap.reservationId) } });
    ctx.actions.push(c.ok ? "CREATE_REF_NOT_ECHOED:READS_REQUIRED" : `LEASE_LOST:${c.error}`);
    return { delayMs: FRESH_AFTER_DISPATCH_MS };
  }
  if (cls.outcome === "conflict") {
    // an explicit contradiction from the provider: a reservation exists but disagrees -> durable escalation, no adoption
    const u = await completeOperation(ctx.pool, op.id, { workerId: ctx.workerId, now: ctx.clock(), outcome: { status: "outcome_unknown", errorCode: "CREATE_REPLY_CONTRADICTION" } });
    if (!u.ok) { ctx.actions.push(`LEASE_LOST:${u.error}`); return { delayMs: 0 }; }
    const r = await applyFenced(ctx, intent.id, { type: "ESCALATE", id: `op-outcome:${op.id}`, code: "CREATE_REPLY_CONTRADICTION" });
    ctx.actions.push(r.ok ? "ESCALATE:CREATE_REPLY_CONTRADICTION" : `ESCALATE!${r.error}`);
    return { delayMs: 0 };
  }
  // ambiguous: 5xx / 429 / transport / auth / uncatalogued refusal / malformed -> unknown, read recovery, never a retry
  return settleUnknown(ctx, intent.id, op, /^[A-Z0-9_]{1,40}$/.test(cls.code || "") ? cls.code : "CREATE_OUTCOME_UNKNOWN");
}

function normalizedReply(ctx, response) {
  if (!isObj(response) || !Number.isSafeInteger(response.httpStatus)) return null;
  const env = unwrapEnvelope(response.json);
  const n = env.ok ? normalizeReservation(env.result, ctx.cfg) : { ok: false };
  return n.ok ? n.reservation : null;
}

/**
 * Immediately before a create send: the operation row is still in_flight and leased to THIS worker, this worker still
 * holds the intent's work lease, the intent is reservation_pending under this worker's E3 lease, and every one of those
 * leases AND the authorization deadline leaves room for the whole bounded call (+ margin). The clock is read AFTER the
 * database reads. Returns null (send) or a refusal code (do not send; the claimed row is settled as unknown).
 */
async function preSendCheck(ctx, intentId, opId) {
  const o = (await ctx.pool.query("SELECT state, lease_worker_id, lease_until FROM booking.external_operations WHERE id = $1", [opId])).rows[0];
  const w = (await ctx.pool.query("SELECT work_worker_id, work_lease_until FROM booking.intent_work WHERE intent_id = $1", [intentId])).rows[0];
  const i = await loadIntent(ctx.pool, intentId);
  const now = ctx.clock();
  const need = ctx.timeouts.createCallMs + LIMITS.sendMarginMs;
  const t = (d) => (d == null ? Number.NaN : new Date(d).getTime());
  if (!o || o.state !== "in_flight" || o.lease_worker_id !== ctx.workerId) return "OPERATION_NOT_HELD";
  if (!(t(o.lease_until) - now > need)) return "OPERATION_LEASE_TOO_SHORT";
  if (!w || w.work_worker_id !== ctx.workerId) return "WORK_LEASE_NOT_HELD";
  if (!(t(w.work_lease_until) - now > need)) return "WORK_LEASE_TOO_SHORT";
  if (!i || i.status !== S.RESERVATION_PENDING || !i.lease || i.lease.workerId !== ctx.workerId) return "E3_LEASE_NOT_HELD";
  if (!(i.lease.until - now > need)) return "E3_LEASE_TOO_SHORT";
  if (!(i.payment.authorizationDeadline - now > need)) return "DEADLINE";
  if (!(ctx.stepEndsAt - ctx.mono() > ctx.timeouts.createCallMs)) return "STEP_BUDGET";
  return null;
}

/** A create result that arrived after its timeout: version-independent reply record + late evidence on the op; no event. */
async function lateCreateResult(ctx, intentId, op, response, plan) {
  const reservation = normalizedReply(ctx, response);
  await recordHostawayCreateResult(ctx.pool, intentId, { httpStatus: Number.isSafeInteger(response?.httpStatus) ? response.httpStatus : null, reservation },
    { now: ctx.clock() });
  const cls = classifyCreateResponse(response, plan, ctx.cfg);
  await completeOperation(ctx.pool, op.id, { workerId: ctx.workerId, now: ctx.clock(), outcome: cls.outcome === "created"
    ? { status: "succeeded", resultRef: String(cls.reservation.reservationId) } : { status: "outcome_unknown", errorCode: "LATE_CREATE_RESULT" } });
}

async function settleUnknown(ctx, intentId, op, code) {
  if (ctx.hooks.beforeSettleUnknown) await ctx.hooks.beforeSettleUnknown(op, code);
  const u = await completeOperation(ctx.pool, op.id, { workerId: ctx.workerId, now: ctx.clock(), outcome: { status: "outcome_unknown", errorCode: code } });
  if (!u.ok) { ctx.actions.push(`LEASE_LOST:${u.error}`); return { delayMs: 0 }; }
  const r = await applyFenced(ctx, intentId, { type: "RESERVATION_OUTCOME_UNKNOWN", id: `op-unknown:${op.id}`, code });
  ctx.actions.push(r.ok ? `RESERVATION_OUTCOME_UNKNOWN:${code}` : `RESERVATION_OUTCOME_UNKNOWN!${r.error}`);
  return { delayMs: 0 };
}

async function handleReservationUnknown(ctx, intent) {
  const create = (await opsOf(ctx.pool, intent.id, OPS.CREATE))[0];
  if (create && create.state === "superseded" && create.dispatched_at == null) {
    // the create was recorded but never handed to a sender; absence after the dispatch record is still not proof (R1)
    await escalate(ctx, intent, "CREATE_NEVER_SENT_UNPROVEN"); return { delayMs: 0 };
  }
  return readsStep(ctx, intent, create);
}

/** Execute ONE due reservation read for the intent (lookup by ref / retrieve by id), honouring evidence freshness. */
async function readsStep(ctx, intent, create) {
  // reads must be observed >= 2 min after the create was handed to a sender (E7.1 freshness): wait, never sleep
  const notBefore = create && create.dispatched_at ? new Date(create.dispatched_at).getTime() + FRESH_AFTER_DISPATCH_MS : 0;
  const now = ctx.clock();
  if (now < notBefore) { ctx.actions.push("WAIT:EVIDENCE_FRESHNESS"); return { delayMs: notBefore - now }; }
  const op = await claimNextOperation(ctx.pool, { workerId: ctx.workerId, now, intentId: intent.id, opTypes: [OPS.LOOKUP, OPS.RETRIEVE] });
  if (!op) { ctx.actions.push("WAIT:NO_READ_DUE"); return { delayMs: LIMITS.waitMs }; }
  const x = await executeRead(ctx, intent, op);
  if (x.outcome === "conflict") { await escalate(ctx, intent, x.code); return { delayMs: 0 }; }
  ctx.actions.push(`READ:${op.op_type}:${x.outcome}`);
  return { delayMs: 0 };
}

// ---------------------------------------------------------------------------------------------
// recovery pass (E7.1 foundation), reservation-phase rows only

async function recoveryPass(ctx) {
  const scope = { intentId: ctx.scopeIntentId, listingIds: ctx.listingIds };
  const missed = (await findMissedOutcomes(ctx.pool, { now: ctx.clock(), limit: LIMITS.recoveryBatch, opTypes: [OPS.CREATE], ...scope })).rows;
  for (const m of missed) {
    const facts = await loadRecoveryFacts(ctx.pool, m.opId);
    const plan = planRecovery({ ...facts, now: ctx.clock() });
    // protected historical ids anywhere in the facts or the plan: never adopted -> durable owner case
    const seen = [facts.op.resultRef, ...(facts.knownReservationIds || []), plan.event?.reservation?.reservationId,
      ...facts.evidence.filter((e) => e.kind === "hostaway_reservation").flatMap((e) => [e.externalRef, e.observed?.reservationId])];
    if (seen.some(isProtectedReservationId)) {
      await escalateOperatorPlan(ctx.pool, m.opId, "PROTECTED_RESERVATION_ID", { now: ctx.clock() });
      ctx.actions.push("RECOVERY:ESCALATE:PROTECTED_RESERVATION_ID");
      continue;
    }
    if (plan.kind === "event") {
      const r = await applyRecoveryPlan(ctx.pool, plan, { now: ctx.clock() });
      ctx.actions.push(`RECOVERY:${plan.event.type}${r.ok ? "" : `!${r.error}`}`);
    } else if (plan.kind === "needs_fresh_read") {
      if (!RESERVATION_WORKER_OP_TYPES.includes(plan.read.opType)) continue;
      const r = await requestRecoveryRead(ctx.pool, m.opId, plan.read, { now: ctx.clock() });
      if (!r.ok && r.error === "RECOVERY_READS_EXHAUSTED") {
        await escalateOperatorPlan(ctx.pool, m.opId, "RECOVERY_READS_EXHAUSTED", { now: ctx.clock() });
        ctx.actions.push("RECOVERY:ESCALATE:RECOVERY_READS_EXHAUSTED");
      } else ctx.actions.push(`RECOVERY:READ:${plan.read.opType}`);
    } else if (plan.kind === "operator") {
      await escalateOperatorPlan(ctx.pool, m.opId, plan.code, { now: ctx.clock() });
      ctx.actions.push(`RECOVERY:ESCALATE:${plan.code}`);
    }
  }
  const orphans = await findOrphanReads(ctx.pool, { now: ctx.clock(), limit: LIMITS.recoveryBatch, opTypes: [OPS.LOOKUP, OPS.RETRIEVE],
    intentStates: [...WORK_STATES], ...scope });
  for (const o of orphans) {
    if (ctx.hooks.beforeReissue) await ctx.hooks.beforeReissue(o);
    // phase-guarded (E7.4a accepted interface): intent locked first; this worker's states + full scope re-checked in-tx
    const r = await reissueOrphanRead(ctx.pool, o.readOpId, { now: ctx.clock(), intentStates: [...WORK_STATES], listingIds: scope.listingIds,
      opTypes: [OPS.LOOKUP, OPS.RETRIEVE], intentId: scope.intentId });
    ctx.actions.push(`RECOVERY:REISSUE${r.ok ? "" : `!${r.error}`}`);
    if (!r.ok && r.error === "REISSUE_DEPTH_EXHAUSTED") {
      // terminal read exhaustion: a durable owner case. Scope and the CURRENT state are checked INSIDE the event
      // transaction (intent row locked): an intent that left the reservation phase meanwhile is never escalated by this.
      if (ctx.hooks.afterReissueExhausted) await ctx.hooks.afterReissueExhausted(o);
      let e;
      try {
        e = await applyEvent(ctx.pool, o.intentId, { type: "ESCALATE", id: `w-reissue-exhausted:${o.readOpId}`, code: "READ_REISSUE_EXHAUSTED" }, {
          now: ctx.clock(), actor: "reconciler",
          inTx: async (c, { before }) => {
            // bound to the version / state the exhaustion was decided on, and the orphan + depth fact still true now
            if (before.version !== r.intentVersion || before.status !== r.intentState
              || !WORK_STATES.includes(before.status) || !ctx.listings.has(before.listingId) || (ctx.scopeIntentId && before.id !== ctx.scopeIntentId)) {
              throw new RepoError("OUT_OF_SCOPE");
            }
            if (!(await orphanReissueExhausted(c, o.readOpId, { now: ctx.clock() }))) throw new RepoError("OUT_OF_SCOPE");
          }
        });
      } catch (err) {
        if (!(err instanceof RepoError && err.code === "OUT_OF_SCOPE")) throw err;
        e = { ok: false, error: "OUT_OF_SCOPE" };
      }
      ctx.actions.push(e.ok ? "RECOVERY:ESCALATE:READ_REISSUE_EXHAUSTED" : `RECOVERY:ESCALATE!${e.error}`);
    }
  }
}

/** Short claim on intent_work (never bumps the E3 version), optionally for one intent only. */
async function claimWork(pool, { workerId, now, leaseMs, states, intentId, listingIds }) {
  const r = await pool.query(
    `WITH c AS (
       SELECT w.intent_id FROM booking.intent_work w JOIN booking.intents i ON i.id = w.intent_id
        WHERE w.next_action_at <= $2 AND (w.work_lease_until IS NULL OR w.work_lease_until < $2) AND i.state = ANY($4)
          AND ($5::uuid IS NULL OR w.intent_id = $5) AND i.listing_id = ANY($6)
        ORDER BY w.next_action_at FOR UPDATE OF w SKIP LOCKED LIMIT 1)
     UPDATE booking.intent_work w SET work_worker_id = $1, work_lease_until = $3 FROM c WHERE w.intent_id = c.intent_id
     RETURNING w.intent_id`, [workerId, new Date(now), new Date(now + leaseMs), states, intentId, listingIds]);
  return r.rows[0]?.intent_id ?? null;
}

// ---------------------------------------------------------------------------------------------

/**
 * runOrchestratorStep(pool, { workerId, env, adapterConfig, listings, executors, clock, intentId?, timeouts?, hooks })
 *   Everything the step touches is scoped IN SQL (before any limit) to the configured listing ids, the reservation-phase
 *   operation types and, when given, one intentId: maintenance, recovery, orphan re-issue and the work claim.
 *   timeouts (optional) may only SHORTEN DEFAULT_TIMEOUTS. result.late settles when any late provider result was recorded.
 *   -> { status: "refused" | "idle" | "worked", code?, intentId?, actions, calls, sends, delayMs? }
 * One bounded step: gate -> test-database check -> bounded maintenance + recovery -> at most ONE intent's next action ->
 * reschedule (never a loop). Nothing is claimed or sent unless every gate passes.
 */
export async function runOrchestratorStep(pool, opts = {}) {
  const { workerId, env, adapterConfig, listings, executors, clock, intentId: scopeIntentId = null, timeouts, hooks = {} } = opts;
  // monotonic time for the real-time step budget (the business clock stays `clock`); injectable for tests only
  const mono = typeof opts.monotonic === "function" ? opts.monotonic : () => performance.now();
  const g = reservationWorkerGate({ env, adapterConfig, listings, executors, clock });
  if (!g.ok) return result("refused", { code: g.code, actions: [], calls: [], sends: 0 });
  if (typeof workerId !== "string" || !/^[A-Za-z0-9._:-]{1,80}$/.test(workerId)) return result("refused", { code: "WORKER_ID_INVALID", actions: [], calls: [], sends: 0 });
  try { await assertEnvironment(pool, "test"); } catch { return result("refused", { code: "DATABASE_NOT_TEST", actions: [], calls: [], sends: 0 }); }
  const t = resolveTimeouts(timeouts);
  const listingIds = [...listings.keys()];
  const ctx = { pool, workerId, cfg: g.cfg, policy: g.policy, listings, listingIds, executors, clock, hooks, scopeIntentId, timeouts: t,
    mono, stepEndsAt: mono() + t.stepBudgetMs, late: [], actions: [], calls: [], sends: 0 };
  const late = () => Promise.allSettled(ctx.late);
  // bounded, SCOPED maintenance: expired reservation-phase operation leases -> unknown (writes never re-queued); expired E3
  // reservation leases of configured listings. Rows of other types / listings / intents are never touched by this step.
  // E7.4a: phase-guarded in the maintenance transaction itself (intent locked first; state re-checked there)
  await recoverExpiredOperations(pool, { now: clock(), limit: LIMITS.maintenanceBatch, opTypes: [...RESERVATION_WORKER_OP_TYPES], intentId: scopeIntentId, listingIds,
    intentStates: [...WORK_STATES] });
  await recoverInterruptedReservations(pool, { now: clock(), limit: LIMITS.maintenanceBatch, intentId: scopeIntentId, listingIds });
  await recoveryPass(ctx);
  const intentId = await claimWork(pool, { workerId, now: clock(), leaseMs: LIMITS.workLeaseMs, states: [...WORK_STATES], intentId: scopeIntentId, listingIds });
  if (!intentId) return result("idle", { actions: ctx.actions, calls: ctx.calls, sends: ctx.sends, late: late() });
  let delayMs = LIMITS.waitMs;
  try {
    const intent = await loadIntent(pool, intentId);
    const h = intent.status === S.PAYMENT_AUTHORIZED ? handlePaymentAuthorized
      : intent.status === S.RESERVATION_PENDING ? handleReservationPending
        : intent.status === S.RESERVATION_UNKNOWN ? handleReservationUnknown : null;
    if (h) ({ delayMs } = await h(ctx, intent));
  } catch (e) {
    if (!(e instanceof WorkerStop)) throw e;
    ctx.actions.push(`STOP:${e.code}`);
  } finally {
    await releaseWork(ctx, intentId, delayMs);
  }
  return result("worked", { intentId, actions: ctx.actions, calls: ctx.calls, sends: ctx.sends, delayMs, late: late() });
}

export const _internal = Object.freeze({ applyFenced, executeRead, observedReservation, resolveTimeouts, startBounded, claimWork, releaseWork });   // + E7.3b reuse (export only)
