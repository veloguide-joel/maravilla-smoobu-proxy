// test/db/rate-window.mjs — TEST-ONLY support for bursts against booking.rate_limit_hit (0006).
//
// 0006 counts hits in FIXED windows: window_start = floor(epoch(statement_timestamp()) / W) * W, and a hit in a newer
// window deletes the bucket's older windows. A burst that straddles a window boundary is therefore split, and a
// limit test can see "never throttled" without any defect. These helpers make such tests boundary-aware WITHOUT
// weakening them:
//   - planBurst() (pure) decides, from the DATABASE clock, whether a burst of a bounded duration fits in the rest of
//     the current window; if not, it waits (bounded, <= maxWaitMs) until just past the boundary.
//   - assertCompleteWindow() then proves, from the real table, that the scoped bucket has exactly ONE window row,
//     equal to the planned window, holding exactly the expected hits. A crossed burst fails loudly; it is never
//     re-interpreted, re-run until green, or skipped.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

/** Window start (ms) of the fixed window containing `ms`, exactly as 0006 computes it (seconds granularity). */
export function windowStartMs(ms, windowSeconds) {
  if (!Number.isFinite(ms) || !Number.isSafeInteger(windowSeconds) || windowSeconds <= 0) throw new TypeError("bad window input");
  const w = windowSeconds * 1000;
  return Math.floor(ms / w) * w;
}

/**
 * planBurst({ dbNowMs, windowSeconds, burstBudgetMs, maxWaitMs, landingMarginMs })
 *   -> { waitMs, windowStartMs }   the burst starts after waitMs, inside the window starting at windowStartMs
 * Throws if the plan cannot fit (budget >= window, or the needed wait exceeds maxWaitMs): the caller then FAILS.
 */
export function planBurst({ dbNowMs, windowSeconds, burstBudgetMs, maxWaitMs = 60_000, landingMarginMs = 1000 }) {
  const w = windowSeconds * 1000;
  if (!(burstBudgetMs > 0) || burstBudgetMs + landingMarginMs >= w) throw new RangeError("burst budget does not fit one window");
  const start = windowStartMs(dbNowMs, windowSeconds);
  const remaining = start + w - dbNowMs;
  if (remaining > burstBudgetMs) return { waitMs: 0, windowStartMs: start };
  const waitMs = remaining + landingMarginMs;
  if (waitMs > maxWaitMs) throw new RangeError(`boundary wait ${waitMs} ms exceeds the ${maxWaitMs} ms bound`);
  return { waitMs, windowStartMs: start + w };
}

/** The opaque bucket key exactly as lib/checkout/intent-api-http.js builds it (salted HMAC; no raw address or token). */
export const bucketKey = (salt, scope, value) => `${scope}:${createHmac("sha256", salt).update(`${scope}|${value}`).digest("hex")}`;

/** The database clock in ms (statement_timestamp, the clock 0006 uses). */
export async function dbNowMs(q) {
  return Number((await q.query("SELECT (extract(epoch FROM statement_timestamp()) * 1000)::float8 AS ms")).rows[0].ms);
}

/** Wait (bounded) until a burst of `burstBudgetMs` fits one complete window of `windowSeconds`; returns the planned window. */
export async function enterCompleteWindow(q, { windowSeconds, burstBudgetMs, maxWaitMs = 60_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const plan = planBurst({ dbNowMs: await dbNowMs(q), windowSeconds, burstBudgetMs, maxWaitMs });
  if (plan.waitMs > 0) await sleep(plan.waitMs);
  const now = await dbNowMs(q);
  assert.equal(windowStartMs(now, windowSeconds), plan.windowStartMs, "the burst did not start in the planned window");
  return { windowStartMs: plan.windowStartMs, startedAtMs: now, deadlineMs: now + burstBudgetMs };
}

/** After the burst: the scoped bucket holds exactly ONE window row = the planned one, with exactly `hits` hits. */
export async function assertCompleteWindow(ownerQ, key, { windowStartMs: planned, hits, label, deadlineMs }) {
  const rows = (await ownerQ.query(
    "SELECT (extract(epoch FROM window_start) * 1000)::float8 AS ws, hits FROM booking.api_rate_limits WHERE bucket = $1 ORDER BY window_start", [key])).rows
    .map((r) => ({ ws: Number(r.ws), hits: Number(r.hits) }));
  assert.deepEqual(rows, [{ ws: planned, hits }],
    `${label}: the burst must land in ONE complete window (planned ${new Date(planned).toISOString()}); a different or split window means it crossed a boundary`);
  if (deadlineMs !== undefined) assert.ok((await dbNowMs(ownerQ)) <= deadlineMs, `${label}: the burst exceeded its time budget`);
}
