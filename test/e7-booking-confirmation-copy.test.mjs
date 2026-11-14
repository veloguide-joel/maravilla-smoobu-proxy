// Stage E7 guest notification — bilingual BOOKING-CONFIRMATION COPY foundation (bcc-v1, C36). PURE module tests: no database, no network
// (throwing guards installed BEFORE import), no clock, no environment, no transport. Facts are synthetic; no recipient / sender / contact data
// exists anywhere in this suite. NOT integrated with gn-v1 (request builder / worker / 0016 fence) — the gn-v1 suites assert that contract.
import https from "node:https";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

let netAttempts = 0;
const realFetch = globalThis.fetch, realReq = https.request, realAgent = https.Agent;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline bcc-v1 suite)"); };
https.request = () => { netAttempts += 1; throw new Error("https.request refused (offline bcc-v1 suite)"); };
https.Agent = function () { netAttempts += 1; throw new Error("https.Agent refused (offline bcc-v1 suite)"); };
after(() => { globalThis.fetch = realFetch; https.request = realReq; https.Agent = realAgent; assert.equal(netAttempts, 0, "no network attempt"); });

const mod = await import("../lib/checkout/booking-confirmation-copy.js");
const { COPY_CONTRACT_VERSION, BRAND, LOCALES, TEMPLATES, INPUT_KEYS, FACT_KEYS, COPY_KEYS, LIMITS, calendarDayMs, renderBookingConfirmation } = mod;
const { formatUsd } = await import("../lib/checkout/guest-notification.js");

const FACTS = Object.freeze({ ref: "MV-ABC123", checkIn: "2026-12-04", checkOut: "2026-12-06", nights: 2, guests: 2, totalMinor: 123456, currency: "USD" });
const input = (locale, over = {}, factsOver = {}) => ({ template: "booking_confirmed", locale, facts: { ...FACTS, ...factsOver }, ...over });
const render = (locale, factsOver = {}, over = {}) => renderBookingConfirmation(input(locale, over, factsOver));
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

const EN_SUBJECT = "Your maraVilla booking MV-ABC123 is confirmed";
const EN_TEXT = ["Your maraVilla booking MV-ABC123 is confirmed.", "Booking reference: MV-ABC123", "Check-in: 2026-12-04", "Check-out: 2026-12-06",
  "Nights: 2", "Guests: 2", "Payment received: $1,234.56 USD", "", "maraVilla"].join("\n");
const ES_SUBJECT = "Tu reservación de maraVilla MV-ABC123 está confirmada";
const ES_TEXT = ["Tu reservación de maraVilla MV-ABC123 está confirmada.", "Referencia de la reservación: MV-ABC123", "Llegada (check-in): 2026-12-04",
  "Salida (check-out): 2026-12-06", "Noches: 2", "Huéspedes: 2", "Pago recibido: $1,234.56 USD", "", "maraVilla"].join("\n");

// ---------------------------------------------------------------------------------------------
// contract surface

test("B1 contract constants: independent version bcc-v1, brand, explicit locales en|es, booking_confirmed only, exact key sets, frozen", () => {
  assert.equal(COPY_CONTRACT_VERSION, "bcc-v1");
  assert.notEqual(COPY_CONTRACT_VERSION, "gn-v1");
  assert.equal(BRAND, "maraVilla");
  assert.deepEqual([...LOCALES], ["en", "es"]);
  assert.deepEqual([...TEMPLATES], ["booking_confirmed"]);
  assert.deepEqual([...INPUT_KEYS], ["facts", "locale", "template"]);
  assert.deepEqual([...FACT_KEYS], ["checkIn", "checkOut", "currency", "guests", "nights", "ref", "totalMinor"]);
  assert.deepEqual([...COPY_KEYS], ["contractVersion", "locale", "subject", "template", "text"]);
  for (const o of [LOCALES, TEMPLATES, INPUT_KEYS, FACT_KEYS, COPY_KEYS, LIMITS]) assert.ok(Object.isFrozen(o));
  assert.deepEqual(Object.keys(mod).sort(), ["BRAND", "COPY_CONTRACT_VERSION", "COPY_KEYS", "FACT_KEYS", "INPUT_KEYS", "LIMITS", "LOCALES", "TEMPLATES", "calendarDayMs", "renderBookingConfirmation"]);
});

