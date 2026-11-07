// scripts/e7-connected/run-binding-r1.mjs — E7 M2-G1: PURE R1 package / executor-closure verifier (contract claude/e7-run-real-r1.md §1–§2).
//   * Output is EVIDENCE DATA (executable:false, all permissions false). A binding-shaped object or the r1 version string is never an
//     execution credential; consumers re-derive the binding from the binder INPUT (the G1 preflight does) — no ForBinding seam exists.
//   * Expected hashes are caller-REVIEWED PINS, not Git provenance and not owner permission.
//   * Pure: imports only pure accepted modules (externals node:crypto / node:util); no process / fs / net / timer / DB / provider.
import { createHash } from "node:crypto";
import { types } from "node:util";
import { canonicalJson } from "./run-manifest.mjs";
import { ownedBytes } from "./probe-source-digest.mjs";
import { buildRunPackageV1, validateRunPlanV1, snapshotData, RUN_PLAN_CLOSURE, PERMISSIONS_NONE, MAX_SOURCE_FILE_BYTES, MAX_SOURCE_TOTAL_BYTES,
  HISTORICAL_EXCLUSIONS } from "./run-plan-v1.mjs";
import { MAX_RATE_BPS } from "../../lib/direct-pricing.js";

export const R1_BINDING_SCHEMA = "e7-run-binding-r1";
export const R1_IDENTITY_VERSION = "e7-run-package-r1";
export const EXECUTOR_SOURCE_PREFIX = "e7-run-executor-source-r1\n";
export const MAX_PACKAGE_BYTES = 65_536;
export const MAX_PACKAGE_DEPTH = 10;
export const ACCEPTED_REF_RE = /^MV-[A-Z0-9]{6,10}$/;          // = run-manifest-v2.mjs:51, executor-adapters.mjs:30, run-facts.mjs REF_RE
/** the REVIEWED G1 executor closure (sorted): scanned transitive relative imports of run-binding-r1 + run-preflight-r1, plus manifests. G1 ONLY. */
export const R1_EXECUTOR_CLOSURE = Object.freeze([
  "lib/bookability.js", "lib/booking-db/codec.js", "lib/booking-db/config.js", "lib/booking-db/repo.js", "lib/checkout/capture-proof.js",
  "lib/checkout/compensation-proof.js", "lib/checkout/final-price.js", "lib/checkout/intent-state.js", "lib/checkout/offline-charge-proof.js",
  "lib/checkout/recovery-plan.js", "lib/checkout/server-pricer.js", "lib/direct-policy.js", "lib/direct-pricing.js", "lib/hostaway-calendar.js", "lib/hostaway-reservations.js", "lib/hostaway.js",
  "lib/public-api.js", "lib/quote-public.js", "package-lock.json", "package.json", "scripts/e7-connected/executor-adapters.mjs",
  "scripts/e7-connected/probe-env-preflight.mjs", "scripts/e7-connected/probe-source-digest.mjs", "scripts/e7-connected/run-binding-r1.mjs",
  "scripts/e7-connected/run-facts.mjs", "scripts/e7-connected/run-guard.mjs", "scripts/e7-connected/run-manifest-v2.mjs", "scripts/e7-connected/run-manifest.mjs",
  "scripts/e7-connected/run-plan-v1.mjs", "scripts/e7-connected/run-preflight-r1.mjs"]);
export const BINDER_CODES = Object.freeze(["R1_OK", "R1_INPUT_INVALID", "R1_EXPECTED_INVALID", "R1_CLOCK_INVALID", "R1_SOURCES_INVALID", "R1_SNAPSHOT_OVERLAP_MISMATCH",
  "R1_PACKAGE_BYTES_INVALID", "R1_PACKAGE_INVALID", "R1_CLOCK_BEFORE_PACKAGE", "R1_RECOMPUTE_REFUSED", "R1_PACKAGE_MISMATCH", "R1_PACKAGE_HASH_MISMATCH", "R1_UNBOUND",
  "R1_STALE_AT_EXEC", "R1_REF_NOT_ACCEPTED", "R1_RATE_NOT_ACCEPTED", "R1_EXECUTOR_DIGEST_MISMATCH"]);
const INPUT_KEYS = ["envSnapshot", "execClock", "executorSources", "expected", "foundationSources", "packageBytes", "planBytes"];

