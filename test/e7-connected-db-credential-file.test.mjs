// E7 G3a — owner DB login-file ingress (contract claude/e7-g3a-native-inspect-and-db-ingress.md §2, §6). OFFLINE: real temp files with
// SYNTHETIC canary credentials only (never real values); the accepted native read-only adapter; no DB connection, pool, DNS or network.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, chmodSync, symlinkSync, linkSync, mkdirSync, renameSync, appendFileSync, chownSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { constants as FS_CONSTANTS } from "node:fs";
import { createNativeAdapters } from "../scripts/e7-connected/probe-cli-main.mjs";
import { readProbeCredentialFile } from "../scripts/e7-connected/probe-credential-file.mjs";
import * as DB from "../scripts/e7-connected/db-credential-file.mjs";

let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline G3a DB ingress suite)"); };
const DIRS = [];
after(() => { globalThis.fetch = realFetch; for (const d of DIRS) rmSync(d, { recursive: true, force: true }); assert.equal(netAttempts, 0); });

const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), ".."));
const UID = process.getuid();
const nat = createNativeAdapters({ platform: process.platform, uid: UID, constants: FS_CONSTANTS, gate: () => {} });
const FS = nat.credentialFs;                                    // the ACCEPTED native read-only adapter (real fs)
const CANARY = "CANARYpw7f3e9Q";                                  // SYNTHETIC — never a real credential
const CANARY_USER = "canaryuser91";
const url = (role, o = {}) => `postgresql://${o.user ?? `${CANARY_USER}_${role.slice(11)}`}:${o.pw ?? CANARY}@${o.host ?? "db.synthetic.invalid"}:${o.port ?? "5432"}/${o.db ?? "synthdb"}${o.q ?? "?sslmode=require"}`;
const login = (role, o = {}) => JSON.stringify({ schema: "e7-db-login-v1", role, connectionString: url(role, o), ...(o.extra ?? {}) });
const dirOf = () => { const d = mkdtempSync(join(tmpdir(), "g3a-db-")); chmodSync(d, 0o700); DIRS.push(d); return d; };
const put = (d, name, text, mode = 0o600) => { const f = join(d, name); writeFileSync(f, text); chmodSync(f, mode); return f; };
const pair = (o = {}) => { const d = dirOf(); return { d, app: put(d, "app.json", o.app ?? login("mv_booking_app")), report: put(d, "report.json", o.report ?? login("mv_booking_report")) }; };
const read = (p, fs = FS) => DB.readDbLoginFiles({ appPath: p.app, reportPath: p.report, repoRoot: ROOT, fs });
const noCanary = (v, label) => {
  for (const s of [JSON.stringify(v), inspect(v, { depth: 10 }), String(v && v.code), `${v}`]) {
    assert.ok(!s.includes(CANARY) && !s.includes(CANARY_USER) && !s.includes("synthetic.invalid") && !s.includes("synthdb"), `${label}: no canary / user / host / db in output: ${s.slice(0, 200)}`);
  }
};

test("D1 happy path: two owner-only files → PRIVATE logins (role enumerable, connectionString NON-enumerable); nothing secret serializes / inspects", async () => {
  const p = pair();
  const r = await read(p);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(Object.keys(r), ["ok", "logins"]); assert.deepEqual(Object.keys(r.logins.app), ["role"]);
  assert.deepEqual([r.logins.app.role, r.logins.report.role], ["mv_booking_app", "mv_booking_report"]);
  assert.equal(r.logins.app.connectionString, url("mv_booking_app")); assert.equal(r.logins.report.connectionString, url("mv_booking_report"));
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.logins) && Object.isFrozen(r.logins.app));
  noCanary(r, "success");
  // sslmode is optional; other accepted sslmodes; postgres: scheme
  for (const q of ["", "?sslmode=verify-full", "?sslmode=verify-ca"]) assert.equal((await read(pair({ app: login("mv_booking_app", { q }), report: login("mv_booking_report", { q }) }))).ok, true, q);
  const s2 = pair({ app: login("mv_booking_app").replace("postgresql://", "postgres://"), report: login("mv_booking_report") });
  assert.equal((await read(s2)).ok, true);
});