test("B2 English: exact subject and plain-text body for synthetic facts; frozen; only the five copy keys", () => {
  const r = render("en");
  assert.equal(r.ok, true);
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.copy));
  assert.deepEqual(Object.keys(r.copy).sort(), [...COPY_KEYS]);
  assert.deepEqual(r.copy, { contractVersion: "bcc-v1", template: "booking_confirmed", locale: "en", subject: EN_SUBJECT, text: EN_TEXT });
  assert.ok(r.copy.text.includes("Payment received: $1,234.56 USD"));
  assert.equal(formatUsd(FACTS.totalMinor), "$1,234.56 USD");
});

test("B3 Spanish (Mexico): exact subject and body with correct Unicode (ó, á, é), NFC, no mojibake", () => {
  const r = render("es");
  assert.equal(r.ok, true);
  assert.deepEqual(r.copy, { contractVersion: "bcc-v1", template: "booking_confirmed", locale: "es", subject: ES_SUBJECT, text: ES_TEXT });
  assert.equal(r.copy.subject, "Tu reservación de maraVilla MV-ABC123 está confirmada");
  assert.ok(r.copy.text.includes("Huéspedes: 2") && r.copy.text.includes("Pago recibido: $1,234.56 USD"));
  for (const s of [r.copy.subject, r.copy.text]) {
    assert.equal(s.normalize("NFC"), s);
    assert.ok(!/�|Ã/.test(s));
    assert.equal(Buffer.from(s, "utf8").toString("utf8"), s);
  }
  // literal source bytes are UTF-8 (no escapes needed at runtime) and the module declares no html
  const src = readFileSync(new URL("../lib/checkout/booking-confirmation-copy.js", import.meta.url), "utf8");
  assert.ok(src.includes("reservación") && src.includes("está confirmada") && src.includes("Huéspedes"));
});

test("B4 deterministic and frozen: equal input → byte-identical output across calls; input not mutated; subject/text hashes pinned", () => {
  const a = render("en"), b = render("en"), c = render("es"), d = render("es");
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(JSON.stringify(c), JSON.stringify(d));
  const i = input("es"); const snap = JSON.stringify(i); renderBookingConfirmation(i); assert.equal(JSON.stringify(i), snap);
  assert.equal(sha(a.copy.subject + "\n" + a.copy.text), sha(EN_SUBJECT + "\n" + EN_TEXT));
  assert.equal(sha(c.copy.subject + "\n" + c.copy.text), sha(ES_SUBJECT + "\n" + ES_TEXT));
  assert.throws(() => { "use strict"; a.copy.subject = "x"; }, TypeError);
});

test("B5 plain text only: no HTML, links, access instructions, policy or refund wording in either locale", () => {
  for (const loc of LOCALES) {
    const { subject, text } = render(loc).copy;
    for (const s of [subject, text]) {
      assert.ok(!/<[a-z!/]/i.test(s), "no html");
      assert.ok(!/https?:|www\.|mailto:/i.test(s), "no links");
      assert.ok(!/refund|reembolso|cancel|código|code|password|contraseña|lockbox|wifi|key|llave|policy|política/i.test(s), "no access/policy/refund wording");
      assert.ok(!/\r/.test(s) && !/[\u0000-\u0008\u000B-\u001F]/.test(s), "no control chars");
    }
    assert.ok(!subject.includes("\n"));
  }
});

// ---------------------------------------------------------------------------------------------
// refusals (code only — never echo input)

const codeOnly = (r, code) => { assert.deepEqual(r, { ok: false, code }); assert.ok(Object.isFrozen(r)); };

