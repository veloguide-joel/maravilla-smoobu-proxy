// E7 checkout TEST page — bounded functional patch F1–F4 (ROOT-approved audit 2026-11-11). FAKE API / storage / timers and a FAKE DOM
// parsed from the page's REAL HTML (no browser, no network). F1 pay eligibility after a Stripe return; F2 lost / failed status state;
// F3 details validation before ANY details write; F4 Forget moved below the release zone with an explicit warning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createController, createStore, startApp, STORE_KEY, POLL } from "../public/checkout-test.js";

const TOKEN = Buffer.alloc(32, 7).toString("base64url");
const CFG = Object.freeze({ listingId: 606998, currency: "USD", termsVersion: "terms-2026-11" });
const reply = (http, body) => ({ kind: "reply", http, body });
function memStorage() { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } }; }
const seeded = (o = {}) => { const s = memStorage(); createStore(s).save({ token: TOKEN, releaseRequested: false, detailsSaved: true, polls: [], uncertain: null, ...o }); return s; };
function fakeTimers() {
  const t = { now: 1_800_000_000_000, q: [], setTimeout(fn, ms) { const id = Symbol("t"); t.q.push({ id, fn, at: t.now + ms }); return id; },
    clearTimeout(id) { t.q = t.q.filter((x) => x.id !== id); },
    async tick() { const x = t.q.sort((a, b) => a.at - b.at).shift(); if (!x) return false; t.now = Math.max(t.now, x.at); await x.fn(); return true; } };
  return t;
}
function fakeApi(script = {}, dflt = {}) {
  const calls = []; const q = { create: [], details: [], pay: [], release: [], status: [], ...script };
  const def = { status: reply(200, { status: "awaiting_payment" }), pay: reply(200, { status: "awaiting_payment", checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_f" }),
    details: reply(200, { status: "awaiting_details" }), ...dflt };
  const m = (k) => async () => { calls.push(k); return q[k].length ? q[k].shift() : def[k] ?? reply(500, {}); };
  return { calls, q, count: (k) => calls.filter((c) => c === k).length, writes: () => calls.filter((c) => c !== "status").length,
    api: { create: m("create"), details: m("details"), pay: m("pay"), release: m("release"), status: m("status") } };
}
function rig({ storage = seeded(), api = fakeApi(), timers = fakeTimers(), search = "" } = {}) {
  const views = []; const nav = { assigned: [], assign(u) { nav.assigned.push(u); }, search: () => search, stripQuery() {} };
  const c = createController({ api: api.api, store: createStore(storage), ui: { render: (v) => views.push(v) }, timers, nav, config: CFG, now: () => timers.now });
  return { c, views, api, timers, storage, nav, last: () => views[views.length - 1] };
}
const VALID = Object.freeze({ firstName: "Ana", lastName: "Test", email: "ana@example.test", phone: "", accepted: true });
const NO_CLAIM = /\b(paid|payment (succeeded|successful|complete|confirmed)|authori[sz]ed|charged|booked|booking (is )?confirmed|released)\b/i;

// ---------------------------------------------------------------------------------------------------------------------------------
// F1 — one pay-eligibility predicate (view canPay AND pay())

test("F1-1 direct pay() bypass: no pay while waiting after a 'complete' Stripe return, before any status is known, or while unreadable", async () => {
  const r = rig({ search: "?checkout=complete" }); await r.c.init();
  assert.deepEqual([r.last().screen, r.last().canPay], ["payWait", false]);
  await r.c.pay(); await r.c.pay();
  assert.equal(r.api.count("pay"), 0, "the controller refuses exactly what the view does not offer");
  // no status read yet (seeded tab, never read): nothing known -> no pay
  const n = rig(); await n.c.pay(); assert.equal(n.api.count("pay"), 0);
  // unreadable status
  const u = rig({ api: fakeApi({ status: [reply(200, { status: "weird" })] }) }); await u.c.init(); await u.c.pay();
  assert.deepEqual([u.last().screen, u.api.count("pay")], ["unreadable", 0]);
});

test("F1-2 return + read budget exhausted: Pay is NOT re-enabled; neutral wait / manual Refresh text; no payment claim", async () => {
  const r = rig({ search: "?checkout=complete" }); await r.c.init();
  while (await r.timers.tick());                                   // auto reads run until the per-tab budget stops them
  assert.equal(r.api.count("status"), POLL.maxAuto, "budget respected");
  const v = r.last();
  assert.deepEqual([v.screen, v.canPay, v.pollStopped, v.canRefresh], ["payWait", false, "BUDGET", true]);
  assert.doesNotMatch(`${v.title} ${v.text}`, NO_CLAIM);
  assert.match(v.text, /Refresh status/); assert.match(v.text, /not offered again/);
  await r.c.pay(); assert.equal(r.api.count("pay"), 0);
  await r.c.refresh(); assert.deepEqual([r.last().screen, r.last().canPay, r.api.count("pay")], ["payWait", false, 0], "manual refresh: still waiting, still no Pay");
  // the server's answer moves the page on (processing), and Pay never comes back
  r.api.q.status.push(reply(200, { status: "processing" })); await r.c.refresh();
  assert.deepEqual([r.last().screen, r.last().canPay], ["authorized", false]);
});

test("F1-3 valid initial unpaid checkout still pays once; a 'cancelled' return keeps Pay; the details-latch recovery keeps Pay", async () => {
  const r = rig(); await r.c.init();
  assert.deepEqual([r.last().screen, r.last().canPay], ["pay", true]);
  await r.c.pay(); assert.deepEqual([r.api.count("pay"), r.nav.assigned], [1, ["https://checkout.stripe.com/c/pay/cs_test_f"]]);
  const c = rig({ search: "?checkout=cancelled" }); await c.c.init();
  assert.deepEqual([c.last().screen, c.last().canPay], ["pay", true]); await c.c.pay(); assert.equal(c.api.count("pay"), 1);
  // saved-details flag (awaiting_details + verified details) is still the pay step
  const d = rig({ api: fakeApi({ status: [reply(200, { status: "awaiting_details" })] }) }); await d.c.init();
  assert.deepEqual([d.last().screen, d.last().canPay], ["pay", true]);
  // details latch + fresh awaiting_details -> explicit resend AND Pay (the server proves details by preparing Checkout)
  const s = seeded({ detailsSaved: false, uncertain: "details" });
  const l = rig({ storage: s, api: fakeApi({ status: [reply(200, { status: "awaiting_details" })] }) }); await l.c.init();
  assert.deepEqual([l.last().latch, l.last().retry, l.last().canPay], ["details", "details", true]);
  await l.c.pay(); assert.equal(l.api.count("pay"), 1);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// F2 — lost (401) and failed status reads are state, not a one-render override

test("F2-1 401 is a persistent 'lost' state: honest title, no Refresh, no pay / release / details / resend / auto read until an explicit reset", async () => {
  const f = fakeApi({ status: [reply(401, { code: "UNAUTHORIZED" })] }); const r = rig({ api: f, search: "?checkout=complete" }); await r.c.init();
  const chk = (label) => { const v = r.last(); assert.deepEqual([v.screen, v.title, v.canRefresh, v.canPay, v.canRequestRelease, v.retry], ["lost", "This tab can no longer check this TEST booking", false, false, false, null], label); assert.equal(v.pollStopped, null, `${label}: no Refresh hint`); };
  chk("after 401");
  assert.doesNotMatch(r.last().text, NO_CLAIM); assert.match(r.last().text, /says nothing about whether a TEST hold exists/);
  const before = f.calls.length;
  await r.c.refresh(); chk("refresh"); await r.c.pay(); chk("pay");
  r.c.armRelease(); await r.c.confirmRelease(); chk("release");
  await r.c.details(VALID); chk("details"); await r.c.retryUncertain(VALID); chk("resend");
  while (await r.timers.tick()); chk("timers");
  assert.equal(f.calls.length, before, "nothing sent after 401");
  r.c.startOver();
  assert.deepEqual([r.last().screen, createStore(r.storage).load()], ["create", null], "explicit reset clears only local state");
  assert.equal(f.calls.length, before);
});

test("F2-2 429 / other HTTP error on the initial load: 'Status not checked' (not lost); budgets and latches kept; later evidence restores the screen", async () => {
  for (const [rep, stop] of [[reply(429, { code: "RATE_LIMITED" }), "RATE_LIMITED"], [reply(503, { code: "UNAVAILABLE" }), "ERROR"]]) {
    const s = seeded({ uncertain: "pay" });
    const f = fakeApi({ status: [rep, reply(200, { status: "awaiting_payment" })] }); const r = rig({ storage: s, api: f }); await r.c.init();
    const v = r.last();
    assert.deepEqual([v.screen, v.title, v.pollStopped, v.canRefresh, v.latch, v.canPay], ["notChecked", "Status not checked", stop, true, "pay", false], stop);
    assert.doesNotMatch(v.text, NO_CLAIM); assert.doesNotMatch(v.text, /no longer|lost/i, "a transient failure never claims the booking is lost");
    assert.equal(createStore(s).load().polls.length, 1, "the read consumed its budget slot");
    await r.c.refresh(); assert.deepEqual([r.last().screen, r.last().latch], ["pay", "pay"], "awaiting_payment proves nothing about an uncertain pay");
  }
  // a known status is NOT erased by a later 429: the screen keeps the last evidence plus a warning notice
  const f = fakeApi({ status: [reply(200, { status: "processing" }), reply(429, { code: "RATE_LIMITED" })] }); const r = rig({ api: f }); await r.c.init();
  await r.c.refresh();
  assert.deepEqual([r.last().screen, r.c.state.notice.code, r.last().canRefresh], ["authorized", "RATE_LIMITED", true]);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// F3 — details validated at the controller boundary for BOTH paths

const BAD = [["blank", { ...VALID, firstName: "", lastName: "", email: "" }, "FIRST_NAME_INVALID"], ["spaces", { ...VALID, firstName: "   " }, "FIRST_NAME_INVALID"],
  ["no last", { ...VALID, lastName: " " }, "LAST_NAME_INVALID"], ["bad email", { ...VALID, email: "ana@example" }, "EMAIL_INVALID"],
  ["markup", { ...VALID, firstName: "<b>" }, "FIRST_NAME_INVALID"], ["bad phone", { ...VALID, phone: "abc" }, "PHONE_INVALID"],
  ["terms", { ...VALID, accepted: false }, "TERMS_NOT_ACCEPTED"], ["missing", undefined, "DETAILS_INVALID"]];

test("F3-1 ordinary details: an invalid form sends ZERO writes and says what to fix; a valid one sends once", async () => {
  for (const [label, form, code] of BAD) {
    const r = rig({ storage: seeded({ detailsSaved: false }), api: fakeApi({ status: [reply(200, { status: "awaiting_details" })] }) }); await r.c.init();
    await r.c.details(form);
    assert.deepEqual([r.api.count("details"), r.c.state.notice.code, r.last().screen], [0, code, "details"], label);
  }
  const r = rig({ storage: seeded({ detailsSaved: false }), api: fakeApi({ status: [reply(200, { status: "awaiting_details" })] }) }); await r.c.init();
  await r.c.details(VALID); assert.equal(r.api.count("details"), 1);
});

test("F3-2 explicit resend after an uncertain details write: blank / invalid -> ZERO writes, latch + token kept, correction allowed; valid -> exactly once", async () => {
  for (const [label, form, code] of BAD) {
    const s = seeded({ detailsSaved: false, uncertain: "details" });
    const r = rig({ storage: s, api: fakeApi({ status: [reply(200, { status: "awaiting_details" })] }) }); await r.c.init();     // e.g. after a reload: empty inputs
    assert.equal(r.last().retry, "details");
    await r.c.retryUncertain(form);
    assert.deepEqual([r.api.count("details"), r.c.state.notice.code, r.last().latch, r.last().retry, createStore(s).load().token], [0, code, "details", "details", TOKEN], label);
    await r.c.retryUncertain(VALID);
    assert.equal(r.api.count("details"), 1, `${label}: the corrected resend goes out exactly once`);
    assert.ok(!JSON.stringify([...s.m.values()]).includes("ana@example.test"), "guest identity never persisted");
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// FAKE DOM from the page's real HTML (+ forms: values, reportValidity, FormData)
const HTML = readFileSync(new URL("../public/checkout-test.html", import.meta.url), "utf8");
const VOID = new Set(["meta", "link", "input", "br", "img"]);
function fakeDocument() {
  const doc = { activeElement: null, byId: new Map(), all: [] };
  class El {
    constructor(tag, attrs) { this.tag = tag; this.attrs = attrs; this.children = []; this.parent = null; this.listeners = {}; this.textContent = "";
      this.id = attrs.id || ""; this.hidden = "hidden" in attrs; this.disabled = false; this.checked = false; this.className = attrs.class || ""; this.values = {}; this.valid = true;
      this.dataset = Object.fromEntries(Object.entries(attrs).filter(([k]) => k.startsWith("data-")).map(([k, v]) => [k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v])); }
    get content() { return this.attrs.content; }
    focus() { if (!this.disabled) doc.activeElement = this; }
    closest(sel) { assert.equal(sel, "[hidden]"); for (let e = this; e; e = e.parent) if (e.hidden) return e; return null; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    dispatch(type, ev = {}) { const e = { key: ev.key, preventDefault() {}, ...ev }; for (const fn of this.listeners[type] || []) fn(e); return e; }
    click() { if (!this.disabled) this.dispatch("click"); }
    reportValidity() { doc.validityChecks = (doc.validityChecks || 0) + 1; return this.valid; }
    replaceChildren() { this.children = []; } append(c) { this.children.push(c); c.parent = this; }
  }
  const root = new El("#root", {}); let cur = root;
  for (const m of HTML.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g)) {
    const [, close, tagRaw, rest] = m; const tag = tagRaw.toLowerCase();
    if (close) { if (cur.tag === tag) cur = cur.parent; continue; }
    const attrs = {}; for (const a of rest.matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] ?? "";
    const el = new El(tag, attrs); cur.append(el); doc.all.push(el); if (el.id) doc.byId.set(el.id, el);
    if (!VOID.has(tag) && !rest.trim().endsWith("/")) cur = el;
  }
  doc.body = doc.all.find((e) => e.tag === "body");
  doc.getElementById = (id) => doc.byId.get(id) || null;
  doc.querySelectorAll = (sel) => { assert.equal(sel, "button"); return doc.all.filter((e) => e.tag === "button"); };
  doc.querySelector = (sel) => { assert.equal(sel, 'meta[name="mv-test-terms-version"]'); return doc.all.find((e) => e.tag === "meta" && e.attrs.name === "mv-test-terms-version") || null; };
  doc.createElement = (tag) => new El(tag, {});
  doc.activeElement = doc.body;
  return doc;
}
class FakeFormData { constructor(form) { this.v = form.values; } get(k) { return k in this.v ? this.v[k] : null; } }
function fakeWindow({ status = [], seed = {}, confirmAnswer = false, search = "" } = {}) {
  const calls = []; const q = { status: [...status] };
  const fetch = async (path, init) => {
    const k = JSON.parse(init.body).step || "create"; calls.push(k);
    const r = k === "status" && q.status.length ? q.status.shift() : k === "status" ? { s: 200, b: { status: "processing" } } : { s: 500, b: {} };
    return { status: r.s, json: async () => r.b };
  };
  const st = memStorage(); createStore(st).save({ token: TOKEN, releaseRequested: false, detailsSaved: true, polls: [], uncertain: null, ...seed });
  const confirms = [];
  return { calls, st, confirms, win: { fetch, sessionStorage: st, setTimeout: () => 0, clearTimeout() {}, location: { search, pathname: "/checkout-test.html", assign() {} },
    history: { replaceState() {} }, confirm: (m) => { confirms.push(m); return confirmAnswer; } } };
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
async function page(opts) {
  const doc = fakeDocument(); const w = fakeWindow(opts); const prev = globalThis.FormData; globalThis.FormData = FakeFormData;
  const c = startApp(doc, w.win); await settle();
  return { doc, ...w, c, $: (id) => doc.getElementById(id), restore: () => { globalThis.FormData = prev; } };
}
const visible = (el) => !el.closest("[hidden]");

test("F4-1 DOM: Forget sits BELOW the release zone (not beside Refresh), secondary, with the explicit warning", async () => {
  const p = await page(); p.restore();
  const idx = (id) => p.doc.all.indexOf(p.$(id));
  assert.equal(p.$("mv-title").textContent, "Processing — not a booking");
  assert.ok(idx("mv-refresh") < idx("mv-release") && idx("mv-release") < idx("mv-forget") && idx("mv-forget") < idx("mv-restart"), "Refresh → release zone → Forget");
  assert.notEqual(p.$("mv-restart").parent, p.$("mv-refresh").parent, "Forget is not in the Refresh row");
  assert.equal(p.$("mv-restart").className, "secondary"); assert.equal(p.$("mv-restart").attrs["aria-describedby"], "mv-forget-warn");
  const warn = /<p id="mv-forget-warn"[^>]*>([^<]*)</.exec(HTML)[1];
  assert.match(warn, /does not cancel/); assert.match(warn, /release any TEST hold/); assert.match(warn, /no longer be able to check it or request a release/);
  assert.deepEqual([visible(p.$("mv-restart")), visible(p.$("mv-refresh"))], [true, true]);
});

test("F4-2 DOM: Forget cancelled keeps the token (zero calls); confirmed reset clears only local state (zero calls); the confirm text warns", async () => {
  const p = await page({ confirmAnswer: false }); p.restore(); const n = p.calls.length;
  p.$("mv-restart").click(); await settle();
  assert.equal(JSON.parse(p.st.m.get(STORE_KEY)).token, TOKEN); assert.equal(p.calls.length, n);
  assert.match(p.confirms[0], /does not cancel the booking or release any TEST hold/); assert.match(p.confirms[0], /no longer be able to check it or request a release/);
  const q = await page({ confirmAnswer: true }); q.restore(); const m = q.calls.length;
  q.$("mv-restart").click(); await settle();
  assert.deepEqual([q.st.m.has(STORE_KEY), q.calls.length, q.$("mv-title").textContent], [false, m, "Start a TEST booking"]);
});

test("F2-3 DOM: after a 401 the page shows the lost title, hides Refresh, keeps Forget, and later renders keep it", async () => {
  const p = await page({ status: [{ s: 401, b: { code: "UNAUTHORIZED" } }] }); p.restore();
  assert.equal(p.$("mv-title").textContent, "This tab can no longer check this TEST booking");
  assert.deepEqual([visible(p.$("mv-refresh")), visible(p.$("mv-release")), visible(p.$("mv-pay")), visible(p.$("mv-restart"))], [false, false, false, true]);
  assert.doesNotMatch(`${p.$("mv-polling").textContent} ${p.$("mv-text").textContent}`, /Refresh/, "no instruction to use a control that is not offered");
  p.$("mv-restart").click(); await settle();                        // a re-render (confirm declined) keeps the lost state
  assert.equal(p.$("mv-title").textContent, "This tab can no longer check this TEST booking"); assert.equal(p.calls.length, 1);
});

test("F1-4 DOM: back from Stripe ('complete') while awaiting_payment — no Pay control, neutral title", async () => {
  const p = await page({ status: [{ s: 200, b: { status: "awaiting_payment" } }], search: "?checkout=complete" }); p.restore();
  assert.equal(p.$("mv-title").textContent, "Waiting for the TEST payment result");
  assert.deepEqual([visible(p.$("mv-pay")), p.$("mv-pay-btn").disabled, visible(p.$("mv-refresh"))], [false, true, true]);
});

test("F3-3 DOM: the explicit details resend checks form validity first; blank inputs never reach the API", async () => {
  const p = await page({ seed: { detailsSaved: false, uncertain: "details" }, status: [{ s: 200, b: { status: "awaiting_details" } }] });
  try {
    assert.equal(visible(p.$("mv-retry-btn")), true); const n = p.calls.length;
    p.$("mv-details").valid = false; p.$("mv-retry-btn").click(); await settle();
    assert.deepEqual([p.doc.validityChecks, p.calls.length], [1, n], "reportValidity false -> nothing");
    p.$("mv-details").valid = true; p.$("mv-details").values = { firstName: "", lastName: "", email: "", phone: "" }; p.$("mv-terms").checked = true;
    p.$("mv-retry-btn").click(); await settle();
    assert.equal(p.calls.length, n, "the controller re-checks: blank values -> nothing");
    assert.match(p.$("mv-notice").textContent, /Enter a first name/);
  } finally { p.restore(); }
});
