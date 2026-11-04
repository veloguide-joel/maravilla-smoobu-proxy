// E7 connected-test runner SLICE A — manifest v1 validation + canonical hash (OFFLINE unit tests; no DB, no network, synthetic only).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { validateRunManifest, canonicalJson, manifestHash, HASH_PREFIX, RUN_MANIFEST_VERSION, TOP_KEYS, OWNER_KEYS, REFUSAL_PRECEDENCE, MAX_AMOUNT_MINOR,
  MAX_NIGHTS, isRealDate } from "../scripts/e7-connected/run-manifest.mjs";
import { MAX_RATE_BPS } from "../lib/direct-pricing.js";
import { readDirectPolicyFromEnv, DIRECT_RATE_ENV } from "../lib/direct-policy.js";
import { isRealDate as adapterIsRealDate } from "../lib/hostaway-reservations.js";
import { MAX_AMOUNT_MINOR as STRIPE_MAX_AMOUNT } from "../lib/checkout/stripe-test-mode.js";
import { MAX_NIGHTS as FINAL_PRICE_MAX_NIGHTS } from "../lib/checkout/final-price.js";

let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline manifest suite)"); };
after(() => { globalThis.fetch = realFetch; assert.equal(netAttempts, 0, "no network attempt"); });

/** a VALID synthetic manifest (every value synthetic; no owner value is implied) */
const valid = (over = {}) => ({
  version: "e7-run-manifest-v1", runId: "synthetic-run-0001", intentId: "00000000-0000-4000-8000-0000000000c1", baselineCommit: "0".repeat(40),
  synthetic: true, providerMode: { hostaway: "fake", stripe: "mock" },
  listing: { id: 891001, currency: "USD", refFieldId: 777009, timeZone: "America/Mazatlan" },
  expectedRef: "MV-SYNTH01", stay: { arrival: "2026-12-04", departure: "2026-12-06", guests: 2 }, amountMinor: 50000, pricing: { rateBps: 1000 },
  stripeAccountId: "acct_1SyntheticRunner", hostawayAccountLabel: { accountRef: "acct-test-1", clientSnapshotId: "client-RUN" },
  phases: { capture: true, recording: true }, paymentMethod: "credit_card",
  cleanup: { reservedNotConfirmed: "synthetic/cleanup-reserved", captured: "synthetic/cleanup-captured", confirmed: "synthetic/cleanup-confirmed" },
  automationsReviewed: "synthetic/automations", checkpoints: ["CALENDAR_BASELINE", "AIRBNB_BLOCKED", "AIRBNB_REOPENED"], ...over
});
const code = (m) => validateRunManifest(m).code;
const without = (k) => { const m = valid(); delete m[k]; return m; };
const nest = (k, over) => valid({ [k]: { ...valid()[k], ...over } });
/** independent canonical form (test-local implementation over a plain clone) */
const indep = (v) => (Array.isArray(v) ? `[${v.map(indep).join(",")}]` : v && typeof v === "object"
  ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${indep(v[k])}`).join(",")}}` : JSON.stringify(v));
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

test("valid synthetic control: frozen result; the VALIDATED frozen copy is exactly what is hashed (independent recomputation, literal prefix)", () => {
  const r = validateRunManifest(valid());
  assert.equal(r.ok, true, r.code);
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.manifest) && Object.isFrozen(r.manifest.listing) && Object.isFrozen(r.manifest.checkpoints));
  assert.match(r.hash, /^[0-9a-f]{64}$/);
  assert.equal(HASH_PREFIX, "e7-run-manifest-v1\n");
  assert.equal(r.hash, sha(`e7-run-manifest-v1\n${indep(valid())}`), "hash = sha256(literal prefix + canonical JSON) of the validated data");
  assert.notEqual(r.hash, sha(indep(valid())), "the version prefix is part of the hash");
  assert.equal(canonicalJson(r.manifest), indep(valid()));
  assert.equal(manifestHash(r.manifest), r.hash);
  assert.deepEqual(JSON.parse(canonicalJson(r.manifest)), valid(), "validated copy = input data");
  assert.deepEqual([...TOP_KEYS].sort(), Object.keys(valid()).sort());
  // explicit-null paymentMethod path (no recording), capture-only and reservation-only scopes
  assert.equal(validateRunManifest(valid({ phases: { capture: true, recording: false }, paymentMethod: null })).ok, true);
  assert.equal(validateRunManifest(valid({ phases: { capture: false, recording: false }, paymentMethod: null })).ok, true);
  assert.equal(validateRunManifest(valid({ paymentMethod: "other" })).ok, true);
});

