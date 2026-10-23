// E4 happy-path sequence (scripts/e4-write-runner/happy-path.mjs) — offline tests. No network, credentials or env:
// every provider response comes from the in-memory FAKE below (synthetic; not provider evidence).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  validateHappyManifest, planHappyRun, executeHappyRun, reconcileHappyFromJournal, HAPPY_STEPS, HAPPY_WRITE_BUDGET, HAPPY_EXECUTION_WIRED
} from "../scripts/e4-write-runner/happy-path.mjs";
import { createGate, PLACEHOLDER } from "../scripts/e4-write-runner/runner.mjs";
import { createFileJournal, readJournalFile, journalFileName } from "../scripts/e4-write-runner/journal.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const NOW = () => new Date("2026-10-22T18:00:00.000Z");
const GUEST = Object.freeze({ firstName: "Synthetic", lastName: "Tester", email: "e4-synthetic@example.invalid" });
const MANIFEST = Object.freeze({
  manifestVersion: "e4-happy-manifest-v1", listingId: 606998, refFieldId: 105433, currency: "USD", nightlyMinor: 10000,
  cleaningFeeMinor: 5000, guests: 2, window: { start: "2027-03-01", end: "2027-03-15" },
  stay: { arrivalDate: "2027-03-03", departureDate: "2027-03-05" }, guest: GUEST
});
const manifest = (over = {}) => ({ ...JSON.parse(JSON.stringify(MANIFEST)), ...over });
const tmp = () => mkdtempSync(join(tmpdir(), "e4-happy-"));
const SILENT = async () => ({ signals: [] });

function fakeHostaway({ intercept } = {}) {
  const reservations = [];
  const log = [];
  let nextId = 8000001;
  const ok = (r) => ({ httpStatus: 200, json: { status: "success", result: JSON.parse(JSON.stringify(r)) } });
  const fail = (s) => ({ httpStatus: s, json: { status: "fail", result: null } });
  async function send(req) {
    const i = log.length;
    log.push(JSON.parse(JSON.stringify(req)));
    if (intercept) {
      const r = intercept(req, i, { reservations, log });
      if (r === "hang") return new Promise(() => {});
      if (r === "throw") throw new Error("socket hang up");
      if (r !== undefined) return r;
    }
    let m;
    if (req.method === "POST" && /\/calendar\/priceDetails$/.test(req.path)) {
      const n = Math.round((Date.parse(req.body.endingDate) - Date.parse(req.body.startingDate)) / 86400000);
      return ok({ totalPrice: n * 100 + 50 });
    }
    if (req.method === "POST" && req.path === "/reservations") {
      const b = req.body;
      const r = { id: nextId++, listingMapId: b.listingMapId, channelId: b.channelId, arrivalDate: b.arrivalDate, departureDate: b.departureDate,
        totalPrice: b.totalPrice, currency: b.currency, status: "new", guestName: b.guestName, guestEmail: b.guestEmail, customFieldValues: b.customFieldValues };
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
      r.status = "cancelled";
      return ok(r);
    }
    return fail(404);
  }
  return { transport: { send }, log, reservations };
}

async function run({ fake = fakeHostaway(), probe = SILENT, mf = manifest(), over = {} } = {}) {
  const dir = tmp();
  const v = validateHappyManifest(mf, { now: NOW });
  assert.ok(v.ok, JSON.stringify(v));
  const journal = createFileJournal(dir, v.hash);
  const report = await executeHappyRun({ mode: "execute", manifest: mf, confirm: v.confirmToken, transport: fake.transport, journal,
    sideEffectProbe: probe, now: NOW, timeoutMs: 50, ...over });
  journal.close();
  return { report, fake, dir, v, journalText: readFileSync(journal.path, "utf8"), entries: readJournalFile(journal.path) };
}
const writesOf = (log) => log.filter((r) => r.method === "PUT" || (r.method === "POST" && r.path === "/reservations"));
const puts = (log) => log.filter((r) => r.method === "PUT");
const readsById = (log) => log.filter((r) => r.method === "GET" && /^\/reservations\/\d+$/.test(r.path));
// Override the n-th (0-based) read-by-id with a modified copy of the stored reservation.
const nthReadById = (n, change) => (req, i, { reservations, log }) => {
  if (!(req.method === "GET" && /^\/reservations\/\d+$/.test(req.path))) return undefined;
  if (readsById(log).length - 1 !== n) return undefined;
  return { httpStatus: 200, json: { status: "success", result: { ...reservations[0], ...change } } };
};

