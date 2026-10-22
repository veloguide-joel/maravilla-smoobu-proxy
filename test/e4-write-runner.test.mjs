// E4 bounded write runner (scripts/e4-write-runner) — offline tests. No network, no credentials, no environment:
// every provider response comes from the in-memory FAKE below, which is synthetic and not provider evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  validateManifest, planRun, executeRun, reconcileFromJournal, checkExecutionPrerequisites, createGate, assertAllowedRequest,
  generateRef, generateRunRefs, sanitizeJournalEntry, expectedTotalMinor, STEP_BUDGETS, WRITE_BUDGET, BLOCKED_BY_EMPTY_REFUSAL_CATALOGUE, PLACEHOLDER, EXECUTION_WIRED, RunnerError
} from "../scripts/e4-write-runner/runner.mjs";
import { createFileJournal, readJournalFile, journalFileName, JournalError } from "../scripts/e4-write-runner/journal.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const NOW = () => new Date("2026-10-22T18:00:00.000Z");
const GUEST = Object.freeze({ firstName: "Synthetic", lastName: "Tester", email: "e4-synthetic@example.invalid" });
const MANIFEST = Object.freeze({
  manifestVersion: "e4-write-manifest-v1", listingId: 606998, refFieldId: 105433, currency: "USD", nightlyMinor: 10000,
  cleaningFeeMinor: 5000, guests: 2,
  window: { start: "2027-03-01", end: "2027-03-15" },
  r1Block: { arrivalDate: "2027-03-10", departureDate: "2027-03-12" },
  r2Stay: { arrivalDate: "2027-03-03", departureDate: "2027-03-05" },
  x1bOverlap: { arrivalDate: "2027-03-04", departureDate: "2027-03-06" },
  guest: GUEST
});
const manifest = (over = {}) => ({ ...JSON.parse(JSON.stringify(MANIFEST)), ...over });
const tmp = () => mkdtempSync(join(tmpdir(), "e4-runner-"));
const SILENT = async () => ({ signals: [] });

// ---------- in-memory fake Hostaway (synthetic) ----------
function fakeHostaway({ intercept, repeatCancel = "ok", priceTotal } = {}) {
  const reservations = [];
  const blocks = [{ arrivalDate: "2027-03-10", departureDate: "2027-03-12" }];
  const log = [];
  let nextId = 7000001;
  const ok = (result) => ({ httpStatus: 200, json: { status: "success", result: JSON.parse(JSON.stringify(result)) } });
  const fail = (s) => ({ httpStatus: s, json: { status: "fail", result: null } });
  const overlap = (a, b) => a.arrivalDate < b.departureDate && b.arrivalDate < a.departureDate;
  async function send(req) {
    const i = log.length;
    log.push(JSON.parse(JSON.stringify(req)));
    if (intercept) {
      const r = intercept(req, i, { reservations });
      if (r === "hang") return new Promise(() => {});
      if (r === "throw") throw new Error("socket hang up");
      if (r !== undefined) return r;
    }
    let m;
    if (req.method === "POST" && /\/calendar\/priceDetails$/.test(req.path)) {
      const n = Math.round((Date.parse(req.body.endingDate) - Date.parse(req.body.startingDate)) / 86400000);
      return ok({ totalPrice: priceTotal ?? n * 100 + 50, components: [] });
    }
    if (req.method === "POST" && req.path === "/reservations") {
      const b = req.body;
      const stay = { arrivalDate: b.arrivalDate, departureDate: b.departureDate };
      if (blocks.some((x) => overlap(x, stay)) || reservations.some((r) => r.status !== "cancelled" && overlap(r, stay))) return fail(400);
      const r = { id: nextId++, listingMapId: b.listingMapId, channelId: b.channelId, arrivalDate: b.arrivalDate, departureDate: b.departureDate,
        totalPrice: b.totalPrice, currency: b.currency, status: "new", guestName: b.guestName, guestEmail: b.guestEmail,
        customFieldValues: b.customFieldValues };
      reservations.push(r);
      return ok(r);
    }
    if (req.method === "GET" && req.path === "/reservations") {
      const q = req.query;
      let items = reservations.filter((r) => r.listingMapId === q.listingId && r.channelId === q.channelId &&
        r.arrivalDate >= q.arrivalStartDate && r.arrivalDate <= q.arrivalEndDate).sort((a, b) => b.id - a.id);
      if (q.afterId !== undefined) { const k = items.findIndex((r) => r.id === q.afterId); items = k < 0 ? [] : items.slice(k + 1); }
      return ok(items.slice(0, q.limit));
    }
    if (req.method === "GET" && (m = /^\/reservations\/(\d+)$/.exec(req.path))) {
      const r = reservations.find((x) => x.id === Number(m[1]));
      return r ? ok(r) : fail(404);
    }
    if (req.method === "PUT" && (m = /^\/reservations\/(\d+)\/statuses\/cancelled$/.exec(req.path))) {
      const r = reservations.find((x) => x.id === Number(m[1]));
      if (!r) return fail(404);
      if (r.status === "cancelled" && repeatCancel === "refuse") return fail(400);
      r.status = "cancelled";
      return ok(r);
    }
    return fail(404);
  }
  return { transport: { send }, log, reservations };
}

