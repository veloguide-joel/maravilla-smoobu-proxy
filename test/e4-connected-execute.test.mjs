// Connected launcher + recovery readiness (offline): canonical run location, replay/concurrency/alternate-location refusal,
// bindings before any prompt, zero-write dry-run, one create + one cancel through the URL guard, read-only recovery.
// Synthetic guest (example.invalid), fake fetch, temporary directories only. No provider, no credential.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname, relative } from "node:path";

const X = await import("../scripts/e4-connected/connected-execute.mjs");
const RC = await import("../scripts/e4-connected/connected-recover.mjs");
const C = await import("../scripts/e4-connected/connected-path.mjs");
const J = await import("../scripts/e4-write-runner/journal.mjs");
const ROOT = new URL("..", import.meta.url).pathname;
const SHA = "d".repeat(40);
const NOW = () => new Date("2026-11-01T18:00:00.000Z");
const L = 603566;
const STAY = { arrivalDate: "2027-04-05", departureDate: "2027-04-07" };
const NIGHTS = ["2027-04-05", "2027-04-06"];
const GUEST = { firstName: "Synthetic", lastName: "Tester", email: "e4-synthetic@example.invalid" };
const TOTAL = 320000;
const LEAKS = ["Synthetic", "Tester", "example.invalid", "PROVIDER-TEXT", "MESSAGE-BODY", "98765-603566", "FAKE-TOKEN", "FAKE-SECRET"];
const leakFree = (o) => { const s = JSON.stringify(o); for (const x of LEAKS) assert.ok(!s.includes(x), `leak: ${x}`); };
const manifest = (over = {}) => ({ ...C.connectedManifestTemplate(), guests: 2, totalMinor: TOTAL, window: { start: "2027-04-01", end: "2027-04-30" },
  stay: { ...STAY }, guest: { ...GUEST }, reviewedCommit: SHA, ...over });
const V = C.validateConnectedManifest(manifest(), { now: NOW });

const gitFor = (sources, { head = SHA, dirty = "" } = {}) => (args) => {
  if (args[0] === "rev-parse") return { status: 0, stdout: `${head}\n` };
  if (args[0] === "status") return { status: 0, stdout: dirty };
  if (args[0] === "ls-tree") return { status: 0, stdout: sources.map((f) => `100644 blob ${"a".repeat(40)}\t${f}`).join("\n") };
  if (args[0] === "hash-object") return { status: 0, stdout: sources.map(() => "a".repeat(40)).join("\n") };
  return { status: 1, stdout: "" };
};
const GIT = gitFor(X.CONNECTED_EXECUTE_SOURCES);
const RGIT = gitFor(RC.CONNECTED_RECOVER_SOURCES);

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "e4-conn-"));
  mkdirSync(join(base, "code"));
  mkdirSync(join(base, "run", "journal"), { recursive: true });
  writeFileSync(join(base, "run", "e4-manifest.json"), "ORIGINAL-RUN-FILE");
  writeFileSync(join(base, "run", "journal", "e4-journal-old.jsonl"), "{\"type\":\"run-start\"}\n");
  const mpath = join(base, "connected-precheck-manifest.json");
  writeFileSync(mpath, JSON.stringify(manifest()));
  return { base, root: join(base, "code"), mpath };
}
const treeHash = (dir) => {
  const h = createHash("sha256");
  const walk = (d) => { for (const n of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(d, n.name); h.update(relative(dir, p)); if (n.isDirectory()) walk(p); else h.update(readFileSync(p)); } };
  walk(dir); return h.digest("hex");
};

// ---------- fake Hostaway at the fetch level ----------
function world(over = {}) {
  const w = { res: null, log: [], calendar: "available", nextId: 91000001 };
  const ok = (result, extra = {}) => ({ status: 200, json: { status: "success", result: JSON.parse(JSON.stringify(result)), ...extra } });
  const handle = (method, path, q, body) => {
    if (method === "POST" && path === "/accessTokens") return over.token ? over.token() : { status: 200, json: { access_token: "FAKE-TOKEN", token_type: "Bearer", expires_in: 9 } };
    if (method === "POST" && path === `/listings/${L}/calendar/priceDetails`) return ok({ totalPrice: over.price ?? 3200 });
    if (method === "GET" && path === "/reservations") return ok(q.afterId ? [] : w.res && w.res.arrivalDate === q.arrivalStartDate ? [w.res] : []);
    if (method === "POST" && path === "/reservations") {
      w.res = { id: w.nextId, hostawayReservationId: String(w.nextId), listingMapId: body.listingMapId, channelId: body.channelId, reservationId: "98765-603566-2000-1",
        arrivalDate: body.arrivalDate, departureDate: body.departureDate, totalPrice: body.totalPrice, currency: body.currency, status: "new",
        guestName: body.guestName, guestEmail: body.guestEmail, hostNote: "PROVIDER-TEXT", customFieldValues: body.customFieldValues };
      w.calendar = over.calendarAfterCreate ?? "reserved";
      if (over.createReply) return over.createReply(w);
      return ok(w.res);
    }
    if (method === "GET" && w.res && path === `/reservations/${w.res.id}`) return ok(w.res);
    if (method === "GET" && path === "/guestPayments/charges") return ok([], { count: 0 });
    if (method === "GET" && path === "/conversations") return ok(Number(q.offset) === 0 ? [{ id: 7701, reservationId: w.res.id, lastMessage: "MESSAGE-BODY" }] : []);
    if (method === "GET" && path === "/tasks") return ok([]);
    if (method === "GET" && path === `/listings/${L}/calendar`) return over.calendarDays ? ok(over.calendarDays(w)) : ok(NIGHTS.map((date) => ({ date, status: w.calendar, isAvailable: w.calendar === "available" ? 1 : 0 })));
    if (method === "PUT" && w.res && path === `/reservations/${w.res.id}/statuses/cancelled`) {
      if (over.cancelReply) return over.cancelReply(w);
      w.res.status = "cancelled"; w.calendar = "available";
      return ok(w.res);
    }
    return { status: 404, json: { status: "fail", result: "PROVIDER-TEXT" } };
  };
  w.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? "GET";
    const path = u.pathname.replace(/^\/v1/, "");
    w.log.push(`${method} ${path}`);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const r = handle(method, path, Object.fromEntries(u.searchParams), body);
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
  };
  return w;
}
const S = { intervalMs: 1000, timeoutMs: 7000000, maxReads: 12, confirmReads: 2 };
function vclock() {
  let t = 0;
  return { clock: () => t, startTimer: (ms) => ms === S.intervalMs ? { promise: Promise.resolve().then(() => { t += ms; }), cancel() {} } : { promise: new Promise(() => {}), cancel() {} } };
}
const airbnb = (w, seen) => async (x) => { seen?.push(x.stage); return w.calendar === "available" ? "open" : "blocked"; };
const loc = (base) => X.connectedRunLocation(base, V.hash);
const execArgs = (sb, over = {}) => ["--execute", "--manifest", sb.mpath, "--reviewed-commit", SHA, "--confirm", over.confirm ?? V.confirmToken, "--location", over.location ?? loc(sb.base).token];
function deps(sb, w, over = {}) {
  const calls = { prompt: 0, stages: [] };
  return { calls, d: { root: sb.root, base: sb.base, git: GIT, now: NOW, fetchImpl: w.fetch, sleep: async () => {}, timeoutMs: 2000, sync: S, ...vclock(),
    prompt: async () => { calls.prompt++; return { accountId: "201434", clientSecret: "FAKE-SECRET" }; }, airbnbCheckpoint: airbnb(w, calls.stages), ...over } };
}
const writes = (w) => w.log.filter((l) => l === "POST /reservations" || l.startsWith("PUT "));

