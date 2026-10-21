// db/lib/pool.js — Stage E2B. Connection pool for the booking database. Not imported by any route.
//
// - No default connection string: the caller must pass one explicitly (never DATABASE_URL, which belonged to the
//   retired Smoobu database).
// - Remote hosts require TLS WITH certificate verification (caller supplies the provider CA). The legacy
//   `rejectUnauthorized:false` pattern of api/_db.js is not used.
// - Plain (non-TLS) connections are allowed only to loopback hosts, for local tests.
import pg from "pg";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopbackUrl(connectionString) {
  const u = new URL(connectionString);
  const host = u.hostname || new URLSearchParams(u.search).get("host") || "";
  return LOOPBACK.has(host) || host.startsWith("/"); // unix socket directories are local too
}

export function createBookingPool({ connectionString, caPem, max = 3, statementTimeoutMs = 5000 } = {}) {
  if (typeof connectionString !== "string" || !connectionString) throw new TypeError("createBookingPool: connectionString required");
  const local = isLoopbackUrl(connectionString);
  if (!local && !caPem) throw new TypeError("createBookingPool: remote databases require caPem (verified TLS)");
  return new pg.Pool({
    connectionString,
    max,
    ssl: local ? false : { rejectUnauthorized: true, ca: caPem },
    statement_timeout: statementTimeoutMs,          // no statement can hold locks for long
    idle_in_transaction_session_timeout: 10000,     // a stuck client cannot keep a transaction open
    application_name: "maravilla-booking"
  });
}

/** Refuse to operate on a database whose environment marker differs from the expected one. */
export async function assertEnvironment(pool, expected) {
  const r = await pool.query("SELECT environment FROM booking.instance");
  const actual = r.rows[0]?.environment;
  if (actual !== expected) throw new Error(`ENVIRONMENT_MISMATCH: database is ${actual ?? "unknown"}, expected ${expected}`);
}
