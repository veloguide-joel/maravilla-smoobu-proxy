// scripts/e7-connected/probe-command.mjs — E7 probe CLI stage C2 (OFFLINE): the single command assembly over INJECTED dependencies.
// Contract: claude/e7-connected-probe-cli-contract.md §11 (accepted at d81fea91) + implementation map §12.
//   * runProbeCommand({ argv, deps }) → native Promise<deep-frozen disposition>; never throws, never rejects.
//   * No default fs, env, clock, timer or network: every dependency is injected; the X primitive is ALWAYS passed explicitly, so X's own
//     default primitive is unreachable from here. No signal registration, stdout write or process action: the (CLOSED) entrypoint owns those.
//   * Inspect (the default) accepts only five deps and never constructs T, X or an Agent, never reads credentials, never writes output.
//   * Order before any secret: args → deps → env → source → plan → bindings → output parent; then C1 credentials → X → T → P.
//   * Finite OPERATION bounds only; NO elapsed-time bound: a hanging injected plan / credential / output fs keeps this pending.
//   * Outputs are code-only and mechanically whitelisted (keys AND values); the private credential capability is never serialized.
import { types } from "node:util";
import { validateProbePlan, canonicalJson, runReadonlyProbes, VOCABULARY, T_ERROR_CODES, CODES } from "./readonly-probe.mjs";
import { createE7HostawaySend, createE7StripeTestSend } from "./http-transports.mjs";
import { createE7RealExchange } from "./real-exchange.mjs";
import { evaluateProbeEnvironment, ENV_CODES, ENV_CHECK_KEYS } from "./probe-env-preflight.mjs";
import { readProbeCredentialFile, CREDENTIAL_CODES, CLOSE_STATES } from "./probe-credential-file.mjs";

export const CLI_RESULT_SCHEMA = "e7-probe-cli-result-v1";
export const CLI_STDOUT_SCHEMA = "e7-probe-cli-stdout-v1";
export const PRIMARY_OUTCOMES = Object.freeze(["CLI_INSPECT_OK", "CLI_COMPLETED_OK", "CLI_COMPLETED_INCONCLUSIVE", "CLI_PROBE_STOPPED", "CLI_USAGE", "CLI_DEPS_INVALID",
  "CLI_ENV_REFUSED", "CLI_SOURCE_UNREADABLE", "CLI_SOURCE_MISMATCH", "CLI_PLAN_UNREADABLE", "CLI_PLAN_INVALID", "CLI_BINDING_MISMATCH", "CLI_OUTPUT_PARENT_INVALID",
  "CLI_OUTPUT_EXISTS", "CLI_CREDENTIAL_REFUSED", "CLI_INTERRUPTED", "CLI_INTERNAL"]);
export const OUTPUT_FAULT_CODES = Object.freeze(["CLI_TAIL_UNCERTAIN", "CLI_OUTPUT_RACE", "CLI_OUTPUT_UNKNOWN"]);
export const CLI_CODES = Object.freeze([...PRIMARY_OUTCOMES, ...OUTPUT_FAULT_CODES]);
export const SUMMARY_FILE_STATES = Object.freeze(["NOT_ATTEMPTED", "RACE_EXISTS", "UNKNOWN", "CLOSED_ACK"]);
/** plan-file sub-codes added by C2 (§12): before P's own plan codes */
export const PLAN_FILE_CODES = Object.freeze(["PLAN_NOT_JSON", "PLAN_TOO_DEEP", "PLAN_NOT_CANONICAL"]);
/** fixed internal sub-codes (§12): a P / T / X setup refusal, or a C2 guard that is unreachable by construction */
export const INTERNAL_CODES = Object.freeze([...CODES.run, "PLAN_NOT_VALIDATED", "OPTIONS_INVALID", "EXCHANGE_OPTIONS_INVALID", "PAYLOAD_LIMIT", "REDACTION", "UNEXPECTED"]);
export const MODES = Object.freeze(["inspect", "execute"]);
export const OUTPUT_CREATE_KIND = "summary-create";                 // O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600 (later real adapter)
export const MAX_ARGV = 32;
export const MAX_PLAN_BYTES = 16384;
export const MAX_PLAN_DEPTH = 8;
export const MAX_PAYLOAD_BYTES = 65536;                             // the summary FILE bytes, trailing newline included
export const MAX_STDOUT_BYTES = 131072;                             // the stdout envelope wraps the payload, so it has its own cap
export const MAX_ANCESTORS = 64;
export const INSPECT_DEPS = Object.freeze(["envSnapshot", "interrupt", "readPlanFile", "repoRoot", "sourceDigest"]);
export const EXECUTE_DEPS = Object.freeze([...INSPECT_DEPS, "credentialFs", "monotonic", "outputFs", "primitive", "timers"]);
const PRE_EXIT = Object.freeze({ CLI_INSPECT_OK: 10, CLI_USAGE: 2, CLI_DEPS_INVALID: 1, CLI_ENV_REFUSED: 3, CLI_SOURCE_UNREADABLE: 4, CLI_SOURCE_MISMATCH: 4,
  CLI_PLAN_UNREADABLE: 4, CLI_PLAN_INVALID: 4, CLI_BINDING_MISMATCH: 4, CLI_OUTPUT_PARENT_INVALID: 4, CLI_OUTPUT_EXISTS: 4, CLI_CREDENTIAL_REFUSED: 5,
  CLI_INTERRUPTED: 7, CLI_INTERNAL: 1 });
