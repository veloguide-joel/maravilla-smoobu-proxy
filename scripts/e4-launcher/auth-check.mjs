#!/usr/bin/env node
// E4 AUTH + READ-ONLY diagnostic (offline-prepared; separate from the booking run; running it requires a reviewer GO).
//
//   node scripts/e4-launcher/auth-check.mjs --reviewed-commit <40-hex commit>
//
// Purpose: tell WHY the owner's local Hostaway auth failed, without any booking capability.
//   1. strict arguments (only --reviewed-commit);
//   2. read-only git provenance of EVERY file this module loads (HEAD == reviewed commit, clean, blobs match) —
//      on failure: no prompt, no network;
//   3. the corrected hidden TTY credential prompt (escape- and abort-safe);
//   4. the existing single-attempt transport, behind a LOCAL fetch allowlist that lets through exactly:
//        - one   POST /v1/accessTokens            (the existing token mint; at most once, no retry/re-mint)
//        - one   GET  /v1/listings/606998          (no query, no body)
//      Anything else (method, path, query, body, a second call) is refused before fetch is ever called.
//   5. output: fixed codes only — token ok?, listing read ok?, HTTP status, allowlisted transport diag.
//      Never a provider body, listing data, credentials, token, account id, names or emails.
// It never calls the booking runner, never creates/cancels, never sends a price POST, never opens, reads, writes or
// deletes any run journal or manifest, and writes no file at all.

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { verifyProvenance, makeGit, EXECUTE_SOURCES } from "./happy-execute.mjs";
import { createHostawayTransport, HOSTAWAY_BASE } from "../e4-transport/hostaway-transport.mjs";
import { promptHostawayCredentials } from "../e4-transport/credential-prompt.mjs";
import { sanitizeTransportDiag, E4_TEST_LISTING_ID } from "../e4-write-runner/runner.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
/** Every file loaded when this module runs (its own imports, transitively), plus this file. */
export const AUTH_CHECK_SOURCES = Object.freeze([...EXECUTE_SOURCES, "scripts/e4-launcher/auth-check.mjs"]);
export const AUTH_EXIT = Object.freeze({ OK: 0, USAGE: 64, REFUSED: 2, DIAGNOSED_FAILURE: 3, INTERNAL: 70 });
const TOKEN_URL = `${HOSTAWAY_BASE}/accessTokens`;
const LISTING_PATH = `/listings/${E4_TEST_LISTING_ID}`;
const LISTING_URL = `${HOSTAWAY_BASE}${LISTING_PATH}`;

/** The only network shapes ever allowed, each at most once. Refuses everything else WITHOUT calling fetch. */
export function guardFetch(fetchImpl) {
  const used = { token: 0, listing: 0, refused: 0 };
  const guarded = async (url, init = {}) => {
    const u = String(url);
    const method = init && typeof init.method === "string" ? init.method : "GET";
    const isToken = u === TOKEN_URL && method === "POST" && used.token === 0;
    const isListing = u === LISTING_URL && method === "GET" && init.body === undefined && used.listing === 0;
    if (!isToken && !isListing) { used.refused++; throw Object.assign(new Error("refused by local allowlist"), { name: "LocalRefusal" }); }
    if (isToken) used.token++; else used.listing++;
    return fetchImpl(url, init);
  };
  return { guarded, used: () => Object.freeze({ ...used }) };
}

const refuse = (exitCode, stage, error) => ({ exitCode, output: Object.freeze({ ok: false, mode: "auth-check", stage, error, credentialsRequested: stage !== "arguments" && stage !== "provenance", network: "none" }) });

/** deps (tests): { git, prompt, fetchImpl, sleep } */
export async function runAuthCheck(argv, deps = {}) {
  const a = Array.isArray(argv) ? argv : [];
  if (a.length !== 2 || a[0] !== "--reviewed-commit") return refuse(AUTH_EXIT.USAGE, "arguments", "USAGE");
  const reviewedCommit = a[1];
  if (typeof reviewedCommit !== "string" || !/^[0-9a-f]{40}$/.test(reviewedCommit)) return refuse(AUTH_EXIT.USAGE, "arguments", "REVIEWED_COMMIT_INVALID");

  const prov = verifyProvenance({ reviewedCommit, git: deps.git ?? makeGit(ROOT), sources: AUTH_CHECK_SOURCES });
  if (!prov.ok) return refuse(AUTH_EXIT.REFUSED, "provenance", prov.code);

  let creds;
  try { creds = await (deps.prompt ?? promptHostawayCredentials)(); } catch (e) {
    const code = typeof e?.code === "string" && /^[A-Z_]{1,40}$/.test(e.code) ? e.code : "CREDENTIALS_UNAVAILABLE";
    return { exitCode: AUTH_EXIT.REFUSED, output: Object.freeze({ ok: false, mode: "auth-check", stage: "credentials", error: code, network: "none" }) };
  }
  const getCredentials = async () => { const c = creds; creds = null; return c; };
  try {
    const guard = guardFetch(deps.fetchImpl ?? globalThis.fetch);
    const transport = createHostawayTransport({ fetchImpl: guard.guarded, getCredentials, ...(deps.sleep ? { sleep: deps.sleep } : {}) });
    const r = await transport.send({ method: "GET", path: LISTING_PATH, query: {} });
    const used = guard.used();
    if (r.transportError) {
      const diag = sanitizeTransportDiag(r.diag);
      return { exitCode: AUTH_EXIT.DIAGNOSED_FAILURE, output: Object.freeze({ ok: false, mode: "auth-check", reviewedCommit,
        tokenOk: diag ? diag.stage === "REQUEST" : false, listingReadOk: false, diag, requests: { token: used.token, listing: used.listing } }) };
    }
    const j = r.json;
    const env = j !== null && typeof j === "object" && !Array.isArray(j) ? j : null;
    const readCode = r.httpStatus !== 200 ? "READ_HTTP_NOT_OK"
      : !env || env.status !== "success" || env.result === null || typeof env.result !== "object" ? "READ_ENVELOPE_INVALID"
      : env.result.id !== E4_TEST_LISTING_ID ? "READ_LISTING_MISMATCH" : "READ_OK";
    const ok = readCode === "READ_OK";
    return { exitCode: ok ? AUTH_EXIT.OK : AUTH_EXIT.DIAGNOSED_FAILURE, output: Object.freeze({ ok, mode: "auth-check", reviewedCommit,
      tokenOk: true, listingReadOk: ok, readCode, readHttpStatus: Number.isSafeInteger(r.httpStatus) ? r.httpStatus : null,
      requests: { token: used.token, listing: used.listing } }) };
  } catch {
    return { exitCode: AUTH_EXIT.INTERNAL, output: Object.freeze({ ok: false, mode: "auth-check", stage: "run", error: "INTERNAL_ERROR" }) };
  } finally {
    creds = null;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await runAuthCheck(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(r.output, null, 2)}\n`);
  process.exitCode = r.exitCode;
}
