// scripts/e7-test-auto-availability-check.mjs — C123 READ-ONLY availability check for the FIXED TEST listing 606998.
//
// Answers ONE question for a bounded half-open stay range [check-in, check-out): which nights are CLEAR for a TEST booking, i.e.
//   Hostaway says the night is available  AND  no unreleased booking.inventory_claims row for 606998 overlaps that night.
// Anything unknown / malformed / failed is NOT clear (fail closed). It never books, reserves, pays, cancels, writes or dispatches.
//
// Modes (each run as its own workflow step; each step receives AT MOST ONE secret):
//   hostaway  E7_HOSTAWAY_TOKEN only: ONE GET https://api.hostaway.com/v1/listings/606998/calendar?startDate=<check-in>&endDate=<check-out>
//             (the exact URL shape the reviewed pipeline's isCalendarUrl guard accepts), with the accepted transport's three headers
//             (Accept / Authorization Bearer / Cache-control no-cache). One non-keep-alive socket, 8 s timeout, NO retry, NO redirect follow
//             (3xx = FAIL, Location never read), NO token mint / refresh, body ≤ 1 MiB in memory only. Per night: available / blocked / unknown,
//             with the reviewed lib/bookability.js nightIsOpen rule (status === "available" AND isAvailable 1/true).
//   claims    E7_DEV_BOOKING_DATABASE_URL only: the runtime-role URL is shape-checked (pinned pooler host / port / user / path, no query) BEFORE
//             any connection; TLS with the pinned Supabase CA (SHA-256 checked) and rejectUnauthorized. ONE connection, ONE attempt:
//             BEGIN READ ONLY → identity + read-only + TEST-instance check → ONE SELECT of lower/upper(stay) only for unreleased 606998 claims
//             overlapping the window → ROLLBACK. Per night: internal claim true / false (half-open: a claim [a, b) covers nights a … b-1).
//   combine   no secret: reads the two result files, re-validates the dates, prints the per-night verdict + overall result.
//
// Output: ONLY dates, available / blocked / unknown, claim true / false, verdicts and fixed codes (+ an HTTP status number or SQLSTATE).
// Never the token, URL, headers, raw body, notes, reservation / intent / claim identifiers, guest data or error text.
// Imports Node built-ins only; `pg` comes from the pinned tooling checkout (E7_TOOLING_DIR), exactly like e7-test-auto-db-connection-check.
// OUTSIDE every runner frame and the TEST arm release; it enables nothing and changes no flag, setting, schedule or secret.

import https from "node:https";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const NAME = "e7-test-auto-availability-check";

export const CONSTANTS = Object.freeze({
  listingId: 606998,
  maxNights: 31,
  maxLeadDays: 730,
  hostaway: Object.freeze({ host: "api.hostaway.com", port: 443, timeoutMs: 8000, maxBodyBytes: 1024 * 1024 }),
  db: Object.freeze({
    host: "aws-0-us-east-1.pooler.supabase.com", port: 6543, ref: "mxotevtiscernhqilyiu", role: "mv_booking_app_dev", database: "postgres",
    caSha256: "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7",
  }),
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;

// ---------- dates ----------

/** a real calendar date in strict YYYY-MM-DD form, else null */
export function parseIsoDate(v) {
  if (typeof v !== "string" || !DATE_RE.test(v)) return null;
  const [y, m, d] = v.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return v;
}
const toMs = (iso) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d); };
export const addDays = (iso, n) => new Date(toMs(iso) + n * DAY_MS).toISOString().slice(0, 10);

/**
 * Strict input bounds for the half-open stay [checkIn, checkOut).
 * → { ok:true, checkIn, checkOut, nights:[checkIn … checkOut-1] } | { ok:false, code }
 * `today` (YYYY-MM-DD, UTC) is injected; the CLI passes the current UTC date.
 */
