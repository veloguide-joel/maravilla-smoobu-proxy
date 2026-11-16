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
const OWNER = "veloguide-joel"; const REPO = "maravilla-smoobu-proxy";
export const GITHUB_DISPATCH_CONSTANTS = freeze({
  enabled: false,                                                                    // SHIPPED CLOSED
  host: "api.github.com", port: 443, owner: OWNER, repo: REPO,
  workflowFile: PINNED_REVISION.workflowFile, ref: "main",
  expectedMainSha: PINNED_REVISION.wrapperCommit,                                    // construction-time reviewed ENABLE pin (9455bc9e…)
  getPath: `/repos/${OWNER}/${REPO}/git/ref/heads/main`,
  postPath: `/repos/${OWNER}/${REPO}/actions/workflows/${PINNED_REVISION.workflowFile}/dispatches`,
  apiVersion: "2022-11-28", accept: "application/vnd.github+json", userAgent: "maravilla-e7-pipeline-kickoff/1",
  getTimeoutMs: 8000, postTimeoutMs: 12000, totalTimeoutMs: 22000,                   // all < the consumer's dispatchTimeoutMs (30000)
  maxGetBytes: 8192, maxPostResponseBytes: 2048, maxPostBodyBytes: 4096
});
const CONFIG_KEYS = freeze(Object.keys(GITHUB_DISPATCH_CONSTANTS));
export const AGENT_OPTIONS = freeze({ keepAlive: false, maxSockets: 1, maxCachedSessions: 0 });
export const NODE_HTTPS_PRIMITIVE = freeze({ request: httpsRequest, Agent: HttpsAgent });
const TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** the reviewed config must be exactly the shipped one apart from `enabled` (no host / path / workflow / ref / header / bound override) */
function configRefusal(c) {
  if (!isObj(c)) return "CONFIG_REFUSED";
  const keys = Object.keys(c);
  if (keys.length !== CONFIG_KEYS.length || keys.some((k, i) => k !== CONFIG_KEYS[i])) return "CONFIG_REFUSED";
  for (const k of CONFIG_KEYS) if (k !== "enabled" && c[k] !== GITHUB_DISPATCH_CONSTANTS[k]) return "CONFIG_REFUSED";
  if (!SHA_RE.test(c.expectedMainSha)) return "CONFIG_REFUSED";
  return null;
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
  return function exchange({ kind, token, body = null, signal, timeoutMs }) {
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
      const fail = (code) => { if (settled) return; settled = true; teardown(); reject(new GithubExchangeError(code)); };
      const ok = (v) => { if (settled) return; settled = true; teardown(); resolve(freeze(v)); };
      function onAbort() { fail("EXCHANGE_ABORTED"); }
      if ((kind !== "getMain" && kind !== "dispatch") || typeof token !== "string" || !TOKEN_RE.test(token)
          || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > (kind === "getMain" ? C.getTimeoutMs : C.postTimeoutMs)
          || (kind === "getMain" && body !== null) || (kind === "dispatch" && (!Buffer.isBuffer(body) || body.length < 2 || body.length > C.maxPostBodyBytes))
          || !(signal instanceof AbortSignal)) { fail("EXCHANGE_INPUT_INVALID"); return; }
      if (signal.aborted) { fail("EXCHANGE_ABORTED"); return; }
      const headers = { Accept: C.accept, "X-GitHub-Api-Version": C.apiVersion, "User-Agent": C.userAgent, Authorization: `Bearer ${token}`, "Accept-Encoding": "identity" };
      if (kind === "dispatch") { headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(body.length); }
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
      try { if (kind === "dispatch") req.end(body); else req.end(); } catch { fail("EXCHANGE_SETUP_FAILED"); }
    });
  };
}

// =================================================================================================================================
/**
 * createGithubWorkflowDispatch({ credential, constants?, exchange?, now? }) → dispatch(call, { signal }) (single use)
 *   credential: () => string — invoked ONLY after the gate, the config check and the call contract passed (never stored, logged or echoed)
 */