test("null-prototype objects and frozen values are accepted and hash identically", () => {
  const nul = (o) => Object.assign(Object.create(null), o);
  const v = valid();
  const n = nul({ ...v, providerMode: nul(v.providerMode), listing: nul(v.listing), stay: nul(v.stay), pricing: nul(v.pricing), hostawayAccountLabel: nul(v.hostawayAccountLabel),
    phases: nul(v.phases), cleanup: nul(v.cleanup), checkpoints: Object.freeze([...v.checkpoints]) });
  const deepFreeze = (o) => { for (const x of Object.values(o)) if (x && typeof x === "object") deepFreeze(x); return Object.freeze(o); };
  const a = validateRunManifest(n); const b = validateRunManifest(deepFreeze(valid()));
  assert.equal(a.ok, true, a.code); assert.equal(b.ok, true, b.code);
  assert.equal(a.hash, validateRunManifest(valid()).hash); assert.equal(b.hash, a.hash);
});

test("key order never changes the hash; every semantic change does", () => {
  const base = validateRunManifest(valid()).hash;
  const reversed = Object.fromEntries(Object.entries(valid()).reverse().map(([k, v]) => [k, v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v]));
  assert.equal(validateRunManifest(reversed).hash, base);
  const changes = [{ runId: "synthetic-run-0002" }, { intentId: "00000000-0000-4000-8000-0000000000c2" }, { baselineCommit: "1".repeat(40) }, { expectedRef: "MV-SYNTH02" },
    { amountMinor: 50001 }, { pricing: { rateBps: 1001 } }, { stripeAccountId: "acct_1Other" }, { paymentMethod: "other" },
    { phases: { capture: true, recording: false }, paymentMethod: null }, { automationsReviewed: "synthetic/automations-2" }];
  const nested = [["listing", { id: 891002 }], ["listing", { refFieldId: 777010 }], ["listing", { timeZone: "America/Mexico_City" }], ["stay", { guests: 3 }],
    ["stay", { departure: "2026-12-07" }], ["hostawayAccountLabel", { clientSnapshotId: "client-RUN2" }], ["cleanup", { captured: "synthetic/other" }]];
  const hashes = new Set([base]);
  for (const c of changes) { const r = validateRunManifest(valid(c)); assert.equal(r.ok, true, `${JSON.stringify(c)} ${r.code}`); hashes.add(r.hash); }
  for (const [k, o] of nested) { const r = validateRunManifest(nest(k, o)); assert.equal(r.ok, true, `${k} ${r.code}`); hashes.add(r.hash); }
  assert.equal(hashes.size, 1 + changes.length + nested.length, "every semantic change yields a distinct hash");
});

test("frozen copy withstands caller mutation after the call; results are code-only refusals", () => {
  const input = valid(); const r = validateRunManifest(input); const h = r.hash;
  input.listing.id = 1; input.checkpoints.reverse(); input.amountMinor = 1; input.cleanup.captured = "x";
  assert.equal(r.manifest.listing.id, 891001); assert.equal(r.manifest.amountMinor, 50000); assert.equal(r.manifest.checkpoints[0], "CALENDAR_BASELINE");
  assert.equal(manifestHash(r.manifest), h);
  for (const bad of [undefined, null, 1, "x", [], valid({ extra: 1 }), valid({ amountMinor: 0 })]) {
    const f = validateRunManifest(bad);
    assert.ok(Object.isFrozen(f) && f.ok === false && typeof f.code === "string"); assert.deepEqual(Object.keys(f), ["ok", "code"]);
    assert.ok(REFUSAL_PRECEDENCE.includes(f.code), f.code);
  }
});

