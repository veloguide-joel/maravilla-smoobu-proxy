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
//        Real wiring: scripts/mv-pipeline-wiring.mjs (P2c-3); tests inject a fake provider world. No result or log carries guest data: ids, codes and counts only.
import { runTestPipelineCoordinator, TEST_LISTING_ID } from "../lib/booking-db/test-pipeline-coordinator.js";

export const MV_PIPELINE_VERSION = "mv-pipeline-v1";
export const LOCK_NAME = "mv-pipeline-runner";                 // one runner at a time per database (session advisory lock)
export const MAX_LISTINGS = 60;
export const DEFAULT_MAX_INTENTS = 3;
/** booking confirmations sent per run (one worker invocation each; never retried within a run) */
export const MAX_CONFIRMATIONS = 3;
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

/** confirmed bookings whose ONE confirmation is still queued and was never attempted (the notification worker re-checks every fact itself) */
const CONFIRM_SQL = `SELECT i.id::text AS id, i.ref, i.listing_id
    FROM booking.intents i
   WHERE i.environment = $1 AND i.listing_id = ANY($2::int[]) AND i.state = 'confirmed' AND i.created_at >= $4::timestamptz
     AND (SELECT count(*) FROM booking.external_operations o WHERE o.intent_id = i.id AND o.op_type = 'guest.notify') = 1
     AND EXISTS (SELECT 1 FROM booking.external_operations o WHERE o.intent_id = i.id AND o.op_type = 'guest.notify'
                    AND o.state = 'pending' AND o.attempts = 0 AND o.dispatched_at IS NULL)
   ORDER BY i.created_at, i.id
   LIMIT $3`;
/** worker outcomes that mean "a person must look" (a send may have happened and its result is not known) */
const CONFIRM_ATTENTION = Object.freeze(["unknown", "lease_lost"]);

export async function runPipelineOnce(pool, cfgIn, deps = {}) {
  const v = validatePipelineConfig(cfgIn);
  const counts = { candidates: 0, confirmed: 0, pending: 0, stopped: 0, attention: 0 };
  const intents = [];
  // P2d-2: booking confirmations (separate from the pipeline counts). code: null | CONFIRMATION_NOT_WIRED | DONE | NEEDS_REVIEW
  const confirmations = { code: null, candidates: 0, sent: 0, skipped: 0, attention: 0 };
  const out = (outcome, code) => freeze({ version: MV_PIPELINE_VERSION, mode: v.ok ? v.cfg.mode : null, outcome, code,
    counts: freeze({ ...counts }), intents: freeze(intents.map(freeze)), confirmations: freeze({ ...confirmations }) });
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
          ...(built.hooks ? { hooks: built.hooks } : {}),
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
    // ---- confirmations: at most MAX_CONFIRMATIONS, ONE notification-worker invocation each, never retried in this run ----
    if (typeof deps.sendConfirmation !== "function") confirmations.code = "CONFIRMATION_NOT_WIRED";
    else {
      const due = (await client.query(CONFIRM_SQL, [cfg.mode, cfg.listingIds, MAX_CONFIRMATIONS, cfg.notBefore])).rows;
      confirmations.candidates = due.length;
      for (const row of due) {
        let w = null;
        try { w = await deps.sendConfirmation(freeze({ id: row.id, ref: row.ref, listingId: Number(row.listing_id) }), cfg); } catch { w = null; }
        if (w && w.ok === true && w.outcome === "accepted") confirmations.sent += 1;
        else if (!w || w.ok !== true || CONFIRM_ATTENTION.includes(w.outcome) || (Number.isSafeInteger(w.sends) && w.sends > 0)) confirmations.attention += 1;
        else confirmations.skipped += 1;                          // idle / waiting / latched / not_claimable / protected: nothing was sent
      }
      confirmations.code = confirmations.attention > 0 ? "NEEDS_REVIEW" : "DONE";
    }
    const bad = counts.stopped + counts.attention + confirmations.attention;
    return out(bad > 0 ? "ATTENTION" : "OK", bad > 0 ? "NEEDS_REVIEW" : counts.candidates + confirmations.candidates === 0 ? "NOTHING_TO_DO" : "DONE");
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1), 0)", [LOCK_NAME]).catch(() => {});
    client.release();
  }
}

export const exitCodeFor = (result) => (result && (result.outcome === "OK" || result.outcome === "BUSY") ? 0 : 1);

// ---------------------------------------------------------------------------------------------------------------------
// CLI (P2c-3). Configuration by NAME from the job's environment; values are never printed.
export const ENV_NAMES = Object.freeze({ mode: "MV_PIPELINE_MODE", listings: "MV_PIPELINE_LISTINGS", notBefore: "MV_PIPELINE_NOT_BEFORE",
  stripeAccount: "MV_PIPELINE_STRIPE_ACCOUNT", refFieldId: "MV_PIPELINE_REF_FIELD_ID", timeZone: "MV_PIPELINE_TIME_ZONE", accountRef: "MV_PIPELINE_ACCOUNT_REF",
  stripeKey: "MV_PIPELINE_STRIPE_KEY", hostawayToken: "MV_PIPELINE_HOSTAWAY_TOKEN", databaseUrl: "MV_PIPELINE_DATABASE_URL", databaseCaFile: "MV_PIPELINE_DATABASE_CA_FILE",
  runId: "MV_PIPELINE_RUN_ID" });