test("B6 input shape: non-object, missing/extra keys, unknown template, unknown locale (no guessing)", () => {
  for (const bad of [undefined, null, 1, "en", [], Object.create({ template: "booking_confirmed" })]) codeOnly(renderBookingConfirmation(bad), "INPUT_INVALID");
  codeOnly(renderBookingConfirmation({ template: "booking_confirmed", facts: FACTS }), "INPUT_INVALID");                 // locale missing → never guessed
  codeOnly(renderBookingConfirmation({ ...input("en"), guestName: "X" }), "INPUT_INVALID");                             // extra key (no contact data accepted)
  codeOnly(renderBookingConfirmation({ ...input("en"), html: true }), "INPUT_INVALID");
  for (const t of ["not_charged_authorization_may_show", "not_completed_not_charged", "booking_cancelled", "", null, "BOOKING_CONFIRMED"]) codeOnly(render("en", {}, { template: t }), "TEMPLATE_INVALID");
  for (const l of ["EN", "es-MX", "en-US", "fr", "", null, undefined, 0, ["en"]]) codeOnly(renderBookingConfirmation({ template: "booking_confirmed", locale: l, facts: { ...FACTS } }), "LOCALE_INVALID");
});

test("B7 facts shape: non-plain, missing field, extra field (e.g. guest email / firstName), array", () => {
  codeOnly(renderBookingConfirmation({ template: "booking_confirmed", locale: "en", facts: null }), "FACTS_SHAPE");
  codeOnly(renderBookingConfirmation({ template: "booking_confirmed", locale: "en", facts: [] }), "FACTS_SHAPE");
  for (const k of FACT_KEYS) { const f = { ...FACTS }; delete f[k]; codeOnly(renderBookingConfirmation({ template: "booking_confirmed", locale: "en", facts: f }), "FACTS_SHAPE"); }
  codeOnly(render("en", { email: "a@b.invalid" }), "FACTS_SHAPE");
  codeOnly(render("en", { firstName: "Synthia" }), "FACTS_SHAPE");
  codeOnly(render("en", { v: 1 }), "FACTS_SHAPE");                                                                       // gn-v1 facts envelope is NOT this contract
  codeOnly(render("en", { template: "booking_confirmed" }), "FACTS_SHAPE");
});

test("B8 ref grammar: MV- plus 6–10 upper alnum only", () => {
  for (const ref of ["MV-ABC12", "MV-ABCDEFGHIJK", "mv-abc123", "XX-ABC123", "MV-ABC 123", "MV-ABC123\n", 123, null, ""]) codeOnly(render("en", { ref }), "REF_INVALID");
  assert.equal(render("en", { ref: "MV-ZZZZZZZZZZ" }).ok, true);
});

test("B9 calendar dates: real ISO days only — Feb 29 leap/non-leap, Feb 30, Apr 31, month 13, day 0, non-ISO forms, year bounds", () => {
  assert.equal(calendarDayMs("2028-02-29"), Date.UTC(2028, 1, 29));                                                      // leap year
  assert.equal(calendarDayMs("2027-02-29"), null);                                                                       // not a leap year
  assert.equal(calendarDayMs("2100-02-29"), null);                                                                       // century rule
  assert.equal(calendarDayMs("2026-02-30"), null);
  assert.equal(calendarDayMs("2026-04-31"), null);
  assert.equal(calendarDayMs("2026-13-01"), null);
  assert.equal(calendarDayMs("2026-00-10"), null);
  assert.equal(calendarDayMs("2026-01-00"), null);
  for (const s of ["2026-1-04", "2026/12/04", "20261204", "2026-12-04T00:00:00Z", "2026-12-04 ", " 2026-12-04", "1999-12-31", "2200-01-01", "", null, 20261204, new Date("2026-12-04")]) assert.equal(calendarDayMs(s), null, String(s));
  codeOnly(render("en", { checkIn: "2027-02-29", checkOut: "2027-03-01", nights: 1 }), "DATE_INVALID");
  codeOnly(render("en", { checkOut: "2026-12-04T00:00:00Z" }), "DATE_INVALID");
  // leap day stay renders in both locales with the right night count
  const leap = render("es", { checkIn: "2028-02-28", checkOut: "2028-03-01", nights: 2 });
  assert.equal(leap.ok, true); assert.ok(leap.copy.text.includes("Noches: 2"));
  codeOnly(render("es", { checkIn: "2028-02-28", checkOut: "2028-03-01", nights: 1 }), "NIGHTS_MISMATCH");
});

