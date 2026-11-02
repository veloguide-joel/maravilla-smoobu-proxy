// E4 connected runner: READ-ONLY CANCEL verification after a cancel reply whose ONLY difference is an unechoed booking ref
// (feature/e4-connected-runner, after the 2026-11-02 live run 343afa… whose cancel reply halted on bookingRef; offline milestone). Synthetic in-memory world (NOT provider evidence), injected
// transport/journal/operator checkpoint, virtual clock; the global fetch is a throwing spy. Synthetic guest/ids only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

let globalFetchCalls = 0;
globalThis.fetch = () => { globalFetchCalls++; throw new Error("global fetch must not be used"); };
const C = await import("../scripts/e4-connected/connected-path.mjs");
const A = await import("../lib/hostaway-reservations.js");
const R = await import("../scripts/e4-write-runner/runner.mjs");
const X = await import("../scripts/e4-connected/connected-execute.mjs");
const RC = await import("../scripts/e4-connected/connected-recover.mjs");
const { validateConnectedManifest, connectedManifestTemplate, executeConnectedRun, stayNights, CONNECTED_STEPS } = C;

const ROOT = new URL("..", import.meta.url).pathname;
const NOW = () => new Date("2026-11-02T18:00:00.000Z");
const L = 603566;
const SHA = "e".repeat(40);
const GUEST = { firstName: "Synthetic", lastName: "Tester", email: "e4-synthetic@example.invalid" };
const STAY = { arrivalDate: "2027-05-10", departureDate: "2027-05-12" };
const TOTAL = 440000;
const HIST = "6c58baedce5c735c6b9766a328c015d36a5e631dbf5bd69ebf6f7653b65697bf";
const HIST343 = "343afa623817102097eff3d0b5d86fcc174333aeb65037198f0468ccf14baca4";
const manifest = (over = {}) => ({ ...connectedManifestTemplate(), guests: 2, totalMinor: TOTAL, window: { start: "2027-05-01", end: "2027-05-20" },
  stay: { ...STAY }, guest: { ...GUEST }, reviewedCommit: SHA, ...over });
const LEAKS = ["Synthetic", "Tester", "example.invalid", "PROVIDER-TEXT", "MESSAGE-BODY", "98765-603566", "customFieldValues"];
const leakFree = (o) => { const s = JSON.stringify(o); for (const x of LEAKS) assert.ok(!s.includes(x), `leak: ${x}`); };
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------- synthetic world ----------
// over.reply(res) -> the create reply's result object (default: the full reservation); over.read(w, n) -> optional read reply
// for the n-th read by id (1 = first); over.lookup(w, q) -> optional page for every ref lookup AFTER the create.
function world(over = {}) {
  const w = { res: null, log: [], calendar: "available", reads: 0, nextId: over.id ?? 91000001, charges: over.charges ?? (() => []),
    conversations: over.conversations ?? ((id) => [{ id: 7701, reservationId: id, lastMessage: "MESSAGE-BODY" }]) };
  const ok = (result, extra = {}) => ({ httpStatus: 200, json: { status: "success", result: clone(result), ...extra } });
  w.ok = ok;
  w.handle = (method, path, q, body) => {
    w.log.push(`${method} ${path}`);
    if (method === "POST" && path === `/listings/${L}/calendar/priceDetails`) return ok({ totalPrice: 4400 });
    if (method === "GET" && path === "/reservations") {
      if (w.res && over.lookup) return over.lookup(w, q);
      if (w.res && w.res.status === "cancelled" && over.postLookup) return over.postLookup(w, q);
      if (q.afterId !== undefined) return ok([]);
      return ok(w.res && w.res.arrivalDate === q.arrivalStartDate ? [w.res] : []);
    }
    if (method === "POST" && path === "/reservations") {
      w.res = { id: w.nextId, hostawayReservationId: String(w.nextId), listingMapId: body.listingMapId, channelId: body.channelId, reservationId: "98765-603566-2000-1",
        arrivalDate: body.arrivalDate, departureDate: body.departureDate, totalPrice: body.totalPrice, currency: body.currency, status: "new",
        guestName: body.guestName, guestEmail: body.guestEmail, hostNote: "PROVIDER-TEXT", customFieldValues: body.customFieldValues };
      w.ref = body.customFieldValues[0].value;
      w.calendar = "reserved";
      if (over.createRaw) return over.createRaw(w);
      return ok(over.reply ? over.reply(clone(w.res), w) : w.res);
    }
    if (method === "GET" && /^\/reservations\/\d+$/.test(path)) {
      w.reads++;
      if (w.res && w.res.status === "cancelled") w.postReads = (w.postReads ?? 0) + 1;
      const h = over.read?.(w, w.reads) ?? (w.res && w.res.status === "cancelled" ? over.postRead?.(w, w.postReads) : undefined);
      if (h === "hang") return new Promise(() => {});
      if (h) return h;
      return w.res && path === `/reservations/${w.res.id}` ? ok(w.res) : { httpStatus: 404, json: { status: "fail", result: "PROVIDER-TEXT" } };
    }
    if (method === "GET" && path === "/guestPayments/charges") { const c = w.charges(w.res.id); return c === "fail" ? { httpStatus: 500, json: {} } : ok(c, { count: c.length }); }
    if (method === "GET" && path === "/conversations") { const c = w.conversations(w.res.id); return c === "fail" ? { httpStatus: 500, json: {} } : ok(c.slice(Number(q.offset), Number(q.offset) + Number(q.limit))); }
    if (method === "GET" && path === "/tasks") return ok([]);
    if (method === "GET" && path === `/listings/${L}/calendar`) return ok(stayNights(STAY).map((date) => ({ date, status: w.calendar, isAvailable: w.calendar === "available" ? 1 : 0 })));
    if (method === "PUT" && w.res && path === `/reservations/${w.res.id}/statuses/cancelled`) {
      w.res.status = "cancelled"; w.calendar = "available";
      if (over.cancelRaw) return over.cancelRaw(w);
      return ok(over.cancel ? over.cancel(clone(w.res), w) : w.res);
    }
    return { httpStatus: 404, json: { status: "fail", result: "PROVIDER-TEXT" } };
  };
  w.transport = { send: (req) => Promise.resolve(w.handle(req.method, req.path, req.query ?? {}, req.body)).then((r) => (r === "throw" ? Promise.reject(new Error("x")) : r)) };
  return w;
}
const memJournal = (boundHash, { failOn, failLoad } = {}) => {
  const es = [];
  return { durable: true, boundHash, entries: es,
    load: () => { if (failLoad && failLoad(es)) throw new Error("disk"); return es.map((e) => clone(e)); },
    append: (e) => { if (failOn && failOn(e, es)) throw new Error("disk"); es.push(clone(e)); } };
};
const S = { intervalMs: 1000, timeoutMs: 7000000, maxReads: 12, confirmReads: 2 };
function vclock() {
  let t = 0;
  return { clock: () => t, startTimer: (ms) => ms === S.intervalMs ? { promise: Promise.resolve().then(() => { t += ms; }), cancel() {} } : { promise: new Promise(() => {}), cancel() {} } };
}
async function run(w, { journal, m = manifest() } = {}) {
  const v = validateConnectedManifest(m, { now: NOW });
  assert.ok(v.ok, JSON.stringify(v));
  const j = journal ?? memJournal(v.hash);
  const stages = [];
  const r = await executeConnectedRun({ mode: "execute", manifest: m, confirm: v.confirmToken, reviewedCommit: SHA, transport: w.transport, journal: j, now: NOW,
    airbnbCheckpoint: async (x) => { stages.push(x.stage); return w.calendar === "available" ? "open" : "blocked"; }, sync: S, timeoutMs: 50, ...vclock() });
  return { r, j, v, stages };
}
const writes = (w) => w.log.filter((l) => l === "POST /reservations" || l.startsWith("PUT "));
const kvEntries = (j) => j.entries.filter((e) => e.step === "KV1_READ_VERIFY" || e.step === "KV2_LOOKUP_VERIFY");
const noRef = (res) => { delete res.customFieldValues; return res; };
const createdOk = (r) => {
  assert.equal(r.status, "COMPLETED", JSON.stringify(r.halt)); assert.equal(r.passed, true);
  assert.deepEqual(r.writes, { create: 1, cancel: 1 });
};
// every journal entry is exactly what the reviewed sanitizer keeps; no raw provider value anywhere
const journalSafe = (j) => { for (const e of j.entries) assert.equal(JSON.stringify(R.sanitizeJournalEntry(e, { steps: CONNECTED_STEPS })), JSON.stringify(e)); leakFree(j.entries); };


