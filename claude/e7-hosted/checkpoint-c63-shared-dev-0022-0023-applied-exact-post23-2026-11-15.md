# Checkpoint C63 — shared DEV 0022 → 0023 APPLIED and verified exact POST 23 (+ C57–C60 sending-domain milestone)

**Status: CLOSED — VERIFIED COMPLETE.** Shared DEV TEST (`mxotevtiscernhqilyiu`, "maraVilla Booking DEV") is at the exact reviewed POST state, schema 1..23. **Never reapply 0022 / 0023.**

**Attribution:**
- **[Joel-reported]**: Joel's own action.
- **[ROOT-obs 2026-11-15]**: ROOT's own observation or action.
- **[Claude-obs]**: Claude's built-in browser.

Claude ran no shared query or apply and took no provider, credential or send action for this checkpoint. Exact tool-call seconds are **UNRECORDED** unless stated.

---

## 1. Packet (immutable, unchanged)
| item | value |
|---|---|
| Packet commit | C46 merge `d322d2192b377d18b6a9280ae06c17eddfe3e73e` (#115); artifacts byte-identical at e7-test `46b3eaf801fd3c85e268e3bbdc7d20b7078cdd89` |
| Wrapper | `claude/e7-0022-0023-sqleditor-apply-v1.sql`, sha256 `9a8190cfeeec5ea09d1d239b95b582415810fe0c57d939083b1d1f40092ac030`, 117193 B |
| Readback | `claude/e7-0022-0023-readback-v1.sql`, sha256 `dea64d95bed2917efced332a55bff68654bdd82d94a9ee8bae92ea91757eb45a` |
| Pins | `claude/e7-0022-0023-pins-v1.json`, sha256 `f83913c7c90a3b7768b3b981e122d65540d3d5bac15d2073ac80279e1c105640` |
| Operator sequence | `claude/e7-0022-0023-apply-operator-sequence.md` |

No packet, pin, migration, runtime, workflow or test file was rewritten.

## 2. Issuance history (historical only — superseded by §3)
- **2026-11-14** [ROOT-obs]: Supabase `apply_migration` connector confirmations twice returned `status=expired`. Each readback showed schema 1..21, unchanged. Durable checkpoint `5905950453`.
- **2026-11-15 (C61)** [ROOT-obs]: one connector submission returned `status=declined` ("Migration was declined."). No cause was given, and none is inferred. Readback was byte-identical to PRE; nothing was applied.
- **2026-11-15** [ROOT-obs]: a renewed connector request stalled and was aborted. No connector confirmation reached Joel; no UI-setting diagnosis was established.
- **2026-11-15 (C62)** [Claude-obs]: Claude's session has no Supabase connector (`ListConnectors` returned `[]`), so Claude stopped at the capability check.

These attempts applied nothing. **The issuance blocker is now RESOLVED** by the human SQL-editor run in §3.

## 3. The apply (C63 — reviewed C46 human SQL-editor procedure)
1. **PRE** [ROOT-obs]: a fresh reviewed pure-SELECT readback was exact PRE.
   - Schema 1..21; every identity key equals `pins.pre`.
   - Instance `test`; schema owner `postgres`.
   - All active lease / lock / in-flight / prepared exclusions are 0 / false.
   - `renders_non_gn_v1_or_meta` 0; receipts `null`.
   - The stalled connector attempt had applied nothing.
2. **Editor preparation** [ROOT-obs]:
   - In the existing authenticated dashboard, ROOT pasted the unchanged d322d219 wrapper into private SQL query `b16b126f-42d1-4746-b766-387ef86de543`.
   - ROOT copied the entire editor back (Ctrl+A / Ctrl+C): 117193 B, sha256 `9a8190cf…ac030`, **exact = true**.
   - ROOT did **not** click Run.
3. **Run** [Joel-reported]: Joel clicked **Run once** himself in that prepared editor. This was not the connector. The exact time is UNRECORDED.
4. **Browser result** [Joel-reported + ROOT-obs browser result], status row `e7_23_status`:

   | field | value |
   |---|---|
   | `v22` | true |
   | `v23` | true |
   | `receipts_rows` | 0 |
   | `migrations_max` | 23 |
   | `functions_sha256` | `50a50a7fbea38e8dd59ddd9f1094bcbd776fd465a2053f0430f0f1a4cb03ea84` (= reviewed POST) |
   | `claim_guest_notification_v2` | true |
   | `complete_guest_notification_resend` | true |

   ROOT observed this **status row**. An `E7_23_APPLIED` notice line was not reported as visible, so none is claimed.
5. **AFTER readback** [ROOT-obs]: an independent, reviewed, pure-SELECT connector readback.
   - Every identity key equals `pins.post`; `mismatches: []`.
   - Migrations min 1 / max 23 / count 23.
   - Aggregate 0001-0023 is `7df0b8fe542b7f85f43bdaf7138438c71627b7bc88a48104314eeb1482270ef0`; the original 0001-0021 aggregate `5473ec1de85742ebb2f7a3638b1a6a42ae20be219a8a0e637a425861e6698e51` is unchanged.
   - The 22 / 23 history rows carry the manifest's up / down checksums:
     - up22 `cc878c94…0caa0`, down22 `d7fbd065…f348`;
     - up23 `c551539b…65cb`, down23 `fb75b41e…caa0`.
   - **The full existing data object is JSON-equal (TRUE) to the immediate C63 PRE.** That covers all 29 pre-existing table counts and whole-row fingerprints, the original 12 render columns, the intent id set, and the original history rows.
   - `notification_provider_receipts` rows 0; `renders_non_gn_v1_or_meta` 0; all 6 exclusion values 0 / false.

**Conclusion:** the database is at the actual, applied, exact reviewed POST 23. No provider state changed, and no queue processing is claimed.

## 4. Sending-domain milestone (C57–C60, 2026-11-15)
- **[Claude-obs] C57:** read-only Squarespace inspection.
  - `micasadirect.com` is Active on Squarespace-managed nameservers `ns-cloud-c1..c4.googledomains.com`, with presets only and no conflicting records.
- **[Claude-obs] C58 drafts / [Joel] saves:** Claude filled each unsaved DNS form; Joel completed the passkey step-up and clicked SAVE on each record. The three records:

  | type | host | value | TTL |
  |---|---|---|---|
  | TXT | `resend._domainkey.mail` | Resend public DKIM key | 1 hr |
  | CNAME | `rsend.mail` | `rsend.forge.rmta.net` | 1 hr |
  | CNAME | `send.mail` | `send.forge.rmta.net` | 1 hr |

  The apex website, SPF, DMARC and null-DKIM presets are unchanged.
- **[ROOT-obs] public DNS:** all three records resolve exactly (Status 0), TTL 3600.
- **[ROOT-obs] C60 final:** Resend domain `mail.micasadirect.com` (`ff83db00-e6e0-432b-97c8-078124a12143`) is **VERIFIED / Ready**.
  - All three records are verified; the domain-verified event is at 2026-11-15 15:59Z.
  - Receiving is OFF. The earlier PENDING state is historical.
- **Sender:** `bookings@mail.micasadirect.com` / `MiCasaDirect` is source-approved (#120 / #121) and the domain is verified. **This is not mail delivery and not permission to send.**

## 5. State unchanged
- **No email sent.**
- The five booking runner flags and the notification runner `executeEnabled` stay **false**; the runtime stays **CLOSED**.
- The recipient scope stays `.invalid` only.
- Preserved and untouched:
  - historical intents `abede8b1-…` and `c83c1842-…`;
  - held claims;
  - the pristine queued notify row;
  - the two unprocessed inbox rows.
- No refund, cancel, inbox, claim, provider or booking action. **Refunds remain manual** and policy-assessed; no automated refunds are enabled or authorized.

## 6. Next
The runtime stays CLOSED. ROOT reviews a bounded notification next step under its own review, fences and gates. This checkpoint authorizes no live action.
