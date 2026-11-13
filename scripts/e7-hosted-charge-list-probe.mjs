// scripts/e7-hosted-charge-list-probe.mjs — C17/C18: READ-ONLY Hostaway charge-LIST SHAPE PROBE for the ONE approved TEST target, before any
// recording POST ever happens. OFFLINE DRAFT: no workflow, no dispatch; the probe mode is NOT wired anywhere and must only be run by ROOT under
// the existing environment gate with the Hostaway secret injected the same way the recording runner's execute step injects it.
//
// What it does (and ALL it does): exactly ONE GET /v1/reservations/71700931 (accepted transport form H2) and — ONLY if the accepted identity
// proof binds listing / stay / ref / direct channel / total / active status — at most ONE GET /v1/guestPayments/charges?limit=500&reservationIds=71700931
// (accepted form H8, the exact selector the recording worker uses). Replies go through the ACCEPTED pure proofs from the pinned tooling
// (offline-charge-proof.js assessIdentitySnapshot / assessChargeList / preflightListObservation — the observation returns a branded count object
// without an ok flag; only an explicit { ok:false } is a refusal; hostaway-reservations.js envelope + normalizer), reused UNCHANGED.
//
// C18 (ROOT review 5899125821):
//   F1 the ONLY network primitive is the ACCEPTED pinned createE7RealExchange({ provider: "hostaway" }) (streaming maxBytes, no redirect follow,
//      one ClientRequest, own non-keep-alive Agent, teardown), placed BEHIND the probe's GET guard; the probe owns ONE AbortController per call
//      with a deterministic per-call deadline and an overall deadline, and tears both down. No fetch / arrayBuffer path exists.
//   F2 pagination is checked EXPLICITLY, without truthiness: `offset` must be absent, null or exactly 0; `limit` absent, null or exactly 500;
//      any continuation / page marker KEY (page, nextPage, hasMore, next, cursor, continuation, totalPages, pages, offsetNext) present at all →
//      STOP; a FULL page (count ≥ 500) → STOP. Never a second page request.
//   F3 the result carries SAFE ENUMS only for provider-controlled strings (type / status / paymentProvider / paymentMethod / currency / reservation
//      status): approved values map to themselves, anything else to "UNKNOWN"; refusal / transport codes are checked against a FIXED allowlist
//      (else "UNKNOWN_CODE"); no exception message or raw provider text is ever stored or printed; an outcome with any UNKNOWN enum is
//      "SHAPE_COMPATIBLE_WITH_UNKNOWN_VALUES", never "SHAPE_COMPATIBLE".
//   F4 before ANY module import, the probe scans the transitive relative-import closure of its four roots (incl. real-exchange.mjs) and requires
//      the EXACT pinned 8-file manifest (set equality + per-file SHA-256); any drift / extra / missing file → refused with zero import and zero
//      exchange. Accepted tooling files and pins are unchanged.
//
// Fail-closed: any non-GET, other host, other path / reservation, redirect (refused by the transport), non-200, fail / malformed envelope, filter
// or pagination ambiguity, unexpected status / shape, transport or exchange error → STOP with a code; never a retry, never a wider search, never a
// third call (hard budget 2). No executor-adapter phase is created (it would expose createOfflineCharge); no DB, worker, repo, record / cancel /
// refund / notify module is imported or reachable.
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve as resolvePath, dirname, relative } from "node:path";
import { pathToFileURL } from "node:url";

