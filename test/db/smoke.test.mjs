// test/db/smoke.test.mjs — scripts/db-smoke.mjs against a throwaway local cluster (loopback, trust auth, no secrets).
// Remote-URL cases run with a deny-network preload and must refuse before any connection.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMigratedDatabase } from "./harness.mjs";

const SMOKE = fileURLToPath(new URL("../../scripts/db-smoke.mjs", import.meta.url));
const MARK = "zqmarker7731";
const DENY_NETWORK = "data:text/javascript," + encodeURIComponent(`
import net from "node:net"; import tls from "node:tls"; import dns from "node:dns";
const deny = (w) => function () { process.stderr.write("NETWORK_ATTEMPT_BLOCKED:" + w + "\\n"); throw new Error("NETWORK_ATTEMPT_BLOCKED"); };
net.Socket.prototype.connect = deny("socket.connect"); net.connect = deny("net.connect"); net.createConnection = deny("net.createConnection");
tls.connect = deny("tls.connect"); dns.lookup = deny("dns.lookup"); dns.promises.lookup = deny("dns.promises.lookup");`);

let db, tmp;
const url = (user) => `postgresql://${user}@127.0.0.1:${db.port}/postgres`;

before(async () => {
  db = await startMigratedDatabase();
  await db.owner.query("CREATE ROLE test_both LOGIN IN ROLE mv_booking_app, mv_booking_admin");
  // Insert sentinel (throwaway DB only): a non-transactional counter survives rollback, so any INSERT attempt on
  // booking.intents while the sentinel is attached is recorded, then refused with a distinct static marker.
  await db.owner.query("CREATE SEQUENCE public.zq_smoke_insert_attempts");
  await db.owner.query(`CREATE FUNCTION public.zq_smoke_insert_sentinel() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
    BEGIN PERFORM nextval('public.zq_smoke_insert_attempts'); RAISE EXCEPTION 'ZQ_SMOKE_INSERT_REACHED' USING ERRCODE = 'ZQ001'; END $$`);
  tmp = mkdtempSync(join(tmpdir(), "mv-smoke-"));
});
after(async () => { await db?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

function smoke(urlValue, args, { deny = false } = {}) {
  const argv = [...(deny ? ["--import", DENY_NETWORK] : []), SMOKE, "--url-env", "MV_SMOKE_URL", ...args];
  const r = spawnSync(process.execPath, argv, { env: { PATH: process.env.PATH, MV_SMOKE_URL: urlValue }, encoding: "utf8", timeout: 60000 });
  const out = r.stdout + r.stderr;
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* asserted below */ }
  return { status: r.status, out, json, byName: Object.fromEntries((json?.checks || []).map((c) => [c.check, c])) };
}
async function insertAttempts() {
  return Number((await db.owner.query("SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS n FROM public.zq_smoke_insert_attempts")).rows[0].n);
}
/** Run fn with the sentinel attached to booking.intents; always detaches it. Asserts no INSERT was attempted. */
async function withInsertSentinel(fn) {
  const before = await insertAttempts();
  await db.owner.query(`CREATE TRIGGER zq_smoke_insert_sentinel BEFORE INSERT ON booking.intents
    FOR EACH ROW EXECUTE FUNCTION public.zq_smoke_insert_sentinel()`);
  try { await fn(); } finally { await db.owner.query("DROP TRIGGER zq_smoke_insert_sentinel ON booking.intents"); }
  assert.equal(await insertAttempts(), before, "write probe must not attempt any INSERT");
}
function assertWriteRefused(r) {
  assert.equal(r.status, 1);
  assert.equal(r.byName.write_probe_refused_prerequisites_not_met?.pass, false);
  assert.ok(!Object.keys(r.byName).some((n) => n.startsWith("write_probe_") && n !== "write_probe_refused_prerequisites_not_met"));
  assert.ok(!r.out.includes("ZQ001") && !r.out.includes("ZQ_SMOKE_INSERT_REACHED"), "sentinel marker never reached");
}
function assertNoSecretMaterial(out, urlValue) {
  assert.ok(!out.includes("postgresql://") && !out.includes(urlValue), "no URL in output");
  assert.ok(!out.toLowerCase().includes(MARK), "no supplied user/credential text in output");
  assert.ok(!/password|NETWORK_ATTEMPT_BLOCKED/i.test(out), "no password text, no network attempt");
}

test("correct runtime login: every read-only check passes, exit 0", () => {
  const u = url("test_app");
  const r = smoke(u, ["--expect-role", "test_app", "--loopback-rehearsal"]);
  assert.equal(r.status, 0, JSON.stringify(r.json));
  assert.equal(r.json.pass, true);
  for (const name of ["connect_authenticated", "identity_is_expected_runtime_login", "member_of_mv_booking_app_only",
    "environment_marker_is_test", "statement_timeout_5s", "idle_in_transaction_session_timeout_10s", "smoke_transaction_is_read_only",
    "table_privilege_matrix_exact", "no_delete_or_truncate_anywhere", "runtime_functions_executable", "admin_functions_not_executable",
    "data_only_instance_row", "db_clock_function_callable", "migration_table_denied"]) {
    assert.equal(r.byName[name]?.pass, true, name);
  }
  assert.ok(!Object.keys(r.byName).some((n) => n.startsWith("write_probe")), "read-only by default");
  assertNoSecretMaterial(r.out, u);
});

test("expected role differs from the authenticated login: fails", () => {
  const r = smoke(url("test_app"), ["--expect-role", "mv_booking_app_dev", "--loopback-rehearsal"]);
  assert.equal(r.status, 1);
  assert.equal(r.byName.identity_is_expected_runtime_login.pass, false);
});

test("admin login used as runtime: membership, matrix and admin functions fail", () => {
  const r = smoke(url("test_admin"), ["--expect-role", "test_admin", "--loopback-rehearsal"]);
  assert.equal(r.status, 1);
  assert.equal(r.byName.member_of_mv_booking_app_only.pass, false);
  assert.equal(r.byName.table_privilege_matrix_exact.pass, false);
  assert.equal(r.byName.admin_functions_not_executable.pass, false);
});

test("login holding app AND admin: over-privilege detected", () => {
  const r = smoke(url("test_both"), ["--expect-role", "test_both", "--loopback-rehearsal"]);
  assert.equal(r.status, 1);
  assert.equal(r.byName.member_of_mv_booking_app_only.pass, false);
  assert.equal(r.byName.admin_functions_not_executable.pass, false);
});

test("schema owner used as runtime: superuser/privilege checks fail", () => {
  const r = smoke(url("postgres"), ["--expect-role", "postgres", "--loopback-rehearsal"]);
  assert.equal(r.status, 1);
  assert.equal(r.byName.not_superuser_bypassrls_createrole_createdb_replication.pass, false);
  assert.equal(r.byName.table_privilege_matrix_exact.pass, false);
  assert.equal(r.byName.migration_table_denied.pass, false);
});

test("wrong expected environment: fails and the write probe is refused (no INSERT attempted)", async () => {
  await withInsertSentinel(async () => {
    const r = smoke(url("test_app"), ["--expect-role", "test_app", "--env", "live", "--write-probe", "--loopback-rehearsal"]);
    assert.equal(r.byName.environment_marker_is_live.pass, false);
    assertWriteRefused(r);
  });
  assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM booking.intents")).rows[0].n, 0);
});

test("sentinel self-check: a permitted write probe IS recorded by the sentinel (counter +1, ZQ001), then rolled back", async () => {
  const before = await insertAttempts();
  await db.owner.query(`CREATE TRIGGER zq_smoke_insert_sentinel BEFORE INSERT ON booking.intents
    FOR EACH ROW EXECUTE FUNCTION public.zq_smoke_insert_sentinel()`);
  let r;
  try { r = smoke(url("test_app"), ["--expect-role", "test_app", "--write-probe", "--loopback-rehearsal"]); }
  finally { await db.owner.query("DROP TRIGGER zq_smoke_insert_sentinel ON booking.intents"); }
  assert.equal(await insertAttempts(), before + 1);
  assert.equal(r.status, 1);
  assert.equal(r.byName.write_probe?.detail, "ZQ001");
  assert.equal(r.byName.write_probe_rolled_back_nothing_committed?.pass, true);
});

test("write probe with wrong expected identity: refused, no INSERT attempted", async () => {
  await withInsertSentinel(async () => {
    const r = smoke(url("test_app"), ["--expect-role", "mv_booking_app_dev", "--write-probe", "--loopback-rehearsal"]);
    assert.equal(r.byName.identity_is_expected_runtime_login.pass, false);
    assertWriteRefused(r);
  });
});

test("write probe with schema owner and with app+admin login: refused, no INSERT attempted", async () => {
  await withInsertSentinel(async () => {
    for (const user of ["postgres", "test_both"]) {
      const r = smoke(url(user), ["--expect-role", user, "--write-probe", "--loopback-rehearsal"]);
      assert.equal(r.byName.member_of_mv_booking_app_only.pass, false, user);
      assertWriteRefused(r);
    }
  });
});

test("row in a previously uncounted table (definite_refusal_codes): data check fails, write probe refused", async () => {
  await db.owner.query("INSERT INTO booking.definite_refusal_codes (op_type, code, note) VALUES ('hostaway.create_reservation', 'ZQ_FIXTURE_CODE', 'smoke test fixture')");
  try {
    await withInsertSentinel(async () => {
      const r = smoke(url("test_app"), ["--expect-role", "test_app", "--write-probe", "--loopback-rehearsal"]);
      assert.equal(r.byName.data_only_instance_row.pass, false);
      assert.deepEqual(r.byName.data_only_instance_row.detail, ["definite_refusal_codes"]);
      assertWriteRefused(r);
    });
  } finally {
    await db.owner.query("DELETE FROM booking.definite_refusal_codes WHERE code = 'ZQ_FIXTURE_CODE'");
  }
  assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM booking.definite_refusal_codes")).rows[0].n, 0);
  const ok = smoke(url("test_app"), ["--expect-role", "test_app", "--loopback-rehearsal"]);
  assert.equal(ok.byName.data_only_instance_row.pass, true, "fixture restored");
});

test("unknown login: sanitized connection failure, no user or URL text", () => {
  const u = url(`${MARK}user`);
  const r = smoke(u, ["--expect-role", "test_app", "--loopback-rehearsal"]);
  assert.equal(r.status, 1);
  assert.equal(r.byName.connect_authenticated.pass, false);
  assert.match(r.byName.connect_authenticated.detail, /^[A-Z0-9_]+$/);
  assertNoSecretMaterial(r.out, u);
});

test("write probe: passes, then nothing is committed", async () => {
  const r = smoke(url("test_app"), ["--expect-role", "test_app", "--write-probe", "--loopback-rehearsal"]);
  assert.equal(r.status, 0, JSON.stringify(r.json));
  for (const name of ["write_probe_insert_ok_db_stamped_audit", "write_probe_delete_denied", "write_probe_identity_immutable",
    "write_probe_rolled_back_nothing_committed"]) assert.equal(r.byName[name]?.pass, true, name);
  const counts = await db.owner.query(`SELECT (SELECT count(*) FROM booking.intents)::int AS i, (SELECT count(*) FROM booking.intent_transitions)::int AS t,
      (SELECT count(*) FROM booking.intent_work)::int AS w`);
  assert.deepEqual(counts.rows[0], { i: 0, t: 0, w: 0 });
});

test("remote URL with an unofficial CA file: fails closed before any connection", () => {
  const ca = join(tmp, "dummy-ca.crt");
  writeFileSync(ca, "-----BEGIN CERTIFICATE-----\nDUMMY\n-----END CERTIFICATE-----\n");
  const u = `postgresql://${MARK}u:${MARK}p@db.remote.example.invalid:6543/postgres`;
  const r = smoke(u, ["--expect-role", "x", "--ca-file", ca], { deny: true });
  assert.equal(r.status, 1);
  assert.equal(r.byName.ca_file_is_official_supabase_prod_ca_2021.pass, false);
  assert.ok(!("connect_authenticated" in r.byName));
  assertNoSecretMaterial(r.out, u);
});

test("unsafe or misused URLs: static refusal, no URL echo, no network", () => {
  const cases = [
    [`postgresql://${MARK}u:${MARK}p@db.remote.example.invalid/postgres?sslmode=disable`, ["--expect-role", "x", "--ca-file", "x"]],
    [`postgresql://${MARK}u:${MARK}p@db.remote.example.invalid/postgres`, ["--expect-role", "x"]],
    [`postgresql://${MARK}u:${MARK}p@db.remote.example.invalid/postgres`, ["--expect-role", "x", "--loopback-rehearsal"]],
    [`postgresql://${MARK}u@127.0.0.1:1/postgres`, ["--expect-role", "x"]],
    [`not a url ${MARK}`, ["--expect-role", "x", "--loopback-rehearsal"]]
  ];
  for (const [u, args] of cases) {
    const r = smoke(u, args, { deny: true });
    assert.equal(r.status, 1);
    assert.equal(r.byName.fatal?.pass, false);
    assertNoSecretMaterial(r.out, u);
  }
  const missing = spawnSync(process.execPath, [SMOKE, "--url-env", "MV_UNSET_VAR", "--expect-role", "x"], { env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /"pass": false/);
});
