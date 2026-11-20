// scripts/mv-pipeline.mjs — P2c-2: ONE mode-aware pipeline runner (design: PRODUCTION.md, "P2c design").
//
// One bounded run: every paid booking on an approved listing is taken through reserve -> capture -> record by the existing, mode-aware
// coordinator and workers (their claims, proofs, fences and write budgets are unchanged and remain the authority). This file only
// SELECTS the bookings, serialises runs with one advisory lock and reports codes and counts. It never builds a provider request itself.
//
//   runPipelineOnce(pool, cfg, deps) -> frozen { version, mode, outcome, code, counts, intents }
//     outcome OK         nothing needed attention (bookings confirmed, pending on a due time, or nothing to do)
//             ATTENTION  at least one booking STOPPED / was REFUSED / has an open case: a person must look (exit 1 -> GitHub emails the owner)
//             BUSY       another run holds the lock: nothing read or written beyond the lock attempt (exit 0)
//             REFUSED    configuration or environment mismatch: nothing claimed, no provider call (exit 1)
//   cfg  { mode: "test" | "live", listings: Map(listingId -> { currency: "USD" }), notBefore: ISO instant, maxIntents?: 1..10 (default 3), workerId }
//        notBefore: only bookings CREATED at or after it are ever selected (older rows, e.g. the fenced historic TEST rows, are never touched).
//        test: listings must be exactly the TEST listing; live: 1..60 listings, never the TEST listing. USD only.
//   deps { buildPhases(intent, cfg) -> { phases, env, clock, recordingClock? } }   the provider wiring for ONE booking (bound executors).
//        Production wiring is P2c-3; tests inject a fake provider world. No result or log carries guest data: ids, codes and counts only.
import { runTestPipelineCoordinator, TEST_LISTING_ID } from "../lib/booking-db/test-pipeline-coordinator.js";

export const MV_PIPELINE_VERSION = "mv-pipeline-v1";
export const LOCK_NAME = "mv-pipeline-runner";                 // one runner at a time per database (session advisory lock)
export const MAX_LISTINGS = 60;
export const DEFAULT_MAX_INTENTS = 3;
export const MAX_INTENTS_LIMIT = 10;
/** the states the coordinator can advance (its PHASE_OF) */
export const PIPELINE_STATES = Object.freeze(["payment_authorized", "reservation_pending", "reservation_confirmed", "payment_captured"]);
/** states that need a person; reported, never advanced */
export const ATTENTION_STATES = Object.freeze(["reservation_unknown", "capture_unknown"]);

const { freeze } = Object;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const WORKER_RE = /^[A-Za-z0-9._:-]{1,40}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CODE_RE = /^[A-Z0-9_:!>.-]{1,80}$/;
const safe = (v, fb) => (typeof v === "string" && CODE_RE.test(v) ? v : fb);

/** Strict configuration check (no I/O). -> { ok:true, cfg } | { ok:false, code } */
export function validatePipelineConfig(cfg) {
  if (!isObj(cfg)) return { ok: false, code: "CONFIG_REQUIRED" };
  if (cfg.mode !== "test" && cfg.mode !== "live") return { ok: false, code: "MODE_INVALID" };
  if (typeof cfg.workerId !== "string" || !WORKER_RE.test(cfg.workerId)) return { ok: false, code: "WORKER_ID_INVALID" };
  if (!(cfg.listings instanceof Map) || cfg.listings.size < 1 || cfg.listings.size > MAX_LISTINGS) return { ok: false, code: "LISTINGS_INVALID" };
  const ids = [];
  for (const [id, lc] of cfg.listings) {
    if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647) return { ok: false, code: "LISTINGS_INVALID" };
    if (!isObj(lc) || lc.currency !== "USD") return { ok: false, code: "CURRENCY_NOT_SUPPORTED" };
    ids.push(id);
  }
  if (cfg.mode === "test" && (ids.length !== 1 || ids[0] !== TEST_LISTING_ID)) return { ok: false, code: "LISTING_NOT_TEST_FIXED" };
  if (cfg.mode === "live" && ids.includes(TEST_LISTING_ID)) return { ok: false, code: "LISTING_NOT_LIVE_SCOPED" };
  if (typeof cfg.notBefore !== "string" || !ISO_RE.test(cfg.notBefore) || !Number.isFinite(Date.parse(cfg.notBefore))) return { ok: false, code: "NOT_BEFORE_INVALID" };
  const maxIntents = cfg.maxIntents === undefined ? DEFAULT_MAX_INTENTS : cfg.maxIntents;
  if (!Number.isSafeInteger(maxIntents) || maxIntents < 1 || maxIntents > MAX_INTENTS_LIMIT) return { ok: false, code: "MAX_INTENTS_INVALID" };
  return { ok: true, cfg: freeze({ mode: cfg.mode, workerId: cfg.workerId, listingIds: freeze(ids.sort((a, b) => a - b)), listings: cfg.listings, notBefore: cfg.notBefore, maxIntents }) };
}

