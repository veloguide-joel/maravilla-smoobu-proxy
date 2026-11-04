// scripts/e7-connected/run-manifest.mjs — E7 connected-test runner SLICE A (OFFLINE): manifest v1 validation + canonical hash ONLY.
// Contract: claude/e7-connected-runner-contract.md (revision 2 §3, Slice A map §11). PURE: no env, fetch, fs, SDK, timers, credentials,
// pool or transport; nothing here enables provider access. A "fake" / "mock" mode label is TRUST: it does not prove the transports a
// later runner injects are fake. This slice accepts ONLY synthetic manifests (synthetic: true, providerMode fake / mock); a real run
// (synthetic: false) is refused, and every actual owner value stays UNSET.
//
// validateRunManifest(input) -> frozen { ok:true, manifest, hash } | frozen { ok:false, code }   (code-only; never throws, never leaks)
//   * ONE descriptor-based snapshot (own, string-keyed, enumerable DATA properties only) into null-prototype / fresh-array copies,
//     bounded in depth and size, BEFORE validation; accessors, symbols, hidden / extra / missing keys, '__proto__', exotic
//     prototypes, sparse / patched arrays and introspection failures are refused. No getter, iterator, toJSON or caller method is
//     invoked; proxy traps necessarily run when a proxy is inspected (their side effects cannot be prevented here).
//   * the frozen copy that was validated is exactly the one hashed: sha256('e7-run-manifest-v1\n' + canonical JSON), where canonical
//     JSON is built here from that copy (sorted keys; strings, safe integers, booleans, null), never JSON.stringify of caller objects.
import { createHash } from "node:crypto";
import { MAX_RATE_BPS } from "../../lib/direct-pricing.js";
import { localDateInZone } from "../../lib/checkout/compensation-proof.js";

export const RUN_MANIFEST_VERSION = "e7-run-manifest-v1";
export const HASH_PREFIX = `${RUN_MANIFEST_VERSION}\n`;
export const MAX_AMOUNT_MINOR = 99_999_999;      // = stripe-test-mode.js MAX_AMOUNT_MINOR (Stripe 8-digit / E3 final-price limit); parity asserted in the tests
export const MAX_GUESTS = 50;                    // = the adapters' guest bound
export const MAX_NIGHTS = 90;                    // = the public quote / calendar 90-night limit
export const PILOT_LISTING_IDS = Object.freeze([603564, 603566]);   // both refused in this slice (contract §3.3)
export const CHECKPOINTS = Object.freeze(["CALENDAR_BASELINE", "AIRBNB_BLOCKED", "AIRBNB_REOPENED"]);
export const PAYMENT_METHODS = Object.freeze(["credit_card", "other"]);
export const TOP_KEYS = Object.freeze(["amountMinor", "automationsReviewed", "baselineCommit", "checkpoints", "cleanup", "expectedRef", "hostawayAccountLabel", "intentId",
  "listing", "paymentMethod", "phases", "pricing", "providerMode", "runId", "stay", "stripeAccountId", "synthetic", "version"]);
/** owner-supplied fields: absent / empty → MANIFEST_OWNER_INPUT_MISSING (never defaulted) */
export const OWNER_KEYS = Object.freeze(["amountMinor", "automationsReviewed", "cleanup", "expectedRef", "hostawayAccountLabel", "listing", "paymentMethod", "phases",
  "pricing", "stay", "stripeAccountId"]);
const NESTED = Object.freeze({
  providerMode: ["hostaway", "stripe"], listing: ["currency", "id", "refFieldId", "timeZone"], stay: ["arrival", "departure", "guests"], pricing: ["rateBps"],
  hostawayAccountLabel: ["accountRef", "clientSnapshotId"], phases: ["capture", "recording"], cleanup: ["captured", "confirmed", "reservedNotConfirmed"]
});
/**
 * Deterministic refusal precedence (first match wins):
 *  1 MANIFEST_SHAPE (snapshot / introspection failure, not a plain object, extra or missing NON-owner top key, nested key sets)
 *  2 VERSION_UNSUPPORTED   3 S_LIVE_REFUSED (stripe "live" — reported even when synthetic is false)   4 REAL_RUN_NOT_IN_THIS_SLICE
 *  5 PROVIDER_MODE_NOT_IN_THIS_SLICE   6 MANIFEST_OWNER_INPUT_MISSING   7.. field codes in TOP-DOWN schema order (below)
 */
