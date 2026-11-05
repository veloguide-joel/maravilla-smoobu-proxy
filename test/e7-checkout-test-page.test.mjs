// E7 checkout TEST page — public/checkout-test.js logic with FAKE API / storage / timers / navigation (UNIT MOCKS, no DOM, no network).
// Browser-header and rendering evidence come from a separate loopback Chromium rehearsal (claude/e7-checkout-test-page.md), not from here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createApi, createController, createStore, describe, validateCheckoutUrl, POLL, STORE_KEY, API } from "../public/checkout-test.js";

const TOKEN = Buffer.alloc(32, 3).toString("base64url");
const CFG = Object.freeze({ listingId: 606998, currency: "USD", termsVersion: "terms-2026-11" });
const PRICE = { currency: "USD", totalMinor: 37500, lines: [{ label: "3 nights", amountMinor: 37500 }] };

function memStorage() { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } }; }
const brokenStorage = () => ({ getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } });
function fakeTimers() {
  const t = { now: 1_800_000_000_000, q: [], setTimeout(fn, ms) { const id = Symbol("t"); t.q.push({ id, fn, at: t.now + ms }); return id; },
    clearTimeout(id) { t.q = t.q.filter((x) => x.id !== id); },
    async tick() { const x = t.q.sort((a, b) => a.at - b.at).shift(); if (!x) return false; t.now = Math.max(t.now, x.at); await x.fn(); return true; } };
  return t;
}
/** scripted fake API: each method shifts a reply from its queue (default reply otherwise) and records calls */
function fakeApi(script = {}) {
  const calls = []; const q = { create: [], details: [], pay: [], release: [], status: [], ...script };
  const def = { create: { kind: "reply", http: 201, body: { token: TOKEN, status: "awaiting_details", price: PRICE } },
    details: { kind: "reply", http: 200, body: { status: "awaiting_details" } },   // ACCEPTED shape: details_collected still maps to awaiting_details
    pay: { kind: "reply", http: 200, body: { status: "awaiting_payment", checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_x#frag" } },
    release: { kind: "reply", http: 202, body: { status: "release_requested", release: "REQUESTED" } },
    status: { kind: "reply", http: 200, body: { status: "processing", price: PRICE } } };
  const m = (k) => async (...a) => { calls.push([k, ...a.map((x) => (typeof x === "string" && x === TOKEN ? "<token>" : x))]); return q[k].length ? q[k].shift() : def[k]; };
  return { calls, q, count: (k) => calls.filter((c) => c[0] === k).length, api: { create: m("create"), details: m("details"), pay: m("pay"), release: m("release"), status: m("status") } };
}
function rig({ storage = memStorage(), search = "", api = fakeApi(), timers = fakeTimers(), cfg = CFG } = {}) {
  const views = []; const nav = { assigned: [], stripped: 0, assign(u) { this.assigned.push(u); }, search: () => search, stripQuery() { this.stripped++; } };
  const c = createController({ api: api.api, store: createStore(storage), ui: { render: (v) => views.push(v) }, timers, nav, config: cfg, now: () => timers.now });
  return { c, views, nav, api, timers, storage, last: () => views[views.length - 1], get state() { return c.state; } };
}
const reply = (http, body) => ({ kind: "reply", http, body });

test("redirect validation: only https://checkout.stripe.com (no port / credentials); everything else refused", () => {
  assert.equal(validateCheckoutUrl("https://checkout.stripe.com/c/pay/cs_test_1"), "https://checkout.stripe.com/c/pay/cs_test_1");
  for (const u of ["http://checkout.stripe.com/c", "https://checkout.stripe.com.evil.example/c", "https://evil.example/https://checkout.stripe.com", "https://user:pw@checkout.stripe.com/c",
    "https://checkout.stripe.com:8443/c", "javascript:alert(1)", "//checkout.stripe.com/c", "https://stripe.com/c", "", null, 42, "https://checkout.stripe.com/" + "a".repeat(2100)]) {
    assert.equal(validateCheckoutUrl(u), null, String(u).slice(0, 60));
  }
});

test("status wording: authorization is a hold, never a booking; queued release != verified release; review and unexpected 'confirmed' are explicit", () => {
  assert.match(describe("processing").title, /not a booking/);
  assert.equal(describe("release_requested").kind, "releaseQueued"); assert.match(describe("release_requested").title, /not released yet/);
  assert.equal(describe("unavailable_not_charged", { releaseRequested: true }).kind, "released");
  assert.equal(describe("unavailable_not_charged").kind, "terminal");
  assert.equal(describe("under_review").kind, "review");
  assert.equal(describe("confirmed").kind, "unexpected"); assert.doesNotMatch(describe("confirmed").title, /confirmed/i);
  for (const s of ["processing", "release_requested", "under_review", "awaiting_payment"]) assert.doesNotMatch(describe(s).text + describe(s).title, /booking (is )?confirmed|reservation (is )?confirmed/i);
  assert.equal(describe("<img src=x>").kind, "unexpected");
});

test("storage: minimum state only (token + release flag + poll times), no guest data; refused storage is survivable and reported", () => {
  const s = memStorage(); const st = createStore(s);
  assert.equal(st.save({ token: TOKEN, releaseRequested: false, polls: [1, 2], guest: { email: "x@example.test" }, price: PRICE }), true);
  assert.deepEqual(Object.keys(JSON.parse(s.m.get(STORE_KEY))).sort(), ["detailsSaved", "polls", "releaseRequested", "token", "uncertain"]);
  s.setItem(STORE_KEY, JSON.stringify({ token: "not-a-token" })); assert.equal(st.load(), null);
  s.setItem(STORE_KEY, "{bad"); assert.equal(st.load(), null);
  const b = createStore(brokenStorage());
  assert.deepEqual([b.load(), b.save({ token: TOKEN }), b.clear()], [null, false, false]);
});

test("API client: exact same-origin paths, POST only, token only in Authorization, no credentials / referrer / redirects; network failure = unknown", async () => {
  const seen = [];
  const api = createApi(async (path, init) => { seen.push({ path, ...init, signal: !!init.signal }); return { status: 200, json: async () => ({ status: "processing" }) }; });
  await api.create({ listingId: 606998, from: "2027-01-10", to: "2027-01-13", guests: 2 }); await api.status(TOKEN); await api.release(TOKEN);
  assert.deepEqual(seen.map((x) => x.path), [API.intents, API.step, API.step]);
  assert.ok(seen.every((x) => x.method === "POST" && x.credentials === "omit" && x.referrerPolicy === "no-referrer" && x.redirect === "error" && x.mode === "same-origin" && x.cache === "no-store" && x.signal));
  assert.equal(seen[0].headers.Authorization, undefined);
  assert.equal(seen[1].headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(seen[1].body), { step: "status" }); assert.deepEqual(JSON.parse(seen[2].body), { step: "release" });
  assert.ok(!seen.some((x) => x.path.includes(TOKEN) || x.body.includes(TOKEN)), "token never in a URL or body");
  const down = createApi(async () => { throw new Error("offline"); });
  assert.deepEqual(await down.status(TOKEN), { kind: "unknown" });
  const html = createApi(async () => ({ status: 502, json: async () => { throw new Error("html"); } }));
  assert.equal((await html.pay(TOKEN)).kind, "unknown");
});

test("happy flow with Stripe return + reload: create -> details (configured terms) -> pay redirect (validated) -> return hint stripped -> bounded polling -> authorized -> release request -> queued -> verified", async () => {
  const timers = fakeTimers(); const storage = memStorage();
  const api = fakeApi({ status: [reply(200, { status: "awaiting_payment" }), reply(200, { status: "awaiting_payment" }), reply(200, { status: "processing", price: PRICE }),
    reply(200, { status: "release_requested" }), reply(200, { status: "unavailable_not_charged" })] });
  const a = rig({ storage, api, timers });
  await a.c.init();
  assert.equal(a.last().screen, "create");
  await a.c.create({ from: "2027-01-10", to: "2027-01-13", guests: 2 });
  assert.deepEqual(api.calls[0], ["create", { listingId: 606998, from: "2027-01-10", to: "2027-01-13", guests: 2 }], "listing from page config; server owns price");
  assert.equal(a.last().screen, "details"); assert.equal(a.last().price.totalMinor, 37500);
  await a.c.details({ firstName: "A", lastName: "B", email: "a@example.test", accepted: false });
  assert.equal(api.count("details"), 0, "terms must be accepted explicitly");
  await a.c.details({ firstName: "A", lastName: "B", email: "a@example.test", accepted: true });
  assert.equal(api.calls[1][2].termsVersion, "terms-2026-11");
  assert.ok(!JSON.stringify([...storage.m.values()]).includes("a@example.test"), "no guest data stored");
  await a.c.pay();
  assert.deepEqual(a.nav.assigned, ["https://checkout.stripe.com/c/pay/cs_test_x#frag"]);
  // the browser leaves for Stripe and comes back to a fresh page load with the return hint
  const b = rig({ storage, api, timers, search: "?checkout=complete" });
  await b.c.init();
  assert.equal(b.nav.stripped, 1, "the query hint is stripped from the URL");
  assert.equal(b.state.notice.code, "RETURNED_COMPLETE");
  assert.equal(b.last().screen, "pay", "the hint never counts as authorization");
  assert.equal(b.state.polling, true);
  await timers.tick(); assert.equal(b.last().screen, "pay");
  await timers.tick(); assert.equal(b.last().screen, "authorized");
  assert.equal(b.state.polling, false, "no polling while simply authorized");
  assert.equal(api.count("create") + api.count("pay"), 2, "a reload never creates or pays again");
  await b.c.release();
  assert.equal(b.last().screen, "releaseQueued"); assert.match(b.last().title, /not released yet/);
  await timers.tick(); assert.equal(b.last().screen, "releaseQueued");
  await timers.tick(); assert.equal(b.last().screen, "released");
  assert.equal(api.count("release"), 1);
  assert.equal(b.state.polling, false);
});

test("automatic status reads: <= 24 per 10 minutes per tab+token ACROSS reloads; one request at a time; 429 stops polling; manual refresh still possible", async () => {
  const timers = fakeTimers(); const storage = memStorage();
  createStore(storage).save({ token: TOKEN, releaseRequested: true, polls: [] });
  const api = fakeApi(); api.q.status = Array.from({ length: 200 }, () => reply(200, { status: "release_requested" }));
  let autos = 0;
  for (let reload = 0; reload < 6; reload++) {              // six reloads in the same tab within the window
    const r = rig({ storage, api, timers, search: "" });
    await r.c.init();
    while (r.state.polling && await timers.tick());
    autos = api.count("status");
  }
  assert.equal(autos, POLL.maxAuto, "budget is shared across reloads");
  const r = rig({ storage, api, timers });
  await r.c.init();
  assert.equal(api.count("status"), POLL.maxAuto); assert.equal(r.state.stopped, "BUDGET");
  await r.c.refresh(); assert.equal(api.count("status"), POLL.maxAuto + 1, "manual refresh is allowed");
  // after the window passes, automatic reads resume
  timers.now += POLL.windowMs + 1;
  const r2 = rig({ storage, api, timers }); await r2.c.init(); assert.equal(api.count("status"), POLL.maxAuto + 2);
  // 429 stops automatic reads at once
  const t3 = fakeTimers(); const s3 = memStorage(); createStore(s3).save({ token: TOKEN, releaseRequested: true, polls: [] });
  const a3 = fakeApi({ status: [reply(200, { status: "release_requested" }), reply(429, { code: "RATE_LIMITED" })] });
  const r3 = rig({ storage: s3, api: a3, timers: t3 }); await r3.c.init(); await t3.tick();
  assert.deepEqual([r3.state.stopped, r3.state.polling, a3.count("status"), t3.q.length], ["RATE_LIMITED", false, 2, 0]);
  // concurrency cap 1: a click while a request is in flight is ignored
  let release; const slow = fakeApi(); slow.api.status = async () => new Promise((res) => { release = res; });
  const r4 = rig({ storage: s3, api: slow }); const p = r4.c.refresh(); await r4.c.release(); await r4.c.refresh();
  assert.equal(slow.count("release"), 0); release(reply(200, { status: "processing" })); await p;
  // storage that cannot persist the budget -> no automatic reads at all
  const brokenApi = fakeApi(); const r5 = rig({ storage: brokenStorage(), api: brokenApi }); await r5.c.init();
  assert.equal(brokenApi.count("status"), 0);
});

test("uncertain writes are never resent; create while a token exists is refused; refused storage disables payment; malicious redirect refused", async () => {
  const u = fakeApi({ create: [{ kind: "unknown" }] }); const a = rig({ api: u });
  await a.c.init(); await a.c.create({ from: "2027-01-10", to: "2027-01-13", guests: 2 });
  assert.equal(a.state.notice.code, "CREATE_UNCERTAIN"); assert.equal(u.count("create"), 1); assert.deepEqual([a.state.st.token, a.state.st.uncertain], [null, "create"]);
  // release / pay / details unknown -> one call, then only an explicit refresh
  for (const [k, code] of [["release", "RELEASE_UNCERTAIN"], ["pay", "PAY_UNCERTAIN"], ["details", "DETAILS_UNCERTAIN"]]) {
    const s = memStorage(); createStore(s).save({ token: TOKEN, releaseRequested: false, polls: [] });
    const f = fakeApi({ [k]: [{ kind: "unknown" }] }); const r = rig({ storage: s, api: f, search: "" });
    if (k === "details") await r.c.details({ firstName: "A", lastName: "B", email: "a@example.test", accepted: true }); else await r.c[k]();
    const timers = r.timers; while (await timers.tick());
    assert.deepEqual([r.state.notice.code, f.count(k), f.count("status")], [code, 1, 0], k);
  }
  // a second create while this tab already holds a token: nothing sent
  const s2 = memStorage(); createStore(s2).save({ token: TOKEN, releaseRequested: false, polls: [] });
  const f2 = fakeApi(); const r2 = rig({ storage: s2, api: f2 }); await r2.c.create({ from: "2027-01-10", to: "2027-01-13", guests: 2 }); assert.equal(f2.count("create"), 0);
  // storage refused at create: reported; payment never requested
  const f3 = fakeApi(); const r3 = rig({ storage: brokenStorage(), api: f3 }); await r3.c.init();
  await r3.c.create({ from: "2027-01-10", to: "2027-01-13", guests: 2 }); assert.equal(r3.state.notice.code, "STORAGE_UNAVAILABLE");
  await r3.c.pay(); assert.equal(f3.count("pay"), 0);
  // malicious / foreign checkout URL from the server: never opened
  for (const bad of ["https://evil.example/pay", "javascript:alert(1)", "http://checkout.stripe.com/x", null]) {
    const s4 = memStorage(); createStore(s4).save({ token: TOKEN, releaseRequested: false, polls: [] });
    const f4 = fakeApi({ pay: [reply(200, { status: "awaiting_payment", checkoutUrl: bad })] }); const r4 = rig({ storage: s4, api: f4 });
    await r4.c.pay(); assert.deepEqual([r4.nav.assigned, r4.state.notice.code], [[], "CHECKOUT_URL_REFUSED"], String(bad));
  }
  // missing terms configuration: details never sent
  const f5 = fakeApi(); const r5 = rig({ api: f5, cfg: { ...CFG, termsVersion: "" } }); await r5.c.create({ from: "2027-01-10", to: "2027-01-13", guests: 2 });
  await r5.c.details({ firstName: "A", lastName: "B", email: "a@example.test", accepted: true }); assert.deepEqual([f5.count("details"), r5.state.notice.code], [0, "TERMS_NOT_CONFIGURED"]);
});

test("server failures are honest: release flag off, 503, 401 lost token, under_review, unknown status text; server codes are sanitized", async () => {
  const mk = (script) => { const s = memStorage(); createStore(s).save({ token: TOKEN, releaseRequested: false, polls: [] }); const f = fakeApi(script); return { s, f, r: rig({ storage: s, api: f }) }; };
  let x = mk({ release: [reply(400, { code: "UNKNOWN_STEP" })] }); await x.r.c.release(); assert.equal(x.r.state.notice.code, "RELEASE_NOT_ENABLED");
  x = mk({ release: [reply(503, { code: "UNAVAILABLE" })] }); await x.r.c.release(); assert.equal(x.r.state.notice.code, "RELEASE_UNCERTAIN", "5xx after a write is uncertain, not a refusal"); assert.equal(x.f.count("release"), 1);
  x = mk({ release: [reply(409, { code: "<script>alert(1)</script>" })] }); await x.r.c.release(); assert.equal(x.r.state.notice.code, "UNEXPECTED_REPLY");
  x = mk({ status: [reply(401, { code: "UNAUTHORIZED" })] }); await x.r.c.init(); assert.deepEqual([x.r.last().screen, x.r.state.notice.code], ["lost", "UNAUTHORIZED"]);
  x = mk({ status: [reply(200, { status: "under_review" })] }); await x.r.c.init(); assert.equal(x.r.last().screen, "review"); assert.equal(x.r.state.polling, false);
  x = mk({ status: [reply(200, { status: "confirmed" })] }); await x.r.c.init(); assert.equal(x.r.last().screen, "unexpected");
  x = mk({ status: [reply(200, { status: "expired" })] }); await x.r.c.init(); assert.equal(x.r.last().screen, "terminal");
  x = mk({ status: [reply(503, { code: "NOT_READY" })] }); await x.r.c.init(); assert.deepEqual([x.r.state.stopped, x.r.state.notice.code], ["ERROR", "NOT_READY"]);
  // cancelled return hint: displayed as a hint, status still read from the server
  const s = memStorage(); createStore(s).save({ token: TOKEN, releaseRequested: false, polls: [] });
  const f = fakeApi({ status: [reply(200, { status: "awaiting_payment" })] }); const r = rig({ storage: s, api: f, search: "?checkout=cancelled" }); await r.c.init();
  assert.deepEqual([r.state.notice.code, r.last().screen, f.count("status")], ["RETURNED_CANCELLED", "pay", 1]);
  // an unrecognized query is stripped and ignored
  const r2 = rig({ storage: s, api: fakeApi(), search: "?token=leak" }); await r2.c.init(); assert.equal(r2.nav.stripped, 1); assert.notEqual(r2.state.notice && r2.state.notice.code, "RETURNED_COMPLETE");
});

test("page source pins: same-origin only, no third-party resource, no storage outside sessionStorage, no console / innerHTML / eval; CSP + no-referrer + noindex; TEST labels", () => {
  const js = readFileSync(new URL("../public/checkout-test.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../public/checkout-test.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../public/checkout-test.css", import.meta.url), "utf8");
  for (const re of [/localStorage/, /console\./, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, /\beval\(|new Function/, /\bimport\s*\(/, /^import /m,
    /https?:\/\/(?!checkout\.stripe\.com)[a-z]/i, /stripe\.js|js\.stripe\.com|hostaway/i]) assert.doesNotMatch(js.replace(/^\/\/.*$/gm, ""), re, String(re));
  assert.doesNotMatch(html, /https?:\/\//, "no absolute resource in the page");
  assert.doesNotMatch(css, /url\(|@import|https?:/);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'"/);
  assert.match(html, /<meta name="referrer" content="no-referrer">/); assert.match(html, /noindex/);
  assert.match(html, /<meta name="mv-test-terms-version" content="">/, "terms version is a documented deployment input, never invented");
  assert.match(html, /TEST ONLY/); assert.match(html, /No reservation is created/);
  assert.match(html, /data-listing-id="606998" data-currency="USD"/);
  assert.doesNotMatch(html, /type="(password|card)"|cardnumber|cc-number|cvc/i, "no payment fields on our page");
});

// ---------- root HOLD corrections (R-UI1 uncertainty latch, R-UI2 neutral processing + stale notices) ----------
import { createIntent, transition, publicStatus } from "../lib/checkout/intent-state.js";   // pure, dependency-free
const seeded = (o = {}) => { const s = memStorage(); createStore(s).save({ token: TOKEN, releaseRequested: false, polls: [], ...o }); return s; };

test("R-UI1 pay: an uncertain pay (network / invalid reply / 5xx) latches; repeat clicks and reload never resend; awaiting_payment does not clear it; a resolved status does", async () => {
  for (const unk of [{ kind: "unknown" }, { kind: "unknown", http: 502 }, reply(500, { code: "UNAVAILABLE" }), reply(503, { code: "PAYMENT_UNAVAILABLE" })]) {
    const s = seeded();
    const f = fakeApi({ pay: [unk], status: [reply(200, { status: "awaiting_payment" }), reply(200, { status: "awaiting_payment" }), reply(200, { status: "processing" })] });
    const a = rig({ storage: s, api: f });
    await a.c.pay();
    assert.equal(a.state.notice.code, "PAY_UNCERTAIN", JSON.stringify(unk));
    assert.equal(a.last().latch, "pay"); assert.equal(a.last().canPay, false, "the DOM keeps Pay disabled");
    await a.c.pay(); await a.c.pay();
    assert.equal(f.count("pay"), 1, "repeat clicks send nothing");
    const b = rig({ storage: s, api: f }); await b.c.init();                 // reload: latch persisted, awaiting_payment proves nothing
    assert.equal(b.last().latch, "pay"); await b.c.pay(); assert.equal(f.count("pay"), 1);
    await b.c.refresh(); assert.equal(b.last().latch, "pay");
    await b.c.refresh(); assert.deepEqual([b.last().latch, b.last().screen], [null, "authorized"], "processing resolves the pay latch");
  }
  // a definite refusal stays a refusal (no latch)
  const f = fakeApi({ pay: [reply(409, { code: "SESSION_NOT_REUSABLE" })] }); const r = rig({ storage: seeded(), api: f });
  await r.c.pay(); assert.deepEqual([r.state.notice.code, r.last().latch], ["SESSION_NOT_REUSABLE", null]);
});

test("R-UI1 create: unknown create (no bearer) needs an explicit acknowledgement reset, also after reload; ordinary Create stays blocked", async () => {
  for (const unk of [{ kind: "unknown" }, reply(503, { code: "UNAVAILABLE" })]) {
    const s = memStorage(); const f = fakeApi({ create: [unk] });
    const a = rig({ storage: s, api: f }); await a.c.init();
    await a.c.create({ from: "2027-01-10", to: "2027-01-13", guests: 2 });
    assert.deepEqual([a.last().screen, a.last().latch, a.state.notice.code], ["createUncertain", "create", "CREATE_UNCERTAIN"]);
    await a.c.create({ from: "2027-01-10", to: "2027-01-13", guests: 2 }); assert.equal(f.count("create"), 1);
    const b = rig({ storage: s, api: f }); await b.c.init();
    assert.equal(b.last().screen, "createUncertain"); assert.equal(f.count("status"), 0, "no bearer: nothing to read");
    await b.c.create({ from: "2027-01-10", to: "2027-01-13", guests: 2 }); assert.equal(f.count("create"), 1);
    b.c.acknowledgeUncertainCreate();
    assert.equal(b.last().screen, "create");
    await b.c.create({ from: "2027-01-10", to: "2027-01-13", guests: 2 }); assert.equal(f.count("create"), 2, "only after the explicit acknowledgement");
  }
});

test("R-UI1 details / release: uncertain -> latched; status proving resolution clears it; still-unresolved state offers only an EXPLICIT resend (release repeat is server-idempotent)", async () => {
  const s = seeded();
  const f = fakeApi({ details: [{ kind: "unknown" }], status: [reply(200, { status: "awaiting_details" }), reply(200, { status: "awaiting_payment" })] });
  const a = rig({ storage: s, api: f });
  const d = { firstName: "A", lastName: "B", email: "a@example.test", accepted: true };
  await a.c.details(d); await a.c.details(d); assert.equal(f.count("details"), 1);
  assert.equal(a.last().latch, "details"); assert.equal(a.last().retry, null, "no resend offered before a status read");
  await a.c.refresh(); assert.deepEqual([a.last().latch, a.last().retry], ["details", "details"]);
  await a.c.details(d); assert.equal(f.count("details"), 1, "the ordinary button stays blocked");
  await a.c.retryUncertain(d); assert.equal(f.count("details"), 2, "explicit resend");
  await a.c.refresh(); assert.equal(a.last().latch, null);
  // release
  const s2 = seeded();
  const g = fakeApi({ release: [reply(500, { code: "UNAVAILABLE" })], status: [reply(200, { status: "processing" }), reply(200, { status: "release_requested" })] });
  const b = rig({ storage: s2, api: g });
  await b.c.release(); await b.c.release(); assert.equal(g.count("release"), 1); assert.equal(b.state.notice.code, "RELEASE_UNCERTAIN");
  const b2 = rig({ storage: s2, api: g }); await b2.c.init();              // reload: latch kept, status processing -> explicit resend allowed
  assert.deepEqual([b2.last().latch, b2.last().retry], ["release", "release"]);
  await b2.c.release(); assert.equal(g.count("release"), 1);
  await b2.c.retryUncertain(); assert.equal(g.count("release"), 2);
  assert.equal(b2.last().latch, null); assert.equal(b2.last().screen, "releaseQueued");
  // storage refused: the latch still holds in memory
  const h = fakeApi({ pay: [{ kind: "unknown" }] }); const r = rig({ storage: brokenStorage(), api: h });
  await r.c.create({ from: "2027-01-10", to: "2027-01-13", guests: 2 }); await r.c.pay(); await r.c.pay();
  assert.equal(h.count("pay"), 0, "payment never starts without storage");
});

test("R-UI2: 'processing' is coarse (payment_authorized, reservation_pending, capture_unknown all map to it) -> neutral wording, no authorization / uncaptured / booking claim; release request stays available", () => {
  const T0 = Date.UTC(2026, 9, 21, 15); const M = 60000;
  const PR = { listingId: 603566, from: "2026-12-20", to: "2026-12-24", guests: 2, nights: 4, currency: "MXN", standardTotalMinor: 640000, eligibleMinor: 640000, discountMinor: 64000,
    finalTotalMinor: 576000, policyVersion: "direct-v1", rateBps: 1000, lines: [], charge: { currency: "mxn", amountMinor: 576000, quantity: 1 }, quoteHash: "a".repeat(64) };
  let i = createIntent({ id: "int_1", ref: "MV-7K3Q9P", listingId: 603566, from: "2026-12-20", to: "2026-12-24", guests: 2, now: T0 });
  const go = (ev, m) => { const r = transition(i, ev, { now: T0 + m * M }); assert.equal(r.ok, true, `${ev.type}: ${r.error}`); i = r.intent; return i; };
  go({ type: "PRICE_CONFIRMED", price: PR }, 0); go({ type: "DETAILS_COLLECTED" }, 1); go({ type: "CHECKOUT_PREPARED", sessionId: "cs_test_1" }, 2);
  const authorized = go({ type: "PAYMENT_AUTHORIZED", id: "e1", paymentIntentId: "pi_1", sessionId: "cs_test_1", amountMinor: 576000, currency: "mxn", livemode: false,
    authorizationCreatedAt: T0 + 4 * M, captureBefore: T0 + 4 * M + 7 * 24 * 60 * M }, 5);
  const pending = go({ type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: true, priceSame: true } }, 6);
  go({ type: "RESERVATION_DISPATCHED", workerId: "w1" }, 6);
  go({ type: "RESERVATION_SUCCEEDED", reservation: { reservationId: 9001, listingId: 603566, from: "2026-12-20", to: "2026-12-24", totalMinor: 576000, currency: "MXN" } }, 7);
  const captureUnknown = go({ type: "CAPTURE_OUTCOME_UNKNOWN" }, 8);
  assert.deepEqual([authorized.status, pending.status, captureUnknown.status], ["payment_authorized", "reservation_pending", "capture_unknown"]);
  assert.deepEqual([publicStatus(authorized), publicStatus(pending), publicStatus(captureUnknown)], ["processing", "processing", "processing"], "one coarse public status");
  const d = describe("processing");
  assert.doesNotMatch(d.title + d.text, /reports a card authorization|not a charge|authorization held|uncaptured|booking (is )?confirmed/i);
  assert.match(d.text, /may/); assert.match(d.title, /not a booking/i);
  assert.equal(d.kind, "authorized", "the guarded release request remains available (the server refuses wrong states)");
});

test("R-UI2: a newer authoritative status clears stale action notices (queued / returned / uncertain); verified or review never shows 'queued, not done'", async () => {
  const s = seeded({ releaseRequested: false });
  const f = fakeApi({ status: [reply(200, { status: "processing" }), reply(200, { status: "release_requested" }), reply(200, { status: "unavailable_not_charged" })] });
  const t = fakeTimers(); const a = rig({ storage: s, api: f, timers: t, search: "?checkout=complete" });
  await a.c.init(); assert.equal(a.state.notice.code, "RETURNED_COMPLETE");
  await a.c.release(); assert.equal(a.state.notice.code, "RELEASE_REQUESTED");
  await t.tick(); assert.equal(a.last().screen, "releaseQueued"); assert.equal(a.state.notice && a.state.notice.code, "RELEASE_REQUESTED");
  await t.tick(); assert.equal(a.last().screen, "released");
  assert.equal(a.state.notice, null, "no stale 'queued, not done' notice next to 'Release verified'");
  const s2 = seeded({ releaseRequested: true });
  const g = fakeApi({ release: [{ kind: "unknown" }], status: [reply(200, { status: "under_review" })] });
  const b = rig({ storage: s2, api: g }); await b.c.release(); assert.equal(b.state.notice.code, "RELEASE_UNCERTAIN");
  await b.c.refresh(); assert.equal(b.last().screen, "review"); assert.equal(b.state.notice, null); assert.equal(b.last().latch, null);
});

// ---------- root re-review HOLD (R-UI1a semantic reply boundary, R-UI1b reload budget) ----------
const latchedStore = (uncertain, o = {}) => seeded({ uncertain, ...o });
const shapes = [reply(200, {}), reply(200, { status: null }), reply(200, { status: "weird_but_valid" }), reply(200, { status: 7 })];

test("R-UI1a: a 200 status reply without a RECOGNISED status never resolves any latch; reads stop honestly; no previous label is reused; ordinary actions stay blocked", async () => {
  for (const action of ["details", "pay", "release"]) {
    for (const bad of shapes) {
      const s = latchedStore(action);
      const f = fakeApi({ status: [reply(200, { status: action === "release" ? "processing" : action === "pay" ? "awaiting_payment" : "awaiting_details" }), bad] });
      const r = rig({ storage: s, api: f });
      await r.c.init();                                   // a valid first read (the latch stays: that status proves nothing)
      await r.c.refresh();                                // the malformed read
      assert.equal(r.last().latch, action, `${action} ${JSON.stringify(bad.body)}`);
      assert.deepEqual([r.last().screen, r.state.stopped, r.state.polling, r.state.last], ["unreadable", "UNREADABLE", false, null], `${action} ${JSON.stringify(bad.body)}`);
      const before = f.calls.length;
      await r.c.pay(); await r.c.release(); await r.c.details({ firstName: "A", lastName: "B", email: "a@example.test", accepted: true }); await r.c.retryUncertain({ accepted: true });
      assert.equal(f.calls.length, before, `${action}: nothing sent after an unreadable status`);
      assert.equal(createStore(s).load().uncertain, action);
    }
  }
  // create latch WITH a bearer (malformed 201): only a recognised status resolves it
  const s = memStorage(); const f = fakeApi({ create: [reply(201, { token: TOKEN })], status: [reply(200, {}), reply(200, { status: "awaiting_details" })] });
  const r = rig({ storage: s, api: f }); await r.c.create({ from: "2027-01-10", to: "2027-01-13", guests: 2 });
  assert.equal(r.last().latch, "create"); await r.c.refresh(); assert.equal(r.last().latch, "create");
  await r.c.refresh(); assert.equal(r.last().latch, null);
});

test("R-UI1a: malformed 2xx mutation replies latch (never a definite refusal, never an ordinary resend, never a bad redirect); a trustworthy bearer is kept for safe status reads", async () => {
  // create 201 without a valid bearer -> explicit acknowledgement path
  for (const body of [{}, { token: "short", status: "awaiting_details" }, { status: "awaiting_details" }]) {
    const f = fakeApi({ create: [reply(201, body)] }); const r = rig({ api: f }); await r.c.init();
    await r.c.create({ from: "2027-01-10", to: "2027-01-13", guests: 2 }); await r.c.create({ from: "2027-01-10", to: "2027-01-13", guests: 2 });
    assert.deepEqual([r.last().screen, r.last().latch, f.count("create")], ["createUncertain", "create", 1], JSON.stringify(body));
  }
  // create 201 with a bearer but no recognised status -> latch, bearer kept, status read allowed
  const fc = fakeApi({ create: [reply(201, { token: TOKEN, status: "?" })], status: [reply(200, { status: "awaiting_details" })] }); const rc = rig({ api: fc });
  await rc.c.create({ from: "2027-01-10", to: "2027-01-13", guests: 2 });
  assert.deepEqual([rc.last().latch, rc.state.st.token === TOKEN], ["create", true]); await rc.c.create({ from: "2027-01-10", to: "2027-01-13", guests: 2 });
  assert.equal(fc.count("create"), 1); await rc.c.refresh(); assert.equal(fc.count("status"), 1);
  // pay 200 with a missing / invalid checkoutUrl -> latch pay, nothing opened, no resend
  for (const body of [{ status: "awaiting_payment" }, { status: "awaiting_payment", checkoutUrl: "https://evil.example/x" }, { checkoutUrl: 5 }]) {
    const f = fakeApi({ pay: [reply(200, body)] }); const r = rig({ storage: seeded(), api: f });
    await r.c.pay(); await r.c.pay();
    assert.deepEqual([r.last().latch, r.nav.assigned, f.count("pay")], ["pay", [], 1], JSON.stringify(body));
  }
  // details 200 without its expected status; release 202 without the REQUESTED marker / a recognised status
  for (const body of [{}, { status: "weird" }, { status: "processing" }]) {
    const f = fakeApi({ details: [reply(200, body)] }); const r = rig({ storage: seeded(), api: f }); const d = { firstName: "A", lastName: "B", email: "a@example.test", accepted: true };
    await r.c.details(d); await r.c.details(d); assert.deepEqual([r.last().latch, f.count("details")], ["details", 1], JSON.stringify(body));
  }
  for (const body of [{}, { status: "release_requested" }, { release: "REQUESTED" }, { release: "REQUESTED", status: "weird" }]) {
    const f = fakeApi({ release: [reply(202, body)] }); const r = rig({ storage: seeded(), api: f });
    await r.c.release(); await r.c.release(); assert.deepEqual([r.last().latch, f.count("release")], ["release", 1], JSON.stringify(body));
  }
  // other 2xx codes on a write are not success either
  const f2 = fakeApi({ release: [reply(200, { status: "release_requested", release: "REQUESTED" })] }); const r2 = rig({ storage: seeded(), api: f2 });
  await r2.c.release(); assert.equal(r2.last().latch, "release");
});

test("accepted details success shape (status stays awaiting_details) advances to payment; an uncertain details step can be proven by a definite pay refusal", async () => {
  const sd = seeded(); const r = rig({ storage: sd, api: fakeApi() });
  await r.c.details({ firstName: "A", lastName: "B", email: "a@example.test", accepted: true });
  assert.deepEqual([r.last().screen, r.last().latch], ["pay", null], "details_collected maps to awaiting_details publicly; the page still moves on");
  const r2 = rig({ storage: sd, api: fakeApi({ status: [reply(200, { status: "awaiting_details" })] }) }); await r2.c.init();
  assert.equal(r2.last().screen, "pay", "a reload keeps the saved-details step (session flag only, no guest data)");
  // uncertain details + awaiting_details: explicit resend OR an explicit pay attempt; a definite NOT_READY_FOR_PAYMENT re-opens the form
  const f = fakeApi({ details: [{ kind: "unknown" }], status: [reply(200, { status: "awaiting_details" })], pay: [reply(409, { code: "NOT_READY_FOR_PAYMENT" })] });
  const r3 = rig({ storage: seeded(), api: f }); await r3.c.details({ firstName: "A", lastName: "B", email: "a@example.test", accepted: true }); await r3.c.refresh();
  assert.deepEqual([r3.last().retry, r3.last().canPay], ["details", true]);
  await r3.c.pay(); assert.deepEqual([r3.last().latch, r3.last().screen, f.count("pay")], [null, "details", 1]);
});

test("R-UI1b: every page-load / Stripe-return status read is AUTOMATIC: 30 reloads of a latched tab send <= 24 within 10 minutes; exhausted -> reload sends nothing; manual Refresh still allowed; no recurring polling while latched", async () => {
  const t = fakeTimers(); const s = latchedStore("pay");
  const f = fakeApi(); f.q.status = Array.from({ length: 60 }, () => reply(200, { status: "awaiting_payment" }));
  for (let i = 0; i < 30; i++) {
    const r = rig({ storage: s, api: f, timers: t, search: i % 2 ? "?checkout=complete" : "" }); await r.c.init();
    assert.equal(r.state.polling, false, "no recurring polling while latched");
  }
  assert.equal(f.count("status"), POLL.maxAuto);
  const r = rig({ storage: s, api: f, timers: t }); await r.c.init();
  assert.deepEqual([f.count("status"), r.state.stopped], [POLL.maxAuto, "BUDGET"]);
  await r.c.refresh(); assert.equal(f.count("status"), POLL.maxAuto + 1, "explicit manual read");
  // storage that cannot persist the budget: a reload sends nothing automatically
  const g = fakeApi(); const r2 = rig({ storage: brokenStorage(), api: g }); await r2.c.init(); assert.equal(g.count("status"), 0);
});