const RUN_EXIT = Object.freeze({ CLI_COMPLETED_OK: 0, CLI_COMPLETED_INCONCLUSIVE: 11, CLI_PROBE_STOPPED: 6 });

// ---- intrinsics captured at load ------------------------------------------------------------------------------------------------------
const freeze = Object.freeze;
const apply = Reflect.apply;
const ownKeys = Reflect.ownKeys;
const getDesc = Object.getOwnPropertyDescriptor;
const getDescs = Object.getOwnPropertyDescriptors;
const getProto = Object.getPrototypeOf;
const isFrozen = Object.isFrozen;
const isArray = Array.isArray;
const NativePromise = Promise;
const PROMISE_PROTO = Promise.prototype;
const P_THEN = Promise.prototype.then;
const CTOR_DESC = getDesc(Promise.prototype, "constructor");
const SPECIES_DESC = getDesc(Promise, Symbol.species);
const NATIVE_ABORTED = getDesc(AbortSignal.prototype, "aborted").get;
const U8 = Uint8Array;
const U8_PROTO = Uint8Array.prototype;
const TA_PROTO = getProto(Uint8Array.prototype);
const TA_LENGTH = getDesc(TA_PROTO, "length").get;
const TA_BUFFER = getDesc(TA_PROTO, "buffer").get;
const TA_SET = TA_PROTO.set;
const DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const DECODE = TextDecoder.prototype.decode;
const ENCODER = new TextEncoder();
const ENCODE = TextEncoder.prototype.encode;
const JSON_PARSE = JSON.parse;
const WELL_KNOWN = new Set(Object.getOwnPropertyNames(Symbol).map((k) => Symbol[k]).filter((s) => typeof s === "symbol"));
const { isProxy, isPromise, isUint8Array, isSharedArrayBuffer } = types;
const isFn = (f) => typeof f === "function" && !isProxy(f);
const isObj = (o) => o !== null && typeof o === "object" && !isProxy(o);

// ---- small helpers (getter-free) --------------------------------------------------------------------------------------------------
function dataExactly(o, keys) {
  try {
    if (!isObj(o) || isArray(o)) return null;
    const p = getProto(o); if (p !== Object.prototype && p !== null) return null;
    const d = getDescs(o); const ks = ownKeys(d); if (ks.length !== keys.length) return null;
    const out = Object.create(null);
    for (const k of ks) { if (typeof k !== "string" || !keys.includes(k) || !("value" in d[k]) || d[k].enumerable !== true) return null; out[k] = d[k].value; }
    return out;
  } catch { return null; }
}
/** own DATA property of a non-proxy object (descriptor read; accessor / absent → undefined) */
const od = (o, k) => { try { if (!isObj(o)) return undefined; const d = getDesc(o, k); return d && "value" in d ? d.value : undefined; } catch { return undefined; } };
const errCode = (e) => { const c = od(e, "code"); return typeof c === "string" ? c : null; };
function nativeAborted(sig) { try { if (!isObj(sig)) return null; const a = apply(NATIVE_ABORTED, sig, []); return typeof a === "boolean" ? a : null; } catch { return null; } }
function intrinsicsIntact() {
  const c = getDesc(PROMISE_PROTO, "constructor"); const sp = getDesc(NativePromise, Symbol.species);
  return !!c && "value" in c && c.value === CTOR_DESC.value && !!sp && sp.get === SPECIES_DESC.get && sp.set === SPECIES_DESC.set;
}
function isNativePromise(p) {
  try {
    if (!isObj(p) || !isPromise(p) || getProto(p) !== PROMISE_PROTO) return false;
    const d = getDescs(p);
    for (const k of ownKeys(d)) if (typeof k !== "symbol" || WELL_KNOWN.has(k) || Symbol.keyFor(k) !== undefined || !("value" in d[k])) return false;
    return intrinsicsIntact();
  } catch { return false; }
}
/** call an injected function ONCE → { ok, v | e } after native settlement; null for a sync throw / non-native return (never assimilated;
 *  any rejection of a non-native return is caller-owned). `onReturn` runs right after the synchronous return (re-entrancy boundary). */