const kcEntries = (j) => j.entries.filter((e) => e.step === "KC1_CANCEL_VERIFY" || e.step === "KC2_CANCEL_LOOKUP_VERIFY");
const H343 = "343afa623817102097eff3d0b5d86fcc174333aeb65037198f0468ccf14baca4";
const canon = (x) => (Array.isArray(x) ? `[${x.map(canon).join(",")}]` : x && typeof x === "object" ? `{${Object.keys(x).sort().map((k) => `${k}:${canon(x[k])}`).join(",")}}` : JSON.stringify(x));
const NOTV = { path: "NONE", result: "NOT_VERIFIED", refEcho: null, readVerify: null, lookupVerify: null };

// ---------- 1. the strict full cancel-reply path is unchanged ----------
test("strict cancel path unchanged: a full cancel reply is REPLY_VERIFIED; no KC entry; no extra lookup after the cancel", async () => {
  const w = world();
  const { r, j } = await run(w);
  assert.equal(r.status, "COMPLETED"); assert.equal(r.passed, true); assert.deepEqual(r.writes, { create: 1, cancel: 1 });
  assert.deepEqual(r.cancelVerification, { path: "REPLY", result: "REPLY_VERIFIED", refEcho: null, readVerify: null, lookupVerify: null });
  assert.equal(r.commandReply.code, "VERIFIED_CANCELLED"); assert.equal(kcEntries(j).length, 0);
  const put = w.log.findIndex((l) => l.startsWith("PUT "));
  assert.deepEqual(w.log.slice(put + 1, put + 3), [`GET /reservations/${w.res.id}`, "GET /guestPayments/charges"]);   // K8 then K9: no lookup
  assert.deepEqual(X.cancelVerificationSummary(r.cancelVerification), r.cancelVerification);
  journalSafe(j); leakFree(r);
});

