// E7 manifest v2 (M2-A) — schema validation + canonical hash (OFFLINE unit tests; no DB, no network, synthetic only).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { validateRunManifestV2, manifestHashV2, HASH_PREFIX_V2, RUN_MANIFEST_V2_VERSION, CONNECTIONS, CHECKPOINTS_BY_CONNECTION, TOP_KEYS_V2, OWNER_KEYS_V2,
  REFUSAL_PRECEDENCE_V2 } from "../scripts/e7-connected/run-manifest-v2.mjs";
import { validateRunManifest, manifestHash, TOP_KEYS, OWNER_KEYS, REFUSAL_PRECEDENCE, CHECKPOINTS } from "../scripts/e7-connected/run-manifest.mjs";

let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline manifest v2 suite)"); };
after(() => { globalThis.fetch = realFetch; assert.equal(netAttempts, 0, "no network attempt"); });

const CK = { disconnected: ["CALENDAR_BASELINE", "CALENDAR_BLOCKED", "CALENDAR_REOPENED"], airbnb: ["CALENDAR_BASELINE", "AIRBNB_BLOCKED", "AIRBNB_REOPENED"] };
/** a VALID synthetic v2 manifest (every value synthetic; no owner value is implied) */
const valid = (over = {}, connection = "disconnected") => ({
  version: "e7-run-manifest-v2", runId: "synthetic-run-v2-0001", intentId: "00000000-0000-4000-8000-0000000000c2", baselineCommit: "0".repeat(40),
  synthetic: true, providerMode: { hostaway: "fake", stripe: "mock" },
  listing: { id: 891001, currency: "USD", refFieldId: 777009, timeZone: "America/Mazatlan", connection },
  expectedRef: "MV-SYNTH02", stay: { arrival: "2026-12-04", departure: "2026-12-06", guests: 2 }, amountMinor: 50000, pricing: { rateBps: 1000 },
  stripeAccountId: "acct_1SyntheticRunner", hostawayAccountLabel: { accountRef: "acct-test-1", clientSnapshotId: "client-RUN" },
  phases: { capture: true, recording: true, testAbortAfterReservation: false }, paymentMethod: "credit_card",
  cleanup: { reservedNotConfirmed: "synthetic/cleanup-reserved", captured: "synthetic/cleanup-captured", confirmed: "synthetic/cleanup-confirmed" },
  automationsReviewed: "synthetic/automations", checkpoints: [...CK[connection]], ...over
});
const abort = (connection = "disconnected") => valid({ phases: { capture: false, recording: false, testAbortAfterReservation: true }, paymentMethod: null }, connection);
const code = (m) => validateRunManifestV2(m).code;
const nest = (base, k, over) => ({ ...base, [k]: { ...base[k], ...over } });
/** the matching v1 manifest (v1 fixture shape): no connection, no testAbortAfterReservation, v1 checkpoints */
const asV1 = (m) => { const { connection, ...listing } = m.listing; const { testAbortAfterReservation, ...phases } = m.phases;
  void connection; void testAbortAfterReservation; return { ...m, version: "e7-run-manifest-v1", listing, phases, checkpoints: [...CHECKPOINTS] }; };
const indep = (v) => (Array.isArray(v) ? `[${v.map(indep).join(",")}]` : v && typeof v === "object"
  ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${indep(v[k])}`).join(",")}}` : JSON.stringify(v));
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

test("V1 both connection modes validate; frozen result; the VALIDATED frozen copy is exactly what is hashed in the v2 domain (independent framing)", () => {
  assert.equal(RUN_MANIFEST_V2_VERSION, "e7-run-manifest-v2"); assert.equal(HASH_PREFIX_V2, "e7-run-manifest-v2\n");
  assert.deepEqual([...CONNECTIONS], ["disconnected", "airbnb"]);
  assert.deepEqual(JSON.parse(JSON.stringify(CHECKPOINTS_BY_CONNECTION)), CK);
  for (const c of CONNECTIONS) for (const m of [valid({}, c), abort(c), valid({ phases: { capture: true, recording: false, testAbortAfterReservation: false }, paymentMethod: null }, c),
    valid({ phases: { capture: false, recording: false, testAbortAfterReservation: false }, paymentMethod: null }, c), valid({ paymentMethod: "other" }, c)]) {
    const r = validateRunManifestV2(m);
    assert.equal(r.ok, true, `${c}: ${r.code}`);
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r.manifest) && Object.isFrozen(r.manifest.listing) && Object.isFrozen(r.manifest.phases) && Object.isFrozen(r.manifest.checkpoints));
    assert.equal(r.hash, sha(`e7-run-manifest-v2\n${indep(m)}`), "hash = sha256(literal v2 prefix + canonical JSON)");
    assert.equal(manifestHashV2(r.manifest), r.hash);
    assert.deepEqual(JSON.parse(indep(r.manifest)), m, "validated copy = input data");
  }
  assert.deepEqual([...TOP_KEYS_V2], [...TOP_KEYS]); assert.deepEqual([...OWNER_KEYS_V2], [...OWNER_KEYS]);
  assert.deepEqual(REFUSAL_PRECEDENCE_V2.filter((c) => !["CONNECTION_INVALID", "TEST_ABORT_PHASE_CONFLICT"].includes(c)), [...REFUSAL_PRECEDENCE], "v1 precedence kept, two codes inserted");
});

