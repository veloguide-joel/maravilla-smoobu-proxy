// E4 connected runner: READ-ONLY create verification after a create reply whose ONLY difference is an unechoed booking ref
// (feature/e4-connected-runner, 2026-11-02, offline milestone). Synthetic in-memory world (NOT provider evidence), injected
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
      const h = over.read?.(w, w.reads);
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
      return ok(w.res);
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

// ---------- 1. the strict full-reply path is unchanged ----------
test("strict path unchanged: a full create reply is REPLY_VERIFIED; no KV read, no KV journal entry, same request sequence as before", async () => {
  const w = world();
  const { r, j } = await run(w);
  createdOk(r);
  assert.deepEqual(r.createVerification, { path: "REPLY", result: "REPLY_VERIFIED", refEcho: null, refusal: null, readVerify: null, lookupVerify: null });
  assert.equal(kvEntries(j).length, 0);
  assert.equal(r.steps.find((s) => s.step === "KW1_CREATE").code, "VERIFIED_CREATED");
  const created = w.log.indexOf("POST /reservations");
  assert.equal(w.log[created + 1], "GET /guestPayments/charges");               // K3 follows KW1 directly: no extra read
  assert.equal(w.log.filter((l) => /^GET \/reservations\/\d+$/.test(l)).length, 3);  // K4, K7, K8 only
  journalSafe(j); leakFree(r);
});

// ---------- 2. every allowed ABSENT shape: read-verified, then the unchanged later checks and the one cancel ----------
const ABSENT = [
  ["ABSENT_UNDEFINED", noRef],
  ["ABSENT_NULL", (x) => ({ ...x, customFieldValues: null })],
  ["ABSENT_EMPTY_ARRAY", (x) => ({ ...x, customFieldValues: [] })],
  ["ABSENT_NO_OWN_ENTRY", (x) => ({ ...x, customFieldValues: [{ customFieldId: 999, value: "PROVIDER-TEXT" }] })],
  ["ABSENT_NO_OWN_ENTRY", (x) => ({ ...x, customFieldValues: [{ id: 5551, customFieldId: 999, value: "PROVIDER-TEXT", customField: { id: 999, name: "PROVIDER-TEXT" } },
    { customFieldId: 1000, value: "" }] })]
];
test("allowed absent shapes: fresh read by id + unique same-id ref lookup -> READ_VERIFIED; K3..K10 and the one cancel exactly as before", async () => {
  for (const [shape, reply] of ABSENT) {
    const w = world({ reply });
    const { r, j, stages } = await run(w);
    createdOk(r);
    assert.deepEqual(r.createVerification, { path: "READ_FALLBACK", result: "READ_VERIFIED", refEcho: shape, refusal: null,
      readVerify: "VERIFY_READ_IDENTITY_OK", lookupVerify: "VERIFY_LOOKUP_SAME_ID_IDENTITY_OK" }, shape);
    assert.deepEqual(r.steps.filter((s) => s.step.startsWith("KW1") || s.step.startsWith("KV")).map((s) => s.code),
      [`CREATE_REF_NOT_ECHOED:${shape}`, "VERIFY_READ_IDENTITY_OK", "VERIFY_LOOKUP_SAME_ID_IDENTITY_OK", "VERIFIED_CREATED_BY_READ"]);
    // the original create-outcome evidence is preserved as it was (RESERVATION_MISMATCH, field NAME only)
    const co = j.entries.find((e) => e.type === "outcome" && e.kind === "create");
    assert.equal(co.code, "RESERVATION_MISMATCH"); assert.deepEqual(co.evidence.mismatches, ["bookingRef"]);
    // order: create -> KV1 read -> KV2 lookup -> K3 side effects ... -> K7 fresh read -> cancel
    const created = w.log.indexOf("POST /reservations");
    assert.equal(w.log[created + 1], `GET /reservations/${w.res.id}`);
    assert.equal(w.log[created + 2], "GET /reservations");
    assert.deepEqual(stages, ["before-create", "after-create", "after-cancel"]);
    assert.deepEqual(writes(w), ["POST /reservations", `PUT /reservations/${w.res.id}/statuses/cancelled`]);
    journalSafe(j); leakFree(r); leakFree(X.summarizeConnected(r));
  }
});

