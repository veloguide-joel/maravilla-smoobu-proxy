// db/lib/webhooks.js — Stage E2B. Permanent Stripe webhook event de-duplication.
// Only call AFTER the Stripe signature has been verified on the raw body (stage E5). No payload is stored.
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