async function callOnce(fn, args, onReturn) {
  let p; try { p = apply(fn, undefined, args); } catch { onReturn(); return null; }
  onReturn();
  if (!isNativePromise(p)) return null;
  return new NativePromise((res) => { try { apply(P_THEN, p, [(v) => res({ ok: true, v }), (e) => res({ ok: false, e })]); } catch { res(null); } });
}
/** genuine non-shared Uint8Array of 1…max bytes → OWNED copy | null (captured getters; no caller shadow / iterator / toJSON read) */
function ownedBytes(v, max) {
  try {
    if (!isObj(v) || !isUint8Array(v) || getProto(v) !== U8_PROTO) return null;
    if (isSharedArrayBuffer(apply(TA_BUFFER, v, []))) return null;
    const n = apply(TA_LENGTH, v, []); if (!Number.isSafeInteger(n) || n < 1 || n > max) return null;
    const out = new U8(n); apply(TA_SET, out, [v]); return out;
  } catch { return null; }
}
// canonical POSIX paths (= C1 rules)
function canonical(p, allowRoot) {
  if (typeof p !== "string" || p.length < 1 || p.length > 4096 || p[0] !== "/" || p.includes("\0")) return false;
  if (p === "/") return allowRoot;
  return p.slice(1).split("/").every((s) => s !== "" && s !== "." && s !== "..");
}
const dirname = (p) => { const i = p.lastIndexOf("/"); return i === 0 ? "/" : p.slice(0, i); };
const join = (d, name) => (d === "/" ? `/${name}` : `${d}/${name}`);
const within = (p, root) => root === "/" || p === root || p.startsWith(`${root}/`);
// stat records (= C1 §2.2 schema, re-implemented locally; C1 is accepted and not modified)
const STAT_KEYS = ["dev", "ino", "kind", "mode", "nlink", "size", "uid", "mtimeNs", "ctimeNs"];
const DEC_RE = /^(0|[1-9][0-9]{0,39})$/;
function statRecord(v) {
  const s = dataExactly(v, STAT_KEYS); if (!s) return null;
  if (typeof s.dev !== "string" || !DEC_RE.test(s.dev) || typeof s.ino !== "string" || !DEC_RE.test(s.ino) || !["file", "dir", "symlink", "other"].includes(s.kind)) return null;
  if (!Number.isSafeInteger(s.mode) || s.mode < 0 || s.mode > 0o177777 || !Number.isSafeInteger(s.nlink) || s.nlink < 0 || s.nlink > 0xffffffff) return null;
  if (!Number.isSafeInteger(s.uid) || s.uid < 0 || s.uid > 0xffffffff || !Number.isSafeInteger(s.size) || s.size < 0) return null;
  if (typeof s.mtimeNs !== "string" || !DEC_RE.test(s.mtimeNs) || typeof s.ctimeNs !== "string" || !DEC_RE.test(s.ctimeNs)) return null;
  return freeze(s);
}

// ---- argv ---------------------------------------------------------------------------------------------------------------------------
const FLAGS = ["--plan", "--credentials", "--summary-out", "--expect-plan-hash", "--expect-source-digest", "--expect-requests", "--approval-ref"];
const INSPECT_FLAGS = ["--plan", "--expect-plan-hash", "--expect-source-digest", "--expect-requests", "--approval-ref"];
const HEX64 = /^[0-9a-f]{64}$/;
const REF_RE = /^[A-Za-z0-9._:-]{1,80}$/;
function argvSnapshot(a) {
  try {
    if (!isObj(a) || !isArray(a) || getProto(a) !== Array.prototype) return null;
    const d = getDescs(a); const ld = d.length; if (!ld || !("value" in ld)) return null;
    const n = ld.value; if (!Number.isSafeInteger(n) || n < 0 || n > MAX_ARGV || ownKeys(d).length !== n + 1) return null;
    const out = [];
    for (let i = 0; i < n; i++) { const e = d[String(i)]; if (!e || !("value" in e) || typeof e.value !== "string" || e.value.length < 1 || e.value.length > 4096 || e.value.includes("\0")) return null; out.push(e.value); }
    return out;
  } catch { return null; }
}
/** → { mode, flags } | { mode|null, usage:true } */
function parseArgv(a) {
  let mode; let i;
  if (a.length === 0 || a[0].startsWith("--")) { mode = "inspect"; i = 0; }
  else if (a[0] === "inspect" || a[0] === "execute") { mode = a[0]; i = 1; }
  else return { mode: null, usage: true };
  const allowed = mode === "inspect" ? INSPECT_FLAGS : FLAGS;
  const flags = Object.create(null);
  for (; i < a.length; i += 2) {
    const f = a[i]; const v = a[i + 1];
    if (!allowed.includes(f) || f in flags || v === undefined || v.startsWith("--")) return { mode, usage: true };
    let ok;
    if (f === "--plan" || f === "--credentials" || f === "--summary-out") ok = canonical(v, false);
    else if (f === "--expect-plan-hash" || f === "--expect-source-digest") ok = HEX64.test(v);
    else if (f === "--expect-requests") ok = /^[1-8]$/.test(v);
    else ok = REF_RE.test(v);
    if (!ok) return { mode, usage: true };
    flags[f] = v;
  }
  const required = mode === "inspect" ? ["--plan"] : FLAGS;
  if (!required.every((f) => f in flags)) return { mode, usage: true };
  if (mode === "execute" && new Set([flags["--plan"], flags["--credentials"], flags["--summary-out"]]).size !== 3) return { mode, usage: true };
  return { mode, flags: freeze(flags) };
}