// ---------- 3. refusal shapes: halt at KW1 as before; never a KV read, never a cancel ----------
const REFUSE = [
  ["explicit wrong ref", (x, w) => ({ ...x, customFieldValues: [{ customFieldId: 105433, value: "MV-ZZZZZZ99" }] }), "RESERVATION_MISMATCH", "REF_PRESENT"],
  ["explicit empty ref", (x) => ({ ...x, customFieldValues: [{ customFieldId: 105433, value: "" }] }), "RESERVATION_MISMATCH", "REF_PRESENT"],
  ["non-string ref value", (x) => ({ ...x, customFieldValues: [{ customFieldId: 105433, value: 123 }] }), "REF_VALUE_INVALID", null],
  ["null ref value", (x) => ({ ...x, customFieldValues: [{ customFieldId: 105433, value: null }] }), "REF_VALUE_INVALID", null],
  ["own entry without value", (x) => ({ ...x, customFieldValues: [{ customFieldId: 105433 }] }), "REF_VALUE_INVALID", null],
  ["duplicate own entries", (x, w) => ({ ...x, customFieldValues: [{ customFieldId: 105433, value: w.ref }, { customFieldId: 105433, value: w.ref }] }), "REF_FIELD_DUPLICATED", null],
  ["list is a string", (x) => ({ ...x, customFieldValues: "PROVIDER-TEXT" }), "CUSTOM_FIELDS_MALFORMED", null],
  ["list is an object", (x) => ({ ...x, customFieldValues: { customFieldId: 999 } }), "CUSTOM_FIELDS_MALFORMED", null],
  ["null item", (x) => ({ ...x, customFieldValues: [null] }), "RESERVATION_MISMATCH", "CUSTOM_FIELDS_NOT_DEMONSTRABLY_ABSENT"],
  ["string item", (x) => ({ ...x, customFieldValues: ["105433"] }), "RESERVATION_MISMATCH", "CUSTOM_FIELDS_NOT_DEMONSTRABLY_ABSENT"],
  ["array item", (x) => ({ ...x, customFieldValues: [{ customFieldId: 999 }, []] }), "RESERVATION_MISMATCH", "CUSTOM_FIELDS_NOT_DEMONSTRABLY_ABSENT"],
  ["string customFieldId of the ref field", (x, w) => ({ ...x, customFieldValues: [{ customFieldId: "105433", value: w.ref }] }), "RESERVATION_MISMATCH", "CUSTOM_FIELDS_NOT_DEMONSTRABLY_ABSENT"],
  ["item keyed by id instead of customFieldId", (x, w) => ({ ...x, customFieldValues: [{ id: 105433, value: w.ref }] }), "RESERVATION_MISMATCH", "CUSTOM_FIELDS_NOT_DEMONSTRABLY_ABSENT"],
  ["other field whose row id is the ref field id (string)", (x) => ({ ...x, customFieldValues: [{ id: "105433", customFieldId: 999, value: "x" }] }), "RESERVATION_MISMATCH", "CUSTOM_FIELDS_NOT_DEMONSTRABLY_ABSENT"],
  ["nested customField naming the ref field", (x) => ({ ...x, customFieldValues: [{ customFieldId: 999, customField: { id: 105433 } }] }), "RESERVATION_MISMATCH", "CUSTOM_FIELDS_NOT_DEMONSTRABLY_ABSENT"],
  ["nested customField not an object", (x) => ({ ...x, customFieldValues: [{ customFieldId: 999, customField: "PROVIDER-TEXT" }] }), "RESERVATION_MISMATCH", "CUSTOM_FIELDS_NOT_DEMONSTRABLY_ABSENT"],
  ["zero customFieldId", (x) => ({ ...x, customFieldValues: [{ customFieldId: 0 }] }), "RESERVATION_MISMATCH", "CUSTOM_FIELDS_NOT_DEMONSTRABLY_ABSENT"],
  ["fractional customFieldId", (x) => ({ ...x, customFieldValues: [{ customFieldId: 105433.5 }] }), "RESERVATION_MISMATCH", "CUSTOM_FIELDS_NOT_DEMONSTRABLY_ABSENT"],
  ["missing customFieldId", (x) => ({ ...x, customFieldValues: [{ value: "x" }] }), "RESERVATION_MISMATCH", "CUSTOM_FIELDS_NOT_DEMONSTRABLY_ABSENT"],
  ["unechoed ref AND another mismatch (total)", (x) => noRef({ ...x, totalPrice: 4400.5 }), "RESERVATION_MISMATCH", "NOT_REF_ONLY_MISMATCH"],
  ["unechoed ref AND another mismatch (dates)", (x) => noRef({ ...x, departureDate: "2027-05-13" }), "RESERVATION_MISMATCH", "NOT_REF_ONLY_MISMATCH"],
  ["unechoed ref AND another mismatch (currency)", (x) => noRef({ ...x, currency: "USD" }), "RESERVATION_MISMATCH", "NOT_REF_ONLY_MISMATCH"],
  ["unechoed ref AND another mismatch (channel)", (x) => noRef({ ...x, channelId: 2005 }), "RESERVATION_MISMATCH", "NOT_REF_ONLY_MISMATCH"],
  ["unechoed ref AND another listing", (x) => noRef({ ...x, listingMapId: 606998 }), "RESERVATION_MISMATCH", "NOT_REF_ONLY_MISMATCH"],
  ["unechoed ref, original status pending", (x) => noRef({ ...x, status: "pending" }), "RESERVATION_MISMATCH", "ORIGINAL_STATUS_NOT_ACCEPTED"],
  ["unechoed ref, original status cancelled", (x) => noRef({ ...x, status: "cancelled" }), "RESERVATION_MISMATCH", "ORIGINAL_STATUS_NOT_ACCEPTED"],
  ["unechoed ref, original status modified", (x) => noRef({ ...x, status: "modified" }), "RESERVATION_MISMATCH", "ORIGINAL_STATUS_NOT_ACCEPTED"],
  ["unechoed ref, original status unknown string", (x) => noRef({ ...x, status: "PROVIDER-TEXT" }), "STATUS_INVALID", null],
  ["unechoed ref, inconsistent id alias", (x) => noRef({ ...x, hostawayReservationId: "1" }), "RESERVATION_ID_INCONSISTENT", null],
  ["unechoed ref, string id", (x) => noRef({ ...x, id: String(x.id) }), "RESERVATION_ID_INVALID", null],
  ["unechoed ref, zero id", (x) => noRef({ ...x, id: 0, hostawayReservationId: undefined }), "RESERVATION_ID_INVALID", null]
];
test("refusal shapes: never treated as absent or coerced -> strict KW1 halt, no KV read or lookup, no cancel; the later read saying new changes nothing", async () => {
  for (const [name, reply, cls, refusal] of REFUSE) {
    const w = world({ reply });
    const { r, j } = await run(w);
    assert.equal(r.status, "HALTED", name);
    assert.deepEqual(r.halt && [r.halt.step, r.halt.code], ["KW1_CREATE", `CREATE_NOT_VERIFIED:${cls}`], name);
    assert.deepEqual(r.writes, { create: 1, cancel: 0 }, name);
    assert.equal(kvEntries(j).length, 0, name);
    assert.equal(r.createVerification.path, "NONE", name); assert.equal(r.createVerification.result, "NOT_VERIFIED", name);
    assert.equal(r.createVerification.refusal, refusal, name);
    assert.equal(r.passed, false, name);
    assert.deepEqual(writes(w), ["POST /reservations"], name);
    journalSafe(j); leakFree(r);
  }
});

test("a create reply carrying a protected id is never adopted on the fallback path either (70636076, 71045356): no read, lookup id, or cancel of it", async () => {
  for (const pid of [70636076, 71045356]) {
    const w = world({ reply: (x) => noRef({ ...x, id: pid, hostawayReservationId: String(pid) }) });
    const { r, j } = await run(w);
    assert.deepEqual([r.halt.step, r.halt.code], ["KW1_CREATE", "CREATE_RETURNED_PROTECTED_ID"]);
    assert.ok(!w.log.some((l) => l.includes(String(pid))));
    assert.equal(kvEntries(j).length, 0); assert.deepEqual(r.writes, { create: 1, cancel: 0 });
  }
});

test("transport-uncertain or non-2xx create replies never take the fallback", async () => {
  for (const raw of [() => "throw", () => ({ httpStatus: 500, json: {} }), () => ({ httpStatus: 201, json: { status: "fail", result: "PROVIDER-TEXT" } })]) {
    const w = world({ createRaw: raw });
    const { r, j } = await run(w);
    assert.equal(r.halt.step, "KW1_CREATE"); assert.equal(kvEntries(j).length, 0); assert.deepEqual(r.writes, { create: 1, cancel: 0 });
  }
});

// ---------- 4. KV1: the fresh read by the exact id must be the full identity, status new ----------
test("KV1 read failures halt read-only before any lookup adoption or cancel: status, ref, price, currency, dates, listing, channel, id, HTTP, transport, timeout", async () => {
  const mut = (f) => (w, n) => (n === 1 ? w.ok(f(clone(w.res), w)) : undefined);
  const cases = [
    ["status pending", mut((x) => ({ ...x, status: "pending" })), "VERIFY_READ_IDENTITY_MISMATCH"],
    ["status cancelled", mut((x) => ({ ...x, status: "cancelled" })), "VERIFY_READ_IDENTITY_MISMATCH"],
    ["status modified", mut((x) => ({ ...x, status: "modified" })), "VERIFY_READ_IDENTITY_MISMATCH"],
    ["ref absent on read", mut(noRef), "VERIFY_READ_IDENTITY_MISMATCH"],
    ["wrong ref on read", mut((x) => ({ ...x, customFieldValues: [{ customFieldId: 105433, value: "MV-ZZZZZZ99" }] })), "VERIFY_READ_IDENTITY_MISMATCH"],
    ["price", mut((x) => ({ ...x, totalPrice: 4401 })), "VERIFY_READ_IDENTITY_MISMATCH"],
    ["currency", mut((x) => ({ ...x, currency: "USD" })), "VERIFY_READ_IDENTITY_MISMATCH"],
    ["dates", mut((x) => ({ ...x, departureDate: "2027-05-13" })), "VERIFY_READ_IDENTITY_MISMATCH"],
    ["listing", mut((x) => ({ ...x, listingMapId: 606998 })), "VERIFY_READ_IDENTITY_MISMATCH"],
    ["channel", mut((x) => ({ ...x, channelId: 2005 })), "VERIFY_READ_IDENTITY_MISMATCH"],
    ["other id", mut((x) => ({ ...x, id: 91000077, hostawayReservationId: "91000077" })), "VERIFY_READ_IDENTITY_MISMATCH"],
    ["duplicate ref field", mut((x, w) => ({ ...x, customFieldValues: [{ customFieldId: 105433, value: w.ref }, { customFieldId: 105433, value: w.ref }] })), "VERIFY_READ_REF_FIELD_DUPLICATED"],
    ["404", (w, n) => (n === 1 ? { httpStatus: 404, json: { status: "fail", result: "PROVIDER-TEXT" } } : undefined), "VERIFY_READ_REFUSAL_CANDIDATE"],
    ["500", (w, n) => (n === 1 ? { httpStatus: 500, json: {} } : undefined), "VERIFY_READ_UPSTREAM_5XX"],
    ["429", (w, n) => (n === 1 ? { httpStatus: 429, json: {} } : undefined), "VERIFY_READ_RATE_LIMITED"],
    ["401", (w, n) => (n === 1 ? { httpStatus: 401, json: {} } : undefined), "VERIFY_READ_AUTH_UNCERTAIN"],
    ["fail envelope", (w, n) => (n === 1 ? { httpStatus: 200, json: { status: "fail", result: "PROVIDER-TEXT" } } : undefined), "VERIFY_READ_FAIL_ENVELOPE"],
    ["transport error", (w, n) => (n === 1 ? "throw" : undefined), "VERIFY_READ_TRANSPORT_UNCERTAIN"],
    ["timeout", (w, n) => (n === 1 ? "hang" : undefined), "VERIFY_READ_TRANSPORT_UNCERTAIN"]
  ];
  for (const [name, read, code] of cases) {
    const w = world({ reply: noRef, read });
    const { r, j } = await run(w);
    assert.deepEqual([r.halt.step, r.halt.code], ["KV1_READ_VERIFY", code], name);
    assert.deepEqual(r.writes, { create: 1, cancel: 0 }, name);
    assert.equal(r.createVerification.result, "NOT_VERIFIED", name); assert.equal(r.createVerification.readVerify, code, name);
    assert.equal(r.createVerification.lookupVerify, null, name);
    assert.ok(!j.entries.some((e) => e.step === "KV2_LOOKUP_VERIFY"), name);           // no lookup step after a failed read
    assert.ok(C.CONNECTED_VERIFY_READ_CODES.includes(code), name);
    assert.equal(r.reconcile.length, 1, name);                                         // read-only reconciliation ran
    assert.ok(writes(w).every((x) => x === "POST /reservations"), name);
    journalSafe(j); leakFree(r);
  }
});

