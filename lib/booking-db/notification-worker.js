// lib/booking-db/notification-worker.js — Stage E7 guest notification STAGE 2 (OFFLINE / INJECTED MOCK). ONE bounded notification step.
// Contract: claude/e7-guest-notification-contract.md revision 3 (§2, §6, §9, §10) as corrected by §15.9; Stage 1 DB fence 0016 (accepted
// at 35097c56). INTERNAL LIBRARY ONLY: no route, cron, scheduler, SDK, fetch, SMTP, secret, environment read or default transport. The
// ONLY way anything is "sent" is the INJECTED executors.sendMessage — trusted code: a `mock-` label or a `.invalid` address does not prove
// it is a mock. Every notification-owned write goes through the accepted 0016 SECURITY DEFINER functions (no raw runtime UPDATE, no generic
// helper, no admin API, no global fallback).
//
// Guarantees of THIS reviewed worker (the DB enforces at most one CLAIM; it cannot count injected calls):
//   * at most ONE sendMessage invocation per claimed row, started synchronously right after the final local decision (no await / hook /
//     query in between); never retried — timeout, abort, throw, an ambiguous / non-exact reply, a lost reply, lease expiry, a crash or a
//     COMMIT ambiguity all end as a durable UNKNOWN (or a later lease expiry → unknown by maintenance), never a resend;
//   * every database error (query / COMMIT / transport) propagates as the ORIGINAL object with NO further query, release or mutation
//     (the work / op leases simply expire); executor errors are classified to a code only (never read, parsed, persisted or returned);
//   * results / diagnostics carry ids, codes and counts only — never a recipient, name, subject, body, reply or error detail.
// Accepted, documented race: a contradiction / late money / protection committed AFTER the pre-send observation (or during the mock's
// processing) can coincide with a sent message; it is visible afterwards and never "un-sent". No freshness / provider / exactly-once claim.
import { TEMPLATE_VERSION, RECIPIENT_RE, SENDER_NAME_RE, buildMessageRequest, contentHash, classifyReply, recipientHash } from "../checkout/guest-notification.js";

export const NOTIFICATION_WORKER_VERSION = "e7-notification-worker-v1";
/** fixed budgets (not configurable by options) */
export const NOTIFICATION_LIMITS = Object.freeze({
  maintenanceBatch: 5,           // recover_expired_notifications batch
  sendTimeoutMs: 10000,          // ONE bounded sendMessage
  presendMarginMs: 5000,         // op / work lease room required beyond the send timeout
  maxSkewMs: 2000,               // |JS clock − DB clock|
  skewRoundTripMs: 1000,         // the skew probe itself must be quick
  observationBudgetMs: 2000,     // monotonic elapsed from BEFORE an observation's BEGIN through its COMMIT
  stepBudgetMs: 30000,           // monotonic budget from step start to the invocation decision
  lateWindowMs: 2000             // in-memory late-reply observation window (no DB write ever)
});
export const NOTIFICATION_OPTION_KEYS = Object.freeze(["clock", "env", "executors", "hooks", "intentId", "listingIds", "sender", "workerId"]);
const HOOK_KEYS = Object.freeze(["afterInitialObservation", "afterClaim", "inObservation", "afterSend"]);
const WORKER_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LABEL_RE = /^mock-[a-z0-9-]{1,40}$/;
const NONE_LATE = Object.freeze({ kind: "none" });
const SNAPSHOT_CLASSES = Object.freeze(["NOT_NOTIFY", "PROTECTED", "SUCCEEDED", "IN_FLIGHT", "UNKNOWN", "OTHER", "LATCHED", "OUT_OF_V1_SCOPE", "WAITING", "ELIGIBLE"]);
const CLASS_OUTCOME = Object.freeze({ NOT_NOTIFY: "not_claimable", SUCCEEDED: "not_claimable", IN_FLIGHT: "not_claimable", UNKNOWN: "not_claimable",
  OTHER: "not_claimable", LATCHED: "latched", OUT_OF_V1_SCOPE: "waiting", WAITING: "waiting" });
const CLAIM_STATUSES = Object.freeze(["claimed", "protected", "latched", "waiting", "not_claimable"]);
const LATCH_RESULTS = Object.freeze(["LATCHED", "PROTECTED", "NOT_ELIGIBLE", "WORK_LEASE"]);
const SETTLE_RESULTS = Object.freeze(["succeeded", "outcome_unknown", "LEASE_LOST", "PROTECTED"]);


