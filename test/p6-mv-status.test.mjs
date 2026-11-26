// P6-1: scripts/mv-status.mjs -- the read-only status check (no database here; see test/db/p6-mv-status.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateStatusConfig, parseStatusEnv, statusOnce, exitCodeFor, main, ENV_NAMES, DEFAULT_MAX_MINUTES, MV_STATUS_VERSION } from "../scripts/mv-status.mjs";

const L = new Map([[628346, { currency: "USD" }], [606998, { currency: "USD" }]]);
const OK = { mode: "test", listings: L, notBefore: "2026-11-20T22:30:00.000Z" };
const ENV = { MV_PIPELINE_MODE: "live", MV_PIPELINE_LISTINGS: "628346:USD,628372:USD", MV_PIPELINE_NOT_BEFORE: "2026-11-27T00:00:00.000Z",
  MV_PIPELINE_DATABASE_URL: "postgresql://u:p@aws-0-us-east-2.pooler.supabase.com:6543/postgres", MV_PIPELINE_DATABASE_CA_FILE: "/nonexistent/ca.crt" };

test("S1 configuration: strict; TEST mode may list several listings (nothing is written); default threshold 20 minutes", () => {
  const v = validateStatusConfig(OK);
  assert.equal(v.ok, true);
  assert.deepEqual([...v.cfg.listingIds], [606998, 628346]);
  assert.equal(v.cfg.maxMinutes, DEFAULT_MAX_MINUTES);
  for (const [bad, code] of [[null, "CONFIG_REQUIRED"], [{ ...OK, mode: "prod" }, "MODE_INVALID"], [{ ...OK, listings: new Map() }, "LISTINGS_INVALID"],
    [{ ...OK, notBefore: "2026-11-20" }, "NOT_BEFORE_INVALID"], [{ ...OK, maxMinutes: 0 }, "MAX_MINUTES_INVALID"], [{ ...OK, maxMinutes: 1441 }, "MAX_MINUTES_INVALID"]]) {
    assert.deepEqual(validateStatusConfig(bad), { ok: false, code });
  }
});

test("S2 env: only the database URL, mode, listings and not-before are needed (no provider secret); refusals carry no value", () => {
  assert.deepEqual(Object.values(ENV_NAMES).sort(), ["MV_PIPELINE_DATABASE_CA_FILE", "MV_PIPELINE_DATABASE_URL", "MV_PIPELINE_LISTINGS", "MV_PIPELINE_MODE", "MV_PIPELINE_NOT_BEFORE"]);
  const p = parseStatusEnv(ENV);
  assert.equal(p.ok, true);
  assert.match(p.db.connectionString, /:5432\//, "session port, as the runner");
  for (const k of Object.keys(ENV)) { const e = { ...ENV }; delete e[k]; assert.deepEqual(parseStatusEnv(e), { ok: false, code: "CONFIG_INCOMPLETE" }); }
  assert.deepEqual(parseStatusEnv({ ...ENV, MV_STATUS_MAX_MINUTES: "abc" }), { ok: false, code: "MAX_MINUTES_INVALID" });
  assert.equal(parseStatusEnv({ ...ENV, MV_STATUS_MAX_MINUTES: "45" }).cfg.maxMinutes, 45);
  assert.deepEqual(parseStatusEnv({ ...ENV, MV_PIPELINE_DATABASE_URL: "postgresql://u:p@example.com:6543/postgres" }), { ok: false, code: "DATABASE_TARGET_REFUSED" });
});

test("S3 the CLI prints ONE JSON line of codes and exits 1 on a refusal, before any database connection", async () => {
  const lines = [];
  assert.equal(await main({}, (l) => lines.push(l)), 1);
  assert.equal(await main(ENV, (l) => lines.push(l)), 1);
  assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ version: MV_STATUS_VERSION, outcome: "REFUSED", code: "CONFIG_INCOMPLETE" }, { version: MV_STATUS_VERSION, outcome: "REFUSED", code: "CA_UNREADABLE" }]);
  assert.ok(!lines.join("").includes("supabase"));
});

