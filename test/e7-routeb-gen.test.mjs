// Route B generator — offline unit tests (no DB): determinism, committed-output parity, verbatim embedding, checksum parity with the
// accepted runner's loadMigrations, db-smoke parity of the POST privilege expectations, built-ins-only source, and refusal rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { generate, loadMigrationFiles, EXPECTED_APP_PRIVS, FUNCS_ALLOWED, FUNCS_DENIED, LOCK_KEY, GenError } from "../scripts/e7-routeb-gen.mjs";
import { loadMigrations } from "../db/lib/migrate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "claude", "evidence", "e7-routeb-2026-11-05");
const sha = (b) => createHash("sha256").update(b).digest("hex");

test("G1 deterministic: two runs byte-identical and equal to the committed evidence files (no extra / missing file)", () => {
  const a = generate(), b = generate();
  assert.deepEqual(a.files.map((f) => f.name), b.files.map((f) => f.name));
  a.files.forEach((f, i) => assert.ok(f.content.equals(b.files[i].content), f.name));
  const committed = readdirSync(OUT).sort();
  assert.deepEqual(committed, a.files.map((f) => f.name).sort());
  for (const f of a.files) assert.ok(readFileSync(join(OUT, f.name)).equals(f.content), `committed ${f.name} differs from generator output`);
});

test("G2 each script embeds its migration VERBATIM once, between the markers, inside exactly one BEGIN ... COMMIT", () => {
  const { files, manifest } = generate();
  for (const s of manifest.scripts) {
    const f = files.find((x) => x.name === s.file).content;
    const up = readFileSync(join(ROOT, "db", "migrations", `${String(s.version).padStart(4, "0")}_${s.name}.up.sql`));
    assert.ok(f.subarray(s.bodyOffset, s.bodyOffset + s.bodyLength).equals(up), `${s.file} body is not byte-identical`);
    assert.equal(f.indexOf(up), s.bodyOffset); assert.equal(f.indexOf(up, s.bodyOffset + 1), -1);
    assert.equal(sha(f), s.scriptSha256); assert.equal(f.length, s.scriptBytes);
    const wrapper = Buffer.concat([f.subarray(0, s.bodyOffset), f.subarray(s.bodyOffset + s.bodyLength)]).toString("utf8");
    assert.equal(wrapper.match(/^BEGIN;$/gm).length, 1); assert.equal(wrapper.match(/^COMMIT;$/gm).length, 1);
    const code = wrapper.split("\n").filter((l) => !l.startsWith("--")).join("\n");   // executable wrapper lines (comments excluded)
    assert.equal(code.match(new RegExp(`^SELECT pg_advisory_xact_lock\\(${LOCK_KEY}\\);$`, "gm")).length, 1);
    assert.match(wrapper, /SELECT set_config\('booking\.migration_environment', 'test', true\);/);
    assert.match(wrapper, new RegExp(`VALUES \\(${s.version}, '${s.name}', '${s.upChecksum}', '${s.downChecksum}', 'test'\\);\\nCOMMIT;\\n$`));
    assert.doesNotMatch(code, /ROLLBACK|\bDROP\b|TRUNCATE|\bDELETE\b|\bUPDATE\b|\bGRANT\b|\bREVOKE\b|\bSELECT\s+\*|intent_guests/i);
    // the lock comes before the guard, the guard before set_config, set_config before the body, the INSERT after it
    const iLock = wrapper.indexOf("\nSELECT pg_advisory_xact_lock"), iGuard = wrapper.indexOf("DO $e7rb_guard$"), iSet = wrapper.indexOf("SELECT set_config");
    assert.ok(iLock < iGuard && iGuard < iSet && iSet < s.bodyOffset && f.indexOf("INSERT INTO booking_migrations.applied", s.bodyOffset + s.bodyLength) > 0);
  }
});