const isPlain = (o) => o !== null && typeof o === "object" && !Array.isArray(o) && [Object.prototype, null].includes(Object.getPrototypeOf(o));
/** own enumerable DATA properties only (no getters / inherited / symbol keys); null when the object does not qualify */
function dataProps(o) {
  if (!isPlain(o)) return null;
  const d = Object.getOwnPropertyDescriptors(o);
  const out = {};
  for (const k of Reflect.ownKeys(d)) {
    if (typeof k !== "string" || !("value" in d[k]) || !d[k].enumerable) return null;
    out[k] = d[k].value;
  }
  return out;
}
const done = (fields) => Object.freeze({ ok: true, late: Promise.resolve(NONE_LATE), ...fields });
const refused = (code) => Object.freeze({ ok: false, code });

// ---------------------------------------------------------------------------------------------
// gate (pure; ZERO queries). Returns a deep-frozen COPY taken before any await: later mutation of the caller's objects changes nothing.

export function notificationWorkerGate(opts) {
  const o = dataProps(opts);
  if (!o) return refused("OPTIONS_INVALID");
  for (const k of Object.keys(o)) if (!NOTIFICATION_OPTION_KEYS.includes(k)) return refused("OPTIONS_INVALID");
  const env = dataProps(o.env);
  if (!env) return refused("OPTIONS_INVALID");
  if (env.VERCEL_ENV === "production" || !["development", "preview"].includes(env.VERCEL_ENV) || env.MV_E7_NOTIFICATION_WORKER !== "enabled") return refused("ENV_REFUSED");
  if (typeof o.workerId !== "string" || !WORKER_RE.test(o.workerId)) return refused("OPTIONS_INVALID");
  if (!Array.isArray(o.listingIds) || o.listingIds.length < 1 || o.listingIds.length > 50 || Object.getPrototypeOf(o.listingIds) !== Array.prototype
      || o.listingIds.some((x) => !Number.isSafeInteger(x) || x <= 0 || x > 2147483647) || new Set(o.listingIds).size !== o.listingIds.length) return refused("OPTIONS_INVALID");
  if (o.intentId !== undefined && o.intentId !== null && (typeof o.intentId !== "string" || !UUID_RE.test(o.intentId))) return refused("OPTIONS_INVALID");
  const sender = dataProps(o.sender);
  if (!sender || JSON.stringify(Object.keys(sender).sort()) !== '["fromAddress","fromName"]' || typeof sender.fromAddress !== "string" || sender.fromAddress.length > 254 || !RECIPIENT_RE.test(sender.fromAddress)
      || typeof sender.fromName !== "string" || !SENDER_NAME_RE.test(sender.fromName)) {
    return refused("OPTIONS_INVALID");
  }
  const ex = dataProps(o.executors);
  if (!ex || JSON.stringify(Object.keys(ex).sort()) !== '["label","sendMessage"]' || typeof ex.sendMessage !== "function"
      || typeof ex.label !== "string" || !LABEL_RE.test(ex.label)) return refused("OPTIONS_INVALID");
  if (typeof o.clock !== "function") return refused("OPTIONS_INVALID");
  let hooks = Object.freeze({});
  if (o.hooks !== undefined) {
    const h = dataProps(o.hooks);
    if (!h || Object.keys(h).some((k) => !HOOK_KEYS.includes(k) || typeof h[k] !== "function")) return refused("OPTIONS_INVALID");
    hooks = Object.freeze({ ...h });
  }
  // the explicit synthetic sender is validated here (zero queries) and once more by the pure request builder, before any claim
  const basis = Object.freeze({ workerId: o.workerId, listingIds: Object.freeze([...o.listingIds]), intentId: o.intentId ?? null,
    sender: Object.freeze({ fromAddress: sender.fromAddress, fromName: sender.fromName }), sendMessage: ex.sendMessage, label: ex.label, clock: o.clock, hooks });
  return Object.freeze({ ok: true, basis });
}

// ---------------------------------------------------------------------------------------------
// R-C1 observation wrapper: fresh connection → BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY → exactly ONE observation SELECT →
// COMMIT → return. No earlier query in that transaction, no reused snapshot, no network inside it. Any query / COMMIT error propagates
// as the ORIGINAL object after a best-effort ROLLBACK and connection disposal only (no mutation, release or retry afterwards).