// ---------- 2. allowed absent shapes: READ_VERIFIED by K8 + KC2; the original reply mismatch is preserved ----------
const ABSENT = [
  ["ABSENT_UNDEFINED", noRef], ["ABSENT_NULL", (x) => ({ ...x, customFieldValues: null })], ["ABSENT_EMPTY_ARRAY", (x) => ({ ...x, customFieldValues: [] })],
  ["ABSENT_NO_OWN_ENTRY", (x) => ({ ...x, customFieldValues: [{ customFieldId: 999, value: "PROVIDER-TEXT", customField: { id: 999 } }] })]
];
test("allowed absent cancel-reply shapes: K8 fresh read + unique same-id KC2 lookup -> READ_VERIFIED, COMPLETED/passed; one PUT; original mismatch kept", async () => {
  for (const [shape, cancel] of ABSENT) {
    const w = world({ cancel });
    const { r, j } = await run(w);
    assert.equal(r.status, "COMPLETED", `${shape} ${JSON.stringify(r.halt)}`); assert.equal(r.passed, true, shape);
    assert.deepEqual(r.writes, { create: 1, cancel: 1 }); assert.deepEqual(writes(w).length, 2);
    assert.deepEqual(r.cancelVerification, { path: "READ_FALLBACK", result: "READ_VERIFIED", refEcho: shape, readVerify: "VERIFY_CANCEL_READ_IDENTITY_OK",
      lookupVerify: "VERIFY_CANCEL_LOOKUP_SAME_ID_IDENTITY_OK" }, shape);
    assert.deepEqual(r.commandReply, { code: "CANCEL_RESPONSE_MISMATCH", httpStatus: 200, mismatches: ["bookingRef"] });     // never erased
    assert.deepEqual(r.finalState, { code: "IDENTITY_OK", status: "cancelled", identityOk: true });
    const xo = j.entries.findIndex((e) => e.type === "outcome" && e.kind === "cancel");
    assert.deepEqual(j.entries.slice(xo, xo + 4).map((e) => `${e.step}:${e.code}`), ["KW2_CANCEL:CANCEL_RESPONSE_MISMATCH", `KC1_CANCEL_VERIFY:CANCEL_REF_NOT_ECHOED:${shape}`,
      "K8_POSTCANCEL:IDENTITY_OK", "KC2_CANCEL_LOOKUP_VERIFY:VERIFY_CANCEL_LOOKUP_SAME_ID_IDENTITY_OK"]);
    assert.ok(r.steps.some((s) => s.code === "VERIFIED_CANCELLED_BY_READ"));
    const c = RC.classifyConnectedJournal(j.entries, validateConnectedManifest(manifest(), { now: NOW }).hash);
    assert.equal(c.clean, true, String(c.conflicts)); assert.equal(c.state, "CANCEL_VERIFIED"); assert.equal(c.cancelVerification.result, "READ_VERIFIED");
    assert.deepEqual(c.cancelOutcome, { code: "CANCEL_RESPONSE_MISMATCH", httpStatus: 200, mismatches: ["bookingRef"] });
    journalSafe(j); leakFree(r); leakFree(X.summarizeConnected(r));
  }
});

// ---------- 3. refusal shapes: halt at KW2 exactly as before (read-only post-checks still run; never a second PUT) ----------
const REFUSE = [
  ["explicit wrong ref", (x) => ({ ...x, customFieldValues: [{ customFieldId: 105433, value: "MV-ZZZZZZ99" }] }), "CANCEL_RESPONSE_MISMATCH", null],
  ["explicit empty ref", (x) => ({ ...x, customFieldValues: [{ customFieldId: 105433, value: "" }] }), "CANCEL_RESPONSE_MISMATCH", null],
  ["non-string ref", (x) => ({ ...x, customFieldValues: [{ customFieldId: 105433, value: 7 }] }), "CANCEL_REF_VALUE_INVALID", null],
  ["duplicate own entries", (x, w) => ({ ...x, customFieldValues: [{ customFieldId: 105433, value: w.ref }, { customFieldId: 105433, value: w.ref }] }), "CANCEL_REF_FIELD_DUPLICATED", null],
  ["list is a string", (x) => ({ ...x, customFieldValues: "PROVIDER-TEXT" }), "CANCEL_CUSTOM_FIELDS_MALFORMED", null],
  ["string customFieldId", (x, w) => ({ ...x, customFieldValues: [{ customFieldId: "105433", value: w.ref }] }), "CANCEL_RESPONSE_MISMATCH", "MALFORMED"],
  ["item keyed by id", (x, w) => ({ ...x, customFieldValues: [{ id: 105433, value: w.ref }] }), "CANCEL_RESPONSE_MISMATCH", "MALFORMED"],
  ["null item", (x) => ({ ...x, customFieldValues: [null] }), "CANCEL_RESPONSE_MISMATCH", "MALFORMED"],
  ["absent ref + status modified", (x) => noRef({ ...x, status: "modified" }), "CANCEL_RESPONSE_MISMATCH", null],
  ["absent ref + status new", (x) => noRef({ ...x, status: "new" }), "CANCEL_RESPONSE_MISMATCH", null],
  ["absent ref + other total", (x) => noRef({ ...x, totalPrice: 4401 }), "CANCEL_RESPONSE_MISMATCH", null],
  ["absent ref + other dates", (x) => noRef({ ...x, departureDate: "2027-05-13" }), "CANCEL_RESPONSE_MISMATCH", null],
  ["absent ref + other id", (x) => noRef({ ...x, id: 91000077, hostawayReservationId: "91000077" }), "CANCEL_RESPONSE_MISMATCH", null],
  ["absent ref + currency", (x) => noRef({ ...x, currency: "USD" }), "CANCEL_RESPONSE_MISMATCH", null]
];
test("refusal shapes: never coerced -> HALTED at KW2 as before, no KC entry or extra lookup, NOT_VERIFIED, one PUT only", async () => {
  for (const [name, cancel, code, refEcho] of REFUSE) {
    const w = world({ cancel });
    const { r, j } = await run(w);
    assert.deepEqual([r.status, r.halt.step, r.halt.code, r.passed], ["HALTED", "KW2_CANCEL", code, false], name);
    assert.deepEqual(r.cancelVerification, { ...NOTV, refEcho }, name);
    assert.equal(kcEntries(j).length, 0, name); assert.equal(writes(w).length, 2, name);
    assert.ok(w.log.slice(w.log.findIndex((l) => l.startsWith("PUT ")) + 1).every((l) => l.startsWith("GET ")), name);
    journalSafe(j); leakFree(r);
  }
  for (const raw of [() => "throw", () => ({ httpStatus: 500, json: {} }), () => ({ httpStatus: 302, json: {} }), () => ({ httpStatus: 200, json: { status: "fail", result: "PROVIDER-TEXT" } })]) {
    const w = world({ cancelRaw: raw });
    const { r, j } = await run(w);
    assert.deepEqual([r.status, r.halt.step, r.passed], ["HALTED", "KW2_CANCEL", false]); assert.equal(kcEntries(j).length, 0); assert.equal(writes(w).length, 2);
    assert.equal(r.cancelVerification.result, "NOT_VERIFIED");
  }
});

