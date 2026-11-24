-- migrate:up
-- =====================================================================
-- SAVED SEARCHES: a date picked in the editor replaces a stored rolling When
-- =====================================================================
-- A saved search keeps a rolling When ("Last month") as `filters.datePreset`
-- and fixed dates as `filters.startTime` / `filters.endTime`. When it opens,
-- the preset wins (`useSavedSearchResolution` in the app,
-- `resolveSavedSearchDateRange` for shared links). Saving a search never
-- writes both: the explorer stores a rolling When without dates.
--
-- Update Saved Search did. Picking From or To there copied the stored preset
-- forward next to the new dates, so the search went on opening on "Last
-- month" and the dates the user picked were ignored (#3079, section 4). The
-- editor now drops the preset when a date is picked. The rows it already
-- wrote still carry both, and the only way to get there was picking those
-- dates, so the dates are what the user asked for. This drops the preset from
-- them.
--
-- Rows with a preset and no dates (every seeded search, and every rolling
-- search saved from the explorer) are left alone. Idempotent: a repaired row
-- no longer matches.

UPDATE ci.saved_searches
   SET filters = filters - 'datePreset',
       updated_at = now()
 WHERE filters ? 'datePreset'
   AND (   nullif(filters ->> 'startTime', '') IS NOT NULL
        OR nullif(filters ->> 'endTime', '') IS NOT NULL);

-- migrate:down
-- Deliberately no-op. A repaired row cannot be told apart from one saved with
-- dates and no preset, and putting the preset back would make the search
-- ignore its dates again.
