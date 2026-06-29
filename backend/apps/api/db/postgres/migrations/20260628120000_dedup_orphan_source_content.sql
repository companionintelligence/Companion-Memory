-- migrate:up
-- Reclaim source-bearing ci.content rows the prior backfill could not reach.
--
-- 20260628000000_backfill_content_user_id recovers user_id by joining
-- content.event_id -> ci.events.user_id. That covers content that shadows an
-- event (media events, calendar attachments). Sources that route ONLY to the
-- content table -- spotify play history, last.fm, google_maps_places, isolated
-- bookmarks -- have no event row to join, so their NULL-user rows survived.
--
-- Until 437d66b3, every re-sync also inserted fresh duplicates of those rows:
-- ContentEntity.userId was insert:false, so the createContents path persisted
-- user_id = NULL on every insert, and the content_source_triple_uniq partial
-- unique index cannot dedupe across NULL user_ids (NULL is distinct from NULL).
-- On Liam's appliance this left 292,738 source-bearing NULL rows covering
-- 121,169 distinct triples (~2.4x amplification), most of them spotify.
--
-- This migration is the source-bearing analogue of 20260628000000:
--   1. Drop NULL-user rows whose triple is ALREADY owned by the appliance user
--      (pure noise -- the owned row is the canonical copy).
--   2. Collapse the remaining NULL-user rows to one earliest-wins survivor per
--      triple, deleting the rest.
--   3. Assign the appliance owner to the surviving orphan rows. Step 1 made
--      the triples disjoint from owned rows and step 2 made them unique among
--      NULL rows, so this UPDATE cannot violate content_source_triple_uniq.
--
-- Single-user only. Multi-user installs cannot safely attribute an orphan
-- source-bearing row without a join, and warrant a manual sweep. Idempotent:
-- a second run finds no NULL-user, source-bearing rows.

DO $$
DECLARE
  appliance_user uuid;
  user_count int;
  deleted_owned int := 0;
  deleted_dupe int := 0;
  rescued int := 0;
BEGIN
  SELECT count(*) INTO user_count FROM ci.users;
  IF user_count <> 1 THEN
    RAISE NOTICE 'dedup_orphan_source_content: multi-user install (% users) -- skipping', user_count;
    RETURN;
  END IF;
  SELECT id INTO appliance_user FROM ci.users;

  -- 1. Drop NULL-user rows whose triple is already owned by the appliance user.
  WITH d AS (
    DELETE FROM ci.content c
     WHERE c.user_id IS NULL
       AND c.source_id IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM ci.content o
          WHERE o.user_id = appliance_user
            AND o.source_id = c.source_id
            AND o.source_type IS NOT DISTINCT FROM c.source_type
            AND o.source_system IS NOT DISTINCT FROM c.source_system
       )
    RETURNING 1
  )
  SELECT count(*) INTO deleted_owned FROM d;

  -- 2. Collapse each remaining NULL-user triple to one earliest-wins survivor.
  WITH ranked AS (
    SELECT id,
           row_number() OVER (
             PARTITION BY source_type, source_system, source_id
             ORDER BY created_at, id
           ) AS rn
      FROM ci.content
     WHERE user_id IS NULL
       AND source_id IS NOT NULL
  ),
  d AS (
    DELETE FROM ci.content c
     USING ranked r
     WHERE c.id = r.id AND r.rn > 1
    RETURNING 1
  )
  SELECT count(*) INTO deleted_dupe FROM d;

  -- 3. Assign the appliance owner to the surviving orphan rows.
  WITH u AS (
    UPDATE ci.content
       SET user_id = appliance_user
     WHERE user_id IS NULL
       AND source_id IS NOT NULL
    RETURNING 1
  )
  SELECT count(*) INTO rescued FROM u;

  RAISE NOTICE 'dedup_orphan_source_content: dropped % already-owned dupes, % NULL-group dupes; assigned owner to % rows',
    deleted_owned, deleted_dupe, rescued;
END $$;

-- migrate:down
-- No-op: irreversible cleanup. Pre-cleanup NULL-user rows were unattributable
-- duplicates of either an owned row (step 1) or an earliest-wins survivor (step 2),
-- not meaningful state.