/**
 * Transaction-pooler ports: a session advisory lock does not survive there. The runner never connects to them. A Supabase pooler URL on
 * such a port is moved to that host's SESSION port (5432), exactly as the proven runner does for its lock connection; any other pooled
 * target is refused.
 */
export const POOLED_PORTS = Object.freeze(["6543", "6432"]);
export const SESSION_PORT = "5432";
/** the Supabase root CA the proven runners pin (prod-ca-2021.crt) */
export const OFFICIAL_CA_SHA256 = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7";
/** -> a session-mode connection string, or null (pooled and not convertible / not a postgres URL) */
export function sessionDatabaseUrl(raw) {
  let u; try { u = new URL(raw); } catch { return null; }
  if (!/^postgres(ql)?:$/.test(u.protocol) || u.search !== "" || u.hash !== "") return null;
  if (!POOLED_PORTS.includes(u.port)) return u.href;
  if (!/^[a-z0-9-]+\.pooler\.supabase\.com$/.test(u.hostname)) return null;
  u.port = SESSION_PORT;
  return u.href;
}

/** optional secret: the Resend sending key. Absent = the run does the pipeline only (confirmations: CONFIRMATION_NOT_WIRED). */
export const RESEND_KEY_ENV = "MV_PIPELINE_RESEND_KEY";

/** Parse "id:USD,id:USD" -> Map | null (strict; USD only; no duplicates). */
export function parseListings(raw) {
  if (typeof raw !== "string" || !raw || raw.length > 1200) return null;
  const m = new Map();
  for (const part of raw.split(",")) {
    const x = /^([1-9]\d{0,9}):USD$/.exec(part.trim());
    if (!x || m.has(Number(x[1]))) return null;
    m.set(Number(x[1]), freeze({ currency: "USD" }));
  }
  return m.size >= 1 && m.size <= MAX_LISTINGS ? m : null;
}

/** -> { ok:true, cfg, wiring:{...}, db:{ connectionString, caPem } } | { ok:false, code } ; never returns or logs a value on refusal */
export function parsePipelineEnv(env) {
  const e = isObj(env) ? env : {};
  const get = (k) => (typeof e[ENV_NAMES[k]] === "string" && e[ENV_NAMES[k]] !== "" ? e[ENV_NAMES[k]] : null);
  for (const k of Object.keys(ENV_NAMES)) if (get(k) === null) return { ok: false, code: "CONFIG_INCOMPLETE" };
  const listings = parseListings(get("listings"));
  if (!listings) return { ok: false, code: "LISTINGS_INVALID" };
  const v = validatePipelineConfig({ mode: get("mode"), workerId: "mv-pipeline", listings, notBefore: get("notBefore") });
  if (!v.ok) return v;
  if (!/^[1-9]\d{0,9}$/.test(get("refFieldId"))) return { ok: false, code: "REF_FIELD_INVALID" };
  const sessionUrl = sessionDatabaseUrl(get("databaseUrl"));
  if (sessionUrl === null) return { ok: false, code: "DATABASE_TARGET_REFUSED" };
  return { ok: true, cfg: { mode: get("mode"), workerId: "mv-pipeline", listings, notBefore: get("notBefore") },
    wiring: { mode: get("mode"), stripeKey: get("stripeKey"), hostawayToken: get("hostawayToken"), stripeAccountId: get("stripeAccount"), refFieldId: Number(get("refFieldId")),
      timeZone: get("timeZone"), accountRef: get("accountRef"), runId: get("runId") },
    db: { connectionString: sessionUrl, caFile: get("databaseCaFile") } };
}

export async function main(env = process.env, out = (line) => process.stdout.write(`${line}\n`)) {
  const p = parsePipelineEnv(env);
  const say = (r) => { out(JSON.stringify(r)); return exitCodeFor(r); };
  if (!p.ok) return say({ version: MV_PIPELINE_VERSION, outcome: "REFUSED", code: p.code });
  let pool = null;
  try {
    const [{ createBookingPool }, { createWiring, createConfirmationWiring }, { readFile }, { createHash }] = await Promise.all([import("../lib/booking-db/pool.js"), import("./mv-pipeline-wiring.mjs"),
      import("node:fs/promises"), import("node:crypto")]);
    let ca; try { ca = await readFile(p.db.caFile); } catch { return say({ version: MV_PIPELINE_VERSION, outcome: "REFUSED", code: "CA_UNREADABLE" }); }
    if (ca.length > 16384 || createHash("sha256").update(ca).digest("hex") !== OFFICIAL_CA_SHA256) return say({ version: MV_PIPELINE_VERSION, outcome: "REFUSED", code: "CA_INVALID" });
    pool = createBookingPool({ connectionString: p.db.connectionString, caPem: ca.toString("utf8"), max: 3 });
    const wiring = createWiring({ ...p.wiring, pool });
    const resendKey = typeof env[RESEND_KEY_ENV] === "string" && env[RESEND_KEY_ENV] !== "" ? env[RESEND_KEY_ENV] : null;   // optional: absent = confirmations not wired
    const conf = resendKey === null ? {} : createConfirmationWiring({ mode: p.wiring.mode, pool, resendKey, runId: p.wiring.runId });
    return say(await runPipelineOnce(pool, p.cfg, { ...wiring, ...conf }));
  } catch (e) {
    return say({ version: MV_PIPELINE_VERSION, outcome: "REFUSED", code: safe(e && e.code, "RUNNER_FAILED") });
  } finally { if (pool) await pool.end().catch(() => {}); }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().then((code) => { process.exitCode = code; }, () => { process.exitCode = 1; });
}
