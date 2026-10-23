#!/usr/bin/env node
// E4 READ-ONLY reservation SHAPE check for the attempt-2 test reservation (DRAFT for review; running it needs a GO).
//
//   node scripts/e4-launcher/reservation-shape-check.mjs --reviewed-commit <40-hex commit>
//
// Purpose: report how Hostaway actually returns `id` / `hostawayReservationId` for ONE fixed reservation, so a parser
// fix can be chosen from evidence. Same structure as auth-check.mjs:
//   1. strict arguments; 2. read-only git provenance of every loaded source (no prompt/network on failure);
//   3. the reviewed hidden TTY prompt; 4. the reviewed single-attempt transport behind a LOCAL allowlist that lets
//   through exactly one POST /v1/accessTokens and one GET /v1/reservations/70636076?includeResources=1 (no body);
//   anything else is refused before fetch; no retry, no re-mint;
//   5. output: fixed codes, booleans, types, and the two id values only when they are plain digits AND the
//   reservation is the expected one (id, listing 606998, ref MV-OTHL9CQU). Never the provider body, guest data, the
//   channel reservation identifier (`reservationId`, it embeds the account), names, emails, token or error text.
// It never writes (no create/cancel/update/price POST), never touches a journal or manifest, and writes no file.

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { verifyProvenance, makeGit, EXECUTE_SOURCES } from "./happy-execute.mjs";
import { createHostawayTransport, HOSTAWAY_BASE } from "../e4-transport/hostaway-transport.mjs";
import { promptHostawayCredentials } from "../e4-transport/credential-prompt.mjs";
import { sanitizeTransportDiag, E4_TEST_LISTING_ID, E4_REF_FIELD_ID, READ_QUERY } from "../e4-write-runner/runner.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const SHAPE_SOURCES = Object.freeze([...EXECUTE_SOURCES, "scripts/e4-launcher/reservation-shape-check.mjs"]);
export const SHAPE_EXIT = Object.freeze({ OK: 0, USAGE: 64, REFUSED: 2, DIAGNOSED_FAILURE: 3, INTERNAL: 70 });
export const SHAPE_TARGET = Object.freeze({ reservationId: 70636076, listingId: E4_TEST_LISTING_ID, ref: "MV-OTHL9CQU",
  arrivalDate: "2027-03-10", departureDate: "2027-03-12", totalMinor: 25000, currency: "USD" });
const TOKEN_URL = `${HOSTAWAY_BASE}/accessTokens`;
const READ_PATH = `/reservations/${SHAPE_TARGET.reservationId}`;
const READ_URL = `${HOSTAWAY_BASE}${READ_PATH}?includeResources=1`;
// Local copies (the adapter's importer set is containment-tested; tests assert these equal the adapter's values).
export const DIRECT_CHANNEL_ID = 2000;
export const RESERVATION_STATUSES = Object.freeze(["new", "modified", "cancelled", "ownerStay", "pending", "awaitingPayment", "declined",
  "expired", "inquiry", "inquiryPreapproved", "inquiryDenied", "inquiryTimedout", "inquiryNotPossible"]);

