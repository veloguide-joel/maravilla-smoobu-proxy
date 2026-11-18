// lib/booking-db/pipeline-dispatch-transport.js — Stage E7 C109 (OFFLINE): a narrow, single-use GitHub `workflow_dispatch` TRANSPORT that
// implements the injected C108 consumer contract `dispatch(call, { signal })` (lib/booking-db/pipeline-kickoff.js). SHIPPED CLOSED and NOT
// WIRED: GITHUB_DISPATCH_CONSTANTS.enabled is FALSE, nothing in this repository constructs it, no route / cron / webhook / worker imports
// it, and no credential exists here — a future reviewed, secure execution step must inject a credential getter at construction. This
// module never reads environment variables. Tests inject a FAKE exchange or a FAKE node:https primitive only (no live HTTP).
//
// Official sources (verified for C109): GitHub REST "Create a workflow dispatch event"
//   POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches, body { ref, inputs (≤ 25 properties), return_run_details };
//   fine-grained permission "Actions" repository permissions (write). The 2026-02-19 changelog: without return_run_details the endpoint
//   returns 204 No Content; with it, 200 + run details. This transport pins X-GitHub-Api-Version 2022-11-28 (supported until 2028-03-10;
//   the default when the header is absent) and sends return_run_details:false; ONLY 204 + an empty, completed body is accepted.
//   "Get a reference" GET /repos/{owner}/{repo}/git/ref/heads/main → 200 { ref, node_id, url, object { type, sha, url } }; 404 / 409;
//   fine-grained permission "Contents" repository permissions (read).
//
// ONE invocation (single use, also under concurrency):
//   1. CLOSED / config not the reviewed config / second use → { notSent:true, code } before any credential value, import or network;
//   2. the EXACT frozen C108 call { workflow, ref, inputs } — workflow = the pinned workflow file, ref = main, inputs re-proved against
//      the ACCEPTED kickoff plan builder (exact 12 keys, server bindings, expected source / closure / plan hash). Anything else → notSent;
//   3. ONE read-only GET of refs/heads/main: it must be a commit whose SHA is the construction-time reviewed ENABLE pin (initially
//      9455bc9e…). Any failure / other SHA → notSent (provably 0 POST). The signal and the total deadline are re-checked right after the
//      GET and right before the POST; a late GET result after an abort / deadline never starts the POST;
//   4. ONE POST of { ref:'main', inputs, return_run_details:false }: 204 + empty completed body → { accepted:true } (HTTP acceptance
//      ONLY: no run id, no execution, no booking). EVERYTHING else once the POST was attempted — throw, timeout, abort, non-204, 3xx,
//      body, malformed / partial / lost reply — is { unknown:true, code }, which the consumer settles as dispatch_unknown and NEVER
//      re-dispatches. A typed notSent is returned ONLY when no POST was attempted. No retry, redirect, pagination or second request.
// GET → POST race (documented): main can move between the GET and the POST. The reviewed workflow's own checks (HEAD == dispatch SHA,
// source / closure / plan digests, executeEnabled, the normal `e7-readonly-probe` reviewer gate) remain authoritative; a different
// reviewed ENABLE commit needs a separately reviewed re-pin. This transport never approves, re-runs, merges or changes a workflow.
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import { kickoffDispatch, KickoffPlanRefusal, PINNED_REVISION, WORKFLOW_INPUT_KEYS } from "../checkout/pipeline-kickoff-plan.js";

const freeze = Object.freeze;
/** C119 S4: the transport's DEFAULT GET pin when no explicit release binding is passed = the historic C102 ENABLE commit 9455bc9e. Main can never
 *  equal it again, so a transport constructed WITHOUT a binding always returns notSent MAIN_NOT_PINNED_ENABLE (fail-closed). It does NOT identify
 *  the reviewed ENABLE runner bytes (PINNED_REVISION does); the kickoff runtime always passes its own github.sha as the binding. */
