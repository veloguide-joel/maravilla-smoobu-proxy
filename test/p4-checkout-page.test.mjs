// P4-1: the guest checkout page (public/checkout.html / checkout.js) and its config route. No DOM, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AUTO_CHECK, WAITING_SCREENS, RETRY_SCREENS, SETTLED_SCREENS, WAIT_TEXT, autoCheckPlan, RETURN_NOTICES, showsSupportCode, UNBOOKABLE_CODES, UNBOOKABLE_TEXT, isUnbookable, guestNoticeFor, GUEST_REFUSALS, offerNewStay, FINISHED_SCREENS, parseStayQuery, guestCopy, guestNotice, readCheckoutConfig, CANCELLATION_POLICY, CANCELLATION_CONTACT, BRAND, RETURN_HINTS, CONFIG_PATH } from "../public/checkout.js";
import { renderBookingConfirmationV2, BRAND_V2, CANCELLATION_CONTACT as EMAIL_CONTACT } from "../lib/checkout/booking-confirmation-copy.js";
import { createCheckoutConfigHandler } from "../lib/checkout/checkout-config-http.js";
import { ENV_OK } from "./e5a-fixtures.mjs";

const read = (p) => readFileSync(new URL(`../public/${p}`, import.meta.url), "utf8");

test("P4-1 stay link: strict parsing; the two Stripe return hints and an empty query are not a stay", () => {
  const ok = parseStayQuery("?listing=606998&from=2026-12-12&to=2026-12-15&guests=2&name=Casa%20Uno");
  assert.deepEqual(ok, { ok: true, stay: { listingId: 606998, from: "2026-12-12", to: "2026-12-15", guests: 2, nights: 3, name: "Casa Uno" } });
  assert.equal(parseStayQuery("?listing=1&from=2026-12-12&to=2026-12-13&guests=1").stay.name, null);
  for (const q of ["", ...RETURN_HINTS]) assert.equal(parseStayQuery(q), null);
  const code = (q) => parseStayQuery(q).code;
  assert.equal(code("?listing=abc&from=2026-12-12&to=2026-12-13&guests=1"), "LISTING_INVALID");
  assert.equal(code("?listing=0&from=2026-12-12&to=2026-12-13&guests=1"), "LISTING_INVALID");
  assert.equal(code("?listing=5&from=2026-02-30&to=2026-03-02&guests=1"), "DATES_INVALID");
  assert.equal(code("?listing=5&from=2026-12-13&to=2026-12-13&guests=1"), "DATES_INVALID");
  assert.equal(code("?listing=5&from=2026-12-13&to=2028-12-13&guests=1"), "DATES_INVALID");
  assert.equal(code("?listing=5&from=2026-12-12&to=2026-12-13&guests=0"), "GUESTS_INVALID");
  assert.equal(code("?listing=5&from=2026-12-12&to=2026-12-13&guests=99"), "GUESTS_INVALID");
  assert.equal(code("?listing=5&from=2026-12-12&to=2026-12-13&guests=1&x=1"), "LINK_INVALID");
  assert.equal(code("?listing=5&listing=6&from=2026-12-12&to=2026-12-13&guests=1"), "LINK_INVALID");
  assert.equal(parseStayQuery("?listing=5&from=2026-12-12&to=2026-12-13&guests=1&name=%3Cb%3Ex").stay.name, null, "a name with markup characters is dropped, not shown");
});

test("P4-1 policy: the page shows exactly the cancellation policy sentences of the confirmation email (bcc-v2, English)", () => {
  const email = renderBookingConfirmationV2({ template: "booking_confirmed", locale: "en",
    facts: { ref: "MV-ABCDEF12", checkIn: "2026-12-10", checkOut: "2026-12-11", nights: 1, guests: 1, totalMinor: 16940, currency: "USD" } }).copy.text.split("\n");
  const at = email.indexOf("Cancellation policy");
  assert.deepEqual([...CANCELLATION_POLICY], email.slice(at + 1, at + 4));
  assert.deepEqual([BRAND, CANCELLATION_CONTACT], [BRAND_V2, EMAIL_CONTACT]);
});

