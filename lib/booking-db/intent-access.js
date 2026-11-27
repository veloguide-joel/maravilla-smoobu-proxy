// lib/booking-db/intent-access.js — Stage E6 (offline). Bearer-token lookup and shared rate limits for the intent API.
// Reads only, plus the SECURITY DEFINER booking.rate_limit_hit() of migration 0006 (database clock, shared by every worker).

/** The intent whose access_token_hash equals this 32-byte SHA-256 digest (null if none). */
export async function findIntentIdByTokenHash(q, tokenHash) {
  if (!Buffer.isBuffer(tokenHash) || tokenHash.length !== 32) throw new TypeError("tokenHash must be a 32-byte digest");
  const r = await q.query("SELECT id FROM booking.intents WHERE access_token_hash = $1", [tokenHash]);
  return r.rows[0] ? r.rows[0].id : null;
}

/** M1 (manage booking): the ONE intent with this booking ref whose guest e-mail equals `email` ignoring letter case (null if none or
 *  ambiguous). READ-ONLY; both values are parameters. Used only by the lookup step, after its format checks and rate limits. */
export async function findIntentIdByRefAndEmail(q, ref, email) {
  if (typeof ref !== "string" || typeof email !== "string") throw new TypeError("ref and email must be strings");
  const r = await q.query("SELECT i.id FROM booking.intents i JOIN booking.intent_guests g ON g.intent_id = i.id WHERE i.ref = $1 AND lower(g.email) = lower($2)", [ref, email]);
  return r.rows.length === 1 ? r.rows[0].id : null;
}

/** One hit on a fixed-window bucket ("<scope>:<64 hex>"). true while within the limit. */
export async function rateLimitHit(q, bucket, windowSeconds, limit) {
  const r = await q.query("SELECT booking.rate_limit_hit($1, $2, $3) AS ok", [bucket, windowSeconds, limit]);
  return r.rows[0].ok === true;
}