// ---------- 5. KV2: a UNIQUE scoped ref lookup must return the SAME id with full identity and status new ----------
test("KV2 lookup failures halt read-only (no adoption, no cancel): not found, duplicate, other id, protected id, identity/status, HTTP, page cap", async () => {
  const item = (w, o = {}) => ({ ...clone(w.res), ...o });
  const page = (items) => (w, q) => (q.afterId !== undefined ? w.ok([]) : w.ok(items(w)));
  const cases = [
    ["not found", page(() => []), "VERIFY_LOOKUP_NOT_CONFIRMED:NOT_FOUND_NON_AUTHORITATIVE"],
    ["duplicate ref", page((w) => [item(w), item(w, { id: 91000078, hostawayReservationId: "91000078" })]), "VERIFY_LOOKUP_NOT_CONFIRMED:DUPLICATE_REF"],
    ["other id with the ref", page((w) => [item(w, { id: 91000078, hostawayReservationId: "91000078" })]), "VERIFY_LOOKUP_ID_DIFFERS"],
    ["protected 71045356 with the ref", page((w) => [item(w, { id: 71045356, hostawayReservationId: "71045356" })]), "VERIFY_LOOKUP_PROTECTED_ID"],
    ["protected 70636076 with the ref", page((w) => [item(w, { id: 70636076, hostawayReservationId: "70636076" })]), "VERIFY_LOOKUP_PROTECTED_ID"],
    ["same id, status pending", page((w) => [item(w, { status: "pending" })]), "VERIFY_LOOKUP_IDENTITY_MISMATCH"],
    ["same id, status cancelled", page((w) => [item(w, { status: "cancelled" })]), "VERIFY_LOOKUP_IDENTITY_MISMATCH"],
    ["same id, price", page((w) => [item(w, { totalPrice: 4401 })]), "VERIFY_LOOKUP_IDENTITY_MISMATCH"],
    ["same id, currency", page((w) => [item(w, { currency: "USD" })]), "VERIFY_LOOKUP_IDENTITY_MISMATCH"],
    ["same id, departure", page((w) => [item(w, { departureDate: "2027-05-13" })]), "VERIFY_LOOKUP_NOT_CONFIRMED:MATCH_DISAGREES"],
    ["filter not applied (other listing)", page((w) => [item(w, { listingMapId: 606998 })]), "VERIFY_LOOKUP_NOT_CONFIRMED:FILTER_NOT_APPLIED"],
    ["malformed item", page((w) => [item(w, { customFieldValues: "PROVIDER-TEXT" })]), "VERIFY_LOOKUP_NOT_CONFIRMED:ITEM_CUSTOM_FIELDS_MALFORMED"],
    ["500", () => ({ httpStatus: 500, json: {} }), "VERIFY_LOOKUP_NOT_CONFIRMED:HTTP_NOT_OK"],
    ["transport", () => "throw", "VERIFY_LOOKUP_NOT_CONFIRMED:TRANSPORT_UNCERTAIN"],
    ["page cap", (w, q) => w.ok([item(w, { id: 92000000 + Number(q.afterId ?? 0) % 1000 + 1, hostawayReservationId: undefined,
      customFieldValues: [{ customFieldId: 105433, value: "MV-OTHER999" }] })]), "VERIFY_LOOKUP_NOT_CONFIRMED:PAGE_CAP_REACHED"]
  ];
  for (const [name, lookup, code] of cases) {
    const w = world({ reply: noRef, lookup });
    const { r, j } = await run(w);
    assert.deepEqual([r.halt.step, r.halt.code], ["KV2_LOOKUP_VERIFY", code], name);
    assert.deepEqual(r.writes, { create: 1, cancel: 0 }, name);
    assert.equal(r.createVerification.readVerify, "VERIFY_READ_IDENTITY_OK", name);
    assert.equal(r.createVerification.lookupVerify, code, name); assert.equal(r.createVerification.result, "NOT_VERIFIED", name);
    assert.ok(C.CONNECTED_VERIFY_LOOKUP_CODES.includes(code), name);
    assert.ok(!w.log.some((l) => /\/reservations\/(70636076|71045356)/.test(l)), name);
    assert.ok(!r.steps.some((s) => s.code === "VERIFIED_CREATED_BY_READ"), name);
    assert.ok(!j.entries.some((e) => e.step === "KV2_LOOKUP_VERIFY" && [70636076, 71045356].includes(e.reservationId)), name);
    journalSafe(j); leakFree(r);
  }
});

// ---------- 6. after adoption every existing safety check still applies ----------
test("after READ_VERIFIED adoption: side effects present or unknown halt before the cancel; a K7 mismatch still forbids the cancel", async () => {
  const cases = [
    [{ charges: () => [{ id: 1, amount: 10, status: "paid" }] }, "K3_SIDE_EFFECTS_CREATE"],
    [{ charges: () => "fail" }, "K3_SIDE_EFFECTS_CREATE"],
    [{ conversations: () => "fail" }, "K3_SIDE_EFFECTS_CREATE"],
    [{ conversations: (id) => [{ id: 1, reservationId: id }, { id: 2, reservationId: id }] }, "K3_SIDE_EFFECTS_CREATE"],
    [{ read: (w, n) => (n === 3 ? w.ok({ ...clone(w.res), totalPrice: 4401 }) : undefined) }, "K7_PRECANCEL"],     // reads: KV1, K4, K7
    [{ read: (w, n) => (n === 2 ? w.ok({ ...clone(w.res), status: "modified" }) : undefined) }, "K4_READBACK"]
  ];
  for (const [over, step] of cases) {
    const w = world({ reply: noRef, ...over });
    const { r } = await run(w);
    assert.equal(r.createVerification.result, "READ_VERIFIED", step);
    assert.equal(r.halt.step, step, JSON.stringify(r.halt));
    assert.deepEqual(r.writes, { create: 1, cancel: 0 }, step);
    assert.deepEqual(writes(w), ["POST /reservations"], step);
  }
});

