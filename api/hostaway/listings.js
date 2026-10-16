// GET /api/hostaway/listings — Stage A read-only diagnostic (owner-approved design,
// hostaway-readiness-2026-10-15.md §5b).
//
// - Requires header `x-admin-key` equal to env HOSTAWAY_DIAG_KEY (constant-time
//   comparison). Without it: 401, and Hostaway is never contacted.
// - No CORS headers on purpose: this is not called from a browser page.
// - Returns ONLY whitelisted listing fields plus key names / value types of the
//   upstream response. Never raw listing objects, secrets, tokens, or guest data.

import { createHash, timingSafeEqual } from "node:crypto";
import { getHostawayEnvStatus, hostawayGet } from "../../lib/hostaway.js";

// Fields the booking UI is expected to need. Anything not listed is dropped.
const LISTING_FIELD_WHITELIST = [
  "id",
  "name",
  "internalListingName",
  "externalListingName",
  "personCapacity",
  "bedroomsNumber",
  "bathroomsNumber",
  "city",
  "countryCode",
  "currencyCode",
  "minNights",
  "maxNights"
];

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  // Hash both sides so lengths always match before the constant-time compare.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function describeType(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array(${v.length})`;
  return typeof v;
}

function keyTypes(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = describeType(obj[k]);
  return out;
}

function sanitizeListing(raw) {
  const out = {};
  const absent = [];
  for (const f of LISTING_FIELD_WHITELIST) {
    if (raw && Object.prototype.hasOwnProperty.call(raw, f)) out[f] = raw[f];
    else absent.push(f);
  }
  return { listing: out, absent };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
    return;
  }

  // --- Authentication (before anything else, before any upstream call) ---
  const diagKey = process.env.HOSTAWAY_DIAG_KEY;
  if (!diagKey) {
    // Endpoint is disabled unless explicitly configured.
    res.status(503).json({ ok: false, error: "DIAGNOSTIC_DISABLED" });
    return;
  }
  const presented = req.headers["x-admin-key"];
  const presentedStr = Array.isArray(presented) ? presented[0] : presented;
  if (!safeEqual(presentedStr, diagKey)) {
    res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    return;
  }

  // --- Env guard (names only, never values) ---
  const env = getHostawayEnvStatus();
  if (!env.ok) {
    res.status(500).json({ ok: false, error: "HOSTAWAY_ENV_MISSING", missing: env.missing });
    return;
  }

  try {
    const { status, json, tokenSource, retried } = await hostawayGet("/listings", {
      query: { limit: 50 }
    });

    if (status < 200 || status >= 300 || !json) {
      res.status(502).json({
        ok: false,
        error: "HOSTAWAY_UPSTREAM_FAILED",
        upstream: { status }
      });
      return;
    }

    // Hostaway documents { status, result, ... } for most endpoints; be tolerant.
    const rawList = Array.isArray(json) ? json : Array.isArray(json.result) ? json.result : null;
    if (!rawList) {
      res.status(502).json({
        ok: false,
        error: "HOSTAWAY_UPSTREAM_UNEXPECTED_SHAPE",
        upstream: { status },
        _schema: { wrapperKeys: keyTypes(json) }
      });
      return;
    }

    const sanitized = rawList.map(sanitizeListing);
    const absentUnion = [...new Set(sanitized.flatMap((s) => s.absent))];

    res.status(200).json({
      ok: true,
      count: rawList.length,
      listings: sanitized.map((s) => s.listing),
      _schema: {
        wrapperKeys: Array.isArray(json) ? "(bare array)" : keyTypes(json),
        listingKeys: keyTypes(rawList[0]) || null,
        whitelistedFieldsAbsent: absentUnion
      },
      _meta: {
        upstreamStatus: status,
        tokenSource, // "minted" | "cache" — observability only; never the token itself
        retriedAfterAuthError: retried
      }
    });
  } catch (err) {
    const code = err?.code || "HOSTAWAY_REQUEST_FAILED";
    const httpStatus = code === "HOSTAWAY_ENV_MISSING" ? 500 : 502;
    const payload = { ok: false, error: code };
    if (err?.upstreamStatus) payload.upstream = { status: err.upstreamStatus };
    if (err?.missing) payload.missing = err.missing;
    // Log only the code and upstream status — never the message chain, which could
    // in theory carry upstream body text.
    console.error("[hostaway/listings] failed", { code, upstreamStatus: err?.upstreamStatus ?? null });
    res.status(httpStatus).json(payload);
  }
}
