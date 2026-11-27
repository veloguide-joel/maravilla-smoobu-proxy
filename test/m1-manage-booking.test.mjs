// M1 "Manage my booking" (owner decision 2026-11-27): the lookup step (no bearer; booking ref + checkout e-mail), its core projection and the
// guest page. Pure / faked dependencies only: no database, SDK or network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { createIntentApiHandler, validLookupBody, DEFAULT_LIMITS } from "../lib/checkout/intent-api-http.js";
import { lookupBooking, BOOKING_NOT_FOUND } from "../lib/checkout/intent-api-core.js";
import { findIntentIdByRefAndEmail } from "../lib/booking-db/intent-access.js";
import { STATES as S } from "../lib/checkout/intent-state.js";
import { normalizeRef, normalizeEmail, refFromHash, lookup, viewOf, requestLink, nightsBetween, NOTICES } from "../public/manage.js";
import { ENV_OK } from "./e5a-fixtures.mjs";

const ORIGIN = "https://preview.example.invalid";
const ENV = Object.freeze({ ...ENV_OK, MV_CHECKOUT_TEST_API: "enabled", MV_CHECKOUT_ALLOWED_ORIGIN: ORIGIN, MV_CHECKOUT_TEST_LISTINGS: "603566:MXN,606998:USD",
  MV_RATE_LIMIT_SALT: "s".repeat(40), MV_CHECKOUT_TERMS_VERSION: "terms-2026-11" });
const call = (h, { method = "POST", url = "/x", headers = {}, body = "" } = {}) => {
  const req = Readable.from(body ? [Buffer.from(body)] : []); req.method = method; req.url = url; req.headers = headers;
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b ? JSON.parse(b) : null; } };
  return h(req, res).then(() => res);
};
const J = { origin: ORIGIN, "content-type": "application/json" };
const BODY = JSON.stringify({ step: "lookup", ref: "MV-ABCD2345", email: "Guest@Example.com" });
function fakeDeps({ found = "11111111-2222-4333-8444-555555555555", allow = () => true } = {}) {
  const seen = { hits: [], find: [], core: 0, token: 0 };
  const pool = { query: async (sql) => (/booking\.instance/.test(sql) ? { rows: [{ environment: "test" }] } : { rows: [] }) };
  return { seen, deps: { createPool: () => pool,
    loadAccess: async () => ({ rateLimitHit: async (_p, bucket) => { const scope = bucket.split(":")[0]; seen.hits.push(scope); return allow(scope); },
      findIntentIdByRefAndEmail: async (_p, ref, email) => { seen.find.push([ref, email]); return found; }, findIntentIdByTokenHash: async () => { seen.token++; return null; } }),
    loadCore: async () => ({ lookupBooking: async (_c, id) => { seen.core++; return { http: 200, body: { booking: { ref: "MV-ABCD2345", id } } }; } }),
    loadStripe: async () => { throw new Error("no SDK"); }, loadHostaway: async () => { throw new Error("no Hostaway"); }, log: () => {} } };
}

test("lookup body: exactly {step, ref, email}; upper-case MV ref; a plausible e-mail", () => {
  assert.equal(validLookupBody({ step: "lookup", ref: "MV-ABCD2345", email: "a@b.co" }), true);
  for (const b of [{ step: "lookup", ref: "mv-abcd2345", email: "a@b.co" }, { step: "lookup", ref: "MV-ABC", email: "a@b.co" }, { step: "lookup", ref: "MV-ABCD2345", email: "nope" },
    { step: "lookup", ref: "MV-ABCD2345", email: "a@b.co", extra: 1 }, { step: "lookup", ref: "MV-ABCD2345" }, { step: "lookup", ref: 5, email: "a@b.co" },
    { step: "lookup", ref: "MV-ABCD2345", email: `${"x".repeat(250)}@b.co` }, { step: "lookup", ref: "MV-ABCD2345'; --", email: "a@b.co" }]) assert.equal(validLookupBody(b), false, JSON.stringify(b));
});

