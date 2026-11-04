// lib/booking-db/recording-inbox.js — Stage E7 (OFFLINE). Scoped recording conflict-inbox: bounded processing + read-only visibility.
// Contract: claude/e7-scoped-recording-inbox-contract.md revision 2 (accepted at 99a78fcf); SQL: db/migrations/0015_scoped_recording_inbox.up.sql.
//
// INTERNAL LIBRARY ONLY (manual / injected invocation): no route, cron, schedule, UI, provider call, notification or environment read. The caller passes
// the env OBJECT and a pool. Scope is a SELECTION boundary, NOT tenant authentication: `by` and any labels stay TRUST; the database role grants + RLS
// remain the access boundary. Nothing here calls the legacy global processor / drain (no fallback). No production cadence or latency promise.
//
// Per call: options are read ONCE into a frozen local copy (listingIds copied element by element) before any await, so a caller / pool / query
// callback mutating its own objects later cannot widen this call. Validation (zero queries) -> ONE explicit marker SELECT -> work.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BY_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const SEQ_RE = /^[1-9][0-9]{0,18}$/;
const INT4_MAX = 2147483647;
const BIGINT_MAX = 9223372036854775807n;
export const SCOPED_INBOX_LIMITS = Object.freeze({ listingIdsMax: 50, maxItemsDefault: 10, maxItemsHard: 25, pageLimitDefault: 50, pageLimitHard: 200 });
export const SCOPED_INBOX_STATUSES = Object.freeze(["pending", "processed", "all"]);

const refused = (code) => Object.freeze({ status: "refused", code });
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** Read the allowed own keys ONCE into a plain copy. -> { ok:true, o } | { ok:false } */
function snapshot(opts, keys) {
  if (!isPlain(opts)) return { ok: false };
  const own = Object.keys(opts);
  if (own.some((k) => !keys.includes(k))) return { ok: false };
  const o = {};
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
  return { ok: true, o };
}

/** Common: env gate + read scope. -> { code } | { scope: frozen { listingIds, intentId } } */
function commonGate(o) {
  const env = o.env;
  if (!isPlain(env)) return { code: "ENV_REQUIRED" };
  const vercel = env.VERCEL_ENV; const flag = env.MV_E7_RECORDING_INBOX;
  if (vercel === "production") return { code: "PRODUCTION_REFUSED" };
  if (vercel !== "development" && vercel !== "preview") return { code: "ENVIRONMENT_NOT_ALLOWED" };
  if (flag !== "enabled") return { code: "NOT_ENABLED" };
  const src = o.listingIds;
  if (!Array.isArray(src)) return { code: "SCOPE_INVALID" };
  const len = src.length;
  if (!(len >= 1 && len <= SCOPED_INBOX_LIMITS.listingIdsMax)) return { code: "SCOPE_INVALID" };
  const ids = [];
  for (let k = 0; k < len; k++) ids.push(src[k]);
  if (ids.some((x) => !Number.isInteger(x) || x < 1 || x > INT4_MAX) || new Set(ids).size !== ids.length) return { code: "SCOPE_INVALID" };
  const intentId = o.intentId === undefined ? null : o.intentId;
  if (intentId !== null && (typeof intentId !== "string" || !UUID_RE.test(intentId))) return { code: "INTENT_ID_INVALID" };
  return { scope: Object.freeze({ listingIds: Object.freeze(ids), intentId }) };
}
const isPool = (p) => !!p && typeof p.query === "function" && typeof p.connect === "function" && typeof p.totalCount === "number";
const isQueryable = (p) => !!p && typeof p.query === "function";

/** ONE explicit marker SELECT. Thrown errors propagate unchanged (no catch). -> true | refusal */
async function markerIsTest(pool) {
  const r = await pool.query("SELECT environment FROM booking.instance");
  const marker = r && Array.isArray(r.rows) && r.rows[0] ? r.rows[0].environment : undefined;
  return marker === "test";
}

