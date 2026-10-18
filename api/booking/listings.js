// GET /api/booking/listings — Stage F1 public, read-only listing feed
// (owner-authorized 2026-10-17). Supplies the Hostaway pilot properties to
// consumer/booking-test.html.
//
// Security model (differs from api/hostaway/* diagnostics, which stay private):
//  - No secrets involved on the client side; Hostaway is called server-side
//    with the same lib/hostaway.js client. HOSTAWAY_DIAG_KEY is never read.
//  - Inventory is a fixed allowlist (PUBLIC_LISTING_IDS). No query parameters
//    are accepted or echoed.
//  - Output is built by lib/listing-public.js (whitelist by construction) and
//    re-checked against PUBLIC_LISTING_KEYS before sending. No _schema/_meta,
//    no upstream status codes, no error details in the public body.
//  - CORS: explicit origin allowlist (booking-ui DEV preview + localhost dev
//    ports), extendable via BOOKING_UI_ORIGINS (comma-separated). Requests
//    from other origins get no Access-Control-Allow-Origin header.
//  - Timeouts: per-request upstream timeout + overall deadline, so a hung
//    Hostaway call turns into a 502 instead of a hanging function.
//  - Caching: per-instance memory cache (optimisation only, TTL 10 min) and
//    `Cache-Control: private, max-age=300` for the browser. Deliberately not
//    CDN-cached (`s-maxage`) for now: CDN caching plus per-origin CORS headers
//    needs Vary:Origin behaviour verified on Vercel first.
//    D3a (2026-10-18): the browser copy is made ONLY for requests carrying an
//    allowlisted Origin (the response then has Access-Control-Allow-Origin).
//    Any other request (direct visit, curl, unlisted origin) gets `no-store`.
//    Vary: Origin alone was proven insufficient: a cached no-Origin copy was
//    reused for a later cross-origin fetch and failed CORS.
//  - No prices. Currency only. No Smoobu data.

import { getHostawayEnvStatus, hostawayGet } from "../../lib/hostaway.js";
import { PUBLIC_LISTING_IDS, PUBLIC_LISTING_KEYS, toPublicListing } from "../../lib/listing-public.js";
import { applyPublicCors, withDeadline } from "../../lib/public-api.js"; // shared allowlist (F2)

const UPSTREAM_TIMEOUT_MS = 8000;   // per listing request (after token mint)
const OVERALL_DEADLINE_MS = 20000;  // whole handler, incl. token mint + retry
const CACHE_TTL_MS = 10 * 60 * 1000;
const BROWSER_MAX_AGE_S = 300;

// Optimisation only; may be empty on any invocation (Vercel instances are not shared).
let cache = null; // { expiresAt:number, body:object }

async function fetchPublicListing(id) {
  const { status, json } = await hostawayGet(`/listings/${id}`, { query: { includeResources: 1 }, timeoutMs: UPSTREAM_TIMEOUT_MS });
  if (status < 200 || status >= 300 || !json || typeof json !== "object") {
    return { ok: false, id, error: "UPSTREAM_STATUS", upstreamStatus: status };
  }
  const raw = json.result && typeof json.result === "object" && !Array.isArray(json.result) ? json.result : null;
  const mapped = toPublicListing(raw, id);
  if (!mapped.ok) return { ok: false, id, error: mapped.error };
  // Final guard: nothing outside the public key whitelist leaves this function.
  for (const k of Object.keys(mapped.listing)) {
    if (!PUBLIC_LISTING_KEYS.includes(k)) return { ok: false, id, error: "UNEXPECTED_KEY" };
  }
  return { ok: true, id, listing: mapped.listing };
}

async function buildBody() {
  // Sequential on purpose: parallel calls on a cold instance would each mint a
  // token (the token cache is filled by the first completed mint). Two ids ->
  // ~0.5 s extra at most; revisit with single-flight minting if the list grows.
  const results = [];
  for (const id of PUBLIC_LISTING_IDS) {
    results.push(await fetchPublicListing(id).catch((err) => ({ ok: false, id, error: err?.code || err?.name || "FETCH_FAILED" })));
  }
  const listings = results.filter((r) => r.ok).map((r) => r.listing);
  const failed = results.filter((r) => !r.ok);
  for (const f of failed) {
    // Server-side only: id + coarse reason. Never the payload, never credentials.
    console.error("[booking/listings] listing unavailable", { id: f.id, error: f.error, upstreamStatus: f.upstreamStatus ?? null });
  }
  if (!listings.length) return { ok: false, status: 502, body: { ok: false, error: "LISTINGS_UNAVAILABLE" } };
  const body = { ok: true, checkedAt: new Date().toISOString(), listings };
  if (failed.length) body.partial = true; // some inventory missing; ids are not disclosed
  return { ok: true, status: 200, body };
}

export default async function handler(req, res) {
  const corsAllowed = applyPublicCors(req, res);

  if (req.method === "OPTIONS") {
    // Preflight: 204 for allowed origins, 403 otherwise (no CORS headers were set).
    res.status(corsAllowed ? 204 : 403).end();
    return;
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    res.setHeader("Cache-Control", "no-store");
    res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
    return;
  }

  const env = getHostawayEnvStatus();
  if (!env.ok) {
    // Public body must not name the missing variables.
    console.error("[booking/listings] hostaway env missing", { missing: env.missing });
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ ok: false, error: "LISTINGS_UNAVAILABLE" });
    return;
  }

  // Browser-cacheable only when CORS headers are present on this response (see D3a note above).
  const okCacheControl = corsAllowed ? `private, max-age=${BROWSER_MAX_AGE_S}` : "no-store";

  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    res.setHeader("Cache-Control", okCacheControl);
    res.setHeader("X-Listings-Cache", "hit");
    res.status(200).json(cache.body);
    return;
  }

  try {
    const result = await withDeadline(buildBody(), OVERALL_DEADLINE_MS, "listings");
    if (!result.ok) {
      res.setHeader("Cache-Control", "no-store");
      res.status(result.status).json(result.body);
      return;
    }
    if (!result.body.partial) cache = { expiresAt: Date.now() + CACHE_TTL_MS, body: result.body }; // only cache complete answers
    res.setHeader("Cache-Control", okCacheControl);
    res.setHeader("X-Listings-Cache", "miss");
    res.status(200).json(result.body);
  } catch (err) {
    console.error("[booking/listings] failed", { code: err?.code || err?.name || "UNKNOWN", upstreamStatus: err?.upstreamStatus ?? null });
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ ok: false, error: "LISTINGS_UNAVAILABLE" });
  }
}
