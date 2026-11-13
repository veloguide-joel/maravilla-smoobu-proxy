// test/e7-hosted-charge-list-probe.test.mjs — C17 read-only charge-LIST shape probe: FAKE exchange only (every real network primitive is replaced
// with a throwing guard before the probe is imported); REAL accepted transport + pure proofs from the pinned tooling (E7_TOOLING_DIR = 5a094b16).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const GUARD = { request: 0, Agent: 0, fetch: 0 };
https.request = () => { GUARD.request += 1; throw new Error("network refused"); };
https.Agent = class { constructor() { GUARD.Agent += 1; throw new Error("network refused"); } };
globalThis.fetch = async () => { GUARD.fetch += 1; throw new Error("network refused"); };
syncBuiltinESMExports();
const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const TOOLING = realpathSync(process.env.E7_TOOLING_DIR || join(ROOT, "..", "tooling"));
const P = await import("../scripts/e7-hosted-charge-list-probe.mjs");
after(() => { assert.deepEqual(GUARD, { request: 0, Agent: 0, fetch: 0 }, "no real network primitive was touched"); });

const T = P.TARGET; const RID = T.reservationId;
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
const reply = (status, x) => ({ status, contentType: "application/json", bytes: enc(x) });
const reservation = (over = {}) => ({ id: Number(RID), listingMapId: T.listingId, channelId: 2000, arrivalDate: T.from, departureDate: T.to, totalPrice: T.finalTotalMinor / 100, currency: "USD", status: "new",
  customFieldValues: [{ customFieldId: P.CONFIG.refFieldId, value: T.ref }], guestName: "SHOULD-NEVER-APPEAR", guestEmail: "never@example.invalid", ...over });
const listEnv = (rows, over = {}) => ({ status: "success", result: rows, count: rows.length, limit: 500, offset: null, ...over });
const chargeRow = (over = {}) => ({ id: 7700777, listingMapId: T.listingId, reservationId: Number(RID), type: "charge", title: "unrelated manual charge", currency: "USD", paymentMethod: "credit_card", amount: 5, status: "paid", paymentProvider: "offline", ...over });
function fakeExchange(o = {}) {
  const calls = [];
  const ex = async (req) => {
    calls.push({ method: req.method, url: req.url, hasAuth: typeof req.headers?.Authorization === "string" });
    const u = new URL(req.url);
    if (o.throwOn === calls.length) throw new Error("socket reset");
    if (/^\/v1\/reservations\/\d+$/.test(u.pathname)) return o.identity ?? reply(200, { status: "success", result: reservation() });
    if (u.pathname === "/v1/guestPayments/charges") return o.list ?? reply(200, listEnv([]));
    return reply(404, { status: "fail" });
  };
  return { ex, calls };
}
let tooling = null;
const load = async () => tooling ??= (await (async () => { const lt = await P.loadTooling(TOOLING); assert.equal(lt.ok, true, JSON.stringify(lt)); return lt.tooling; })());
const run = async (o = {}) => { const f = fakeExchange(o); const r = await P.runProbe({ tooling: await load(), exchange: f.ex, credential: () => "synthetic-hostaway-token", clientSnapshotId: "c17-test", ...o.over }); return { r, calls: f.calls }; };
const noLeak = (r) => { const s = JSON.stringify(r); assert.doesNotMatch(s, /SHOULD-NEVER-APPEAR|example\.invalid|synthetic-hostaway-token|Authorization|Bearer/, "no raw body / guest / token in the result"); };

test("P0 pinned tooling: the three modules at E7_TOOLING_DIR match the probe's digests; a drifted byte is refused before import; a missing file is refused", async () => {
  const lt = await P.loadTooling(TOOLING);
  assert.equal(lt.ok, true, JSON.stringify(lt)); assert.deepEqual(lt.digests, P.PINNED_FILES);
  const drift = await P.loadTooling(TOOLING, { readFile: async (p) => { const b = readFileSync(p); return p.endsWith("http-transports.mjs") ? Buffer.concat([b, Buffer.from("\n// drift")]) : b; } });
  assert.deepEqual([drift.ok, drift.code, drift.file], [false, "TOOLING_DIGEST_MISMATCH", "scripts/e7-connected/http-transports.mjs"]);
  const missing = await P.loadTooling(TOOLING, { readFile: async (p) => { if (p.endsWith("hostaway-reservations.js")) throw new Error("ENOENT"); return readFileSync(p); } });
  assert.deepEqual([missing.ok, missing.code], [false, "TOOLING_INVALID"]);
  assert.deepEqual([(await P.loadTooling("/nonexistent/dir")).code], ["TOOLING_INVALID"]);
});

