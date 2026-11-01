// E4 connected-listing runner (scripts/e4-connected/connected-path.mjs) — OFFLINE ONLY. Synthetic in-memory "world"
// (NOT provider evidence), injected transport/journal/operator checkpoint, virtual clock. The global fetch is a throwing
// spy that must never be called. All dates/amounts/guest values below are synthetic test values, not live defaults.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";

let globalFetchCalls = 0;
globalThis.fetch = () => { globalFetchCalls++; throw new Error("global fetch must not be used"); };
const C = await import("../scripts/e4-connected/connected-path.mjs");
const A = await import("../lib/hostaway-reservations.js");
const R = await import("../scripts/e4-write-runner/runner.mjs");
const H = await import("../scripts/e4-write-runner/happy-path.mjs");
const { validateConnectedManifest, connectedManifestTemplate, planConnectedRun, executeConnectedRun, assertConnectedRequest, stayNights,
  CONNECTED_STEPS, CONNECTED_SOURCES, CONNECTED_AIRBNB_LISTING_ID, CONNECTED_EXECUTION_WIRED, CONNECTED_SYNC } = C;

const ROOT = new URL("..", import.meta.url).pathname;
const NOW = () => new Date("2026-11-01T18:00:00.000Z");
const L = 603566;
const SHA = "c".repeat(40);
const GUEST = { firstName: "Synthetic", lastName: "Tester", email: "e4-synthetic@example.invalid" };
const STAY = { arrivalDate: "2027-04-05", departureDate: "2027-04-07" };
const TOTAL = 440000;                                       // synthetic MXN 4,400.00
const manifest = (over = {}) => ({ ...connectedManifestTemplate(), guests: 2, totalMinor: TOTAL, window: { start: "2027-04-01", end: "2027-04-20" },
  stay: { ...STAY }, guest: { ...GUEST }, reviewedCommit: SHA, ...over });
const LEAKS = ["Synthetic", "Tester", "example.invalid", "PROVIDER-TEXT", "MESSAGE-BODY", "98765-603566"];
const leakFree = (o) => { const s = JSON.stringify(o); for (const x of LEAKS) assert.ok(!s.includes(x), `leak: ${x}`); };

// ---------- synthetic world ----------
function world(over = {}) {
  const w = { res: null, log: [], calendar: "available", calReads: 0, nextId: 91000001, conversations: over.conversations ?? ((id) => [{ id: 7701, reservationId: id, lastMessage: "MESSAGE-BODY" }]),
    tasks: over.tasks ?? (() => []), charges: over.charges ?? (() => []), price: over.price ?? 4400 };
  const ok = (result, extra = {}) => ({ httpStatus: 200, json: { status: "success", result: JSON.parse(JSON.stringify(result)), ...extra } });
  w.handle = (method, path, q, body) => {
    w.log.push(`${method} ${path}`);
    if (method === "POST" && path === `/listings/${L}/calendar/priceDetails`) return over.priceReply ? over.priceReply() : ok({ totalPrice: w.price });
    if (method === "GET" && path === "/reservations") {
      if (q.afterId !== undefined) return ok([]);
      return ok(w.res && w.res.arrivalDate === q.arrivalStartDate ? [w.res] : []);
    }
    if (method === "POST" && path === "/reservations") {
      if (over.createReply) return over.createReply(w, body);
      w.res = { id: w.nextId, hostawayReservationId: String(w.nextId), listingMapId: body.listingMapId, channelId: body.channelId, reservationId: "98765-603566-2000-1",
        arrivalDate: body.arrivalDate, departureDate: body.departureDate, totalPrice: body.totalPrice, currency: body.currency, status: "new",
        guestName: body.guestName, guestEmail: body.guestEmail, hostNote: "PROVIDER-TEXT", customFieldValues: body.customFieldValues };
      w.calendar = over.blockOnCreate === false ? "available" : "reserved";
      return ok(w.res);
    }
    if (method === "GET" && w.res && path === `/reservations/${w.res.id}`) return over.readHook?.(w) ?? ok(w.res);
    if (method === "GET" && path === "/guestPayments/charges") { const c = w.charges(w.res.id); return ok(c, { count: c.length }); }
    if (method === "GET" && (path === "/conversations" || path === "/tasks")) {
      const list = (path === "/conversations" ? w.conversations : w.tasks)(w.res.id);
      return ok(list.slice(Number(q.offset), Number(q.offset) + Number(q.limit)));
    }
    if (method === "GET" && path === `/listings/${L}/calendar`) {
      w.calReads++;
      const st = over.calendarState ? over.calendarState(w) : w.calendar;
      return ok(stayNights(STAY).map((date) => ({ date, status: st, isAvailable: st === "available" ? 1 : 0 })));
    }
    if (method === "PUT" && w.res && path === `/reservations/${w.res.id}/statuses/cancelled`) {
      if (over.cancelReply) return over.cancelReply(w);
      w.res.status = "cancelled"; w.calendar = over.reopenOnCancel === false ? "reserved" : "available";
      return ok(w.res);
    }
    return { httpStatus: 404, json: { status: "fail", result: "PROVIDER-TEXT" } };
  };
  w.transport = { send: async (req) => { const r = w.handle(req.method, req.path, req.query ?? {}, req.body); return r === "throw" ? Promise.reject(new Error("x")) : r; } };
  return w;
}
const memJournal = (boundHash, failOn) => { const es = []; return { durable: true, boundHash, entries: es, load: () => es.map((e) => JSON.parse(JSON.stringify(e))),
  append: (e) => { if (failOn && failOn(e)) throw new Error("disk"); es.push(JSON.parse(JSON.stringify(e))); } }; };
