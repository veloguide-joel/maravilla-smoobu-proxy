#!/usr/bin/env node
// scripts/hostaway-readonly-check.mjs — Stage E4, owner-private READ-ONLY Hostaway check (NOT deployed).
//
// Purpose: confirm, with the owner's own API credential on the owner's own PC, that
//   1. the reservation custom field 105433 exists with the exact expected metadata (reservation / text / private),
//   2. test listing 606998 exists and is not archived (sanitized fields only),
//   3. its calendar can be read for an owner-chosen window,
//   4. Hostaway's priceDetails CALCULATION (creates nothing) returns a consistent total and components.
//
// Hard limits (enforced in code and tests):
//   - Exactly these HTTP calls, sequential, each at most once, never retried:
//       POST /v1/accessTokens                                   (token mint — authentication only)
//       GET  /v1/customFields?objectType=reservation&limit=100&offset=0
//       GET  /v1/listings/606998
//       GET  /v1/listings/606998/calendar?startDate&endDate      (no includeResources)
//       POST /v1/listings/606998/calendar/priceDetails          (calculation; body: dates, guests, version 2)
//     Any other method/path is refused before it is sent. No reservation, calendar, listing, field, coupon,
//     payment or settings write exists here. Pilots 603564/603566 are refused.
//   - Credentials: read ONCE from two process environment variables set by the owner's PowerShell
//     SecureString procedure, then deleted from process.env. Kept only in memory, never printed, never
//     written to disk, never sent anywhere but api.hostaway.com. No dotenv, no files, no argv secrets.
//   - Output: one sanitized JSON document (codes, ids, numbers, enum values). No tokens, secrets, raw
//     bodies, guest data, addresses, descriptions or provider message strings.
//   - Default mode is a DRY RUN that prints the planned request manifest and makes no network call.
//     Network calls happen only with --execute-readonly.
//
// Sources: Hostaway Public API reference (read 2026-10-22): "Custom field object" / "Retrieve custom fields",
// "Listing object", "Retrieve a listing calendar", "Calculate reservation price" (version 2), authentication.
// Repo: lib/quote-public.js validatePriceDetails (live-used by the F3 quote route), lib/calendar-public.js
// normalizeCalendar, lib/hostaway-reservations.js amountToMinor.

import { pathToFileURL } from "node:url";
import { validatePriceDetails } from "../lib/quote-public.js";
import { normalizeCalendar } from "../lib/calendar-public.js";
import { amountToMinor, isRealDate } from "../lib/hostaway-reservations.js";

export const TOOL = "hostaway-readonly-check";
export const TOOL_VERSION = "e4-ro-v1";
export const API_ORIGIN = "https://api.hostaway.com";
export const TEST_LISTING_ID = 606998;
export const FORBIDDEN_PILOT_LISTING_IDS = Object.freeze([603564, 603566]);
export const CREDENTIAL_ENV = Object.freeze({ accountId: "E4_HA_ACCOUNT_ID", clientSecret: "E4_HA_CLIENT_SECRET" });
export const EXPECTED_FIELD = Object.freeze({
  id: 105433, name: "maraVilla booking ref", objectType: "reservation", type: "text"
});
export const MAX_NIGHTS = 31;
export const MAX_GUESTS = 16;
export const REQUEST_TIMEOUT_MS = 15000;
const TOKEN_ACTIVATION_DELAY_MS = 1100;   // documented: wait >= 1 s after minting (as lib/hostaway.js)
const CUSTOM_FIELDS_LIMIT = 100;

export class CheckError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.name = "CheckError"; this.code = code; }
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;
const enumOrNull = (v, allowed) => (allowed.includes(v) ? v : null);
const intOrNull = (v, min, max) => (Number.isSafeInteger(v) && v >= min && v <= max ? v : null);
const boolish = (v) => (v === 1 || v === true ? true : v === 0 || v === false ? false : null);
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9]{0,40}$/;
const SAFE_VARNAME = /^[a-z0-9_]{1,64}$/;

// ---------------------------------------------------------------------------------------------
// Arguments and plan (pure)

export function parseArgs(argv) {
  const o = { execute: false };
  const take = (i, k) => { if (i + 1 >= argv.length) throw new CheckError("ARG_MISSING_VALUE", k); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--execute-readonly") o.execute = true;
    else if (a === "--dry-run") o.execute = false;
    else if (a === "--listing") { o.listing = take(i, a); i++; }
    else if (a === "--from") { o.from = take(i, a); i++; }
    else if (a === "--to") { o.to = take(i, a); i++; }
    else if (a === "--guests") { o.guests = take(i, a); i++; }
    else throw new CheckError("ARG_UNKNOWN", a.startsWith("--") ? a : "positional");
  }
  return o;
}

