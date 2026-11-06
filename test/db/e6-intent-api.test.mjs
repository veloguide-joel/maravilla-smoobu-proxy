// Stage E6 — intent API (create/server price, details, pay, status) against a throwaway local PostgreSQL.
// Hostaway and Stripe are in-memory fakes injected into the handler; no network, no SDK client, no keys (fake key-shaped
// strings are assembled at runtime). The handlers are exercised through fake Node req/res objects.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import pg from "pg";
import { startMigratedDatabase } from "./harness.mjs";
import { createIntentApiHandler } from "../../lib/checkout/intent-api-http.js";
import { ENV_OK } from "../e5a-fixtures.mjs";
import { addDays } from "../../lib/bookability.js";
import { enterCompleteWindow, assertCompleteWindow, bucketKey } from "./rate-window.mjs";

let db, pool2;
before(async () => { db = await startMigratedDatabase(); pool2 = new pg.Pool({ connectionString: db.appUrl(), max: 4 }); });
after(async () => { await pool2.end(); await db.close(); });

const ORIGIN = "https://preview.example.invalid";
const ENV = Object.freeze({ ...ENV_OK, MV_CHECKOUT_TEST_API: "enabled", MV_CHECKOUT_ALLOWED_ORIGIN: ORIGIN,
  MV_CHECKOUT_TEST_LISTINGS: "603566:MXN,606998:USD", MV_RATE_LIMIT_SALT: "s".repeat(40), MV_CHECKOUT_TERMS_VERSION: "terms-2026-11",
  MV_CLIENT_ADDRESS_SOURCE: "x-real-ip" });     // most tests model the (future, platform-validated) trusted adapter
const ACCT = ENV.STRIPE_TEST_ACCOUNT_ID;
const NOW0 = Date.UTC(2026, 10, 2, 20, 0, 0);
const GUEST = { firstName: "Zanabria", lastName: "Quintessa", email: "zq.e6.guest@example.test", phone: "+52 322 555 0199" };
const PII = [GUEST.firstName, GUEST.lastName, GUEST.email, "555 0199", "Zanabria"];
const clone = (o) => JSON.parse(JSON.stringify(o));
let seq = 0;
let ipSeq = 0;
const freshIp = () => `198.51.100.${(++ipSeq % 250) + 1}`;

// ---------- fakes ----------
function hostawayFake({ currency = { 603566: "MXN", 606998: "USD" }, blocked = new Set(), tax = false } = {}) {
  const calls = [];
  const days = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push({ date: d, status: blocked.has(d) ? "booked" : "available", isAvailable: blocked.has(d) ? 0 : 1, minimumStay: 1, maximumStay: 90, closedOnArrival: 0, closedOnDeparture: 0, note: "PRIVATE-NOTE" }); return out; };
  return { calls,
    get: async (path, opts = {}) => {
      calls.push(`GET ${path}`);
      const m = /^\/listings\/(\d+)(\/calendar)?$/.exec(path);
      const id = Number(m[1]);
      if (!m[2]) return { status: 200, json: { result: { id, currencyCode: currency[id], personCapacity: 2, minNights: 1, maxNights: 90, address: "PRIVATE-ADDRESS" } } };
      return { status: 200, json: { result: days(opts.query.startDate, opts.query.endDate) } };
    },
    post: async (path, body) => {
      calls.push(`POST ${path}`);
      const nights = Math.round((Date.parse(body.endingDate) - Date.parse(body.startingDate)) / 86400000);
      const comps = [{ id: 1, type: "accommodation", name: "baseRate", title: "Base rate", quantity: 1, value: 1600, total: 1600 * nights, isIncludedInTotalPrice: 1, isMandatory: 1, isOverriddenByUser: 0, isDeleted: 0, units: nights }];
      if (tax) comps.push({ id: 2, type: "tax", name: "vat", total: 100, isIncludedInTotalPrice: 1, isMandatory: 1, isOverriddenByUser: 0, isDeleted: 0 });
      return { status: 200, json: { status: "success", result: { totalPrice: comps.reduce((s, c) => s + c.total, 0), components: comps } } };
    } };
}
function stripeFake() {
  const w = { creates: [], reads: [], sessions: new Map(), createImpl: null, account: { object: "account", id: ACCT } };
  const strip = (s) => { const { _pim, ...r } = s; return clone(r); };
  w.stripe = {
    accounts: { retrieve: async () => { w.reads.push("account"); return clone(w.account); } },
    checkout: { sessions: {
      create: async (params, opts) => {
        w.creates.push({ params: clone(params), opts: clone(opts) });
        await new Promise((r) => setTimeout(r, 5));
        if (w.createImpl) return w.createImpl(params, opts);
        const id = `cs_test_E${++seq}`; const pd = params.line_items[0].price_data;
        const s = { object: "checkout.session", id, livemode: false, mode: "payment", status: "open", amount_total: pd.unit_amount, currency: pd.currency,
          client_reference_id: params.client_reference_id, metadata: { ...params.metadata }, expires_at: params.expires_at, url: `https://checkout.stripe.com/c/pay/${id}`,
          payment_intent: null, _pim: params.payment_intent_data };
        w.sessions.set(id, s); return strip(s);
      },
      retrieve: async (id) => { w.reads.push(`session:${id}`); const s = w.sessions.get(id); if (!s) throw Object.assign(new Error("nf"), { type: "StripeInvalidRequestError", statusCode: 404 }); return strip(s); } } } };
  return w;
}