test("G3 checksum parity with the accepted runner's loadMigrations (db/lib/migrate.js) and the expected prior history in every guard", () => {
  const runner = loadMigrations(), mine = loadMigrationFiles(), { files, manifest } = generate();
  assert.equal(runner.length, 16); assert.equal(mine.length, 16);
  runner.forEach((r, i) => { assert.equal(mine[i].name, r.name); assert.equal(mine[i].upChecksum, r.upChecksum); assert.equal(mine[i].downChecksum, r.downChecksum); });
  assert.deepEqual(manifest.scripts.map((s) => s.version), [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  for (const s of manifest.scripts) {
    const r = runner[s.version - 1]; assert.equal(s.upChecksum, r.upChecksum); assert.equal(s.downChecksum, r.downChecksum);
    const text = files.find((x) => x.name === s.file).content.toString("utf8");
    for (const p of runner.slice(0, s.version - 1)) assert.ok(text.includes(`(${p.version}, '${p.name}', '${p.upChecksum}', '${p.downChecksum}')`), `${s.file} lacks prior ${p.version}`);
    assert.ok(!text.slice(0, s.bodyOffset).includes(`(${s.version}, '${s.name}', '${s.upChecksum}'`), "own version is not in the prior set");
  }
  assert.deepEqual(manifest.history1to5.map((h) => h.version), [1, 2, 3, 4, 5]);
});

test("G4 POST privilege / function expectations equal scripts/db-smoke.mjs (accepted read-only smoke)", () => {
  const src = readFileSync(join(ROOT, "scripts", "db-smoke.mjs"), "utf8");
  const block = (name, open, close) => { const i = src.indexOf(`const ${name} = `); return src.slice(i + `const ${name} = `.length, src.indexOf(close, i) + 1); };
  const S = "SELECT", I = "INSERT", U = "UPDATE";
  const privs = new Function("S", "I", "U", `return (${block("EXPECTED_TABLE_PRIVS", "{", "};")})`)(S, I, U);
  assert.deepEqual(Object.fromEntries(Object.entries(EXPECTED_APP_PRIVS)), privs);
  const allowed = new Function(`return ${block("FUNCS_ALLOWED", "[", "];")}`)(), denied = new Function(`return ${block("FUNCS_DENIED", "[", "];")}`)();
  assert.deepEqual([...FUNCS_ALLOWED], allowed); assert.deepEqual([...FUNCS_DENIED], denied);
  assert.equal(Object.keys(EXPECTED_APP_PRIVS).length, 28);
});

test("G5 verification SQL is read-only and selects no guest column", () => {
  const { files } = generate();
  for (const n of ["pre_verify.sql", "post_verify.sql"]) {
    const t = files.find((f) => f.name === n).content.toString("utf8");
    assert.match(t, /^BEGIN READ ONLY;$/m); assert.match(t, /^ROLLBACK;$/m); assert.doesNotMatch(t, /^COMMIT;$/m);
    assert.doesNotMatch(t, /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT|REVOKE)\s/);
    assert.doesNotMatch(t, /\b(email|phone|guest_name|first_name|last_name|full_name|contact)\b/i);
  }
});

test("G6 generator source: built-in imports only, no runtime / migrate.js / adapter import, no containment-pinned name", () => {
  const src = readFileSync(join(ROOT, "scripts", "e7-routeb-gen.mjs"), "utf8");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ["node:crypto", "node:fs", "node:path", "node:url"]);
  assert.doesNotMatch(src, /import\(|require\(/);
  assert.ok(!src.includes(["hostaway", "reservations"].join("-")));
});

function fixture(files) {
  const d = mkdtempSync(join(tmpdir(), "rb-gen-"));
  for (const [n, c] of Object.entries(files)) writeFileSync(join(d, n), c);
  return d;
}
test("G7 refusals: CR / BOM / NUL / non-UTF-8 / gap / missing pair / bad name; top-level tx control or guard tag in a body", () => {
  const ok = "-- x\nSELECT 1;\n";
  const cases = [
    [{ "0001_a.up.sql": "SELECT 1;\r\n", "0001_a.down.sql": ok }, "NUL_OR_CR"],
    [{ "0001_a.up.sql": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(ok)]), "0001_a.down.sql": ok }, "BOM"],
    [{ "0001_a.up.sql": Buffer.from([0x53, 0x00, 0x0a]), "0001_a.down.sql": ok }, "NUL_OR_CR"],
    [{ "0001_a.up.sql": Buffer.from([0x2d, 0x2d, 0xff, 0x0a]), "0001_a.down.sql": ok }, "NOT_EXACT_UTF8"],
    [{ "0001_a.up.sql": ok, "0001_a.down.sql": ok, "0003_c.up.sql": ok, "0003_c.down.sql": ok }, "GAP"],
    [{ "0001_a.up.sql": ok }, "MISSING_PAIR"],
    [{ "0001_A.up.sql": ok }, "BAD_FILENAME"]];
  for (const [files, code] of cases) {
    const d = fixture(files);
    try { assert.throws(() => loadMigrationFiles(d), (e) => e instanceof GenError && e.code === code, code); } finally { rmSync(d, { recursive: true, force: true }); }
  }
  // body rules are applied per generated script; a 16-file fixture whose 0006 body is bad
  const base = {};
  for (let v = 1; v <= 16; v++) { const n = String(v).padStart(4, "0"); base[`${n}_m${v}.up.sql`] = ok; base[`${n}_m${v}.down.sql`] = ok; }
  for (const [body, code] of [["SELECT 1;\nCOMMIT;\n", "TX_CONTROL_IN_BODY"], ["BEGIN;\nSELECT 1;\n", "TX_CONTROL_IN_BODY"], ["rollback;\n", "TX_CONTROL_IN_BODY"],
    ["DO $e7rb_guard$ BEGIN END $e7rb_guard$;\n", "GUARD_TAG_IN_BODY"]]) {
    const d = fixture({ ...base, "0006_m6.up.sql": body });
    try { assert.throws(() => generate(d), (e) => e instanceof GenError && e.code === code, code); } finally { rmSync(d, { recursive: true, force: true }); }
  }
  // a PL/pgSQL block's indented BEGIN / END; is not top-level transaction control
  const d = fixture({ ...base, "0006_m6.up.sql": "DO $$\nBEGIN\n  PERFORM 1;\nEND $$;\n" });
  try { assert.equal(generate(d).manifest.scripts.length, 11); } finally { rmSync(d, { recursive: true, force: true }); }
});