/** Validates the owner's runtime choices. The tool never picks dates; it only checks them. */
export function buildPlan(args) {
  const listing = /^\d{1,12}$/.test(String(args.listing ?? "")) ? Number(args.listing) : NaN;
  if (FORBIDDEN_PILOT_LISTING_IDS.includes(listing)) throw new CheckError("PILOT_LISTING_FORBIDDEN");
  if (listing !== TEST_LISTING_ID) throw new CheckError("LISTING_NOT_ALLOWED");
  if (!isRealDate(args.from) || !isRealDate(args.to)) throw new CheckError("INVALID_DATE", "YYYY-MM-DD");
  if (!(args.to > args.from)) throw new CheckError("DEPARTURE_NOT_AFTER_ARRIVAL");
  const nights = Math.round((Date.parse(`${args.to}T00:00:00Z`) - Date.parse(`${args.from}T00:00:00Z`)) / 86400000);
  if (nights > MAX_NIGHTS) throw new CheckError("WINDOW_TOO_LONG", `max ${MAX_NIGHTS} nights`);
  const guests = /^\d{1,2}$/.test(String(args.guests ?? "")) ? Number(args.guests) : NaN;
  if (!isPosInt(guests) || guests > MAX_GUESTS) throw new CheckError("INVALID_GUESTS");
  const id = TEST_LISTING_ID;
  const requests = [
    { step: "customFields", method: "GET", path: "/v1/customFields", query: { objectType: "reservation", limit: CUSTOM_FIELDS_LIMIT, offset: 0 } },
    { step: "listing", method: "GET", path: `/v1/listings/${id}`, query: {} },
    { step: "calendar", method: "GET", path: `/v1/listings/${id}/calendar`, query: { startDate: args.from, endDate: args.to } },
    { step: "priceDetails", method: "POST", path: `/v1/listings/${id}/calendar/priceDetails`, query: {},
      body: { startingDate: args.from, endingDate: args.to, numberOfGuests: guests, version: 2 } }
  ];
  for (const r of requests) assertAllowedRequest(r);
  return Object.freeze({ listingId: id, from: args.from, to: args.to, nights, guests, requests: Object.freeze(requests.map((r) => Object.freeze(r))) });
}

/** The only requests this tool can ever send (besides the token mint). Anything else is refused. */
export function assertAllowedRequest(r) {
  if (!isPlainObject(r)) throw new CheckError("REQUEST_REFUSED", "shape");
  const id = TEST_LISTING_ID;
  const allowed = {
    "GET /v1/customFields": (q, b) => b === undefined && sameKeys(q, ["objectType", "limit", "offset"]) && q.objectType === "reservation" && q.limit === CUSTOM_FIELDS_LIMIT && q.offset === 0,
    [`GET /v1/listings/${id}`]: (q, b) => b === undefined && sameKeys(q, []),
    [`GET /v1/listings/${id}/calendar`]: (q, b) => b === undefined && sameKeys(q, ["startDate", "endDate"]) && isRealDate(q.startDate) && isRealDate(q.endDate),
    [`POST /v1/listings/${id}/calendar/priceDetails`]: (q, b) => sameKeys(q, []) && isPlainObject(b) &&
      sameKeys(b, ["startingDate", "endingDate", "numberOfGuests", "version"]) && isRealDate(b.startingDate) && isRealDate(b.endingDate) &&
      isPosInt(b.numberOfGuests) && b.numberOfGuests <= MAX_GUESTS && b.version === 2
  };
  const key = `${r.method} ${r.path}`;
  if (FORBIDDEN_PILOT_LISTING_IDS.some((p) => String(r.path).includes(String(p)))) throw new CheckError("PILOT_LISTING_FORBIDDEN");
  const ok = allowed[key];
  if (!ok || !ok(r.query ?? {}, r.body)) throw new CheckError("REQUEST_REFUSED", key);
  return true;
}
const sameKeys = (o, keys) => isPlainObject(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));

/** Dry-run manifest: what WOULD be sent. No credentials needed, no network. */
export function manifest(plan) {
  return {
    tool: TOOL, version: TOOL_VERSION, mode: "dry-run", network: false,
    listingId: plan.listingId, from: plan.from, to: plan.to, nights: plan.nights, guests: plan.guests,
    calls: [
      { step: "token", method: "POST", path: "/v1/accessTokens", note: "authentication only; credentials from E4_HA_* env, never printed" },
      ...plan.requests.map((r) => ({ step: r.step, method: r.method, path: r.path, query: r.query, ...(r.body ? { body: r.body } : {}) }))
    ],
    writes: "none (no reservation, calendar, listing, field, coupon, payment or settings write exists in this tool)"
  };
}

