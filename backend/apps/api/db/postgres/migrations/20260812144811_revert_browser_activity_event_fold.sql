-- migrate:up
-- =================================================================
-- Revert Wave D: unfold browser_activity from ci.events + ci.content
-- =================================================================
-- Wave D (20260808070615, squashed into 20260808150100) backfilled every
-- ci.browser_activity row into ci.events ('view') + ci.content ('web-page')
-- and marked browser_activity deprecated pending a drop.
--
-- That is reversed here. Browser page views are not timeline events: folding
-- them in flooded the schedule calendar (patched at the read path in 6078c06f6)
-- and silently changed the HBPE training corpus, which reads ci.events with no
-- event_type or source_type filter. ci.browser_activity is the sole home for
-- these rows; BrowserActivityService no longer dual-writes.
--
-- Ordering note: this migration must land BEFORE the source_type stopgap is
-- removed from EventService.findInRange, or historical folds reappear on the
-- calendar in the window between the two.
--
-- Graph deltas: the ci.entities triggers were dropped in 20260811210000, so
-- unlike the CTI migrations this one has no triggers to disable. The deletes
-- below intentionally record no graph_deltas — removing rows that should never
-- have been graph nodes is not a graph change the user should see as insights.

-- (1) Content mirrors. Deleted first: ci.content.event_id is ON DELETE SET NULL,
-- so removing events first would silently orphan these instead of deleting them.
DELETE FROM ci.content
WHERE type = 'web-page'
  AND source_data ? 'browser_activity_id';

-- (2) Event aggregates. ci.events sits under ci.entities via CTI
-- (20260811061409) with ON DELETE CASCADE, so deleting the base row removes the
-- detail row with it. Matching on the detail row's metadata and deleting the
-- base row by shared uuid keeps the predicate on the column that actually
-- carries the fold marker.
DELETE FROM ci.entities
WHERE entity_type = 'Event'
  AND entity_id IN (
    SELECT event_id
      FROM ci.events
     WHERE metadata ? 'browser_activity_id'
  );

-- Belt and braces: any detail row whose base row was already gone (pre-CTI
-- leftovers) would not be reached by the cascade above.
DELETE FROM ci.events
WHERE metadata ? 'browser_activity_id';

-- (3) browser_activity is no longer deprecated.
COMMENT ON TABLE ci.browser_activity IS
  'Browser extension page views. Sole home for this data — do not fold into ci.events (see 20260812144811).';

-- migrate:down
-- Not reversible: the folded rows are deleted, not archived. Re-running the
-- Wave D backfill (20260808070615) would rebuild them from ci.browser_activity,
-- which is deliberately still intact.
SELECT 1;
