// scripts/e7-connected/run-r1-launcher.mjs — E7 G3b: the native EXECUTION wiring behind run-plan-cli-main.mjs `execute` (contract
// claude/e7-g3b-native-execute.md). Imported ONLY after the CLI verified the native execution closure digest.
//   * Order (each step pure until noted): env evaluation (accepted) → package / plan / source reads + a journal-minted R1 binding
//     (accepted binder; expected package hash / executor digest / freshness / intent) → OWNER file ingress (accepted provider reader, accepted
//     DB login reader, CA file) → pool / transport / exchange CONSTRUCTION (no connect) → creation-only R1 file + head journal → the accepted
//     runReservationAbortR1 (which takes the lock, checks same-DB / TEST / roles, runs the fresh preflight and every fence) → finalize →
//     journal close → pool end → ONE sanitized result.
//   * Nothing secret is placed in any result / error / output; owner values are passed only as capabilities (credential closures, pool configs).
//   * No retry, fallback, adoption, resume or repair. Accepted core / bridge / workers / journals / transports / pool are used unchanged.
import { createHash, randomBytes } from "node:crypto";
import { runReservationAbortR1 } from "./run-core-abort-v2.mjs";
import { bindRunPackageR1Journal, bindingKindV2 } from "./run-journal-memory-v2.mjs";
import { openFileJournalR1 } from "./run-journal-file-v2.mjs";
import { createE7HostawaySend, createE7StripeTestSend } from "./http-transports.mjs";
import { createE7RealExchange } from "./real-exchange.mjs";
import { readProbeCredentialFile } from "./probe-credential-file.mjs";
import { readDbLoginFiles } from "./db-credential-file.mjs";
import { evaluateProbeEnvironment } from "./probe-env-preflight.mjs";
import { RUN_PLAN_CLOSURE, MAX_SOURCE_FILE_BYTES, MAX_SOURCE_TOTAL_BYTES, MAX_PLAN_BYTES } from "./run-plan-v1.mjs";
import { R1_EXECUTOR_CLOSURE, MAX_PACKAGE_BYTES } from "./run-binding-r1.mjs";
import { createBookingPool } from "../../lib/booking-db/pool.js";

export const LAUNCH_RESULT_SCHEMA = "e7-r1-launch-result-v1";
export const MAX_CA_BYTES = 65_536;
export const POOL_MAX = Object.freeze({ app: 4, report: 4 });
export const POOL_END_BOUND_MS = 10_000;
export const EVIDENCE_REF_RE = /^[A-Za-z0-9._:/-]{1,128}$/;              // = the accepted journal's attestation evidenceRef rule
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const freeze = Object.freeze;

/** the ONE sanitized result: whitelisted codes / counts / digests only (no URL, credential, guest, path or provider text) */
function sanitize(r, extra) {
  const pick = (o, ks) => (o && typeof o === "object" ? Object.fromEntries(ks.filter((k) => k in o).map((k) => [k, o[k]])) : null);
  const run = r ? {
    ok: r.ok === true, outcome: r.outcome, stopCode: r.stopCode ?? null, phase: r.phase, manifestHash: r.manifestHash ?? null, connection: r.connection ?? null,
    journalSeq: r.journalSeq ?? null, trustedHead: r.trustedHead ? pick(r.trustedHead, ["seq", "hash"]) : null, journalTail: r.journalTail ?? null,
    journalTerminal: r.journalTerminal ?? null, writes: r.writes ? pick(r.writes, ["cancel", "capture", "create", "record", "void"]) : null,
    effectsKnown: r.effectsKnown ?? null, outstanding: r.outstanding ?? null, exclusion: r.exclusion ?? null, bridgeCalls: r.bridgeCalls ?? null,
    bridge: r.bridge ? pick(r.bridge, ["outcome", "code", "receiptLanding", "operatorCoreInvocations", "dbAbortApplied"]) : null,
    release: r.release ? pick(r.release, ["state", "reason", "legs", "claimsHeld"]) : null, ownerCleanupRequired: r.ownerCleanupRequired ?? null,
    r1: r.r1 ? { ...pick(r.r1, ["kind", "packageHash", "executorDigest", "fences", "expiredAtCleanup", "exclusionAfter", "fullyClean"]),
      preflight: r.r1.preflight ? pick(r.r1.preflight, ["code", "preflightDigest", "baselineDigest"]) : null,
      refence: r.r1.refence ? pick(r.r1.refence, ["code", "baselineDigest"]) : null,
      exclusionRead: r.r1.exclusionRead ? pick(r.r1.exclusionRead, ["at", "code", "disposition", "uncertainty"]) : null } : null
  } : null;
  return JSON.parse(JSON.stringify({ schema: LAUNCH_RESULT_SCHEMA, executable: run !== null, run, ...extra }));
}
const refused = (stage, code, pools) => freeze({ stage, code, result: sanitize(null, { refused: { stage, code }, ...(pools ? { teardown: { pools } } : {}) }) });

