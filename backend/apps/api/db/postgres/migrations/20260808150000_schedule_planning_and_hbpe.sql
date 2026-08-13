-- migrate:up
-- Consolidated from feat/schedules: HBPE recurrence, planning tasks, schedule
-- candidates/rhythms, and event-candidate personalization.

-- Recurrence profiles: per-(user, L1 cluster) statistical recurrence model,
-- rebuilt nightly from hbpe.token_stream.
CREATE TABLE hbpe.recurrence_profiles (
    user_id                 UUID NOT NULL REFERENCES ci.users(id),
    l1_cluster_id           UUID NOT NULL REFERENCES hbpe.l1_clusters(cluster_id) ON DELETE CASCADE,
    computed_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    history_days            INTEGER NOT NULL,
    n_occurrence_days       INTEGER NOT NULL,
    first_seen              DATE,
    last_seen               DATE,
    dow_counts              INTEGER[] NOT NULL,
    daypart_counts          INTEGER[] NOT NULL,
    intervals_days          INTEGER[] NOT NULL,
    interval_median         REAL,
    interval_p25            REAL,
    interval_p75            REAL,
    interval_p90            REAL,
    interval_mean           REAL,
    interval_std            REAL,
    periodicity_confidence  REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, l1_cluster_id)
);

CREATE TABLE hbpe.occurrence_log (
    id              UUID NOT NULL DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES ci.users(id),
    predicted_at    TIMESTAMPTZ NOT NULL,
    target_date     DATE NOT NULL,
    l1_cluster_id   UUID NOT NULL,
    p_occur         REAL NOT NULL CHECK (p_occur >= 0 AND p_occur <= 1),
    actual          BOOLEAN,
    model_version   TEXT NOT NULL,
    PRIMARY KEY (id, predicted_at)
);

CREATE INDEX ON hbpe.occurrence_log (user_id, target_date) WHERE actual IS NULL;
CREATE INDEX ON hbpe.occurrence_log (user_id, l1_cluster_id, target_date);

