// Packaging regression (2026-11-02): the gated E5a webhook bundles only runtime code from lib/; /db stays excluded.
// Evidence here is from an APPROXIMATE static tracer (test/helpers/import-closure.mjs). It is not proof of what Vercel
// builds, bundles or loads; that is the later platform validation gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { importClosure } from "./helpers/import-closure.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const walk = (d) => (existsSync(join(ROOT, d)) ? readdirSync(join(ROOT, d)).flatMap((n) => (statSync(join(ROOT, d, n)).isDirectory() ? walk(`${d}/${n}`) : [`${d}/${n}`])) : []);
const MOVED = ["codec", "config", "operations", "pool", "repo", "webhooks"];
const BOOKING_DB_FILES = [...MOVED, "intent-access", "recovery", "reservation-worker", "capture-worker", "compensation-worker", "recording-worker", "recording-inbox", "notification-worker", "test-abort", "test-cleanup"].sort(); // + E6 bearer-token lookup and shared rate limits; + E7.1 recovery; + E7.2/E7.3b/E7.4a/E7.4b/E7 guest-notification offline workers; + E7 TEST abort/cleanup transactions (not route-reachable)
const WEBHOOK = "api/checkout/stripe-webhook.js";
const INTENT_ROUTES = ["api/checkout/intents.js", "api/checkout/intent-step.js"];
// E6 intent API closure (identical for both routes apart from the entry file); everything after the HTTP layer is lazy.
const INTENT_CLOSURE_STATIC = ["lib/checkout/intent-api-http.js", "lib/checkout/stripe-test-mode.js", "lib/checkout/stripe-webhook-http.js"];
const INTENT_CLOSURE_DYNAMIC = ["lib/bookability.js", "lib/booking-db/codec.js", "lib/booking-db/config.js", "lib/booking-db/intent-access.js",
  "lib/booking-db/operations.js", "lib/booking-db/pool.js", "lib/booking-db/repo.js", "lib/booking-db/webhooks.js", "lib/checkout/final-price.js",
  "lib/checkout/intent-api-core.js", "lib/checkout/intent-state.js", "lib/checkout/server-pricer.js", "lib/checkout/stripe-test-webhook.js",
  "lib/direct-policy.js", "lib/direct-pricing.js", "lib/hostaway-calendar.js", "lib/hostaway.js", "lib/public-api.js", "lib/quote-public.js"];

const WEBHOOK_CLOSURE = Object.freeze([
  "api/checkout/stripe-webhook.js",
  "lib/booking-db/codec.js", "lib/booking-db/config.js", "lib/booking-db/operations.js", "lib/booking-db/pool.js",
  "lib/booking-db/repo.js", "lib/booking-db/webhooks.js",
  "lib/checkout/intent-state.js", "lib/checkout/stripe-test-mode.js", "lib/checkout/stripe-test-webhook.js", "lib/checkout/stripe-webhook-http.js"
]);

// Closures of every other api/ file at the accepted base 0c94b17 (tracer output; must not change).
const OTHER_API = Object.freeze({
  "api/_db.js": { files: ["api/_db.js"], packages: ["pg"] },
  "api/booking/calendar.js": { files: ["api/booking/calendar.js", "lib/bookability.js", "lib/calendar-public.js", "lib/hostaway-calendar.js", "lib/hostaway.js", "lib/listing-content.js", "lib/listing-public.js", "lib/public-api.js"], packages: [] },
  "api/booking/listings.js": { files: ["api/booking/listings.js", "lib/hostaway.js", "lib/listing-content.js", "lib/listing-public.js", "lib/public-api.js"], packages: [] },
  "api/booking/quote.js": { files: ["api/booking/quote.js", "lib/bookability.js", "lib/direct-policy.js", "lib/direct-pricing.js", "lib/direct-public.js", "lib/hostaway-calendar.js", "lib/hostaway.js", "lib/listing-content.js", "lib/listing-public.js", "lib/public-api.js", "lib/quote-public.js"], packages: [] },
  "api/health.js": { files: ["api/health.js"], packages: [] },
  "api/hostaway/calendar.js": { files: ["api/hostaway/calendar.js", "lib/diag-auth.js", "lib/hostaway.js"], packages: ["node:crypto"] },
  "api/hostaway/listing.js": { files: ["api/hostaway/listing.js", "lib/diag-auth.js", "lib/hostaway.js", "lib/listing-content.js", "lib/listing-public.js"], packages: ["node:crypto"] },
  "api/hostaway/listings.js": { files: ["api/hostaway/listings.js", "lib/hostaway.js"], packages: ["node:crypto"] },
  "api/hostaway/quote.js": { files: ["api/hostaway/quote.js", "lib/diag-auth.js", "lib/hostaway.js"], packages: ["node:crypto"] }
});