// ---- deps -------------------------------------------------------------------------------------------------------------------------
/** frozen non-proxy env snapshot + frozen non-proxy own-data `present`; C1 then decides its exact shape */
function envSnapshotOk(s) {
  try {
    if (!isObj(s) || !isFrozen(s)) return false;
    const pd = getDesc(s, "present"); if (!pd || !("value" in pd)) return false;
    return isObj(pd.value) && isFrozen(pd.value);
  } catch { return false; }
}
function depsFor(mode, deps) {
  const d = dataExactly(deps, mode === "inspect" ? INSPECT_DEPS : EXECUTE_DEPS); if (!d) return null;
  if (!envSnapshotOk(d.envSnapshot) || !canonical(d.repoRoot, true) || !(d.sourceDigest === null || (typeof d.sourceDigest === "string" && HEX64.test(d.sourceDigest)))
      || !isFn(d.readPlanFile) || nativeAborted(d.interrupt) === null) return null;
  if (mode === "inspect") return d;
  const out = dataExactly(d.outputFs, ["create", "lstat", "platform", "realpath", "uid"]);
  if (!out || typeof out.platform !== "string" || !Number.isSafeInteger(out.uid) || out.uid < 0 || out.uid > 0xffffffff || !isFn(out.lstat) || !isFn(out.realpath) || !isFn(out.create)) return null;
  if (!isObj(d.credentialFs) || od(d.credentialFs, "platform") !== out.platform || od(d.credentialFs, "uid") !== out.uid) return null;
  const prim = dataExactly(d.primitive, ["Agent", "request"]); if (!prim || !isFn(prim.Agent) || !isFn(prim.request)) return null;
  if (!isFn(d.monotonic) || !isObj(d.timers)) return null;
  return freeze({ ...d, outputFs: freeze(out), primitive: freeze(prim) });
}

// ---- plan bytes → validated plan ----------------------------------------------------------------------------------------------------
/** iterative structural bound on a JSON.parse result (no recursion before P has bounded the structure) */
function depthOk(v) {
  const stack = [[v, 1]]; let nodes = 0;
  while (stack.length) {
    const [x, dep] = stack.pop(); nodes += 1; if (nodes > MAX_PLAN_BYTES) return false;
    if (x === null || typeof x !== "object") continue;
    if (dep > MAX_PLAN_DEPTH) return false;
    const vals = isArray(x) ? x : Object.keys(x).map((k) => x[k]);           // JSON.parse output: plain own data only
    for (const c of vals) stack.push([c, dep + 1]);
  }
  return true;
}
function planFromBytes(bytes) {
  let text;
  try { text = apply(DECODE, DECODER, [bytes]); } catch { return { code: "PLAN_NOT_JSON" }; }
  let parsed; try { parsed = apply(JSON_PARSE, JSON, [text]); } catch { return { code: "PLAN_NOT_JSON" }; }
  if (!depthOk(parsed)) return { code: "PLAN_TOO_DEEP" };
  const r = validateProbePlan(parsed);
  if (!r.ok) return { code: r.code };
  const plan = r.plan;
  // canonical-file equality over the SAME validated, frozen content that P hashed (planHash excluded, exactly as P computed it)
  const body = Object.fromEntries(Object.keys(plan).filter((k) => k !== "planHash").map((k) => [k, plan[k]]));
  const c = canonicalJson(body);
  if (text !== c && text !== `${c}\n`) return { code: "PLAN_NOT_CANONICAL" };
  return { plan };
}