// ---------- HTTP plumbing ----------
function makeHandlers({ env = ENV, hostaway = hostawayFake(), stripe = stripeFake(), clock = { now: NOW0 }, pool = db.app, logs = [], limits } = {}) {
  const spies = { createPool: 0, loadCore: 0, loadAccess: 0, createStripe: 0, createHostaway: 0 };
  const errors = [];
  const deps = {
    createPool: () => { spies.createPool++; return pool; },
    loadCore: async () => { spies.loadCore++; return import("../../lib/checkout/intent-api-core.js"); },
    loadAccess: async () => { spies.loadAccess++; return import("../../lib/booking-db/intent-access.js"); },
    createStripe: () => { spies.createStripe++; return stripe.stripe; },
    createHostaway: () => { spies.createHostaway++; return hostaway; },
    loadStripe: async () => { throw new Error("SDK must not load in tests"); },
    loadHostaway: async () => { throw new Error("real Hostaway must not load in tests"); },
    now: () => clock.now, log: (c) => logs.push(c), onError: (e) => { errors.push(e); }, ...(limits ? { limits } : {})
  };
  return { spies, logs, errors, hostaway, stripe, clock,
    intents: createIntentApiHandler({ route: "intents", env, deps }), step: createIntentApiHandler({ route: "step", env, deps }) };
}
function call(handler, { method = "POST", url = "/api/checkout/intents", body, token, origin = ORIGIN, ip = "203.0.113.9", headers = {} } = {}) {
  const raw = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method; req.url = url;
  // x-real-ip carries the modelled trusted address; x-forwarded-for always carries caller-controlled junk that must be ignored
  req.headers = { ...(origin !== null ? { origin } : {}), ...(ip !== null ? { "x-real-ip": ip } : {}), "x-forwarded-for": `spoof-${++seq}, 10.0.0.1`,
    ...(method === "POST" ? { "content-type": "application/json" } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers };
  const res = { statusCode: 0, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.raw = b || ""; this.body = b ? JSON.parse(b) : null; } };
  return handler(req, res).then(() => res);
}
let stayN = 0;   // every default stay gets its own nights (claims from earlier intents must not collide)
const STAY = (o = {}) => { const from = addDays("2027-08-01", 3 * stayN++); return { listingId: 603566, from, to: addDays(from, 2), guests: 2, ...o }; };
const DETAILS = { step: "details", ...GUEST, termsVersion: "terms-2026-11" };
async function created(h, stay = STAY(), ip = freshIp()) {
  const r = await call(h.intents, { body: stay, ip });
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  return r.body;
}
const q1 = async (sql, p) => (await db.app.query(sql, p)).rows;
const noPii = (...things) => { const s = JSON.stringify(things); for (const x of PII) assert.ok(!s.includes(x), `PII leak: ${x}`); assert.doesNotMatch(s, /PRIVATE-|whsec|sk_test|acct_/); };

// =====================================================================================================================
test("gate: production, missing flag or incomplete TEST config -> 404 with zero effects (no body read, pool, core, SDK, Hostaway)", async () => {
  const untouchable = { method: "POST", url: "/api/checkout/intents", headers: new Proxy({}, { get() { throw new Error("headers read"); } }), on() { throw new Error("body read"); } };
  for (const env of [{ ...ENV, VERCEL_ENV: "production" }, { ...ENV, MV_CHECKOUT_TEST_API: undefined }, { ...ENV, MV_STRIPE_TEST_WEBHOOK: "no" }, {},
    { ...ENV, MV_CHECKOUT_ALLOWED_ORIGIN: "http://preview.example.invalid" }, { ...ENV, MV_CHECKOUT_ALLOWED_ORIGIN: "*" },
    { ...ENV, MV_CHECKOUT_TEST_LISTINGS: "603566" }, { ...ENV, MV_CHECKOUT_TEST_LISTINGS: "603566:EUR" }, { ...ENV, MV_CHECKOUT_TEST_LISTINGS: "603566:MXN,603566:USD" },
    { ...ENV, MV_RATE_LIMIT_SALT: "short" }, { ...ENV, MV_CHECKOUT_TERMS_VERSION: "" }, { ...ENV, MV_CHECKOUT_RETURN_URL: undefined }]) {
    const h = makeHandlers({ env });
    for (const hd of [h.intents, h.step]) {
      const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = JSON.parse(b); } };
      await hd(untouchable, res);
      assert.equal(res.statusCode, 404); assert.deepEqual(res.body, { code: "NOT_FOUND" });
    }
    assert.deepEqual(h.spies, { createPool: 0, loadCore: 0, loadAccess: 0, createStripe: 0, createHostaway: 0 });
    assert.equal(h.hostaway.calls.length + h.stripe.creates.length + h.stripe.reads.length, 0);
  }
  // the deployed route files are inert in this process (no TEST configuration in process.env)
  for (const f of ["intents", "intent-step"]) {
    const route = (await import(`../../api/checkout/${f}.js`)).default;
    const res = { statusCode: 0, headers: {}, setHeader() {}, end(b) { this.body = JSON.parse(b); } };
    await route(untouchable, res); assert.equal(res.statusCode, 404);
  }
});

