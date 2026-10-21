// db/lib/repo.js — Stage E2B. Durable persistence for E3 booking intents.
//
// The single pattern (E2A §4.1, owner addendum R2):
//   1. load the intent row (no transaction)
//   2. pure E3 transition() in memory
//   3. ONE short transaction, no network inside:
//        permanent event de-dup row  -> compare-and-swap UPDATE (WHERE version = expected)
//        -> audit row -> outbox rows for every effect -> claims / attempts / ledger / cases -> work schedule
//   4. on a lost version race: reload and re-evaluate (bounded)
// External calls happen only BEFORE step 1 or AFTER step 3. Nothing here talks to Stripe or Hostaway.
//
// A unique outbox or attempt row bounds what THIS system may send. It is not a claim of exactly-once delivery
// to Stripe or Hostaway: that depends on provider idempotency (Stripe) or reconciliation (Hostaway, R1).
import { randomUUID } from "node:crypto";
import { createIntent, transition, TERMINAL_STATES, STATES as S } from "../../lib/checkout/intent-state.js";
import { rowToIntent, intentToRow, MUTABLE_COLUMNS, INTENT_SELECT, num } from "./codec.js";
import { DB_CONFIG } from "./config.js";

const TERMINAL = new Set(TERMINAL_STATES);
// States in which the inventory claim may be released — and then only if no payment attempt is unresolved.
// Every other state keeps the claim: a reservation may exist, or money may be held, or the outcome is unknown.
export const CLAIM_RELEASE_STATES = Object.freeze(new Set([
  S.VALIDATION_FAILED, S.EXPIRED, S.PAYMENT_FAILED, S.PAYMENT_EXPIRED, S.AUTHORIZATION_RELEASED, S.CANCELLED
]));
export const UNRESOLVED_PAYMENT_ATTEMPT = Object.freeze(["creating", "open", "outcome_unknown"]);

export class RepoError extends Error {
  constructor(code, detail) { super(code); this.code = code; if (detail) this.detail = detail; }
}

// ---------------------------------------------------------------------------------------------
// transaction helper (short transactions only)
export async function withTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function loadIntentRow(q, intentId, { forUpdate = false } = {}) {
  const r = await q.query(`${INTENT_SELECT} WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`, [intentId]);
  return r.rows[0] || null;
}

export async function loadIntent(q, intentId) {
  const row = await loadIntentRow(q, intentId);
  return row ? rowToIntent(row) : null;
}

const INSERT_COLUMNS = ["id", "ref", "access_token_hash", "machine_version", "environment", "state", "version", "listing_id",
  "from_date", "to_date", "guests", "created_at", "updated_at"];

/** Create a new intent (version 0, state created) with its audit row and work row. */
export async function createIntentRecord(pool, { id = randomUUID(), ref, accessTokenHash, listingId, from, to, guests, environment, now }) {
  if (!Buffer.isBuffer(accessTokenHash) || accessTokenHash.length !== 32) throw new TypeError("accessTokenHash must be a 32-byte sha256 digest");
  const intent = createIntent({ id, ref, listingId, from, to, guests, now });
  const row = intentToRow(intent);
  const values = [row.id, row.ref, accessTokenHash, row.machine_version, environment, row.state, row.version, row.listing_id,
    row.from_date, row.to_date, row.guests, row.created_at, row.updated_at];
  await withTx(pool, async (c) => {
    await c.query(`INSERT INTO booking.intents (${INSERT_COLUMNS.join(", ")}) VALUES (${INSERT_COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})`, values);
    await c.query(`INSERT INTO booking.intent_transitions (intent_id, version_after, from_state, to_state, event_type, actor, at)
                   VALUES ($1, 0, NULL, 'created', 'CREATED', 'guest', $2)`, [id, new Date(now)]);
    await c.query("INSERT INTO booking.intent_work (intent_id, next_action_at) VALUES ($1, NULL)", [id]);
  });
  return intent;
}

// ---------------------------------------------------------------------------------------------
// E3 effect -> outbox row. Outbox keys are OUR de-duplication keys; provider idempotency keys travel in payload.
export function effectToOperation(effect, after, versionAfter) {
  const id = after.id;
  const base = (opType, retryClass, key, payload) => ({ opType, retryClass, key, payload });
  switch (effect.type) {
    // E3.2: provider WRITES that are reconciled first — attempted once per row; an ambiguous result is settled by a
    // provider read (settle_operation_from_evidence) before E3 may emit another attempt as a new row.
    case "stripe.void_payment_intent":
      return base(effect.type, "reconcile_first", `void:${id}:v${versionAfter}`,
        { paymentIntentId: effect.paymentIntentId, attempt: effect.attempt ?? 1, providerIdempotencyKey: effect.idempotencyKey });
    case "stripe.capture_payment_intent":
      return base(effect.type, "reconcile_first", `cap:${id}:v${versionAfter}`,
        { paymentIntentId: effect.paymentIntentId, amountMinor: effect.amountMinor, attempt: effect.attempt ?? 1,
          providerIdempotencyKey: effect.idempotencyKey });
    case "stripe.retrieve_payment_intent":
      return base(effect.type, "read", `read-pi:${id}:v${versionAfter}`, { paymentIntentId: effect.paymentIntentId });
    case "hostaway.lookup_reservation":
      return base(effect.type, "read", `lookup:${id}:v${versionAfter}`, { ref: effect.ref });
    case "hostaway.create_reservation":
      if (effect.forceOverbooking !== false) throw new RepoError("FORCE_OVERBOOKING_REFUSED");
      return base(effect.type, "non_idempotent", `hcreate:${id}`, { ref: effect.ref, forceOverbooking: false });
    case "hostaway.cancel_reservation":
      return base(effect.type, "reconcile_first", `hcancel:${id}:${effect.reservationId}:${effect.attempt ?? 1}`,
        { reservationId: String(effect.reservationId), cancelledBy: effect.cancelledBy, attempt: effect.attempt ?? 1 });
    case "hostaway.retrieve_reservation":
      return base(effect.type, "read", `read-res:${id}:v${versionAfter}`, { reservationId: String(effect.reservationId) });
    case "hostaway.record_offline_charge":
      return base(effect.type, "non_idempotent", `och:${id}:${after.counters.offlineChargeAttempts + 1}`,
        { reservationId: String(effect.reservationId), amountMinor: effect.amountMinor });
    case "guest.notify":
      return base(effect.type, "idempotent", `notify:${id}:${effect.template}`, { template: effect.template });
    case "alert.owner":
      return base(effect.type, "idempotent", `alert:${id}:v${versionAfter}`, { reason: effect.reason });
    case "orchestrator.schedule":
      return null; // scheduling only (intent_work.next_action_at), not an external call
    default:
      throw new RepoError("UNKNOWN_EFFECT", effect.type);
  }
}

