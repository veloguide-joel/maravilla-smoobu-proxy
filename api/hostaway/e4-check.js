// GET /api/hostaway/e4-check — Stage E4 read-only verification of test listing 606998.
//
// FEATURE-PREVIEW ONLY (branch feature/e4-readonly-route; never merged to DEV/main):
//  1. Runtime gate FIRST: unless VERCEL_ENV === "preview" AND VERCEL_GIT_COMMIT_REF ===
//     "feature/e4-readonly-route", the route answers 404 before any auth check or provider call
//     (fail-closed when either variable is missing). Vercel SSO deployment protection also applies.
//  2. GET only; constant-time HOSTAWAY_DIAG_KEY auth (lib/diag-auth.js; 503 when unset, 401 otherwise).
//  3. Strict query: only from, to (real YYYY-MM-DD, to > from, <= 31 nights) and guests (1..16).
//  4. Listing 606998 is hard-coded; no id/path/URL/body passthrough. Exactly four read/calculation
//     paths, each at most once, in order:
//       GET  /customFields?objectType=reservation&limit=100&offset=0
//       GET  /listings/606998
//       GET  /listings/606998/calendar?startDate&endDate          (no includeResources)
//       POST /listings/606998/calendar/priceDetails {startingDate, endingDate, numberOfGuests, version: 2}
//     using the existing server-side credentials (lib/hostaway.js) with retryOnAuth: false: no 401/403
//     re-mint retry, and the client never retries network/429. Any thrown error (auth mint, network,
//     timeout) stops the run, so at most one token mint happens per invocation.
//  5. Output: the sanitized report of lib/e4-readonly-checks.js (copied from the reviewed CLI) — codes,
//     ids, enums, minor units, tri-state checks. Never tokens, secrets, env values, raw provider bodies or
//     messages, titles, addresses, notes or guest data. No CORS headers; Cache-Control: no-store; no logs.

import { getHostawayEnvStatus, hostawayGet, hostawayPost } from "../../lib/hostaway.js";
import { requireDiagKey } from "../../lib/diag-auth.js";
import {
  TEST_LISTING_ID, MAX_NIGHTS, MAX_GUESTS, isRealDate,
  summarizeCustomFields, summarizeListing, summarizeCalendar, summarizePriceDetails, evaluate
} from "../../lib/e4-readonly-checks.js";

export const E4_ROUTE_BRANCH = "feature/e4-readonly-route";
export const E4_ROUTE_VERSION = "e4-route-v1";
const UPSTREAM_TIMEOUT_MS = 15000;
const ALLOWED_QUERY_KEYS = Object.freeze(["from", "to", "guests"]);

/** True only on a Vercel preview deployment of exactly this branch. Missing variables => false. */
export function e4GateOpen(env = process.env) {
  return env.VERCEL_ENV === "preview" && env.VERCEL_GIT_COMMIT_REF === E4_ROUTE_BRANCH;
}

/** Strict query validation. Returns { ok, plan } or { ok:false, error }. */
export function parseE4Query(query) {
  const q = query && typeof query === "object" ? query : {};
  for (const k of Object.keys(q)) if (!ALLOWED_QUERY_KEYS.includes(k)) return { ok: false, error: "UNKNOWN_PARAMETER" };
  for (const k of ALLOWED_QUERY_KEYS) if (typeof q[k] !== "string") return { ok: false, error: "MISSING_OR_REPEATED_PARAMETER" };
  const { from, to, guests: g } = q;
  if (!isRealDate(from) || !isRealDate(to)) return { ok: false, error: "INVALID_DATE" };
  if (!(to > from)) return { ok: false, error: "DEPARTURE_NOT_AFTER_ARRIVAL" };
  const nights = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
  if (nights > MAX_NIGHTS) return { ok: false, error: "WINDOW_TOO_LONG" };
  if (!/^\d{1,2}$/.test(g)) return { ok: false, error: "INVALID_GUESTS" };
  const guests = Number(g);
  if (guests < 1 || guests > MAX_GUESTS) return { ok: false, error: "INVALID_GUESTS" };
  return { ok: true, plan: { listingId: TEST_LISTING_ID, from, to, nights, guests } };
}