/**
 * runR1Launch({ flags, nat, proc, hooks, signal, attest, repoRoot }) → Promise<{ stage, code, result }>; never rejects.
 *   flags: the CLI's validated execute flags. nat: the accepted native adapters (probe-cli-main). attest: the native stdin attestation callback.
 *   hooks (IN-PROCESS ONLY, never selectable from argv / env): { exchanges?, timeScale? } — default real https exchanges, real time.
 */
export async function runR1Launch(input) {
  const { flags, nat, proc, hooks, signal, attest, repoRoot } = input;
  // ---- (1) accepted env evaluation (presence-only snapshot built by the CLI) ---------------------------------------------------------
  const env = evaluateProbeEnvironment(input.envSnapshot);
  if (!env.ok) return refused("env", env.code);
  // ---- (2) package / plan / sources (owner-supplied reviewed files + the verified repo closure); pure binder pre-check ---------------
  let packageBytes; let planBytes; let foundationSources; let executorSources;
  try {
    packageBytes = await nat.readBounded(flags.package, MAX_PACKAGE_BYTES);
    planBytes = await nat.readBounded(flags.plan, MAX_PLAN_BYTES);
    const readList = async (list) => { const out = []; let t = 0; for (const p of list) { const b = await nat.readBounded(`${repoRoot}/${p}`, MAX_SOURCE_FILE_BYTES); t += b.length; if (t > MAX_SOURCE_TOTAL_BYTES) throw new Error("e7"); out.push({ path: p, bytes: b }); } return out; };
    foundationSources = await readList(RUN_PLAN_CLOSURE); executorSources = await readList(R1_EXECUTOR_CLOSURE);
  } catch { return refused("package", "PACKAGE_READ_FAILED"); }
  const r1 = { packageBytes, planBytes, foundationSources, executorSources, envSnapshot: input.envSnapshot,
    expected: { packageHash: flags.expectPackageHash, executorDigest: flags.expectExecutorDigest } };
  const clock = () => proc.now();
  const pre = bindRunPackageR1Journal(r1, clock());
  if (!pre.ok) return refused("package", pre.binderCode || pre.code);
  const B = pre.binding;
  if (bindingKindV2(B) !== "r1") return refused("package", "BINDING_UNVERIFIED");
  if (B.identity.intentId !== flags.intent) return refused("package", "INTENT_MISMATCH");
  // ---- (3) OWNER file ingress (accepted readers; explicit paths; secrets stay in capabilities) ---------------------------------------
  const pc = await readProbeCredentialFile({ path: flags.providerCredentials, repoRoot, needs: { hostaway: true, stripe: true }, fs: nat.credentialFs });
  if (!pc.ok) return refused("provider-credentials", pc.code);
  const db = await readDbLoginFiles({ appPath: flags.dbApp, reportPath: flags.dbReport, repoRoot, fs: nat.credentialFs });
  if (!db.ok) return refused(`db-login-${db.slot ?? "pair"}`, db.code);
  let caPem = null;
  if (flags.dbCa !== "none") {
    try {
      const b = await nat.readBounded(flags.dbCa, MAX_CA_BYTES);
      caPem = new TextDecoder("utf-8", { fatal: true }).decode(b);
      if (!/^-----BEGIN CERTIFICATE-----\r?\n[\s\S]+-----END CERTIFICATE-----\s*$/.test(caPem)) return refused("db-ca", "CA_NOT_PEM");
    } catch { return refused("db-ca", "CA_READ_FAILED"); }
  }
  // ---- (4) construction (NO connect / NO request): accepted pool (verified TLS for remote; loopback plain), accepted X → T -------------
  const pools = {};
  try {
    for (const slot of ["app", "report"]) pools[slot] = createBookingPool({ connectionString: db.logins[slot].connectionString, caPem, max: POOL_MAX[slot] });
  } catch { for (const p of Object.values(pools)) p.end().catch(() => {}); return refused("pool", "POOL_CONFIG_REFUSED"); }   // accepted pool errors carry no URL; dropped anyway
  const creds = pc.credentials;
  const exch = (provider) => (hooks && hooks.exchanges ? { ok: true, exchange: hooks.exchanges[provider] } : createE7RealExchange({ provider }));
  const xh = exch("hostaway"); const xs = exch("stripe");
  const th = xh.ok ? createE7HostawaySend({ exchange: xh.exchange, credential: () => creds.hostawayToken }) : xh;
  const ts = xs.ok ? createE7StripeTestSend({ exchange: xs.exchange, credential: () => creds.stripeTestKey, accountId: B.manifest.stripeAccountId, apiVersion: flags.stripeApiVersion }) : xs;
  const endPools = () => endAll(pools, proc);
  if (!th.ok || !ts.ok) { const pe = await endPools(); return refused("transport", "TRANSPORT_OPTIONS_INVALID", pe); }
  // ---- (5) creation-only R1 file + head journal (explicit owner dirs; never reopen / resume / repair) ---------------------------------
  const fj = await openFileJournalR1({ journalDir: flags.journalDir, headDir: flags.headDir, binding: B });
  if (!fj.ok) { const pe = await endPools(); return freeze({ stage: "journal", code: fj.code, result: sanitize(null, { refused: { stage: "journal", code: fj.code }, teardown: { pools: pe } }) }); }
  // ---- (6) the accepted consumer (lock, same-DB / TEST / roles, fresh preflight, fences, bridge, cleanup, release, exclusion re-read) --
  const K = hooks && Number.isSafeInteger(hooks.timeScale) && hooks.timeScale > 0 ? hooks.timeScale : 1;
  const t0 = proc.monotonic(); const mono = () => (proc.monotonic() - t0) * K;
  const timers = freeze({ arm: (ms) => { let id; const promise = new Promise((res) => { id = proc.setTimer(res, Math.max(0, ms / K)); }); return { promise, cancel: () => proc.clearTimer(id) }; } });
  let r = null;
  try {
    r = await runReservationAbortR1({ r1, intentId: flags.intent, pools: { app: pools.app, report: pools.report }, transports: { hostaway: th.transport, stripe: ts.transport },
      journal: fj.journal, trustedHead: null, attest, clock, monotonic: mono, timers, signal });
  } catch { r = null; }
  // ---- (7) teardown with honest dispositions: finalize (lock release / quiescence) → journal close → pool end (bounded) ----------------
  let fin = null; try { fin = r && typeof r.finalize === "function" ? await r.finalize() : null; } catch { fin = null; }
  let jc = null; try { jc = await fj.close(); } catch { jc = null; }
  const pe = await endPools();
  const teardown = { finalize: fin ? { quiescence: fin.quiescence ?? null, lockRelease: fin.lockRelease ?? null } : "unknown",
    journal: jc ? { fileClose: jc.fileClose, headLock: jc.headLock, journalLock: jc.journalLock } : "unknown", pools: pe };
  const code = r === null ? "CONSUMER_FAILED" : r.outcome;
  return freeze({ stage: "run", code, result: sanitize(r, { teardown, journalFiles: { journal: "e7-journal-r1", head: "e7-head-r1", runIdHash: createHash("sha256").update(B.identity.runId).digest("hex").slice(0, 16) } }) });
}

