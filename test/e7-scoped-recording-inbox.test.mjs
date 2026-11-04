// Stage E7 — scoped recording conflict-inbox JS module, WITHOUT PostgreSQL: zero-query validation, the one marker check, original-error
// propagation and progress, per-call option copies, projections and cursor strings. Fake pools only (no DB, provider or network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { processScopedRecordingInbox, listScopedRecordingInbox, scopedRecordingInboxSummary, SCOPED_INBOX_LIMITS } from "../lib/booking-db/recording-inbox.js";

const ENV = Object.freeze({ VERCEL_ENV: "development", MV_E7_RECORDING_INBOX: "enabled" });
const UUID = "0b2b6e5e-6a0b-4d0e-9a2c-5c2f6b7a8e91";
/** a pg.Pool-shaped fake: replies[k](sql, params) answers the k-th query (after the marker unless marker: false) */
function fakePool({ marker = "test", replies = [], pool = true } = {}) {
  const p = { sqls: [], params: [], query: async (sql, params) => {
    p.sqls.push(sql); p.params.push(params);
    if (/booking\.instance/.test(sql)) { if (marker instanceof Error) throw marker; return { rows: marker === "ABSENT" ? [] : [{ environment: marker }] }; }
    const f = replies.shift();
    if (!f) throw new Error("fakePool: unexpected query");
    return f(sql, params);
  } };
  if (pool) { p.connect = async () => { throw new Error("no connect"); }; p.totalCount = 0; }
  return p;
}
const reply = (r) => async () => ({ rows: [{ r }] });

