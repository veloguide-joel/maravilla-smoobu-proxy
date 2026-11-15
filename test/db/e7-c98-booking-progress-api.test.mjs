// C98 — bookingProgress over the REAL intent API handler + core + repo on a disposable PostgreSQL (test/db/harness.mjs); intents built through
// the accepted fixtures (no network, no provider, no worker). The bearer token is bound at creation (fixtures accept accessTokenHash).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { createIntentApiHandler, hashToken } from "../../lib/checkout/intent-api-http.js";
import { ENV_OK } from "../e5a-fixtures.mjs";
import { createApi, createController, createStore, STORE_KEY } from "../../public/checkout-test.js";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });

const ORIGIN = "https://preview.example.invalid";
const ENV = Object.freeze({ ...ENV_OK, MV_CHECKOUT_TEST_API: "enabled", MV_CHECKOUT_ALLOWED_ORIGIN: ORIGIN, MV_CHECKOUT_TEST_LISTINGS: "603566:MXN,606998:USD",
  MV_RATE_LIMIT_SALT: "s".repeat(40), MV_CHECKOUT_TERMS_VERSION: "terms-2026-11", MV_CLIENT_ADDRESS_SOURCE: "x-real-ip" });
const never = (what) => () => { throw new Error(`${what} must not be used by a status read`); };
const handlers = () => {
  const deps = { createPool: () => db.app, loadCore: () => import("../../lib/checkout/intent-api-core.js"), loadAccess: () => import("../../lib/booking-db/intent-access.js"),
    createStripe: never("Stripe"), createHostaway: never("Hostaway"), loadStripe: never("Stripe SDK"), loadHostaway: never("Hostaway client"), now: () => Date.now(), log: () => {}, onError: () => {} };
  return { intents: createIntentApiHandler({ route: "intents", env: ENV, deps }), step: createIntentApiHandler({ route: "step", env: ENV, deps }) };
};
let ipN = 0;
function call(handler, { method = "GET", token, body } = {}) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []); req.method = method; req.url = method === "GET" ? "/api/checkout/intents" : "/api/checkout/intent-step";
  req.headers = { origin: ORIGIN, "x-real-ip": `198.51.100.${(++ipN % 250) + 1}`, ...(method === "POST" ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const res = { statusCode: 0, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.raw = b || ""; this.body = b ? JSON.parse(b) : null; } };
  return handler(req, res).then(() => res);
}
let lane = 0;
const stay = (token) => { lane += 1; const from = F.addDays("2028-02-01", 6 * lane); return { from, to: F.addDays(from, 4), accessTokenHash: hashToken(token) }; };
const newToken = () => randomBytes(32).toString("base64url");
const fingerprint = async (id) => (await db.owner.query(`SELECT md5(i::text) AS i, (SELECT md5(coalesce(string_agg(o::text, '|' ORDER BY o.id), '')) FROM booking.external_operations o WHERE o.intent_id = $1) AS ops,
  (SELECT md5(coalesce(string_agg(w::text, '|'), '')) FROM booking.intent_work w WHERE w.intent_id = $1) AS work FROM booking.intents i WHERE i.id = $1`, [id])).rows[0];

test("A1 REAL API: payment_captured → status 'confirmed' (unchanged) + bookingProgress payment_received_finalizing (no ref); confirmed with the accepted recording proof → complete + the guest's own ref; existing fields unchanged; no internal id / PI / charge / reservation / guest data in the reply", async () => {
  const h = handlers();
  const tc = newToken(); const cap = await F.captured(db.app, stay(tc));
  const rc = await call(h.intents, { token: tc });
  assert.equal(rc.statusCode, 200); assert.equal(rc.headers["cache-control"], "no-store");
  assert.deepEqual(Object.keys(rc.body).sort(), ["bookingProgress", "price", "quoteExpiresAt", "status"], "additive: the three existing fields + bookingProgress");
  assert.deepEqual([rc.body.status, rc.body.bookingProgress], ["confirmed", { stage: "payment_received_finalizing", bookingRef: null }]);
  const tf = newToken(); const conf = await F.confirmed(db.app, stay(tf));
  const rf = await call(h.intents, { token: tf });
  const ref = (await db.owner.query("SELECT ref FROM booking.intents WHERE id = $1", [conf.id])).rows[0].ref;
  assert.deepEqual([rf.statusCode, rf.body.status, rf.body.bookingProgress], [200, "confirmed", { stage: "complete", bookingRef: ref }]);
  for (const [r, x] of [[rc, cap], [rf, conf]]) {
    for (const leak of [x.id, x.piId, String(x.reservationId), x.sessionId, x.chargeId, F.GUEST.email, F.GUEST.firstName].filter(Boolean)) assert.ok(!r.raw.includes(leak), `no ${leak.slice(0, 12)}… in the reply`);
    assert.doesNotMatch(r.raw, /payment_captured|reservation_confirmed|"state"|offline|och:|cap:/);
  }
  // POST step "status" (the page's same-origin alias) returns the identical body
  const ps = await call(h.step, { method: "POST", token: tf, body: { step: "status" } });
  assert.deepEqual(ps.body, rf.body);
});