test("D2 schema / role / URL structure / cross-file TEXT checks → code-only refusals (slot named), canary never echoed", async () => {
  const cases = [
    ["missing key", { app: JSON.stringify({ schema: "e7-db-login-v1", role: "mv_booking_app" }) }, "DB_LOGIN_SHAPE", "app"],
    ["extra key", { app: login("mv_booking_app", { extra: { note: "x" } }) }, "DB_LOGIN_SHAPE", "app"],
    ["wrong schema", { app: login("mv_booking_app").replace("e7-db-login-v1", "e7-db-login-v2") }, "DB_LOGIN_SHAPE", "app"],
    ["duplicate key", { app: `{"schema":"e7-db-login-v1","role":"mv_booking_app","role":"mv_booking_app","connectionString":"${url("mv_booking_app")}"}` }, "CRED_SHAPE", "app"],
    ["escaped duplicate", { app: `{"schema":"e7-db-login-v1","role":"mv_booking_app","rol\\u0065":"x","connectionString":"${url("mv_booking_app")}"}` }, "CRED_SHAPE", "app"],
    ["non-string value", { app: `{"schema":"e7-db-login-v1","role":"mv_booking_app","connectionString":1}` }, "CRED_SHAPE", "app"],
    ["not json", { app: "postgresql://x" }, "CRED_PARSE", "app"],
    ["role swapped", { app: login("mv_booking_report"), report: login("mv_booking_app") }, "DB_ROLE_MISMATCH", "app"],
    ["report wrong role", { report: login("mv_booking_owner") }, "DB_ROLE_MISMATCH", "report"],
    ["scheme", { app: login("mv_booking_app").replace("postgresql://", "mysql://") }, "DB_URL_SCHEME", "app"],
    ["no password", { app: login("mv_booking_app", { pw: "" }).replace(":@", "@") }, "DB_URL_PASSWORD", "app"],
    ["no user", { app: JSON.stringify({ schema: "e7-db-login-v1", role: "mv_booking_app", connectionString: `postgresql://:${CANARY}@h.invalid:5432/d` }) }, "DB_URL_USER", "app"],
    ["no port", { app: login("mv_booking_app", { port: "" }).replace(".invalid:/", ".invalid/") }, "DB_URL_PORT", "app"],
    ["port range", { app: login("mv_booking_app", { port: "70000" }) }, "DB_URL_INVALID", "app"],
    ["no database", { app: login("mv_booking_app", { db: "" }) }, "DB_URL_DATABASE", "app"],
    ["nested path", { app: login("mv_booking_app", { db: "a/b" }) }, "DB_URL_DATABASE", "app"],
    ["other param", { app: login("mv_booking_app", { q: "?sslmode=require&options=x" }) }, "DB_URL_PARAMS", "app"],
    ["sslmode disable", { app: login("mv_booking_app", { q: "?sslmode=disable" }) }, "DB_URL_PARAMS", "app"],
    ["fragment", { app: login("mv_booking_app", { q: "?sslmode=require#frag" }) }, "DB_URL_PARAMS", "app"],
    ["unparseable", { app: JSON.stringify({ schema: "e7-db-login-v1", role: "mv_booking_app", connectionString: `postgresql://${CANARY}@[bad` }) }, "DB_URL_INVALID", "app"],
    ["whitespace", { app: JSON.stringify({ schema: "e7-db-login-v1", role: "mv_booking_app", connectionString: `postgresql://u:${CANARY} @h.invalid:5432/d` }) }, "DB_URL_INVALID", "app"],
    ["too long", { app: login("mv_booking_app", { db: "d".repeat(2100) }) }, "DB_URL_TOO_LONG", "app"],
    ["target host differs", { report: login("mv_booking_report", { host: "other.synthetic.invalid" }) }, "DB_TARGET_TEXT_MISMATCH", null],
    ["target db differs", { report: login("mv_booking_report", { db: "otherdb" }) }, "DB_TARGET_TEXT_MISMATCH", null]
  ];
  for (const [label, files, code, slot] of cases) {
    const r = await read(pair(files));
    assert.deepEqual([r.ok, r.code, r.slot], [false, code, slot], `${label}: ${JSON.stringify(r)}`);
    assert.deepEqual(Object.keys(r).sort(), ["closeState", "code", "ok", "slot"]);
    noCanary(r, label);
  }
  // identical strings in both files (the role field differs but the connection string is the same login) → refused
  { const cs = url("mv_booking_app");
    const r = await read(pair({ app: JSON.stringify({ schema: "e7-db-login-v1", role: "mv_booking_app", connectionString: cs }),
      report: JSON.stringify({ schema: "e7-db-login-v1", role: "mv_booking_report", connectionString: cs }) }));
    assert.deepEqual([r.ok, r.code], [false, "DB_LOGINS_IDENTICAL"]); noCanary(r, "identical"); }
  // explicit inputs only: same path, relative / non-canonical paths, missing / extra option keys, getters, proxies → DB_INPUT_INVALID / DB_PATHS_SAME
  const p = pair();
  assert.equal((await DB.readDbLoginFiles({ appPath: p.app, reportPath: p.app, repoRoot: ROOT, fs: FS })).code, "DB_PATHS_SAME");
  let getterCalls = 0;
  const g = { appPath: p.app, reportPath: p.report, repoRoot: ROOT }; Object.defineProperty(g, "fs", { enumerable: true, get: () => { getterCalls += 1; return FS; } });
  for (const bad of [{ appPath: "rel.json", reportPath: p.report, repoRoot: ROOT, fs: FS }, { appPath: `${p.d}/./app.json`, reportPath: p.report, repoRoot: ROOT, fs: FS },
    { appPath: p.app, reportPath: p.report, repoRoot: ROOT }, { appPath: p.app, reportPath: p.report, repoRoot: ROOT, fs: FS, env: process.env }, g,
    new Proxy({ appPath: p.app, reportPath: p.report, repoRoot: ROOT, fs: FS }, {}), null, "x"]) assert.equal((await DB.readDbLoginFiles(bad)).code, "DB_INPUT_INVALID");
  assert.equal(getterCalls, 0);
  assert.equal((await DB.readDbLoginFiles({ appPath: p.app, reportPath: p.report, repoRoot: ROOT, fs: { ...FS, platform: "win32" } })).code, "CRED_PLATFORM_UNSUPPORTED");
});