const freeze = Object.freeze;
export const PROBE_VERSION = "e7-hosted-charge-list-probe-v2";
/** the recording runner's tooling pin (Slice 4 closure) */
export const TOOLING_COMMIT = "5a094b16c1f84690a738a98ab89140caa69c1e1f";
/** the four import roots; MANIFEST = their complete transitive relative-import closure at the pin (scanned independently, must match exactly) */
export const ROOTS = freeze(["scripts/e7-connected/http-transports.mjs", "scripts/e7-connected/real-exchange.mjs", "lib/checkout/offline-charge-proof.js", "lib/hostaway-reservations.js"]);
export const MANIFEST = freeze({
  "lib/checkout/capture-proof.js": "9a3c7948b6dc80a504fc654c0dcdc47764ac8548f950bc0ea4012a3bc0a2c272",
  "lib/checkout/compensation-proof.js": "03645839f5a531367f44da0fd1413c2e9cea77efce8eafa3784a377397da5314",
  "lib/checkout/intent-state.js": "ef132f4e78e75234dba57aaf9ff652458ce490049822b380d882ba4bdbb9674f",
  "lib/checkout/offline-charge-proof.js": "2469ee967c00efc09d301a0928e56c360bce3d488cd5dbda6ec6467295761902",
  "lib/checkout/recovery-plan.js": "4ffd8dd4dc6c728bee9660f67b9846e1afad9b067e730bfc7b956ba272591570",
  "lib/hostaway-reservations.js": "d86827cc0f8dee8a02886ef11fcadc12c0a98128607d5399f55d719a9f16e608",
  "scripts/e7-connected/http-transports.mjs": "2c41847fd44ef2002d05bbd1cdb972436278957daf89d172fdefdaf6178568d8",
  "scripts/e7-connected/real-exchange.mjs": "bc584758e51fec0fc35e67d05efde8acd1094bf5ea414e280b70a0eadd5a8594"
});
/** The ONE approved TEST target (ROOT C17; facts from the merged #92 closure checkpoint). Fixed; no input can change it. */
export const TARGET = freeze({
  intentId: "abede8b1-8ef6-44f2-876e-6a02fc056a96", ref: "MV-8L79DEJ7", listingId: 606998, reservationId: "71700931",
  from: "2026-11-23", to: "2026-11-24", currency: "USD", finalTotalMinor: 14000, capturedMinor: 14000, status: "payment_captured", version: 8,
  recordedPaymentAt: Date.UTC(2026, 10, 13, 20, 57, 10)            // the capture instant (run 43505796029); only its PRESENCE is checked by the proof
});
export const CONFIG = freeze({ accountRef: "hostaway-e7-test", channelId: 2000, currency: "USD", listingId: 606998, paymentMethod: "credit_card", refFieldId: 105433 });
export const LIST_LIMIT = 500;
export const MAX_CALLS = 2;
/** budgets owned by the probe (the accepted real exchange owns no timer; the caller's AbortSignal is its only deadline) */
export const BUDGETS = freeze({ maxBytes: 256 * 1024, callMs: 15_000, totalMs: 30_000, calls: MAX_CALLS });
export const ALLOWED = freeze([freeze({ method: "GET", path: `/v1/reservations/${TARGET.reservationId}` }), freeze({ method: "GET", path: "/v1/guestPayments/charges" })]);
export const HOSTAWAY_ORIGIN = "https://api.hostaway.com";
export const CONTINUATION_KEYS = freeze(["page", "nextPage", "hasMore", "next", "cursor", "continuation", "totalPages", "pages", "offsetNext", "nextOffset"]);
export const STOP_CODES = freeze(["TOOLING_INVALID", "TOOLING_CLOSURE_MISMATCH", "TRANSPORT_INVALID", "DEADLINE", "IDENTITY_TRANSPORT_ERROR", "IDENTITY_REFUSED",
  "LIST_TRANSPORT_ERROR", "LIST_REFUSED", "LIST_PAGE_FULL_AMBIGUOUS", "LIST_OFFSET_NOT_ZERO", "LIST_OFFSET_MALFORMED", "LIST_LIMIT_INCOMPATIBLE", "LIST_LIMIT_MALFORMED",
  "LIST_CONTINUATION_MARKER_PRESENT", "LIST_OBSERVATION_REFUSED", "GUARD_REFUSED"]);