/** end both pools, each bounded; an unsettled end is reported "unknown" (never reused: the process exits after the one result line) */
async function endAll(pools, proc) {
  const out = {};
  for (const [slot, p] of Object.entries(pools)) {
    out[slot] = await new Promise((resolve) => {
      let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
      const id = proc.setTimer(() => fin("unknown"), POOL_END_BOUND_MS);
      p.end().then(() => { proc.clearTimer(id); fin("ended"); }, () => { proc.clearTimer(id); fin("end_failed"); });
    });
  }
  return out;
}

/**
 * createStdinAttest({ stdin, stderr }) → { attest, stats } — the native owner-attestation adapter for the accepted core (root review of 128ac08, H1).
 *   * ONE active prompt at a time, each with a FRESH unpredictable token. The prompt (stderr, no secret) is
 *     `E7ATTEST {"runId","checkpoint","intentId","manifestHash","connection","token","reply"}` and states the exact reply forms:
 *       `ATTEST <runId> <checkpoint> <token> <evidenceRef>`  |  `DECLINE <runId> <checkpoint> <token>`
 *   * An answer is accepted ONLY while its prompt is active and only with that prompt's run / checkpoint / token. Input arriving while NO prompt
 *     is active (before the first, between checkpoints, after the match in the same chunk) is DROPPED, never queued; a partial line buffered
 *     before a prompt is discarded when the prompt is issued; lines and the partial buffer are bounded. Old tokens never match a new prompt.
 *   * The token prevents stale / pre-queued adoption; it does NOT authenticate the truth of the owner's evidence. Nothing is fabricated: no
 *     answer → the core's own ATTEST_MS bound / the run signal; an abort rejects (listener attached BEFORE the prompt is written).
 */
