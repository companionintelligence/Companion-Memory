-- migrate:up
-- Give a re-delivered event's TIME and TITLE the refresh its status got in
-- 20261001145556: a merge base per field, kept apart from what the row shows.
--
-- WHY. A meeting rescheduled or renamed at its source kept its first-sync time
-- and title for good. Google re-delivers the change through its sync token, but
-- CalendarEventService.createOne finds the stored row by its identity and, since
-- #2890, refreshes only `status`. The fields cannot simply be overwritten:
-- `update` and `reschedule` write all of them, and a meeting the user moved or
-- renamed must stay the way the user left it. So each gets what `status` got,
-- the value its SOURCE delivered last time. A re-delivered value lands only
-- while the row still shows that base (a three-way merge), and becomes the new
-- base either way.
--
-- WHAT. Four columns, typed like the fields they shadow (the argument for
-- typed columns over one jsonb snapshot is in sourceFieldMerge.ts):
--
--  * source_start_time / source_end_time: the source's time, merged as ONE
--    unit with source_recurrence. A pair merged field by field can come out
--    inverted (the user's end, the source's start), so a user who moved either
--    end has moved the event. NULL source_start_time means no base; a NULL
--    source_end_time beside a set start means the source said open-ended.
--  * source_recurrence: for a series master, the rule and zone the source
--    delivered with that time ({"rule": [...], "timeZone": ...}, from
--    metadata.recurrenceRule / recurrenceTimeZone, which only the Google
--    transform writes). It belongs to the same unit because a series moved
--    from Monday to Tuesday changes its DTSTART and its BYDAY together, and a
--    "this and following" edit ends the old series with an UNTIL. NULL beside
--    a set start means no rule.
--  * source_title: the title (ci.entities.name, the CTI base row) the source
--    delivered. It lives here, on the row whose lock the merge takes.
--
-- Nothing user-facing writes these: UpdateEventDto has no field for them.
--
-- BACKFILL. Two kinds of evidence, used in this order. The exact one: the
-- writer recorded what its source said. Failing that, the absence of any sign
-- that someone else changed the field since the row was written, which every
-- user edit leaves for this field from a known date. Where neither holds, the
-- base stays NULL, and the merge reads NULL as "the row may be the user's":
-- the user's value stands until the source comes round to it. Planned blocks
-- and rows no source owns are never touched.
--
-- Time, from the evidence a person's move leaves: `last_moved_at`, which
-- `update` and `reschedule` stamp on every time write (#2691, 2026-09-16);
-- `external_sync_status = 'pending'`, which `reschedule` sets on a synced row
-- (since 2026-08-03); and, for the weeks before the stamp existed, any `update`
-- that changed a detail field at all, since its graph delta does not say which
-- (deltas are app-written from 2026-08-11). A row with none of these was
-- moved by nobody but its source and the clean stage. The clean stage
-- (clean.temporal_repair) moves an all-day row from UTC midnight to local
-- midnight and keeps what was there in start_time_original / end_time_original,
-- so for a row it moved, the source's time is that original pair, not what the
-- row shows. It keeps the pair after a later pass relabels the row, which is
-- why `start_time_original IS NOT NULL`, not `time_source = 'repaired'`, says
-- the row was moved.
--
-- Title. Exact for the Google Calendar transform, which has kept Google's own
-- summary on every row it wrote as metadata.rawEventSummary and stored
-- `summary || 'Untitled Event'` as the title. The rows #2890 writes for a
-- cancelled occurrence carry no summary of their own (their title is the
-- series') and are left to the next rule. For every other source row: the
-- current name, unless a graph delta records a rename. The entity triggers
-- recorded every name change from 2026-08-09, and `update` has recorded its
-- own since 2026-08-11 (as {"name": {"new": ...}}, without "old").
--
-- Known gaps, both on the side of the source: a user's move made through
-- `update` before 2026-08-11 left no trace, and neither did a user's rename
-- before 2026-08-09 of an event from a source other than Google. Such an edit
-- is replaced the next time that source changes the same field.
ALTER TABLE ci.events ADD COLUMN IF NOT EXISTS source_start_time timestamptz;
ALTER TABLE ci.events ADD COLUMN IF NOT EXISTS source_end_time timestamptz;
ALTER TABLE ci.events ADD COLUMN IF NOT EXISTS source_recurrence jsonb;
ALTER TABLE ci.events ADD COLUMN IF NOT EXISTS source_title text;

COMMENT ON COLUMN ci.events.source_start_time IS
  'The start_time this row''s source last delivered: with source_end_time and '
  'source_recurrence, the merge base for the time refresh in '
  'CalendarEventService.createOne (sourceFieldMerge.ts). NULL when there is no '
  'base. Never user-writable.';

COMMENT ON COLUMN ci.events.source_end_time IS
  'The end_time this row''s source last delivered. Read only when '
  'source_start_time is set; NULL beside it means the source sent no end. '
  'Never user-writable.';

COMMENT ON COLUMN ci.events.source_recurrence IS
  'The recurrence ({"rule": [...], "timeZone": ...}) this row''s source last '
  'delivered with its time. Read only when source_start_time is set; NULL '
  'beside it means no rule. Never user-writable.';

COMMENT ON COLUMN ci.events.source_title IS
  'The title (ci.entities.name) this row''s source last delivered: the merge '
  'base for the title refresh in CalendarEventService.createOne. Kept on the '
  'events row because that row''s lock is the one the merge takes. NULL when '
  'there is no base. Never user-writable.';

-- Time, for a row the clean stage moved: the pair it moved it from.
UPDATE ci.events e
   SET source_start_time = e.start_time_original,
       source_end_time = e.end_time_original,
       source_recurrence = CASE WHEN e.metadata ? 'recurrenceRule'
                                THEN jsonb_build_object('rule', e.metadata->'recurrenceRule',
                                                        'timeZone', e.metadata->'recurrenceTimeZone')
                           END
 WHERE e.source_start_time IS NULL
   AND e.source_id IS NOT NULL
   AND e.source_type IS DISTINCT FROM 'planning'
   AND e.start_time_original IS NOT NULL
   AND e.last_moved_at IS NULL
   AND e.external_sync_status IS DISTINCT FROM 'pending'
   AND NOT EXISTS (
         SELECT 1
           FROM ci.graph_deltas d
          WHERE d.entity_id = e.event_id
            AND d.change_type = 'updated'
            AND d.change_source IN ('EventService.update', 'CalendarEventService.update')
            AND d.changed_fields ? 'detail_updated'
            AND d.changed_at < '2026-09-16T02:58:13Z');

-- Time, for every other row nobody moved: what it shows.
UPDATE ci.events e
   SET source_start_time = e.start_time,
       source_end_time = e.end_time,
       source_recurrence = CASE WHEN e.metadata ? 'recurrenceRule'
                                THEN jsonb_build_object('rule', e.metadata->'recurrenceRule',
                                                        'timeZone', e.metadata->'recurrenceTimeZone')
                           END
 WHERE e.source_start_time IS NULL
   AND e.source_id IS NOT NULL
   AND e.source_type IS DISTINCT FROM 'planning'
   AND e.start_time_original IS NULL
   AND e.last_moved_at IS NULL
   AND e.external_sync_status IS DISTINCT FROM 'pending'
   AND NOT EXISTS (
         SELECT 1
           FROM ci.graph_deltas d
          WHERE d.entity_id = e.event_id
            AND d.change_type = 'updated'
            AND d.change_source IN ('EventService.update', 'CalendarEventService.update')
            AND d.changed_fields ? 'detail_updated'
            AND d.changed_at < '2026-09-16T02:58:13Z');

-- Title, exactly, for the Google Calendar transform's rows.
UPDATE ci.events e
   SET source_title = CASE WHEN COALESCE(e.metadata->>'rawEventSummary', '') = ''
                           THEN 'Untitled Event'
                           ELSE e.metadata->>'rawEventSummary'
                      END
 WHERE e.source_title IS NULL
   AND e.source_id IS NOT NULL
   AND e.source_type = 'ETL'
   AND e.metadata ? 'rawEventId'
   AND NOT (e.metadata ? 'originalStartTime');

-- Title, for every other source row nobody renamed: what it shows.
UPDATE ci.events e
   SET source_title = b.name
  FROM ci.entities b
 WHERE b.entity_id = e.event_id
   AND b.name IS NOT NULL
   AND e.source_title IS NULL
   AND e.source_id IS NOT NULL
   AND e.source_type IS DISTINCT FROM 'planning'
   AND NOT EXISTS (
         SELECT 1
           FROM ci.graph_deltas d
          WHERE d.entity_id = e.event_id
            AND d.change_type = 'updated'
            AND d.changed_fields ? 'name'
            AND (NOT (d.changed_fields->'name' ? 'old')
                 OR d.changed_fields->'name'->'old' IS DISTINCT FROM d.changed_fields->'name'->'new'));

-- migrate:down
ALTER TABLE ci.events DROP COLUMN IF EXISTS source_title;
ALTER TABLE ci.events DROP COLUMN IF EXISTS source_recurrence;
ALTER TABLE ci.events DROP COLUMN IF EXISTS source_end_time;
ALTER TABLE ci.events DROP COLUMN IF EXISTS source_start_time;