// ---------------------------------------------------------------------------------------------
// Sanitizers (pure). Each returns only validated primitives.

const unwrap = (json) => (isPlainObject(json) && json.status === "success" && Object.prototype.hasOwnProperty.call(json, "result") ? json.result : undefined);

export function summarizeCustomFields(json) {
  const result = unwrap(json);
  if (!Array.isArray(result)) return { ok: false, code: "UNEXPECTED_SHAPE" };
  if (result.length >= CUSTOM_FIELDS_LIMIT) return { ok: false, code: "LIST_POSSIBLY_TRUNCATED" };
  const valid = result.filter(isPlainObject);
  const byId = valid.filter((f) => f.id === EXPECTED_FIELD.id);
  const sameName = valid.filter((f) => f.name === EXPECTED_FIELD.name);
  if (byId.length !== 1) return { ok: false, code: byId.length ? "FIELD_ID_DUPLICATED" : "FIELD_ID_NOT_FOUND", fieldsReturned: valid.length, sameNameCount: sameName.length };
  const f = byId[0];
  const isPublic = boolish(f.isPublic);
  const checks = {
    idMatches: true,
    nameExact: f.name === EXPECTED_FIELD.name,
    objectTypeReservation: f.objectType === EXPECTED_FIELD.objectType,
    typeText: f.type === EXPECTED_FIELD.type,
    private: isPublic === false,
    uniqueName: sameName.length === 1
  };
  return {
    ok: Object.values(checks).every(Boolean), code: Object.values(checks).every(Boolean) ? "FIELD_VERIFIED" : "FIELD_MISMATCH",
    fieldId: f.id, objectType: enumOrNull(f.objectType, ["reservation", "listing", "task"]), type: enumOrNull(f.type, ["text", "textarea", "number", "dropdown"]),
    isPublic, varName: typeof f.varName === "string" && SAFE_VARNAME.test(f.varName) ? f.varName : null,
    fieldsReturned: valid.length, sameNameCount: sameName.length, checks
  };
}

export function summarizeListing(json) {
  const l = unwrap(json);
  if (!isPlainObject(l)) return { ok: false, code: "UNEXPECTED_SHAPE" };
  if (l.id !== TEST_LISTING_ID) return { ok: false, code: "LISTING_ID_MISMATCH" };
  const name = typeof l.name === "string" ? l.name : null;
  const nameStatus = name === "maraVilla TEST - DO NOT BOOK" ? "EXACT" : name === "maraVilla TEST - DO NOT BOOK." ? "TRAILING_PERIOD" : "OTHER";
  const money = (v) => (typeof v === "number" ? amountToMinor(v) : null);
  const out = {
    ok: true, code: "LISTING_READ", listingId: l.id, nameStatus,
    archived: l.specialStatus === "archived" ? true : l.specialStatus === null || l.specialStatus === undefined ? false : null,
    currencyCode: typeof l.currencyCode === "string" && /^[A-Z]{3}$/.test(l.currencyCode) ? l.currencyCode : null,
    priceMinor: money(l.price), cleaningFeeMinor: money(l.cleaningFee),
    minNights: intOrNull(l.minNights, 0, 3650), maxNights: intOrNull(l.maxNights, 0, 100000), personCapacity: intOrNull(l.personCapacity, 0, 100),
    checkInTimeStart: intOrNull(l.checkInTimeStart, 0, 23), checkInTimeEnd: intOrNull(l.checkInTimeEnd, 0, 23), checkOutTime: intOrNull(l.checkOutTime, 0, 23),
    instantBookable: boolish(l.instantBookable),
    isBookingEngineActive: boolish(l.isBookingEngineActive)            // documented on the listing object; null if absent
  };
  if (out.archived === true) { out.ok = false; out.code = "LISTING_ARCHIVED"; }
  return out;
}