CREATE TABLE ci.tasks (
    id                UUID        PRIMARY KEY DEFAULT gen_uuid_v7(),
    user_id           UUID        NOT NULL REFERENCES ci.users (id) ON DELETE CASCADE,
    title             TEXT        NOT NULL,
    description       TEXT        NULL,
    notes             TEXT        NULL,
    status            TEXT        NOT NULL DEFAULT 'open',
    priority          INTEGER     NOT NULL DEFAULT 3,
    parent_id         UUID        NULL REFERENCES ci.tasks (id) ON DELETE CASCADE,
    due_at            TIMESTAMPTZ NULL,
    task_time         TIME        NULL,
    scheduled_for     DATE        NULL,
    defer_until       DATE        NULL,
    defer_count       INTEGER     NOT NULL DEFAULT 0,
    estimated_minutes INTEGER     NULL,
    actual_minutes    INTEGER     NOT NULL DEFAULT 0,
    completed_at      TIMESTAMPTZ NULL,
    source_kind       TEXT        NOT NULL DEFAULT 'manual',
    source_ref        TEXT        NULL,
    metadata          JSONB       NOT NULL DEFAULT '{}',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT tasks_status_check
        CHECK (status IN ('open', 'in_progress', 'done', 'skipped', 'archived')),
    CONSTRAINT tasks_priority_check
        CHECK (priority BETWEEN 0 AND 5),
    CONSTRAINT tasks_estimated_minutes_check
        CHECK (estimated_minutes IS NULL OR estimated_minutes > 0),
    CONSTRAINT tasks_no_self_parent
        CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX idx_tasks_user_status ON ci.tasks (user_id, status, due_at);
CREATE INDEX idx_tasks_parent ON ci.tasks (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX idx_tasks_user_scheduled ON ci.tasks (user_id, scheduled_for)
    WHERE scheduled_for IS NOT NULL;
CREATE UNIQUE INDEX ux_tasks_source ON ci.tasks (user_id, source_kind, source_ref)
    WHERE source_ref IS NOT NULL;

CREATE TABLE ci.task_dependencies (
    task_id       UUID        NOT NULL REFERENCES ci.tasks (id) ON DELETE CASCADE,
    depends_on_id UUID        NOT NULL REFERENCES ci.tasks (id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (task_id, depends_on_id),
    CONSTRAINT task_dependencies_no_self_edge CHECK (task_id <> depends_on_id)
);

CREATE INDEX idx_task_dependencies_depends_on ON ci.task_dependencies (depends_on_id);

ALTER TABLE ci.actions
    ADD COLUMN IF NOT EXISTS task_id UUID NULL REFERENCES ci.tasks (id) ON DELETE SET NULL;

CREATE TABLE ci.event_candidates (
    candidate_id        UUID PRIMARY KEY,
    user_id             UUID NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    title               TEXT NOT NULL,
    description         TEXT,
    rationale           TEXT NOT NULL,
    rationale_sources   JSONB NOT NULL DEFAULT '[]',
    window_start        TIMESTAMPTZ NOT NULL,
    window_end          TIMESTAMPTZ NOT NULL,
    time_flex           TEXT NOT NULL DEFAULT 'week'
                        CHECK (time_flex IN ('exact', 'day', 'week', 'month', 'season')),
    duration_minutes    INTEGER CHECK (duration_minutes > 0),
    constraints         JSONB NOT NULL DEFAULT '{}',
    l0_class            TEXT,
    l1_cluster_id       UUID,
    energy_cost         INTEGER CHECK (energy_cost BETWEEN 1 AND 10),
    fit_score           REAL CHECK (fit_score >= 0 AND fit_score <= 1),
    fit_curve           JSONB,
    status              TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'accepted', 'snoozed', 'declined', 'never')),
    feedback_reason     TEXT,
    feedback_at         TIMESTAMPTZ,
    snoozed_until       TIMESTAMPTZ,
    promoted_event_id   UUID REFERENCES ci.events(event_id) ON DELETE SET NULL,
    dedupe_key          TEXT NOT NULL,
    generator           TEXT,
    confidence          REAL CHECK (confidence >= 0 AND confidence <= 1),
    personalization     JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT candidate_window_ordered CHECK (window_start < window_end),
    CONSTRAINT candidate_promotion_consistent CHECK (
        status = 'accepted' OR promoted_event_id IS NULL
    )
);

CREATE UNIQUE INDEX event_candidates_dedupe_uniq
    ON ci.event_candidates (user_id, dedupe_key);
CREATE INDEX event_candidates_window_idx
    ON ci.event_candidates (user_id, window_start, window_end)
    WHERE status IN ('open', 'snoozed');
CREATE INDEX event_candidates_rank_idx
    ON ci.event_candidates (user_id, fit_score DESC NULLS LAST)
    WHERE status = 'open';

CREATE TABLE ci.rhythms (
    rhythm_id       UUID PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    label           TEXT NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('window', 'cadence', 'avoid')),
    spec            JSONB NOT NULL,
    strength        TEXT NOT NULL DEFAULT 'soft' CHECK (strength IN ('soft', 'hard')),
    source          TEXT NOT NULL DEFAULT 'declared' CHECK (source IN ('declared', 'answer')),
    source_answer_id UUID,
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX rhythms_user_active_idx ON ci.rhythms (user_id) WHERE active;

-- migrate:down

DROP TABLE IF EXISTS ci.rhythms;
DROP TABLE IF EXISTS ci.event_candidates;
ALTER TABLE ci.actions DROP COLUMN IF EXISTS task_id;
DROP TABLE IF EXISTS ci.task_dependencies;
DROP TABLE IF EXISTS ci.tasks;
DROP TABLE IF EXISTS hbpe.occurrence_log;
DROP TABLE IF EXISTS hbpe.recurrence_profiles;