async function run({ fake = fakeHostaway(), probe = SILENT, over = {}, mf = manifest() } = {}) {
  const dir = tmp();
  const v = validateManifest(mf, { now: NOW });
  assert.ok(v.ok, JSON.stringify(v));
  const journal = createFileJournal(dir, v.hash);
  const report = await executeRun({ mode: "execute", manifest: mf, confirm: v.confirmToken, transport: fake.transport, journal,
    sideEffectProbe: probe, now: NOW, timeoutMs: 50, ...over });
  journal.close();
  const text = readFileSync(journal.path, "utf8");
  return { report, fake, journalText: text, entries: readJournalFile(journal.path), dir, v };
}
const writesOf = (log) => log.filter((r) => r.method === "PUT" || (r.method === "POST" && r.path === "/reservations"));
const after = (log, k) => log.slice(k + 1);

// ---------- manifest ----------
test("manifest: the template is not approvable — every owner input is reported as a blocker", () => {
  const t = JSON.parse(readFileSync(join(ROOT, "scripts/e4-write-runner/manifest.template.json"), "utf8"));
  const v = validateManifest(t, { now: NOW });
  assert.equal(v.ok, false);
  assert.deepEqual(v.blockers.sort(), ["guest", "r1Block", "r2Stay", "window", "x1bOverlap"].map((k) => `OWNER_INPUT_REQUIRED:${k}`).sort());
  assert.equal(planRun(t, { now: NOW }).ok, false);
  const nested = manifest({ guest: { ...GUEST, email: PLACEHOLDER } });
  assert.deepEqual(validateManifest(nested, { now: NOW }).blockers, ["OWNER_INPUT_REQUIRED:guest.email"]);
});

test("manifest: listing must be exactly 606998 (pilots and others refused); USD and the fixed prices are mandatory", () => {
  const err = (over) => validateManifest(manifest(over), { now: NOW }).errors;
  assert.ok(err({ listingId: 603564 }).includes("PILOT_LISTING_FORBIDDEN"));
  assert.ok(err({ listingId: 603566 }).includes("PILOT_LISTING_FORBIDDEN"));
  assert.ok(err({ listingId: 990001 }).includes("LISTING_NOT_E4_TEST"));
  assert.ok(err({ currency: "MXN" }).includes("CURRENCY_NOT_USD"));
  assert.ok(err({ cleaningFeeMinor: 0 }).includes("FIXED_VALUE_MISMATCH:cleaningFeeMinor"));
  assert.ok(err({ nightlyMinor: 9900 }).includes("FIXED_VALUE_MISMATCH:nightlyMinor"));
  assert.ok(err({ refFieldId: 1 }).includes("FIXED_VALUE_MISMATCH:refFieldId"));
  assert.ok(err({ extra: 1 }).includes("UNKNOWN_FIELD:extra"));
  assert.ok(err({ guest: { ...GUEST, forceOverbooking: true } }).includes("FORCE_OVERBOOKING_REFUSED"));
  assert.deepEqual(validateManifest(manifest(), {}).errors, ["CLOCK_REQUIRED"]);
});

test("manifest: window far future and <= 31 nights; ranges inside it; R1/R2 disjoint; X1b overlaps R2 only", () => {
  const err = (over) => validateManifest(manifest(over), { now: NOW }).errors;
  assert.ok(err({ window: { start: "2026-11-01", end: "2026-11-10" }, r1Block: { arrivalDate: "2026-11-08", departureDate: "2026-11-09" },
    r2Stay: { arrivalDate: "2026-11-02", departureDate: "2026-11-04" }, x1bOverlap: { arrivalDate: "2026-11-03", departureDate: "2026-11-05" } })
    .includes("WINDOW_NOT_FAR_FUTURE"));
  assert.ok(err({ window: { start: "2027-03-01", end: "2027-04-15" } }).includes("RANGE_TOO_LONG:window"));
  assert.ok(err({ r2Stay: { arrivalDate: "2027-02-27", departureDate: "2027-03-02" } }).includes("OUTSIDE_WINDOW:r2Stay"));
  assert.ok(err({ r2Stay: { arrivalDate: "2027-03-09", departureDate: "2027-03-11" }, x1bOverlap: { arrivalDate: "2027-03-08", departureDate: "2027-03-09" } }).includes("R1_R2_OVERLAP"));
  assert.ok(err({ x1bOverlap: { arrivalDate: "2027-03-06", departureDate: "2027-03-07" } }).includes("X1B_NOT_OVERLAPPING_R2"));
  assert.ok(err({ x1bOverlap: { arrivalDate: "2027-03-04", departureDate: "2027-03-11" } }).includes("X1B_OVERLAPS_R1"));
  assert.ok(err({ r2Stay: { arrivalDate: "2027-03-03", departureDate: "2027-02-30" } }).includes("DATES_INVALID:r2Stay"));
  assert.ok(err({ guest: { ...GUEST, email: "not-an-email" } }).some((e) => e.startsWith("GUEST_OR_PLAN_INVALID")));
  assert.equal(expectedTotalMinor(MANIFEST.r2Stay), 25000);
});

