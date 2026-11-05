// lib/booking-db/webhooks.js (moved verbatim from db/lib/webhooks.js for packaging, 2026-11-02) — Stage E2B. Permanent Stripe webhook event de-duplication.
// Only call AFTER the Stripe signature has been verified on the raw body (stage E5). No payload is stored.
import { transition } from "../checkout/intent-state.js";
import { rowToIntent, INTENT_SELECT } from "./codec.js";

const EVT_RE = /^evt_[A-Za-z0-9_]{1,200}$/;

/**
 * recordStripeEvent → { shouldProcess, first, status }
 *   first delivery            -> shouldProcess:true,  first:true
 *   retry of an unfinished    -> shouldProcess:true,  first:false (state transitions are de-duplicated per intent)
 *   already processed/ignored -> shouldProcess:false
 * Events whose livemode differs from the database environment are refused and not stored.
 */
export async function recordStripeEvent(pool, ev, { now }) {
  if (!EVT_RE.test(ev.eventId || "")) throw new TypeError("eventId");
  const env = (await pool.query("SELECT environment FROM booking.instance")).rows[0].environment;
  if (ev.livemode !== (env === "live")) return { shouldProcess: false, first: false, status: "refused", error: "LIVEMODE_MISMATCH" };
  const t = new Date(now);
  const ins = await pool.query(
    `INSERT INTO booking.stripe_webhook_events (event_id, event_type, livemode, api_version, stripe_created_at, object_id, intent_id, received_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'received') ON CONFLICT (event_id) DO NOTHING RETURNING status`,
    [ev.eventId, ev.type, ev.livemode, ev.apiVersion ?? null, new Date(ev.createdAt), ev.objectId ?? null, ev.intentId ?? null, t]);
  if (ins.rowCount === 1) return { shouldProcess: true, first: true, status: "received" };
  const r = await pool.query(
    `UPDATE booking.stripe_webhook_events SET attempts = attempts + 1
      WHERE event_id = $1 AND status IN ('received', 'failed_retryable') RETURNING status`, [ev.eventId]);
  if (r.rowCount === 1) return { shouldProcess: true, first: false, status: r.rows[0].status };
  const s = (await pool.query("SELECT status FROM booking.stripe_webhook_events WHERE event_id = $1", [ev.eventId])).rows[0].status;
  return { shouldProcess: false, first: false, status: s };
}

export async function finishStripeEvent(pool, eventId, { status, intentId = null, errorCode = null, now }) {
  if (!["processed", "ignored", "failed_retryable"].includes(status)) throw new TypeError("status");
  const r = await pool.query(
    `UPDATE booking.stripe_webhook_events SET status = $2, processed_at = CASE WHEN $2 = 'failed_retryable' THEN NULL ELSE $5::timestamptz END,
            intent_id = coalesce(intent_id, $3), error_code = $4
      WHERE event_id = $1 AND status IN ('received', 'failed_retryable')`,
    [eventId, status, intentId, errorCode, new Date(now)]);
  return { updated: r.rowCount === 1 };
}

// ---------------------------------------------------------------------------------------------
// E5a (Stripe TEST mode only). Helpers for the signed-webhook handler in lib/checkout/stripe-test-webhook.js.

/**
 * Mark a received event processed INSIDE the transaction that applies its E3 transition (applyEvent inTx), so the
 * de-dup record, the transition and the completion commit together or not at all. Throws if the row is not open.
 */
export async function markStripeEventProcessedInTx(client, eventId, { intentId, now }) {
  const r = await client.query(
    `UPDATE booking.stripe_webhook_events SET status = 'processed', processed_at = $3, intent_id = coalesce(intent_id, $2), error_code = NULL
      WHERE event_id = $1 AND status IN ('received', 'failed_retryable')`, [eventId, intentId, new Date(now)]);
  if (r.rowCount !== 1) {
    const e = new Error("WEBHOOK_EVENT_NOT_OPEN");
    e.code = "WEBHOOK_EVENT_NOT_OPEN";
    throw e;
  }
}

/** The payment attempt bound to a Checkout Session id (null if none). Read-only. */
export async function findAttemptBySession(q, sessionId) {
  const r = await q.query(
    `SELECT id, intent_id, attempt, status, checkout_session_id, session_expires_at, amount_minor, currency
       FROM booking.payment_attempts WHERE checkout_session_id = $1`, [sessionId]);
  return r.rows[0] || null;
}

/** A payment attempt by id (used only to tell "not recorded yet" from "unknown"). Read-only. */
export async function findAttemptById(q, attemptId) {
  const r = await q.query(
    `SELECT id, intent_id, attempt, status, checkout_session_id, amount_minor, currency
       FROM booking.payment_attempts WHERE id = $1::uuid`, [attemptId]);
  return r.rows[0] || null;
}

// ---------------------------------------------------------------------------------------------
// E7: acknowledge a late completed webhook for an authorization that was ALREADY accepted (durably) and then canceled.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AMT = /^[1-9][0-9]{0,15}$/;
const dbInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : typeof v === "string" && AMT.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : null);
const upper = (v) => (typeof v === "string" && /^[A-Za-z]{3}$/.test(v) ? v.toUpperCase() : null);

