// P2c-3: mv-pipeline CLI configuration and provider-wiring guards. Offline: no network, database or provider. Placeholders only, never real credentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePipelineEnv, parseListings, sessionDatabaseUrl, ENV_NAMES, main, OFFICIAL_CA_SHA256 } from "../scripts/mv-pipeline.mjs";
import { validateWiringOptions, createWiring, WiringRefusal } from "../scripts/mv-pipeline-wiring.mjs";

const K = (p, n = 24) => p + "A".repeat(n);
const ENV = Object.freeze({ MV_PIPELINE_MODE: "test", MV_PIPELINE_LISTINGS: "606998:USD", MV_PIPELINE_NOT_BEFORE: "2026-11-21T00:00:00.000Z",
  MV_PIPELINE_STRIPE_ACCOUNT: "acct_1PlaceholderAccount", MV_PIPELINE_REF_FIELD_ID: "105433", MV_PIPELINE_TIME_ZONE: "America/Mexico_City",
  MV_PIPELINE_ACCOUNT_REF: "hostaway-e7-test", MV_PIPELINE_STRIPE_KEY: K("sk_test_"), MV_PIPELINE_HOSTAWAY_TOKEN: "token-placeholder",
  MV_PIPELINE_DATABASE_URL: "postgresql://role.ref:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres", MV_PIPELINE_DATABASE_CA_FILE: "/nonexistent/ca.crt",
  MV_PIPELINE_RUN_ID: "123-1" });
const code = (fn) => { try { fn(); return "NO_THROW"; } catch (e) { return e instanceof WiringRefusal ? e.code : `OTHER:${e.message}`; } };
const W = Object.freeze({ mode: "test", pool: { query: async () => ({ rows: [] }) }, stripeKey: K("sk_test_"), hostawayToken: "token-placeholder", stripeAccountId: "acct_1PlaceholderAccount",
  refFieldId: 105433, timeZone: "America/Mexico_City", accountRef: "hostaway-e7-test", runId: "123-1" });

test("E1 env parsing: every name is required; a refusal never carries a value; listings are strict id:USD", () => {
  const ok = parsePipelineEnv(ENV);
  assert.equal(ok.ok, true);
  assert.deepEqual([ok.cfg.mode, [...ok.cfg.listings.keys()], ok.cfg.notBefore, ok.wiring.refFieldId, ok.db.caFile], ["test", [606998], ENV.MV_PIPELINE_NOT_BEFORE, 105433, "/nonexistent/ca.crt"]);
  for (const name of Object.values(ENV_NAMES)) {
    const e = { ...ENV }; delete e[name];
    assert.deepEqual(parsePipelineEnv(e), { ok: false, code: "CONFIG_INCOMPLETE" }, name);
    assert.deepEqual(parsePipelineEnv({ ...ENV, [name]: "" }), { ok: false, code: "CONFIG_INCOMPLETE" }, name);
  }
  for (const [over, c] of [[{ MV_PIPELINE_MODE: "prod" }, "MODE_INVALID"], [{ MV_PIPELINE_LISTINGS: "606998:MXN" }, "LISTINGS_INVALID"], [{ MV_PIPELINE_LISTINGS: "700123:USD" }, "LISTING_NOT_TEST_FIXED"],
    [{ MV_PIPELINE_MODE: "live" }, "LISTING_NOT_LIVE_SCOPED"], [{ MV_PIPELINE_NOT_BEFORE: "yesterday" }, "NOT_BEFORE_INVALID"], [{ MV_PIPELINE_REF_FIELD_ID: "abc" }, "REF_FIELD_INVALID"],
    [{ MV_PIPELINE_DATABASE_URL: "https://example.com/db" }, "DATABASE_TARGET_REFUSED"]]) {
    const r = parsePipelineEnv({ ...ENV, ...over });
    assert.deepEqual(r, { ok: false, code: c }, c);
    assert.equal(JSON.stringify(r).includes("placeholder"), false);
  }
  assert.equal(parseListings("1:USD,1:USD"), null); assert.equal(parseListings("1:USD, 2:USD").size, 2); assert.equal(parseListings(""), null);
});