export const TRANSPORT_DEFAULT_MAIN_PIN = "9455bc9ee15370b5321b7a04a96e893e9e80080b";
const OWNER = "veloguide-joel"; const REPO = "maravilla-smoobu-proxy";
export const GITHUB_DISPATCH_CONSTANTS = freeze({
  enabled: false,                                                                    // SHIPPED CLOSED
  host: "api.github.com", port: 443, owner: OWNER, repo: REPO,
  workflowFile: PINNED_REVISION.workflowFile, ref: "main",
  expectedMainSha: TRANSPORT_DEFAULT_MAIN_PIN,                                       // C119 S4: a NAMED historic default (see below), not PINNED_REVISION
  getPath: `/repos/${OWNER}/${REPO}/git/ref/heads/main`,
  postPath: `/repos/${OWNER}/${REPO}/actions/workflows/${PINNED_REVISION.workflowFile}/dispatches`,
  apiVersion: "2022-11-28", accept: "application/vnd.github+json", userAgent: "maravilla-e7-pipeline-kickoff/1",
  getTimeoutMs: 8000, postTimeoutMs: 12000, totalTimeoutMs: 22000,                   // all < the consumer's dispatchTimeoutMs (30000)
  maxGetBytes: 8192, maxPostResponseBytes: 2048, maxPostBodyBytes: 4096
});
const CONFIG_KEYS = freeze(Object.keys(GITHUB_DISPATCH_CONSTANTS));
export const AGENT_OPTIONS = freeze({ keepAlive: false, maxSockets: 1, maxCachedSessions: 0 });
export const NODE_HTTPS_PRIMITIVE = freeze({ request: httpsRequest, Agent: HttpsAgent });
// C112 F1: GitHub built-in token shapes. Classic opaque tokens ([A-Za-z0-9_], 20..255) AND the stateless `ghs_` installation /
// Actions GITHUB_TOKEN format (a ghs_-prefixed JWT, ~520 chars, dots / hyphens / underscores; GitHub's recommended match
// ghs_[A-Za-z0-9.\-_]{36,}, https://github.blog/changelog/2026-05-15-github-app-installation-tokens-per-request-override-header/).
// OPAQUE: the token is never decoded or parsed and no claim is trusted. The character set excludes whitespace, CR / LF and every control
// character (no header injection); the length is capped (finite, well above the documented ~520).
export const TOKEN_MAX_LENGTH = 2048;
const TOKEN_CLASSIC_RE = /^[A-Za-z0-9_]{20,255}$/;
const TOKEN_GHS_RE = /^ghs_[A-Za-z0-9._-]{36,2044}$/;
/** githubTokenRefusal(token) → null when the shape is supported; else "CREDENTIAL_EMPTY" | "CREDENTIAL_INVALID" (no value-derived detail) */
export function githubTokenRefusal(token) {
  if (typeof token !== "string") return "CREDENTIAL_INVALID";
  if (token.length === 0) return "CREDENTIAL_EMPTY";
  if (token.length > TOKEN_MAX_LENGTH) return "CREDENTIAL_INVALID";
  return TOKEN_CLASSIC_RE.test(token) || TOKEN_GHS_RE.test(token) ? null : "CREDENTIAL_INVALID";
}
const SHA_RE = /^[0-9a-f]{40}$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * C110-F2: descriptor-only snapshot of an untrusted object (the C37 / C38 discipline): Reflect.ownKeys must be EXACTLY `keys` (strings, in
 * order; any hidden / symbol / extra / missing key refuses), the prototype Object.prototype or null, and every property an OWN, ENUMERABLE
 * DATA property whose value passes `ok`. No accessor is ever invoked (no [[Get]]); a proxy trap that throws → null (code-only). Returns a
 * fresh frozen plain object (exact key order) or null. Callers validate and use ONLY the snapshot.
 */
export function dataSnapshot(o, keys, ok) {
  try {
    if (o === null || typeof o !== "object" || Array.isArray(o)) return null;
    const proto = Reflect.getPrototypeOf(o);
    if (proto !== Object.prototype && proto !== null) return null;
    const own = Reflect.ownKeys(o);
    if (own.length !== keys.length || own.some((k, i) => k !== keys[i])) return null;
    const out = {};
    for (const k of keys) {
      const d = Reflect.getOwnPropertyDescriptor(o, k);
      if (!d || !Object.hasOwn(d, "value") || d.enumerable !== true || Object.hasOwn(d, "get") || Object.hasOwn(d, "set") || !ok(d.value, k)) return null;
      out[k] = d.value;
    }
    return freeze(out);
  } catch { return null; }
}
const isPrim = (v) => v === null || ["string", "number", "boolean"].includes(typeof v);

/** C110-F2: the config is snapshotted ONCE (data only) and must equal the shipped one apart from `enabled` → { snap } | { why } */
function configSnapshot(c) {
  const snap = dataSnapshot(c, CONFIG_KEYS, isPrim);
  if (snap === null) return { why: "CONFIG_REFUSED" };
  for (const k of CONFIG_KEYS) if (k !== "enabled" && snap[k] !== GITHUB_DISPATCH_CONSTANTS[k]) return { why: "CONFIG_REFUSED" };
  if (!SHA_RE.test(snap.expectedMainSha) || typeof snap.enabled !== "boolean") return { why: "CONFIG_REFUSED" };
  return { snap };
}