// ---------- manifest / plan ----------
test("manifest: template not approvable; 606998 only; USD and fixed prices; far-future window; stay inside it", () => {
  const t = JSON.parse(readFileSync(join(ROOT, "scripts/e4-write-runner/happy-manifest.template.json"), "utf8"));
  assert.deepEqual(validateHappyManifest(t, { now: NOW }).blockers.sort(), ["guest", "stay", "window"].map((k) => `OWNER_INPUT_REQUIRED:${k}`).sort());
  const err = (over) => validateHappyManifest(manifest(over), { now: NOW }).errors;
  assert.ok(err({ listingId: 603564 }).includes("PILOT_LISTING_FORBIDDEN"));
  assert.ok(err({ listingId: 603566 }).includes("PILOT_LISTING_FORBIDDEN"));
  assert.ok(err({ listingId: 1 }).includes("LISTING_NOT_E4_TEST"));
  assert.ok(err({ currency: "MXN" }).includes("CURRENCY_NOT_USD"));
  assert.ok(err({ cleaningFeeMinor: 0 }).includes("FIXED_VALUE_MISMATCH:cleaningFeeMinor"));
  assert.ok(err({ window: { start: "2026-11-01", end: "2026-11-10" }, stay: { arrivalDate: "2026-11-02", departureDate: "2026-11-04" } }).includes("WINDOW_NOT_FAR_FUTURE"));
  assert.ok(err({ stay: { arrivalDate: "2027-03-14", departureDate: "2027-03-17" } }).includes("OUTSIDE_WINDOW:stay"));
  assert.ok(err({ stay: { arrivalDate: "2027-03-01", departureDate: "2027-03-10" } }).includes("RANGE_TOO_LONG:stay"));
  assert.ok(err({ guest: { ...GUEST, forceOverbooking: true } }).includes("FORCE_OVERBOOKING_REFUSED"));
  assert.ok(err({ r1Block: {} }).includes("UNKNOWN_FIELD:r1Block"));
  assert.deepEqual(validateHappyManifest(manifest({ guest: PLACEHOLDER }), { now: NOW }).blockers, ["OWNER_INPUT_REQUIRED:guest"]);
});

test("dry-run: zero network; exactly 1 create + 1 cancel; no refusal/overlap/repeat steps; no guest data", () => {
  const p = planHappyRun(manifest(), { now: NOW });
  assert.equal(p.ok, true);
  assert.equal(p.network, "none");
  assert.equal(p.executionWired, false);
  assert.deepEqual(p.writeBudget, { create: 1, cancel: 1 });
  assert.deepEqual(p.steps.filter((s) => s.method === "PUT" || (s.method === "POST" && s.path === "/reservations")).map((s) => s.step), ["HW1_CREATE", "HW2_CANCEL"]);
  assert.equal(p.stay.totalMinor, 25000);
  const text = JSON.stringify(p);
  for (const x of [GUEST.firstName, GUEST.email, "OVERLAP", "REFUSAL", "REPEAT", "DELETE", "forceOverbooking", "MV-DRYRUN0"]) assert.ok(!text.includes(x), x);
  assert.equal(planHappyRun.length, 1, "no transport parameter");
  let sumC = 0, sumX = 0;
  for (const b of Object.values(HAPPY_STEPS)) { if (b.kind === "create") sumC += b.writes; if (b.kind === "cancel") sumX += b.writes; }
  assert.deepEqual([sumC, sumX], [HAPPY_WRITE_BUDGET.create, HAPPY_WRITE_BUDGET.cancel]);
});

