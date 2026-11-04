# E7.4b-D1 D5: claim-to-confirmation binding (migration 0014) — IMPLEMENTATION CONTRACT, DOCS ONLY

**Branch.** `feature/e7-offline-charge-completion-binding-contract`, cut from exact `185da0e54e72cffdc28e84824d28ac5622c203f8`.

**Status.**
- **0013 is PRESENT and accepted offline at `185da0e`** (root ruling; Claude-run local PG only).
- **D5 / 0014 is PROPOSED** here and is not implemented.

**Labels.**
- **[00nn:a–b]**: source lines of `db/migrations/00nn_*.up.sql` at `185da0e`.
- **[PROPOSED-0014]**: this design.
- **[TRUST]**: input the database cannot attest.

**Boundaries.**
- No provider call, worker, adapter, route, UI, config, schedule or live action.
- No new public write primitive, dispatch or manual finalisation.
- No `paymentMethod` is selected or defaulted.
- Labels are [TRUST]: equality of `executorAccountRef` is **not** provider-account authentication.

---

## 1. Root decision being implemented

When a recording that **was claimed through the 0012 / 0013 fence** gets its first proof link, the persisted confirming evidence must satisfy both:

- `observed.executorAccountRef` = `A.account_ref` (= `A.cfg ->> 'accountRef'`);
- `observed.paymentMethod` = `A.cfg ->> 'paymentMethod'`.

Here `A` is the assessment cited by the **immutable** `recording_claim_assessments.assessment_id` of that operation. The anchor is never:
- the latest assessment;
- a caller-supplied config;
- a review;
- an earlier-epoch row.

---

## 2. Every path that attaches the first link or reports success (verified at `185da0e`)

| Path (signature, grant) | What it does today | Existing locks | D5 gap |
|---|---|---|---|
| `complete_recording_with_evidence(uuid,text,uuid,text,integer)`, app [0011:363–402] | in_flight → succeeded **with** link; `worker_fresh` proof, work + op lease, version, latest, attempt 1, no hold, no positive contradiction | intent S → work S → op U → advisory → `v_t` | proof validates the account-label **format** and the approved **method set** [0010:104, 110], not the claimed snapshot |
| `link_recording_evidence(uuid,uuid)`, app [0011:404–434] | succeeded (owner-resolved, unlinked) → link; `owner_historical` (≥ 15 min after dispatch), latest, no hold, no contradiction | intent S → op U → advisory → `v_t` | an op **with** a claim audit could be owner-resolved as succeeded and then linked with a proof of another method / account |
| `admin_resolve_recording_hold(…,'link_full_proof',…)`, admin [0011:753–817] | same `owner_historical` proof; link + decision + hold release in one transaction | intent S → op U → advisory → hold U → case U → `v_t` | same as above |
| `admin_resolve_operation(uuid,text,uuid[],text,text,text,timestamptz)`, admin [0005:296–384; recording branch 0005:327–339] | sets `succeeded` with an owner **resolution**, count-only evidence, **no link** | op U | none by itself (no link); D5 applies when a link is attached later |
| `settle_operation_from_evidence(uuid,uuid)`, app [0005:239–289] | only `retry_class = 'reconcile_first'` | — | not reachable: recordings are `non_idempotent` (`NOT_SETTLEABLE`) |
| `recording_lifecycle_guard()`, INVOKER trigger `zz0_` [0010:166–242, 245] | the **single choke point**: every transition into succeeded with a link (`worker_fresh` recheck) and every NULL → link on a succeeded row (`owner_historical` recheck), privileged only | runs inside the caller's locks | no claim binding |
| `zz_external_operations_settled_evidence_immutable` [0008:25] | refuses clear / repoint | — | unchanged |

**Conclusion.** Putting D5 in `recording_lifecycle_guard` covers **all three** attach paths, including owner-resolve-then-link and `link_full_proof`, with no per-function bypass. The explicit functions need no signature change.

---

## 3. Binding predicate [PROPOSED-0014]

New private function `booking.recording_completion_binding_refusal(p_op uuid, p_evidence uuid, p_worker text) RETURNS text`:
- SECURITY DEFINER, VOLATILE, `search_path = pg_catalog, booking`, `REVOKE ALL FROM PUBLIC`, no role grant;
- takes no lock and reads no clock;
- returns NULL when bound, otherwise a code.

