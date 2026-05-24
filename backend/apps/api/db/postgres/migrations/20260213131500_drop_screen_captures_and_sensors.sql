-- migrate:up

-- Remove unused capture/sensor tables and all dependent indexes/triggers/constraints.
DROP TABLE IF EXISTS ci.screen_captures CASCADE;
DROP TABLE IF EXISTS ci.sensors CASCADE;

-- migrate:down
-- Irreversible migration by design.
