-- migrate:up
-- ═══════════════════════════════════════════════════════════════════════════
-- M3's remaining `ci.events` columns (roadmap: docs/architecture/
-- planning-roadmap.md, "M3 — Scheduling"). `task_id` / `planned_minutes`
-- landed in 20260818185920; this closes the rest of the list that migration's
-- own comment named as still owed: `is_locked`, `is_auto`, `occurrence_date`,
-- `recurrence_parent_id`, `recurrence_rule`, `last_moved_at`, `auto_run_id`,
-- `category_tag_id`, `color_token`.
--
-- ── The `status` CHECK is NOT touched here ──────────────────────────────────
--
-- The roadmap's M3 entry still lists "the widened status CHECK" under "Not
-- landed", but that is stale: 20260818185920 widened `events_status_check` to
-- `'planned' | 'in_progress' | 'skipped'` in the same migration that added
-- `task_id`, because a placed block needs those statuses to exist as soon as
-- it can be written. Confirmed against the live schema (`\d ci.events`) —
-- `events_status_check` already reads `tentative, confirmed, cancelled,
-- completed, no_show, rescheduled, planned, in_progress, skipped`. Re-running
-- DROP/ADD here would be a no-op at best and a footgun at worst (a second
-- migration racing the first's constraint name). The roadmap doc is corrected
-- alongside this migration.
--
-- ── Why each column is shaped the way it is ─────────────────────────────────
--
-- `is_locked` / `is_auto` are booleans with the same DEFAULT-false, NOT NULL
-- shape `task_proposed_and_pending_changes` used for `is_recurring` etc.:
-- every block written before this migration is unlocked and manual, which is
-- the correct reading for a row nobody has ever been able to lock or
-- auto-place. `is_locked` is settable/readable only in this milestone — a
-- future reflow engine owns making it mean something (roadmap invariant 4
-- says protection is passed to reflow in memory, never re-derived from this
-- column mid-run, so a crashed reflow cannot leave stale locks behind).
--
-- `occurrence_date`, `recurrence_parent_id`, `recurrence_rule`, `auto_run_id`
-- are nullable schema-readiness columns for the recurrence engine and autoplan
-- correlation named in the roadmap's "Later" section — neither is implemented
-- here. `recurrence_parent_id` is a self-FK (`ON DELETE SET NULL`, matching
-- `parent_event_id`'s own ON DELETE action) so deleting a recurring template
-- orphans its instances rather than cascading their deletion.
--
-- `last_moved_at` is nullable because every block placed before this
-- migration has no recorded "last moved" instant — NULL means "never observed
-- moving", not "moved at time zero". Stamped by every write path that changes
-- `start_time`/`end_time` (CalendarEventService.update and .reschedule); this
-- migration only adds the column, not the anti-thrash logic the roadmap says
-- will eventually read it.
--
-- `category_tag_id` references `ci_search.tags(id)` with no CHECK on
-- `tags.kind`: M2 (the taxonomy milestone) may or may not have landed
-- `kind` yet depending on merge order, and this migration must not take a
-- dependency on a column that might not exist when it runs. Any
-- kind='category' enforcement is M2's to add once it can guarantee the
-- column is there.
--
-- `color_token` is a plain nullable text stamp, not a live lookup. CI-Planning's
-- own scar: a category's color is copied onto the block AT WRITE TIME, so
-- re-coloring a category later does not retroactively repaint history. Nothing
-- in this migration or this PR computes a value for it — it is wired the same
-- way `occurrence_date`/`recurrence_rule` are, ready for the category-based
-- placement milestone to start writing it.

ALTER TABLE ci.events
    ADD COLUMN IF NOT EXISTS is_locked boolean NOT NULL DEFAULT false;

ALTER TABLE ci.events
    ADD COLUMN IF NOT EXISTS is_auto boolean NOT NULL DEFAULT false;

ALTER TABLE ci.events
    ADD COLUMN IF NOT EXISTS occurrence_date date NULL;

ALTER TABLE ci.events
    ADD COLUMN IF NOT EXISTS recurrence_parent_id uuid NULL
        REFERENCES ci.events (event_id) ON DELETE SET NULL;

ALTER TABLE ci.events
    ADD COLUMN IF NOT EXISTS recurrence_rule text NULL;

ALTER TABLE ci.events
    ADD COLUMN IF NOT EXISTS last_moved_at timestamptz NULL;

ALTER TABLE ci.events
    ADD COLUMN IF NOT EXISTS auto_run_id uuid NULL;

ALTER TABLE ci.events
    ADD COLUMN IF NOT EXISTS category_tag_id uuid NULL
        REFERENCES ci_search.tags (id) ON DELETE SET NULL;

ALTER TABLE ci.events
    ADD COLUMN IF NOT EXISTS color_token text NULL;

-- migrate:down

ALTER TABLE ci.events DROP COLUMN IF EXISTS color_token;
ALTER TABLE ci.events DROP COLUMN IF EXISTS category_tag_id;
ALTER TABLE ci.events DROP COLUMN IF EXISTS auto_run_id;
ALTER TABLE ci.events DROP COLUMN IF EXISTS last_moved_at;
ALTER TABLE ci.events DROP COLUMN IF EXISTS recurrence_rule;
ALTER TABLE ci.events DROP COLUMN IF EXISTS recurrence_parent_id;
ALTER TABLE ci.events DROP COLUMN IF EXISTS occurrence_date;
ALTER TABLE ci.events DROP COLUMN IF EXISTS is_auto;
ALTER TABLE ci.events DROP COLUMN IF EXISTS is_locked;