/** C110-F2/F3: the inputs snapshot (12 string data properties) re-proved through the ACCEPTED kickoff builder → null | code */
function inputsRefusal(i) {
  let again;
  try {
    again = kickoffDispatch({ intentId: i.intent_id, ref: i.booking_ref, authorizedVersion: Number(i.expected_version), paymentIntentId: i.payment_intent_id,
      amountMinor: Number(i.amount_minor), currency: i.currency, listingId: 606998, notBefore: i.not_before });
  } catch (e) { return e instanceof KickoffPlanRefusal ? `INPUTS_NOT_BOUND:${e.code}`.slice(0, 96) : "INPUTS_NOT_BOUND"; }
  for (const k of WORKFLOW_INPUT_KEYS) if (again.inputs[k] !== i[k]) return "INPUTS_NOT_BOUND";
  if (String(Number(i.expected_version)) !== i.expected_version || String(Number(i.amount_minor)) !== i.amount_minor) return "INPUTS_NOT_BOUND";
  return null;
}
const isStr = (v) => typeof v === "string";
/** the ONE approved POST body, serialized from a validated inputs SNAPSHOT */
export const dispatchBodyFor = (inputs) => Buffer.from(JSON.stringify({ ref: "main", inputs, return_run_details: false }), "utf8");
/** C110-F3: an independently validated POST body → a private copy of the approved bytes | null (fixed grammar; the exact 12 bound inputs) */
export function approvedDispatchBody(body) {
  if (!Buffer.isBuffer(body) || body.length < 2 || body.length > GITHUB_DISPATCH_CONSTANTS.maxPostBodyBytes) return null;
  const copy = Buffer.from(body);                                                    // a private copy: the caller's Buffer is never read again
  let j;
  try { j = JSON.parse(copy.toString("utf8")); } catch { return null; }
  const top = dataSnapshot(j, ["ref", "inputs", "return_run_details"], () => true);
  if (top === null || top.ref !== "main" || top.return_run_details !== false) return null;
  const inputs = dataSnapshot(top.inputs, WORKFLOW_INPUT_KEYS, isStr);
  if (inputs === null || inputsRefusal(inputs) !== null) return null;
  const approved = dispatchBodyFor(inputs);
  return approved.equals(copy) ? approved : null;
}

// =================================================================================================================================
// the narrow exchange: ONE node:https request to api.github.com:443, exactly two shapes, own non-keep-alive Agent, bounded time / body
export class GithubExchangeError extends Error { constructor(code) { super("GITHUB_EXCHANGE_ERROR"); this.code = code; freeze(this); } }

/**
 * createGithubExchange({ primitive? }) → exchange({ kind: 'getMain' | 'dispatch', token, body?, signal, timeoutMs }) →
 *   Promise<frozen { status, contentType, contentEncoding, bytes (Buffer), complete:true }> | rejects GithubExchangeError(code)
 * No I/O until invoked. TLS: rejectUnauthorized true, servername = host, system CAs (no ca / cert / proxy / lookup override). Never follows
 * a redirect (3xx resolves with an empty body, unread). Accept-Encoding: identity; any other content-encoding → rejected. Every bound
 * includes headers + body; a timeout / abort destroys request, response and Agent; timers are always cleared.
 */
