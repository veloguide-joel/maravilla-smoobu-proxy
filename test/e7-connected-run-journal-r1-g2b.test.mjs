// E7 M2-G2b — the R1 journal identity / hash domain, the module-minted R1 brand, the R1 memory + FILE journal entrypoints (OFFLINE; contract
// claude/e7-run-real-r1-g2.md §8). No DB, provider, network, credential. Plans / clocks / env snapshots / ids are SYNTHETIC (labelled).
//   * The plan / package fixture is a LABELLED COPY of test/e7-connected-run-binding-r1.test.mjs:21–60 (the accepted G1 binder fixture).
//   * File-journal round-trips use owner-only temp dirs and the accepted node fs adapter (real fsync), removed in after().
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync, chmodSync, renameSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import * as R from "../scripts/e7-connected/run-binding-r1.mjs";
import { buildRunPackageV1, sourceDigestV1, RUN_PLAN_CLOSURE, HISTORICAL_EXCLUSIONS, ALLOWED_OPS } from "../scripts/e7-connected/run-plan-v1.mjs";
import { canonicalJson } from "../scripts/e7-connected/run-manifest.mjs";
import * as J from "../scripts/e7-connected/run-journal-memory-v2.mjs";
import * as FJ from "../scripts/e7-connected/run-journal-file-v2.mjs";

let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline G2b journal suite)"); };
const DIRS = [];
after(() => { globalThis.fetch = realFetch; for (const d of DIRS) rmSync(d, { recursive: true, force: true }); assert.equal(netAttempts, 0); });