const S = { intervalMs: 1000, timeoutMs: 7000000, maxReads: 12, confirmReads: 2 };
function vclock() {
  let t = 0;
  return { clock: () => t, startTimer: (ms) => ms === S.intervalMs
    ? { promise: Promise.resolve().then(() => { t += ms; }), cancel() {} } : { promise: new Promise(() => {}), cancel() {} } };
}
// Operator checkpoint: what the operator would attest after checking Airbnb's own calendar (synthetic here).
const airbnbFrom = (w, over = {}) => async ({ stage }) => (over[stage] !== undefined ? (typeof over[stage] === "function" ? over[stage]() : over[stage])
  : w.calendar === "available" ? "open" : "blocked");
async function run(w, { m = manifest(), journal, checkpoint, extra = {} } = {}) {
  const v = validateConnectedManifest(m, { now: NOW });
  assert.ok(v.ok, JSON.stringify(v));
  const j = journal ?? memJournal(v.hash);
  const stages = [];
  const cp = checkpoint ?? airbnbFrom(w);
  const r = await executeConnectedRun({ mode: "execute", manifest: m, confirm: v.confirmToken, reviewedCommit: SHA, transport: w.transport, journal: j,
    now: NOW, airbnbCheckpoint: async (x) => { stages.push(x.stage); return cp(x); }, sync: S, timeoutMs: 50, ...vclock(), ...extra });
  return { r, j, w, stages, v };
}
const writes = (w) => w.log.filter((l) => l.startsWith("POST /reservations") || l.startsWith("PUT "));

// ---------- manifest ----------
test("template: fixed listing/Airbnb/channel/currency; every owner input is a placeholder; no dates are defaulted", () => {
  const t = connectedManifestTemplate();
  assert.deepEqual([t.listingId, t.airbnbListingId, t.channelId, t.currency, t.refFieldId], [603566, "1798070853315176756", 2000, "MXN", R.E4_REF_FIELD_ID]);
  const v = validateConnectedManifest(t, { now: NOW });
  assert.equal(v.ok, false);
  assert.deepEqual(v.blockers.sort(), ["guest.email", "guest.firstName", "guest.lastName", "guests", "reviewedCommit", "stay.arrivalDate", "stay.departureDate",
    "totalMinor", "window.end", "window.start"].map((p) => `OWNER_INPUT_REQUIRED:${p}`).sort());
  assert.ok(!/20\d\d-\d\d-\d\d/.test(JSON.stringify(t)), "no date in the template");
  assert.equal(planConnectedRun(t, { now: NOW }).ok, false);
});

