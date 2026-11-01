#!/usr/bin/env node
// E4 CONNECTED-LISTING PRECHECK (603566) — strictly READ-ONLY. Execution (create/cancel) is NOT wired anywhere.
//
//   node scripts/e4-connected/connected-precheck.mjs --dry-run  --manifest <file.json> --reviewed-commit <sha>
//        provenance of the complete import closure at <sha>, then the manifest check. Zero credentials, zero network,
//        zero files written.
//   node scripts/e4-connected/connected-precheck.mjs --precheck --manifest <file.json> --reviewed-commit <sha>
//        the same, then the reviewed hidden prompt (the owner's EXISTING key only) and ONE token mint, then exactly:
//          P1 GET  /listings/603566                      identity, currency MXN, capacity >= guests, documented airbnbListingUrl
//          P2 POST /listings/603566/calendar/priceDetails price for the manifest stay (calculation only; creates nothing)
//          P3 GET  /listings/603566/calendar              every stay night open
//          P4 GET  /reservations (<= 5 pages)             nothing at all on the arrival date (bounded, to an empty page)
//          A  operator: Airbnb's own public calendar for the nights (asked separately; never inferred from Hostaway)
//        A two-layer allowlist (the runner gate + a fetch guard) refuses every other request before fetch: no booking,
//        cancel, message, payment or other listing. No retries, no re-mint. Nothing is journaled; no file is written.
// Manifest: a connected-path manifest. PROPOSAL mode: totalMinor and/or the guest may still be placeholders (the
// precheck then reports the observed price as a proposal for the owner to approve); everything else must be concrete,
// including reviewedCommit == --reviewed-commit.
// Output: codes, booleans, counts, ids and dates only. Never provider bodies, guest data, account ids, tokens, keys,
// URLs with credentials or error text. Some facts cannot be proven read-only and are reported as such (refFieldStorage).

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { verifyProvenance, makeGit } from "../e4-launcher/happy-execute.mjs";
import { createHostawayTransport, HOSTAWAY_BASE } from "../e4-transport/hostaway-transport.mjs";
import { promptHostawayCredentials } from "../e4-transport/credential-prompt.mjs";
import { connectedTestAdapterConfig, CONNECTED_TEST_LISTING_ID, lookupByRef, LOOKUP_MAX_PAGES } from "../../lib/hostaway-reservations.js";
import { createGate, withTimeout, RunnerError, DEFAULT_TIMEOUT_MS, PLACEHOLDER, generateRunRefs, parsePriceTotal, sanitizeTransportDiag } from "../e4-write-runner/runner.mjs";
import { validateConnectedManifest, stayNights, CONNECTED_AIRBNB_LISTING_ID, CONNECTED_LIVE_UNVERIFIED } from "./connected-path.mjs";
import { nightsState } from "./safeguards.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const CONNECTED_PRECHECK_VERSION = "e4-connected-precheck-v1";
// Complete static import closure of this CLI (asserted by test); all are provenance-checked before any credential.
export const CONNECTED_PRECHECK_SOURCES = Object.freeze([
  "lib/hostaway-reservations.js", "scripts/e4-connected/connected-path.mjs", "scripts/e4-connected/connected-precheck.mjs",
  "scripts/e4-connected/safeguards.mjs", "scripts/e4-launcher/happy-execute.mjs", "scripts/e4-recovery/cancel-only.mjs",
  "scripts/e4-transport/credential-prompt.mjs", "scripts/e4-transport/hostaway-transport.mjs", "scripts/e4-write-runner/happy-path.mjs",
  "scripts/e4-write-runner/happy-preflight.mjs", "scripts/e4-write-runner/journal.mjs", "scripts/e4-write-runner/runner.mjs",
  "scripts/e4-write-runner/side-effects.mjs"
]);
export const CONNECTED_PRECHECK_EXIT = Object.freeze({ OK: 0, USAGE: 64, REFUSED: 2, INCOMPLETE: 3, INTERNAL: 70 });
export const CONNECTED_PRECHECK_STEPS = Object.freeze({
  P1_LISTING: Object.freeze({ reads: 1, writes: 0 }),
  P2_PRICE: Object.freeze({ reads: 1, writes: 0 }),
  P3_CALENDAR: Object.freeze({ reads: 1, writes: 0 }),
  P4_LOOKUP: Object.freeze({ reads: LOOKUP_MAX_PAGES, writes: 0 })
});
export const REF_FIELD_STORAGE = "UNPROVEN_WITHOUT_CREATE";   // only a create can show that field 105433 is stored on 603566
const NO_WRITES = Object.freeze({ create: 0, cancel: 0 });
const PROPOSAL_FIELDS = ["totalMinor", "guest.firstName", "guest.lastName", "guest.email"];
const MAX_MANIFEST_BYTES = 65536;
const L = CONNECTED_TEST_LISTING_ID;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
}

