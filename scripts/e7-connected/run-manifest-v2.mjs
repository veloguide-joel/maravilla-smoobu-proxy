// scripts/e7-connected/run-manifest-v2.mjs — E7 connected-test manifest v2 (M2-A, OFFLINE): SCHEMA validation + canonical hash ONLY.
// Doc: claude/e7-run-manifest-v2.md. PURE and INERT: no env, fetch, fs, SDK, timers, credentials, pool, transport, worker or event application.
// The accepted v1 module (run-manifest.mjs) is unchanged; run-core and the journals still consume v1 ONLY and do NOT execute v2.
//
// v2 = every accepted v1 safeguard, plus:
//   * listing.connection REQUIRED: exactly "disconnected" | "airbnb" (no default, no inference from the listing id);
//   * checkpoints = the EXACT ordered list for that connection (a declaration of required evidence, NOT evidence that it happened);
//   * phases.testAbortAfterReservation REQUIRED boolean; true requires capture=false and recording=false (declares the planned TEST
//     abort; nothing is sent or applied here). v1 rules recording ⇒ capture and the paymentMethod rule are kept.
// Version "e7-run-manifest-v2" and hash framing sha256("e7-run-manifest-v2\n" + canonical JSON of the SAME validated frozen snapshot).
// v2 refuses v1 manifests and v1 refuses v2 manifests: no implicit relabel, upgrade or downgrade. synthetic:false stays
// REAL_RUN_NOT_IN_THIS_SLICE; only providerMode hostaway "fake" / stripe "mock" is accepted (stripe "live" → S_LIVE_REFUSED).
//
// validateRunManifestV2(input) -> frozen { ok:true, manifest, hash } | frozen { ok:false, code }   (code-only; never throws, never leaks)
//   * ONE descriptor-based, bounded snapshot BEFORE validation (the accepted v1 rules, copied: v1 keeps its snapshot private and must stay
//     byte-exact); no getter, iterator, toJSON or caller method is invoked; accessors / symbols / extra keys / exotic prototypes refuse.
import { createHash } from "node:crypto";
import { MAX_RATE_BPS } from "../../lib/direct-pricing.js";
import { localDateInZone } from "../../lib/checkout/compensation-proof.js";
import { isRealDate, canonicalJson, MAX_AMOUNT_MINOR, MAX_GUESTS, MAX_NIGHTS, PILOT_LISTING_IDS, PAYMENT_METHODS }
  from "./run-manifest.mjs";

export const RUN_MANIFEST_V2_VERSION = "e7-run-manifest-v2";
export const HASH_PREFIX_V2 = `${RUN_MANIFEST_V2_VERSION}\n`;
export const CONNECTIONS = Object.freeze(["disconnected", "airbnb"]);
export const CHECKPOINTS_BY_CONNECTION = Object.freeze({
  disconnected: Object.freeze(["CALENDAR_BASELINE", "CALENDAR_BLOCKED", "CALENDAR_REOPENED"]),
  airbnb: Object.freeze(["CALENDAR_BASELINE", "AIRBNB_BLOCKED", "AIRBNB_REOPENED"])
});
export const TOP_KEYS_V2 = Object.freeze(["amountMinor", "automationsReviewed", "baselineCommit", "checkpoints", "cleanup", "expectedRef", "hostawayAccountLabel", "intentId",
  "listing", "paymentMethod", "phases", "pricing", "providerMode", "runId", "stay", "stripeAccountId", "synthetic", "version"]);
/** owner-supplied fields: absent / empty → MANIFEST_OWNER_INPUT_MISSING (never defaulted) — the v1 set */
export const OWNER_KEYS_V2 = Object.freeze(["amountMinor", "automationsReviewed", "cleanup", "expectedRef", "hostawayAccountLabel", "listing", "paymentMethod", "phases",
  "pricing", "stay", "stripeAccountId"]);
const NESTED = Object.freeze({
  providerMode: ["hostaway", "stripe"], listing: ["connection", "currency", "id", "refFieldId", "timeZone"], stay: ["arrival", "departure", "guests"], pricing: ["rateBps"],
  hostawayAccountLabel: ["accountRef", "clientSnapshotId"], phases: ["capture", "recording", "testAbortAfterReservation"],
  cleanup: ["captured", "confirmed", "reservedNotConfirmed"]
});
/** deterministic refusal precedence (first match wins): the v1 order with CONNECTION_INVALID after the listing fields and
 *  TEST_ABORT_PHASE_CONFLICT after PHASE_DEPENDENCY */