test("P1 happy shape: ONE identity GET then ONE list GET with the exact accepted selector; identity bound (listing / stay / ref / channel / total / active); empty list → SHAPE_COMPATIBLE, matching 0; exactly 2 calls, both GET, Authorization present on the wire but never in the result", async () => {
  const { r, calls } = await run();
  assert.equal(r.stop, null, JSON.stringify(r)); assert.equal(r.outcome, "SHAPE_COMPATIBLE");
  assert.deepEqual(calls.map((c) => [c.method, c.url, c.hasAuth]), [["GET", `https://api.hostaway.com/v1/reservations/${RID}`, true], ["GET", `https://api.hostaway.com/v1/guestPayments/charges?limit=500&reservationIds=${RID}`, true]]);
  assert.deepEqual([r.calls, r.attempted, r.urls], [2, 2, [`GET /v1/reservations/${RID}`, `GET /v1/guestPayments/charges?limit=500&reservationIds=${RID}`]]);
  assert.deepEqual(r.identity, { httpStatus: 200, envelope: "success", ok: true, code: null, reservation: { reservationId: RID, listingId: T.listingId, channelId: 2000, from: T.from, to: T.to, totalMinor: T.finalTotalMinor, currency: "USD", status: "new", bookingRefMatches: true } });
  assert.deepEqual([r.list.ok, r.list.rowCount, r.list.matchingChargeCount, r.list.sameAmountPaidCount, r.list.lookalikeCount, r.list.typesSeen, r.list.paginationFields], [true, 0, 0, 0, 0, [], ["limit", "offset"]]);
  assert.equal(r.target, T); assert.equal(r.toolingCommit, P.TOOLING_COMMIT);
  noLeak(r);
});

test("P2 non-empty list shapes: unrelated paid charge rows are summarised (ids / type / status / amount only); a refund row with a negative exact amount is accepted; a same-amount paid charge and a marker lookalike are COUNTED, not interpreted", async () => {
  const rows = [chargeRow(), chargeRow({ id: 7700778, type: "refund", amount: -5, status: "paid" }), chargeRow({ id: 7700779, amount: T.capturedMinor / 100 }), chargeRow({ id: 7700780, title: `maraVilla payment MVOCH1-${T.intentId.toUpperCase()}` })];
  const { r } = await run({ list: reply(200, listEnv(rows)) });
  assert.equal(r.stop, null, JSON.stringify(r));
  assert.deepEqual([r.list.rowCount, r.list.typesSeen, r.list.sameAmountPaidCount, r.list.lookalikeCount, r.list.matchingChargeCount], [4, ["charge", "refund"], 1, 1, 0]);
  assert.deepEqual(r.list.rows[1], { chargeId: "7700778", type: "refund", status: "paid", amountMinor: -500, currency: "USD", paymentProvider: "offline", paymentMethod: "credit_card" });
  assert.ok(!("title" in r.list.rows[0]), "titles are not echoed"); noLeak(r);
});

test("P3 identity refusals STOP before any list call (exactly 1 call): cancelled / wrong listing / wrong stay / wrong total / ref missing / foreign ref / wrong channel / fail envelope / non-200 / malformed", async () => {
  const cases = [
    [reply(200, { status: "success", result: reservation({ status: "cancelled" }) }), "IDENTITY_STATUS_NOT_ACTIVE"],
    [reply(200, { status: "success", result: reservation({ listingMapId: 603566 }) }), "IDENTITY_LISTING_MISMATCH"],
    [reply(200, { status: "success", result: reservation({ departureDate: "2026-11-25" }) }), "IDENTITY_DEPARTURE_MISMATCH"],
    [reply(200, { status: "success", result: reservation({ totalPrice: 150 }) }), "IDENTITY_TOTAL_MISMATCH"],
    [reply(200, { status: "success", result: reservation({ customFieldValues: [] }) }), "IDENTITY_REF_MISMATCH"],
    [reply(200, { status: "success", result: reservation({ customFieldValues: [{ customFieldId: P.CONFIG.refFieldId, value: "MV-OTHER01" }] }) }), "IDENTITY_REF_MISMATCH"],
    [reply(200, { status: "success", result: reservation({ channelId: 2018 }) }), "IDENTITY_CHANNEL_MISMATCH"],
    [reply(200, { status: "success", result: reservation({ id: 71700932 }) }), "IDENTITY_RESERVATION_ID_MISMATCH"],
    [reply(200, { status: "fail", result: null }), "IDENTITY_FAIL_ENVELOPE"],
    [reply(200, { result: reservation() }), "IDENTITY_MALFORMED_ENVELOPE"],
    [reply(404, { status: "fail" }), "IDENTITY_HTTP_STATUS"],
    [reply(200, { status: "success", result: "not-an-object" }), "IDENTITY_RESULT_NOT_OBJECT"],
  ];
  for (const [identity, code] of cases) {
    const { r, calls } = await run({ identity });
    assert.deepEqual([r.stop, r.identity.ok, r.identity.code, calls.length, r.list], ["IDENTITY_REFUSED", false, code, 1, undefined], `${code}: ${JSON.stringify(r)}`);
    noLeak(r);
  }
});

