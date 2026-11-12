// E7 checkout TEST page — two-step release confirmation (ROOT-approved proposal 2026-11-11). FAKE API / storage / timers and a FAKE DOM built
// from the page's REAL HTML (no browser, no network). The fake DOM models only what startApp uses: ids, hidden (incl. ancestors), disabled,
// text, focus / activeElement, click / keydown listeners, querySelectorAll("button"), the terms meta and dataset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createController, createStore, startApp, STORE_KEY } from "../public/checkout-test.js";

const TOKEN = Buffer.alloc(32, 3).toString("base64url");
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
function fakeApi(script = {}) {
  const calls = []; const q = { create: [], details: [], pay: [], release: [], status: [], ...script };
  const def = { release: reply(202, { status: "release_requested", release: "REQUESTED" }), status: reply(200, { status: "processing" }) };
  const m = (k) => async () => { calls.push(k); return q[k].length ? q[k].shift() : def[k] ?? reply(500, {}); };
  return { calls, q, count: (k) => calls.filter((c) => c === k).length, api: { create: m("create"), details: m("details"), pay: m("pay"), release: m("release"), status: m("status") } };
}
function rig({ storage = seeded(), api = fakeApi(), timers = fakeTimers() } = {}) {
  const views = []; const nav = { assign() {}, search: () => "", stripQuery() {} };
  const c = createController({ api: api.api, store: createStore(storage), ui: { render: (v) => views.push(v) }, timers, nav, config: CFG, now: () => timers.now });
  return { c, views, api, timers, storage, last: () => views[views.length - 1] };
}
/** a rig that has READ the current status ("processing" → screen authorized) */
async function processing(o = {}) { const r = rig(o); await r.c.init(); assert.equal(r.last().screen, "authorized"); return r; }
const confirmed = (c) => { c.armRelease(); return c.confirmRelease(); };

// ---------------------------------------------------------------------------------------------------------------------------------
test("RED-1 (failing on a9b5efd6): one-click c.release() from the Processing screen sends NOTHING — it only opens the confirmation", async () => {
  const r = await processing();
  await r.c.release();
  assert.equal(r.api.count("release"), 0, "no one-click release");
  assert.equal(r.last().confirmingRelease, true, "the alias only arms the confirmation");
});

test("R1 / R2 arm and cancel make ZERO API calls (×10); the state returns to unarmed", async () => {
  const r = await processing(); const before = r.api.calls.length;
  assert.deepEqual([r.last().canRequestRelease, r.last().confirmingRelease], [true, false]);
  for (let i = 0; i < 10; i++) { r.c.armRelease(); assert.equal(r.last().confirmingRelease, true); r.c.cancelRelease(); assert.equal(r.last().confirmingRelease, false); }
  assert.equal(r.api.calls.length, before, "no status read, no release");
});

test("R3 arm + confirm sends exactly ONE release; the accepted success path follows; the panel closes", async () => {
  const r = await processing();
  await confirmed(r.c);
  assert.equal(r.api.count("release"), 1);
  assert.deepEqual([r.last().confirmingRelease, r.last().screen, r.c.state.notice.code, r.c.state.st.releaseRequested, r.c.state.polling], [false, "releaseQueued", "RELEASE_REQUESTED", true, true]);
});

test("R4 confirm without arming sends nothing; R5 a double / concurrent confirm sends once (the armed state is consumed synchronously)", async () => {
  const r = await processing();
  await r.c.confirmRelease(); assert.equal(r.api.count("release"), 0);
  r.c.armRelease(); const p1 = r.c.confirmRelease(); const p2 = r.c.confirmRelease(); await Promise.all([p1, p2]);
  assert.equal(r.api.count("release"), 1);
});