test("missing / extra / wrong-type keys: non-owner → MANIFEST_SHAPE; owner absent or empty → MANIFEST_OWNER_INPUT_MISSING (no defaults)", () => {
  for (const k of TOP_KEYS) {
    const expected = OWNER_KEYS.includes(k) ? "MANIFEST_OWNER_INPUT_MISSING" : "MANIFEST_SHAPE";
    assert.equal(code(without(k)), expected, k);
  }
  for (const k of ["listing", "stay", "pricing", "hostawayAccountLabel", "phases", "cleanup"]) assert.equal(code(valid({ [k]: {} })), "MANIFEST_OWNER_INPUT_MISSING", `${k} {}`);
  for (const k of ["expectedRef", "stripeAccountId", "automationsReviewed"]) assert.equal(code(valid({ [k]: "" })), "MANIFEST_OWNER_INPUT_MISSING", `${k} ""`);
  assert.equal(code(valid({ extra: 1 })), "MANIFEST_SHAPE");
  for (const [k, o] of [["listing", { extra: 1 }], ["stay", { nights: 2 }], ["pricing", { policy: "x" }], ["phases", { notify: false }], ["cleanup", { other: "x" }],
    ["hostawayAccountLabel", { secret: "x" }], ["providerMode", { notify: "fake" }]]) assert.equal(code(nest(k, o)), "MANIFEST_SHAPE", `${k} extra key`);
  const noTz = valid(); delete noTz.listing.timeZone; assert.equal(code(noTz), "MANIFEST_SHAPE", "a nested key missing");
  const noRefField = valid(); delete noRefField.listing.refFieldId; assert.equal(code(noRefField), "MANIFEST_SHAPE");
  for (const [k, v] of [["listing", "891001"], ["stay", ["2026-12-04"]], ["phases", true], ["synthetic", "true"], ["providerMode", "fake"]]) {
    assert.ok(["MANIFEST_SHAPE", "MANIFEST_OWNER_INPUT_MISSING"].includes(code(valid({ [k]: v }))), `${k} wrong type`);
  }
  assert.equal(code(valid({ guest: { email: "x@y.test" } })), "MANIFEST_SHAPE", "no contact data field exists");
});

test("deterministic precedence: version > S_LIVE > REAL_RUN > provider mode > owner input > fields", () => {
  assert.equal(code(valid({ version: "v0", providerMode: { hostaway: "fake", stripe: "live" } })), "VERSION_UNSUPPORTED");
  assert.equal(code(valid({ synthetic: false, providerMode: { hostaway: "real", stripe: "live" } })), "S_LIVE_REFUSED", "live Stripe is always reported as such");
  assert.equal(code(valid({ synthetic: false })), "REAL_RUN_NOT_IN_THIS_SLICE");
  assert.equal(code(valid({ synthetic: false, providerMode: { hostaway: "real", stripe: "test" } })), "REAL_RUN_NOT_IN_THIS_SLICE");
  for (const pm of [{ hostaway: "real", stripe: "mock" }, { hostaway: "fake", stripe: "test" }, { hostaway: "real", stripe: "test" }, { hostaway: "FAKE", stripe: "mock" }]) {
    assert.equal(code(valid({ providerMode: pm })), "PROVIDER_MODE_NOT_IN_THIS_SLICE", JSON.stringify(pm));
  }
  const m = without("listing"); m.providerMode = { hostaway: "real", stripe: "mock" };
  assert.equal(code(m), "PROVIDER_MODE_NOT_IN_THIS_SLICE", "mode before owner input");
  assert.equal(code(valid({ amountMinor: 0, runId: "BAD" })), "RUN_ID_INVALID", "field codes in schema order");
});

