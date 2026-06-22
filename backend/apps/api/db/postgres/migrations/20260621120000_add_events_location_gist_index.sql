-- migrate:up
-- GIST index backing the map "Search this area" viewport filter. The bbox query
-- casts the geography column to geometry —
--   ST_Within(location_coordinates::geometry, ST_MakeEnvelope(minLon,minLat,maxLon,maxLat,4326))
-- — so this is a FUNCTIONAL GIST index on that exact cast expression; a plain
-- GIST index on the raw geography column would not be picked for the geometry
-- predicate. Partial on non-null coordinates (only located events are ever
-- matched) keeps the index small.
CREATE INDEX IF NOT EXISTS events_location_coordinates_gix
  ON ci.events USING GIST ((location_coordinates::geometry))
  WHERE location_coordinates IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS ci.events_location_coordinates_gix;
