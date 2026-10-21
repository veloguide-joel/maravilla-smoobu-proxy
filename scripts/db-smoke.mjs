#!/usr/bin/env node
// scripts/db-smoke.mjs — E2C authenticated connectivity smoke test for the booking database.
// Status: validated on throwaway local PostgreSQL 17 only. NOT yet run against any hosted database.
//
// Connects with the RUNTIME login through the verified-TLS booking pool (one client) and checks:
// TLS, identity/least privilege, environment marker, effective session limits, the exact table-privilege
// matrix, function privileges, empty data, and a database-clock function.
//
// - READ-ONLY by default: every check runs inside one `BEGIN READ ONLY` transaction that is always rolled back.
// - --write-probe (separate explicit approval): only when EVERY read-only check passed and the marker is `test`; inserts ONE synthetic
//   intent with raw SQL on the same single client inside its own transaction that is ALWAYS rolled back
//   (no repository helper is called, so nothing can commit), then confirms the probe row does not exist.
// - Fails closed: exit 0 only if at least one check ran and every check passed.
// - Output: check names, booleans and codes only. Never the URL, user name, password, or server error text.
//
// Usage:
//   node scripts/db-smoke.mjs --url-env BOOKING_DATABASE_URL --ca-file prod-ca-2021.crt --expect-role mv_booking_app_dev [--env test] [--write-probe]
//   --loopback-rehearsal : local throwaway clusters only (no TLS); refuses any non-loopback host.
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createBookingPool, resolveBookingTarget } from "../db/lib/pool.js";

const OFFICIAL_CA_SHA256 = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7"; // Supabase prod-ca-2021.crt

// Expected runtime privileges, from migrations 0002 (grants) and 0003 (UPDATE revoked on claims/cases; SELECT on
// the evidence tables). No DELETE/TRUNCATE/REFERENCES/TRIGGER anywhere.
const S = "SELECT", I = "INSERT", U = "UPDATE";
const EXPECTED_TABLE_PRIVS = {
  instance: [S],
  intents: [S, I, U], intent_work: [S, I, U], payment_attempts: [S, I, U], external_operations: [S, I, U],
  hostaway_reservation_attempts: [S, I, U], payment_refunds: [S, I, U], stripe_webhook_events: [S, I, U],
  inventory_claims: [S, I], reconciliation_cases: [S, I],
  intent_transitions: [S, I], intent_applied_events: [S, I], payment_ledger: [S, I], intent_guests: [S, I],
  provider_evidence: [S], reconciliation_resolutions: [S], definite_refusal_codes: [S]
};
const ALL_PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
const FUNCS_ALLOWED = ["booking.claim_release_blockers(uuid)", "booking.release_claim_if_safe(uuid,text)",
  "booking.release_completed_stays()", "booking.purge_guest_data(integer,integer)", "booking.settle_operation_from_evidence(uuid,uuid)",
  "booking.record_provider_evidence(uuid,text,text,text,jsonb,text)"];
const FUNCS_DENIED = ["booking.admin_resolve_operation(uuid,text,uuid[],text,text,text,timestamptz)",
  "booking.admin_resolve_intent(uuid,text,uuid[],text,text,text,timestamptz)", "booking.admin_close_case(uuid,uuid[],text,text,timestamptz)",
  "booking.admin_record_evidence(uuid,text,text,text,jsonb,timestamptz,text,text)", "booking.admin_acquire_claim(uuid,timestamptz)"];

class UsageError extends Error {} // static messages only, safe to print

const results = [];
const check = (name, pass, detail) => { results.push({ check: name, pass: !!pass, ...(detail !== undefined ? { detail } : {}) }); };
// Sanitized error code: SQLSTATE / Node error code only, never message text (which can carry host or user names).
const code = (e) => (typeof e?.code === "string" && /^[A-Z0-9_]{2,40}$/.test(e.code) ? e.code : "ERROR");

function parse(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write-probe" || a === "--loopback-rehearsal") o[a.slice(2)] = true;
    else if (["--url-env", "--ca-file", "--expect-role", "--env"].includes(a) && i + 1 < argv.length) o[a.slice(2)] = argv[++i];
    else throw new UsageError("unknown or incomplete argument");
  }
  o.env ??= "test";
  if (!["test", "live"].includes(o.env)) throw new UsageError("--env must be test or live");
  if (!o["url-env"] || !o["expect-role"]) throw new UsageError("--url-env and --expect-role are required");
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(o["url-env"])) throw new UsageError("--url-env must be an environment variable name");
  if (o["url-env"] === "DATABASE_URL") throw new UsageError("DATABASE_URL is the retired legacy variable");
  return o;
}