test("exact-origin CORS, no query strings, methods, JSON-only bounded bodies: refused before any database work", async () => {
  const h = makeHandlers();
  for (const origin of [null, "https://evil.example", "https://preview.example.invalid.evil.example", "http://preview.example.invalid", `${ORIGIN}/`, "null"]) {
    const r = await call(h.intents, { body: STAY(), origin });
    assert.equal(r.statusCode, 403); assert.equal(r.headers["access-control-allow-origin"], undefined);
  }
  let r = await call(h.intents, { method: "OPTIONS" });
  assert.equal(r.statusCode, 204); assert.equal(r.headers["access-control-allow-origin"], ORIGIN); assert.equal(r.headers["access-control-allow-headers"], "authorization, content-type");
  assert.equal(r.headers["access-control-allow-credentials"], undefined);
  r = await call(h.intents, { method: "GET", url: "/api/checkout/intents?token=abc" }); assert.deepEqual([r.statusCode, r.body.code], [400, "QUERY_NOT_ALLOWED"]);
  r = await call(h.step, { body: { step: "pay" }, url: "/api/checkout/intent-step?x=1" }); assert.equal(r.statusCode, 400);
  r = await call(h.intents, { method: "PUT", body: STAY() }); assert.deepEqual([r.statusCode, r.headers.allow], [405, "GET, POST, OPTIONS"]);
  r = await call(h.step, { method: "GET" }); assert.equal(r.statusCode, 405);
  r = await call(h.intents, { body: STAY(), headers: { "content-type": "text/plain" } }); assert.equal(r.statusCode, 415);
  r = await call(h.intents, { body: "{not json" }); assert.deepEqual([r.statusCode, r.body.code], [400, "INVALID_JSON"]);
  r = await call(h.intents, { body: "[1,2]" }); assert.deepEqual([r.statusCode, r.body.code], [400, "INVALID_JSON"]);
  r = await call(h.intents, { body: JSON.stringify({ ...STAY(), pad: "x".repeat(9000) }) }); assert.equal(r.statusCode, 413);
  r = await call(h.intents, { body: STAY(), headers: { "content-length": "999999" } }); assert.equal(r.statusCode, 413);
  r = await call(h.step, { body: { step: "refund" } }); assert.deepEqual([r.statusCode, r.body.code], [400, "UNKNOWN_STEP"]);
  assert.equal(h.spies.createPool, 0);
});

test("create: server-priced from fresh Hostaway reads; amount/currency/price overrides and unknown fields refused; scoped TEST listings only", async () => {
  const h = makeHandlers();
  for (const [extra, code] of [[{ amount: 1 }, "CLIENT_PRICE_FIELD_REJECTED"], [{ currency: "USD" }, "CLIENT_PRICE_FIELD_REJECTED"], [{ amountMinor: 50 }, "CLIENT_PRICE_FIELD_REJECTED"],
    [{ finalTotalMinor: 50 }, "CLIENT_PRICE_FIELD_REJECTED"], [{ rate: 1 }, "CLIENT_PRICE_FIELD_REJECTED"], [{ coupon: "X" }, "UNKNOWN_FIELD"], [{ token: "x" }, "UNKNOWN_FIELD"]]) {
    const r = await call(h.intents, { body: { ...STAY(), ...extra }, ip: freshIp() });
    assert.deepEqual([r.statusCode, r.body], [400, { code }], code);
  }
  assert.equal(h.hostaway.calls.length, 0, "nothing priced for refused input");
  assert.deepEqual((await call(h.intents, { body: STAY({ listingId: 603564 }), ip: freshIp() })).body, { code: "LISTING_NOT_AVAILABLE" });
  const mx = await created(h);
  assert.match(mx.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(mx.status, "awaiting_details");
  assert.deepEqual(mx.price, { currency: "MXN", totalMinor: 288000, lines: [{ label: "Accommodation", amountMinor: 320000 }, { label: "Book Direct discount (10%)", amountMinor: -32000 }] });
  assert.equal(mx.quoteExpiresAt, new Date(NOW0 + 30 * 60000).toISOString());
  assert.deepEqual(Object.keys(mx).sort(), ["price", "quoteExpiresAt", "status", "token"]);
  assert.deepEqual(h.hostaway.calls, ["GET /listings/603566", "GET /listings/603566/calendar", "POST /listings/603566/calendar/priceDetails"]);
  const us = await created(h, STAY({ listingId: 606998 }));
  assert.equal(us.price.currency, "USD");
  // stored: only the token's SHA-256; the intent carries the server price
  const { hashToken } = await import("../../lib/checkout/intent-api-http.js");
  const rows = await q1("SELECT encode(access_token_hash, 'hex') AS h, currency, final_total_minor::int AS t, state FROM booking.intents WHERE access_token_hash = ANY($1)",
    [[hashToken(mx.token), hashToken(us.token)]]);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((x) => x.h.length === 64 && !x.h.includes(mx.token)));
  assert.deepEqual(rows.map((x) => [x.currency, x.t, x.state]).sort(), [["MXN", 288000, "price_confirmed"], ["USD", 288000, "price_confirmed"]]);
  // a listing whose Hostaway currency differs from its configured one is refused (no FX, no browser currency)
  const h2 = makeHandlers({ hostaway: hostawayFake({ currency: { 603566: "USD" } }) });
  assert.deepEqual((await call(h2.intents, { body: STAY(), ip: freshIp() })).body, { code: "LISTING_NOT_CONFIGURED" });
  const h3 = makeHandlers({ hostaway: hostawayFake({ blocked: new Set(["2027-03-11"]) }) });
  assert.deepEqual((await call(h3.intents, { body: STAY({ from: "2027-03-10", to: "2027-03-12" }), ip: freshIp() })).body, { code: "NOT_AVAILABLE" });
  const h4 = makeHandlers({ hostaway: hostawayFake({ tax: true }) });
  assert.deepEqual((await call(h4.intents, { body: STAY(), ip: freshIp() })).body, { code: "PRICE_REFUSED" });
  noPii(mx, us);
});

