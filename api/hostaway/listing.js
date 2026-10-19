// GET /api/hostaway/listing?id=<pilotListingId> — Stage B read-only diagnostic.
//
// - Same auth gate as Stage A (x-admin-key, constant-time). Hostaway is never
//   contacted on a failed gate, a malformed id, or an id outside the pilot set.
// - Restricted to the two owner-approved pilot listings. Any other id -> 404
//   LISTING_NOT_IN_PILOT without an upstream call.
// - Calls GET /v1/listings/{id} and returns a SANITIZED detail view built for
//   the booking-UI field-mapping exercise: identity, capacity, public policy and
//   public pricing fields; image/amenity/bed-type STRUCTURE (key names + types)
//   plus a bounded sample of public values (first image URL, amenity names);
//   description length + short excerpt. Never: street address, coordinates,
//   contacts, invoicing, door/wifi codes, licence numbers, OTA account fields,
//   raw objects, secrets or tokens.

import { getHostawayEnvStatus, hostawayGet } from "../../lib/hostaway.js";
import { requireDiagKey } from "../../lib/diag-auth.js";
import { toPublicContent } from "../../lib/listing-content.js";
import { PUBLISH_DESCRIPTION } from "../../lib/listing-public.js";

// Owner-approved pilot inventory (Stage A evidence, 2026-10-16).
const PILOT_LISTING_IDS = new Set([603564, 603566]);

