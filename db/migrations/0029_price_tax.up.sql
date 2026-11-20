-- 0029 (P1, owner decision 2026-11-20): taxes on the checkout total.
--
-- Owner rule: 16% IVA + 5% state lodging tax are ADDED to every total (lib/checkout/tax-policy.js; price version final-price-v2).
-- The stored E3 price object (price_snapshot) is the single source: it is immutable after PRICE_CONFIRMED (0021) and already pinned
-- field-by-field to the typed columns (price_snapshot_matches). This migration only teaches the arithmetic invariant about tax:
--
--   tax_minor            GENERATED from price_snapshot->>'taxMinor' (0 for every pre-P1 / untaxed price) -- no writer can set it apart
--   price_arithmetic     standard_total_minor - discount_minor + tax_minor = final_total_minor
--   price_tax_policy     a taxed price names its policy version; an untaxed price names none
--
-- final_total_minor stays "what the guest pays" (authorization, capture, Hostaway total, ledger): nothing else changes meaning.
-- No data is modified: every existing row has no taxMinor, so tax_minor = 0 and the old invariant is the same statement.
SET LOCAL lock_timeout = '5s';

ALTER TABLE booking.intents
  ADD COLUMN tax_minor bigint GENERATED ALWAYS AS (COALESCE((price_snapshot ->> 'taxMinor')::bigint, 0)) STORED;

ALTER TABLE booking.intents
  DROP CONSTRAINT price_arithmetic,
  ADD CONSTRAINT price_arithmetic CHECK (final_total_minor IS NULL OR (
    discount_minor <= eligible_minor AND eligible_minor <= standard_total_minor
    AND tax_minor >= 0
    AND standard_total_minor - discount_minor + tax_minor = final_total_minor)),
  ADD CONSTRAINT price_tax_policy CHECK (
    (tax_minor > 0) = (price_snapshot IS NOT NULL AND price_snapshot ? 'taxPolicyVersion')
    AND (price_snapshot IS NULL OR NOT (price_snapshot ? 'taxPolicyVersion')
         OR (price_snapshot ->> 'version' = 'final-price-v2'
             AND (price_snapshot ->> 'preTaxTotalMinor')::bigint = standard_total_minor - discount_minor)));