export function validateRange(checkIn, checkOut, today) {
  const a = parseIsoDate(checkIn); const b = parseIsoDate(checkOut); const t = parseIsoDate(today);
  if (!a) return { ok: false, code: "CHECK_IN_INVALID" };
  if (!b) return { ok: false, code: "CHECK_OUT_INVALID" };
  if (!t) return { ok: false, code: "TODAY_INVALID" };
  const n = Math.round((toMs(b) - toMs(a)) / DAY_MS);
  if (n < 1) return { ok: false, code: "RANGE_EMPTY_OR_REVERSED" };
  if (n > CONSTANTS.maxNights) return { ok: false, code: "RANGE_TOO_LONG" };
  if (toMs(a) < toMs(t)) return { ok: false, code: "CHECK_IN_IN_PAST" };
  if (toMs(a) > toMs(t) + CONSTANTS.maxLeadDays * DAY_MS) return { ok: false, code: "CHECK_IN_TOO_FAR" };
  const nights = []; for (let i = 0; i < n; i++) nights.push(addDays(a, i));
  return { ok: true, checkIn: a, checkOut: b, nights };
}

// ---------- Hostaway (GET only) ----------

/** the ONE request this check may send; the listing is the fixed literal, never an input */
export function calendarRequestOptions(range, token) {
  const q = new URLSearchParams([["startDate", range.checkIn], ["endDate", range.checkOut]]).toString();
  return {
    method: "GET", host: CONSTANTS.hostaway.host, port: CONSTANTS.hostaway.port,
    path: `/v1/listings/${CONSTANTS.listingId}/calendar?${q}`,
    headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "Cache-control": "no-cache" },
    timeout: CONSTANTS.hostaway.timeoutMs,
  };
}

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const flag = (v) => v === 1 || v === true;
const unflag = (v) => v === 0 || v === false;

/** one calendar day → available | blocked | unknown (lib/bookability.js nightIsOpen rule; contradictions are unknown) */
export function classifyDay(d) {
  if (!isObj(d) || typeof d.status !== "string" || d.status.length === 0) return "unknown";
  if (d.status === "available") return flag(d.isAvailable) ? "available" : unflag(d.isAvailable) ? "blocked" : "unknown";
  return unflag(d.isAvailable) ? "blocked" : "unknown"; // a non-available status with isAvailable 1 (or missing) is contradictory → unknown
}

/** parsed reply → { ok:true, nights:{date:status} } | { ok:false, code } ; a missing / duplicated night is unknown */
export function classifyCalendar(json, nights) {
  if (!isObj(json)) return { ok: false, code: "SHAPE_NOT_OBJECT" };
  if (Object.hasOwn(json, "status") && json.status !== "success") return { ok: false, code: "SHAPE_STATUS_NOT_SUCCESS" };
  if (!Array.isArray(json.result)) return { ok: false, code: "SHAPE_NO_RESULT_ARRAY" };
  const seen = new Map();
  for (const d of json.result) {
    const date = isObj(d) ? parseIsoDate(d.date) : null;
    if (!date) continue;
    seen.set(date, seen.has(date) ? "DUPLICATE" : d);
  }
  const out = {};
  for (const n of nights) { const d = seen.get(n); out[n] = d === undefined || d === "DUPLICATE" ? "unknown" : classifyDay(d); }
  return { ok: true, nights: out };
}

/**
 * ONE GET, no retry, no redirect. Resolves { ok, code, http, nights? } — never rejects, never includes token / body / headers.
 * `request` is injectable for tests (defaults to https.request with a fresh non-keep-alive agent).
 */