// ---------- launcher ----------
test("arguments: only --dry-run/--execute with the exact flags; there is no journal-dir, resume or alternate-location option", () => {
  const P = X.parseConnectedExecuteArgs;
  assert.equal(P(["--dry-run", "--manifest", "m", "--reviewed-commit", SHA]).ok, true);
  assert.equal(P(["--execute", "--manifest", "m", "--reviewed-commit", SHA, "--confirm", V.confirmToken, "--location", "a".repeat(12)]).ok, true);
  for (const bad of [[], ["--execute", "--manifest", "m", "--reviewed-commit", SHA, "--confirm", V.confirmToken], ["--dry-run", "--manifest", "m", "--reviewed-commit", SHA, "--journal-dir", "x"],
    ["--execute", "--manifest", "m", "--reviewed-commit", SHA, "--confirm", V.confirmToken, "--journal-dir", "x"], ["--resume", "--manifest", "m", "--reviewed-commit", SHA],
    ["--dry-run", "--manifest", "m", "--manifest", "m"]]) assert.equal(P(bad).ok, false, JSON.stringify(bad));
  assert.equal(P(["--execute", "--manifest", "m", "--reviewed-commit", SHA, "--confirm", "E4-HAPPY-aaaaaaaaaaaa", "--location", "a".repeat(12)]).code, "CONFIRM_TOKEN_INVALID");
  const src = readFileSync(join(ROOT, "scripts/e4-connected/connected-execute.mjs"), "utf8");
  assert.doesNotMatch(src, /process\.argv|promptHostawayCredentials|connectedCredentialPrompt|process\.env/);   // no direct CLI, no raw TTY prompt, no env
});

test("dry-run: zero writes anywhere (no run directory, no connected-runs), no prompt, no network; reports the bound location and tokens", async () => {
  const sb = sandbox(); const w = world(); const { d, calls } = deps(sb, w);
  const before = treeHash(sb.base);
  const r = await X.runConnectedExecuteCli(["--dry-run", "--manifest", sb.mpath, "--reviewed-commit", SHA], d);
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.equal(treeHash(sb.base), before);
  assert.deepEqual(readdirSync(sb.base).sort(), ["code", "connected-precheck-manifest.json", "run"]);
  assert.equal(calls.prompt, 0); assert.equal(w.log.length, 0);
  assert.equal(r.output.confirmToken, V.confirmToken);
  assert.equal(r.output.location.token, loc(sb.base).token);
  assert.equal(r.output.location.runDir, join(resolve(sb.base), "connected-runs", V.hash));
  assert.equal(r.output.location.wouldRefuseAsReplay, false);
  assert.equal(r.output.plan.writeBudget.create, 1); assert.equal(r.output.plan.writeBudget.cancel, 1);
  leakFree(r.output);
});

test("full run: ONE create + ONE cancel through the URL guard, exclusive run directory holding only the journal; original run folder untouched", async () => {
  const sb = sandbox(); const w = world(); const { d, calls } = deps(sb, w);
  const runBefore = treeHash(join(sb.base, "run"));
  const r = await X.runConnectedExecuteCli(execArgs(sb), d);
  assert.equal(r.exitCode, 0, JSON.stringify(r.output));
  assert.equal(r.output.status, "COMPLETED"); assert.equal(r.output.passed, true);
  assert.deepEqual(writes(w), ["POST /reservations", `PUT /reservations/${w.res.id}/statuses/cancelled`]);
  assert.deepEqual(r.output.writes, { create: 1, cancel: 1 });
  assert.equal(r.output.guard.token, 1); assert.equal(r.output.guard.create, 1); assert.equal(r.output.guard.cancel, 1); assert.equal(r.output.guard.refused, 0);
  assert.deepEqual(calls.stages, ["before-create", "after-create", "after-cancel"]);
  assert.equal(calls.prompt, 1);
  const l = loc(sb.base);
  assert.deepEqual(readdirSync(l.runsRoot), [V.hash]);
  assert.deepEqual(readdirSync(l.runDir), [J.journalFileName(V.hash)]);
  assert.equal(treeHash(join(sb.base, "run")), runBefore);
  const entries = J.readJournalFile(join(l.runDir, J.journalFileName(V.hash)));
  assert.equal(entries.filter((e) => e.type === "intent").length, 2);
  leakFree(r.output); leakFree(entries);
  // ---- replay of the SAME approved manifest/confirm/location: refused before any prompt or network
  const w2 = world(); const x2 = deps(sb, w2);
  const r2 = await X.runConnectedExecuteCli(execArgs(sb), x2.d);
  assert.equal(r2.output.error, "REPLAY_REFUSED_RUN_LOCATION_EXISTS");
  assert.equal(x2.calls.prompt, 0); assert.equal(w2.log.length, 0);
  // ---- recovery inspect of this run: CANCEL_VERIFIED, no network, nothing written
  const before = treeHash(sb.base);
  const ri = await RC.runConnectedRecoverCli(["--inspect", "--manifest", sb.mpath, "--reviewed-commit", SHA, "--location", l.token], { root: sb.root, base: sb.base, git: RGIT });
  assert.equal(ri.exitCode, 0, JSON.stringify(ri.output));
  assert.equal(ri.output.classification.state, "CANCEL_VERIFIED");
  assert.equal(ri.output.classification.reservationId, w.res.id);
  assert.deepEqual(ri.output.classification.unusedRunBudget, { create: 0, cancel: 0 });
  assert.equal(treeHash(sb.base), before);
  leakFree(ri.output);
});

test("bindings before any prompt/network/write: confirm, location, manifest commit, provenance, owner channel", async () => {
  const sb = sandbox(); const w = world();
  const cases = [
    [execArgs(sb, { confirm: "E4-CONNECTED-000000000000" }), {}, "CONFIRM_TOKEN_MISMATCH"],
    [execArgs(sb, { location: "0".repeat(12) }), {}, "LOCATION_TOKEN_MISMATCH"],
    [execArgs(sb), { prompt: undefined }, "OWNER_CHANNEL_MISSING"],
    [execArgs(sb), { airbnbCheckpoint: undefined }, "OWNER_CHANNEL_MISSING"],
    [execArgs(sb), { git: gitFor(X.CONNECTED_EXECUTE_SOURCES, { dirty: " M lib/hostaway-reservations.js" }) }, "SOURCE_DIRTY"],
    [execArgs(sb), { git: gitFor(X.CONNECTED_EXECUTE_SOURCES, { head: "e".repeat(40) }) }, "HEAD_NOT_REVIEWED_COMMIT"],
    [["--execute", "--manifest", sb.mpath, "--reviewed-commit", "e".repeat(40), "--confirm", V.confirmToken, "--location", loc(sb.base).token],
      { git: gitFor(X.CONNECTED_EXECUTE_SOURCES, { head: "e".repeat(40) }) }, "MANIFEST_REVIEWED_COMMIT_MISMATCH"]
  ];
  const before = treeHash(sb.base);
  for (const [argv, over, code] of cases) {
    const { d, calls } = deps(sb, w, over);
    const r = await X.runConnectedExecuteCli(argv, d);
    assert.equal(r.output.error, code); assert.equal(r.exitCode, 2);
    assert.equal(calls.prompt, 0); assert.equal(r.output.credentialsRequested, false);
  }
  assert.equal(w.log.length, 0); assert.equal(treeHash(sb.base), before);
  // a provenance failure is reported before the manifest is even read
  let read = 0;
  const { d } = deps(sb, w, { git: gitFor(X.CONNECTED_EXECUTE_SOURCES, { dirty: "?? x" }), readText: () => { read++; return "{}"; } });
  await X.runConnectedExecuteCli(execArgs(sb), d);
  assert.equal(read, 0);
});

test("alternate location for the SAME manifest is refused: another checkout base gives another location token, before any prompt", async () => {
  const a = sandbox(); const b = sandbox(); const w = world();
  assert.notEqual(loc(a.base).token, loc(b.base).token);
  const { d, calls } = deps(b, w);
  const r = await X.runConnectedExecuteCli(["--execute", "--manifest", b.mpath, "--reviewed-commit", SHA, "--confirm", V.confirmToken, "--location", loc(a.base).token], d);
  assert.equal(r.output.error, "LOCATION_TOKEN_MISMATCH"); assert.equal(calls.prompt, 0); assert.equal(w.log.length, 0);
  assert.deepEqual(readdirSync(b.base).sort(), ["code", "connected-precheck-manifest.json", "run"]);
});

