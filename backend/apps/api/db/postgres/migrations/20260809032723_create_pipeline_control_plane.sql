-- migrate:up
-- =====================================================================
-- PIPELINE CONTROL PLANE
-- =====================================================================
-- The five tables that make the jobs system restartable, observable and
-- idempotent. None of them hold work — pg-boss still does that. They hold the
-- ANSWER to "has this entity been through this stage at this version yet?",
-- which the old system could only answer by re-running the stage and hoping it
-- was idempotent.
--
-- The design point: work is DERIVED, never enqueued-and-forgotten. A stage
-- sweeps its source table LEFT JOIN ci.pipeline_state and takes whatever is
-- missing, out of date, or due for retry (THE ONE RULE, below). That makes a
-- crash mid-run a non-event — the next sweep re-derives exactly the same
-- remainder — and it makes a code change to a stage a one-integer operation:
-- bump STAGE_VERSIONS and every row is stale again.
--
--   SELECT s."<idCol>" AS id
--     FROM "<schema>"."<table>" s
--     LEFT JOIN ci.pipeline_state p
--       ON p.entity_type = $1 AND p.entity_id = s."<idCol>" AND p.stage = $2
--    WHERE s."<userCol>" = $3
--      AND (<stage applicability predicate>)
--      AND ( p.entity_id IS NULL
--         OR p.stage_version < $4
--         OR (p.status = 'failed' AND p.next_attempt_at <= now()) )
--      AND ($5::uuid IS NULL OR s."<idCol>" > $5::uuid)
--    ORDER BY s."<idCol>"
--    LIMIT $6;
--
-- Deliberately NO foreign key from these tables to ci.users. The control plane
-- has to stay writable for an entity whose user row is mid-repair or has not
-- landed yet, and a sweep must never fail on a dangling reference — the whole
-- point is that it degrades to "re-derive next tick". The cost is that a user
-- delete leaves control-plane rows behind; they are small, have no read path
-- once the user is gone, and a maintenance sweep can reap them.

-- ---------------------------------------------------------------------
-- ci.pipeline_state — one row per (entity, stage). The ledger.
-- ---------------------------------------------------------------------
-- Composite natural PK, no surrogate id: the identity of a row IS
-- (entity_type, entity_id, stage), so an upsert has an ON CONFLICT target for
-- free and there is no way to write the same fact twice. It also means the PK
-- index is exactly the index the sweep's LEFT JOIN needs.
CREATE TABLE IF NOT EXISTS ci.pipeline_state (
    entity_type     TEXT NOT NULL,
    entity_id       UUID NOT NULL,
    stage           TEXT NOT NULL,

    -- Monotonic per-stage version from STAGE_VERSIONS. Bumping it in code is
    -- the ONLY re-processing lever: every row with a lower number becomes
    -- stale on the next sweep. No backfill script, no manual DELETE.
    stage_version   INTEGER NOT NULL DEFAULT 0,

    status          TEXT NOT NULL
                      CHECK (status IN ('pending', 'running', 'done', 'skipped', 'failed', 'quarantined')),
    -- By CONVENTION (not a CHECK) reason is required when status is 'skipped'
    -- or 'failed'. Left unenforced on purpose: a stage that blew up mid-write
    -- must still be able to record that it failed, and a constraint that can
    -- reject the error-path write turns a recoverable failure into a lost one.
    reason          TEXT,

    attempts        INTEGER NOT NULL DEFAULT 0,
    -- Retry gate. The sweep only reclaims a 'failed' row once this is due, so
    -- backoff lives in data rather than in a scheduler that dies with the
    -- process.
    next_attempt_at TIMESTAMPTZ,

    -- Denormalized from the source row so the sweep, the per-user dashboard and
    -- the reaper can all filter by user without joining back to the entity's
    -- own table. NULLable because some stages act on user-less rows.
    user_id         UUID,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (entity_type, entity_id, stage)
);

COMMENT ON TABLE ci.pipeline_state IS
  'One row per (entity, stage): whether an entity has been through a stage, at which stage_version, and with what outcome. The LEFT JOIN target of every staleness sweep.';
COMMENT ON COLUMN ci.pipeline_state.stage_version IS
  'STAGE_VERSIONS value at the time the row was written. Rows below the current version are stale and get re-swept. Bumping the constant is the whole reprocessing mechanism.';
COMMENT ON COLUMN ci.pipeline_state.reason IS
  'Why a row is skipped or failed. Required by convention for those statuses; not enforced, so an error path can never be blocked by a constraint.';
COMMENT ON COLUMN ci.pipeline_state.status IS
  'pending | running | done | skipped | failed | quarantined. quarantined = out of retries, needs a human; the sweep never reclaims it.';