test("execute: refused with zero requests unless every prerequisite is supplied", async () => {
  const v = validateHappyManifest(manifest(), { now: NOW });
  const fake = fakeHostaway();
  const good = () => ({ mode: "execute", manifest: manifest(), confirm: v.confirmToken, transport: fake.transport,
    journal: createFileJournal(tmp(), v.hash), sideEffectProbe: SILENT, now: NOW });
  for (const [over, code] of [[{ mode: "dry-run" }, "MODE_NOT_EXECUTE"], [{ confirm: "E4-HAPPY-000000000000" }, "CONFIRM_TOKEN_MISMATCH"],
    [{ transport: {} }, "TRANSPORT_MISSING"], [{ journal: { durable: false, boundHash: v.hash, load: () => [], append() {} } }, "JOURNAL_NOT_DURABLE"],
    [{ journal: { durable: true, boundHash: v.hash, load: () => [{ type: "run-start" }], append() {} } }, "JOURNAL_NOT_EMPTY"],
    [{ journal: { durable: true, boundHash: "0".repeat(64), load: () => [], append() {} } }, "JOURNAL_NOT_BOUND_TO_MANIFEST"],
    [{ sideEffectProbe: undefined }, "SIDE_EFFECT_PROBE_MISSING"], [{ now: undefined }, "CLOCK_MISSING"],
    [{ manifest: manifest({ stay: PLACEHOLDER }) }, "MANIFEST_NOT_APPROVABLE"]]) {
    const r = await executeHappyRun({ ...good(), ...over });
    assert.equal(r.status, "REFUSED", code);
    assert.ok(r.prerequisites.includes(code), `${code}: ${r.prerequisites}`);
  }
  assert.equal(fake.log.length, 0);
});

// ---------- happy path ----------
test("execute (fake): create -> verify -> cancel the SAME verified id; exactly 1 create + 1 cancel; sanitized journal", async () => {
  const { report, fake, journalText, entries } = await run();
  assert.equal(report.status, "COMPLETED");
  assert.deepEqual(report.writes, { create: 1, cancel: 1 });
  const id = fake.reservations[0].id;
  assert.deepEqual(writesOf(fake.log).map((r) => `${r.method} ${r.path}`), ["POST /reservations", `PUT /reservations/${id}/statuses/cancelled`]);
  assert.deepEqual(puts(fake.log)[0].body, { cancelledBy: "host" });
  assert.deepEqual(puts(fake.log)[0].query, {});
  const create = writesOf(fake.log)[0].body;
  assert.deepEqual([create.listingMapId, create.channelId, create.currency, create.totalPrice, create.arrivalDate, create.departureDate],
    [606998, 2000, "USD", 250, "2027-03-03", "2027-03-05"]);
  assert.match(create.customFieldValues[0].value, /^MV-[A-Z0-9]{8}$/);
  assert.equal(fake.reservations.length, 1);
  assert.equal(fake.reservations[0].status, "cancelled");
  // The last read before the PUT is the fresh pre-cancel read of the same id.
  const iPut = fake.log.indexOf(puts(fake.log)[0]);
  assert.equal(fake.log[iPut - 1].path, `/reservations/${id}`);
  const steps = entries.map((e) => `${e.type}:${e.step ?? ""}`);
  for (const s of ["HW1_CREATE", "HW2_CANCEL"]) assert.ok(steps.indexOf(`intent:${s}`) > -1 && steps.indexOf(`intent:${s}`) < steps.indexOf(`outcome:${s}`), s);
  for (const x of [GUEST.firstName, GUEST.lastName, GUEST.email, "guestName", "guestEmail"]) assert.ok(!journalText.includes(x), x);
  assert.ok(fake.log.every((r) => r.method !== "DELETE" && !JSON.stringify(r).toLowerCase().includes("forceoverbooking")));
});

// ---------- create-side halts: never a cancel ----------
test("halt: any reservation already on the stay's arrival date (e.g. an earlier run) => zero writes", async () => {
  const fake = fakeHostaway();
  fake.reservations.push({ id: 7999999, listingMapId: 606998, channelId: 2000, arrivalDate: "2027-03-03", departureDate: "2027-03-05",
    totalPrice: 250, currency: "USD", status: "new", customFieldValues: [{ customFieldId: 105433, value: "MV-OLDRUN01" }] });
  const { report } = await run({ fake });
  assert.deepEqual([report.halt.step, report.halt.code], ["P1_PREFLIGHT_CLEAR", "PREFLIGHT_NOT_CLEAR"]);
  assert.equal(writesOf(fake.log).length, 0);
});


for (const [name, respond] of [["timeout", () => "hang"], ["transport error", () => "throw"], ["401", () => ({ httpStatus: 401, json: { status: "fail" } })],
  ["429", () => ({ httpStatus: 429, json: { status: "fail" } })], ["500", () => ({ httpStatus: 500, json: {} })],
  ["400 refusal candidate", () => ({ httpStatus: 400, json: { status: "fail" } })], ["success without result", () => ({ httpStatus: 200, json: { status: "success" } })]]) {
  test(`halt: create ${name} => no cancel/cleanup, one create attempt, reads only after`, async () => {
    const fake = fakeHostaway({ intercept: (req) => (req.method === "POST" && req.path === "/reservations" ? respond() : undefined) });
    const { report } = await run({ fake });
    assert.equal(report.status, "HALTED");
    assert.equal(report.halt.step, "HW1_CREATE");
    assert.equal(writesOf(fake.log).length, 1);
    assert.equal(puts(fake.log).length, 0);
    const k = fake.log.findIndex((r) => r.method === "POST" && r.path === "/reservations");
    assert.ok(fake.log.slice(k + 1).every((r) => r.method === "GET"));
    assert.ok(report.reconcile.length === 1);
  });
}