test("V2 distinct version / hash domains; v1 ⇄ v2 cross-rejection (no relabel / upgrade / downgrade); v1 non-regression", () => {
  const v2 = validateRunManifestV2(valid({}, "airbnb"));
  const v1in = asV1(valid({}, "airbnb"));
  const v1 = validateRunManifest(v1in);
  assert.equal(v1.ok, true, v1.code);
  // the same validated data framed in the two domains never collides
  assert.notEqual(v2.hash, manifestHash(v2.manifest)); assert.equal(manifestHash(v2.manifest), sha(`e7-run-manifest-v1\n${indep(valid({}, "airbnb"))}`));
  assert.notEqual(manifestHashV2(v1.manifest), v1.hash);
  // v2 refuses every v1 manifest; v1 refuses every v2 manifest
  assert.equal(code(v1in), "MANIFEST_SHAPE", "a v1 manifest lacks connection / testAbortAfterReservation");
  assert.equal(code({ ...valid(), version: "e7-run-manifest-v1" }), "VERSION_UNSUPPORTED", "a v2-shaped manifest labelled v1 is never relabelled");
  for (const v of ["e7-run-manifest-v3", "", "E7-RUN-MANIFEST-V2", "e7-run-manifest-v2 "]) assert.equal(code({ ...valid(), version: v }), "VERSION_UNSUPPORTED", v);
  for (const c of CONNECTIONS) {
    assert.equal(validateRunManifest(valid({}, c)).ok, false, `v1 refuses v2 (${c})`);
    assert.equal(validateRunManifest(valid({}, c)).code, "MANIFEST_SHAPE");
    assert.equal(validateRunManifest({ ...asV1(valid({}, c)), version: "e7-run-manifest-v2" }).code, "VERSION_UNSUPPORTED", "a v1-shaped manifest labelled v2 is refused by v1");
  }
  // v1 non-regression: the accepted v1 fixture still validates with its accepted hash framing
  assert.equal(v1.hash, sha(`e7-run-manifest-v1\n${indep(v1in)}`));
});

test("V3 hash binds connection / checkpoint mode / testAbortAfterReservation and every relevant field", () => {
  const base = validateRunManifestV2(valid()).hash;
  const variants = [valid({}, "airbnb"), abort(), valid({ phases: { capture: true, recording: false, testAbortAfterReservation: false }, paymentMethod: null }),
    valid({ runId: "synthetic-run-v2-0002" }), valid({ intentId: "00000000-0000-4000-8000-0000000000c3" }), valid({ baselineCommit: "1".repeat(40) }),
    nest(valid(), "listing", { id: 891002 }), nest(valid(), "listing", { refFieldId: 777010 }), nest(valid(), "listing", { timeZone: "America/Mexico_City" }),
    valid({ expectedRef: "MV-SYNTH03" }), nest(valid(), "stay", { arrival: "2026-12-03" }), nest(valid(), "stay", { departure: "2026-12-07" }), nest(valid(), "stay", { guests: 3 }),
    valid({ amountMinor: 50001 }), valid({ pricing: { rateBps: 999 } }), valid({ stripeAccountId: "acct_1SyntheticRunnerB" }),
    nest(valid(), "hostawayAccountLabel", { accountRef: "acct-test-2" }), nest(valid(), "hostawayAccountLabel", { clientSnapshotId: "client-RUN2" }), valid({ paymentMethod: "other" }),
    nest(valid(), "cleanup", { captured: "synthetic/cleanup-captured-2" }), valid({ automationsReviewed: "synthetic/automations-2" })];
  const hashes = new Set([base]);
  for (const v of variants) { const r = validateRunManifestV2(v); assert.equal(r.ok, true, r.code); assert.ok(!hashes.has(r.hash), JSON.stringify(v).slice(0, 80)); hashes.add(r.hash); }
  // key order never changes the hash
  const m = valid(); const reordered = Object.fromEntries(Object.entries(m).reverse().map(([k, v]) => [k, v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v]));
  assert.equal(validateRunManifestV2(reordered).hash, base);
});