// ---- redaction ----------------------------------------------------------------------------------------------------------------------
const P_SUMMARY_KEYS = ["schema", "planHash", "metadata", "reviewedCommit", "nodeVersion", "stripeVersion", "approvalRef", "outcome", "stopCode", "stopProbe", "probes", "id", "code",
  "httpStatus", "transportCode", "elapsed", "evidence", "gates", "idMatches", "currencyUSD", "dayCount", "inWindow", "complete", "rowCount", "allScoped", "typesOk", "pageFull",
  "listingMatches", "status", "allRowsMatch", "accountIdMatches", "livemode", "latestCharge", "proofFieldsTyped", "G_AUTH_charges_read", "G_FILTER", "G_SHAPE_listing",
  "G_SHAPE_calendar", "G_SHAPE_lookup", "G_SHAPE_reservation", "G_SHAPE_charges", "B4_pi_read", "TEST_mode_pi", "timerCleanup", "cancelFailed", "uncancellable"];
const CLI_KEYS = ["mode", "primaryOutcome", "runExitCode", "tailUncertain", "interruptObserved", "preflight", "ok", "checks", ...ENV_CHECK_KEYS, "source", "sourceDigest", "matches",
  "planCode", "plan", "probes", "maxRequests", "bindings", "requests", "credential", "closeState", "requestsAttempted", "internalCode", "summary", "finalize", "tail",
  "payload", "output", "summaryFile", "summaryCloseState", "exitCode"];
const KEY_SET = new Set([...P_SUMMARY_KEYS, ...CLI_KEYS]);
const STATIC_VALUES = new Set([...VOCABULARY, ...T_ERROR_CODES, ...ENV_CODES, ...CREDENTIAL_CODES, ...CLOSE_STATES, ...CLI_CODES, ...SUMMARY_FILE_STATES, ...PLAN_FILE_CODES,
  ...CODES.plan, ...INTERNAL_CODES, CLI_RESULT_SCHEMA, CLI_STDOUT_SCHEMA, ...MODES]);
/** every key ∈ KEY_SET and every string value ∈ STATIC_VALUES ∪ `dynamic` (planHash, sourceDigest, the four metadata labels) */
function redactionOk(root, dynamic) {
  const stack = [root]; let nodes = 0;
  while (stack.length) {
    const v = stack.pop(); nodes += 1; if (nodes > 100000) return false;
    if (v === null || typeof v === "boolean") continue;
    if (typeof v === "number") { if (!Number.isFinite(v)) return false; continue; }
    if (typeof v === "string") { if (!STATIC_VALUES.has(v) && !dynamic.has(v)) return false; continue; }
    if (typeof v !== "object") return false;
    if (isArray(v)) { for (const x of v) stack.push(x); continue; }
    for (const k of Object.keys(v)) { if (!KEY_SET.has(k) && !T_ERROR_CODES.includes(k)) return false; stack.push(v[k]); }
  }
  return true;
}
function deepFreeze(v) { if (v !== null && typeof v === "object" && !isFrozen(v)) { freeze(v); for (const k of Object.keys(v)) deepFreeze(v[k]); } return v; }

/**
 * exitFor(facts) — the ONLY exit-precedence computation in C2.
 *   facts: { primaryOutcome, ran, tailUncertain, summaryFile } (summaryFile null = output not considered → operational precedence only)
 *   run:     9 summary file ≠ CLOSED_ACK  >  8 tail uncertain  >  6 stopped  >  11 completed inconclusive  >  0 completed OK
 *   no run:  the fixed pre-run code (2 usage, 1 deps / internal, 3 env, 4 source / plan / binding / output parent / exists, 5 credential, 7 interrupted, 10 inspect OK)
 *   (130 and a stdout write failure → 9 are applied ONLY by the CLOSED entrypoint, which cannot be known here)
 */
export function exitFor(facts) {
  if (!facts.ran) return PRE_EXIT[facts.primaryOutcome] ?? 1;
  if (facts.summaryFile !== null && facts.summaryFile !== "CLOSED_ACK") return 9;
  if (facts.tailUncertain) return 8;
  return RUN_EXIT[facts.primaryOutcome] ?? 1;
}

