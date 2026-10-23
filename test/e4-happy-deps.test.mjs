// E4 happy-path dependencies — side-effect reader + injected transport. Offline: a MOCK fetchImpl backed by a fake
// in-memory provider (synthetic; not provider evidence). No global fetch, credentials, env or network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSideEffectProbe, evaluateSideEffectResponse, sideEffectRequest, SIDE_EFFECT_SOURCES } from "../scripts/e4-write-runner/side-effects.mjs";
import { createHostawayTransport } from "../scripts/e4-transport/hostaway-transport.mjs";
import { validateHappyManifest, executeHappyRun } from "../scripts/e4-write-runner/happy-path.mjs";
import { createFileJournal } from "../scripts/e4-write-runner/journal.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const [CHARGES, CONVERSATIONS, TASKS] = SIDE_EFFECT_SOURCES;
const ID = 8000001;
const ok = (json) => ({ httpStatus: 200, json });
const FAKE_SECRET = "FAKE-client-secret-not-real-123";
const FAKE_TOKEN = "FAKE-access-token-not-real-456";
const CREDS = async () => ({ accountId: "12345", clientSecret: FAKE_SECRET });
const noSleep = async () => {};

// ---------- evaluator ----------
test("charges: zero only with success, empty page AND documented count 0; present / unknown otherwise", () => {
  const e = (resp) => evaluateSideEffectResponse(CHARGES, resp, ID);
  assert.deepEqual({ ...e(ok({ status: "success", result: [], count: 0, offset: null })) }, { source: "CHARGES", state: "zero", code: "CHARGES_NONE" });
  assert.equal(e(ok({ status: "success", result: [{ reservationId: ID, title: "SYNTH", amount: 10 }], count: 1 })).state, "present");
  assert.equal(e(ok({ status: "success", result: [], count: 3 })).state, "present", "count is the documented total");
  for (const [resp, code] of [[ok({ status: "success", result: [] }), "CHARGES_COUNT_MISSING"], [ok({ status: "success", result: [], count: "0" }), "CHARGES_COUNT_INVALID"],
    [ok({ status: "success", result: [{ reservationId: ID }, { reservationId: ID }], count: 1 }), "CHARGES_COUNT_INCONSISTENT"],
    [ok({ status: "success", result: [{ reservationId: 999 }], count: 1 }), "CHARGES_FILTER_NOT_APPLIED"], [ok({ status: "fail", result: [] }), "CHARGES_MALFORMED"],
    [{ httpStatus: 403, json: {} }, "CHARGES_HTTP_NOT_OK"], [{ transportError: true }, "CHARGES_TRANSPORT_UNCERTAIN"], [null, "CHARGES_TRANSPORT_UNCERTAIN"],
    [ok({ status: "success", result: Array.from({ length: 101 }, () => ({ reservationId: ID })), count: 101 }), "CHARGES_PAGE_OVER_LIMIT"]]) {
    assert.deepEqual([e(resp).state, e(resp).code], ["unknown", code], JSON.stringify(resp).slice(0, 80));
  }
  assert.ok(!JSON.stringify(e(ok({ status: "success", result: [{ reservationId: ID, title: "SYNTH-TITLE" }], count: 1 }))).includes("SYNTH"));
});

test("conversations/tasks: only ZERO can be certified (empty filtered page); any item => present; never a count", () => {
  for (const src of [CONVERSATIONS, TASKS]) {
    const e = (resp) => evaluateSideEffectResponse(src, resp, ID);
    assert.equal(e(ok({ status: "success", result: [] })).state, "zero", src.name);
    assert.equal(e(ok({ status: "success", result: [], count: 0 })).state, "zero");
    assert.equal(e(ok({ status: "success", result: [{ reservationId: String(ID), guestEmail: "x@example.invalid" }] })).state, "present", "documented string id");
    assert.equal(e(ok({ status: "success", result: [{ reservationId: ID }] })).state, "present");
    assert.equal(e(ok({ status: "success", result: [{ reservationId: 7 }] })).code, `${src.name}_FILTER_NOT_APPLIED`, "ignored filter => unknown, not zero");
    assert.equal(e(ok({ status: "success", result: [{ reservationId: "08000001" }] })).state, "unknown");
    assert.equal(e(ok({ status: "success", result: [], count: 2 })).code, `${src.name}_COUNT_INCONSISTENT`);
    assert.equal(e(ok({ status: "success", result: {} })).state, "unknown");
    assert.equal(e({ httpStatus: 500, json: null }).state, "unknown");
    assert.ok(!Object.keys(e(ok({ status: "success", result: [] }))).includes("count"));
  }
});