test("concurrent second start of the same manifest: exactly one claims the location; the other stops at RUN_LOCATION_EXISTS with no provider request", async () => {
  const sb = sandbox(); const w1 = world(); const w2 = world();
  let release; const gate = new Promise((r) => { release = r; });
  const x1 = deps(sb, w1, { prompt: async () => { await gate; return { accountId: "201434", clientSecret: "FAKE-SECRET" }; } });
  const x2 = deps(sb, w2, { prompt: async () => { await gate; return { accountId: "201434", clientSecret: "FAKE-SECRET" }; } });
  const p1 = X.runConnectedExecuteCli(execArgs(sb), x1.d); const p2 = X.runConnectedExecuteCli(execArgs(sb), x2.d);
  await new Promise((r) => setTimeout(r, 20)); release();
  const [r1, r2] = await Promise.all([p1, p2]);
  const outs = [[r1, w1], [r2, w2]];
  const winners = outs.filter(([r]) => r.output.stage === "run");
  const losers = outs.filter(([r]) => r.output.error === "RUN_LOCATION_EXISTS");
  assert.equal(winners.length, 1); assert.equal(losers.length, 1);
  assert.equal(losers[0][1].log.length, 0);
  assert.equal(writes(winners[0][1]).length, 2);
});

test("run location must be real directories: a symlinked connected-runs or checkout base is refused (dry-run and execute) with no write", async (t) => {
  const sb = sandbox(); const w = world();
  const elsewhere = mkdtempSync(join(tmpdir(), "e4-elsewhere-"));
  try { symlinkSync(elsewhere, join(sb.base, "connected-runs"), "dir"); } catch { t.skip("symlinks unavailable"); return; }
  for (const argv of [["--dry-run", "--manifest", sb.mpath, "--reviewed-commit", SHA], execArgs(sb)]) {
    const { d, calls } = deps(sb, w);
    const r = await X.runConnectedExecuteCli(argv, d);
    assert.equal(r.output.error, "RUNS_ROOT_NOT_A_REAL_DIRECTORY"); assert.equal(calls.prompt, 0);
  }
  assert.deepEqual(readdirSync(elsewhere), []); assert.equal(w.log.length, 0);
  rmSync(join(sb.base, "connected-runs"));
  const linkBase = join(mkdtempSync(join(tmpdir(), "e4-lb-")), "base");
  symlinkSync(sb.base, linkBase, "dir");
  const { d } = deps(sb, w, { base: linkBase });
  const r = await X.runConnectedExecuteCli(["--dry-run", "--manifest", sb.mpath, "--reviewed-commit", SHA], d);
  assert.equal(r.output.error, "CHECKOUT_BASE_NOT_A_REAL_DIRECTORY");
});

test("credential abort after the bindings: nothing created on disk, nothing sent; the location stays unclaimed", async () => {
  const sb = sandbox(); const w = world();
  const { d } = deps(sb, w, { prompt: async () => { throw Object.assign(new Error("x"), { code: "ABORTED" }); } });
  const r = await X.runConnectedExecuteCli(execArgs(sb), d);
  assert.equal(r.output.error, "ABORTED"); assert.equal(r.output.stage, "credentials");
  assert.equal(w.log.length, 0);
  assert.deepEqual(readdirSync(sb.base).sort(), ["code", "connected-precheck-manifest.json", "run"]);
});

test("cancel reply mismatch: HALTED/exit 3, only mismatching identity field NAMES reported; reads continue; recovery classifies and reconciles read-only", async () => {
  const sb = sandbox();
  const w = world({ cancelReply: (wd) => { wd.res.status = "cancelled"; wd.calendar = "available"; return { status: 200, json: { status: "success", result: { ...wd.res, totalPrice: 9999, hostNote: "PROVIDER-TEXT" } } }; } });
  const { d } = deps(sb, w);
  const r = await X.runConnectedExecuteCli(execArgs(sb), d);
  assert.equal(r.exitCode, 3); assert.equal(r.output.status, "HALTED");
  assert.deepEqual(r.output.commandReply.mismatches, ["totalMinor"]);
  assert.equal(r.output.finalState.status, "cancelled");
  assert.equal(writes(w).length, 2);
  leakFree(r.output);
  const l = loc(sb.base);
  const ri = await RC.runConnectedRecoverCli(["--inspect", "--manifest", sb.mpath, "--reviewed-commit", SHA, "--location", l.token], { root: sb.root, base: sb.base, git: RGIT });
  assert.equal(ri.exitCode, 3);
  assert.equal(ri.output.classification.state, "CANCEL_NOT_VERIFIED");
  assert.deepEqual(ri.output.classification.cancelOutcome.mismatches, ["totalMinor"]);
  assert.equal(ri.output.nextStep, "RECONCILE_READ_ONLY");
  const before = w.log.length;
  const rr = await RC.runConnectedRecoverCli(["--reconcile", "--manifest", sb.mpath, "--reviewed-commit", SHA, "--location", l.token],
    { root: sb.root, base: sb.base, git: RGIT, fetchImpl: w.fetch, sleep: async () => {}, prompt: async () => ({ accountId: "201434", clientSecret: "FAKE-SECRET" }) });
  assert.equal(rr.exitCode, 0, JSON.stringify(rr.output));
  assert.equal(rr.output.reconcile.verdict, "RESERVATION_CANCELLED_CONFIRMED");
  assert.equal(rr.output.reconcile.calendar.code, "CALENDAR_OPEN");
  const recLog = w.log.slice(before);
  assert.ok(recLog.every((x) => x.startsWith("GET ") || x === "POST /accessTokens"), JSON.stringify(recLog));
  assert.equal(rr.output.guard.refused, 0);
  leakFree(rr.output);
});

test("halt before the cancel (side effects present): recovery reports OWNER_DECISION_REQUIRED with exact identity proof and unused budget; it sends no write", async () => {
  const sb = sandbox();
  const w = world();
  const orig = w.fetch;
  w.fetch = async (url, init = {}) => {
    if (String(url).includes("/v1/guestPayments/charges")) { w.log.push("GET /guestPayments/charges"); return new Response(JSON.stringify({ status: "success", result: [{ id: 1 }], count: 1 }), { status: 200 }); }
    return orig(url, init);
  };
  const { d } = deps(sb, w);
  const r = await X.runConnectedExecuteCli(execArgs(sb), d);
  assert.equal(r.output.status, "HALTED"); assert.match(r.output.halt.code, /^CHARGES_(PRESENT|UNKNOWN)$/);
  assert.deepEqual(writes(w), ["POST /reservations"]);
  const l = loc(sb.base);
  const ri = await RC.runConnectedRecoverCli(["--inspect", "--manifest", sb.mpath, "--reviewed-commit", SHA, "--location", l.token], { root: sb.root, base: sb.base, git: RGIT });
  assert.equal(ri.output.classification.state, "CREATED_NO_CANCEL_ATTEMPT");
  assert.deepEqual(ri.output.classification.unusedRunBudget, { create: 0, cancel: 1 });
  const n = w.log.length;
  const rr = await RC.runConnectedRecoverCli(["--reconcile", "--manifest", sb.mpath, "--reviewed-commit", SHA, "--location", l.token],
    { root: sb.root, base: sb.base, git: RGIT, fetchImpl: w.fetch, sleep: async () => {}, prompt: async () => ({ accountId: "201434", clientSecret: "FAKE-SECRET" }) });
  assert.equal(rr.exitCode, 3);
  assert.equal(rr.output.reconcile.verdict, "RESERVATION_ACTIVE_OWNER_DECISION_REQUIRED");
  assert.deepEqual(rr.output.reconcile.decision.target, { reservationId: w.res.id, ref: ri.output.classification.ref, listingId: L, from: STAY.arrivalDate, to: STAY.departureDate });
  assert.equal(rr.output.reconcile.decision.identityProof, "READ_BY_ID_FULL_IDENTITY");
  assert.ok(w.log.slice(n).every((x) => !x.startsWith("PUT") && x !== "POST /reservations"));
  // the launcher cannot resume it either
  const x2 = deps(sb, world());
  assert.equal((await X.runConnectedExecuteCli(execArgs(sb), x2.d)).output.error, "REPLAY_REFUSED_RUN_LOCATION_EXISTS");
});