test("manifest: hash/confirm token bind the exact content", () => {
  const a = validateManifest(manifest(), { now: NOW });
  const b = validateManifest(manifest({ guests: 2, r2Stay: { departureDate: "2027-03-05", arrivalDate: "2027-03-03" } }), { now: NOW });
  const c = validateManifest(manifest({ r2Stay: { arrivalDate: "2027-03-03", departureDate: "2027-03-04" } }), { now: NOW });
  assert.equal(a.hash, b.hash, "key order does not matter");
  assert.notEqual(a.hash, c.hash);
  assert.match(a.confirmToken, /^E4-EXECUTE-[0-9a-f]{12}$/);
});

// ---------- plan / dry-run ----------
test("dry-run: zero network, fixed 3 creates + 2 cancels, no guest data, no DELETE/payment/forceOverbooking", () => {
  const p = planRun(manifest(), { now: NOW });
  assert.equal(p.ok, true);
  assert.equal(p.network, "none");
  assert.equal(p.executionWired, false);
  const w = p.steps.filter((s) => s.kind === "create" || s.kind === "cancel");
  assert.deepEqual(w.map((s) => [s.step, s.method, s.executable !== false]), [["W1_CREATE_R2", "POST", true], ["W2_CREATE_X1B_OVERLAP", "POST", true],
    ["W3_CREATE_X1A_BLOCKED", "POST", false], ["W4_CANCEL_W1", "PUT", false], ["W5_CANCEL_REPEAT", "PUT", false]]);
  assert.equal(p.expectedTerminal, "HALTED_AT_W2_BY_DESIGN");
  assert.deepEqual(p.executableWrites, { create: 2, cancel: 0 });
  const text = JSON.stringify(p);
  for (const s of [GUEST.firstName, GUEST.lastName, GUEST.email, "DELETE", "forceOverbooking", "charge", "payment", "MV-DRYRUN0"]) {
    assert.ok(!text.includes(s), s);
  }
  assert.equal(planRun.length, 1, "planRun takes no transport");
});

test("budgets: per-step writes sum exactly to the run budget create 3 / cancel 2", () => {
  const sum = { create: 0, cancel: 0 };
  for (const b of Object.values(STEP_BUDGETS)) if (b.kind) sum[b.kind] += b.writes;
  assert.deepEqual(sum, { ...WRITE_BUDGET });
  assert.deepEqual(WRITE_BUDGET, { create: 3, cancel: 2 });
  const exe = { create: 0, cancel: 0 };
  for (const b of Object.values(STEP_BUDGETS)) if (b.kind && b.executable === true) exe[b.kind] += b.writes;
  assert.deepEqual(exe, { create: 2, cancel: 0 }, "with an empty refusal catalogue only W1 and W2 are executable");
});

// ---------- prerequisites: fail closed, zero requests ----------
test("execute: refused with zero requests unless every prerequisite is supplied", async () => {
  const dir = tmp();
  const v = validateManifest(manifest(), { now: NOW });
  const fake = fakeHostaway();
  const good = () => ({ mode: "execute", manifest: manifest(), confirm: v.confirmToken, transport: fake.transport,
    journal: createFileJournal(tmp(), v.hash), sideEffectProbe: SILENT, now: NOW });
  const cases = [
    [{ mode: "dry-run" }, "MODE_NOT_EXECUTE"], [{ mode: undefined }, "MODE_NOT_EXECUTE"],
    [{ confirm: "E4-EXECUTE-000000000000" }, "CONFIRM_TOKEN_MISMATCH"],
    [{ transport: undefined }, "TRANSPORT_MISSING"], [{ transport: {} }, "TRANSPORT_MISSING"],
    [{ journal: undefined }, "JOURNAL_MISSING"],
    [{ journal: { durable: false, boundHash: v.hash, load: () => [], append() {} } }, "JOURNAL_NOT_DURABLE"],
    [{ journal: { durable: true, boundHash: "0".repeat(64), load: () => [], append() {} } }, "JOURNAL_NOT_BOUND_TO_MANIFEST"],
    [{ journal: { durable: true, boundHash: v.hash, load: () => [{ type: "run-start" }], append() {} } }, "JOURNAL_NOT_EMPTY"],
    [{ sideEffectProbe: undefined }, "SIDE_EFFECT_PROBE_MISSING"],
    [{ now: undefined }, "CLOCK_MISSING"],
    [{ manifest: manifest({ guest: PLACEHOLDER }) }, "MANIFEST_NOT_APPROVABLE"],
    [{ timeoutMs: 0 }, "TIMEOUT_INVALID"]
  ];
  for (const [over, code] of cases) {
    const r = await executeRun({ ...good(), ...over });
    assert.equal(r.status, "REFUSED", code);
    assert.ok(r.prerequisites.includes(code), `${code}: ${r.prerequisites}`);
  }
  assert.equal(fake.log.length, 0, "no request was ever sent");
  assert.equal(checkExecutionPrerequisites(good()).ok, true);
  rmSync(dir, { recursive: true, force: true });
});