// ---------------------------------------------------------------------------------------------
// Manifest (bound or proposal). Proposal substitutes valid stand-ins ONLY for the proposal fields, so every other
// rule of validateConnectedManifest applies unchanged; a stand-in never leaves this function.

const STAND_IN = Object.freeze({ totalMinor: 1, guest: Object.freeze({ firstName: "Standin", lastName: "Standin", email: "standin@example.invalid" }) });
export function checkPrecheckManifest(input, { now, reviewedCommit }) {
  if (!isObj(input)) return { ok: false, errors: ["MANIFEST_NOT_OBJECT"] };
  const proposal = [];
  const m = JSON.parse(JSON.stringify(input));
  if (m.totalMinor === PLACEHOLDER) { proposal.push("totalMinor"); m.totalMinor = STAND_IN.totalMinor; }
  if (isObj(m.guest)) for (const k of ["firstName", "lastName", "email"]) if (m.guest[k] === PLACEHOLDER) { proposal.push(`guest.${k}`); m.guest[k] = STAND_IN.guest[k]; }
  const v = validateConnectedManifest(m, { now });
  if (!v.ok) return { ok: false, errors: v.errors, blockers: v.blockers };
  if (v.manifest.reviewedCommit !== reviewedCommit) return { ok: false, errors: ["REVIEWED_COMMIT_NOT_BOUND"] };
  const s = v.manifest.stay;
  return { ok: true, proposal, manifestHash: proposal.length ? null : v.hash, guests: v.manifest.guests, totalMinor: proposal.includes("totalMinor") ? null : v.manifest.totalMinor,
    stay: { arrivalDate: s.arrivalDate, departureDate: s.departureDate }, nights: stayNights(s) };
}

/** The exact request shapes of one precheck (from the checked manifest). */
export function boundShapes(c) {
  return deepFreeze({
    priceBody: { startingDate: c.stay.arrivalDate, endingDate: c.stay.departureDate, numberOfGuests: c.guests, version: 2 },
    calendar: { startDate: c.nights[0], endDate: c.nights[c.nights.length - 1] },
    lookup: { listingId: L, channelId: 2000, arrivalStartDate: c.stay.arrivalDate, arrivalEndDate: c.stay.arrivalDate, limit: 100, includeResources: 1 }
  });
}

// ---------------------------------------------------------------------------------------------
// Layer 1: the gate allowlist (read/calc only; no write kind can ever pass).