// ---------- 7. journal failures on the fallback forbid the cancel ----------
test("journal append failure at the KV1 marker, KV1 read or KV2 lookup entry: halted, latched not durable, nothing after it is written; a journal load failure forbids the cancel", async () => {
  const v = validateConnectedManifest(manifest(), { now: NOW });
  const at = [
    [(e) => e.step === "KV1_READ_VERIFY" && String(e.code).startsWith("CREATE_REF_NOT_ECHOED:"), "KV1_READ_VERIFY", 0],
    [(e) => e.step === "KV1_READ_VERIFY" && e.code === "VERIFY_READ_IDENTITY_OK", "KV1_READ_VERIFY", 1],
    [(e) => e.step === "KV2_LOOKUP_VERIFY" && e.type === "read", "KV2_LOOKUP_VERIFY", 1]
  ];
  for (const [failOn, step, kv1Reads] of at) {
    const w = world({ reply: noRef });
    const { r } = await run(w, { journal: memJournal(v.hash, { failOn }) });
    assert.equal(r.status, "HALTED"); assert.equal(r.halt.step, step); assert.equal(r.halt.code, "JOURNAL_WRITE_FAILED");
    assert.equal(r.journalDurable, false); assert.deepEqual(r.writes, { create: 1, cancel: 0 });
    assert.equal(w.reads >= kv1Reads, true);
    if (kv1Reads === 0) assert.equal(w.log.filter((l) => l === `GET /reservations/${w.res.id}`).length, 1);   // only the KR reconcile read
    assert.notEqual(r.createVerification.result, "READ_VERIFIED");
    assert.deepEqual(writes(w), ["POST /reservations"]);
  }
  // journal LOAD failing before the cancel's write-ahead budget check: no cancel is sent
  const w = world({ reply: noRef });
  const j = memJournal(v.hash, { failLoad: (es) => es.some((e) => e.step === "K7_PRECANCEL") });
  const { r } = await run(w, { journal: j });
  assert.equal(r.createVerification.result, "READ_VERIFIED");
  assert.deepEqual(r.writes, { create: 1, cancel: 0 }); assert.equal(r.halt.step, "KW2_CANCEL");
  assert.deepEqual(writes(w), ["POST /reservations"]);
});

// ---------- 8. budgets, guard caps, allowlists, protection ----------
test("budgets: create 1 / cancel 1 unchanged; KV steps are read-only and counted; the URL guard caps include exactly the KV reads", async () => {
  assert.deepEqual(C.CONNECTED_WRITE_BUDGET, { create: 1, cancel: 1 });
  assert.deepEqual(CONNECTED_STEPS.KV1_READ_VERIFY, { reads: 1, writes: 0 });
  assert.deepEqual(CONNECTED_STEPS.KV2_LOOKUP_VERIFY, { reads: A.LOOKUP_MAX_PAGES, writes: 0 });
  assert.deepEqual(Object.keys(CONNECTED_STEPS).filter((k) => CONNECTED_STEPS[k].writes).sort(), ["KW1_CREATE", "KW2_CANCEL"]);
  const steps = Object.keys(CONNECTED_STEPS);
  assert.ok(steps.indexOf("KW1_CREATE") < steps.indexOf("KV1_READ_VERIFY") && steps.indexOf("KV2_LOOKUP_VERIFY") < steps.indexOf("K3_SIDE_EFFECTS_CREATE"));
  const g = X.guardConnectedFetch(async () => new Response("{}"), { calendar: { startDate: "2027-05-10", endDate: "2027-05-11" }, arrivalDate: STAY.arrivalDate, departureDate: STAY.departureDate });
  const B = "https://api.hostaway.com/v1";
  let n = 0;
  for (;;) { try { await g.guarded(`${B}/reservations/91000001?includeResources=1`); n++; } catch { break; } }
  assert.equal(n, 1 + 1 + 1 + 1 + 1);                                // KV1, K4, K7, K8 + one KR reconcile read
  const lq = `listingId=${L}&channelId=2000&arrivalStartDate=${STAY.arrivalDate}&arrivalEndDate=${STAY.arrivalDate}&limit=100&includeResources=1`;
  let k = 0;
  for (;;) { try { await g.guarded(`${B}/reservations?${lq}`); k++; } catch { break; } }
  assert.equal(k, 4 * A.LOOKUP_MAX_PAGES);                           // K1, KV2, K5 + KR reconcile
  for (const pid of [70636076, 71045356]) await assert.rejects(g.guarded(`${B}/reservations/${pid}/statuses/cancelled`, { method: "PUT", body: JSON.stringify({ cancelledBy: "host" }) }));
});

test("71045356 protection: refused for NEW execution (gate + launcher guard) even if readable/cancellable; recovery exempts it ONLY for the historical run's own journal", async () => {
  const st = { readableIds: new Set([71045356]), cancellableId: 71045356, bound: { priceBody: {}, createBody: {}, arrivalDate: STAY.arrivalDate } };
  const code = (req, wk) => { try { C.assertConnectedRequest(req, st, wk); return "ALLOWED"; } catch (e) { return e.code; } };
  assert.equal(code({ method: "GET", path: "/reservations/71045356", query: { includeResources: 1 } }), "PROTECTED_RESERVATION");
  assert.equal(code({ method: "PUT", path: "/reservations/71045356/statuses/cancelled", query: {}, body: { cancelledBy: "host" } }, "cancel"), "PROTECTED_RESERVATION");
  assert.equal(code({ method: "GET", path: "/conversations", query: { reservationId: 71045356, limit: 100, offset: 0 } }), "PROTECTED_RESERVATION");
  // recovery protection is scoped by manifest hash
  assert.equal(RC.recoveryProtection(HIST)(71045356), false);
  assert.equal(RC.recoveryProtection(HIST)(70636076), true);
  assert.equal(RC.recoveryProtection("f".repeat(64))(71045356), true);
  assert.equal(RC.recoveryProtection(undefined)(71045356), true);
  assert.deepEqual(C.CONNECTED_HISTORICAL_RUN_IDS, { [HIST]: 71045356 });
  const rst = (h) => ({ isProtected: RC.recoveryProtection(h), readId: 71045356, arrivalDate: "2027-04-05", calendar: { startDate: "2027-04-05", endDate: "2027-04-06" } });
  assert.equal(RC.assertRecoverRequest({ method: "GET", path: "/reservations/71045356", query: { includeResources: 1 } }, rst(HIST)), "read");
  assert.throws(() => RC.assertRecoverRequest({ method: "GET", path: "/reservations/71045356", query: { includeResources: 1 } }, rst("f".repeat(64))), /PROTECTED_RESERVATION|Runner/);
  assert.throws(() => RC.assertRecoverRequest({ method: "GET", path: "/reservations/70636076", query: { includeResources: 1 } }, { ...rst(HIST), readId: 70636076 }));
  assert.throws(() => RC.assertRecoverRequest({ method: "PUT", path: "/reservations/71045356/statuses/cancelled", body: {} }, rst(HIST), "cancel"));
  // the historical run's own journal shape (create reply mismatch on 71045356, no cancel) stays readable by recovery
  const refs = ["MV-PROBE001", "MV-ABCDEF12"];
  const hist = [{ type: "run-start", runId: "a".repeat(16), manifestHash: HIST, refs }, { type: "intent", step: "KW1_CREATE", kind: "create", ref: refs[1] },
    { type: "outcome", step: "KW1_CREATE", kind: "create", ref: refs[1], code: "RESERVATION_MISMATCH", evidence: { outcome: "conflict", code: "RESERVATION_MISMATCH", httpStatus: 200, mismatches: ["bookingRef"], reservationId: 71045356 } },
    { type: "halt", step: "KW1_CREATE", code: "CREATE_NOT_VERIFIED:RESERVATION_MISMATCH" }];
  const ch = RC.classifyConnectedJournal(hist, HIST);
  assert.equal(ch.ok, true); assert.equal(ch.clean, true); assert.equal(ch.reservationId, 71045356); assert.equal(ch.state, "CREATED_NO_CANCEL_ATTEMPT");
  assert.deepEqual(ch.createVerification, { path: "NONE", result: "NOT_VERIFIED", refEcho: null, readVerify: null, lookupVerify: null });   // never a pass
  // the same id in any other run's journal is a protected-id conflict and is never read
  const other = hist.map((e, i) => (i === 0 ? { ...e, manifestHash: "f".repeat(64) } : e));
  const co = RC.classifyConnectedJournal(other, "f".repeat(64));
  assert.equal(co.clean, false); assert.ok(co.conflicts.includes("PROTECTED_ID_IN_JOURNAL")); assert.equal(co.reservationId, null);
  // the execute side never consults the historical exemption
  for (const f of ["scripts/e4-connected/connected-execute.mjs"]) assert.doesNotMatch(readFileSync(join(ROOT, f), "utf8"), /CONNECTED_HISTORICAL_RUN_IDS|recoveryProtection/);
  const pathSrc = readFileSync(join(ROOT, "scripts/e4-connected/connected-path.mjs"), "utf8");
  assert.equal(pathSrc.match(/CONNECTED_HISTORICAL_RUN_IDS/g).length, 1);              // defined only; never used by execution
});