test("lookup step: no bearer needed; own rate limits (shared + per ref); found -> core projection; never touches the token path", async () => {
  const f = fakeDeps();
  const r = await call(createIntentApiHandler({ route: "step", env: ENV, deps: f.deps }), { headers: J, body: BODY });
  assert.deepEqual([r.statusCode, r.body.booking.ref, r.headers["cache-control"]], [200, "MV-ABCD2345", "no-store"]);
  assert.deepEqual(f.seen.hits, ["unattributed", "lookup_shared", "lookup_ref"]);
  assert.deepEqual([f.seen.find, f.seen.core, f.seen.token], [[["MV-ABCD2345", "Guest@Example.com"]], 1, 0]);
  assert.deepEqual([DEFAULT_LIMITS.lookupPerAddress, DEFAULT_LIMITS.lookupPerRef], [[600, 10], [3600, 10]]);
});

test("lookup step: unknown ref / wrong e-mail -> one uniform 404 without the core; each limit refuses with 429 before the database read", async () => {
  const miss = fakeDeps({ found: null });
  const r = await call(createIntentApiHandler({ route: "step", env: ENV, deps: miss.deps }), { headers: J, body: BODY });
  assert.deepEqual([r.statusCode, r.body, miss.seen.core], [404, { code: "BOOKING_NOT_FOUND" }, 0]);
  for (const blocked of ["unattributed", "lookup_shared", "lookup_ref"]) {
    const f = fakeDeps({ allow: (scope) => scope !== blocked });
    const x = await call(createIntentApiHandler({ route: "step", env: ENV, deps: f.deps }), { headers: J, body: BODY });
    assert.deepEqual([x.statusCode, x.body.code, f.seen.find.length], [429, "RATE_LIMITED", 0], blocked);
  }
});

test("lookup step: refusals before any dependency (origin, gate, malformed body, query string)", async () => {
  const spies = { n: 0 }; const bump = () => { spies.n++; throw new Error("no"); };
  const deps = { createPool: bump, loadCore: bump, loadAccess: bump, loadStripe: bump, loadHostaway: bump, log: () => {} };
  const h = createIntentApiHandler({ route: "step", env: ENV, deps });
  const off = createIntentApiHandler({ route: "step", env: { ...ENV, MV_CHECKOUT_TEST_API: "no" }, deps });
  const cases = [[h, { headers: { "content-type": "application/json" }, body: BODY }, 403], [h, { headers: { ...J, origin: "https://evil.example" }, body: BODY }, 403],
    [h, { headers: J, body: '{"step":"lookup","ref":"MV-ABCD2345"}' }, 400], [h, { headers: J, body: '{"step":"lookup","ref":"mv-abcd2345","email":"a@b.co"}' }, 400],
    [h, { headers: J, body: '{"step":"lookup","ref":"MV-ABCD2345","email":"a@b.co","token":"x"}' }, 400], [h, { url: "/x?ref=MV-ABCD2345", headers: J, body: BODY }, 400],
    [off, { headers: J, body: BODY }, 404]];
  for (const [hd, req, st] of cases) assert.equal((await call(hd, req)).statusCode, st, JSON.stringify(req));
  assert.equal(spies.n, 0);
});

test("database read: one parameterised, case-insensitive match; ambiguity or nothing -> null", async () => {
  const seen = [];
  const q = (rows) => ({ query: async (sql, params) => { seen.push([sql, params]); return { rows }; } });
  assert.equal(await findIntentIdByRefAndEmail(q([{ id: "a" }]), "MV-ABCD2345", "A@b.co"), "a");
  assert.equal(await findIntentIdByRefAndEmail(q([]), "MV-ABCD2345", "a@b.co"), null);
  assert.equal(await findIntentIdByRefAndEmail(q([{ id: "a" }, { id: "b" }]), "MV-ABCD2345", "a@b.co"), null);
  assert.match(seen[0][0], /WHERE i\.ref = \$1 AND lower\(g\.email\) = lower\(\$2\)/); assert.deepEqual(seen[0][1], ["MV-ABCD2345", "A@b.co"]);
  assert.doesNotMatch(seen[0][0], /MV-ABCD2345|b\.co/, "values travel as parameters only");
  await assert.rejects(findIntentIdByRefAndEmail(q([]), null, "a@b.co"), TypeError);
});