export function assertPrecheckRequest(req, state, writeKind) {
  if (writeKind !== null && writeKind !== undefined) throw new RunnerError("PRECHECK_WRITES_NOTHING");
  if (!isObj(req) || typeof req.method !== "string" || typeof req.path !== "string") throw new RunnerError("REQUEST_MALFORMED");
  const b = state.bound;
  if (!isObj(b)) throw new RunnerError("REQUEST_NOT_BOUND_TO_RUN");
  const q = req.query === undefined ? {} : req.query;
  if (!isObj(q)) throw new RunnerError("REQUEST_MALFORMED");
  if (req.method === "GET" && req.path === `/listings/${L}` && Object.keys(q).length === 0 && req.body === undefined) return "read";
  if (req.method === "POST" && req.path === `/listings/${L}/calendar/priceDetails` && Object.keys(q).length === 0 && canonical(req.body) === canonical(b.priceBody)) return "calc";
  if (req.method === "GET" && req.path === `/listings/${L}/calendar` && req.body === undefined && canonical(q) === canonical(b.calendar)) return "read";
  if (req.method === "GET" && req.path === "/reservations" && req.body === undefined &&
    canonical(Object.fromEntries(Object.entries(q).filter(([k]) => k !== "afterId"))) === canonical(b.lookup) &&
    (!Object.prototype.hasOwnProperty.call(q, "afterId") || isPosInt(q.afterId))) return "lookup";
  throw new RunnerError("REQUEST_NOT_ALLOWLISTED");
}

// ---------------------------------------------------------------------------------------------
// Layer 2: fetch guard under the transport (exact method + URL + query + body, hard counts; refusal before fetch).

const TOKEN_URL = `${HOSTAWAY_BASE}/accessTokens`;
export function guardFetch(fetchImpl, bound) {
  const exact = (o) => (p) => Object.keys(o).length === [...p.keys()].length && Object.entries(o).every(([k, v]) => p.get(k) === String(v));
  const body = (o) => (b) => { try { return typeof b === "string" && canonical(JSON.parse(b)) === canonical(o); } catch { return false; } };
  const rules = [
    { name: "token", max: 1, m: "POST", path: "/v1/accessTokens", q: (p) => [...p.keys()].length === 0, body: (b) => b !== undefined },
    { name: "listing", max: 1, m: "GET", path: `/v1/listings/${L}`, q: exact({}), body: (b) => b === undefined },
    { name: "price", max: 1, m: "POST", path: `/v1/listings/${L}/calendar/priceDetails`, q: exact({}), body: body(bound.priceBody) },
    { name: "calendar", max: 1, m: "GET", path: `/v1/listings/${L}/calendar`, q: exact(bound.calendar), body: (b) => b === undefined },
    { name: "lookup", max: LOOKUP_MAX_PAGES, m: "GET", path: "/v1/reservations", body: (b) => b === undefined, q: (p) => {
      const keys = [...p.keys()].filter((k) => k !== "afterId");
      return exact(bound.lookup)(new URLSearchParams(keys.map((k) => [k, p.get(k)]))) && (!p.has("afterId") || /^[1-9]\d{0,15}$/.test(p.get("afterId")));
    } }
  ];
  const used = Object.fromEntries(rules.map((r) => [r.name, 0]));
  let refused = 0;
  const guarded = async (url, init = {}) => {
    let u = null; try { u = new URL(String(url)); } catch { u = null; }
    const method = init && typeof init.method === "string" ? init.method : "GET";
    const rule = u && u.origin === "https://api.hostaway.com" ? rules.find((r) => r.m === method && r.path === u.pathname && r.q(u.searchParams) && r.body(init.body)) : undefined;
    if (!rule || used[rule.name] >= rule.max || (rule.name === "token" && String(url) !== TOKEN_URL)) {
      refused++; throw Object.assign(new Error("refused by local allowlist"), { name: "LocalRefusal" });
    }
    used[rule.name]++;
    return fetchImpl(url, init);
  };
  return { guarded, used: () => Object.freeze({ ...used, refused }) };
}

// ---------------------------------------------------------------------------------------------
// The read-only run (transport and operator checkpoint injected).