test("P4-1 wording: every screen has guest wording without test wording; a confirmed booking shows its reference; notices lose test wording", () => {
  const screens = ["create", "loading", "details", "pay", "redirecting", "payWait", "authorized", "confirming", "finalizing", "complete", "terminal", "review", "lost", "unreadable", "notChecked", "unexpected", "createUncertain", "somethingNew"];
  for (const screen of screens) {
    const c = guestCopy({ screen, text: "The server reports this TEST booking complete. Booking reference: MV-TK3NP7NN. This is a TEST booking." });
    assert.ok(c.title.length > 0, screen);
    assert.doesNotMatch(`${c.title} ${c.text}`, /TEST|test |server|intent|operator/, screen);
  }
  assert.match(guestCopy({ screen: "complete", text: "x Booking reference: MV-TK3NP7NN. y" }).text, /Booking reference: MV-TK3NP7NN\./);
  assert.doesNotMatch(guestCopy({ screen: "complete", text: "no reference here" }).text, /Booking reference/);
  assert.equal(guestNotice("This tab cannot remember the TEST booking; payment stays disabled."), "This tab cannot remember the booking; payment stays disabled.");
  assert.equal(guestNotice("It is unknown whether a TEST intent was created. Nothing is retried."), "It is unknown whether a booking request was created. Nothing is retried.");
});

