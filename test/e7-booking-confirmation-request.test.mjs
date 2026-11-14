// Stage E7 guest notification — BOOKING-CONFIRMATION REQUEST BINDING "gn-v2" (C40). PURE module tests: no database, no network (throwing
// guards installed BEFORE import), no clock, no environment, no transport. Every address is a synthetic `.invalid` test address; nothing here
// prints a recipient, name, subject, body or error detail. NOT integrated: the gn-v1 builder / worker / 0016 fence are asserted unchanged.
import https from "node:https";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

let netAttempts = 0;
const realFetch = globalThis.fetch, realReq = https.request, realAgent = https.Agent;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline gn-v2 suite)"); };
https.request = () => { netAttempts += 1; throw new Error("https.request refused (offline gn-v2 suite)"); };
https.Agent = function () { netAttempts += 1; throw new Error("https.Agent refused (offline gn-v2 suite)"); };
after(() => { globalThis.fetch = realFetch; https.request = realReq; https.Agent = realAgent; assert.equal(netAttempts, 0, "no network attempt"); });

const mod = await import("../lib/checkout/booking-confirmation-request.js");
const { REQUEST_VERSION, CONTENT_HASH_PREFIX, MESSAGE_REF_PREFIX, INPUT_KEYS, GUEST_KEYS, SENDER_KEYS, REQUEST_KEYS_V2, TEMPLATES, LOCALES, COPY_CONTRACT_VERSION,
  contentHashV2, buildBookingConfirmationRequest: build } = mod;
const gn = await import("../lib/checkout/guest-notification.js");
const { renderBookingConfirmation } = await import("../lib/checkout/booking-confirmation-copy.js");

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const OP = "00000000-0000-4000-8000-000000000001";
const FACTS = Object.freeze({ ref: "MV-ABC123", checkIn: "2026-12-04", checkOut: "2026-12-06", nights: 2, guests: 2, totalMinor: 123456, currency: "USD" });
const GUEST = Object.freeze({ email: "guest.v@mv-test.invalid", firstName: "Synthia" });
const SENDER = Object.freeze({ fromAddress: "bookings@sender.mv-test.invalid", fromName: "maraVilla Test" });
const input = (locale = "en", over = {}) => ({ template: "booking_confirmed", locale, facts: { ...FACTS }, guest: { ...GUEST }, sender: { ...SENDER }, opId: OP, ...over });
const codeOnly = (r, code) => { assert.deepEqual(r, { ok: false, code }); assert.ok(Object.isFrozen(r)); };
const SENTINEL = "sensitive-sentinel";
const noSentinel = (r) => assert.ok(!JSON.stringify(r).includes("sentinel"));

const EN_SUBJECT = "Your maraVilla booking MV-ABC123 is confirmed";
const EN_TEXT = ["Your maraVilla booking MV-ABC123 is confirmed.", "Booking reference: MV-ABC123", "Check-in: 2026-12-04", "Check-out: 2026-12-06",
  "Nights: 2", "Guests: 2", "Payment received: $1,234.56 USD", "", "maraVilla"].join("\n");
const ES_SUBJECT = "Tu reservación de maraVilla MV-ABC123 está confirmada";
const ES_TEXT = ["Tu reservación de maraVilla MV-ABC123 está confirmada.", "Referencia de la reservación: MV-ABC123", "Llegada (check-in): 2026-12-04",
  "Salida (check-out): 2026-12-06", "Noches: 2", "Huéspedes: 2", "Pago recibido: $1,234.56 USD", "", "maraVilla"].join("\n");
const expected = (locale, subject, text) => ({ channel: "email", copyContractVersion: "bcc-v1", from: SENDER.fromAddress, fromName: SENDER.fromName, locale,
  messageRef: `gn2-${OP}`, subject, template: "booking_confirmed", templateVersion: "gn-v2", text, to: GUEST.email });
// independently derived canonical form (hand-written, NOT the module's canonical()) + pinned vectors
const manualCanonical = (r) => `{${Object.keys(r).sort().map((k) => `${JSON.stringify(k)}:${JSON.stringify(r[k])}`).join(",")}}`;
const VEC = Object.freeze({ en: "ce560719d5e19ff6c5d5c04f9fb83684822719264380de69d011fcc87a100cc7", es: "51252563b1fe89f8d71fcd2f5266d467b7adfec40e1cae9ad2dfaef7878f842f",
  recipient: "806b832b52e66b4f53e2c03620d2ab98c55d7515c13d8ecb32124bcfbd985f1d" });

