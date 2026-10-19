// The authenticated listing diagnostic keeps its key gate; its description audit view never appears publicly. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";

let calls = 0;
globalThis.fetch = async (url) => {
  calls += 1;
  const u = String(url);
  const json = (s, b) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
  if (u.endsWith("/accessTokens")) return json(200, { token_type: "Bearer", expires_in: 3600, access_token: "fake-token-not-a-secret" });
  const id = Number(u.match(/\/listings\/(\d+)/)?.[1]);
  return json(200, { status: "success", result: { id, name: "Test", personCapacity: 2, currencyCode: "MXN", description: "<p>Clean candidate text for the audit.</p>", listingAmenities: [{ amenityName: "Wireless" }], checkInTimeStart: 15, listingImages: [] } });
};
process.env.HOSTAWAY_ACCOUNT_ID = "fake-account";
process.env.HOSTAWAY_CLIENT_SECRET = "fake-secret";
const { default: handler } = await import("../api/hostaway/listing.js");
const run = async (headers, id = "603564") => { const r = { headers: {}, statusCode: null, body: null }; r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.end = () => r; await handler({ method: "GET", headers, query: { id } }, r); return r; };

test("disabled without HOSTAWAY_DIAG_KEY; 401 without or with a wrong key; no upstream call on a failed gate", async () => {
  delete process.env.HOSTAWAY_DIAG_KEY; calls = 0;
  assert.equal((await run({})).statusCode, 503);
  process.env.HOSTAWAY_DIAG_KEY = "test-only-diag-key";
  assert.equal((await run({})).statusCode, 401);
  assert.equal((await run({ "x-admin-key": "wrong" })).statusCode, 401);
  assert.equal((await run({ "x-admin-key": ["wrong"] })).statusCode, 401);
  assert.equal(calls, 0);
  assert.equal((await run({ "x-admin-key": "test-only-diag-key" }, "999999")).statusCode, 404); // non-pilot id, still no upstream call
  assert.equal(calls, 0);
});

test("with the key, the audit view shows the candidate and that it is not published", async () => {
  process.env.HOSTAWAY_DIAG_KEY = "test-only-diag-key";
  const r = await run({ "x-admin-key": "test-only-diag-key" });
  assert.equal(r.statusCode, 200);
  const pc = JSON.stringify(r.body).match(/"publicCandidate":(\{.*?\})(,"|\})/)?.[1];
  assert.ok(pc && pc.includes("Clean candidate text for the audit.") && pc.includes('"publishedNow":false'), pc);
});