// ---------- recovery: pure classification and guards ----------
const H = V.hash; const REF0 = "MV-PROBE001"; const REF = "MV-ABCDEF12";
const start = { type: "run-start", runId: "a".repeat(16), manifestHash: H, refs: [REF0, REF] };
const ci = { type: "intent", step: "KW1_CREATE", kind: "create", ref: REF };
// the producer's real code for a reply-verified create (a cancel after any other create outcome is a CANCEL_WITHOUT_VERIFIED_CREATE conflict)
const co = (id, code = "VERIFIED_CREATED") => ({ type: "outcome", step: "KW1_CREATE", kind: "create", ref: REF, code, evidence: { reservationId: id } });
const xi = (id) => ({ type: "intent", step: "KW2_CANCEL", kind: "cancel", reservationId: id, ref: REF });
const xo = (id, code, extra = {}) => ({ type: "outcome", step: "KW2_CANCEL", kind: "cancel", reservationId: id, code, ...extra });

test("classification: every state, and refusal of any journal that is not exactly this run's", () => {
  const K = (es) => RC.classifyConnectedJournal(es, H);
  assert.equal(K([start]).state, "NO_CREATE_ATTEMPTED");
  assert.equal(K([start, ci]).state, "CREATE_OUTCOME_MISSING");
  assert.equal(K([start, ci, { ...co(5), evidence: {} }]).state, "CREATE_NOT_VERIFIED");
  assert.equal(K([start, ci, co(5)]).state, "CREATED_NO_CANCEL_ATTEMPT");
  assert.equal(K([start, ci, co(5), xi(5)]).state, "CANCEL_OUTCOME_MISSING");
  const nv = K([start, ci, co(5), xi(5), xo(5, "CANCEL_RESPONSE_MISMATCH", { mismatches: ["totalMinor"], httpStatus: 200 })]);
  assert.equal(nv.state, "CANCEL_NOT_VERIFIED"); assert.deepEqual(nv.cancelOutcome.mismatches, ["totalMinor"]);
  assert.equal(K([start, ci, co(5), xi(5), xo(5, "VERIFIED_CANCELLED")]).state, "CANCEL_VERIFIED");
  assert.equal(K([start, ci, co(5), xi(6)]).idsConsistent, false);
  assert.equal(K([start, ci, co(5), xi(6)]).reservationId, null);
  const p = K([start, ci, co(70636076)]);
  assert.equal(p.protectedIdSeen, true); assert.equal(p.reservationId, null);
  for (const [es, code] of [[[], "JOURNAL_EMPTY"], [[ci], "JOURNAL_NO_RUN_START"], [[{ ...start, manifestHash: "f".repeat(64) }], "JOURNAL_FOREIGN_MANIFEST"],
    [[start, ci, ci], "JOURNAL_CREATE_BUDGET_INCONSISTENT"], [[start, ci, co(5), xi(5), xi(5)], "JOURNAL_CANCEL_BUDGET_INCONSISTENT"],
    [[start, xi(5)], "JOURNAL_CANCEL_BEFORE_CREATE_OUTCOME"], [[start, { ...ci, ref: "MV-OTHER123" }], "JOURNAL_CREATE_NOT_THIS_RUN"],
    [[start, { type: "intent", step: "HW1_CREATE", kind: "create", ref: REF }], "JOURNAL_ENTRY_NOT_SANITIZED"], [[start, { type: "weird" }], "JOURNAL_UNEXPECTED_ENTRY"],
    [[start, start], "JOURNAL_SECOND_RUN_START"], [[start, { type: "run-end", code: "HALTED" }, ci], "JOURNAL_ENTRY_AFTER_RUN_END"]]) {
    assert.equal(K(es).code, code, code);
  }
});

test("recovery read guards: no write shape exists; reads only of this run's id, lookup and calendar; a protected id never", async () => {
  const st = { readId: 5, arrivalDate: STAY.arrivalDate, calendar: { startDate: NIGHTS[0], endDate: NIGHTS[1] } };
  const A = (req, wk = null) => RC.assertRecoverRequest(req, st, wk);
  assert.equal(A({ method: "GET", path: "/reservations/5", query: { includeResources: 1 } }), "read");
  // a read shape with a write method, or any write kind, is refused (defence in depth beyond the path patterns)
  assert.throws(() => A({ method: "PUT", path: "/reservations/5", query: { includeResources: 1 } }), /REQUEST_NOT_ALLOWLISTED/);
  assert.throws(() => A({ method: "DELETE", path: `/listings/${L}/calendar`, query: st.calendar }), /REQUEST_NOT_ALLOWLISTED/);
  assert.throws(() => A({ method: "GET", path: "/reservations/5", query: { includeResources: 1 } }, "cancel"), /RECOVERY_NEVER_WRITES/);
  for (const [req, wk] of [[{ method: "PUT", path: "/reservations/5/statuses/cancelled", query: {}, body: { cancelledBy: "host" } }, "cancel"],
    [{ method: "POST", path: "/reservations", query: {}, body: {} }, null], [{ method: "GET", path: "/reservations/6", query: { includeResources: 1 } }, null],
    [{ method: "GET", path: "/reservations/70636076", query: { includeResources: 1 } }, null], [{ method: "GET", path: "/listings/603564/calendar", query: st.calendar }, null]]) {
    assert.throws(() => A(req, wk));
  }
  const calls = [];
  const g = RC.guardRecoverFetch(async (u, i) => { calls.push(`${i.method ?? "GET"} ${u}`); return new Response("{}"); }, { readId: 5, calendar: st.calendar, arrivalDate: STAY.arrivalDate });
  await assert.rejects(g.guarded("https://api.hostaway.com/v1/reservations/5/statuses/cancelled", { method: "PUT", body: "{}" }));
  await assert.rejects(g.guarded("https://api.hostaway.com/v1/reservations", { method: "POST", body: "{}" }));
  await g.guarded("https://api.hostaway.com/v1/reservations/5?includeResources=1", { method: "GET" });
  await assert.rejects(g.guarded("https://api.hostaway.com/v1/reservations/5?includeResources=1", { method: "GET" }));   // once
  assert.equal(calls.length, 1); assert.equal(g.used().refused, 3);
});

test("launcher URL guard: only 603566 connected shapes, caps from the step budgets, protected id refused, a second create/cancel refused", async () => {
  const sent = [];
  const g = X.guardConnectedFetch(async (u, i) => { sent.push(`${i.method ?? "GET"} ${new URL(u).pathname}`); return new Response("{}"); },
    { calendar: { startDate: NIGHTS[0], endDate: NIGHTS[1] }, arrivalDate: STAY.arrivalDate, departureDate: STAY.departureDate });
  const B = "https://api.hostaway.com/v1";
  const cb = JSON.stringify({ listingMapId: L, channelId: 2000, currency: "MXN", arrivalDate: STAY.arrivalDate, departureDate: STAY.departureDate });
  await g.guarded(`${B}/reservations`, { method: "POST", body: cb });
  await assert.rejects(g.guarded(`${B}/reservations`, { method: "POST", body: cb }));
  await assert.rejects(g.guarded(`${B}/reservations/70636076/statuses/cancelled`, { method: "PUT", body: JSON.stringify({ cancelledBy: "host" }) }));
  await assert.rejects(g.guarded(`${B}/reservations/5/statuses/cancelled`, { method: "PUT", body: JSON.stringify({ cancelledBy: "guest" }) }));
  await g.guarded(`${B}/reservations/5/statuses/cancelled`, { method: "PUT", body: JSON.stringify({ cancelledBy: "host" }) });
  await assert.rejects(g.guarded(`${B}/reservations/6/statuses/cancelled`, { method: "PUT", body: JSON.stringify({ cancelledBy: "host" }) }));
  await assert.rejects(g.guarded(`${B}/listings/603564/calendar?startDate=${NIGHTS[0]}&endDate=${NIGHTS[1]}`, { method: "GET" }));
  await assert.rejects(g.guarded(`https://evil.example/v1/reservations`, { method: "POST", body: "{}" }));
  await assert.rejects(g.guarded(`${B}/reservations?listingId=${L}&channelId=2000&arrivalStartDate=2027-04-06&arrivalEndDate=2027-04-06&limit=100&includeResources=1`, { method: "GET" }));
  assert.deepEqual(sent, ["POST /v1/reservations", "PUT /v1/reservations/5/statuses/cancelled"]);
});