test("D3 file safety = the accepted reader's (parity on the SAME real files): mode / owner / links / symlink / dir / size / missing / in-repo / git-tree / parent symlink / replace + growth races", async () => {
  const provider = (f) => readProbeCredentialFile({ path: f, repoRoot: ROOT, needs: { hostaway: true, stripe: false }, fs: FS });
  const valid = login("mv_booking_app");
  const scen = [];
  { const d = dirOf(); scen.push(["mode 0644", put(d, "a.json", valid, 0o644), "CRED_MODE"]); }
  { const d = dirOf(); scen.push(["mode 0400", put(d, "a.json", valid, 0o400), "CRED_MODE"]); }
  { const d = dirOf(); const f = put(d, "a.json", valid); chownSync(f, 4321, 4321); scen.push(["owner", f, "CRED_OWNER"]); }
  { const d = dirOf(); const f = put(d, "a.json", valid); linkSync(f, join(d, "b.json")); scen.push(["hard link", f, "CRED_LINKS"]); }
  { const d = dirOf(); const f = put(d, "a.json", valid); symlinkSync(f, join(d, "s.json")); scen.push(["symlink", join(d, "s.json"), "CRED_NOT_REGULAR"]); }
  { const d = dirOf(); mkdirSync(join(d, "dir.json")); scen.push(["directory", join(d, "dir.json"), "CRED_NOT_REGULAR"]); }
  { const d = dirOf(); scen.push(["empty", put(d, "a.json", ""), "CRED_SIZE"]); }
  { const d = dirOf(); scen.push(["oversize", put(d, "a.json", "x".repeat(4097)), "CRED_SIZE"]); }
  { const d = dirOf(); scen.push(["missing", join(d, "nope.json"), "CRED_MISSING"]); }
  { scen.push(["in repo", join(ROOT, "test", "e7-g3a-in-repo-never-created.json"), "CRED_IN_REPO"]); }
  { const d = dirOf(); mkdirSync(join(d, ".git")); mkdirSync(join(d, "sub")); chmodSync(join(d, "sub"), 0o700); scen.push(["git tree", put(join(d, "sub"), "a.json", valid), "CRED_IN_GIT_TREE"]); }
  { const d = dirOf(); mkdirSync(join(d, "real")); const f = put(join(d, "real"), "a.json", valid); symlinkSync(join(d, "real"), join(d, "alias")); scen.push(["parent symlink", join(d, "alias", "a.json"), "CRED_PATH_NOT_CANONICAL"]); void f; }
  for (const [label, f, code] of scen) {
    const d2 = dirOf(); const rep = put(d2, "report.json", login("mv_booking_report"));
    const r = await DB.readDbLoginFiles({ appPath: f, reportPath: rep, repoRoot: ROOT, fs: FS });
    const a = await provider(f);
    assert.deepEqual([r.ok, r.code, r.slot], [false, code, "app"], `${label}: ${JSON.stringify(r)}`);
    assert.equal(r.code, a.code, `${label}: same refusal as the accepted reader`); assert.equal(r.closeState, a.closeState, `${label}: same close state`);
  }
  // RACES through a wrapping adapter (labelled TEST-ONLY): replace the file between the pre-lstat and the open; grow it after the first read
  const raced = (mut) => ({ ...FS, open: async (p, kind) => { const h = await (mut.beforeOpen ? (await mut.beforeOpen(p), FS.open(p, kind)) : FS.open(p, kind));
    let n = 0; return { stat: h.stat, close: h.close, read: async (b, o, l) => { const r = await h.read(b, o, l); n += 1; if (n === 1 && mut.afterRead) await mut.afterRead(p); return r; } }; } });
  const replace = { beforeOpen: async (p) => { const t = `${p}.new`; writeFileSync(t, login("mv_booking_app")); chmodSync(t, 0o600); renameSync(t, p); } };
  const grow = { afterRead: async (p) => { appendFileSync(p, " "); } };
  for (const [label, mut] of [["replaced before open", replace], ["grown after read", grow]]) {
    const p1 = pair(); const r = await read(p1, raced(mut));
    const p2 = pair(); const a = await readProbeCredentialFile({ path: p2.app, repoRoot: ROOT, needs: { hostaway: true, stripe: false }, fs: raced(mut) });
    assert.deepEqual([r.ok, r.code, r.slot, r.closeState], [false, "CRED_CHANGED", "app", "CLOSED"], `${label}: ${JSON.stringify(r)}`);
    assert.deepEqual([a.code, a.closeState], [r.code, r.closeState], `${label}: parity`);
    noCanary(r, label);
  }
  // a report-slot refusal names the report slot
  { const d = dirOf(); const r = await DB.readDbLoginFiles({ appPath: put(d, "app.json", login("mv_booking_app")), reportPath: put(d, "r.json", login("mv_booking_report"), 0o640), repoRoot: ROOT, fs: FS });
    assert.deepEqual([r.code, r.slot], ["CRED_MODE", "report"]); }
});

