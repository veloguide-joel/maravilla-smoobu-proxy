-- 0029 down. Refused once any taxed price exists: its total could not satisfy the pre-P1 arithmetic. Otherwise restores 0001 exactly.
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM booking.intents WHERE tax_minor <> 0) THEN
    RAISE EXCEPTION 'MIGRATION_0029_DOWN_REFUSED: taxed prices exist' USING ERRCODE = 'restrict_violation';
  END IF;
END $$;
ALTER TABLE booking.intents
  DROP CONSTRAINT price_tax_policy,
  DROP CONSTRAINT price_arithmetic,
  ADD CONSTRAINT price_arithmetic CHECK (final_total_minor IS NULL OR (
    discount_minor <= eligible_minor AND eligible_minor <= standard_total_minor
    AND standard_total_minor - discount_minor = final_total_minor));
ALTER TABLE booking.intents DROP COLUMN tax_minor;