// ---------- 9. recovery classification at each new stage (crash/halt) ----------
test("recovery: KV stages classify truthfully at every crash point; READ_VERIFIED vs REPLY_VERIFIED; contradictions are conflicts", () => {
  const v = validateConnectedManifest(manifest(), { now: NOW }); const H = v.hash;
  const REF = "MV-ABCDEF12";
  const start = { type: "run-start", runId: "a".repeat(16), manifestHash: H, refs: ["MV-PROBE001", REF] };
  const ci = { type: "intent", step: "KW1_CREATE", kind: "create", ref: REF };
  const co = (code) => ({ type: "outcome", step: "KW1_CREATE", kind: "create", ref: REF, code, evidence: { outcome: code === "VERIFIED_CREATED" ? "created" : "conflict", code,
    httpStatus: 200, ...(code === "RESERVATION_MISMATCH" ? { mismatches: ["bookingRef"] } : {}), reservationId: 5 } });
  const mk = { type: "read", step: "KV1_READ_VERIFY", kind: "read", code: "CREATE_REF_NOT_ECHOED:ABSENT_UNDEFINED", reservationId: 5 };
  const rd = (code = "VERIFY_READ_IDENTITY_OK", id = 5, extra = {}) => ({ type: "read", step: "KV1_READ_VERIFY", kind: "read", code, reservationId: id, httpStatus: 200,
    ...(code === "VERIFY_READ_IDENTITY_MISMATCH" ? { mismatches: ["status"] } : {}), ...extra });
  const hl = (step, code) => ({ type: "halt", step, code });
  const rc = { type: "reconcile", step: "KR_RECONCILE", ref: REF, code: "FOUND_BY_REF", reservationId: 5 };
  const lk = (code = "VERIFY_LOOKUP_SAME_ID_IDENTITY_OK", id = 5) => ({ type: "read", step: "KV2_LOOKUP_VERIFY", kind: "lookup", code, ref: REF, ...(id ? { reservationId: id } : {}) });
  const xi = { type: "intent", step: "KW2_CANCEL", kind: "cancel", reservationId: 5, ref: REF };
  const xo = { type: "outcome", step: "KW2_CANCEL", kind: "cancel", reservationId: 5, code: "VERIFIED_CANCELLED" };
  const K = (es) => RC.classifyConnectedJournal(es, H);
  const cv = (path, result, refEcho, readVerify, lookupVerify) => ({ path, result, refEcho, readVerify, lookupVerify });
  const MK = "CREATE_REF_NOT_ECHOED:ABSENT_UNDEFINED";
  const stages = [
    [[start, ci, co("RESERVATION_MISMATCH")], "CREATED_NO_CANCEL_ATTEMPT", cv("NONE", "NOT_VERIFIED", null, null, null)],
    [[start, ci, co("RESERVATION_MISMATCH"), mk], "CREATED_NO_CANCEL_ATTEMPT", cv("READ_FALLBACK", "NOT_VERIFIED", MK, null, null)],
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd()], "CREATED_NO_CANCEL_ATTEMPT", cv("READ_FALLBACK", "NOT_VERIFIED", MK, "VERIFY_READ_IDENTITY_OK", null)],
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd("VERIFY_READ_IDENTITY_MISMATCH")], "CREATED_NO_CANCEL_ATTEMPT", cv("READ_FALLBACK", "NOT_VERIFIED", MK, "VERIFY_READ_IDENTITY_MISMATCH", null)],
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd(), lk()], "CREATED_NO_CANCEL_ATTEMPT", cv("READ_FALLBACK", "READ_VERIFIED", MK, "VERIFY_READ_IDENTITY_OK", "VERIFY_LOOKUP_SAME_ID_IDENTITY_OK")],
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd(), lk("VERIFY_LOOKUP_NOT_CONFIRMED:NOT_FOUND_NON_AUTHORITATIVE", null)], "CREATED_NO_CANCEL_ATTEMPT",
      cv("READ_FALLBACK", "NOT_VERIFIED", MK, "VERIFY_READ_IDENTITY_OK", "VERIFY_LOOKUP_NOT_CONFIRMED:NOT_FOUND_NON_AUTHORITATIVE")],
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd(), lk(), xi], "CANCEL_OUTCOME_MISSING", cv("READ_FALLBACK", "READ_VERIFIED", MK, "VERIFY_READ_IDENTITY_OK", "VERIFY_LOOKUP_SAME_ID_IDENTITY_OK")],
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd(), lk(), xi, xo], "CANCEL_VERIFIED", cv("READ_FALLBACK", "READ_VERIFIED", MK, "VERIFY_READ_IDENTITY_OK", "VERIFY_LOOKUP_SAME_ID_IDENTITY_OK")],
    [[start, ci, co("VERIFIED_CREATED"), xi, xo], "CANCEL_VERIFIED", cv("REPLY", "REPLY_VERIFIED", null, null, null)],
    // a valid non-200 2xx create reply (classifyCreateResponse accepts 200..299) and a 2xx read stay compatible
    [[start, ci, { ...co("RESERVATION_MISMATCH"), evidence: { ...co("RESERVATION_MISMATCH").evidence, httpStatus: 201 } }, mk, rd("VERIFY_READ_IDENTITY_OK", 5, { httpStatus: 203 }), lk()],
      "CREATED_NO_CANCEL_ATTEMPT", cv("READ_FALLBACK", "READ_VERIFIED", MK, "VERIFY_READ_IDENTITY_OK", "VERIFY_LOOKUP_SAME_ID_IDENTITY_OK")],
    // crash/halt prefixes exactly as the producer writes them (halt + read-only reconcile + run-end after the last KV entry)
    [[start, ci, co("RESERVATION_MISMATCH"), hl("KV1_READ_VERIFY", "JOURNAL_WRITE_FAILED"), rc], "CREATED_NO_CANCEL_ATTEMPT", cv("NONE", "NOT_VERIFIED", null, null, null)],
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd("VERIFY_READ_IDENTITY_MISMATCH"), hl("KV1_READ_VERIFY", "VERIFY_READ_IDENTITY_MISMATCH"), rc, { type: "run-end", code: "HALTED" }],
      "CREATED_NO_CANCEL_ATTEMPT", cv("READ_FALLBACK", "NOT_VERIFIED", MK, "VERIFY_READ_IDENTITY_MISMATCH", null)],
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd("VERIFY_READ_TRANSPORT_UNCERTAIN", 5, { httpStatus: undefined, transport: "TIMEOUT" }), hl("KV1_READ_VERIFY", "VERIFY_READ_TRANSPORT_UNCERTAIN"), rc],
      "CREATED_NO_CANCEL_ATTEMPT", cv("READ_FALLBACK", "NOT_VERIFIED", MK, "VERIFY_READ_TRANSPORT_UNCERTAIN", null)],
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd(), lk("VERIFY_LOOKUP_NOT_CONFIRMED:DUPLICATE_REF", null), hl("KV2_LOOKUP_VERIFY", "VERIFY_LOOKUP_NOT_CONFIRMED:DUPLICATE_REF"), rc],
      "CREATED_NO_CANCEL_ATTEMPT", cv("READ_FALLBACK", "NOT_VERIFIED", MK, "VERIFY_READ_IDENTITY_OK", "VERIFY_LOOKUP_NOT_CONFIRMED:DUPLICATE_REF")]
  ].map(([es, st, w]) => [es.map((e) => JSON.parse(JSON.stringify(e))), st, w]);
  for (const [es, state, want] of stages) {
    const c = K(es);
    assert.equal(c.ok, true, JSON.stringify(c)); assert.equal(c.clean, true, `${state} ${c.conflicts}`);
    assert.equal(c.state, state); assert.deepEqual(c.createVerification, want); assert.equal(c.reservationId, 5);
  }
  const conflicts = [
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd(), xi], "CANCEL_WITHOUT_VERIFIED_CREATE"],
    [[start, ci, co("RESERVATION_MISMATCH"), xi], "CANCEL_WITHOUT_VERIFIED_CREATE"],
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd(), lk("VERIFY_LOOKUP_ID_DIFFERS", 6)], "RESERVATION_IDS_INCONSISTENT"],
    [[start, ci, co("VERIFIED_CREATED"), mk, rd(), lk()], "CREATE_VERIFICATION_WITHOUT_UNECHOED_REF"],
    [[start, ci, co("RESERVATION_MISMATCH"), rd(), lk()], "CREATE_VERIFICATION_OUT_OF_ORDER"],                          // no marker: the read sits in the marker slot
    [[start, ci, mk, co("RESERVATION_MISMATCH")], "CREATE_VERIFICATION_BEFORE_CREATE_OUTCOME"],
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd(), lk(), xi, lk()], "CREATE_VERIFICATION_AFTER_CANCEL"],
    [[start, ci, co("RESERVATION_MISMATCH"), mk, mk, rd(), lk()], "CREATE_VERIFICATION_DUPLICATED"],
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd("VERIFY_READ_SOMETHING_NEW"), lk()], "CREATE_VERIFICATION_CODE_UNKNOWN"],
    [[start, ci, co("RESERVATION_MISMATCH"), { ...mk, code: "CREATE_REF_NOT_ECHOED:MALFORMED" }, rd(), lk()], "CREATE_VERIFICATION_CODE_UNKNOWN"],
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd(), lk("VERIFY_LOOKUP_SAME_ID_IDENTITY_OK", 71045356)], "PROTECTED_ID_IN_JOURNAL"],
    // ---- root HOLD f6d00ab regressions (sanitizer-valid entries that must never be READ_VERIFIED)
    [[start, ci, co("RESERVATION_MISMATCH"), lk(), rd(), mk], "CREATE_VERIFICATION_OUT_OF_ORDER"],                       // (1) reordered after the outcome
    [[start, ci, { ...co("RESERVATION_MISMATCH"), evidence: { ...co("RESERVATION_MISMATCH").evidence, mismatches: ["totalMinor"] } }, mk, rd(), lk()],
      "CREATE_VERIFICATION_WITHOUT_UNECHOED_REF"],                                                                       // (2) original mismatch not exactly bookingRef
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd(), { ...lk(), ref: "MV-ZZZZZZ99" }], "CREATE_VERIFICATION_REF_NOT_BOUND"],  // (3) lookup ref is not the run ref
    // original outcome evidence must be exactly the producer's
    [[start, ci, { ...co("RESERVATION_MISMATCH"), evidence: { ...co("RESERVATION_MISMATCH").evidence, mismatches: ["bookingRef", "totalMinor"] } }, mk, rd(), lk()], "CREATE_VERIFICATION_WITHOUT_UNECHOED_REF"],
    [[start, ci, { ...co("RESERVATION_MISMATCH"), evidence: { ...co("RESERVATION_MISMATCH").evidence, httpStatus: 300 } }, mk, rd(), lk()], "CREATE_VERIFICATION_WITHOUT_UNECHOED_REF"],
    [[start, ci, { ...co("RESERVATION_MISMATCH"), evidence: { ...co("RESERVATION_MISMATCH").evidence, httpStatus: 199 } }, mk, rd(), lk()], "CREATE_VERIFICATION_WITHOUT_UNECHOED_REF"],
    [[start, ci, { ...co("RESERVATION_MISMATCH"), evidence: { ...co("RESERVATION_MISMATCH").evidence, httpStatus: undefined } }, mk, rd(), lk()], "CREATE_VERIFICATION_WITHOUT_UNECHOED_REF"],
    [[start, ci, { ...co("RESERVATION_MISMATCH"), evidence: { ...co("RESERVATION_MISMATCH").evidence, outcome: "ambiguous" } }, mk, rd(), lk()], "CREATE_VERIFICATION_WITHOUT_UNECHOED_REF"],
    [[start, ci, { ...co("RESERVATION_MISMATCH"), evidence: { ...co("RESERVATION_MISMATCH").evidence, code: "UNEXPECTED_RESERVATION_STATUS" } }, mk, rd(), lk()], "CREATE_VERIFICATION_WITHOUT_UNECHOED_REF"],
    [[start, ci, { ...co("RESERVATION_MISMATCH"), transport: "TIMEOUT" }, mk, rd(), lk()], "CREATE_VERIFICATION_WITHOUT_UNECHOED_REF"],
    [[start, ci, { ...co("RESERVATION_MISMATCH"), evidence: { outcome: "conflict", code: "RESERVATION_MISMATCH", httpStatus: 200, mismatches: ["bookingRef"] } }, mk, rd(), lk()],
      "CREATE_VERIFICATION_WITHOUT_UNECHOED_REF"],                                                                       // outcome without an id
    [[start, ci, co("RESERVATION_MISMATCH"), { ...mk, reservationId: undefined }, rd(), lk()].map((e) => JSON.parse(JSON.stringify(e))), "CREATE_VERIFICATION_ID_NOT_BOUND"],   // missing marker id
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd("VERIFY_READ_IDENTITY_OK", 6), lk()], "CREATE_VERIFICATION_ID_NOT_BOUND"],       // read of another id
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd(), lk("VERIFY_LOOKUP_SAME_ID_IDENTITY_OK", null)], "CREATE_VERIFICATION_CONTRADICTORY"],   // success without an id
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd(), { ...lk(), ref: undefined }].map((e) => JSON.parse(JSON.stringify(e))), "CREATE_VERIFICATION_REF_NOT_BOUND"],
    // order and kind
    [[start, ci, co("RESERVATION_MISMATCH"), rd(), mk, lk()], "CREATE_VERIFICATION_OUT_OF_ORDER"],                      // read before marker
    [[start, ci, co("RESERVATION_MISMATCH"), lk(), mk, rd()], "CREATE_VERIFICATION_OUT_OF_ORDER"],                      // lookup before marker
    [[start, ci, co("RESERVATION_MISMATCH"), mk, lk(), rd()], "CREATE_VERIFICATION_OUT_OF_ORDER"],                      // lookup before read
    [[start, ci, co("RESERVATION_MISMATCH"), rc, mk, rd(), lk()], "CREATE_VERIFICATION_OUT_OF_ORDER"],                  // not contiguous
    [[start, ci, co("RESERVATION_MISMATCH"), mk, { ...rd(), kind: "lookup" }, lk()], "CREATE_VERIFICATION_OUT_OF_ORDER"],   // wrong kind
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd(), { ...lk(), kind: "read" }], "CREATE_VERIFICATION_OUT_OF_ORDER"],
    [[start, ci, co("RESERVATION_MISMATCH"), { ...mk, code: "VERIFY_READ_IDENTITY_OK" }, rd(), lk()], "CREATE_VERIFICATION_OUT_OF_ORDER"],   // a read code in the marker slot
    [[start, ci, co("RESERVATION_MISMATCH"), mk, mk, lk()], "CREATE_VERIFICATION_OUT_OF_ORDER"],                        // marker in the read slot
    // entries after a halt, or after later steps
    [[start, ci, co("RESERVATION_MISMATCH"), mk, hl("KV1_READ_VERIFY", "X"), rd(), lk()], "CREATE_VERIFICATION_AFTER_HALT"],
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd(), hl("KV1_READ_VERIFY", "X"), lk()], "CREATE_VERIFICATION_AFTER_HALT"],
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd(), { type: "side-effect-check", step: "K3_SIDE_EFFECTS_CREATE", code: "SIDE_EFFECTS_OK" }], "LATER_STEP_WITHOUT_VERIFIED_CREATE"],
    [[start, ci, co("RESERVATION_MISMATCH"), { type: "read", step: "K4_READBACK", kind: "read", code: "IDENTITY_OK", reservationId: 5 }], "LATER_STEP_WITHOUT_VERIFIED_CREATE"],
    // success codes contradicted by their own metadata
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd("VERIFY_READ_IDENTITY_OK", 5, { mismatches: ["status"] }), lk()], "CREATE_VERIFICATION_CONTRADICTORY"],
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd("VERIFY_READ_IDENTITY_OK", 5, { httpStatus: 500 }), lk()], "CREATE_VERIFICATION_CONTRADICTORY"],
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd("VERIFY_READ_IDENTITY_OK", 5, { transport: "TIMEOUT" }), lk()], "CREATE_VERIFICATION_CONTRADICTORY"],
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd("VERIFY_READ_IDENTITY_OK", 5, { httpStatus: undefined }), lk()].map((e) => JSON.parse(JSON.stringify(e))), "CREATE_VERIFICATION_CONTRADICTORY"],
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd(), { ...lk(), mismatches: ["status"] }], "CREATE_VERIFICATION_CONTRADICTORY"],
    [[start, ci, co("RESERVATION_MISMATCH"), { ...mk, mismatches: ["status"] }, rd(), lk()], "CREATE_VERIFICATION_CONTRADICTORY"],
    [[start, ci, co("RESERVATION_MISMATCH"), { ...mk, httpStatus: 200 }, rd(), lk()], "CREATE_VERIFICATION_CONTRADICTORY"],
    [[start, ci, co("RESERVATION_MISMATCH"), { ...mk, ref: REF }, rd(), lk()], "CREATE_VERIFICATION_CONTRADICTORY"],
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd("VERIFY_READ_UPSTREAM_5XX"), lk()], "CREATE_VERIFICATION_CONTRADICTORY"],   // lookup after a failed read
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd("VERIFY_READ_IDENTITY_MISMATCH", 5, { mismatches: undefined })].map((e) => JSON.parse(JSON.stringify(e))), "CREATE_VERIFICATION_CONTRADICTORY"],
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd(), lk(), xi, xo, lk()], "CREATE_VERIFICATION_DUPLICATED"],
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd("VERIFY_READ_IDENTITY_OK", 5, { httpStatus: 300 }), lk()], "CREATE_VERIFICATION_CONTRADICTORY"],
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd("VERIFY_READ_IDENTITY_MISMATCH", 5, { ref: REF })], "CREATE_VERIFICATION_CONTRADICTORY"],   // a ref on the read entry
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd(), lk("VERIFY_LOOKUP_ID_DIFFERS", 6)], "CREATE_VERIFICATION_ID_NOT_BOUND"],
    [[start, ci, co("RESERVATION_MISMATCH"), mk, rd(), lk("VERIFY_LOOKUP_IDENTITY_MISMATCH")], "CREATE_VERIFICATION_CONTRADICTORY"]
  ].map(([es, w]) => [es.map((e) => JSON.parse(JSON.stringify(e))), w]);
  for (const [es, want] of conflicts) {
    const c = K(es);
    assert.equal(c.ok, true); assert.equal(c.clean, false, want); assert.ok(c.conflicts.includes(want), `${want} in ${c.conflicts}`);
    assert.equal(c.createVerification.result, "NOT_VERIFIED", want);                    // never READ_ or REPLY_VERIFIED under a conflict
    const canon = (x) => (Array.isArray(x) ? `[${x.map(canon).join(",")}]` : x && typeof x === "object" ? `{${Object.keys(x).sort().map((k) => `${k}:${canon(x[k])}`).join(",")}}` : JSON.stringify(x));
    for (const e of es) assert.equal(canon(R.sanitizeJournalEntry(e, { steps: CONNECTED_STEPS })), canon(e), `fixture not sanitizer-valid: ${want} ${JSON.stringify(e)}`);
  }
  // unknown codes are reported as OTHER, never echoed
  assert.equal(K([start, ci, co("RESERVATION_MISMATCH"), mk, rd("VERIFY_READ_SOMETHING_NEW")]).createVerification.readVerify, "OTHER");
  // a KV entry of a write type is refused outright; a raw value in a KV entry fails the disk sanitizer
  assert.equal(K([start, ci, co("RESERVATION_MISMATCH"), { ...mk, type: "outcome", kind: "create" }]).ok, false);
  assert.equal(K([start, ci, co("RESERVATION_MISMATCH"), { ...mk, value: "MV-ABCDEF12" }]).code, "JOURNAL_ENTRY_NOT_SANITIZED");
  assert.equal(K([start, ci, co("RESERVATION_MISMATCH"), { ...mk, code: "create-ref-PROVIDER-TEXT" }]).code, "JOURNAL_ENTRY_NOT_SANITIZED");
  // the frozen old journal schema (no KV steps) still classifies exactly as before
  const old = K([start, ci, co("VERIFIED_CREATED")]);
  assert.equal(old.state, "CREATED_NO_CANCEL_ATTEMPT"); assert.equal(old.clean, true);
});