test("recovery location/journal refusals: wrong token, absent run, empty run dir, foreign content, corrupt journal; nothing written, nothing sent", async () => {
  const sb = sandbox(); const l = loc(sb.base);
  const R = (token, over = {}) => RC.runConnectedRecoverCli(["--inspect", "--manifest", sb.mpath, "--reviewed-commit", SHA, "--location", token], { root: sb.root, base: sb.base, git: RGIT, ...over });
  assert.equal((await R("0".repeat(12))).output.error, "LOCATION_TOKEN_MISMATCH");
  assert.equal((await R(l.token)).output.error, "RUNS_ROOT_NOT_A_REAL_DIRECTORY");
  mkdirSync(l.runsRoot);
  assert.equal((await R(l.token)).output.error, "RUN_LOCATION_ABSENT_OR_NOT_A_REAL_DIRECTORY");
  mkdirSync(l.runDir);
  assert.equal((await R(l.token)).output.error, "RUN_LOCATION_HAS_NO_JOURNAL");
  writeFileSync(join(l.runDir, "other.txt"), "x");
  assert.equal((await R(l.token)).output.error, "RUN_LOCATION_UNEXPECTED_CONTENT");
  rmSync(join(l.runDir, "other.txt"));
  writeFileSync(join(l.runDir, J.journalFileName(V.hash)), "{\"type\":\"run-start\"");
  assert.equal((await R(l.token)).output.error, "JOURNAL_CORRUPT");
  writeFileSync(join(l.runDir, J.journalFileName(V.hash)), `${JSON.stringify({ ...start, manifestHash: "f".repeat(64) })}\n`);
  assert.equal((await R(l.token)).output.error, "JOURNAL_FOREIGN_MANIFEST");
  writeFileSync(join(l.runDir, J.journalFileName(V.hash)), `${JSON.stringify(start)}\n`);
  const ok = await R(l.token);
  assert.equal(ok.exitCode, 0); assert.equal(ok.output.classification.state, "NO_CREATE_ATTEMPTED"); assert.equal(ok.output.nextStep, "NONE_NOTHING_SENT_BY_A_CREATE");
  const rr = await RC.runConnectedRecoverCli(["--reconcile", "--manifest", sb.mpath, "--reviewed-commit", SHA, "--location", l.token],
    { root: sb.root, base: sb.base, git: RGIT, prompt: async () => { throw new Error("must not be asked"); } });
  assert.equal(rr.exitCode, 0); assert.equal(rr.output.credentialsRequested, false);
  assert.equal((await RC.runConnectedRecoverCli(["--inspect", "--manifest", sb.mpath, "--reviewed-commit", SHA, "--location", l.token],
    { root: sb.root, base: sb.base, git: gitFor(RC.CONNECTED_RECOVER_SOURCES, { dirty: " M x" }) })).output.error, "SOURCE_DIRTY");
});

test("provenance metadata: launcher and recovery source lists are exactly their static import closures", () => {
  const closure = (entry) => {
    const seen = new Set();
    const walk = (f) => {
      if (seen.has(f)) return; seen.add(f);
      for (const m of readFileSync(join(ROOT, f), "utf8").matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)) {
        if (m[1].startsWith(".")) walk(relative(ROOT, resolve(dirname(join(ROOT, f)), m[1])).replace(/\\/g, "/"));
        else assert.match(m[1], /^node:(crypto|fs|path|url|child_process)$/, `external import ${m[1]} in ${f}`);
      }
    };
    walk(entry); return [...seen].sort();
  };
  assert.deepEqual(closure("scripts/e4-connected/connected-execute.mjs"), [...X.CONNECTED_EXECUTE_SOURCES].sort());
  assert.deepEqual(closure("scripts/e4-connected/connected-recover.mjs"), [...RC.CONNECTED_RECOVER_SOURCES].sort());
  assert.equal(C.CONNECTED_EXECUTION_WIRED, false);   // the core module itself still has no transport/CLI
  const rsrc = readFileSync(join(ROOT, "scripts/e4-connected/connected-recover.mjs"), "utf8");
  assert.doesNotMatch(rsrc, /writeFileSync|appendFileSync|mkdirSync|createFileJournal|statuses\/cancelled|method: "PUT"|method: "POST"/);
});

