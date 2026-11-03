-- 0009_void_cancel_claim_fence (down) — DEV/test only. Restores the 0008 schema exactly.
DROP TRIGGER external_operations_void_cancel_claim_fence ON booking.external_operations;
DROP FUNCTION booking.void_cancel_claim_fence();
