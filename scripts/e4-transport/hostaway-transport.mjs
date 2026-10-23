// E4 — injected single-attempt Hostaway transport for the OFFLINE happy-path runner (not instantiated anywhere).
//
// createHostawayTransport({ fetchImpl, getCredentials, ... }) -> { send(request) }. Every dependency is injected:
// nothing here reads the environment, a file, a prompt or a global fetch, and nothing in the repository constructs
// it (the happy-path CLI keeps execution disabled). Lives under scripts/ (excluded from every Vercel deployment).
//
// Auth (same documented flow as lib/hostaway.js): POST /v1/accessTokens, form-encoded client_credentials with
// scope=general, then the documented >= 1 s activation delay. Differences, by design:
//  - at most ONE token mint per transport (= per run); a failed mint is final: every later send returns
//    { transportError, code: "AUTH_UNAVAILABLE" } without a network call;
//  - NO 401/403 re-mint and NO retry of anything: each send is exactly one fetch; a 401 is returned as is;
//  - credentials are requested once (getCredentials) and dropped after the mint; neither the secret nor the token is
//    ever returned, thrown, logged or stored outside the closure.
// Requests: only GET/POST/PUT; a path of plain segments under the fixed base (no "..", "//", "?", "#", "%", host
// change); query values must be strings/finite numbers/booleans; a JSON body only for POST/PUT. Anything else is
// refused WITHOUT a network call. Every fetch has a timeout (AbortSignal).

export const HOSTAWAY_BASE = "https://api.hostaway.com/v1";
export const TOKEN_ACTIVATION_DELAY_MS = 1100;
const PATH_RE = /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Safe failure diagnostics (allowlisted; re-validated by the runner's sanitizeTransportDiag). Built only from fixed
// codes, an integer HTTP status, the error's NAME class and an allowlisted low-level cause code — never the provider
// body, error.message, stack, URL, account id, secret or token.
const CAUSE_CODES = Object.freeze(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH",
  "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID"]);
function errorClass(err) {
  const name = err && typeof err.name === "string" ? err.name : "";
  const errorKind = name === "TimeoutError" ? "TIMEOUT" : name === "AbortError" ? "ABORTED" : name === "TypeError" ? "FETCH_TYPE_ERROR" : "OTHER";
  const raw = err && isObj(err.cause) && typeof err.cause.code === "string" ? err.cause.code : (err && typeof err.code === "string" ? err.code : null);
  const causeCode = raw === null ? "NONE" : CAUSE_CODES.includes(raw) ? raw : "UNLISTED";
  return { errorKind, causeCode };
}
const diag = (stage, code, extra = {}) => Object.freeze({ stage, code, ...extra });
const failure = (code, d) => Object.freeze({ transportError: true, code, diag: d });

export function createHostawayTransport({ fetchImpl, getCredentials, timeoutMs = 15000, sleep = defaultSleep,
  activationDelayMs = TOKEN_ACTIVATION_DELAY_MS } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl required");
  if (typeof getCredentials !== "function") throw new TypeError("getCredentials required");
  if (!(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60000)) throw new TypeError("timeoutMs invalid");
  let token = null;
  let mintState = "none";              // none | ok | failed
  let mintPromise = null;
  let mintDiag = null;                 // why the single mint failed (allowlisted), reused for every later send
  let fetches = 0;

  async function mintOnce() {
    const fail = (d) => { token = null; mintState = "failed"; mintDiag = d; };
    let creds;
    try { creds = await getCredentials(); } catch { return fail(diag("TOKEN", "TOKEN_LOCAL_INPUT_INVALID")); }
    const accountId = isObj(creds) ? creds.accountId : undefined;
    const clientSecret = isObj(creds) ? creds.clientSecret : undefined;
    creds = null;
    if (typeof accountId !== "string" || !/^[1-9]\d{0,15}$/.test(accountId) || typeof clientSecret !== "string" || !clientSecret) {
      return fail(diag("TOKEN", "TOKEN_LOCAL_INPUT_INVALID"));                     // nothing sent
    }
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: accountId, client_secret: clientSecret, scope: "general" });
    let resp;
    try {
      fetches++;
      resp = await fetchImpl(`${HOSTAWAY_BASE}/accessTokens`, { method: "POST", body, redirect: "error",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-control": "no-cache" }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) { return fail(diag("TOKEN", "TOKEN_NETWORK_FAILED", errorClass(err))); }
    const httpStatus = Number.isSafeInteger(resp?.status) ? resp.status : undefined;
    const st = httpStatus === undefined ? {} : { httpStatus };
    if (!resp || !resp.ok) return fail(diag("TOKEN", "TOKEN_HTTP_REFUSED", st));         // body never read or kept
    let data = null;
    try { data = await resp.json(); } catch { data = null; }
    if (!isObj(data) || typeof data.access_token !== "string" || !data.access_token) return fail(diag("TOKEN", "TOKEN_RESPONSE_INVALID", st));
    try {
      token = data.access_token;
      await sleep(activationDelayMs);
      mintState = "ok";
    } catch { fail(diag("TOKEN", "TOKEN_RESPONSE_INVALID", st)); }
  }

  function buildUrl(req) {
    if (!isObj(req) || !["GET", "POST", "PUT"].includes(req.method) || typeof req.path !== "string" || !PATH_RE.test(req.path)) return null;
    const q = req.query === undefined ? {} : req.query;
    if (!isObj(q)) return null;
    if (req.body !== undefined && !(req.method === "POST" || req.method === "PUT")) return null;
    if ((req.method === "POST" || req.method === "PUT") && !isObj(req.body)) return null;
    const url = new URL(`${HOSTAWAY_BASE}${req.path}`);
    for (const [k, v] of Object.entries(q)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k)) return null;
      if (!(typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)))) return null;
      url.searchParams.set(k, String(v));
    }
    if (url.origin !== "https://api.hostaway.com" || !url.pathname.startsWith("/v1/")) return null;
    return url;
  }

  async function send(req) {
    const url = buildUrl(req);
    if (!url) return failure("REQUEST_REFUSED", diag("REQUEST", "REQUEST_REFUSED_LOCAL"));
    if (mintState === "none") { mintPromise = mintPromise || mintOnce(); await mintPromise; }
    if (mintState !== "ok" || !token) return failure("AUTH_UNAVAILABLE", mintDiag ?? diag("TOKEN", "TOKEN_RESPONSE_INVALID"));
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/json", "Cache-control": "no-cache" };
    const init = { method: req.method, headers, redirect: "error", signal: AbortSignal.timeout(timeoutMs) };
    if (req.body !== undefined) { headers["Content-Type"] = "application/json"; init.body = JSON.stringify(req.body); }
    let resp;
    try { fetches++; resp = await fetchImpl(url.toString(), init); }
    catch (err) { return failure("TRANSPORT_ERROR", diag("REQUEST", "REQUEST_NETWORK_FAILED", errorClass(err))); }
    let text = "";
    try { text = await resp.text(); } catch (err) { return failure("TRANSPORT_ERROR", diag("REQUEST", "REQUEST_BODY_READ_FAILED", errorClass(err))); }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return Object.freeze({ httpStatus: resp.status, json });
  }

  return Object.freeze({ send, usage: () => Object.freeze({ fetches, mintState }) });
}
