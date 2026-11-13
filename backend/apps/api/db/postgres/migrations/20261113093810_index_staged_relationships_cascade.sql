-- migrate:up
-- Index the two columns of ci_import.staged_relationships that cascade from
-- ci_import.staged_items, so deleting staged items does not read the whole
-- relationships table once per item.
--
-- ## Why
--
-- `item_id` and `related_item_id` both reference `ci_import.staged_items(id)
-- ON DELETE CASCADE`. Every staged item a discard or the retention sweep
-- deletes (`ImportRetentionService.deleteBatched`, 5,000 at a time) fires two
-- cascade lookups, `WHERE $1 = item_id` and `WHERE $1 = related_item_id`. The
-- only indexes on those columns are the two partial unique ones from
-- 20260810164304_create_ci_import_schema, `(item_id, entity_id, relation) WHERE
-- entity_id IS NOT NULL` and `(item_id, related_item_id, relation) WHERE
-- related_item_id IS NOT NULL`:
--
--  - `item_id = $1` implies neither predicate, so neither index can serve it
--    and every deleted item is a sequential scan of the table.
--  - `related_item_id = $1` is not the leading column of either. Postgres 18
--    answers it with a skip scan of staged_relationships_item_related_uniq,
--    one descent per distinct item_id, so once a run has many item-to-item
--    edges (mail and its attachments) every deleted item walks that whole
--    index.
--
--   EXPLAIN DELETE FROM ci_import.staged_relationships WHERE item_id = '<uuid>';
--   -- before: Seq Scan on staged_relationships, Filter: (item_id = ...)
--   -- after:  Index Scan using staged_relationships_item_idx
--
-- That made a discard quadratic in the run's size. A 60,000-line WhatsApp parse
-- (60,000 staged items, 60,000 staged relationships) took 117 s to discard on a
-- laptop and 45 s on a test machine, 120,000 lines took 176 s there, and a
-- 400,000-line chat ran for about three hours while holding database
-- connections and blocking every other Discard on the Sync card.
--
-- `related_item_id` is partial on IS NOT NULL: most edges point at an entity
-- and leave it NULL, and the cascade's `related_item_id = $1` implies the
-- predicate, so the index still serves it.
--
-- ## Why not CONCURRENTLY
--
-- dbmate runs each migration inside a transaction, which `CREATE INDEX
-- CONCURRENTLY` cannot run in; 20260819000439_add_position_id_index documents
-- the same trade-off. `staged_relationships` keeps a finished run's edges until
-- the retention sweep takes them (`stagingDays`, 7 by default), and keeps a
-- parse that was never pushed until its owner discards it. On most appliances
-- that is small, the build is short and it happens at migrate time. An operator
-- holding a large staged parse (ImportRetentionService measured one run at
-- 780,946 items) can build both out of band first, after which this is a no-op
-- through IF NOT EXISTS:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS staged_relationships_item_idx
--     ON ci_import.staged_relationships (item_id);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS staged_relationships_related_item_idx
--     ON ci_import.staged_relationships (related_item_id) WHERE related_item_id IS NOT NULL;
--
-- A CONCURRENTLY build that fails or is cancelled leaves an INVALID index under
-- the same name. IF NOT EXISTS would take that as done, record this migration
-- as applied and leave the cascade scanning, so an invalid leftover is dropped
-- first and rebuilt here.
DO $$
DECLARE
    leftover regclass;
BEGIN
    FOR leftover IN
        SELECT i.indexrelid::regclass
          FROM pg_catalog.pg_index i
         WHERE NOT i.indisvalid
           AND i.indexrelid IN (
                 to_regclass('ci_import.staged_relationships_item_idx'),
                 to_regclass('ci_import.staged_relationships_related_item_idx'))
    LOOP
        EXECUTE format('DROP INDEX %s', leftover);
    END LOOP;
END
$$;

CREATE INDEX IF NOT EXISTS staged_relationships_item_idx
    ON ci_import.staged_relationships (item_id);

CREATE INDEX IF NOT EXISTS staged_relationships_related_item_idx
    ON ci_import.staged_relationships (related_item_id)
    WHERE related_item_id IS NOT NULL;

COMMENT ON INDEX ci_import.staged_relationships_item_idx IS
  'Serves the ON DELETE CASCADE from ci_import.staged_items through item_id. Without it every deleted staged item scanned the whole table, which made discarding a large parse take hours.';

COMMENT ON INDEX ci_import.staged_relationships_related_item_idx IS
  'Serves the ON DELETE CASCADE from ci_import.staged_items through related_item_id, for runs with many item-to-item edges (mail and its attachments).';

-- migrate:down
DROP INDEX IF EXISTS ci_import.staged_relationships_related_item_idx;
DROP INDEX IF EXISTS ci_import.staged_relationships_item_idx;
