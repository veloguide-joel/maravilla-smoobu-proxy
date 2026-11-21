// lib/public-catalog.js — E7 C85. Which Hostaway listing ids the PUBLIC read-only booking routes (/api/booking/listings,
// /api/booking/calendar, /api/booking/quote) may serve. Server-side only: the catalog is chosen from the deployment's own
// environment, never from a request (no client-supplied id list, no query parameter).
//
//   pilot (DEFAULT, and ALWAYS in production): the two existing public pilots, PUBLIC_LISTING_IDS — unchanged behaviour.
//   migrated-preview (MV_PUBLIC_CATALOG=migrated-preview AND VERCEL_ENV preview|development): the pilots + the EXACT 28 listings
//     migrated from Tokeet into Hostaway (project doc claude/tokeet-migration/inventory-2026-11-13.md; current Hostaway
//     inventory 2026-11-15: 31 listings = 28 migrated + 2 pilots + TEST 606998). Read-only browse / calendar / quote only.
//   launch (MV_PUBLIC_CATALOG=launch, any environment; P4-4): EXACTLY the 28 migrated USD listings and nothing else -- the two MXN
//     pilots are not part of it. This is the production catalog.
//   anything else, or migrated-preview outside preview|development → pilot (fail closed) with a reason code for logs.
//
// Never in any public catalog: the original TEST listing 606998 (booking / payment exercises stay there) and the non-existent
// 628381 / 628387. This module grants NO checkout admission: checkout listings come from MV_CHECKOUT_TEST_LISTINGS in
// lib/checkout/intent-api-http.js and are untouched.
import { PUBLIC_LISTING_IDS } from "./listing-public.js";

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
/** The exact migrated set (28): 628346; 628372..628380; 628382..628386; 628388..628400. */
export const MIGRATED_PREVIEW_LISTING_IDS = Object.freeze([628346, ...range(628372, 628380), ...range(628382, 628386), ...range(628388, 628400)]);
export const NEVER_PUBLIC_LISTING_IDS = Object.freeze([606998, 628381, 628387]);
export const CATALOG_MODES = Object.freeze({ PILOT: "pilot", MIGRATED_PREVIEW: "migrated-preview", LAUNCH: "launch" });
/** P4-4 launch catalog: exactly the 28 migrated USD listings. Never the two MXN pilots (owner decision: all prices in USD). */
export const LAUNCH_CATALOG_IDS = MIGRATED_PREVIEW_LISTING_IDS;
export const PREVIEW_CATALOG_IDS = Object.freeze([...PUBLIC_LISTING_IDS, ...MIGRATED_PREVIEW_LISTING_IDS]);
/** Upstream concurrency for the listings feed (each listing = 1 GET; Hostaway documents 200 requests / 10 s). */
export const LISTINGS_FETCH_CONCURRENCY = 4;

const PILOT = Object.freeze({ mode: CATALOG_MODES.PILOT, ids: PUBLIC_LISTING_IDS, reason: null });

/** resolvePublicCatalog(env) -> frozen { mode, ids, reason } — pure, server-side env only. */
export function resolvePublicCatalog(env = process.env) {
  const raw = env && typeof env.MV_PUBLIC_CATALOG === "string" ? env.MV_PUBLIC_CATALOG.trim() : "";
  if (raw === "" || raw === CATALOG_MODES.PILOT) return PILOT;
  // P4-4: `launch` is the production catalog (also usable on preview to rehearse it): the 28 USD listings only
  if (raw === CATALOG_MODES.LAUNCH) return Object.freeze({ mode: CATALOG_MODES.LAUNCH, ids: LAUNCH_CATALOG_IDS, reason: null });
  if (raw !== CATALOG_MODES.MIGRATED_PREVIEW) return Object.freeze({ ...PILOT, reason: "CATALOG_MODE_UNKNOWN" });
  if (env.VERCEL_ENV !== "preview" && env.VERCEL_ENV !== "development") return Object.freeze({ ...PILOT, reason: "PREVIEW_CATALOG_REFUSED_ENV" });
  return Object.freeze({ mode: CATALOG_MODES.MIGRATED_PREVIEW, ids: PREVIEW_CATALOG_IDS, reason: null });
}

/** True only for an id in the resolved catalog (never a TEST / non-existent id). */
export function isPublicCatalogId(id, catalog = resolvePublicCatalog()) {
  return Number.isSafeInteger(id) && catalog.ids.includes(id) && !NEVER_PUBLIC_LISTING_IDS.includes(id);
}