test("recovery of real producer journals: halt at KV1 / KV2 leaves CREATED_NO_CANCEL_ATTEMPT with the id; a READ_VERIFIED run classifies CANCEL_VERIFIED, clean", async () => {
  const v = validateConnectedManifest(manifest(), { now: NOW });
  const variants = [
    [{ reply: noRef }, "CANCEL_VERIFIED", "READ_VERIFIED", true],
    [{ reply: noRef, read: (w, n) => (n === 1 ? w.ok({ ...clone(w.res), status: "pending" }) : undefined) }, "CREATED_NO_CANCEL_ATTEMPT", "NOT_VERIFIED", true],
    [{ reply: noRef, lookup: (w, q) => w.ok([]) }, "CREATED_NO_CANCEL_ATTEMPT", "NOT_VERIFIED", true],
    [{ reply: noRef, lookup: (w, q) => (q.afterId !== undefined ? w.ok([]) : w.ok([{ ...clone(w.res), id: 91000078, hostawayReservationId: "91000078" }])) }, "CREATE_NOT_VERIFIED", "NOT_VERIFIED", false],   // two ids: conflict, no single id
    [{}, "CANCEL_VERIFIED", "REPLY_VERIFIED", true]
  ];
  for (const [over, state, result, clean] of variants) {
    const w = world(over);
    const { r, j } = await run(w);
    const c = RC.classifyConnectedJournal(j.entries, v.hash);
    assert.equal(c.ok, true, JSON.stringify(c));
    assert.equal(c.state, state, JSON.stringify(r.halt)); assert.equal(c.createVerification.result, result); assert.equal(c.clean, clean, String(c.conflicts));
    if (clean) assert.equal(c.reservationId, w.res.id);
    else { assert.ok(c.conflicts.includes("RESERVATION_IDS_INCONSISTENT")); assert.equal(c.reservationId, null); }
    assert.equal(r.createVerification.result, result);
    leakFree(c);
  }
});

