// Booking pool TLS/target guard: offline checks of the EFFECTIVE pg connection parameters.
// Fabricated .invalid hosts and dummy data only; a deny-network preload makes every connect/DNS/TLS attempt throw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createBookingPool, isLoopbackUrl } from "../db/lib/pool.js";

// Deny-network preload, used in this process AND inside the CLI child (node --import), so no check can reach the
// network: socket connects, DNS lookups and TLS connects throw before any I/O and leave a marker on stderr.
const DENY_NETWORK_SRC = `
import net from "node:net"; import tls from "node:tls"; import dns from "node:dns";
const deny = (what) => function () { process.stderr.write("NETWORK_ATTEMPT_BLOCKED:" + what + "\\n"); throw new Error("NETWORK_ATTEMPT_BLOCKED"); };
net.Socket.prototype.connect = deny("socket.connect"); net.connect = deny("net.connect"); net.createConnection = deny("net.createConnection");
tls.connect = deny("tls.connect"); dns.lookup = deny("dns.lookup"); dns.promises.lookup = deny("dns.promises.lookup");
`;
const DENY_NETWORK = "data:text/javascript," + encodeURIComponent(DENY_NETWORK_SRC);
await import(DENY_NETWORK);

const CA = "-----BEGIN CERTIFICATE-----\nDUMMY-NOT-A-REAL-CA\n-----END CERTIFICATE-----\n";
const R = "db.remote.example.invalid";

// What a client created by the pool would actually use (pg-pool passes pool.options to new Client; no connect()).
function effective(pool) {
  const p = new pg.Client(pool.options).connectionParameters;
  const ssl = p.ssl;
  return {
    host: p.host,
    tls: !!ssl,
    rejectUnauthorized: !!ssl && typeof ssl === "object" && ssl.rejectUnauthorized === true,
    caPresent: !!ssl && typeof ssl === "object" && ssl.ca === CA
  };
}

const accepted = [
  ["ordinary remote URL", `postgresql://u:dummy@${R}:5432/d`, { host: R, tls: true, rejectUnauthorized: true, caPresent: true }],
  ["postgres: scheme, harmless options", `postgres://u:dummy@${R}/d?application_name=x&options=-c%20search_path%3Dbooking`, { host: R, tls: true, rejectUnauthorized: true, caPresent: true }],
  ["loopback 127.0.0.1", "postgresql://u:dummy@127.0.0.1:5432/d", { host: "127.0.0.1", tls: false, rejectUnauthorized: false, caPresent: false }],
  ["localhost", "postgresql://u:dummy@localhost/d", { host: "localhost", tls: false, rejectUnauthorized: false, caPresent: false }],
  ["IPv6 loopback", "postgresql://u:dummy@[::1]:5432/d", { host: "[::1]", tls: false, rejectUnauthorized: false, caPresent: false }],
  ["Unix socket via ?host= with empty URL host", "postgresql:///d?host=/var/run/postgresql", { host: "/var/run/postgresql", tls: false, rejectUnauthorized: false, caPresent: false }],
  ["Unix socket via ?host= with localhost URL host", "postgresql://u@localhost/d?host=/var/run/postgresql", { host: "/var/run/postgresql", tls: false, rejectUnauthorized: false, caPresent: false }],
  ["Unix socket as percent-encoded host", "postgresql://u@%2Fvar%2Frun%2Fpostgresql/d", { host: "/var/run/postgresql", tls: false, rejectUnauthorized: false, caPresent: false }]
];

for (const [name, url, want] of accepted) {
  test(`accepted: ${name} -> effective target and TLS as configured`, async () => {
    const pool = createBookingPool({ connectionString: url, caPem: CA });
    try { assert.deepEqual(effective(pool), want); } finally { await pool.end(); }
  });
}