// ---------- probe ----------
test("probe: fixed reservation-scoped reads; {signals:[]} only if all three are zero; budget 2 calls; bad scope sends nothing", async () => {
  const sent = [];
  let answer = () => ok({ status: "success", result: [], count: 0 });
  const p = createSideEffectProbe({ send: async (req) => { sent.push(req); return answer(req); } });
  assert.deepEqual(await p.probe({ step: "HW1_CREATE", listingId: 606998, reservationIds: [ID] }), { signals: [] });
  assert.deepEqual(sent.map((r) => [r.method, r.path, JSON.stringify(r.query)]), [
    ["GET", "/guestPayments/charges", `{"reservationId":${ID},"limit":100,"offset":0}`],
    ["GET", "/conversations", `{"reservationId":${ID},"limit":100,"offset":0}`],
    ["GET", "/tasks", `{"reservationId":${ID},"limit":100,"offset":0}`]]);
  answer = (req) => (req.path === "/conversations" ? ok({ status: "success", result: [{ reservationId: String(ID) }] }) : { httpStatus: 500, json: null });
  assert.deepEqual(await p.probe({ step: "HW2_CANCEL", listingId: 606998, reservationIds: [ID] }), { signals: ["CONVERSATIONS_PRESENT"] });
  const before = sent.length;
  assert.deepEqual(await p.probe({ step: "x", listingId: 606998, reservationIds: [ID] }), { unknown: ["PROBE_BUDGET_EXHAUSTED"] });
  assert.equal(sent.length, before);
  const q = createSideEffectProbe({ send: async (req) => { sent.push(req); return ok({ status: "success", result: [], count: 0 }); } });
  const n = sent.length;
  for (const bad of [{ listingId: 603564, reservationIds: [ID] }, { listingId: 606998, reservationIds: [] }, { listingId: 606998, reservationIds: [1, 2] }, { listingId: 606998, reservationIds: ["8000001"] }, null]) {
    assert.deepEqual(await createSideEffectProbe({ send: async (r) => { sent.push(r); return ok({}); } }).probe(bad), { unknown: ["PROBE_SCOPE_INVALID"] });
  }
  assert.equal(sent.length, n);
  const unk = createSideEffectProbe({ send: async () => { throw new Error("boom"); } });
  assert.deepEqual(await unk.probe({ listingId: 606998, reservationIds: [ID] }), { unknown: ["CHARGES_TRANSPORT_UNCERTAIN", "CONVERSATIONS_TRANSPORT_UNCERTAIN", "TASKS_TRANSPORT_UNCERTAIN"] });
  assert.equal(q.usage().calls, 0);
});

// ---------- transport ----------
function mockFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: String(url), origin: u.origin, path: u.pathname, query: Object.fromEntries(u.searchParams), method: init.method, headers: { ...(init.headers || {}) },
      body: init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init.body, hasSignal: !!init.signal, redirect: init.redirect });
    return handler(calls.at(-1));
  };
  return { fetchImpl, calls };
}
const json = (status, body) => new Response(body === undefined ? "" : JSON.stringify(body), { status });
const MINT_OK = () => json(200, { token_type: "Bearer", expires_in: 3600, access_token: FAKE_TOKEN });