const DAY_KEYS = ["date", "status", "isAvailable", "minimumStay", "maximumStay", "closedOnArrival", "closedOnDeparture", "price"];
export function summarizeCalendar(json, plan) {
  const raw = Array.isArray(json) ? json : unwrap(json);
  if (!Array.isArray(raw)) return { ok: false, code: "UNEXPECTED_SHAPE" };
  const days = raw.filter(isPlainObject).map((d) => Object.fromEntries(DAY_KEYS.map((k) => [k, Object.prototype.hasOwnProperty.call(d, k) ? d[k] : null])));
  const n = normalizeCalendar({ rawDays: days, from: plan.from, to: plan.to });
  if (!n.ok) return { ok: false, code: typeof n.error === "string" && /^[A-Z_]{1,40}$/.test(n.error) ? n.error : "CALENDAR_INVALID" };
  const prices = days.filter((d) => d.date >= plan.from && d.date < plan.to).map((d) => (typeof d.price === "number" ? amountToMinor(d.price) : null));
  const known = prices.filter((p) => p !== null);
  return {
    ok: true, code: "CALENDAR_READ",
    daysRequested: n.public.coverage.daysRequested, daysReturned: n.public.coverage.daysReturned, complete: n.public.coverage.complete,
    unavailableNights: n.public.unavailableNights,
    unavailable: n.public.unavailable.map((r) => ({ arrival: r.arrival, departure: r.departure, nights: r.nights })),
    kinds: { ...n.internal.kinds },
    nightlyPriceMinor: known.length ? { min: Math.min(...known), max: Math.max(...known), nightsWithPrice: known.length, nightsWithoutPrice: prices.length - known.length } : null
  };
}

const COMPONENT_TYPES = ["price", "tax", "fee", "discount"];
export function summarizePriceDetails(json) {
  const v = validatePriceDetails(json);
  if (!v.ok) return { ok: false, code: typeof v.error === "string" && /^[A-Z_]{1,40}$/.test(v.error) ? `PRICE_${v.error}` : "PRICE_INVALID" };
  const r = unwrap(json);
  const totalMinor = amountToMinor(r.totalPrice);
  if (totalMinor === null) return { ok: false, code: "PRICE_TOTAL_NOT_EXACT" };
  const components = [];
  for (const c of r.components) {
    const t = typeof c.total === "number" ? (c.total < 0 ? amountToMinor(-c.total) : amountToMinor(c.total)) : null;
    if (t === null) return { ok: false, code: "PRICE_COMPONENT_NOT_EXACT" };
    components.push({
      type: enumOrNull(c.type, COMPONENT_TYPES), name: typeof c.name === "string" && SAFE_NAME.test(c.name) ? c.name : null,
      totalMinor: c.total < 0 ? -t : t, included: boolish(c.isIncludedInTotalPrice), mandatory: boolish(c.isMandatory)
    });
  }
  const includedSum = components.filter((c) => c.included === true).reduce((s, c) => s + c.totalMinor, 0);
  if (includedSum !== totalMinor) return { ok: false, code: "PRICE_SUM_MISMATCH_MINOR" };
  const cleaning = components.filter((c) => c.name === "cleaningFee");
  return {
    ok: true, code: "PRICE_CALCULATED", totalMinor, componentCount: components.length, components,
    cleaningFeeMinor: cleaning.length === 1 ? cleaning[0].totalMinor : null,
    extraComponentsCount: Array.isArray(r.extraComponents) ? r.extraComponents.length : null
  };
}

// ---------------------------------------------------------------------------------------------
// Runner (transport injected; never retries; never prints secrets)

/** Reads the two credential env vars once and REMOVES them from process.env. Returns a closure-held pair. */
export function takeCredentials(env = process.env) {
  const accountId = env[CREDENTIAL_ENV.accountId];
  const clientSecret = env[CREDENTIAL_ENV.clientSecret];
  delete env[CREDENTIAL_ENV.accountId];
  delete env[CREDENTIAL_ENV.clientSecret];
  if (typeof accountId !== "string" || !/^\d{1,12}$/.test(accountId)) throw new CheckError("CREDENTIAL_ACCOUNT_ID_MISSING");
  if (typeof clientSecret !== "string" || clientSecret.length < 16 || /\s/.test(clientSecret)) throw new CheckError("CREDENTIAL_SECRET_MISSING");
  return Object.freeze({ accountId, clientSecret });
}