test("A2 token-bound: each bearer sees ONLY its own intent's projection / ref; an unknown or missing token gets the unchanged byte-identical 401 (no projection); an early intent is not_paid with no ref", async () => {
  const h = handlers();
  const ta = newToken(); const a = await F.confirmed(db.app, stay(ta));
  const tb = newToken(); await F.withDetails(db.app, stay(tb));
  const ra = await call(h.intents, { token: ta }); const rb = await call(h.intents, { token: tb });
  const refA = (await db.owner.query("SELECT ref FROM booking.intents WHERE id = $1", [a.id])).rows[0].ref;
  assert.equal(ra.body.bookingProgress.bookingRef, refA);
  assert.deepEqual([rb.body.status, rb.body.bookingProgress], ["awaiting_details", { stage: "not_paid", bookingRef: null }]); assert.ok(!rb.raw.includes(refA));
  const r1 = await call(h.intents, { token: newToken() }); const r2 = await call(h.intents, {});
  assert.deepEqual([r1.statusCode, r2.statusCode, r1.raw, r2.raw], [401, 401, JSON.stringify({ code: "UNAUTHORIZED" }), JSON.stringify({ code: "UNAUTHORIZED" })]);
});

test("A3 READ-ONLY: repeated status reads (GET + POST alias) change NO intent / operation / work row of the intent (rate-limit buckets are the existing behaviour); a reconciliation-required intent is needs_review, never complete", async () => {
  const h = handlers();
  const t = newToken(); const c = await F.captured(db.app, stay(t));
  const before = await fingerprint(c.id);
  for (let i = 0; i < 3; i++) { await call(h.intents, { token: t }); await call(h.step, { method: "POST", token: t, body: { step: "status" } }); }
  assert.deepEqual(await fingerprint(c.id), before, "no write to the intent, its operations or its work row");
  // a reconciliation case on the confirmed intent → the accepted machine moves it to reconciliation_required only through events; here the
  // projection of that persisted state is checked on the REAL row (owner-set state is a fixture shortcut on a disposable DB only)
  const t2 = newToken(); const r = await F.confirmed(db.app, stay(t2));
  await db.owner.query("ALTER TABLE booking.intents DISABLE TRIGGER USER"); 
  try { await db.owner.query("UPDATE booking.intents SET state = 'reconciliation_required' WHERE id = $1", [r.id]); } finally { await db.owner.query("ALTER TABLE booking.intents ENABLE TRIGGER USER"); }
  const rr = await call(h.intents, { token: t2 });
  assert.deepEqual([rr.statusCode, rr.body.status, rr.body.bookingProgress], [200, "under_review", { stage: "needs_review", bookingRef: null }]);
});

// the REAL page controller (public/checkout-test.js) through a fetch adapter into the REAL handler (the adapter sets Origin: NOT browser evidence)
function pageFor(token, h) {
  const fetchFn = async (path, init) => {
    const req = Readable.from([Buffer.from(init.body)]); req.method = "POST"; req.url = path;
    req.headers = { origin: ORIGIN, "x-real-ip": `198.51.100.${(++ipN % 250) + 1}`, "content-type": init.headers["Content-Type"], ...(init.headers.Authorization ? { authorization: init.headers.Authorization } : {}) };
    const res = { statusCode: 0, headers: {}, raw: "", setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.raw = b || ""; } };
    await (path === "/api/checkout/intents" ? h.intents : h.step)(req, res);
    return { status: res.statusCode, json: async () => JSON.parse(res.raw) };
  };
  const m = new Map([[STORE_KEY, JSON.stringify({ token, releaseRequested: false, detailsSaved: true, polls: [], uncertain: null })]]);
  const storage = { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
  const views = []; const timers = { setTimeout: () => Symbol("t"), clearTimeout() {} };
  const nav = { assigned: [], assign(u) { this.assigned.push(u); }, search: () => "", stripQuery() {} };
  const c = createController({ api: createApi(fetchFn), store: createStore(storage), ui: { render: (v) => views.push(v) }, timers, nav, config: { listingId: 603566, currency: "MXN", termsVersion: "terms-2026-11" } });
  return { c, nav, storage, last: () => views[views.length - 1] };
}
test("A4 REAL page controller → REAL API → REAL DB: payment_captured shows 'TEST payment received — finalizing' (no ref, no pay / release); confirmed with proof shows 'TEST booking confirmed' + the ref; nothing is written; nothing is persisted but the minimum tab state", async () => {
  const h = handlers();
  const tc = newToken(); const cap = await F.captured(db.app, stay(tc)); const before = await fingerprint(cap.id);
  const pc = pageFor(tc, h); await pc.c.init();
  let v = pc.last(); assert.deepEqual([v.screen, v.title, v.canPay, v.canRequestRelease], ["finalizing", "TEST payment received — finalizing", false, false]); assert.doesNotMatch(v.text, /MV-/);
  await pc.c.pay(); assert.deepEqual(pc.nav.assigned, []); assert.deepEqual(await fingerprint(cap.id), before, "the page wrote nothing");
  const tf = newToken(); const conf = await F.confirmed(db.app, stay(tf));
  const ref = (await db.owner.query("SELECT ref FROM booking.intents WHERE id = $1", [conf.id])).rows[0].ref;
  const pf = pageFor(tf, h); await pf.c.init();
  v = pf.last(); assert.deepEqual([v.screen, v.title, v.canPay, v.canRequestRelease, v.reset], ["complete", "TEST booking confirmed", false, false, "startNew"]); assert.ok(v.text.includes(ref));
  assert.doesNotMatch(v.text, /e-?mail|refund|deliver/i, "no invented e-mail / refund / delivery promise");
  assert.deepEqual(Object.keys(JSON.parse(pf.storage.m.get(STORE_KEY))).sort(), ["detailsSaved", "polls", "releaseRequested", "token", "uncertain"], "the projection / ref is not persisted");
});