test("fixed fields cannot be changed: other listing (603564, 606998, 70636076-style ids), currency, Airbnb mapping, channel, ref field", () => {
  for (const [k, v] of [["listingId", 603564], ["listingId", 606998], ["listingId", 70636076], ["currency", "USD"], ["airbnbListingId", "1798047712926775907"],
    ["channelId", 2005], ["refFieldId", 1], ["manifestVersion", "e4-happy-manifest-v1"]]) {
    const r = validateConnectedManifest(manifest({ [k]: v }), { now: NOW });
    assert.deepEqual([r.ok, r.errors], [false, [`FIXED_VALUE_MISMATCH:${k}`]], `${k}=${v}`);
  }
  assert.deepEqual(validateConnectedManifest({ ...manifest(), extra: 1 }, { now: NOW }).errors, ["UNKNOWN_FIELD:extra"]);
  assert.ok(validateConnectedManifest({ ...manifest(), guest: { ...GUEST, forceOverbooking: true } }, { now: NOW }).errors.includes("FORCE_OVERBOOKING_REFUSED"));
  assert.deepEqual(validateConnectedManifest(manifest(), {}).errors, ["CLOCK_REQUIRED"]);
});

test("owner inputs are validated: far-future window, stay inside it, guests, amount, code binding, guest", () => {
  const bad = (over, code) => assert.ok(validateConnectedManifest(manifest(over), { now: NOW }).errors.includes(code), code);
  bad({ window: { start: "2026-12-01", end: "2026-12-20" }, stay: { arrivalDate: "2026-12-05", departureDate: "2026-12-07" } }, "WINDOW_NOT_FAR_FUTURE");
  bad({ stay: { arrivalDate: "2027-03-30", departureDate: "2027-04-02" } }, "OUTSIDE_WINDOW:stay");
  bad({ stay: { arrivalDate: "2027-04-02", departureDate: "2027-04-12" } }, "RANGE_TOO_LONG:stay");
  bad({ stay: { arrivalDate: "2027-04-07", departureDate: "2027-04-05" } }, "DEPARTURE_NOT_AFTER_ARRIVAL:stay");
  for (const g of [0, 3, 1.5, "2"]) bad({ guests: g }, "GUESTS_INVALID");
  for (const t of [0, -1, 1.5, "440000", 100000000]) bad({ totalMinor: t }, "TOTAL_MINOR_INVALID");
  for (const c of ["abc", "C".repeat(40), "c".repeat(39)]) bad({ reviewedCommit: c }, "REVIEWED_COMMIT_INVALID");
  bad({ guest: { ...GUEST, email: "nope" } }, "GUEST_OR_PLAN_INVALID:GUEST_EMAIL_INVALID");
  const a = validateConnectedManifest(manifest(), { now: NOW }), b = validateConnectedManifest(manifest({ reviewedCommit: "d".repeat(40) }), { now: NOW });
  assert.ok(a.ok && b.ok && a.hash !== b.hash && a.confirmToken.startsWith("E4-CONNECTED-"), "the hash binds the reviewed commit");
});

test("dry run: zero network, not wired, nights listed, guest not shown", () => {
  const p = planConnectedRun(manifest(), { now: NOW });
  assert.deepEqual([p.ok, p.network, p.executionWired, p.stay.nights, p.stay.currency, p.stay.listingId, p.stay.airbnbListingId],
    [true, "none", false, ["2027-04-05", "2027-04-06"], "MXN", 603566, CONNECTED_AIRBNB_LISTING_ID]);
  assert.equal(CONNECTED_EXECUTION_WIRED, false);
  leakFree(p);
});

