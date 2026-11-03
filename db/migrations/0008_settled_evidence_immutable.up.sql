-- 0008_settled_evidence_immutable (up) — Stage E7.1a (offline). DISPOSABLE LOCAL test databases only.
--
-- Trust boundary: the runtime role may record verified provider API evidence (booking.record_provider_evidence binds it
-- to a succeeded read; the database cannot authenticate the provider), and booking.settle_operation_from_evidence may
-- link an ambiguous operation to that evidence ONCE (NULL -> first evidence). From then on the persisted settlement
-- evidence is part of the audit record: no role — runtime, admin or owner — may clear or repoint
-- external_operations.settled_evidence_id, in any UPDATE, including updates that leave the operation state unchanged.
-- Re-writing the same id is a no-op and allowed. Legitimate flows are unchanged: the settler only ever sets it from NULL,
-- and owner resolutions (booking.admin_resolve_operation) never touch it.
--
-- The trigger is named with a "zz_" prefix so it fires AFTER every other BEFORE UPDATE trigger on the table (PostgreSQL
-- fires them in name order) and therefore checks the final NEW row. Its function only reads OLD/NEW: no table access,
-- no SECURITY DEFINER, fixed search_path, and EXECUTE revoked from PUBLIC. No grant changes.
CREATE FUNCTION booking.settled_evidence_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.settled_evidence_id IS NOT NULL AND NEW.settled_evidence_id IS DISTINCT FROM OLD.settled_evidence_id THEN
    RAISE EXCEPTION 'SETTLED_EVIDENCE_IMMUTABLE: operation % is settled from evidence %; it cannot be cleared or repointed',
      OLD.id, OLD.settled_evidence_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION booking.settled_evidence_immutable() FROM PUBLIC;
-- No WHEN clause: the condition lives in ONE place (the function), so it cannot drift between two copies.
CREATE TRIGGER zz_external_operations_settled_evidence_immutable BEFORE UPDATE ON booking.external_operations
  FOR EACH ROW EXECUTE FUNCTION booking.settled_evidence_immutable();