// ---------- 4. K8 proof failures ----------
test("K8 fresh-read failures after an eligible reply: halt at K8, no KC2 lookup, NOT_VERIFIED, passed false", async () => {
  const mut = (f) => (w, n) => (n === 1 ? w.ok(f(clone(w.res), w)) : undefined);
  for (const [name, postRead] of [["status new", mut((x) => ({ ...x, status: "new" }))], ["status modified", mut((x) => ({ ...x, status: "modified" }))],
    ["ref absent on read", mut(noRef)], ["wrong ref", mut((x) => ({ ...x, customFieldValues: [{ customFieldId: 105433, value: "MV-ZZZZZZ99" }] }))],
    ["total", mut((x) => ({ ...x, totalPrice: 4401 }))], ["other id", mut((x) => ({ ...x, id: 91000077, hostawayReservationId: "91000077" }))],
    ["500", (w, n) => (n === 1 ? { httpStatus: 500, json: {} } : undefined)], ["transport", (w, n) => (n === 1 ? "throw" : undefined)], ["timeout", (w, n) => (n === 1 ? "hang" : undefined)]]) {
    const w = world({ cancel: noRef, postRead });
    const { r, j } = await run(w);
    assert.equal(r.halt.step, "K8_POSTCANCEL", name); assert.equal(r.passed, false, name);
    assert.equal(r.cancelVerification.path, "READ_FALLBACK", name); assert.equal(r.cancelVerification.result, "NOT_VERIFIED", name);
    assert.equal(r.cancelVerification.readVerify, "VERIFY_CANCEL_READ_NOT_CONFIRMED", name); assert.equal(r.cancelVerification.lookupVerify, null, name);
    assert.ok(!j.entries.some((e) => e.step === "KC2_CANCEL_LOOKUP_VERIFY"), name); assert.equal(writes(w).length, 2, name);
    const c = RC.classifyConnectedJournal(j.entries, validateConnectedManifest(manifest(), { now: NOW }).hash);
    assert.equal(c.state, "CANCEL_NOT_VERIFIED", name); assert.equal(c.cancelVerification.result, "NOT_VERIFIED", name);
    journalSafe(j); leakFree(r);
  }
});

// ---------- 5. KC2 proof failures ----------
test("KC2 lookup failures: halt at KC2, NOT_VERIFIED, passed false; protected ids never echoed or read", async () => {
  const item = (w, o = {}) => ({ ...clone(w.res), ...o });
  const page = (items) => (w, q) => (q.afterId !== undefined ? w.ok([]) : w.ok(items(w)));
  for (const [name, postLookup, code] of [
    ["not found", page(() => []), "VERIFY_CANCEL_LOOKUP_NOT_CONFIRMED:NOT_FOUND_NON_AUTHORITATIVE"],
    ["duplicate", page((w) => [item(w), item(w, { id: 91000078, hostawayReservationId: "91000078" })]), "VERIFY_CANCEL_LOOKUP_NOT_CONFIRMED:DUPLICATE_REF"],
    ["other id", page((w) => [item(w, { id: 91000078, hostawayReservationId: "91000078" })]), "VERIFY_CANCEL_LOOKUP_ID_DIFFERS"],
    ["protected 71072615", page((w) => [item(w, { id: 71072615, hostawayReservationId: "71072615" })]), "VERIFY_CANCEL_LOOKUP_PROTECTED_ID"],
    ["status new", page((w) => [item(w, { status: "new" })]), "VERIFY_CANCEL_LOOKUP_IDENTITY_MISMATCH"],
    ["total", page((w) => [item(w, { totalPrice: 4401 })]), "VERIFY_CANCEL_LOOKUP_IDENTITY_MISMATCH"],
    ["500", () => ({ httpStatus: 500, json: {} }), "VERIFY_CANCEL_LOOKUP_NOT_CONFIRMED:HTTP_NOT_OK"],
    ["transport", () => "throw", "VERIFY_CANCEL_LOOKUP_NOT_CONFIRMED:TRANSPORT_UNCERTAIN"],
    ["page cap", (w, q) => w.ok([item(w, { id: 92000000 + Number(q.afterId ?? 0) % 1000 + 1, hostawayReservationId: undefined, customFieldValues: [{ customFieldId: 105433, value: "MV-OTHER999" }] })]),
      "VERIFY_CANCEL_LOOKUP_NOT_CONFIRMED:PAGE_CAP_REACHED"]]) {
    const w = world({ cancel: noRef, postLookup });
    const { r, j } = await run(w);
    assert.deepEqual([r.halt.step, r.halt.code], ["KC2_CANCEL_LOOKUP_VERIFY", code], name);
    assert.equal(r.cancelVerification.result, "NOT_VERIFIED", name); assert.equal(r.cancelVerification.lookupVerify, code, name);
    assert.ok(C.CONNECTED_CANCEL_LOOKUP_CODES.includes(code)); assert.equal(r.passed, false); assert.equal(writes(w).length, 2);
    assert.ok(!w.log.some((l) => /\/reservations\/(70636076|71045356|71072615)/.test(l)), name);
    assert.ok(!j.entries.some((e) => [70636076, 71045356, 71072615].includes(e.reservationId)), name);
    const c = RC.classifyConnectedJournal(j.entries, validateConnectedManifest(manifest(), { now: NOW }).hash);
    assert.equal(c.state, "CANCEL_NOT_VERIFIED", name); assert.notEqual(c.cancelVerification.result, "READ_VERIFIED", name);
    journalSafe(j); leakFree(r);
  }
});

