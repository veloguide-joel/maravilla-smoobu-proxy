-- 0006_api_rate_limits (up) — Stage E6 (offline). Authorized for DISPOSABLE LOCAL test databases only; no hosted database
-- change is part of this stage.
--   * booking.api_rate_limits: fixed-window counters shared by every worker (durable, database clock). Buckets are opaque
--     "<scope>:<64 hex>" keys computed by the app as HMAC(salt, ip|token-hash): no IP address or token is stored.
--   * booking.rate_limit_hit(bucket, window_seconds, limit) -> true while the bucket is within its limit. The only write
--     path; the runtime role has no direct table privilege.
--   * Expiry: every call also deletes at most 100 CLOSED windows of ANY bucket older than 25 hours (retention > the 24 h
--     maximum window, so no open window is ever touched), oldest first, skipping rows another session holds (SKIP LOCKED).
--     One-use buckets (random tokens, single addresses) therefore never accumulate. Indexed on window_start.
--   * A unique index on intents.access_token_hash: the intent API finds an intent only by the SHA-256 of its bearer token.
-- Unreleased: applied only to disposable local test databases so far; amended in place before any persistent use.

CREATE TABLE booking.api_rate_limits (
  bucket        text        NOT NULL CHECK (bucket ~ '^[a-z_]{1,32}:[0-9a-f]{64}$'),
  window_start  timestamptz NOT NULL,
  hits          integer     NOT NULL CHECK (hits >= 1),
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX api_rate_limits_window_start_idx ON booking.api_rate_limits (window_start);
ALTER TABLE booking.api_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON booking.api_rate_limits FROM PUBLIC;

CREATE FUNCTION booking.rate_limit_hit(p_bucket text, p_window_seconds integer, p_limit integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, booking AS $$
DECLARE w timestamptz; n integer;
BEGIN
  IF p_bucket IS NULL OR p_bucket !~ '^[a-z_]{1,32}:[0-9a-f]{64}$'
     OR p_window_seconds IS NULL OR p_window_seconds NOT BETWEEN 1 AND 86400
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'invalid rate limit parameters' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  w := to_timestamp(floor(extract(epoch FROM statement_timestamp()) / p_window_seconds) * p_window_seconds);
  INSERT INTO booking.api_rate_limits AS r (bucket, window_start, hits) VALUES (p_bucket, w, 1)
    ON CONFLICT (bucket, window_start) DO UPDATE SET hits = r.hits + 1
    RETURNING r.hits INTO n;
  DELETE FROM booking.api_rate_limits WHERE bucket = p_bucket AND window_start < w;   -- older windows of this bucket
  -- bounded global expiry of closed windows (any bucket), concurrency-safe
  DELETE FROM booking.api_rate_limits r USING (
      SELECT bucket, window_start FROM booking.api_rate_limits
       WHERE window_start < statement_timestamp() - interval '25 hours'
       ORDER BY window_start LIMIT 100 FOR UPDATE SKIP LOCKED) old
   WHERE r.bucket = old.bucket AND r.window_start = old.window_start;
  RETURN n <= p_limit;
END $$;
REVOKE ALL ON FUNCTION booking.rate_limit_hit(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION booking.rate_limit_hit(text, integer, integer) TO mv_booking_app;

CREATE UNIQUE INDEX intents_access_token_hash_key ON booking.intents (access_token_hash);