const attachProgress = (e, out) => {
  if (e && typeof e === "object" && Object.isExtensible(e)) {
    try {
      Object.defineProperty(e, "scopedInboxProgress", { value: Object.freeze({ calls: out.calls, processed: Object.freeze([...out.processed]),
        errors: Object.freeze([...out.errors]), skipped: Object.freeze([...out.skipped]) }), enumerable: false, configurable: true });
    } catch { /* the original error is propagated regardless */ }
  }
};

/**
 * processScopedRecordingInbox(pool, { env, by, listingIds, intentId?, maxItems? })
 *   pool: a real pg.Pool (each call its own autocommit statement) — never a client inside an open transaction.
 *   -> refusal { status:'refused', code } (zero queries; DATABASE_NOT_TEST after the one marker query)
 *    | { status:'worked'|'idle', calls, processed:[{evidenceId,intentId,outcome,holdId}], errors:[{evidenceId,intentId,error,attempts}],
 *        skipped:[{evidenceId,intentId}], drained, stoppedOnRepeatedError }
 *   `calls` = ATTEMPTED processor calls (a call that threw counts); the arrays hold ACKNOWLEDGED replies only. A recorded item error is data (its
 *   attempts persist; it stays queued); the same item erroring twice stops the step; a STALE skip (zero mutation) stops the step.
 *   A thrown call (query / transport / unknown COMMIT) stops IMMEDIATELY: the ORIGINAL error is re-thrown with no follow-up query or retry, with a
 *   non-enumerable `scopedInboxProgress` describing only the replies received; the thrown call itself may or may not have committed (UNKNOWN).
 */
export async function processScopedRecordingInbox(pool, opts) {
  const s = snapshot(opts, ["env", "by", "listingIds", "intentId", "maxItems"]);
  if (!s.ok) return refused("OPTIONS_INVALID");
  const g = commonGate(s.o);
  if (g.code) return refused(g.code);
  const by = s.o.by;
  if (typeof by !== "string" || !BY_RE.test(by)) return refused("BY_INVALID");
  const mi = s.o.maxItems;
  let bound;
  if (mi === undefined) bound = SCOPED_INBOX_LIMITS.maxItemsDefault;
  else if (Number.isSafeInteger(mi)) bound = Math.max(1, Math.min(SCOPED_INBOX_LIMITS.maxItemsHard, mi));
  else return refused("MAX_ITEMS_INVALID");
  if (!isPool(pool)) return refused("POOL_REQUIRED");
  const { listingIds, intentId } = g.scope;
  if (!(await markerIsTest(pool))) return refused("DATABASE_NOT_TEST");
  const out = { calls: 0, processed: [], errors: [], skipped: [], drained: false, stoppedOnRepeatedError: false };
  const errored = new Set();
  while (out.calls < bound) {
    out.calls += 1;
    let res;
    try { res = await pool.query("SELECT booking.process_recording_conflict_inbox_scoped_one($1, $2::int[], $3::uuid) AS r", [by, [...listingIds], intentId]); }
    catch (e) { attachProgress(e, out); throw e; }
    const row = res && Array.isArray(res.rows) ? res.rows[0] : undefined;
    if (!row || !Object.prototype.hasOwnProperty.call(row, "r")) {
      const e = new TypeError("processScopedRecordingInbox: unexpected reply shape");
      attachProgress(e, out); throw e;
    }
    const r = row.r;
    if (r === null) { out.drained = true; break; }
    if (r.skipped === "STALE_OUT_OF_SCOPE") { out.skipped.push(Object.freeze({ evidenceId: r.evidenceId, intentId: r.intentId })); break; }
    if (typeof r.error === "string") {
      out.errors.push(Object.freeze({ evidenceId: r.evidenceId, intentId: r.intentId, error: r.error, attempts: r.attempts }));
      if (errored.has(r.evidenceId)) { out.stoppedOnRepeatedError = true; break; }
      errored.add(r.evidenceId);
      continue;
    }
    out.processed.push(Object.freeze({ evidenceId: r.evidenceId, intentId: r.intentId, outcome: r.outcome, holdId: r.holdId ?? null }));
  }
  const idle = out.calls === 1 && out.drained && out.processed.length === 0 && out.errors.length === 0 && out.skipped.length === 0;
  return Object.freeze({ status: idle ? "idle" : "worked", calls: out.calls, processed: Object.freeze(out.processed), errors: Object.freeze(out.errors),
    skipped: Object.freeze(out.skipped), drained: out.drained, stoppedOnRepeatedError: out.stoppedOnRepeatedError });
}

