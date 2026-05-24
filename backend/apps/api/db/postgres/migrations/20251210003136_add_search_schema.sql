-- migrate:up
CREATE SCHEMA IF NOT EXISTS ci_search;

-- migrate:down
DROP SCHEMA IF EXISTS ci_search CASCADE;