// ---------- 10. pure adapter assessment ----------
test("adapter: customFieldRefShape and assessRefNotEchoed are pure, explicit and conservative", () => {
  const F = 105433;
  const sh = (cfv, present = true) => A.customFieldRefShape(present ? { customFieldValues: cfv } : {}, F);
  assert.equal(sh(undefined, false), "ABSENT_UNDEFINED"); assert.equal(sh(undefined), "ABSENT_UNDEFINED");
  assert.equal(sh(null), "ABSENT_NULL"); assert.equal(sh([]), "ABSENT_EMPTY_ARRAY");
  assert.equal(sh([{ customFieldId: 1 }]), "ABSENT_NO_OWN_ENTRY");
  assert.equal(sh([{ customFieldId: F }]), "PRESENT"); assert.equal(sh([{ customFieldId: F, value: "" }]), "PRESENT");
  // eslint-disable-next-line no-sparse-arrays
  for (const bad of ["x", {}, 0, false, [,], [null], [1], ["105433"], [[]], [{}], [{ id: F }], [{ customFieldId: "105433" }], [{ customFieldId: -1 }],
    [{ customFieldId: 2 ** 60 }], [{ customFieldId: 1, id: F }], [{ customFieldId: 1, id: "105433" }], [{ customFieldId: 1, customField: null }],
    [{ customFieldId: 1, customField: { id: F } }], [{ customFieldId: 1, customField: { id: "1" } }], [{ customFieldId: 1 }, Object.create({ customFieldId: 2 })]]) {
    assert.equal(sh(bad), "MALFORMED", JSON.stringify(bad));
  }
  assert.equal(A.customFieldRefShape(null, F), "MALFORMED"); assert.equal(A.customFieldRefShape({}, "105433"), "MALFORMED");
  const plan = { ref: "MV-ABCDEF12", listingId: L, arrivalDate: STAY.arrivalDate, departureDate: STAY.departureDate, guests: 2, guest: GUEST, totalMinor: TOTAL, currency: "MXN" };
  const res = { id: 5, listingMapId: L, channelId: 2000, arrivalDate: STAY.arrivalDate, departureDate: STAY.departureDate, totalPrice: 4400, currency: "MXN", status: "new" };
  const cfg = A.connectedTestAdapterConfig();
  const as = (result, httpStatus = 200) => A.assessRefNotEchoed({ httpStatus, json: { status: "success", result } }, plan, cfg);
  assert.deepEqual({ ...as(res) }, { eligible: true, code: "REF_NOT_ECHOED", shape: "ABSENT_UNDEFINED", reservationId: 5, status: "new" });
  assert.equal(as({ ...res, customFieldValues: [{ customFieldId: F, value: plan.ref }] }).code, "NOT_REF_ONLY_MISMATCH");   // a full reply: not this path
  assert.equal(as({ ...res, status: "pending" }).code, "ORIGINAL_STATUS_NOT_ACCEPTED");
  assert.equal(as({ ...res, customFieldValues: [{ customFieldId: F, value: "MV-ZZZZZZ99" }] }).code, "REF_PRESENT");
  assert.equal(as(res, 500).code, "NOT_REF_ONLY_MISMATCH");
  assert.equal(A.assessRefNotEchoed({ transportError: true }, plan, cfg).eligible, false);
  assert.ok(Object.isFrozen(as(res)));
  assert.deepEqual(A.ACCEPTED_CREATE_STATUSES, ["new"]);                // the accepted status set is NOT broadened
  for (const s of A.REF_ECHO_ABSENT_SHAPES) assert.ok(A.REF_ECHO_SHAPES.includes(s));
  // used only by the core runner (and defined in the adapter)
  const walk = (p) => readdirSync(join(ROOT, p), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === "node_modules" ? [] : walk(join(p, e.name))) : [join(p, e.name)]);
  const files = [...walk("api"), ...walk("lib"), ...walk("scripts"), ...walk("public")];
  assert.deepEqual(files.filter((f) => readFileSync(join(ROOT, f), "utf8").includes("assessRefNotEchoed")).sort(),
    ["lib/hostaway-reservations.js", "scripts/e4-connected/connected-path.mjs"]);
});