// ---------- 6. journal failures, evidence failures, later side effects ----------
test("journal failures on the cancel fallback never yield READ_VERIFIED; evidence/side-effect failures keep passed false even when READ_VERIFIED", async () => {
  const v = validateConnectedManifest(manifest(), { now: NOW });
  for (const [failOn, step] of [[(e) => e.step === "KC1_CANCEL_VERIFY", "KC1_CANCEL_VERIFY"], [(e) => e.step === "K8_POSTCANCEL" && e.type === "read", "K8_POSTCANCEL"],
    [(e) => e.step === "KC2_CANCEL_LOOKUP_VERIFY" && e.type === "read", "KC2_CANCEL_LOOKUP_VERIFY"]]) {
    const w = world({ cancel: noRef });
    const { r } = await run(w, { journal: memJournal(v.hash, { failOn }) });
    assert.equal(r.status, "HALTED", step); assert.equal(r.journalDurable, false); assert.equal(r.halt.code, "JOURNAL_WRITE_FAILED", step);
    assert.equal(r.cancelVerification.result, "NOT_VERIFIED", step); assert.equal(r.passed, false); assert.equal(writes(w).length, 2);
  }
  // K9 conversation change after cancel: READ_VERIFIED but not passed
  let wref = null;
  const w = world({ cancel: noRef, conversations: (id) => (wref.res.status === "cancelled" ? [{ id: 7701, reservationId: id }, { id: 7702, reservationId: id }] : [{ id: 7701, reservationId: id }]) });
  wref = w;
  const { r } = await run(w);
  assert.equal(r.cancelVerification.result, "READ_VERIFIED"); assert.equal(r.sideEffectsCancel.ok, false); assert.equal(r.passed, false);
});