const ROW = (over = {}) => ({ machine_version: "intent-state-v1", id: "i1", ref: "MV-ABCD2345", listing_id: 628392, from_date_s: "2027-05-18", to_date_s: "2027-05-20", guests: 2,
  state: S.CONFIRMED, version: 9, created_at: new Date(0), updated_at: new Date(0), price_snapshot: { currency: "USD", finalTotalMinor: 16335, lines: [{ label: "2 nights", amountMinor: 13500 }, { label: "Taxes", amountMinor: 2835 }] },
  quote_expires_at: null, details_collected: true, checkout_session_id: null, stripe_payment_intent_id: "pi_1", authorized_minor: 16335, currency: "USD", payment_livemode: false,
  authorization_created_at: null, capture_before: null, authorization_deadline: null, authorization_accepted_at: null, captured_minor: 16335, hostaway_reservation_id: "71000001",
  reservation_confirmed_at: null, lease_worker_id: null, dispatch_at: null, reservation_attempts: 0, void_attempts: 0, offline_charge_id: "5001", ...over });
const poolFor = (row, xc = null, fail = false) => ({ query: async (sql) => {
  if (/external_cancellation_public/.test(sql)) { if (fail) throw new Error("x"); return { rows: [{ x: xc }] }; }
  return { rows: row ? [row] : [] };
} });

test("core projection: only a complete or host-cancelled booking is shown; the reply carries the stay and price, nothing personal or internal", async () => {
  const ok = await lookupBooking({ pool: poolFor(ROW()) }, "i1");
  if (ok.http !== 200) return assert.fail(`fixture row not accepted as complete: ${JSON.stringify(ok.body)}`);
  assert.deepEqual(ok.body, { booking: { ref: "MV-ABCD2345", stage: "complete", refundStatus: null, listingId: 628392, from: "2027-05-18", to: "2027-05-20", guests: 2,
    price: { currency: "USD", totalMinor: 16335, lines: [{ label: "2 nights", amountMinor: 13500 }, { label: "Taxes", amountMinor: 2835 }] } } });
  const text = JSON.stringify(ok.body);
  for (const bad of ["pi_1", "71000001", "5001", "i1\"", "email", "firstName", "token"]) assert.equal(text.includes(bad), false, bad);
  const cancelled = await lookupBooking({ pool: poolFor(ROW(), { cancelled: true, refundStatus: "full" }) }, "i1");
  assert.deepEqual([cancelled.http, cancelled.body.booking.stage, cancelled.body.booking.refundStatus], [200, "cancelled", "full"]);
  for (const [name, pool] of [["unpaid", poolFor(ROW({ state: S.PAYMENT_PENDING }))], ["in progress", poolFor(ROW({ state: S.PAYMENT_AUTHORIZED }))], ["ended", poolFor(ROW({ state: S.EXPIRED }))],
    ["under review", poolFor(ROW({ state: S.RECONCILIATION_REQUIRED }))], ["no reservation id", poolFor(ROW({ hostaway_reservation_id: null }))], ["missing row", poolFor(null)],
    ["unreadable cancellation", poolFor(ROW(), { cancelled: true, refundStatus: "maybe" })], ["cancellation read failed", poolFor(ROW(), null, true)]]) {
    assert.deepEqual(await lookupBooking({ pool }, "i1"), BOOKING_NOT_FOUND, name);
  }
});

