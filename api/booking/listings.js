// GET /api/booking/listings — Stage F1 public, read-only listing feed
// (owner-authorized 2026-10-17). Supplies the Hostaway pilot properties to
// consumer/booking-test.html.
//
// Security model (differs from api/hostaway/* diagnostics, which stay private):
//  - No secrets involved on the client side; Hostaway is called server-side
//    with the same lib/hostaway.js client. HOSTAWAY_DIAG_KEY is never read.
//  - Inventory is a fixed allowlist chosen SERVER-SIDE by lib/public-catalog.js:
//    the two pilots by default (always in production); the pilots + the exact
//    28 migrated listings only when MV_PUBLIC_CATALOG=migrated-preview on a
//    preview/development deployment (C85). No query parameters are accepted or
//    echoed; the client never supplies ids.
//  - Output is built by lib/listing-public.js (whitelist by construction) and
//    re-checked against PUBLIC_LISTING_KEYS before sending. No _schema/_meta,
//    no upstream status codes, no error details in the public body.
//  - CORS: explicit origin allowlist (booking-ui DEV preview + localhost dev
//    ports), extendable via BOOKING_UI_ORIGINS (comma-separated). Requests
//    from other origins get no Access-Control-Allow-Origin header.
//  - Timeouts: per-request upstream timeout + overall deadline, so a hung
//    Hostaway call turns into a 502 instead of a hanging function.
//  - Caching: per-instance memory cache (optimisation only, TTL 10 min; it
//    stores the body only — CORS and cache headers are computed per request).
//    Browser/CDN: `Cache-Control: no-store` on EVERY response (C2, 2026-10-19).
//    Why: Vercel adds a weak ETag and answers revalidations with a 304 that
//    omits Access-Control-Allow-Origin. A copy cached for one allowlisted
//    origin was revalidated by another, kept the first origin's ACAO and failed
//    CORS persistently (each 304 renewed it) — see C1 audit. D3a (allowlisted
//    origins only cacheable) narrowed but did not remove that. Vary: Origin stays.
//  - No prices. Currency only. No Smoobu data.

import { getHostawayEnvStatus, hostawayGet } from "../../lib/hostaway.js";
import { PUBLIC_LISTING_KEYS, toPublicListing } from "../../lib/listing-public.js";
import { resolvePublicCatalog, LISTINGS_FETCH_CONCURRENCY } from "../../lib/public-catalog.js";
import { applyPublicCors, withDeadline } from "../../lib/public-api.js"; // shared allowlist (F2)

const UPSTREAM_TIMEOUT_MS = 8000;   // per listing request (after token mint)
const OVERALL_DEADLINE_MS = 20000;  // whole handler, incl. token mint + retry
const CACHE_TTL_MS = 10 * 60 * 1000;
// C85: no NEW listing request starts after this point, so every started request (UPSTREAM_TIMEOUT_MS) still ends
// before OVERALL_DEADLINE_MS; listings not started in time are reported as missing (partial), never as a 502 of the whole feed.
const START_CUTOFF_MS = OVERALL_DEADLINE_MS - UPSTREAM_TIMEOUT_MS - 1000;

// Optimisation only; may be empty on any invocation (Vercel instances are not shared).
let cache = null; // { mode:string, expiresAt:number, body:object } — scoped to the catalog mode that produced it

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

export async function buildBody(ids, { concurrency = LISTINGS_FETCH_CONCURRENCY, startCutoffMs = START_CUTOFF_MS, fetchOne = fetchPublicListing, now = Date.now } = {}) {
  // C85: bounded concurrency (<= `concurrency` requests in flight; lib/hostaway.js mints ONE token for all of them),
  // catalog order preserved, no retry beyond the client's single 401 refresh, no new request after the start cutoff.
  const t0 = now();
  const results = new Array(ids.length);
  let next = 0;
  const lane = async () => {
    for (;;) {
      const i = next++;
      if (i >= ids.length) return;
      const id = ids[i];
      if (now() - t0 > startCutoffMs) { results[i] = { ok: false, id, error: "NOT_STARTED_DEADLINE" }; continue; }
      results[i] = await fetchOne(id).catch((err) => ({ ok: false, id, error: err?.code || err?.name || "FETCH_FAILED" }));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, ids.length)) }, lane));
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

  // C2: never browser-cacheable, for any origin (see the Caching note above).
  const okCacheControl = "no-store";

  const catalog = resolvePublicCatalog();
  if (catalog.reason) console.error("[booking/listings] catalog fell back to pilot", { reason: catalog.reason });
  const now = Date.now();
  if (cache && cache.mode === catalog.mode && cache.expiresAt > now) {
    res.setHeader("Cache-Control", okCacheControl);
    res.setHeader("X-Listings-Cache", "hit");
    res.status(200).json(cache.body);
    return;
  }

  try {
    const result = await withDeadline(buildBody(catalog.ids), OVERALL_DEADLINE_MS, "listings");
    if (!result.ok) {
      res.setHeader("Cache-Control", "no-store");
      res.status(result.status).json(result.body);
      return;
    }
    if (!result.body.partial) cache = { mode: catalog.mode, expiresAt: Date.now() + CACHE_TTL_MS, body: result.body }; // only cache complete answers, per catalog mode
    res.setHeader("Cache-Control", okCacheControl);
    res.setHeader("X-Listings-Cache", "miss");
    res.status(200).json(result.body);
  } catch (err) {
    console.error("[booking/listings] failed", { code: err?.code || err?.name || "UNKNOWN", upstreamStatus: err?.upstreamStatus ?? null });
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ ok: false, error: "LISTINGS_UNAVAILABLE" });
  }
}
