// Hostaway Public API client — Stage A (read-only).
//
// Auth: OAuth2 client-credentials per https://api.hostaway.com/documentation
//   POST /v1/accessTokens  (application/x-www-form-urlencoded)
//   grant_type=client_credentials&client_id=<ACCOUNT_ID>&client_secret=<SECRET>&scope=general
//   -> { token_type: "Bearer", expires_in, access_token }
//
// Design constraints (owner, 2026-10-15):
//  - Correctness must NOT depend on an in-memory cache surviving between Vercel
//    invocations. The module-level cache below is an optimisation only; every
//    code path works from a cold start by minting a fresh token.
//  - Never log or return the client secret or the access token.
//  - Honour the documented activation delay: wait >= 1 s after minting before use.
//  - A 401/403 from the API invalidates the cached token; mint once more, retry once.

const HOSTAWAY_API_BASE = "https://api.hostaway.com/v1";
const TOKEN_ACTIVATION_DELAY_MS = 1100; // docs: "wait at least 1 second"
// C87: ONE finite budget for a whole token mint (request headers + body + the activation delay). On expiry the mint is aborted
// and rejected with HOSTAWAY_AUTH_TIMEOUT, the in-flight slot is cleared, and a LATER call starts a fresh mint.
const MINT_BUDGET_MS = 6000;
const timing = { mintBudgetMs: MINT_BUDGET_MS, activationDelayMs: TOKEN_ACTIVATION_DELAY_MS };
/** TEST-ONLY: shorten the mint budget / activation delay (offline fake-network tests). Never called by runtime code. */
export function _setHostawayTimingForTests({ mintBudgetMs, activationDelayMs } = {}) {
  if (Number.isFinite(mintBudgetMs) && mintBudgetMs > 0) timing.mintBudgetMs = mintBudgetMs;
  if (Number.isFinite(activationDelayMs) && activationDelayMs >= 0) timing.activationDelayMs = activationDelayMs;
}
const TOKEN_EXPIRY_SAFETY_MS = 60 * 1000;

// Optimisation only. May be empty on any given invocation.
let tokenCache = null; // { token: string, expiresAt: number }
// C85: single-flight mint. Concurrent callers on a cold (or just-invalidated) cache share ONE in-flight mint instead of
// minting one token each. Cleared when that mint settles (success or failure); a failed mint is never cached.
let mintInFlight = null;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(signal.reason); return; }
    const t = setTimeout(() => { if (signal) signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal.reason); };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}
const codedError = (message, code) => Object.assign(new Error(message), { code });
/** The reason a caller-owned signal was aborted, as a coded Error (never the provider payload). */
function abortReason(signal) {
  const r = signal && signal.reason;
  if (r instanceof Error && r.code) return r;
  return codedError("Hostaway request aborted", r && r.name === "TimeoutError" ? "HOSTAWAY_TIMEOUT" : "HOSTAWAY_ABORTED");
}
/** Wait for `p` on behalf of ONE caller: that caller's abort rejects only its own wait, never the shared promise. */
function waitFor(p, signal) {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then((v) => { signal.removeEventListener("abort", onAbort); resolve(v); }, (e) => { signal.removeEventListener("abort", onAbort); reject(e); });
  });
}

export function getHostawayEnvStatus() {
  const missing = [];
  if (!process.env.HOSTAWAY_ACCOUNT_ID) missing.push("HOSTAWAY_ACCOUNT_ID");
  if (!process.env.HOSTAWAY_CLIENT_SECRET) missing.push("HOSTAWAY_CLIENT_SECRET");
  return { ok: missing.length === 0, missing };
}

/**
 * Mint a new access token. Always performs the network call.
 * Returns { token, expiresIn } or throws an Error with .code / .upstreamStatus.
 */
async function mintAccessToken(signal) {
  const env = getHostawayEnvStatus();
  if (!env.ok) {
    const err = new Error("Hostaway credentials not configured");
    err.code = "HOSTAWAY_ENV_MISSING";
    err.missing = env.missing;
    throw err;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.HOSTAWAY_ACCOUNT_ID,
    client_secret: process.env.HOSTAWAY_CLIENT_SECRET,
    scope: "general"
  });

  const resp = await fetch(`${HOSTAWAY_API_BASE}/accessTokens`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-control": "no-cache"
    },
    body,
    signal
  });

  if (!resp.ok) {
    const err = new Error("Hostaway token request failed");
    err.code = "HOSTAWAY_AUTH_FAILED";
    err.upstreamStatus = resp.status;
    throw err;
  }

  let data = null;
  try {
    data = await resp.json();
  } catch {
    const err = new Error("Hostaway token response was not JSON");
    err.code = "HOSTAWAY_AUTH_INVALID";
    err.upstreamStatus = resp.status;
    throw err;
  }

  if (!data || typeof data.access_token !== "string" || !data.access_token) {
    const err = new Error("Hostaway token response missing access_token");
    err.code = "HOSTAWAY_AUTH_INVALID";
    err.upstreamStatus = resp.status;
    throw err;
  }

  const expiresIn = Number.isFinite(Number(data.expires_in)) ? Number(data.expires_in) : null;

  // Documented activation delay (inside the same mint budget).
  await sleep(timing.activationDelayMs, signal);

  return { token: data.access_token, expiresIn };
}