test("tokens: Bearer header only; malformed, forged and unknown tokens get the identical 401; a token only ever reaches its own intent", async () => {
  const h = makeHandlers();
  const a = await created(h); const b = await created(h);
  const forged = Buffer.alloc(32, 7).toString("base64url");
  const nonCanonical = a.token.slice(0, 42) + (a.token[42] === "A" ? "B" : "A");
  const bodies = [];
  for (const [token, headers] of [[undefined, {}], ["short", {}], [forged, {}], [`${a.token}x`, {}], [undefined, { authorization: `bearer ${a.token}` }],
    [undefined, { authorization: `Basic ${a.token}` }], [undefined, { authorization: `Bearer  ${a.token}` }], [undefined, { authorization: `Bearer ${a.token.replace(/[A-Za-z]/, "+")}` }],
    [undefined, { authorization: `Bearer ${nonCanonical}` }]]) {
    const r = await call(h.intents, { method: "GET", token, headers });
    assert.equal(r.statusCode, 401); assert.equal(r.headers["www-authenticate"], "Bearer"); bodies.push(r.raw);
  }
  assert.equal(new Set(bodies).size, 1, "every refusal is byte-identical");
  assert.deepEqual(JSON.parse(bodies[0]), { code: "UNAUTHORIZED" });
  const sa = await call(h.intents, { method: "GET", token: a.token }); const sb = await call(h.intents, { method: "GET", token: b.token });
  assert.deepEqual(sa.body, { status: "awaiting_details", quoteExpiresAt: a.quoteExpiresAt, price: a.price });
  assert.notDeepEqual(sa.body, sb.body.quoteExpiresAt === sa.body.quoteExpiresAt ? { ...sb.body, x: 1 } : sb.body);
  // B's token cannot move A: details with B's token change only B
  assert.equal((await call(h.step, { token: b.token, body: DETAILS })).statusCode, 200);
  assert.equal((await call(h.intents, { method: "GET", token: a.token })).body.status, "awaiting_details");
  assert.equal((await call(h.intents, { method: "GET", token: b.token })).body.status, "awaiting_details");   // E3 public status for details_collected
  assert.equal((await q1("SELECT state FROM booking.intents WHERE id = (SELECT intent_id FROM booking.intent_guests LIMIT 1)"))[0].state, "details_collected");
  noPii(sa.body, sb.body, h.logs);
});

test("details: strict fields and server terms version; guest data stored only in intent_guests, never echoed or logged", async () => {
  const h = makeHandlers();
  const a = await created(h);
  for (const [body, code] of [[{ ...DETAILS, termsVersion: "terms-2020" }, "TERMS_VERSION_MISMATCH"], [{ ...DETAILS, address: "x" }, "UNKNOWN_FIELD"],
    [{ ...DETAILS, email: "nope" }, "GUEST_EMAIL"], [{ ...DETAILS, firstName: "<b>" }, "GUEST_FIRST_NAME"]]) {
    const r = await call(h.step, { token: a.token, body }); assert.deepEqual([r.statusCode, r.body], [400, { code }], code);
  }
  const r = await call(h.step, { token: a.token, body: DETAILS });
  assert.deepEqual([r.statusCode, r.body], [200, { status: "awaiting_details" }]);
  const again = await call(h.step, { token: a.token, body: DETAILS });
  assert.deepEqual([again.statusCode, again.body], [409, { code: "NOT_ALLOWED_IN_STATE" }]);
  const st = await call(h.intents, { method: "GET", token: a.token });
  noPii(r.body, again.body, st.body, h.logs);
  const { hashToken } = await import("../../lib/checkout/intent-api-http.js");
  const g = await q1("SELECT g.email FROM booking.intent_guests g JOIN booking.intents i ON i.id = g.intent_id WHERE i.access_token_hash = $1", [hashToken(a.token)]);
  assert.deepEqual(g, [{ email: GUEST.email }]);
});

