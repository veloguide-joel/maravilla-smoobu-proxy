// scripts/e7-resend-sink-probe.mjs — C42: Resend SYNTHETIC SINK-SEND TRANSPORT PROBE. Proves ONE provider POST shape before any real guest
// send is integrated. HONEST LABEL: a SYNTHETIC transport probe — NOT a booking notification, NOT a recipient rewrite of a gn-v2 worker request,
// NOT proof that any real inbox received mail. The gn-v2 builder / notification worker / SQL fences are NOT imported, changed or wired to Resend.
//
// What it sends (and ALL it can send), per reviewed dispatch: exactly ONE POST https://api.resend.com/emails with the JSON body
//   {"from":"maraVilla TEST <onboarding@resend.dev>","to":["delivered@resend.dev"],"subject":<bcc-v1 subject>,"text":<bcc-v1 text>}
// — sender and recipient FIXED (the recipient is Resend's documented delivery-simulation sink, an exact singleton: no caller / address override,
// no +label, no CC / BCC / reply-to / HTML / attachments / tags / headers / scheduling / template). The subject / text are the ACCEPTED bilingual
// booking-confirmation copy (renderBookingConfirmation, contract bcc-v1) loaded from the IMMUTABLE tooling commit f05016a7 and fed FIXED SYNTHETIC
// facts (ref MV-SINKPROBE, 2030 dates, USD 123.45 = 12345 minor) that match no real intent / reservation. The explicit locale en | es is the ONLY
// content choice.
//
// Official docs read for this file (C42, 2026-11-14): Send Email (POST /emails, Bearer auth, from / to / subject required, text optional string,
// response {"id": UUID}, Idempotency-Key header: unique per request, expires after 24 h, max 256 chars), API introduction (200 = successful request;
// a User-Agent header is REQUIRED — requests without one are rejected with 403), Idempotency Keys (same key + same payload within 24 h → the
// original response, `idempotent-replayed: true`; different payload or concurrent → 409; failed requests not stored), Send Test Emails
// (delivered@resend.dev simulates delivery; counts against quota; labels exist but are NOT used here).
//
// Guarantees: inert on import; --dry / --preflight make ZERO network calls and never read the key; the run attempt must be exactly 1 and the
// expected plan hash must match BEFORE the key is read; the plan (route / body / header grammar) is validated BEFORE the exchange; ONE attempt,
// no retry of any kind, redirects refused, any non-200 / ambiguous / malformed outcome is a code-only UNKNOWN STOP with NO second send. The
// Idempotency-Key is stable per (plan hash, GitHub run id, attempt 1): it guards duplicate delivery of THIS dispatch's single request for the
// provider's 24 h window only — it does NOT dedupe workflow reruns (refused instead) or future dispatches. The key and Authorization are never
// returned or printed; no exception message, subject, body, recipient or raw provider text reaches the output.
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve as resolvePath, dirname, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { createResendExchange, RESEND_HOST, RESEND_PATH, RESEND_METHOD, EXCHANGE_BUDGETS, EXCHANGE_CODES } from "./e7-resend/resend-exchange.mjs";

