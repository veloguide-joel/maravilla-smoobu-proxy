// Deterministic synthetic checks for the TEST-ONLY window helper used by the DB rate-limit test
// (test/db/rate-window.mjs). Pure: no database, clock or network. The DB test itself still runs against the real
// booking.rate_limit_hit; this file only pins the helper's boundary arithmetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { windowStartMs, planBurst, bucketKey } from "./db/rate-window.mjs";

const W = 600;                                   // seconds, as DEFAULT_LIMITS
const B = Date.UTC(2026, 10, 6, 4, 40, 0);       // a 600 s boundary (04:40:00Z)

test("windowStartMs: floor to the fixed window, like 0006", () => {
  assert.equal(windowStartMs(B, W), B);
  assert.equal(windowStartMs(B - 1, W), B - W * 1000);
  assert.equal(windowStartMs(B + 599_999, W), B);
  assert.equal(windowStartMs(B + 600_000, W), B + W * 1000);
  assert.throws(() => windowStartMs(NaN, W), TypeError);
  assert.throws(() => windowStartMs(B, 0), TypeError);
});

test("planBurst: no wait when the budget fits; a bounded wait past the boundary when it does not", () => {
  assert.deepEqual(planBurst({ dbNowMs: B + 1000, windowSeconds: W, burstBudgetMs: 20_000 }), { waitMs: 0, windowStartMs: B });
  // 20 s budget, 20.001 s left: fits
  assert.deepEqual(planBurst({ dbNowMs: B + 579_999, windowSeconds: W, burstBudgetMs: 20_000 }), { waitMs: 0, windowStartMs: B });
  // exactly 20 s left: does not fit (strict); wait 20 s + 1 s landing margin into the NEXT window
  assert.deepEqual(planBurst({ dbNowMs: B + 580_000, windowSeconds: W, burstBudgetMs: 20_000 }), { waitMs: 21_000, windowStartMs: B + 600_000 });
  // 1 ms before the boundary (the failing run's situation): wait 1.001 s
  assert.deepEqual(planBurst({ dbNowMs: B - 1, windowSeconds: W, burstBudgetMs: 20_000 }), { waitMs: 1001, windowStartMs: B });
  // bounded: a wait above maxWaitMs, or a budget that cannot fit any window, throws (the caller fails; never loops)
  assert.throws(() => planBurst({ dbNowMs: B + 1000, windowSeconds: W, burstBudgetMs: 599_500 }), RangeError);
  assert.throws(() => planBurst({ dbNowMs: B + 580_000, windowSeconds: W, burstBudgetMs: 20_000, maxWaitMs: 10_000 }), RangeError);
  assert.throws(() => planBurst({ dbNowMs: B, windowSeconds: W, burstBudgetMs: 0 }), RangeError);
});

test("bucketKey: the same salted HMAC shape the handler stores (no raw value)", () => {
  const salt = "s".repeat(40);
  const k = bucketKey(salt, "ip", "192.0.2.99");
  assert.equal(k, `ip:${createHmac("sha256", salt).update("ip|192.0.2.99").digest("hex")}`);
  assert.match(k, /^[a-z_]+:[0-9a-f]{64}$/);
  assert.doesNotMatch(k, /192\.0\.2/);
});