const CAL_STATUSES = ["available", "reserved", "pending", "blocked", "hardBlock", "mreserved", "mblocked", "conflicted"];
function nightCodes(resp, nights) {
  if (!isObj(resp) || resp.transportError || resp.httpStatus !== 200 || !isObj(resp.json) || resp.json.status !== "success" || !Array.isArray(resp.json.result)) return null;
  return nights.map((date) => {
    const d = resp.json.result.filter((x) => isObj(x) && x.date === date);
    if (d.length !== 1) return { date, code: d.length ? "NIGHT_DUPLICATED" : "NIGHT_MISSING" };
    const st = CAL_STATUSES.includes(d[0].status) ? d[0].status.toUpperCase() : "OTHER";
    const av = d[0].isAvailable === 1 || d[0].isAvailable === true ? "TRUE" : d[0].isAvailable === 0 || d[0].isAvailable === false ? "FALSE" : "OTHER";
    return { date, code: `NIGHT_${st}_${av}` };
  });
}
// Airbnb link evidence: ONLY the documented read-only Listing field `airbnbListingUrl` (official Hostaway Listing object),
// parsed structurally: https, host www.airbnb.com or airbnb.com, no credentials/port/query/fragment, path exactly
// /rooms/<digits> compared as a STRING (no numeric precision loss). Expected id => link seen; another id => explicit
// mismatch; absent/unparseable/other host => unknown. A link is not proof of an active connection or of sync.
const AIRBNB_HOSTS = Object.freeze(["www.airbnb.com", "airbnb.com"]);
export function airbnbLinkEvidence(listing) {
  const v = isObj(listing) ? listing.airbnbListingUrl : undefined;
  if (v === undefined || v === null || v === "") return "AIRBNB_URL_ABSENT_UNKNOWN";
  if (typeof v !== "string" || v.length > 300) return "AIRBNB_URL_INVALID_UNKNOWN";
  let u;
  try { u = new URL(v); } catch { return "AIRBNB_URL_INVALID_UNKNOWN"; }
  if (u.protocol !== "https:" || !AIRBNB_HOSTS.includes(u.hostname) || u.username || u.password || u.port || u.search || u.hash) return "AIRBNB_URL_INVALID_UNKNOWN";
  const m = /^\/rooms\/([1-9]\d{0,24})\/?$/.exec(u.pathname);
  if (!m) return "AIRBNB_URL_INVALID_UNKNOWN";
  return m[1] === CONNECTED_AIRBNB_LISTING_ID ? "AIRBNB_URL_MATCHES" : "AIRBNB_URL_OTHER_ID";
}
function listingCheck(resp, guests) {
  if (!isObj(resp) || resp.transportError) return { code: "LISTING_TRANSPORT_UNCERTAIN" };
  if (resp.httpStatus !== 200) return { code: "LISTING_HTTP_NOT_OK", ...(Number.isSafeInteger(resp.httpStatus) ? { httpStatus: resp.httpStatus } : {}) };
  const j = resp.json;
  if (!isObj(j) || j.status !== "success" || !isObj(j.result)) return { code: "LISTING_MALFORMED" };
  const r = j.result;
  const idMatches = r.id === L || r.id === String(L);
  const currencyOk = r.currencyCode === "MXN";
  const capacity = Number.isSafeInteger(r.personCapacity) && r.personCapacity > 0 && r.personCapacity <= 50 ? r.personCapacity : null;
  const capacityOk = capacity !== null && capacity >= guests;
  const mapping = airbnbLinkEvidence(r);
  return { code: idMatches && currencyOk && capacityOk ? "LISTING_OK" : "LISTING_MISMATCH", idMatches, currency: currencyOk ? "MXN" : "NOT_MXN", currencyOk, capacity, capacityOk, mapping };
}

