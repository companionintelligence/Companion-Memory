-- migrate:up
-- Backfill ci.content.user_id for rows the relation-only insert left NULL.
--
-- Until this fix, ContentEntity.userId was mapped insert:false, so
-- ContentService.create / createMany wrote the owner through the `user` relation
-- only. Because the relation's FK and the scalar column share the same DB column,
-- the write was shadowed and user_id persisted as NULL on every insert. That
-- silently broke every user_id-scoped read (the search-index listener dropped the
-- row, the batch-ingest idempotency dedupe never matched, content exports came
-- back empty) and let re-syncs insert duplicate rows — NULLs are distinct in the
-- content_source_triple_uniq partial unique index, so the dedupe index could not
-- fire while user_id was NULL.
--
-- Recover the owner from the linked event (content.event_id -> ci.events.user_id),
-- the same join the media-thumbnail read path already relies on.

-- 1. Source-bearing rows (governed by content_source_triple_uniq). A re-sync may
--    have inserted duplicates of the same (user, triple) while user_id was NULL;
--    fill only ONE row per group (earliest wins) so setting user_id cannot violate
--    the partial unique index. Duplicate losers stay NULL and remain invisible to
--    user-scoped reads — a separate dedupe can remove them later.
WITH ranked AS (
  SELECT c.id,
         e.user_id AS owner_id,
         row_number() OVER (
           PARTITION BY e.user_id, c.source_type, c.source_system, c.source_id
           ORDER BY c.created_at, c.id
         ) AS rn
    FROM ci.content c
    JOIN ci.events e ON e.event_id = c.event_id
   WHERE c.user_id IS NULL
     AND c.source_id IS NOT NULL
     AND e.user_id IS NOT NULL
     -- Skip a triple already owned by that user, so this is safe to re-run: on a
     -- second pass a leftover NULL duplicate would otherwise become rn=1 and
     -- collide with the row filled on the first pass.
     AND NOT EXISTS (
       SELECT 1
         FROM ci.content owned
        WHERE owned.user_id = e.user_id
          AND owned.source_id = c.source_id
          AND owned.source_type IS NOT DISTINCT FROM c.source_type
          AND owned.source_system IS NOT DISTINCT FROM c.source_system
     )
)
UPDATE ci.content c
   SET user_id = r.owner_id
  FROM ranked r
 WHERE c.id = r.id
   AND r.rn = 1;

-- 2. Rows without a provenance source_id are not governed by the unique index,
--    so they can be filled directly from their linked event with no collision risk.
UPDATE ci.content c
   SET user_id = e.user_id
  FROM ci.events e
 WHERE c.event_id = e.event_id
   AND c.user_id IS NULL
   AND c.source_id IS NULL
   AND e.user_id IS NOT NULL;

-- 3. Single-user appliance recovery: content with no event link (manual notes,
--    derived rows) and no provenance triple cannot infer an owner from a join.
--    When the install has exactly one user, that user is the unambiguous owner.
--    No-op in multi-user installs. Restricted to source_id IS NULL so it can never
--    collide on content_source_triple_uniq.
UPDATE ci.content
   SET user_id = (SELECT id FROM ci.users)
 WHERE user_id IS NULL
   AND source_id IS NULL
   AND (SELECT count(*) FROM ci.users) = 1;

-- migrate:down
-- No-op: irreversible data backfill. The pre-backfill NULLs were a data-integrity
-- bug, not meaningful state, and the original NULL/non-NULL split is not recorded.