const freeze = Object.freeze;
const getProto = Object.getPrototypeOf;
const HEX64 = /^[0-9a-f]{64}$/;
const isInt = (v, lo, hi) => typeof v === "number" && Number.isSafeInteger(v) && v >= lo && v <= hi;

/** own enumerable DATA properties exactly `keys` of a plain / null-proto non-proxy object → frozen null-proto copy | null (no getter runs) */
function dataExactly(o, keys) {
  try {
    if (o === null || typeof o !== "object" || types.isProxy(o) || Array.isArray(o)) return null;
    const p = getProto(o); if (p !== Object.prototype && p !== null) return null;
    const d = Object.getOwnPropertyDescriptors(o); const ks = Reflect.ownKeys(d);
    if (ks.length !== keys.length) return null;
    const out = Object.create(null);
    for (const k of ks) { if (typeof k !== "string" || !keys.includes(k) || !("value" in d[k]) || d[k].enumerable !== true) return null; out[k] = d[k].value; }
    return out;
  } catch { return null; }
}
/** an EXACT ordered source list for `closure` → frozen [{ path, bytes(owned) }] | null */
function ownSources(input, closure) {
  try {
    if (!Array.isArray(input) || types.isProxy(input) || getProto(input) !== Array.prototype) return null;
    const d = Object.getOwnPropertyDescriptors(input);
    if (!d.length || d.length.value !== closure.length || Reflect.ownKeys(d).length !== closure.length + 1) return null;
    const out = []; let total = 0;
    for (let i = 0; i < closure.length; i++) {
      const e = d[String(i)]; if (!e || !("value" in e)) return null;
      const x = dataExactly(e.value, ["bytes", "path"]); if (!x || x.path !== closure[i]) return null;
      const bytes = ownedBytes(x.bytes, MAX_SOURCE_FILE_BYTES); if (bytes === null) return null;
      total += bytes.length; if (total > MAX_SOURCE_TOTAL_BYTES) return null;
      out.push(freeze({ path: closure[i], bytes }));
    }
    return freeze(out);
  } catch { return null; }
}
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
/** executor digest: prefix, then per entry path ‖ 0x00 ‖ decimal length ‖ 0x00 ‖ bytes ‖ 0x00 */
export function executorDigestR1(entries) {
  const h = createHash("sha256"); const z = new Uint8Array([0]); const enc = new TextEncoder();
  h.update(enc.encode(EXECUTOR_SOURCE_PREFIX));
  for (const { path, bytes } of entries) { h.update(enc.encode(path)); h.update(z); h.update(enc.encode(String(bytes.length))); h.update(z); h.update(bytes); h.update(z); }
  return h.digest("hex");
}
/** bounded canonical bytes (exact canonicalJson + "\n"; depth scanned before JSON.parse) → value | undefined */
function parseCanonical(b, maxBytes, maxDepth) {
  if (b.length > maxBytes) return undefined;
  let depth = 0; let inStr = false; let esc = false;
  for (const c of b) {
    if (inStr) { if (esc) esc = false; else if (c === 0x5c) esc = true; else if (c === 0x22) inStr = false; continue; }
    if (c === 0x22) inStr = true; else if (c === 0x7b || c === 0x5b) { if (++depth > maxDepth) return undefined; } else if (c === 0x7d || c === 0x5d) depth -= 1;
  }
  let text; try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b); } catch { return undefined; }
  if (!text.endsWith("\n")) return undefined;
  let v; try { v = JSON.parse(text.slice(0, -1)); } catch { return undefined; }
  let canon; try { canon = canonicalJson(v); } catch { return undefined; }
  return `${canon}\n` === text ? v : undefined;
}

