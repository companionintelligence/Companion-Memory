-- migrate:up
-- Give ci.events the one fact a status refresh needs and never had: the status
-- the row's SOURCE last delivered, kept apart from the status the row shows.
--
-- WHY. A calendar connection re-delivers a meeting when it changes — Google
-- through its sync token, with showDeleted=true — and CalendarEventService's
-- createOne found the stored row by its identity and returned it verbatim. A
-- meeting that was confirmed at its first sync and cancelled afterwards
-- therefore stayed 'confirmed' for good, on the calendar and in the planner's
-- occupancy alike. Overwriting `status` on every re-delivery is
-- not the fix, because `status` is also the user's: updateEvent writes it, and
-- a meeting the user marked tentative or no_show must stay that way. The two
-- cannot be told apart from `status` alone.
--
-- WHAT. `source_status` is the merge base. createOne now applies a re-delivered
-- status only while the row still shows what its source last said
-- (status = COALESCE(source_status, 'confirmed')), and records the new value
-- as the base either way — a three-way merge, so a user's edit stands until
-- the source comes round to agreeing with it. NULL means no source ever
-- asserted a status for the row, which leaves it at the column DEFAULT; the
-- COALESCE says exactly that. Nothing user-facing writes this column:
-- UpdateEventDto has no field for it.
--
-- BACKFILL. Two writers left a record of the status their source stated, so the
-- base is known exactly for their rows. That matters for the rows the COALESCE
-- would get wrong: one that was already 'tentative' or 'cancelled' when it
-- arrived would otherwise read as a user's edit, and a later confirm or restore
-- from a calendar connection would never land. A row whose status differs from
-- its backfilled base was changed after it arrived, which is the definition of
-- an edit this refresh must leave alone.
--
--  1. The Google Calendar transform has recorded Google's own status on every
--     row it wrote, as metadata.rawEventStatus. Mapped through the table its
--     normalizeStatus uses: anything else, including a missing value, became
--     'confirmed'.
--  2. The importer has stated a status since #2871 (its repair migration is
--     20260930174042): an .ics VEVENT's STATUS, a cancelled Takeout
--     reservation. It writes the stated
--     value to `status` and keeps it as metadata.eventStatus, and the push sends
--     only the three values below (canonical.ts importedEventStatus), so any
--     other value there never reached `status`. 58 of the reference corpus's
--     1,843 VEVENTs are TENTATIVE.
--
-- Rows with no such evidence stay NULL, which reads as 'confirmed': Outlook rows
-- (the transform keeps no raw status, and Outlook skips cancelled events
-- entirely), rows imported before #2871, capture rows, and user-created rows
-- (no source at all).
ALTER TABLE ci.events ADD COLUMN IF NOT EXISTS source_status text;

COMMENT ON COLUMN ci.events.source_status IS
  'The status this row''s source last delivered: the merge base for the status '
  'refresh in CalendarEventService.createOne. A re-delivered status is applied '
  'only while status = COALESCE(source_status, ''confirmed''); otherwise the user '
  'changed it and it stands. NULL when no source has asserted a status. Never '
  'user-writable.';

UPDATE ci.events
   SET source_status = CASE lower(metadata->>'rawEventStatus')
                         WHEN 'cancelled' THEN 'cancelled'
                         WHEN 'tentative' THEN 'tentative'
                         ELSE 'confirmed'
                       END
 WHERE source_status IS NULL
   AND source_id IS NOT NULL
   AND source_type = 'ETL'
   AND metadata ? 'rawEventStatus';

UPDATE ci.events
   SET source_status = metadata->>'eventStatus'
 WHERE source_status IS NULL
   AND source_id IS NOT NULL
   AND source_type = 'ci-import-tools'
   AND metadata->>'eventStatus' IN ('confirmed', 'tentative', 'cancelled');

-- migrate:down
ALTER TABLE ci.events DROP COLUMN IF EXISTS source_status;