test("E2 the database connection is always SESSION mode: a Supabase transaction-pooler URL moves to port 5432; any other pooled target is refused", () => {
  assert.equal(new URL(parsePipelineEnv(ENV).db.connectionString).port, "5432");
  assert.equal(new URL(sessionDatabaseUrl("postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres")).port, "5432");
  assert.equal(new URL(sessionDatabaseUrl("postgresql://u:p@db.example.internal:5432/postgres")).port, "5432");
  for (const bad of ["postgresql://u:p@pgbouncer.example.com:6432/postgres", "postgresql://u:p@db.example.com:6543/postgres", "postgresql://u:p@h:5432/postgres?sslmode=disable", "not a url", "mysql://h/db"]) {
    assert.equal(sessionDatabaseUrl(bad), null, bad);
  }
});

test("E3 the CLI prints ONE JSON line of codes only and exits 1 on any refusal (incomplete config; unreadable CA) without touching a database or provider", async () => {
  const lines = [];
  assert.equal(await main({}, (l) => lines.push(l)), 1);
  assert.equal(await main(ENV, (l) => lines.push(l)), 1);
  assert.deepEqual(lines.map((l) => JSON.parse(l).code), ["CONFIG_INCOMPLETE", "CA_UNREADABLE"]);
  for (const l of lines) for (const secret of [ENV.MV_PIPELINE_STRIPE_KEY, ENV.MV_PIPELINE_HOSTAWAY_TOKEN, "pooler.supabase.com"]) assert.equal(l.includes(secret), false);
  assert.match(OFFICIAL_CA_SHA256, /^[0-9a-f]{64}$/);
});

test("E4 wiring guards (before anything is built): the Stripe key kind must match the mode; LIVE wiring is refused until the Stripe transport is mode-aware", () => {
  assert.equal(validateWiringOptions(W), true);
  assert.equal(code(() => validateWiringOptions({ ...W, stripeKey: K("rk_live_") })), "KEY_MODE_MISMATCH");           // a LIVE key in TEST mode
  assert.equal(code(() => validateWiringOptions({ ...W, mode: "live" })), "KEY_MODE_MISMATCH");                         // a TEST key in LIVE mode
  assert.equal(code(() => validateWiringOptions({ ...W, mode: "live", stripeKey: K("rk_live_") })), "STRIPE_LIVE_TRANSPORT_NOT_READY");
  for (const [over, c] of [[{ stripeKey: K("sk_live_") }, "CREDENTIAL_INVALID"], [{ stripeKey: "x" }, "CREDENTIAL_INVALID"], [{ hostawayToken: "" }, "CREDENTIAL_INVALID"],
    [{ stripeAccountId: "x" }, "ACCOUNT_ID_INVALID"], [{ refFieldId: 0 }, "REF_FIELD_INVALID"], [{ timeZone: "Mexico" }, "TIME_ZONE_INVALID"], [{ runId: "" }, "LABEL_INVALID"],
    [{ pool: null }, "POOL_REQUIRED"], [{ mode: "prod" }, "MODE_INVALID"]]) assert.equal(code(() => validateWiringOptions({ ...W, ...over })), c, c);
  const never = async () => { throw new Error("no provider call is expected"); };
  assert.equal(typeof createWiring({ ...W, exchanges: { stripe: never, hostaway: never } }).buildPhases, "function");
});

test("E5 the workflow file: manual dispatch only (no schedule), read-only token, environment by mode, secrets and variables by NAME, not in any arm manifest", () => {
  const y = readFileSync(new URL("../.github/workflows/mv-pipeline.yml", import.meta.url), "utf8");
  assert.match(y, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(y, /schedule:|cron:|pull_request|push:/);
  assert.match(y, /permissions:\n  contents: read/);
  assert.match(y, /environment: \$\{\{ inputs\.mode == 'live' && 'mv-live' \|\| 'e7-test-auto' \}\}/);
  assert.match(y, /cancel-in-progress: false/);
  for (const n of ["secrets.MV_LIVE_STRIPE_KEY", "secrets.E7_STRIPE_TEST_KEY", "secrets.MV_LIVE_HOSTAWAY_TOKEN", "secrets.E7_HOSTAWAY_TOKEN", "secrets.MV_LIVE_BOOKING_DATABASE_URL",
    "secrets.E7_DEV_BOOKING_DATABASE_URL"]) assert.ok(y.includes(n), n);
  assert.doesNotMatch(y, /sk_(test|live)_|rk_(test|live)_|whsec_|postgres(ql)?:\/\//);
});
