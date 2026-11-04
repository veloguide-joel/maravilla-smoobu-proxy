# E7 read-only probe — OWNER HANDOFF / EXACT APPROVAL PACKET (two-GET first run) — DRAFT, NOT AN APPROVAL

**Status.** The tooling is ACCEPTED **OFFLINE** only. It is **not live-ready** and **nothing has run against a provider**. Real execution, credentials, the owner environment and the approval below are all **CLOSED**. Every `UNSET` field makes the plan **invalid and unapproved**. Protected reservations `70636076 / 71045356 / 71072615 / 71081885` get zero action, and all writes are excluded.

## 1. Accepted tooling and source identity
| Item | Value |
|---|---|
| Accepted tooling head (C1 + C2 + C3, root-accepted OFFLINE) | `d1e20d71ecf15f82d2d3b74fd22eb562eaa310f8` (branch `feature/e7-connected-probe-entrypoint`) |
| `sourceDigest` of the exact 13-path closure at that head | `23212caabf508f0aa929a2c3beb9f6f216b0cc3bc697cd783ba7ed203e21ce3d` |
| This packet's docs-only head | It changes no closure file, so its `sourceDigest` is **identical** to the value above (re-computed after the commit; see the report) |

**How the digest was computed (Claude, local, read-only).**
- Bytes: the accepted pure helper `computeSourceDigest` over fresh `Uint8Array` snapshots of the **git blob bytes** (`git show d1e20d71:<path>`) of each closure path.
- Working tree: the clean checkout's bytes give the same digest, and `git diff` against the head is empty for every closure path.
- Not used: the real CLI (it reads the environment), credentials and network requests.

**Closure (in order, byte sizes):**

| # | Path | Bytes |
|---|---|---|
| 1 | `package.json` | 305 |
| 2 | `scripts/e7-connected/probe-cli-main.mjs` | 20037 |
| 3 | `scripts/e7-connected/probe-source-digest.mjs` | 5595 |
| 4 | `scripts/e7-connected/probe-command.mjs` | 32552 |
| 5 | `scripts/e7-connected/probe-env-preflight.mjs` | 4498 |
| 6 | `scripts/e7-connected/probe-credential-file.mjs` | 19854 |
| 7 | `scripts/e7-connected/readonly-probe.mjs` | 45795 |
| 8 | `scripts/e7-connected/http-transports.mjs` | 28364 |
| 9 | `scripts/e7-connected/real-exchange.mjs` | 23221 |
| 10 | `lib/checkout/compensation-proof.js` | 31611 |
| 11 | `lib/checkout/recovery-plan.js` | 24695 |
| 12 | `lib/checkout/capture-proof.js` | 17137 |
| 13 | `lib/checkout/intent-state.js` | 41943 |

**Checkout requirement:** the owner's working tree must be byte-identical to the head. That means no CRLF / `autocrlf` / eol filter conversion, so `inspect` reports exactly this digest.

**Source-derived constants:**
- Node: exactly `22.22.0` or `24.22.1`.
- Platform: `linux` or `darwin`.
- `Stripe-Version`: `2026-08-26.dahlia`.
- Hosts: `https://api.hostaway.com`, `https://api.stripe.com`.
- Probe inventory: GET only, `P-H1…P-H6`, `P-S1`, `P-S2`.
- Plan limits ranges: `perProbeMs` 1000…15000, `runMs` 1000…180000 (≥ perProbeMs), `tailMs` 0…10000.
- Credential file: 1…4096 bytes, `0600`.
- Plan file: ≤ 16384 bytes, canonical.

**Test provenance:**

| Who | What |
|---|---|
| **ROOT-run** | C3 focused 8/8 first run; combined A/B/D/F/T/X/P/rehearsal/C1/C2/C3 154/154 first run; root boundary probes (C2 3/3, C3 2/2) |
| **CLAUDE-run** | C3 FIRST FULL TAP 7/8 (a test-timing fixture fault, disclosed), then 8/8; units 227/227; `npm test` 892/892 |

All tests used fakes or synthetic temp files only, in a container. **None of this proves the owner's machine** (that is E1 / E2 below).

## 2. Recommended first package: TWO GETs only
**Probes `["P-H1", "P-S1"]`, exactly 2 requests.** This plan is valid against the accepted P schema: P's dependency and unused-input rules hold, and C3 test B5 composed exactly this shape over fake primitives.

| Probe | Request (built by P from the plan only) | What it can show |
|---|---|---|
| `P-H1` | `GET https://api.hostaway.com/v1/listings/<listingId>` with the existing Hostaway token | The token can read this listing, the reply `id` equals the planned listing id, and its current `currencyCode` is `USD` (else `PROBE_LISTING_MISMATCH` STOP); 401 / 403 → `PROBE_AUTH_REFUSED` |
| `P-S1` | `GET https://api.stripe.com/v1/account` with the `sk_test_` key and `Stripe-Version: 2026-08-26.dahlia` | The key's own account `id` equals the planned TEST account id (`accountIdMatches`). TEST-ness comes from the `sk_test_` prefix rule (C1 / T); the Account object itself carries no `livemode` |

