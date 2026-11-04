// Stage E7 guest notification STAGE 2 — pure request module + OFFLINE notification step against a SCRIPTED in-memory pool.
// No database, no network (global fetch guard), no real transport. Every address is a synthetic `.invalid` test address; the injected
// sink records requests IN MEMORY only and nothing here prints a recipient, name, subject, body, reply or error detail.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { TEMPLATES, REQUEST_KEYS, formatUsd, buildMessageRequest, canonical, contentHash, recipientHash, classifyReply } from "../lib/checkout/guest-notification.js";
import { notificationWorkerGate, runNotificationStep, NOTIFICATION_LIMITS, NOTIFICATION_OPTION_KEYS } from "../lib/booking-db/notification-worker.js";

let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline Stage 2 suite)"); };
after(() => { globalThis.fetch = realFetch; assert.equal(netAttempts, 0, "no network attempt"); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OP = "00000000-0000-4000-8000-000000000001";
const INTENT = "00000000-0000-4000-8000-0000000000a1";
const SENDER = Object.freeze({ fromAddress: "bookings@sender.mv-test.invalid", fromName: "maraVilla Test" });
const GUEST = Object.freeze({ email: "guest.v@mv-test.invalid", firstName: "Synthia" });
const facts = (t, over = {}) => ({ v: 1, template: t, ref: "MV-ABC123", checkIn: "2026-12-04", checkOut: "2026-12-06", nights: 2, guests: 2, totalMinor: 123456, currency: "USD", ...over });
const build = (t, over = {}) => buildMessageRequest({ template: t, facts: facts(t), guest: { ...GUEST }, sender: { ...SENDER }, opId: OP, ...over });
const ENV = Object.freeze({ VERCEL_ENV: "development", MV_E7_NOTIFICATION_WORKER: "enabled" });

// ---------------------------------------------------------------------------------------------
// pure module

test("formatUsd: integer minor units only, USD suffix, thousands separators", () => {
  assert.equal(formatUsd(1), "$0.01 USD");
  assert.equal(formatUsd(100), "$1.00 USD");
  assert.equal(formatUsd(123456), "$1,234.56 USD");
  assert.equal(formatUsd(100000000), "$1,000,000.00 USD");
  for (const bad of [0, -1, 1.5, "100", null, undefined, NaN, Infinity, 2 ** 53, 10n]) assert.equal(formatUsd(bad), null);
});

test("request: exact keys, deep-frozen, bound recipient, messageRef, English mock copy for all 3 templates", () => {
  for (const t of TEMPLATES) {
    const r = build(t);
    assert.equal(r.ok, true);
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r.request));
    assert.deepEqual(Object.keys(r.request).sort(), [...REQUEST_KEYS]);
    assert.equal(r.request.to, GUEST.email);
    assert.equal(r.request.from, SENDER.fromAddress);
    assert.equal(r.request.messageRef, `gn1-${OP}`);
    assert.equal(r.request.templateVersion, "gn-v1");
    assert.equal(r.request.channel, "email");
    assert.ok(!/https?:|www\.|token|password|\bcode\b|<|>/i.test(r.request.text + r.request.subject), "no links / tokens / access instructions / markup");
  }
  const c = build("booking_confirmed").request;
  assert.equal(c.subject, "Your maraVilla booking MV-ABC123 is confirmed");
  assert.equal(c.text, ["Hello Synthia,", "", "Your maraVilla booking MV-ABC123 is confirmed.", "Check-in: 2026-12-04", "Check-out: 2026-12-06", "Nights: 2", "Guests: 2", "",
    "We have charged $1,234.56 USD to your card.", "", "maraVilla"].join("\n"));
  const a = build("not_charged_authorization_may_show").request;
  assert.match(a.text, /you were not charged\./);
  assert.match(a.text, /temporary authorization as pending/);
  assert.ok(!a.text.includes("$"), "no amount in a not-charged message");
  const x = build("not_completed_not_charged").request;
  assert.match(x.text, /reservation has been cancelled and you were not charged/);
  assert.match(x.text, /temporary authorization as pending/);
});

test("canonical + content hash: deterministic vectors (sorted keys, gn-v1-content prefix)", () => {
  const VEC = { booking_confirmed: "32613d05e796b6a00cf7003bec3685a6f68ee167cdaaee5ad5824e96cc71d4d2",
    not_charged_authorization_may_show: "2e08b4d4d2d45685ae1fba483522d857327e50723f77427793f343a08bf16bb7",
    not_completed_not_charged: "ba5629f5e495e155106431b822fee28a9731358c3ed919f998b332bb8ef651a8" };
  for (const t of TEMPLATES) {
    const req = build(t).request;
    const manual = `{${[...REQUEST_KEYS].sort().map((k) => `${JSON.stringify(k)}:${JSON.stringify(req[k])}`).join(",")}}`;
    assert.equal(canonical(req), manual);
    assert.equal(contentHash(req), createHash("sha256").update(`gn-v1-content\n${manual}`, "utf8").digest("hex"));
    assert.equal(contentHash(req), VEC[t], t);
    assert.equal(contentHash(build(t).request), VEC[t], "stable across builds");
  }
  // any single-field change moves the hash
  const base = build("booking_confirmed").request;
  assert.notEqual(contentHash({ ...base, text: base.text + " " }), contentHash(base));
  assert.notEqual(contentHash(build("booking_confirmed", { opId: "00000000-0000-4000-8000-000000000002" }).request), contentHash(base));
  assert.throws(() => canonical({ a: 1.5 }), TypeError);
  assert.throws(() => canonical({ a: {} }), TypeError);
  assert.throws(() => canonical([]), TypeError);
});