export const REFUSAL_PRECEDENCE_V2 = Object.freeze(["MANIFEST_SHAPE", "VERSION_UNSUPPORTED", "S_LIVE_REFUSED", "REAL_RUN_NOT_IN_THIS_SLICE",
  "PROVIDER_MODE_NOT_IN_THIS_SLICE", "MANIFEST_OWNER_INPUT_MISSING", "RUN_ID_INVALID", "INTENT_ID_INVALID", "BASELINE_COMMIT_INVALID", "LISTING_ID_INVALID",
  "PILOT_NOT_IN_THIS_SLICE", "CURRENCY_RULE", "REF_FIELD_INVALID", "TIME_ZONE_INVALID", "CONNECTION_INVALID", "EXPECTED_REF_INVALID", "STAY_INVALID", "AMOUNT_INVALID",
  "RATE_INVALID", "RATE_OUT_OF_RANGE", "STRIPE_ACCOUNT_INVALID", "ACCOUNT_LABEL_INVALID", "PHASE_DEPENDENCY", "TEST_ABORT_PHASE_CONFLICT", "PAYMENT_METHOD_RULE",
  "CLEANUP_INVALID", "AUTOMATIONS_INVALID", "CHECKPOINTS_INVALID"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const RUN_ID_RE = /^[a-z0-9-]{8,64}$/;
const REF_RE = /^MV-[A-Z0-9]{6,10}$/;
const ACCT_RE = /^acct_[A-Za-z0-9]{1,64}$/;
const LABEL_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const PROC_RE = /^[A-Za-z0-9._:/-]{1,128}$/;
const TZ_PROBE_MS = Date.UTC(2026, 0, 15, 12);
const MAX_DEPTH = 4; const MAX_KEYS = 32; const MAX_ARRAY = 8; const MAX_STRING = 256;

// one descriptor-based snapshot (copied v1 rules), bounded; BAD on anything not plain JSON-like data
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
const nightsBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/** v2 hash domain: sha256("e7-run-manifest-v2\n" + canonical JSON) of the validated frozen snapshot (canonicalJson = the accepted v1 one) */
export const manifestHashV2 = (validated) => createHash("sha256").update(HASH_PREFIX_V2 + canonicalJson(validated), "utf8").digest("hex");

const refuse = (code) => Object.freeze({ ok: false, code });
const ownerEmpty = (v) => v === undefined || v === "" || (isRec(v) && Object.keys(v).length === 0);

function validate(m) {
  if (!isRec(m)) return "MANIFEST_SHAPE";
  for (const k of Object.keys(m)) if (!TOP_KEYS_V2.includes(k)) return "MANIFEST_SHAPE";
  for (const k of TOP_KEYS_V2) if (!OWNER_KEYS_V2.includes(k) && !(k in m)) return "MANIFEST_SHAPE";
  if (!isRec(m.providerMode) || !keysEq(m.providerMode, NESTED.providerMode) || typeof m.synthetic !== "boolean") return "MANIFEST_SHAPE";
  for (const [k, ks] of Object.entries(NESTED)) if (k in m && m[k] !== null && isRec(m[k]) && Object.keys(m[k]).length && !keysEq(m[k], ks)) return "MANIFEST_SHAPE";
  if (m.version !== RUN_MANIFEST_V2_VERSION) return "VERSION_UNSUPPORTED";          // a v1 (or any other) version is never relabelled
  if (m.providerMode.stripe === "live") return "S_LIVE_REFUSED";
  if (m.synthetic !== true) return "REAL_RUN_NOT_IN_THIS_SLICE";
  if (m.providerMode.hostaway !== "fake" || m.providerMode.stripe !== "mock") return "PROVIDER_MODE_NOT_IN_THIS_SLICE";
  for (const k of OWNER_KEYS_V2) if (k !== "paymentMethod" && ownerEmpty(m[k])) return "MANIFEST_OWNER_INPUT_MISSING";
  if (!("paymentMethod" in m)) return "MANIFEST_OWNER_INPUT_MISSING";
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
  if (typeof L.connection !== "string" || !CONNECTIONS.includes(L.connection)) return "CONNECTION_INVALID";
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
  if (typeof P.capture !== "boolean" || typeof P.recording !== "boolean" || typeof P.testAbortAfterReservation !== "boolean" || (P.recording && !P.capture)) return "PHASE_DEPENDENCY";
  if (P.testAbortAfterReservation && (P.capture || P.recording)) return "TEST_ABORT_PHASE_CONFLICT";
  if (P.recording ? !PAYMENT_METHODS.includes(m.paymentMethod) : m.paymentMethod !== null) return "PAYMENT_METHOD_RULE";
  const C = m.cleanup;
  for (const k of NESTED.cleanup) if (typeof C[k] !== "string" || !PROC_RE.test(C[k])) return "CLEANUP_INVALID";
  if (typeof m.automationsReviewed !== "string" || !PROC_RE.test(m.automationsReviewed)) return "AUTOMATIONS_INVALID";
  const want = CHECKPOINTS_BY_CONNECTION[L.connection];
  if (!Array.isArray(m.checkpoints) || m.checkpoints.length !== want.length || m.checkpoints.some((x, i) => x !== want[i])) return "CHECKPOINTS_INVALID";
  return null;
}

/** validateRunManifestV2(input) → frozen { ok:true, manifest, hash } | frozen { ok:false, code }. Never throws; never returns caller data. */
export function validateRunManifestV2(input) {
  let m;
  try { m = snap(input, 0); } catch { return refuse("MANIFEST_SHAPE"); }       // ONLY input introspection is caught
  if (m === BAD) return refuse("MANIFEST_SHAPE");
  const code = validate(m);
  if (code) return refuse(code);
  return Object.freeze({ ok: true, manifest: m, hash: manifestHashV2(m) });
}