test("scalar ranges and cross-field rules (all explicit)", () => {
  const cases = [
    [valid({ runId: "short" }), "RUN_ID_INVALID"], [valid({ runId: "UPPER-CASE-RUN" }), "RUN_ID_INVALID"],
    [valid({ intentId: "00000000-0000-4000-8000-0000000000C1" }), "INTENT_ID_INVALID"], [valid({ intentId: "not-a-uuid" }), "INTENT_ID_INVALID"],
    [valid({ baselineCommit: "A".repeat(40) }), "BASELINE_COMMIT_INVALID"], [valid({ baselineCommit: "0".repeat(39) }), "BASELINE_COMMIT_INVALID"],
    [nest("listing", { id: 0 }), "LISTING_ID_INVALID"], [nest("listing", { id: 2 ** 31 }), "LISTING_ID_INVALID"], [nest("listing", { id: 1.5 }), "LISTING_ID_INVALID"],
    [nest("listing", { id: 603564 }), "PILOT_NOT_IN_THIS_SLICE"], [nest("listing", { id: 603566, currency: "MXN" }), "PILOT_NOT_IN_THIS_SLICE"],
    [nest("listing", { currency: "MXN" }), "CURRENCY_RULE"], [nest("listing", { currency: "usd" }), "CURRENCY_RULE"],
    [nest("listing", { refFieldId: 0 }), "REF_FIELD_INVALID"], [nest("listing", { refFieldId: "777009" }), "REF_FIELD_INVALID"],
    [nest("listing", { timeZone: "+07:00" }), "TIME_ZONE_INVALID"], [nest("listing", { timeZone: "Mars/Olympus" }), "TIME_ZONE_INVALID"], [nest("listing", { timeZone: "UTC " }), "TIME_ZONE_INVALID"],
    [valid({ expectedRef: "mv-synth01" }), "EXPECTED_REF_INVALID"], [valid({ expectedRef: "MV-AB" }), "EXPECTED_REF_INVALID"],
    [nest("stay", { arrival: "2026-02-30" }), "STAY_INVALID"], [nest("stay", { departure: "2026-12-04" }), "STAY_INVALID"], [nest("stay", { departure: "2026-12-03" }), "STAY_INVALID"],
    [nest("stay", { departure: "2027-03-05" }), "STAY_INVALID"], [nest("stay", { guests: 0 }), "STAY_INVALID"], [nest("stay", { guests: 51 }), "STAY_INVALID"],
    [nest("stay", { arrival: "1999-12-30", departure: "2000-01-02" }), "STAY_INVALID"],
    [valid({ amountMinor: 0 }), "AMOUNT_INVALID"], [valid({ amountMinor: MAX_AMOUNT_MINOR + 1 }), "AMOUNT_INVALID"], [valid({ amountMinor: 100.5 }), "AMOUNT_INVALID"],
    [valid({ pricing: { rateBps: -1 } }), "RATE_INVALID"], [valid({ pricing: { rateBps: 1.5 } }), "RATE_INVALID"], [valid({ pricing: { rateBps: "1000" } }), "RATE_INVALID"],
    [valid({ pricing: { rateBps: 5001 } }), "RATE_OUT_OF_RANGE"], [valid({ pricing: { rateBps: 10000 } }), "RATE_OUT_OF_RANGE"],
    [valid({ stripeAccountId: "acct-1" }), "STRIPE_ACCOUNT_INVALID"], [valid({ stripeAccountId: "sk_test_x" }), "STRIPE_ACCOUNT_INVALID"],
    [nest("hostawayAccountLabel", { accountRef: "has space" }), "ACCOUNT_LABEL_INVALID"], [nest("hostawayAccountLabel", { clientSnapshotId: "a@b" }), "ACCOUNT_LABEL_INVALID"],
    [valid({ phases: { capture: false, recording: true } }), "PHASE_DEPENDENCY"], [valid({ phases: { capture: "yes", recording: false }, paymentMethod: null }), "PHASE_DEPENDENCY"],
    [valid({ paymentMethod: null }), "PAYMENT_METHOD_RULE"], [valid({ paymentMethod: "cash" }), "PAYMENT_METHOD_RULE"],
    [valid({ phases: { capture: true, recording: false }, paymentMethod: "credit_card" }), "PAYMENT_METHOD_RULE"],
    [valid({ phases: { capture: true, recording: false }, paymentMethod: "" }), "PAYMENT_METHOD_RULE"],
    [nest("cleanup", { captured: "has space" }), "CLEANUP_INVALID"], [nest("cleanup", { confirmed: "owner@example.test" }), "CLEANUP_INVALID"], [nest("cleanup", { reservedNotConfirmed: 1 }), "CLEANUP_INVALID"],
    [valid({ automationsReviewed: "x".repeat(129) }), "AUTOMATIONS_INVALID"],
    [valid({ checkpoints: ["AIRBNB_BLOCKED", "CALENDAR_BASELINE", "AIRBNB_REOPENED"] }), "CHECKPOINTS_INVALID"], [valid({ checkpoints: ["CALENDAR_BASELINE"] }), "CHECKPOINTS_INVALID"]
  ];
  for (const [m, c] of cases) assert.equal(code(m), c, JSON.stringify(m).slice(0, 120));
  // boundaries that ARE valid
  for (const m of [nest("listing", { id: 2147483647 }), nest("listing", { id: 1 }), nest("stay", { guests: 50 }), nest("stay", { guests: 1 }), nest("stay", { departure: "2027-03-04", arrival: "2026-12-04" }) /* exactly 90 nights = max */,
    valid({ amountMinor: 1 }), valid({ amountMinor: MAX_AMOUNT_MINOR }), valid({ pricing: { rateBps: 0 } }), valid({ pricing: { rateBps: MAX_RATE_BPS } }), nest("listing", { timeZone: "UTC" })]) {
    const r = validateRunManifest(m);
    assert.equal(r.ok, true, `${JSON.stringify(m).slice(0, 100)} ${r.code}`);
  }
});