test("B10 date order and nights: checkOut must follow checkIn; nights must equal the day difference; bounded 1..365; integers only", () => {
  codeOnly(render("en", { checkIn: "2026-12-06", checkOut: "2026-12-04" }), "DATE_ORDER_INVALID");
  codeOnly(render("en", { checkIn: "2026-12-04", checkOut: "2026-12-04", nights: 0 }), "DATE_ORDER_INVALID");
  codeOnly(render("en", { nights: 3 }), "NIGHTS_MISMATCH");
  codeOnly(render("en", { nights: 1 }), "NIGHTS_MISMATCH");
  codeOnly(render("en", { nights: "2" }), "NIGHTS_MISMATCH");
  codeOnly(render("en", { nights: 2.0000001 }), "NIGHTS_MISMATCH");
  codeOnly(render("en", { checkIn: "2026-01-01", checkOut: "2027-01-02", nights: 366 }), "NIGHTS_MISMATCH");            // over the bound
  assert.equal(render("en", { checkIn: "2026-01-01", checkOut: "2027-01-01", nights: 365 }).ok, true);
  // DST-free: UTC day arithmetic across a Mexican DST-era boundary month still counts whole days
  assert.equal(render("en", { checkIn: "2026-03-28", checkOut: "2026-04-05", nights: 8 }).ok, true);
});

test("B11 guests bounded positive integer", () => {
  for (const guests of [0, -1, 1.5, "2", null, LIMITS.maxGuests + 1, Number.MAX_SAFE_INTEGER + 1]) codeOnly(render("en", { guests }), "GUESTS_INVALID");
  assert.equal(render("en", { guests: LIMITS.maxGuests }).ok, true);
});

test("B12 money: USD only; positive safe integer minor units within ceiling; no floats/strings/NaN/negative/zero", () => {
  for (const currency of ["MXN", "usd", "EUR", "", null, undefined]) codeOnly(render("en", { currency }), "CURRENCY_NOT_SUPPORTED");
  for (const totalMinor of [0, -1, 1.5, 140.0 + 0.1, "14000", NaN, Infinity, 2 ** 53, LIMITS.maxTotalMinor + 1, null]) codeOnly(render("en", { totalMinor }), "AMOUNT_INVALID");
  const r = render("es", { totalMinor: 14000 });
  assert.equal(r.ok, true); assert.ok(r.copy.text.includes("Pago recibido: $140.00 USD"));
  assert.ok(render("en", { totalMinor: 1 }).copy.text.includes("Payment received: $0.01 USD"));
  assert.ok(render("en", { totalMinor: LIMITS.maxTotalMinor }).copy.text.includes("Payment received: $10,000,000.00 USD"));
});

test("B13 refusal order is validation order and never echoes input values", () => {
  const r = render("fr", { ref: "bad", totalMinor: -1 }, { template: "nope" });
  codeOnly(r, "TEMPLATE_INVALID");
  const r2 = render("en", { ref: "MV-ABC123", checkIn: "nope", totalMinor: -1 });
  codeOnly(r2, "DATE_INVALID");
  assert.ok(!JSON.stringify(r2).includes("nope"));
});

// ---------------------------------------------------------------------------------------------
// C37 (ROOT F1): descriptor-based exact shape — hidden / symbol keys, accessors, hostile traps; code-only, nothing invoked, nothing echoed

const SENTINEL = "sensitive-sentinel";
const noSentinel = (r) => assert.ok(!JSON.stringify(r).includes(SENTINEL) && !JSON.stringify(r).includes("sentinel"));

test("B16 hidden (non-enumerable) and symbol own keys are extra keys at BOTH levels → INPUT_INVALID / FACTS_SHAPE", () => {
  const outerHidden = input("en"); Object.defineProperty(outerHidden, "email", { value: SENTINEL, enumerable: false });
  codeOnly(renderBookingConfirmation(outerHidden), "INPUT_INVALID");
  const outerSym = input("en"); outerSym[Symbol("email")] = SENTINEL;
  codeOnly(renderBookingConfirmation(outerSym), "INPUT_INVALID");
  const fHidden = { ...FACTS }; Object.defineProperty(fHidden, "email", { value: SENTINEL, enumerable: false });
  codeOnly(renderBookingConfirmation({ template: "booking_confirmed", locale: "en", facts: fHidden }), "FACTS_SHAPE");
  const fSym = { ...FACTS }; fSym[Symbol("email")] = SENTINEL;
  codeOnly(renderBookingConfirmation({ template: "booking_confirmed", locale: "en", facts: fSym }), "FACTS_SHAPE");
  // a hidden key standing IN for a required key is still refused (own enumerable data fields only)
  const fHiddenReq = { ...FACTS }; delete fHiddenReq.ref; Object.defineProperty(fHiddenReq, "ref", { value: "MV-ABC123", enumerable: false });
  codeOnly(renderBookingConfirmation({ template: "booking_confirmed", locale: "en", facts: fHiddenReq }), "FACTS_SHAPE");
  // symbol replacing a required key keeps the count equal but the key missing
  const fSymReq = { ...FACTS }; delete fSymReq.ref; fSymReq[Symbol("ref")] = "MV-ABC123";
  codeOnly(renderBookingConfirmation({ template: "booking_confirmed", locale: "en", facts: fSymReq }), "FACTS_SHAPE");
});

