// scripts/mv-status.mjs — P6-1: a READ-ONLY look at the booking pipeline's state (owner review 2026-11-21: "read-only preflight").
//
// One read-only transaction against the booking database. It takes no lock, claims nothing, calls no provider and needs no provider
// secret: only the database URL, the mode, the approved listings and the not-before instant. Output: ONE JSON line of counts and codes
// (no ids, no guest data). Exit 1 means a person must look (GitHub emails the owner), which also makes it the watchdog's check.
//
//   statusOnce(pool, cfg, now?) -> frozen { version, mode, outcome, code, byState, inFlight, attention, openCases, oldestInFlightMinutes,
//                                           confirmationsQueued, oldestQueuedConfirmationMinutes, unlistedPaid, maxMinutes }
//     outcome OK         nothing is stuck
//             ATTENTION  a booking needs a person, or has waited longer than maxMinutes, or a paid booking is on a listing the runner
//                        is not allowed to process
//             REFUSED    configuration or database mismatch; nothing else was read
import { PIPELINE_STATES, ATTENTION_STATES, MAX_LISTINGS, parseListings, sessionDatabaseUrl, OFFICIAL_CA_SHA256 } from "./mv-pipeline.mjs";

export const MV_STATUS_VERSION = "mv-status-v1";
export const DEFAULT_MAX_MINUTES = 20;      // a paid booking normally confirms within two runner passes
export const MAX_MINUTES_LIMIT = 1440;
export const ENV_NAMES = Object.freeze({ mode: "MV_PIPELINE_MODE", listings: "MV_PIPELINE_LISTINGS", notBefore: "MV_PIPELINE_NOT_BEFORE",
  databaseUrl: "MV_PIPELINE_DATABASE_URL", databaseCaFile: "MV_PIPELINE_DATABASE_CA_FILE" });
export const MAX_MINUTES_ENV = "MV_STATUS_MAX_MINUTES";

const { freeze } = Object;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STATE_RE = /^[a-z_]{1,40}$/;

/** -> { ok:true, cfg } | { ok:false, code }. Unlike the runner, TEST mode may list more than the one TEST listing (nothing is written). */
export function validateStatusConfig(cfg) {
  if (cfg === null || typeof cfg !== "object") return { ok: false, code: "CONFIG_REQUIRED" };
  if (cfg.mode !== "test" && cfg.mode !== "live") return { ok: false, code: "MODE_INVALID" };
  if (!(cfg.listings instanceof Map) || cfg.listings.size < 1 || cfg.listings.size > MAX_LISTINGS) return { ok: false, code: "LISTINGS_INVALID" };
  const ids = [...cfg.listings.keys()];
  if (!ids.every((id) => Number.isSafeInteger(id) && id > 0 && id <= 2147483647)) return { ok: false, code: "LISTINGS_INVALID" };
  if (typeof cfg.notBefore !== "string" || !ISO_RE.test(cfg.notBefore) || !Number.isFinite(Date.parse(cfg.notBefore))) return { ok: false, code: "NOT_BEFORE_INVALID" };
  const maxMinutes = cfg.maxMinutes === undefined ? DEFAULT_MAX_MINUTES : cfg.maxMinutes;
  if (!Number.isSafeInteger(maxMinutes) || maxMinutes < 1 || maxMinutes > MAX_MINUTES_LIMIT) return { ok: false, code: "MAX_MINUTES_INVALID" };
  return { ok: true, cfg: freeze({ mode: cfg.mode, listingIds: freeze(ids.sort((a, b) => a - b)), notBefore: cfg.notBefore, maxMinutes }) };
}

const STATE_SQL = `SELECT i.state, count(*)::int AS n FROM booking.intents i
   WHERE i.environment = $1 AND i.listing_id = ANY($2::int[]) AND i.created_at >= $3::timestamptz GROUP BY i.state`;