export async function runConnectedPrecheck({ transport, checked, airbnbCheckpoint, timeoutMs = DEFAULT_TIMEOUT_MS, rng = randomBytes }) {
  const bound = boundShapes(checked);
  let firstDiag = null;
  const note = (r) => { if (firstDiag === null && r && r.transportError) { const d = sanitizeTransportDiag(r.diag); if (d) firstDiag = d; } return r; };
  const state = { halted: false, readOnly: true, readableIds: new Set(), cancellableId: null, bound };
  const noJournal = Object.freeze({ durable: false, load: () => [], append: () => { throw new RunnerError("PRECHECK_WRITES_NOTHING"); } });
  const rawGate = createGate({ transport, journal: noJournal, timeoutMs, state, budgets: CONNECTED_PRECHECK_STEPS, writeBudget: NO_WRITES,
    allowRequest: assertPrecheckRequest });
  const send = async (step, req) => { try { return note(await rawGate.send(step, req)); } catch (e) { return { transportError: true, code: e instanceof RunnerError ? e.code : "GATE" }; } };
  const out = { version: CONNECTED_PRECHECK_VERSION, listingId: L, airbnbListingId: CONNECTED_AIRBNB_LISTING_ID, stay: checked.stay, nights: checked.nights,
    guests: checked.guests, priceMode: checked.proposal.includes("totalMinor") ? "proposal" : "bound", refFieldStorage: REF_FIELD_STORAGE };
  out.listing = listingCheck(await send("P1_LISTING", { method: "GET", path: `/listings/${L}`, query: {} }), checked.guests);
  const pr = parsePriceTotal(await send("P2_PRICE", { method: "POST", path: `/listings/${L}/calendar/priceDetails`, query: {}, body: bound.priceBody }));
  // priceDetails carries no currency: an amount is labelled MXN (matched or proposed) only when THIS run read the listing
  // currency as MXN; otherwise the currency of the amount is unproven and no amount is reported.
  out.price = !pr.ok ? { code: pr.code } : out.listing.currencyOk !== true ? { code: "PRICE_CURRENCY_UNPROVEN" } : out.priceMode === "proposal"
    ? { code: "PRICE_OBSERVED_PROPOSAL", observedTotalMinor: pr.totalMinor, currency: "MXN" }
    : { code: pr.totalMinor === checked.totalMinor ? "PRICE_MATCHES_MANIFEST" : "PRICE_DIFFERS_FROM_MANIFEST", observedTotalMinor: pr.totalMinor, manifestTotalMinor: checked.totalMinor, currency: "MXN" };
  const cal = await send("P3_CALENDAR", { method: "GET", path: `/listings/${L}/calendar`, query: bound.calendar });
  const cs = nightsState(cal, checked.nights);
  out.calendar = { code: `CALENDAR_${cs.toUpperCase()}`, nights: nightCodes(cal, checked.nights) };
  let itemsSeen = 0;
  let probe;
  try { [probe] = generateRunRefs(rng, 1); } catch { probe = null; }
  if (probe) {
    const lk = await lookupByRef({ ref: probe, listingId: L, arrivalDate: checked.stay.arrivalDate, departureDate: checked.stay.departureDate }, connectedTestAdapterConfig(),
      async (req) => { const r = await send("P4_LOOKUP", req); if (!r.transportError && r.httpStatus === 200 && isObj(r.json) && Array.isArray(r.json.result)) itemsSeen += r.json.result.length; return r; });
    out.lookup = { code: lk.outcome === "not_found" && itemsSeen === 0 ? "NO_RESERVATION_ON_ARRIVAL_SEEN" : lk.outcome === "not_found" ? "OTHER_RESERVATIONS_ON_ARRIVAL" : `LOOKUP_${lk.code}`, itemsSeen, pagesRead: lk.pagesRead ?? null };
  } else out.lookup = { code: "LOOKUP_REF_GENERATION_FAILED", itemsSeen: 0 };
  // Independent Airbnb evidence: asked separately; the operator is not shown the Hostaway results first.
  let a;
  try { a = await airbnbCheckpoint(deepFreeze({ airbnbListingId: CONNECTED_AIRBNB_LISTING_ID, nights: [...checked.nights] })); } catch { a = undefined; }
  out.airbnb = { attested: ["OPEN", "BLOCKED"].includes(a) ? a : "UNKNOWN", source: "OPERATOR_ATTESTED" };
  out.checks = {
    listing: out.listing.code === "LISTING_OK", mappingNotContradicted: out.listing.mapping !== "AIRBNB_URL_OTHER_ID", price: ["PRICE_MATCHES_MANIFEST", "PRICE_OBSERVED_PROPOSAL"].includes(out.price.code),
    calendarOpen: out.calendar.code === "CALENDAR_OPEN", arrivalClear: out.lookup.code === "NO_RESERVATION_ON_ARRIVAL_SEEN", airbnbOpen: out.airbnb.attested === "OPEN"
  };
  out.precheckPassed = Object.values(out.checks).every(Boolean);
  out.transportDiag = firstDiag;
  let usage = null;
  try { usage = typeof transport.usage === "function" ? transport.usage() : null; } catch { usage = null; }
  out.transportUsage = usage && ["none", "ok", "failed"].includes(usage.mintState) && Number.isSafeInteger(usage.fetches) && usage.fetches >= 0 && usage.fetches <= 100
    ? { mintState: usage.mintState, fetches: usage.fetches } : null;
  out.requests = rawGate.requestCount();
  out.liveUnverified = CONNECTED_LIVE_UNVERIFIED;
  return out;
}

