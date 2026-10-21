#!/usr/bin/env node
// scripts/db-migrate.mjs — Stage E2B. Local migration runner for the booking schema.
//
// Usage:
//   node scripts/db-migrate.mjs <status|up|down> --env test --url-env NAME_OF_ENV_VAR [--to N] [--ca-file path] [--allow-remote]
//
// Safety:
// - The connection string is read from the environment variable NAMED by --url-env (never printed, never DATABASE_URL).
// - Only loopback databases unless --allow-remote is given; remote use (stage E2C) needs separate owner approval
//   and a CA file for verified TLS.
// - `down` is refused for --env live (forward-only policy).
import { readFileSync } from "node:fs";
import { createBookingPool, isLoopbackUrl } from "../db/lib/pool.js";
import { migrateUp, migrateDown, migrationStatus } from "../db/lib/migrate.js";

function parse(argv) {
  const [cmd, ...rest] = argv;
  const o = { cmd };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--allow-remote") o.allowRemote = true;
    else if (["--env", "--url-env", "--to", "--ca-file"].includes(a)) o[a.slice(2)] = rest[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

async function main() {
  const o = parse(process.argv.slice(2));
  if (!["status", "up", "down"].includes(o.cmd)) throw new Error("command must be status, up or down");
  if (!o["url-env"]) throw new Error("--url-env is required (name of the environment variable holding the URL)");
  if (o["url-env"] === "DATABASE_URL") throw new Error("DATABASE_URL is the retired legacy variable; use a dedicated variable");
  const url = process.env[o["url-env"]];
  if (!url) throw new Error(`environment variable ${o["url-env"]} is not set`);
  const local = isLoopbackUrl(url);
  if (!local && !o.allowRemote) throw new Error("remote database refused: pass --allow-remote only with explicit owner approval (stage E2C)");
  const caPem = o["ca-file"] ? readFileSync(o["ca-file"], "utf8") : undefined;
  const pool = createBookingPool({ connectionString: url, caPem, max: 1 });
  const client = await pool.connect();
  try {
    const to = o.to !== undefined ? Number(o.to) : undefined;
    if (o.cmd === "status") console.log(JSON.stringify(await migrationStatus(client, { env: o.env })));
    if (o.cmd === "up") console.log(JSON.stringify({ applied: await migrateUp(client, { env: o.env, ...(to !== undefined ? { to } : {}) }) }));
    if (o.cmd === "down") console.log(JSON.stringify({ reverted: await migrateDown(client, { env: o.env, ...(to !== undefined ? { to } : {}) }) }));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e.code ? `${e.code}` : e.message); process.exitCode = 1; });