test("zero-query refusals: options / env / scope / API-specific inputs, for all three APIs; page and summary never require by / maxItems", async () => {
  const base = { env: ENV, listingIds: [1] };
  const cases = [
    [null, "OPTIONS_INVALID"], [[], "OPTIONS_INVALID"], [{ ...base, extra: 1 }, "OPTIONS_INVALID"],
    [{ ...base, env: undefined }, "ENV_REQUIRED"], [{ ...base, env: { ...ENV, VERCEL_ENV: "production" } }, "PRODUCTION_REFUSED"],
    [{ ...base, env: { MV_E7_RECORDING_INBOX: "enabled" } }, "ENVIRONMENT_NOT_ALLOWED"], [{ ...base, env: { VERCEL_ENV: "preview", MV_E7_RECORDING_INBOX: "yes" } }, "NOT_ENABLED"],
    [{ ...base, listingIds: undefined }, "SCOPE_INVALID"], [{ ...base, listingIds: [] }, "SCOPE_INVALID"], [{ ...base, listingIds: "1" }, "SCOPE_INVALID"],
    [{ ...base, listingIds: [0] }, "SCOPE_INVALID"], [{ ...base, listingIds: [-1] }, "SCOPE_INVALID"], [{ ...base, listingIds: [1.5] }, "SCOPE_INVALID"],
    [{ ...base, listingIds: ["1"] }, "SCOPE_INVALID"], [{ ...base, listingIds: [NaN] }, "SCOPE_INVALID"], [{ ...base, listingIds: [2147483648] }, "SCOPE_INVALID"],
    [{ ...base, listingIds: [1, 1] }, "SCOPE_INVALID"], [{ ...base, listingIds: [null] }, "SCOPE_INVALID"],
    [{ ...base, listingIds: Array.from({ length: 51 }, (_, k) => k + 1) }, "SCOPE_INVALID"],
    [{ ...base, intentId: "not-a-uuid" }, "INTENT_ID_INVALID"], [{ ...base, intentId: UUID.toUpperCase() }, "INTENT_ID_INVALID"], [{ ...base, intentId: 7 }, "INTENT_ID_INVALID"]
  ];
  for (const [o, code] of cases) {
    for (const [fn, extra] of [[processScopedRecordingInbox, { by: "t" }], [listScopedRecordingInbox, { status: "all" }], [scopedRecordingInboxSummary, {}]]) {
      const p = fakePool();
      const opts = o && typeof o === "object" && !Array.isArray(o) ? { ...o, ...extra } : o;
      assert.deepEqual(await fn(p, opts), { status: "refused", code }, `${fn.name} ${JSON.stringify(o)}`);
      assert.equal(p.sqls.length, 0, "zero queries");
    }
  }
  const proc = [[{ by: undefined }, "BY_INVALID"], [{ by: "" }, "BY_INVALID"], [{ by: "bad by" }, "BY_INVALID"], [{ by: "x".repeat(81) }, "BY_INVALID"],
    [{ by: "t", maxItems: 2.5 }, "MAX_ITEMS_INVALID"], [{ by: "t", maxItems: "3" }, "MAX_ITEMS_INVALID"], [{ by: "t", maxItems: null }, "MAX_ITEMS_INVALID"]];
  for (const [o, code] of proc) { const p = fakePool(); assert.deepEqual(await processScopedRecordingInbox(p, { ...base, ...o }), { status: "refused", code }); assert.equal(p.sqls.length, 0); }
  const pageCases = [[{ status: undefined }, "STATUS_INVALID"], [{ status: "ALL" }, "STATUS_INVALID"], [{ status: "all", after: { afterSeq: 5 } }, "CURSOR_INVALID"],
    [{ status: "all", after: { afterSeq: "05" } }, "CURSOR_INVALID"], [{ status: "all", after: { afterSeq: "0" } }, "CURSOR_INVALID"],
    [{ status: "all", after: { afterSeq: "9223372036854775808" } }, "CURSOR_INVALID"], [{ status: "all", after: { afterSeq: "1", x: 1 } }, "CURSOR_INVALID"],
    [{ status: "all", after: "1" }, "CURSOR_INVALID"], [{ status: "all", limit: 1.5 }, "LIMIT_INVALID"], [{ status: "all", limit: "5" }, "LIMIT_INVALID"]];
  for (const [o, code] of pageCases) { const p = fakePool(); assert.deepEqual(await listScopedRecordingInbox(p, { ...base, ...o }), { status: "refused", code }); assert.equal(p.sqls.length, 0); }
  // processor-only keys are NOT accepted by the read APIs (and vice versa): no implicit by / maxItems requirement
  assert.deepEqual(await listScopedRecordingInbox(fakePool(), { ...base, status: "all", by: "t" }), { status: "refused", code: "OPTIONS_INVALID" });
  assert.deepEqual(await scopedRecordingInboxSummary(fakePool(), { ...base, maxItems: 3 }), { status: "refused", code: "OPTIONS_INVALID" });
  // pool requirements: the processor needs a real pg.Pool shape; the read APIs any queryable
  const q = fakePool({ pool: false, replies: [async () => ({ rows: [{ s: {} }] })] });
  assert.deepEqual(await processScopedRecordingInbox(q, { ...base, by: "t" }), { status: "refused", code: "POOL_REQUIRED" });
  assert.equal(q.sqls.length, 0);
  assert.equal((await scopedRecordingInboxSummary(q, base)).status, "ok");
  // int4 upper bound accepted; 50 ids accepted
  const ok = fakePool({ replies: [reply(null)] });
  assert.equal((await processScopedRecordingInbox(ok, { ...base, by: "t", listingIds: [2147483647] })).status, "idle");
  const fifty = fakePool({ replies: [reply(null)] });
  assert.equal((await processScopedRecordingInbox(fifty, { ...base, by: "t", listingIds: Array.from({ length: 50 }, (_, k) => k + 1) })).status, "idle");
});

test("ONE explicit marker SELECT per invocation: acknowledged non-test / absent marker -> DATABASE_NOT_TEST after exactly that query; a thrown marker error propagates as the ORIGINAL object with no follow-up", async () => {
  const runs = [[processScopedRecordingInbox, { by: "t" }], [listScopedRecordingInbox, { status: "all" }], [scopedRecordingInboxSummary, {}]];
  for (const [fn, extra] of runs) {
    for (const marker of ["live", "staging", "ABSENT", null]) {
      const p = fakePool({ marker });
      assert.deepEqual(await fn(p, { env: ENV, listingIds: [1], ...extra }), { status: "refused", code: "DATABASE_NOT_TEST" }, `${fn.name} ${marker}`);
      assert.deepEqual(p.sqls, ["SELECT environment FROM booking.instance"]);
    }
    const boom = Object.assign(new Error("connection terminated (mock)"), { code: "57P01" });
    const p = fakePool({ marker: boom });
    await assert.rejects(fn(p, { env: ENV, listingIds: [1], ...extra }), (e) => e === boom);
    assert.equal(p.sqls.length, 1);
  }
});