test("prerequisites refuse with zero requests (token, code binding, journal, checkpoint, timers)", async () => {
  const v = validateConnectedManifest(manifest(), { now: NOW });
  const base = () => { const w = world(); return { w, o: { mode: "execute", manifest: manifest(), confirm: v.confirmToken, reviewedCommit: SHA, transport: w.transport,
    journal: memJournal(v.hash), now: NOW, airbnbCheckpoint: async () => "open", ...vclock() } }; };
  for (const [name, mut, code] of [["token", (o) => { o.confirm = "E4-CONNECTED-000000000000"; }, "CONFIRM_TOKEN_MISMATCH"],
    ["commit", (o) => { o.reviewedCommit = "d".repeat(40); }, "REVIEWED_COMMIT_NOT_BOUND"],
    ["durable", (o) => { o.journal.durable = false; }, "JOURNAL_NOT_DURABLE"], ["bound", (o) => { o.journal.boundHash = "x"; }, "JOURNAL_NOT_BOUND_TO_MANIFEST"],
    ["non-empty", (o) => { o.journal.append({ type: "run-start" }); }, "JOURNAL_NOT_EMPTY"], ["checkpoint", (o) => { delete o.airbnbCheckpoint; }, "AIRBNB_CHECKPOINT_MISSING"],
    ["timers", (o) => { delete o.startTimer; }, "TIMERS_MISSING"], ["mode", (o) => { o.mode = "dry-run"; }, "MODE_NOT_EXECUTE"]]) {
    const { w, o } = base(); mut(o);
    const r = await executeConnectedRun(o);
    assert.deepEqual([r.status, r.requests, r.prerequisites.includes(code), w.log.length], ["REFUSED", 0, true, 0], name);
  }
});

// ---------- the run ----------
test("full run: price -> clear -> calendar open -> Airbnb open -> ONE create -> side effects -> blocked (both) -> ONE cancel -> reopened (both)", async () => {
  const { r, j, w, stages } = await run(world());
  assert.deepEqual([r.status, r.passed, r.syncProven, r.halt, r.writes], ["COMPLETED", true, true, null, { create: 1, cancel: 1 }]);
  assert.deepEqual(writes(w), ["POST /reservations", `PUT /reservations/${w.res.id}/statuses/cancelled`]);
  assert.ok(w.log.indexOf("POST /reservations") > w.log.indexOf(`POST /listings/${L}/calendar/priceDetails`), "price before create");
  assert.equal(w.log[w.log.indexOf(writes(w)[1]) - 1], `GET /reservations/${w.res.id}`, "fresh read immediately before the cancel");
  assert.deepEqual(stages, ["before-create", "after-create", "after-cancel"]);
  assert.deepEqual([r.commandReply, r.finalState], [{ code: "VERIFIED_CANCELLED", httpStatus: 200 }, { code: "IDENTITY_OK", status: "cancelled", identityOk: true }]);
  assert.deepEqual([r.sideEffectsCreate.ok, r.sideEffectsCreate.conversations.ids, r.sideEffectsCancel.ok], [true, [7701], true]);
  assert.deepEqual([r.evidence.hostawayBlocked.code, r.evidence.airbnbBlocked, r.evidence.hostawayReopened.code, r.evidence.airbnbReopened],
    ["OBSERVED_STABLE", "blocked", "OBSERVED_STABLE", "open"]);
  assert.equal(j.entries.filter((e) => e.type === "intent").length, 2);
  const iCreate = j.entries.findIndex((e) => e.type === "intent" && e.step === "KW1_CREATE");
  assert.ok(iCreate > 0 && j.entries[iCreate + 1].type === "outcome", "write-ahead intent immediately before its outcome");
  assert.deepEqual(j.entries.filter((e) => e.step?.startsWith("A")).map((e) => e.code), ["AIRBNB_ATTESTED_OPEN", "AIRBNB_ATTESTED_BLOCKED", "AIRBNB_ATTESTED_OPEN"]);
  assert.equal(j.entries.at(-1).code, "COMPLETED");
  leakFree(r); leakFree(j.entries);
  assert.equal(globalFetchCalls, 0);
});