const PAGE_COLUMNS = `seq::text AS seq, evidence_id, intent_id, listing_id, intent_state, enqueued_at_exact, db_now_exact, attempts, last_attempt_at_exact,
  last_error_code, processed_at_exact, outcome, hold_id, hold_reason, hold_active, case_id, case_status, latest_op_id, latest_op_state, latest_op_linked,
  evidence_source, evidence_observed_at_exact, evidence_read_operation_id`;

/**
 * listScopedRecordingInbox(pool, { env, listingIds, intentId?, status, after?, limit? })   READ-ONLY
 *   after = null | { afterSeq: canonical decimal STRING } (bigint; never coerced to Number). limit: omitted -> 50, integer -> clamped 1..200.
 *   -> refusal | { status:'ok', rows:[{ seq: decimal string, ... }], next: { afterSeq } | null }  (next iff rows.length === effective limit)
 */
export async function listScopedRecordingInbox(pool, opts) {
  const s = snapshot(opts, ["env", "listingIds", "intentId", "status", "after", "limit"]);
  if (!s.ok) return refused("OPTIONS_INVALID");
  const g = commonGate(s.o);
  if (g.code) return refused(g.code);
  const status = s.o.status;
  if (!SCOPED_INBOX_STATUSES.includes(status)) return refused("STATUS_INVALID");
  const after = s.o.after === undefined ? null : s.o.after;
  let afterSeq = null;
  if (after !== null) {
    const a = snapshot(after, ["afterSeq"]);
    const v = a.ok ? a.o.afterSeq : undefined;
    if (typeof v !== "string" || !SEQ_RE.test(v) || BigInt(v) > BIGINT_MAX) return refused("CURSOR_INVALID");
    afterSeq = v;
  }
  const lim = s.o.limit;
  let limit;
  if (lim === undefined) limit = SCOPED_INBOX_LIMITS.pageLimitDefault;
  else if (Number.isSafeInteger(lim)) limit = Math.max(1, Math.min(SCOPED_INBOX_LIMITS.pageLimitHard, lim));
  else return refused("LIMIT_INVALID");
  if (!isQueryable(pool)) return refused("POOL_REQUIRED");
  const { listingIds, intentId } = g.scope;
  if (!(await markerIsTest(pool))) return refused("DATABASE_NOT_TEST");
  const r = await pool.query(`SELECT ${PAGE_COLUMNS} FROM booking.recording_inbox_page($1::int[], $2::uuid, $3::text, $4::bigint, $5::int)`,
    [[...listingIds], intentId, status, afterSeq, limit]);
  const rows = Object.freeze(r.rows.map((x) => Object.freeze({ ...x })));
  const next = rows.length === limit ? Object.freeze({ afterSeq: rows[rows.length - 1].seq }) : null;
  return Object.freeze({ status: "ok", rows, next });
}

/** scopedRecordingInboxSummary(pool, { env, listingIds, intentId? })  READ-ONLY -> refusal | { status:'ok', summary } (one SQL statement) */
export async function scopedRecordingInboxSummary(pool, opts) {
  const s = snapshot(opts, ["env", "listingIds", "intentId"]);
  if (!s.ok) return refused("OPTIONS_INVALID");
  const g = commonGate(s.o);
  if (g.code) return refused(g.code);
  if (!isQueryable(pool)) return refused("POOL_REQUIRED");
  const { listingIds, intentId } = g.scope;
  if (!(await markerIsTest(pool))) return refused("DATABASE_NOT_TEST");
  const r = await pool.query("SELECT booking.recording_inbox_summary($1::int[], $2::uuid) AS s", [[...listingIds], intentId]);
  return Object.freeze({ status: "ok", summary: Object.freeze(r.rows[0].s) });
}
