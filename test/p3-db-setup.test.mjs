// P3-1: scripts/mv-db-setup.mjs -- environment validation and output discipline (no database).
import test from "node:test";
import assert from "node:assert/strict";
import { parseSetupEnv, scramVerifier, main, ENV_NAMES, APP_ROLE, NEVER_PROJECT_REFS } from "../scripts/mv-db-setup.mjs";

const OWNER = "Owner-pass/with:odd@chars#1";
const APP = "abcdefghijklmnopqrstuvwxyz012345";
const good = (over = {}) => ({ MV_DB_ACTION: "setup", MV_DB_HOST: "aws-1-us-east-1.pooler.supabase.com", MV_DB_PROJECT_REF: "ewfkrzuwdkbkjeeztzsv",
  MV_DB_OWNER_PASSWORD: OWNER, MV_DB_APP_PASSWORD: APP, MV_DB_CA_FILE: "/nonexistent/ca.crt", ...over });

test("P3-1 env: a complete environment builds session-pooler URLs for the owner and the runtime login", () => {
  const p = parseSetupEnv(good());
  assert.equal(p.ok, true);
  const o = new URL(p.cfg.ownerUrl); const a = new URL(p.cfg.appUrl);
  assert.deepEqual([o.username, o.port, o.hostname, o.pathname, o.search], ["postgres.ewfkrzuwdkbkjeeztzsv", "5432", "aws-1-us-east-1.pooler.supabase.com", "/postgres", ""]);
  assert.equal(decodeURIComponent(o.password), OWNER, "the owner password is URL-encoded, not altered");
  assert.deepEqual([a.username, a.port, decodeURIComponent(a.password)], [`${APP_ROLE}.ewfkrzuwdkbkjeeztzsv`, "5432", APP]);
  const s = parseSetupEnv(good({ MV_DB_ACTION: "status", MV_DB_APP_PASSWORD: "" }));
  assert.equal(s.ok, true); assert.equal(s.cfg.appUrl, null, "status needs no runtime password");
});

test("P3-1 env: refusals are codes; the TEST project can never be a target", () => {
  const code = (over) => parseSetupEnv(good(over)).code;
  assert.equal(code({ MV_DB_ACTION: "down" }), "ACTION_INVALID");
  assert.equal(code({ MV_DB_HOST: "db.example.com" }), "HOST_INVALID");
  assert.equal(code({ MV_DB_HOST: "aws-1-us-east-1.pooler.supabase.com:6543" }), "HOST_INVALID");
  assert.equal(code({ MV_DB_PROJECT_REF: "short" }), "PROJECT_REF_INVALID");
  for (const ref of NEVER_PROJECT_REFS) assert.equal(code({ MV_DB_PROJECT_REF: ref }), "PROJECT_IS_TEST_DATABASE");
  assert.equal(code({ MV_DB_OWNER_PASSWORD: "" }), "OWNER_PASSWORD_REQUIRED");
  assert.equal(code({ MV_DB_OWNER_PASSWORD: "has space in it" }), "OWNER_PASSWORD_REQUIRED");
  assert.equal(code({ MV_DB_APP_PASSWORD: "tooshort1" }), "APP_PASSWORD_FORMAT");
  assert.equal(code({ MV_DB_APP_PASSWORD: "abcdefghijklmnopqrstuvwx-1234567" }), "APP_PASSWORD_FORMAT");
  assert.equal(code({ MV_DB_OWNER_PASSWORD: APP }), "APP_PASSWORD_EQUALS_OWNER");
  assert.equal(code({ MV_DB_CA_FILE: "" }), "CA_FILE_REQUIRED");
  assert.deepEqual(Object.values(ENV_NAMES).sort(), ["MV_DB_ACTION", "MV_DB_APP_PASSWORD", "MV_DB_CA_FILE", "MV_DB_HOST", "MV_DB_OWNER_PASSWORD", "MV_DB_PROJECT_REF"]);
});

test("P3-1 scram: verifier shape; same salt -> same verifier; the password is not in it", () => {
  const salt = Buffer.from("0123456789abcdef");
  const v = scramVerifier(APP, salt);
  assert.match(v, /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/);
  assert.equal(v, scramVerifier(APP, salt));
  assert.notEqual(scramVerifier(APP), scramVerifier(APP), "a fresh random salt each time by default");
  assert.equal(v.includes(APP), false);
  assert.throws(() => scramVerifier("short"), TypeError);
});

test("P3-1 main: one JSON line, never a secret; an unreadable CA refuses before any connection", async () => {
  const lines = []; let pools = 0;
  const rc = await main(good(), (l) => lines.push(l), { createPool: () => { pools += 1; throw new Error("no"); } });
  assert.equal(rc, 1); assert.equal(lines.length, 1); assert.equal(pools, 0);
  const r = JSON.parse(lines[0]);
  assert.deepEqual([r.version, r.environment, r.outcome, r.code], ["mv-db-setup-v1", "live", "REFUSED", "CA_UNREADABLE"]);
  assert.equal(lines[0].includes(OWNER) || lines[0].includes(APP), false);
  const bad = []; assert.equal(await main(good({ MV_DB_PROJECT_REF: "mxotevtiscernhqilyiu" }), (l) => bad.push(l)), 1);
  assert.equal(JSON.parse(bad[0]).code, "PROJECT_IS_TEST_DATABASE");
});
