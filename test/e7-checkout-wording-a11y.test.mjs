// E7 checkout TEST page — wording / accessibility patch W1 / W2 / W3 / W5 + A1 (ROOT-approved scope 2026-11-11). FAKE API / storage / timers
// and a FAKE DOM parsed from the page's REAL HTML (no browser, no network). The fake DOM records every textContent write so live-region
// announcements can be counted exactly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as page from "../public/checkout-test.js";
const { createController, createStore, startApp, describe, STORE_KEY, POLL } = page;

const TOKEN = Buffer.alloc(32, 9).toString("base64url");
const TOKEN2 = Buffer.alloc(32, 10).toString("base64url");
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
function rig(statuses, { storage = seeded(), search = "" } = {}) {
  const q = [...statuses]; const calls = [];
  const api = { status: async () => { calls.push("status"); return q.length > 1 ? q.shift() : q[0]; } };
  for (const k of ["create", "details", "pay", "release"]) api[k] = async () => { calls.push(k); return reply(500, {}); };
  const views = []; const timers = fakeTimers();
  const c = createController({ api, store: createStore(storage), ui: { render: (v) => views.push(v) }, timers, nav: { assign() {}, search: () => search, stripQuery() {} }, config: CFG, now: () => timers.now });
  return { c, calls, views, timers, storage, q, last: () => views[views.length - 1] };
}
const S = (status) => reply(200, { status });
const CLAIM = /\b(released|no (TEST )?hold|cancel(l)?ed|closed|clean ?up|refund(ed)?|paid|charged|booked|confirmed)\b/i;
const CODEISH = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\[[A-Z0-9_]+\]/;

// ---------------------------------------------------------------------------------------------------------------------------------
// FAKE DOM (actual HTML; records textContent writes)
const HTML = readFileSync(new URL("../public/checkout-test.html", import.meta.url), "utf8");
const VOID = new Set(["meta", "link", "input", "br", "img"]);
function fakeDocument() {
  const doc = { activeElement: null, byId: new Map(), all: [] };
  class El {
    constructor(tag, attrs) { this.tag = tag; this.attrs = attrs; this.children = []; this.parent = null; this.listeners = {}; this._t = ""; this.writes = [];
      this.id = attrs.id || ""; this.hidden = "hidden" in attrs; this.disabled = false; this.checked = false; this.className = attrs.class || ""; this.values = {};
      this.dataset = Object.fromEntries(Object.entries(attrs).filter(([k]) => k.startsWith("data-")).map(([k, v]) => [k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v])); }
    get textContent() { return this._t; } set textContent(v) { this.writes.push(String(v)); this._t = String(v); }
    get content() { return this.attrs.content; }
    focus() { if (!this.disabled) doc.activeElement = this; }
    closest(sel) { assert.equal(sel, "[hidden]"); for (let e = this; e; e = e.parent) if (e.hidden) return e; return null; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    dispatch(type, ev = {}) { const e = { key: ev.key, preventDefault() {}, ...ev }; for (const fn of this.listeners[type] || []) fn(e); return e; }
    click() { if (!this.disabled) this.dispatch("click"); }
    reportValidity() { return true; }
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
  // static text from the HTML (needed for elements the script only switches, e.g. the Forget warning / label)
  for (const m of HTML.matchAll(/<(p|button|h2)\s+id="([^"]+)"[^>]*>([^<]*)</g)) { const el = doc.byId.get(m[2]); if (el) el._t = m[3]; }
  doc.body = doc.all.find((e) => e.tag === "body");
  doc.getElementById = (id) => doc.byId.get(id) || null;
  doc.querySelectorAll = (sel) => { assert.equal(sel, "button"); return doc.all.filter((e) => e.tag === "button"); };
  doc.querySelector = (sel) => { assert.equal(sel, 'meta[name="mv-test-terms-version"]'); return doc.all.find((e) => e.tag === "meta" && e.attrs.name === "mv-test-terms-version") || null; };
  doc.createElement = (tag) => new El(tag, {});
  doc.activeElement = doc.body;
  return doc;
}
function fakeWindow({ status = [], seed = {}, confirmAnswer = false, search = "", create = null } = {}) {
  const calls = []; const q = [...status]; const timers = [];
  const fetch = async (path, init) => {
    const body = JSON.parse(init.body); const k = body.step || "create"; calls.push(k);
    if (k === "create" && create) return { status: create.s, json: async () => create.b };
    if (k === "status") { const r = typeof q[0] === "function" ? await q.shift()() : q.length > 1 ? q.shift() : q[0]; return { status: r.s, json: async () => r.b }; }
    return { status: 500, json: async () => ({}) };
  };
  const st = memStorage(); if (seed !== null) createStore(st).save({ token: TOKEN, releaseRequested: false, detailsSaved: true, polls: [], uncertain: null, ...seed });
  const confirms = [];
  return { calls, st, confirms, timers, win: { fetch, sessionStorage: st, setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {},
    location: { search, pathname: "/checkout-test.html", assign() {} }, history: { replaceState() {} }, confirm: (m) => { confirms.push(m); return confirmAnswer; } } };
}
const settle = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r)); };
async function open(opts) {
  const doc = fakeDocument(); const w = fakeWindow(opts); const c = startApp(doc, w.win); await settle();
  const $ = (id) => doc.getElementById(id);
  const runTimers = async (n = 100) => { for (let i = 0; i < n && w.timers.length; i++) { await w.timers.shift()(); await settle(); } };
  return { doc, ...w, c, $, runTimers, said: () => $("mv-announce").writes };
}
const visible = (el) => !el.closest("[hidden]");
const ST = (status) => ({ s: 200, b: { status } });