test("no write unless everything before it is clean: price, clear, Hostaway calendar, Airbnb attestation", async () => {
  const cases = [
    ["price differs", { price: 4400.5 }, {}, "PREFLIGHT_TOTAL_MISMATCH"],
    ["price unreadable", { priceReply: () => ({ httpStatus: 503, json: {} }) }, {}, "PRICE_HTTP_NOT_OK"],
    ["calendar not open", { calendarState: () => "blocked" }, {}, "CALENDAR_NOT_OPEN_BEFORE"],
    ["Airbnb attested blocked", {}, { "before-create": "blocked" }, "AIRBNB_NOT_ATTESTED_OPEN_BEFORE"],
    ["Airbnb unknown", {}, { "before-create": "maybe" }, "AIRBNB_NOT_ATTESTED_OPEN_BEFORE"],
    ["Airbnb checkpoint throws", {}, { "before-create": () => { throw new Error("x"); } }, "AIRBNB_NOT_ATTESTED_OPEN_BEFORE"]
  ];
  for (const [name, wo, cpo, code] of cases) {
    const w = world(wo);
    const { r } = await run(w, { checkpoint: airbnbFrom(w, cpo) });
    assert.deepEqual([r.status, r.halt.code, writes(w).length, r.passed], ["HALTED", code, 0, false], name);
  }
  // a reservation already on the arrival date (any reservation, not only ours) blocks the create
  const w = world(); w.res = { id: 5, hostawayReservationId: "5", listingMapId: L, channelId: 2000, arrivalDate: STAY.arrivalDate, departureDate: STAY.departureDate,
    totalPrice: 1, currency: "MXN", status: "new", customFieldValues: [] };
  const { r } = await run(w);
  assert.deepEqual([r.halt.step, r.halt.code, writes(w).length], ["K1_CLEAR", "PREFLIGHT_NOT_CLEAR", 0]);
});

test("ambiguous or unverified create: HALTED, never a cancel or second create; read-only reconciliation", async () => {
  for (const [name, createReply] of [["5xx", () => ({ httpStatus: 503, json: {} })], ["transport", () => "throw"],
    ["other listing in reply", (w, b) => ({ httpStatus: 200, json: { status: "success", result: { id: 1, listingMapId: 603564, channelId: 2000, arrivalDate: b.arrivalDate,
      departureDate: b.departureDate, totalPrice: b.totalPrice, currency: "MXN", status: "new", customFieldValues: b.customFieldValues } } })]]) {
    const w = world({ createReply });
    const { r, j } = await run(w);
    assert.equal(writes(w).length, 1, name);
    assert.deepEqual([r.status, r.halt.step, r.writes.cancel, r.passed], ["HALTED", "KW1_CREATE", 0, false], name);
    assert.equal(r.reconcile.length, 1, name);
    assert.ok(w.log.slice(w.log.indexOf("POST /reservations") + 1).every((l) => l.startsWith("GET ")), `${name}: reads only after`);
    assert.equal(j.entries.at(-1).code, "HALTED");
  }
});

test("side effects after create are a safety gate: anything but charges zero / one conversation / no task halts before the cancel", async () => {
  for (const [name, over, code] of [["two conversations", { conversations: (id) => [{ id: 1, reservationId: id }, { id: 2, reservationId: id }] }, "MORE_THAN_ONE_CONVERSATION"],
    ["no conversation", { conversations: () => [] }, "EXPECTED_CONVERSATION_ABSENT"], ["a task", { tasks: (id) => [{ id: 3, reservationId: id }] }, "TASKS_PRESENT"],
    ["a charge", { charges: (id) => [{ id: 4, reservationId: id }] }, "CHARGES_PRESENT"]]) {
    const w = world(over);
    const { r } = await run(w);
    assert.deepEqual([r.status, r.halt.step, r.halt.code, r.writes.cancel], ["HALTED", "K3_SIDE_EFFECTS_CREATE", code, 0], name);
  }
});

