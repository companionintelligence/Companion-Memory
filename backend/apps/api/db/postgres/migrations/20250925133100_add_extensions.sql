-- =================================================================
-- POSTGRESQL EXTENSIONS SETUP
-- =================================================================
-- Extensions are now provisioned by ci/setup-database (superuser init container).
-- This migration is kept as a no-op so dbmate doesn't re-run it.

-- migrate:up
-- No-op: see infrastructure/setup-database/entrypoint.sh

-- migrate:down
-- No-op: extension lifecycle managed by ci/setup-database