-- Backstop for the staleness sweep. The PK already covers the join itself;
-- this covers the version predicate behind "which stages are behind?" — the
-- pipeline status endpoint and the post-version-bump backfill both scan it.
-- NOTE: once ci.pipeline_state is large (millions of rows across all stages),
-- any FURTHER index on it must be built out of band with CREATE INDEX
-- CONCURRENTLY. dbmate wraps a migration in a transaction, where CONCURRENTLY
-- is illegal, so everything here is a blocking build with the appliance down —
-- which is only honest to pay for while the table is empty.
CREATE INDEX IF NOT EXISTS pipeline_state_stage_version_idx
    ON ci.pipeline_state (stage, stage_version);

-- Retry queue. Partial so it holds only the rows actually awaiting a retry,
-- which is a tiny fraction of the table in steady state.
CREATE INDEX IF NOT EXISTS pipeline_state_retry_idx
    ON ci.pipeline_state (status, next_attempt_at)
    WHERE status = 'failed';

-- ---------------------------------------------------------------------
-- ci.pipeline_runs — one row per invocation of a pipeline for a user.
-- ---------------------------------------------------------------------
-- desired_state is the CONTROL channel (what the operator wants); status is the
-- OBSERVED channel (what the workers are actually doing). Keeping them apart is
-- what makes pause and cancel work without a side channel: a worker reads
-- desired_state between batches and stops on its own. Nothing has to reach into
-- a queue and delete jobs, which is the operation that always races.
CREATE TABLE IF NOT EXISTS ci.pipeline_runs (
    id            UUID PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
    user_id       UUID NOT NULL,
    kind          TEXT NOT NULL,
    desired_state TEXT NOT NULL
                    CHECK (desired_state IN ('running', 'paused', 'cancelled')),
    status        TEXT NOT NULL,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ,
    detail        JSONB NOT NULL DEFAULT '{}'
);

COMMENT ON TABLE ci.pipeline_runs IS
  'One pipeline invocation for a user. desired_state is operator intent (running/paused/cancelled); status is what the workers report. Workers reconcile toward desired_state between batches.';
COMMENT ON COLUMN ci.pipeline_runs.desired_state IS
  'Operator intent, polled by workers between batches. Setting it to paused or cancelled is how a run is stopped — nothing deletes queued jobs.';
COMMENT ON COLUMN ci.pipeline_runs.finished_at IS
  'NULL means the run is still active, which is exactly the predicate of pipeline_runs_active_uniq. A cancelled run stays active until a worker finalizes it.';

-- ONE active run per user. Keyed on `finished_at IS NULL` rather than a status
-- list because the status vocabulary belongs to the runner and will grow, while
-- finalization is the single moment a run stops being active — so this index
-- cannot drift out of sync with the runner's state machine. An operator
-- double-clicking "reprocess" gets a unique violation instead of two workers
-- racing over the same user's rows.
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_runs_active_uniq
    ON ci.pipeline_runs (user_id)
    WHERE finished_at IS NULL;

-- History view: "show me this user's last runs".
CREATE INDEX IF NOT EXISTS pipeline_runs_user_started_idx
    ON ci.pipeline_runs (user_id, started_at DESC);

-- ---------------------------------------------------------------------
-- ci.pipeline_shards — the resumable cursor, one row per unit of parallelism.
-- ---------------------------------------------------------------------
-- A shard is (run, stage, shard_key) and carries a keyset `cursor` — the last
-- id handed out, i.e. the `$5::uuid` parameter of THE ONE RULE. Storing a
-- keyset instead of an OFFSET is what makes a resumed run cost O(remaining)
-- rather than O(processed), and immune to rows appearing mid-scan.
--
-- The lease pair is a cooperative mutex with a deadline, not a lock: a worker
-- claims a shard by stamping lease_owner/lease_expires_at, and a reaper takes
-- back anything expired. A worker that is SIGKILLed therefore costs one lease
-- period, not a permanently stuck run.
CREATE TABLE IF NOT EXISTS ci.pipeline_shards (
    id               UUID PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
    run_id           UUID NOT NULL REFERENCES ci.pipeline_runs(id) ON DELETE CASCADE,
    stage            TEXT NOT NULL,
    shard_key        TEXT NOT NULL,
    -- Keyset position: the last source id already handed out for this shard.
    -- TEXT, not UUID, so a stage whose source is keyed by something else can
    -- use the same table without a schema change.
    cursor           TEXT,
    status           TEXT NOT NULL,
    lease_owner      TEXT,
    lease_expires_at TIMESTAMPTZ
);

COMMENT ON TABLE ci.pipeline_shards IS
  'Resumable per-(run, stage, shard) cursor plus a lease. The cursor is the keyset position fed back into the sweep; the lease is a deadline-bounded claim, so a killed worker costs one lease period rather than a stuck run.';
COMMENT ON COLUMN ci.pipeline_shards.cursor IS
  'Last source id handed out, i.e. the $5 parameter of the staleness sweep. TEXT so non-UUID-keyed sources fit without a migration.';