export function createGithubExchange({ primitive = NODE_HTTPS_PRIMITIVE } = {}) {
  const C = GITHUB_DISPATCH_CONSTANTS;
  // C110-F3: per-instance phase, advanced SYNCHRONOUSLY before any socket and never reset: fresh → (ONE GET) → get_ok (only after that GET
  // resolved 200) → (ONE POST) → spent. A repeated / concurrent POST, a third call, a GET after the POST, a POST before (or after a failed)
  // GET → code-only EXCHANGE_PHASE_REFUSED, no request created.
  let phase = "fresh";
  return function exchange(spec) {
    const s = dataSnapshot(spec, Reflect.ownKeys(spec ?? {}).filter((k) => typeof k === "string"), () => true);
    const { kind, token, body = null, signal, timeoutMs } = s ?? {};
    let sendBody = null;
    if (s !== null && kind === "getMain" && phase === "fresh") phase = "get_pending";
    else if (s !== null && kind === "dispatch" && phase === "get_ok") { phase = "spent"; sendBody = approvedDispatchBody(body); }
    else {
      const ok = s !== null && (kind === "getMain" || kind === "dispatch");
      if (ok) phase = "spent";
      return Promise.reject(new GithubExchangeError(ok ? "EXCHANGE_PHASE_REFUSED" : "EXCHANGE_INPUT_INVALID"));
    }
    return new Promise((resolve, reject) => {
      let settled = false; let agent = null; let req = null; let res = null; let timer = null;
      const chunks = []; let total = 0;
      const max = kind === "getMain" ? C.maxGetBytes : C.maxPostResponseBytes;
      const teardown = () => {
        if (timer !== null) { clearTimeout(timer); timer = null; }
        if (signal) try { signal.removeEventListener("abort", onAbort); } catch { /* ignore */ }
        try { if (res) res.destroy(); } catch { /* ignore */ }
        try { if (req) req.destroy(); } catch { /* ignore */ }
        try { if (agent) agent.destroy(); } catch { /* ignore */ }
      };
      const fail = (code) => { if (settled) return; settled = true; if (kind === "getMain") phase = "spent"; teardown(); reject(new GithubExchangeError(code)); };
      const ok = (v) => { if (settled) return; settled = true; teardown(); if (kind === "getMain" && v.status === 200) phase = "get_ok"; else if (kind === "getMain") phase = "spent"; resolve(freeze(v)); };
      function onAbort() { fail("EXCHANGE_ABORTED"); }
      if ((kind !== "getMain" && kind !== "dispatch") || githubTokenRefusal(token) !== null
          || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > (kind === "getMain" ? C.getTimeoutMs : C.postTimeoutMs)
          || (kind === "getMain" && body !== null) || (kind === "dispatch" && sendBody === null)
          || !(signal instanceof AbortSignal)) { if (kind === "getMain") phase = "spent"; fail("EXCHANGE_INPUT_INVALID"); return; }
      if (signal.aborted) { if (kind === "getMain") phase = "spent"; fail("EXCHANGE_ABORTED"); return; }
      const headers = { Accept: C.accept, "X-GitHub-Api-Version": C.apiVersion, "User-Agent": C.userAgent, Authorization: `Bearer ${token}`, "Accept-Encoding": "identity" };
      if (kind === "dispatch") { headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(sendBody.length); }
      try {
        signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => fail("EXCHANGE_TIMEOUT"), timeoutMs);
        agent = new primitive.Agent(AGENT_OPTIONS);
        req = primitive.request({ protocol: "https:", host: C.host, port: C.port, servername: C.host, method: kind === "getMain" ? "GET" : "POST",
          path: kind === "getMain" ? C.getPath : C.postPath, headers, agent, rejectUnauthorized: true });
      } catch { fail("EXCHANGE_SETUP_FAILED"); return; }
      req.on("error", () => fail("EXCHANGE_NETWORK_ERROR"));
      req.on("response", (r) => {
        if (settled) { try { r.destroy(); } catch { /* ignore */ } return; }          // a late response after timeout / abort: never processed
        res = r;
        r.on("error", () => fail("EXCHANGE_PREMATURE_CLOSE"));
        r.on("aborted", () => fail("EXCHANGE_PREMATURE_CLOSE"));
        r.on("close", () => fail("EXCHANGE_PREMATURE_CLOSE"));                       // no-op once settled
        const status = r.statusCode; const h = isObj(r.headers) ? r.headers : {};
        const contentType = typeof h["content-type"] === "string" ? h["content-type"] : null;
        const contentEncoding = typeof h["content-encoding"] === "string" ? h["content-encoding"].trim().toLowerCase() : null;
        if (!Number.isSafeInteger(status) || status < 100 || status > 599) { fail("EXCHANGE_STATUS_INVALID"); return; }
        if (contentEncoding !== null && contentEncoding !== "identity") { fail("EXCHANGE_ENCODING_REFUSED"); return; }
        if (status >= 300 && status <= 399) { ok({ status, contentType, contentEncoding, bytes: Buffer.alloc(0), complete: true }); return; }   // never followed
        const cl = h["content-length"] !== undefined ? Number(h["content-length"]) : null;
        if (cl !== null && (!Number.isSafeInteger(cl) || cl < 0 || cl > max)) { fail("EXCHANGE_BODY_TOO_LARGE"); return; }
        r.on("data", (c) => { if (settled) return; const b = Buffer.isBuffer(c) ? c : Buffer.from(String(c)); total += b.length;
          if (total > max) { fail("EXCHANGE_BODY_TOO_LARGE"); return; } chunks.push(b); });
        r.on("end", () => ok({ status, contentType, contentEncoding, bytes: Buffer.concat(chunks, total), complete: true }));
      });
      try { if (kind === "dispatch") req.end(sendBody); else req.end(); } catch { fail("EXCHANGE_SETUP_FAILED"); }
    });
  };
}