// ---------------------------------------------------------------------------------------------------------------------------------
test("W1 Guests defaults to 1; min / max / required unchanged", () => {
  const input = /<input type="number" name="guests"[^>]*>/.exec(HTML)[0];
  assert.match(input, /value="1"/); assert.match(input, /min="1"/); assert.match(input, /max="20"/); assert.match(input, /required/);
});

test("W2 reset kind follows the RENDERED screen: startNew only for terminal / released; every other screen keeps Forget", async () => {
  const cases = [
    ["expired", {}, "terminal", "startNew"], ["payment_failed", {}, "terminal", "startNew"], ["unavailable", {}, "terminal", "startNew"],
    ["not_completed_not_charged", {}, "terminal", "startNew"], ["unavailable_not_charged", {}, "terminal", "startNew"],
    ["unavailable_not_charged", { releaseRequested: true }, "released", "startNew"],
    ["processing", {}, "authorized", "forget"], ["release_requested", {}, "releaseQueued", "forget"], ["under_review", {}, "review", "forget"],
    ["confirmed", {}, "unexpected", "forget"], ["awaiting_payment", {}, "pay", "forget"], ["awaiting_details", { detailsSaved: false }, "details", "forget"],
    ["weird", {}, "unreadable", "forget"]];
  for (const [status, seed, screen, reset] of cases) {
    const r = rig([S(status)], { storage: seeded(seed) }); await r.c.init();
    assert.deepEqual([r.last().screen, r.last().reset], [screen, reset], `${status} ${JSON.stringify(seed)}`);
  }
  for (const [label, rep, screen] of [["429", reply(429, { code: "RATE_LIMITED" }), "notChecked"], ["401", reply(401, { code: "UNAUTHORIZED" }), "lost"]]) {
    const r = rig([rep]); await r.c.init(); assert.deepEqual([r.last().screen, r.last().reset], [screen, "forget"], label);
  }
  const p = rig([S("awaiting_payment")], { search: "?checkout=complete" }); await p.c.init(); assert.deepEqual([p.last().screen, p.last().reset], ["payWait", "forget"]);
  // retained terminal evidence, then 401 / unreadable: back to the loss-of-access Forget warning
  for (const [label, rep, screen] of [["401", reply(401, { code: "UNAUTHORIZED" }), "lost"], ["unreadable", S("weird"), "unreadable"], ["unknown", { kind: "unknown" }, "unreadable"]]) {
    const r = rig([S("expired"), rep]); await r.c.init(); assert.equal(r.last().reset, "startNew");
    await r.c.refresh(); assert.deepEqual([r.last().screen, r.last().reset], [screen, "forget"], `expired then ${label}`);
  }
});