// ---------- happy path ----------
// ---------- the refusal invariant ----------
const fresh = () => ({ halted: false, readOnly: false, readableIds: new Set([7000001]), cancellableId: 7000001 });
const CREATE = { method: "POST", path: "/reservations", query: {}, body: { listingMapId: 606998, channelId: 2000, currency: "USD" } };
test("INVARIANT: W1 verified -> W2 HTTP 400 candidate -> lookup empty => W3/W4/W5 never dispatched; halted; no resume", async () => {
  const { report, fake, journalText, entries, dir, v } = await run();
  // W1 verified, W2 sent once and refused with an undocumented 400 (the fake's overlap refusal).
  const writes = writesOf(fake.log);
  assert.deepEqual(writes.map((r) => `${r.method} ${r.path} ${r.body.arrivalDate}`), ["POST /reservations 2027-03-03", "POST /reservations 2027-03-04"]);
  assert.ok(report.steps.some((x) => x.step === "W1_CREATE_R2" && x.code === "W1_VERIFIED_CREATED"));
  assert.deepEqual({ step: report.halt.step, code: report.halt.code, httpStatus: report.halt.httpStatus },
    { step: "W2_CREATE_X1B_OVERLAP", code: "REFUSAL_CANDIDATE_AMBIGUOUS", httpStatus: 400 });
  assert.equal(report.status, "HALTED");
  // W3 / W4 / W5 never dispatched; no cleanup cancellation of W1 either.
  assert.ok(!fake.log.some((r) => r.method === "PUT" || (r.method === "POST" && r.path === "/reservations" && r.body.arrivalDate === "2027-03-10")));
  assert.deepEqual(report.writes, { create: 2, cancel: 0 });
  assert.equal(fake.reservations.length, 1);
  assert.equal(fake.reservations[0].status, "new", "W1 is left for owner/reviewer-directed cleanup");
  // The empty-lookup result exists only as read-only reconciliation and unlocked nothing.
  const w2Index = fake.log.indexOf(writes[1]);
  assert.ok(after(fake.log, w2Index).length > 0 && after(fake.log, w2Index).every((r) => r.method === "GET"));
  const recW2 = report.reconcile.find((x) => x.ref === writes[1].body.customFieldValues[0].value);
  assert.equal(recW2.lookupCode, "NOT_FOUND_NON_AUTHORITATIVE");
  const recW1 = report.reconcile.find((x) => x.reservationId === fake.reservations[0].id);
  assert.deepEqual([recW1.readCode, recW1.reservationStatus], ["READ_OK", "new"]);
  // Journal: halted, then reconcile entries, then run-end. No guest data.
  const types = entries.map((e) => e.type);
  assert.ok(types.indexOf("halt") > types.lastIndexOf("intent"));
  assert.equal(entries.find((e) => e.type === "halt").code, "REFUSAL_CANDIDATE_AMBIGUOUS");
  for (const x of [GUEST.firstName, GUEST.lastName, GUEST.email]) assert.ok(!journalText.includes(x));
  // A fresh invocation cannot resume: the journal is exclusive and non-empty journals are refused.
  assert.throws(() => createFileJournal(dir, v.hash), (e) => e.code === "JOURNAL_EXISTS");
  const path = join(dir, journalFileName(v.hash));
  const reopened = { durable: true, boundHash: v.hash, load: () => readJournalFile(path), append() { throw new Error("must not write"); } };
  const second = fakeHostaway();
  const again = await executeRun({ mode: "execute", manifest: manifest(), confirm: v.confirmToken, transport: second.transport, journal: reopened,
    sideEffectProbe: SILENT, now: NOW, timeoutMs: 50 });
  assert.equal(again.status, "REFUSED");
  assert.ok(again.prerequisites.includes("JOURNAL_NOT_EMPTY"));
  assert.equal(second.log.length, 0);
  const rec = await reconcileFromJournal({ entries: readJournalFile(path), manifest: manifest(), transport: second.transport, now: NOW, timeoutMs: 50 });
  assert.equal(rec.writesPermitted, false);
  assert.deepEqual(rec.priorWrites, { create: 2, cancel: 0 });
  assert.ok(second.log.every((r) => r.method === "GET"));
});

test("W2: every undocumented 4xx (incl. 409 conflict) is ambiguous and halts; 401/403/429/5xx/timeout halt too", async () => {
  for (const s of [400, 404, 409, 410, 422, 401, 403, 429, 500, 502, "hang"]) {
    const fake = fakeHostaway({ intercept: (req) => (req.method === "POST" && req.path === "/reservations" && req.body.arrivalDate === "2027-03-04"
      ? (s === "hang" ? "hang" : { httpStatus: s, json: { status: "fail" } }) : undefined) });
    const { report } = await run({ fake });
    assert.equal(report.halt.step, "W2_CREATE_X1B_OVERLAP", String(s));
    assert.equal(writesOf(fake.log).length, 2, String(s));
    const expected = [400, 404, 409, 410, 422].includes(s) ? "REFUSAL_CANDIDATE_AMBIGUOUS" : undefined;
    if (expected) assert.equal(report.halt.code, expected, String(s));
    else assert.match(report.halt.code, /^WRITE_AMBIGUOUS:/, String(s));
  }
});

