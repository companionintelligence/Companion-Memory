-- migrate:up
-- Retire ci.user_snapshots: a compressed TimescaleDB hypertable with no reader
-- and, on any supported install, no writer either.
--
-- The evidence, gathered 2026-08-26:
--
--  * No SELECT anywhere in this repo. The only reference to the table outside
--    its own migrations was `@Entity({ schema: 'ci', name: 'user_snapshots' })`
--    and a service whose sole method is `repository.save`.
--
--  * The GraphQL mutation that fed it (`ingestUserSnapshot`) has no caller in
--    any repo in the workspace, and could not have one: its resolver is guarded
--    by the bare `JwtAuthGuard`, so it accepts a session JWT only. CI-Capture —
--    the producer this table was built for — authenticates with an API key or a
--    Portal OIDC bearer (CI-Capture `src/server_common.rs` `AuthCredential`),
--    both of which that resolver 401s. See docs/api/graphql.md §2.
--
--  * CI-Capture's supported path does not touch this table. `capture_vizier`
--    (CI-Capture `src/worker.rs`) calls `server_ingest::ingest_vizier_event`,
--    which POSTs to `/v1/events`; the focus/window/fs-event payload lands in
--    ci.events as `vizier_snapshot` / `vizier_patch`. The direct INSERT into
--    ci.user_snapshots (`src/db.rs` `record_vizier_event`) is reachable only
--    behind the non-default `legacy-postgres` cargo feature AND only when no
--    CI-Server is configured at all, and it is already fire-and-forget: the
--    caller logs a warning and continues when the write fails.
--
-- This is the same retirement ci.screen_captures already went through — see the
-- note on the `legacy-minio` feature in CI-Capture's Cargo.toml, which records
-- that the table "was dropped from CI-Server, so this path now writes to a
-- table it re-creates itself and nothing reads."
--
-- Retention, which docs/architecture/hypertable-audit.md flagged as this
-- table's "strongest unrealised retention argument", is settled the only way it
-- can be settled for a dataset with no consumer: the rows go, and no new ones
-- accumulate. The desktop-focus signal HBPE wanted from here
-- (docs/scratch1-bdc/hbpe-data-rich-redesign.md, Ambient/P2) is available from
-- ci.events, which is where CI-Capture actually sends it.

-- Drop the background compression job before the table, so the job catalog is
-- clean even on a TimescaleDB build that would otherwise leave it orphaned.
SELECT remove_compression_policy('ci.user_snapshots', if_exists => true);

DROP TABLE IF EXISTS ci.user_snapshots;

-- migrate:down
-- Restores the schema object as 20260807072056 left it. It cannot restore the
-- rows: DROP TABLE took the chunks with it.
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

SELECT create_hypertable('ci.user_snapshots', 'observed_at', chunk_time_interval => INTERVAL '7 days');

ALTER TABLE ci.user_snapshots
    SET (
        timescaledb.compress,
        timescaledb.compress_segmentby = 'user_id, device_id, producer, snapshot_kind',
        timescaledb.compress_orderby = 'observed_at DESC'
    );

SELECT add_compression_policy('ci.user_snapshots', INTERVAL '14 days', if_not_exists => true);

CREATE INDEX user_snapshots_device_time_idx
    ON ci.user_snapshots (device_id, observed_at DESC);

CREATE INDEX user_snapshots_session_time_idx
    ON ci.user_snapshots (session_id, observed_at DESC);

CREATE INDEX user_snapshots_user_kind_time_idx
    ON ci.user_snapshots (user_id, snapshot_kind, observed_at DESC);

CREATE INDEX user_snapshots_payload_gin_idx
    ON ci.user_snapshots USING GIN (payload);

CREATE INDEX user_snapshots_user_id_observed_at_idx
    ON ci.user_snapshots (user_id, observed_at DESC);