test("rate limit = the accepted pure policy (MAX_RATE_BPS 5000); every accepted rate yields that EXPLICIT policy value, never the default", () => {
  assert.equal(MAX_RATE_BPS, 5000);
  for (const r of [0, 1, 1000, 4999, 5000]) {
    assert.equal(validateRunManifest(valid({ pricing: { rateBps: r } })).ok, true, String(r));
    const p = readDirectPolicyFromEnv({ VERCEL_ENV: "development", [DIRECT_RATE_ENV]: String(r) });
    assert.deepEqual([p.ok, p.source, p.policy.rateBps], [true, "env", r], `policy for ${r}`);
  }
  for (const r of [5001, 10000]) {
    assert.equal(code(valid({ pricing: { rateBps: r } })), "RATE_OUT_OF_RANGE");
    assert.equal(readDirectPolicyFromEnv({ [DIRECT_RATE_ENV]: String(r) }).ok, false, `the worker policy also refuses ${r}`);
  }
  assert.equal(DIRECT_RATE_ENV, "DIRECT_DISCOUNT_BPS");
});

test("constant / date parity with the accepted pure modules", () => {
  assert.equal(MAX_AMOUNT_MINOR, STRIPE_MAX_AMOUNT);
  assert.equal(MAX_NIGHTS, FINAL_PRICE_MAX_NIGHTS);
  for (const d of ["2026-12-04", "2028-02-29", "2026-02-29", "1999-12-31", "2101-01-01", "2026-13-01", "2026-1-01", "x", null, 20261204]) assert.equal(isRealDate(d), adapterIsRealDate(d), String(d));
  assert.equal(RUN_MANIFEST_VERSION, "e7-run-manifest-v1");
  const adapterSrc = readFileSync(new URL("../lib/hostaway-reservations.js", import.meta.url), "utf8");
  assert.match(adapterSrc, /!isPosInt\(plan\.guests\) \|\| plan\.guests > 50\)/, "adapter guest bound is 1..50");
  assert.equal(validateRunManifest(nest("stay", { guests: 50 })).ok, true); assert.equal(code(nest("stay", { guests: 51 })), "STAY_INVALID");
});