const SELECT_SQL = `SELECT i.id::text AS id, i.ref, i.listing_id, i.state,
         (SELECT count(*)::int FROM booking.reconciliation_cases c WHERE c.intent_id = i.id AND c.status = 'open') AS open_cases
    FROM booking.intents i
   WHERE i.environment = $1 AND i.listing_id = ANY($2::int[]) AND i.state = ANY($3::text[]) AND i.created_at >= $5::timestamptz
   ORDER BY i.created_at, i.id
   LIMIT $4`;

export async function runPipelineOnce(pool, cfgIn, deps = {}) {
  const v = validatePipelineConfig(cfgIn);
  const counts = { candidates: 0, confirmed: 0, pending: 0, stopped: 0, attention: 0 };
  const intents = [];
  const out = (outcome, code) => freeze({ version: MV_PIPELINE_VERSION, mode: v.ok ? v.cfg.mode : null, outcome, code,
    counts: freeze({ ...counts }), intents: freeze(intents.map(freeze)) });
  if (!v.ok) return out("REFUSED", v.code);
  if (typeof deps.buildPhases !== "function") return out("REFUSED", "PROVIDER_WIRING_REQUIRED");
  const cfg = v.cfg;
  const client = await pool.connect();
  let locked = false;
  try {
    const markers = (await client.query("SELECT environment FROM booking.instance")).rows;
    if (markers.length !== 1 || markers[0].environment !== cfg.mode) return out("REFUSED", "DATABASE_NOT_CONFIGURED_MODE");
    locked = (await client.query("SELECT pg_try_advisory_lock(hashtext($1), 0) AS ok", [LOCK_NAME])).rows[0].ok === true;
    if (!locked) return out("BUSY", "LOCK_HELD");
    const rows = (await client.query(SELECT_SQL, [cfg.mode, cfg.listingIds, [...PIPELINE_STATES, ...ATTENTION_STATES], cfg.maxIntents, cfg.notBefore])).rows;
    counts.candidates = rows.length;
    for (const row of rows) {
      const entry = { intentId: row.id, listingId: Number(row.listing_id), outcome: null, code: null, writes: null };
      intents.push(entry);
      if (ATTENTION_STATES.includes(row.state)) { entry.outcome = "ATTENTION"; entry.code = `STATE_${String(row.state).toUpperCase()}`; counts.attention += 1; continue; }
      if (row.open_cases > 0) { entry.outcome = "ATTENTION"; entry.code = "OPEN_CASE"; counts.attention += 1; continue; }
      let r;
      try {
        const built = await deps.buildPhases(freeze({ id: row.id, ref: row.ref, listingId: Number(row.listing_id) }), cfg);
        r = await runTestPipelineCoordinator(pool, { workerId: `${cfg.workerId}:${row.id.slice(0, 8)}`, env: built.env, binding: { intentId: row.id, ref: row.ref },
          phases: built.phases, clock: built.clock, ...(built.recordingClock ? { recordingClock: built.recordingClock } : {}),
          ...(cfg.mode === "live" ? { mode: "live", listingId: Number(row.listing_id) } : {}) });
      } catch (e) {
        // wiring / transport fault for THIS booking: reported, never retried here; the next run decides on fresh persisted facts
        entry.outcome = "STOP"; entry.code = `RUNNER_THREW_${safe(e && e.code, "ERROR")}`; counts.stopped += 1; continue;
      }
      entry.outcome = r.outcome; entry.code = safe(r.code, "CODE"); entry.writes = r.writes;
      if (r.outcome === "CONFIRMED") counts.confirmed += 1;
      else if (r.outcome === "PENDING") counts.pending += 1;
      else counts.stopped += 1;                                   // STOP | REFUSED
    }
    return out(counts.stopped + counts.attention > 0 ? "ATTENTION" : "OK", counts.candidates === 0 ? "NOTHING_TO_DO" : counts.stopped + counts.attention > 0 ? "NEEDS_REVIEW" : "DONE");
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1), 0)", [LOCK_NAME]).catch(() => {});
    client.release();
  }
}

export const exitCodeFor = (result) => (result && (result.outcome === "OK" || result.outcome === "BUSY") ? 0 : 1);

// CLI: the production provider wiring (bound Stripe / Hostaway executors per booking) lands in P2c-3. Until then the CLI refuses.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.stdout.write(`${JSON.stringify({ version: MV_PIPELINE_VERSION, outcome: "REFUSED", code: "NOT_WIRED" })}\n`);
  process.exit(1);
}