test("P4-1 page: strict CSP, no inline script or style, every element the script uses exists, no test wording in the markup", () => {
  const html = read("checkout.html"); const js = read("checkout.js");
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'"/);
  assert.doesNotMatch(html, /<script(?![^>]*src=)|<style|\son[a-z]+=|style="/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  const ids = [...js.matchAll(/\$\("([a-z-]+)"\)|show\("([a-z-]+)"|form\("([a-z-]+)"\)/g)].map((m) => m[1] || m[2] || m[3]);
  assert.ok(ids.length > 20);
  for (const id of new Set(ids)) assert.ok(html.includes(`id="${id}"`), `missing element #${id}`);
  assert.doesNotMatch(html.replace(/<p id="mv-test-banner"[^\n]*\n/, ""), /TEST|maraVilla/);
  assert.match(js, /from "\.\/checkout-test\.js"/, "the booking logic is imported, not copied");
  assert.doesNotMatch(js, /createController\s*=|function createController/);
});

test("P4-1 config: GET /api/checkout/config returns only mode and terms version, 404 when the checkout API is unavailable; the page reader is strict", async () => {
  const ENV = { ...ENV_OK, MV_CHECKOUT_TEST_API: "enabled", MV_CHECKOUT_ALLOWED_ORIGIN: "https://preview.example.invalid", MV_CHECKOUT_TEST_LISTINGS: "606998:USD",
    MV_RATE_LIMIT_SALT: "s".repeat(40), MV_CHECKOUT_TERMS_VERSION: "terms-2026-11" };
  const call = (env, method = "GET") => { const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
    createCheckoutConfigHandler({ env })({ method }, res); return res; };
  const ok = call(ENV);
  assert.deepEqual([ok.statusCode, JSON.parse(ok.body), ok.headers["Cache-Control"]], [200, { mode: "test", termsVersion: "terms-2026-11" }, "no-store"]);
  assert.equal(Object.keys(ok.headers).some((h) => /access-control/i.test(h)), false, "no CORS: same-origin only");
  assert.equal(call(ENV, "POST").statusCode, 405);
  for (const env of [{}, { ...ENV, MV_CHECKOUT_TEST_API: "" }, { ...ENV, VERCEL_ENV: "production" }]) { const r = call(env); assert.deepEqual([r.statusCode, JSON.parse(r.body)], [404, { code: "NOT_FOUND" }]); }
  const fake = (status, body) => async (path, init) => { assert.equal(path, CONFIG_PATH); assert.equal(init.method, "GET"); return { status, json: async () => body }; };
  assert.deepEqual(await readCheckoutConfig(fake(200, { mode: "live", termsVersion: "terms-2026-11" })), { mode: "live", termsVersion: "terms-2026-11" });
  for (const [s, b] of [[404, { code: "NOT_FOUND" }], [200, { mode: "prod", termsVersion: "x" }], [200, { mode: "test", termsVersion: "<b>" }], [200, null]]) assert.equal(await readCheckoutConfig(fake(s, b)), null);
  assert.equal(await readCheckoutConfig(async () => { throw new Error("network"); }), null);
});

test("P4-1b new stay: offered only with a valid stay link AND a finished booking in the tab; never over a booking in progress", () => {
  const stay = parseStayQuery("?listing=5&from=2026-12-12&to=2026-12-13&guests=1").stay;
  assert.deepEqual([...FINISHED_SCREENS], ["complete", "terminal"]);
  for (const s of FINISHED_SCREENS) { assert.equal(offerNewStay(s, stay), true, s); assert.equal(offerNewStay(s, null), false, s); }
  for (const s of ["create", "details", "pay", "payWait", "authorized", "confirming", "finalizing", "review", "lost", "unreadable", "createUncertain", "loading"]) assert.equal(offerNewStay(s, stay), false, s);
});

test("Origin header: the checkout API calls never use referrerPolicy no-referrer (browsers that follow the Fetch standard send `Origin: null` with it, which the API refuses); navigations keep no-referrer", () => {
  const api = read("checkout-test.js");
  assert.match(api, /method: "POST"[^\n]*referrerPolicy: "same-origin"/);
  assert.doesNotMatch(api, /method: "POST"[^\n]*referrerPolicy: "no-referrer"/);
  for (const page of ["checkout.html", "checkout-test.html"]) assert.match(read(page), /<meta name="referrer" content="no-referrer">/, page);
});


test("P4-6: every 'definite refusal' notice the controller can raise has guest wording (no operator phrasing reaches the guest)", () => {
  const src = readFileSync(new URL("../public/checkout-test.js", import.meta.url), "utf8");
  const raised = [...src.matchAll(/text: "([^"]*\(a definite refusal\)\.)"/g)].map((m) => m[1]);
  assert.equal(raised.length, 4);
  assert.deepEqual([...new Set(raised)].sort(), Object.keys(GUEST_REFUSALS).sort());
  for (const r of raised) { const g = guestNotice(r); assert.ok(!/refus|server|definite|TEST/i.test(g), g); assert.match(g, /info@micasadirect\.com/); }
  assert.match(guestNotice("The server refused to start payment (a definite refusal)."), /Nothing was charged/);
});

test("P4-7: a listing or dates that cannot be booked get their own wording (never 'try again'), and the price button is hidden", () => {
  const core = readFileSync(new URL("../lib/checkout/intent-api-core.js", import.meta.url), "utf8");
  for (const c of UNBOOKABLE_CODES) {
    assert.ok(core.includes(`code: "${c}"`), c);
    const n = { level: "warn", code: c, text: "The server refused the request (a definite refusal)." };
    assert.equal(isUnbookable(n), true);
    assert.equal(guestNoticeFor(n), UNBOOKABLE_TEXT);
  }
  assert.ok(!/try again/i.test(UNBOOKABLE_TEXT));
  const other = { level: "warn", code: "RATE_LIMITED", text: "The server refused the request (a definite refusal)." };
  assert.equal(isUnbookable(other), false);
  assert.match(guestNoticeFor(other), /try again in a moment/);
  assert.equal(guestNoticeFor(null), "");
  const page = readFileSync(new URL("../public/checkout.js", import.meta.url), "utf8");
  assert.ok(page.includes('show("mv-create", v.screen === "create" && !!stay && !isUnbookable(v.notice));'));
});

test("P4-8: returning from the payment page shows no operator hint and no support code", () => {
  const src = readFileSync(new URL("../public/checkout-test.js", import.meta.url), "utf8");
  for (const c of Object.keys(RETURN_NOTICES)) assert.ok(src.includes(`"${c}"`), c);
  const done = { level: "info", code: "RETURNED_COMPLETE", text: "You returned from Stripe. This is only a hint: the page now asks the server what actually happened." };
  assert.equal(guestNoticeFor(done), "");
  assert.equal(showsSupportCode(done), false);
  const left = { ...done, code: "RETURNED_CANCELLED" };
  assert.match(guestNoticeFor(left), /before paying/);
  assert.ok(readFileSync(new URL("../public/checkout.js", import.meta.url), "utf8").includes("showsSupportCode(v.notice) ? v.notice.code : null"));
  assert.ok(!/Stripe|hint|server/i.test(guestNoticeFor(left)));
  assert.equal(showsSupportCode(left), false);
  assert.equal(showsSupportCode({ level: "warn", code: "RATE_LIMITED", text: "x" }), true);
  assert.equal(showsSupportCode(null), false);
});

test("P7-1: while a paid booking is being confirmed the page checks by itself (inside the server's read limit) and never asks for Refresh status", () => {
  const t0 = 1_000_000;
  for (const screen of WAITING_SCREENS) {
    assert.deepEqual(autoCheckPlan({ screen, waiting: true, startedAt: t0, now: t0 + 1 }), { mode: "auto", again: true });
    assert.ok(!/Refresh status/.test(guestCopy({ screen }).text), screen);
  }
  for (const screen of RETRY_SCREENS) assert.equal(autoCheckPlan({ screen, waiting: true, startedAt: t0, now: t0 + 1 }).mode, "auto", "a failed read is simply tried again");
  assert.equal(autoCheckPlan({ screen: "notChecked", waiting: false, startedAt: null, now: t0 }).mode, "off", "never started for a page that was not waiting");
  for (const screen of [...SETTLED_SCREENS, "review", "lost", "create", "details", "pay"]) assert.equal(autoCheckPlan({ screen, waiting: true, startedAt: t0, now: t0 + 1 }).mode, "off", screen);
  assert.deepEqual(autoCheckPlan({ screen: "confirming", waiting: true, startedAt: t0, now: t0 + AUTO_CHECK.totalMs }), { mode: "paused", again: false });
  assert.equal(autoCheckPlan({ screen: "confirming", waiting: true, startedAt: null, now: t0 }).mode, "paused", "no start time: never an endless loop");
  // 40 reads per booking per 10 minutes on the server (DEFAULT_LIMITS.perToken); the controller may add 24 of its own in a 10-minute window
  const api = readFileSync(new URL("../lib/checkout/intent-api-http.js", import.meta.url), "utf8");
  assert.match(api, /perToken: Object\.freeze\(\[600, 40\]\)/);
  assert.ok((600_000 / AUTO_CHECK.intervalMs) <= 20);
  assert.match(WAIT_TEXT.auto, /email/); assert.match(WAIT_TEXT.paused, /check again/);
  const js = readFileSync(new URL("../public/checkout.js", import.meta.url), "utf8");
  assert.ok(js.includes('plan.mode === "auto" || SETTLED_SCREENS.includes(v.screen) || NO_REFRESH_SCREENS.includes(v.screen);'), "no Refresh button while checking, once settled, or before any payment");
  assert.ok(js.includes('NO_REFRESH_SCREENS = Object.freeze(["create", "details", "loading", "redirecting"])'));
  assert.ok(js.includes("if (ctl && !ctl.state.busy) ctl.refresh();"));
  assert.ok(js.includes("win.clearTimeout(autoTimer)"));
});

test("P7-2: the waiting picture is decorative, same-origin and still when the guest prefers reduced motion", () => {
  const html = readFileSync(new URL("../public/checkout.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../public/checkout.css", import.meta.url), "utf8");
  assert.match(html, /<div id="mv-wait" class="wait" aria-hidden="true" hidden>/);
  assert.match(html, /<span>Bucerías<\/span>/);
  const wait = html.slice(html.indexOf('id="mv-wait"'), html.indexOf('id="mv-polling"'));
  assert.doesNotMatch(wait, /style=|href=|<script|<image|url\(/i, "no inline style, link, script or external image (the page's CSP allows none)");
  assert.match(html, /style-src 'self'/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.wait-plane \{ animation: none;/);
  assert.match(css, /\.wait-plane \{[^}]*offset-path: path\("M24 70 Q160 -6 290 62"\)/);
});
