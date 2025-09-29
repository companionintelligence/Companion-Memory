-- =================================================================
-- POSTGRESQL EXTENSIONS SETUP
-- =================================================================
-- This file must be run first to enable all required extensions

-- Core extensions for the multi-modal database
-- migrate:up
CREATE EXTENSION IF NOT EXISTS pg_uuidv7;            -- UUID v7 with timestamps
CREATE EXTENSION IF NOT EXISTS timescaledb;          -- Time-series optimization
CREATE EXTENSION IF NOT EXISTS postgis;              -- Geospatial operations  
CREATE EXTENSION IF NOT EXISTS vector;               -- Vector similarity search

-- Optional but recommended extensions
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;   -- Query performance monitoring
CREATE EXTENSION IF NOT EXISTS btree_gist;          -- Better indexing for exclusion constraints


-- migrate:down
-- Drop all extensions in reverse order of creation
DROP EXTENSION IF EXISTS btree_gist;
DROP EXTENSION IF EXISTS pg_stat_statements;
DROP EXTENSION IF EXISTS postgis;
DROP EXTENSION IF EXISTS timescaledb;