export function readHostawayCalendar({ token, range, request = null }) {
  return new Promise((resolve) => {
    let done = false; const finish = (r) => { if (!done) { done = true; resolve(r); } };
    if (typeof token !== "string" || token.length === 0) return finish({ ok: false, code: "TOKEN_MISSING", http: null });
    if (!/^[\x21-\x7e]+$/.test(token)) return finish({ ok: false, code: "TOKEN_SHAPE", http: null });
    const opts = calendarRequestOptions(range, token);
    const send = request ?? ((o, cb) => https.request({ ...o, agent: new https.Agent({ keepAlive: false, maxSockets: 1 }) }, cb));
    let req;
    try {
      req = send(opts, (res) => {
        const s = res.statusCode;
        if (!Number.isInteger(s)) { res.destroy(); return finish({ ok: false, code: "HTTP_NO_STATUS", http: null }); }
        if (s >= 300 && s <= 399) { res.destroy(); return finish({ ok: false, code: "REDIRECT_REFUSED", http: s }); }
        if (s < 200 || s > 299) { res.destroy(); return finish({ ok: false, code: `HTTP_${s >= 500 ? "5XX" : s >= 400 ? "4XX" : "OTHER"}`, http: s }); }
        const chunks = []; let n = 0;
        res.on("data", (c) => { n += c.length; if (n > CONSTANTS.hostaway.maxBodyBytes) { res.destroy(); finish({ ok: false, code: "BODY_TOO_LARGE", http: s }); } else chunks.push(c); });
        res.on("error", () => finish({ ok: false, code: "READ_ERROR", http: s }));
        res.on("end", () => {
          let j; try { j = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return finish({ ok: false, code: "JSON_INVALID", http: s }); }
          const c = classifyCalendar(j, range.nights);
          finish(c.ok ? { ok: true, code: "CALENDAR_READ", http: s, nights: c.nights } : { ok: false, code: c.code, http: s });
        });
      });
    } catch { return finish({ ok: false, code: "REQUEST_ERROR", http: null }); }
    req.on("timeout", () => { req.destroy(); finish({ ok: false, code: "TIMEOUT", http: null }); });
    req.on("error", (e) => finish({ ok: false, code: e && typeof e.code === "string" && /^E[A-Z_]{2,24}$/.test(e.code) ? `REQUEST_${e.code}` : "REQUEST_ERROR", http: null }));
    req.end(); // no body is ever written
  });
}

// ---------- shared TEST DB (read-only) ----------

/** the runtime-role URL shape (pinned host / port / user / path, no query, no fragment) → { ok, user, password } | { ok:false, code } */
export function dbTarget(urlText) {
  let u; try { u = new URL(urlText ?? ""); } catch { return { ok: false, code: "URL_UNPARSEABLE" }; }
  let user = ""; let password = "";
  try { user = decodeURIComponent(u.username); password = decodeURIComponent(u.password); } catch { return { ok: false, code: "URL_ENCODING" }; }
  const D = CONSTANTS.db;
  if (!(u.protocol === "postgresql:" || u.protocol === "postgres:") || u.hostname !== D.host || u.port !== String(D.port)
      || user !== `${D.role}.${D.ref}` || u.pathname !== `/${D.database}` || u.search !== "" || u.hash !== "") return { ok: false, code: "TARGET_SHAPE" };
  if (password.length === 0) return { ok: false, code: "PASSWORD_EMPTY" };
  return { ok: true, user, password };
}

export const SQL = Object.freeze({
  begin: "BEGIN READ ONLY",
  identity: "SELECT current_user::text AS cu, current_setting('transaction_read_only') AS ro,"
    + " (SELECT count(*)::int FROM booking.instance) AS n, (SELECT min(environment)::text FROM booking.instance) AS env",
  // lower / upper only: no id, intent, kind or timestamp leaves the database
  claims: "SELECT lower(stay)::text AS f, upper(stay)::text AS t, lower_inc(stay) AS li, upper_inc(stay) AS ui"
    + " FROM booking.inventory_claims WHERE listing_id = $1 AND released_at IS NULL AND stay && daterange($2::date, $3::date, '[)')",
  rollback: "ROLLBACK",
});