test("W2: an unexpected success halts; the extra id is kept for read-only reconciliation only (never cancelled)", async () => {
  const fake = fakeHostaway({ intercept: (req, i, { reservations }) => {
    if (req.method !== "POST" || req.path !== "/reservations" || req.body.arrivalDate !== "2027-03-04") return undefined;
    const b = req.body;
    const r = { id: 7200002, listingMapId: 606998, channelId: 2000, arrivalDate: b.arrivalDate, departureDate: b.departureDate,
      totalPrice: b.totalPrice, currency: "USD", status: "new", customFieldValues: b.customFieldValues };
    reservations.push(r);
    return { httpStatus: 200, json: { status: "success", result: r } };
  } });
  const { report } = await run({ fake });
  assert.equal(report.halt.code, "UNEXPECTED_CREATE_ON_REFUSAL_STEP");
  assert.equal(writesOf(fake.log).length, 2);
  assert.ok(!fake.log.some((r) => r.method === "PUT"));
  assert.ok(fake.log.some((r) => r.method === "GET" && r.path === "/reservations/7200002"), "read-only reconciliation of the extra id");
  assert.equal(report.reconcile.find((x) => x.reservationId === 7200002).foundReservationId, 7200002);
});

test("W2: a refused attempt that is nevertheless present is surfaced by reconciliation (halt already latched)", async () => {
  const fake = fakeHostaway({ intercept: (req, i, { reservations }) => {
    if (req.method === "POST" && req.path === "/reservations" && req.body.arrivalDate === "2027-03-04") {
      const b = req.body;
      reservations.push({ id: 7300003, listingMapId: 606998, channelId: 2000, arrivalDate: b.arrivalDate, departureDate: b.departureDate,
        totalPrice: b.totalPrice, currency: "USD", status: "new", customFieldValues: b.customFieldValues });
      return { httpStatus: 409, json: { status: "fail" } };
    }
    return undefined;
  } });
  const { report } = await run({ fake });
  assert.equal(report.halt.code, "REFUSAL_CANDIDATE_AMBIGUOUS");
  const w2 = report.reconcile.find((x) => x.foundReservationId === 7300003);
  assert.equal(w2.lookupCode, "FOUND_BY_REF");
  assert.ok(!fake.log.some((r) => r.method === "PUT"));
});

test("gate: W3/W4/W5 are non-executable even if every other guard would pass", async () => {
  let sent = 0;
  const transport = { send: async () => { sent++; return {}; } };
  const journal = { durable: true, load: () => [], append() {} };
  const g = createGate({ transport, journal, timeoutMs: 50, state: fresh() });
  const cancel = { method: "PUT", path: "/reservations/7000001/statuses/cancelled", query: {}, body: { cancelledBy: "host" } };
  await assert.rejects(g.send("W3_CREATE_X1A_BLOCKED", CREATE, { writeKind: "create", intent: {} }), (e) => e.code === "STEP_NOT_EXECUTABLE");
  await assert.rejects(g.send("W4_CANCEL_W1", cancel, { writeKind: "cancel", intent: {} }), (e) => e.code === "STEP_NOT_EXECUTABLE");
  await assert.rejects(g.send("W5_CANCEL_REPEAT", cancel, { writeKind: "cancel", intent: {} }), (e) => e.code === "STEP_NOT_EXECUTABLE");
  assert.equal(sent, 0);
  assert.deepEqual(BLOCKED_BY_EMPTY_REFUSAL_CATALOGUE, ["W3_CREATE_X1A_BLOCKED", "W4_CANCEL_W1", "W5_CANCEL_REPEAT"]);
});

// ---------- halts: no further writes, read-only reconciliation ----------
const w1Index = (log) => log.findIndex((r) => r.method === "POST" && r.path === "/reservations");
const W1_FAULTS = [
  ["timeout", () => "hang"], ["transport error", () => "throw"], ["malformed transport result", () => null],
  ["401", () => ({ httpStatus: 401, json: { status: "fail" } })], ["403", () => ({ httpStatus: 403, json: { status: "fail" } })],
  ["429", () => ({ httpStatus: 429, json: { status: "fail" } })], ["500", () => ({ httpStatus: 500, json: {} })],
  ["503", () => ({ httpStatus: 503, json: {} })], ["400 refusal", () => ({ httpStatus: 400, json: { status: "fail" } })],
  ["success without result", () => ({ httpStatus: 200, json: { status: "success" } })]
];
for (const [name, respond] of W1_FAULTS) {
  test(`halt: W1 ${name} => no later write (no retry, no re-auth, no cleanup); reconciliation is read-only`, async () => {
    const fake = fakeHostaway({ intercept: (req) => (req.method === "POST" && req.path === "/reservations" ? respond() : undefined) });
    const { report, entries } = await run({ fake });
    assert.equal(report.status, "HALTED");
    assert.equal(report.halt.step, "W1_CREATE_R2");
    assert.equal(writesOf(fake.log).length, 1, "exactly one write attempt");
    assert.ok(after(fake.log, w1Index(fake.log)).every((r) => r.method === "GET"), "only reads after the halt");
    assert.ok(report.reconcile.length === 1 && report.reconcile[0].lookupCode, "bounded ref lookup ran");
    assert.ok(entries.some((e) => e.type === "intent" && e.step === "W1_CREATE_R2"));
    assert.ok(entries.some((e) => e.type === "halt"));
  });
}

