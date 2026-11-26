// P6-1 db: scripts/mv-status.mjs against a throwaway cluster migrated as "live" -- every query runs on the real schema, read-only.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startPostgres } from "./harness.mjs";
import { migrateUp } from "../../db/lib/migrate.js";
import { statusOnce } from "../../scripts/mv-status.mjs";

test("P6-1 db: empty live database -> OK / NOTHING_IN_FLIGHT; the other mode is refused; the session cannot write", async () => {
  const db = await startPostgres();
  const owner = new pg.Client({ connectionString: db.adminUrl });
  await owner.connect();
  const pool = new pg.Pool({ connectionString: db.adminUrl, max: 1 });
  try {
    await migrateUp(owner, { env: "live" });
    const cfg = { mode: "live", listings: new Map([[628346, { currency: "USD" }]]), notBefore: "2026-11-01T00:00:00.000Z" };
    const r = await statusOnce(pool, cfg);
    assert.deepEqual([r.outcome, r.code, r.inFlight, r.attention, r.openCases, r.confirmationsQueued, r.unlistedPaid], ["OK", "NOTHING_IN_FLIGHT", 0, 0, 0, 0, 0]);
    assert.deepEqual(r.byState, {});
    const wrong = await statusOnce(pool, { ...cfg, mode: "test" });
    assert.deepEqual([wrong.outcome, wrong.code], ["REFUSED", "DATABASE_NOT_CONFIGURED_MODE"]);
    const c = await pool.connect();
    try {
      await c.query("BEGIN TRANSACTION READ ONLY");
      await assert.rejects(c.query("CREATE TABLE booking.p6_probe (x int)"), (e) => e.code === "25006", "a read-only transaction refuses writes");
      await c.query("ROLLBACK");
    } finally { c.release(); }
  } finally { await pool.end(); await owner.end(); await db.stop(); }
});
