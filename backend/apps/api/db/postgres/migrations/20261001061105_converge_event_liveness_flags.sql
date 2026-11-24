-- migrate:up
-- =====================================================================
-- EVENT AGGREGATES — make the two liveness flags agree
-- =====================================================================
-- An event is two rows: the `ci.entities` base row, whose `is_active` every
-- graph reader goes by, and the `ci.events` detail row, whose `is_deleted`
-- every event reader goes by. `CalendarEventService.remove` now writes both
-- together, and `restore` clears both. Two populations were written before it
-- did, each hidden from the readers of the flag it did not set.
--
-- 1. DELETED, BASE STILL ACTIVE. An event deleted from the app set `is_deleted`
--    and left the base row active, so the graph explorer, the node counts and
--    the deterministic edge matrix (which joins both endpoints on
--    `is_active`) all went on treating it as live. The base row is
--    deactivated here. Both rows stay, so Undo still works.
--
-- 2. FORGOTTEN, DETAIL STILL LIVE. `memory.forget` deactivated the base row and
--    never touched `is_deleted`, so the calendar, Known places, the location
--    enrichment stages and HBPE went on returning an event the user had asked
--    the appliance to forget, and nothing removed it from search. The only
--    thing that deactivates an `Event` base row is that tool: the other
--    writers of `is_active = FALSE` are the person, place and object merges,
--    which do not touch events. A merge tombstone (`merged_into_entity_id`) is
--    excluded all the same, so a row inactive for that reason can never be
--    read as a forgotten one. Each such event is moved to the trash, the state
--    the tool now leaves behind, and its search rows are removed with it. That
--    is the other half of what `CalendarEventService.remove` does, and it is
--    what `memory.forget` never did for an event. The orphan sweep cannot
--    reach those rows later, because the event still exists.
--
-- The two populations are disjoint: step 1 matches only active base rows and
-- step 2 only inactive ones. `updated_at` is bumped on every row written, so
-- anything that sweeps these tables by it sees the change.
--
-- Idempotent. A repaired row no longer matches either predicate.

-- 1. Deleted events: deactivate the base row.
UPDATE ci.entities e
   SET is_active = FALSE,
       updated_at = now()
  FROM ci.events ev
 WHERE ev.event_id = e.entity_id
   AND e.entity_type = 'Event'
   AND ev.is_deleted
   AND e.is_active;

-- 2. Forgotten events: tombstone them and drop their search rows. One
--    statement, so the rows to un-index are exactly the rows just tombstoned.
WITH forgotten AS (
  UPDATE ci.events ev
     SET is_deleted = TRUE,
         updated_at = now()
    FROM ci.entities e
   WHERE e.entity_id = ev.event_id
     AND e.entity_type = 'Event'
     AND NOT e.is_active
     AND e.merged_into_entity_id IS NULL
     AND NOT ev.is_deleted
  RETURNING ev.event_id
), unindexed AS (
  DELETE FROM ci_search.vectors v
   USING forgotten f
   WHERE v.entity_type = 'event'
     AND v.entity_id = f.event_id
  RETURNING v.entity_id
)
DELETE FROM ci_search.embeddings m
 USING forgotten f
 WHERE m.entity_type = 'event'
   AND m.entity_id = f.event_id;

-- migrate:down
-- Deliberately no-op. The rows repaired above cannot be told apart from rows
-- that were written correctly after the fix, and reinstating the split would
-- bring forgotten events back onto the calendar.