async function call(fetchImpl, { method, path, query, body, headers }) {
  const url = new URL(`${API_ORIGIN}${path}`);
  if (url.origin !== API_ORIGIN) throw new CheckError("ORIGIN_REFUSED");
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
  const started = Date.now();
  let resp;
  try {
    resp = await fetchImpl(url.toString(), { method, headers, body, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    return { httpStatus: null, json: null, ms: Date.now() - started, transportError: true };
  }
  let json = null;
  try { json = JSON.parse(await resp.text()); } catch { json = null; }
  return { httpStatus: resp.status, json, ms: Date.now() - started, transportError: false };
}

/**
 * Execute the plan. fetchImpl and sleep are injected (tests pass stubs). Every request passes the allowlist
 * immediately before it is sent. Returns the sanitized report only.
 */
export async function runReadonlyChecks(plan, credentials, { fetchImpl, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => new Date() }) {
  if (typeof fetchImpl !== "function") throw new CheckError("FETCH_REQUIRED");
  // Refuse a forged or altered plan BEFORE any credential is used: every request must pass the allowlist,
  // and the steps must be exactly the four documented read/calculation steps, in order.
  if (!plan || !Array.isArray(plan.requests) || plan.requests.map((r) => r && r.step).join(",") !== "customFields,listing,calendar,priceDetails") {
    throw new CheckError("PLAN_REFUSED");
  }
  for (const r of plan.requests) assertAllowedRequest(r);
  const report = { tool: TOOL, version: TOOL_VERSION, mode: "execute-readonly", startedAt: now().toISOString(),
    listingId: plan.listingId, from: plan.from, to: plan.to, nights: plan.nights, guests: plan.guests, calls: [], results: {} };

  const tok = await call(fetchImpl, {
    method: "POST", path: "/v1/accessTokens",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-control": "no-cache" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: credentials.accountId, client_secret: credentials.clientSecret, scope: "general" }).toString()
  });
  report.calls.push({ step: "token", httpStatus: tok.httpStatus, ms: tok.ms });
  const token = isPlainObject(tok.json) && typeof tok.json.access_token === "string" && tok.json.access_token ? tok.json.access_token : null;
  if (tok.transportError || tok.httpStatus !== 200 || !token) {
    report.outcome = "AUTH_FAILED";
    return finish(report, now);
  }
  await sleep(TOKEN_ACTIVATION_DELAY_MS);

  const summarize = {
    customFields: (j) => summarizeCustomFields(j),
    listing: (j) => summarizeListing(j),
    calendar: (j) => summarizeCalendar(j, plan),
    priceDetails: (j) => summarizePriceDetails(j)
  };
  for (const r of plan.requests) {
    assertAllowedRequest(r);
    const res = await call(fetchImpl, {
      method: r.method, path: r.path, query: r.query,
      headers: { Authorization: `Bearer ${token}`, "Cache-control": "no-cache", Accept: "application/json", ...(r.body ? { "Content-Type": "application/json" } : {}) },
      body: r.body ? JSON.stringify(r.body) : undefined
    });
    report.calls.push({ step: r.step, httpStatus: res.httpStatus, ms: res.ms });
    if (res.transportError) report.results[r.step] = { ok: false, code: "TRANSPORT_UNCERTAIN" };
    else if (res.httpStatus !== 200) report.results[r.step] = { ok: false, code: Number.isSafeInteger(res.httpStatus) ? `HTTP_${res.httpStatus}` : "HTTP_UNKNOWN" };
    else report.results[r.step] = summarize[r.step](res.json);
  }
  report.outcome = Object.values(report.results).every((x) => x.ok) ? "ALL_CHECKS_OK" : "SOME_CHECKS_FAILED";
  return finish(report, now);
}

function finish(report, now) {
  report.finishedAt = now().toISOString();
  report.network = "api.hostaway.com only";
  report.writes = "none";
  return report;
}

// ---------------------------------------------------------------------------------------------
// CLI entry (only when run directly)

export async function main(argv = process.argv.slice(2), { env = process.env, fetchImpl = globalThis.fetch, out = (s) => process.stdout.write(s) } = {}) {
  let plan;
  try {
    const args = parseArgs(argv);
    plan = buildPlan(args);
    if (!args.execute) {
      delete env[CREDENTIAL_ENV.accountId];            // a dry run never reads credentials; drop them if present
      delete env[CREDENTIAL_ENV.clientSecret];
      out(`${JSON.stringify(manifest(plan), null, 2)}\n`);
      return 0;
    }
    const credentials = takeCredentials(env);
    const report = await runReadonlyChecks(plan, credentials, { fetchImpl });
    out(`${JSON.stringify(report, null, 2)}\n`);
    return report.outcome === "ALL_CHECKS_OK" ? 0 : 2;
  } catch (e) {
    // Credentials are never part of an error; only a code is printed.
    delete env[CREDENTIAL_ENV.accountId];
    delete env[CREDENTIAL_ENV.clientSecret];
    out(`${JSON.stringify({ tool: TOOL, version: TOOL_VERSION, ok: false, code: e instanceof CheckError ? e.code : "UNEXPECTED_ERROR" })}\n`);
    return 1;
  }
}

const invokedDirectly = (() => { try { return import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; } })();
if (invokedDirectly) main().then((code) => { process.exitCode = code; });