/** safe enums (F3): approved provider values map to themselves; everything else → "UNKNOWN" */
export const ENUMS = freeze({
  chargeType: freeze(["charge", "preAuth", "refund"]), chargeStatus: freeze(["paid", "unpaid", "pending", "cancelled", "refunded", "failed"]),
  paymentProvider: freeze(["offline", "stripe", "hostaway"]), paymentMethod: freeze(["credit_card", "other"]), currency: freeze(["USD", "MXN"]),
  reservationStatus: freeze(["new", "modified", "cancelled", "ownerStay", "pending", "awaitingPayment", "declined", "expired", "inquiry"]), envelope: freeze(["success", "fail"])
});
/** fixed allowlist of codes that may appear in the result (proof refusals, envelope codes, transport + real-exchange codes, probe codes); else UNKNOWN_CODE */
export const CODE_ALLOWLIST = freeze([
  ...STOP_CODES, "PAGE_FULL", "OFFSET_NOT_ZERO", "OFFSET_MALFORMED", "LIMIT_INCOMPATIBLE", "LIMIT_MALFORMED", "CONTINUATION_MARKER_PRESENT",
  "IDENTITY_ACCOUNT_REF_MISMATCH", "IDENTITY_ARRIVAL_MISMATCH", "IDENTITY_CHANNEL_MISMATCH", "IDENTITY_CLIENT_LABEL_INVALID", "IDENTITY_CONTEXT_CHANGED", "IDENTITY_CURRENCY_MISMATCH",
  "IDENTITY_DEPARTURE_MISMATCH", "IDENTITY_HTTP_STATUS", "IDENTITY_LISTING_MISMATCH", "IDENTITY_NOT_NORMALIZABLE", "IDENTITY_REF_MISMATCH", "IDENTITY_RESERVATION_ID_MISMATCH",
  "IDENTITY_RESULT_NOT_OBJECT", "IDENTITY_SNAPSHOT_SHAPE", "IDENTITY_STATUS_NOT_ACTIVE", "IDENTITY_TOTAL_MISMATCH", "IDENTITY_FAIL_ENVELOPE", "IDENTITY_MALFORMED_ENVELOPE",
  "IDENTITY_STALE", "IDENTITY_OBSERVED_IN_FUTURE", "IDENTITY_OBSERVED_AT_INVALID", "IDENTITY_NOW_INVALID", "IDENTITY_MAX_AGE_INVALID",
  "IDENTITY_AMOUNT_NOT_EXACT", "IDENTITY_CHANNEL_ID_INVALID", "IDENTITY_CURRENCY_INVALID", "IDENTITY_CUSTOM_FIELDS_MALFORMED", "IDENTITY_DATES_INVALID", "IDENTITY_LISTING_ID_INVALID",
  "IDENTITY_MALFORMED_RESERVATION", "IDENTITY_REF_FIELD_DUPLICATED", "IDENTITY_REF_VALUE_INVALID", "IDENTITY_RESERVATION_ID_INCONSISTENT", "IDENTITY_RESERVATION_ID_INVALID", "IDENTITY_STATUS_INVALID",
  "LIST_ACCOUNT_REF_MISMATCH", "LIST_BINDING_MISMATCH", "LIST_CLIENT_LABEL_INVALID", "LIST_CONTEXT_CHANGED", "LIST_COUNT_INVALID", "LIST_COUNT_LENGTH_MISMATCH", "LIST_DUPLICATE_ID",
  "LIST_FOREIGN_LISTING_ROW", "LIST_FOREIGN_RESERVATION_ROW", "LIST_HTTP_STATUS", "LIST_READ_SHAPE", "LIST_REQUEST_NOT_CANONICAL", "LIST_RESULT_NOT_ARRAY", "LIST_ROW_AMOUNT_INVALID",
  "LIST_ROW_AMOUNT_NOT_EXACT", "LIST_ROW_ID_INVALID", "LIST_ROW_MALFORMED", "LIST_ROW_TYPE_UNKNOWN", "LIST_FAIL_ENVELOPE", "LIST_MALFORMED_ENVELOPE", "LIST_STALE", "LIST_OBSERVED_IN_FUTURE",
  "LIST_ROW_TYPE_INVALID", "LIST_ROW_TITLE_INVALID", "LIST_ROW_CURRENCY_INVALID", "LIST_ROW_STATUS_INVALID", "LIST_ROW_PAYMENTPROVIDER_INVALID", "LIST_ROW_PAYMENTMETHOD_INVALID",
  "COMPLETE_LIST_REQUIRED", "ACCOUNT_REF_BINDING_MISMATCH", "CLIENT_LABEL_BINDING_MISMATCH", "POSITIVE_IDENTITY_REQUIRED", "RESERVATION_BINDING_MISMATCH", "UNEXPECTED_INPUT",
  "CONFIG_REQUIRED", "CONFIG_SHAPE", "INTENT_SHAPE", "NOT_PAYMENT_CAPTURED",
  "OPTIONS_INVALID", "REQUEST_NOT_ALLOWED", "ABORTED", "ABORTED_IN_FLIGHT", "CREDENTIAL_INVALID", "EXCHANGE_FAILED", "REDIRECT_REFUSED", "REPLY_INVALID", "BODY_TOO_LARGE", "JSON_INVALID",
  "EXCHANGE_OPTIONS_INVALID", "EXCHANGE_INPUT_INVALID", "EXCHANGE_ABORTED", "EXCHANGE_SETUP_FAILED", "EXCHANGE_NETWORK_ERROR", "EXCHANGE_PREMATURE_CLOSE", "EXCHANGE_STATUS_INVALID",
  "EXCHANGE_HEADERS_INVALID", "EXCHANGE_ENCODING_REFUSED", "EXCHANGE_BODY_TOO_LARGE", "GUARD_REFUSED"
]);
const CODE_SET = new Set(CODE_ALLOWLIST);
export const safeCode = (c) => (typeof c === "string" && CODE_SET.has(c) ? c : "UNKNOWN_CODE");
export const safeEnum = (kind, v) => (typeof v === "string" && ENUMS[kind].includes(v) ? v : "UNKNOWN");

