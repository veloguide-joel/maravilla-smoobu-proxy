# E7 C118 — the ONE C116 external-cancellation reconciliation (parameterized, guarded) — DRAFT

Reviewable DRAFT packet. **ROOT keeps the private bindings, reviews the bound text and issues it ONCE.** Claude does not run shared queries. Nothing here has been issued; no evidence, record or refund attestation has been written.

Target: the C116 synthetic TEST booking (TEST listing, USD 140.00, confirmation SENT to the simulation sink) whose Hostaway reservation a person cancelled in the Hostaway UI (cancelled by host, 2026-11-17 22:21:51Z). The refund stays **manual** in the Stripe dashboard and is recorded here as **pending**. The first C116 attempt has no reservation and is **not** part of this step.

## Files (sha256 manifest — verify every byte before use)

| file | sha256 |
|---|---|
| `claude/e7-c118-c116-record-v1.sql` | `2a67f5b147378e10d9cdff4d92349b4e82f2b98fd3cd5b5dd6249e2ad6c29793` |
| `claude/e7-c118-c116-record-readback-v1.sql` | `2734c17b7522764e2e49b2a5522ded52cdac2c9b595815ce7edf6f4db9c58b1e` |
| `claude/gen-c118-c116-record.py` | `8b37a56c9ae72cfd2f08887ef46fd66a7d99468a407416713b206f7e1658d49b` |
| `test/db/e7-c118-c116-record.test.mjs` | `9991d42a42178a9cfc81ff0a3e2449d23a9d7f2082a82886f5f86fa8397722f8` |
| `claude/e7-0027-inventory.sql` | `78d96c770205776f16a1bf38bbdee17ebeab639ce07223914b646fea03f50b2c` |
| `claude/e7-0027-pins-v1.json` | `430b98313a7ee25837bf757241629983d9e8d0fe03d6a9710e0a7c46af1c71c7` |

The test file's own hash is listed for reference only. Its bytes are covered by the PR head.

## Bindings (private; substitute every token, never commit)

| token | value ROOT binds | source |
|---|---|---|
| `<<C116_INTENT_ID>>` | the C116 replacement intent id | ROOT's private C116 binding |
| `<<EXPECTED_VERSION>>` | that intent's current version | read immediately before (readback) |
| `<<C116_RESERVATION_ID>>` | its Hostaway reservation id | private binding; equals `intents.hostaway_reservation_id` |
| `<<EXPECTED_LISTING_ID>>` | the TEST listing id | private binding |
| `<<EXPECTED_CAPTURED_MINOR>>` | `14000` | captured == final total |
| `<<HOSTAWAY_CANCELLED_AT>>` | `2026-11-17T22:21:51Z` | Hostaway reservation log |
| `<<OBSERVED_AT>>` | the UTC time of a FRESH read-only dashboard read showing the reservation still Cancelled | taken immediately before issuance; ISO `YYYY-MM-DDTHH:MM:SS(.ffffff)Z` |
| `<<REQUEST_KEY>>` | a fresh key, 8–116 chars `[A-Za-z0-9._:-]` | ROOT |
| `<<SHORT_REF>>` | a short reference, `[A-Za-z0-9._:/#-]` ≤ 120 | ROOT |

An unbound or malformed token refuses before any booking read (`E7_C116_PLACEHOLDER_NOT_BOUND` / `E7_C116_BINDING_MALFORMED`).

## Sequence

1. Fresh read-only Hostaway read of the reservation (still Cancelled, payment unchanged) → `<<OBSERVED_AT>>`. No provider change.
2. Readback BEFORE (`claude/e7-c118-c116-record-readback-v1.sql`, same tokens): schema 27, target confirmed at the expected version, own claim held 1, notify succeeded / attempt 1 / renders 1 / receipts 1 / latches 0, records 0, projection null. Keep `others_fingerprint`, `intent_row_md5`, `history_md5`.
3. Issue the bound `claude/e7-c118-c116-record-v1.sql` ONCE as the schema owner. Expect notice `E7_C116_RECORDED`; status line `1 / 1 / ["pending"] / 0`.
4. Readback AFTER: `intent_row_md5`, `history_md5`, `notify` identical; own claim held 0 (released `EXTERNAL_CANCELLATION_ATTESTED`); record `key_matches` true, dispositions `["sent_preserved"]`; refund `["pending"]`; latest reservation evidence `cancelled` / `hostaway_dashboard`; projection `{cancelled: true, refundStatus: pending}`; `externally_cancelled_latches` 0; `others_fingerprint` IDENTICAL to BEFORE.

## Boundaries

- **Atomic:** the evidence row (`admin_record_evidence`) and the record (`admin_record_external_cancellation`) are written in ONE transaction by the reviewed functions. Any refusal — the wrapper's or the function's own (stale version, lease, open case, superseded evidence, …) — rolls back BOTH. There is no state with evidence but no record.
- **PRE (refuse, nothing written):** schema-owner role; TEST instance; history exactly 0001–0027 with aggregate `f6f3b20b6be4a603a9fbc6472743dfa9e4d8af62c78156e90c13d34894147980`; full POST-27 identity (functions `137ea3dae9fb20cd8486598cc6ae71a4a619a34df51a096df501cdda07c15e82`); admin-only EXECUTE on the recording / evidence functions; quiescence (run lock, work / intent / operation leases, in-flight operations, unsettled kickoff requests, prepared transactions, other write locks); no record anywhere yet; the bound intent TEST / confirmed / expected version / reservation / listing / USD / captured == final == expected; exactly one held claim of its own; its confirmation SENT (one succeeded attempt-1 operation, one gn-v2 render, one typed receipt, no latch); the observation fresh (≤ now, ≥ now − 24 h, ≥ the cancellation time) and later than every earlier observation of that reservation.
- **POST (same transaction):** result exactly `[sent_preserved]` and its own claim released; no other claim changed; exactly one new evidence row; exactly one record + one `pending` attestation (no amount, no provider reference); projection exact; no latch; every other booking table row-for-row identical (intents, operations, renders, receipts, ledger, transitions, latches, refunds, kickoff requests, …); schema unchanged.
- **Replay:** the same bound text after success → `E7_C116_ALREADY_RECORDED_NOOP` (no write). Any other existing record → `E7_C116_EXISTING_RECORD_STOP`.
- **Uncertain issuance** (editor timeout / lost reply): run the readback FIRST; never re-issue blindly. If the record exists, the replay no-op confirms it; if not, nothing was written.
- **Refusal recovery:** stale version / not-fresh observation → re-read, re-bind, re-review; any other refusal → stop and investigate (no partial state exists).
- **Not here:** no provider call, send, refund, void, cancel, delete or latch; the later Stripe-dashboard refund is recorded, when it happens, by a separate reviewed `admin_attest_external_refund` step.