test("recipient hash mirrors the SQL gn_recipient_hash_of formula", () => {
  assert.equal(recipientHash(GUEST.email, GUEST.firstName), createHash("sha256").update(`gn-v1-recipient\n${GUEST.email}\n${GUEST.firstName}`).digest("hex"));
  assert.equal(recipientHash(GUEST.email, GUEST.firstName), "806b832b52e66b4f53e2c03620d2ab98c55d7515c13d8ecb32124bcfbd985f1d");
});

test("request refusals: template / op / facts / currency / recipient / sender (code only)", () => {
  const T = "booking_confirmed";
  assert.equal(build("other").code, "TEMPLATE_INVALID");
  assert.equal(build(T, { opId: "NOT-A-UUID" }).code, "OP_ID_INVALID");
  assert.equal(build(T, { opId: OP.toUpperCase().replace(/0/g, "0") + "X" }).code, "OP_ID_INVALID");
  for (const over of [{ template: "not_completed_not_charged" }, { ref: "XX-1" }, { checkIn: "2026-12-06" }, { checkIn: "12/04/2026" }, { nights: 0 }, { nights: 2.5 },
    { guests: 0 }, { guests: 51 }, { totalMinor: 0 }, { totalMinor: "123456" }, { totalMinor: 2 ** 53 }]) {
    assert.equal(buildMessageRequest({ template: T, facts: facts(T, over), guest: { ...GUEST }, sender: { ...SENDER }, opId: OP }).code, "RENDER_FACTS_INVALID", JSON.stringify(Object.keys(over)));
  }
  assert.equal(buildMessageRequest({ template: T, facts: null, guest: GUEST, sender: SENDER, opId: OP }).code, "RENDER_FACTS_INVALID");
  assert.equal(buildMessageRequest({ template: T, facts: facts(T, { currency: "EUR" }), guest: GUEST, sender: SENDER, opId: OP }).code, "CURRENCY_NOT_SUPPORTED");
  for (const g of [{ email: "guest@example.com", firstName: "A" }, { email: "Guest@mv-test.invalid", firstName: "A" }, { email: "guest@invalid", firstName: "A" },
    { email: "g@mv-test.invalid", firstName: "" }, { email: "g@mv-test.invalid", firstName: "A<b>" }, { email: "g@mv-test.invalid", firstName: "A\nB" }, null]) {
    assert.equal(buildMessageRequest({ template: T, facts: facts(T), guest: g, sender: SENDER, opId: OP }).code, "RECIPIENT_INVALID");
  }
  for (const s of [{ fromAddress: "x@example.com", fromName: "A" }, { fromAddress: SENDER.fromAddress, fromName: "A\u0007" }, { ...SENDER, replyTo: "x@y.invalid" },
    { fromAddress: SENDER.fromAddress }, null]) {
    assert.equal(buildMessageRequest({ template: T, facts: facts(T), guest: GUEST, sender: s, opId: OP }).code, "SENDER_INVALID");
  }
  assert.equal(buildMessageRequest(undefined).code, "TEMPLATE_INVALID");
});

test("classifyReply: ONLY the exact accepted shape; adversarial shapes are code-only unknown and never throw", () => {
  assert.deepEqual(classifyReply({ accepted: true, providerMessageId: "mock-1" }), { kind: "accepted", providerMessageId: "mock-1" });
  assert.equal(classifyReply(Object.assign(Object.create(null), { accepted: true, providerMessageId: "mock-x" })).kind, "accepted");
  const shape = [undefined, null, true, "ok", 1, [], [true, "mock-1"], { accepted: true }, { accepted: "true", providerMessageId: "mock-1" },
    { accepted: true, providerMessageId: "msg-1" }, { accepted: true, providerMessageId: "mock-" }, { accepted: true, providerMessageId: `mock-${"a".repeat(96)}` },
    { accepted: true, providerMessageId: "mock-1", delivered: true }, { accepted: false, providerMessageId: "mock-1" }, new (class R { constructor() { this.accepted = true; this.providerMessageId = "mock-1"; } })(),
    Object.defineProperty({ accepted: true }, "providerMessageId", { get() { return "mock-1"; }, enumerable: true }),
    Object.defineProperty({ accepted: true }, "providerMessageId", { value: "mock-1", enumerable: false }),
    { accepted: true, providerMessageId: "mock-1", [Symbol("s")]: 1 }];
  for (const r of shape) assert.deepEqual(classifyReply(r), { kind: "unknown", code: "REPLY_SHAPE" });
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error("hostile"); } });
  assert.deepEqual(classifyReply(hostile), { kind: "unknown", code: "REPLY_UNREADABLE" });
  const hostile2 = new Proxy({ accepted: true, providerMessageId: "mock-1" }, { ownKeys() { throw new Error("hostile"); } });
  assert.deepEqual(classifyReply(hostile2), { kind: "unknown", code: "REPLY_UNREADABLE" });
});

// ---------------------------------------------------------------------------------------------
// scripted pool: answers every worker statement by kind, records an ordered event log (kinds only, never values)