test("B17 accessors are refused WITHOUT invocation at both levels (throwing and value-changing getters never run; counters stay 0)", () => {
  let calls = 0;
  const outer = { template: "booking_confirmed", facts: { ...FACTS } };
  Object.defineProperty(outer, "locale", { enumerable: true, get() { calls += 1; throw new Error(SENTINEL); } });
  const r1 = renderBookingConfirmation(outer); codeOnly(r1, "INPUT_INVALID"); noSentinel(r1);
  const f = { ...FACTS }; delete f.ref;
  Object.defineProperty(f, "ref", { enumerable: true, get() { calls += 1; throw new Error(SENTINEL); } });
  const r2 = renderBookingConfirmation({ template: "booking_confirmed", locale: "en", facts: f }); codeOnly(r2, "FACTS_SHAPE"); noSentinel(r2);
  let n = 0; const g = { ...FACTS }; delete g.nights;
  Object.defineProperty(g, "nights", { enumerable: true, get() { calls += 1; return (n += 1) === 1 ? 2 : 999; } });
  codeOnly(renderBookingConfirmation({ template: "booking_confirmed", locale: "es", facts: g }), "FACTS_SHAPE");
  const h = { ...FACTS }; delete h.totalMinor;
  Object.defineProperty(h, "totalMinor", { enumerable: true, get() { calls += 1; return 123456; }, set() {} });
  codeOnly(renderBookingConfirmation({ template: "booking_confirmed", locale: "es", facts: h }), "FACTS_SHAPE");
  assert.equal(calls, 0, "no accessor invoked");
  assert.equal(n, 0);
});

test("B18 hostile Proxy traps (ownKeys / getOwnPropertyDescriptor / getPrototypeOf) at both levels → code-only, no throw, no sentinel; [[Get]] never consulted", () => {
  const boom = () => { throw new Error(SENTINEL); };
  const traps = [{ ownKeys: boom }, { getOwnPropertyDescriptor: boom }, { getPrototypeOf: boom },
    { getOwnPropertyDescriptor: (t, k) => (k === "locale" ? { value: "en", enumerable: true, configurable: true, writable: true } : Reflect.getOwnPropertyDescriptor(t, k)), ownKeys: (t) => [...Reflect.ownKeys(t), "ghost"] }];
  for (const trap of traps) {
    const r1 = renderBookingConfirmation(new Proxy(input("en"), trap));
    assert.equal(r1.ok, false); assert.equal(r1.code, "INPUT_INVALID"); noSentinel(r1);
    const r2 = renderBookingConfirmation({ template: "booking_confirmed", locale: "en", facts: new Proxy({ ...FACTS }, trap) });
    assert.equal(r2.ok, false); assert.equal(r2.code, "FACTS_SHAPE"); noSentinel(r2);
  }
  // [[Get]] is never consulted: a throwing `get` trap cannot fire because values come from own data descriptors (both levels)
  let gets = 0; const getBoom = { get: () => { gets += 1; throw new Error(SENTINEL); } };
  assert.deepEqual(renderBookingConfirmation(new Proxy(input("en"), getBoom)), render("en"));
  assert.deepEqual(renderBookingConfirmation({ template: "booking_confirmed", locale: "es", facts: new Proxy({ ...FACTS }, getBoom) }), render("es"));
  assert.equal(gets, 0, "no [[Get]] on input objects");
  // a Proxy that lies about its prototype or hands out accessor descriptors is refused the same way
  const lie = new Proxy({ ...FACTS }, { getPrototypeOf: () => Array.prototype });
  codeOnly(renderBookingConfirmation({ template: "booking_confirmed", locale: "en", facts: lie }), "FACTS_SHAPE");
  const acc = new Proxy({ ...FACTS }, { getOwnPropertyDescriptor: (t, k) => ({ get: () => SENTINEL, enumerable: true, configurable: true }) });
  const r3 = renderBookingConfirmation({ template: "booking_confirmed", locale: "en", facts: acc }); codeOnly(r3, "FACTS_SHAPE"); noSentinel(r3);
});