const freeze = Object.freeze;
export const PROBE_VERSION = "e7-resend-sink-probe-v1";
/** IMMUTABLE tooling commit carrying the accepted bcc-v1 copy (e7-test merge of #110) */
export const TOOLING_COMMIT = "f05016a7af3f866e7e4d46d219a3b95934ca867c";
/** the ONE import root; MANIFEST = its complete transitive relative-import closure at the pin (scanned independently; + node:crypto only) */
export const ROOTS = freeze(["lib/checkout/booking-confirmation-copy.js"]);
export const MANIFEST = freeze({
  "lib/checkout/booking-confirmation-copy.js": "b393f9b60098c002db3e1d0fcc2966bf52aede4c0a337c9c64bdfe3a9304ef91",
  "lib/checkout/guest-notification.js": "0bea6251a70fe7d47cd1175effd63815d65f905a6ee20bc5311a93eba518251c"
});
export const BUILTIN_IMPORTS = freeze(["node:crypto"]);
export const SENDER = "maraVilla TEST <onboarding@resend.dev>";
export const RECIPIENTS = freeze(["delivered@resend.dev"]);
export const LOCALES = freeze(["en", "es"]);
/** FIXED SYNTHETIC facts — no real intent / reservation / booking ref (≠ MV-8L79DEJ7, MV-5RBRW6CM) */
export const SYNTHETIC_FACTS = freeze({ ref: "MV-SINKPROBE", checkIn: "2030-01-14", checkOut: "2030-01-16", nights: 2, guests: 2, totalMinor: 12345, currency: "USD" });
export const USER_AGENT = "maravilla-e7-resend-sink-probe/1";
export const BODY_KEYS = freeze(["from", "to", "subject", "text"]);
/** exact request header names, in send order (values: Authorization / Idempotency-Key are filled at send time and never part of the plan) */
export const HEADER_NAMES = freeze(["Authorization", "Content-Type", "Content-Length", "User-Agent", "Idempotency-Key", "Accept", "Accept-Encoding"]);
export const BUDGETS = EXCHANGE_BUDGETS;
export const OUTCOMES = freeze(["PROVIDER_ACCEPTED", "PROVIDER_ACCEPTED_REPLAY", "UNKNOWN_STOP", "REFUSED_BEFORE_NETWORK"]);
export const PROBE_CODES = freeze(["TOOLING_INVALID", "TOOLING_CLOSURE_MISMATCH", "TOOLING_BUILTIN_MISMATCH", "LOCALE_INVALID", "COPY_REFUSED", "PLAN_INVALID",
  "PLAN_HASH_MISMATCH", "PLAN_HASH_INVALID", "RUN_ID_INVALID", "RUN_ATTEMPT_NOT_1", "KEY_INVALID", "INPUT_INVALID", "GUARD_REFUSED", "HTTP_STATUS",
  "REPLY_CONTENT_TYPE", "REPLY_JSON_INVALID", "REPLY_SHAPE", "REPLY_ID_INVALID", "REPLAY_HEADER_INVALID"]);
const CODE_SET = new Set([...PROBE_CODES, ...EXCHANGE_CODES]);
export const safeCode = (c) => (typeof c === "string" && CODE_SET.has(c) ? c : "UNKNOWN_CODE");

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const HEX64 = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RUN_ID_RE = /^[1-9][0-9]{0,19}$/;
const KEY_RE = /^re_[\x21-\x7E]{8,256}$/;                          // visible ASCII, no whitespace / CR / LF (the docs' format is re_…)
const IMPORT_RE = /^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"|^\s*import\s+"([^"]+)"/gm;

// ---------------------------------------------------------------------------------------------
// pinned copy closure (static scan BEFORE import; zero import on any drift)

/** scan the transitive import closure of ROOTS: relative files (sha256) + bare / builtin specifiers seen */
export async function scanClosure(root, deps = {}) {
  const read = deps.readFile ?? readFile;
  const files = {}; const builtins = new Set(); const queue = [...ROOTS];
  while (queue.length) {
    const rel = queue.shift();
    if (hasOwn(files, rel)) continue;
    let bytes; try { bytes = await read(`${root}/${rel}`); } catch { return freeze({ ok: false, code: "TOOLING_INVALID", file: rel }); }
    files[rel] = sha256(bytes);
    for (const m of Buffer.from(bytes).toString("utf8").matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2];
      if (spec.startsWith("./") || spec.startsWith("../")) queue.push(relative(root, resolvePath(dirname(`${root}/${rel}`), spec)));
      else builtins.add(spec);
    }
  }
  return freeze({ ok: true, files: freeze(files), builtins: freeze([...builtins].sort()) });
}

/** verify the EXACT pinned closure (file set + digests + builtin set) BEFORE importing the copy module */
export async function loadTooling(dir, deps = {}) {
  const imp = deps.importModule ?? ((p) => import(pathToFileURL(p).href));
  let root; try { root = await realpath(dir); } catch { return freeze({ ok: false, code: "TOOLING_INVALID" }); }
  const scan = await scanClosure(root, deps);
  if (!scan.ok) return scan;
  const got = Object.keys(scan.files).sort(); const want = Object.keys(MANIFEST).sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) return freeze({ ok: false, code: "TOOLING_CLOSURE_MISMATCH", file: got.find((f) => !hasOwn(MANIFEST, f)) ?? want.find((f) => !hasOwn(scan.files, f)) ?? null });
  for (const f of want) if (scan.files[f] !== MANIFEST[f]) return freeze({ ok: false, code: "TOOLING_CLOSURE_MISMATCH", file: f });
  if (JSON.stringify(scan.builtins) !== JSON.stringify([...BUILTIN_IMPORTS])) return freeze({ ok: false, code: "TOOLING_BUILTIN_MISMATCH" });
  try {
    const m = await imp(`${root}/${ROOTS[0]}`);
    if (typeof m.renderBookingConfirmation !== "function" || m.COPY_CONTRACT_VERSION !== "bcc-v1") return freeze({ ok: false, code: "TOOLING_INVALID" });
    return freeze({ ok: true, render: m.renderBookingConfirmation, copyContractVersion: m.COPY_CONTRACT_VERSION, manifest: scan.files });
  } catch { return freeze({ ok: false, code: "TOOLING_INVALID" }); }
}