test("halt: created reservation with wrong total, currency, dates, status or listing => no cancel", async () => {
  for (const [field, value] of [["totalPrice", 260], ["currency", "MXN"], ["departureDate", "2027-03-06"], ["status", "pending"], ["listingMapId", 606999]]) {
    const fake = fakeHostaway({ intercept: (req, i, { reservations }) => {
      if (!(req.method === "POST" && req.path === "/reservations")) return undefined;
      const b = req.body;
      const r = { id: 8100001, listingMapId: 606998, channelId: 2000, arrivalDate: b.arrivalDate, departureDate: b.departureDate,
        totalPrice: b.totalPrice, currency: "USD", status: "new", customFieldValues: b.customFieldValues, [field]: value };
      reservations.push(r);
      return { httpStatus: 200, json: { status: "success", result: r } };
    } });
    const { report } = await run({ fake });
    assert.equal(report.halt.step, "HW1_CREATE", field);
    assert.equal(puts(fake.log).length, 0, field);
  }
});

test("halt: read-back (P2) mismatch on any identity field => no cancel", async () => {
  for (const change of [{ status: "modified" }, { totalPrice: 240 }, { currency: "MXN" }, { arrivalDate: "2027-03-02" }, { customFieldValues: [] }]) {
    const fake = fakeHostaway({ intercept: nthReadById(0, change) });
    const { report } = await run({ fake });
    assert.deepEqual([report.halt.step, report.halt.code], ["P2_READBACK", "READBACK_IDENTITY_MISMATCH"], JSON.stringify(change));
    assert.equal(puts(fake.log).length, 0);
  }
});

test("halt: ref lookup (P3) with matching id+ref but different total/currency/status => no cancel", async () => {
  for (const [field, value, mm] of [["totalPrice", 240, "totalMinor"], ["currency", "MXN", "currency"], ["status", "modified", "status"]]) {
    const fake = fakeHostaway({ intercept: (req, i, { reservations }) => (req.method === "GET" && req.path === "/reservations" && reservations.length &&
      req.query.afterId === undefined ? { httpStatus: 200, json: { status: "success", result: [{ ...reservations[0], [field]: value }] } } : undefined) });
    const { report } = await run({ fake });
    assert.deepEqual([report.halt.step, report.halt.code, report.halt.mismatches], ["P3_LOOKUP_REF", "LOOKUP_IDENTITY_MISMATCH", [mm]], field);
    assert.equal(puts(fake.log).length, 0);
  }
});

test("halt: FRESH pre-cancel read (P4) no longer matching (status/total/dates/ref) or unreadable => no cancel", async () => {
  for (const change of [{ status: "modified" }, { status: "cancelled" }, { totalPrice: 250.5 }, { departureDate: "2027-03-06" },
    { customFieldValues: [{ customFieldId: 105433, value: "MV-OTHER123" }] }]) {
    const fake = fakeHostaway({ intercept: nthReadById(1, change) });
    const { report } = await run({ fake });
    assert.deepEqual([report.halt.step, report.halt.code], ["P4_PRECANCEL_READ", "PRECANCEL_IDENTITY_MISMATCH"], JSON.stringify(change));
    assert.equal(puts(fake.log).length, 0);
  }
  for (const resp of [{ httpStatus: 500, json: {} }, "hang", { httpStatus: 404, json: { status: "fail" } }]) {
    const fake = fakeHostaway({ intercept: (req, i, ctx) => (req.method === "GET" && /^\/reservations\/\d+$/.test(req.path) && readsById(ctx.log).length === 2 ? resp : undefined) });
    const { report } = await run({ fake });
    assert.equal(report.halt.step, "P4_PRECANCEL_READ");
    assert.equal(puts(fake.log).length, 0);
  }
});