test("descriptor / proxy / getter / toJSON probes: refused or ignored WITHOUT running caller getters, iterators or toJSON", () => {
  let runs = 0;
  const getter = (o, k, v) => Object.defineProperty(o, k, { enumerable: true, configurable: true, get() { runs += 1; return v; } });
  const probes = [
    getter(valid(), "amountMinor", 50000), (() => { const m = valid(); getter(m.listing, "id", 891001); return m; })(),
    Object.defineProperty(valid(), "__proto__", { enumerable: true, value: { amountMinor: 1 } }),
    (() => { const m = valid(); Object.defineProperty(m.listing, "__proto__", { enumerable: true, value: {} }); return m; })(),
    (() => { const m = valid(); m[Symbol("s")] = 1; return m; })(), Object.defineProperty(valid(), "hidden", { value: 1, enumerable: false }),
    (() => { const m = valid(); Object.defineProperty(m, "runId", { value: "synthetic-run-0001", enumerable: false }); return m; })(),
    (() => { const m = valid(); m.checkpoints = ["CALENDAR_BASELINE", , "AIRBNB_REOPENED"]; return m; })(),                                   // eslint-disable-line no-sparse-arrays
    (() => { const m = valid(); m.checkpoints[Symbol.iterator] = function* () { runs += 1; yield "x"; }; return m; })(),
    (() => { const m = valid(); getter(m.checkpoints, "0", "CALENDAR_BASELINE"); return m; })(),
    (() => { const m = valid(); m.checkpoints.extra = 1; return m; })(),
    (() => { const m = valid(); m.toJSON = () => { runs += 1; return {}; }; return m; })(),
    (() => { const m = valid(); m.listing = Object.assign(Object.create({ toJSON() { runs += 1; return {}; } }), m.listing); return m; })(),
    (() => { class L { constructor() { Object.assign(this, valid().listing); } } return valid({ listing: new L() }); })(),
    valid({ stay: Object.assign(new Date(), valid().stay) }), Object.setPrototypeOf(valid(), { x: 1 }),
    new Proxy(valid(), { ownKeys() { throw new Error("hostile"); } }), new Proxy(valid(), { getPrototypeOf() { throw new Error("hostile"); } }),
    (() => { const r = Proxy.revocable(valid(), {}); r.revoke(); return r.proxy; })(), valid({ listing: (() => { const r = Proxy.revocable({}, {}); r.revoke(); return r.proxy; })() }),
    (() => { const m = valid(); const s = Object.setPrototypeOf(["CALENDAR_BASELINE", "AIRBNB_BLOCKED", "AIRBNB_REOPENED"], null); m.checkpoints = s; return m; })(),
    valid({ amountMinor: 50000n }), valid({ amountMinor: NaN }), valid({ runId: new String("synthetic-run-0001") })
  ];
  assert.equal(probes.length, 24);
  for (const [i, m] of probes.entries()) {
    let r; assert.doesNotThrow(() => { r = validateRunManifest(m); }, `probe ${i} never throws`);
    assert.equal(r.ok, false, `probe ${i}`); assert.deepEqual(Object.keys(r), ["ok", "code"]);
  }
  // bounded depth / cycles
  const deep = valid(); let cur = deep.listing; for (let k = 0; k < 10; k++) { cur.n = {}; cur = cur.n; }
  assert.equal(code(deep), "MANIFEST_SHAPE");
  const cyc = valid(); cyc.listing.self = cyc; assert.equal(code(cyc), "MANIFEST_SHAPE");
  assert.equal(runs, 0, "no caller getter / iterator / toJSON ran");
});

test("purity: no env / network / fs / timers / SDK / pinned Hostaway adapter import in the module", () => {
  const src = readFileSync(new URL("../scripts/e7-connected/run-manifest.mjs", import.meta.url), "utf8");
  const code = src.replace(/\/\/.*$/gm, "");
  for (const re of [/process\./, /\bfetch\s*\(/, /node:(fs|net|https?|child_process|timers)/, /setTimeout|setInterval/, /Date\.now|new Date\(\)/, /from\s+["']stripe["']/,
    /hostaway-reservations/, /connectedTestAdapterConfig/, /JSON\.stringify\((?!k\)|v\))/]) assert.doesNotMatch(code, re, String(re));
  const imports = [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ["../../lib/checkout/compensation-proof.js", "../../lib/direct-pricing.js", "node:crypto"]);
});
