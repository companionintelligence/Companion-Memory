-- migrate:up
CREATE TABLE ci.user_snapshots (
    snapshot_id UUID NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL,
    user_id UUID NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES ci.devices(device_id) ON DELETE CASCADE,
    session_id UUID NOT NULL,
    producer TEXT NOT NULL,
    snapshot_kind TEXT NOT NULL CHECK (snapshot_kind IN ('snapshot', 'patch')),
    monotonic_ms BIGINT NOT NULL,
    payload JSONB NOT NULL,
    focus_app TEXT,
    focus_title TEXT,
    cwd TEXT,
    fs_event_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (snapshot_id, observed_at, user_id)
);

SELECT create_hypertable('ci.user_snapshots', 'observed_at', 'user_id', 4);

ALTER TABLE ci.user_snapshots
    SET (
        timescaledb.compress,
        timescaledb.compress_segmentby = 'user_id, device_id, producer, snapshot_kind',
        timescaledb.compress_orderby = 'observed_at DESC'
    );

SELECT add_compression_policy('ci.user_snapshots', INTERVAL '14 days');

CREATE INDEX user_snapshots_device_time_idx
    ON ci.user_snapshots (device_id, observed_at DESC);

CREATE INDEX user_snapshots_session_time_idx
    ON ci.user_snapshots (session_id, observed_at DESC);

CREATE INDEX user_snapshots_user_kind_time_idx
    ON ci.user_snapshots (user_id, snapshot_kind, observed_at DESC);

CREATE INDEX user_snapshots_payload_gin_idx
    ON ci.user_snapshots USING GIN (payload);

-- migrate:down
DROP TABLE IF EXISTS ci.user_snapshots;