// ---- output ---------------------------------------------------------------------------------------------------------------------------
/** single summary-file write: create once (O_EXCL kind), close captured FIRST, writes / sync / close each acknowledged by exact schema */
async function writeSummary(outputFs, target, bytes) {
  const noop = () => {};
  const created = await callOnce(outputFs.create, [target, OUTPUT_CREATE_KIND], noop);
  if (created === null) return { summaryFile: "UNKNOWN", closeState: "NOT_OPENED" };                     // unobservable create: nothing provable
  if (!created.ok) return { summaryFile: errCode(created.e) === "EEXIST" ? "RACE_EXISTS" : "UNKNOWN", closeState: "NOT_OPENED" };
  const h = created.v;
  let closeFn = null;
  if (isObj(h)) { try { const cd = getDesc(h, "close"); if (cd && "value" in cd && isFn(cd.value)) closeFn = cd.value; } catch { closeFn = null; } }
  let ok = false;
  try {
    const hd = dataExactly(h, ["close", "sync", "write"]);
    if (hd && closeFn !== null && isFn(hd.write) && isFn(hd.sync)) {
      let off = 0; let calls = 0; let fault = false;
      while (off < bytes.length) {
        calls += 1; if (calls > bytes.length) { fault = true; break; }                                    // unreachable under positive progress
        const r = await callOnce(hd.write, [bytes, off, bytes.length - off], noop);
        if (r === null || !r.ok || !Number.isSafeInteger(r.v) || r.v < 1 || r.v > bytes.length - off) { fault = true; break; }
        off += r.v;
      }
      if (!fault) { const s = await callOnce(hd.sync, [], noop); ok = s !== null && s.ok && s.v === undefined; }
    }
  } catch { ok = false; }
  if (closeFn === null) return { summaryFile: "UNKNOWN", closeState: "UNCLOSABLE" };
  const c = await callOnce(closeFn, [], noop);
  const closed = c !== null && c.ok && c.v === undefined;
  return { summaryFile: ok && closed ? "CLOSED_ACK" : "UNKNOWN", closeState: closed ? "CLOSED" : "CLOSE_FAILED" };
}

// ---- command ----------------------------------------------------------------------------------------------------------------------
/** runProbeCommand({ argv, deps }) → native Promise<deep-frozen disposition>; never throws, never rejects */
export function runProbeCommand(input) {
  const st = { mode: null, ran: false, primaryOutcome: "CLI_INTERNAL", tailUncertain: false };
  return new NativePromise((resolve) => {
    let inner;
    try { inner = command(input, st); } catch { resolve(fallback(st)); return; }
    apply(P_THEN, inner, [resolve, () => resolve(fallback(st))]);
  });
}
/** fixed fallback for an unexpected internal fault: truthful primaryOutcome if a run happened; no payload, no file */
function fallback(st) {
  const exitCode = exitFor({ primaryOutcome: st.primaryOutcome, ran: st.ran, tailUncertain: st.tailUncertain, summaryFile: st.ran ? "NOT_ATTEMPTED" : null });
  const env = { schema: CLI_STDOUT_SCHEMA, payload: null, output: { summaryFile: "NOT_ATTEMPTED", summaryCloseState: "NOT_OPENED" }, exitCode,
    primaryOutcome: st.primaryOutcome, tailUncertain: st.tailUncertain };
  return deepFreeze({ exitCode, primaryOutcome: st.primaryOutcome, tailUncertain: st.tailUncertain, summaryFile: "NOT_ATTEMPTED", summaryCloseState: "NOT_OPENED", stdoutLine: canonicalJson(env) });
}