const FLIGHT_SQL = `SELECT count(*)::int AS n, min(coalesce(i.authorization_accepted_at, i.created_at)) AS oldest FROM booking.intents i
   WHERE i.environment = $1 AND i.listing_id = ANY($2::int[]) AND i.created_at >= $3::timestamptz AND i.state = ANY($4::text[])`;
const CASES_SQL = `SELECT count(*)::int AS n FROM booking.reconciliation_cases c JOIN booking.intents i ON i.id = c.intent_id
   WHERE c.status = 'open' AND i.environment = $1 AND i.created_at >= $2::timestamptz`;
const QUEUED_SQL = `SELECT count(*)::int AS n, min(coalesce(i.authorization_accepted_at, i.created_at)) AS oldest FROM booking.intents i
   WHERE i.environment = $1 AND i.listing_id = ANY($2::int[]) AND i.created_at >= $3::timestamptz AND i.state = 'confirmed'
     AND EXISTS (SELECT 1 FROM booking.external_operations o WHERE o.intent_id = i.id AND o.op_type = 'guest.notify'
                    AND o.state = 'pending' AND o.attempts = 0 AND o.dispatched_at IS NULL)`;
const UNLISTED_SQL = `SELECT count(*)::int AS n FROM booking.intents i
   WHERE i.environment = $1 AND NOT (i.listing_id = ANY($2::int[])) AND i.created_at >= $3::timestamptz AND i.state = ANY($4::text[])`;

const minutesSince = (then, nowMs) => (then === null || then === undefined ? null : Math.max(0, Math.floor((nowMs - new Date(then).getTime()) / 60000)));

