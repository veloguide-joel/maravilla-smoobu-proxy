// test/legacy-routes-retired.test.mjs — Stage E1 (owner-authorized 2026-10-20).
//
// The Smoobu-era payment, hold and reservation routes were retired because they
// were unauthenticated, trusted browser-supplied amounts, exposed guest data or
// could not load at all (see the E0 architecture report). Vercel serves one
// function per file under api/, so a deleted file is a 404 with no side effects.
//
// These checks keep it that way:
//   1. the retired route and library files are gone and cannot quietly return;
//   2. the deployed function set is exactly the modern Hostaway API + health;
//   3. nothing that remains can create a Stripe session, write the database or
//      call Smoobu, and no Stripe key/secret pattern exists in the code;
//   4. the modern routes still load and import nothing retired;
//   5. the obsolete hold-expiry cron is gone from vercel.json.
// Behaviour of the retained routes is covered by the existing suites.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const rel = (p) => relative(ROOT, p).split("\\").join("/");

function listFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

const RETIRED_FILES = Object.freeze([
  "api/create-checkout-session.js",
  "api/instant/checkout.js",
  "api/stripe/webhook.js",
  "api/holds/active.js",
  "api/holds/confirm.js",
  "api/holds/create.js",
  "api/holds/expire.js",
  "api/holds/release.js",
  "api/smoobu/apartments.js",
  "api/smoobu/availability.js",
  "api/smoobu/me.js",
  "api/smoobu/quote.js",
  "api/smoobu/reservations.js",
  "api/smoobu/test.js",
  "api/stripe/checkout_old.js",
  "api/[...path].js",
  "api/_cors.js",
  "lib/holds.js",
  "lib/smoobu.js",
  "lib/quote.js"
]);

const RETIRED_DIRS = Object.freeze(["api/holds", "api/smoobu", "api/stripe", "api/instant"]);

// Every file under api/ that may exist. Files starting with "_" are not routes.
const EXPECTED_API_FILES = Object.freeze([
  "api/_db.js",
  "api/booking/calendar.js",
  "api/booking/listings.js",
  "api/booking/quote.js",
  "api/health.js",
  "api/hostaway/calendar.js",
  "api/hostaway/e4-check.js",
  "api/hostaway/listing.js",
  "api/hostaway/listings.js",
  "api/hostaway/payment-rules-check.js",
  "api/hostaway/payment-rules-page.js",
  "api/hostaway/quote.js"
]);

const RETAINED_ROUTES = EXPECTED_API_FILES.filter((f) => !f.split("/").pop().startsWith("_"));

test("retired route and library files are absent", () => {
  for (const f of RETIRED_FILES) assert.equal(existsSync(join(ROOT, f)), false, `${f} must not exist`);
  for (const d of RETIRED_DIRS) {
    const left = listFiles(join(ROOT, d)).map(rel);
    assert.deepEqual(left, [], `${d}/ must contain no files`);
  }
});

test("the api/ directory contains exactly the expected files", () => {
  const actual = listFiles(join(ROOT, "api")).map(rel).sort();
  assert.deepEqual(actual, [...EXPECTED_API_FILES].sort());
});

test("no deployed code can create Stripe sessions, write the database or call Smoobu", () => {
  const files = [...listFiles(join(ROOT, "api")), ...listFiles(join(ROOT, "lib"))]
    .filter((f) => f.endsWith(".js") && !rel(f).endsWith("lib/stripe-checkout-draft.js")); // inert, commented reference only
  const forbidden = [
    [/from\s+["']stripe["']|require\(\s*["']stripe["']\s*\)/, "stripe import"],
    [/checkout\.sessions\.create/, "Checkout Session creation"],
    [/\b(INSERT\s+INTO|UPDATE\s+booking_intents|DELETE\s+FROM)\b/i, "database write"],
    [/smoobu\.com/i, "Smoobu API call"],
    [/from\s+["'][./]*(api\/)?_db\.js["']/, "database pool import"]
  ];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const [re, what] of forbidden) assert.equal(re.test(src), false, `${rel(f)} contains ${what}`);
  }
});

test("lib/stripe-checkout-draft.js stays inert (no runtime imports, not a route)", () => {
  const f = join(ROOT, "lib/stripe-checkout-draft.js");
  if (!existsSync(f)) return; // deleting it later is fine
  const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.equal(/^\s*import\s/m.test(code), false, "draft must not import anything");
  assert.equal(/export\s+default/.test(code), false, "draft must not export a handler");
});

test("no Stripe key or webhook-secret patterns in source", () => {
  const files = ["api", "lib", "scripts", "test"].flatMap((d) => listFiles(join(ROOT, d)))
    .filter((f) => /\.(m?js|cjs|json)$/.test(f));
  files.push(join(ROOT, "vercel.json"), join(ROOT, "package.json"));
  const secret = /\b(sk|rk)_(live|test)_[0-9A-Za-z]{8,}|\bwhsec_[0-9A-Za-z]{8,}/;
  for (const f of files) assert.equal(secret.test(readFileSync(f, "utf8")), false, `${rel(f)} contains a key-like value`);
});

test("vercel.json carries no cron for the retired hold-expiry route", () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8"));
  const crons = Array.isArray(cfg.crons) ? cfg.crons : [];
  assert.equal(crons.some((c) => typeof c?.path === "string" && c.path.startsWith("/api/holds")), false);
  const rewrites = Array.isArray(cfg.rewrites) ? cfg.rewrites : [];
  assert.equal(rewrites.some((r) => /holds|stripe|checkout|smoobu/.test(JSON.stringify(r))), false);
});

test("every retained route loads and exports a handler", async () => {
  for (const f of RETAINED_ROUTES) {
    const mod = await import(pathToFileURL(join(ROOT, f)).href);
    assert.equal(typeof mod.default, "function", `${f} default export`);
  }
});

test("no retained module imports a retired module", () => {
  const retiredBases = new Set(RETIRED_FILES.map((f) => f.split("/").pop()));
  const files = [...listFiles(join(ROOT, "api")), ...listFiles(join(ROOT, "lib"))].filter((f) => f.endsWith(".js"));
  for (const f of files) {
    if (rel(f) === "lib/stripe-checkout-draft.js") continue;
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/^\s*import\s[^;]*?from\s*["']([^"']+)["']/gm)) {
      const base = m[1].split("/").pop();
      assert.equal(m[1].startsWith(".") && retiredBases.has(base), false, `${rel(f)} imports retired ${m[1]}`);
    }
  }
});