test("timeout: a hanging write resolves as TIMEOUT within the bound, is journaled, and halts", { timeout: 5000 }, async () => {
  const fake = fakeHostaway({ intercept: (req) => (req.method === "POST" && req.path === "/reservations" ? "hang" : undefined) });
  const t0 = Date.now();
  const { report, entries } = await run({ fake });
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(report.status, "HALTED");
  const o = entries.find((e) => e.type === "outcome" && e.step === "W1_CREATE_R2");
  assert.equal(o.transport, "TIMEOUT");
  assert.equal(o.code, "TRANSPORT_UNCERTAIN");
});

test("halt: W1 created but amount, currency, dates or ref differ => conflict, nothing cancelled", async () => {
  for (const [field, value] of [["totalPrice", 260], ["currency", "MXN"], ["departureDate", "2027-03-06"], ["status", "pending"], ["listingMapId", 606999]]) {
    const fake = fakeHostaway({ intercept: (req, i, { reservations }) => {
      if (req.method !== "POST" || req.path !== "/reservations") return undefined;
      const b = req.body;
      const r = { id: 7100001, listingMapId: b.listingMapId, channelId: 2000, arrivalDate: b.arrivalDate, departureDate: b.departureDate,
        totalPrice: b.totalPrice, currency: "USD", status: "new", customFieldValues: b.customFieldValues, [field]: value };
      reservations.push(r);
      return { httpStatus: 200, json: { status: "success", result: r } };
    } });
    const { report } = await run({ fake });
    assert.equal(report.status, "HALTED", field);
    assert.equal(writesOf(fake.log).length, 1, field);
    assert.ok(!fake.log.some((r) => r.method === "PUT"), `${field}: no cancel of an unverified reservation`);
  }
});

test("halt: W1 read-back by id disagreeing with the verified create (status/total/dates/ref) => halt before W2", async () => {
  for (const [field, value] of [["status", "modified"], ["totalPrice", 240], ["departureDate", "2027-03-06"], ["customFieldValues", []]]) {
    const fake = fakeHostaway({ intercept: (req, i, { reservations }) => (req.method === "GET" && /^\/reservations\/\d+$/.test(req.path)
      ? { httpStatus: 200, json: { status: "success", result: { ...reservations[0], [field]: value } } } : undefined) });
    const { report } = await run({ fake });
    assert.equal(report.halt.step, "S2_READBACK_W1", field);
    assert.equal(report.halt.code, "READBACK_IDENTITY_MISMATCH", field);
    assert.equal(writesOf(fake.log).length, 1, field);
  }
});

test("halt: preflight price differs from the manifest total => zero writes", async () => {
  const fake = fakeHostaway({ priceTotal: 260 });
  const { report } = await run({ fake });
  assert.equal(report.halt.code, "PREFLIGHT_TOTAL_MISMATCH");
  assert.equal(writesOf(fake.log).length, 0);
});

test("halt: any existing reservation on R2's arrival date (e.g. an earlier run) => zero writes", async () => {
  const fake = fakeHostaway();
  fake.reservations.push({ id: 6999999, listingMapId: 606998, channelId: 2000, arrivalDate: "2027-03-03", departureDate: "2027-03-05",
    totalPrice: 250, currency: "USD", status: "new", customFieldValues: [{ customFieldId: 105433, value: "MV-OLDRUN01" }] });
  const { report } = await run({ fake });
  assert.equal(report.halt.code, "PREFLIGHT_R2_NOT_CLEAR");
  assert.equal(writesOf(fake.log).length, 0);
});

test("halt: side-effect signal or unknown probe state after a write stops all later writes", async () => {
  for (const probe of [async () => ({ signals: ["payment_request"] }), async () => ({}), async () => { throw new Error("x"); },
    async () => ({ signals: [], extra: 1 }), () => new Promise(() => {}), async () => null]) {
    const { report, fake, journalText } = await run({ probe });
    assert.equal(report.status, "HALTED");
    assert.equal(report.halt.step, "W1_CREATE_R2");
    assert.equal(writesOf(fake.log).length, 1);
    assert.ok(!journalText.includes("payment_request"), "signal contents are not journaled");
  }
});

