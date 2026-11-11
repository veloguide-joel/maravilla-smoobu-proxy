# E7 H1 — guided hidden-entry credential-file helper (contract note)

`scripts/e7-connected/e7-fill-credential-file.mjs <app-login|provider> <ABS path>` (root ruling: P-B + F-A). An owner pre-run tool. It is NOT part of the native execution closure or of any E4 closure.

- **Kinds.**
  - `app-login`: the `mv_booking_app_dev` login. The EXISTING password is reused; never reset. Role label `mv_booking_app`; fixed DIRECT `db.mxotevtiscernhqilyiu.supabase.co:5432/postgres`; the password is percent-encoded by the helper; no sslmode / query.
  - `provider`: Hostaway token + Stripe `sk_test_` key.
  - There is no report kind.
- **Order.** Grammar → platform → TTY → path prevalidation → double hidden entry → in-memory build / validation → ONE synchronous block (exclusive create, dev / ino captured IMMEDIATELY after open, bounded write, fsync, close) → signal check → round-trip through the ACCEPTED reader → signal check.
  - Path prevalidation: canonical; absent target; parent realpath-equal, own uid, `mode & 022 == 0`; not in the repo / `.git`.
  - Accepted reader: `readOneDbLogin` slot app / `readProbeCredentialFile`, with the accepted native `credentialFs`.
- **Prompt.** An H1-local reader with the same state machine as the accepted E4 `readHiddenLine` (parity-tested; the E4 file stays byte-unchanged), plus:
  - per-prompt limits: password 512 / Hostaway 4096 / Stripe 256 (the 4096-byte FILE cap binds first);
  - UTF-8 assembled across chunks; chunk ≤ 65536;
  - end / close / error / AbortSignal → ABORTED;
  - own-listener-only cleanup; raw mode restored on every path.
- **Output.** One stdout line `{"schema":"e7-cred-fill-v1","kind","code"}`; stderr = fixed labels only. Never a value, URL, path, message or stack.
- **Limits (stated).**
  - Cleanup is an lstat dev / ino identity check + unlink under the trusted parent, NOT an atomic compare-and-unlink (namespace trust: same uid / root).
  - An fstat failure right after open → `OWNERSHIP_UNPROVEN_LEFT_IN_PLACE` (no unlink).
  - No recovery from SIGKILL / crash.
  - JS strings cannot be wiped.
  - An identical typo entered twice passes; the first real login proves the value.
  - Importing the accepted adapter module loads `node:https` (module load only; zero network invocations, tripwire-tested); no `pg` / launcher.