export function createGithubWorkflowDispatch({ credential, constants = GITHUB_DISPATCH_CONSTANTS, exchange = null, now = Date.now } = {}) {
  const notSent = (code) => freeze({ notSent: true, code });
  const unknown = (code) => freeze({ unknown: true, code });
  let used = false;
  const configWhy = configRefusal(constants);
  const C = configWhy === null ? constants : GITHUB_DISPATCH_CONSTANTS;
  return async function dispatch(call, opts = {}) {
    if (used) return notSent("TRANSPORT_SINGLE_USE");
    used = true;                                                                     // synchronously: a concurrent second call loses
    if (C.enabled !== true || configWhy !== null) return notSent(configWhy ?? "TRANSPORT_CLOSED");
    if (typeof credential !== "function") return notSent("CREDENTIAL_ABSENT");
    // ---- the exact frozen C108 call, re-proved through the ACCEPTED kickoff plan builder ----
    const why = callRefusal(call, C);
    if (why) return notSent(why);
    const signal = opts && opts.signal instanceof AbortSignal ? opts.signal : null;
    if (signal === null) return notSent("SIGNAL_ABSENT");
    if (signal.aborted) return notSent("ABORTED_BEFORE_GET");
    const deadline = now() + C.totalTimeoutMs;
    const left = (cap) => Math.min(cap, deadline - now());
    let token;
    try { token = credential(); } catch { return notSent("CREDENTIAL_UNAVAILABLE"); }
    if (typeof token !== "string" || !TOKEN_RE.test(token)) return notSent("CREDENTIAL_INVALID");
    const ex = exchange ?? createGithubExchange();
    // ---- ONE read-only GET of refs/heads/main → the reviewed ENABLE pin ----
    let g;
    try { const t = left(C.getTimeoutMs); if (t < 1) return notSent("DEADLINE_BEFORE_GET"); g = await ex({ kind: "getMain", token, signal, timeoutMs: t }); }
    catch { return notSent(signal.aborted ? "ABORTED_DURING_GET" : "MAIN_READ_FAILED"); }
    if (signal.aborted) return notSent("ABORTED_AFTER_GET");                         // a late GET result never starts the POST
    if (now() >= deadline) return notSent("DEADLINE_AFTER_GET");
    const mw = mainRefusal(g, C);
    if (mw) return notSent(mw);
    const body = Buffer.from(JSON.stringify({ ref: C.ref, inputs: orderedInputs(call.inputs), return_run_details: false }), "utf8");
    if (body.length > C.maxPostBodyBytes) return notSent("BODY_TOO_LARGE");
    const t2 = left(C.postTimeoutMs);
    if (signal.aborted) return notSent("ABORTED_BEFORE_POST");
    if (t2 < 1) return notSent("DEADLINE_BEFORE_POST");
    // ---- ONE POST: from here on, nothing is provably unsent ----
    let p;
    try { p = await ex({ kind: "dispatch", token, body, signal, timeoutMs: t2 }); }
    catch (e) { return unknown(e instanceof GithubExchangeError ? `POST_${e.code}` : "POST_THREW"); }
    if (!isObj(p) || p.complete !== true || !Buffer.isBuffer(p.bytes)) return unknown("POST_REPLY_MALFORMED");
    if (p.status === 204 && p.bytes.length === 0) return freeze({ accepted: true });
    return unknown(p.status >= 300 && p.status <= 399 ? "POST_REDIRECT" : p.status === 200 ? "POST_200_NOT_ACCEPTED" : "POST_STATUS_NOT_204");
  };
}

function orderedInputs(inputs) { const o = {}; for (const k of WORKFLOW_INPUT_KEYS) o[k] = inputs[k]; return o; }

/** the C108 call contract: frozen { workflow, ref, inputs } exactly; inputs re-derived from their own server bindings by the accepted builder */
export function callRefusal(call, C = GITHUB_DISPATCH_CONSTANTS) {
  if (!isObj(call) || !Object.isFrozen(call)) return "CALL_CONTRACT_REFUSED";
  const keys = Object.keys(call);
  if (keys.length !== 3 || keys[0] !== "workflow" || keys[1] !== "ref" || keys[2] !== "inputs") return "CALL_CONTRACT_REFUSED";
  if (call.workflow !== C.workflowFile) return "WORKFLOW_REFUSED";
  if (call.ref !== C.ref) return "REF_REFUSED";
  const i = call.inputs;
  if (!isObj(i) || !Object.isFrozen(i)) return "INPUTS_REFUSED";
  const ik = Object.keys(i);
  if (ik.length !== WORKFLOW_INPUT_KEYS.length || ik.some((k, n) => k !== WORKFLOW_INPUT_KEYS[n]) || ik.some((k) => typeof i[k] !== "string")) return "INPUTS_REFUSED";
  let again;
  try {
    again = kickoffDispatch({ intentId: i.intent_id, ref: i.booking_ref, authorizedVersion: Number(i.expected_version), paymentIntentId: i.payment_intent_id,
      amountMinor: Number(i.amount_minor), currency: i.currency, listingId: 606998, notBefore: i.not_before });
  } catch (e) { return e instanceof KickoffPlanRefusal ? `INPUTS_NOT_BOUND:${e.code}`.slice(0, 96) : "INPUTS_NOT_BOUND"; }
  for (const k of WORKFLOW_INPUT_KEYS) if (again.inputs[k] !== i[k]) return "INPUTS_NOT_BOUND";
  if (String(Number(i.expected_version)) !== i.expected_version || String(Number(i.amount_minor)) !== i.amount_minor) return "INPUTS_NOT_BOUND";
  return null;
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