test("D4 provenance / inertness: the copied segments are VERBATIM from the pinned accepted reader; imports node:util only; no pg / pool / net / process / env; accepted reader unchanged", () => {
  const origin = "scripts/e7-connected/probe-credential-file.mjs";
  const ob = readFileSync(join(ROOT, origin));
  assert.deepEqual({ ...DB.COPIED_ORIGIN }, { [origin]: createHash("sha256").update(ob).digest("hex") }, "origin pin = the accepted reader's current bytes");
  const lines = ob.toString("utf8").split("\n");
  const src = readFileSync(join(ROOT, "scripts/e7-connected/db-credential-file.mjs"), "utf8");
  for (const [k, [a, b]] of Object.entries(DB.COPIED_SEGMENTS)) assert.ok(src.includes(lines.slice(a - 1, b).join("\n")), `segment ${k} (${a}–${b}) verbatim`);
  assert.deepEqual([...src.matchAll(/^import\s[\s\S]*?from\s+"([^"]+)";/gm)].map((x) => x[1]), ["node:util"]);
  const code = src.replace(/\/\/.*$/gm, "").replace(/"[^"]*"/g, "\"\"");
  for (const bad of ["import(", "require(", "process.", "globalThis", "fetch(", "Pool", "Client(", "connect(", "lookup(", "setTimeout"]) assert.ok(!code.includes(bad), bad);
});