**It does NOT verify or touch** these, all of which stay CLOSED / untested:
- `G_AUTH_charges_read` and `G_FILTER` (the charges reads, P-H5 / P-H6), `NOT_PROBED`;
- calendar / lookup / reservation / charges shapes (P-H2…P-H6);
- `B4_pi_read` and `TEST_mode_pi` (P-S2, PaymentIntent);
- every write shape (capture / void / cancel), booking, notifications;
- calendar or Airbnb block / reopen, listing ownership, and the full booking path.

It is a credential / listing / account binding check only.

**Owner-fillable plan DRAFT.** The `<UNSET …>` values are deliberately invalid: P refuses this draft with `PLAN_SHAPE` until every one is filled. It is not a runnable plan.

```json
{
  "version": "e7-probe-plan-v1",
  "metadata": {
    "reviewedCommit": "d1e20d71ecf15f82d2d3b74fd22eb562eaa310f8",
    "nodeVersion": "<UNSET: exactly 22.22.0 or 24.22.1 = the owner's node>",
    "stripeVersion": "2026-08-26.dahlia",
    "approvalRef": "<UNSET approval label: [A-Za-z0-9._:-]{1,80}>"
  },
  "hostaway": {
    "listingId": "<UNSET: JSON number, positive integer, a USD listing, not a pilot/protected one>",
    "calendar": null,
    "lookup": null,
    "sample": null,
    "control": null
  },
  "stripe": {
    "accountId": "<UNSET: acct_… TEST account id>",
    "paymentIntentId": null
  },
  "probes": ["P-H1", "P-S1"],
  "limits": { "perProbeMs": 10000, "runMs": 30000, "tailMs": 5000 }
}
```

**Notes on the draft:**
- `listingId` must become a bare JSON **number** (not a string).
- The limits are conservative and in range: 10 s per probe, 30 s total, 5 s to observe late settlement.
- `reviewedCommit` is a label, not attestation.

## 3. Minimal owner inputs
**(a) Execution environment.** It must be one that **already exists**: Linux or macOS, Node **exactly** `22.22.0` or `24.22.1`, run as a normal user that owns the files.
- Joel's normal desktop appears to be Windows, and **native Windows is unsupported** (the tool refuses).
- **Which existing Linux/macOS machine to use is the owner's choice.** This packet does not choose WSL, install anything or direct any system change.

**(b) Target listing id.** A USD Hostaway listing, not any pilot/protected item.

**(c) Stripe TEST account id** (`acct_…`).

**(d) Owner paths:**
- draft plan, canonical plan and credential file;
- `--summary-out`, a new file in an owner directory.

**(e) Approval label** (`approvalRef`).

**Credentials:** the **existing** Hostaway token and an `sk_test_` key go **only** into the private credential file (§4). They are never pasted into chat, reports or this packet, and no token is minted. **No reservation id or PaymentIntent is needed** for this package.

## 4. Commands (local first; provider GETs last and NOT AUTHORIZED)
**General rules for every command:**
- Run every command from a clean checkout of `d1e20d71` (or this docs head) with plain `node`: **no Node flags** (`execArgv` must be empty).
- The process environment must **not contain** `NODE_OPTIONS`, `NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_EXTRA_CA_CERTS`, `NODE_USE_ENV_PROXY`, `NODE_DEBUG`, `NODE_DEBUG_NATIVE`, `SSLKEYLOGFILE` or `OPENSSL_CONF`. Their presence refuses; values are never read.
- Proxy variables are reported only. A network that requires a proxy is unsupported.
- All paths are absolute and canonical (no `.` / `..` / `//`, no symlinked ancestors).

**Local only — no credentials, no network:**
1. **E1** (native-mapping + bootstrap tests over disposable synthetic temp files; fake https primitive, real https / fetch guarded):
   `node --test test/e7-connected-probe-cli-main.test.mjs`
   - Needs no `npm install`: the closure and this test import only repository files and Node built-ins.
   - Result: **UNSET**.
2. **Prepare** the canonical plan from the filled draft. It loads P only, with no C2 / T / X, credentials or network. The output is a new `0600` file and is never overwritten. Duplicate keys in a draft resolve last-key-wins, so **check the printed `planHash` and the produced file**:
   `node scripts/e7-connected/probe-cli-main.mjs prepare-plan --in <ABS draft.json> --out <ABS plan.json>`
3. **E2** inspect:
   `node scripts/e7-connected/probe-cli-main.mjs inspect --plan <ABS plan.json>`
   - It reads no credential, makes no request and creates no file.
   - Expected for a ready package: `preflight.code = ENV_OK`, `source.sourceDigest = 23212caabf508f0aa929a2c3beb9f6f216b0cc3bc697cd783ba7ed203e21ce3d`, the `planHash` from step 2, exit `10`.
   - Result: **UNSET**.