test("processor loop: calls = ATTEMPTED calls, arrays = ACKNOWLEDGED replies; recorded errors are data; same item twice stops; a stale skip stops; idle only when the first call is NULL; bound default 10 / hard 25", async () => {
  const P = (evidenceId, extra = {}) => reply({ evidenceId, intentId: UUID, outcome: "consistent", holdId: null, message: "MUST NOT LEAK", ...extra });
  let p = fakePool({ replies: [P("e1"), reply({ evidenceId: "e2", intentId: UUID, error: "23514", attempts: 1, message: "x" }), P("e3"),
    reply({ evidenceId: "e2", intentId: UUID, error: "23514", attempts: 2 })] });
  let o = await processScopedRecordingInbox(p, { env: ENV, by: "t", listingIds: [1] });
  assert.deepEqual(o, { status: "worked", calls: 4, processed: [{ evidenceId: "e1", intentId: UUID, outcome: "consistent", holdId: null },
    { evidenceId: "e3", intentId: UUID, outcome: "consistent", holdId: null }], errors: [{ evidenceId: "e2", intentId: UUID, error: "23514", attempts: 1 },
    { evidenceId: "e2", intentId: UUID, error: "23514", attempts: 2 }], skipped: [], drained: false, stoppedOnRepeatedError: true });
  assert.ok(!JSON.stringify(o).includes("MUST NOT LEAK"), "only projected keys");
  p = fakePool({ replies: [P("e1"), reply({ evidenceId: "e9", intentId: UUID, skipped: "STALE_OUT_OF_SCOPE" }), P("never")] });
  o = await processScopedRecordingInbox(p, { env: ENV, by: "t", listingIds: [1] });
  assert.deepEqual([o.calls, o.skipped, o.processed.length, p.sqls.length], [2, [{ evidenceId: "e9", intentId: UUID }], 1, 3], "stale stops the step");
  p = fakePool({ replies: [reply(null)] });
  assert.deepEqual(await processScopedRecordingInbox(p, { env: ENV, by: "t", listingIds: [1] }),
    { status: "idle", calls: 1, processed: [], errors: [], skipped: [], drained: true, stoppedOnRepeatedError: false });
  p = fakePool({ replies: [P("e1"), reply(null)] });
  o = await processScopedRecordingInbox(p, { env: ENV, by: "t", listingIds: [1] });
  assert.deepEqual([o.status, o.calls, o.drained], ["worked", 2, true]);
  for (const [mi, n] of [[undefined, SCOPED_INBOX_LIMITS.maxItemsDefault], [0, 1], [-7, 1], [3, 3], [1000, SCOPED_INBOX_LIMITS.maxItemsHard]]) {
    p = fakePool({ replies: Array.from({ length: 40 }, (_, k) => P(`e${k}`)) });
    o = await processScopedRecordingInbox(p, { env: ENV, by: "t", listingIds: [1], ...(mi === undefined ? {} : { maxItems: mi }) });
    assert.equal(o.calls, n, `maxItems ${mi}`);
  }
  assert.deepEqual([SCOPED_INBOX_LIMITS.maxItemsDefault, SCOPED_INBOX_LIMITS.maxItemsHard], [10, 25]);
});

