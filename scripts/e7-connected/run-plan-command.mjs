// scripts/e7-connected/run-plan-command.mjs — E7 M2-F: the plan-only command (contract claude/e7-run-plan-v1.md §7). INSPECT ONLY.
//   * runPlanCommand({ argv, deps }) → native Promise<deep-frozen result>; never throws, never rejects.
//   * The mode is decided from argv FIRST; "execute" (EXECUTE_NOT_IMPLEMENTED) and anything else (USAGE) refuse before `deps` is read at all.
//   * Inspect binds the read-only deps once: envSnapshot (data), planClock (sync), readPlanFile / readSourceFiles (async, read-only by
//     contract). No process, env, fs, network, timer, credential, DB or provider access of its own; output is mechanically whitelisted.
import { types } from "node:util";
import { buildRunPackageV1, snapshotData, ownPlanBytes, RUN_PLAN_CLOSURE, PERMISSIONS_NONE, PLAN_CODES } from "./run-plan-v1.mjs";

export const CLI_RESULT_SCHEMA = "e7-run-plan-cli-result-v1";
export const OUTCOMES = Object.freeze(["INSPECT_OK", "PLAN_REFUSED", "EXECUTE_NOT_IMPLEMENTED", "USAGE", "DEPS_INVALID"]);
export const CODES = Object.freeze([...PLAN_CODES, "EXECUTE_NOT_IMPLEMENTED", "USAGE", "DEPS_INVALID", "PLAN_READ_FAILED", "SOURCE_READ_FAILED", "INTERNAL"]);
export const DEPS_KEYS = Object.freeze(["envSnapshot", "planClock", "readPlanFile", "readSourceFiles"]);

const freeze = Object.freeze;
const getProto = Object.getPrototypeOf;
const isFn = (f) => typeof f === "function" && !types.isProxy(f);
const result = (outcome, code, extra = {}) => freeze({ schema: CLI_RESULT_SCHEMA, outcome: OUTCOMES.includes(outcome) ? outcome : "PLAN_REFUSED",
  code: CODES.includes(code) ? code : "INTERNAL", executable: false, permissions: PERMISSIONS_NONE, ...extra });
const plainObj = (o) => o !== null && typeof o === "object" && !types.isProxy(o) && (getProto(o) === Object.prototype || getProto(o) === null);

/** the mode from argv ONLY (descriptor reads of `input.argv`; no other property of `input` is touched) */
function modeOf(input) {
  try {
    if (!plainObj(input)) return "USAGE";
    const ad = Object.getOwnPropertyDescriptor(input, "argv");
    if (!ad || !("value" in ad)) return "USAGE";
    const a = ad.value;
    if (!Array.isArray(a) || types.isProxy(a) || getProto(a) !== Array.prototype) return "USAGE";
    const d = Object.getOwnPropertyDescriptors(a);
    const len = d.length.value;
    if (!Number.isSafeInteger(len) || len < 1 || len > 4 || Reflect.ownKeys(d).length !== len + 1) return "USAGE";
    const first = d["0"] && "value" in d["0"] ? d["0"].value : undefined;
    if (typeof first !== "string") return "USAGE";
    if (first === "execute") return "EXECUTE";
    if (first !== "inspect" || len !== 1) return "USAGE";
    return "INSPECT";
  } catch { return "USAGE"; }
}

export function runPlanCommand(input) {
  return (async () => {
    const mode = modeOf(input);
    if (mode === "EXECUTE") return result("EXECUTE_NOT_IMPLEMENTED", "EXECUTE_NOT_IMPLEMENTED");
    if (mode !== "INSPECT") return result("USAGE", "USAGE");
    // ---- bind deps ONCE (descriptor-only; no getter executed) ----
    let deps;
    try {
      const dd = Object.getOwnPropertyDescriptor(input, "deps");
      const ks = Reflect.ownKeys(Object.getOwnPropertyDescriptors(input));
      if (ks.length !== 2 || !ks.includes("argv") || !ks.includes("deps") || !dd || !("value" in dd) || !plainObj(dd.value)) return result("DEPS_INVALID", "DEPS_INVALID");
      const d = Object.getOwnPropertyDescriptors(dd.value); const dk = Reflect.ownKeys(d);
      if (dk.length !== DEPS_KEYS.length || !DEPS_KEYS.every((k) => d[k] && "value" in d[k] && d[k].enumerable === true)) return result("DEPS_INVALID", "DEPS_INVALID");
      deps = freeze(Object.fromEntries(DEPS_KEYS.map((k) => [k, d[k].value])));
      if (!isFn(deps.planClock) || !isFn(deps.readPlanFile) || !isFn(deps.readSourceFiles)) return result("DEPS_INVALID", "DEPS_INVALID");
    } catch { return result("DEPS_INVALID", "DEPS_INVALID"); }
    // ---- synchronous reads first, BEFORE any await: one env snapshot, then the clock (typed, finite) ----
    const envSnap = snapshotData(deps.envSnapshot);
    if (envSnap === null) return result("PLAN_REFUSED", "ENV_REFUSED");
    let clock;
    try { clock = Reflect.apply(deps.planClock, undefined, []); } catch { return result("PLAN_REFUSED", "CLOCK_INVALID"); }
    if (typeof clock !== "number" || !Number.isSafeInteger(clock) || clock < 1) return result("PLAN_REFUSED", "CLOCK_INVALID");
    // ---- the two read-only reads (results copied immediately inside the pure builder) ----
    let planBytes; let sources;
    try { planBytes = await Reflect.apply(deps.readPlanFile, undefined, []); } catch { return result("PLAN_REFUSED", "PLAN_READ_FAILED"); }
    planBytes = ownPlanBytes(planBytes);                              // OWNED copy now: mutation during the next await is irrelevant
    if (planBytes === null) return result("PLAN_REFUSED", "PLAN_BYTES_INVALID");
    try { sources = await Reflect.apply(deps.readSourceFiles, undefined, [RUN_PLAN_CLOSURE]); } catch { return result("PLAN_REFUSED", "SOURCE_READ_FAILED"); }
    const built = buildRunPackageV1({ planBytes, sourceEntries: sources, envSnapshot: envSnap, planClock: clock });
    if (!built.ok) return result("PLAN_REFUSED", built.code);
    return result("INSPECT_OK", "PLAN_OK", { planHash: built.planHash, sourceDigest: built.sourceDigest, packageHash: built.packageHash, package: built.package });
  })().catch(() => result("PLAN_REFUSED", "INTERNAL"));
}
