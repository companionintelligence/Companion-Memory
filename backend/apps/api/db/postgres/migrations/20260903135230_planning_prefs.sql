-- migrate:up

-- ═══════════════════════════════════════════════════════════════════════════
-- Where a person's planning preferences live.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The placer has always needed to know when someone's day starts and ends, and
-- until now it asked the knowledge graph. `PlannedBlockService.workdayHours`
-- resolves the self-Person entity and reads `properties.schedule.work_start` /
-- `work_end` out of its jsonb. That works, but it is two graph reads on the hot
-- path of every placement to answer a question that has nothing to do with the
-- graph, and it puts a scheduling setting somewhere no scheduling code would
-- think to look for it.
--
-- The planning roadmap named `ci.planning_prefs` as the home for this and it is
-- the one piece of M3 that never landed (docs/architecture/planning-roadmap.md
-- lists it under "Not landed"). This is that table.
--
-- ── Absent means shipped defaults ──────────────────────────────────────────
--
-- Nothing is seeded. A user who has never opened a settings page has no row
-- here, and no row must behave exactly as today: 09:00-17:00, a 30-minute
-- default estimate, a 7-day flex window. Those three constants already exist in
-- code (DEFAULT_WORK_START / DEFAULT_WORK_END in PlannedBlockService,
-- DEFAULT_ESTIMATED_MINUTES in engine/computePlacement) and the service layer
-- keeps them as the fallback rather than duplicating them as column DEFAULTs
-- that could drift from the code. The columns are nullable for the same reason
-- ci.job_settings makes NULL mean "inherit": a reset writes NULL, it does not
-- delete the row.
--
-- ── What is deliberately NOT here ──────────────────────────────────────────
--
-- `timezone`. `ci.users.timezone` is the single source of truth and is already
-- what ForecastContextService and PlanningTimeService read. A second timezone
-- column is the classic way to end up with two answers to "what day is it for
-- this person", which is precisely the failure the date/time discipline in this
-- domain exists to prevent.
--
-- `trust_mode`. It lives at `properties.planner.trust_mode` on the self-Person
-- and PersonalizationService.decide reads it there. Moving it is a data
-- migration with a behavioural blast radius (it gates whether the five LLM
-- planning jobs may act unattended), so it is left alone here rather than
-- quietly relocated as a side effect of adding a preferences table.
--
-- ── Column types ───────────────────────────────────────────────────────────
--
-- `work_start` / `work_end` are `time`, not `timestamptz`: they are zoneless
-- wall-clock, an INPUT to PlanningTimeService, never an output of it. Handing a
-- timestamptz to zonedWallTimeToUTC is the documented way to break DST in this
-- domain. Postgres hydrates `time` as a string, which is exactly the shape
-- workdayHours already passes around.
CREATE TABLE IF NOT EXISTS ci.planning_prefs (
    -- One row per person, so user_id IS the key. There is nothing to version or
    -- keep history of here; a preference has one current value.
    user_id                   uuid        PRIMARY KEY REFERENCES ci.users (id) ON DELETE CASCADE,

    -- NULL = inherit the shipped default. See the note above on why the
    -- defaults live in code rather than in column DEFAULTs.
    work_start                time,
    work_end                  time,

    -- Fallback duration for a task with no estimate. Bounded below at 1 because
    -- a zero-minute block is not a block, and above at a day because an
    -- estimate longer than the span it has to fit into can only ever fail to
    -- place.
    default_estimated_minutes integer,

    -- How many days forward scheduleTask may sweep looking for a gap. 1 means
    -- "today only". Capped at 28: past that the placement is a guess about a
    -- week that has not been planned yet, and the sweep cost is linear in it.
    flex_days                 integer,

    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),

    -- An inverted window would make every gap search return nothing, and it
    -- would do it silently -- the placer would just report no_gap forever. Equal
    -- is rejected too: a zero-length workday is a disabled workday spelled
    -- ambiguously.
    CONSTRAINT planning_prefs_workday_order_check
        CHECK (work_start IS NULL OR work_end IS NULL OR work_start < work_end),
    CONSTRAINT planning_prefs_default_estimated_minutes_check
        CHECK (default_estimated_minutes IS NULL
               OR (default_estimated_minutes >= 1 AND default_estimated_minutes <= 1440)),
    CONSTRAINT planning_prefs_flex_days_check
        CHECK (flex_days IS NULL OR (flex_days >= 1 AND flex_days <= 28))
);

COMMENT ON TABLE ci.planning_prefs IS
  'Per-user planning preferences: the workday window the placer fits blocks into, the fallback estimate, and how far forward scheduling may sweep. Zero rows means shipped defaults, so an untouched appliance behaves exactly as it did before this table existed. Timezone is NOT here -- ci.users.timezone is the source of truth.';

COMMENT ON COLUMN ci.planning_prefs.work_start IS
  'Zoneless wall-clock start of the workday. An INPUT to PlanningTimeService, never an output -- never hand this to zonedWallTimeToUTC as if it were an instant. NULL = inherit (09:00).';

COMMENT ON COLUMN ci.planning_prefs.work_end IS
  'Zoneless wall-clock end of the workday. NULL = inherit (17:00).';

COMMENT ON COLUMN ci.planning_prefs.default_estimated_minutes IS
  'Duration assumed for a task with no estimate. NULL = inherit (30, DEFAULT_ESTIMATED_MINUTES in engine/computePlacement).';

COMMENT ON COLUMN ci.planning_prefs.flex_days IS
  'How many days forward scheduleTask may sweep for a gap; 1 = today only. NULL = inherit (7, FLEX_DAYS in PlannedBlockService).';

-- migrate:down

DROP TABLE IF EXISTS ci.planning_prefs;