test("transport: one form-encoded mint + activation delay; bearer GET/POST/PUT; one fetch per send; nothing secret returned", async () => {
  let sleeps = 0;
  const m = mockFetch((c) => (c.path === "/v1/accessTokens" ? MINT_OK() : json(200, { status: "success", result: { echo: c.method } })));
  const t = createHostawayTransport({ fetchImpl: m.fetchImpl, getCredentials: CREDS, sleep: async () => { sleeps++; } });
  const r1 = await t.send({ method: "GET", path: "/reservations/8000001", query: { includeResources: 1 } });
  const r2 = await t.send({ method: "POST", path: "/reservations", query: {}, body: { a: 1 } });
  const r3 = await t.send({ method: "PUT", path: "/reservations/8000001/statuses/cancelled", query: {}, body: { cancelledBy: "host" } });
  assert.deepEqual([r1.httpStatus, r2.json.result.echo, r3.json.result.echo], [200, "POST", "PUT"]);
  assert.equal(sleeps, 1);
  assert.deepEqual(m.calls.map((c) => `${c.method} ${c.origin}${c.path}`), ["POST https://api.hostaway.com/v1/accessTokens", "GET https://api.hostaway.com/v1/reservations/8000001",
    "POST https://api.hostaway.com/v1/reservations", "PUT https://api.hostaway.com/v1/reservations/8000001/statuses/cancelled"]);
  assert.deepEqual(m.calls[0].body, { grant_type: "client_credentials", client_id: "12345", client_secret: FAKE_SECRET, scope: "general" });
  assert.equal(m.calls[0].headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.deepEqual(m.calls[1].query, { includeResources: "1" });
  assert.equal(m.calls[1].headers.Authorization, `Bearer ${FAKE_TOKEN}`);
  assert.equal(m.calls[2].body, JSON.stringify({ a: 1 }));
  assert.equal(m.calls[3].body, JSON.stringify({ cancelledBy: "host" }));
  assert.ok(m.calls.every((c) => c.hasSignal && c.redirect === "error"));
  const text = JSON.stringify([r1, r2, r3, t.usage()]);
  assert.ok(!text.includes(FAKE_SECRET) && !text.includes(FAKE_TOKEN));
});

test("transport: 401/403/429/5xx returned as-is — no retry, no re-mint; a failed mint is final; fetch errors are TRANSPORT_ERROR", async () => {
  let m = mockFetch((c) => (c.path === "/v1/accessTokens" ? MINT_OK() : json(401, { status: "fail" })));
  let t = createHostawayTransport({ fetchImpl: m.fetchImpl, getCredentials: CREDS, sleep: noSleep });
  for (const s of [1, 2]) assert.equal((await t.send({ method: "GET", path: "/reservations/1" })).httpStatus, 401, String(s));
  assert.equal(m.calls.filter((c) => c.path === "/v1/accessTokens").length, 1, "never re-minted");
  assert.equal(m.calls.length, 3, "one fetch per send");
  for (const mint of [() => json(401, { status: "fail" }), () => json(200, {}), () => new Response("not json", { status: 200 }), () => { throw new Error("net"); }]) {
    m = mockFetch((c) => (c.path === "/v1/accessTokens" ? mint() : json(200, { status: "success" })));
    t = createHostawayTransport({ fetchImpl: m.fetchImpl, getCredentials: CREDS, sleep: noSleep });
    assert.deepEqual({ ...(await t.send({ method: "GET", path: "/reservations/1" })) }, { transportError: true, code: "AUTH_UNAVAILABLE" });
    assert.deepEqual({ ...(await t.send({ method: "GET", path: "/reservations/1" })) }, { transportError: true, code: "AUTH_UNAVAILABLE" });
    assert.equal(m.calls.length, 1, "failed mint is final: no second mint, no data request");
  }
  for (const creds of [async () => ({ accountId: "", clientSecret: "x" }), async () => ({ accountId: "12345" }), async () => null, async () => { throw new Error("prompt"); }]) {
    m = mockFetch(() => MINT_OK());
    t = createHostawayTransport({ fetchImpl: m.fetchImpl, getCredentials: creds, sleep: noSleep });
    assert.equal((await t.send({ method: "GET", path: "/reservations/1" })).code, "AUTH_UNAVAILABLE");
    assert.equal(m.calls.length, 0, "invalid credentials: nothing sent");
  }
  m = mockFetch((c) => { if (c.path === "/v1/accessTokens") return MINT_OK(); throw new Error("socket"); });
  t = createHostawayTransport({ fetchImpl: m.fetchImpl, getCredentials: CREDS, sleep: noSleep });
  assert.deepEqual({ ...(await t.send({ method: "GET", path: "/reservations/1" })) }, { transportError: true, code: "TRANSPORT_ERROR" });
});

test("transport: refuses DELETE/PATCH, traversal, odd paths, nested/odd query values, bodies on GET — with zero network calls", async () => {
  const m = mockFetch(() => MINT_OK());
  const t = createHostawayTransport({ fetchImpl: m.fetchImpl, getCredentials: CREDS, sleep: noSleep });
  for (const req of [{ method: "DELETE", path: "/reservations/1" }, { method: "PATCH", path: "/reservations/1", body: {} }, { method: "GET", path: "/../v2/x" },
    { method: "GET", path: "//evil.example/x" }, { method: "GET", path: "/reservations?x=1" }, { method: "GET", path: "/reservations/%2e%2e" }, { method: "GET", path: "reservations" },
    { method: "GET", path: "/reservations", query: { a: { b: 1 } } }, { method: "GET", path: "/reservations", query: { a: [1] } }, { method: "GET", path: "/reservations", query: { "a b": 1 } },
    { method: "GET", path: "/reservations", query: { a: Number.NaN } }, { method: "GET", path: "/reservations", body: {} }, { method: "PUT", path: "/reservations/1" }, null]) {
    assert.deepEqual({ ...(await t.send(req)) }, { transportError: true, code: "REQUEST_REFUSED" }, JSON.stringify(req));
  }
  assert.equal(m.calls.length, 0);
  assert.throws(() => createHostawayTransport({ getCredentials: CREDS }), TypeError);
  assert.throws(() => createHostawayTransport({ fetchImpl: m.fetchImpl }), TypeError);
});

// ---------- integration with the reviewed happy-path runner (mock fetch -> fake provider) ----------
function fakeProviderFetch({ conversations = 0, charges = 0, tasks = 0, createStatus = 200 } = {}) {
  const reservations = [];
  let nextId = ID;
  const m = mockFetch((c) => {
    const p = c.path.replace(/^\/v1/, "");
    let r;
    if (c.method === "POST" && p === "/accessTokens") return MINT_OK();
    if (c.headers.Authorization !== `Bearer ${FAKE_TOKEN}`) return json(401, { status: "fail" });
    if (c.method === "POST" && /\/calendar\/priceDetails$/.test(p)) return json(200, { status: "success", result: { totalPrice: 250 } });
    if (c.method === "POST" && p === "/reservations") {
      if (createStatus !== 200) return json(createStatus, { status: "fail" });
      const b = JSON.parse(c.body);
      r = { id: nextId++, listingMapId: b.listingMapId, channelId: b.channelId, arrivalDate: b.arrivalDate, departureDate: b.departureDate, totalPrice: b.totalPrice,
        currency: b.currency, status: "new", guestName: b.guestName, customFieldValues: b.customFieldValues };
      reservations.push(r);
      return json(200, { status: "success", result: r });
    }
    if (c.method === "GET" && p === "/reservations") {
      const items = reservations.filter((x) => x.arrivalDate === c.query.arrivalStartDate && String(x.listingMapId) === c.query.listingId);
      return json(200, { status: "success", result: c.query.afterId ? [] : items });
    }
    let mm;
    if (c.method === "GET" && (mm = /^\/reservations\/(\d+)$/.exec(p))) { r = reservations.find((x) => x.id === Number(mm[1])); return r ? json(200, { status: "success", result: r }) : json(404, { status: "fail" }); }
    if (c.method === "PUT" && (mm = /^\/reservations\/(\d+)\/statuses\/cancelled$/.exec(p))) { r = reservations.find((x) => x.id === Number(mm[1])); r.status = "cancelled"; return json(200, { status: "success", result: r }); }
    const rid = Number(c.query.reservationId);
    const list = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, reservationId: p === "/conversations" ? String(rid) : rid, title: "SYNTH-CONTENT" }));
    if (p === "/guestPayments/charges") return json(200, { status: "success", result: list(charges), count: charges, offset: null });
    if (p === "/conversations") return json(200, { status: "success", result: list(conversations) });
    if (p === "/tasks") return json(200, { status: "success", result: list(tasks) });
    return json(404, { status: "fail" });
  });
  return { ...m, reservations };
}
const NOW = () => new Date("2026-10-22T18:00:00.000Z");
const MANIFEST = { manifestVersion: "e4-happy-manifest-v1", listingId: 606998, refFieldId: 105433, currency: "USD", nightlyMinor: 10000, cleaningFeeMinor: 5000, guests: 2,
  window: { start: "2027-03-01", end: "2027-03-15" }, stay: { arrivalDate: "2027-03-03", departureDate: "2027-03-05" },
  guest: { firstName: "Synthetic", lastName: "Tester", email: "e4-synthetic@example.invalid" } };