test("V4 checkpoints: mode-specific exact order; cross-mode, union / mixed, missing, extra, reordered, duplicated, v1-legacy and wrong types refuse", () => {
  const D = CK.disconnected; const A = CK.airbnb;
  const bad = { disconnected: [A, [...D, ...A.slice(1)], [D[0], D[1], A[2]], [D[0], A[1], D[2]], D.slice(0, 2), [...D, D[2]], [D[1], D[0], D[2]], [D[0], D[0], D[1]], [], ["calendar_baseline", D[1], D[2]], "CALENDAR_BASELINE", null],
    airbnb: [D, [...A, ...D.slice(1)], [A[0], A[1], D[2]], A.slice(1), [A[2], A[1], A[0]], [...A, "AIRBNB_REOPENED"], [A[0], "CALENDAR_BLOCKED", A[2]], [A[0], A[1]]] };
  for (const [c, lists] of Object.entries(bad)) for (const ck of lists) {
    const got = code(valid({ checkpoints: ck }, c));
    assert.ok(["CHECKPOINTS_INVALID", "MANIFEST_SHAPE"].includes(got), `${c} ${JSON.stringify(ck)} → ${got}`);
    assert.notEqual(validateRunManifestV2(valid({ checkpoints: ck }, c)).ok, true);
  }
  assert.equal(code(valid({ checkpoints: A }, "disconnected")), "CHECKPOINTS_INVALID");
  assert.equal(code(valid({ checkpoints: D }, "airbnb")), "CHECKPOINTS_INVALID");
});

test("V5 connection: REQUIRED, exactly disconnected | airbnb; no default and no inference from the listing id", () => {
  const noConn = valid(); delete noConn.listing.connection;
  assert.equal(code(noConn), "MANIFEST_SHAPE", "absent connection is a missing listing key, never defaulted");
  for (const c of ["", "Disconnected", "AIRBNB", "airbnb ", "none", "vrbo", null, true, 1, ["airbnb"], { mode: "airbnb" }]) {
    const got = code(nest(valid(), "listing", { connection: c }));
    assert.ok(["CONNECTION_INVALID", "MANIFEST_SHAPE"].includes(got), `${JSON.stringify(c)} → ${got}`);
  }
  assert.equal(code(nest(valid(), "listing", { connection: "AIRBNB" })), "CONNECTION_INVALID");
  // a listing id historically connected to Airbnb does not imply "airbnb" and vice versa: both modes are accepted per declaration for the same id
  assert.equal(validateRunManifestV2(valid({}, "disconnected")).ok, true); assert.equal(validateRunManifestV2(valid({}, "airbnb")).ok, true);
  assert.equal(code(nest(valid(), "listing", { id: 603566 })), "PILOT_NOT_IN_THIS_SLICE", "pilot listings stay refused");
});

test("V6 phases: testAbortAfterReservation REQUIRED boolean; true requires capture=false and recording=false; v1 phase / paymentMethod rules kept", () => {
  const ph = (p, pm = null) => valid({ phases: p, paymentMethod: pm });
  assert.equal(code(ph({ capture: true, recording: false, testAbortAfterReservation: true })), "TEST_ABORT_PHASE_CONFLICT");
  assert.equal(code(ph({ capture: true, recording: true, testAbortAfterReservation: true }, "credit_card")), "TEST_ABORT_PHASE_CONFLICT");
  assert.equal(code(ph({ capture: false, recording: true, testAbortAfterReservation: true }, "credit_card")), "PHASE_DEPENDENCY", "recording ⇒ capture still first");
  assert.equal(code(ph({ capture: false, recording: true, testAbortAfterReservation: false }, "credit_card")), "PHASE_DEPENDENCY");
  assert.equal(code(ph({ capture: false, recording: false, testAbortAfterReservation: true }, "credit_card")), "PAYMENT_METHOD_RULE", "no recording ⇒ paymentMethod null");
  assert.equal(code(ph({ capture: true, recording: true, testAbortAfterReservation: false }, null)), "PAYMENT_METHOD_RULE");
  for (const t of [undefined, null, "true", 1, 0, [true], new Boolean(true)]) {
    const p = { capture: false, recording: false, testAbortAfterReservation: t }; if (t === undefined) delete p.testAbortAfterReservation;
    const got = code(ph(p));
    assert.ok(["PHASE_DEPENDENCY", "MANIFEST_SHAPE"].includes(got), `${String(t)} → ${got}`);
  }
  assert.equal(code(ph({ capture: false, recording: false, testAbortAfterReservation: "true" })), "PHASE_DEPENDENCY");
  assert.equal(code(valid({ phases: {} })), "MANIFEST_OWNER_INPUT_MISSING", "empty phases is an absent owner input");
});