export const REFUSAL_PRECEDENCE = Object.freeze(["MANIFEST_SHAPE", "VERSION_UNSUPPORTED", "S_LIVE_REFUSED", "REAL_RUN_NOT_IN_THIS_SLICE",
  "PROVIDER_MODE_NOT_IN_THIS_SLICE", "MANIFEST_OWNER_INPUT_MISSING", "RUN_ID_INVALID", "INTENT_ID_INVALID", "BASELINE_COMMIT_INVALID", "LISTING_ID_INVALID",
  "PILOT_NOT_IN_THIS_SLICE", "CURRENCY_RULE", "REF_FIELD_INVALID", "TIME_ZONE_INVALID", "EXPECTED_REF_INVALID", "STAY_INVALID", "AMOUNT_INVALID", "RATE_INVALID",
  "RATE_OUT_OF_RANGE", "STRIPE_ACCOUNT_INVALID", "ACCOUNT_LABEL_INVALID", "PHASE_DEPENDENCY", "PAYMENT_METHOD_RULE", "CLEANUP_INVALID", "AUTOMATIONS_INVALID",
  "CHECKPOINTS_INVALID"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const RUN_ID_RE = /^[a-z0-9-]{8,64}$/;
const REF_RE = /^MV-[A-Z0-9]{6,10}$/;
const ACCT_RE = /^acct_[A-Za-z0-9]{1,64}$/;
const LABEL_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const PROC_RE = /^[A-Za-z0-9._:/-]{1,128}$/;             // a procedure / review REFERENCE (no spaces, no '@': never contact data)
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TZ_PROBE_MS = Date.UTC(2026, 0, 15, 12);            // a fixed instant for the time-zone validity probe (no clock read)
const MAX_DEPTH = 4; const MAX_KEYS = 32; const MAX_ARRAY = 8; const MAX_STRING = 256;

// ---------------------------------------------------------------------------------------------
// one descriptor-based snapshot (R-G1 rules), bounded; BAD on anything not plain JSON-like data

const BAD = Symbol("bad");
function snap(v, depth) {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "string") return v.length <= MAX_STRING ? v : BAD;
  if (typeof v === "number") return Number.isFinite(v) ? v : BAD;
  if (typeof v !== "object" || depth > MAX_DEPTH) return BAD;
  const d = Object.getOwnPropertyDescriptors(v);
  const keys = Reflect.ownKeys(d);
  if (Array.isArray(v)) {
    if (Object.getPrototypeOf(v) !== Array.prototype) return BAD;
    const len = d.length;
    if (!len || !("value" in len) || !Number.isSafeInteger(len.value) || len.value > MAX_ARRAY || keys.length !== len.value + 1) return BAD;
    const out = [];
    for (let i = 0; i < len.value; i++) {
      const di = d[String(i)];
      if (!di || !("value" in di) || di.enumerable !== true) return BAD;
      const s = snap(di.value, depth + 1); if (s === BAD) return BAD; out.push(s);
    }
    for (const k of keys) if (k !== "length" && !(typeof k === "string" && /^(0|[1-9][0-9]*)$/.test(k) && Number(k) < len.value)) return BAD;
    return Object.freeze(out);
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return BAD;
  if (keys.length > MAX_KEYS) return BAD;
  const out = Object.create(null);
  for (const k of keys) {
    if (typeof k !== "string" || k === "__proto__" || !("value" in d[k]) || d[k].enumerable !== true) return BAD;
    const s = snap(d[k].value, depth + 1); if (s === BAD) return BAD; out[k] = s;
  }
  return Object.freeze(out);
}
const isRec = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const keysEq = (o, ks) => { const a = Object.keys(o).sort(); const b = [...ks].sort(); return a.length === b.length && a.every((x, i) => x === b[i]); };
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;
/** real calendar date 'YYYY-MM-DD', years 2000–2100 (the pure Hostaway adapter's isRealDate rule; parity asserted in the tests) */
export function isRealDate(s) {
  if (typeof s !== "string") return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}
const nightsBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

// ---------------------------------------------------------------------------------------------
// canonical JSON of the validated frozen copy (sorted keys; strings / safe integers / booleans / null; arrays in order)

export function canonicalJson(v) {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") { if (!Number.isSafeInteger(v)) throw new TypeError("canonical: safe integers only"); return String(v); }
  if (typeof v === "string") return JSON.stringify(v);                  // a primitive string: no caller object / toJSON involved
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (isRec(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  throw new TypeError("canonical: unsupported value");
}
export const manifestHash = (validated) => createHash("sha256").update(HASH_PREFIX + canonicalJson(validated), "utf8").digest("hex");

// ---------------------------------------------------------------------------------------------

const refuse = (code) => Object.freeze({ ok: false, code });
const ownerEmpty = (v) => v === undefined || v === "" || (isRec(v) && Object.keys(v).length === 0);

function validate(m) {
  if (!isRec(m)) return "MANIFEST_SHAPE";
  for (const k of Object.keys(m)) if (!TOP_KEYS.includes(k)) return "MANIFEST_SHAPE";
  for (const k of TOP_KEYS) if (!OWNER_KEYS.includes(k) && !(k in m)) return "MANIFEST_SHAPE";
  if (!isRec(m.providerMode) || !keysEq(m.providerMode, NESTED.providerMode) || typeof m.synthetic !== "boolean") return "MANIFEST_SHAPE";
  for (const [k, ks] of Object.entries(NESTED)) if (k in m && m[k] !== null && isRec(m[k]) && Object.keys(m[k]).length && !keysEq(m[k], ks)) return "MANIFEST_SHAPE";
  if (m.version !== RUN_MANIFEST_VERSION) return "VERSION_UNSUPPORTED";
  if (m.providerMode.stripe === "live") return "S_LIVE_REFUSED";
  if (m.synthetic !== true) return "REAL_RUN_NOT_IN_THIS_SLICE";
  if (m.providerMode.hostaway !== "fake" || m.providerMode.stripe !== "mock") return "PROVIDER_MODE_NOT_IN_THIS_SLICE";
  for (const k of OWNER_KEYS) if (k !== "paymentMethod" && ownerEmpty(m[k])) return "MANIFEST_OWNER_INPUT_MISSING";
  if (!("paymentMethod" in m)) return "MANIFEST_OWNER_INPUT_MISSING";      // always present: null is an explicit value (§3.1)
  for (const [k, ks] of Object.entries(NESTED)) if (!isRec(m[k]) || !keysEq(m[k], ks)) return "MANIFEST_SHAPE";
  if (typeof m.runId !== "string" || !RUN_ID_RE.test(m.runId)) return "RUN_ID_INVALID";
  if (typeof m.intentId !== "string" || !UUID_RE.test(m.intentId)) return "INTENT_ID_INVALID";
  if (typeof m.baselineCommit !== "string" || !COMMIT_RE.test(m.baselineCommit)) return "BASELINE_COMMIT_INVALID";
  const L = m.listing;
  if (!isPosInt(L.id) || L.id > 2147483647) return "LISTING_ID_INVALID";
  if (PILOT_LISTING_IDS.includes(L.id)) return "PILOT_NOT_IN_THIS_SLICE";
  if (L.currency !== "USD") return "CURRENCY_RULE";
  if (!isPosInt(L.refFieldId) || L.refFieldId > 2147483647) return "REF_FIELD_INVALID";
  if (typeof L.timeZone !== "string" || localDateInZone(TZ_PROBE_MS, L.timeZone) === null) return "TIME_ZONE_INVALID";
  if (typeof m.expectedRef !== "string" || !REF_RE.test(m.expectedRef)) return "EXPECTED_REF_INVALID";
  const S = m.stay;
  if (!isRealDate(S.arrival) || !isRealDate(S.departure) || !(S.arrival < S.departure) || nightsBetween(S.arrival, S.departure) > MAX_NIGHTS
      || !isPosInt(S.guests) || S.guests > MAX_GUESTS) return "STAY_INVALID";
  if (!isPosInt(m.amountMinor) || m.amountMinor > MAX_AMOUNT_MINOR) return "AMOUNT_INVALID";
  if (!Number.isSafeInteger(m.pricing.rateBps) || m.pricing.rateBps < 0) return "RATE_INVALID";
  if (m.pricing.rateBps > MAX_RATE_BPS) return "RATE_OUT_OF_RANGE";
  if (typeof m.stripeAccountId !== "string" || !ACCT_RE.test(m.stripeAccountId)) return "STRIPE_ACCOUNT_INVALID";
  const A = m.hostawayAccountLabel;
  if (typeof A.accountRef !== "string" || !LABEL_RE.test(A.accountRef) || typeof A.clientSnapshotId !== "string" || !LABEL_RE.test(A.clientSnapshotId)) return "ACCOUNT_LABEL_INVALID";
  const P = m.phases;
  if (typeof P.capture !== "boolean" || typeof P.recording !== "boolean" || (P.recording && !P.capture)) return "PHASE_DEPENDENCY";
  if (P.recording ? !PAYMENT_METHODS.includes(m.paymentMethod) : m.paymentMethod !== null) return "PAYMENT_METHOD_RULE";
  const C = m.cleanup;
  for (const k of NESTED.cleanup) if (typeof C[k] !== "string" || !PROC_RE.test(C[k])) return "CLEANUP_INVALID";
  if (typeof m.automationsReviewed !== "string" || !PROC_RE.test(m.automationsReviewed)) return "AUTOMATIONS_INVALID";
  if (!Array.isArray(m.checkpoints) || m.checkpoints.length !== CHECKPOINTS.length || m.checkpoints.some((x, i) => x !== CHECKPOINTS[i])) return "CHECKPOINTS_INVALID";
  return null;
}

/** validateRunManifest(input) → frozen { ok:true, manifest, hash } | frozen { ok:false, code }. Never throws; never returns caller data. */
export function validateRunManifest(input) {
  let m;
  try { m = snap(input, 0); } catch { return refuse("MANIFEST_SHAPE"); }       // ONLY input introspection is caught
  if (m === BAD) return refuse("MANIFEST_SHAPE");
  const code = validate(m);
  if (code) return refuse(code);
  return Object.freeze({ ok: true, manifest: m, hash: manifestHash(m) });
}
