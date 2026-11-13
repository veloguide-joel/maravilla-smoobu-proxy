// scripts/e7-hosted-charge-list-probe.mjs — C17: READ-ONLY Hostaway charge-LIST SHAPE PROBE for the ONE approved TEST target, before any
// recording POST ever happens. OFFLINE DRAFT: no workflow, no dispatch, no credential or network here (`import.meta.main` guard; the probe mode
// below is NOT wired to any workflow and must only be run by ROOT under the existing environment gate, with the Hostaway secret injected the
// same way the recording runner injects it).
//
// What it does (and ALL it does): exactly ONE GET /v1/reservations/71700931 (accepted transport form H2), and — ONLY if the accepted identity
// proof binds listing / stay / ref / direct channel / total / active status — at most ONE GET /v1/guestPayments/charges?limit=500&reservationIds=71700931
// (accepted form H8, the exact selector the recording worker uses). Both replies go through the ACCEPTED pure proofs from the pinned tooling
// (offline-charge-proof.js assessIdentitySnapshot / assessChargeList / preflightListObservation — the observation returns a branded count object
// without an ok flag; only an explicit { ok:false } is a refusal; hostaway-reservations.js envelope + normalizer),
// reused UNCHANGED. The result is an ALLOWLISTED summary (ids / statuses / amounts / counts / envelope compatibility / refusal codes). Never raw
// bodies, headers, tokens, guest fields.
//
// Fail-closed: any non-GET, other host, other path / reservation, redirect (the transport refuses 3xx itself), non-200, fail / malformed
// envelope, filter or pagination ambiguity (a FULL page of 500 is ambiguous), unexpected status / shape, transport error → the probe STOPS with
// a code; it never retries, never widens the search, never calls anything else. A third call is impossible (hard budget 2).
//
// Reused seams (unchanged): tooling.createE7HostawaySend({ exchange, credential }) and the pure proofs. No executor-adapter phase is created
// (that object would expose createOfflineCharge); no DB, worker, repo, record / cancel / refund / notify module is imported or reachable.
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const freeze = Object.freeze;
export const PROBE_VERSION = "e7-hosted-charge-list-probe-v1";
/** the recording runner's tooling pin (Slice 4 closure); the three modules this probe imports, digest-pinned */
export const TOOLING_COMMIT = "5a094b16c1f84690a738a98ab89140caa69c1e1f";
export const PINNED_FILES = freeze({
  "lib/checkout/offline-charge-proof.js": "2469ee967c00efc09d301a0928e56c360bce3d488cd5dbda6ec6467295761902",
  "lib/hostaway-reservations.js": "d86827cc0f8dee8a02886ef11fcadc12c0a98128607d5399f55d719a9f16e608",
  "scripts/e7-connected/http-transports.mjs": "2c41847fd44ef2002d05bbd1cdb972436278957daf89d172fdefdaf6178568d8"
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
export const ALLOWED = freeze([freeze({ method: "GET", path: `/v1/reservations/${TARGET.reservationId}` }), freeze({ method: "GET", path: "/v1/guestPayments/charges" })]);
export const HOSTAWAY_ORIGIN = "https://api.hostaway.com";
export const STOP_CODES = freeze(["TOOLING_INVALID", "TOOLING_DIGEST_MISMATCH", "TRANSPORT_INVALID", "CALL_BUDGET", "IDENTITY_TRANSPORT_ERROR", "IDENTITY_REFUSED",
  "LIST_TRANSPORT_ERROR", "LIST_REFUSED", "LIST_PAGE_FULL_AMBIGUOUS", "LIST_PAGINATION_FIELDS_AMBIGUOUS", "LIST_OBSERVATION_REFUSED", "GUARD_REFUSED"]);

const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/** verify the three pinned modules by digest, then import them (fail closed on any drift) */
export async function loadTooling(dir, deps = {}) {
  const read = deps.readFile ?? readFile; const imp = deps.importModule ?? ((p) => import(pathToFileURL(p).href));
  let root; try { root = await realpath(dir); } catch { return freeze({ ok: false, code: "TOOLING_INVALID" }); }
  const digests = {};
  for (const [rel, want] of Object.entries(PINNED_FILES)) {
    let bytes; try { bytes = await read(`${root}/${rel}`); } catch { return freeze({ ok: false, code: "TOOLING_INVALID", file: rel }); }
    const got = sha256(bytes); digests[rel] = got;
    if (got !== want) return freeze({ ok: false, code: "TOOLING_DIGEST_MISMATCH", file: rel });
  }
  try {
    const [T, OP, HR] = await Promise.all([imp(`${root}/scripts/e7-connected/http-transports.mjs`), imp(`${root}/lib/checkout/offline-charge-proof.js`), imp(`${root}/lib/hostaway-reservations.js`)]);
    for (const [m, k] of [[T, "createE7HostawaySend"], [OP, "assessIdentitySnapshot"], [OP, "assessChargeList"], [OP, "preflightListObservation"], [HR, "unwrapEnvelope"]])
      if (typeof m[k] !== "function") return freeze({ ok: false, code: "TOOLING_INVALID", missing: k });
    if (OP.LIST_LIMIT !== LIST_LIMIT || T.CHARGE_LIST_LIMIT !== LIST_LIMIT) return freeze({ ok: false, code: "TOOLING_INVALID", missing: "LIST_LIMIT" });
    return freeze({ ok: true, tooling: freeze({ createE7HostawaySend: T.createE7HostawaySend, assessIdentitySnapshot: OP.assessIdentitySnapshot, assessChargeList: OP.assessChargeList,
      preflightListObservation: OP.preflightListObservation, unwrapEnvelope: HR.unwrapEnvelope }), digests: freeze(digests) });
  } catch { return freeze({ ok: false, code: "TOOLING_INVALID" }); }
}

/** the probe's OWN exchange guard in front of the injected exchange: GET only, this origin only, the two allowed URLs only, hard call budget, NO retry */
export function guardedExchange(exchange, state) {
  return async (req) => {
    state.attempted += 1;
    if (!isObj(req) || req.method !== "GET" || typeof req.url !== "string") { state.guardRefusals.push("NOT_GET"); throw new Error("GUARD_REFUSED"); }
    const u = new URL(req.url);
    if (u.origin !== HOSTAWAY_ORIGIN) { state.guardRefusals.push("ORIGIN"); throw new Error("GUARD_REFUSED"); }
    const allowed = ALLOWED.find((a) => a.path === u.pathname);
    if (!allowed) { state.guardRefusals.push("PATH"); throw new Error("GUARD_REFUSED"); }
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

const reservationSummary = (id) => id && id.ok ? freeze({ reservationId: id.observed.reservationId, listingId: id.observed.listingId, channelId: id.observed.channelId, from: id.observed.from, to: id.observed.to,
  totalMinor: id.observed.totalMinor, currency: id.observed.currency, status: id.observed.status, bookingRefMatches: id.observed.bookingRef === TARGET.ref }) : null;

/**
 * runProbe({ tooling, exchange, credential, clock?, clientSnapshotId }) → frozen allowlisted result. `exchange(req)` and `credential()` are the
 * SAME seams the accepted transport takes; nothing else is read. Never throws for provider / shape reasons (returns a stop code).
 */
export async function runProbe({ tooling, exchange, credential, clock = () => Date.now(), clientSnapshotId = "c17-probe", signal = null } = {}) {
  const callOpts = { signal: signal ?? new AbortController().signal };   // the accepted transport requires an explicit { signal }
  const state = { attempted: 0, sent: 0, urls: [], guardRefusals: [] };
  const base = { schema: "e7-charge-list-probe-result-v1", probeVersion: PROBE_VERSION, toolingCommit: TOOLING_COMMIT, target: TARGET, config: { ...CONFIG }, clientSnapshotId };
  const done = (stop, extra = {}) => freeze({ ...base, ...extra, stop, calls: state.sent, attempted: state.attempted, urls: freeze([...state.urls]), guardRefusals: freeze([...state.guardRefusals]) });
  if (!tooling || typeof exchange !== "function" || typeof credential !== "function") return done("TRANSPORT_INVALID");
  const tr = tooling.createE7HostawaySend({ exchange: guardedExchange(exchange, state), credential });
  if (!tr || tr.ok !== true) return done("TRANSPORT_INVALID", { transportCode: tr && tr.code });
  const send = tr.transport.send;
  // (1) identity: ONE GET /v1/reservations/<R>
  let idReply; const t1 = clock();
  try { idReply = await send({ method: "GET", path: `/v1/reservations/${TARGET.reservationId}`, query: {} }, callOpts); }
  catch (e) { return done(state.guardRefusals.length ? "GUARD_REFUSED" : "IDENTITY_TRANSPORT_ERROR", { transportCode: String(e && e.code ? e.code : e && e.message ? e.message : "ERROR") }); }
  const idSnap = { accountRef: CONFIG.accountRef, clientSnapshotId, httpStatus: idReply.httpStatus, json: idReply.json, observedAt: t1 };
  const identity = tooling.assessIdentitySnapshot({ snapshot: idSnap, intent: { ...TARGET }, config: { ...CONFIG }, now: clock() });
  const env1 = tooling.unwrapEnvelope(idReply.json);
  const identityOut = freeze({ httpStatus: idReply.httpStatus, envelope: env1.ok ? "success" : env1.code, ok: identity.ok === true, code: identity.ok ? null : identity.code, reservation: reservationSummary(identity) });
  if (!identity.ok) return done("IDENTITY_REFUSED", { identity: identityOut });
  // (2) list: at most ONE GET /v1/guestPayments/charges?limit=500&reservationIds=<R>
  let lsReply; const t2 = clock();
  try { lsReply = await send({ method: "GET", path: "/v1/guestPayments/charges", query: { limit: LIST_LIMIT, reservationId: TARGET.reservationId } }, callOpts); }
  catch (e) { return done(state.guardRefusals.length ? "GUARD_REFUSED" : "LIST_TRANSPORT_ERROR", { identity: identityOut, transportCode: String(e && e.code ? e.code : e && e.message ? e.message : "ERROR") }); }
  const env2 = tooling.unwrapEnvelope(lsReply.json);
  const rawCount = isObj(lsReply.json) && Number.isSafeInteger(lsReply.json.count) ? lsReply.json.count : null;
  const pageFields = isObj(lsReply.json) ? ["limit", "offset", "page", "nextPage", "hasMore"].filter((k) => Object.prototype.hasOwnProperty.call(lsReply.json, k)) : [];
  const listBase = { httpStatus: lsReply.httpStatus, envelope: env2.ok ? "success" : env2.code, count: rawCount, paginationFields: freeze(pageFields) };
  const list = tooling.assessChargeList({ read: { accountRef: CONFIG.accountRef, clientSnapshotId, httpStatus: lsReply.httpStatus, json: lsReply.json, observedAt: t2,
    request: { limit: LIST_LIMIT, reservationId: TARGET.reservationId } }, intent: { ...TARGET }, config: { ...CONFIG }, now: clock() });
  if (!list.ok) return done("LIST_REFUSED", { identity: identityOut, list: freeze({ ...listBase, ok: false, code: list.code }) });
  if (list.count >= LIST_LIMIT) return done("LIST_PAGE_FULL_AMBIGUOUS", { identity: identityOut, list: freeze({ ...listBase, ok: false, code: "PAGE_FULL" }) });
  if (pageFields.some((k) => ["nextPage", "hasMore"].includes(k) && lsReply.json[k])) return done("LIST_PAGINATION_FIELDS_AMBIGUOUS", { identity: identityOut, list: freeze({ ...listBase, ok: false, code: "MORE_PAGES_SIGNALLED" }) });
  const obs = tooling.preflightListObservation({ list, intent: { ...TARGET }, config: { ...CONFIG } });
  if (obs.ok === false) return done("LIST_OBSERVATION_REFUSED", { identity: identityOut, list: freeze({ ...listBase, ok: false, code: obs.code }) });
  const typesSeen = freeze([...new Set(list.rows.map((r) => r.type))].sort());
  const listOut = freeze({ ...listBase, ok: true, code: null, rowCount: list.count, typesSeen, matchingChargeCount: obs.matchingChargeCount, matchingChargeIds: obs.matchingChargeIds,
    sameAmountPaidCount: obs.sameAmountPaidCount, lookalikeCount: obs.lookalikeCount, rows: freeze(list.rows.map((r) => freeze({ chargeId: r.chargeId, type: r.type, status: r.status, amountMinor: r.amountMinor, currency: r.currency, paymentProvider: r.paymentProvider, paymentMethod: r.paymentMethod }))) });
  return done(null, { identity: identityOut, list: listOut, outcome: "SHAPE_COMPATIBLE", note: "LIST shape accepted by the recording proofs; this proves nothing about POST availability" });
}

/** stdout line: allowlisted summary only */
export function formatResult(r) {
  return `${r.schema} stop=${r.stop ?? "-"} outcome=${r.outcome ?? "-"} calls=${r.calls} urls=${JSON.stringify(r.urls)} identity=${r.identity ? `${r.identity.httpStatus}/${r.identity.envelope}/${r.identity.ok ? "ok" : r.identity.code}` : "-"}`
    + ` list=${r.list ? `${r.list.httpStatus}/${r.list.envelope}/${r.list.ok ? `ok count=${r.list.rowCount} types=${JSON.stringify(r.list.typesSeen)} matching=${r.list.matchingChargeCount}` : r.list.code}` : "-"} guard=${JSON.stringify(r.guardRefusals)}\n`;
}

// Inert on import. The probe mode is DRAFT: not wired to any workflow; it would need the SAME injection the recording runner's execute step uses
// (E7_TOOLING_DIR = pinned checkout; the Hostaway token from the environment secret, never printed). `--dry` prints the plan with ZERO network.
if (import.meta.main === true) {
  const mode = process.argv[2] ?? "--dry";
  if (mode === "--dry") {
    process.stdout.write(`${PROBE_VERSION} DRY: tooling ${TOOLING_COMMIT}; calls: ${ALLOWED.map((a) => `${a.method} ${a.path}`).join(" | ")} (list query limit=${LIST_LIMIT}&reservationIds=${TARGET.reservationId}); max ${MAX_CALLS} calls; no network\n`);
  } else if (mode === "--probe") {
    const dir = process.env.E7_TOOLING_DIR; const token = process.env.E7_HOSTAWAY_TOKEN;
    if (!dir || !token) { process.stdout.write(`${PROBE_VERSION} REFUSED: E7_TOOLING_DIR and E7_HOSTAWAY_TOKEN required (execute-step injection only)\n`); process.exitCode = 2; }
    else {
      const lt = await loadTooling(dir);
      if (!lt.ok) { process.stdout.write(`${PROBE_VERSION} REFUSED: ${lt.code} ${lt.file ?? ""}\n`); process.exitCode = 2; }
      else {
        const exchange = async (req) => {                             // the ONLY network primitive, GET-only by the guard; no redirect follow; one attempt
          const res = await fetch(req.url, { method: "GET", headers: req.headers, redirect: "manual", signal: req.signal });
          return { status: res.status, contentType: res.headers.get("content-type") ?? "", bytes: new Uint8Array(await res.arrayBuffer()) };
        };
        const r = await runProbe({ tooling: lt.tooling, exchange, credential: () => token, clientSnapshotId: `c17-${Date.now()}` });
        process.stdout.write(formatResult(r)); process.exitCode = r.stop === null ? 0 : 1;
      }
    }
  } else { process.stdout.write(`${PROBE_VERSION} usage: --dry | --probe\n`); process.exitCode = 2; }
}