test("W2 DOM: start-new copy is local-reset only (no claim); declined confirm keeps the bearer; accepted reset clears only local state; zero calls", async () => {
  const p = await open({ status: [ST("expired")] });
  assert.equal(p.$("mv-restart").textContent, "Start a new TEST booking…");
  const warn = p.$("mv-forget-warn").textContent;
  assert.match(warn, /only clears this tab/); assert.match(warn, /Nothing is sent to the server/); assert.doesNotMatch(warn, CLAIM);
  const n = p.calls.length; p.$("mv-restart").click(); await settle();
  assert.match(p.confirms[0], /only clears this tab; nothing is sent to the server/); assert.doesNotMatch(p.confirms[0], CLAIM);
  assert.deepEqual([JSON.parse(p.st.m.get(STORE_KEY)).token, p.calls.length], [TOKEN, n], "declined: bearer kept, nothing sent");
  const q = await open({ status: [ST("expired")], confirmAnswer: true }); const m = q.calls.length;
  q.$("mv-restart").click(); await settle();
  assert.deepEqual([q.st.m.has(STORE_KEY), q.calls.length, q.$("mv-title").textContent], [false, m, "Start a TEST booking"]);
  // a non-terminal screen keeps the reviewed Forget wording (also the static default) and its confirm text
  const f = await open({ status: [ST("under_review")] });
  assert.equal(f.$("mv-restart").textContent, "Forget this TEST booking in this tab…");
  assert.match(f.$("mv-forget-warn").textContent, /does not cancel the TEST booking or release any TEST hold/);
  f.$("mv-restart").click(); await settle(); assert.match(f.confirms[0], /does not cancel the booking or release any TEST hold/);
  // expired, then a 401: the label and warning switch back to Forget
  const l = await open({ status: [ST("expired"), { s: 401, b: { code: "UNAUTHORIZED" } }] });
  assert.equal(l.$("mv-restart").textContent, "Start a new TEST booking…");
  l.$("mv-refresh").click(); await settle();
  assert.deepEqual([l.$("mv-restart").textContent, /no longer be able to check it or request a release/.test(l.$("mv-forget-warn").textContent)], ["Forget this TEST booking in this tab…", true]);
  // the static HTML default is the Forget wording (no-JS fallback; F4 pin)
  assert.match(/<p id="mv-forget-warn"[^>]*>([^<]*)</.exec(HTML)[1], /does not cancel the TEST booking/);
  assert.match(/<button[^>]*id="mv-restart"[^>]*>([^<]*)</.exec(HTML)[1], /^Forget this TEST booking in this tab…$/);
});

test("W3 support codes: muted diagnostic line only (sanitized), never in the notice sentence, the stop line or the live region", async () => {
  // 429 on load: notice sentence without code; diag carries it; no duplicate stop line under a warn notice
  const r = await open({ status: [{ s: 429, b: { code: "RATE_LIMITED" } }] });
  assert.equal(r.$("mv-notice").textContent.includes("["), false); assert.doesNotMatch(r.$("mv-notice").textContent, CODEISH);
  assert.deepEqual([r.$("mv-diag").textContent, visible(r.$("mv-diag")), r.$("mv-diag").className], ["Support code: RATE_LIMITED", true, "diag"]);
  assert.equal(r.$("mv-polling").textContent, "", "the warn notice already explains the stop");
  // Stripe return until BUDGET: info notice + plain stop reason with the manual hint; both codes in the diag
  const b = await open({ status: [ST("awaiting_payment")], search: "?checkout=complete" }); await b.runTimers();
  assert.equal(b.$("mv-polling").textContent, "Automatic checks paused to limit requests. Use Refresh status to check again.");
  assert.equal(b.$("mv-diag").textContent, "Support code: RETURNED_COMPLETE, BUDGET");
  // lost: no Refresh hint anywhere, no duplicate warning
  const l = await open({ status: [{ s: 401, b: { code: "UNAUTHORIZED" } }] });
  assert.equal(l.$("mv-polling").textContent, ""); assert.doesNotMatch(`${l.$("mv-text").textContent} ${l.$("mv-notice").textContent}`, /Refresh/);
  assert.equal(l.$("mv-diag").textContent, "Support code: UNAUTHORIZED");
  // a hostile server code is sanitized end to end
  const h = await open({ status: [{ s: 503, b: { code: "<img src=x>" } }] });
  assert.equal(h.$("mv-diag").textContent, "Support code: UNEXPECTED_REPLY, ERROR", "hostile code replaced; the stop code is listed too");
  for (const x of [r, b, l, h]) { assert.doesNotMatch(x.said().join(" "), CODEISH, "no codes announced"); assert.doesNotMatch(x.$("mv-polling").textContent, CODEISH); }
  // the diagnostic line sits outside the live region
  assert.notEqual(r.$("mv-diag").parent, r.$("mv-announce")); assert.equal(r.$("mv-announce").children.length, 0);
});

