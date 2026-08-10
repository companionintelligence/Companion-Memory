-- migrate:up
-- =====================================================================
-- ci.pipeline_schedule — WHEN EACH LEG LAST STARTED. The weekly clock.
-- =====================================================================
-- `STAGE_SCHEDULES` (domains/pipeline/schedule.ts) declares that
-- `enrich.geocode` and `enrich.position_reverse` run WEEKLY, inside the
-- enrichment window, capped per sweep. `stageDueness()` turns that declaration
-- into a yes or a no — and it takes `lastStartedAt` as a parameter, because a
-- schedule measured appliance-wide would starve every user but whoever the tick
-- reached first. Nothing in the schema could answer it, so the metered stages
-- were held out of `defaultStageSet()` entirely and "slower" was implemented as
-- "never". This table is the missing half.
--
-- One row per `(user, stage, entity_type)` leg — the same unit
-- `ci.pipeline_state` is keyed by and the same unit `ci.pipeline_shards.
-- shard_key` shards on, because a stage declaring two entity types is two
-- independent sweeps with two independent cursors and therefore two independent
-- clocks.
--
-- ── Why a table, and not one of the five that already exist ────────────────
--
-- `ci.pipeline_shards` is the obvious candidate and it is the WRONG ONE, in the
-- most expensive possible direction. A shard is RUN-SCOPED: it CASCADEs with
-- `ci.pipeline_runs`, and the control tick finalizes a run as soon as nothing is
-- stale and starts a fresh one when new rows land. So a leg's shard history is
-- erased on a cadence of hours while its schedule is measured in weeks — every
-- new run would read back "never started", `stageDueness` would answer
-- `never_run`, and a weekly metered stage would be due on every tick that
-- follows a finalization. That is not a slower geocoder, it is the same
-- unbounded one with a table behind it.
--
-- `max(ci.pipeline_state.updated_at)` needs no migration at all and was
-- rejected for the direction it fails in. It records when an ENTITY was last
-- written, not when a SWEEP was last started, so the two disagree exactly when
-- it matters: a sweep that dispatched 1,000 ids and had every one of them
-- skipped by the stage writes rows and looks like a run, while a sweep whose
-- slices are all still queued writes nothing and looks like it never happened.
-- The second case is the fatal one — it fails OPEN for a metered stage, once
-- per tick, against a paid provider. A dedicated row stamped by the claim
-- cannot: it is written before the first slice is enqueued, so the worst case is
-- a leg that waits a week longer than it had to.
--
-- `ci.pipeline_turns` is per-USER window bookkeeping (whose turn, what tonight
-- cost). Per-stage cadence is a different key and a different question, and
-- merging them would mean one row per user per stage in a table whose whole
-- design note is "one row per user".
--
-- Deliberately NO foreign key to ci.users, for the reason the rest of the
-- control plane gives: a scheduler must degrade to "re-derive next tick" rather
-- than fail on a dangling reference. A deleted user leaves a handful of small
-- rows nothing reads, because the tick only looks up users it has already
-- selected from ci.users.
CREATE TABLE IF NOT EXISTS ci.pipeline_schedule (
    -- The leg. No surrogate id: the identity of a schedule record IS the triple,
    -- so the upsert has an ON CONFLICT target for free.
    user_id         UUID        NOT NULL,

    -- TEXT rather than an enum, exactly as ci.pipeline_state.stage and
    -- ci.pipeline_shards.stage are: the stage vocabulary is STAGE_IDS in code,
    -- and a type that has to be ALTERed to add a stage is a migration standing
    -- between a developer and a new enricher.
    stage           TEXT        NOT NULL,

    -- The ledger entity_type this leg sweeps. A stage declaring two types keeps
    -- two rows here and two clocks, because it is two sweeps.
    entity_type     TEXT        NOT NULL,

    -- THE CLOCK. Stamped when the control tick CLAIMS the leg's shard — before
    -- the first slice is enqueued, not after the sweep drains — so a process
    -- killed mid-dispatch cannot re-bill the leg on the next tick. NOT NULL: a
    -- row that exists but says nothing about when it started would be read as
    -- "never run" by stageDueness, which is the fail-open case this table
    -- exists to close. A leg that has never started has NO ROW, and the absence
    -- is the answer.
    last_started_at TIMESTAMPTZ NOT NULL,

    -- Lifetime sweeps started for this leg. Nothing schedules on it; it is the
    -- number that answers "has the weekly geocoder actually run, ever?" without
    -- reading a log that has since rotated.
    starts          BIGINT      NOT NULL DEFAULT 0 CHECK (starts >= 0),

    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (user_id, stage, entity_type)
);

COMMENT ON TABLE ci.pipeline_schedule IS
  'When each (user, stage, entity_type) leg last had a sweep started, so STAGE_SCHEDULES'' per-leg minInterval and maxStaleness can be evaluated. Cross-run on purpose: ci.pipeline_shards is run-scoped and would reset a weekly stage to never-run every time a run finalizes.';
COMMENT ON COLUMN ci.pipeline_schedule.last_started_at IS
  'The instant the control tick claimed this leg''s shard — the START of a sweep, stamped before any slice is enqueued. No row at all means the leg has never run, which stageDueness treats as infinite staleness.';
COMMENT ON COLUMN ci.pipeline_schedule.starts IS
  'Lifetime count of sweeps started for this leg. Evidence that a weekly stage is actually running; nothing schedules on it.';

-- No index beyond the primary key, deliberately. The tick reads this table once
-- per user per tick — `WHERE user_id = $1`, the whole row set for that user,
-- a handful of rows — and user_id is the PK's leading column, so the PK index
-- already serves it. An index on (stage) would be a second structure to
-- maintain for a query nobody issues.

-- migrate:down
DROP TABLE IF EXISTS ci.pipeline_schedule;