const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const IMPORT_RE = /^\s*(?:import|export)\s[^;]*?from\s+"(\.{1,2}\/[^"]+)"|^\s*import\s+"(\.{1,2}\/[^"]+)"/gm;

/** scan the transitive RELATIVE-import closure of ROOTS (static text scan; zero import) → { ok, files: {rel: sha256} } | { ok:false, code, file } */
export async function scanClosure(root, deps = {}) {
  const read = deps.readFile ?? readFile;
  const files = {}; const queue = [...ROOTS];
  while (queue.length) {
    const rel = queue.shift();
    if (hasOwn(files, rel)) continue;
    let bytes; try { bytes = await read(`${root}/${rel}`); } catch { return freeze({ ok: false, code: "TOOLING_INVALID", file: rel }); }
    files[rel] = sha256(bytes);
    const src = Buffer.from(bytes).toString("utf8");
    for (const m of src.matchAll(IMPORT_RE)) { const spec = m[1] ?? m[2]; queue.push(relative(root, resolvePath(dirname(`${root}/${rel}`), spec))); }
  }
  return freeze({ ok: true, files: freeze(files) });
}

/** verify the EXACT pinned closure (set equality + digests) BEFORE any import; then import the four roots (fail closed on any drift) */
export async function loadTooling(dir, deps = {}) {
  const imp = deps.importModule ?? ((p) => import(pathToFileURL(p).href));
  let root; try { root = await realpath(dir); } catch { return freeze({ ok: false, code: "TOOLING_INVALID" }); }
  const scan = await scanClosure(root, deps);
  if (!scan.ok) return scan;
  const got = Object.keys(scan.files).sort(); const want = Object.keys(MANIFEST).sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    const extra = got.filter((f) => !hasOwn(MANIFEST, f)); const missing = want.filter((f) => !hasOwn(scan.files, f));
    return freeze({ ok: false, code: "TOOLING_CLOSURE_MISMATCH", file: extra[0] ?? missing[0] ?? null, extra: freeze(extra), missing: freeze(missing) });
  }
  for (const f of want) if (scan.files[f] !== MANIFEST[f]) return freeze({ ok: false, code: "TOOLING_CLOSURE_MISMATCH", file: f, extra: freeze([]), missing: freeze([]) });
  try {
    const [T, X, OP, HR] = await Promise.all([imp(`${root}/scripts/e7-connected/http-transports.mjs`), imp(`${root}/scripts/e7-connected/real-exchange.mjs`), imp(`${root}/lib/checkout/offline-charge-proof.js`), imp(`${root}/lib/hostaway-reservations.js`)]);
    for (const [m, k] of [[T, "createE7HostawaySend"], [X, "createE7RealExchange"], [OP, "assessIdentitySnapshot"], [OP, "assessChargeList"], [OP, "preflightListObservation"], [HR, "unwrapEnvelope"]])
      if (typeof m[k] !== "function") return freeze({ ok: false, code: "TOOLING_INVALID", missing: k });
    if (OP.LIST_LIMIT !== LIST_LIMIT || T.CHARGE_LIST_LIMIT !== LIST_LIMIT) return freeze({ ok: false, code: "TOOLING_INVALID", missing: "LIST_LIMIT" });
    return freeze({ ok: true, tooling: freeze({ createE7HostawaySend: T.createE7HostawaySend, createE7RealExchange: X.createE7RealExchange, assessIdentitySnapshot: OP.assessIdentitySnapshot,
      assessChargeList: OP.assessChargeList, preflightListObservation: OP.preflightListObservation, unwrapEnvelope: HR.unwrapEnvelope }), manifest: scan.files });
  } catch { return freeze({ ok: false, code: "TOOLING_INVALID" }); }
}

/** the probe's OWN exchange guard in front of the injected / real exchange: GET only, this origin only, the two allowed URLs only, no body, hard call budget, NO retry */
export function guardedExchange(exchange, state) {
  return async (req) => {
    state.attempted += 1;
    if (!isObj(req) || req.method !== "GET" || typeof req.url !== "string") { state.guardRefusals.push("NOT_GET"); throw new Error("GUARD_REFUSED"); }
    let u; try { u = new URL(req.url); } catch { state.guardRefusals.push("URL"); throw new Error("GUARD_REFUSED"); }
    if (u.origin !== HOSTAWAY_ORIGIN) { state.guardRefusals.push("ORIGIN"); throw new Error("GUARD_REFUSED"); }
    if (!ALLOWED.some((a) => a.path === u.pathname)) { state.guardRefusals.push("PATH"); throw new Error("GUARD_REFUSED"); }
    if (u.pathname === "/v1/guestPayments/charges") {
      const q = [...u.searchParams.entries()].sort();
      if (JSON.stringify(q) !== JSON.stringify([["limit", String(LIST_LIMIT)], ["reservationIds", TARGET.reservationId]])) { state.guardRefusals.push("QUERY"); throw new Error("GUARD_REFUSED"); }
    } else if ([...u.searchParams.keys()].length !== 0) { state.guardRefusals.push("QUERY"); throw new Error("GUARD_REFUSED"); }
    if (req.body !== null && req.body !== undefined) { state.guardRefusals.push("BODY"); throw new Error("GUARD_REFUSED"); }
    if (state.sent >= MAX_CALLS) { state.guardRefusals.push("BUDGET"); throw new Error("GUARD_REFUSED"); }
    state.sent += 1; state.urls.push(`${req.method} ${u.pathname}${u.search}`);
    return exchange(req);                                             // exactly once; a rejection / throw is final (no retry)
  };
}

/** F2: explicit pagination rules on the raw list envelope (no truthiness) → null | code */
export function paginationRefusal(json, count) {
  if (!isObj(json)) return null;                                      // envelope shape is the proof's business
  for (const k of CONTINUATION_KEYS) if (hasOwn(json, k)) return "CONTINUATION_MARKER_PRESENT";
  if (hasOwn(json, "offset") && json.offset !== null) {
    if (typeof json.offset !== "number" || !Number.isSafeInteger(json.offset)) return "OFFSET_MALFORMED";
    if (json.offset !== 0) return "OFFSET_NOT_ZERO";
  }
  if (hasOwn(json, "limit") && json.limit !== null) {
    if (typeof json.limit !== "number" || !Number.isSafeInteger(json.limit)) return "LIMIT_MALFORMED";
    if (json.limit !== LIST_LIMIT) return "LIMIT_INCOMPATIBLE";
  }
  if (Number.isSafeInteger(count) && count >= LIST_LIMIT) return "PAGE_FULL";
  return null;
}
const PAGINATION_STOP = freeze({ CONTINUATION_MARKER_PRESENT: "LIST_CONTINUATION_MARKER_PRESENT", OFFSET_MALFORMED: "LIST_OFFSET_MALFORMED", OFFSET_NOT_ZERO: "LIST_OFFSET_NOT_ZERO",
  LIMIT_MALFORMED: "LIST_LIMIT_MALFORMED", LIMIT_INCOMPATIBLE: "LIST_LIMIT_INCOMPATIBLE", PAGE_FULL: "LIST_PAGE_FULL_AMBIGUOUS" });

const errCode = (e) => safeCode(e && typeof e === "object" ? (typeof e.code === "string" ? e.code : e.message === "GUARD_REFUSED" ? "GUARD_REFUSED" : null) : null);
const reservationSummary = (id) => id && id.ok ? freeze({ reservationId: id.observed.reservationId, listingId: id.observed.listingId, channelId: id.observed.channelId, from: id.observed.from, to: id.observed.to,
  totalMinor: id.observed.totalMinor, currency: safeEnum("currency", id.observed.currency), status: safeEnum("reservationStatus", id.observed.status), bookingRefMatches: id.observed.bookingRef === TARGET.ref }) : null;
const envelopeEnum = (env) => (env.ok ? "success" : safeCode(env.code));

/** one bounded AbortSignal per call (per-call deadline ∧ overall deadline); returns { signal, release } */
function callDeadline(timers, perMs, deadlineAt, clock) {
  const ac = new AbortController();
  const left = deadlineAt - clock();
  const ms = Math.max(0, Math.min(perMs, left));
  const t = timers.setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, release: () => timers.clearTimeout(t) };
}

