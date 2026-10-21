// db/lib/pool.js — Stage E2B. Connection pool for the booking database. Not imported by any route.
//
// - No default connection string: the caller must pass one explicitly (never DATABASE_URL, which belonged to the
//   retired Smoobu database).
// - Remote hosts require TLS WITH certificate verification (caller supplies the provider CA). The legacy
//   `rejectUnauthorized:false` pattern of api/_db.js is not used.
// - Plain (non-TLS) connections are allowed only to loopback hosts, for local tests.
import pg from "pg";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// URL options that pg/pg-connection-string turn into an `ssl` setting REPLACING the verified one passed below
// (sslmode, ssl, sslcert, sslkey, sslrootcert, sslpassword, ...), or that change how it is interpreted.
const TLS_OVERRIDE_PARAM = /^(ssl.*|uselibpqcompat)$/i;

function reject(reason) {
  return new TypeError(`createBookingPool: connection string rejected (${reason})`); // never includes the URL
}

/**
 * Validate a booking connection string and decide where it really points. Fails closed on anything that could
 * make pg connect somewhere other than the URL's host, or with weaker TLS than the pool configures.
 * Allowed: postgres(ql)://host/... (remote: verified TLS; loopback: plain), and Unix sockets given unambiguously
 * either as a percent-encoded path host or as ?host=/absolute/path with an empty or loopback URL host.
 */
export function resolveBookingTarget(connectionString) {
  let u;
  try { u = new URL(connectionString); } catch { throw reject("not a valid URL"); }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") throw reject("scheme must be postgres or postgresql");
  if ([...u.searchParams.keys()].some((k) => TLS_OVERRIDE_PARAM.test(k))) {
    throw reject("a URL option would override the verified TLS configuration");
  }
  let urlHost;
  try { urlHost = decodeURIComponent(u.hostname); } catch { throw reject("malformed host"); }
  const hostParams = u.searchParams.getAll("host");
  if (hostParams.length > 1) throw reject("more than one host option");
  let host = urlHost;
  if (hostParams.length === 1) {
    const h = hostParams[0];
    const socketOverride = h.startsWith("/") && !h.includes(",") && (urlHost === "" || LOOPBACK.has(urlHost));
    if (!socketOverride) throw reject("ambiguous host: ?host= may only name a Unix socket directory for a local URL");
    host = h;
  }
  if (!host) throw reject("no host");
  return { host, local: LOOPBACK.has(host) || host.startsWith("/") }; // unix socket directories are local too
}

export function isLoopbackUrl(connectionString) {
  return resolveBookingTarget(connectionString).local;
}

export function createBookingPool({ connectionString, caPem, max = 3, statementTimeoutMs = 5000 } = {}) {
  if (typeof connectionString !== "string" || !connectionString) throw new TypeError("createBookingPool: connectionString required");
  const { host, local } = resolveBookingTarget(connectionString);
  if (!local && !caPem) throw new TypeError("createBookingPool: remote databases require caPem (verified TLS)");
  const ssl = local ? false : { rejectUnauthorized: true, ca: caPem };
  const config = {
    connectionString,
    max,
    ssl,
    statement_timeout: statementTimeoutMs,          // no statement can hold locks for long
    idle_in_transaction_session_timeout: 10000,     // a stuck client cannot keep a transaction open
    application_name: "maravilla-booking"
  };
  // Fail closed on what pg will EFFECTIVELY use (constructing a Client does not connect).
  const eff = new pg.Client(config).connectionParameters;
  if (eff.host !== host) throw reject("effective host differs from the URL host");
  if (eff.ssl !== ssl) throw reject("effective TLS settings differ from the verified configuration");
  return new pg.Pool(config);
}

/** Refuse to operate on a database whose environment marker differs from the expected one. */
export async function assertEnvironment(pool, expected) {
  const r = await pool.query("SELECT environment FROM booking.instance");
  const actual = r.rows[0]?.environment;
  if (actual !== expected) throw new Error(`ENVIRONMENT_MISMATCH: database is ${actual ?? "unknown"}, expected ${expected}`);
}