export const MAX_ATTEST_LINE = 512;
export function createStdinAttest({ stdin, stderr, token: tokenFn = () => randomBytes(16).toString("hex") }) {
  let partial = ""; let overflow = false; let active = null;
  const stats = { dropped: 0, mismatched: 0 };
  const bump = (k) => { if (stats[k] < 1_000_000) stats[k] += 1; };
  const onLine = (l) => {
    if (active === null) { bump("dropped"); return; }
    const p = l.split(" "); const a = active;
    if (p[0] === "ATTEST" && p.length === 5 && p[1] === a.runId && p[2] === a.checkpoint && p[3] === a.token && EVIDENCE_REF_RE.test(p[4])) { a.finish({ ok: true, evidenceRef: p[4] }); return; }
    if (p[0] === "DECLINE" && p.length === 4 && p[1] === a.runId && p[2] === a.checkpoint && p[3] === a.token) { a.finish({ ok: false }); return; }
    bump("mismatched");
  };
  if (typeof stdin.setEncoding === "function") stdin.setEncoding("utf8");
  stdin.on("data", (c) => {
    let s = String(c);
    while (s.length) {
      const i = s.indexOf("\n");
      if (i < 0) { if (!overflow) { partial += s; if (partial.length > MAX_ATTEST_LINE) { partial = ""; overflow = true; } } return; }
      const piece = s.slice(0, i); s = s.slice(i + 1);
      if (overflow) { overflow = false; partial = ""; bump("dropped"); continue; }          // the over-long line is dropped whole
      const line = (partial + piece).replace(/\r$/, ""); partial = "";
      if (line.length > MAX_ATTEST_LINE) { bump("dropped"); continue; }
      onLine(line);
    }
  });
  const attest = (checkpoint, request, opts) => new Promise((resolve, reject) => {
    const sig = opts && opts.signal;
    if (active !== null) { reject(new Error("attest-busy")); return; }                 // never two waiters
    if (sig && sig.aborted) { reject(new Error("aborted")); return; }
    let finished = false;
    const a = { runId: request.runId, checkpoint, token: String(tokenFn()) };
    const end = () => { finished = true; if (active === a) active = null; if (sig) sig.removeEventListener("abort", onAbort); };
    a.finish = (v) => { if (finished) return; end(); resolve(v); };
    const onAbort = () => { if (finished) return; end(); reject(new Error("aborted")); };
    if (sig) sig.addEventListener("abort", onAbort, { once: true });                 // BEFORE the prompt is written
    partial = ""; overflow = false;                                                    // a pre-prompt partial line is never part of an answer
    active = a;
    const reply = `ATTEST ${a.runId} ${checkpoint} ${a.token} <evidenceRef>  |  DECLINE ${a.runId} ${checkpoint} ${a.token}`;
    try { stderr.write(`E7ATTEST ${JSON.stringify({ runId: request.runId, checkpoint, intentId: request.intentId, manifestHash: request.manifestHash, connection: request.connection, token: a.token, reply })}\n`); }
    catch { /* prompt best effort */ }
    if (sig && sig.aborted) onAbort();
  });
  return { attest, stats };
}
export const isUuid = (s) => typeof s === "string" && UUID_RE.test(s);