/**
 * acknowledgeCanceledDuplicate(pool, binding, { now, config?, hooks? })
 *   -> { ok:true, intent } | { ok:false, code, status? }
 * binding = bindCanceledDuplicate(...).binding (pure, from the server reads). ONE short transaction, lock order
 * intents -> payment_attempts -> stripe_webhook_events (the order applyEvent + markStripeEventProcessedInTx use):
 *   1. the intent row FOR SHARE (waits for, and blocks, any concurrent version-locked intent writer, e.g. VOID_SUCCEEDED);
 *   2. the bound payment attempt FOR SHARE, freshly re-read;
 *   3. the CURRENT persisted bindings: payment / session / PaymentIntent / money / TEST on the intent and the completed attempt;
 *   4. durable prior acceptance: a PAYMENT_AUTHORIZED applied under a DIFFERENT event id whose processed webhook record
 *      names this same session, and this event id never applied;
 *   5. E3's own duplicate rule (transition() on the locked intent must answer duplicate) -- no status list is copied here;
 *   6. ONLY this webhook row is marked processed (error_code CANCELED_DUPLICATE). No transition, effect, claim or operation.
 * Refusals roll back and return a code (the caller leaves the event unresolved). A row that is no longer open (another
 * delivery finished it first) returns WEBHOOK_EVENT_NOT_OPEN with its current status. A failed COMMIT throws: never success.
 * Account: the configured TEST account is verified by the caller (verifyAccount) before the reads; the schema has no
 * durable account column on intents or payment_attempts, so no persisted account binding is checked here.
 */
export async function acknowledgeCanceledDuplicate(pool, binding, { now, config = {}, hooks = {} } = {}) {
  if (!Number.isFinite(now)) throw new TypeError("now required");
  const b = binding;
  if (!b || !EVT_RE.test(String(b.eventId)) || !UUID.test(String(b.intentId)) || !UUID.test(String(b.attemptId))
      || typeof b.sessionId !== "string" || typeof b.paymentIntentId !== "string" || dbInt(b.amountMinor) === null || upper(b.currency) === null) {
    return { ok: false, code: "BINDING_INVALID" };
  }
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query("BEGIN");
    const refuse = async (code) => { await client.query("ROLLBACK"); return { ok: false, code }; };
    const row = (await client.query(`${INTENT_SELECT} WHERE id = $1 FOR SHARE`, [b.intentId])).rows[0];
    if (!row) return await refuse("INTENT_NOT_FOUND");
    const at = (await client.query(
      `SELECT id, intent_id, status, checkout_session_id, payment_intent_id, livemode, amount_minor::text AS amount_minor, currency
         FROM booking.payment_attempts WHERE id = $1 FOR SHARE`, [b.attemptId])).rows[0];
    if (hooks.afterLocks) await hooks.afterLocks();
    const intent = rowToIntent(row);
    const pay = intent.payment;
    if (!pay || pay.paymentIntentId !== b.paymentIntentId || pay.livemode !== false) return await refuse("INTENT_PAYMENT_NOT_BOUND");
    if (!intent.checkout || intent.checkout.sessionId !== b.sessionId) return await refuse("INTENT_SESSION_NOT_BOUND");
    if (!intent.price || dbInt(intent.price.finalTotalMinor) !== b.amountMinor || dbInt(pay.amountMinor) !== b.amountMinor
        || upper(intent.price.currency) !== b.currency || upper(pay.currency) !== b.currency) return await refuse("INTENT_MONEY_MISMATCH");
    if (!at || at.intent_id !== b.intentId || at.status !== "completed" || at.checkout_session_id !== b.sessionId
        || at.payment_intent_id !== b.paymentIntentId || at.livemode !== false) return await refuse("ATTEMPT_NOT_BOUND");
    if (dbInt(at.amount_minor) !== b.amountMinor || upper(at.currency) !== b.currency) return await refuse("ATTEMPT_MONEY_MISMATCH");
    const prior = await client.query(
      `SELECT count(*)::int AS n FROM booking.intent_applied_events ae
         JOIN booking.stripe_webhook_events w ON w.event_id = ae.event_id
        WHERE ae.intent_id = $1 AND ae.event_type = 'PAYMENT_AUTHORIZED' AND ae.event_id <> $2
          AND w.intent_id = $1 AND w.status = 'processed' AND w.event_type = 'checkout.session.completed' AND w.object_id = $3`,
      [b.intentId, b.eventId, b.sessionId]);
    if (prior.rows[0].n !== 1) return await refuse("NO_PRIOR_AUTHORIZATION");
    const self = await client.query("SELECT 1 FROM booking.intent_applied_events WHERE intent_id = $1 AND event_id = $2", [b.intentId, b.eventId]);
    if (self.rowCount) return await refuse("EVENT_ALREADY_APPLIED");
    const e3 = transition(intent, { type: "PAYMENT_AUTHORIZED", id: b.eventId, paymentIntentId: b.paymentIntentId }, { now, config });
    if (!e3.ok || e3.duplicate !== true) return await refuse("NOT_AN_E3_DUPLICATE");
    const upd = await client.query(
      `UPDATE booking.stripe_webhook_events SET status = 'processed', processed_at = $3, intent_id = coalesce(intent_id, $2), error_code = 'CANCELED_DUPLICATE'
        WHERE event_id = $1 AND status IN ('received', 'failed_retryable') AND (intent_id IS NULL OR intent_id = $2)`, [b.eventId, b.intentId, new Date(now)]);
    if (upd.rowCount !== 1) {
      const cur = (await client.query("SELECT status FROM booking.stripe_webhook_events WHERE event_id = $1", [b.eventId])).rows[0];
      await client.query("ROLLBACK");
      return { ok: false, code: "WEBHOOK_EVENT_NOT_OPEN", status: cur ? cur.status : null };
    }
    if (hooks.beforeCommit) await hooks.beforeCommit();
    await client.query("COMMIT");
    committed = true;
    return { ok: true, intent };
  } catch (e) {
    if (!committed) await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