test("outer failure at call k: the ORIGINAL error (identity / code / message) is re-thrown immediately, no follow-up query or retry; non-enumerable scopedInboxProgress = attempted calls + acknowledged replies only", async () => {
  for (const k of [1, 3]) {
    const boom = Object.assign(new Error("socket hang up (mock)"), { code: "ECONNRESET" });
    const replies = Array.from({ length: k - 1 }, (_, n) => reply({ evidenceId: `e${n}`, intentId: UUID, outcome: "consistent", holdId: null }));
    replies.push(async () => { throw boom; });
    replies.push(reply({ evidenceId: "never", intentId: UUID, outcome: "consistent", holdId: null }));
    const p = fakePool({ replies });
    const e = await processScopedRecordingInbox(p, { env: ENV, by: "t", listingIds: [1] }).then(() => null, (x) => x);
    assert.equal(e, boom);
    assert.deepEqual([e.code, e.message], ["ECONNRESET", "socket hang up (mock)"]);
    assert.equal(p.sqls.length, 1 + k, "marker + k calls; nothing after the throw");
    assert.ok(!Object.keys(e).includes("scopedInboxProgress"));
    assert.deepEqual(JSON.parse(JSON.stringify(e.scopedInboxProgress)), { calls: k, processed: Array.from({ length: k - 1 }, (_, n) => ({ evidenceId: `e${n}`, intentId: UUID,
      outcome: "consistent", holdId: null })), errors: [], skipped: [] });
  }
  // a frozen error object still propagates unchanged (progress simply not attached)
  const frozen = Object.freeze(new Error("frozen (mock)"));
  const p = fakePool({ replies: [async () => { throw frozen; }] });
  await assert.rejects(processScopedRecordingInbox(p, { env: ENV, by: "t", listingIds: [1] }), (e) => e === frozen);
});

test("per-call copies: a caller / pool mutating listingIds, intentId or the passed params during an awaited query cannot widen or change later calls", async () => {
  const ids = [11, 12]; const opts = { env: ENV, by: "t", listingIds: ids, intentId: UUID };
  const seen = [];
  const p = fakePool({ replies: [
    async (sql, params) => { seen.push(JSON.stringify(params)); ids.push(99); ids[0] = 77; opts.intentId = null; params[1].push(55); return { rows: [{ r: { evidenceId: "e1", intentId: UUID, outcome: "consistent", holdId: null } }] }; },
    async (sql, params) => { seen.push(JSON.stringify(params)); return { rows: [{ r: null }] }; }] });
  const real = p.query;
  p.query = async (sql, params) => { if (/booking\.instance/.test(sql)) { ids.push(1000); opts.listingIds = [1, 2, 3]; } return real(sql, params); };
  const o = await processScopedRecordingInbox(p, opts);
  assert.equal(o.calls, 2);
  assert.deepEqual(seen, [JSON.stringify(["t", [11, 12], UUID]), JSON.stringify(["t", [11, 12], UUID])]);
  // read APIs likewise
  const ids2 = [21];
  const q = fakePool({ replies: [async (sql, params) => ({ rows: [{ s: { params } }] })] });
  const real2 = q.query;
  q.query = async (sql, params) => { if (/booking\.instance/.test(sql)) ids2.push(22); return real2(sql, params); };
  const s = await scopedRecordingInboxSummary(q, { env: ENV, listingIds: ids2 });
  assert.deepEqual(s.summary.params, [[21], null]);
});

test("page: seq stays a decimal STRING end to end (SQL casts seq::text; afterSeq passed as text); next iff rows === EFFECTIVE limit", async () => {
  const big = "9007199254740995";
  for (const [lim, eff] of [[undefined, 50], [0, 1], [2, 2], [999, 200]]) {
    const n = Math.min(eff, 3);
    const p = fakePool({ replies: [async (sql, params) => {
      assert.match(sql, /seq::text AS seq/);
      assert.deepEqual(params, [[5], null, "pending", big, eff]);
      return { rows: Array.from({ length: n }, (_, k) => ({ seq: (BigInt(big) + BigInt(k + 1)).toString(), evidence_id: `e${k}` })) };
    }] });
    const r = await listScopedRecordingInbox(p, { env: ENV, listingIds: [5], status: "pending", after: { afterSeq: big }, ...(lim === undefined ? {} : { limit: lim }) });
    assert.equal(r.status, "ok");
    assert.equal(r.rows.length, n);
    assert.deepEqual(r.next, n === eff ? { afterSeq: (BigInt(big) + BigInt(n)).toString() } : null, `limit ${lim}`);
    assert.ok(r.rows.every((x) => typeof x.seq === "string"));
  }
});
