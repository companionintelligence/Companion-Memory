-- migrate:up
-- Forward-geocode cache for location_name -> location_coordinates backfill
-- (geodata-plan Phase 1). One row per *canonical* query string so repeated
-- lookups of the same address (across events, re-runs of the backfill) hit the
-- cache instead of Google. Negative results are cached too: a ZERO_RESULTS /
-- REQUEST_DENIED row stops us from re-billing a query that will never resolve.
--
-- query_hash is the PK: sha256 of the *canonical* form of raw_query
-- (trim + lowercase + collapse whitespace + strip punctuation), computed in
-- application code (GeocodeService.canonicalize) so the normalization rule lives
-- in one place. lat/lng are nullable (negative cache). status mirrors Google's
-- JSON `status` field (OK | ZERO_RESULTS | REQUEST_DENIED | INVALID_REQUEST |
-- OVER_QUERY_LIMIT | UNKNOWN_ERROR | virtual).
CREATE TABLE IF NOT EXISTS ci.geocode_cache (
  query_hash         text        PRIMARY KEY,
  raw_query          text        NOT NULL,
  normalized_address text,
  place_id           text,
  lat                double precision,
  lng                double precision,
  components         jsonb       NOT NULL DEFAULT '{}',
  status             text        NOT NULL,
  partial_match      boolean     NOT NULL DEFAULT false,
  location_type      text,
  hit_count          integer     NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Status lookups for backfill analytics / negative-cache scans.
CREATE INDEX IF NOT EXISTS geocode_cache_status_idx ON ci.geocode_cache (status);

-- migrate:down
DROP TABLE IF EXISTS ci.geocode_cache;