async function observe(ctx, sql, params, kind) {
  const c = await ctx.pool.connect();
  let broken = false;
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const r = (await c.query(sql, params)).rows[0].r;
    if (ctx.basis.hooks.inObservation) await ctx.basis.hooks.inObservation(kind);   // TEST ONLY: inside the read-only transaction
    await c.query("COMMIT");
    return r;
  } catch (e) {
    broken = true;
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release(broken ? true : undefined);              // a failed transaction's connection is discarded, never reused
  }
}
const one = async (ctx, sql, params) => (await ctx.pool.query(sql, params)).rows[0].r;
/** release_notification_work → 'RELEASED' | 'NOT_HELD' | 'PROTECTED' (PROTECTED: nothing written, the lease expires); anything else is an invariant break */
async function releaseWork(ctx, intentId) {
  const r = await one(ctx, "SELECT booking.release_notification_work($1, $2) AS r", [intentId, ctx.basis.workerId]);
  if (!["RELEASED", "NOT_HELD", "PROTECTED"].includes(r)) throw new TypeError("notification worker: unexpected release result");
  return r;
}
const settle = (ctx, opId, kind, ref, code) => one(ctx, "SELECT booking.complete_guest_notification($1, $2, $3, $4, $5) AS r", [opId, ctx.basis.workerId, kind, ref, code]);

/** the ONE bounded invocation, started synchronously by the caller; resolves to a code-only classification (never throws) */
function invoke(ctx, request) {
  const ac = new AbortController();
  let raw;
  try { raw = Promise.resolve(ctx.basis.sendMessage(request, { signal: ac.signal })); } catch (e) { raw = Promise.reject(e); }
  let timer;
  const outcome = new Promise((resolve) => {
    timer = setTimeout(() => { ac.abort(); resolve({ kind: "unknown", code: "SEND_TIMEOUT", timedOut: true }); }, NOTIFICATION_LIMITS.sendTimeoutMs);
    raw.then((v) => { clearTimeout(timer); resolve(classifyReply(v)); }, () => { clearTimeout(timer); resolve({ kind: "unknown", code: "SEND_THREW" }); });
  });
  return { outcome, raw };
}
/** a late reply after the timeout: observed IN MEMORY only, within a finite window; never a DB write; code-only */
function observeLate(raw) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(NONE_LATE); } }, NOTIFICATION_LIMITS.lateWindowMs);
    raw.then((v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(Object.freeze({ kind: "late_reply", classified: classifyReply(v).kind })); } },
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve(Object.freeze({ kind: "late_reply", classified: "rejected" })); } });
  });
}

// ---------------------------------------------------------------------------------------------

/**
 * runNotificationStep(pool, opts) → deep-frozen result:
 *   { ok:false, code }  gate refusals (OPTIONS_INVALID, ENV_REFUSED — ZERO queries) or DATABASE_NOT_TEST / CLOCK_SKEW;
 *   { ok:true, outcome, sends, ... } (contract §9.3 / §16.3; `protected` carries no ids) with outcome ∈ idle | accepted | unknown | latched | waiting | protected | not_claimable | lease_lost.
 * Throws ONLY the identical outer database error (no follow-up query) or a TypeError for an internal invariant break.
 */