test("V7 v1 safeguards preserved: owner inputs, live / real / provider mode, identity, TEST / amount / currency / dates (invalid / rollover / reversed: code-only, never throwing)", () => {
  for (const k of OWNER_KEYS_V2) { const m = valid(); delete m[k]; assert.equal(code(m), "MANIFEST_OWNER_INPUT_MISSING", k); }
  for (const k of ["listing", "stay", "pricing", "phases", "cleanup", "hostawayAccountLabel"]) assert.equal(code(valid({ [k]: {} })), "MANIFEST_OWNER_INPUT_MISSING", k);
  assert.equal(code(valid({ expectedRef: "" })), "MANIFEST_OWNER_INPUT_MISSING");
  assert.equal(code(valid({ providerMode: { hostaway: "fake", stripe: "live" } })), "S_LIVE_REFUSED");
  assert.equal(code(valid({ providerMode: { hostaway: "fake", stripe: "live" }, synthetic: false })), "S_LIVE_REFUSED");
  assert.equal(code(valid({ synthetic: false })), "REAL_RUN_NOT_IN_THIS_SLICE");
  for (const pm of [{ hostaway: "real", stripe: "mock" }, { hostaway: "fake", stripe: "test" }, { hostaway: "fake", stripe: "real" }]) assert.equal(code(valid({ providerMode: pm })), "PROVIDER_MODE_NOT_IN_THIS_SLICE");
  assert.equal(code(nest(valid(), "listing", { currency: "MXN" })), "CURRENCY_RULE");
  assert.equal(code(valid({ amountMinor: 0 })), "AMOUNT_INVALID"); assert.equal(code(valid({ amountMinor: 100000000 })), "AMOUNT_INVALID");
  assert.equal(code(valid({ amountMinor: 500.5 })), "AMOUNT_INVALID");
  assert.equal(code(valid({ stripeAccountId: "sk_test_x" })), "STRIPE_ACCOUNT_INVALID");
  assert.equal(code(valid({ runId: "BAD" })), "RUN_ID_INVALID"); assert.equal(code(valid({ intentId: "x" })), "INTENT_ID_INVALID");
  for (const [a, d] of [["2026-13-01", "2026-13-03"], ["2026-12-00", "2026-12-03"], ["2026-12-04", "2026-12-99"], ["2027-02-29", "2027-03-02"], ["2027-02-30", "2027-03-02"],
    ["2026-12-06", "2026-12-04"], ["2026-12-04", "2026-12-04"], ["1999-12-30", "2000-01-02"], ["2026-12-4", "2026-12-06"], ["2026-01-01", "2026-04-02"]]) {
    let r; assert.doesNotThrow(() => { r = validateRunManifestV2(nest(valid(), "stay", { arrival: a, departure: d })); }, `${a}..${d}`);
    assert.deepEqual(r, { ok: false, code: "STAY_INVALID" }, `${a}..${d}`);
  }
  assert.equal(validateRunManifestV2(nest(valid(), "stay", { arrival: "2028-02-29", departure: "2028-03-02" })).ok, true, "a real leap day passes");
  // differential parity with the accepted v1 validator for every shared-field mutation (same refusal code)
  const shared = [{ runId: "x" }, { baselineCommit: "abc" }, { expectedRef: "MV-1" }, { amountMinor: -1 }, { pricing: { rateBps: 5001 } }, { pricing: { rateBps: -1 } },
    { automationsReviewed: "has space" }, { paymentMethod: "cash" }, { stripeAccountId: "acct_" }];
  for (const o of shared) assert.equal(code(valid(o, "airbnb")), validateRunManifest({ ...asV1(valid({}, "airbnb")), ...o }).code, JSON.stringify(o));
  for (const [k, o] of [["listing", { id: 0 }], ["listing", { timeZone: "+07:00" }], ["listing", { refFieldId: -1 }], ["stay", { guests: 51 }], ["cleanup", { captured: "" }],
    ["hostawayAccountLabel", { accountRef: "a b" }]]) {
    const v1 = asV1(valid({}, "airbnb")); assert.equal(code(nest(valid({}, "airbnb"), k, o)), validateRunManifest(nest(v1, k, o)).code, `${k} ${JSON.stringify(o)}`);
  }
});