// ---------- gate unit tests ----------
test("gate: allowlist — no DELETE, payments, other listings, unknown ids, extra fields or forceOverbooking", () => {
  const s = fresh();
  const code = (req, wk) => { try { assertAllowedRequest(req, s, wk); } catch (e) { return e.code; } return "ALLOWED"; };
  assert.equal(code(CREATE, "create"), "ALLOWED");
  assert.equal(code({ method: "DELETE", path: "/reservations/7000001" }), "REQUEST_NOT_ALLOWLISTED");
  assert.equal(code({ method: "POST", path: "/guestPayments/charges/7000001", body: {} }), "REQUEST_NOT_ALLOWLISTED");
  assert.equal(code({ ...CREATE, body: { ...CREATE.body, listingMapId: 603564 } }, "create"), "REQUEST_NOT_ALLOWLISTED");
  assert.equal(code({ ...CREATE, body: { ...CREATE.body, financeField: [] } }, "create"), "REQUEST_NOT_ALLOWLISTED");
  assert.equal(code({ ...CREATE, query: { forceOverbooking: 1 } }, "create"), "FORCE_OVERBOOKING_REFUSED");
  assert.equal(code({ ...CREATE, body: { ...CREATE.body, x: [{ ForceOverbooking: true }] } }, "create"), "FORCE_OVERBOOKING_REFUSED");
  assert.equal(code(CREATE, null), "WRITE_KIND_MISMATCH");
  assert.equal(code({ method: "PUT", path: "/reservations/7000002/statuses/cancelled", query: {}, body: { cancelledBy: "host" } }, "cancel"), "CANCEL_TARGET_NOT_VERIFIED");
  assert.equal(code({ method: "PUT", path: "/reservations/7000001/statuses/cancelled", query: {}, body: { cancelledBy: "guest" } }, "cancel"), "REQUEST_NOT_ALLOWLISTED");
  assert.equal(code({ method: "PUT", path: "/reservations/7000001/statuses/cancelled", query: {}, body: { cancelledBy: "host" } }, "cancel"), "ALLOWED");
  assert.equal(code({ method: "GET", path: "/reservations/7000002", query: { includeResources: 1 } }), "READ_TARGET_NOT_FROM_THIS_RUN");
  assert.equal(code({ method: "GET", path: "/reservations", query: { listingId: 603566, channelId: 2000 } }), "REQUEST_NOT_ALLOWLISTED");
  assert.equal(code({ method: "GET", path: "/reservations", query: { listingId: 606998, channelId: 2000, offset: 5 } }), "REQUEST_NOT_ALLOWLISTED");
  s.cancellableId = null;
  assert.equal(code({ method: "PUT", path: "/reservations/7000001/statuses/cancelled", query: {}, body: { cancelledBy: "host" } }, "cancel"), "CANCEL_TARGET_NOT_VERIFIED");
});

test("gate: halt latch, read-only mode, step and DURABLE run budgets refuse writes before sending", async () => {
  let sent = 0;
  const transport = { send: async () => { sent++; return { httpStatus: 400, json: { status: "fail" } }; } };
  const mk = (entries = []) => ({ durable: true, load: () => entries, append: (e) => entries.push(e) });
  const tryWrite = async (state, journal, step = "W1_CREATE_R2") => {
    try { await createGate({ transport, journal, timeoutMs: 50, state }).send(step, CREATE, { writeKind: "create", intent: {} }); return "SENT"; }
    catch (e) { return e.code; }
  };
  assert.equal(await tryWrite({ ...fresh(), halted: true }, mk()), "WRITE_AFTER_HALT");
  assert.equal(await tryWrite({ ...fresh(), readOnly: true }, mk()), "WRITE_IN_READ_ONLY_MODE");
  assert.equal(await tryWrite(fresh(), mk(), "S2_READBACK_W1"), "STEP_KIND_MISMATCH");
  const three = [1, 2, 3].map(() => ({ type: "intent", kind: "create" }));
  assert.equal(await tryWrite(fresh(), mk([...three])), "RUN_WRITE_BUDGET_EXHAUSTED", "budget comes from the journal");
  assert.equal(sent, 0);
  // per-step: a second write in the same step is refused
  const j = mk();
  const g = createGate({ transport, journal: j, timeoutMs: 50, state: fresh() });
  await g.send("W1_CREATE_R2", CREATE, { writeKind: "create", intent: {} });
  await assert.rejects(g.send("W1_CREATE_R2", CREATE, { writeKind: "create", intent: {} }), (e) => e.code === "STEP_WRITE_BUDGET_EXHAUSTED");
  assert.equal(sent, 1);
  // read budget
  const rd = { method: "GET", path: "/reservations/7000001", query: { includeResources: 1 } };
  await g.send("S2_READBACK_W1", rd);
  await assert.rejects(g.send("S2_READBACK_W1", rd), (e) => e.code === "STEP_READ_BUDGET_EXHAUSTED");
});

test("gate: if the write-ahead intent cannot be journaled, the write is never sent", async () => {
  let sent = 0;
  const transport = { send: async () => { sent++; return {}; } };
  const journal = { durable: true, load: () => [], append: () => { throw new Error("disk full"); } };
  const state = fresh();
  await assert.rejects(createGate({ transport, journal, timeoutMs: 50, state }).send("W1_CREATE_R2", CREATE, { writeKind: "create", intent: {} }),
    (e) => e.code === "JOURNAL_WRITE_FAILED");
  assert.equal(sent, 0);
  assert.equal(state.halted, true);
});

test("execute: a journal failure on W1's intent halts with zero writes sent", async () => {
  const v = validateManifest(manifest(), { now: NOW });
  const fake = fakeHostaway();
  const entries = [];
  const journal = { durable: true, boundHash: v.hash, load: () => [...entries],
    append: (e) => { if (e.type === "intent") throw new Error("io"); entries.push(e); } };
  const r = await executeRun({ mode: "execute", manifest: manifest(), confirm: v.confirmToken, transport: fake.transport, journal, sideEffectProbe: SILENT, now: NOW, timeoutMs: 50 });
  assert.equal(r.halt.code, "JOURNAL_WRITE_FAILED");
  assert.equal(writesOf(fake.log).length, 0);
});

// ---------- replay / restart ----------
test("replay: the journal is exclusive per manifest; an existing one is never reused or overwritten", async () => {
  const { dir, v, journalText } = await run();
  assert.throws(() => createFileJournal(dir, v.hash), (e) => e instanceof JournalError && e.code === "JOURNAL_EXISTS");
  assert.equal(readFileSync(join(dir, journalFileName(v.hash)), "utf8"), journalText, "untouched");
});