export async function runNotificationStep(pool, opts) {
  const g = notificationWorkerGate(opts);
  if (!g.ok) return g;
  const b = g.basis;
  const monoStart = performance.now();
  const ctx = { pool, basis: b };
  // ONE explicit marker SELECT: only a successfully read non-'test' / absent marker is the structured refusal
  const marker = (await pool.query("SELECT environment FROM booking.instance")).rows[0]?.environment;
  if (marker !== "test") return refused("DATABASE_NOT_TEST");
  // JS clock vs DB clock (the database's own clocks stay authoritative)
  const m0 = performance.now(); const t0 = b.clock();
  const dbt = Date.parse((await pool.query("SELECT clock_timestamp() AS t")).rows[0].t.toISOString());
  const t1 = b.clock(); const m1 = performance.now();
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || m1 - m0 > NOTIFICATION_LIMITS.skewRoundTripMs
      || Math.abs(dbt - t0) > NOTIFICATION_LIMITS.maxSkewMs || Math.abs(dbt - t1) > NOTIFICATION_LIMITS.maxSkewMs) return refused("CLOCK_SKEW");

  // 1. bounded notification-scoped maintenance (never the generic helpers, never an inbox drain)
  await one(ctx, "SELECT booking.recover_expired_notifications($1, $2, $3) AS r", [b.listingIds, b.intentId, NOTIFICATION_LIMITS.maintenanceBatch]);
  // 2. at most ONE due work lease
  const wk = await one(ctx, "SELECT booking.claim_notification_work($1, $2, $3) AS r", [b.workerId, b.listingIds, b.intentId]);
  if (wk.status === "idle") return done({ outcome: "idle", sends: 0 });
  if (wk.status !== "acquired" || !UUID_RE.test(wk.opId) || !UUID_RE.test(wk.intentId)) throw new TypeError("notification worker: unexpected work result");
  const opId = wk.opId; const intentId = wk.intentId;

  // 3. initial observation (RR read-only) → pure request
  const s = await observe(ctx, "SELECT booking.guest_notification_snapshot($1) AS r", [opId], "snapshot");
  if (b.hooks.afterInitialObservation) await b.hooks.afterInitialObservation(opId);
  if (!SNAPSHOT_CLASSES.includes(s?.class)) throw new TypeError("notification worker: unexpected snapshot class");
  if (s.class === "PROTECTED") return done({ outcome: "protected", sends: 0 });               // zero writes; the work lease expires
  if (s.class !== "ELIGIBLE") {
    const rel = await releaseWork(ctx, intentId);
    return done({ outcome: CLASS_OUTCOME[s.class], sends: 0, opId, code: s.class, release: rel });
  }
  // ELIGIBLE: s.code is the SQL refusal at the snapshot (NULL = qualifies). A refused row still goes to the dedicated claim, which
  // records the exact SQL latch / waiting code (or claims legitimately if the row became qualified with the same facts / recipient).
  const template = s.template;
  const built = (typeof s.email === "string" && typeof s.firstName === "string" && s.recipientHash === recipientHash(s.email, s.firstName))
    ? buildMessageRequest({ template, facts: s.facts, guest: { email: s.email, firstName: s.firstName }, sender: { ...b.sender }, opId })
    : Object.freeze({ ok: false, code: "RECIPIENT_INVALID" });
  if (!built.ok) {
    // the authorized RENDER_FAILED latch; never a fabricated recipient / message to get past the claim
    const l = await one(ctx, "SELECT booking.latch_guest_notification($1, $2, 'RENDER_FAILED') AS r", [opId, b.workerId]);
    if (!LATCH_RESULTS.includes(l)) throw new TypeError("notification worker: unexpected latch result");
    if (l === "PROTECTED") return done({ outcome: "protected", sends: 0 });
    const rel = await releaseWork(ctx, intentId);
    return done({ outcome: l === "LATCHED" ? "latched" : "not_claimable", sends: 0, opId, code: l === "LATCHED" ? "RENDER_FAILED" : l, renderCode: built.code, release: rel });
  }
  const request = built.request;
  const hash = contentHash(request);

  // 4. dedicated claim with the exact hashes
  const c = await one(ctx, "SELECT booking.claim_guest_notification($1, $2, $3, $4, $5, $6) AS r", [opId, b.workerId, TEMPLATE_VERSION, hash, s.factsHash, s.recipientHash]);
  if (!CLAIM_STATUSES.includes(c?.status)) throw new TypeError("notification worker: unexpected claim result");
  if (c.status === "protected") return done({ outcome: "protected", sends: 0 });
  if (c.status !== "claimed") {
    const rel = await releaseWork(ctx, intentId);
    return done({ outcome: c.status, sends: 0, opId, code: c.code, release: rel });            // latched | waiting | not_claimable
  }
  if (b.hooks.afterClaim) await b.hooks.afterClaim(opId);

  // 5. fresh pre-send observation (RR read-only); elapsed on the REAL monotonic clock from BEFORE the observation through its COMMIT
  const p0 = performance.now();
  const ps = await observe(ctx, "SELECT booking.guest_notification_presend($1, $2) AS r", [opId, b.workerId], "presend");
  const p1 = performance.now();
  if (typeof ps?.ok !== "boolean") throw new TypeError("notification worker: unexpected pre-send result");
  if (!ps.ok && ps.code === "PROTECTED") return done({ outcome: "protected", sends: 0 });      // zero writes; leases expire
  // 6. final SYNCHRONOUS checks: no await / hook / query from here to the invocation
  let abort = null;
  if (!ps.ok) abort = typeof ps.code === "string" ? ps.code : "PRESEND_REFUSED";
  else {
    const dbNow = Date.parse(ps.dbNow); const opUntil = Date.parse(ps.opLeaseUntil); const workUntil = Date.parse(ps.workLeaseUntil);
    const now = b.clock(); const mono = performance.now();
    const room = NOTIFICATION_LIMITS.sendTimeoutMs + NOTIFICATION_LIMITS.presendMarginMs;
    const sinceObs = mono - p0;                                       // already spent since BEFORE the observation (never negative)
    if (ps.contentHash !== hash || ps.templateVersion !== TEMPLATE_VERSION || ps.messageRef !== request.messageRef) abort = "REQUEST_MISMATCH";
    else if (p1 - p0 > NOTIFICATION_LIMITS.observationBudgetMs) abort = "OBSERVATION_SLOW";
    else if (!Number.isFinite(dbNow) || !Number.isFinite(opUntil) || !Number.isFinite(workUntil)) abort = "PRESEND_SHAPE";
    else if (typeof now !== "number" || !Number.isFinite(now) || Math.abs(now - dbNow) > NOTIFICATION_LIMITS.maxSkewMs) abort = "CLOCK_SKEW";
    else if (!(opUntil - dbNow - sinceObs >= room) || !(workUntil - dbNow - sinceObs >= room)) abort = "LEASE_ROOM";
    else if (mono - monoStart + NOTIFICATION_LIMITS.sendTimeoutMs > NOTIFICATION_LIMITS.stepBudgetMs) abort = "STEP_BUDGET";
  }
  if (abort) {
    // safe unknown, NOT invoked (no outer DB failure occurred; protection not visible in the observation)
    const r = await settle(ctx, opId, "unknown", null, "PRESEND_ABORTED_NOT_INVOKED");
    if (!SETTLE_RESULTS.includes(r) || r === "succeeded") throw new TypeError("notification worker: unexpected settlement result");
    if (r === "PROTECTED") return done({ outcome: "protected", sends: 0, abort });
    const rel = await releaseWork(ctx, intentId);
    return done({ outcome: r === "outcome_unknown" ? "unknown" : "lease_lost", sends: 0, opId, code: r === "outcome_unknown" ? "PRESEND_ABORTED_NOT_INVOKED" : r, abort, release: rel });
  }
  // 7. the ONE invocation, started synchronously right after the decision above; never retried
  const call = invoke(ctx, request);
  const sends = 1;
  const cls = await call.outcome;
  const late = cls.timedOut ? observeLate(call.raw) : Promise.resolve(NONE_LATE);
  if (b.hooks.afterSend) await b.hooks.afterSend(opId);
  // 8. dedicated settlement; an outer DB error propagates unchanged with NO further query (the in_flight row later becomes unknown)
  const r = cls.kind === "accepted" ? await settle(ctx, opId, "accepted", cls.providerMessageId, null) : await settle(ctx, opId, "unknown", null, cls.code);
  if (!SETTLE_RESULTS.includes(r) || (r === "succeeded" && cls.kind !== "accepted") || (r === "outcome_unknown" && cls.kind === "accepted")) {
    throw new TypeError("notification worker: unexpected settlement result");
  }
  if (r === "PROTECTED") return Object.freeze({ ok: true, outcome: "protected", sends, late });          // zero further writes
  // the acknowledged settlement is durable; a later release failure propagates but never reclassifies it (no try / finally)
  const rel = await releaseWork(ctx, intentId);
  if (r === "LEASE_LOST") return Object.freeze({ ok: true, outcome: "lease_lost", sends, opId, code: cls.kind === "accepted" ? "ACCEPTED_AFTER_LEASE" : cls.code, release: rel, late });
  if (r === "succeeded") return Object.freeze({ ok: true, outcome: "accepted", sends, opId, template, contentHashPrefix: hash.slice(0, 8), release: rel, late });
  return Object.freeze({ ok: true, outcome: "unknown", sends, opId, template, code: cls.code, release: rel, late });
}

export const _internal = Object.freeze({ observe, invoke, observeLate });