**Provider GETs — TEMPLATE ONLY, NOT AUTHORIZED** (2 requests):

```
node scripts/e7-connected/probe-cli-main.mjs execute --plan <ABS plan.json> --credentials <ABS creds.json> --summary-out <ABS summary.json> \
  --expect-plan-hash <UNSET 64-hex from E2> --expect-source-digest 23212caabf508f0aa929a2c3beb9f6f216b0cc3bc697cd783ba7ed203e21ce3d \
  --expect-requests 2 --approval-ref <UNSET same label as the plan>
```

**File requirements:**
- **Credential file:**
  - one regular file, mode `0600`, owned by the running user, single link, 1…4096 bytes, not a symlink;
  - its directory canonical and outside the repo and any `.git` tree;
  - contents exactly `{"hostawayToken":"<existing token>","stripeTestKey":"sk_test_…"}`, with no other keys.

  Live / restricted keys refuse.
- **`--summary-out`:** a **new** file. Its parent directory must be canonical, owned by the user, not group / world-writable (e.g. `0700`), and outside the repo / `.git`. An existing target refuses, and nothing is ever overwritten.

**Evidence returned:**
- **one stdout line** — the envelope with the payload and the summary-file status;
- **the `0600` summary file** — the payload, byte-identical inside the envelope.

Both are code-only: they never contain key / token values, paths or raw error text. Whether the owner later deletes or rotates the credential is a separate owner decision, outside this authorization.

## 5. Approval block for the eventual two-GET run (NOT GIVEN; fill, then ask)
| Field | Value |
|---|---|
| Scope | ONE owner-run READ-ONLY run: exactly `P-H1` + `P-S1` = **2 GET requests**; no writes, booking, notification, calendar or reservation access; protected ids zero-action |
| Tooling head / sourceDigest | `d1e20d71ecf15f82d2d3b74fd22eb562eaa310f8` / `23212caabf508f0aa929a2c3beb9f6f216b0cc3bc697cd783ba7ed203e21ce3d` |
| `planHash` | UNSET (from prepare + E2) |
| Listing id (USD) / Stripe TEST account | UNSET / UNSET |
| Environment | UNSET machine (Linux/macOS), Node UNSET (`22.22.0` / `24.22.1`); E1 result UNSET; E2 line UNSET (`ENV_OK`, digest as above) |
| Versions | `Stripe-Version: 2026-08-26.dahlia`; plan version `e7-probe-plan-v1`; limits 10000 / 30000 / 5000 ms |
| Credentials | existing Hostaway token + `sk_test_` key in the private `0600` file only; no mint; never displayed |
| Output | `--summary-out` path UNSET (new file, owner `0700` directory); evidence = the stdout line + summary file |
| Command | the §4 execute template with every UNSET value filled |
| `approvalRef` | UNSET label — **a label only: approvalRef, flags, hashes or switches are never consent** |
| Joel's explicit approval of THIS filled package | **UNSET** — required before any run; real execution stays CLOSED until E1 / E2 and every field above are filled and Joel approves that exact filled package |

**Outcome semantics (truthful):**
- **Exit codes:**
  - `0` — both probes OK and output acknowledged;
  - `6` — a probe STOPPED the run (e.g. auth refused, listing / account mismatch, transport failure); the remaining probe is `AFTER_STOP`, with no retry, fallback or resend;
  - `11` — completed with an INCONCLUSIVE probe (not success);
  - `8` — tail / cleanup uncertain: a request may still have been delivered and in-process work was abandoned, not proven cleaned up;
  - `9` — the summary file or stdout was not acknowledged: output **UNKNOWN**, possibly partially written, never "nothing written";
  - pre-run refusals: `2` usage, `3` env / platform, `4` source / plan / binding / output parent / output exists, `5` credential; no request is made.
- **First Ctrl-C** aborts: before dispatch it gives `7` with no request. During a probe it is recorded as `PROBE_CANCELLED`, and the evidence write still happens. `interruptObserved` is only a pre-output snapshot.
- **Second Ctrl-C** forces exit `130` immediately: nothing more is written and nothing pending is promised flushed.
- A credential refusal can take precedence over a simultaneous Ctrl-C (exit `5`).

## 6. Prioritized input checklist — then STOP
1. Name an **existing** Linux/macOS machine with Node exactly `22.22.0` or `24.22.1` (owner choice; no install or system change is directed here).
2. On it, a clean checkout of `d1e20d71` (no eol conversion), then run **E1** and record the result.
3. Fill the draft: **USD listing id**, **Stripe TEST account id**, **node version**, **approval label**. Run **prepare-plan**, then **E2 inspect**, and record the line (`ENV_OK`, digest, `planHash`).
4. Prepare the private `0600` credential file (existing token + `sk_test_` key) and an owner `0700` output directory. Never share their contents.
5. Fill §5. Only then ask Joel for explicit approval of that exact filled package.

**STOP.** No further code or infrastructure is proposed, because there is no actual blocker. No live run has begun, and no ETA is given beyond completing the owner inputs above.