test("P4 list refusals / ambiguity STOP with a code (2 calls, never a third, never a different selector): fail envelope, non-200, count/length mismatch, foreign reservation row, foreign listing row, duplicate id, malformed row, FULL page (500 → ambiguous), hasMore/nextPage signalled", async () => {
  const full = Array.from({ length: 500 }, (_, i) => chargeRow({ id: 7800000 + i }));
  const cases = [
    [reply(200, { status: "fail", result: [] }), "LIST_REFUSED", "LIST_FAIL_ENVELOPE"],
    [reply(500, { status: "fail" }), "LIST_REFUSED", "LIST_HTTP_STATUS"],
    [reply(200, listEnv([chargeRow()], { count: 2 })), "LIST_REFUSED", "LIST_COUNT_LENGTH_MISMATCH"],
    [reply(200, listEnv([chargeRow({ reservationId: 71700932 })])), "LIST_REFUSED", "LIST_FOREIGN_RESERVATION_ROW"],
    [reply(200, listEnv([chargeRow({ listingMapId: 603566 })])), "LIST_REFUSED", "LIST_FOREIGN_LISTING_ROW"],
    [reply(200, listEnv([chargeRow(), chargeRow()])), "LIST_REFUSED", "LIST_DUPLICATE_ID"],
    [reply(200, listEnv([chargeRow({ amount: "5" })])), "LIST_REFUSED", "LIST_ROW_AMOUNT_INVALID"],
    [reply(200, listEnv(full)), "LIST_PAGE_FULL_AMBIGUOUS", "PAGE_FULL"],
    [reply(200, listEnv([chargeRow()], { hasMore: true })), "LIST_PAGINATION_FIELDS_AMBIGUOUS", "MORE_PAGES_SIGNALLED"],
    [reply(200, listEnv([chargeRow()], { nextPage: 2 })), "LIST_PAGINATION_FIELDS_AMBIGUOUS", "MORE_PAGES_SIGNALLED"],
  ];
  for (const [list, stop, code] of cases) {
    const { r, calls } = await run({ list });
    assert.deepEqual([r.stop, r.identity.ok, r.list.ok, r.list.code, calls.length, r.calls], [stop, true, false, code, 2, 2], `${code}: ${JSON.stringify(r)}`);
    noLeak(r);
  }
  const { r } = await run({ list: reply(200, listEnv([chargeRow()], { nextPage: null, hasMore: false })) });
  assert.equal(r.stop, null, "falsy pagination markers are reported, not ambiguous: " + JSON.stringify(r.list));
});

test("P5 transport: redirects are refused by the accepted transport (never followed); a thrown exchange is final (no retry); a transport error on the identity call means ZERO list calls; a bad credential never reaches the wire", async () => {
  let x = await run({ identity: reply(302, {}) });
  assert.deepEqual([x.r.stop, x.r.transportCode, x.calls.length], ["IDENTITY_TRANSPORT_ERROR", "REDIRECT_REFUSED", 1]);
  x = await run({ list: reply(301, {}) });
  assert.deepEqual([x.r.stop, x.r.transportCode, x.calls.length], ["LIST_TRANSPORT_ERROR", "REDIRECT_REFUSED", 2]);
  x = await run({ throwOn: 1 });
  assert.deepEqual([x.r.stop, x.calls.length, x.r.attempted], ["IDENTITY_TRANSPORT_ERROR", 1, 1], "no retry, no list");
  x = await run({ throwOn: 2 });
  assert.deepEqual([x.r.stop, x.calls.length, x.r.attempted], ["LIST_TRANSPORT_ERROR", 2, 2], "no retry");
  x = await run({ over: { credential: () => "" } });
  assert.deepEqual([x.r.stop, x.r.transportCode, x.calls.length], ["IDENTITY_TRANSPORT_ERROR", "CREDENTIAL_INVALID", 0]);
  const bad = await P.runProbe({ tooling: await load(), exchange: "nope", credential: () => "t" });
  assert.deepEqual([bad.stop, bad.calls], ["TRANSPORT_INVALID", 0]);
});