test("pay: ONE TEST create with manual capture for the server price; repeats return the same session after a fresh bound read; never a second create", async () => {
  const h = makeHandlers();
  const a = await created(h);
  assert.equal((await call(h.step, { token: a.token, body: DETAILS })).statusCode, 200);
  const p1 = await call(h.step, { token: a.token, body: { step: "pay" } });
  assert.equal(p1.statusCode, 200, JSON.stringify(p1.body));
  assert.equal(p1.body.status, "awaiting_payment");
  assert.match(p1.body.checkoutUrl, /^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);
  assert.equal(h.stripe.creates.length, 1);
  const c = h.stripe.creates[0];
  assert.equal(c.params.payment_intent_data.capture_method, "manual");
  assert.equal(c.params.line_items[0].price_data.unit_amount, 288000); assert.equal(c.params.line_items[0].price_data.currency, "mxn");
  assert.equal(c.params.success_url, `${ENV.MV_CHECKOUT_RETURN_URL}?checkout=complete`);
  assert.doesNotMatch(JSON.stringify(c.params), new RegExp(`${a.token}|${GUEST.email}|customer_email`));
  const readsBefore = h.stripe.reads.filter((x) => x.startsWith("session:")).length;
  for (let i = 0; i < 3; i++) {
    const p = await call(h.step, { token: a.token, body: { step: "pay" } });
    assert.deepEqual([p.statusCode, p.body], [200, p1.body]);
  }
  assert.equal(h.stripe.creates.length, 1);
  assert.equal(h.stripe.reads.filter((x) => x.startsWith("session:")).length, readsBefore + 3, "each reuse is backed by a fresh read");
  // a session that no longer matches its attempt (amount changed at Stripe) is not handed out; nothing is recreated
  const [sid] = [...h.stripe.sessions.keys()];
  h.stripe.sessions.get(sid).amount_total = 1;
  assert.deepEqual((await call(h.step, { token: a.token, body: { step: "pay" } })).body, { code: "SESSION_NOT_REUSABLE" });
  h.stripe.sessions.get(sid).amount_total = 288000; h.stripe.sessions.get(sid).url = "https://evil.example/pay";
  assert.deepEqual((await call(h.step, { token: a.token, body: { step: "pay" } })).body, { code: "SESSION_NOT_REUSABLE" });
  h.stripe.sessions.get(sid).url = `https://checkout.stripe.com/c/pay/${sid}`;
  // past the session's own expiry: refused, never extended or recreated
  h.clock.now = h.stripe.sessions.get(sid).expires_at * 1000;
  assert.deepEqual((await call(h.step, { token: a.token, body: { step: "pay" } })).body, { code: "SESSION_EXPIRED_NOT_REUSABLE" });
  assert.equal(h.stripe.creates.length, 1);
  const ops = await q1("SELECT op_type, state FROM booking.external_operations WHERE intent_id = (SELECT id FROM booking.intents WHERE access_token_hash = $1)",
    [(await import("../../lib/checkout/intent-api-http.js")).hashToken(a.token)]);
  assert.deepEqual(ops.map((o) => `${o.op_type}:${o.state}`).filter((x) => !x.startsWith("stripe.retrieve")), ["stripe.create_checkout_session:succeeded"]);
  noPii(p1.body, h.logs);
});

test("concurrent pay requests: exactly one create; the others wait (409 in progress) or get the same session", async () => {
  const h = makeHandlers();
  const a = await created(h);
  await call(h.step, { token: a.token, body: DETAILS });
  const out = await Promise.all(Array.from({ length: 6 }, () => call(h.step, { token: a.token, body: { step: "pay" } })));
  assert.deepEqual(h.errors.map((e) => `${e.code} ${e.message}`), []);
  assert.equal(h.stripe.creates.length, 1, JSON.stringify(out.map((o) => o.body)));
  const urls = new Set(out.filter((o) => o.statusCode === 200).map((o) => o.body.checkoutUrl));
  assert.ok(urls.size === 1, JSON.stringify(out.map((o) => [o.statusCode, o.body])));
  for (const o of out) assert.ok(o.statusCode === 200 || (o.statusCode === 409 && o.body.code === "CHECKOUT_CREATE_IN_PROGRESS"), JSON.stringify(o.body));
  const later = await call(h.step, { token: a.token, body: { step: "pay" } });
  assert.deepEqual([later.statusCode, later.body.checkoutUrl], [200, [...urls][0]]);
  assert.equal(h.stripe.creates.length, 1);
});

test("unknown create outcome: 502 once, then 409 unresolved on every retry; still exactly one create; quote expiry refuses pay", async () => {
  const h = makeHandlers();
  h.stripe.createImpl = async () => { throw Object.assign(new Error("socket hang up"), { type: "StripeConnectionError" }); };
  const a = await created(h);
  await call(h.step, { token: a.token, body: DETAILS });
  assert.deepEqual(await call(h.step, { token: a.token, body: { step: "pay" } }).then((r) => [r.statusCode, r.body]), [502, { code: "CONNECTION" }]);
  for (let i = 0; i < 3; i++) assert.deepEqual(await call(h.step, { token: a.token, body: { step: "pay" } }).then((r) => [r.statusCode, r.body]), [409, { code: "CHECKOUT_CREATE_UNRESOLVED" }]);
  assert.equal(h.stripe.creates.length, 1);
  const b = await created(h);
  await call(h.step, { token: b.token, body: DETAILS });
  h.clock.now = NOW0 + 31 * 60000;
  assert.deepEqual(await call(h.step, { token: b.token, body: { step: "pay" } }).then((r) => [r.statusCode, r.body]), [409, { code: "QUOTE_EXPIRED" }]);
  assert.equal(h.stripe.creates.length, 1);
  // test-DB / account guards are inherited: a wrong account refuses before any write or create (fresh worker: no cached account)
  const hw = makeHandlers();
  hw.stripe.account = { object: "account", id: "acct_SOMEONEELSE" };
  const c = await created(hw);
  await call(hw.step, { token: c.token, body: DETAILS });
  assert.deepEqual(await call(hw.step, { token: c.token, body: { step: "pay" } }).then((r) => [r.statusCode, r.body]), [503, { code: "PAYMENT_UNAVAILABLE" }]);
  assert.equal(hw.stripe.creates.length, 0);
  assert.equal((await q1("SELECT count(*)::int AS n FROM booking.payment_attempts a JOIN booking.intents i ON i.id = a.intent_id WHERE i.access_token_hash = $1",
    [(await import("../../lib/checkout/intent-api-http.js")).hashToken(c.token)]))[0].n, 0);
});