// anything that must never be reachable from a deployable function
const EXCLUDED = [/^db\//, /^scripts\//, /^test\//, /^docs?\//, /^public\//, /\.sql$/, /(^|\/)(migrate|admin|index)\.js$/, /README/i];

test("webhook closure (static + literal dynamic) is exactly the runtime set under lib/; packages pg/stripe/node:crypto only; no non-literal import()", () => {
  const c = importClosure(ROOT, WEBHOOK);
  assert.deepEqual([...c.files.keys()].sort(), [...WEBHOOK_CLOSURE].sort());
  assert.deepEqual([...c.packages].sort(), ["node:crypto", "pg", "stripe"]);
  assert.deepEqual(c.nonLiteralDynamic, []);
  for (const f of c.files.keys()) for (const re of EXCLUDED) assert.doesNotMatch(f, re, f);
  // the DB layer and the SDK are reached only lazily (after the route's gate), never at module load
  for (const f of ["lib/booking-db/pool.js", "lib/booking-db/repo.js", "lib/checkout/stripe-test-webhook.js"]) assert.equal(c.files.get(f), "dynamic", f);
  for (const f of ["api/checkout/stripe-webhook.js", "lib/checkout/stripe-webhook-http.js", "lib/checkout/stripe-test-mode.js"]) assert.equal(c.files.get(f), "static", f);
  // the operations -> repo edge is a literal dynamic import inside the DB layer; it must stay literal (traceable)
  assert.match(readFileSync(join(ROOT, "lib/booking-db/operations.js"), "utf8"), /await import\("\.\/repo\.js"\)/);
});

test("E6 intent routes: exact closure (static HTTP layer; DB, core, pricer, Hostaway client and SDK only lazy); same exclusions", () => {
  for (const r of INTENT_ROUTES) {
    const c = importClosure(ROOT, r);
    const want = Object.fromEntries([[r, "static"], ...INTENT_CLOSURE_STATIC.map((f) => [f, "static"]), ...INTENT_CLOSURE_DYNAMIC.map((f) => [f, "dynamic"])]);
    assert.deepEqual(Object.fromEntries([...c.files].sort()), Object.fromEntries(Object.entries(want).sort()), r);
    assert.deepEqual([...c.packages].sort(), ["node:crypto", "node:net", "pg", "stripe"], r);   // node:net: isIP for the trusted-address policy
    assert.deepEqual(c.nonLiteralDynamic, [], r);
    for (const f of c.files.keys()) for (const re of EXCLUDED) assert.doesNotMatch(f, re, `${r}: ${f}`);
    for (const f of c.files.keys()) {
      const src = readFileSync(join(ROOT, f), "utf8");
      assert.doesNotMatch(src, /from\s+["'](node:)?fs(\/promises)?["']|import\s*\(\s*["'](node:)?fs/, f);
    }
  }
});

test("no runtime module in the closure reads files or migrations", () => {
  for (const f of WEBHOOK_CLOSURE) {
    const src = readFileSync(join(ROOT, f), "utf8");
    assert.doesNotMatch(src, /from\s+["'](node:)?fs(\/promises)?["']|import\(\s*["'](node:)?fs/, f);
    assert.doesNotMatch(src, /readFileSync|readdirSync|createReadStream/, f);
  }
});

test("every other api/ file keeps its exact base closure: no DB, payment or Stripe reachability gained", () => {
  const apiFiles = walk("api").filter((f) => f.endsWith(".js") && f !== WEBHOOK && !INTENT_ROUTES.includes(f)).sort();
  assert.deepEqual(apiFiles, Object.keys(OTHER_API).sort(), "api/ file set");
  for (const f of apiFiles) {
    const c = importClosure(ROOT, f);
    assert.deepEqual({ files: [...c.files.keys()].sort(), packages: [...c.packages].sort() }, OTHER_API[f], f);
    assert.deepEqual(c.nonLiteralDynamic, [], f);
    for (const x of c.files.keys()) assert.doesNotMatch(x, /^lib\/(booking-db|checkout)\//, `${f} reaches ${x}`);
    assert.ok(![...c.packages].includes("stripe"), f);
  }
});

test("db/lib shims: identical export names and identical function/object identities; db/lib keeps only shims + migrate/admin/index", async () => {
  for (const m of MOVED) {
    const shim = await import(pathToFileURL(join(ROOT, `db/lib/${m}.js`)).href);
    const real = await import(pathToFileURL(join(ROOT, `lib/booking-db/${m}.js`)).href);
    assert.deepEqual(Object.keys(shim).sort(), Object.keys(real).sort(), m);
    assert.ok(Object.keys(real).length > 0, m);
    for (const k of Object.keys(real)) assert.equal(shim[k], real[k], `${m}.${k} identity`);
    assert.equal("default" in real, false, `${m} has no default export to lose`);
    const code = readFileSync(join(ROOT, `db/lib/${m}.js`), "utf8").replace(/^\s*\/\/.*$/gm, "").trim();
    assert.equal(code, `export * from "../../lib/booking-db/${m}.js";`, `${m} shim is a pure re-export`);
  }
  assert.deepEqual(walk("db/lib").sort(), ["admin", "codec", "config", "index", "migrate", "operations", "pool", "repo", "webhooks"].map((n) => `db/lib/${n}.js`));
  assert.deepEqual(walk("lib/booking-db").sort(), BOOKING_DB_FILES.map((n) => `lib/booking-db/${n}.js`));
  // the public DB surface (db/lib/index.js: migrations + admin + runtime) still exports everything it did
  const idx = await import(pathToFileURL(join(ROOT, "db/lib/index.js")).href);
  for (const n of ["migrateUp", "migrateDown", "loadMigrations", "createBookingPool", "assertEnvironment", "applyEvent", "recordStripeEvent", "claimNextOperation", "DB_CONFIG"]) assert.equal(typeof idx[n] === "undefined", false, n);
  const repo = await import(pathToFileURL(join(ROOT, "lib/booking-db/repo.js")).href);
  assert.equal(idx.applyEvent, repo.applyEvent);
});

test("only the E5a/E6 checkout modules import the booking DB layer; nothing in lib/ imports db/", () => {
  for (const f of walk("lib").filter((x) => x.endsWith(".js"))) {
    const src = readFileSync(join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(src, /["'][./]*db\/(lib|migrations)\//, `${f} imports from db/`);
    if (/booking-db\//.test(src) && !f.startsWith("lib/booking-db/")) assert.ok(["lib/checkout/stripe-test-webhook.js", "lib/checkout/stripe-webhook-http.js",
      "lib/checkout/intent-api-core.js", "lib/checkout/intent-api-http.js"].includes(f), f);
  }
});

test(".vercelignore and public/ containment are unchanged", () => {
  assert.equal(readFileSync(join(ROOT, ".vercelignore"), "utf8"),
    "# C8: never upload internal-only trees to Vercel (defence in depth; outputDirectory \"public\" already keeps\n# everything else out of static serving). NEVER list api/ or lib/: API functions bundle their lib/ imports.\n/db\n/test\n/scripts\n");
  assert.deepEqual(readdirSync(join(ROOT, "public")).sort(), ["checkout-test.css", "checkout-test.html", "checkout-test.js", "robots.txt"]);   // exact allowlist (E7 TEST page)
  assert.deepEqual(JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")), { outputDirectory: "public" });
});

test("E7.1/E7.2: no api/ route's import closure reaches the recovery modules, the reservation worker or the Hostaway adapter", () => {
  const OFFLINE_ONLY = ["lib/booking-db/reservation-worker.js", "lib/booking-db/recording-worker.js", "lib/booking-db/recovery.js", "lib/checkout/recovery-plan.js", "lib/hostaway-reservations.js",
    "lib/checkout/capture-proof.js", "lib/booking-db/capture-worker.js", "lib/checkout/compensation-proof.js", "lib/booking-db/compensation-worker.js",
    "lib/checkout/offline-charge-proof.js", "lib/booking-db/recording-inbox.js", "lib/checkout/guest-notification.js", "lib/booking-db/notification-worker.js",
    "lib/booking-db/test-cleanup.js"];   // + E7.3a pure capture proof, E7.3b capture worker, E7.4a-0 pure compensation proof, E7.4b-0 pure offline-charge proof, E7 guest-notification Stage 2; TEST cleanup stays offline
  const routes = walk("api").filter((f) => /\.m?js$/.test(f));
  assert.ok(routes.length >= 10);
  for (const r of routes) {
    const c = importClosure(ROOT, r);
    for (const f of OFFLINE_ONLY) assert.equal(c.files.has(f), false, `${r} reaches ${f}`);
    assert.deepEqual(c.nonLiteralDynamic, [], r);
  }
});