// ---------------------------------------------------------------------------------------------
// the plan (pure, deterministic, run-independent): route, exact body bytes, header grammar, hashes

/** buildPlan({ render, locale }) → { ok:true, plan } | { ok:false, code }. The plan carries the body BYTES (needed to send) and its hashes. */
export function buildPlan({ render, locale } = {}) {
  if (!LOCALES.includes(locale)) return freeze({ ok: false, code: "LOCALE_INVALID" });
  if (typeof render !== "function") return freeze({ ok: false, code: "TOOLING_INVALID" });
  let c; try { c = render({ template: "booking_confirmed", locale, facts: { ...SYNTHETIC_FACTS } }); } catch { return freeze({ ok: false, code: "COPY_REFUSED" }); }
  if (!c || c.ok !== true || c.copy?.contractVersion !== "bcc-v1" || c.copy.locale !== locale || typeof c.copy.subject !== "string" || typeof c.copy.text !== "string") {
    return freeze({ ok: false, code: "COPY_REFUSED" });
  }
  const json = JSON.stringify({ from: SENDER, to: [...RECIPIENTS], subject: c.copy.subject, text: c.copy.text });
  const body = Buffer.from(json, "utf8");
  const bodyHash = sha256(body);
  const fixedHeaders = freeze({ "Content-Type": "application/json", "Content-Length": String(body.length), "User-Agent": USER_AGENT, Accept: "application/json", "Accept-Encoding": "identity" });
  const descriptor = { schema: "e7-resend-sink-plan-v1", probeVersion: PROBE_VERSION, toolingCommit: TOOLING_COMMIT, manifest: MANIFEST, builtins: BUILTIN_IMPORTS,
    copyContractVersion: "bcc-v1", locale, method: RESEND_METHOD, host: RESEND_HOST, path: RESEND_PATH, headerNames: HEADER_NAMES, fixedHeaders, bodyKeys: BODY_KEYS,
    sender: SENDER, recipients: RECIPIENTS, syntheticFacts: SYNTHETIC_FACTS, bodyBytes: body.length, bodyHash, budgets: BUDGETS };
  const planHash = sha256(`${PROBE_VERSION}-plan\n${canonicalJson(descriptor)}`);
  return freeze({ ok: true, plan: freeze({ locale, method: RESEND_METHOD, host: RESEND_HOST, path: RESEND_PATH, body, bodyHash, bodyBytes: body.length, fixedHeaders, planHash }) });
}