test("P6 the probe's own guard: anything but the two exact GET URLs on api.hostaway.com is refused before the exchange (POST / other host / other reservation / extra query / body / third call)", async () => {
  const st = () => ({ attempted: 0, sent: 0, urls: [], guardRefusals: [] });
  const ex = async () => reply(200, {});
  for (const [req, why] of [
    [{ method: "POST", url: `https://api.hostaway.com/v1/guestPayments/charges/${RID}`, headers: {}, body: "{}" }, "NOT_GET"],
    [{ method: "GET", url: `https://api.evil.example/v1/reservations/${RID}`, headers: {}, body: null }, "ORIGIN"],
    [{ method: "GET", url: "https://api.hostaway.com/v1/reservations/71700932", headers: {}, body: null }, "PATH"],
    [{ method: "GET", url: "https://api.hostaway.com/v1/reservations", headers: {}, body: null }, "PATH"],
    [{ method: "GET", url: `https://api.hostaway.com/v1/guestPayments/charges?limit=500&reservationIds=71700932`, headers: {}, body: null }, "QUERY"],
    [{ method: "GET", url: `https://api.hostaway.com/v1/guestPayments/charges?limit=100&reservationIds=${RID}`, headers: {}, body: null }, "QUERY"],
    [{ method: "GET", url: `https://api.hostaway.com/v1/reservations/${RID}?includeResources=1`, headers: {}, body: null }, "QUERY"],
    [{ method: "GET", url: `https://api.hostaway.com/v1/reservations/${RID}`, headers: {}, body: "{}" }, "BODY"],
  ]) { const s = st(); await assert.rejects(P.guardedExchange(ex, s)(req), /GUARD_REFUSED/); assert.deepEqual([s.guardRefusals, s.sent], [[why], 0], why); }
  const s = st(); const g = P.guardedExchange(ex, s);
  const ok = { method: "GET", url: `https://api.hostaway.com/v1/reservations/${RID}`, headers: {}, body: null };
  await g(ok); await g(ok); await assert.rejects(g(ok), /GUARD_REFUSED/); assert.deepEqual([s.sent, s.guardRefusals], [2, ["BUDGET"]]);
});

test("P7 static: the probe imports node built-ins only; no POST / PUT / DELETE / DB / worker / record / cancel / refund / notify / Stripe call text in code; no executor phase; inert import (env / fetch only after the main guard); fixed target constants", () => {
  const src = readFileSync(join(ROOT, "scripts/e7-hosted-charge-list-probe.mjs"), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.deepEqual([...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]), ["node:crypto", "node:fs/promises", "node:url"]);
  assert.doesNotMatch(code, /method: "(POST|PUT|DELETE|PATCH)"|createPhaseExecutors|createOfflineCharge|recording-worker|repo\.js|operations\.js|pg\b|statuses\/cancelled|refund|notify|api\.stripe\.com|createE7StripeTestSend|\/guestPayments\/charges\/\$/);
  assert.ok(src.indexOf("process.env") > src.indexOf("import.meta.main === true"), "env only after the main guard");
  assert.ok(src.indexOf("fetch(") > src.indexOf("import.meta.main === true"), "fetch only inside the main guard");
  assert.deepEqual([T.listingId, T.reservationId, T.ref, T.from, T.to, T.currency, T.finalTotalMinor, T.capturedMinor, P.MAX_CALLS, P.LIST_LIMIT], [606998, "71700931", "MV-8L79DEJ7", "2026-11-23", "2026-11-24", "USD", 14000, 14000, 2, 500]);
  assert.ok(Object.isFrozen(T) && Object.isFrozen(P.CONFIG) && Object.isFrozen(P.ALLOWED));
});