test("halt: side-effect signal or unknown state after the create => the cancel (cleanup) is NOT sent", async () => {
  for (const probe of [async ({ step }) => (step === "HW1_CREATE" ? { signals: ["payment_request"] } : { signals: [] }), async () => ({}),
    async () => { throw new Error("x"); }, () => new Promise(() => {})]) {
    const { report, fake, journalText } = await run({ probe });
    assert.deepEqual([report.status, report.halt.step], ["HALTED", "HW1_CREATE"]);
    assert.equal(puts(fake.log).length, 0);
    assert.ok(!journalText.includes("payment_request"));
  }
});

test("cancel: ambiguous or mismatching cancel response => one PUT only, halted, reads only after", async () => {
  for (const resp of [{ httpStatus: 500, json: {} }, "hang", "throw", { httpStatus: 400, json: { status: "fail" } }, { httpStatus: 429, json: { status: "fail" } }]) {
    const fake = fakeHostaway({ intercept: (req) => (req.method === "PUT" ? resp : undefined) });
    const { report } = await run({ fake });
    assert.equal(report.halt.step, "HW2_CANCEL", JSON.stringify(resp));
    assert.equal(puts(fake.log).length, 1);
    const k = fake.log.indexOf(puts(fake.log)[0]);
    assert.ok(fake.log.slice(k + 1).every((r) => r.method === "GET"));
  }
  for (const change of [{ status: "new" }, { id: 8000999 }, { totalPrice: 0 }, { currency: "MXN" }]) {
    const fake = fakeHostaway({ intercept: (req, i, { reservations }) => (req.method === "PUT"
      ? { httpStatus: 200, json: { status: "success", result: { ...reservations[0], status: "cancelled", ...change } } } : undefined) });
    const { report } = await run({ fake });
    assert.deepEqual([report.halt.step, report.halt.code], ["HW2_CANCEL", "CANCEL_RESPONSE_MISMATCH"], JSON.stringify(change));
    assert.equal(puts(fake.log).length, 1);
  }
});

test("post-cancel read (P5) not showing the cancelled reservation => HALTED (nothing further is written)", async () => {
  const fake = fakeHostaway({ intercept: nthReadById(2, { status: "new" }) });
  const { report } = await run({ fake });
  assert.deepEqual([report.status, report.halt.step, report.halt.code], ["HALTED", "P5_POSTCANCEL_READ", "POSTCANCEL_IDENTITY_MISMATCH"]);
  assert.equal(puts(fake.log).length, 1);
});

// ---------- gate / journal / restart ----------
const CREATE = { method: "POST", path: "/reservations", query: {}, body: { listingMapId: 606998, channelId: 2000, currency: "USD" } };
const CANCEL = (id) => ({ method: "PUT", path: `/reservations/${id}/statuses/cancelled`, query: {}, body: { cancelledBy: "host" } });
test("gate (happy budgets): 1 create and 1 cancel per run from the durable journal; cancel only the verified id; protocol steps unknown", async () => {
  let sent = 0;
  const transport = { send: async () => { sent++; return { httpStatus: 500, json: {} }; } };
  const state = () => ({ halted: false, readOnly: false, readableIds: new Set([8000001]), cancellableId: 8000001 });
  const g = (journal, st = state()) => createGate({ transport, journal, timeoutMs: 50, state: st, budgets: HAPPY_STEPS, writeBudget: HAPPY_WRITE_BUDGET });
  const code = async (p) => { try { await p; return "SENT"; } catch (e) { return e.code; } };
  const one = [{ type: "intent", kind: "create" }];
  assert.equal(await code(g({ durable: true, load: () => one, append() {} }).send("HW1_CREATE", CREATE, { writeKind: "create", intent: {} })), "RUN_WRITE_BUDGET_EXHAUSTED");
  assert.equal(await code(g({ durable: true, load: () => [{ type: "intent", kind: "cancel" }], append() {} }).send("HW2_CANCEL", CANCEL(8000001), { writeKind: "cancel", intent: {} })), "RUN_WRITE_BUDGET_EXHAUSTED");
  assert.equal(await code(g({ durable: true, load: () => [], append() {} }).send("HW2_CANCEL", CANCEL(8000002), { writeKind: "cancel", intent: {} })), "CANCEL_TARGET_NOT_VERIFIED");
  assert.equal(await code(g({ durable: true, load: () => [], append() {} }).send("W1_CREATE_R2", CREATE, { writeKind: "create", intent: {} })), "STEP_UNKNOWN");
  assert.equal(await code(g({ durable: true, load: () => [], append() {} }, { ...state(), cancellableId: null }).send("HW2_CANCEL", CANCEL(8000001), { writeKind: "cancel", intent: {} })), "CANCEL_TARGET_NOT_VERIFIED");
  assert.equal(sent, 0);
});