/** sorted-key canonical JSON (strings / numbers / arrays / plain objects only) */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  if (typeof v === "string" || (typeof v === "number" && Number.isFinite(v))) return JSON.stringify(v);
  throw new TypeError("canonicalJson: unsupported value");
}

/** stable per (plan hash, GitHub run id, attempt 1); ≤ 256 chars per the docs; NOT a forever / cross-dispatch dedupe */
export const idempotencyKey = (planHash, runId) => `${PROBE_VERSION}/run-${runId}/attempt-1/${planHash}`;

/** the probe's guard in front of the exchange: the request must be EXACTLY the plan's route / headers / body (no third-party input) */
export function guardRequest(req, plan) {
  if (!isObj(req) || !plan) return "GUARD_REFUSED";
  if (JSON.stringify(Object.keys(req).sort()) !== '["body","headers","host","method","path"]') return "GUARD_REFUSED";
  if (req.method !== RESEND_METHOD || req.host !== RESEND_HOST || req.path !== RESEND_PATH) return "GUARD_REFUSED";
  if (!(req.body instanceof Uint8Array) || Buffer.compare(Buffer.from(req.body), plan.body) !== 0 || sha256(req.body) !== plan.bodyHash) return "GUARD_REFUSED";
  let parsed; try { parsed = JSON.parse(Buffer.from(req.body).toString("utf8")); } catch { return "GUARD_REFUSED"; }
  if (!isObj(parsed) || JSON.stringify(Object.keys(parsed)) !== JSON.stringify(BODY_KEYS) || parsed.from !== SENDER || !Array.isArray(parsed.to)
      || JSON.stringify(parsed.to) !== JSON.stringify(RECIPIENTS) || typeof parsed.subject !== "string" || typeof parsed.text !== "string") return "GUARD_REFUSED";
  if (!isObj(req.headers) || JSON.stringify(Object.keys(req.headers)) !== JSON.stringify(HEADER_NAMES)) return "GUARD_REFUSED";
  for (const [k, v] of Object.entries(plan.fixedHeaders)) if (req.headers[k] !== v) return "GUARD_REFUSED";
  if (typeof req.headers.Authorization !== "string" || !/^Bearer re_[\x21-\x7E]{8,256}$/.test(req.headers.Authorization)) return "GUARD_REFUSED";
  if (typeof req.headers["Idempotency-Key"] !== "string" || req.headers["Idempotency-Key"].length > 256 || !req.headers["Idempotency-Key"].endsWith(`/attempt-1/${plan.planHash}`)) return "GUARD_REFUSED";
  return null;
}

/** classify the ONE reply: success ONLY for status 200 + JSON object exactly {"id": <UUID>}; everything else a code (never retried) */
export function classifyReply(reply) {
  if (!isObj(reply) || !Number.isSafeInteger(reply.status)) return freeze({ outcome: "UNKNOWN_STOP", stop: "REPLY_SHAPE", httpStatus: null, emailId: null });
  const status = reply.status;
  if (status !== 200) return freeze({ outcome: "UNKNOWN_STOP", stop: "HTTP_STATUS", httpStatus: status, emailId: null });
  const ct = reply.headers?.contentType;
  if (typeof ct !== "string" || !/^application\/json(\s*;\s*charset=utf-8)?$/i.test(ct.trim())) return freeze({ outcome: "UNKNOWN_STOP", stop: "REPLY_CONTENT_TYPE", httpStatus: status, emailId: null });
  let j; try { j = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reply.body)); } catch { return freeze({ outcome: "UNKNOWN_STOP", stop: "REPLY_JSON_INVALID", httpStatus: status, emailId: null }); }
  if (!isObj(j) || JSON.stringify(Object.keys(j)) !== '["id"]') return freeze({ outcome: "UNKNOWN_STOP", stop: "REPLY_SHAPE", httpStatus: status, emailId: null });
  if (typeof j.id !== "string" || !UUID_RE.test(j.id)) return freeze({ outcome: "UNKNOWN_STOP", stop: "REPLY_ID_INVALID", httpStatus: status, emailId: null });
  const rp = reply.headers?.idempotentReplayed;
  if (rp !== null && rp !== undefined && rp !== "true" && rp !== "false") return freeze({ outcome: "UNKNOWN_STOP", stop: "REPLAY_HEADER_INVALID", httpStatus: status, emailId: null });
  return freeze({ outcome: rp === "true" ? "PROVIDER_ACCEPTED_REPLAY" : "PROVIDER_ACCEPTED", stop: null, httpStatus: status, emailId: j.id });
}