function scriptedPool(over = {}) {
  const log = [];
  let claimHash = null;
  const presendNow = () => new Date();
  const kindOf = (sql) => {
    if (/FROM booking\.instance/.test(sql)) return "marker";
    if (/clock_timestamp\(\) AS t/.test(sql)) return "clock";
    const m = /booking\.([a-z_]+)\(/.exec(sql);
    if (m) return m[1];
    return sql.split(" ")[0];
  };
  const defaults = {
    marker: () => ({ rows: [{ environment: "test" }] }),
    clock: () => ({ rows: [{ t: new Date() }] }),
    recover_expired_notifications: () => ({ processed: 0, skippedLocked: 0, skippedProtected: 0 }),
    claim_notification_work: () => ({ status: "acquired", opId: OP, intentId: INTENT, workLeaseUntil: new Date(Date.now() + 120000).toISOString() }),
    guest_notification_snapshot: () => ({ class: "ELIGIBLE", code: null, template: "booking_confirmed", facts: facts("booking_confirmed"), factsHash: "f".repeat(64),
      recipientHash: recipientHash(GUEST.email, GUEST.firstName), email: GUEST.email, firstName: GUEST.firstName }),
    claim_guest_notification: (p) => { claimHash = p[3]; return { status: "claimed" }; },
    latch_guest_notification: () => "LATCHED",
    guest_notification_presend: () => { const n = presendNow(); return { ok: true, code: null, dbNow: n.toISOString(), opLeaseUntil: new Date(+n + 59000).toISOString(),
      workLeaseUntil: new Date(+n + 119000).toISOString(), contentHash: claimHash, templateVersion: "gn-v1", messageRef: `gn1-${OP}` }; },
    complete_guest_notification: (p) => (p[2] === "accepted" ? "succeeded" : "outcome_unknown"),
    release_notification_work: () => "RELEASED",
    BEGIN: () => ({}), COMMIT: () => ({}), ROLLBACK: () => ({})
  };
  const h = { ...defaults, ...over };
  const answer = async (sql, params, via) => {
    const k = kindOf(sql);
    log.push(`${via}:${k}`);
    const f = h[k];
    if (!f) throw new TypeError(`unscripted ${k}`);
    const v = await f(params, log);
    if (k === "marker" || k === "clock" || k === "BEGIN" || k === "COMMIT" || k === "ROLLBACK") return v.rows ? v : { rows: [] };
    return { rows: [{ r: v }] };
  };
  const pool = {
    log,
    query: (sql, params) => answer(sql, params, "pool"),
    connect: async () => { log.push("connect"); return { query: (sql, params) => answer(sql, params, "tx"), release: (d) => log.push(d ? "dispose" : "release") }; }
  };
  return pool;
}
function sink({ reply = (i) => ({ accepted: true, providerMessageId: `mock-${i}` }), onSend } = {}) {
  const s = { count: 0, requests: [] };
  s.sendMessage = (req, ctx) => { s.count += 1; s.requests.push(req); if (onSend) onSend(req, ctx); return reply(s.count, ctx); };
  return s;
}
const opts = (snk, over = {}) => ({ env: ENV, workerId: "gn-w1", listingIds: [891001], sender: { ...SENDER }, executors: { sendMessage: snk.sendMessage, label: "mock-sink" },
  clock: Date.now, ...over });
const noPii = (r) => {
  const j = JSON.stringify(r);
  for (const v of [GUEST.email, GUEST.firstName, SENDER.fromAddress, "maraVilla booking", "Hello"]) assert.ok(!j.includes(v), "no contact / content in the result");
};

test("gate: invalid options / env / scope / config refuse with ZERO queries", async () => {
  const snk = sink();
  const bad = [undefined, null, [], "x", { ...opts(snk), extra: 1 }, { ...opts(snk), env: { VERCEL_ENV: "production", MV_E7_NOTIFICATION_WORKER: "enabled" } },
    { ...opts(snk), env: { VERCEL_ENV: "development" } }, { ...opts(snk), env: { VERCEL_ENV: "development", MV_E7_NOTIFICATION_WORKER: "1" } },
    { ...opts(snk), workerId: "bad id" }, { ...opts(snk), listingIds: [] }, { ...opts(snk), listingIds: [1, 1] }, { ...opts(snk), listingIds: [0] },
    { ...opts(snk), listingIds: [2 ** 31] }, { ...opts(snk), listingIds: Array.from({ length: 51 }, (_, i) => i + 1) }, { ...opts(snk), listingIds: ["1"] },
    { ...opts(snk), intentId: "ABC" }, { ...opts(snk), sender: { fromAddress: "a@example.com", fromName: "A" } }, { ...opts(snk), sender: { ...SENDER, cc: "x@y.invalid" } },
    { ...opts(snk), sender: { ...SENDER, fromName: "A\nB" } }, { ...opts(snk), executors: { sendMessage: snk.sendMessage } },
    { ...opts(snk), executors: { sendMessage: snk.sendMessage, label: "live-sender" } }, { ...opts(snk), executors: { sendMessage: "x", label: "mock-a" } },
    { ...opts(snk), executors: { sendMessage: snk.sendMessage, label: "mock-a", transport: {} } }, { ...opts(snk), clock: 5 },
    { ...opts(snk), hooks: { beforeSend: () => {} } }, { ...opts(snk), hooks: { afterClaim: 1 } }];
  let getterRuns = 0;
  bad.push(Object.defineProperty({ ...opts(snk) }, "workerId", { get() { getterRuns += 1; return "gn-w1"; }, enumerable: true }));
  bad.push(Object.assign(Object.create({ inherited: 1 }), opts(snk)));
  for (const o of bad) {
    const pool = scriptedPool();
    const r = await runNotificationStep(pool, o);
    assert.equal(r.ok, false);
    assert.ok(["OPTIONS_INVALID", "ENV_REFUSED"].includes(r.code), r.code);
    assert.equal(pool.log.length, 0, "zero queries");
  }
  assert.equal(getterRuns, 0, "accessor options are refused, never invoked");
  assert.equal(snk.count, 0);
  assert.deepEqual([...NOTIFICATION_OPTION_KEYS], ["clock", "env", "executors", "hooks", "intentId", "listingIds", "sender", "workerId"]);
});

test("gate: per-step basis is a deep-frozen COPY (later caller mutation changes nothing)", () => {
  const snk = sink();
  const o = opts(snk, { env: { ...ENV } }); const g = notificationWorkerGate(o);
  assert.equal(g.ok, true);
  o.listingIds.push(5); o.sender.fromAddress = "x@example.com"; o.env.VERCEL_ENV = "production";
  assert.deepEqual([...g.basis.listingIds], [891001]);
  assert.equal(g.basis.sender.fromAddress, SENDER.fromAddress);
  assert.ok(Object.isFrozen(g.basis) && Object.isFrozen(g.basis.listingIds) && Object.isFrozen(g.basis.sender));
});

test("marker: wrong / absent marker refuses after exactly ONE query; a marker query error propagates as the SAME object, no follow-up", async () => {
  for (const rows of [[{ environment: "production" }], [{ environment: null }], []]) {
    const pool = scriptedPool({ marker: () => ({ rows }) });
    const snk = sink();
    const r = await runNotificationStep(pool, opts(snk));
    assert.deepEqual({ ...r }, { ok: false, code: "DATABASE_NOT_TEST" });
    assert.deepEqual(pool.log, ["pool:marker"]);
    assert.equal(snk.count, 0);
  }
  const boom = Object.assign(new Error("relation does not exist"), { code: "42P01" });
  const pool = scriptedPool({ marker: () => { throw boom; } });
  await assert.rejects(runNotificationStep(pool, opts(sink())), (e) => e === boom);
  assert.deepEqual(pool.log, ["pool:marker"]);
});

test("clock skew refuses before any notification query", async () => {
  const pool = scriptedPool();
  const r = await runNotificationStep(pool, opts(sink(), { clock: () => Date.now() - 2500 }));
  assert.equal(r.code, "CLOCK_SKEW");
  assert.deepEqual(pool.log, ["pool:marker", "pool:clock"]);
  const p2 = scriptedPool();
  assert.equal((await runNotificationStep(p2, opts(sink(), { clock: () => NaN }))).code, "CLOCK_SKEW");
});

test("happy path order: maintenance → work → RR observation → claim → RR pre-send → ONE send → settlement → release; result has no PII", async () => {
  const pool = scriptedPool(); const snk = sink();
  const r = await runNotificationStep(pool, opts(snk));
  assert.equal(r.outcome, "accepted"); assert.equal(r.sends, 1); assert.equal(snk.count, 1);
  assert.deepEqual(pool.log, ["pool:marker", "pool:clock", "pool:recover_expired_notifications", "pool:claim_notification_work",
    "connect", "tx:BEGIN", "tx:guest_notification_snapshot", "tx:COMMIT", "release",
    "pool:claim_guest_notification",
    "connect", "tx:BEGIN", "tx:guest_notification_presend", "tx:COMMIT", "release",
    "pool:complete_guest_notification", "pool:release_notification_work"]);
  assert.ok(Object.isFrozen(r));
  assert.equal((await r.late).kind, "none");
  noPii(r);
  assert.ok(Object.isFrozen(snk.requests[0]) && snk.requests[0].to === GUEST.email, "the bound guest recipient, no override");
});

test("pre-send no-await boundary: the send starts synchronously in the continuation of the pre-send COMMIT (no query / hook between)", async () => {
  let afterCommitTicks = null;
  const pool = scriptedPool({ COMMIT: (p, log) => {
    if (log.filter((x) => x === "tx:COMMIT").length === 2) { afterCommitTicks = 0; const tick = () => { if (afterCommitTicks !== null && afterCommitTicks < 50) { afterCommitTicks += 1; queueMicrotask(tick); } }; queueMicrotask(tick); }
    return {};
  } });
  let ticksAtSend = null; const events = [];
  const snk = sink({ onSend: () => { ticksAtSend = afterCommitTicks; events.push(pool.log.at(-1)); } });
  const hooks = { afterClaim: async () => {}, afterSend: async () => {}, afterInitialObservation: async () => {} };
  const r = await runNotificationStep(pool, opts(snk, { hooks }));
  assert.equal(r.outcome, "accepted");
  assert.deepEqual(events, ["release"], "the last event before the send is the pre-send connection release");
  assert.ok(ticksAtSend !== null && ticksAtSend <= 3, `send within the COMMIT continuation (microtask hops ${ticksAtSend})`);
});

test("observation read / COMMIT errors propagate as the SAME object: ROLLBACK + dispose only, zero sends, no follow-up", async () => {
  for (const where of ["snapshot", "snapshotCommit", "presend", "presendCommit"]) {
    const boom = Object.assign(new Error("synthetic"), { code: "08006" });
    let commits = 0;
    const over = {};
    if (where === "snapshot") over.guest_notification_snapshot = () => { throw boom; };
    if (where === "presend") over.guest_notification_presend = () => { throw boom; };
    if (where.endsWith("Commit")) over.COMMIT = () => { commits += 1; if ((where === "snapshotCommit" && commits === 1) || (where === "presendCommit" && commits === 2)) throw boom; return {}; };
    const pool = scriptedPool(over); const snk = sink();
    await assert.rejects(runNotificationStep(pool, opts(snk)), (e) => e === boom, where);
    assert.equal(snk.count, 0, `${where}: zero sends`);
    assert.deepEqual(pool.log.slice(-2), ["tx:ROLLBACK", "dispose"], `${where}: cleanup only`);
    assert.ok(!pool.log.includes("pool:complete_guest_notification") && !pool.log.includes("pool:release_notification_work"), `${where}: no settlement / release`);
  }
});

test("settlement outer error after the send propagates unchanged: no further query, no release; release failure after success propagates", async () => {
  const boom = Object.assign(new Error("synthetic"), { code: "57P01" });
  const p1 = scriptedPool({ complete_guest_notification: () => { throw boom; } }); const s1 = sink();
  await assert.rejects(runNotificationStep(p1, opts(s1)), (e) => e === boom);
  assert.equal(s1.count, 1);
  assert.equal(p1.log.at(-1), "pool:complete_guest_notification", "nothing after the failed settlement");
  const boom2 = new Error("synthetic release");
  const p2 = scriptedPool({ release_notification_work: () => { throw boom2; } }); const s2 = sink();
  await assert.rejects(runNotificationStep(p2, opts(s2)), (e) => e === boom2);
  assert.equal(s2.count, 1);
  assert.deepEqual(p2.log.slice(-2), ["pool:complete_guest_notification", "pool:release_notification_work"]);
});

test("executor throw / rejection / non-exact reply → bounded code-only unknown; never a second invocation", async () => {
  const cases = [[() => { throw new Error("secret detail guest.v@mv-test.invalid"); }, "SEND_THREW"], [() => Promise.reject(new Error("x")), "SEND_THREW"],
    [() => ({ accepted: true, providerMessageId: "real-123" }), "REPLY_SHAPE"], [() => ({ accepted: true, providerMessageId: "mock-1", status: "delivered" }), "REPLY_SHAPE"],
    [() => new Proxy({}, { getPrototypeOf() { throw new Error("hostile"); } }), "REPLY_UNREADABLE"], [() => undefined, "REPLY_SHAPE"]];
  for (const [reply, code] of cases) {
    const pool = scriptedPool(); let settledWith = null;
    pool.query = ((q) => (sql, p) => { if (/complete_guest_notification/.test(sql)) settledWith = [p[2], p[3], p[4]]; return q(sql, p); })(pool.query);
    const snk = sink({ reply });
    const r = await runNotificationStep(pool, opts(snk));
    assert.equal(snk.count, 1); assert.equal(r.sends, 1);
    assert.equal(r.outcome, "unknown"); assert.equal(r.code, code);
    assert.deepEqual(settledWith, ["unknown", null, code]);
    noPii(r);
    assert.ok(!JSON.stringify(r).includes("secret detail"));
  }
});

test("final local checks after claim → PRESEND_ABORTED_NOT_INVOKED (zero sends): mismatch, lease room, skew, slow observation, step budget", async () => {
  const run = async (over, o = {}) => {
    const pool = scriptedPool(over); const snk = sink();
    let settled = null;
    pool.query = ((q) => (sql, p) => { if (/complete_guest_notification/.test(sql)) settled = [p[2], p[4]]; return q(sql, p); })(pool.query);
    const r = await runNotificationStep(pool, opts(snk, o));
    assert.equal(snk.count, 0); assert.equal(r.sends, 0);
    assert.deepEqual(settled, ["unknown", "PRESEND_ABORTED_NOT_INVOKED"]);
    assert.equal(r.outcome, "unknown");
    return r.abort;
  };
  const ps = (f) => ({ guest_notification_presend: (p) => { const n = new Date(); return f({ ok: true, code: null, dbNow: n.toISOString(), opLeaseUntil: new Date(+n + 59000).toISOString(),
    workLeaseUntil: new Date(+n + 119000).toISOString(), contentHash: "0".repeat(64), templateVersion: "gn-v1", messageRef: `gn1-${OP}` }, n); } });
  assert.equal(await run(ps((x) => x)), "REQUEST_MISMATCH");
  // lease room: the hash must match → reuse the claim's hash through a closure
  let h = null;
  const withHash = (f) => ({ claim_guest_notification: (p) => { h = p[3]; return { status: "claimed" }; },
    guest_notification_presend: () => { const n = new Date(); return f({ ok: true, code: null, dbNow: n.toISOString(), opLeaseUntil: new Date(+n + 59000).toISOString(),
      workLeaseUntil: new Date(+n + 119000).toISOString(), contentHash: h, templateVersion: "gn-v1", messageRef: `gn1-${OP}` }, n); } });
  assert.equal(await run(withHash((x, n) => ({ ...x, opLeaseUntil: new Date(+n + 14900).toISOString() }))), "LEASE_ROOM");
  assert.equal(await run(withHash((x, n) => ({ ...x, workLeaseUntil: new Date(+n + 14900).toISOString() }))), "LEASE_ROOM");
  assert.equal(await run(withHash((x) => ({ ...x, messageRef: "gn1-other" }))), "REQUEST_MISMATCH");
  assert.equal(await run(withHash((x) => ({ ...x, templateVersion: "gn-v2" }))), "REQUEST_MISMATCH");
  assert.equal(await run(withHash((x) => ({ ...x, dbNow: "not a time" }))), "PRESEND_SHAPE");
  // skew at the final check: the injected wall clock jumps back 3 s after the step's skew probe
  let calls = 0;
  assert.equal(await run(withHash((x) => x), { clock: () => { calls += 1; return calls <= 2 ? Date.now() : Date.now() - 3000; } }), "CLOCK_SKEW");
  // slow RR observation: elapsed is measured on the monotonic clock from BEFORE BEGIN through COMMIT, even when dbNow is late
  const slowHooks = { inObservation: async (k) => { if (k === "presend") await sleep(NOTIFICATION_LIMITS.observationBudgetMs + 150); } };
  const lateNow = (f) => withHash((x) => f(x));
  assert.equal(await run(lateNow((x) => x), { hooks: slowHooks }), "OBSERVATION_SLOW");
  // a wall clock going BACKWARDS (within skew) never enlarges the monotonic lease budget: 15.5 s reported room − 0.6 s elapsed < 15 s
  const medium = { inObservation: async (k) => { if (k === "presend") await sleep(600); } };
  assert.equal(await run(withHash((x, n) => ({ ...x, opLeaseUntil: new Date(+n + 15500).toISOString() })), { hooks: medium, clock: () => Date.now() - 1500 }), "LEASE_ROOM");
  // step budget: monotonic time from step start (performance.now patched forward after the claim)
  const realNow = performance.now.bind(performance); let offset = 0;
  performance.now = () => realNow() + offset;
  try {
    assert.equal(await run(withHash((x) => x), { hooks: { afterClaim: async () => { offset = NOTIFICATION_LIMITS.stepBudgetMs; } } }), "STEP_BUDGET");
  } finally { performance.now = realNow; }
  // a refused pre-send (not protected) is the same safe unknown
  assert.equal(await run({ guest_notification_presend: () => ({ ok: false, code: "FACTS_CHANGED" }) }), "FACTS_CHANGED");
});

test("protected anywhere → zero additional writes and no release; every SQL status handled explicitly", async () => {
  const writes = ["latch_guest_notification", "claim_guest_notification", "complete_guest_notification", "release_notification_work"];
  const after = (log, k) => log.slice(log.indexOf(k) + 1).filter((x) => writes.some((w) => x.endsWith(w)));
  { const p = scriptedPool({ guest_notification_snapshot: () => ({ class: "PROTECTED" }) }); const s = sink();
    const r = await runNotificationStep(p, opts(s)); assert.equal(r.outcome, "protected"); assert.ok(!("opId" in r), "protected: no ids (§9.3)"); assert.deepEqual(after(p.log, "tx:guest_notification_snapshot"), []); assert.equal(s.count, 0); }
  { const p = scriptedPool({ claim_guest_notification: () => ({ status: "protected" }) }); const s = sink();
    const r = await runNotificationStep(p, opts(s)); assert.equal(r.outcome, "protected"); assert.deepEqual(after(p.log, "pool:claim_guest_notification"), []); }
  { const p = scriptedPool({ guest_notification_presend: () => ({ ok: false, code: "PROTECTED" }) }); const s = sink();
    const r = await runNotificationStep(p, opts(s)); assert.equal(r.outcome, "protected"); assert.deepEqual(after(p.log, "tx:guest_notification_presend"), []); assert.equal(s.count, 0); }
  { const p = scriptedPool({ complete_guest_notification: () => "PROTECTED" }); const s = sink();
    const r = await runNotificationStep(p, opts(s)); assert.equal(r.outcome, "protected"); assert.equal(s.count, 1); assert.equal(p.log.at(-1), "pool:complete_guest_notification"); }
  // non-ELIGIBLE snapshot classes release work and never claim
  for (const [cls, outcome] of [["WAITING", "waiting"], ["OUT_OF_V1_SCOPE", "waiting"], ["LATCHED", "latched"], ["SUCCEEDED", "not_claimable"], ["IN_FLIGHT", "not_claimable"],
    ["UNKNOWN", "not_claimable"], ["OTHER", "not_claimable"], ["NOT_NOTIFY", "not_claimable"]]) {
    const p = scriptedPool({ guest_notification_snapshot: () => ({ class: cls }) }); const s = sink();
    const r = await runNotificationStep(p, opts(s));
    assert.equal(r.outcome, outcome, cls); assert.equal(p.log.at(-1), "pool:release_notification_work"); assert.ok(!p.log.includes("pool:claim_guest_notification"));
  }
  for (const [st, code] of [["latched", "OPEN_CASE"], ["waiting", "WEBHOOK_UNPROCESSED"], ["not_claimable", "SNAPSHOT_STALE"]]) {
    const p = scriptedPool({ claim_guest_notification: () => ({ status: st, code }) }); const s = sink();
    const r = await runNotificationStep(p, opts(s));
    assert.deepEqual([r.outcome, r.code, s.count], [st, code, 0]); assert.equal(p.log.at(-1), "pool:release_notification_work");
  }
  // unexpected shapes are invariant breaks (TypeError), never guessed
  for (const over of [{ guest_notification_snapshot: () => ({ class: "NEW" }) }, { claim_guest_notification: () => ({ status: "ok" }) },
    { claim_notification_work: () => ({ status: "acquired", opId: "x" }) }, { guest_notification_presend: () => null }, { release_notification_work: () => "DONE" }]) {
    const s = sink();
    await assert.rejects(runNotificationStep(scriptedPool(over), opts(s)), TypeError);
  }
});

test("render failure → the authorized RENDER_FAILED latch (never a fabricated recipient / message); recipient hash cross-check", async () => {
  const snap = (x) => ({ guest_notification_snapshot: () => ({ class: "ELIGIBLE", code: null, template: "booking_confirmed", facts: facts("booking_confirmed"), factsHash: "f".repeat(64),
    recipientHash: recipientHash(GUEST.email, GUEST.firstName), email: GUEST.email, firstName: GUEST.firstName, ...x }) });
  for (const [x, rc] of [[{ facts: facts("booking_confirmed", { currency: "EUR" }) }, "CURRENCY_NOT_SUPPORTED"], [{ email: null, recipientHash: null }, "RECIPIENT_INVALID"],
    [{ recipientHash: "0".repeat(64) }, "RECIPIENT_INVALID"], [{ facts: facts("booking_confirmed", { nights: 0 }) }, "RENDER_FACTS_INVALID"]]) {
    const p = scriptedPool(snap(x)); const s = sink();
    const r = await runNotificationStep(p, opts(s));
    assert.deepEqual([r.outcome, r.code, r.renderCode, s.count], ["latched", "RENDER_FAILED", rc, 0]);
    assert.ok(!p.log.includes("pool:claim_guest_notification"), "no claim after a render failure");
  }
  for (const [l, outcome] of [["PROTECTED", "protected"], ["NOT_ELIGIBLE", "not_claimable"], ["WORK_LEASE", "not_claimable"]]) {
    const p = scriptedPool({ ...snap({ email: null }), latch_guest_notification: () => l });
    const r = await runNotificationStep(p, opts(sink()));
    assert.equal(r.outcome, outcome);
    assert.equal(p.log.at(-1), l === "PROTECTED" ? "pool:latch_guest_notification" : "pool:release_notification_work");
  }
});

test("timeout: ONE bounded call aborted at the fixed send timeout → unknown SEND_TIMEOUT; a late reply is in-memory only (no DB write)", async () => {
  let signal = null;
  const snk = sink({ reply: (i, ctx) => { signal = ctx.signal; return new Promise((res) => setTimeout(() => res({ accepted: true, providerMessageId: "mock-late" }), NOTIFICATION_LIMITS.sendTimeoutMs + 300)); } });
  const pool = scriptedPool();
  const t0 = performance.now();
  const r = await runNotificationStep(pool, opts(snk));
  const el = performance.now() - t0;
  assert.ok(el >= NOTIFICATION_LIMITS.sendTimeoutMs - 50 && el < NOTIFICATION_LIMITS.sendTimeoutMs + 1500, `bounded (${Math.round(el)} ms)`);
  assert.deepEqual([r.outcome, r.code, r.sends, snk.count], ["unknown", "SEND_TIMEOUT", 1, 1]);
  assert.equal(signal.aborted, true);
  const n = pool.log.length;
  const late = await r.late;
  assert.deepEqual({ ...late }, { kind: "late_reply", classified: "accepted" });
  assert.equal(pool.log.length, n, "no query after the late reply");
});

// ---------------------------------------------------------------------------------------------
// R-G1 (root CODE HOLD on 44e8d0a8): the gate copies exactly the DATA it validates; hostile option data is OPTIONS_INVALID, zero calls.

/** run one hostile option set through the gate AND the step: structured refusal, zero pool / connect / executor calls */
async function refusedQuietly(make, label) {
  const snk = sink(); const pool = scriptedPool();
  let g;
  assert.doesNotThrow(() => { g = notificationWorkerGate(make(snk)); }, `${label}: the gate never throws`);
  assert.deepEqual({ ...g }, { ok: false, code: "OPTIONS_INVALID" }, label);
  assert.ok(Object.isFrozen(g) && Object.keys(g).length === 2, `${label}: code-only refusal (no caller error leaked)`);
  const r = await runNotificationStep(pool, make(snk));
  assert.deepEqual({ ...r }, { ok: false, code: "OPTIONS_INVALID" }, label);
  assert.equal(pool.log.length, 0, `${label}: zero pool / connect calls`);
  assert.equal(snk.count, 0, `${label}: zero executor calls`);
}
const withIds = (ids) => (snk) => opts(snk, { listingIds: ids() });

test("R-G1 root probe 1: an enumerable accessor at index '0' is refused and NEVER invoked", async () => {
  let runs = 0;
  const ids = () => { const a = [1]; Object.defineProperty(a, "0", { get() { runs += 1; return 1; }, enumerable: true, configurable: true }); return a; };
  await refusedQuietly(withIds(ids), "index accessor");
  assert.equal(runs, 0, "getter never ran (44e8: 3 runs, accepted)");
});

test("R-G1 root probe 2: an own Symbol.iterator cannot make the copied scope differ from the validated scope", async () => {
  let iter = 0;
  const ids = () => { const a = [1]; a[Symbol.iterator] = function* () { iter += 1; yield 2; }; return a; };
  await refusedQuietly(withIds(ids), "own iterator");
  assert.equal(iter, 0, "iterator never ran (44e8: accepted, basis [2])");
});

test("R-G1 root probe 3: an own enumerable '__proto__' DATA key is an unknown key on opts and on every nested object", async () => {
  const proto = (o) => Object.defineProperty(o, "__proto__", { enumerable: true, configurable: true, writable: true, value: { extra: true } });
  await refusedQuietly((snk) => proto(opts(snk)), "opts.__proto__");
  await refusedQuietly((snk) => opts(snk, { env: proto({ ...ENV }) }), "env.__proto__");
  await refusedQuietly((snk) => opts(snk, { sender: proto({ ...SENDER }) }), "sender.__proto__");
  await refusedQuietly((snk) => opts(snk, { executors: proto({ sendMessage: snk.sendMessage, label: "mock-sink" }) }), "executors.__proto__");
  await refusedQuietly((snk) => opts(snk, { hooks: proto({ afterClaim: async () => {} }) }), "hooks.__proto__");
  // the stronger variant: required values supplied only through a '__proto__' key are never served from a scratch prototype
  await refusedQuietly((snk) => { const o = opts(snk); const { workerId, clock } = o; delete o.workerId; delete o.clock;
    return Object.defineProperty(o, "__proto__", { enumerable: true, value: { workerId, clock } }); }, "required keys via __proto__");
});

test("R-G1 root probe 4: throwing / revoked proxies at every level → OPTIONS_INVALID, never the caller's error object", async () => {
  const boom = new Error("synthetic trap failure");
  const throwing = (t, trap) => new Proxy(t, { [trap]() { throw boom; } });
  const revoked = (t) => { const r = Proxy.revocable(t, {}); r.revoke(); return r.proxy; };
  const levels = {
    opts: (snk, f) => f(opts(snk)),
    env: (snk, f) => opts(snk, { env: f({ ...ENV }) }),
    sender: (snk, f) => opts(snk, { sender: f({ ...SENDER }) }),
    executors: (snk, f) => opts(snk, { executors: f({ sendMessage: snk.sendMessage, label: "mock-sink" }) }),
    hooks: (snk, f) => opts(snk, { hooks: f({ afterClaim: async () => {} }) }),
    listingIds: (snk, f) => opts(snk, { listingIds: f([891001]) })
  };
  for (const [lvl, mk] of Object.entries(levels)) {
    for (const trap of ["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"]) await refusedQuietly((snk) => mk(snk, (t) => throwing(t, trap)), `${lvl}: ${trap} throws`);
    await refusedQuietly((snk) => mk(snk, revoked), `${lvl}: revoked`);
  }
});

test("R-G1 listingIds variants: changing getter, holes, non-enumerable / accessor index, custom methods / iterators / symbol / extra keys, subclass", async () => {
  let runs = 0;
  const def = (a, k, d) => Object.defineProperty(a, k, { configurable: true, ...d });
  const cases = {
    "changing index getter": () => def([1, 2], "1", { get() { runs += 1; return runs > 1 ? 1 : 2; }, enumerable: true }),
    "sparse (hole)": () => [891001, , 891003],                                   // eslint-disable-line no-sparse-arrays
    "trailing hole via length": () => { const a = [891001]; a.length = 2; return a; },
    "non-enumerable index": () => def([891001], "0", { value: 891001, enumerable: false, writable: true }),
    "non-enumerable accessor index": () => def([1], "0", { get() { runs += 1; return 1; }, enumerable: false }),
    "custom .some": () => { const a = [0]; a.some = () => false; return a; },
    "custom .some non-enumerable": () => def([0], "some", { value: () => false, enumerable: false }),
    "non-enumerable iterator": () => def([1], Symbol.iterator, { value: function* () { runs += 1; yield 2; }, enumerable: false }),
    "symbol key": () => { const a = [1]; a[Symbol("x")] = 1; return a; },
    "extra string key": () => { const a = [1]; a.extra = 1; return a; },
    "subclass prototype": () => { class Ids extends Array {} return Ids.from([1]); },
    "null-prototype array": () => Object.setPrototypeOf([1], null),
    "array-like object": () => ({ 0: 1, length: 1 }),
    "length 51": () => Array.from({ length: 51 }, (_, i) => i + 1),
    "empty": () => []
  };
  for (const [label, mk] of Object.entries(cases)) await refusedQuietly(withIds(mk), label);
  assert.equal(runs, 0, "no getter / iterator ran");
});

test("R-G1 valid controls: dense frozen array, plain and null-prototype configs; copied basis equals the validated data; caller mutation after the gate changes nothing", async () => {
  const nul = (o) => Object.assign(Object.create(null), o);
  for (const [label, mk] of [["frozen dense array", (snk) => opts(snk, { listingIds: Object.freeze([891001, 891002]) })],
    ["null-prototype everywhere", (snk) => nul({ ...opts(snk), env: nul(ENV), sender: nul(SENDER), executors: nul({ sendMessage: snk.sendMessage, label: "mock-sink" }),
      hooks: nul({ afterClaim: async () => {} }), listingIds: [891001, 891002] })]]) {
    const snk = sink(); const o = mk(snk);
    const g = notificationWorkerGate(o);
    assert.equal(g.ok, true, label);
    assert.deepEqual([...g.basis.listingIds], [891001, 891002], `${label}: copied scope = validated scope`);
    assert.ok(Object.isFrozen(g.basis.listingIds) && Object.getPrototypeOf(g.basis.listingIds) === Array.prototype && g.basis.listingIds !== o.listingIds);
    assert.deepEqual({ ...g.basis.sender }, { ...SENDER });
    assert.ok(Object.isFrozen(g.basis.hooks) && Object.getPrototypeOf(g.basis.hooks) === null);
    const pool = scriptedPool();
    const r = await runNotificationStep(pool, mk(snk));
    assert.equal(r.outcome, "accepted", label); assert.equal(snk.count, 1);
  }
  // mutation after the gate (writable array) changes nothing
  const snk = sink(); const o = opts(snk, { listingIds: [891001] });
  const g = notificationWorkerGate(o);
  o.listingIds[0] = 5; o.listingIds.push(6);
  assert.deepEqual([...g.basis.listingIds], [891001]);
});

test("R-G1 boundary: the gate catch is option-only — a runtime marker error still propagates as the SAME object after the gate", async () => {
  const boom = Object.assign(new Error("synthetic"), { code: "08006" });
  const pool = scriptedPool({ marker: () => { throw boom; } });
  await assert.rejects(runNotificationStep(pool, opts(sink())), (e) => e === boom);
  assert.deepEqual(pool.log, ["pool:marker"]);
});