test("page helpers: reference and e-mail normalising, fragment prefill, view, request links", () => {
  assert.deepEqual([normalizeRef(" mv-abcd2345 "), normalizeRef("ABCD2345"), normalizeRef("mv abcd 2345"), normalizeRef("MV-!!"), normalizeRef(5)], ["MV-ABCD2345", "MV-ABCD2345", "MV-ABCD2345", null, null]);
  assert.deepEqual([normalizeEmail("  a@b.co "), normalizeEmail("nope"), normalizeEmail("")], ["a@b.co", null, null]);
  assert.deepEqual([refFromHash("#MV-ABCD2345"), refFromHash("#x"), refFromHash("")], ["MV-ABCD2345", null, null]);
  assert.equal(nightsBetween("2027-05-18", "2027-05-20"), 2);
  const b = { ref: "MV-ABCD2345", stage: "complete", refundStatus: null, listingId: 1, from: "2027-05-18", to: "2027-05-20", guests: 2,
    price: { currency: "USD", totalMinor: 16335, lines: [{ label: "2 nights", amountMinor: 13500 }, { label: "Taxes", amountMinor: 2835 }] } };
  const v = viewOf(b, "Small Studio");
  assert.deepEqual([v.status, v.home, v.checkIn, v.nights, v.guests, v.total, v.lines, v.refund], ["Your booking is confirmed.", "Small Studio", "Tuesday, May 18, 2027", "2", "2",
    "Total paid: $163.35", ["2 nights: $135.00", "Taxes: $28.35"], null]);
  const c = viewOf({ ...b, stage: "cancelled", refundStatus: "full" }, null);
  assert.deepEqual([c.status, c.cancelled, c.home, c.refund], ["This booking was cancelled.", true, "Your MiCasaDirect home", "Refund: a full refund has been made."]);
  const link = requestLink("cancel", v);
  assert.ok(link.startsWith("mailto:info@micasadirect.com?subject=Cancellation%20request%3A%20MV-ABCD2345&body="));
  assert.ok(decodeURIComponent(link).includes("I would like to cancel this booking.")); assert.ok(requestLink("change", v).includes("Change%20request"));
});

test("page lookup(): one same-origin POST with exactly {step, ref, email}; replies map to guest notices; malformed success is not shown", async () => {
  const seen = [];
  const f = (status, body) => async (url, init) => { seen.push([url, init]); return { status, json: async () => body }; };
  const good = { booking: { ref: "MV-ABCD2345", stage: "complete", listingId: 1, from: "2027-05-18", to: "2027-05-20", guests: 2, price: null } };
  assert.deepEqual(await lookup(f(200, good), "MV-ABCD2345", "a@b.co"), { ok: true, booking: good.booking });
  assert.deepEqual([seen[0][0], seen[0][1].method, JSON.parse(seen[0][1].body), seen[0][1].credentials], ["/api/checkout/intent-step", "POST", { step: "lookup", ref: "MV-ABCD2345", email: "a@b.co" }, "omit"]);
  for (const [st, body, notice] of [[404, {}, "BOOKING_NOT_FOUND"], [429, {}, "RATE_LIMITED"], [400, {}, "INPUT"], [503, {}, "UNAVAILABLE"], [200, { booking: { ref: "x" } }, "UNAVAILABLE"], [200, null, "UNAVAILABLE"]])
    assert.deepEqual(await lookup(f(st, body), "MV-ABCD2345", "a@b.co"), { ok: false, notice }, String(st));
  assert.deepEqual(await lookup(async () => { throw new Error("offline"); }, "MV-ABCD2345", "a@b.co"), { ok: false, notice: "UNAVAILABLE" });
  for (const k of Object.keys(NOTICES)) assert.ok(NOTICES[k].length > 20);
});

test("page markup: same strict CSP and no-referrer as checkout, no inline script or style, not indexed, nothing changes a booking", () => {
  const html = readFileSync(new URL("../public/manage.html", import.meta.url), "utf8"); const js = readFileSync(new URL("../public/manage.js", import.meta.url), "utf8");
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'"/);
  assert.match(html, /<meta name="referrer" content="no-referrer">/); assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.doesNotMatch(html, /<script(?![^>]*src=)|<style|\son[a-z]+=|style="/);
  assert.doesNotMatch(js, /localStorage|sessionStorage|document\.cookie|innerHTML|step: "(pay|details|release|create)"/);
  assert.equal((js.match(/intent-step/g) || []).length, 1, "the page calls the step route in one place, for lookup only");
});
