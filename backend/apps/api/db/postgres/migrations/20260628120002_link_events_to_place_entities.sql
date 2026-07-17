-- migrate:up
-- =============================================================================
-- Link located events to Place (ci.entities entity_type='Location') rows.
-- =============================================================================
--
-- Before this migration: reverse-geocode populates events.location_name from
-- coordinates (see GeocodeBatchListener.handleReverseBatch), but never creates
-- a corresponding ci.entities row — so every event.location_entity_id is NULL
-- and queries like "events at <place>" can't traverse the graph.
--
-- This migration:
--   1. Adds a partial UNIQUE index on ci.entities that's the upsert key for
--      reverse-geocode-sourced Place rows: (owner_user_id, normalized name,
--      coords rounded to 3 decimal places ≈ 110 m). Same name + same rounded
--      coords = same Place. 3dp absorbs GPS jitter (different EXIF sources
--      report a single address as 5–10 m apart) without merging geographically
--      distinct places that happen to share a generic name ("Starbucks").
--   2. Backfills one ci.entities row per distinct (user, name, rounded coords)
--      group from existing reverse-geocoded events.
--   3. Sets events.location_entity_id on every reverse-geocoded event to point
--      at its new Place row.
--
-- Going forward, GeocodeBatchListener calls PlaceService.findOrCreateForGeocode
-- against this same unique index, so new reverse-geocodes don't accumulate
-- orphaned rows.

-- 1. Partial unique index — the upsert key for reverse-geocoded Places.
--    Scoped to entity_type='Location' AND properties.source='reverse_geocode'
--    so it doesn't conflict with user-created Location rows (createPlace
--    mutations) that have no lat/lng in properties.
CREATE UNIQUE INDEX IF NOT EXISTS entities_reverse_geocode_dedup_idx
  ON ci.entities (
    owner_user_id,
    lower(btrim(name)),
    round(((properties->>'lat')::numeric), 3),
    round(((properties->>'lng')::numeric), 3)
  )
  WHERE entity_type = 'Location'
    AND properties->>'source' = 'reverse_geocode'
    AND name IS NOT NULL
    AND btrim(name) <> '';

-- 2. Insert one Location entity per distinct (user, normalized name, rounded
--    coords) group. min(location_name) picks a deterministic display casing
--    when the same normalized name appears with multiple casings.
INSERT INTO ci.entities (entity_type, owner_user_id, name, properties)
SELECT
  'Location',
  user_id,
  min(location_name) AS name,
  jsonb_build_object(
    'source', 'reverse_geocode',
    'type', 'address',
    'lat', round(ST_Y(location_coordinates::geometry)::numeric, 3),
    'lng', round(ST_X(location_coordinates::geometry)::numeric, 3),
    'event_count', count(*)
  ) AS properties
FROM ci.events
WHERE location_coordinates IS NOT NULL
  AND location_name IS NOT NULL
  AND btrim(location_name) <> ''
GROUP BY
  user_id,
  lower(btrim(location_name)),
  round(ST_Y(location_coordinates::geometry)::numeric, 3),
  round(ST_X(location_coordinates::geometry)::numeric, 3)
ON CONFLICT DO NOTHING;

-- 3. Link every reverse-geocoded event to its Place. Join purely on the
--    uniqueness key — no temp table needed; the partial unique index
--    guarantees one matching Place per (user, name, rounded coords) tuple.
UPDATE ci.events e
SET location_entity_id = ent.entity_id
FROM ci.entities ent
WHERE e.location_entity_id IS NULL
  AND e.location_coordinates IS NOT NULL
  AND e.location_name IS NOT NULL
  AND btrim(e.location_name) <> ''
  AND ent.entity_type = 'Location'
  AND ent.properties->>'source' = 'reverse_geocode'
  AND ent.owner_user_id = e.user_id
  AND lower(btrim(ent.name)) = lower(btrim(e.location_name))
  AND round(((ent.properties->>'lat')::numeric), 3)
      = round(ST_Y(e.location_coordinates::geometry)::numeric, 3)
  AND round(((ent.properties->>'lng')::numeric), 3)
      = round(ST_X(e.location_coordinates::geometry)::numeric, 3);

-- migrate:down
-- Reverse in dependency order: unlink events first, then delete the Place
-- rows this migration created, then drop the dedup index. The
-- properties->>'source' filter scopes the delete to rows this migration owns;
-- any user-curated Places stay put.
UPDATE ci.events e
SET location_entity_id = NULL
FROM ci.entities ent
WHERE e.location_entity_id = ent.entity_id
  AND ent.entity_type = 'Location'
  AND ent.properties->>'source' = 'reverse_geocode';

DELETE FROM ci.entities
WHERE entity_type = 'Location'
  AND properties->>'source' = 'reverse_geocode';

DROP INDEX IF EXISTS ci.entities_reverse_geocode_dedup_idx;