// ---------------------------------------------------------------------------------------------
// CLI

/** Visible single-line operator answer from a TTY (OPEN / BLOCKED / UNKNOWN); anything else is UNKNOWN. */
export function askAirbnbOnTty({ input = process.stdin, output = process.stderr } = {}) {
  return async ({ airbnbListingId, nights }) => {
    if (!input || input.isTTY !== true) return "UNKNOWN";
    output.write(`\nAirbnb checkpoint (independent of Hostaway): open https://www.airbnb.com/rooms/${airbnbListingId} in a browser and check the nights `
      + `${nights.join(", ")}.\nType OPEN if every night is selectable, BLOCKED if any is not, or UNKNOWN; then Enter: `);
    return new Promise((res) => {
      let buf = "";
      const onData = (chunk) => {
        buf += String(chunk);
        const i = buf.search(/[\r\n]/);
        if (i >= 0 || buf.length > 32) { input.removeListener("data", onData); if (typeof input.pause === "function") input.pause(); res(buf.slice(0, i >= 0 ? i : 32).trim().toUpperCase()); }
      };
      input.on("data", onData);
      if (typeof input.resume === "function") input.resume();
    });
  };
}

/**
 * The connected precheck's credential prompt: the reviewed hidden prompt with leading blank terminators tolerated
 * (a CR/LF still pending from a pasted PowerShell launch must not submit an empty account id). Validation unchanged.
 */
export function connectedCredentialPrompt({ input = process.stdin, output = process.stderr } = {}) {
  return promptHostawayCredentials({ input, output, tolerateLeadingBlankLines: true });
}

const refuse = (exitCode, stage, error, extra = {}) => ({ exitCode, output: Object.freeze({ ok: false, mode: "connected-precheck", stage, error, network: "none", credentialsRequested: false, filesWritten: 0, ...extra }) });

