-- migrate:up
CREATE SCHEMA IF NOT EXISTS ci_etl;

-- Create an ENUM for status to save space and enforce valid states
CREATE TYPE ci_etl.job_status AS ENUM ('in_progress', 'failed', 'success', 'pending');

CREATE TABLE ci_etl.connection_sync_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Foreign Keys & Relations
    user_id UUID NOT NULL, -- Keep NOT NULL for security/filtering
    connection_id UUID NOT NULL,
    job_id UUID,

    -- Job Context
    endpoint_name TEXT NOT NULL,
    status ci_etl.job_status NOT NULL DEFAULT 'in_progress',

    -- Data & Pagination (JSONB is correct for flexibility)
    data JSONB NOT NULL DEFAULT '{}',
    type TEXT NOT NULL, -- 'historical' or 'incremental'
    cursor JSONB DEFAULT '{}', -- For current page cursor
    next_cursor JSONB DEFAULT '{}', -- For next page cursor
    properties JSONB DEFAULT '{}',

    error JSONB, -- Store error details if job fails, this can include standard fields like error_code, message, stack_trace, etc.

    -- Audit Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

-- migrate:down
DROP TABLE ci_etl.connection_sync_jobs;
DROP TYPE ci_etl.job_status;
DROP SCHEMA ci_etl;