test("W3 stop reasons: plain text per code; neutral fallback for an unknown code; manual hint only when Refresh is offered; support-code fallback", () => {
  assert.equal(page.stopLine("BUDGET", true), "Automatic checks paused to limit requests. Use Refresh status to check again.");
  assert.equal(page.stopLine("RATE_LIMITED", true), "Automatic checks stopped because the server asked this page to slow down. Wait, then use Refresh status.");
  for (const c of ["STORAGE", "UNREADABLE", "ERROR"]) { assert.match(page.stopLine(c, true), /\. Use Refresh status\.$/); assert.doesNotMatch(page.stopLine(c, false), /Refresh/); }
  for (const c of ["WHATEVER", "__proto__", "toString", "", undefined]) {
    assert.equal(page.stopLine(c, false), "Automatic checks stopped.", String(c)); assert.equal(page.stopLine(c, true), "Automatic checks stopped. Use Refresh status.", String(c));
  }
  for (const c of ["BUDGET", "RATE_LIMITED", "STORAGE", "UNREADABLE", "ERROR"]) assert.doesNotMatch(page.stopLine(c, true), CODEISH);
  assert.deepEqual(["RATE_LIMITED", "<b>", "lower", "", null, 5, "A".repeat(65)].map(page.supportCode),
    ["RATE_LIMITED", "UNEXPECTED_REPLY", "UNEXPECTED_REPLY", "UNEXPECTED_REPLY", "UNEXPECTED_REPLY", "UNEXPECTED_REPLY", "UNEXPECTED_REPLY"]);
});

test("W5 shorter Processing text keeps every caution; the release-zone lead carries server authority", () => {
  const t = describe("processing").text;
  for (const re of [/Keep this tab open/, /test operator/, /Do not make another TEST payment/, /may be held/, /cannot show whether it has been captured or released/,
    /does not create a reservation or confirm a booking/]) assert.match(t, re);
  assert.doesNotMatch(t, /Request release|^Next:/);
  assert.equal(describe("processing").title, "Processing — not a booking");
  assert.match(/<div id="mv-release-trigger">\s*<p class="muted">([^<]*)</.exec(HTML)[1], /^Only if you want to end this test early\. The server decides whether a release is still allowed\.$/);
});

test("A1 live region: one pre-existing polite atomic status element; no alert / modal; outside hidden content", () => {
  const tag = /<p id="mv-announce"[^>]*>/.exec(HTML)[0];
  for (const a of ['role="status"', 'aria-live="polite"', 'aria-atomic="true"', 'class="sr-only"']) assert.ok(tag.includes(a), a);
  assert.doesNotMatch(tag, /hidden/); assert.doesNotMatch(HTML, /role="alert"|aria-live="assertive"|aria-modal/);
  assert.equal((HTML.match(/aria-live=/g) || []).length, 1, "exactly one live region");
  const d = fakeDocument(); assert.equal(visible(d.getElementById("mv-announce")), true);
});