// ---------------------------------------------------------------------------------------------
// contract surface + exact output

test("R1 contract constants: gn-v2 request version over bcc-v1 copy; exact key sets; 11 request keys = gn-v1 nine + locale + copyContractVersion; frozen", () => {
  assert.equal(REQUEST_VERSION, "gn-v2");
  assert.equal(CONTENT_HASH_PREFIX, "gn-v2-content\n");
  assert.equal(MESSAGE_REF_PREFIX, "gn2-");
  assert.equal(COPY_CONTRACT_VERSION, "bcc-v1");
  assert.deepEqual([...TEMPLATES], ["booking_confirmed"]);
  assert.deepEqual([...LOCALES], ["en", "es"]);
  assert.deepEqual([...INPUT_KEYS], ["facts", "guest", "locale", "opId", "sender", "template"]);
  assert.deepEqual([...GUEST_KEYS], ["email", "firstName"]);
  assert.deepEqual([...SENDER_KEYS], ["fromAddress", "fromName"]);
  assert.deepEqual([...REQUEST_KEYS_V2], ["channel", "copyContractVersion", "from", "fromName", "locale", "messageRef", "subject", "template", "templateVersion", "text", "to"]);
  assert.deepEqual([...REQUEST_KEYS_V2].filter((k) => !["copyContractVersion", "locale"].includes(k)), [...gn.REQUEST_KEYS].sort());
  for (const o of [INPUT_KEYS, GUEST_KEYS, SENDER_KEYS, REQUEST_KEYS_V2]) assert.ok(Object.isFrozen(o));
  assert.deepEqual(Object.keys(mod).sort(), ["CONTENT_HASH_PREFIX", "COPY_CONTRACT_VERSION", "GUEST_KEYS", "INPUT_KEYS", "LOCALES", "MESSAGE_REF_PREFIX", "REQUEST_KEYS_V2",
    "REQUEST_VERSION", "SENDER_KEYS", "TEMPLATES", "buildBookingConfirmationRequest", "contentHashV2"]);
});

test("R2 English: exact 11-field request, deep-frozen; independently derived and pinned content hash; recipient hash = unchanged gn-v1 helper", () => {
  const r = build(input("en"));
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r).sort(), ["contentHash", "ok", "recipientHash", "request"]);
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.request));
  assert.deepEqual(r.request, expected("en", EN_SUBJECT, EN_TEXT));
  assert.deepEqual(Object.keys(r.request).sort(), [...REQUEST_KEYS_V2]);
  assert.equal(r.contentHash, sha(`gn-v2-content\n${manualCanonical(expected("en", EN_SUBJECT, EN_TEXT))}`));
  assert.equal(r.contentHash, VEC.en);
  assert.equal(r.recipientHash, sha(`gn-v1-recipient\n${GUEST.email}\n${GUEST.firstName}`));
  assert.equal(r.recipientHash, VEC.recipient);
  assert.equal(r.recipientHash, gn.recipientHash(GUEST.email, GUEST.firstName));
  // subject / text are exactly the accepted bcc-v1 renderer output (no duplicated or altered copy, no greeting)
  const c = renderBookingConfirmation({ template: "booking_confirmed", locale: "en", facts: { ...FACTS } }).copy;
  assert.equal(r.request.subject, c.subject); assert.equal(r.request.text, c.text);
  assert.ok(!r.request.text.includes(GUEST.firstName), "firstName is not rendered (no greeting)");
});

test("R3 Spanish (Mexico): exact request with correct Unicode; independently derived and pinned content hash", () => {
  const r = build(input("es"));
  assert.equal(r.ok, true);
  assert.deepEqual(r.request, expected("es", ES_SUBJECT, ES_TEXT));
  assert.equal(r.contentHash, sha(`gn-v2-content\n${manualCanonical(expected("es", ES_SUBJECT, ES_TEXT))}`));
  assert.equal(r.contentHash, VEC.es);
  assert.equal(r.recipientHash, VEC.recipient);
  assert.notEqual(VEC.en, VEC.es);
  for (const s of [r.request.subject, r.request.text]) assert.equal(s.normalize("NFC"), s);
});

// ---------------------------------------------------------------------------------------------
// hash binding