| Step | Check (every comparison NULL-safe: `IS DISTINCT FROM` / `coalesce(…, false)`) | Code |
|---|---|---|
| 1 | `ca :=` the claim-audit row of `p_op`; none | `NO_CLAIM_AUDIT` |
| 2 | `A :=` the row with `A.id = ca.assessment_id`. Required: `A.operation_id = p_op = ca.operation_id`, `A.intent_id = ca.intent_id = op.intent_id`, `A.phase = 'preflight'`, `A.outcome = 'eligible'`, `A.epoch = ca.epoch`, `A.worker = ca.worker`, and `ca.epoch = recording_preflight_epoch(p_op)` (frozen after a claim: holds need a pending op) | `CLAIM_AUDIT_BINDING` |
| 3 | `p_worker IS NULL` (owner paths) or `p_worker = ca.worker` (worker path: the guard passes `OLD.lease_worker_id`) | `CLAIM_WORKER` |
| 4 | `jsonb_typeof(A.cfg->'accountRef') = 'string'`, `A.cfg->'accountRef' = to_jsonb(A.account_ref)`, `jsonb_typeof(A.cfg->'paymentMethod') = 'string'`, `A.cfg->>'paymentMethod' IN ('credit_card','other')` | `CLAIM_CONFIG_INVALID` |
| 5 | evidence row exists and `jsonb_typeof(o->'executorAccountRef') = 'string' AND o->'executorAccountRef' = to_jsonb(A.account_ref)` | `EXECUTOR_ACCOUNT_MISMATCH` |
| 6 | `jsonb_typeof(o->'paymentMethod') = 'string' AND o->'paymentMethod' = A.cfg->'paymentMethod'` | `PAYMENT_METHOD_MISMATCH` |

**Order and reuse.**
- The predicate runs **after** `recording_proof_refusal` has accepted the evidence. That function already binds intent, API source, list read, reservation, read time, the after-dispatch rule, the full exact key set, amount / currency / marker / title / status / type / provider / readCount, plus the label format and method set [0010:42–114].
- D5 adds only steps 1–6.

**Validated once versus rechecked.**
- Claim-audit, assessment and evidence rows are append-only and immutable (`reject_change` [0012:180–181, 202–203]; [0003] evidence triggers), so steps 1–2 and 4–6 are deterministic.
- They are nevertheless re-evaluated at every attach, inside the caller's existing locks, because that is cheap and needs no new lock.
- D5 does **not** require the claim-time assessment to still be fresh at completion. The proof keeps its own clock (`worker_fresh` 2 min / `owner_historical` ≥ 15 min), and the work / op leases keep theirs.

**Stated risk (not proven by equality).** The provider identity, credential or config may change between the claim and the completion. Equal labels are [TRUST] and do not prove the same account or method. This is a worker-integration risk to handle there (D5 is necessary, not sufficient).

---

## 4. Policy per path [PROPOSED-0014]

The policy lives in the replaced `recording_lifecycle_guard`:

| Guard branch | Policy |
|---|---|
| **Transition into `succeeded` WITH a link** (only `complete_recording_with_evidence`) | after the existing `worker_fresh` proof recheck: `recording_completion_binding_refusal(NEW.id, NEW.settled_evidence_id, OLD.lease_worker_id)` must be NULL. **`NO_CLAIM_AUDIT` refuses: fail closed.** A recording in flight without a claim audit (claimed before 0012) cannot complete through the worker path. It goes through the owner (outcome unknown → owner resolution) |
| **NULL → link on a succeeded row** (`link_recording_evidence`, `link_full_proof`) | after the existing `owner_historical` recheck: if a claim audit exists, the predicate must return NULL (`p_worker` NULL). **`NO_CLAIM_AUDIT` → the historical owner-maintenance policy:** allowed under the unchanged 0010 / 0011 rules, because no claim snapshot exists to bind to. The method / account of such inherited rows stay owner-attested [TRUST]. No audit is invented and no bypass flag exists |
| succeeded via owner resolution, no link (`admin_resolve_operation`) | unchanged; D5 applies when that row is later linked |
| everything else (no-link-repoint / clear, frozen fields, finalisation, holds, contradiction checks, 15-min historical rule) | unchanged |

Refusals raise `RECORDING_CLAIM_BINDING: <code>` (`check_violation`). The whole statement aborts, so the op, link, hold, case and claim audit stay untouched.

---

## 5. Migration 0014 [PROPOSED-0014]

**Up:**
1. The precondition is 0013 applied.
2. `CREATE FUNCTION booking.recording_completion_binding_refusal(uuid, uuid, text)` (private, §3).
3. `CREATE OR REPLACE FUNCTION booking.recording_lifecycle_guard()`: the body of [0010:166–242] verbatim, plus two marked `-- 0014` blocks (§4). Same INVOKER / `search_path` / ACL; the trigger `zz0_recording_lifecycle_guard` is unchanged.

