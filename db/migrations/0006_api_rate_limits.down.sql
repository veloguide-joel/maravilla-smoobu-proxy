-- 0006_api_rate_limits (down) — DEV/test only. Restores the 0005 schema exactly.
DROP INDEX booking.intents_access_token_hash_key;
DROP FUNCTION booking.rate_limit_hit(text, integer, integer);
DROP TABLE booking.api_rate_limits;