const rejected = [
  ["sslmode=disable (TLS off)", `postgresql://u:dummy@${R}/d?sslmode=disable`],
  ["sslmode=no-verify (no certificate check)", `postgresql://u:dummy@${R}/d?sslmode=no-verify`],
  ["sslmode=require (replaces CA)", `postgresql://u:dummy@${R}/d?sslmode=require`],
  ["sslmode=verify-full (replaces CA)", `postgresql://u:dummy@${R}/d?sslmode=verify-full`],
  ["ssl=0", `postgresql://u:dummy@${R}/d?ssl=0`],
  ["ssl=false", `postgresql://u:dummy@${R}/d?ssl=false`],
  ["sslrootcert", `postgresql://u:dummy@${R}/d?sslrootcert=/nonexistent/dummy.crt`],
  ["sslcert/sslkey", `postgresql://u:dummy@${R}/d?sslcert=/nonexistent/c&sslkey=/nonexistent/k`],
  ["upper-case SSLMODE", `postgresql://u:dummy@${R}/d?SSLMODE=disable`],
  ["uselibpqcompat", `postgresql://u:dummy@${R}/d?uselibpqcompat=true`],
  ["localhost URL redirected to a remote ?host= (plaintext to remote)", "postgresql://u:dummy@localhost:5432/d?host=remote.example.invalid"],
  ["remote URL redirected to another remote ?host=", `postgresql://u:dummy@${R}/d?host=other.example.invalid`],
  ["remote URL redirected to ?host=localhost", `postgresql://u:dummy@${R}/d?host=localhost`],
  ["remote URL redirected to a socket ?host=", `postgresql://u:dummy@${R}/d?host=/var/run/postgresql`],
  ["two ?host= options", "postgresql://u@localhost/d?host=/a&host=/b"],
  ["comma host list in ?host=", "postgresql://u@localhost/d?host=/a,/b"],
  ["empty host (environment-dependent)", "postgresql:///d"],
  ["non-postgres scheme", "socket:/var/run/postgresql?db=d"],
  ["not a URL", "host=remote.example.invalid sslmode=disable"]
];

for (const [name, url] of rejected) {
  test(`rejected: ${name}`, () => {
    assert.throws(() => createBookingPool({ connectionString: url, caPem: CA }), (e) => {
      assert.ok(e instanceof TypeError);
      assert.match(e.message, /connection string rejected/);
      assert.ok(!e.message.includes("dummy") && !e.message.includes("example.invalid"), "error must not echo the URL");
      return true;
    });
  });
}

test("isLoopbackUrl refuses the localhost-with-remote-?host= form (migration CLI would otherwise skip --allow-remote)", () => {
  assert.throws(() => isLoopbackUrl("postgresql://u@localhost/d?host=remote.example.invalid"), /connection string rejected/);
  assert.equal(isLoopbackUrl("postgresql://u@127.0.0.1/d"), true);
  assert.equal(isLoopbackUrl(`postgresql://u@${R}/d`), false);
});

test("remote URL still requires a CA", () => {
  assert.throws(() => createBookingPool({ connectionString: `postgresql://u@${R}/d` }), /require caPem/);
});

test("rejection messages are static: no supplied URL text is echoed (key, value, userinfo, host, path markers)", () => {
  const M = "zqmarker7731";
  const urls = [
    `postgresql://${M}u:${M}p@${M}h.example.invalid/${M}d?ssl${M}=${M}v`,
    `postgresql://${M}u:${M}p@${M}h.example.invalid/${M}d?SSLMODE=${M}v`,
    `postgresql://${M}u:${M}p@localhost/${M}d?host=${M}remote.example.invalid`,
    `postgresql://${M}u@localhost/${M}d?host=/${M}a&host=/${M}b`,
    `${M}scheme://${M}h/${M}d`,
    `not a url ${M}`
  ];
  const STATIC = /^createBookingPool: connection string rejected \((not a valid URL|scheme must be postgres or postgresql|a URL option would override the verified TLS configuration|malformed host|more than one host option|ambiguous host: \?host= may only name a Unix socket directory for a local URL|no host|effective host differs from the URL host|effective TLS settings differ from the verified configuration)\)$/;
  for (const url of urls) {
    assert.throws(() => createBookingPool({ connectionString: url, caPem: CA }), (e) => {
      assert.match(e.message, STATIC);
      assert.ok(!e.message.toLowerCase().includes(M), "error must not echo supplied URL text");
      return true;
    });
  }
});

test("migration CLI refuses an ambiguous host override before any connection, without printing the URL", () => {
  const cli = fileURLToPath(new URL("../scripts/db-migrate.mjs", import.meta.url));
  const r = spawnSync(process.execPath, ["--import", DENY_NETWORK, cli, "status", "--env", "test", "--url-env", "MV_GUARD_URL"], {
    env: { PATH: process.env.PATH, MV_GUARD_URL: "postgresql://u:dummy@localhost:5432/d?host=remote.example.invalid" },
    encoding: "utf8", timeout: 20000
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /connection string rejected/);
  assert.ok(!/NETWORK_ATTEMPT_BLOCKED/.test(r.stderr), "the CLI must refuse before any network attempt");
  assert.ok(!/dummy|example\.invalid|ENOTFOUND|ECONNREFUSED/.test(r.stdout + r.stderr));
});