// ---------- 7. recovery classification: bound KC sequence, prefixes, conflicts; 343 compatibility ----------
test("recovery: KC entries bound to the cancel outcome/id/ref/order; prefixes clean but NOT_VERIFIED; contradictions are conflicts; the 343 shape stays CANCEL_NOT_VERIFIED", () => {
  const v = validateConnectedManifest(manifest(), { now: NOW }); const H = v.hash; const REF = "MV-ABCDEF12";
  const start = { type: "run-start", runId: "a".repeat(16), manifestHash: H, refs: ["MV-PROBE001", REF] };
  const ci = { type: "intent", step: "KW1_CREATE", kind: "create", ref: REF };
  const co = { type: "outcome", step: "KW1_CREATE", kind: "create", ref: REF, code: "VERIFIED_CREATED", evidence: { outcome: "created", code: "VERIFIED_CREATED", httpStatus: 201, reservationId: 5 } };
  const xi = { type: "intent", step: "KW2_CANCEL", kind: "cancel", reservationId: 5, ref: REF };
  const xo = (o = {}) => ({ type: "outcome", step: "KW2_CANCEL", kind: "cancel", reservationId: 5, code: "CANCEL_RESPONSE_MISMATCH", mismatches: ["bookingRef"], httpStatus: 200, ...o });
  const mk = (o = {}) => ({ type: "read", step: "KC1_CANCEL_VERIFY", kind: "read", code: "CANCEL_REF_NOT_ECHOED:ABSENT_EMPTY_ARRAY", reservationId: 5, ...o });
  const k8 = (o = {}) => ({ type: "read", step: "K8_POSTCANCEL", kind: "read", code: "IDENTITY_OK", reservationId: 5, httpStatus: 200, ...o });
  const lk = (o = {}) => ({ type: "read", step: "KC2_CANCEL_LOOKUP_VERIFY", kind: "lookup", code: "VERIFY_CANCEL_LOOKUP_SAME_ID_IDENTITY_OK", ref: REF, reservationId: 5, ...o });
  const hl = (step, code) => ({ type: "halt", step, code });
  const se = { type: "side-effect-check", step: "K9_SIDE_EFFECTS_CANCEL", code: "SIDE_EFFECTS_OK" };
  const K = (es, h = H) => RC.classifyConnectedJournal(es.map((e) => JSON.parse(JSON.stringify(e))), h);
  const RV = "VERIFY_CANCEL_READ_IDENTITY_OK", LV = "VERIFY_CANCEL_LOOKUP_SAME_ID_IDENTITY_OK", MK = "CANCEL_REF_NOT_ECHOED:ABSENT_EMPTY_ARRAY";
  for (const [es, state, want] of [
    [[start, ci, co, xi, xo()], "CANCEL_NOT_VERIFIED", { path: "NONE", result: "NOT_VERIFIED", refEcho: null, readVerify: null, lookupVerify: null }],
    [[start, ci, co, xi, xo(), k8(), hl("KW2_CANCEL", "CANCEL_RESPONSE_MISMATCH")], "CANCEL_NOT_VERIFIED", { path: "NONE", result: "NOT_VERIFIED", refEcho: null, readVerify: null, lookupVerify: null }],
    [[start, ci, co, xi, xo(), mk()], "CANCEL_NOT_VERIFIED", { path: "READ_FALLBACK", result: "NOT_VERIFIED", refEcho: MK, readVerify: null, lookupVerify: null }],
    [[start, ci, co, xi, xo(), mk(), k8()], "CANCEL_NOT_VERIFIED", { path: "READ_FALLBACK", result: "NOT_VERIFIED", refEcho: MK, readVerify: RV, lookupVerify: null }],
    [[start, ci, co, xi, xo(), mk(), k8({ code: "POSTCANCEL_IDENTITY_MISMATCH", mismatches: ["status"] }), hl("K8_POSTCANCEL", "POSTCANCEL_IDENTITY_MISMATCH")], "CANCEL_NOT_VERIFIED",
      { path: "READ_FALLBACK", result: "NOT_VERIFIED", refEcho: MK, readVerify: "VERIFY_CANCEL_READ_NOT_CONFIRMED", lookupVerify: null }],
    [[start, ci, co, xi, xo(), mk(), k8(), lk({ code: "VERIFY_CANCEL_LOOKUP_NOT_CONFIRMED:NOT_FOUND_NON_AUTHORITATIVE", reservationId: undefined }), hl("KC2_CANCEL_LOOKUP_VERIFY", "X")], "CANCEL_NOT_VERIFIED",
      { path: "READ_FALLBACK", result: "NOT_VERIFIED", refEcho: MK, readVerify: RV, lookupVerify: "VERIFY_CANCEL_LOOKUP_NOT_CONFIRMED:NOT_FOUND_NON_AUTHORITATIVE" }],
    [[start, ci, co, xi, xo(), mk(), k8(), lk()], "CANCEL_VERIFIED", { path: "READ_FALLBACK", result: "READ_VERIFIED", refEcho: MK, readVerify: RV, lookupVerify: LV }],
    [[start, ci, co, xi, xo({ httpStatus: 204 }), mk(), k8({ httpStatus: 203 }), lk(), se, { type: "run-end", code: "COMPLETED" }], "CANCEL_VERIFIED", { path: "READ_FALLBACK", result: "READ_VERIFIED", refEcho: MK, readVerify: RV, lookupVerify: LV }],
    [[start, ci, co, xi, xo({ code: "VERIFIED_CANCELLED", mismatches: undefined }), k8()], "CANCEL_VERIFIED", { path: "REPLY", result: "REPLY_VERIFIED", refEcho: null, readVerify: null, lookupVerify: null }]
  ]) {
    const c = K(es);
    assert.equal(c.ok, true, JSON.stringify(c)); assert.equal(c.clean, true, `${state} ${c.conflicts}`); assert.equal(c.state, state); assert.deepEqual(c.cancelVerification, want);
  }
  for (const [es, want] of [
    [[start, ci, co, xi, xo(), k8(), mk(), lk()], "CANCEL_VERIFICATION_OUT_OF_ORDER"],
    [[start, ci, co, xi, xo(), mk(), lk(), k8()], "CANCEL_VERIFICATION_OUT_OF_ORDER"],
    [[start, ci, co, xi, xo(), lk(), k8(), mk()], "CANCEL_VERIFICATION_OUT_OF_ORDER"],
    [[start, ci, co, xi, xo(), se, mk(), k8(), lk()], "CANCEL_VERIFICATION_OUT_OF_ORDER"],
    [[start, ci, co, mk(), xi, xo(), k8(), lk()], "CANCEL_VERIFICATION_BEFORE_CANCEL_OUTCOME"],
    [[start, ci, co, xi, mk(), k8(), lk()], "CANCEL_VERIFICATION_BEFORE_CANCEL_OUTCOME"],
    [[start, ci, co, xi, xo({ mismatches: ["totalMinor"] }), mk(), k8(), lk()], "CANCEL_VERIFICATION_WITHOUT_UNECHOED_REF"],
    [[start, ci, co, xi, xo({ mismatches: ["bookingRef", "status"] }), mk(), k8(), lk()], "CANCEL_VERIFICATION_WITHOUT_UNECHOED_REF"],
    [[start, ci, co, xi, xo({ httpStatus: 302 }), mk(), k8(), lk()], "CANCEL_VERIFICATION_WITHOUT_UNECHOED_REF"],
    [[start, ci, co, xi, xo({ httpStatus: undefined }), mk(), k8(), lk()], "CANCEL_VERIFICATION_WITHOUT_UNECHOED_REF"],
    [[start, ci, co, xi, xo({ transport: "TIMEOUT" }), mk(), k8(), lk()], "CANCEL_VERIFICATION_WITHOUT_UNECHOED_REF"],
    [[start, ci, co, xi, xo({ code: "VERIFIED_CANCELLED", mismatches: undefined }), mk(), k8(), lk()], "CANCEL_VERIFICATION_WITHOUT_UNECHOED_REF"],
    [[start, ci, co, xi, xo(), mk({ reservationId: undefined }), k8(), lk()], "CANCEL_VERIFICATION_ID_NOT_BOUND"],
    [[start, ci, co, xi, xo(), mk(), k8(), lk({ reservationId: 6 })], "CANCEL_VERIFICATION_ID_NOT_BOUND"],
    [[start, ci, co, xi, xo(), mk(), k8(), lk({ reservationId: undefined })], "CANCEL_VERIFICATION_CONTRADICTORY"],
    [[start, ci, co, xi, xo(), mk(), k8(), lk({ ref: "MV-ZZZZZZ99" })], "CANCEL_VERIFICATION_REF_NOT_BOUND"],
    [[start, ci, co, xi, xo(), mk(), k8(), lk({ ref: undefined })], "CANCEL_VERIFICATION_REF_NOT_BOUND"],
    [[start, ci, co, xi, xo(), mk(), k8(), lk(), lk()], "CANCEL_VERIFICATION_DUPLICATED"],
    [[start, ci, co, xi, xo(), mk(), hl("KC1_CANCEL_VERIFY", "X"), k8(), lk()], "CANCEL_VERIFICATION_AFTER_HALT"],
    [[start, ci, co, xi, xo(), mk(), k8({ code: "POSTCANCEL_IDENTITY_MISMATCH", mismatches: ["status"] }), lk()], "CANCEL_VERIFICATION_CONTRADICTORY"],
    [[start, ci, co, xi, xo(), mk(), k8({ httpStatus: 500 }), lk()], "CANCEL_VERIFICATION_CONTRADICTORY"],
    [[start, ci, co, xi, xo(), mk(), k8({ transport: "TIMEOUT" }), lk()], "CANCEL_VERIFICATION_CONTRADICTORY"],
    [[start, ci, co, xi, xo(), mk({ httpStatus: 200 }), k8(), lk()], "CANCEL_VERIFICATION_CONTRADICTORY"],
    [[start, ci, co, xi, xo(), mk(), k8(), lk({ mismatches: ["status"] })], "CANCEL_VERIFICATION_CONTRADICTORY"],
    [[start, ci, co, xi, xo(), mk(), k8(), lk({ code: "VERIFY_CANCEL_LOOKUP_IDENTITY_MISMATCH" })], "CANCEL_VERIFICATION_CONTRADICTORY"],
    [[start, ci, co, xi, xo(), mk({ code: "CANCEL_REF_NOT_ECHOED:MALFORMED" }), k8(), lk()], "CANCEL_VERIFICATION_CODE_UNKNOWN"],
    [[start, ci, co, xi, xo(), mk(), k8(), lk({ code: "VERIFY_CANCEL_LOOKUP_SOMETHING" })], "CANCEL_VERIFICATION_CODE_UNKNOWN"],
    [[start, ci, co, xi, xo(), mk({ code: "VERIFY_CANCEL_LOOKUP_SAME_ID_IDENTITY_OK" }), k8(), lk()], "CANCEL_VERIFICATION_OUT_OF_ORDER"],
    [[start, ci, co, xi, xo(), mk(), k8(), lk({ reservationId: 71072615 })], "PROTECTED_ID_IN_JOURNAL"],
    [[start, ci, { ...co, code: "RESERVATION_MISMATCH", evidence: { outcome: "conflict", code: "RESERVATION_MISMATCH", httpStatus: 200, mismatches: ["bookingRef"], reservationId: 5 } }, xi, xo(), mk(), k8(), lk()],
      "CANCEL_WITHOUT_VERIFIED_CREATE"]
  ]) {
    const c = K(es);
    assert.equal(c.ok, true, want); assert.equal(c.clean, false, want); assert.ok(c.conflicts.includes(want), `${want} in ${c.conflicts}`);
    assert.notEqual(c.cancelVerification.result, "READ_VERIFIED", want);
    for (const e of es) assert.equal(canon(R.sanitizeJournalEntry(JSON.parse(JSON.stringify(e)), { steps: CONNECTED_STEPS })), canon(JSON.parse(JSON.stringify(e))), `fixture ${want}`);
  }
  assert.equal(K([start, ci, co, xi, xo(), { ...mk(), type: "outcome", kind: "cancel" }]).ok, false);
  assert.equal(K([start, ci, co, xi, xo(), { ...mk(), value: REF }]).code, "JOURNAL_ENTRY_NOT_SANITIZED");
});