// =================================================================================================================================
/**
 * createGithubWorkflowDispatch({ credential, constants?, exchange?, now? }) → dispatch(call, { signal }) (single use)
 *   credential: () => string — invoked ONLY after the gate, the config check and the call contract passed (never stored, logged or echoed)
 */
/**
 * C111 release binding: an OPTIONAL, explicit, construction-time reviewed release binding { expectedMainSha: <40 lowercase hex> } (descriptor-only
 * snapshot, exact single key). When present it REPLACES the default ENABLE pin as the SHA refs/heads/main must equal at the ONE GET; when
 * absent the default pin (9455bc9e…) applies. Everything else in the config stays fixed. It is NEVER taken from the call, a guest or any
 * request input: a trusted hosted wrapper derives it from its own workflow's exact github.sha AFTER proving (before any secret) that the
 * checked-out pipeline runner files frame to the accepted ENABLE source digest and its closure. A malformed binding → CONFIG_REFUSED before
 * any credential read or network.
 */
export function releaseBindingSnapshot(b) {
  if (b === undefined) return { sha: null };
  const s = dataSnapshot(b, ["expectedMainSha"], (v) => typeof v === "string" && SHA_RE.test(v));
  return s === null ? { why: "CONFIG_REFUSED" } : { sha: s.expectedMainSha };
}

export function createGithubWorkflowDispatch({ credential, constants = GITHUB_DISPATCH_CONSTANTS, exchange = null, now = Date.now, releaseBinding } = {}) {
  const notSent = (code) => freeze({ notSent: true, code });
  const unknown = (code) => freeze({ unknown: true, code });
  let used = false;
  const cfg = configSnapshot(constants);                                             // C110-F2: ONE data-only snapshot at construction
  const rb = releaseBindingSnapshot(releaseBinding);                                 // C111: ONE data-only snapshot at construction
  const configWhy = cfg.why ?? rb.why ?? null;
  const C0 = cfg.snap ?? GITHUB_DISPATCH_CONSTANTS;
  const C = rb.sha ? freeze({ ...C0, expectedMainSha: rb.sha }) : C0;
  return async function dispatch(call, opts) {
    if (used) return notSent("TRANSPORT_SINGLE_USE");
    used = true;                                                                     // synchronously: a concurrent second call loses
    if (configWhy !== null) return notSent(configWhy);
    if (C.enabled !== true) return notSent("TRANSPORT_CLOSED");
    if (typeof credential !== "function") return notSent("CREDENTIAL_ABSENT");
    // ---- the exact frozen C108 call: ONE descriptor-only snapshot, re-proved through the ACCEPTED kickoff plan builder ----
    const snapCall = callSnapshot(call);
    if (snapCall.why) return notSent(snapCall.why);
    const why = callRefusal(snapCall.call, C);
    if (why) return notSent(why);
    const o = dataSnapshot(opts, ["signal"], (v) => v instanceof AbortSignal);
    const signal = o === null ? null : o.signal;
    if (signal === null) return notSent("SIGNAL_ABSENT");
    if (signal.aborted) return notSent("ABORTED_BEFORE_GET");
    const deadline = now() + C.totalTimeoutMs;
    const left = (cap) => Math.min(cap, deadline - now());
    let token;
    try { token = credential(); } catch { return notSent("CREDENTIAL_UNAVAILABLE"); }
    const tokenWhy = githubTokenRefusal(token);
    if (tokenWhy !== null) return notSent(tokenWhy);
    const ex = exchange ?? createGithubExchange();
    // ---- ONE read-only GET of refs/heads/main → the reviewed ENABLE pin ----
    let g;
    try { const t = left(C.getTimeoutMs); if (t < 1) return notSent("DEADLINE_BEFORE_GET"); g = await ex({ kind: "getMain", token, signal, timeoutMs: t }); }
    catch { return notSent(signal.aborted ? "ABORTED_DURING_GET" : "MAIN_READ_FAILED"); }
    if (signal.aborted) return notSent("ABORTED_AFTER_GET");                         // a late GET result never starts the POST
    if (now() >= deadline) return notSent("DEADLINE_AFTER_GET");
    const mw = mainRefusal(g, C);
    if (mw) return notSent(mw);
    const body = dispatchBodyFor(snapCall.call.inputs);                              // serialized ONLY from the validated snapshot
    if (body.length > C.maxPostBodyBytes) return notSent("BODY_TOO_LARGE");
    const t2 = left(C.postTimeoutMs);
    if (signal.aborted) return notSent("ABORTED_BEFORE_POST");
    if (t2 < 1) return notSent("DEADLINE_BEFORE_POST");
    // ---- ONE POST: from here on, nothing is provably unsent ----
    let p;
    try { p = await ex({ kind: "dispatch", token, body, signal, timeoutMs: t2 }); }
    catch (e) { return unknown(e instanceof GithubExchangeError ? `POST_${e.code}` : "POST_THREW"); }
    // C110-F1: terminal classification AFTER the await — a cancellation or the total deadline reached while the POST was outstanding is
    // UNKNOWN (it may have been sent); a late 204 can never upgrade it. Still ONE POST, never re-sent.
    if (signal.aborted) return unknown("POST_ABORTED_BEFORE_REPLY_ACCEPTED");
    if (now() >= deadline) return unknown("POST_DEADLINE_BEFORE_REPLY_ACCEPTED");
    if (!isObj(p) || p.complete !== true || !Buffer.isBuffer(p.bytes)) return unknown("POST_REPLY_MALFORMED");
    if (p.status === 204 && p.bytes.length === 0) return freeze({ accepted: true });
    return unknown(p.status >= 300 && p.status <= 399 ? "POST_REDIRECT" : p.status === 200 ? "POST_200_NOT_ACCEPTED" : "POST_STATUS_NOT_204");
  };
}