export async function statusOnce(pool, cfgIn, now = Date.now()) {
  const v = validateStatusConfig(cfgIn);
  const base = { version: MV_STATUS_VERSION, mode: v.ok ? v.cfg.mode : null };
  if (!v.ok) return freeze({ ...base, outcome: "REFUSED", code: v.code });
  const cfg = v.cfg;
  const client = await pool.connect();
  let open = false;
  try {
    await client.query("BEGIN TRANSACTION READ ONLY"); open = true;
    const markers = (await client.query("SELECT environment FROM booking.instance")).rows;
    if (markers.length !== 1 || markers[0].environment !== cfg.mode) return freeze({ ...base, outcome: "REFUSED", code: "DATABASE_NOT_CONFIGURED_MODE" });
    const active = [...PIPELINE_STATES, ...ATTENTION_STATES];
    const byState = {};
    for (const r of (await client.query(STATE_SQL, [cfg.mode, cfg.listingIds, cfg.notBefore])).rows) if (STATE_RE.test(String(r.state))) byState[r.state] = r.n;
    const flight = (await client.query(FLIGHT_SQL, [cfg.mode, cfg.listingIds, cfg.notBefore, [...PIPELINE_STATES]])).rows[0];
    const openCases = (await client.query(CASES_SQL, [cfg.mode, cfg.notBefore])).rows[0].n;
    const queued = (await client.query(QUEUED_SQL, [cfg.mode, cfg.listingIds, cfg.notBefore])).rows[0];
    const unlistedPaid = (await client.query(UNLISTED_SQL, [cfg.mode, cfg.listingIds, cfg.notBefore, active])).rows[0].n;
    const attention = ATTENTION_STATES.reduce((n, s) => n + (byState[s] || 0), 0);
    const oldestInFlightMinutes = minutesSince(flight.oldest, now);
    const oldestQueuedConfirmationMinutes = minutesSince(queued.oldest, now);
    const code = attention > 0 ? "STATE_NEEDS_REVIEW" : openCases > 0 ? "OPEN_CASE"
      : oldestInFlightMinutes !== null && oldestInFlightMinutes > cfg.maxMinutes ? "PAID_NOT_CONFIRMED_IN_TIME"
      : oldestQueuedConfirmationMinutes !== null && oldestQueuedConfirmationMinutes > cfg.maxMinutes ? "CONFIRMATION_NOT_SENT_IN_TIME"
      : unlistedPaid > 0 ? "PAID_ON_UNLISTED_LISTING" : flight.n + queued.n === 0 ? "NOTHING_IN_FLIGHT" : "IN_FLIGHT_ON_TIME";
    const ok = code === "NOTHING_IN_FLIGHT" || code === "IN_FLIGHT_ON_TIME";
    return freeze({ ...base, outcome: ok ? "OK" : "ATTENTION", code, byState: freeze(byState), inFlight: flight.n, attention, openCases, oldestInFlightMinutes,
      confirmationsQueued: queued.n, oldestQueuedConfirmationMinutes, unlistedPaid, maxMinutes: cfg.maxMinutes });
  } finally {
    if (open) await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

export const exitCodeFor = (r) => (r && r.outcome === "OK" ? 0 : 1);

/** -> { ok:true, cfg, db } | { ok:false, code }; never returns or logs a value on refusal */
export function parseStatusEnv(env) {
  const e = env !== null && typeof env === "object" ? env : {};
  const get = (k) => (typeof e[ENV_NAMES[k]] === "string" && e[ENV_NAMES[k]] !== "" ? e[ENV_NAMES[k]] : null);
  for (const k of Object.keys(ENV_NAMES)) if (get(k) === null) return { ok: false, code: "CONFIG_INCOMPLETE" };
  const listings = parseListings(get("listings"));
  if (!listings) return { ok: false, code: "LISTINGS_INVALID" };
  const rawMax = typeof e[MAX_MINUTES_ENV] === "string" && e[MAX_MINUTES_ENV] !== "" ? e[MAX_MINUTES_ENV] : null;
  if (rawMax !== null && !/^[1-9]\d{0,3}$/.test(rawMax)) return { ok: false, code: "MAX_MINUTES_INVALID" };
  const v = validateStatusConfig({ mode: get("mode"), listings, notBefore: get("notBefore"), ...(rawMax === null ? {} : { maxMinutes: Number(rawMax) }) });
  if (!v.ok) return v;
  const sessionUrl = sessionDatabaseUrl(get("databaseUrl"));
  if (sessionUrl === null) return { ok: false, code: "DATABASE_TARGET_REFUSED" };
  return { ok: true, cfg: { mode: get("mode"), listings, notBefore: get("notBefore"), ...(rawMax === null ? {} : { maxMinutes: Number(rawMax) }) },
    db: { connectionString: sessionUrl, caFile: get("databaseCaFile") } };
}

export async function main(env = process.env, out = (line) => process.stdout.write(`${line}\n`)) {
  const p = parseStatusEnv(env);
  const say = (r) => { out(JSON.stringify(r)); return exitCodeFor(r); };
  if (!p.ok) return say({ version: MV_STATUS_VERSION, outcome: "REFUSED", code: p.code });
  let pool = null;
  try {
    const [{ createBookingPool }, { readFile }, { createHash }] = await Promise.all([import("../lib/booking-db/pool.js"), import("node:fs/promises"), import("node:crypto")]);
    let ca; try { ca = await readFile(p.db.caFile); } catch { return say({ version: MV_STATUS_VERSION, outcome: "REFUSED", code: "CA_UNREADABLE" }); }
    if (ca.length > 16384 || createHash("sha256").update(ca).digest("hex") !== OFFICIAL_CA_SHA256) return say({ version: MV_STATUS_VERSION, outcome: "REFUSED", code: "CA_INVALID" });
    pool = createBookingPool({ connectionString: p.db.connectionString, caPem: ca.toString("utf8"), max: 1 });
    return say(await statusOnce(pool, p.cfg));
  } catch (e) {
    return say({ version: MV_STATUS_VERSION, outcome: "REFUSED", code: e && typeof e.code === "string" && /^[A-Z0-9_]{1,60}$/.test(e.code) ? e.code : "STATUS_FAILED" });
  } finally { if (pool) await pool.end().catch(() => {}); }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().then((code) => { process.exitCode = code; }, () => { process.exitCode = 1; });
}