test("R4 contentHash binds all 11 fields (locale, copy version, template, version, messageRef, from, fromName, to, subject, text, channel)", () => {
  const base = build(input("en")).request;
  const h0 = contentHashV2(base);
  for (const k of REQUEST_KEYS_V2) {
    const changed = { ...base, [k]: `${base[k]}x` };
    assert.notEqual(contentHashV2(changed), h0, `${k} is bound`);
  }
  assert.equal(contentHashV2({ ...base }), h0);
  // the gn-v1 prefix over the same canonical JSON gives a different hash (versioned domain separation)
  assert.notEqual(sha(`gn-v1-content\n${gn.canonical(base)}`), h0);
});

test("R5 distinct op / locale / recipient / sender changes are bound; firstName binds the recipient hash only (it is not in the copy)", () => {
  const h = (over) => build(input(over.locale ?? "en", over.rest ?? {}));
  const b = h({});
  const variants = {
    op: h({ rest: { opId: "00000000-0000-4000-8000-000000000002" } }),
    locale: h({ locale: "es" }),
    recipient: h({ rest: { guest: { ...GUEST, email: "guest.w@mv-test.invalid" } } }),
    fromAddress: h({ rest: { sender: { ...SENDER, fromAddress: "other@sender.mv-test.invalid" } } }),
    fromName: h({ rest: { sender: { ...SENDER, fromName: "maraVilla Ops" } } }),
    facts: h({ rest: { facts: { ...FACTS, guests: 3 } } }),
  };
  for (const [k, v] of Object.entries(variants)) { assert.equal(v.ok, true, k); assert.notEqual(v.contentHash, b.contentHash, k); }
  assert.equal(variants.op.request.messageRef, "gn2-00000000-0000-4000-8000-000000000002");
  assert.notEqual(variants.recipient.recipientHash, b.recipientHash);
  const fn = h({ rest: { guest: { ...GUEST, firstName: "Otra" } } });
  assert.equal(fn.contentHash, b.contentHash, "firstName is not part of the content");
  assert.notEqual(fn.recipientHash, b.recipientHash, "firstName binds the recipient hash");
});

test("R6 insertion order does not matter: reordered input / facts / guest / sender give byte-identical output", () => {
  const a = build(input("es"));
  const rev = (o) => Object.fromEntries(Object.entries(o).reverse());
  const b = build(rev({ ...input("es"), facts: rev({ ...FACTS }), guest: rev({ ...GUEST }), sender: rev({ ...SENDER }) }));
  assert.equal(JSON.stringify(b), JSON.stringify(a));
  assert.equal(b.contentHash, a.contentHash);
});

test("R7 frozen snapshot: caller mutation after the call changes nothing; input never mutated; output immutable", () => {
  const i = input("en"); const snap = JSON.stringify(i);
  const r = build(i);
  assert.equal(JSON.stringify(i), snap, "input not mutated");
  i.guest.email = "changed@mv-test.invalid"; i.sender.fromName = "Changed"; i.facts.ref = "MV-ZZZZZZ"; i.locale = "es"; i.opId = "00000000-0000-4000-8000-000000000009";
  assert.deepEqual(r.request, expected("en", EN_SUBJECT, EN_TEXT));
  assert.equal(r.contentHash, VEC.en);
  assert.throws(() => { "use strict"; r.request.to = "x@mv-test.invalid"; }, TypeError);
  assert.throws(() => { "use strict"; r.contentHash = "0".repeat(64); }, TypeError);
});

// ---------------------------------------------------------------------------------------------
// refusals (code only)

test("R8 caller cannot supply hash / version / messageRef / request / routing fields: any extra outer key → INPUT_INVALID", () => {
  for (const k of ["contentHash", "recipientHash", "templateVersion", "copyContractVersion", "messageRef", "request", "to", "from", "cc", "bcc", "replyTo", "html", "subject", "text"]) {
    codeOnly(build({ ...input("en"), [k]: "x" }), "INPUT_INVALID");
  }
  for (const k of INPUT_KEYS) { const i = input("en"); delete i[k]; codeOnly(build(i), "INPUT_INVALID"); }
  for (const bad of [undefined, null, 1, "x", [], Object.create({ template: "booking_confirmed" })]) codeOnly(build(bad), "INPUT_INVALID");
  // extra guest / sender keys (cc, bcc, replyTo, html, override address) are refused at their own boundary
  for (const k of ["cc", "bcc", "replyTo", "to", "html", "lastName"]) codeOnly(build(input("en", { guest: { ...GUEST, [k]: "a@mv-test.invalid" } })), "RECIPIENT_INVALID");
  for (const k of ["replyTo", "cc", "bcc", "to", "html"]) codeOnly(build(input("en", { sender: { ...SENDER, [k]: "a@mv-test.invalid" } })), "SENDER_INVALID");
});

