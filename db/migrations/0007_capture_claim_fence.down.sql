-- 0007_capture_claim_fence (down) — DEV/test only. Restores the 0006 schema exactly.
DROP TRIGGER external_operations_capture_claim_fence ON booking.external_operations;
DROP FUNCTION booking.capture_claim_fence();