COMMENT ON COLUMN ci.pipeline_shards.lease_expires_at IS
  'When this claim goes stale. The reaper reclaims any non-terminal shard past this instant regardless of lease_owner.';

-- Identity of a shard, and the ON CONFLICT target used when a run materializes
-- its shards — so re-materializing after a restart is idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_shards_run_stage_key_uniq
    ON ci.pipeline_shards (run_id, stage, shard_key);

-- Lease reaping: "which claims have expired?".
CREATE INDEX IF NOT EXISTS pipeline_shards_lease_idx
    ON ci.pipeline_shards (status, lease_expires_at);

-- ---------------------------------------------------------------------
-- ci.pipeline_dead_letters — jobs that died, kept instead of dropped.
-- ---------------------------------------------------------------------
-- pg-boss archives a failed job's payload and then expires it. That is fine for
-- a queue and useless for an appliance, where the failed payload is often the
-- only surviving copy of a record the source will not re-send. A dead letter is
-- REPLAYABLE: payload + event_name is everything needed to re-emit, and
-- replayed_at is the idempotency flag that stops a replay-all from looping.
CREATE TABLE IF NOT EXISTS ci.pipeline_dead_letters (
    id          UUID PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
    queue       TEXT NOT NULL,
    event_name  TEXT NOT NULL,
    stage       TEXT,
    entity_type TEXT,
    entity_id   UUID,
    payload     JSONB NOT NULL,
    error       TEXT NOT NULL,
    failed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    replayed_at TIMESTAMPTZ
);

COMMENT ON TABLE ci.pipeline_dead_letters IS
  'Terminal job failures with their payload, kept for replay. Unlike pg-boss archive rows these never expire — the payload is often the only surviving copy of the record.';
COMMENT ON COLUMN ci.pipeline_dead_letters.replayed_at IS
  'Stamped when the letter has been re-emitted. Non-NULL rows are excluded from the replay queue, so "replay all" is safe to run twice.';

-- Operator view: newest failures for a queue.
CREATE INDEX IF NOT EXISTS pipeline_dead_letters_queue_failed_idx
    ON ci.pipeline_dead_letters (queue, failed_at DESC);

-- Replay queue. Partial so it shrinks back to nothing as letters are replayed.
CREATE INDEX IF NOT EXISTS pipeline_dead_letters_unreplayed_idx
    ON ci.pipeline_dead_letters (replayed_at)
    WHERE replayed_at IS NULL;

-- ---------------------------------------------------------------------
-- ci.record_rejections — records refused at the door.
-- ---------------------------------------------------------------------
-- Distinct from a dead letter on purpose: a dead letter is OUR failure to
-- process a valid record; a rejection is THEIR record failing validation.
-- Conflating them is what taught the old importer to log-and-drop, which is how
-- a schema change at a source turned into weeks of silently missing data.
-- Keeping the raw payload means a fixed parser can re-admit the backlog.
CREATE TABLE IF NOT EXISTS ci.record_rejections (
    id          UUID PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
    user_id     UUID,
    source_kind TEXT,
    payload     JSONB NOT NULL,
    reason      TEXT NOT NULL,
    rejected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE ci.record_rejections IS
  'Inbound records refused by validation, kept with their raw payload. A rejection is the SOURCE being wrong; ci.pipeline_dead_letters is US being wrong. A fixed parser can re-admit these.';

-- Triage view: newest rejections, per user and for the unattributed ones.
CREATE INDEX IF NOT EXISTS record_rejections_user_time_idx
    ON ci.record_rejections (user_id, rejected_at DESC);

-- migrate:down
DROP INDEX IF EXISTS ci.record_rejections_user_time_idx;
DROP TABLE IF EXISTS ci.record_rejections;

DROP INDEX IF EXISTS ci.pipeline_dead_letters_unreplayed_idx;
DROP INDEX IF EXISTS ci.pipeline_dead_letters_queue_failed_idx;
DROP TABLE IF EXISTS ci.pipeline_dead_letters;

-- Shards before runs: pipeline_shards.run_id FKs into pipeline_runs.
DROP INDEX IF EXISTS ci.pipeline_shards_lease_idx;
DROP INDEX IF EXISTS ci.pipeline_shards_run_stage_key_uniq;
DROP TABLE IF EXISTS ci.pipeline_shards;

DROP INDEX IF EXISTS ci.pipeline_runs_user_started_idx;
DROP INDEX IF EXISTS ci.pipeline_runs_active_uniq;
DROP TABLE IF EXISTS ci.pipeline_runs;

DROP INDEX IF EXISTS ci.pipeline_state_retry_idx;
DROP INDEX IF EXISTS ci.pipeline_state_stage_version_idx;
DROP TABLE IF EXISTS ci.pipeline_state;