const IDENTITY_FIELDS = ["id", "name", "internalListingName", "externalListingName", "propertyTypeId", "roomType"];
const CAPACITY_FIELDS = ["personCapacity", "guestsIncluded", "bedroomsNumber", "bedsNumber", "bathroomsNumber", "bathroomType", "squareMeters"];
const LOCATION_FIELDS = ["city", "state", "country", "countryCode", "timeZoneName"]; // deliberately no street/zip/lat/lng
const POLICY_FIELDS = ["minNights", "maxNights", "checkInTimeStart", "checkInTimeEnd", "checkOutTime", "instantBookable", "allowSameDayBooking", "cancellationPolicy", "cancellationPolicyId"];
const PRICING_FIELDS = ["currencyCode", "price", "priceForExtraPerson", "cleaningFee", "checkinFee", "refundableDamageDeposit", "weeklyDiscount", "monthlyDiscount", "guestNightlyTax", "guestPerPersonPerNightTax", "guestStayTax", "propertyRentTax"];
const DESCRIPTION_EXCERPT_CHARS = 160;
const MAX_AMENITY_NAMES = 40;

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
function pick(raw, fields) {
  const out = {};
  const absent = [];
  for (const f of fields) {
    if (raw && Object.prototype.hasOwnProperty.call(raw, f)) out[f] = raw[f];
    else absent.push(f);
  }
  return { out, absent };
}
function parseListingId(q) {
  const v = Array.isArray(q) ? q[0] : q;
  if (typeof v !== "string" || !/^\d{1,12}$/.test(v)) return null;
  return Number(v);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
    return;
  }
  if (!requireDiagKey(req, res)) return;

  const id = parseListingId(req.query?.id);
  if (id === null) {
    res.status(400).json({ ok: false, error: "INVALID_LISTING_ID" });
    return;
  }
  if (!PILOT_LISTING_IDS.has(id)) {
    // Do not reveal whether the id exists upstream; do not call upstream.
    res.status(404).json({ ok: false, error: "LISTING_NOT_IN_PILOT" });
    return;
  }

  const env = getHostawayEnvStatus();
  if (!env.ok) {
    res.status(500).json({ ok: false, error: "HOSTAWAY_ENV_MISSING", missing: env.missing });
    return;
  }

  try {
    // includeResources=1: without it GET /v1/listings/{id} omits listingImages,
    // listingAmenities and listingBedTypes (verified live 2026-10-16: 0/0/0 vs
    // 16/19/0 on the list endpoint). Documented query parameter for listings.
    const { status, json, tokenSource, retried } = await hostawayGet(`/listings/${id}`, {
      query: { includeResources: 1 }
    });

    if (status < 200 || status >= 300 || !json) {
      res.status(502).json({ ok: false, error: "HOSTAWAY_UPSTREAM_FAILED", upstream: { status } });
      return;
    }
    const raw = json && typeof json.result === "object" && !Array.isArray(json.result) ? json.result : null;
    if (!raw) {
      res.status(502).json({
        ok: false,
        error: "HOSTAWAY_UPSTREAM_UNEXPECTED_SHAPE",
        upstream: { status },
        _schema: { wrapperKeys: keyTypes(json) }
      });
      return;
    }
    if (Number(raw.id) !== id) {
      res.status(502).json({ ok: false, error: "HOSTAWAY_UPSTREAM_ID_MISMATCH", upstream: { status } });
      return;
    }

    const identity = pick(raw, IDENTITY_FIELDS);
    const capacity = pick(raw, CAPACITY_FIELDS);
    const location = pick(raw, LOCATION_FIELDS);
    const policy = pick(raw, POLICY_FIELDS);
    const pricing = pick(raw, PRICING_FIELDS);

    // Images: structure + first public CDN URL only.
    const images = Array.isArray(raw.listingImages) ? raw.listingImages : [];
    const firstImage = images[0] || null;
    const imagesView = {
      count: images.length,
      itemKeys: keyTypes(firstImage),
      first: firstImage
        ? {
            url: typeof firstImage.url === "string" ? firstImage.url : null,
            caption: typeof firstImage.caption === "string" ? firstImage.caption : null,
            sortOrder: firstImage.sortOrder ?? null
          }
        : null,
      thumbnailUrl: typeof raw.thumbnailUrl === "string" ? raw.thumbnailUrl : null
    };

    // Amenities: structure + names (public marketing data), bounded.
    const amenities = Array.isArray(raw.listingAmenities) ? raw.listingAmenities : [];
    const amenitiesView = {
      count: amenities.length,
      itemKeys: keyTypes(amenities[0] || null),
      names: amenities
        .map((a) => (a && typeof a.amenityName === "string" ? a.amenityName : null))
        .filter(Boolean)
        .slice(0, MAX_AMENITY_NAMES)
    };

    const bedTypes = Array.isArray(raw.listingBedTypes) ? raw.listingBedTypes : [];
    const bedTypesView = { count: bedTypes.length, itemKeys: keyTypes(bedTypes[0] || null) };

    const description = typeof raw.description === "string" ? raw.description : "";
    const descriptionView = {
      length: description.length,
      excerpt: description.slice(0, DESCRIPTION_EXCERPT_CHARS) + (description.length > DESCRIPTION_EXCERPT_CHARS ? "…" : ""),
      hasHouseRules: typeof raw.houseRules === "string" && raw.houseRules.length > 0,
      houseRulesLength: typeof raw.houseRules === "string" ? raw.houseRules.length : 0,
      // UX2a audit view: exactly what the public feed WOULD publish, plus the private-content scan verdict.
      publicCandidate: (() => { const c = toPublicContent(raw); return { description: c.description, flags: c.descriptionFlags, publishedNow: PUBLISH_DESCRIPTION && !!c.description, amenities: c.amenities, beds: c.beds, checkInFrom: c.checkInFrom, checkOutBy: c.checkOutBy }; })()
    };

    res.status(200).json({
      ok: true,
      listing: {
        identity: identity.out,
        capacity: capacity.out,
        location: location.out,
        policy: policy.out,
        pricing: pricing.out,
        images: imagesView,
        amenities: amenitiesView,
        bedTypes: bedTypesView,
        description: descriptionView
      },
      _schema: {
        wrapperKeys: keyTypes(json),
        topLevelKeyCount: Object.keys(raw).length,
        absentFromUpstream: [...identity.absent, ...capacity.absent, ...location.absent, ...policy.absent, ...pricing.absent]
      },
      _meta: { upstreamStatus: status, tokenSource, retriedAfterAuthError: retried }
    });
  } catch (err) {
    const code = err?.code || "HOSTAWAY_REQUEST_FAILED";
    const httpStatus = code === "HOSTAWAY_ENV_MISSING" ? 500 : 502;
    const payload = { ok: false, error: code };
    if (err?.upstreamStatus) payload.upstream = { status: err.upstreamStatus };
    if (err?.missing) payload.missing = err.missing;
    console.error("[hostaway/listing] failed", { code, upstreamStatus: err?.upstreamStatus ?? null });
    res.status(httpStatus).json(payload);
  }
}