/**
 * runProbe({ tooling, exchange, credential, clock?, timers?, clientSnapshotId?, budgets? }) → frozen allowlisted result.
 * `exchange(req)` is the accepted real exchange (or a fake in tests) and `credential()` the same seam the accepted transport takes. Never throws
 * for provider / shape / transport reasons (returns a stop code); every timer it sets is cleared before it returns.
 */
export async function runProbe({ tooling, exchange, credential, clock = () => Date.now(), timers = globalThis, clientSnapshotId = "c17-probe", budgets = BUDGETS } = {}) {
  const state = { attempted: 0, sent: 0, urls: [], guardRefusals: [] };
  const started = clock(); const deadlineAt = started + budgets.totalMs;
  const base = { schema: "e7-charge-list-probe-result-v2", probeVersion: PROBE_VERSION, toolingCommit: TOOLING_COMMIT, target: TARGET, config: CONFIG, budgets: freeze({ ...budgets }), clientSnapshotId };
  const done = (stop, extra = {}) => freeze({ ...base, ...extra, stop, calls: state.sent, attempted: state.attempted, urls: freeze([...state.urls]), guardRefusals: freeze([...state.guardRefusals]), elapsedMs: clock() - started });
  if (!tooling || typeof exchange !== "function" || typeof credential !== "function") return done("TRANSPORT_INVALID");
  const tr = tooling.createE7HostawaySend({ exchange: guardedExchange(exchange, state), credential, maxBytes: budgets.maxBytes });
  if (!tr || tr.ok !== true) return done("TRANSPORT_INVALID", { transportCode: safeCode(tr && tr.code) });
  const send = tr.transport.send;
  const call = async (request) => {
    if (clock() >= deadlineAt) throw Object.assign(new Error("DEADLINE"), { code: "ABORTED" });
    const d = callDeadline(timers, budgets.callMs, deadlineAt, clock);
    try { return await send(request, { signal: d.signal }); } finally { d.release(); }
  };
  // (1) identity: ONE GET /v1/reservations/<R>
  let idReply; const t1 = clock();
  try { idReply = await call({ method: "GET", path: `/v1/reservations/${TARGET.reservationId}`, query: {} }); }
  catch (e) { return done(state.guardRefusals.length ? "GUARD_REFUSED" : clock() >= deadlineAt ? "DEADLINE" : "IDENTITY_TRANSPORT_ERROR", { transportCode: errCode(e) }); }
  const identity = tooling.assessIdentitySnapshot({ snapshot: { accountRef: CONFIG.accountRef, clientSnapshotId, httpStatus: idReply.httpStatus, json: idReply.json, observedAt: t1 }, intent: { ...TARGET }, config: { ...CONFIG }, now: clock() });
  const identityOut = freeze({ httpStatus: idReply.httpStatus, envelope: envelopeEnum(tooling.unwrapEnvelope(idReply.json)), ok: identity.ok === true, code: identity.ok ? null : safeCode(identity.code), reservation: reservationSummary(identity) });
  if (!identity.ok) return done("IDENTITY_REFUSED", { identity: identityOut });
  // (2) list: at most ONE GET /v1/guestPayments/charges?limit=500&reservationIds=<R>
  let lsReply; const t2 = clock();
  try { lsReply = await call({ method: "GET", path: "/v1/guestPayments/charges", query: { limit: LIST_LIMIT, reservationId: TARGET.reservationId } }); }
  catch (e) { return done(state.guardRefusals.length ? "GUARD_REFUSED" : clock() >= deadlineAt ? "DEADLINE" : "LIST_TRANSPORT_ERROR", { identity: identityOut, transportCode: errCode(e) }); }
  const env2 = tooling.unwrapEnvelope(lsReply.json);
  const rawCount = isObj(lsReply.json) && Number.isSafeInteger(lsReply.json.count) ? lsReply.json.count : null;
  const pg = isObj(lsReply.json) ? freeze({ offset: hasOwn(lsReply.json, "offset") ? (lsReply.json.offset === null ? "null" : typeof lsReply.json.offset === "number" ? lsReply.json.offset : "UNKNOWN") : "absent",
    limit: hasOwn(lsReply.json, "limit") ? (lsReply.json.limit === null ? "null" : typeof lsReply.json.limit === "number" ? lsReply.json.limit : "UNKNOWN") : "absent",
    continuationKeys: freeze(CONTINUATION_KEYS.filter((k) => hasOwn(lsReply.json, k))) }) : freeze({ offset: "UNKNOWN", limit: "UNKNOWN", continuationKeys: freeze([]) });
  const listBase = { httpStatus: lsReply.httpStatus, envelope: envelopeEnum(env2), count: rawCount, pagination: pg };
  const list = tooling.assessChargeList({ read: { accountRef: CONFIG.accountRef, clientSnapshotId, httpStatus: lsReply.httpStatus, json: lsReply.json, observedAt: t2,
    request: { limit: LIST_LIMIT, reservationId: TARGET.reservationId } }, intent: { ...TARGET }, config: { ...CONFIG }, now: clock() });
  if (!list.ok) return done("LIST_REFUSED", { identity: identityOut, list: freeze({ ...listBase, ok: false, code: safeCode(list.code) }) });
  const pr = paginationRefusal(lsReply.json, list.count);
  if (pr) return done(PAGINATION_STOP[pr], { identity: identityOut, list: freeze({ ...listBase, ok: false, code: pr }) });
  const obs = tooling.preflightListObservation({ list, intent: { ...TARGET }, config: { ...CONFIG } });
  if (obs.ok === false) return done("LIST_OBSERVATION_REFUSED", { identity: identityOut, list: freeze({ ...listBase, ok: false, code: safeCode(obs.code) }) });
  const rows = freeze(list.rows.map((r) => freeze({ chargeId: r.chargeId, type: safeEnum("chargeType", r.type), status: safeEnum("chargeStatus", r.status), amountMinor: r.amountMinor,
    currency: safeEnum("currency", r.currency), paymentProvider: safeEnum("paymentProvider", r.paymentProvider), paymentMethod: safeEnum("paymentMethod", r.paymentMethod) })));
  const unknownValues = rows.reduce((n, r) => n + ["type", "status", "currency", "paymentProvider", "paymentMethod"].filter((k) => r[k] === "UNKNOWN").length, 0)
    + (identityOut.reservation.currency === "UNKNOWN" ? 1 : 0) + (identityOut.reservation.status === "UNKNOWN" ? 1 : 0);
  const typesSeen = freeze([...new Set(rows.map((r) => r.type))].sort());
  const listOut = freeze({ ...listBase, ok: true, code: null, rowCount: list.count, typesSeen, matchingChargeCount: obs.matchingChargeCount, matchingChargeIds: obs.matchingChargeIds,
    sameAmountPaidCount: obs.sameAmountPaidCount, lookalikeCount: obs.lookalikeCount, unknownValues, rows });
  return done(null, { identity: identityOut, list: listOut, outcome: unknownValues === 0 ? "SHAPE_COMPATIBLE" : "SHAPE_COMPATIBLE_WITH_UNKNOWN_VALUES",
    note: "LIST read shape accepted by the recording proofs (count-only observation); proves nothing about POST availability; UNKNOWN = a provider value outside the approved enums" });
}

