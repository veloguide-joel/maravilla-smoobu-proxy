// lib/hostaway.js `retryOnAuth` option (E4): default behaviour unchanged; explicit false disables the single
// 401/403 re-mint retry. Offline: fake global fetch, fake credentials. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";

const calls = [];
let dataStatus = 401;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push({ path: new URL(u).pathname, method: init.method || "GET" });
  if (u.endsWith("/accessTokens")) {
    return new Response(JSON.stringify({ token_type: "Bearer", expires_in: 3600, access_token: `fake-token-${calls.length}` }), { status: 200 });
  }
  return new Response(JSON.stringify({ status: dataStatus === 200 ? "success" : "fail", result: [] }), { status: dataStatus });
};
process.env.HOSTAWAY_ACCOUNT_ID = "fake-account";
process.env.HOSTAWAY_CLIENT_SECRET = "fake-secret";
const { hostawayGet, hostawayPost } = await import("../lib/hostaway.js");
const count = (p) => calls.filter((c) => c.path === p).length;
const reset = () => { calls.length = 0; };

test("default (option omitted): a 401 discards the token, mints once more and retries exactly once", async () => {
  reset(); dataStatus = 401;
  const r = await hostawayGet("/listings/1");
  assert.equal(r.status, 401);
  assert.equal(r.retried, true);
  assert.equal(count("/v1/accessTokens"), 2, "initial mint + one forced re-mint");
  assert.equal(count("/v1/listings/1"), 2, "original + one retry");
});

test("retryOnAuth: true behaves exactly like the default", async () => {
  reset(); dataStatus = 403;
  const r = await hostawayGet("/listings/2", { retryOnAuth: true });
  assert.deepEqual([r.status, r.retried, count("/v1/accessTokens"), count("/v1/listings/2")], [403, true, 1, 2]);
});

test("retryOnAuth: false — GET 401/403 returned as is: no retry, no re-mint, token cache kept", async () => {
  for (const s of [401, 403]) {
    reset(); dataStatus = s;
    const r = await hostawayGet("/listings/3", { retryOnAuth: false });
    assert.deepEqual([r.status, r.retried], [s, false]);
    assert.equal(count("/v1/listings/3"), 1);
    assert.equal(count("/v1/accessTokens"), 0, "cached token reused, never re-minted");
  }
  reset(); dataStatus = 200;
  const ok = await hostawayGet("/listings/3", { retryOnAuth: false });
  assert.deepEqual([ok.status, count("/v1/accessTokens")], [200, 0], "the cache survived the 401/403");
});

test("retryOnAuth: false — POST likewise single attempt; other statuses never retried in any mode", async () => {
  reset(); dataStatus = 401;
  const r = await hostawayPost("/listings/4/calendar/priceDetails", { version: 2 }, { retryOnAuth: false });
  assert.deepEqual([r.status, r.retried, calls.filter((c) => c.method === "POST" && c.path.endsWith("priceDetails")).length], [401, false, 1]);
  for (const s of [429, 500, 503]) {
    for (const opt of [{}, { retryOnAuth: false }]) {
      reset(); dataStatus = s;
      const x = await hostawayGet("/listings/5", opt);
      assert.deepEqual([x.status, count("/v1/listings/5")], [s, 1], `${s} ${JSON.stringify(opt)}`);
    }
  }
});