// ---------- root review of 9e00f47: R1..R4 regressions ----------
import { linkSync, statSync as statSyncFs, fstatSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";

const jfile = (es) => es.map((e) => JSON.stringify(e)).join("\n") + "\n";
function prepared(es) {
  const sb = sandbox(); const l = loc(sb.base);
  mkdirSync(l.runDir, { recursive: true });
  if (es) writeFileSync(join(l.runDir, J.journalFileName(V.hash)), jfile(es));
  return { sb, l };
}
const inspect = (sb, l, over = {}) => RC.runConnectedRecoverCli(["--inspect", "--manifest", sb.mpath, "--reviewed-commit", SHA, "--location", l.token],
  { root: sb.root, base: sb.base, git: RGIT, ...over });

test("R1: the journal must be a regular single-linked bounded file; a symlink/hard link named like the journal is refused before any read", async (t) => {
  const outside = mkdtempSync(join(tmpdir(), "e4-outside-"));
  const target = join(outside, "elsewhere.jsonl");
  writeFileSync(target, jfile([start]));
  const { sb, l } = prepared(null);
  try { symlinkSync(target, join(l.runDir, J.journalFileName(V.hash)), "file"); } catch { t.skip("symlinks unavailable"); return; }
  let reads = 0; let asked = 0;
  const spy = { readJournal: () => { reads++; return [start]; }, prompt: async () => { asked++; return {}; } };
  const r = await inspect(sb, l, spy);
  assert.equal(r.output.error, "JOURNAL_NOT_A_REGULAR_FILE"); assert.equal(r.exitCode, 2);
  const rr = await RC.runConnectedRecoverCli(["--reconcile", "--manifest", sb.mpath, "--reviewed-commit", SHA, "--location", l.token], { root: sb.root, base: sb.base, git: RGIT, ...spy });
  assert.equal(rr.output.error, "JOURNAL_NOT_A_REGULAR_FILE");
  assert.equal(reads, 0); assert.equal(asked, 0);
  // a hard link to another file
  rmSync(join(l.runDir, J.journalFileName(V.hash)));
  linkSync(target, join(l.runDir, J.journalFileName(V.hash)));
  assert.equal((await inspect(sb, l, spy)).output.error, "JOURNAL_HAS_OTHER_LINKS");
  // a directory with the journal's name, and an oversized file
  rmSync(join(l.runDir, J.journalFileName(V.hash)));
  mkdirSync(join(l.runDir, J.journalFileName(V.hash)));
  assert.equal((await inspect(sb, l, spy)).output.error, "JOURNAL_NOT_A_REGULAR_FILE");
  rmSync(join(l.runDir, J.journalFileName(V.hash)), { recursive: true });
  writeFileSync(join(l.runDir, J.journalFileName(V.hash)), "x".repeat(RC.MAX_JOURNAL_BYTES + 1));
  assert.equal((await inspect(sb, l, spy)).output.error, "JOURNAL_TOO_LARGE");
  assert.equal(reads, 0); assert.equal(asked, 0);
});

test("R2: loaded journal values are revalidated at the disk boundary; raw objects/unknown values never reach the output", async () => {
  const PRIVATE = "PRIVATE_SENTINEL";
  const variants = [
    [start, ci, { ...co(5), code: { raw: PRIVATE } }, xi(5), xo(5, "VERIFIED_CANCELLED")],
    [start, ci, co(5), xi(5), xo(5, "VERIFIED_CANCELLED", { mismatches: [{ guestEmail: PRIVATE }] })],
    [start, ci, co(5), xi(5), xo(5, "VERIFIED_CANCELLED", { transport: { token: PRIVATE } })],
    [start, ci, co(5), xi(5), xo(5, "VERIFIED_CANCELLED"), { type: "halt", step: "KW2_CANCEL", code: { raw: PRIVATE } }],
    [start, ci, co(5), xi(5), xo(5, "VERIFIED_CANCELLED"), { type: "run-end", code: PRIVATE.toLowerCase() }],
    [start, ci, co(5), xi(5), xo(5, "VERIFIED_CANCELLED", { guestEmail: PRIVATE })],
    [start, ci, { ...co(5), evidence: { reservationId: 5, rawBody: PRIVATE } }, xi(5), xo(5, "VERIFIED_CANCELLED")],
    [start, ci, co(5), xi(5), xo(5, "VERIFIED_CANCELLED", { mismatches: ["guestEmail"] })],
    [start, ci, co(5), xi(5), xo(5, "VERIFIED_CANCELLED", { httpStatus: "200" })]
  ];
  for (const es of variants) {
    const c = RC.classifyConnectedJournal(es, H);
    assert.equal(c.ok, false, JSON.stringify(es).slice(0, 160)); assert.equal(c.code, "JOURNAL_ENTRY_NOT_SANITIZED");
    assert.ok(!JSON.stringify(c).includes(PRIVATE) && !JSON.stringify(c).includes(PRIVATE.toLowerCase()));
    const { sb, l } = prepared(es);
    const r = await inspect(sb, l);
    assert.equal(r.output.error, "JOURNAL_ENTRY_NOT_SANITIZED"); assert.equal(r.exitCode, 2);
    assert.ok(!JSON.stringify(r.output).toLowerCase().includes(PRIVATE.toLowerCase()));
  }
  // the field-name-only mismatch report still passes when it is exactly what the producer writes
  const okc = RC.classifyConnectedJournal([start, ci, co(5), xi(5), xo(5, "CANCEL_RESPONSE_MISMATCH", { mismatches: ["totalMinor", "status"], httpStatus: 200 })], H);
  assert.equal(okc.ok, true); assert.deepEqual(okc.cancelOutcome.mismatches, ["totalMinor", "status"]);
});

test("R3: contradictions or protected evidence never exit clean; reconcile collects scoped evidence but returns CONFLICT_MANUAL_REVIEW without a decision", async () => {
  const contradictions = [
    [[start, ci, co(5), xi(6), xo(6, "VERIFIED_CANCELLED")], ["RESERVATION_IDS_INCONSISTENT"]],
    [[start, ci, co(70636076), xi(6), xo(6, "VERIFIED_CANCELLED")], ["PROTECTED_ID_IN_JOURNAL"]],
    [[start, ci, co(5), xi(5), xo(6, "VERIFIED_CANCELLED")], ["RESERVATION_IDS_INCONSISTENT", "CANCEL_OUTCOME_ID_DIFFERS_FROM_INTENT"]]
  ];
  for (const [es, expected] of contradictions) {
    const c = RC.classifyConnectedJournal(es, H);
    assert.equal(c.ok, true); assert.equal(c.clean, false);
    for (const x of expected) assert.ok(c.conflicts.includes(x), `${x} in ${c.conflicts}`);
    assert.equal(c.reservationId, null);
    const { sb, l } = prepared(es);
    const r = await inspect(sb, l);
    assert.equal(r.exitCode, 3, JSON.stringify(r.output));
    const w = world();
    const rr = await RC.runConnectedRecoverCli(["--reconcile", "--manifest", sb.mpath, "--reviewed-commit", SHA, "--location", l.token],
      { root: sb.root, base: sb.base, git: RGIT, fetchImpl: w.fetch, sleep: async () => {}, prompt: async () => ({ accountId: "201434", clientSecret: "FAKE-SECRET" }) });
    assert.equal(rr.exitCode, 3); assert.equal(rr.output.reconcile.verdict, "CONFLICT_MANUAL_REVIEW"); assert.equal(rr.output.reconcile.decision, null);
    assert.equal(rr.output.reconcile.read, null);                       // no read by id when ids conflict or a protected id appears
    assert.ok(w.log.every((x) => x.startsWith("GET ") || x === "POST /accessTokens") && !w.log.some((x) => x.includes("70636076")));
  }
  // ordering that the reviewed sequence never produces is refused outright
  for (const [es, code] of [[[start, ci, xi(5), co(5)], "JOURNAL_CANCEL_BEFORE_CREATE_OUTCOME"], [[start, co(5)], "JOURNAL_CREATE_OUTCOME_WITHOUT_INTENT"],
    [[start, ci, co(5), xo(5, "VERIFIED_CANCELLED")], "JOURNAL_CANCEL_OUTCOME_WITHOUT_INTENT"]]) assert.equal(RC.classifyConnectedJournal(es, H).code, code);
});

test("R4: a journal close failure after the run is never a clean pass: durable false, not passed, exit 3, facts kept, no retry", async () => {
  const sb = sandbox(); const w = world(); const { d } = deps(sb, w);
  const l = loc(sb.base); const jpath = join(l.runDir, J.journalFileName(V.hash));
  const fs = createRequire(import.meta.url)("node:fs");
  const realClose = fs.closeSync; let injected = 0;
  fs.closeSync = (fd) => {
    let target = false;
    try { target = fstatSync(fd).ino === statSyncFs(jpath).ino; } catch { target = false; }
    realClose(fd);
    if (target) { injected++; throw Object.assign(new Error("EIO"), { code: "EIO" }); }
  };
  syncBuiltinESMExports();
  let r;
  try { r = await X.runConnectedExecuteCli(execArgs(sb), d); } finally { fs.closeSync = realClose; syncBuiltinESMExports(); }
  assert.equal(injected, 1);
  assert.equal(r.exitCode, 3, JSON.stringify(r.output));
  assert.equal(r.output.passed, false); assert.equal(r.output.ok, false);
  assert.equal(r.output.journalClose, "JOURNAL_CLOSE_FAILED"); assert.equal(r.output.journalDurable, false);
  assert.ok(r.output.journalFailures.includes("CLOSE"));
  assert.equal(r.output.status, "COMPLETED_JOURNAL_NOT_DURABLE");
  assert.deepEqual(r.output.writes, { create: 1, cancel: 1 });           // facts preserved
  assert.equal(r.output.commandReply.code, "VERIFIED_CANCELLED");
  assert.equal(writes(w).length, 2);                                      // nothing retried
  // a normal close is reported as such
  const sb2 = sandbox(); const w2 = world(); const x2 = deps(sb2, w2);
  const ok = await X.runConnectedExecuteCli(execArgs(sb2), x2.d);
  assert.equal(ok.output.journalClose, "JOURNAL_CLOSED"); assert.equal(ok.exitCode, 0);
});

test("launcher URL guard body binding: create for another listing/dates/currency or with forceOverbooking, and price for other dates, are refused", async () => {
  const sent = [];
  const g = X.guardConnectedFetch(async (u) => { sent.push(new URL(u).pathname); return new Response("{}"); },
    { calendar: { startDate: NIGHTS[0], endDate: NIGHTS[1] }, arrivalDate: STAY.arrivalDate, departureDate: STAY.departureDate });
  const B = "https://api.hostaway.com/v1";
  const body = { listingMapId: L, channelId: 2000, currency: "MXN", arrivalDate: STAY.arrivalDate, departureDate: STAY.departureDate };
  for (const bad of [{ ...body, listingMapId: 603564 }, { ...body, currency: "USD" }, { ...body, departureDate: "2027-04-08" }, { ...body, channelId: 2005 }, { ...body, forceOverbooking: true }]) {
    await assert.rejects(g.guarded(`${B}/reservations`, { method: "POST", body: JSON.stringify(bad) }));
  }
  await assert.rejects(g.guarded(`${B}/listings/${L}/calendar/priceDetails`, { method: "POST", body: JSON.stringify({ startingDate: "2027-04-06", endingDate: STAY.departureDate }) }));
  await g.guarded(`${B}/listings/${L}/calendar/priceDetails`, { method: "POST", body: JSON.stringify({ startingDate: STAY.arrivalDate, endingDate: STAY.departureDate, numberOfGuests: 2, version: 2 }) });
  await g.guarded(`${B}/reservations`, { method: "POST", body: JSON.stringify(body) });
  assert.deepEqual(sent, [`/v1/listings/${L}/calendar/priceDetails`, "/v1/reservations"]);
});

test("recovery truthfulness: a clean read by id never masks a contradicting ref lookup (other id, protected id, status/identity disagreement, duplicate ref)", async () => {
  const es = [start, ci, co(5), xi(5), xo(5, "VERIFIED_CANCELLED")];
  const resv = (over = {}) => ({ id: 5, hostawayReservationId: "5", listingMapId: L, channelId: 2000, reservationId: "98765-603566-2000-1", arrivalDate: STAY.arrivalDate,
    departureDate: STAY.departureDate, totalPrice: 3200, currency: "MXN", status: "cancelled", guestName: "Synthetic Tester",
    customFieldValues: [{ customFieldId: 105433, value: REF }], ...over });
  const cases = [
    [[resv({ id: 6, hostawayReservationId: "6" })], "LOOKUP_ID_DIFFERS_FROM_READ"],
    [[resv({ id: 70636076, hostawayReservationId: "70636076" })], "LOOKUP_RETURNED_PROTECTED_ID"],
    [[resv({ status: "new" })], "LOOKUP_STATUS_DIFFERS_FROM_READ"],
    [[resv({ totalPrice: 9999 })], "LOOKUP_IDENTITY_MISMATCH"],
    [[resv(), resv({ id: 7, hostawayReservationId: "7" })], "LOOKUP_DUPLICATE_REF"]
  ];
  for (const [lookupItems, expected] of cases) {
    const { sb, l } = prepared(es);
    const log = [];
    const fetchImpl = async (url, init = {}) => {
      const u = new URL(String(url)); const path = u.pathname.replace(/^\/v1/, ""); log.push(`${init.method ?? "GET"} ${path}`);
      const J2 = (o) => new Response(JSON.stringify(o), { status: 200 });
      if (path === "/accessTokens") return J2({ access_token: "FAKE-TOKEN" });
      if (path === "/reservations/5") return J2({ status: "success", result: resv() });
      if (path === "/reservations") return J2({ status: "success", result: u.searchParams.get("afterId") ? [] : lookupItems });
      if (path === `/listings/${L}/calendar`) return J2({ status: "success", result: NIGHTS.map((date) => ({ date, status: "available", isAvailable: 1 })) });
      return new Response("{}", { status: 404 });
    };
    const rr = await RC.runConnectedRecoverCli(["--reconcile", "--manifest", sb.mpath, "--reviewed-commit", SHA, "--location", l.token],
      { root: sb.root, base: sb.base, git: RGIT, fetchImpl, sleep: async () => {}, prompt: async () => ({ accountId: "201434", clientSecret: "FAKE-SECRET" }) });
    assert.equal(rr.output.reconcile.read.code, "READ_IDENTITY_OK", expected);                 // the useful read is preserved
    assert.ok(rr.output.reconcile.evidenceConflicts.includes(expected), `${expected} in ${rr.output.reconcile.evidenceConflicts}`);
    assert.equal(rr.output.reconcile.verdict, "EVIDENCE_CONFLICT_MANUAL_REVIEW"); assert.equal(rr.output.reconcile.decision, null);
    assert.equal(rr.exitCode, 3);
    assert.ok(log.every((x) => x.startsWith("GET ") || x === "POST /accessTokens") && !log.includes("GET /reservations/70636076"));
    leakFree(rr.output);
  }
});


// ---------- 2026-11-01 live result: create reply vs later read; calendar API/UI discrepancy (reporting only) ----------
const A = await import("../lib/hostaway-reservations.js");
const reconcileWith = async (sb, w) => RC.runConnectedRecoverCli(["--reconcile", "--manifest", sb.mpath, "--reviewed-commit", SHA, "--location", loc(sb.base).token],
  { root: sb.root, base: sb.base, git: RGIT, fetchImpl: w.fetch, sleep: async () => {}, prompt: async () => ({ accountId: "201434", clientSecret: "FAKE-SECRET" }) });

test("create reply whose ref field is MALFORMED (item keyed by id) but later read WITH the ref: strict halt (1 create, 0 cancel); recovery shows the reply's mismatching field NAMES", async () => {
  const sb = sandbox();
  const w = world({ createReply: (wd) => ({ status: 200, json: { status: "success", result: { ...wd.res, customFieldValues: [{ id: 105433, value: wd.res.customFieldValues[0].value }] } } }) });
  const { d, calls } = deps(sb, w);
  const r = await X.runConnectedExecuteCli(execArgs(sb), d);
  assert.equal(r.exitCode, 3); assert.equal(r.output.status, "HALTED");
  assert.equal(r.output.halt.step, "KW1_CREATE"); assert.equal(r.output.halt.code, "CREATE_NOT_VERIFIED:RESERVATION_MISMATCH");
  assert.deepEqual(r.output.writes, { create: 1, cancel: 0 }); assert.deepEqual(writes(w), ["POST /reservations"]);
  assert.deepEqual(calls.stages, ["before-create"]);                                   // no after-create checkpoint is reached
  assert.equal(r.output.reconcile[0].reservationId, w.res.id); assert.equal(r.output.reconcile[0].reservationStatus, "new");
  assert.deepEqual(r.output.createVerification, { path: "NONE", result: "NOT_VERIFIED", refEcho: "MALFORMED", refusal: "CUSTOM_FIELDS_NOT_DEMONSTRABLY_ABSENT", readVerify: null, lookupVerify: null });
  // the classification itself is NOT weakened: a reply without the ref is still a conflict (only the narrow KV path may follow)
  const plan = { ref: "MV-ABCDEF12", listingId: L, arrivalDate: STAY.arrivalDate, departureDate: STAY.departureDate, guests: 2, guest: GUEST, totalMinor: TOTAL, currency: "MXN" };
  const noRef = { httpStatus: 200, json: { status: "success", result: { id: 5, listingMapId: L, channelId: 2000, arrivalDate: STAY.arrivalDate, departureDate: STAY.departureDate,
    totalPrice: 3200, currency: "MXN", status: "new" } } };
  const cls = A.classifyCreateResponse(noRef, plan, A.connectedTestAdapterConfig());
  assert.equal(cls.code, "RESERVATION_MISMATCH"); assert.deepEqual(cls.mismatches, ["bookingRef"]);
  // recovery: field names only, from the journal's sanitized create evidence
  const l = loc(sb.base);
  const ri = await inspect(sb, l);
  assert.equal(ri.exitCode, 3);
  assert.equal(ri.output.classification.state, "CREATED_NO_CANCEL_ATTEMPT");
  assert.deepEqual(ri.output.classification.createOutcome, { code: "RESERVATION_MISMATCH", replyMismatchFields: ["bookingRef"], replyHttpStatus: 200 });
  assert.deepEqual(ri.output.classification.createVerification, { path: "NONE", result: "NOT_VERIFIED", refEcho: null, readVerify: null, lookupVerify: null });
  const rr = await reconcileWith(sb, w);
  assert.equal(rr.output.reconcile.read.code, "READ_IDENTITY_OK"); assert.equal(rr.output.reconcile.verdict, "RESERVATION_ACTIVE_OWNER_DECISION_REQUIRED");
  assert.ok(w.log.filter((x) => x === "POST /reservations" || x.startsWith("PUT ")).length === 1);
  leakFree(r.output); leakFree(ri.output); leakFree(rr.output);
});

test("create reply with a different total: field name totalMinor only; never the value", async () => {
  const sb = sandbox();
  const w = world({ createReply: (wd) => ({ status: 200, json: { status: "success", result: { ...wd.res, totalPrice: 3200.5 } } }) });
  const { d } = deps(sb, w);
  const r = await X.runConnectedExecuteCli(execArgs(sb), d);
  assert.equal(r.output.halt.code, "CREATE_NOT_VERIFIED:RESERVATION_MISMATCH");
  const ri = await inspect(sb, loc(sb.base));
  assert.deepEqual(ri.output.classification.createOutcome.replyMismatchFields, ["totalMinor"]);
  assert.ok(!JSON.stringify(ri.output).includes("3200.5") && !JSON.stringify(ri.output).includes("320050"));
});

test("calendar API/UI discrepancy: an active reservation while the API calendar says available/1 is CALENDAR_OPEN with categorical night shapes; contradictions stay UNKNOWN; no price/note/raw text", async () => {
  const day = (date, o) => ({ id: 1, date, price: 1600, note: "PROVIDER-TEXT", minimumStay: 1, reservations: [], ...o });
  const cases = [
    [() => NIGHTS.map((dt) => day(dt, { status: "available", isAvailable: 1, isProcessed: 1, countAvailableUnits: 1, availableUnitsToSell: 1, countPendingUnits: 0, countBlockedUnits: 0 })),
      "CALENDAR_OPEN", { status: "available", isAvailable: "TRUE", isProcessed: "TRUE", countAvailableUnits: 1, countReservedUnits: "ABSENT" }],
    [() => NIGHTS.map((dt) => day(dt, { status: "reserved", isAvailable: 1, isProcessed: 0 })), "CALENDAR_UNKNOWN", { status: "reserved", isAvailable: "TRUE", isProcessed: "FALSE" }],
    [() => NIGHTS.map((dt) => day(dt, { status: "reserved", isAvailable: 0, isProcessed: 1 })), "CALENDAR_BLOCKED", { status: "reserved", isAvailable: "FALSE" }],
    [() => NIGHTS.map((dt) => day(dt, { status: "weird-PROVIDER-TEXT", isAvailable: "1", countAvailableUnits: 150, countBlockedUnits: -1, countPendingUnits: "2" })), "CALENDAR_UNKNOWN",
      { status: "OTHER", isAvailable: "OTHER", isProcessed: "ABSENT", countAvailableUnits: "OTHER", countBlockedUnits: "OTHER", countPendingUnits: "OTHER" }]
  ];
  for (const [days, code, expect] of cases) {
    const sb = sandbox();
    const w = world({ createReply: (wd) => ({ status: 200, json: { status: "success", result: { ...wd.res, customFieldValues: "PROVIDER-TEXT" } } }) });
    const { d } = deps(sb, w);
    await X.runConnectedExecuteCli(execArgs(sb), d);                      // creates, halts (reply's ref field malformed)
    const w2 = { ...w, fetch: world({ calendarDays: days }).fetch };
    // reuse the same reservation in a second fake world for the recovery reads
    const wr = world({ calendarDays: days }); wr.res = w.res;
    const rr = await reconcileWith(sb, wr);
    assert.equal(rr.output.reconcile.calendar.code, code, code);
    assert.equal(rr.output.reconcile.calendar.nights.length, 2);
    for (const n of rr.output.reconcile.calendar.nights) for (const [k, v] of Object.entries(expect)) assert.equal(n[k], v, `${code} ${k}`);
    const s = JSON.stringify(rr.output.reconcile.calendar);
    assert.ok(!s.includes("1600") && !s.includes("PROVIDER-TEXT") && !s.includes("price") && !s.includes("note"));
    void w2;
  }
});

// ---------- 2026-11-02 read-only create verification through the real launcher, file journal, URL guard and recovery ----------
const noRefReply = (wd) => { const { customFieldValues, ...rest } = wd.res; return { status: 200, json: { status: "success", result: rest } }; };

test("launcher end-to-end: an unechoed ref is READ_VERIFIED (fresh read + same-id unique lookup), then the unchanged checks and one cancel; recovery says READ_VERIFIED; replay refused", async () => {
  const sb = sandbox();
  const w = world({ createReply: noRefReply });
  const { d, calls } = deps(sb, w);
  const r = await X.runConnectedExecuteCli(execArgs(sb), d);
  assert.equal(r.exitCode, 0, JSON.stringify(r.output.halt)); assert.equal(r.output.passed, true);
  assert.deepEqual(r.output.writes, { create: 1, cancel: 1 }); assert.equal(writes(w).length, 2);
  assert.deepEqual(r.output.createVerification, { path: "READ_FALLBACK", result: "READ_VERIFIED", refEcho: "ABSENT_UNDEFINED", refusal: null,
    readVerify: "VERIFY_READ_IDENTITY_OK", lookupVerify: "VERIFY_LOOKUP_SAME_ID_IDENTITY_OK" });
  assert.deepEqual(calls.stages, ["before-create", "after-create", "after-cancel"]);
  assert.equal(r.output.guard.refused, 0); assert.equal(r.output.guard.read, 4); assert.equal(r.output.guard.lookup, 5);   // reads: KV1+K4+K7+K8; lookup pages: K1 (1 empty) + KV2 (2) + K5 (2)
  const ri = await inspect(sb, loc(sb.base));
  assert.equal(ri.exitCode, 0, JSON.stringify(ri.output.classification));
  assert.equal(ri.output.classification.state, "CANCEL_VERIFIED"); assert.equal(ri.output.classification.clean, true);
  assert.deepEqual(ri.output.classification.createVerification, { path: "READ_FALLBACK", result: "READ_VERIFIED", refEcho: "CREATE_REF_NOT_ECHOED:ABSENT_UNDEFINED",
    readVerify: "VERIFY_READ_IDENTITY_OK", lookupVerify: "VERIFY_LOOKUP_SAME_ID_IDENTITY_OK" });
  assert.deepEqual(ri.output.classification.createOutcome, { code: "RESERVATION_MISMATCH", replyMismatchFields: ["bookingRef"], replyHttpStatus: 200 });   // original evidence kept
  const before = w.log.length; const x2 = deps(sb, w);
  const r2 = await X.runConnectedExecuteCli(execArgs(sb), x2.d);
  assert.equal(r2.output.error, "REPLAY_REFUSED_RUN_LOCATION_EXISTS"); assert.equal(x2.calls.prompt, 0); assert.equal(w.log.length, before);
  leakFree(r.output); leakFree(ri.output);
});

test("launcher end-to-end: a KV2 lookup returning another id halts read-only (no cancel); recovery shows the conflict and never a clean result; reconcile writes nothing", async () => {
  const sb = sandbox();
  const w = world({ createReply: noRefReply });
  const base = w.fetch;
  let creates = 0;
  w.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if ((init.method ?? "GET") === "POST" && u.pathname === "/v1/reservations") creates++;
    if (creates && (init.method ?? "GET") === "GET" && u.pathname === "/v1/reservations" && !u.searchParams.get("afterId") && w.res) {
      w.log.push("GET /reservations");
      const other = { ...w.res, id: 91000078, hostawayReservationId: "91000078" };
      return new Response(JSON.stringify({ status: "success", result: [other] }), { status: 200 });
    }
    return base(url, init);
  };
  const { d } = deps(sb, w);
  const r = await X.runConnectedExecuteCli(execArgs(sb), d);
  assert.equal(r.exitCode, 3); assert.equal(r.output.halt.step, "KV2_LOOKUP_VERIFY"); assert.equal(r.output.halt.code, "VERIFY_LOOKUP_ID_DIFFERS");
  assert.deepEqual(r.output.writes, { create: 1, cancel: 0 }); assert.equal(r.output.passed, false);
  assert.equal(r.output.createVerification.result, "NOT_VERIFIED");
  const ri = await inspect(sb, loc(sb.base));
  assert.equal(ri.exitCode, 3); assert.equal(ri.output.classification.clean, false);
  assert.ok(ri.output.classification.conflicts.includes("RESERVATION_IDS_INCONSISTENT"));
  assert.equal(ri.output.classification.createVerification.result, "NOT_VERIFIED");
  leakFree(r.output); leakFree(ri.output);
});