test("shared durable rate limits: per-IP creates are counted across separate workers and separate connection pools", async () => {
  const w1 = makeHandlers(); const w2 = makeHandlers({ pool: pool2 });
  const ip = "192.0.2.77";
  const SALT = ENV.MV_RATE_LIMIT_SALT;
  // Each burst below runs inside ONE complete fixed window (0006: floor(statement_timestamp / 600 s)), planned from the
  // database clock, and is then proven against the real table: the scoped bucket holds exactly one window row with
  // exactly the burst's hits. A crossed or slow burst fails; nothing is retried, loosened or skipped.
  const BURST_MS = 20_000;
  const codes = [];
  let win = await enterCompleteWindow(db.owner, { windowSeconds: 600, burstBudgetMs: BURST_MS });
  for (let i = 0; i < 12; i++) {
    const h = i % 2 ? w2 : w1;
    const r = await call(h.intents, { body: STAY(), ip });
    codes.push(r.statusCode);
  }
  assert.deepEqual(codes, [...Array(10).fill(201), 429, 429]);
  await assertCompleteWindow(db.owner, bucketKey(SALT, "create_ip", ip), { ...win, hits: 12, label: "per-address create burst" });
  assert.equal((await call(w2.intents, { body: STAY(), ip: "192.0.2.78" })).statusCode, 201, "another address is unaffected");
  // per-token limit (40 / 10 min): shared too
  const a = await created(w1);
  const { hashToken: tokenHashOf } = await import("../../lib/checkout/intent-api-http.js");
  const st = [];
  win = await enterCompleteWindow(db.owner, { windowSeconds: 600, burstBudgetMs: BURST_MS });
  for (let i = 0; i < 42; i++) st.push((await call((i % 2 ? w2 : w1).intents, { method: "GET", token: a.token, ip: freshIp() })).statusCode);
  assert.deepEqual(st.slice(-2), [429, 429]); assert.equal(st.filter((s) => s === 200).length, 40);
  await assertCompleteWindow(db.owner, bucketKey(SALT, "tok", tokenHashOf(a.token).toString("hex")), { ...win, hits: 42, label: "per-token status burst" });
  // per-address limit across all actions (120 / 10 min), counted before any token lookup, shared across workers
  const flood = "192.0.2.99"; const fl = [];
  const forged = (i) => { const x = Buffer.alloc(32, 0); x.writeUInt32BE(i + 1, 0); return x.toString("base64url"); };   // distinct tokens: per-token limit not involved
  win = await enterCompleteWindow(db.owner, { windowSeconds: 600, burstBudgetMs: BURST_MS });
  for (let i = 0; i < 122; i++) fl.push((await call((i % 2 ? w2 : w1).intents, { method: "GET", token: forged(i), ip: flood })).statusCode);
  assert.equal(fl.filter((x) => x === 401).length, 120); assert.deepEqual(fl.slice(-2), [429, 429]);
  await assertCompleteWindow(db.owner, bucketKey(SALT, "ip", flood), { ...win, hits: 122, label: "per-address flood" });
  // buckets are opaque HMACs keyed by the server salt: no address or token is stored, and an unsalted hash of a known
  // address or token does not appear either (so a leaked table cannot be matched by hashing guesses)
  const { createHash } = await import("node:crypto");
  const { hashToken } = await import("../../lib/checkout/intent-api-http.js");
  const unsalted = [ip, flood, "192.0.2.78", hashToken(a.token).toString("hex")].flatMap((v) => [createHash("sha256").update(v).digest("hex"),
    ...["ip", "create_ip", "tok"].map((sc) => createHash("sha256").update(`${sc}|${v}`).digest("hex"))]);
  const b = await db.owner.query("SELECT bucket FROM booking.api_rate_limits");
  for (const r of b.rows) assert.ok(!unsalted.includes(r.bucket.split(":")[1]), "bucket is not an unsalted hash");
  assert.ok(b.rows.length > 0 && b.rows.every((r) => /^[a-z_]+:[0-9a-f]{64}$/.test(r.bucket)));
  assert.doesNotMatch(JSON.stringify(b.rows), /192\.0\.2|198\.51|203\.0/);
  assert.ok(!b.rows.some((r) => r.bucket.includes(a.token)));
  // the runtime role cannot touch the table directly; only the function
  await assert.rejects(db.app.query("SELECT * FROM booking.api_rate_limits"), /permission denied/);
  await assert.rejects(db.app.query("DELETE FROM booking.api_rate_limits"), /permission denied/);
  await assert.rejects(db.app.query("SELECT booking.rate_limit_hit('bad bucket', 60, 1)"), /invalid rate limit/);
});

test("a LIVE-marked database or an unreachable one: 503 NOT_READY before any Hostaway, Stripe or write", async () => {
  const live = { query: (sql, p) => (/FROM booking\.instance/.test(sql) ? Promise.resolve({ rows: [{ environment: "live" }] }) : db.app.query(sql, p)), connect: () => db.app.connect() };
  for (const pool of [live, { query: () => Promise.reject(new Error("down")), connect: () => Promise.reject(new Error("down")) }]) {
    const h = makeHandlers({ pool });
    const before = (await q1("SELECT count(*)::int AS n FROM booking.intents"))[0].n;
    const r = await call(h.intents, { body: STAY(), ip: freshIp() });
    assert.deepEqual([r.statusCode, r.body], [503, { code: "NOT_READY" }]);
    assert.equal(h.hostaway.calls.length + h.stripe.creates.length + h.stripe.reads.length, 0);
    assert.equal((await q1("SELECT count(*)::int AS n FROM booking.intents"))[0].n, before);
  }
});