// ===== LABELLED COPY of test/e7-connected-run-binding-r1.test.mjs:21–60 (G1 fixture) =====
const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), ".."));
const enc = new TextEncoder();
const u8 = (p) => new Uint8Array(readFileSync(join(ROOT, p)));
const clone = (v) => JSON.parse(JSON.stringify(v));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const NOW = Date.parse("2027-02-01T03:00:00.000Z"); const MIN = 60_000;
const at = (ms) => new Date(NOW - ms).toISOString();
const FOUND = RUN_PLAN_CLOSURE.map((path) => ({ path, bytes: u8(path) }));
const EXEC = R.R1_EXECUTOR_CLOSURE.map((path) => ({ path, bytes: u8(path) }));
const FOUND_DIGEST = sourceDigestV1(FOUND);
const indepDigest = (entries) => sha(Buffer.concat([Buffer.from("e7-run-executor-source-r1\n"), ...entries.flatMap((e) => [Buffer.from(`${e.path}\0${e.bytes.length}\0`), Buffer.from(e.bytes), Buffer.from([0])])]));
const ENV = () => ({ schema: "e7-probe-env-snapshot-v1", nodeVersion: "22.22.0", platform: "linux", execArgvCount: 0, uidAvailable: true,
  present: Object.fromEntries(["NODE_OPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "SSLKEYLOGFILE",
    "OPENSSL_CONF", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"].map((k) => [k, false])) });
const plan = (over = (p) => p) => {
  const p = { version: "e7-run-plan-v1", kind: "reservation-test-abort-v1", runId: "synthetic-r1-0001", createdAt: at(MIN),
    baseline: { repoCommit: "58a88f691ac88dcb260cdf407a73785cd96949cd", sourceDigest: null },
    environment: { stripe: { mode: "test", accountId: "acct_SYNTHETIC0001" }, hostaway: { accountRef: "synthetic-hostaway", clientSnapshotId: "synthetic-client-1" },
      db: { instanceEnvironment: "test", appRole: "mv_booking_app", reportRole: "mv_booking_report" } },
    listing: { id: 606998, currency: "USD", refFieldId: 777009, connection: "disconnected", timeZone: "America/Mazatlan" },
    phases: { capture: false, recording: false, testAbortAfterReservation: true }, allowedOps: [...ALLOWED_OPS],
    checkpoints: ["CALENDAR_BASELINE", "CALENDAR_BLOCKED", "CALENDAR_REOPENED"],
    deadlines: { quoteMaxAgeMinutes: 30, authorizationMaxAgeHours: 24 }, stayRules: { minLeadDays: 7, maxNights: 7 }, exclusions: clone(HISTORICAL_EXCLUSIONS),
    binding: { intentId: "00000000-0000-4000-8000-0000000000f1", expectedRef: "MV-SYN0001", paymentIntentId: "pi_SYNTHETIC0000f1",
      stay: { arrival: "2027-03-10", departure: "2027-03-12", guests: 2 }, amountMinor: 23000, rateBps: 1000,
      quote: { totalMinor: 23000, currency: "USD", quotedAt: at(10 * MIN) }, authorizedAt: at(5 * MIN) } };
  over(p);
  return p;
};
function fixture(over, { clock = NOW } = {}) {
  const p = plan(over); if (p.baseline.sourceDigest === null) p.baseline.sourceDigest = FOUND_DIGEST;
  const planBytes = enc.encode(`${canonicalJson(p)}\n`);
  const built = buildRunPackageV1({ planBytes, sourceEntries: FOUND, envSnapshot: ENV(), planClock: clock });
  assert.ok(built.ok, `fixture build ${built.code}`);
  return { plan: p, built, input: { packageBytes: enc.encode(`${canonicalJson(built.package)}\n`), planBytes, foundationSources: FOUND, executorSources: EXEC, envSnapshot: ENV(),
    expected: { packageHash: built.packageHash, executorDigest: indepDigest(EXEC) }, execClock: clock } };
}
// ===== end of the labelled copy =====

const r1In = (fx) => { const { execClock, ...rest } = fx.input; void execClock; return rest; };
const mint = (fx, clock = NOW) => J.bindRunPackageR1Journal(r1In(fx), clock);
const D1 = "1".repeat(64); const D2 = "2".repeat(64);
/** a SYNTHETIC v2 manifest whose identity fields (runId / intent / connection) equal the R1 fixture's — for relabel / cross-domain controls */
const v2Manifest = (fx, over = {}) => ({ version: "e7-run-manifest-v2", runId: fx.plan.runId, intentId: fx.plan.binding.intentId, baselineCommit: fx.plan.baseline.repoCommit,
  synthetic: true, providerMode: { hostaway: "fake", stripe: "mock" }, listing: { ...fx.plan.listing }, expectedRef: fx.plan.binding.expectedRef,
  stay: { ...fx.plan.binding.stay }, amountMinor: fx.plan.binding.amountMinor, pricing: { rateBps: fx.plan.binding.rateBps }, stripeAccountId: "acct_SYNTHETIC0001",
  hostawayAccountLabel: { accountRef: "synthetic-hostaway", clientSnapshotId: "synthetic-client-1" }, phases: { capture: false, recording: false, testAbortAfterReservation: true },
  paymentMethod: null, cleanup: { reservedNotConfirmed: "synthetic/a", captured: "synthetic/b", confirmed: "synthetic/c" }, automationsReviewed: "synthetic/automations",
  checkpoints: [...fx.plan.checkpoints], ...over });
const rec = (b, seq, prevHash, event, body = {}, at0 = NOW) => ({ v: 2, seq, prevHash, ...b.identity, at: at0, event, ...body });
const started = (b, digest = b.r1.executorDigest) => rec(b, 1, J.GENESIS_HASH, "RUN_STARTED", { preflightDigest: D1, executorDigest: digest });
const r1Hash = (r) => sha(Buffer.from(`e7-run-journal-r1\n${canonicalJson(r)}`, "utf8"));
const v2Hash = (r) => sha(Buffer.from(`e7-run-journal-v2\n${canonicalJson(r)}`, "utf8"));

// =================================================================================================================================
test("J1 R1 brand: minted ONLY by re-derivation (accepted binder, fresh clock); copies / hand-built / version strings never authority; binder refusals surfaced", () => {
  const fx = fixture();
  const m = mint(fx);
  assert.equal(m.ok, true, JSON.stringify(m));
  const b = m.binding;
  assert.equal(J.bindingKindV2(b), "r1"); assert.equal(J.isBoundBindingV2(b), true);
  assert.deepEqual({ ...b.identity }, { manifestVersion: "e7-run-package-r1", connection: "disconnected", runId: "synthetic-r1-0001", intentId: fx.plan.binding.intentId,
    baselineCommit: fx.plan.baseline.repoCommit, manifestHash: fx.built.packageHash });
  assert.equal(b.r1.packageHash, fx.built.packageHash); assert.equal(b.r1.executorDigest, indepDigest(EXEC)); assert.equal(b.r1.foundationDigest, FOUND_DIGEST);
  assert.equal(b.r1.paymentIntentId, "pi_SYNTHETIC0000f1"); assert.equal(b.r1.execClock, NOW);
  assert.deepEqual(Object.keys(b.manifest).sort(), ["amountMinor", "expectedRef", "intentId", "kind", "listing", "pricing", "runId", "stay", "stripeAccountId"]);
  assert.equal(b.manifest.kind, "r1-scope"); assert.ok(!("synthetic" in b.manifest) && !("providerMode" in b.manifest), "no synthetic / provider-mode fields");
  for (const o of [b, b.identity, b.manifest, b.manifest.listing, b.r1, b.r1.exclusions]) assert.ok(Object.isFrozen(o));
  // two mints of the same input are two distinct brands with equal values
  const m2 = mint(fx); assert.notEqual(m2.binding, b); assert.deepEqual(clone(m2.binding), clone(b));
  // forgery: spread / JSON copy / hand-built / prototype-chained / v2-labelled object → never BOUND, never r1
  const forged = [{ ...b }, clone(b), Object.create(b), { identity: b.identity, checkpoints: b.checkpoints, phases: b.phases, facts: b.facts, manifest: b.manifest, r1: b.r1 }];
  for (const f of forged) {
    assert.equal(J.isBoundBindingV2(f), false); assert.equal(J.bindingKindV2(f), null);
    assert.equal(J.validateRecordBound(started(b), f).code, "BINDING_UNVERIFIED");
    assert.equal(J.createMemoryJournalBound({ binding: f }).code, "BINDING_UNVERIFIED");
    assert.equal(J.evaluateStartBound({ records: [], tail: "complete" }, f).code, "BINDING_UNVERIFIED");
  }
  for (const s of ["r1", "e7-run-package-r1", true, null, 1]) assert.equal(J.bindingKindV2(s), null);
  // binder refusals: package tamper / pin mismatch / stale clock / clock before package / executor tamper — each surfaced, nothing minted
  const t = new Uint8Array(fx.input.packageBytes); t[t.length - 3] ^= 1;
  const codes = [
    J.bindRunPackageR1Journal({ ...r1In(fx), packageBytes: t }, NOW),
    J.bindRunPackageR1Journal({ ...r1In(fx), expected: { ...fx.input.expected, packageHash: "0".repeat(64) } }, NOW),
    J.bindRunPackageR1Journal({ ...r1In(fx), expected: { ...fx.input.expected, executorDigest: "0".repeat(64) } }, NOW),
    J.bindRunPackageR1Journal(r1In(fx), NOW + 20 * MIN + 1),
    J.bindRunPackageR1Journal(r1In(fx), NOW - 1),
    J.bindRunPackageR1Journal({ ...r1In(fx), executorSources: EXEC.map((e, i) => (i === 0 ? { path: e.path, bytes: (() => { const x = new Uint8Array(e.bytes); x[0] ^= 1; return x; })() } : e)) }, NOW)
  ].map((r) => [r.ok, r.code, r.binderCode]);
  assert.deepEqual(codes.map((c) => c.slice(0, 2)), Array(6).fill([false, "R1_BINDING_INVALID"]));
  assert.ok(["R1_PACKAGE_BYTES_INVALID", "R1_PACKAGE_MISMATCH", "R1_PACKAGE_INVALID"].includes(codes[0][2]), codes[0][2]);
  assert.deepEqual(codes.slice(1).map((c) => c[2]), ["R1_PACKAGE_HASH_MISMATCH", "R1_EXECUTOR_DIGEST_MISMATCH", "R1_STALE_AT_EXEC", "R1_CLOCK_BEFORE_PACKAGE", "R1_SNAPSHOT_OVERLAP_MISMATCH"]);
  // hostile input (getter / proxy / extra key / missing key / execClock smuggled in) → refused with ZERO getter calls
  let getterCalls = 0;
  const withGetter = { ...r1In(fx) }; Object.defineProperty(withGetter, "planBytes", { enumerable: true, get: () => { getterCalls += 1; return fx.input.planBytes; } });
  for (const bad of [withGetter, new Proxy(r1In(fx), {}), { ...r1In(fx), extra: 1 }, { ...r1In(fx), execClock: NOW }, (() => { const x = r1In(fx); delete x.envSnapshot; return x; })(), null, "x"])
    assert.deepEqual([J.bindRunPackageR1Journal(bad, NOW).code, J.bindRunPackageR1Journal(bad, NOW).binderCode], ["R1_BINDING_INVALID", "R1_INPUT_INVALID"]);
  assert.equal(getterCalls, 0);
  // the v2 binder can never mint an r1 kind; an R1 package is never a v2 manifest
  const v2 = J.bindManifestV2(v2Manifest(fx));
  assert.equal(v2.ok, true, JSON.stringify(v2)); assert.equal(J.bindingKindV2(v2.binding), "v2");
  assert.equal(J.bindManifestV2(b).ok, false); assert.equal(J.bindManifestV2(b.manifest).ok, false);
});

test("J2 R1 record shape / identity / hash domain: exact R1-only RUN_STARTED; relabelled / mixed / cross-mode refused both directions; v2 hash unchanged", () => {
  const fx = fixture(); const b = mint(fx).binding;
  const v2b = J.bindManifestV2(v2Manifest(fx)).binding;
  const ok = J.validateRecordBound(started(b), b);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  // RUN_STARTED must carry EXACTLY { preflightDigest, executorDigest } (hex64), the executor digest = THIS binding's
  assert.equal(J.validateRecordBound(rec(b, 1, J.GENESIS_HASH, "RUN_STARTED"), b).code, "RECORD_SHAPE");
  assert.equal(J.validateRecordBound({ ...started(b), extra: 1 }, b).code, "RECORD_SHAPE");
  assert.equal(J.validateRecordBound({ ...started(b), preflightDigest: "x" }, b).code, "RECORD_FIELD_INVALID");
  assert.equal(J.validateRecordBound({ ...started(b), executorDigest: D2 }, b).code, "IDENTITY_MISMATCH");
  const { executorDigest, ...noExec } = started(b); void executorDigest;
  assert.equal(J.validateRecordBound(noExec, b).code, "RECORD_SHAPE");
  // the same R1 record under the v2 binding, and a v2 record under the R1 binding → refused (no relabel either way)
  assert.equal(J.validateRecordBound(started(b), v2b).ok, false);
  const v2rec = rec(v2b, 1, J.GENESIS_HASH, "RUN_STARTED");
  assert.equal(J.validateRecordBound(v2rec, v2b).ok, true);
  assert.equal(J.validateRecordBound(v2rec, b).ok, false);
  assert.equal(J.validateRecordBound({ ...v2rec, manifestVersion: "e7-run-package-r1" }, b).ok, false, "relabelled v2 record (wrong hash / shape) refused");
  assert.equal(J.validateRecordBound({ ...started(b), manifestVersion: "e7-run-manifest-v2" }, b).code, "RECORD_FIELD_INVALID");
  // cross-mode: an airbnb R1 binding refuses a disconnected record, and vice versa
  const fxA = fixture((p) => { p.listing.connection = "airbnb"; p.checkpoints = ["CALENDAR_BASELINE", "AIRBNB_BLOCKED", "AIRBNB_REOPENED"]; });
  const bA = mint(fxA).binding;
  assert.equal(J.validateRecordBound(started(b), bA).ok, false); assert.equal(J.validateRecordBound(started(bA), b).ok, false);
  // hash domain: R1 records under "e7-run-journal-r1\n"; v2 records EXACTLY as before ("e7-run-journal-v2\n"), computed here independently
  assert.equal(J.recordHashV2(started(b)), r1Hash(started(b)));
  assert.notEqual(J.recordHashV2(started(b)), v2Hash(started(b)));
  assert.equal(J.recordHashV2(v2rec), v2Hash(v2rec));
  assert.equal(J.JOURNAL_R1_HASH_PREFIX, "e7-run-journal-r1\n"); assert.equal(J.JOURNAL_V2_HASH_PREFIX, "e7-run-journal-v2\n");
  // chains: a valid R1 chain validates; a mixed chain (R1 then v2-labelled) and a v2 chain under R1 are malformed
  const s1 = started(b); const a2 = rec(b, 2, r1Hash(s1), "ATTESTED", { attestation: { checkpoint: "CALENDAR_BASELINE", evidenceRef: "synthetic/a" } });
  const vj = J.validateJournalBound([s1, a2], b, { trustedHead: { seq: 2, hash: r1Hash(a2) } });
  assert.deepEqual([vj.ok, vj.status, vj.anchored], [true, "IN_PROGRESS", true], JSON.stringify(vj));
  const mixed = [s1, { ...rec(v2b, 2, r1Hash(s1), "ATTESTED", { attestation: { checkpoint: "CALENDAR_BASELINE", evidenceRef: "synthetic/a" } }) }];
  assert.equal(J.validateJournalBound(mixed, b).ok, false);
  assert.equal(J.validateJournalBound([v2rec], b).ok, false);
  assert.equal(J.validateJournalBound([s1], v2b).ok, false);
  // a v2-domain hash chained into an R1 journal → chain refusal (the prevHash domain is the R1 one)
  assert.equal(J.validateJournalBound([s1, rec(b, 2, v2Hash(s1), "ATTESTED", { attestation: { checkpoint: "CALENDAR_BASELINE", evidenceRef: "synthetic/a" } })], b).ok, false);
});

test("J3 start rule: ONLY an empty R1 journal starts; any prior R1 / v2 / mixed history refuses (no resume, no adoption)", () => {
  const fx = fixture(); const b = mint(fx).binding; const v2b = J.bindManifestV2(v2Manifest(fx)).binding;
  assert.equal(J.evaluateStartBound({ records: [], tail: "complete" }, b).ok, true);
  const s1 = started(b);
  for (const records of [[s1], [rec(v2b, 1, J.GENESIS_HASH, "RUN_STARTED")]]) assert.equal(J.evaluateStartBound({ records, tail: "complete" }, b).ok, false);
  assert.equal(J.evaluateStartBound({ records: [], tail: "torn" }, b).ok, false);
});

test("J4 memory journal for a BOUND R1 binding: exact ACK = R1-domain hash; relabelled / v2 records rejected; v2 memory journal unchanged", async () => {
  const fx = fixture(); const b = mint(fx).binding;
  const jm = J.createMemoryJournalBound({ binding: b });
  assert.equal(jm.ok, true); assert.deepEqual({ ...jm.identity }, { ...b.identity });
  const s1 = started(b);
  const ack = await jm.journal.append(s1);
  assert.deepEqual({ ...ack }, { seq: 1, hash: r1Hash(s1) });
  await assert.rejects(jm.journal.append(rec(b, 2, r1Hash(s1), "RUN_STARTED", { preflightDigest: D1, executorDigest: b.r1.executorDigest })));
  const v2b = J.bindManifestV2(v2Manifest(fx)).binding;
  await assert.rejects(jm.journal.append(rec(v2b, 2, r1Hash(s1), "ATTESTED", { attestation: { checkpoint: "CALENDAR_BASELINE", evidenceRef: "synthetic/a" } })));
  const a2 = rec(b, 2, r1Hash(s1), "ATTESTED", { attestation: { checkpoint: "CALENDAR_BASELINE", evidenceRef: "synthetic/a" } });
  assert.deepEqual({ ...(await jm.journal.append(a2)) }, { seq: 2, hash: r1Hash(a2) });
  const rd = await jm.journal.read();
  assert.equal(rd.records.length, 2); assert.equal(rd.tail, "complete");
  // a v2 journal created through the old entrypoint refuses an R1 record, and its ACKs stay v2-domain
  const j2 = J.createMemoryJournalV2({ manifest: v2Manifest(fx) });
  await assert.rejects(j2.journal.append(s1));
  const v1 = rec(v2b, 1, J.GENESIS_HASH, "RUN_STARTED");
  assert.deepEqual({ ...(await j2.journal.append(v1)) }, { seq: 1, hash: v2Hash(v1) });
  // options hygiene
  for (const bad of [{}, { binding: b, extra: 1 }, null, { binding: b, faults: { append: { 1: "nope" } } }]) assert.equal(J.createMemoryJournalBound(bad).ok, false);
});

// ---------------------------------------------------------------------------------------------------------------------------------
const ownerDir = (p) => { const d = mkdtempSync(join(tmpdir(), p)); chmodSync(d, 0o700); DIRS.push(d); return d; };
const lines = (p) => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("J5 R1 FILE journal: creation-only dual-file round-trip (R1 names + head-line domain), diagnostic recovery with NO permission; v2 / copied bindings, relabel, mixed refused", async () => {
  const fx = fixture(); const b = mint(fx).binding; const v2m = v2Manifest(fx);
  const jd = ownerDir("g2b-j-"); const hd = ownerDir("g2b-h-");
  // entrypoint refusals before ANY fs effect
  for (const bad of [J.bindManifestV2(v2m).binding, { ...b }, clone(b), null]) assert.equal((await FJ.openFileJournalR1({ journalDir: jd, headDir: hd, binding: bad })).code, "BINDING_UNVERIFIED");
  assert.equal((await FJ.openFileJournalR1({ journalDir: jd, headDir: hd, binding: b, manifest: v2m })).code, "JOURNAL_OPTIONS_INVALID");
  assert.deepEqual(readdirSync(jd), []); assert.deepEqual(readdirSync(hd), []);
  const o = await FJ.openFileJournalR1({ journalDir: jd, headDir: hd, binding: b });
  assert.equal(o.ok, true, JSON.stringify(o)); assert.deepEqual({ ...o.identity }, { ...b.identity });
  const s1 = started(b); const a2 = rec(b, 2, r1Hash(s1), "ATTESTED", { attestation: { checkpoint: "CALENDAR_BASELINE", evidenceRef: "synthetic/a" } });
  assert.deepEqual({ ...(await o.journal.append(s1)) }, { seq: 1, hash: r1Hash(s1) });
  await assert.rejects(o.journal.append(rec(J.bindManifestV2(v2m).binding, 2, r1Hash(s1), "ATTESTED", { attestation: { checkpoint: "CALENDAR_BASELINE", evidenceRef: "synthetic/a" } })));
  // the v2-record attempt was refused BEFORE any write: the handle stays usable
  assert.deepEqual({ ...(await o.journal.append(a2)) }, { seq: 2, hash: r1Hash(a2) });
  const rd = await o.journal.read(); assert.equal(rd.records.length, 2);
  const cl = await o.close();
  assert.deepEqual({ ...cl }, { fileClose: "closed", headLock: "released", journalLock: "released" });
  const jp = join(jd, FJ.journalFileNameR1(b.identity.runId)); const hp = join(hd, FJ.headFileNameR1(b.identity.runId));
  assert.deepEqual(readdirSync(jd), [FJ.journalFileNameR1(b.identity.runId)]); assert.deepEqual(readdirSync(hd), [FJ.headFileNameR1(b.identity.runId)]);
  assert.match(FJ.journalFileNameR1("x"), /^e7-journal-r1-x\.jsonl$/); assert.match(FJ.headFileNameR1("x"), /^e7-head-r1-x\.jsonl$/);
  assert.deepEqual(lines(hp), [{ v: "r1", runId: b.identity.runId, manifestHash: b.identity.manifestHash, seq: 1, hash: r1Hash(s1) },
    { v: "r1", runId: b.identity.runId, manifestHash: b.identity.manifestHash, seq: 2, hash: r1Hash(a2) }]);
  assert.deepEqual(lines(jp), [s1, a2]);
  // creation only: the same binding never reopens / resumes existing files
  assert.equal((await FJ.openFileJournalR1({ journalDir: jd, headDir: hd, binding: b })).code, "JOURNAL_EXISTS");
  // recovery: diagnostic, AT_ESCROW_HEAD, permission all false, R1 report version; a supplied head matches the tip
  const rc = await FJ.readJournalForRecoveryR1({ journalDir: jd, headDir: hd, binding: b, trustedHead: { seq: 2, hash: r1Hash(a2) } });
  assert.deepEqual([rc.ok, rc.version, rc.relation, rc.records, rc.headRecords, rc.suppliedHead, rc.chain.anchoredPrefix.seq, rc.chain.factsAre],
    [true, "e7-run-journal-file-r1", "AT_ESCROW_HEAD", 2, 2, "MATCH_TIP", 2, "EVIDENCE_NOT_PERMISSION"], JSON.stringify(rc));
  assert.deepEqual({ ...rc.permission }, { newRun: false, resume: false, adopt: false, cleanup: false, send: false });
  assert.ok(rc.unresolved.includes("LAST_RECORD_ACK_DELIVERY_UNKNOWN"));
  for (const bad of [J.bindManifestV2(v2m).binding, { ...b }]) {
    const x = await FJ.readJournalForRecoveryR1({ journalDir: jd, headDir: hd, binding: bad });
    assert.deepEqual([x.ok, x.code, x.permission.resume], [false, "BINDING_UNVERIFIED", false]);
  }
  // cross-domain: the v2 recovery entrypoint sees no v2 files (distinct names) → BOTH_MISSING, never the R1 history
  const v2rc = await FJ.readJournalForRecoveryV2({ journalDir: jd, headDir: hd, manifest: v2m });
  assert.deepEqual([v2rc.ok, v2rc.version, v2rc.relation], [true, "e7-run-journal-file-v2", "BOTH_MISSING"]);
  // RELABEL: the R1 files renamed to the v2 names → the v2 reader refuses them (head domain / identity), never adopts them
  renameSync(jp, join(jd, FJ.journalFileNameV2(b.identity.runId))); renameSync(hp, join(hd, FJ.headFileNameV2(b.identity.runId)));
  const rl = await FJ.readJournalForRecoveryV2({ journalDir: jd, headDir: hd, manifest: v2m });
  assert.equal(rl.relation, "HEAD_IDENTITY_MISMATCH", JSON.stringify(rl)); assert.equal(rl.permission.resume, false);
  // and the R1 reader now sees nothing under its own names
  assert.equal((await FJ.readJournalForRecoveryR1({ journalDir: jd, headDir: hd, binding: b })).relation, "BOTH_MISSING");
  // MIXED: a v2 file journal (old entrypoint) renamed to the R1 names → R1 head-line domain refuses
  const jd2 = ownerDir("g2b-j2-"); const hd2 = ownerDir("g2b-h2-");
  const o2 = await FJ.openFileJournalV2({ journalDir: jd2, headDir: hd2, manifest: v2m });
  assert.equal(o2.ok, true);
  const v2b = J.bindManifestV2(v2m).binding; const v1 = rec(v2b, 1, J.GENESIS_HASH, "RUN_STARTED");
  assert.deepEqual({ ...(await o2.journal.append(v1)) }, { seq: 1, hash: v2Hash(v1) });
  await o2.close();
  assert.deepEqual(lines(join(hd2, FJ.headFileNameV2(v2b.identity.runId))), [{ v: 2, runId: v2b.identity.runId, manifestHash: v2b.identity.manifestHash, seq: 1, hash: v2Hash(v1) }],
    "v2 head line byte-shape unchanged");
  renameSync(join(jd2, FJ.journalFileNameV2(v2b.identity.runId)), join(jd2, FJ.journalFileNameR1(b.identity.runId)));
  renameSync(join(hd2, FJ.headFileNameV2(v2b.identity.runId)), join(hd2, FJ.headFileNameR1(b.identity.runId)));
  const mx = await FJ.readJournalForRecoveryR1({ journalDir: jd2, headDir: hd2, binding: b });
  assert.equal(mx.relation, "HEAD_IDENTITY_MISMATCH"); assert.equal(mx.permission.send, false);
  // journal-only relabel (head file rebuilt in the R1 domain over the v2 record) → the R1 chain validation refuses the v2 record
  const jd3 = ownerDir("g2b-j3-"); const hd3 = ownerDir("g2b-h3-");
  const o3 = await FJ.openFileJournalR1({ journalDir: jd3, headDir: hd3, binding: b }); await o3.journal.append(s1); await o3.close();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(jd3, FJ.journalFileNameR1(b.identity.runId)), `${canonicalJson(v1)}\n`);
  const jx = await FJ.readJournalForRecoveryR1({ journalDir: jd3, headDir: hd3, binding: b });
  assert.ok(["JOURNAL_INVALID", "HASH_MISMATCH"].includes(jx.relation), jx.relation); assert.equal(jx.permission.newRun, false);
  assert.ok(existsSync(join(hd3, FJ.headFileNameR1(b.identity.runId))), "recovery never removes / repairs");
});
