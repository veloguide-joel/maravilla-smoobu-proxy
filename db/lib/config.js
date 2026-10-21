// db/lib/config.js — Stage E2B. Tunables for the booking persistence layer (no secrets).

export const DB_CONFIG = Object.freeze({
  checkoutSessionTtlMs: 30 * 60 * 1000,     // expires_at we will ask Stripe for (Checkout minimum); decided before the call
  claimReviewAfterMs: 40 * 60 * 1000,       // pay-step claim with no recorded session becomes DUE FOR REVIEW (not released)
  claimReviewMarginMs: 10 * 60 * 1000,      // review a checkout claim this long after the session's expiry
  claimReviewBackoffMs: 10 * 60 * 1000,     // re-review interval while evidence is missing
  maxClaimReviews: 6,                       // then a reconciliation case is opened (claim still held)
  operationLeaseMs: 60 * 1000,              // outbox worker lease
  casMaxRetries: 3,                         // reload-and-retry when another worker won the version race
  retryBackoffMs: Object.freeze({ read: 30 * 1000, idempotent: 60 * 1000 }),
  maxAttempts: Object.freeze({ read: 10, idempotent: 5, non_idempotent: 1 }),  // non_idempotent = 1 is also enforced by the DB
  releaseConfirmedClaimsAfterCheckout: true // O5 (provisional): a confirmed booking keeps its claim until check-out
});

// O6 — PROVISIONAL guest-data retention, pending legal/privacy review. Always passed explicitly to the purge
// function, so it can change without a migration.
export const PROVISIONAL_RETENTION = Object.freeze({
  failedAttemptDays: 30,   // no booking made: delete guest data this long after the terminal state
  postCheckoutDays: 90,    // booking made: delete guest data this long after check-out
  status: "provisional-pending-legal-privacy-review"
});

/** Retention from environment overrides (BOOKING_RETENTION_FAILED_DAYS / BOOKING_RETENTION_POST_CHECKOUT_DAYS). */
export function retentionFromEnv(env = process.env, base = PROVISIONAL_RETENTION) {
  const pick = (name, fallback) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 3650) throw new RangeError(`${name} must be an integer between 1 and 3650`);
    return n;
  };
  return Object.freeze({
    failedAttemptDays: pick("BOOKING_RETENTION_FAILED_DAYS", base.failedAttemptDays),
    postCheckoutDays: pick("BOOKING_RETENTION_POST_CHECKOUT_DAYS", base.postCheckoutDays),
    status: base.status
  });
}