**Not changed:**
- the complete / link / owner functions and their signatures and grants;
- JS beyond adding `RECORDING_CLAIM_BINDING` to `DB_SAFETY_CODES` (`lib/booking-db/repo.js`).

**No new table and no durable feature marker:** the existence of the claim audit row *is* the D5 marker (every fenced claim since 0012 writes one atomically).

**Down:**
1. Restore `recording_lifecycle_guard` verbatim from [0010:166–242] (generator).
2. Drop `recording_completion_binding_refusal`.
3. Equivalence: a fresh cluster at 13.

0014 stores no data, so no audit can be lost.

**Rollback precondition (recommended, R-D5):**
- Refuse down (`DOWNGRADE_REFUSED_RECORDING_COMPLETION_BINDING`) while a D5-governed attach is still possible: any recording **with a claim audit** that is `in_flight`, or `succeeded` with `settled_evidence_id IS NULL`. Otherwise allow.
- This is honest about the risk: down silently re-enables unbound attaches only where one is still possible.
- Alternative: an unconditional down (no data loss, weaker check afterwards).

**Compatibility:**
- 0013 code on schema 14 works (no signature changes).
- A worker completion of a pre-0012 in-flight row now refuses by design.

Migrations 0001–0013 stay byte-identical.

---

## 6. Planned local-PG tests (focused `e74b-d1-completion-binding.test.mjs`; full TAP)

| # | Scenario |
|---|---|
| C-1 | method + account match → succeeded + link; finalisation unchanged |
| C-2 | account mismatch only; method mismatch only (fixture uses the other approved value) → `RECORDING_CLAIM_BINDING`; op stays in flight, no link, audit unchanged |
| C-3 | malformed / mistyped / NULL D5 fields → refused by the 0010 proof (format / set) before D5; D5 codes for wrong values |
| C-4 | evidence of another op / intent / read → existing proof refusals; D5 never reached |
| C-5 | missing claim audit: a pre-0012-style in-flight row (labelled owner-managed history) → worker completion refused `NO_CLAIM_AUDIT`; the owner-resolve + historical link of such a row is allowed |
| C-6 | two release cycles → claim at epoch 2 → the binding uses the epoch-2 assessment's cfg; a proof matching an older epoch's different cfg is refused |
| C-7 | an injected later assessment / review (owner TEST SETUP) never replaces the anchor |
| C-8 | an op WITH audit: owner-resolve succeeded, then `link_recording_evidence` / `link_full_proof` with a mismatched method or account → refused; with the matching proof → linked |
| C-9 | work / op lease expiry and proof ageing after waits → existing refusals unchanged; D5 does not require claim-time freshness |
| C-10 | unchanged: no repoint / clear, positive-contradiction refusal, active-hold refusal, 15-min historical rule |
| C-11 | atomic refusal: op, link, holds, cases and claim audit byte-identical before and after |
| C-12 | grants: the predicate is private (app / admin / report denied); guard security unchanged |
| C-13 | down: refused while a D5-governed attach is possible; otherwise == fresh 13 (bodies / ACLs / security / volatility / search_path / triggers / constraints / indexes / policies / RLS); identical re-up |

**Regressions:** all 0010–0013 suites unchanged, incl. R1 / R2, T-C10, page microseconds, A- / B- / D- tests.

**Mutation targets:**
- each of steps 1–6;
- the worker-path `NO_CLAIM_AUDIT` fail-closed branch;
- the historical branch (must stay allowed);
- worker equality;
- anchor = audit (not the latest row);
- the down gate.

---

## 7. Choices for root (recommended first) and open items

| # | Choice | Recommendation |
|---|---|---|
| D5-a | where | the single lifecycle guard (covers all attach paths); not per-function copies |
| D5-b | missing audit, worker path | fail closed (`NO_CLAIM_AUDIT`) |
| D5-c | missing audit, owner maintenance | the historical policy: allowed under the unchanged 0010 / 0011 rules, labelled [TRUST] |
| D5-d | marker | none: the claim audit row is the marker |
| R-D5 | rollback | refuse while a D5-governed attach is possible; otherwise allow |

**Open (not blocking 0014 offline):**
- the owner's `paymentMethod` choice;
- live-unverified provider shapes;
- all live gates;
- worker integration (identity / config drift between claim and completion);
- the unexplained historical e74a guard failure.

## 8. Implementation sequence (after root acceptance)

1. 0014 up / down (generator for the verbatim guard).
2. The `DB_SAFETY_CODES` entry.
3. The focused test file + fixture variants (a proof with a chosen method / account).
4. Targeted mutants.
5. Focused + migration + offline + D1 / D2 suites, then `npm test` and `test:db`.
6. Docs map; commit / push; one ping; stop.