test("R9 template / locale / facts are validated by the accepted bcc-v1 renderer: unknown template / locale, SQL v:1 envelope, invalid facts", () => {
  for (const t of ["not_charged_authorization_may_show", "not_completed_not_charged", "BOOKING_CONFIRMED", "", null]) codeOnly(build(input("en", { template: t })), "TEMPLATE_INVALID");
  for (const l of ["EN", "es-MX", "fr", "", null, undefined]) codeOnly(build(input("en", { locale: l })), "LOCALE_INVALID");
  codeOnly(build(input("en", { facts: { v: 1, template: "booking_confirmed", ...FACTS } })), "FACTS_SHAPE");   // SQL envelope is NOT this contract
  codeOnly(build(input("en", { facts: { ...FACTS, nights: 3 } })), "NIGHTS_MISMATCH");
  codeOnly(build(input("en", { facts: { ...FACTS, currency: "MXN" } })), "CURRENCY_NOT_SUPPORTED");
  codeOnly(build(input("en", { facts: { ...FACTS, totalMinor: 0 } })), "AMOUNT_INVALID");
  codeOnly(build(input("en", { facts: { ...FACTS, checkIn: "2027-02-29", checkOut: "2027-03-01", nights: 1 } })), "DATE_INVALID");
});

test("R10 recipient stays in the existing .invalid scope and bounds (no relaxation); firstName validated (control chars, <, >, length)", () => {
  for (const email of ["guest@gmail.com", "guest@example.com", "Guest.V@mv-test.invalid", "guest@mv-test.INVALID", "a b@mv-test.invalid", `${"a".repeat(65)}@x.invalid`,
    `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.invalid`, "", null, 1]) {
    codeOnly(build(input("en", { guest: { ...GUEST, email } })), "RECIPIENT_INVALID");
  }
  for (const firstName of ["", "a\u0000b", "a\nb", "a\u007fb", "<b>", "a>b", "x".repeat(101), null, 7]) codeOnly(build(input("en", { guest: { ...GUEST, firstName } })), "RECIPIENT_INVALID");
  for (const guest of [null, [], "guest.v@mv-test.invalid", { email: GUEST.email }]) codeOnly(build(input("en", { guest })), "RECIPIENT_INVALID");
  assert.equal(build(input("en", { guest: { ...GUEST, firstName: "Síñtia O'Neil-Ávila" } })).ok, true, "accented names are allowed (existing NAME_RE)");
});

test("R11 sender stays in the existing .invalid scope and SENDER_NAME_RE; exact key set", () => {
  for (const fromAddress of ["bookings@maravillanayarit.com", "Bookings@sender.mv-test.invalid", "", null]) codeOnly(build(input("en", { sender: { ...SENDER, fromAddress } })), "SENDER_INVALID");
  for (const fromName of ["", "maraVilla\nTest", "maraVilla <x>", "maraVilla Á", "x".repeat(65), null]) codeOnly(build(input("en", { sender: { ...SENDER, fromName } })), "SENDER_INVALID");
  for (const sender of [null, [], { fromAddress: SENDER.fromAddress }]) codeOnly(build(input("en", { sender })), "SENDER_INVALID");
});

test("R12 opId: lowercase canonical UUID only; checked before rendering; refusal order is INPUT → OP_ID → renderer → RECIPIENT → SENDER", () => {
  for (const opId of ["00000000-0000-4000-8000-00000000000G", "00000000-0000-4000-8000-0000000000A1", "00000000000040008000000000000001", "", null, 1, ` ${OP}`, `${OP}\n`]) {
    codeOnly(build(input("en", { opId })), "OP_ID_INVALID");
  }
  const all = { opId: "nope", template: "nope", guest: null, sender: null };
  codeOnly(build(input("en", all)), "OP_ID_INVALID");
  codeOnly(build(input("en", { ...all, opId: OP })), "TEMPLATE_INVALID");
  codeOnly(build(input("en", { guest: null, sender: null })), "RECIPIENT_INVALID");
  codeOnly(build(input("en", { sender: null })), "SENDER_INVALID");
  assert.ok(!JSON.stringify(build(input("en", { guest: { ...GUEST, email: "leak@gmail.com" } }))).includes("leak"));
});

