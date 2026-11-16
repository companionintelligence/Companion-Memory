-- migrate:up
-- Leave places merged into another out of entities_admin_place_uniq, the
-- one-city-per-region key, the way product_models_brand_model_uniq leaves out
-- merged product models.
--
-- ## Why
--
-- The key is (owner, kind, lower(btrim(name)), parent), with a missing parent
-- counting as its own value. A merged-away city kept it. So merging a city
-- with no region into a same-named city under one failed: the kept city took
-- the region while the other still held (city, name, region), and the
-- PlaceMergeService fold hit `duplicate key value violates unique constraint
-- "entities_admin_place_uniq"`. Clearing the other city's parent first collides
-- the other way, with the kept city's own parentless key, and every place the
-- merge leaves without a parent holds that parentless key from then on, so
-- the next merge of a city of that name failed too.
--
-- A merged-away place is not a city node any more: geocoding resolves the
-- city to the live row (PlaceService.findOrCreateAdminPlace reads back only
-- live rows) and Places lists only live rows. So the key holds for live
-- places only.
DROP INDEX IF EXISTS ci.entities_admin_place_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS entities_admin_place_uniq
  ON ci.entities (
    owner_user_id,
    place_kind,
    lower(btrim(name)),
    COALESCE(parent_place_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE entity_type = 'Location'
    AND place_kind IN ('city', 'region', 'country', 'continent', 'planet')
    AND name IS NOT NULL
    AND merged_into_entity_id IS NULL;

-- migrate:down
-- Fails if a merged-away place now shares its key with another place; merge
-- or rename those first.
DROP INDEX IF EXISTS ci.entities_admin_place_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS entities_admin_place_uniq
  ON ci.entities (
    owner_user_id,
    place_kind,
    lower(btrim(name)),
    COALESCE(parent_place_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE entity_type = 'Location'
    AND place_kind IN ('city', 'region', 'country', 'continent', 'planet')
    AND name IS NOT NULL;