async function runWith(fake) {
  const v = validateHappyManifest(MANIFEST, { now: NOW });
  const journal = createFileJournal(mkdtempSync(join(tmpdir(), "e4-deps-")), v.hash);
  const transport = createHostawayTransport({ fetchImpl: fake.fetchImpl, getCredentials: CREDS, sleep: noSleep });
  const se = createSideEffectProbe({ send: transport.send });
  const report = await executeHappyRun({ mode: "execute", manifest: MANIFEST, confirm: v.confirmToken, transport, journal, sideEffectProbe: se.probe, now: NOW, timeoutMs: 2000 });
  journal.close();
  return { report, journalText: readFileSync(journal.path, "utf8"), se, transport };
}
const sePaths = new Set(["/v1/guestPayments/charges", "/v1/conversations", "/v1/tasks"]);

test("integration: runner + transport + probe — completes; 1 mint; 1 create + 1 cancel; 6 side-effect reads; nothing secret journaled", async () => {
  const fake = fakeProviderFetch();
  const { report, journalText, se } = await runWith(fake);
  assert.equal(report.status, "COMPLETED", JSON.stringify(report.halt));
  assert.equal(fake.calls.filter((c) => c.path === "/v1/accessTokens").length, 1);
  assert.deepEqual(fake.calls.filter((c) => c.method !== "GET" && c.path !== "/v1/accessTokens" && !c.path.endsWith("priceDetails")).map((c) => `${c.method} ${c.path}`),
    ["POST /v1/reservations", `PUT /v1/reservations/${ID}/statuses/cancelled`]);
  assert.equal(fake.calls.filter((c) => sePaths.has(c.path)).length, 6);
  assert.ok(fake.calls.filter((c) => sePaths.has(c.path)).every((c) => c.query.reservationId === String(ID)));
  assert.deepEqual(se.usage(), { calls: 2, reads: 6 });
  for (const x of [FAKE_SECRET, FAKE_TOKEN, "SYNTH-CONTENT", "Synthetic", "e4-synthetic@"]) assert.ok(!journalText.includes(x), x);
});

