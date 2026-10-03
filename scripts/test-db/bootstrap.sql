-- The one bootstrap for a database the DB-backed jest suites run against.
--
-- Shared by `make test-db` (scripts/xtask/commands/test-db.ts feeds it to psql
-- inside its throwaway container) and by the `test` job in
-- .github/workflows/ci.yml, so the two cannot drift apart on which role, database
-- and extensions a test database has.
--
-- It is what the `ci/setup-database` init container does in compose
-- (infrastructure/setup-database/entrypoint.sh), reduced to what a test database
-- needs: the least-privilege application role, its database, and the extensions
-- the migrations assume are already installed. No migration issues CREATE
-- EXTENSION for these (see 20250528215624_enable_pgvector, a no-op that exists to
-- document exactly that), so a database that skips this fails on a type it has
-- never heard of. Keep the extension list in step with that script.
--
-- CONTRACT
--   * Run as a superuser, connected to the maintenance database `postgres`.
--   * The application role's password is the psql variable `app_password`,
--     supplied by the caller (`-v app_password=...`, or a `\set` line ahead of
--     this file on stdin). It is never a literal here, so this file holds no
--     credential.
--   * Idempotent: safe to run twice against the same cluster.
--
-- Nothing here creates tables. Migrations do that:
--   yarn workspace @ci/be-api migrate && yarn workspace @ci/be-api pgboss:ensure

\set ON_ERROR_STOP on

\if :{?app_password}
\else
  DO $$ BEGIN RAISE EXCEPTION 'bootstrap.sql: the psql variable app_password is not set (pass -v app_password=...)'; END $$;
\endif

-- The application role. ALTER on a re-run, so a changed password takes effect.
SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'companion') AS role_exists \gset
\if :role_exists
  ALTER ROLE companion WITH LOGIN PASSWORD :'app_password';
\else
  CREATE ROLE companion WITH LOGIN PASSWORD :'app_password';
\endif

-- The application database, owned by that role.
SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'companion') AS db_exists \gset
\if :db_exists
  ALTER DATABASE companion OWNER TO companion;
\else
  CREATE DATABASE companion OWNER companion;
\endif

-- A second, permanently EMPTY database for the one Python suite that must be
-- pointed at a disposable one (backend/apps/summary/tests/test_macos_activity.py,
-- MACOS_TEST_DATABASE_URL: it runs CREATE SCHEMA ci and refuses a database that
-- already has one, so it cannot share `companion` once that is migrated).
SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'companion_empty') AS empty_db_exists \gset
\if :empty_db_exists
  ALTER DATABASE companion_empty OWNER TO companion;
\else
  CREATE DATABASE companion_empty OWNER companion;
\endif

-- Extensions live in the application database, installed by the superuser.
\connect companion
CREATE EXTENSION IF NOT EXISTS "timescaledb";
CREATE EXTENSION IF NOT EXISTS "postgis";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";
CREATE EXTENSION IF NOT EXISTS "btree_gist";