test("V8 hostile inputs: arrays / boxed values / accessors / extra / symbol / exotic prototypes refuse code-only WITHOUT invoking getters or toJSON; mutation after validation cannot change the frozen hashed object", () => {
  let calls = 0;
  const getterTop = Object.defineProperty(valid(), "amountMinor", { get: () => { calls += 1; return 50000; }, enumerable: true });
  const getterNested = valid(); Object.defineProperty(getterNested.listing, "connection", { get: () => { calls += 1; return "airbnb"; }, enumerable: true });
  const withToJSON = valid({ listing: { ...valid().listing, toJSON() { calls += 1; return {}; } } });
  const sym = valid(); sym[Symbol("x")] = 1;
  const hidden = valid(); Object.defineProperty(hidden, "extra", { value: 1, enumerable: false });
  class K { constructor() { Object.assign(this, valid()); } }
  const cases = [getterTop, getterNested, withToJSON, sym, hidden, new K(), valid({ extra: 1 }), valid({ __proto__x: 1 }), [valid()], new String("x"), null, 42, "manifest",
    valid({ amountMinor: new Number(50000) }), valid({ runId: new String("synthetic-run-v2-0001") }), valid({ checkpoints: Object.assign([...CK.disconnected], { extra: 1 }) }),
    nest(valid(), "listing", { connection: new String("airbnb") }), valid({ phases: { capture: false, recording: false, testAbortAfterReservation: new Boolean(true) }, paymentMethod: null }),
    valid({ checkpoints: CK.disconnected.map((x) => new String(x)) })];
  for (const m of cases) {
    let r; assert.doesNotThrow(() => { r = validateRunManifestV2(m); });
    assert.equal(r.ok, false); assert.equal(typeof r.code, "string"); assert.deepEqual(Object.keys(r).sort(), ["code", "ok"]);
  }
  assert.equal(calls, 0, "no caller getter / toJSON invoked");
  const src = valid(); const r = validateRunManifestV2(src); const h = r.hash;
  src.listing.connection = "airbnb"; src.phases.testAbortAfterReservation = true; src.checkpoints[1] = "AIRBNB_BLOCKED"; src.amountMinor = 1;
  assert.equal(r.manifest.listing.connection, "disconnected"); assert.equal(r.manifest.phases.testAbortAfterReservation, false); assert.equal(r.manifest.checkpoints[1], "CALENDAR_BLOCKED");
  assert.equal(manifestHashV2(r.manifest), h);
  assert.throws(() => { "use strict"; r.manifest.listing.connection = "airbnb"; }, TypeError);
  // bounded work: oversized string / array / depth refuse code-only
  assert.equal(code(valid({ automationsReviewed: "a".repeat(300) })), "MANIFEST_SHAPE");
  assert.equal(code(valid({ checkpoints: new Array(9).fill("CALENDAR_BASELINE") })), "MANIFEST_SHAPE");
});

test("V9 purity / scope: the v2 module is inert (no env / network / fs / timers / SDK / DB / transport import); v1 module bytes unchanged", () => {
  const src = readFileSync(new URL("../scripts/e7-connected/run-manifest-v2.mjs", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const imports = [...code.matchAll(/^import\s[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["node:crypto", "../../lib/direct-pricing.js", "../../lib/checkout/compensation-proof.js", "./run-manifest.mjs"]);
  for (const bad of ["process.", "fetch(", "node:fs", "node:http", "node:net", "setTimeout", "setInterval", "import(", "require(", "globalThis", "Intl.DateTimeFormat"]) {   // provider / SDK / DB / transport / journal modules: excluded by the EXACT import list above
    assert.equal(new RegExp(`\\b${bad.replace(/[.()]/g, "\\$&")}`).test(code.replace(/"[^"]*"/g, "")), false, bad);
  }
  const v1 = readFileSync(new URL("../scripts/e7-connected/run-manifest.mjs", import.meta.url));
  assert.equal(createHash("sha256").update(v1).digest("hex"), V1_SHA256, "accepted v1 module byte-exact");
});
const V1_SHA256 = "c47f72eb2b9e898bdaca2ca20ffe7cea0befab006079953133810ce5651f6a56";
