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
const TOKEN_EXPIRY_SAFETY_MS = 60 * 1000;

// Optimisation only. May be empty on any given invocation.
let tokenCache = null; // { token: string, expiresAt: number }

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
async function mintAccessToken() {
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
    body
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

  // Documented activation delay.
  await sleep(TOKEN_ACTIVATION_DELAY_MS);

  return { token: data.access_token, expiresIn };
}

/**
 * Return a usable bearer token. Uses the in-memory cache when it is present and
 * not near expiry; otherwise mints a new one. Never assumes the cache exists.
 */
async function getAccessToken({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (
    !forceRefresh &&
    tokenCache &&
    typeof tokenCache.token === "string" &&
    (tokenCache.expiresAt === null || tokenCache.expiresAt - TOKEN_EXPIRY_SAFETY_MS > now)
  ) {
    return { token: tokenCache.token, source: "cache" };
  }

  const minted = await mintAccessToken();
  tokenCache = {
    token: minted.token,
    expiresAt: minted.expiresIn ? now + minted.expiresIn * 1000 : null
  };
  return { token: minted.token, source: "minted" };
}

/**
 * GET a Hostaway API path with bearer auth. On 401/403 the cached token is
 * discarded, a fresh one is minted, and the request is retried exactly once.
 * Returns { status, json, tokenSource, retried }.
 * Never includes the token in the return value or in logs.
 */
export async function hostawayGet(path, { query } = {}) {
  return hostawayRequest("GET", path, { query });
}

/**
 * POST a JSON body to a Hostaway API path. Same auth, retry and return
 * contract as hostawayGet. Stage D: used only for
 * POST /v1/listings/{id}/calendar/priceDetails (a calculation; creates nothing).
 */
export async function hostawayPost(path, body, { query } = {}) {
  return hostawayRequest("POST", path, { query, body });
}

async function hostawayRequest(method, path, { query, body } = {}) {
  const url = new URL(`${HOSTAWAY_API_BASE}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  let { token, source } = await getAccessToken();
  let retried = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = {
      Authorization: `Bearer ${token}`,
      "Cache-control": "no-cache",
      Accept: "application/json"
    };
    const init = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const resp = await fetch(url, init);

    if ((resp.status === 401 || resp.status === 403) && attempt === 0) {
      tokenCache = null;
      ({ token, source } = await getAccessToken({ forceRefresh: true }));
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
