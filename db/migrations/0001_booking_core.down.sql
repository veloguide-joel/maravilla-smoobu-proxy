-- 0001_booking_core (down) — DEV/test only. Drops the whole booking schema and every row in it.
-- Production policy is forward-only fixes; this file exists for local tests and the DEV database (test data only).
-- The btree_gist extension is left installed (it may be shared and is harmless).
DROP SCHEMA booking CASCADE;
