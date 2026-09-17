-- migrate:up
-- Read-time recurrence expansion adds a second read to the calendar's hot path,
-- and it is deliberately NOT bounded the way the first one is.
--
-- `findInRange` floors `start_time` at MAX_EVENT_LOOKBACK_DAYS (92 days) so the
-- (user_id, start_time DESC) index has something to stop at — without that floor
-- the scan costs O(every event the user owns before `to`), which on a
-- photo-heavy `ci.events` is the whole table. `findRecurringMasters` cannot use
-- that floor: a weekly standup that started three years ago is precisely the
-- series whose occurrences land in the window being asked for, and flooring it
-- would make the expander blind to every series older than a quarter.
--
-- So the masters read is unfloored by design, and would reintroduce exactly the
-- seq scan the floor was added to kill. This partial index is what pays for it:
-- the predicate matches the query's own `is_recurring AND NOT is_deleted`, so
-- only series masters are indexed — a few rows per user rather than the tens of
-- thousands `events_user_time_idx` covers — and `source_system` is included
-- because the query filters on it too (only federated calendar rows carry a
-- rule worth expanding).

CREATE INDEX IF NOT EXISTS events_user_recurring_idx
    ON ci.events (user_id, start_time DESC)
    INCLUDE (source_system)
    WHERE is_recurring AND NOT is_deleted;

-- migrate:down

DROP INDEX IF EXISTS ci.events_user_recurring_idx;