test("R6 armed, then ANY operation or status / error change disarms it; a later confirm sends nothing", async () => {
  const cases = [["release_requested", reply(200, { status: "release_requested" })], ["under_review", reply(200, { status: "under_review" })],
    ["unavailable_not_charged", reply(200, { status: "unavailable_not_charged" })], ["unknown status", reply(200, { status: "weird" })],
    ["unreadable", { kind: "unknown" }], ["429", reply(429, { code: "RATE_LIMITED" })], ["401", reply(401, { code: "UNAUTHORIZED" })], ["still processing", reply(200, { status: "processing" })]];
  for (const [label, rep] of cases) {
    const f = fakeApi(); const r = await processing({ api: f });
    r.c.armRelease(); assert.equal(r.last().confirmingRelease, true);
    f.q.status.push(rep); await r.c.refresh();
    assert.equal(r.last().confirmingRelease, false, `${label}: disarmed`);
    await r.c.confirmRelease(); assert.equal(f.count("release"), 0, `${label}: no stale send`);
  }
  // reset / forget: never an old armed action afterwards
  const r = await processing(); r.c.armRelease(); r.c.startOver(); await r.c.confirmRelease(); assert.equal(r.api.count("release"), 0);
  // arming is refused while busy (an operation in flight)
  let release; const slow = fakeApi(); const r2 = await processing({ api: slow });
  slow.api.status = () => new Promise((res) => { release = () => res(reply(200, { status: "processing" })); });
  const p = r2.c.refresh(); r2.c.armRelease(); assert.equal(r2.last().confirmingRelease, false, "busy: not armed"); release(); await p;
});

test("R7 the armed state is never persisted: reload → unarmed; storage schema unchanged", async () => {
  const s = seeded(); const r = await processing({ storage: s }); r.c.armRelease();
  assert.deepEqual(Object.keys(JSON.parse(s.m.get(STORE_KEY))).sort(), ["detailsSaved", "polls", "releaseRequested", "token", "uncertain"]);
  const r2 = await processing({ storage: s });
  assert.equal(r2.last().confirmingRelease, false); await r2.c.confirmRelease(); assert.equal(r2.api.count("release") + r.api.count("release"), 0);
});

test("R8 uncertain release latches: no re-arm, no ordinary send; only the accepted EXPLICIT resend after a fresh 'processing' (one call)", async () => {
  const f = fakeApi({ release: [{ kind: "unknown" }] }); const r = await processing({ api: f });
  await confirmed(r.c); assert.deepEqual([r.c.state.notice.code, r.last().latch, f.count("release")], ["RELEASE_UNCERTAIN", "release", 1]);
  r.c.armRelease(); assert.deepEqual([r.last().confirmingRelease, r.last().canRequestRelease], [false, false]);
  await r.c.confirmRelease(); await r.c.release(); assert.equal(f.count("release"), 1);
  await r.c.refresh(); assert.equal(r.last().retry, "release");
  await r.c.retryUncertain(); assert.equal(f.count("release"), 2, "explicit resend (server treats a repeat as the same request)");
});