test("execute: if the create intent cannot be journaled, nothing is created", async () => {
  const v = validateHappyManifest(manifest(), { now: NOW });
  const fake = fakeHostaway();
  const entries = [];
  const journal = { durable: true, boundHash: v.hash, load: () => [...entries], append: (e) => { if (e.type === "intent") throw new Error("io"); entries.push(e); } };
  const r = await executeHappyRun({ mode: "execute", manifest: manifest(), confirm: v.confirmToken, transport: fake.transport, journal, sideEffectProbe: SILENT, now: NOW, timeoutMs: 50 });
  assert.equal(r.halt.code, "JOURNAL_WRITE_FAILED");
  assert.equal(writesOf(fake.log).length, 0);
});

test("restart: exclusive journal; a crash after the durable create intent => INDETERMINATE, read-only reconciliation, never a write", async () => {
  const fake = fakeHostaway({ intercept: (req) => (req.method === "POST" && req.path === "/reservations" ? "hang" : undefined) });
  const { dir, v } = await run({ fake });
  assert.throws(() => createFileJournal(dir, v.hash), (e) => e.code === "JOURNAL_EXISTS");
  const path = join(dir, journalFileName(v.hash));
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const cut = lines.findIndex((l) => JSON.parse(l).type === "intent");
  writeFileSync(path, `${lines.slice(0, cut + 1).join("\n")}\n`);
  const later = fakeHostaway();
  const r = await reconcileHappyFromJournal({ entries: readJournalFile(path), manifest: manifest(), transport: later.transport, now: NOW, timeoutMs: 50 });
  assert.deepEqual([r.status, r.writesPermitted, r.indeterminateSteps, r.priorWrites], ["RECONCILED_READ_ONLY", false, ["HW1_CREATE"], { create: 1, cancel: 0 }]);
  assert.ok(later.log.length > 0 && later.log.every((q) => q.method === "GET"));
  const reopened = { durable: true, boundHash: v.hash, load: () => readJournalFile(path), append() { throw new Error("no"); } };
  const again = await executeHappyRun({ mode: "execute", manifest: manifest(), confirm: v.confirmToken, transport: later.transport, journal: reopened,
    sideEffectProbe: SILENT, now: NOW });
  assert.equal(again.status, "REFUSED");
  assert.ok(again.prerequisites.includes("JOURNAL_NOT_EMPTY"));
});

// ---------- containment / CLI ----------
test("containment: no env/fetch/URLs in the happy-path files; nothing deployable imports them; CLI execute not wired", () => {
  for (const f of ["happy-path.mjs", "happy-cli.mjs"]) {
    const src = readFileSync(join(ROOT, "scripts/e4-write-runner", f), "utf8");
    for (const re of [/process\.env/, /\bfetch\s*\(/, /https?:\/\//, /lib\/hostaway\.js/, /child_process/, /\beval\s*\(|new Function/]) assert.doesNotMatch(src, re, `${f} ${re}`);
  }
  const walk = (d, out = []) => {
    for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p, out); else if (/\.(m?js|cjs)$/.test(e.name) && readFileSync(join(ROOT, p), "utf8").includes("happy-path")) out.push(p);
    }
    return out;
  };
  assert.deepEqual([...walk("api"), ...walk("lib"), ...walk("db")], []);
  assert.equal(HAPPY_EXECUTION_WIRED, false);
  const cli = join(ROOT, "scripts/e4-write-runner/happy-cli.mjs");
  const ex = spawnSync(process.execPath, [cli, "--execute", "x"], { encoding: "utf8", env: {}, input: "" });
  assert.deepEqual([ex.status, JSON.parse(ex.stdout).error, JSON.parse(ex.stdout).credentialsRequested], [64, "USAGE", false]); // execute path: see test/e4-happy-execute.test.mjs
  const dr = spawnSync(process.execPath, [cli, "--dry-run", join(ROOT, "scripts/e4-write-runner/happy-manifest.template.json")], { encoding: "utf8", env: {} });
  assert.deepEqual([dr.status, JSON.parse(dr.stdout).network], [1, "none"]);
});