test("launcher summary: createVerification is an explicit allowlist; unknown values become OTHER; never raw values", () => {
  const S0 = X.createVerificationSummary;
  assert.deepEqual(S0(undefined), { path: "NONE", result: "NOT_VERIFIED", refEcho: null, refusal: null, readVerify: null, lookupVerify: null });
  assert.deepEqual(S0({ path: "READ_FALLBACK", result: "READ_VERIFIED", refEcho: "ABSENT_NULL", refusal: null, readVerify: "VERIFY_READ_IDENTITY_OK", lookupVerify: "VERIFY_LOOKUP_SAME_ID_IDENTITY_OK" }),
    { path: "READ_FALLBACK", result: "READ_VERIFIED", refEcho: "ABSENT_NULL", refusal: null, readVerify: "VERIFY_READ_IDENTITY_OK", lookupVerify: "VERIFY_LOOKUP_SAME_ID_IDENTITY_OK" });
  const bad = S0({ path: "PROVIDER-TEXT", result: "PASSED", refEcho: "MV-ABCDEF12", refusal: { x: 1 }, readVerify: "VERIFY_READ_PROVIDER", lookupVerify: 5 });
  assert.deepEqual(bad, { path: "OTHER", result: "OTHER", refEcho: "OTHER", refusal: "OTHER", readVerify: "OTHER", lookupVerify: "OTHER" });
  assert.equal(globalFetchCalls, 0);
});

test("end-to-end HTTP 201 create reply with an absent ref: READ_VERIFIED by the producer, and recovery classifies the real journal READ_VERIFIED / CANCEL_VERIFIED, clean", async () => {
  const v = validateConnectedManifest(manifest(), { now: NOW });
  const w = world({ createRaw: (wd) => { const x = clone(wd.res); delete x.customFieldValues; return { httpStatus: 201, json: { status: "success", result: x } }; } });
  const { r, j } = await run(w);
  createdOk(r);
  assert.equal(r.createVerification.result, "READ_VERIFIED"); assert.equal(r.createVerification.refEcho, "ABSENT_UNDEFINED");
  const co = j.entries.find((e) => e.type === "outcome" && e.kind === "create");
  assert.equal(co.evidence.httpStatus, 201); assert.deepEqual(co.evidence.mismatches, ["bookingRef"]);
  const c = RC.classifyConnectedJournal(j.entries, v.hash);
  assert.equal(c.ok, true); assert.equal(c.clean, true, String(c.conflicts)); assert.equal(c.state, "CANCEL_VERIFIED");
  assert.equal(c.createVerification.result, "READ_VERIFIED"); assert.equal(c.createOutcome.replyHttpStatus, 201);
  journalSafe(j);
});

test("end-to-end HTTP 201 on the KV1 read (parseReservationResponse accepts 200..299): READ_VERIFIED; recovery clean; a 3xx read still fails", async () => {
  const v = validateConnectedManifest(manifest(), { now: NOW });
  const w = world({ reply: noRef, read: (wd, n) => (n === 1 ? { httpStatus: 201, json: { status: "success", result: clone(wd.res) } } : undefined) });
  const { r, j } = await run(w);
  createdOk(r);
  assert.equal(r.createVerification.readVerify, "VERIFY_READ_IDENTITY_OK");
  assert.equal(j.entries.find((e) => e.step === "KV1_READ_VERIFY" && e.code === "VERIFY_READ_IDENTITY_OK").httpStatus, 201);
  const c = RC.classifyConnectedJournal(j.entries, v.hash);
  assert.equal(c.clean, true, String(c.conflicts)); assert.equal(c.createVerification.result, "READ_VERIFIED"); assert.equal(c.state, "CANCEL_VERIFIED");
  const w2 = world({ reply: noRef, read: (wd, n) => (n === 1 ? { httpStatus: 302, json: { status: "success", result: clone(wd.res) } } : undefined) });
  const { r: r2 } = await run(w2);
  assert.deepEqual([r2.halt.step, r2.halt.code], ["KV1_READ_VERIFY", "VERIFY_READ_UNEXPECTED_HTTP_STATUS"]); assert.deepEqual(r2.writes, { create: 1, cancel: 0 });
});