/** half-open mapping: a claim [f, t) covers nights f … t-1; a malformed / unbounded range fails closed */
export function nightConflicts(rows, nights) {
  if (!Array.isArray(rows)) return { ok: false, code: "CLAIM_ROWS_INVALID" };
  const ranges = [];
  for (const r of rows) {
    const f = isObj(r) ? parseIsoDate(r.f) : null; const t = isObj(r) ? parseIsoDate(r.t) : null;
    if (!f || !t || r.li !== true || r.ui !== false || !(toMs(f) < toMs(t))) return { ok: false, code: "CLAIM_RANGE_MALFORMED" };
    ranges.push([f, t]);
  }
  const out = {};
  for (const n of nights) out[n] = ranges.some(([f, t]) => f <= n && n < t);
  return { ok: true, nights: out };
}

/**
 * ONE read-only snapshot. `client` is a pg.Client-like object (connect / query / end); injectable for tests.
 * → { ok:true, code, nights:{date:boolean} } | { ok:false, code }
 */
export async function readClaims({ client, range }) {
  const code = (e) => (e && typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : "NO_SQLSTATE");
  try { await client.connect(); } catch (e) { return { ok: false, code: `CONNECT_${code(e)}` }; }
  let result;
  try {
    await client.query(SQL.begin);
    const id = (await client.query(SQL.identity)).rows?.[0];
    if (!id || id.cu !== CONSTANTS.db.role) result = { ok: false, code: "ROLE_MISMATCH" };
    else if (id.ro !== "on") result = { ok: false, code: "NOT_READ_ONLY" };
    else if (id.n !== 1 || id.env !== "test") result = { ok: false, code: "NOT_TEST_INSTANCE" };
    else {
      const rows = (await client.query(SQL.claims, [CONSTANTS.listingId, range.checkIn, range.checkOut])).rows;
      const c = nightConflicts(rows, range.nights);
      result = c.ok ? { ok: true, code: "CLAIMS_READ", nights: c.nights } : c;
    }
  } catch (e) { result = { ok: false, code: `QUERY_${code(e)}` }; }
  try { await client.query(SQL.rollback); } catch { /* the connection is closed next; nothing was written */ }
  try { await client.end(); } catch { /* ignore */ }
  return result;
}

// ---------- combine (no secret) ----------

/** a night is CLEAR only when Hostaway says available AND no internal claim overlaps; anything unknown is UNKNOWN */
export function combine(range, hostaway, claims) {
  const lines = []; let clear = 0; let unknown = 0;
  for (const n of range.nights) {
    const h = hostaway?.ok ? hostaway.nights?.[n] : undefined;
    const c = claims?.ok ? claims.nights?.[n] : undefined;
    const hs = h === "available" || h === "blocked" ? h : "unknown";
    const cs = c === true || c === false ? String(c) : "unknown";
    const verdict = hs === "unknown" || cs === "unknown" ? "UNKNOWN" : hs === "available" && cs === "false" ? "CLEAR" : "NOT_CLEAR";
    if (verdict === "CLEAR") clear += 1; if (verdict === "UNKNOWN") unknown += 1;
    lines.push(`night=${n} hostaway=${hs} internal_claim=${cs} verdict=${verdict}`);
  }
  const overall = unknown > 0 ? "UNKNOWN" : clear === range.nights.length ? "ALL_CLEAR" : clear > 0 ? "SOME_CLEAR" : "NONE_CLEAR";
  return { overall, clear, unknown, lines, exitCode: unknown > 0 ? 3 : 0 };
}

// ---------- CLI ----------

const SAFE_CODE = /^[A-Z0-9_]{2,40}$/;
/** the only shapes ever written to a result file (re-checked on read) */
function sanitizeResult(r, nights, kind) {
  const ok = r?.ok === true && SAFE_CODE.test(r.code);
  const out = { kind, ok, code: SAFE_CODE.test(r?.code) ? r.code : "UNKNOWN_CODE", http: Number.isInteger(r?.http) ? r.http : null };
  if (ok) {
    out.nights = {};
    for (const n of nights) {
      const v = r.nights?.[n];
      out.nights[n] = kind === "hostaway" ? (v === "available" || v === "blocked" ? v : "unknown") : (v === true || v === false ? v : "unknown");
    }
  }
  return out;
}