// ---------------------------------------------------------------------------------------------
// descriptor discipline at every boundary (outer / facts / guest / sender)

const LEVELS = Object.freeze({ outer: "INPUT_INVALID", facts: "FACTS_SHAPE", guest: "RECIPIENT_INVALID", sender: "SENDER_INVALID" });
const BASE = Object.freeze({ facts: FACTS, guest: GUEST, sender: SENDER });
/** build the whole input with `fn` applied to the object at `level` */
const at = (level, fn) => {
  if (level === "outer") return fn(input("en"));
  return { ...input("en"), [level]: fn({ ...BASE[level] }) };
};

test("R13 hidden (non-enumerable) and symbol extras at every boundary → that boundary's code", () => {
  for (const [level, code] of Object.entries(LEVELS)) {
    codeOnly(build(at(level, (o) => Object.defineProperty(o, "cc", { value: SENTINEL, enumerable: false }))), code);
    codeOnly(build(at(level, (o) => { o[Symbol("bcc")] = SENTINEL; return o; })), code);
  }
});

test("R14 accessors at every boundary are refused WITHOUT invocation (throwing and value-changing getters; counter 0), no sentinel", () => {
  let calls = 0;
  const required = { outer: "opId", facts: "ref", guest: "email", sender: "fromAddress" };
  for (const [level, code] of Object.entries(LEVELS)) {
    const k = required[level];
    const r1 = build(at(level, (o) => { delete o[k]; return Object.defineProperty(o, k, { enumerable: true, configurable: true, get() { calls += 1; throw new Error(SENTINEL); } }); }));
    codeOnly(r1, code); noSentinel(r1);
    let n = 0; const good = level === "outer" ? OP : BASE[level][k];
    const r2 = build(at(level, (o) => { delete o[k]; return Object.defineProperty(o, k, { enumerable: true, get() { calls += 1; return (n += 1) === 1 ? good : SENTINEL; } }); }));
    codeOnly(r2, code); noSentinel(r2);
  }
  assert.equal(calls, 0, "no accessor invoked at any boundary");
});

test("R15 hostile Proxy traps and same-length key substitutions at every boundary → code-only, no throw, no sentinel; [[Get]] never consulted", () => {
  const boom = () => { throw new Error(SENTINEL); };
  const drop = { outer: "sender", facts: "ref", guest: "email", sender: "fromAddress" };
  for (const [level, code] of Object.entries(LEVELS)) {
    for (const trap of [{ ownKeys: boom }, { getOwnPropertyDescriptor: boom }, { getPrototypeOf: boom }, { getPrototypeOf: () => Array.prototype },
      { getOwnPropertyDescriptor: () => ({ get: () => SENTINEL, enumerable: true, configurable: true }) }]) {
      const r = build(at(level, (o) => new Proxy(o, trap)));
      codeOnly(r, code); noSentinel(r);
    }
    for (const add of ["email_override", Symbol("extra")]) {
      const r = build(at(level, (o) => new Proxy(o, { ownKeys: (t) => Reflect.ownKeys(t).filter((k) => k !== drop[level]).concat([add]) })));
      codeOnly(r, code);
    }
    codeOnly(build(at(level, (o) => new Proxy(o, { ownKeys: (t) => { const ks = Reflect.ownKeys(t); return [...ks.slice(0, -1), ks[0]]; } }))), code);   // duplicate approved key
  }
  let gets = 0;
  const getBoom = { get: () => { gets += 1; throw new Error(SENTINEL); } };
  const viaProxies = { ...input("es"), facts: new Proxy({ ...FACTS }, getBoom), guest: new Proxy({ ...GUEST }, getBoom), sender: new Proxy({ ...SENDER }, getBoom) };
  assert.deepEqual(build(new Proxy(viaProxies, getBoom)), build(input("es")));
  assert.equal(gets, 0, "no [[Get]] on any input object");
});