async function command(input, st) {
  // payload fields; every unreached stage stays null (exact fixed shape for pre-run dispositions)
  const P = { mode: null, preflight: null, source: null, planCode: null, plan: null, bindings: null, credential: null, requestsAttempted: null, internalCode: null,
    summary: null, finalize: null, interruptObserved: false };
  const dynamic = new Set();
  let interrupt = null;
  const intNow = () => { if (interrupt !== null && nativeAborted(interrupt) === true) P.interruptObserved = true; return P.interruptObserved; };

  const finish = async (primaryOutcome, out) => {
    st.primaryOutcome = primaryOutcome;
    if (interrupt !== null) intNow();
    const runExitCode = exitFor({ primaryOutcome, ran: st.ran, tailUncertain: st.tailUncertain, summaryFile: null });
    const payload = deepFreeze({ schema: CLI_RESULT_SCHEMA, mode: P.mode, primaryOutcome, runExitCode, tailUncertain: st.tailUncertain, interruptObserved: P.interruptObserved,
      preflight: P.preflight, source: P.source, planCode: P.planCode, plan: P.plan, bindings: P.bindings, credential: P.credential, requestsAttempted: P.requestsAttempted,
      internalCode: P.internalCode, summary: P.summary, finalize: P.finalize });
    let fileText = null;
    try { if (redactionOk(payload, dynamic)) { const t = `${canonicalJson(payload)}\n`; if (apply(ENCODE, ENCODER, [t]).length <= MAX_PAYLOAD_BYTES) fileText = t; } } catch { fileText = null; }
    let summaryFile = "NOT_ATTEMPTED"; let closeState = "NOT_OPENED";
    if (st.ran && fileText !== null && out) {
      const w = await writeSummary(out.fs, out.target, apply(ENCODE, ENCODER, [fileText]));
      summaryFile = w.summaryFile; closeState = w.closeState;
    }
    const exitCode = exitFor({ primaryOutcome, ran: st.ran, tailUncertain: st.tailUncertain, summaryFile: st.ran ? summaryFile : null });
    let env = { schema: CLI_STDOUT_SCHEMA, payload: fileText === null ? null : payload, output: { summaryFile, summaryCloseState: closeState }, exitCode, primaryOutcome,
      tailUncertain: st.tailUncertain };
    let line = canonicalJson(env);
    if (apply(ENCODE, ENCODER, [line]).length > MAX_STDOUT_BYTES || !redactionOk(env, dynamic)) { env = { ...env, payload: null }; line = canonicalJson(env); }
    return deepFreeze({ exitCode, primaryOutcome, tailUncertain: st.tailUncertain, summaryFile, summaryCloseState: closeState, stdoutLine: line });
  };

  // (1) argv
  const top = dataExactly(input, ["argv", "deps"]);
  if (!top) return finish("CLI_DEPS_INVALID");
  const a = argvSnapshot(top.argv);
  if (a === null) return finish("CLI_USAGE");
  const parsed = parseArgv(a);
  P.mode = parsed.mode; st.mode = parsed.mode;
  if (parsed.usage) return finish("CLI_USAGE");
  const { mode, flags } = parsed;
  // (1b) deps — exact per-mode set
  const d = depsFor(mode, top.deps);
  if (!d) return finish("CLI_DEPS_INVALID");
  interrupt = d.interrupt;
  const execute = mode === "execute";
  const INT = () => intNow();
  if (INT()) return finish("CLI_INTERRUPTED");

  // (2) env (C1, pure)
  const env = evaluateProbeEnvironment(d.envSnapshot);
  P.preflight = env;
  if (INT()) return finish("CLI_INTERRUPTED");
  if (execute && !env.ok) return finish("CLI_ENV_REFUSED");

  // (3) source — consistency of the INJECTED digest (real enforcement is the CLOSED entrypoint's pre-import check)
  const want = flags["--expect-source-digest"];
  P.source = { sourceDigest: d.sourceDigest, matches: want === undefined || d.sourceDigest === null ? null : d.sourceDigest === want };
  if (d.sourceDigest !== null) dynamic.add(d.sourceDigest);
  if (execute && d.sourceDigest === null) return finish("CLI_SOURCE_UNREADABLE");
  if (execute && d.sourceDigest !== want) return finish("CLI_SOURCE_MISMATCH");

  // (4) plan
  const pr = await callOnce(d.readPlanFile, [flags["--plan"]], INT);
  if (INT()) return finish("CLI_INTERRUPTED");
  const bytes = pr !== null && pr.ok ? ownedBytes(pr.v, MAX_PLAN_BYTES) : null;
  if (bytes === null) return finish("CLI_PLAN_UNREADABLE");
  const pf = planFromBytes(bytes);
  if (!pf.plan) { P.planCode = pf.code; return finish("CLI_PLAN_INVALID"); }
  const plan = pf.plan;
  dynamic.add(plan.planHash); for (const v of Object.values(plan.metadata)) dynamic.add(v);
  P.plan = { planHash: plan.planHash, probes: [...plan.probes], maxRequests: plan.probes.length, metadata: { ...plan.metadata } };

  // (5) bindings
  const nodeVersion = od(d.envSnapshot, "nodeVersion");
  const cmp = (flag, eq) => (flags[flag] === undefined ? null : eq);
  P.bindings = { planHash: cmp("--expect-plan-hash", plan.planHash === flags["--expect-plan-hash"]),
    requests: cmp("--expect-requests", String(plan.probes.length) === flags["--expect-requests"]),
    nodeVersion: typeof nodeVersion === "string" ? plan.metadata.nodeVersion === nodeVersion : false,
    approvalRef: cmp("--approval-ref", plan.metadata.approvalRef === flags["--approval-ref"]) };
  if (!execute) return finish("CLI_INSPECT_OK");
  if (!Object.values(P.bindings).every((x) => x === true)) return finish("CLI_BINDING_MISMATCH");
  const expectRequests = plan.probes.length;

  // (6) output-parent preflight — before any secret
  const out = d.outputFs; const target = flags["--summary-out"]; const parent = dirname(target);
  if ((parent === "/" ? 1 : parent.split("/").length) > MAX_ANCESTORS) return finish("CLI_OUTPUT_PARENT_INVALID");
  const fsCall = async (fn, args) => { const r = await callOnce(fn, args, INT); return r; };
  const real = async (p) => { const r = await fsCall(out.realpath, [p]); return r !== null && r.ok && canonical(r.v, true) ? r.v : null; };
  const lst = async (p) => { const r = await fsCall(out.lstat, [p]); if (r === null) return { bad: true }; if (!r.ok) { const c = errCode(r.e); return c === "ENOENT" || c === "ENOTDIR" ? { absent: true } : { bad: true }; }
    const s = statRecord(r.v); return s ? { s } : { bad: true }; };
  const rp = await real(parent); if (INT()) return finish("CLI_INTERRUPTED");
  if (rp !== parent) return finish("CLI_OUTPUT_PARENT_INVALID");
  const ps = await lst(parent); if (INT()) return finish("CLI_INTERRUPTED");
  if (!ps.s || ps.s.kind !== "dir" || ps.s.uid !== out.uid || (ps.s.mode & 0o022) !== 0) return finish("CLI_OUTPUT_PARENT_INVALID");
  const rr = await real(d.repoRoot); if (INT()) return finish("CLI_INTERRUPTED");
  if (rr === null || within(parent, rr) || within(target, rr)) return finish("CLI_OUTPUT_PARENT_INVALID");
  for (let dir = parent; ; dir = dirname(dir)) {
    const g = await lst(join(dir, ".git")); if (INT()) return finish("CLI_INTERRUPTED");
    if (!g.absent) return finish("CLI_OUTPUT_PARENT_INVALID");
    if (dir === "/") break;
  }
  const ts = await fsCall(out.lstat, [target]); if (INT()) return finish("CLI_INTERRUPTED");
  if (ts === null) return finish("CLI_OUTPUT_PARENT_INVALID");
  if (ts.ok) return finish("CLI_OUTPUT_EXISTS");
  if (errCode(ts.e) !== "ENOENT") return finish("CLI_OUTPUT_PARENT_INVALID");

  // (7) credentials (C1, accepted as is); the capability stays private and is dropped on every path
  const needs = { hostaway: plan.probes.some((x) => x.startsWith("P-H")), stripe: plan.probes.some((x) => x.startsWith("P-S")) };
  if (INT()) return finish("CLI_INTERRUPTED");
  const cr = await readProbeCredentialFile({ path: flags["--credentials"], repoRoot: d.repoRoot, needs, fs: d.credentialFs });
  if (!cr.ok) { P.credential = { code: cr.code, closeState: cr.closeState }; return finish("CLI_CREDENTIAL_REFUSED"); }
  P.credential = { code: "CRED_OK", closeState: cr.closeState };
  let creds = cr.credentials;
  if (INT()) { creds = null; return finish("CLI_INTERRUPTED"); }

  // (8) X → T → P, direct; the primitive is passed explicitly and counted (guard unreachable through accepted P: one send per probe)
  let attempted = 0;
  const primRequest = d.primitive.request;
  const counted = freeze({ Agent: d.primitive.Agent, request(options) { attempted += 1; if (attempted > expectRequests) throw new Error("E7_REQUEST_LIMIT"); return apply(primRequest, undefined, [options]); } });
  const sends = {};
  const internal = (code) => { creds = null; P.internalCode = code; return finish("CLI_INTERNAL"); };
  if (needs.hostaway) {
    const x = createE7RealExchange({ provider: "hostaway", primitive: counted }); if (!x.ok) return internal(x.code);
    const t = createE7HostawaySend({ exchange: x.exchange, credential: () => (creds === null ? null : creds.hostawayToken) }); if (!t.ok) return internal(t.code);
    sends.hostaway = t.transport;
  }
  if (needs.stripe) {
    const x = createE7RealExchange({ provider: "stripe", primitive: counted }); if (!x.ok) return internal(x.code);
    const t = createE7StripeTestSend({ exchange: x.exchange, credential: () => (creds === null ? null : creds.stripeTestKey), accountId: plan.stripe.accountId,
      apiVersion: plan.metadata.stripeVersion });
    if (!t.ok) return internal(t.code);
    sends.stripe = t.transport;
  }
  if (INT()) { creds = null; return finish("CLI_INTERRUPTED"); }               // last pre-run check, immediately before dispatch
  const run = runReadonlyProbes({ plan, ...sends, deps: { monotonic: d.monotonic, timers: d.timers }, signal: interrupt });
  if (!run.ok) return internal(run.code);

  // (9) the run has started: ALWAYS observe result + finalize; an interrupt is P's signal, never a pre-run refusal; evidence is written
  st.ran = true;
  const summary = await run.result;
  const fin = await run.finalize();
  creds = null;
  P.requestsAttempted = attempted;
  P.summary = summary; P.finalize = fin;
  st.tailUncertain = fin.tail === "UNSETTLED" || fin.tail === "UNOBSERVABLE" || fin.timerCleanup.cancelFailed + fin.timerCleanup.uncancellable > 0;
  const primary = summary.outcome === "STOPPED" ? "CLI_PROBE_STOPPED" : summary.probes.every((p) => p.outcome === "OK") ? "CLI_COMPLETED_OK" : "CLI_COMPLETED_INCONCLUSIVE";
  st.primaryOutcome = primary;
  // (10) payload → the ONE prescribed summary write (not stopped by an interrupt) → disposition
  return finish(primary, { fs: out, target });
}