/** deps (tests): { git, readManifest, now, prompt, fetchImpl, sleep, airbnbCheckpoint, timeoutMs, rng } */
export async function runConnectedPrecheckCli(argv, deps = {}) {
  const a = Array.isArray(argv) ? argv : [];
  if (a.length !== 5 || !["--dry-run", "--precheck"].includes(a[0])) return refuse(CONNECTED_PRECHECK_EXIT.USAGE, "arguments", "USAGE");
  const mode = a[0], opts = {};
  for (let i = 1; i < 5; i += 2) {
    if (!["--manifest", "--reviewed-commit"].includes(a[i]) || Object.prototype.hasOwnProperty.call(opts, a[i]) || typeof a[i + 1] !== "string" || a[i + 1].startsWith("--")) {
      return refuse(CONNECTED_PRECHECK_EXIT.USAGE, "arguments", "USAGE");
    }
    opts[a[i]] = a[i + 1];
  }
  const sha = opts["--reviewed-commit"];
  if (!/^[0-9a-f]{40}$/.test(sha)) return refuse(CONNECTED_PRECHECK_EXIT.USAGE, "arguments", "REVIEWED_COMMIT_INVALID");
  // 1. provenance of the complete import closure, before anything else is read or asked
  const prov = verifyProvenance({ reviewedCommit: sha, git: deps.git ?? makeGit(ROOT), sources: CONNECTED_PRECHECK_SOURCES });
  if (!prov.ok) return refuse(CONNECTED_PRECHECK_EXIT.REFUSED, "provenance", prov.code);
  // 2. the manifest (read-only)
  let raw;
  try {
    raw = (deps.readManifest ?? ((p) => { if (statSync(p).size > MAX_MANIFEST_BYTES) throw new Error("big"); return readFileSync(p, "utf8"); }))(resolve(opts["--manifest"]));
  } catch { return refuse(CONNECTED_PRECHECK_EXIT.REFUSED, "manifest", "MANIFEST_UNREADABLE"); }
  let input;
  try { input = JSON.parse(raw); } catch { return refuse(CONNECTED_PRECHECK_EXIT.REFUSED, "manifest", "MANIFEST_NOT_JSON"); }
  const now = deps.now ?? (() => new Date());
  const checked = checkPrecheckManifest(input, { now, reviewedCommit: sha });
  if (!checked.ok) return refuse(CONNECTED_PRECHECK_EXIT.REFUSED, "manifest", "MANIFEST_INVALID", { manifestErrors: checked.errors ?? [], blockers: checked.blockers ?? [] });
  const summary = { reviewedCommit: sha, manifestHash: checked.manifestHash, proposalFields: checked.proposal, listingId: L, airbnbListingId: CONNECTED_AIRBNB_LISTING_ID,
    stay: checked.stay, nights: checked.nights, guests: checked.guests, totalMinor: checked.totalMinor, executionWired: false };
  if (mode === "--dry-run") {
    return { exitCode: CONNECTED_PRECHECK_EXIT.OK, output: Object.freeze({ ok: true, mode: "connected-dry-run", network: "none", credentialsRequested: false, filesWritten: 0, ...summary,
      plannedRequests: ["GET /listings/603566", "POST /listings/603566/calendar/priceDetails", "GET /listings/603566/calendar", "GET /reservations (<= 5 pages)"] }) };
  }
  // 3. the owner's existing key, privately; then the read-only run
  let creds;
  try { creds = await (deps.prompt ?? connectedCredentialPrompt)(); } catch (e) {
    return refuse(CONNECTED_PRECHECK_EXIT.REFUSED, "credentials", typeof e?.code === "string" && /^[A-Z_]{1,40}$/.test(e.code) ? e.code : "CREDENTIALS_UNAVAILABLE", { credentialsRequested: true });
  }
  const getCredentials = async () => { const c = creds; creds = null; return c; };
  try {
    const guard = guardFetch(deps.fetchImpl ?? globalThis.fetch, boundShapes(checked));
    const transport = createHostawayTransport({ fetchImpl: guard.guarded, getCredentials, ...(deps.sleep ? { sleep: deps.sleep } : {}) });
    const r = await runConnectedPrecheck({ transport, checked, airbnbCheckpoint: deps.airbnbCheckpoint ?? askAirbnbOnTty(), rng: deps.rng,
      ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}) });
    return { exitCode: r.precheckPassed ? CONNECTED_PRECHECK_EXIT.OK : CONNECTED_PRECHECK_EXIT.INCOMPLETE,
      output: Object.freeze({ ok: r.precheckPassed, mode: "connected-precheck", credentialsRequested: true, filesWritten: 0, ...summary, ...r, guard: guard.used() }) };
  } catch {
    return { exitCode: CONNECTED_PRECHECK_EXIT.INTERNAL, output: Object.freeze({ ok: false, mode: "connected-precheck", stage: "run", error: "INTERNAL_ERROR", filesWritten: 0 }) };
  } finally { creds = null; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await runConnectedPrecheckCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(r.output, null, 2)}\n`);
  process.exitCode = r.exitCode;
}