// ---------------------------------------------------------------------------------------------

/** gates that need NO key: run id grammar, run attempt exactly 1, expected plan hash grammar + equality */
export function sendGates({ plan, runId, runAttempt, expectedPlanHash }) {
  if (runAttempt !== "1") return "RUN_ATTEMPT_NOT_1";
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) return "RUN_ID_INVALID";
  if (typeof expectedPlanHash !== "string" || !HEX64.test(expectedPlanHash)) return "PLAN_HASH_INVALID";
  if (expectedPlanHash !== plan.planHash) return "PLAN_HASH_MISMATCH";
  return null;
}

/**
 * runSend({ plan, runId, runAttempt, expectedPlanHash, credential, exchange, clock? }) → frozen sanitized result. Exactly these input keys
 * (anything else → INPUT_INVALID, no exchange). Gates run BEFORE credential() is called; the guard runs BEFORE the exchange; at most ONE
 * exchange call; any throw / non-200 / malformed reply is a code-only UNKNOWN_STOP, never retried.
 */
export async function runSend(input) {
  const t0 = Date.now();
  const base = (plan) => ({ schema: "e7-resend-sink-probe-result-v1", probeVersion: PROBE_VERSION, toolingCommit: TOOLING_COMMIT, label: "SYNTHETIC transport probe (not a booking notification)",
    locale: plan?.locale ?? null, planHash: plan?.planHash ?? null, bodyHash: plan?.bodyHash ?? null });
  const out = (plan, fields) => freeze({ ...base(plan), attempts: 0, httpStatus: null, emailId: null, ...fields, elapsedMs: Date.now() - t0 });
  const keys = isObj(input) ? Object.keys(input).sort() : [];
  const allowed = ["clock", "credential", "exchange", "expectedPlanHash", "plan", "runAttempt", "runId"];
  if (!isObj(input) || keys.some((k) => !allowed.includes(k)) || !input.plan || typeof input.credential !== "function" || typeof input.exchange !== "function") {
    return out(null, { outcome: "REFUSED_BEFORE_NETWORK", stop: "INPUT_INVALID" });
  }
  const { plan, runId, runAttempt, expectedPlanHash, credential, exchange } = input;
  const g = sendGates({ plan, runId, runAttempt, expectedPlanHash });
  if (g) return out(plan, { outcome: "REFUSED_BEFORE_NETWORK", stop: g });
  let token; try { token = credential(); } catch { token = null; }
  if (typeof token !== "string" || !KEY_RE.test(token)) return out(plan, { outcome: "REFUSED_BEFORE_NETWORK", stop: "KEY_INVALID" });
  const req = { method: plan.method, host: plan.host, path: plan.path,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": plan.fixedHeaders["Content-Type"], "Content-Length": plan.fixedHeaders["Content-Length"], "User-Agent": plan.fixedHeaders["User-Agent"],
      "Idempotency-Key": idempotencyKey(plan.planHash, runId), Accept: plan.fixedHeaders.Accept, "Accept-Encoding": plan.fixedHeaders["Accept-Encoding"] },
    body: plan.body };
  token = null;
  const gr = guardRequest(req, plan);
  if (gr) return out(plan, { outcome: "REFUSED_BEFORE_NETWORK", stop: gr });
  let reply;
  try { reply = await exchange(req); }                              // the ONE attempt; a throw is FINAL (no retry, no second send)
  catch (e) { return out(plan, { outcome: "UNKNOWN_STOP", stop: safeCode(e && typeof e === "object" ? e.code : null), attempts: 1 }); }
  const c = classifyReply(reply);
  return out(plan, { ...c, attempts: 1 });
}