test("R16 controls: frozen, null-prototype and transparent-Proxy objects at every boundary build identically", () => {
  const ref = build(input("en"));
  const deepFrozen = Object.freeze({ ...input("en"), facts: Object.freeze({ ...FACTS }), guest: Object.freeze({ ...GUEST }), sender: Object.freeze({ ...SENDER }) });
  assert.deepEqual(build(deepFrozen), ref);
  const np = (o) => Object.assign(Object.create(null), o);
  assert.deepEqual(build(np({ ...input("en"), facts: np(FACTS), guest: np(GUEST), sender: np(SENDER) })), ref);
  assert.deepEqual(build(new Proxy({ ...input("en"), facts: new Proxy({ ...FACTS }, {}), guest: new Proxy({ ...GUEST }, {}), sender: new Proxy({ ...SENDER }, {}) }, {})), ref);
});

// ---------------------------------------------------------------------------------------------
// isolation: pure, no duplicated copy, not integrated

test("R17 module source: imports only node:crypto + the two accepted pure modules; no I/O / clock / env / network / DB / transport surface; no duplicated copy", () => {
  const src = readFileSync(new URL("../lib/checkout/booking-confirmation-request.js", import.meta.url), "utf8");
  const imports = [...src.matchAll(/^import\s[\s\S]*?from\s+"([^"]+)";?$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["node:crypto", "./guest-notification.js", "./booking-confirmation-copy.js"]);
  const code = src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/require\(|process\.|Date\.now|new Date|fetch|https?\.|\bpg\b|SELECT|INSERT|sendMessage|setTimeout|console\./.test(code), "no I/O / clock / env surface");
  assert.ok(!/Payment received|Pago recibido|Hello|Hola|is confirmed|confirmada|maraVilla/.test(code), "no copy text: subject / text come only from the bcc-v1 renderer");
  assert.ok(/Reflect\.ownKeys/.test(code) && /getOwnPropertyDescriptor/.test(code) && !/Object\.keys\(/.test(code), "descriptor-based exact-shape extraction");
});

test("R18 integration boundary (C41): ONLY the notification worker imports the builder (opt-in path); operations / 0016 / other migrations do not name gn-v2; only 0022 admits it; 0016 still gn-v1-only; gn-v1 builder + vectors unchanged", async () => {
  const worker = readFileSync(new URL("../lib/booking-db/notification-worker.js", import.meta.url), "utf8");
  assert.equal([...worker.matchAll(/from "\.\.\/checkout\/booking-confirmation-request\.js"/g)].length, 1, "the worker imports the gn-v2 builder exactly once");
  assert.ok(/buildBookingConfirmationRequest\(/.test(worker) && /claim_guest_notification_v2\(/.test(worker), "the opt-in path uses the builder and the dedicated v2 claim");
  for (const p of ["../lib/booking-db/operations.js", "../lib/checkout/guest-notification.js", "../lib/checkout/booking-confirmation-copy.js",
    "../db/migrations/0016_guest_notification_fence.up.sql"]) {
    const s = readFileSync(new URL(p, import.meta.url), "utf8");
    assert.ok(!s.includes("booking-confirmation-request") && !s.includes("gn-v2"), p);
  }
  const naming = readdirSync(new URL("../db/migrations/", import.meta.url)).filter((f) => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), "utf8").includes("gn-v2"));
  assert.deepEqual(naming.sort(), ["0022_gn_v2_booking_confirmation.down.sql", "0022_gn_v2_booking_confirmation.up.sql"], "only 0022 names gn-v2");
  const fence = readFileSync(new URL("../db/migrations/0016_guest_notification_fence.up.sql", import.meta.url), "utf8");
  assert.ok(fence.includes("CHECK (template_version = 'gn-v1')") && fence.includes("p_template_version IS DISTINCT FROM 'gn-v1'"), "0016 text unchanged: its six-argument claim refuses any other version");
  assert.equal(gn.TEMPLATE_VERSION, "gn-v1");
  const v1 = gn.buildMessageRequest({ template: "booking_confirmed", facts: { v: 1, template: "booking_confirmed", ...FACTS }, guest: { ...GUEST }, sender: { ...SENDER }, opId: OP });
  assert.equal(v1.ok, true);
  assert.equal(v1.request.templateVersion, "gn-v1");
  assert.equal(v1.request.messageRef, `gn1-${OP}`);
  assert.equal(gn.contentHash(v1.request), "32613d05e796b6a00cf7003bec3685a6f68ee167cdaaee5ad5824e96cc71d4d2", "gn-v1 booking_confirmed vector unchanged");
  assert.notEqual(gn.contentHash(v1.request), VEC.en);
});
