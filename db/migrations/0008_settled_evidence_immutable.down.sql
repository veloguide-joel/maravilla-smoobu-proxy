-- 0008_settled_evidence_immutable (down) — restores the 0007 schema exactly.
DROP TRIGGER zz_external_operations_settled_evidence_immutable ON booking.external_operations;
DROP FUNCTION booking.settled_evidence_immutable();
