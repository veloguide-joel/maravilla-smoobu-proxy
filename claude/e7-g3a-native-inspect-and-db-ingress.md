# E7 G3a — native plan-INSPECT entrypoint and owner DB credential-file ingress (OFFLINE, LOCAL) — contract

**Authority.** Root ruling 26518a25 part B. The work starts from e7-test `ab9d463a771044fa6c257f931ee8978cd3e28113` on the isolated branch `feature/e7-g3a-native-inspect`.

**The slice.** It prepares the eventual real runner without activating it. It does not:
- invoke `runReservationAbortR1`;
- execute anything;
- add a route, workflow, cron or deployable import;
- read a credential, open a DB connection or make a provider call;
- make a shared-DB or 0017 change.

G3b (execute wiring) is NOT part of this slice.

## 1. `scripts/e7-connected/run-plan-cli-main.mjs` — native INSPECT entrypoint

**Inert on import.** The only top-level effect is `if (import.meta.main === true) main(...)`.
- Its static imports are Node built-ins only: `node:process` (used only by that guarded call), `node:fs`'s `constants`, and `node:url`'s `fileURLToPath` (for the CLI's own repo root).
- Everything else is loaded by a fixed-specifier dynamic `import()` AFTER the mode is decided: the accepted command `run-plan-command.mjs`, and the accepted native fs adapters `createNativeAdapters` / `nativeSupported` / `PRESENT_KEYS` from `probe-cli-main.mjs`.

**`main(proc, hooks)` never rejects and gives a single exit.** The `proc` / `hooks` shapes follow the accepted `probe-cli-main.mjs`.

**Grammar** (from argv alone, before anything else is touched):

| argv after `node <file>` | result | exit |
|---|---|---|
| `inspect --plan <abs canonical path>` | INSPECT (below) | 0 / 4 / 1 |
| first token `execute` (any rest) | `{ outcome: "EXECUTE_NOT_IMPLEMENTED" }` | 5 |
| anything else (empty, unknown, malformed / extra / repeated flags, relative path) | `{ outcome: "USAGE" }` | 2 |

**`execute` / unknown modes refuse FIRST.** They make no `env` read, no `getuid`, no platform probe, no adapter, no import, no file / dir / credential / network / pool / transport / journal access. Tests count every `proc` member touch and hook call, and run a child process under an fs tracer.

**INSPECT steps:**
1. The platform / constants check uses the accepted `nativeSupported`; failure → `BOOT_UNSUPPORTED` (exit 3).
2. The accepted adapters are created with a no-op terminal gate.
3. The env snapshot is built ONCE, presence-only, using exactly the accepted probe CLI's `PRESENT_KEYS` / schema. No env value is read.
4. `runPlanCommand({ argv: ["inspect"], deps })`, the accepted command, runs with:
   - `planClock = Date.now` (one sync read);
   - `readPlanFile` = the accepted bounded O_NOFOLLOW regular-file reader at `run-plan-v1.MAX_PLAN_BYTES`;
   - `readSourceFiles(closure)` = the same reader over exactly the closure the command passes (`RUN_PLAN_CLOSURE`), under the CLI's own repo root, with per-file and total caps from `run-plan-v1`.
5. stdout is ONE line: the command's deep-frozen, mechanically whitelisted result, plus `exitCode`.
   - Exit codes: `INSPECT_OK` → 0; `PLAN_REFUSED` / `DEPS_INVALID` → 4 / 1.
   - Every result keeps `executable: false` and all permissions false.
   - No path, file content, error text or env value is echoed.

**No mutation of any kind:** INSPECT writes no file and starts no DB, provider, network or timer work.

## 2. `scripts/e7-connected/db-credential-file.mjs` — owner DB login-file ingress (separate, inert)

**`readDbLoginFiles({ appPath, reportPath, repoRoot, fs })`** → native Promise; never rejects.
- **Inputs:** explicit owner-supplied paths only, through the SAME injected read-only adapter schema as the accepted `probe-credential-file.mjs` (`{ platform, uid, lstat, realpath, open }`). There is no env fallback and no default path or value.
- **File safety** is a LABELLED COPY of the accepted reader's steps 1–10, pinned to its origin SHA-256 (`COPIED_ORIGIN`) and parity-tested on the same scenarios:
  - canonical absolute path, canonical parent, not inside the repo or any `.git` tree;
  - regular file, owner uid, mode exactly 0600, nlink 1, size 1–4096;
  - O_RDONLY | O_NOFOLLOW open kind; fd stats before and after the read, with identity equality;
  - a one-byte growth probe, then a post-read path lstat;
  - close exactly once;
  - a strict duplicate-refusing object-of-strings JSON parser.
  - The accepted reader itself is unchanged.
- **Schema, per file, exactly three string keys:** `{ "schema": "e7-db-login-v1", "role": <slot role>, "connectionString": <url> }`.
  - The app slot requires `role = "mv_booking_app"`; the report slot requires `role = "mv_booking_report"`.
- **URL structure.** The string is parsed with WHATWG `URL`; no DNS, no pool, no connection.
  - scheme `postgres:` or `postgresql:`;
  - non-empty username and password;
  - non-empty host and port 1–65535;
  - path exactly one non-empty database segment;
  - no fragment; the only query parameter allowed is `sslmode` ∈ {`require`, `verify-ca`, `verify-full`};
  - ≤ 2048 characters.
- **Cross-file checks** (TEXT ONLY): the two paths must differ, the two connection strings must differ, and host / port / database must be textually equal.
  - These are string checks, NOT evidence of same-DB, TEST marker, role membership or privilege. Those remain the live preflight's L1 checks (`checkSameDatabase`, `ROLE_NOT_APP` / `ROLE_NOT_REPORT`).
- **Results.**
  - Failures are PUBLIC and code-only: `{ ok:false, code, slot: "app"|"report"|null, closeState }`.
  - Success is PRIVATE: `{ ok:true, logins: { app, report } }`. Each login has an enumerable `role` and a NON-ENUMERABLE `connectionString`.
  - No URL, user, password, host or hash ever appears in a result, a code or a thrown error.
- **Imports:** `node:util` only. No `pg`, no fs, no process.

## 3. Closures / pins (explicit)

- No accepted runtime module changes; all are byte-exact.
- Neither new module is imported by any accepted root, so `RUN_PLAN_CLOSURE` (50) and `R1_EXECUTOR_CLOSURE` (30) are unchanged, and so are their digests (`cdb00be0…03e1` / `897d369f…1ea7`).
- **Not claimed:** the 30-path G1 executor closure is G1-only. It is NOT the future native execution closure. A launched consumer (the CLI execute path, the DB ingress, the journal / core / workers / transports) needs its own reviewed closure in G3b.

## 4. Shortest remaining activation checklist (concrete unresolved inputs)

1. **Machine.** The chosen POSIX machine (linux / darwin, Node 22.22.0 or 24.22.1, no refused env variables), with owner-only journal and head directories on it. The owner chooses machine and paths.
2. **Credentials.**
   - Owner-only app and report login files (mode 0600, outside the repo), schema §2. The owner types the password values.
   - The existing provider file (Hostaway token plus Stripe TEST key) per the accepted probe ingress.
   - No agent reads these values.
3. **Shared 0017.** A reviewed apply and readback package, using the procedure in §5. It stays unapplied until that package is reviewed and run under the existing delegation.
4. **Fresh booking input.** A fresh website quote and an authorized test intent: payment_authorized, within the 30-minute quote cap and the margin rules. Respect any automatic review rejection, including the prior hosted Pay handoff; it is never routed around.
5. **ONE execution / recovery package.** A single, exact, reviewed package covering booking → intentional TEST abort → host-cancel plus authorization-void, with protected and historical exclusions. Capture, recording, refunds and notifications are out of scope; `guest.notify` stays queued and unsent.
6. **G3b.** Execute wiring (credential and DB ingress → pools / transports / journal → `runReservationAbortR1`) under its own reviewed native closure. Not started.

Joel already delegates reviewed routine migrations, merges and TEST actions, so no fresh blanket approval is created here. The owner supplies only the secret values and the machine / path choices. All Hostaway listings are owner-declared TEST inventory; external writes remain ONE bounded, reviewed package.

## 5. Offline 0017 apply / readback PROCEDURE (a document, not a tool; nothing run here)

1. **Pre-read** (read-only, operator session): `booking.schema_migrations` latest version; the presence of the 0017 objects (`db/migrations/0017_cancelled_pristine_capture_release.up.sql`); counts of `inventory_claims` held for `cancelled` intents.
2. **Pin check.** The file SHA-256 equals the accepted pin `880f203b11cb4d2a9fe2317d6cb9fc8e00853b8c8ba41f44026d07aae9fd510e`, from the M2-D PINS.
3. **Apply** with the accepted `scripts/db-migrate.mjs`, as the schema owner, only when the pre-read in step 1 shows 0017 as the ONLY pending migration, and only after review of steps 1–2.
4. **Readback:** the migration row is present, the objects exist, and the pre-read counts are unchanged except as 0017 documents. No booking-row edits.
5. **On any unexpected effect:** stop, record it, no down-migration without review.

## 6. Tests

- `test/e7-connected-run-plan-cli-main.test.mjs`. **Child-process tests:**
  - INSPECT over a synthetic canonical plan with the real repo sources → `INSPECT_OK`, byte-equal to the in-process accepted `runPlanCommand` over the same files and clock;
  - a refusal / exit-code parity table (malformed, non-canonical, oversize, non-regular / symlink plan; a tampered source copy → `SOURCE_DIGEST_MISMATCH`; a plan with the wrong sourceDigest pin);
  - execute / unknown → zero fs touches under a tracer;
  - sanitized output.

  **In-process tests:** the `proc` / `hooks` touch counts for execute / unknown / usage; hostile proc fields.
- `test/e7-connected-db-credential-file.test.mjs`. **Real temp files, synthetic canary credentials:**
  - happy path;
  - mode / owner / link / symlink / size / growth / replace / in-repo / git-tree refusals, with parity against the accepted reader for the copied steps;
  - malformed, duplicate, extra and missing keys; role mismatch / swap;
  - URL structure refusals; cross-file checks;
  - the canary never appears in any result, error or inspect / JSON output;
  - no `pg` import and no connection;
  - the origin pin.