test("sync evidence never blocks the single cleanup cancel and never passes on its own", async () => {
  // Hostaway calendar never blocks and the operator never sees Airbnb blocked: still exactly one cancel; COMPLETED but not passed
  let w = world({ blockOnCreate: false });
  let { r } = await run(w, { checkpoint: airbnbFrom(w, { "after-create": "open" }) });
  assert.deepEqual([r.status, r.passed, r.syncProven, r.evidence.hostawayBlocked.code, r.evidence.airbnbBlocked, writes(w).length],
    ["COMPLETED", false, false, "READ_CAP_REACHED", "open", 2]);
  assert.equal(r.evidence.hostawayBlocked.reads, S.maxReads, "bounded observation");
  // calendar never reopens after the cancel: not passed, no extra write
  w = world({ reopenOnCancel: false });
  ({ r } = await run(w));
  assert.deepEqual([r.status, r.passed, r.evidence.hostawayReopened.code, r.evidence.airbnbReopened, writes(w).length], ["COMPLETED", false, "READ_CAP_REACHED", "blocked", 2]);
  // delayed blocking (3rd read) is observed within the bound
  w = world({ calendarState: (w2) => (w2.res && w2.res.status === "new" && w2.calReads >= 4 ? "reserved" : "available") });
  ({ r } = await run(w));
  assert.deepEqual([r.evidence.hostawayBlocked.code, r.passed], ["OBSERVED_STABLE", true]);
});

test("cancel reply is strict: a mismatching reply HALTS with field names; final state, side effects and calendar are still observed read-only", async () => {
  const w = world({ cancelReply: (w2) => { w2.res.status = "cancelled"; w2.calendar = "available"; const { customFieldValues, ...rest } = w2.res;
    return { httpStatus: 200, json: { status: "success", result: rest } }; } });
  const { r, j } = await run(w);
  assert.deepEqual([r.status, r.passed, r.halt.code, r.halt.mismatches, r.commandReply], ["HALTED", false, "CANCEL_RESPONSE_MISMATCH", ["bookingRef"],
    { code: "CANCEL_RESPONSE_MISMATCH", httpStatus: 200, mismatches: ["bookingRef"] }]);
  assert.deepEqual(r.finalState, { code: "IDENTITY_OK", status: "cancelled", identityOk: true });
  assert.deepEqual([r.sideEffectsCancel.ok, r.evidence.hostawayReopened.code, r.evidence.airbnbReopened], [true, "OBSERVED_STABLE", "open"]);
  assert.equal(writes(w).length, 2, "exactly one create and one cancel");
  assert.deepEqual(j.entries.find((e) => e.type === "outcome" && e.step === "KW2_CANCEL").mismatches, ["bookingRef"]);
  // transport-uncertain cancel reply: one PUT, reads only afterwards, never a retry
  const w2 = world({ cancelReply: () => "throw" });
  const t = await run(w2);
  assert.deepEqual([writes(w2).length, t.r.status, t.r.halt.step, t.r.passed], [2, "HALTED", "KW2_CANCEL", false]);
  assert.ok(w2.log.slice(w2.log.indexOf(writes(w2)[1]) + 1).every((l) => l.startsWith("GET ")));
});

test("journal: a non-durable write-ahead intent sends nothing", async () => {
  const w = world();
  const v = validateConnectedManifest(manifest(), { now: NOW });
  const { r } = await run(w, { journal: memJournal(v.hash, (e) => e.type === "intent") });
  assert.deepEqual([r.status, r.halt.code, writes(w).length], ["HALTED", "JOURNAL_WRITE_FAILED", 0]);
});

