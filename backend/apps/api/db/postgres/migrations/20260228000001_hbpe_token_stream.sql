-- migrate:up

-- Migration: ci.token_stream
-- Stores the serialized [SOD]…[EOD] token stream per user-day.
-- Replaces the previous parquet-file approach so training can query the DB directly.

CREATE TABLE ci.token_stream (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES ci.users(id),
    date          DATE NOT NULL,
    seq_order     SMALLINT NOT NULL,   -- row position within the day (0-based)
    bucket_idx    SMALLINT NOT NULL,   -- 0..47  (30-min bucket)
    level         TEXT NOT NULL,       -- SOD | L0 | L1 | L2 | EOD
    token_id      TEXT NOT NULL,       -- L0 class name, cluster UUID, or SOD/EOD
    soft_prob     FLOAT4[] NOT NULL,   -- similarity score(s); [1.0] for SOD/EOD/L0
    serialized_at TIMESTAMPTZ DEFAULT NOW()
);

-- Primary access pattern: fetch one user's full day in sequence order
CREATE INDEX ON ci.token_stream (user_id, date, seq_order);

-- Secondary: range queries across dates for training
CREATE INDEX ON ci.token_stream (user_id, date);

-- migrate:down

DROP TABLE IF EXISTS ci.token_stream;
