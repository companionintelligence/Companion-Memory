-- migrate:up

-- ═══════════════════════════════════════════════════════════════════════════
-- Operator control over the job system, persisted.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Every knob that decides how hard this appliance works has lived in the
-- environment: CI_QUEUE_CONCURRENCY, CI_QUEUE_PER_QUEUE_CONCURRENCY,
-- CI_QUEUE_SUPPRESS. All three are read once at boot, none of them are
-- reachable from the UI, and CI_QUEUE_SUPPRESS in particular is a bulk-import
-- escape hatch that an operator is expected to set, restart into, and remember
-- to unset. So the honest answer to "Memory is pinning this box, turn something
-- off" was: edit a compose file and restart the appliance.
--
-- This table is that answer, made durable. One row per thing an operator can
-- steer, read by every process a few seconds after it changes, and applied at
-- BOTH ends of the queue — the enqueue side, so disabled work never becomes a
-- row, and the worker side, so paused work stops burning CPU without losing
-- anything already queued.
--
-- ── The row vocabulary ─────────────────────────────────────────────────────
--
-- `kind` says what the row steers and therefore which columns mean anything.
-- There are exactly three, and the set is closed by a CHECK rather than left to
-- convention, because a typo'd kind would be a setting that silently never
-- applies:
--
--   kind='global', key='concurrency'
--     Appliance-wide ceiling on jobs in flight across every queue. `concurrency`
--     is the value; `mode` is unused. Absent → config `queues.concurrency`.
--
--   kind='global', key='per_queue_concurrency'
--     Default ceiling for any single queue. `concurrency` is the value; `mode`
--     is unused. Absent → config `queues.perQueueConcurrency`.
--
--   kind='global', key='non_interactive'
--     The panic switch. mode='paused' stops the workers fetching from every
--     queue that carries no interactive work, leaving chat and anything else a
--     human is waiting on running. Nothing is dropped: enqueue continues and the
--     backlog drains when it goes back to 'enabled'. mode='disabled' is refused
--     for this key by the API — a box that is too hot needs a pause, not a
--     silent hole in its memory.
--
--   kind='queue', key=<pg-boss queue name>
--     mode='enabled'  — normal.
--     mode='paused'   — keep enqueuing, stop working. Backlog builds, nothing
--                       is lost. This is the safe way to cool a box.
--     mode='disabled' — stop enqueuing AND stop working. New work for this
--                       queue is DROPPED, not deferred; `skipped_count` is what
--                       makes that visible instead of silent.
--     `concurrency` lowers this one queue's ceiling. It can only ever lower:
--     the effective cap is min(this, the global per-queue default, and any
--     `localConcurrency` the queue declares in code). A queue that declares
--     localConcurrency:1 because two of its jobs at once would thrash the model
--     stays at 1 no matter what is written here.
--
--   kind='cron', key=<`Class.method` registry name>
--     mode='enabled' or 'disabled'. A disabled schedule's body never runs and
--     never stamps ci.cron_runs, so the Jobs page reports it as disabled rather
--     than as a schedule that has mysteriously stopped firing. 'paused' is
--     meaningless for a cron — a tick that is not taken is simply not taken —
--     and is refused by the API.
--
-- ── Why NULL is a value here ───────────────────────────────────────────────
--
-- `mode` and `concurrency` are nullable and NULL means "no opinion, inherit the
-- shipped default". That is what makes the acceptance criterion "defaults do not
-- change behaviour for users who never open the page" true by construction: an
-- appliance that has never had this page opened has ZERO rows in this table, and
-- zero rows is exactly today's behaviour. Nothing is seeded. Resetting a control
-- writes NULL rather than deleting the row, so the skip tally survives the
-- reset and an operator can still see what a disable cost them.
--
-- ── Scope ──────────────────────────────────────────────────────────────────
--
-- Appliance-wide, deliberately: there is no user_id. One Memory serves one box,
-- and the two places these settings are enforced — the pg-boss worker loop and
-- the @Cron wrapper — have no user in scope at all. A per-user concurrency cap
-- could not be honoured anyway: the semaphore it would have to shrink is one
-- process-wide p-limit shared by every user's work.
CREATE TABLE IF NOT EXISTS ci.job_settings (
    kind             text        NOT NULL,
    key              text        NOT NULL,

    -- NULL = inherit. See the vocabulary above for which kinds use which column.
    mode             text,
    concurrency      integer,

    -- How much work this setting has thrown away, and when it last did.
    -- Incremented in batches from an in-memory counter (a bulk import fans out
    -- per row; one UPDATE per queue per flush interval, not one per drop).
    -- Only ever non-zero for a row that was at some point 'disabled': a paused
    -- queue defers work, it does not drop it.
    skipped_count    bigint      NOT NULL DEFAULT 0,
    last_skipped_at  timestamptz,

    updated_at       timestamptz NOT NULL DEFAULT now(),
    -- Who last changed it. Nullable because the appliance itself may write a
    -- row (the skip counters do), and ON DELETE SET NULL so deleting an account
    -- cannot take an appliance-wide setting with it.
    updated_by       uuid        REFERENCES ci.users (id) ON DELETE SET NULL,

    PRIMARY KEY (kind, key),

    CONSTRAINT job_settings_kind_check
        CHECK (kind IN ('global', 'queue', 'cron')),
    CONSTRAINT job_settings_mode_check
        CHECK (mode IS NULL OR mode IN ('enabled', 'paused', 'disabled')),
    -- Never "unlimited". A cap of zero would be a disable spelled as a number,
    -- and the two are separate controls on purpose.
    CONSTRAINT job_settings_concurrency_check
        CHECK (concurrency IS NULL OR concurrency >= 1),
    CONSTRAINT job_settings_skipped_count_check
        CHECK (skipped_count >= 0)
);

COMMENT ON TABLE ci.job_settings IS
  'Appliance-wide, persisted operator control over the job system: per-queue and per-cron on/pause/off, and concurrency ceilings. Read by every process on a short poll and applied at both enqueue and execute. Zero rows means shipped defaults, which is why nothing is seeded.';

COMMENT ON COLUMN ci.job_settings.kind IS
  'global | queue | cron. Decides which of `mode` and `concurrency` mean anything for this row -- see the migration that created this table for the full row vocabulary.';

COMMENT ON COLUMN ci.job_settings.mode IS
  'NULL = inherit the shipped default. enabled | paused | disabled. paused keeps enqueuing and stops working (nothing lost); disabled also stops enqueuing (new work is DROPPED).';

COMMENT ON COLUMN ci.job_settings.concurrency IS
  'NULL = inherit. A ceiling, never a floor: the effective cap is the minimum of this, the global per-queue default, and any localConcurrency the queue declares in code.';

COMMENT ON COLUMN ci.job_settings.skipped_count IS
  'Work this setting has dropped, cumulative. Exists so a disabled queue reads as "disabled, 12,340 dropped since 14:02" rather than as a dead queue.';

-- migrate:down

DROP TABLE IF EXISTS ci.job_settings;