function todayUtc() { return new Date().toISOString().slice(0, 10); }

async function main(argv, env) {
  const mode = argv[2];
  const say = (s) => process.stdout.write(`${NAME} ${s}\n`);
  const range = validateRange(env.E7_CHECK_IN, env.E7_CHECK_OUT, todayUtc());
  if (!range.ok) { say(`FAIL mode=${["hostaway", "claims", "combine"].includes(mode) ? mode : "?"} code=${range.code}`); return 3; }
  if (mode === "hostaway") {
    let token = env.E7_HOSTAWAY_TOKEN ?? ""; delete env.E7_HOSTAWAY_TOKEN;
    const r = sanitizeResult(await readHostawayCalendar({ token, range }), range.nights, "hostaway"); token = null;
    writeFileSync(env.E7_OUT_FILE, JSON.stringify({ checkIn: range.checkIn, checkOut: range.checkOut, ...r }));
    say(`${r.ok ? "PASS" : "FAIL"} mode=hostaway code=${r.code} http=${r.http ?? "none"}`);
    return r.ok ? 0 : 3;
  }
  if (mode === "claims") {
    const t = dbTarget(env.E7_DEV_BOOKING_DATABASE_URL); delete env.E7_DEV_BOOKING_DATABASE_URL;
    let r;
    if (!t.ok) r = { ok: false, code: t.code };
    else {
      let ca = null;
      try { ca = readFileSync(env.E7_CA_FILE, "utf8"); } catch { /* handled below */ }
      if (ca === null || createHash("sha256").update(ca).digest("hex") !== CONSTANTS.db.caSha256) r = { ok: false, code: "CA_PIN" };
      else {
        let pg = null; try { pg = createRequire(`${env.E7_TOOLING_DIR}/package.json`)("pg"); } catch { r = { ok: false, code: "PG_MODULE" }; }
        if (pg) {
          const D = CONSTANTS.db;
          const client = new pg.Client({ host: D.host, port: D.port, user: t.user, password: t.password, database: D.database,
            ssl: { ca, rejectUnauthorized: true, servername: D.host }, connectionTimeoutMillis: 10000, statement_timeout: 5000, query_timeout: 8000,
            application_name: NAME });
          client.on("error", () => {});
          r = await readClaims({ client, range });
        }
      }
    }
    const s = sanitizeResult(r, range.nights, "claims");
    writeFileSync(env.E7_OUT_FILE, JSON.stringify({ checkIn: range.checkIn, checkOut: range.checkOut, ...s }));
    say(`${s.ok ? "PASS" : "FAIL"} mode=claims code=${s.code}`);
    return s.ok ? 0 : 3;
  }
  if (mode === "combine") {
    const load = (p, kind) => {
      try {
        const j = JSON.parse(readFileSync(p, "utf8"));
        if (j?.kind !== kind || j.checkIn !== range.checkIn || j.checkOut !== range.checkOut) return { ok: false, code: "RESULT_MISMATCH" };
        return sanitizeResult(j, range.nights, kind);
      } catch { return { ok: false, code: "RESULT_MISSING" }; }
    };
    const h = load(env.E7_HOSTAWAY_RESULT, "hostaway"); const c = load(env.E7_CLAIMS_RESULT, "claims");
    const v = combine(range, h, c);
    say(`listing=${CONSTANTS.listingId} stay=[${range.checkIn},${range.checkOut}) nights=${range.nights.length} hostaway=${h.ok ? "READ" : `FAIL:${h.code}`} claims=${c.ok ? "READ" : `FAIL:${c.code}`}`);
    for (const l of v.lines) say(l);
    say(`RESULT overall=${v.overall} clear=${v.clear} unknown=${v.unknown}`);
    return h.ok && c.ok ? v.exitCode : 3;
  }
  say("FAIL code=MODE_INVALID");
  return 3;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv, process.env).then((c) => process.exit(c), () => { process.stdout.write(`${NAME} FAIL code=SCRIPT_ERROR\n`); process.exit(3); });
}