test("R9 a definite refusal after confirm: warn notice, no latch, disarmed; re-arming stays possible (the server is authoritative)", async () => {
  const f = fakeApi({ release: [reply(409, { code: "NOT_RELEASABLE" })] }); const r = await processing({ api: f });
  await confirmed(r.c);
  assert.deepEqual([r.c.state.notice.level, r.c.state.notice.code, r.last().latch, r.last().confirmingRelease], ["warn", "NOT_RELEASABLE", null, false]);
  r.c.armRelease(); assert.equal(r.last().confirmingRelease, true);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// FAKE DOM from the page's real HTML
const HTML = readFileSync(new URL("../public/checkout-test.html", import.meta.url), "utf8");
const VOID = new Set(["meta", "link", "input", "br", "img"]);
function fakeDocument() {
  const doc = { activeElement: null, byId: new Map(), all: [] };
  class El {
    constructor(tag, attrs) { this.tag = tag; this.attrs = attrs; this.children = []; this.parent = null; this.listeners = {}; this.textContent = "";
      this.id = attrs.id || ""; this.hidden = "hidden" in attrs; this.disabled = false; this.className = attrs.class || "";
      this.dataset = Object.fromEntries(Object.entries(attrs).filter(([k]) => k.startsWith("data-")).map(([k, v]) => [k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v])); }
    get content() { return this.attrs.content; }
    focus() { if (!this.disabled) doc.activeElement = this; }   // like a browser: a disabled control cannot take focus
    closest(sel) { assert.equal(sel, "[hidden]"); for (let e = this; e; e = e.parent) if (e.hidden) return e; return null; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    dispatch(type, ev = {}) { const e = { key: ev.key, preventDefault() {}, ...ev }; for (const fn of this.listeners[type] || []) fn(e); return e; }
    click() { if (!this.disabled) this.dispatch("click"); }
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
function fakeWindow(script) {
  const calls = []; const q = { status: [], release: [], ...script };
  const fetch = async (path, init) => {
    const body = JSON.parse(init.body); const k = body.step || "create"; calls.push(k);
    const r = q[k] && q[k].length ? q[k].shift() : k === "status" ? { s: 200, b: { status: "processing" } } : { s: 202, b: { status: "release_requested", release: "REQUESTED" } };
    return { status: r.s, json: async () => r.b };
  };
  const st = memStorage(); createStore(st).save({ token: TOKEN, releaseRequested: false, detailsSaved: true, polls: [], uncertain: null });
  return { calls, q, win: { fetch, sessionStorage: st, setTimeout: () => 0, clearTimeout() {}, location: { search: "", pathname: "/checkout-test.html", assign() {} },
    history: { replaceState() {} }, confirm: () => false } };
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
async function page(script = {}) { const doc = fakeDocument(); const w = fakeWindow(script); const c = startApp(doc, w.win); await settle(); return { doc, ...w, c, $: (id) => doc.getElementById(id) }; }
const visible = (el) => !el.closest("[hidden]");

test("D1 DOM order + affordance: on Processing, Refresh precedes the release zone; release is secondary; the confirm panel starts hidden", async () => {
  const p = await page();
  assert.equal(p.$("mv-title").textContent, "Processing — not a booking");
  const idx = (id) => p.doc.all.indexOf(p.$(id));
  assert.ok(idx("mv-refresh") < idx("mv-release"), "Refresh first");
  assert.equal(p.$("mv-release-btn").className, "secondary"); assert.equal(p.$("mv-refresh").className, "", "Refresh is the filled primary");
  assert.deepEqual([visible(p.$("mv-release-btn")), visible(p.$("mv-release-confirm")), visible(p.$("mv-refresh"))], [true, false, true]);
  assert.equal(p.$("mv-release-confirm").attrs.role, "group"); assert.equal("aria-modal" in p.$("mv-release-confirm").attrs, false, "inline group, not a modal");
});

test("D2 keyboard: trigger opens the panel and focuses Keep waiting; Escape cancels with ZERO calls and restores focus to the trigger", async () => {
  const p = await page(); const n = p.calls.length;
  p.$("mv-release-btn").focus(); p.$("mv-release-btn").click(); await settle();
  assert.deepEqual([visible(p.$("mv-release-confirm")), visible(p.$("mv-release-btn")), p.doc.activeElement.id], [true, false, "mv-release-keep"]);
  p.$("mv-release-confirm").dispatch("keydown", { key: "Escape" }); await settle();
  assert.deepEqual([visible(p.$("mv-release-confirm")), p.doc.activeElement.id, p.calls.length], [false, "mv-release-btn", n]);
  // Keep waiting button: same as Escape
  p.$("mv-release-btn").click(); p.$("mv-release-keep").click(); await settle();
  assert.deepEqual([visible(p.$("mv-release-confirm")), p.doc.activeElement.id, p.calls.length], [false, "mv-release-btn", n]);
  // other keys do nothing
  p.$("mv-release-btn").click(); p.$("mv-release-confirm").dispatch("keydown", { key: "Enter" }); await settle();
  assert.equal(visible(p.$("mv-release-confirm")), true); assert.equal(p.calls.length, n);
});

test("D3 Yes, request release: ONE request; both confirmation buttons are disabled while busy; focus never left in hidden content", async () => {
  const w = fakeWindow({}); let held;
  const docB = fakeDocument(); const win = { ...w.win, fetch: async (path, init) => { const k = JSON.parse(init.body).step; w.calls.push(k);
    if (k === "release") return new Promise((r) => { held = () => r({ status: 202, json: async () => ({ status: "release_requested", release: "REQUESTED" }) }); });
    return { status: 200, json: async () => ({ status: "processing" }) }; } };
  startApp(docB, win); await settle();
  const $ = (id) => docB.getElementById(id);
  $("mv-release-btn").click(); await settle();
  $("mv-release-yes").click(); $("mv-release-yes").click(); await settle();
  assert.equal(w.calls.filter((k) => k === "release").length, 1, "double click sends once");
  assert.ok(!visible($("mv-release-confirm")), "the panel closed when the send started");
  for (const id of ["mv-release-yes", "mv-release-keep", "mv-release-btn"]) assert.equal($(id).disabled, true, `${id} disabled while busy`);
  assert.equal(docB.activeElement.id, "mv-title", "while busy, focus falls back to the status heading (Refresh is disabled), never hidden Keep waiting");
  held(); await settle();
  assert.ok(visible(docB.activeElement) && docB.activeElement !== docB.body, `focus on visible content (${docB.activeElement.id})`);
  assert.match($("mv-title").textContent, /not released yet/);
});

test("D4 auto-dismiss: armed panel closed by a status change moves focus OUT of hidden content (Refresh / heading); an unrelated render never steals focus", async () => {
  const p = await page({ status: [{ s: 200, b: { status: "processing" } }, { s: 200, b: { status: "under_review" } }] });
  p.$("mv-release-btn").click(); await settle(); assert.equal(p.doc.activeElement.id, "mv-release-keep");
  p.$("mv-refresh").click(); await settle();
  assert.equal(visible(p.$("mv-release")), false);
  assert.ok(["mv-refresh", "mv-title"].includes(p.doc.activeElement.id) && visible(p.doc.activeElement), `fallback focus (${p.doc.activeElement.id})`);
  // focus placed by the user on a visible control stays put across renders
  const q = await page(); q.$("mv-refresh").focus(); q.$("mv-refresh").click(); await settle(); q.$("mv-refresh").click(); await settle();
  assert.equal(q.doc.activeElement.id, "mv-refresh");
});

test("R10 source pins: arm-only click binding, no window.confirm on the release path, inline group (no aria-modal), copy makes no positive booking / charge / release claim", () => {
  const js = readFileSync(new URL("../public/checkout-test.js", import.meta.url), "utf8");
  assert.match(js, /\$\("mv-release-btn"\)\.addEventListener\("click", \(\) => c\.armRelease\(\)\)/);
  for (const line of js.split("\n").filter((l) => /mv-release-(btn|keep|yes|confirm)"/.test(l) && /addEventListener/.test(l)))
    assert.doesNotMatch(line, /win\.confirm|window\.confirm/, "no native confirm on the release path");
  assert.equal((js.match(/win\.confirm\(/g) || []).length, 2, "only the pre-existing ack / forget confirms");
  assert.match(js, /release\(\) \{ this\.armRelease\(\); \}/, "compatibility alias is arm-only");
  const panel = /<div id="mv-release-confirm"[\s\S]*?<\/div>/.exec(HTML)[0];
  assert.doesNotMatch(panel, /aria-modal/);
  assert.doesNotMatch(panel, /\b(booking|reservation) (is )?confirmed|\bcharged\b|\brefunded\b|\breleased\b|has been released/i);
  assert.match(panel, /queued, not instant/); assert.match(panel, /cannot undo/); assert.match(panel, /server decides/);
});