// ---------- allowlist, adapter profile, containment ----------
test("allowlist: 603566 only; reads/cancel only of an id this run verified; exact calendar range; no other listing, reservation or method", () => {
  const st = { readableIds: new Set([91000001]), cancellableId: 91000001, calendar: { startDate: "2027-04-05", endDate: "2027-04-06" } };
  const refused = (req, wk) => assert.throws(() => assertConnectedRequest(req, st, wk), (e) => e instanceof R.RunnerError, JSON.stringify(req));
  const body = { channelId: 2000, listingMapId: L, arrivalDate: "2027-04-05", departureDate: "2027-04-07", totalPrice: 4400, currency: "MXN" };
  assert.equal(assertConnectedRequest({ method: "POST", path: "/reservations", query: {}, body }, st, "create"), "create");
  assert.equal(assertConnectedRequest({ method: "PUT", path: "/reservations/91000001/statuses/cancelled", query: {}, body: { cancelledBy: "host" } }, st, "cancel"), "cancel");
  assert.equal(assertConnectedRequest({ method: "GET", path: `/listings/${L}/calendar`, query: { startDate: "2027-04-05", endDate: "2027-04-06" } }, st), "read");
  refused({ method: "POST", path: "/reservations", query: {}, body: { ...body, listingMapId: 603564 } }, "create");
  refused({ method: "POST", path: "/reservations", query: {}, body: { ...body, listingMapId: 606998 } }, "create");
  refused({ method: "POST", path: "/reservations", query: {}, body: { ...body, currency: "USD" } }, "create");
  refused({ method: "POST", path: "/reservations", query: {}, body: { ...body, forceOverbooking: true } }, "create");
  refused({ method: "POST", path: "/reservations", query: {}, body }, null);
  refused({ method: "GET", path: "/reservations/70636076", query: { includeResources: 1 } });
  refused({ method: "PUT", path: "/reservations/70636076/statuses/cancelled", query: {}, body: { cancelledBy: "host" } }, "cancel");
  refused({ method: "PUT", path: "/reservations/91000002/statuses/cancelled", query: {}, body: { cancelledBy: "host" } }, "cancel");
  refused({ method: "DELETE", path: "/reservations/91000001", query: {} });
  refused({ method: "GET", path: "/listings/603564/calendar", query: { startDate: "2027-04-05", endDate: "2027-04-06" } });
  refused({ method: "GET", path: `/listings/${L}/calendar`, query: { startDate: "2027-04-01", endDate: "2027-04-30" } });
  refused({ method: "POST", path: "/listings/603564/calendar/priceDetails", query: {}, body: { version: 2 } });
  refused({ method: "GET", path: "/reservations", query: { listingId: 603564, channelId: 2000 } });
  refused({ method: "GET", path: "/conversations", query: { reservationId: 70636076, limit: 100, offset: 0 } });
  refused({ method: "GET", path: "/conversations/7701/messages", query: {} });
  refused({ method: "GET", path: "/guestPayments/charges", query: { reservationId: 91000001, limit: 100, offset: 100 } });
});

test("adapter: only a MINTED connected config can address 603566; plain objects and every default config still reject BOTH pilots; 603564 never", () => {
  const code = (f) => { try { f(); return "NO_THROW"; } catch (e) { return e.code; } };
  const minted = A.connectedTestAdapterConfig();
  assert.equal(A.validateAdapterConfig(minted), minted);
  assert.deepEqual([...minted.allowedListingIds], [603566]);
  assert.ok(Object.isFrozen(minted) && Object.isFrozen(minted.allowedListingIds));
  assert.equal(code(() => A.validateAdapterConfig({ ...minted, allowedListingIds: [...minted.allowedListingIds] })), "PILOT_LISTING_FORBIDDEN", "a plain copy is refused");
  assert.equal(code(() => A.validateAdapterConfig(JSON.parse(JSON.stringify(minted)))), "PILOT_LISTING_FORBIDDEN");
  for (const ids of [[603564], [603566], [606998, 603566]]) assert.equal(code(() => A.validateAdapterConfig({ ...R.ADAPTER_CFG, allowedListingIds: ids })), "PILOT_LISTING_FORBIDDEN");
  const plan = (listingId, currency = "MXN") => ({ ref: "MV-ABCDEF12", listingId, arrivalDate: "2027-04-05", departureDate: "2027-04-07", guests: 2, guest: GUEST, totalMinor: TOTAL, currency });
  assert.equal(A.buildCreateReservationRequest(plan(603566), minted).body.listingMapId, 603566);
  assert.equal(code(() => A.buildCreateReservationRequest(plan(603564), minted)), "PILOT_LISTING_FORBIDDEN");
  assert.equal(code(() => A.buildCreateReservationRequest(plan(606998), minted)), "LISTING_NOT_ALLOWED");
  assert.equal(code(() => A.buildCreateReservationRequest(plan(603566, "USD"), minted)), "CURRENCY_MISMATCH");
  assert.equal(code(() => A.buildCreateReservationRequest(plan(603566, "USD"), R.ADAPTER_CFG)), "PILOT_LISTING_FORBIDDEN", "the default E4 config still refuses 603566");
  assert.deepEqual(A.FORBIDDEN_PILOT_LISTING_IDS, [603564, 603566]);
  assert.equal(A.CONNECTED_TEST_REF_FIELD_ID, R.E4_REF_FIELD_ID);
  // the default runner gate and the happy path still refuse the pilot
  assert.throws(() => R.assertAllowedRequest({ method: "POST", path: "/listings/603566/calendar/priceDetails", query: {} }, { readableIds: new Set() }, null), (e) => e.code === "REQUEST_NOT_ALLOWLISTED");
  const hm = H.validateHappyManifest({ manifestVersion: H.HAPPY_MANIFEST_VERSION, listingId: 603566, refFieldId: R.E4_REF_FIELD_ID, currency: "USD", nightlyMinor: R.E4_NIGHTLY_MINOR,
    cleaningFeeMinor: R.E4_CLEANING_FEE_MINOR, guests: R.E4_GUESTS, window: { start: "2027-04-01", end: "2027-04-20" }, stay: STAY, guest: GUEST }, { now: NOW });
  assert.ok(hm.errors.includes("PILOT_LISTING_FORBIDDEN"));
});

