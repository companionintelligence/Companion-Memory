-- migrate:up
-- Known places: Home / Work / school / social / other "places lived" plus the
-- per-person common locations surfaced as confirmable insights (geodata-plan
-- Phase 3). A label is the user-facing, confidence-tracked, time-bounded
-- assertion that a graph Location (ci.entities, entity_type='Location') plays a
-- role in the user's life.
--
-- Time-ranges are mandatory in spirit (home moves): active_from defaults to the
-- epoch for "as long as we know", active_to NULL = still current. The pair
-- (user_id, label, active_from) is unique so the same label can have multiple
-- non-overlapping eras (e.g. two successive homes) without colliding.
--
-- location_id is the ci.entities Location node; coordinates is denormalized off
-- that node (and the clustering pass) so map/geo queries don't have to join.
CREATE TABLE IF NOT EXISTS ci.known_place_labels (
  id           uuid                    PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
  user_id      uuid                    NOT NULL REFERENCES ci.users (id),
  location_id  uuid                    REFERENCES ci.entities (entity_id) ON DELETE SET NULL,
  label        text                    NOT NULL,
  kind         text                    NOT NULL DEFAULT 'other'
                 CHECK (kind IN ('home', 'work', 'school', 'social', 'other')),
  coordinates  geography(Point, 4326),
  confidence   double precision        NOT NULL DEFAULT 0.5,
  active_from  date                    NOT NULL DEFAULT '1970-01-01',
  active_to    date,
  aliases      text[]                  NOT NULL DEFAULT '{}',
  source       text                    NOT NULL DEFAULT 'inferred'
                 CHECK (source IN ('manual', 'inferred', 'geocoded')),
  created_at   timestamptz             NOT NULL DEFAULT now(),
  updated_at   timestamptz             NOT NULL DEFAULT now(),
  UNIQUE (user_id, label, active_from)
);

-- Primary read path: a user's labels, optionally filtered by kind.
CREATE INDEX IF NOT EXISTS known_place_labels_user_kind_idx
  ON ci.known_place_labels (user_id, kind);

-- Resolve labels for a given Location node.
CREATE INDEX IF NOT EXISTS known_place_labels_location_idx
  ON ci.known_place_labels (location_id)
  WHERE location_id IS NOT NULL;

-- migrate:down
DROP TABLE IF EXISTS ci.known_place_labels;
