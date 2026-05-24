-- migrate:up

-- Remove unused action_tag join table and dependent constraints/indexes.
DROP TABLE IF EXISTS ci.action_tag CASCADE;

-- migrate:down
-- Irreversible migration by design.