test("S4 one READ ONLY transaction, always rolled back; every statement is a SELECT; a database of the other mode is refused after one read", async () => {
  const seen = [];
  const reply = (sql) => (sql.includes("booking.instance") ? { rows: [{ environment: "live" }] } : { rows: [] });
  const pool = { connect: async () => ({ query: async (sql) => { seen.push(sql); return reply(sql); }, release() { seen.push("RELEASE"); } }) };
  const r = await statusOnce(pool, OK);
  assert.deepEqual([r.outcome, r.code], ["REFUSED", "DATABASE_NOT_CONFIGURED_MODE"]);
  assert.deepEqual(seen, ["BEGIN TRANSACTION READ ONLY", "SELECT environment FROM booking.instance", "ROLLBACK", "RELEASE"]);
  assert.equal(exitCodeFor(r), 1);
  const src = readFileSync(new URL("../scripts/mv-status.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE|pg_try_advisory_lock|pg_advisory_lock|FOR UPDATE|COMMIT)\b/);
  assert.doesNotMatch(src, /STRIPE_KEY|HOSTAWAY_TOKEN|RESEND_KEY|mv-pipeline-wiring/);
});

test("S5 outcomes: on time -> OK; too old, a state needing review, an open case, or a paid booking on an unlisted listing -> ATTENTION", async () => {
  const now = Date.parse("2026-11-27T12:00:00.000Z");
  const world = (o) => ({ connect: async () => ({ release() {}, query: async (sql) => {
    if (sql.includes("booking.instance")) return { rows: [{ environment: "test" }] };
    if (sql.includes("GROUP BY i.state")) return { rows: o.states || [] };
    if (sql.includes("reconciliation_cases")) return { rows: [{ n: o.cases || 0 }] };
    if (sql.includes("guest.notify")) return { rows: [{ n: o.queued || 0, oldest: o.queuedOldest || null }] };
    if (sql.includes("NOT (i.listing_id")) return { rows: [{ n: o.unlisted || 0 }] };
    if (sql.includes("min(coalesce")) return { rows: [{ n: o.flight || 0, oldest: o.flightOldest || null }] };
    return { rows: [] };
  } }) });
  const run = async (o) => { const r = await statusOnce(world(o), OK, now); return [r.outcome, r.code]; };
  assert.deepEqual(await run({}), ["OK", "NOTHING_IN_FLIGHT"]);
  assert.deepEqual(await run({ flight: 1, flightOldest: "2026-11-27T11:50:00.000Z" }), ["OK", "IN_FLIGHT_ON_TIME"]);
  assert.deepEqual(await run({ flight: 1, flightOldest: "2026-11-27T11:30:00.000Z" }), ["ATTENTION", "PAID_NOT_CONFIRMED_IN_TIME"]);
  assert.deepEqual(await run({ queued: 1, queuedOldest: "2026-11-27T11:00:00.000Z" }), ["ATTENTION", "CONFIRMATION_NOT_SENT_IN_TIME"]);
  assert.deepEqual(await run({ states: [{ state: "capture_unknown", n: 1 }] }), ["ATTENTION", "STATE_NEEDS_REVIEW"]);
  assert.deepEqual(await run({ cases: 1 }), ["ATTENTION", "OPEN_CASE"]);
  assert.deepEqual(await run({ unlisted: 2 }), ["ATTENTION", "PAID_ON_UNLISTED_LISTING"]);
  const r = await statusOnce(world({ states: [{ state: "confirmed", n: 3 }], flight: 1, flightOldest: "2026-11-27T11:55:00.000Z" }), OK, now);
  assert.deepEqual([r.byState.confirmed, r.inFlight, r.oldestInFlightMinutes, r.maxMinutes], [3, 1, 5, 20]);
  assert.ok(!JSON.stringify(r).includes("MV-"), "no booking reference in the output");
});