test("containment: no I/O of its own; nothing imports it; the minted config and the gate allowlist hook have exactly one user", () => {
  const src = readFileSync(join(ROOT, "scripts/e4-connected/connected-path.mjs"), "utf8");
  for (const re of [/process\.env/, /console\./, /fetch\(/, /node:fs|node:child_process|node:net|node:https?/, /readFileSync|writeFileSync|createFileJournal/,
    /promptHostawayCredentials|createHostawayTransport/]) assert.doesNotMatch(src, re, String(re));
  const walk = (p) => readdirSync(join(ROOT, p), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === "node_modules" ? [] : walk(join(p, e.name))) : [join(p, e.name)]);
  const files = [...walk("api"), ...walk("lib"), ...walk("scripts"), ...walk("public")];
  const users = (re) => files.filter((f) => re.test(readFileSync(join(ROOT, f), "utf8"))).map((f) => f.replace(/\\/g, "/")).sort();
  assert.deepEqual(users(/(from\s*|import\s*\(\s*)["'][^"']*connected-path/), [], "nothing deployable or runnable imports the connected runner");
  assert.deepEqual(users(/connectedTestAdapterConfig/), ["lib/hostaway-reservations.js", "scripts/e4-connected/connected-path.mjs"]);
  assert.deepEqual(users(/allowRequest:/), ["scripts/e4-connected/connected-path.mjs"]);
  assert.equal(CONNECTED_EXECUTION_WIRED, false);
  assert.ok(readFileSync(join(ROOT, ".vercelignore"), "utf8").split("\n").includes("/scripts"));
});

test("provenance metadata: CONNECTED_SOURCES is exactly the static import closure (local files), nothing missing or extra", () => {
  const seen = new Set();
  const walk = (f) => {
    if (seen.has(f)) return; seen.add(f);
    for (const m of readFileSync(join(ROOT, f), "utf8").matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)) {
      if (m[1].startsWith(".")) walk(relative(ROOT, resolve(dirname(join(ROOT, f)), m[1])).replace(/\\/g, "/"));
      else assert.match(m[1], /^node:(crypto|fs|path|url|child_process)$/, `external import ${m[1]} in ${f}`);
    }
  };
  walk("scripts/e4-connected/connected-path.mjs");
  assert.deepEqual([...seen].sort(), [...CONNECTED_SOURCES].sort());
  assert.equal(new Set(CONNECTED_SOURCES).size, CONNECTED_SOURCES.length);
  assert.deepEqual(Object.keys(CONNECTED_STEPS).filter((k) => CONNECTED_STEPS[k].writes).sort(), ["KW1_CREATE", "KW2_CANCEL"]);
  assert.deepEqual(CONNECTED_SYNC, { intervalMs: 10000, timeoutMs: 120000, maxReads: 12, confirmReads: 2 });
});