test("A1 announcement decision: busy / loading never consume the key (a change seen while busy is announced once settled); create clears", () => {
  const v = (o) => ({ screen: "authorized", title: "Processing — not a booking", notice: null, busy: false, ...o });
  const first = page.announcementFor(v({}), null); assert.deepEqual(first.text, "Processing — not a booking");
  assert.equal(page.announcementFor(v({}), first.key), null, "identical render: nothing");
  const changedBusy = v({ screen: "releaseQueued", title: "Release requested — not released yet", busy: true });
  assert.equal(page.announcementFor(changedBusy, first.key), null, "busy: nothing, key NOT consumed");
  const settled = page.announcementFor({ ...changedBusy, busy: false }, first.key);
  assert.equal(settled.text, "Release requested — not released yet", "announced once when settled");
  assert.equal(page.announcementFor({ ...changedBusy, busy: false }, settled.key), null);
  assert.equal(page.announcementFor(v({ screen: "loading", title: "Checking status…" }), settled.key), null);
  // the notice sentence is part of the key, and the text never carries the code
  const n1 = page.announcementFor(v({ notice: { code: "RATE_LIMITED", text: "Too many requests." } }), first.key);
  assert.equal(n1.text, "Processing — not a booking. Too many requests.");
  assert.notEqual(page.announcementFor(v({ notice: { code: "RATE_LIMITED", text: "Other sentence." } }), n1.key), null);
  assert.deepEqual(page.announcementFor(v({ screen: "create", title: "Start a TEST booking" }), n1.key), { key: null, text: "" });
});

test("A1 DOM: identical polls write nothing; a status change writes once; focus never moves; no codes / price / guest data / bearer", async () => {
  const p = await open({ status: [ST("release_requested")], seed: { releaseRequested: true } });
  p.$("mv-refresh").focus(); const focused = p.doc.activeElement;
  await p.runTimers();
  assert.deepEqual(p.said(), ["Release requested — not released yet"], "24 identical automatic reads: one announcement");
  assert.equal(p.calls.filter((k) => k === "status").length, POLL.maxAuto);
  assert.equal(p.doc.activeElement, focused, "announcements never move focus");
  // a real change after a manual refresh announces exactly once more; an unchanged one announces nothing
  const q = await open({ status: [ST("processing"), ST("processing"), ST("release_requested")] });
  q.$("mv-refresh").click(); await settle(); assert.deepEqual(q.said(), ["Processing — not a booking"], "same status after refresh: nothing new");
  const before = q.doc.activeElement; q.$("mv-refresh").click(); await settle();
  assert.deepEqual(q.said(), ["Processing — not a booking", "Release requested — not released yet"]); assert.equal(q.doc.activeElement, before);
  for (const x of [p, q]) { const all = x.said().join(" "); assert.doesNotMatch(all, CODEISH); assert.doesNotMatch(all, /\$|USD|@|Total/); assert.ok(!all.includes(TOKEN)); }
});

test("A1 DOM: a change first rendered while busy is announced once after settling", async () => {
  let release; const gate = () => new Promise((r) => { release = () => r(ST("release_requested")); });
  const p = await open({ status: [ST("processing"), gate] });
  assert.deepEqual(p.said(), ["Processing — not a booking"]);
  p.$("mv-refresh").click(); await settle();                        // busy render (Refresh disabled): nothing announced
  assert.equal(p.$("mv-refresh").disabled, true); assert.deepEqual(p.said(), ["Processing — not a booking"]);
  release(); await settle();
  assert.deepEqual(p.said(), ["Processing — not a booking", "Release requested — not released yet"]);
});

test("A1 DOM: an explicit reset clears the region (no create / loading announcement); the same status in the NEXT intent is announced again once", async () => {
  const p = await open({ status: [ST("awaiting_details")], seed: { detailsSaved: false }, confirmAnswer: true,
    create: { s: 201, b: { token: TOKEN2, status: "awaiting_details", price: { totalMinor: 14000, currency: "USD", lines: [] } } } });
  assert.deepEqual(p.said(), ["Enter guest details"]);
  p.$("mv-restart").click(); await settle();
  assert.deepEqual([p.$("mv-announce").textContent, p.said().length], ["", 2], "cleared with ONE write; nothing announced for the create screen");
  assert.equal(p.$("mv-title").textContent, "Start a TEST booking");
  await p.c.create({ from: "2027-01-10", to: "2027-01-11", guests: 1 }); await settle();
  assert.deepEqual(p.said(), ["Enter guest details", "", "Enter guest details"], "new intent: the same status announced once again");
  assert.doesNotMatch(p.said().join(" "), /140|USD|Total/, "no price announced");
});
