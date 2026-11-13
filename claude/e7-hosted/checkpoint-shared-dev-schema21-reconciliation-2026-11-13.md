# Checkpoint — shared DEV at schema 0021: reconciliation of current status (2026-11-13)

## Correction of record
Claude's handoff (`root-handoff-new-chat-2026-11-13.md`, §6) and its first message in the new ROOT chat said shared DEV was still schema 18. **That was stale.** ROOT applied 0019/0020 and then 0021 to shared DEV on 2026-11-13 between 14:19Z and 14:25Z (08:19–08:25 CDMX) via the dashboard SQL editor, and recorded GO / POST PASS reviews on PRs #71 and #78. Claude verified those review records exist on GitHub (ids, timestamps, bodies below). Claude ran **no** shared query. The handoff doc is preserved as written, with a correction banner added at its top.

## ROOT review records (GitHub, PR review comments by veloguide-joel = ROOT)
| Review id | PR | UTC | Content |
|---|---|---|---|
| 5892578716 | #71 | 2026-11-13 14:19:23 | GO: ONE new attempt, dashboard SQL editor, exact merged e38e5592 artifact SHA `528eeee5…5425`, no byte edits / split / down. PRE: 19 identity keys match pins.pre, schema 18, history 1..18, leases / in-flight / P3 locks clear. Quiescence correction: two expired 2026-11-06 `price_confirmed` quotes exist (no checkout session / PI / lease) — rows must remain unchanged. Covers ONLY 0019+0020. |
| 5892633549 | #71 | 2026-11-13 14:22:46 | **0019/0020 POST PASS.** Editor text SHA-256 96 075 bytes = `528eeee5…5425`; result v19=true / v20=true / migrations_max 20 / functions `5ad41abb…a086`. Separate pure-SELECT readback (`3993363d…c809`): all 19 POST identity keys match pins.post, tracking 19/20 exact, history 1..18 aggregate unchanged, instance TEST, all 28 booking-table row fingerprints byte-identical PRE→POST (incl. the two expired quotes). |
| 5892634706 | #78 | 2026-11-13 14:22:50 | GO: separate ONE attempt for 0021, exact merged 63adbc59 artifact SHA `53ad7869…b4b2`. PRE: all 20 identity keys match pins.pre, history 1..20 aggregate `a1c2821d…f183`, TEST, leases / in-flight / P3 lock 0. |
| 5892671916 | #78 | 2026-11-13 14:25:10 | **0021 POST PASS.** Editor text SHA-256 126 789 bytes = `53ad7869…b4b2`; result v21=true / migrations_max 21 / mirrored_column=true / functions **`bc3a24df47ec6ffb9937609979e4db45921bdd4093f8cbac2f65c87b35b2c1cb`**. Readback (`aff1ca5d…0773`): all 20 POST identity keys match pins.post, tracking 21 (up `79017a94…7db7` / down `b6a973b4…4557`), history 1..20 aggregate unchanged, all 28 PRE-column/PRE-table fingerprints unchanged, `settlement_recording_mirrored IS NOT NULL` count 0, `notification_suppressions` count 0, advisory locks 0 / prepared tx 0; vocabulary_objects new count 2 = expected after 0021. |

ROOT's additional pure SELECT in the new chat (2026-11-13 ~16:25Z) against the shared instance: `booking_migrations.applied` count 21 / min 1 / max 21 / versions exactly 1..21.

## Current status (supersedes every earlier "shared still 18" line)
- **Shared DEV (instance TEST) = schema EXACTLY 0001..0021.** Do NOT reapply any migration.
- The earlier stalled `apply_migration` tool issuance (checkpoint-shared-apply-attempt-no-outcome-2026-11-12.md) remains **historically UNKNOWN**; its cause is unproven. The SQL-editor route succeeded; that proves the route, not the cause.
- Active-checkout correction: the earlier coarse count used the wrong state name; the true picture is two expired 2026-11-06 `price_confirmed` quotes, no checkout session / PI / lease. Preserve those rows; no repair.
- main = `f97c6495` (tree `9dbf6af2`), e7-test = `63adbc59` — unchanged by the applies.
- All five hosted runners `executeEnabled=false`; D4 / provider / queue / live-run HOLD; recording/mirror path CLOSED for the next test. The schema/transport prerequisite is CLOSED.

## Immutable 0021 artifacts (e7-test `63adbc594686fafb0cbb8d3b1e5c2740e40ed2ae`) — for ROOT's focused identity comparison
Fetch any of them bytes-exact with `git show 63adbc59:<path>` (or the raw GitHub URL at that commit). SHA-256 as committed:
| Path | SHA-256 | Role |
|---|---|---|
| `claude/e7-0021-readback-v1.sql` | `aff1ca5def619c75581de7fed5f2fadce3c05ee4bcb3afed19fa3df37a750773` | pure-SELECT POST readback (identity keys, tracking row, history aggregate, PRE-column fingerprints, NULL-column / empty-table asserts) |
| `claude/e7-0021-pins-v1.json` | `8e647afe462d049d3cf810e0e2cbead41552d4fcbe741b933f30d70051c04d4b` | pins.pre (20 keys; functions `5ad41abb…a086`, history `a1c2821d…f183`) and pins.post (20 keys; functions `bc3a24df…c1cb`) |
| `claude/e7-0021-sqleditor-apply-v1.sql` | `53ad7869ef01d1672a99ede21b7c569daa64be67c2fac8b2707a93b90800b4b2` | the applied batch (matches ROOT's editor-text hash, 126 789 bytes) |
| `claude/e7-0021-inventory.sql` | `c456f8258cb12c111b8fb2fcf75755c3435a1b5924f8b37f1131a2e45c1e20fa` | inventory used to derive the pins |
| `claude/derive-0021-pins.mjs`, `claude/gen-0021-wrapper.py` | (source) | pin derivation / wrapper generator |
| `test/db/e7-0021-sqleditor-apply-wrapper.test.mjs` | (source) | 8 disposable tests incl. row-mutation rollback challenge |

## Immutable 0019/0020 artifacts (e7-test `e38e5592`)
| Path | SHA-256 |
|---|---|
| `claude/e7-0019-0020-readback-v1.sql` | `3993363d9acd2595f601dcb75ccaf296767416112558829a9baf9fbb3843c809` |
| `claude/e7-0019-0020-pins-v1.json` | `9edf7888248d76fb476de3712c915b76d1545f71585640d28ff1048eb6619c43` |
| `claude/e7-0019-0020-sqleditor-apply-v1.sql` | `528eeee53a89dd4f5b072fe2f7ce1f8f28f0e11d87ef08bd95ebc8fc5562f425` (96 075 bytes, matches ROOT's editor-text hash) |
| `claude/e7-0019-0020-inventory.sql`, `claude/derive-0019-0020-pins.mjs`, `claude/gen-0019-0020-wrapper.py` | (source) |

## Docs superseded on the "shared still 18" point (kept for history)
`root-handoff-new-chat-2026-11-13.md` (§6, §9.2), `checkpoint-pr79-merged-f97c6495-integrated-rehearsal-2026-11-12.md` (Holds), `checkpoint-pr78-merged-63adbc59-0021-apply-packet-2026-11-12.md`, `checkpoint-shared-apply-attempt-no-outcome-2026-11-12.md` (still accurate as history of the UNKNOWN tool attempt).