/** Exactly one token POST and one reservation GET (no body); everything else refused WITHOUT calling fetch. */
export function guardFetch(fetchImpl) {
  const used = { token: 0, read: 0, refused: 0 };
  const guarded = async (url, init = {}) => {
    const u = String(url);
    const method = init && typeof init.method === "string" ? init.method : "GET";
    const isToken = u === TOKEN_URL && method === "POST" && used.token === 0;
    const isRead = u === READ_URL && method === "GET" && init.body === undefined && used.read === 0;
    if (!isToken && !isRead) { used.refused++; throw Object.assign(new Error("refused by local allowlist"), { name: "LocalRefusal" }); }
    if (isToken) used.token++; else used.read++;
    return fetchImpl(url, init);
  };
  return { guarded, used: () => Object.freeze({ ...used }) };
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const DIGITS = /^[1-9]\d{0,15}$/;
/** Type of an id-like value; the value itself only for a positive safe integer or a plain digit string. */
export function describeId(v, withValue) {
  if (v === undefined) return { type: "absent" };
  if (v === null) return { type: "null" };
  if (typeof v === "number") return Number.isSafeInteger(v) && v > 0 ? { type: "integer", ...(withValue ? { value: v } : {}) } : { type: "number-other" };
  if (typeof v === "string") return DIGITS.test(v) ? { type: "string-digits", ...(withValue ? { value: v } : {}) } : { type: "string-other" };
  return { type: Array.isArray(v) ? "array" : typeof v };
}
const numEq = (v, n) => v === n || (typeof v === "string" && DIGITS.test(v) && Number(v) === n);
const typeOf = (v) => (v === undefined ? "absent" : v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/** Pure: GET result object -> safe report (no provider strings). */
export function describeReservation(r) {
  const T = SHAPE_TARGET;
  const cfv = r.customFieldValues;
  const mine = Array.isArray(cfv) ? cfv.filter((x) => isObj(x) && x.customFieldId === E4_REF_FIELD_ID) : [];
  const checks = {
    idMatchesTarget: numEq(r.id, T.reservationId),
    listingMatches: numEq(r.listingMapId, T.listingId),
    refFieldCount: mine.length,
    refMatches: mine.length === 1 && mine[0].value === T.ref,
    datesMatch: r.arrivalDate === T.arrivalDate && r.departureDate === T.departureDate,
    channelDirect: numEq(r.channelId, DIRECT_CHANNEL_ID)
  };
  const identityOk = checks.idMatchesTarget && checks.listingMatches && checks.refMatches && checks.datesMatch;
  const shape = {
    id: describeId(r.id, identityOk),
    hostawayReservationId: describeId(r.hostawayReservationId, identityOk),
    aliasStrictEqualsId: r.hostawayReservationId === r.id,
    aliasNumericEqualsId: Number.isSafeInteger(r.id) && numEq(r.hostawayReservationId, r.id),
    listingMapIdType: typeOf(r.listingMapId), channelIdType: typeOf(r.channelId), totalPriceType: typeOf(r.totalPrice),
    currencyType: typeOf(r.currency), statusType: typeOf(r.status), customFieldValuesType: typeOf(cfv)
  };
  return {
    identityOk, checks, shape,
    ...(identityOk ? {
      status: RESERVATION_STATUSES.includes(r.status) ? r.status : "OTHER",
      totalMinorMatches: typeof r.totalPrice === "number" && Number.isFinite(r.totalPrice) && Math.round(r.totalPrice * 100) === T.totalMinor && Math.abs(r.totalPrice * 100 - T.totalMinor) < 1e-6,
      currencyMatches: typeof r.currency === "string" && r.currency.toUpperCase() === T.currency
    } : {})
  };
}

const refuse = (exitCode, stage, error) => ({ exitCode, output: Object.freeze({ ok: false, mode: "reservation-shape-check", stage, error,
  credentialsRequested: stage !== "arguments" && stage !== "provenance", network: "none" }) });

/** deps (tests): { git, prompt, fetchImpl, sleep } */
export async function runShapeCheck(argv, deps = {}) {
  const a = Array.isArray(argv) ? argv : [];
  if (a.length !== 2 || a[0] !== "--reviewed-commit") return refuse(SHAPE_EXIT.USAGE, "arguments", "USAGE");
  const reviewedCommit = a[1];
  if (typeof reviewedCommit !== "string" || !/^[0-9a-f]{40}$/.test(reviewedCommit)) return refuse(SHAPE_EXIT.USAGE, "arguments", "REVIEWED_COMMIT_INVALID");
  const prov = verifyProvenance({ reviewedCommit, git: deps.git ?? makeGit(ROOT), sources: SHAPE_SOURCES });
  if (!prov.ok) return refuse(SHAPE_EXIT.REFUSED, "provenance", prov.code);

  let creds;
  try { creds = await (deps.prompt ?? promptHostawayCredentials)(); } catch (e) {
    const code = typeof e?.code === "string" && /^[A-Z_]{1,40}$/.test(e.code) ? e.code : "CREDENTIALS_UNAVAILABLE";
    return { exitCode: SHAPE_EXIT.REFUSED, output: Object.freeze({ ok: false, mode: "reservation-shape-check", stage: "credentials", error: code, network: "none" }) };
  }
  const getCredentials = async () => { const c = creds; creds = null; return c; };
  try {
    const guard = guardFetch(deps.fetchImpl ?? globalThis.fetch);
    const transport = createHostawayTransport({ fetchImpl: guard.guarded, getCredentials, ...(deps.sleep ? { sleep: deps.sleep } : {}) });
    const r = await transport.send({ method: "GET", path: READ_PATH, query: READ_QUERY });
    const used = guard.used();
    const requests = { token: used.token, read: used.read };
    const base = { mode: "reservation-shape-check", reviewedCommit, target: { reservationId: SHAPE_TARGET.reservationId, ref: SHAPE_TARGET.ref } };
    if (r.transportError) {
      const diag = sanitizeTransportDiag(r.diag);
      return { exitCode: SHAPE_EXIT.DIAGNOSED_FAILURE, output: Object.freeze({ ok: false, ...base,
        tokenOk: diag ? diag.stage === "REQUEST" : false, readOk: false, diag, requests }) };
    }
    const j = r.json;
    const readCode = r.httpStatus !== 200 ? "READ_HTTP_NOT_OK"
      : !isObj(j) || j.status !== "success" ? "READ_ENVELOPE_INVALID" : !isObj(j.result) ? "READ_RESULT_NOT_OBJECT" : "READ_OK";
    const readHttpStatus = Number.isSafeInteger(r.httpStatus) ? r.httpStatus : null;
    if (readCode !== "READ_OK") {
      return { exitCode: SHAPE_EXIT.DIAGNOSED_FAILURE, output: Object.freeze({ ok: false, ...base, tokenOk: true, readOk: false, readCode, readHttpStatus, requests }) };
    }
    const d = describeReservation(j.result);
    return { exitCode: d.identityOk ? SHAPE_EXIT.OK : SHAPE_EXIT.DIAGNOSED_FAILURE, output: Object.freeze({ ok: d.identityOk, ...base,
      tokenOk: true, readOk: true, readCode, readHttpStatus, ...d, requests }) };
  } catch {
    return { exitCode: SHAPE_EXIT.INTERNAL, output: Object.freeze({ ok: false, mode: "reservation-shape-check", stage: "run", error: "INTERNAL_ERROR" }) };
  } finally {
    creds = null;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await runShapeCheck(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(r.output, null, 2)}\n`);
  process.exitCode = r.exitCode;
}