test("71072615: protected for NEW execution (gate + launcher guard); the read-only recovery exception applies ONLY to the 343 run's own journal", async () => {
  const st = { readableIds: new Set([71072615]), cancellableId: 71072615, bound: { priceBody: {}, createBody: {}, arrivalDate: STAY.arrivalDate } };
  for (const [req, wk] of [[{ method: "GET", path: "/reservations/71072615", query: { includeResources: 1 } }], [{ method: "PUT", path: "/reservations/71072615/statuses/cancelled", query: {}, body: { cancelledBy: "host" } }, "cancel"],
    [{ method: "GET", path: "/tasks", query: { reservationId: 71072615, limit: 100, offset: 0 } }]]) assert.throws(() => C.assertConnectedRequest(req, st, wk), /PROTECTED_RESERVATION|Runner/);
  const g = X.guardConnectedFetch(async () => new Response("{}"), { calendar: { startDate: "2027-05-10", endDate: "2027-05-11" }, arrivalDate: STAY.arrivalDate, departureDate: STAY.departureDate });
  await assert.rejects(g.guarded("https://api.hostaway.com/v1/reservations/71072615?includeResources=1"));
  assert.equal(RC.recoveryProtection(H343)(71072615), false); assert.equal(RC.recoveryProtection(H343)(71045356), true);
  assert.equal(RC.recoveryProtection("6c58baedce5c735c6b9766a328c015d36a5e631dbf5bd69ebf6f7653b65697bf")(71072615), true);
  assert.equal(RC.recoveryProtection("f".repeat(64))(71072615), true);
  // the historical 343 journal shape: create READ_VERIFIED, cancel reply mismatch on bookingRef, no KC (produced before this code) -> CANCEL_NOT_VERIFIED, clean
  const REF = "MV-2SSG6KHB";
  const hist = [{ type: "run-start", runId: "b".repeat(16), manifestHash: H343, refs: ["MV-PROBE001", REF] }, { type: "intent", step: "KW1_CREATE", kind: "create", ref: REF },
    { type: "outcome", step: "KW1_CREATE", kind: "create", ref: REF, code: "RESERVATION_MISMATCH", evidence: { outcome: "conflict", code: "RESERVATION_MISMATCH", httpStatus: 200, mismatches: ["bookingRef"], reservationId: 71072615 } },
    { type: "read", step: "KV1_READ_VERIFY", kind: "read", code: "CREATE_REF_NOT_ECHOED:ABSENT_EMPTY_ARRAY", reservationId: 71072615 },
    { type: "read", step: "KV1_READ_VERIFY", kind: "read", code: "VERIFY_READ_IDENTITY_OK", reservationId: 71072615, httpStatus: 200 },
    { type: "read", step: "KV2_LOOKUP_VERIFY", kind: "lookup", code: "VERIFY_LOOKUP_SAME_ID_IDENTITY_OK", ref: REF, reservationId: 71072615 },
    { type: "intent", step: "KW2_CANCEL", kind: "cancel", reservationId: 71072615, ref: REF },
    { type: "outcome", step: "KW2_CANCEL", kind: "cancel", reservationId: 71072615, code: "CANCEL_RESPONSE_MISMATCH", mismatches: ["bookingRef"], httpStatus: 200 },
    { type: "halt", step: "KW2_CANCEL", code: "CANCEL_RESPONSE_MISMATCH", mismatches: ["bookingRef"] },
    { type: "read", step: "K8_POSTCANCEL", kind: "read", code: "IDENTITY_OK", reservationId: 71072615, httpStatus: 200 }, { type: "run-end", code: "HALTED" }];
  const c = RC.classifyConnectedJournal(hist, H343);
  assert.equal(c.ok, true); assert.equal(c.clean, true, String(c.conflicts)); assert.equal(c.state, "CANCEL_NOT_VERIFIED"); assert.equal(c.reservationId, 71072615);
  assert.equal(c.createVerification.result, "READ_VERIFIED"); assert.equal(c.cancelVerification.result, "NOT_VERIFIED");     // never retroactively passed
  const other = hist.map((e, i) => (i === 0 ? { ...e, manifestHash: "f".repeat(64) } : e));
  const co2 = RC.classifyConnectedJournal(other, "f".repeat(64));
  assert.equal(co2.clean, false); assert.ok(co2.conflicts.includes("PROTECTED_ID_IN_JOURNAL")); assert.equal(co2.reservationId, null);
  assert.deepEqual(C.CONNECTED_PROTECTED_RESERVATION_IDS, [70636076, 71045356, 71072615]);
});