test("no PII, tokens or provider ids in any status/error body or log line across a full flow", async () => {
  const logs = [];
  const h = makeHandlers({ logs });
  const a = await created(h);
  const all = [];
  all.push((await call(h.step, { token: a.token, body: DETAILS })).body);
  all.push((await call(h.step, { token: a.token, body: { ...DETAILS, email: "bad" } })).body);
  all.push((await call(h.intents, { method: "GET", token: a.token })).body);
  const pay = (await call(h.step, { token: a.token, body: { step: "pay" } })).body;
  all.push((await call(h.intents, { method: "GET", token: a.token })).body);
  all.push((await call(h.intents, { method: "GET", token: Buffer.alloc(32, 9).toString("base64url") })).body);
  noPii(all, pay, logs);
  const s = JSON.stringify([all, logs]);
  assert.ok(!s.includes(a.token)); assert.doesNotMatch(s, /cs_test_|pi_|evt_|MV-[A-Z0-9]{6,}/);
  assert.ok(logs.every((l) => /^[A-Z0-9_]+$/.test(l)), JSON.stringify(logs));
});

test("reusableSessionUrl (direct): a session whose own expiry has passed is never handed out, even if every other field matches", async () => {
  const { reusableSessionUrl } = await import("../../lib/checkout/intent-api-core.js");
  const h = makeHandlers();
  const a = await created(h);
  await call(h.step, { token: a.token, body: DETAILS });
  const p = await call(h.step, { token: a.token, body: { step: "pay" } });
  assert.equal(p.statusCode, 200);
  const [sid] = [...h.stripe.sessions.keys()];
  const { hashToken } = await import("../../lib/checkout/intent-api-http.js");
  const id = (await q1("SELECT id FROM booking.intents WHERE access_token_hash = $1", [hashToken(a.token)]))[0].id;
  const exp = h.stripe.sessions.get(sid).expires_at * 1000;
  assert.equal(await reusableSessionUrl(db.app, h.stripe.stripe, id, sid, exp - 1000), p.body.checkoutUrl);
  for (const now of [exp, exp + 1, exp + 86400000]) assert.equal(await reusableSessionUrl(db.app, h.stripe.stripe, id, sid, now), null, String(now));
  // a different intent id or a non-test id is never bound
  assert.equal(await reusableSessionUrl(db.app, h.stripe.stripe, "00000000-0000-4000-8000-000000000000", sid, exp - 1000), null);
  assert.equal(await reusableSessionUrl(db.app, h.stripe.stripe, id, "cs_live_X", exp - 1000), null);
});

test("client-address policy 'none' (the default): spoofed X-Forwarded-For / X-Real-IP never mint buckets; all unattributed traffic shares ONE limit across workers", async () => {
  const env = { ...ENV, MV_CLIENT_ADDRESS_SOURCE: undefined };
  const limits = { unattributed: [600, 6], createUnattributed: [600, 3] };
  const w1 = makeHandlers({ env, limits, pool: db.app }); const w2 = makeHandlers({ env, limits, pool: pool2 });
  // fresh salt so this test's shared buckets are its own
  const env2 = { ...env, MV_RATE_LIMIT_SALT: "n".repeat(40) };
  const a1 = makeHandlers({ env: env2, limits, pool: db.app }); const a2 = makeHandlers({ env: env2, limits, pool: pool2 });
  const out = [];
  for (let i = 0; i < 5; i++) {
    const r = await call((i % 2 ? a2 : a1).intents, { body: STAY(), ip: `198.18.0.${i + 1}`, headers: { "x-forwarded-for": `bucket-${i}`, "x-real-ip": `203.0.113.${i + 1}` } });
    out.push(r.statusCode);
  }
  assert.deepEqual(out, [201, 201, 201, 429, 429], "3 creates for ALL unattributed callers together, whatever the headers say");
  const more = [];
  for (let i = 0; i < 3; i++) more.push((await call((i % 2 ? a2 : a1).intents, { method: "GET", token: Buffer.alloc(32, i + 1).toString("base64url"), headers: { "x-real-ip": `198.51.100.${i + 9}` } })).statusCode);
  assert.deepEqual(more, [401, 429, 429], "the shared all-actions limit (6) is reached across both workers");
  // origin is still checked first, and token limits still apply under this policy (separate salt => separate buckets)
  assert.equal((await call(w1.intents, { body: STAY(), origin: "https://evil.example" })).statusCode, 403);
  void w2;
});

