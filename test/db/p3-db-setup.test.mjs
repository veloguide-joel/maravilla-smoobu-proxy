// P3-1: scripts/mv-db-setup.mjs against a throwaway cluster -- a fresh database migrated as "live", the runtime login, and its proof.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startPostgres } from "./harness.mjs";
import { migrateUp, migrationStatus, loadMigrations } from "../../db/lib/migrate.js";
import { ensureRuntimeLogin, proveRuntimeLogin, scramVerifier, APP_ROLE } from "../../scripts/mv-db-setup.mjs";

const APP = "abcdefghijklmnopqrstuvwxyz012345";

test("P3-1 db: fresh database -> every migration as live, runtime login created once, verifier equals PostgreSQL's own, login proof passes", async () => {
  const db = await startPostgres();
  const owner = new pg.Client({ connectionString: db.adminUrl });
  await owner.connect();
  try {
    const ran = await migrateUp(owner, { env: "live" });
    const all = loadMigrations().length;
    assert.equal(ran.length, all);
    const s = await migrationStatus(owner, { env: "live" });
    assert.deepEqual([s.applied.length, s.pending.length, s.environment], [all, 0, "live"]);

    const first = await ensureRuntimeLogin(owner, scramVerifier(APP));
    assert.equal(first.created, true);
    const stored = (await owner.query("SELECT rolpassword FROM pg_authid WHERE rolname = $1", [APP_ROLE])).rows[0].rolpassword;
    assert.match(stored, /^SCRAM-SHA-256\$4096:/, "stored as a verifier, as sent");

    // correctness of the verifier: PostgreSQL hashes the same password itself; with ITS salt our function must give ITS verifier
    await owner.query("SET password_encryption = 'scram-sha-256'");
    await owner.query(`CREATE ROLE p3_probe LOGIN PASSWORD '${APP}'`);
    const pgOwn = (await owner.query("SELECT rolpassword FROM pg_authid WHERE rolname = 'p3_probe'")).rows[0].rolpassword;
    const salt = Buffer.from(/^SCRAM-SHA-256\$4096:([^$]+)\$/.exec(pgOwn)[1], "base64");
    assert.equal(scramVerifier(APP, salt), pgOwn);

    const again = await ensureRuntimeLogin(owner, scramVerifier(APP));
    assert.equal(again.created, false, "idempotent");
    await assert.rejects(ensureRuntimeLogin(owner, "md5abc"), (e) => e.code === "VERIFIER_INVALID");

    const app = new pg.Client({ connectionString: db.adminUrl.replace("postgres@", `${APP_ROLE}@`) });
    await app.connect();
    try {
      const proof = await proveRuntimeLogin(app);
      assert.deepEqual(proof, { ok: true, checks: { identity: true, marker: true, statementTimeout: true, migrationTableDenied: true } });
    } finally { await app.end(); }
    const asOwner = await proveRuntimeLogin(owner);
    assert.equal(asOwner.ok, false, "the owner connection is not the runtime login");
    assert.equal(asOwner.checks.identity, false);
  } finally { await owner.end().catch(() => {}); db.stop(); }
});