/** the ONLY output line: built from the sanitized result (codes / enums / hashes / numbers / an allowlisted UUID) */
export function formatResult(r) {
  return `${r.schema} outcome=${r.outcome} stop=${r.stop ?? "-"} attempts=${r.attempts} httpStatus=${r.httpStatus ?? "-"} emailId=${r.emailId ?? "-"} locale=${r.locale ?? "-"} planHash=${r.planHash ?? "-"} bodyHash=${r.bodyHash ?? "-"} elapsedMs=${r.elapsedMs} note=${r.outcome?.startsWith("PROVIDER_ACCEPTED") ? "provider-accepted-for-the-resend-delivery-simulation-sink;not-real-inbox-proof;not-a-booking-notification" : "-"}\n`;
}
const formatPlan = (p) => `${PROBE_VERSION} PLAN locale=${p.locale} method=${p.method} host=${p.host} path=${p.path} bodyBytes=${p.bodyBytes} bodyHash=${p.bodyHash} planHash=${p.planHash} headers=${HEADER_NAMES.join(",")} budgets=${JSON.stringify(BUDGETS)} tooling=${TOOLING_COMMIT} (${Object.keys(MANIFEST).length}-file closure + ${BUILTIN_IMPORTS.join(",")}) network=none\n`;

// Inert on import. --dry / --preflight: ZERO network and the key is never read. --send: the gates run before the key is read.
if (import.meta.main === true) {
  const mode = process.argv[2] ?? "--dry";
  const say = (s, code) => { process.stdout.write(s); process.exitCode = code; };
  if (!["--dry", "--preflight", "--send"].includes(mode)) say(`${PROBE_VERSION} usage: --dry | --preflight | --send\n`, 2);
  else {
    const lt = await loadTooling(process.env.E7_TOOLING_DIR ?? "");
    if (!lt.ok) say(`${PROBE_VERSION} REFUSED: ${safeCode(lt.code)} ${lt.file ?? ""}\n`, 2);
    else {
      const bp = buildPlan({ render: lt.render, locale: process.env.E7_LOCALE });
      if (!bp.ok) say(`${PROBE_VERSION} REFUSED: ${safeCode(bp.code)}\n`, 2);
      else if (mode === "--dry") say(formatPlan(bp.plan), 0);
      else {
        const g = sendGates({ plan: bp.plan, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, expectedPlanHash: process.env.E7_EXPECTED_PLAN_HASH });
        if (g) say(`${PROBE_VERSION} REFUSED: ${safeCode(g)} (no key read, no network)\n`, 2);
        else if (mode === "--preflight") say(`${PROBE_VERSION} PREFLIGHT ok: ${formatPlan(bp.plan).slice(PROBE_VERSION.length + 1)}`, 0);
        else {
          const rx = createResendExchange();
          if (!rx.ok) say(`${PROBE_VERSION} REFUSED: ${safeCode(rx.code)}\n`, 2);
          else {
            const r = await runSend({ plan: bp.plan, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, expectedPlanHash: process.env.E7_EXPECTED_PLAN_HASH,
              credential: () => process.env.E7_RESEND_TEST_KEY, exchange: rx.exchange });
            say(formatResult(r), r.outcome === "PROVIDER_ACCEPTED" || r.outcome === "PROVIDER_ACCEPTED_REPLAY" ? 0 : 1);
          }
        }
      }
    }
  }
}