/** The four fixed provider requests. Nothing here is derived from the request except validated dates/guests. */
export function e4Requests(plan) {
  const id = TEST_LISTING_ID;
  return [
    { step: "customFields", method: "GET", path: "/customFields", query: { objectType: "reservation", limit: 100, offset: 0 } },
    { step: "listing", method: "GET", path: `/listings/${id}`, query: undefined },
    { step: "calendar", method: "GET", path: `/listings/${id}/calendar`, query: { startDate: plan.from, endDate: plan.to } },
    { step: "priceDetails", method: "POST", path: `/listings/${id}/calendar/priceDetails`, query: undefined,
      body: { startingDate: plan.from, endingDate: plan.to, numberOfGuests: plan.guests, version: 2 } }
  ];
}

const SUMMARIZE = Object.freeze({
  customFields: (j) => summarizeCustomFields(j),
  listing: (j) => summarizeListing(j),
  calendar: (j, plan) => summarizeCalendar(j, plan),
  priceDetails: (j) => summarizePriceDetails(j)
});

const notFound = (res) => { res.status(404).json({ ok: false, error: "NOT_FOUND" }); };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  // 1. Deployment gate before anything else (no auth evaluation, no provider call).
  if (!e4GateOpen()) { notFound(res); return; }
  // 2. Method.
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" }); return; }
  // 3. Existing diagnostic key (constant-time; fail-closed when unset).
  if (!requireDiagKey(req, res)) return;
  // 4. Strict parameters.
  const parsed = parseE4Query(req.query);
  if (!parsed.ok) { res.status(400).json({ ok: false, error: parsed.error }); return; }
  const plan = parsed.plan;
  if (!getHostawayEnvStatus().ok) { res.status(503).json({ ok: false, error: "UPSTREAM_NOT_CONFIGURED" }); return; }

  const report = {
    tool: "e4-check-route", version: E4_ROUTE_VERSION, mode: "preview-readonly", startedAt: new Date().toISOString(),
    listingId: plan.listingId, from: plan.from, to: plan.to, nights: plan.nights, guests: plan.guests, calls: [], results: {}
  };
  for (const r of e4Requests(plan)) {
    const started = Date.now();
    let resp;
    try {
      resp = r.method === "POST"
        ? await hostawayPost(r.path, r.body, { timeoutMs: UPSTREAM_TIMEOUT_MS, retryOnAuth: false })
        : await hostawayGet(r.path, { query: r.query, timeoutMs: UPSTREAM_TIMEOUT_MS, retryOnAuth: false });
    } catch (err) {
      // Auth mint, network or timeout failure: record a code and STOP (no further calls, no second mint).
      const auth = typeof err?.code === "string" && /^HOSTAWAY_(AUTH|ENV)/.test(err.code);
      report.calls.push({ step: r.step, httpStatus: null, ms: Date.now() - started });
      report.results[r.step] = { ok: false, code: auth ? "AUTH_FAILED" : "TRANSPORT_UNCERTAIN" };
      report.stoppedEarly = true;
      break;
    }
    report.calls.push({ step: r.step, httpStatus: Number.isSafeInteger(resp.status) ? resp.status : null, ms: Date.now() - started });
    if (resp.status !== 200) report.results[r.step] = { ok: false, code: Number.isSafeInteger(resp.status) ? `HTTP_${resp.status}` : "HTTP_UNKNOWN" };
    else report.results[r.step] = SUMMARIZE[r.step](resp.json, plan);
  }
  evaluate(report);
  report.finishedAt = new Date().toISOString();
  report.network = "api.hostaway.com via existing server-side client";
  report.writes = "none (token mint is authentication only)";
  res.status(200).json(report);
}