/** C110-F2: the C108 call → ONE descriptor-only snapshot { call: { workflow, ref, inputs(snapshot) } } | { why }; frozen originals required */
export function callSnapshot(call) {
  let frozen = false;
  try { frozen = Object.isFrozen(call) && call !== null && typeof call === "object"; } catch { frozen = false; }
  if (!frozen) return { why: "CALL_CONTRACT_REFUSED" };
  const top = dataSnapshot(call, ["workflow", "ref", "inputs"], (v, k) => (k === "inputs" ? v !== null && typeof v === "object" : isStr(v)));
  if (top === null) return { why: "CALL_CONTRACT_REFUSED" };
  let inFrozen = false;
  try { inFrozen = Object.isFrozen(top.inputs); } catch { inFrozen = false; }
  if (!inFrozen) return { why: "INPUTS_REFUSED" };
  const inputs = dataSnapshot(top.inputs, WORKFLOW_INPUT_KEYS, isStr);
  if (inputs === null) return { why: "INPUTS_REFUSED" };
  return { call: freeze({ workflow: top.workflow, ref: top.ref, inputs }) };
}

/** the C108 call contract over a SNAPSHOT: workflow / ref pinned; inputs re-derived from their own server bindings by the accepted builder */
export function callRefusal(snap, C = GITHUB_DISPATCH_CONSTANTS) {
  if (snap.workflow !== C.workflowFile) return "WORKFLOW_REFUSED";
  if (snap.ref !== C.ref) return "REF_REFUSED";
  return inputsRefusal(snap.inputs);
}

/** strict allowlist of the GET refs/heads/main reply → null | notSent code */
function mainRefusal(g, C) {
  if (!isObj(g) || g.complete !== true || !Buffer.isBuffer(g.bytes)) return "MAIN_READ_INVALID";
  if (g.status !== 200) return "MAIN_READ_STATUS";
  if (typeof g.contentType !== "string" || !/^application\/json(\s*;|$)/i.test(g.contentType)) return "MAIN_READ_INVALID";
  if (g.contentEncoding !== null && g.contentEncoding !== "identity") return "MAIN_READ_INVALID";
  let j;
  try { j = JSON.parse(g.bytes.toString("utf8")); } catch { return "MAIN_READ_INVALID"; }
  if (!isObj(j) || j.ref !== "refs/heads/main" || !isObj(j.object) || j.object.type !== "commit" || typeof j.object.sha !== "string" || !SHA_RE.test(j.object.sha)) {
    return "MAIN_READ_INVALID";
  }
  if (j.object.sha !== C.expectedMainSha) return "MAIN_NOT_PINNED_ENABLE";
  return null;
}