test("client-address policy 'x-real-ip': only one canonical IPv4/IPv6 value counts; X-Forwarded-For ignored; malformed -> shared bucket; IPv6 normalised", async () => {
  const limits = { createPerAddress: [600, 2], createUnattributed: [600, 1] };
  const env = { ...ENV, MV_RATE_LIMIT_SALT: "r".repeat(40) };
  const h1 = makeHandlers({ env, limits }); const h2 = makeHandlers({ env, limits, pool: pool2 });
  const creates = async (hdrs) => (await call(h1.intents, { body: STAY(), ip: null, headers: hdrs })).statusCode;
  // IPv6 spellings of one address share a bucket (2 allowed), across workers
  assert.equal(await creates({ "x-real-ip": "2001:DB8::1" }), 201);
  assert.equal((await call(h2.intents, { body: STAY(), ip: null, headers: { "x-real-ip": "2001:db8:0:0:0:0:0:1" } })).statusCode, 201);
  assert.equal(await creates({ "x-real-ip": "2001:0db8::0001" }), 429);
  // IPv4-mapped IPv6 is the IPv4 address
  assert.equal(await creates({ "x-real-ip": "192.0.2.50" }), 201);
  assert.equal(await creates({ "x-real-ip": "::ffff:192.0.2.50" }), 201);
  assert.equal(await creates({ "x-real-ip": "::ffff:c000:0232" }), 429);
  // X-Forwarded-For never changes the bucket
  assert.equal(await creates({ "x-real-ip": "192.0.2.60", "x-forwarded-for": "1.1.1.1" }), 201);
  assert.equal(await creates({ "x-real-ip": "192.0.2.60", "x-forwarded-for": "2.2.2.2" }), 201);
  assert.equal(await creates({ "x-real-ip": "192.0.2.60", "x-forwarded-for": "3.3.3.3" }), 429);
  // malformed / multi-hop / ported / zoned / missing values all fall into ONE shared bucket (1 allowed here)
  const bad = [{ "x-real-ip": "arbitrary-bucket-name" }, { "x-real-ip": "192.0.2.70, 192.0.2.71" }, { "x-real-ip": "192.0.2.70:443" },
    { "x-real-ip": "fe80::1%eth0" }, { "x-real-ip": "[2001:db8::2]" }, { "x-real-ip": "01.2.3.4" }, { "x-real-ip": " 192.0.2.72" }, {}];
  const codes = []; for (const hd of bad) codes.push(await creates(hd));
  assert.deepEqual(codes, [201, ...Array(bad.length - 1).fill(429)]);
});

test("0006 expiry: one-use buckets older than 25 h are removed (bounded, oldest first); open windows and recent counters are kept; concurrent calls are safe", async () => {
  const hex = (i) => i.toString(16).padStart(64, "0");
  await db.owner.query("DELETE FROM booking.api_rate_limits");
  // 250 stale one-use rows (closed long ago), 5 recent rows, and a 24 h window that opened 23 h ago (still open)
  await db.owner.query(`INSERT INTO booking.api_rate_limits (bucket, window_start, hits)
    SELECT 'tok:' || lpad(to_hex(g), 64, '0'), statement_timestamp() - interval '26 hours' - make_interval(secs => g), 1 FROM generate_series(1, 250) g`);
  await db.owner.query(`INSERT INTO booking.api_rate_limits (bucket, window_start, hits)
    SELECT 'ip:' || lpad(to_hex(g), 64, '0'), statement_timestamp() - interval '5 minutes', 3 FROM generate_series(1, 5) g`);
  await db.owner.query("INSERT INTO booking.api_rate_limits (bucket, window_start, hits) VALUES ($1, statement_timestamp() - interval '23 hours', 7)", [`create_all:${hex(77)}`]);
  const count = async (sql) => Number((await db.owner.query(sql)).rows[0].n);
  const stale = "SELECT count(*) AS n FROM booking.api_rate_limits WHERE window_start < statement_timestamp() - interval '25 hours'";
  assert.equal(await count(stale), 250);
  await db.app.query("SELECT booking.rate_limit_hit($1, 600, 10)", [`ip:${hex(9001)}`]);
  assert.equal(await count(stale), 150, "at most 100 removed per call, oldest first");
  assert.equal(await count("SELECT count(*) AS n FROM booking.api_rate_limits WHERE bucket LIKE 'tok:%' AND window_start < statement_timestamp() - interval '26 hours 151 seconds'"), 0, "the oldest went first");
  // concurrency: 12 callers on separate connections, each on its own bucket
  await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? pool2 : db.app).query("SELECT booking.rate_limit_hit($1, 600, 10)", [`ip:${hex(9100 + i)}`])));
  assert.equal(await count(stale), 0);
  assert.equal(await count("SELECT count(*) AS n FROM booking.api_rate_limits WHERE bucket LIKE 'ip:%' AND hits = 3"), 5, "recent counters kept");
  assert.equal(await count(`SELECT count(*) AS n FROM booking.api_rate_limits WHERE bucket = 'create_all:${hex(77)}' AND hits = 7`), 1, "an open 24 h window is kept");
  assert.equal(await count("SELECT count(*) AS n FROM booking.api_rate_limits WHERE bucket LIKE 'ip:%' AND hits = 1"), 13);
  const plan = (await db.owner.query("EXPLAIN SELECT 1 FROM booking.api_rate_limits WHERE window_start < now() - interval '25 hours' ORDER BY window_start LIMIT 100")).rows.map((r) => r["QUERY PLAN"]).join(" ");
  assert.ok((await db.owner.query("SELECT 1 FROM pg_indexes WHERE schemaname = 'booking' AND indexname = 'api_rate_limits_window_start_idx'")).rowCount === 1, plan);
  await assert.rejects(db.app.query("SELECT count(*) FROM booking.api_rate_limits"), /permission denied/);
  await assert.rejects(db.app.query("DELETE FROM booking.api_rate_limits"), /permission denied/);
});
