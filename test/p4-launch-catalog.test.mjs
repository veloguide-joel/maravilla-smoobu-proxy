// P4-4: the production ("launch") public catalog -- exactly the 28 migrated USD listings, in every environment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PUBLIC_LISTING_IDS } from "../lib/listing-public.js";
import { resolvePublicCatalog, isPublicCatalogId, LAUNCH_CATALOG_IDS, MIGRATED_PREVIEW_LISTING_IDS, NEVER_PUBLIC_LISTING_IDS, PREVIEW_CATALOG_IDS, CATALOG_MODES } from "../lib/public-catalog.js";

test("P4-4 launch catalog: the 28 USD listings only, also in production; never the MXN pilots, the TEST listing or the non-existent ids", () => {
  assert.equal(CATALOG_MODES.LAUNCH, "launch");
  assert.equal(LAUNCH_CATALOG_IDS.length, 28); assert.deepEqual([...LAUNCH_CATALOG_IDS], [...MIGRATED_PREVIEW_LISTING_IDS]);
  for (const VERCEL_ENV of ["production", "preview", "development", undefined]) {
    const c = resolvePublicCatalog({ MV_PUBLIC_CATALOG: "launch", VERCEL_ENV });
    assert.deepEqual([c.mode, c.reason, c.ids.length], ["launch", null, 28], String(VERCEL_ENV));
    assert.ok(Object.isFrozen(c));
    for (const id of PUBLIC_LISTING_IDS) assert.equal(isPublicCatalogId(id, c), false, `pilot ${id}`);
    for (const id of NEVER_PUBLIC_LISTING_IDS) assert.equal(isPublicCatalogId(id, c), false, `never ${id}`);
    for (const id of LAUNCH_CATALOG_IDS) assert.equal(isPublicCatalogId(id, c), true, String(id));
  }
});

test("P4-4 the other modes are unchanged: pilot by default, migrated-preview only on preview / development, unknown values fail closed", () => {
  assert.deepEqual([...resolvePublicCatalog({}).ids], [...PUBLIC_LISTING_IDS]);
  assert.deepEqual([...resolvePublicCatalog({ MV_PUBLIC_CATALOG: "migrated-preview", VERCEL_ENV: "preview" }).ids], [...PREVIEW_CATALOG_IDS]);
  assert.deepEqual([resolvePublicCatalog({ MV_PUBLIC_CATALOG: "migrated-preview", VERCEL_ENV: "production" }).mode, resolvePublicCatalog({ MV_PUBLIC_CATALOG: "migrated-preview", VERCEL_ENV: "production" }).reason], ["pilot", "PREVIEW_CATALOG_REFUSED_ENV"]);
  for (const v of ["Launch", "launch ", "LAUNCH", "live", "all"]) { const c = resolvePublicCatalog({ MV_PUBLIC_CATALOG: v, VERCEL_ENV: "production" }); if (v.trim() === "launch") continue; assert.deepEqual([c.mode, c.reason], ["pilot", "CATALOG_MODE_UNKNOWN"], v); }
});
