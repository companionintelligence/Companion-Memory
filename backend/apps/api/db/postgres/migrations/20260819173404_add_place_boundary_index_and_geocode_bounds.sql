-- migrate:up
-- #2161 (follow-up to #1811). Makes ci.entities.location_boundary a real,
-- queryable polygon rather than the placeholder column #1813 left behind.
--
-- 1. The boundary column shipped with no spatial index — its sibling
--    location_point got entities_location_point_gix, the polygon got nothing —
--    so any containment query would seq-scan every Location row. This is the
--    index placesContaining (ST_Covers) runs on.
--
-- 2. ci.geocode_cache gains `bounds`: Google returns geometry.bounds (the real
--    footprint, present exactly for the areas where a polygon matters — cities,
--    neighbourhoods, parks) and geometry.viewport (a display box, present for
--    everything). Both were parsed away. Caching them alongside the coordinates
--    means a place resolved from cache still gets its footprint, without a
--    second billed provider call.
--
-- Stored as {north, south, east, west} rather than a geometry so the cache row
-- stays provider-shaped; PlaceService builds the polygon via ST_MakeEnvelope.

CREATE INDEX IF NOT EXISTS entities_location_boundary_gix
  ON ci.entities USING GIST (location_boundary)
  WHERE entity_type = 'Location' AND location_boundary IS NOT NULL;

ALTER TABLE ci.geocode_cache
  ADD COLUMN IF NOT EXISTS bounds JSONB;

COMMENT ON COLUMN ci.geocode_cache.bounds IS
  'Provider bounding box for the result, {north, south, east, west} in WGS84 degrees. Prefers Google geometry.bounds (true footprint) over geometry.viewport (display box). NULL when the provider returned neither, or for rows cached before this column.';

-- migrate:down
ALTER TABLE ci.geocode_cache
  DROP COLUMN IF EXISTS bounds;

DROP INDEX IF EXISTS ci.entities_location_boundary_gix;
