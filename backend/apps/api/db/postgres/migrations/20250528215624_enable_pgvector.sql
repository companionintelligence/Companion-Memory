-- migrate:up
-- Extension is now provisioned by ci/setup-database (superuser init container)

-- migrate:down
-- No-op: extension lifecycle managed by ci/setup-database
