-- migrate:up
-- Repair: a Google Takeout reservation the user cancelled is stored with
-- `status = 'confirmed'`.
--
-- ## The bug
--
-- google_purchases.ts recorded Google's `canceled: true` only as
-- `metadata.Canceled`, a JSON boolean, and left `ci.events.status` at its
-- DEFAULT. Every reader that asks whether an event happened reads the column,
-- not that key: the calendar and planner (`LIVE_EVENT_SQL`), daily metrics'
-- meeting counts, HBPE's schedule reconciliation and Known places. So each of
-- them counted a booking the user cancelled.
--
-- Fixed for future imports in the same commit: the datasource states
-- `eventStatus: 'cancelled'`, and the push writes it to the column. A re-import
-- does NOT repair rows already stored. `INGEST_REFRESH_COLUMNS.event` is `[]`,
-- so a re-push of the same (source_system, source_id) finds the existing row
-- and leaves it as it is. So the stored rows are repaired here.
--
-- ## Scope guards
--
--  - `source_system = 'google_purchases'` and `metadata @> '{"Canceled": true}'`:
--    exactly what the importer wrote for a cancellation. It only ever wrote a
--    JSON boolean, never a string. `Canceled: false` and rows without the key
--    are left alone.
--  - `status = 'confirmed'`: only a row still at the DEFAULT. A status set since
--    then (`completed`, `no_show`, ...) is kept.
--  - Tombstoned rows are included. The column should be right if one is ever
--    restored.
--
-- `metadata.eventStatus` is stamped too, so a repaired row matches what a
-- fresh import writes now.
--
-- Nothing needs re-arming. The search index does not read status, and Known
-- places, the calendar and HBPE's reconciliation read it live. Two things stay
-- as they are. HBPE's token-stream queries do not filter on status at all, so
-- training still sees these rows; that is a reader-side change. And daily
-- metrics recompute only the 180 most recent days with data, so a figure
-- already stored for an older day keeps counting the booking.
--
-- ## .ics events cannot be repaired here
--
-- calendar.ts ignored the VEVENT's STATUS and kept no copy of it, so a
-- cancelled event and a confirmed one are stored identically. The database has
-- nothing to repair from. Only the source file records which were cancelled,
-- and re-importing it will not rewrite a stored row, for the reason above.
-- Repairing one takes the file: parse it with `parseIcsEvents`, collect the ids
-- whose `status` is 'cancelled', and update the rows whose
-- (source_system = 'calendar', source_id) match them.
--
-- ## Measured on the reference corpus
--
-- 42 google_purchases reservations. 5 are `Canceled: true` (4 bookings, 1
-- waitlist entry), all still 'confirmed'. This statement updates those 5, and
-- running it again updates 0. The four .ics exports behind the corpus's 1,841
-- calendar rows hold 1,843 VEVENTs: 1,785 CONFIRMED, 58 TENTATIVE and no
-- CANCELLED. So there is no .ics row to repair there either.

UPDATE ci.events
   SET status = 'cancelled',
       metadata = metadata || '{"eventStatus": "cancelled"}'::jsonb,
       updated_at = now()
 WHERE source_system = 'google_purchases'
   AND metadata @> '{"Canceled": true}'::jsonb
   AND status = 'confirmed';

-- ## Post-migration verification
--
-- Should be 0:
--   SELECT count(*) FROM ci.events
--    WHERE source_system = 'google_purchases'
--      AND metadata @> '{"Canceled": true}'::jsonb
--      AND status = 'confirmed';

-- migrate:down
-- No-op, by design. Putting these rows back to 'confirmed' would bring back the
-- bug, and `metadata.Canceled` stays on every row, so the repair can be run
-- again at any time.