test("launcher cancelVerification summary is an explicit allowlist; budgets and steps", () => {
  const S0 = X.cancelVerificationSummary;
  assert.deepEqual(S0(undefined), NOTV);
  assert.deepEqual(S0({ path: "x", result: "PASSED", refEcho: "MV-ABCDEF12", readVerify: "IDENTITY_OK", lookupVerify: "FOUND_BY_REF" }),
    { path: "OTHER", result: "OTHER", refEcho: "OTHER", readVerify: "OTHER", lookupVerify: "OTHER" });
  assert.deepEqual(C.CONNECTED_WRITE_BUDGET, { create: 1, cancel: 1 });
  assert.deepEqual(CONNECTED_STEPS.KC1_CANCEL_VERIFY, { reads: 0, writes: 0 }); assert.deepEqual(CONNECTED_STEPS.KC2_CANCEL_LOOKUP_VERIFY, { reads: A.LOOKUP_MAX_PAGES, writes: 0 });
  const k = Object.keys(CONNECTED_STEPS);
  assert.ok(k.indexOf("KW2_CANCEL") < k.indexOf("KC1_CANCEL_VERIFY") && k.indexOf("KC1_CANCEL_VERIFY") < k.indexOf("K8_POSTCANCEL") && k.indexOf("K8_POSTCANCEL") < k.indexOf("KC2_CANCEL_LOOKUP_VERIFY"));
  assert.equal(globalFetchCalls, 0);
});
