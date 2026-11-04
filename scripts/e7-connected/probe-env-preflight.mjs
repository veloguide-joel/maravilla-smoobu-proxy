// scripts/e7-connected/probe-env-preflight.mjs — E7 probe CLI stage C1 (OFFLINE): PURE evaluation of an explicitly SUPPLIED environment
// snapshot. Contract: claude/e7-connected-probe-cli-contract.md rev 2 (accepted at 34903dec) §2.1 + C1 map (§10).
//   * Never reads `process`, env, fs, clock or network. The result evaluates the snapshot it is given; it is NOT an attestation that the
//     running process actually has those properties (only the later, CLOSED C3 entrypoint would build the snapshot).
//   * Descriptor-only, getter-free input checks: proxies (incl. revoked), accessors, symbol keys, extra / missing keys and wrong types are
//     refused with a fixed code; every public result is deep-frozen.
import { types } from "node:util";

export const ENV_SNAPSHOT_SCHEMA = "e7-probe-env-snapshot-v1";
export const SUPPORTED_NODE_VERSIONS = Object.freeze(["22.22.0", "24.22.1"]);
export const SUPPORTED_PLATFORMS = Object.freeze(["linux", "darwin"]);
/** presence keys: the first eight are REFUSED when present (conservative proposal); the six proxy names are report-only */
export const REFUSED_VARIABLES = Object.freeze(["NODE_OPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY", "NODE_DEBUG",
  "NODE_DEBUG_NATIVE", "SSLKEYLOGFILE", "OPENSSL_CONF"]);
export const PROXY_VARIABLES = Object.freeze(["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"]);
export const PRESENT_KEYS = Object.freeze([...REFUSED_VARIABLES, ...PROXY_VARIABLES]);
export const ENV_CODES = Object.freeze(["ENV_OK", "ENV_SNAPSHOT_INVALID", "ENV_NODE_UNSUPPORTED", "ENV_PLATFORM_UNSUPPORTED", "ENV_EXEC_FLAGS", "ENV_VARIABLE_REFUSED", "ENV_UID_UNAVAILABLE"]);
export const ENV_CHECK_KEYS = Object.freeze(["nodeVersionSupported", "platformSupported", "execArgvEmpty", "refusedVariablesAbsent", "uidAvailable", "proxyVariablesPresent"]);

const freeze = Object.freeze;
const { isProxy } = types;
const SNAPSHOT_KEYS = ["schema", "nodeVersion", "platform", "execArgvCount", "uidAvailable", "present"];
/** own enumerable DATA properties exactly `keys` of a plain or null-prototype object → null-proto copy, or null; never runs a getter */
function dataExactly(o, keys) {
  try {
    if (o === null || typeof o !== "object" || isProxy(o) || Array.isArray(o)) return null;
    const p = Object.getPrototypeOf(o); if (p !== Object.prototype && p !== null) return null;
    const d = Object.getOwnPropertyDescriptors(o); const ks = Reflect.ownKeys(d);
    if (ks.length !== keys.length) return null;
    const out = Object.create(null);
    for (const k of ks) { if (typeof k !== "string" || !keys.includes(k) || !("value" in d[k]) || d[k].enumerable !== true) return null; out[k] = d[k].value; }
    return out;
  } catch { return null; }
}
const result = (code, checks) => freeze({ ok: code === "ENV_OK", code, checks: freeze({ ...checks }) });
const NONE = freeze(Object.fromEntries(ENV_CHECK_KEYS.map((k) => [k, false])));

/** evaluateProbeEnvironment(snapshot) → frozen { ok, code, checks } — never throws, never reads the process */
export function evaluateProbeEnvironment(snapshot) {
  const s = dataExactly(snapshot, SNAPSHOT_KEYS);
  if (!s || s.schema !== ENV_SNAPSHOT_SCHEMA || typeof s.nodeVersion !== "string" || s.nodeVersion.length > 32 || typeof s.platform !== "string" || s.platform.length > 16
      || !Number.isSafeInteger(s.execArgvCount) || s.execArgvCount < 0 || s.execArgvCount > 1024 || typeof s.uidAvailable !== "boolean") return result("ENV_SNAPSHOT_INVALID", NONE);
  const pr = dataExactly(s.present, PRESENT_KEYS);
  if (!pr || !PRESENT_KEYS.every((k) => typeof pr[k] === "boolean")) return result("ENV_SNAPSHOT_INVALID", NONE);
  const checks = {
    nodeVersionSupported: SUPPORTED_NODE_VERSIONS.includes(s.nodeVersion),
    platformSupported: SUPPORTED_PLATFORMS.includes(s.platform),
    execArgvEmpty: s.execArgvCount === 0,
    refusedVariablesAbsent: REFUSED_VARIABLES.every((k) => pr[k] === false),
    uidAvailable: s.uidAvailable,
    proxyVariablesPresent: PROXY_VARIABLES.some((k) => pr[k] === true)            // report-only: required-proxy connectivity is unsupported
  };
  const code = !checks.nodeVersionSupported ? "ENV_NODE_UNSUPPORTED" : !checks.platformSupported ? "ENV_PLATFORM_UNSUPPORTED" : !checks.execArgvEmpty ? "ENV_EXEC_FLAGS"
    : !checks.refusedVariablesAbsent ? "ENV_VARIABLE_REFUSED" : !checks.uidAvailable ? "ENV_UID_UNAVAILABLE" : "ENV_OK";
  return result(code, checks);
}