test("restart: an intent without outcome is INDETERMINATE; reconciliation only reads, never writes", async () => {
  const fake = fakeHostaway({ intercept: (req) => (req.method === "POST" && req.path === "/reservations" ? "hang" : undefined) });
  const { dir, v } = await run({ fake });
  const path = join(dir, journalFileName(v.hash));
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const cut = lines.findIndex((l) => JSON.parse(l).type === "intent");
  writeFileSync(path, `${lines.slice(0, cut + 1).join("\n")}\n`); // simulate a crash right after the durable intent
  const entries = readJournalFile(path);
  const later = fakeHostaway();
  const r = await reconcileFromJournal({ entries, manifest: manifest(), transport: later.transport, now: NOW, timeoutMs: 50 });
  assert.equal(r.status, "RECONCILED_READ_ONLY");
  assert.equal(r.writesPermitted, false);
  assert.deepEqual(r.indeterminateSteps, ["W1_CREATE_R2"]);
  assert.deepEqual(r.priorWrites, { create: 1, cancel: 0 });
  assert.ok(later.log.length > 0 && later.log.every((q) => q.method === "GET"));
  const other = await reconcileFromJournal({ entries, manifest: manifest({ r2Stay: { arrivalDate: "2027-03-02", departureDate: "2027-03-05" } }),
    transport: later.transport, now: NOW });
  assert.equal(other.code, "JOURNAL_MANIFEST_MISMATCH");
  writeFileSync(path, `${lines[0]}\n{"type":"intent"`);
  assert.throws(() => readJournalFile(path), (e) => e.code === "JOURNAL_CORRUPT");
});

// ---------- refs and sanitizer ----------
test("refs: DB-compatible format, unique per attempt, bounded generation", () => {
  const refs = generateRunRefs(undefined, 4); // default: node:crypto randomBytes
  assert.equal(new Set(refs).size, 4);
  for (const r of refs) assert.match(r, /^MV-[A-Z0-9]{8}$/);
  const constant = () => Buffer.alloc(16, 7);
  assert.throws(() => generateRunRefs(constant, 4), (e) => e instanceof RunnerError && e.code === "REF_GENERATION_FAILED");
  assert.throws(() => generateRef(() => Buffer.alloc(16, 255)), (e) => e.code === "REF_GENERATION_FAILED");
});

test("sanitizer: unknown keys and invalid values are dropped (no guest data, no provider strings)", () => {
  const e = sanitizeJournalEntry({ type: "outcome", step: "W1_CREATE_R2", guestEmail: GUEST.email, code: "bad code with spaces", ref: "MV-OK123456",
    message: "provider text", evidence: { outcome: "created", reservation: { reservationId: 1, guestName: "x", currency: "USD" } }, httpStatus: 999 });
  assert.deepEqual(Object.keys(e).sort(), ["evidence", "ref", "step", "type"]);
  assert.deepEqual(e.evidence, { outcome: "created", reservation: { reservationId: 1, currency: "USD" } });
});

// ---------- containment ----------
test("containment: no transport, env, credentials or URLs in the runner; nothing deployable imports it; scripts excluded from Vercel", () => {
  const dir = join(ROOT, "scripts/e4-write-runner");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".mjs"))) {
    const code = readFileSync(join(dir, f), "utf8"); // raw source, comments included
    for (const re of [/process\.env/, /\bfetch\s*\(/, /https?:\/\//, /lib\/hostaway\.js/, /from\s+"(?:node:)?(?:https?|net|tls|dns|http2)"/, /\bdotenv\b/, /child_process/,
      /\beval\s*\(|new Function/]) {
      assert.doesNotMatch(code, re, `${f} ${re}`);
    }
  }
  const walk = (d, out = []) => {
    for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p, out); else if (/\.(m?js|cjs)$/.test(e.name) && readFileSync(join(ROOT, p), "utf8").includes("e4-write-runner")) out.push(p);
    }
    return out;
  };
  assert.deepEqual([...walk("api"), ...walk("lib"), ...walk("db")], []);
  const ignore = readFileSync(join(ROOT, ".vercelignore"), "utf8").split("\n").map((l) => l.trim());
  assert.ok(ignore.includes("/scripts") && ignore.includes("/test"));
  assert.equal(EXECUTION_WIRED, false);
});

test("cli: dry-run prints a zero-network plan; --execute is refused (not wired)", () => {
  const dir = tmp();
  const p = join(dir, "m.json");
  const far = { ...manifest() };
  writeFileSync(p, JSON.stringify(far));
  const cli = join(ROOT, "scripts/e4-write-runner/cli.mjs");
  const ex = spawnSync(process.execPath, [cli, "--execute", p], { encoding: "utf8", env: {} });
  assert.equal(ex.status, 2);
  assert.equal(JSON.parse(ex.stdout).error, "EXECUTION_NOT_WIRED");
  const dr = spawnSync(process.execPath, [cli, "--dry-run", join(ROOT, "scripts/e4-write-runner/manifest.template.json")], { encoding: "utf8", env: {} });
  assert.equal(dr.status, 1);
  assert.equal(JSON.parse(dr.stdout).network, "none");
  assert.ok(existsSync(cli));
});