async function insertOperations(c, effects, after, now) {
  const ops = [];
  for (const e of effects) {
    const op = effectToOperation(e, after, after.version);
    if (!op) continue;
    const id = randomUUID();
    const r = await c.query(
      `INSERT INTO booking.external_operations (id, intent_id, op_type, idempotency_key, retry_class, state, payload,
         source_version, max_attempts, next_attempt_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9,$9,$9)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [id, after.id, op.opType, op.key, op.retryClass, op.payload, after.version, DB_CONFIG.maxAttempts[op.retryClass], new Date(now)]);
    ops.push({ id: r.rows[0]?.id ?? null, opType: op.opType, key: op.key, retryClass: op.retryClass, inserted: r.rowCount === 1 });
  }
  return ops;
}

async function openCase(c, intentId, kind, openedBy, evidence, now) {
  await c.query(
    `INSERT INTO booking.reconciliation_cases (id, intent_id, kind, status, opened_at, opened_by, evidence)
     VALUES ($1,$2,$3,'open',$4,$5,$6) ON CONFLICT (intent_id, kind) WHERE status = 'open' DO NOTHING`,
    [randomUUID(), intentId, kind, new Date(now), openedBy, evidence]);
}

// E2B.1 (C2/C7): claims are changed only through SECURITY DEFINER functions; the database re-checks every blocker
// (payment attempts, authorizations, reservations, provider operations, open cases) before any release.
// E2B.2 (A): release and purge decisions use PostgreSQL's own clock. No caller can supply "now" for them.
function refuseCallerTime(opts) {
  if (opts && opts.now !== undefined) {
    throw new TypeError("TIME_IS_DATABASE_CONTROLLED: release and purge decisions use the database clock; do not pass now");
  }
}
async function releaseClaimIfSafe(c, intentId, reason) {
  const r = await c.query("SELECT booking.release_claim_if_safe($1, $2) AS ok", [intentId, reason]);
  return r.rows[0].ok === true;
}

/** Ask the database to release the claim; it does so only if nothing is unresolved (database clock). Returns true if released. */
export async function tryReleaseClaim(pool, intentId, opts = {}) {
  refuseCallerTime(opts);
  return withTx(pool, (c) => releaseClaimIfSafe(c, intentId, opts.reason || "SAFE_RELEASE"));
}

/** Why the claim of this intent cannot be released right now, by the database clock (empty = it can). */
export async function claimReleaseBlockers(q, intentId, opts = {}) {
  refuseCallerTime(opts);
  return (await q.query("SELECT booking.claim_release_blockers($1) AS b", [intentId])).rows[0].b;
}

/** Records that must change in the same transaction as the E3 transition. */
async function sideRecords(c, before, after, event, now, ops, openedBy) {
  const t = new Date(now);
  const id = after.id;
  // A money fact is recorded once. A repeat for the SAME intent is a harmless replay; the same provider
  // reference on a DIFFERENT intent is an inconsistency and aborts the whole transition.
  const ledger = async (entry, amount, currency, provider, ref) => {
    const r = await c.query(
      `INSERT INTO booking.payment_ledger (intent_id, entry, amount_minor, currency, provider, provider_ref, source, at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (entry, provider, provider_ref) DO NOTHING`,
      [id, entry, amount, currency, provider, String(ref), openedBy, t]);
    if (r.rowCount === 0) {
      const other = await c.query("SELECT intent_id FROM booking.payment_ledger WHERE entry = $1 AND provider = $2 AND provider_ref = $3",
        [entry, provider, String(ref)]);
      if (other.rows[0] && other.rows[0].intent_id !== id) throw new RepoError("LEDGER_REFERENCE_CONFLICT", entry);
    }
  };

  // payment attempts + money ledger
  if (event.type === "PAYMENT_AUTHORIZED") {
    if (before.status === S.PAYMENT_PENDING && after.status === S.PAYMENT_AUTHORIZED) {
      await c.query(`UPDATE booking.payment_attempts SET status = 'completed', payment_intent_id = $3, livemode = $4, updated_at = $5
                     WHERE intent_id = $1 AND checkout_session_id = $2 AND status <> 'completed'`,
        [id, after.checkout.sessionId, after.payment.paymentIntentId, after.payment.livemode, t]);
      await ledger("authorization_accepted", after.payment.amountMinor, after.price.currency, "stripe", after.payment.paymentIntentId);
      await c.query("SELECT booking.claim_upgrade($1, 'authorized')", [id]);
    } else if (after.status === S.RECONCILIATION_REQUIRED) {
      // money held that this intent did not accept (closed intent, mismatch, second PaymentIntent): record the fact
      const amt = Number.isSafeInteger(event.amountMinor) && event.amountMinor >= 0 ? event.amountMinor : 0;
      const cur = typeof event.currency === "string" ? event.currency.toUpperCase().slice(0, 3) : (after.price?.currency ?? "MXN");
      await ledger("authorization_rejected", amt, cur, "stripe", event.paymentIntentId);
    }
  }
  // C3: both end the attempt only on VERIFIED session expiry (the database refuses 'expired' without that evidence)
  if ((event.type === "CHECKOUT_EXPIRED" || event.type === "PAYMENT_FAILED") && after.checkout) {
    await c.query(`UPDATE booking.payment_attempts SET status = 'expired', updated_at = $3
                   WHERE intent_id = $1 AND checkout_session_id = $2 AND status IN ('open', 'outcome_unknown')`, [id, after.checkout.sessionId, t]);
  }
  if ((event.type === "CAPTURE_SUCCEEDED" || event.type === "RECONCILED_CAPTURE_SUCCEEDED") && after.status === S.PAYMENT_CAPTURED) {
    await ledger("capture_succeeded", after.payment.capturedMinor, after.price.currency, "stripe", after.payment.paymentIntentId);
  }
  if (event.type === "VOID_SUCCEEDED") {
    await ledger("authorization_voided", after.payment.amountMinor, after.price.currency, "stripe", after.payment.paymentIntentId);
  }
  if (event.type === "OFFLINE_CHARGE_RECORDED") {
    await ledger("offline_charge_recorded", after.payment.capturedMinor, after.price.currency, "hostaway", after.offlineChargeId);
  }

  // Hostaway reservation attempts (write-before-send)
  if (event.type === "RESERVATION_DISPATCHED") {
    const create = ops.find((o) => o.opType === "hostaway.create_reservation");
    if (!create || !create.inserted) throw new RepoError("HOSTAWAY_CREATE_ALREADY_RECORDED");
    await c.query(`INSERT INTO booking.hostaway_reservation_attempts (id, intent_id, operation_id, booking_ref, state, dispatched_at, updated_at)
                   VALUES ($1,$2,$3,$4,'dispatched',$5,$5)`, [randomUUID(), id, create.id, after.ref, t]);
  }
  const setAttempt = (state, fromStates, extra = "", params = []) => c.query(
    `UPDATE booking.hostaway_reservation_attempts SET state = $2, updated_at = $3${extra} WHERE intent_id = $1 AND state = ANY($4)`,
    [id, state, t, fromStates, ...params]);
  if (event.type === "RESERVATION_SUCCEEDED" && after.reservation) {
    await setAttempt("succeeded", ["dispatched"], ", hostaway_reservation_id = coalesce(hostaway_reservation_id, $5)", [after.reservation.reservationId]);
  }
  if (event.type === "RECONCILED_RESERVATION_FOUND" && after.reservation) {
    await setAttempt("reconciled_found", ["dispatched", "outcome_unknown", "escalated"], ", hostaway_reservation_id = coalesce(hostaway_reservation_id, $5)", [after.reservation.reservationId]);
  }
  if (event.type === "RESERVATION_FAILED" && before.dispatch) await setAttempt("refused", ["dispatched"]);
  if (after.status === S.RESERVATION_UNKNOWN && before.status !== S.RESERVATION_UNKNOWN) await setAttempt("outcome_unknown", ["dispatched"]);
  if (after.status === S.RECONCILIATION_REQUIRED && before.dispatch && !before.reservation) await setAttempt("escalated", ["dispatched", "outcome_unknown"]);
  if (before.status === S.RESERVATION_PENDING && after.status !== S.RESERVATION_PENDING) {
    // a create that was recorded but never claimed for sending must never be sent later
    await c.query(`UPDATE booking.external_operations SET state = 'superseded', updated_at = $2
                   WHERE intent_id = $1 AND op_type = 'hostaway.create_reservation' AND state = 'pending'`, [id, t]);
  }

  // A Checkout Session create that was queued but never handed to a sender cannot have reached Stripe: once the
  // intent is closed, retire it so it is never sent, and record that its attempt was not created.
  if (TERMINAL.has(after.status) && !TERMINAL.has(before.status)) {
    const sup = await c.query(`UPDATE booking.external_operations SET state = 'superseded', updated_at = $2
                               WHERE intent_id = $1 AND op_type = 'stripe.create_checkout_session' AND state = 'pending' AND dispatched_at IS NULL
                               RETURNING payload ->> 'paymentAttemptId' AS aid`, [id, t]);
    for (const r of sup.rows) {
      await c.query("UPDATE booking.payment_attempts SET status = 'not_created', updated_at = $2 WHERE id = $1::uuid AND status = 'creating'", [r.aid, t]);
    }
  }

  // inventory claim
  if (after.reservation && !before.reservation) {
    await c.query("SELECT booking.claim_upgrade($1, 'reserved')", [id]);
  }
  if (CLAIM_RELEASE_STATES.has(after.status) && after.status !== before.status) {
    await releaseClaimIfSafe(c, id, `INTENT_${after.status.toUpperCase()}`);
  }

  // reconciliation cases
  if (after.status === S.RECONCILIATION_REQUIRED && before.status !== S.RECONCILIATION_REQUIRED) {
    await openCase(c, id, after.reasonCode || "RECONCILIATION_REQUIRED", openedBy, {
      fromState: before.status, eventType: event.type,
      paymentIntentId: after.payment?.paymentIntentId ?? (typeof event.paymentIntentId === "string" ? event.paymentIntentId : null),
      reservationId: after.reservation?.reservationId ?? null
    }, now);
  }
  // RESOLVE: the database consumes the owner resolution and closes the cases (booking.intents_safety_guard)

  // work schedule (not versioned)
  const idle = TERMINAL.has(after.status) || after.status === S.RECONCILIATION_REQUIRED;
  await c.query("UPDATE booking.intent_work SET next_action_at = $2 WHERE intent_id = $1", [id, idle ? null : t]);
}

async function guardEvent(pool, intentId, event) {
  // R1: until E4 proves Hostaway lookup reliability, "not found" is never proof of non-creation.
  if (event.type === "RECONCILED_RESERVATION_ABSENT" && event.authoritative === true) return "ABSENCE_NOT_AUTHORITATIVE_UNTIL_E4";
  // C4: owner decisions enter only as a persisted resolution (applyResolution builds the event); never as booleans.
  if (event.type === "RESOLVE" && !event.resolutionId) return "RESOLUTION_REQUIRED";
  // Ambiguous Hostaway payment recording: a retry is allowed only after the previous attempt is DEFINITELY failed.
  if (event.type === "OFFLINE_CHARGE_FAILED") {
    const r = await pool.query(`SELECT state FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'hostaway.record_offline_charge'
                                ORDER BY source_version DESC LIMIT 1`, [intentId]);
    if (!r.rows[0] || r.rows[0].state !== "failed_definite") return "OFFLINE_CHARGE_OUTCOME_UNRESOLVED";
  }
  // Hostaway payment recording is confirmed only by a succeeded (or owner-resolved) operation with the same charge id.
  if (event.type === "OFFLINE_CHARGE_RECORDED") {
    const r = await pool.query(`SELECT state, result_ref FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'hostaway.record_offline_charge'
                                ORDER BY source_version DESC LIMIT 1`, [intentId]);
    if (!r.rows[0] || r.rows[0].state !== "succeeded" || r.rows[0].result_ref !== String(event.chargeId)) return "OFFLINE_CHARGE_NOT_VERIFIED";
  }
  return null;
}

// Safety refusals raised by the E2B.1 triggers, surfaced as result codes.
export const DB_SAFETY_CODES = Object.freeze(["CLAIM_REQUIRED", "CHECKOUT_EXPIRY_NOT_VERIFIED", "VOID_NOT_VERIFIED", "CANCELLATION_NOT_VERIFIED",
  "AUTHORIZATION_NOT_VERIFIED_SETTLED", "AMBIGUOUS_RESULT_NOT_DEFINITE",
  "RESOLUTION_REQUIRED", "RESOLUTION_MISMATCH", "CLAIM_RELEASE_BLOCKED", "PRIOR_RECORDING_NOT_VERIFIED_FAILED", "REFUSAL_NOT_CATALOGUED",
  "OWNER_RESOLUTION_REQUIRED", "NOT_A_CATALOGUED_DEFINITE_REFUSAL"]);
export function dbSafetyCode(e) {
  if (!e || !["23514", "42501"].includes(e.code)) return null;
  const m = /^([A-Z_]+)/.exec(e.message || "");
  return m && DB_SAFETY_CODES.includes(m[1]) ? m[1] : null;
}

/**
 * applyEvent(pool, intentId, event, { now, actor, workerId, config, inTx, hooks })
 *   -> { ok:true, duplicate, intent, effects, operations, casRetries } | { ok:false, error, intent? }
 * inTx(client, { before, after, operations }) runs inside the same short transaction (no network allowed).
 * hooks.afterLoad / hooks.beforeCommit exist for deterministic concurrency tests only.
 */
export async function applyEvent(pool, intentId, event, opts = {}) {
  const { now, actor = "system", workerId = null, config = {}, inTx = null, hooks = {} } = opts;
  if (!Number.isFinite(now)) throw new TypeError("applyEvent: now required");
  const e3config = { ...config, lookupAbsenceIsAuthoritative: false }; // enforced until E4 (R1)
  const blocked = await guardEvent(pool, intentId, event);
  if (blocked) return { ok: false, error: blocked };
  const eventId = event.id != null ? String(event.id) : null;

  for (let attempt = 0; attempt <= DB_CONFIG.casMaxRetries; attempt++) {
    const row = await loadIntentRow(pool, intentId);
    if (!row) return { ok: false, error: "NOT_FOUND" };
    if (eventId) {
      const seen = await pool.query("SELECT 1 FROM booking.intent_applied_events WHERE intent_id = $1 AND event_id = $2", [intentId, eventId]);
      if (seen.rowCount) return { ok: true, duplicate: true, intent: rowToIntent(row), effects: [], operations: [], casRetries: attempt };
    }
    const before = rowToIntent(row);
    const res = transition(before, event, { now, config: e3config });
    if (hooks.afterLoad) await hooks.afterLoad(attempt);
    if (!res.ok) return { ok: false, error: res.error, intent: before };
    if (res.duplicate) return { ok: true, duplicate: true, intent: before, effects: [], operations: [], casRetries: attempt };
    const after = res.intent;
    const openedBy = eventId || `${event.type}:v${after.version}`;
    const effects = res.effects; // E3.2: E3 itself emits every recovery action (no database-side additions)

    const client = await pool.connect();
    let outcome;
    try {
      await client.query("BEGIN");
      // Lock order: the intent row FIRST (version-checked). Concurrent writers for the same intent queue here and the
      // loser sees a newer version, instead of interleaving foreign-key share locks with the update (deadlock).
      const lock = await client.query("SELECT 1 FROM booking.intents WHERE id = $1 AND version = $2 FOR NO KEY UPDATE", [intentId, before.version]);
      if (lock.rowCount === 0) { await client.query("ROLLBACK"); outcome = { lost: true }; }
      if (!outcome && eventId) {
        const ins = await client.query(
          `INSERT INTO booking.intent_applied_events (intent_id, event_id, event_type, applied_version, applied_at)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [intentId, eventId, event.type, after.version, new Date(now)]);
        if (ins.rowCount === 0) { await client.query("ROLLBACK"); outcome = { duplicate: true }; }
      }
      if (!outcome) {
        const r = intentToRow(after);
        const sets = MUTABLE_COLUMNS.map((col, i) => `${col} = $${i + 3}`).join(", ");
        const upd = await client.query(`UPDATE booking.intents SET ${sets} WHERE id = $1 AND version = $2`,
          [intentId, before.version, ...MUTABLE_COLUMNS.map((col) => r[col])]);
        if (upd.rowCount === 0) { await client.query("ROLLBACK"); outcome = { lost: true }; }
      }
      if (!outcome) {
        await client.query(
          `INSERT INTO booking.intent_transitions (intent_id, version_after, from_state, to_state, event_type, event_id, reason_code, actor, worker_id, at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [intentId, after.version, before.status, after.status, event.type, eventId, after.reasonCode !== before.reasonCode ? after.reasonCode : null,
            actor, workerId, new Date(now)]);
        const operations = await insertOperations(client, effects, after, now);
        await sideRecords(client, before, after, event, now, operations, openedBy);
        if (inTx) await inTx(client, { before, after, operations });
        if (hooks.beforeCommit) await hooks.beforeCommit(attempt);
        await client.query("COMMIT");
        outcome = { done: true, operations };
      }
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      if (e.code === "40P01" || e.code === "40001") outcome = { lost: true }; // deadlock/serialization victim: reload, retry
      else if (e.code === "23505" && /one_open_offline_charge/.test(e.constraint || "")) return { ok: false, error: "OFFLINE_CHARGE_OUTCOME_UNRESOLVED" };
      else if (dbSafetyCode(e)) return { ok: false, error: dbSafetyCode(e) };
      else if (e.code === "23505" && /one_hostaway_create|hostaway_reservation_attempts_intent_id/.test(e.constraint || "")) return { ok: false, error: "HOSTAWAY_CREATE_ALREADY_RECORDED" };
      else if (e.code === "23505" && /one_open_provider_write/.test(e.constraint || "")) return { ok: false, error: "PRIOR_PROVIDER_WRITE_UNRESOLVED" };
      else throw e;
    } finally {
      client.release();
    }
    if (outcome.duplicate) return { ok: true, duplicate: true, intent: rowToIntent(await loadIntentRow(pool, intentId)), effects: [], operations: [], casRetries: attempt };
    if (outcome.done) return { ok: true, duplicate: false, intent: after, effects, operations: outcome.operations, casRetries: attempt };
    // lost the version race: reload and re-evaluate against the winner's state
  }
  return { ok: false, error: "CAS_CONTENTION" };
}

// ---------------------------------------------------------------------------------------------
// Guest details (the only personal data) — stored in the same transaction as E3 DETAILS_COLLECTED.
const NAME_RE = /^[^\u0000-\u001f<>]{1,100}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^[+0-9 ()-]{6,32}$/;

export function validateGuest(g) {
  if (!g || typeof g !== "object") return "GUEST_INVALID";
  const allowed = new Set(["firstName", "lastName", "email", "phone"]);
  if (Object.keys(g).some((k) => !allowed.has(k))) return "GUEST_UNKNOWN_FIELD";
  if (typeof g.firstName !== "string" || !NAME_RE.test(g.firstName.trim())) return "GUEST_FIRST_NAME";
  if (typeof g.lastName !== "string" || !NAME_RE.test(g.lastName.trim())) return "GUEST_LAST_NAME";
  if (typeof g.email !== "string" || g.email.length > 254 || !EMAIL_RE.test(g.email.trim())) return "GUEST_EMAIL";
  if (g.phone != null && (typeof g.phone !== "string" || !PHONE_RE.test(g.phone.trim()))) return "GUEST_PHONE";
  return null;
}

export async function collectGuestDetails(pool, intentId, guest, { now, termsVersion, config } = {}) {
  const bad = validateGuest(guest);
  if (bad) return { ok: false, error: bad };
  if (typeof termsVersion !== "string" || !termsVersion || termsVersion.length > 40) return { ok: false, error: "TERMS_VERSION_REQUIRED" };
  return applyEvent(pool, intentId, { type: "DETAILS_COLLECTED" }, {
    now, config, actor: "guest",
    inTx: (c) => c.query(
      `INSERT INTO booking.intent_guests (intent_id, first_name, last_name, email, phone, terms_version, terms_accepted_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
      [intentId, guest.firstName.trim(), guest.lastName.trim(), guest.email.trim().toLowerCase(), guest.phone ? guest.phone.trim() : null,
        termsVersion, new Date(now)])
  });
}

/**
 * Delete guest data that has passed the (provisional, configurable) retention periods. The database decides what is
 * due with its own clock (E2B.2); callers cannot supply "now". Returns rows deleted.
 */
export async function purgeGuestData(pool, opts) {
  refuseCallerTime(opts);
  const { retention } = opts;
  const r = await pool.query("SELECT booking.purge_guest_data($1, $2) AS n", [retention.failedAttemptDays, retention.postCheckoutDays]);
  return r.rows[0].n;
}

// ---------------------------------------------------------------------------------------------
// Pay step: claim the nights and record the payment attempt BEFORE any Stripe call (O4).
export async function beginPayStep(pool, intentId, opts = {}) {
  // Two transactions inserting overlapping claims at the same instant can each wait for the other inside the
  // exclusion check; PostgreSQL aborts one (40P01). The victim retries and then sees the committed claim.
  for (let i = 0; ; i++) {
    try { return await beginPayStepOnce(pool, intentId, opts); }
    catch (e) { if ((e.code === "40P01" || e.code === "40001") && i < DB_CONFIG.casMaxRetries) continue; throw e; }
  }
}

async function beginPayStepOnce(pool, intentId, { now, cfg = DB_CONFIG } = {}) {
  const t = new Date(now);
  try {
    return await withTx(pool, async (c) => {
      const row = await loadIntentRow(c, intentId, { forUpdate: true }); // short row lock: serialises with expiry/transitions
      if (!row) return { ok: false, error: "NOT_FOUND" };
      if (row.state !== S.DETAILS_COLLECTED) return { ok: false, error: "NOT_READY_FOR_PAYMENT", state: row.state };
      if (!(t < row.quote_expires_at)) return { ok: false, error: "QUOTE_EXPIRED" };
      const existing = await c.query("SELECT * FROM booking.payment_attempts WHERE intent_id = $1 AND status = ANY($2) ORDER BY attempt DESC LIMIT 1",
        [intentId, UNRESOLVED_PAYMENT_ATTEMPT]);
      if (existing.rows[0]) {
        // E2B.2 (B): a create whose outcome is unknown is reconciled first; no further create is ever requested for it
        if (existing.rows[0].status === "outcome_unknown") return { ok: false, error: "CHECKOUT_CREATE_UNRESOLVED", attempt: existing.rows[0] };
        return { ok: true, reused: true, attempt: existing.rows[0] };
      }
      const claim = await c.query("SELECT id FROM booking.inventory_claims WHERE intent_id = $1 AND released_at IS NULL", [intentId]);
      if (!claim.rows[0]) {
        await c.query(`INSERT INTO booking.inventory_claims (intent_id, listing_id, stay, kind, claimed_at, review_after)
                       VALUES ($1,$2,daterange($3::date,$4::date,'[)'),'checkout',$5,$6)`,
          [intentId, row.listing_id, row.from_date_s, row.to_date_s, t, new Date(now + cfg.claimReviewAfterMs)]);
      }
      const n = (await c.query("SELECT coalesce(max(attempt),0)::int + 1 AS n FROM booking.payment_attempts WHERE intent_id = $1", [intentId])).rows[0].n;
      const attemptId = randomUUID();
      const key = `cs:${intentId}:${n}`;
      const planned = new Date(now + cfg.checkoutSessionTtlMs);
      const a = await c.query(
        `INSERT INTO booking.payment_attempts (id, intent_id, attempt, idempotency_key, status, amount_minor, currency,
           planned_session_expires_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'creating',$5,$6,$7,$8,$8) RETURNING *`,
        [attemptId, intentId, n, key, row.final_total_minor, row.currency, planned, t]);
      await c.query(
        `INSERT INTO booking.external_operations (id, intent_id, op_type, idempotency_key, retry_class, state, payload, source_version,
           max_attempts, next_attempt_at, created_at, updated_at)
         VALUES ($1,$2,'stripe.create_checkout_session',$3,'reconcile_first','pending',$4,$5,$6,$7,$7,$7)`,
        [randomUUID(), intentId, `cs-op:${intentId}:${n}`,
          { providerIdempotencyKey: key, amountMinor: num(row.final_total_minor), currency: row.currency, expiresAt: planned.toISOString(), paymentAttemptId: attemptId },
          row.version, cfg.maxAttempts.reconcile_first, t]);
      return { ok: true, reused: false, attempt: a.rows[0] };
    });
  } catch (e) {
    if (e.code === "23P01") return { ok: false, error: "DATES_CLAIMED" }; // another maraVilla guest holds overlapping nights
    throw e;
  }
}

/** Record the Checkout Session Stripe returned (version-independent evidence first), then E3 CHECKOUT_PREPARED. */
export async function recordCheckoutSession(pool, intentId, attemptId, { sessionId, expiresAt, now, config, cfg = DB_CONFIG }) {
  const t = new Date(now);
  await withTx(pool, async (c) => {
    const r = await c.query(`UPDATE booking.payment_attempts SET status = 'open', checkout_session_id = $3, session_expires_at = $4, updated_at = $5
                             WHERE id = $1 AND intent_id = $2 AND status IN ('creating', 'outcome_unknown')`,
      [attemptId, intentId, sessionId, new Date(expiresAt), t]);
    if (r.rowCount === 0) throw new RepoError("PAYMENT_ATTEMPT_NOT_OPENABLE");
    await c.query("SELECT booking.claim_schedule_review($1, $2, false)", [intentId, new Date(expiresAt + cfg.claimReviewMarginMs)]);
  });
  return applyEvent(pool, intentId, { type: "CHECKOUT_PREPARED", id: `cs-prepared:${sessionId}`, sessionId }, { now, config, actor: "guest" });
}

// ---------------------------------------------------------------------------------------------
// Claim review: a claim past review_after is re-checked with PROVIDER EVIDENCE. Time alone never releases it.
export async function listClaimsDueForReview(pool, { now, limit = 50 }) {
  const r = await pool.query(
    `SELECT c.id AS claim_id, c.intent_id, c.kind, c.review_count, i.state,
            (SELECT json_agg(json_build_object('id', a.id, 'status', a.status, 'sessionId', a.checkout_session_id) ORDER BY a.attempt)
               FROM booking.payment_attempts a WHERE a.intent_id = c.intent_id AND a.status = ANY($3)) AS unresolved_attempts,
            booking.claim_release_blockers(c.intent_id) AS blockers
       FROM booking.inventory_claims c JOIN booking.intents i ON i.id = c.intent_id
      WHERE c.released_at IS NULL AND c.review_after <= $1 ORDER BY c.review_after LIMIT $2`,
    [new Date(now), limit, UNRESOLVED_PAYMENT_ATTEMPT]);
  return r.rows;
}

/** Keep the claim, review again later; after maxClaimReviews open a reconciliation case (claim still held). */
export async function deferClaimReview(pool, claimId, { now, reason = "EVIDENCE_MISSING", cfg = DB_CONFIG }) {
  return withTx(pool, async (c) => {
    const claim = (await c.query("SELECT intent_id FROM booking.inventory_claims WHERE id = $1 AND released_at IS NULL", [claimId])).rows[0];
    if (!claim) return { ok: false, error: "CLAIM_NOT_ACTIVE" };
    const n = (await c.query("SELECT booking.claim_schedule_review($1, $2, true) AS n", [claim.intent_id, new Date(now + cfg.claimReviewBackoffMs)])).rows[0].n;
    if (n >= cfg.maxClaimReviews) {
      await openCase(c, claim.intent_id, "CLAIM_UNRESOLVED", `claim:${claimId}`, { claimId: String(claimId), reason }, now);
    }
    return { ok: true, reviewCount: n };
  });
}

/**
 * Apply PERSISTED Stripe evidence about a Checkout Session (a provider_evidence row recorded from a verified read).
 *   status 'expired'  -> attempt expired; E3 CHECKOUT_EXPIRED if the intent still waits on it; claim released only if
 *                        the database finds nothing else unresolved
 *   status 'open'     -> review again after the session's expiry (claim kept)
 *   status 'complete' -> not handled here: the caller applies the verified E3 PAYMENT_AUTHORIZED
 */
export async function applyCheckoutSessionEvidence(pool, intentId, attemptId, evidenceId, { now, config, cfg = DB_CONFIG }) {
  const ev = (await pool.query("SELECT * FROM booking.provider_evidence WHERE id = $1 AND intent_id = $2 AND kind = 'checkout_session'",
    [evidenceId, intentId])).rows[0];
  if (!ev) return { ok: false, error: "EVIDENCE_NOT_FOUND" };
  const a = (await pool.query("SELECT * FROM booking.payment_attempts WHERE id = $1 AND intent_id = $2", [attemptId, intentId])).rows[0];
  if (!a) return { ok: false, error: "ATTEMPT_NOT_FOUND" };
  if (a.checkout_session_id && a.checkout_session_id !== ev.external_ref) return { ok: false, error: "EVIDENCE_SESSION_MISMATCH" };
  if (ev.status === "complete") return { ok: false, error: "APPLY_PAYMENT_AUTHORIZED" };
  if (ev.status === "open") {
    const until = a.session_expires_at ? new Date(a.session_expires_at).getTime() + cfg.claimReviewMarginMs : now + cfg.claimReviewBackoffMs;
    await pool.query("SELECT booking.claim_schedule_review($1, $2, false)", [intentId, new Date(until)]);
    return { ok: true, released: false, deferred: true };
  }
  const intent = await loadIntent(pool, intentId);
  if (intent.status === S.PAYMENT_PENDING && intent.checkout?.sessionId === ev.external_ref) {
    const r = await applyEvent(pool, intentId, { type: "CHECKOUT_EXPIRED", id: `cs-expired:${ev.external_ref}` }, { now, config, actor: "reconciler" });
    if (!r.ok) return r;
  }
  const released = await withTx(pool, async (c) => {
    await c.query(`UPDATE booking.payment_attempts SET checkout_session_id = coalesce(checkout_session_id, $2), status = 'expired', updated_at = $3
                   WHERE id = $1 AND status IN ('creating', 'open', 'outcome_unknown')`, [attemptId, ev.external_ref, new Date(now)]);
    const row = await loadIntentRow(c, intentId, { forUpdate: true });
    if (!CLAIM_RELEASE_STATES.has(row.state)) return false; // still in progress
    return releaseClaimIfSafe(c, intentId, "CHECKOUT_EXPIRED");
  });
  return { ok: true, released };
}

/** O5 (provisional): confirmed bookings release their claim once check-out day (Mexico City) is reached, by the database clock. */
export async function releaseCompletedStayClaims(pool, opts = {}) {
  refuseCallerTime(opts);
  return (await pool.query("SELECT booking.release_completed_stays() AS n")).rows[0].n;
}

/** Build and apply the E3 RESOLVE event from a persisted OWNER RESOLUTION (never from caller-supplied booleans). */
export async function applyResolution(pool, intentId, resolutionId, { now, config } = {}) {
  const r = (await pool.query("SELECT * FROM booking.reconciliation_resolutions WHERE id = $1 AND intent_id = $2", [resolutionId, intentId])).rows[0];
  if (!r) return { ok: false, error: "RESOLUTION_NOT_FOUND" };
  if (r.consumed_at) return { ok: false, error: "RESOLUTION_ALREADY_USED" };
  const row = await loadIntentRow(pool, intentId);
  let outcome, evidence;
  if (r.decision === "intent_confirmed") {
    outcome = "confirmed";
    evidence = { reservationId: r.result_ref, capturedMinor: num(row.final_total_minor), currency: row.currency };
  } else if (r.decision === "intent_released") {
    outcome = "released"; evidence = { authorizationVoided: true, noReservation: true };      // derived from verified DB facts
  } else if (r.decision === "intent_cancelled") {
    outcome = "cancelled"; evidence = { reservationCancelled: true, notCaptured: true };       // derived from verified DB facts
  } else return { ok: false, error: "NOT_AN_INTENT_RESOLUTION" };
  return applyEvent(pool, intentId, { type: "RESOLVE", id: `resolution:${r.id}`, resolutionId: r.id, outcome, evidence, resolvedBy: r.resolver },
    { now, config, actor: "admin" });
}

// ---------------------------------------------------------------------------------------------
// Hostaway evidence (version-independent: recorded even if the intent has moved on, e.g. after lease expiry)
export async function recordHostawayCreateResult(pool, intentId, { httpStatus = null, refusalCode = null, reservation = null }, { now }) {
  const r = await pool.query(
    `UPDATE booking.hostaway_reservation_attempts
        SET responded_at = $2, http_status = $3, refusal_code = $4,
            hostaway_reservation_id = coalesce(hostaway_reservation_id, $5),
            verified_listing_id = $6, verified_from = $7::date, verified_to = $8::date, verified_total_minor = $9, updated_at = $2
      WHERE intent_id = $1 AND responded_at IS NULL`,
    [intentId, new Date(now), httpStatus, refusalCode, reservation ? String(reservation.reservationId) : null,
      reservation?.listingId ?? null, reservation?.from ?? null, reservation?.to ?? null, reservation?.totalMinor ?? null]);
  return { recorded: r.rowCount === 1 };
}

export async function recordHostawayLookup(pool, intentId, { result }, { now }) {
  if (!["found", "not_found", "error"].includes(result)) throw new TypeError("lookup result");
  await pool.query(`UPDATE booking.hostaway_reservation_attempts SET lookup_count = lookup_count + 1, last_lookup_at = $2,
                    last_lookup_result = $3, updated_at = $2 WHERE intent_id = $1`, [intentId, new Date(now), result]);
}

// ---------------------------------------------------------------------------------------------
// Worker leases: an interrupted reservation worker is recovered through E3 RECOVER_INTERRUPTED.
// With no dispatch -> back to payment_authorized (nothing was sent). With a dispatch -> reservation_unknown (never re-create).
export async function recoverInterruptedReservations(pool, { now, config, limit = 20 }) {
  const r = await pool.query(`SELECT id, version FROM booking.intents WHERE state = 'reservation_pending' AND lease_until < $1 LIMIT $2`,
    [new Date(now), limit]);
  const out = [];
  for (const row of r.rows) {
    const res = await applyEvent(pool, row.id, { type: "RECOVER_INTERRUPTED", id: `recover:${row.id}:v${row.version}` }, { now, config, actor: "reconciler" });
    out.push({ intentId: row.id, ok: res.ok, status: res.intent?.status, error: res.error });
  }
  return out;
}

/** Pick an intent that needs work (short claim on intent_work; never bumps the E3 version). */
export async function claimIntentWork(pool, { workerId, now, leaseMs = 60000, states }) {
  const r = await pool.query(
    `WITH c AS (
       SELECT w.intent_id FROM booking.intent_work w JOIN booking.intents i ON i.id = w.intent_id
        WHERE w.next_action_at <= $2 AND (w.work_lease_until IS NULL OR w.work_lease_until < $2) AND i.state = ANY($4)
        ORDER BY w.next_action_at FOR UPDATE OF w SKIP LOCKED LIMIT 1)
     UPDATE booking.intent_work w SET work_worker_id = $1, work_lease_until = $3 FROM c WHERE w.intent_id = c.intent_id
     RETURNING w.intent_id`,
    [workerId, new Date(now), new Date(now + leaseMs), states]);
  return r.rows[0]?.intent_id ?? null;
}