test("integration: a conversation thread, a charge or a task on the new reservation => halt at the create; the cancel is never sent", async () => {
  for (const opt of [{ conversations: 1 }, { charges: 1 }, { tasks: 2 }]) {
    const fake = fakeProviderFetch(opt);
    const { report } = await runWith(fake);
    assert.deepEqual([report.status, report.halt.step, report.halt.code], ["HALTED", "HW1_CREATE", "SIDE_EFFECT_SIGNAL"], JSON.stringify(opt));
    assert.ok(!fake.calls.some((c) => c.method === "PUT"), JSON.stringify(opt));
  }
});

test("integration: a 401 on the create => exactly one create fetch, no re-mint, halted, reads only afterwards", async () => {
  const fake = fakeProviderFetch({ createStatus: 401 });
  const { report } = await runWith(fake);
  assert.deepEqual([report.status, report.halt.step], ["HALTED", "HW1_CREATE"]);
  assert.equal(fake.calls.filter((c) => c.method === "POST" && c.path === "/v1/reservations").length, 1);
  assert.equal(fake.calls.filter((c) => c.path === "/v1/accessTokens").length, 1);
  const k = fake.calls.findIndex((c) => c.method === "POST" && c.path === "/v1/reservations");
  assert.ok(fake.calls.slice(k + 1).every((c) => c.method === "GET"));
});

// ---------- containment ----------
test("containment: transport/reader read no env/files/globals; nothing deployable imports them; the CLI imports them only via the launcher", () => {
  const tsrc = readFileSync(join(ROOT, "scripts/e4-transport/hostaway-transport.mjs"), "utf8");
  const ssrc = readFileSync(join(ROOT, "scripts/e4-write-runner/side-effects.mjs"), "utf8");
  for (const [n, src] of [["transport", tsrc], ["side-effects", ssrc]]) {
    for (const re of [/process\.env/, /\bimport\s[^;]*node:fs/, /readFileSync|writeFileSync/, /console\./, /from\s+"[^"]*lib\/hostaway\.js"/, /child_process/, /readline/, /(^|[^.\w])fetch\s*\(/m]) {
      assert.doesNotMatch(src, re, `${n} ${re}`);
    }
  }
  assert.doesNotMatch(tsrc, /^import /m, "the transport imports nothing");
  const walk = (d, out = []) => {
    for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p, out); else if (/\.(m?js|cjs)$/.test(e.name) && /hostaway-transport|side-effects/.test(readFileSync(join(ROOT, p), "utf8"))) out.push(p);
    }
    return out;
  };
  assert.deepEqual([...walk("api"), ...walk("lib"), ...walk("db")], []);
  const cli = readFileSync(join(ROOT, "scripts/e4-write-runner/happy-cli.mjs"), "utf8");
  assert.doesNotMatch(cli, /hostaway-transport|side-effects|executeHappyRun/);
  assert.ok(readFileSync(join(ROOT, ".vercelignore"), "utf8").split("\n").includes("/scripts"));
});