/**
 * Return a usable bearer token. Uses the in-memory cache when it is present and
 * not near expiry; otherwise mints a new one. Never assumes the cache exists.
 */
async function getAccessToken({ forceRefresh = false, signal = null } = {}) {
  const now = Date.now();
  if (
    !forceRefresh &&
    tokenCache &&
    typeof tokenCache.token === "string" &&
    (tokenCache.expiresAt === null || tokenCache.expiresAt - TOKEN_EXPIRY_SAFETY_MS > now)
  ) {
    return { token: tokenCache.token, source: "cache" };
  }

  if (signal && signal.aborted) throw abortReason(signal);              // C87: an aborted caller never starts a mint
  if (!mintInFlight) mintInFlight = startMint(now);
  return { token: await waitFor(mintInFlight, signal), source: "minted" };
}

/** C87: ONE shared, budget-bounded mint. Cancelled by its own budget only (never by one waiter); cleared on settle. */
function startMint(now) {
  const ac = new AbortController();
  const expired = codedError("Hostaway token mint exceeded its budget", "HOSTAWAY_AUTH_TIMEOUT");
  let timer;
  const budget = new Promise((_, reject) => { timer = setTimeout(() => { ac.abort(expired); reject(expired); }, timing.mintBudgetMs); });
  const work = (async () => {
    const minted = await mintAccessToken(ac.signal);
    if (ac.signal.aborted) throw expired;                              // never cache a token from an expired mint
    tokenCache = { token: minted.token, expiresAt: minted.expiresIn ? now + minted.expiresIn * 1000 : null };
    return minted.token;
  })();
  const p = Promise.race([work, budget]).catch((e) => { throw ac.signal.aborted ? expired : e; }).finally(() => {
    clearTimeout(timer);
    if (mintInFlight === p) mintInFlight = null;                        // failure / expiry / success: a later call starts fresh
  });
  work.catch(() => {});                                                 // a late rejection of the abandoned work is not unhandled
  p.catch(() => {});
  return p;
}

/**
 * GET a Hostaway API path with bearer auth. On 401/403 the cached token is
 * discarded, a fresh one is minted, and the request is retried exactly once.
 * Returns { status, json, tokenSource, retried }.
 * Never includes the token in the return value or in logs.
 */
export async function hostawayGet(path, { query, timeoutMs, signal } = {}) {
  return hostawayRequest("GET", path, { query, timeoutMs, signal });
}

/**
 * POST a JSON body to a Hostaway API path. Same auth, retry and return
 * contract as hostawayGet. Stage D: used only for
 * POST /v1/listings/{id}/calendar/priceDetails (a calculation; creates nothing).
 */
export async function hostawayPost(path, body, { query, timeoutMs, signal } = {}) {
  return hostawayRequest("POST", path, { query, body, timeoutMs, signal });
}

// `timeoutMs` (optional, Stage F1): aborts the data request after the given
// time (AbortError propagates to the caller). Omitted => previous behaviour.
// `signal` (optional, C87): the caller's WHOLE-operation signal — it bounds the token wait, every data attempt (headers + body)
// and the single 401 refresh / retry; once aborted no further request is started.
async function hostawayRequest(method, path, { query, body, timeoutMs, signal = null } = {}) {
  const url = new URL(`${HOSTAWAY_API_BASE}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  let { token, source } = await getAccessToken({ signal });
  let retried = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = {
      Authorization: `Bearer ${token}`,
      "Cache-control": "no-cache",
      Accept: "application/json"
    };
    if (signal && signal.aborted) throw abortReason(signal);
    const init = { method, headers };
    const signals = [];
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
    if (signal) signals.push(signal);
    if (signals.length) init.signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const resp = await fetch(url, init);

    if ((resp.status === 401 || resp.status === 403) && attempt === 0) {
      // C85: invalidate only the token THIS request used; if a concurrent request already replaced it, reuse the newer
      // token (or join the in-flight mint) instead of minting again. Still exactly one retry per request.
      if (signal && signal.aborted) throw abortReason(signal);            // C87: no refresh / retry after the caller's deadline
      if (tokenCache && tokenCache.token === token) tokenCache = null;
      ({ token, source } = await getAccessToken({ signal }));
      retried = true;
      continue;
    }

    let json = null;
    const text = await resp.text();
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    return { status: resp.status, json, tokenSource: source, retried };
  }

  // Unreachable in practice (loop returns on the second attempt), kept for safety.
  const err = new Error("Hostaway request failed after token refresh");
  err.code = "HOSTAWAY_AUTH_FAILED";
  throw err;
}