/** stdout line: built ONLY from the sanitized result (enums / codes / numbers); no provider text can reach it */
export function formatResult(r) {
  const id = r.identity ? `${r.identity.httpStatus}/${r.identity.envelope}/${r.identity.ok ? `ok status=${r.identity.reservation.status} currency=${r.identity.reservation.currency}` : r.identity.code}` : "-";
  const ls = r.list ? `${r.list.httpStatus}/${r.list.envelope}/${r.list.ok ? `ok count=${r.list.rowCount} types=${JSON.stringify(r.list.typesSeen)} matching=${r.list.matchingChargeCount} unknown=${r.list.unknownValues} offset=${r.list.pagination.offset} limit=${r.list.pagination.limit}` : r.list.code}` : "-";
  return `${r.schema} stop=${r.stop ?? "-"} outcome=${r.outcome ?? "-"} calls=${r.calls} urls=${JSON.stringify(r.urls)} identity=${id} list=${ls} transport=${r.transportCode ?? "-"} guard=${JSON.stringify(r.guardRefusals)} elapsedMs=${r.elapsedMs}\n`;
}

// Inert on import. The probe mode is DRAFT: not wired to any workflow; it needs the SAME injection the recording runner's execute step uses
// (E7_TOOLING_DIR = pinned checkout; the Hostaway token from the environment secret, never printed). `--dry` prints the plan with ZERO network.
if (import.meta.main === true) {
  const mode = process.argv[2] ?? "--dry";
  if (mode === "--dry") {
    process.stdout.write(`${PROBE_VERSION} DRY: tooling ${TOOLING_COMMIT} (${Object.keys(MANIFEST).length}-file pinned closure); calls: ${ALLOWED.map((a) => `${a.method} ${a.path}`).join(" | ")} (list query limit=${LIST_LIMIT}&reservationIds=${TARGET.reservationId}); budgets ${JSON.stringify(BUDGETS)}; no network\n`);
  } else if (mode === "--probe") {
    const dir = process.env.E7_TOOLING_DIR; const token = process.env.E7_HOSTAWAY_TOKEN;
    if (!dir || !token) { process.stdout.write(`${PROBE_VERSION} REFUSED: E7_TOOLING_DIR and E7_HOSTAWAY_TOKEN required (execute-step injection only)\n`); process.exitCode = 2; }
    else {
      const lt = await loadTooling(dir);
      if (!lt.ok) { process.stdout.write(`${PROBE_VERSION} REFUSED: ${safeCode(lt.code)} ${lt.file ?? ""}\n`); process.exitCode = 2; }
      else {
        const rx = lt.tooling.createE7RealExchange({ provider: "hostaway" });            // the ACCEPTED pinned real exchange; the ONLY network primitive
        if (!rx.ok) { process.stdout.write(`${PROBE_VERSION} REFUSED: ${safeCode(rx.code)}\n`); process.exitCode = 2; }
        else {
          const r = await runProbe({ tooling: lt.tooling, exchange: rx.exchange, credential: () => token, clientSnapshotId: `c17-${Date.now()}` });
          process.stdout.write(formatResult(r)); process.exitCode = r.stop === null ? 0 : 1;
        }
      }
    }
  } else { process.stdout.write(`${PROBE_VERSION} usage: --dry | --probe\n`); process.exitCode = 2; }
}