/** bindRunPackageR1(input) → frozen { ok:true, binding } | frozen { ok:false, code } — pure, synchronous, never throws */
export function bindRunPackageR1(input) {
  const R = (code) => freeze({ ok: false, code });
  try {
    const o = dataExactly(input, INPUT_KEYS); if (!o) return R("R1_INPUT_INVALID");
    const ex = dataExactly(o.expected, ["executorDigest", "packageHash"]);
    if (!ex || typeof ex.packageHash !== "string" || !HEX64.test(ex.packageHash) || typeof ex.executorDigest !== "string" || !HEX64.test(ex.executorDigest)) return R("R1_EXPECTED_INVALID");
    if (!isInt(o.execClock, 1, 8.64e15)) return R("R1_CLOCK_INVALID");
    const execClock = o.execClock;
    const pkgBytes = ownedBytes(o.packageBytes, MAX_PACKAGE_BYTES + 1); const planBytes = ownedBytes(o.planBytes, 4 * 16_384);
    const env = snapshotData(o.envSnapshot);
    if (pkgBytes === null || planBytes === null || env === null) return R("R1_INPUT_INVALID");
    const fnd = ownSources(o.foundationSources, RUN_PLAN_CLOSURE); const exe = ownSources(o.executorSources, R1_EXECUTOR_CLOSURE);
    if (!fnd || !exe) return R("R1_SOURCES_INVALID");
    const byPath = new Map(fnd.map((e) => [e.path, e.bytes]));
    for (const e of exe) if (byPath.has(e.path) && !sameBytes(byPath.get(e.path), e.bytes)) return R("R1_SNAPSHOT_OVERLAP_MISMATCH");
    const pkg = parseCanonical(pkgBytes, MAX_PACKAGE_BYTES, MAX_PACKAGE_DEPTH); if (pkg === undefined) return R("R1_PACKAGE_BYTES_INVALID");
    const p = snapshotData(pkg);
    if (!p || p.schema !== "e7-run-package-v1" || p.executable !== false || p.nature !== "SCOPE_BINDING_ONLY" || canonicalJson(p.permissions ?? null) !== canonicalJson(PERMISSIONS_NONE)
      || !isInt(p.evaluatedAt, 1, 8.64e15)) return R("R1_PACKAGE_INVALID");
    if (execClock < p.evaluatedAt) return R("R1_CLOCK_BEFORE_PACKAGE");
    const built = buildRunPackageV1({ planBytes, sourceEntries: fnd.map((e) => ({ path: e.path, bytes: e.bytes })), envSnapshot: env, planClock: p.evaluatedAt });
    if (!built.ok) return R("R1_RECOMPUTE_REFUSED");
    if (`${canonicalJson(built.package)}\n` !== new TextDecoder().decode(pkgBytes)) return R("R1_PACKAGE_MISMATCH");
    if (built.packageHash !== ex.packageHash) return R("R1_PACKAGE_HASH_MISMATCH");
    if (built.package.binding !== "BOUND") return R("R1_UNBOUND");
    const plan = built.package.plan;
    if (!validateRunPlanV1(plan, { planClock: execClock }).ok) return R("R1_STALE_AT_EXEC");
    const b = plan.binding;
    if (!ACCEPTED_REF_RE.test(b.expectedRef)) return R("R1_REF_NOT_ACCEPTED");
    if (!isInt(b.rateBps, 0, MAX_RATE_BPS)) return R("R1_RATE_NOT_ACCEPTED");
    const executorDigest = executorDigestR1(exe);
    if (executorDigest !== ex.executorDigest) return R("R1_EXECUTOR_DIGEST_MISMATCH");
    const L = plan.listing; const ck = plan.checkpoints;
    const binding = snapshotData({
      schema: R1_BINDING_SCHEMA, nature: "R1_BINDING_EVIDENCE_ONLY", executable: false, permissions: { ...PERMISSIONS_NONE },
      identity: { manifestVersion: R1_IDENTITY_VERSION, connection: L.connection, runId: plan.runId, intentId: b.intentId, baselineCommit: plan.baseline.repoCommit,
        manifestHash: built.packageHash },
      packageHash: built.packageHash, foundationDigest: built.sourceDigest, executorDigest, execClock, evaluatedAt: p.evaluatedAt,
      scope: { intentId: b.intentId, paymentIntentId: b.paymentIntentId, expectedRef: b.expectedRef,
        listing: { id: L.id, currency: L.currency, refFieldId: L.refFieldId, timeZone: L.timeZone, connection: L.connection },
        stay: { arrival: b.stay.arrival, departure: b.stay.departure, guests: b.stay.guests }, amountMinor: b.amountMinor, rateBps: b.rateBps,
        stripeAccountId: plan.environment.stripe.accountId, quote: { totalMinor: b.quote.totalMinor, currency: b.quote.currency, quotedAt: b.quote.quotedAt },
        authorizedAt: b.authorizedAt },
      checkpoints: { baseline: ck[0], blocked: ck[1], reopened: ck[2] }, phases: { ...plan.phases },
      exclusions: JSON.parse(JSON.stringify(HISTORICAL_EXCLUSIONS))
    });
    if (!binding) return R("R1_PACKAGE_INVALID");
    return freeze({ ok: true, binding });
  } catch { return R("R1_INPUT_INVALID"); }
}