async function main() {
  const o = parse(process.argv.slice(2));
  const url = process.env[o["url-env"]];
  if (!url) throw new UsageError("the named environment variable is not set");
  let local;
  try { ({ local } = resolveBookingTarget(url)); } catch { throw new UsageError("connection string rejected by the booking pool guard"); }
  if (local && !o["loopback-rehearsal"]) throw new UsageError("loopback URL: use --loopback-rehearsal (local clusters only)");
  if (!local && o["loopback-rehearsal"]) throw new UsageError("--loopback-rehearsal refuses non-loopback hosts");

  let caPem;
  if (!local) {
    if (!o["ca-file"]) throw new UsageError("--ca-file is required for a remote database");
    let buf;
    try { buf = readFileSync(o["ca-file"]); } catch { throw new UsageError("CA file could not be read"); }
    const ok = createHash("sha256").update(buf).digest("hex") === OFFICIAL_CA_SHA256;
    check("ca_file_is_official_supabase_prod_ca_2021", ok);
    if (!ok) return; // fail closed before any connection
    caPem = buf.toString("utf8");
  }

  let pool;
  try { pool = createBookingPool({ connectionString: url, caPem, max: 1 }); }
  catch { throw new UsageError("connection string rejected by the booking pool guard"); }
  pool.on("error", () => {}); // idle-client errors must not print server text
  let client;
  try {
    try { client = await pool.connect(); check("connect_authenticated", true); }
    catch (e) { check("connect_authenticated", false, code(e)); return; }
    client.on("error", () => {});

    if (!local) {
      const s = client.connection.stream;
      const cert = typeof s.getPeerCertificate === "function" ? s.getPeerCertificate() : {};
      check("tls_encrypted", s.encrypted === true);
      check("tls_authorized", s.authorized === true);
      check("tls_protocol", /^TLSv1\.[23]$/.test(s.getProtocol?.() || ""), s.getProtocol?.() || "none");
      check("tls_peer_cn_present", typeof cert?.subject?.CN === "string");
    }

    const q = async (sql, params) => (await client.query(sql, params)).rows;
    let envOk = false;
    await client.query("BEGIN READ ONLY");
    try {
      const [who] = await q(`SELECT current_user AS cu, session_user AS su,
          r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
          pg_has_role(current_user, 'mv_booking_app', 'MEMBER') AS app_member,
          pg_has_role(current_user, 'mv_booking_admin', 'MEMBER') AS admin_member,
          pg_has_role(current_user, 'mv_booking_report', 'MEMBER') AS report_member,
          has_schema_privilege(current_user, 'booking_migrations', 'USAGE') AS migrations_usage,
          has_schema_privilege(current_user, 'booking', 'CREATE') AS booking_create
        FROM pg_roles r WHERE r.rolname = current_user`);
      check("identity_is_expected_runtime_login", who.cu === o["expect-role"] && who.su === o["expect-role"]);
      check("not_superuser_bypassrls_createrole_createdb_replication",
        !who.rolsuper && !who.rolbypassrls && !who.rolcreaterole && !who.rolcreatedb && !who.rolreplication);
      check("member_of_mv_booking_app_only", who.app_member && !who.admin_member && !who.report_member);
      check("no_access_to_migration_bookkeeping", who.migrations_usage === false);
      check("no_ddl_in_booking_schema", who.booking_create === false);

      await client.query("SAVEPOINT env");
      try {
        const rows = await q("SELECT environment FROM booking.instance");
        envOk = rows.length === 1 && rows[0].environment === o.env;
        check(`environment_marker_is_${o.env}`, envOk);
        await client.query("RELEASE SAVEPOINT env");
      } catch (e) { check(`environment_marker_is_${o.env}`, false, code(e)); await client.query("ROLLBACK TO SAVEPOINT env"); }

      const [lim] = await q(`SELECT current_setting('statement_timeout') AS st, current_setting('idle_in_transaction_session_timeout') AS it,
          current_setting('transaction_read_only') AS ro`);
      check("statement_timeout_5s", lim.st === "5s", lim.st);
      check("idle_in_transaction_session_timeout_10s", lim.it === "10s", lim.it);
      check("smoke_transaction_is_read_only", lim.ro === "on");

      const privRows = await q(`SELECT c.relname AS t, p.priv, has_table_privilege(current_user, c.oid, p.priv) AS ok
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN unnest($1::text[]) AS p(priv)
         WHERE n.nspname = 'booking' AND c.relkind IN ('r','p')`, [ALL_PRIVS]);
      const actual = {};
      for (const r of privRows) if (r.ok) (actual[r.t] ??= []).push(r.priv);
      const tables = new Set([...Object.keys(EXPECTED_TABLE_PRIVS), ...privRows.map((r) => r.t)]);
      const diffs = [];
      for (const t of [...tables].sort()) {
        const want = [...(EXPECTED_TABLE_PRIVS[t] || [])].sort().join(","), got = [...(actual[t] || [])].sort().join(",");
        if (want !== got) diffs.push(`${t}: expected ${want || "none"} got ${got || "none"}`);
      }
      check("table_privilege_matrix_exact", diffs.length === 0 && tables.size === 17, diffs.length ? diffs : `${tables.size} tables`);
      check("no_delete_or_truncate_anywhere", !privRows.some((r) => r.ok && (r.priv === "DELETE" || r.priv === "TRUNCATE")));

      const fn = async (sig) => (await q("SELECT has_function_privilege(current_user, $1, 'EXECUTE') AS ok", [sig]))[0].ok;
      const missing = [], extra = [];
      for (const f of FUNCS_ALLOWED) if (!(await fn(f))) missing.push(f);
      for (const f of FUNCS_DENIED) if (await fn(f)) extra.push(f);
      check("runtime_functions_executable", missing.length === 0, missing.length ? missing : undefined);
      check("admin_functions_not_executable", extra.length === 0, extra.length ? extra : undefined);

      await client.query("SAVEPOINT data");
      try {
        // Every expected booking table (fixed names from EXPECTED_TABLE_PRIVS): only instance may hold one row.
        const names = Object.keys(EXPECTED_TABLE_PRIVS).sort();
        const [c0] = await q(`SELECT ${names.map((t) => `(SELECT count(*) FROM booking.${t})::int AS ${t}`).join(", ")}`);
        const unexpected = names.filter((t) => c0[t] !== (t === "instance" ? 1 : 0));
        check("data_only_instance_row", unexpected.length === 0, unexpected.length ? unexpected : `${names.length} tables`);
        const [blk] = await q("SELECT booking.claim_release_blockers(gen_random_uuid()) AS b");
        check("db_clock_function_callable", JSON.stringify(blk.b) === JSON.stringify(["INTENT_NOT_FOUND"]));
        await client.query("RELEASE SAVEPOINT data");
      } catch (e) { check("data_and_function_reads", false, code(e)); await client.query("ROLLBACK TO SAVEPOINT data"); }

      await client.query("SAVEPOINT mig");
      try { await q("SELECT 1 FROM booking_migrations.applied LIMIT 1"); check("migration_table_denied", false, "readable"); }
      catch (e) { check("migration_table_denied", e.code === "42501", code(e)); }
      await client.query("ROLLBACK TO SAVEPOINT mig");
    } finally {
      await client.query("ROLLBACK").catch(() => {}); // the read-only phase never commits
    }

    if (o["write-probe"]) {
      // Gate: every check completed so far must have passed (identity, privileges, TLS, limits, data, environment),
      // and the database marker must be `test`. Otherwise no write transaction is ever started.
      if (!(results.length > 0 && results.every((r) => r.pass) && envOk && o.env === "test")) {
        check("write_probe_refused_prerequisites_not_met", false);
        return;
      }
      // One synthetic intent on THIS client only, raw SQL, ALWAYS rolled back. No repository helper (they commit).
      const id = randomUUID(), ref = "MV-SMK" + randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase();
      const token = createHash("sha256").update(randomUUID()).digest();
      await client.query("BEGIN");
      try {
        await client.query(`INSERT INTO booking.intents (id, ref, access_token_hash, machine_version, environment, state, version, listing_id,
            from_date, to_date, guests, created_at, updated_at)
          VALUES ($1, $2, $3, 'intent-state-v1', 'test', 'created', 0, 999999, '2099-01-10', '2099-01-12', 1, now(), now())`, [id, ref, token]);
        await client.query(`INSERT INTO booking.intent_transitions (intent_id, version_after, from_state, to_state, event_type, actor, at)
          VALUES ($1, 0, NULL, 'created', 'CREATED', 'guest', '2000-01-01T00:00:00Z')`, [id]);
        await client.query("INSERT INTO booking.intent_work (intent_id, next_action_at) VALUES ($1, NULL)", [id]);
        const [t] = (await client.query(
          "SELECT (recorded_at > now() - interval '1 hour') AS db_stamped FROM booking.intent_transitions WHERE intent_id = $1", [id])).rows;
        check("write_probe_insert_ok_db_stamped_audit", t?.db_stamped === true);
        await client.query("SAVEPOINT p1");
        try { await client.query("DELETE FROM booking.intents WHERE id = $1", [id]); check("write_probe_delete_denied", false, "deleted"); }
        catch (e) { check("write_probe_delete_denied", e.code === "42501", code(e)); }
        await client.query("ROLLBACK TO SAVEPOINT p1");
        await client.query("SAVEPOINT p2");
        try { await client.query("UPDATE booking.intents SET listing_id = 1 WHERE id = $1", [id]); check("write_probe_identity_immutable", false, "updated"); }
        catch (e) { check("write_probe_identity_immutable", e.code === "23514", code(e)); }
        await client.query("ROLLBACK TO SAVEPOINT p2");
      } catch (e) {
        check("write_probe", false, code(e));
      } finally {
        await client.query("ROLLBACK").catch(() => {});
      }
      const [after] = (await client.query("SELECT count(*)::int AS n FROM booking.intents WHERE id = $1", [id])).rows;
      check("write_probe_rolled_back_nothing_committed", after.n === 0);
    }
  } finally {
    client?.release();
    await pool.end().catch(() => {});
  }
}

main()
  .catch((e) => check("fatal", false, e instanceof UsageError ? e.message : code(e)))
  .finally(() => {
    const ok = results.length > 0 && results.every((r) => r.pass);
    console.log(JSON.stringify({ at: new Date().toISOString(), pass: ok, checks: results }, null, 1));
    process.exitCode = ok ? 0 : 1;
  });