test("B19 controls: frozen and null-prototype plain objects at both levels still render; transparent Proxy passes; values snapshotted once", () => {
  const frozen = Object.freeze({ template: "booking_confirmed", locale: "en", facts: Object.freeze({ ...FACTS }) });
  assert.deepEqual(renderBookingConfirmation(frozen), render("en"));
  const nullProtoFacts = Object.assign(Object.create(null), FACTS);
  const nullProto = Object.assign(Object.create(null), { template: "booking_confirmed", locale: "es", facts: nullProtoFacts });
  assert.deepEqual(renderBookingConfirmation(nullProto), render("es"));
  assert.deepEqual(renderBookingConfirmation(new Proxy(input("en"), {})), render("en"));
  // snapshot: a getter-free object mutated after the call does not affect the already-returned frozen copy
  const live = input("en"); const r = renderBookingConfirmation(live); live.facts.ref = "MV-ZZZZZZ"; live.locale = "es";
  assert.equal(r.copy.subject, EN_SUBJECT);
});

// ---------------------------------------------------------------------------------------------
// isolation: pure, no I/O, not wired into gn-v1 / worker / SQL

test("B14 module source: single pure import (formatUsd from guest-notification.js), no node: builtins, no I/O/clock/env/network surface; descriptor-based shape", () => {
  const src = readFileSync(new URL("../lib/checkout/booking-confirmation-copy.js", import.meta.url), "utf8");
  const imports = [...src.matchAll(/^import\s.*?from\s+"([^"]+)";?$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./guest-notification.js"]);
  const code = src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/node:|require\(|process\.|Date\.now|new Date\(\)|fetch|https?\.|pg|sql|SELECT|INSERT|sendMessage|fromAddress|to:|email|firstName|setTimeout/i.test(code), "no I/O / clock / env / contact surface in code");
  assert.ok(/Reflect\.ownKeys/.test(code) && /getOwnPropertyDescriptor/.test(code) && !/Object\.keys\((input|facts|obj)\)/.test(code), "descriptor-based exact-shape extraction");
});

test("B15 not integrated: gn-v1 builder/worker/fence do not import this module; gn-v1 constants unchanged", async () => {
  const roots = ["../lib/checkout/guest-notification.js", "../lib/booking-db/notification-worker.js", "../db/migrations/0016_guest_notification_fence.up.sql"];
  for (const p of roots) assert.ok(!readFileSync(new URL(p, import.meta.url), "utf8").includes("booking-confirmation-copy"), p);
  const gn = await import("../lib/checkout/guest-notification.js");
  assert.equal(gn.TEMPLATE_VERSION, "gn-v1");
  assert.deepEqual([...gn.TEMPLATES], ["booking_confirmed", "not_charged_authorization_may_show", "not_completed_not_charged"]);
  // gn-v1 English booking_confirmed copy differs from bcc-v1 (different contract; gn-v1 hash vectors are asserted in the gn-v1 suite)
  const req = gn.buildMessageRequest({ template: "booking_confirmed", facts: { v: 1, template: "booking_confirmed", ...FACTS },
    guest: { email: "guest.v@mv-test.invalid", firstName: "Synthia" }, sender: { fromAddress: "bookings@sender.mv-test.invalid", fromName: "maraVilla Test" }, opId: "00000000-0000-4000-8000-000000000001" });
  assert.equal(req.ok, true);
  assert.equal(req.request.subject, EN_SUBJECT);                                                                         // same subject line by product choice
  assert.notEqual(req.request.text, EN_TEXT);                                                                            // different body contract
  assert.equal(req.request.templateVersion, "gn-v1");
});
