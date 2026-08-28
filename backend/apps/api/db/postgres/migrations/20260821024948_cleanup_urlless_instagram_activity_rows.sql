-- migrate:up
-- Remove the Instagram activity ci.content rows written between the two halves
-- of the parser fix -- the ones that carry the post's permalink INSIDE their
-- text and nowhere else, because the parser had learned to title an entry but
-- had not yet learned to read the href it hangs on.
--
-- Companion to 20260819001323_cleanup_contentless_instagram_activity_rows.sql,
-- which deletes the same lanes' rows in their EARLIER shape. Same cause, same
-- lanes, one predicate apart -- see below for why one migration could not
-- cover both.
--
-- ## Why a second cleanup exists at all
--
-- The Instagram HTML fix landed as two commits:
--
--   08857ee9a  "title Instagram activity by what it is"
--              -> stamps metadata.Title / Description, so `text` is populated
--   ae4db5d6e  "read the Instagram entry, not the label around it"
--              -> stamps metadata.URL / PostId / Author / Handle / URI from
--                 the entry's <a href>, so `url` is populated
--
-- 20260819001323 was written against an appliance imported BEFORE the first of
-- those, where the rows had a blank text AND a blank url, and its predicate
-- says so: `coalesce(btrim(text), '') = ''`. An appliance imported BETWEEN the
-- two commits has the intermediate shape -- text present, url blank -- and
-- every one of those rows sails straight through that predicate. Measured on a
-- real appliance: 39 Instagram content rows, 6 matched (the media lane), 33 did
-- not.
--
-- ## Why they must be DELETED, not left to a re-import
--
-- INGEST_REFRESH_COLUMNS.content is `[]`, so a re-ingest of an existing
-- provenance triple is find-or-return: the stale row is never updated in place.
-- What happens next depends on the lane:
--
--  * The four post-bearing lanes (liked_posts, saved_posts, reposts,
--    stories_viewed) now mint metadata.URI = 'instagram:p:<shortcode>', and
--    push/inputs.ts toContentInput makes that URI the content row's source_id.
--    So the repaired row arrives under a DIFFERENT source_id than the stale
--    one and the two coexist forever -- 31 permanent duplicates.
--  * saved_collections has no single post to key on, so its 2 rows keep their
--    source_id and are simply returned untouched -- stale forever.
--
-- Deleting first is what turns the next import into a create instead of a
-- no-op or a duplicate. Nothing is repairable in place: the permalink, the
-- owner handle and the shortcode were never persisted in any column, only in
-- the export on disk.
--
-- ## Why the fixed parser cannot re-create this shape
--
-- Verified by running the current parser over the same export
-- (datasources/instagram.ts processHtmlActivity): all 33 entries now resolve a
-- permalink via firstWebLink and carry metadata.URL, which push/inputs.ts maps
-- to ci.content.url. A row whose own text quotes an instagram.com link while
-- `url` and `source_data->'URL'` are both empty is no longer a shape this
-- importer can produce.
--
-- ## The predicate, and why it is evidence-based rather than a lane list
--
-- The row must carry the permalink in `text` while neither `url` nor
-- `source_data->'URL'` has it. That is self-evidencing -- the row itself proves
-- the parser saw the link and failed to map it -- and it cannot catch a
-- correctly imported row of any lane, including the lanes that legitimately
-- have no permalink at all (checkout_payment_information,
-- recently_viewed_items, followers, following: verified URL-less both before
-- and after the fix, so a lane list would have deleted rows a re-import
-- recreates identically).
--
-- `source_id NOT LIKE '%/%'` keeps DMs out: a message id is
-- `instagram:msg:<relative/path>.html#<i>`, which would otherwise match the
-- `instagram:%.html#%` shape, and a DM quoting an instagram.com link is a real
-- message with real text. `external_id IS NULL` keeps a row whose media leg has
-- run (external_id_kind = 'file') safe, same guard as 20260819001323.
--
-- ## Verified against a real appliance database before writing this migration
--
--   SELECT split_part(source_id,'#',1) AS lane, type, count(*)
--     FROM ci.content WHERE source_system = 'instagram' GROUP BY 1,2;
--   -- liked_posts       like            22
--   -- reposts           post             5
--   -- stories_viewed    social_bookmark  3
--   -- saved_collections social_bookmark  2
--   -- saved_posts       social_bookmark  1   (33 total; the 6 rows
--   --                                         20260819001323 removed are gone)
--
--   -- All 33 match the predicate below; 0 rows outside it are touched.
--
--   -- Reference audit for the 33 content ids (only ci.content and ci.events
--   -- carry FKs to ci.entities; ci.relationships, ci_search.*,
--   -- ci.pipeline_state and ci.graph_deltas hold plain uuid columns and are
--   -- cleaned by hand, exactly as in 20260819001323):
--   --   ci.entities                33   <- deleted (cascades to ci.content)
--   --   ci_search.embeddings       33   <- deleted
--   --   ci_search.vectors          33   <- deleted
--   --   ci.pipeline_state          99   <- deleted
--   --   ci.graph_deltas            33   <- deleted
--   --   ci.relationships (from)    33   <- deleted (DOCUMENTS -> its event)
--   --   ci.relationships (to)       0
--   --   hbpe.content_context        0   <- FK, deleted defensively
--   --   hbpe.l2_content_cluster     0   <- FK, deleted defensively
--   --   ci_search.entity_tag        0
--   --   ci_search.index_skips       0
--   --   ci.entity_identifiers       0
--   --   ci.pipeline_dead_letters    0
--
-- ## What is deliberately NOT touched: the 33 sibling ci.events rows
--
-- Each of these content rows has an event beside it
-- (instagram:liked_posts.html#<i>, kind social.like, event_type like) carrying
-- the pre-fix Title too. They are left alone on purpose:
--
--  * Their identity is CORRECT. The event's source_id is not re-keyed by the
--    fix -- push/inputs.ts stamps the URI onto the content row only, and says
--    so -- so a re-import finds the same event rather than duplicating it. The
--    duplication argument that justifies deleting the content rows does not
--    apply here.
--  * Deleting them would LOSE data until a re-import happens: the event is the
--    only row that dates the like. A stale content blob beside a correct event
--    is worse than nothing; a deleted event is nothing.
--
-- The cost is that their `metadata.Title` stays the coarse "Instagram like"
-- rather than "Instagram like -- <subject>" until INGEST_REFRESH_COLUMNS.event
-- stops being `[]`. That is a contract change for a separate commit, not
-- something to smuggle in behind a DELETE.
--
-- Idempotent: every statement recomputes the same predicate (cheap at 33 rows),
-- so a second run selects zero rows. Ordered so each hand-cleaned table is
-- emptied while ci.content still exists to select from; the ci.entities delete
-- goes last and takes ci.content with it through content_id_entities_fk
-- (ON DELETE CASCADE).

WITH bad_content AS (
  SELECT id
    FROM ci.content
   WHERE source_system = 'instagram'
     AND source_id LIKE 'instagram:%.html#%'
     AND source_id NOT LIKE '%/%'
     AND external_id IS NULL
     AND coalesce(btrim(url), '') = ''
     AND source_data->>'URL' IS NULL
     AND text ~ 'https?://(www\.)?instagram\.com/'
)
DELETE FROM ci.relationships r
 USING bad_content bad
 WHERE r.from_entity_id = bad.id
    OR r.to_entity_id = bad.id;

WITH bad_content AS (
  SELECT id
    FROM ci.content
   WHERE source_system = 'instagram'
     AND source_id LIKE 'instagram:%.html#%'
     AND source_id NOT LIKE '%/%'
     AND external_id IS NULL
     AND coalesce(btrim(url), '') = ''
     AND source_data->>'URL' IS NULL
     AND text ~ 'https?://(www\.)?instagram\.com/'
)
DELETE FROM ci_search.embeddings emb
 USING bad_content bad
 WHERE emb.entity_type = 'content'
   AND emb.entity_id = bad.id;

WITH bad_content AS (
  SELECT id
    FROM ci.content
   WHERE source_system = 'instagram'
     AND source_id LIKE 'instagram:%.html#%'
     AND source_id NOT LIKE '%/%'
     AND external_id IS NULL
     AND coalesce(btrim(url), '') = ''
     AND source_data->>'URL' IS NULL
     AND text ~ 'https?://(www\.)?instagram\.com/'
)
DELETE FROM ci_search.vectors v
 USING bad_content bad
 WHERE v.entity_type = 'content'
   AND v.entity_id = bad.id;

WITH bad_content AS (
  SELECT id
    FROM ci.content
   WHERE source_system = 'instagram'
     AND source_id LIKE 'instagram:%.html#%'
     AND source_id NOT LIKE '%/%'
     AND external_id IS NULL
     AND coalesce(btrim(url), '') = ''
     AND source_data->>'URL' IS NULL
     AND text ~ 'https?://(www\.)?instagram\.com/'
)
DELETE FROM ci.pipeline_state ps
 USING bad_content bad
 WHERE ps.entity_type = 'content'
   AND ps.entity_id = bad.id;

WITH bad_content AS (
  SELECT id
    FROM ci.content
   WHERE source_system = 'instagram'
     AND source_id LIKE 'instagram:%.html#%'
     AND source_id NOT LIKE '%/%'
     AND external_id IS NULL
     AND coalesce(btrim(url), '') = ''
     AND source_data->>'URL' IS NULL
     AND text ~ 'https?://(www\.)?instagram\.com/'
)
DELETE FROM ci.graph_deltas gd
 USING bad_content bad
 WHERE gd.entity_id = bad.id;

WITH bad_content AS (
  SELECT id
    FROM ci.content
   WHERE source_system = 'instagram'
     AND source_id LIKE 'instagram:%.html#%'
     AND source_id NOT LIKE '%/%'
     AND external_id IS NULL
     AND coalesce(btrim(url), '') = ''
     AND source_data->>'URL' IS NULL
     AND text ~ 'https?://(www\.)?instagram\.com/'
)
DELETE FROM hbpe.content_context cc
 USING bad_content bad
 WHERE cc.content_id = bad.id;

WITH bad_content AS (
  SELECT id
    FROM ci.content
   WHERE source_system = 'instagram'
     AND source_id LIKE 'instagram:%.html#%'
     AND source_id NOT LIKE '%/%'
     AND external_id IS NULL
     AND coalesce(btrim(url), '') = ''
     AND source_data->>'URL' IS NULL
     AND text ~ 'https?://(www\.)?instagram\.com/'
)
DELETE FROM hbpe.l2_content_cluster lc
 USING bad_content bad
 WHERE lc.content_id = bad.id;

-- Deleting the ci.entities base row removes the ci.content row with it
-- (content_id_entities_fk, ON DELETE CASCADE). The subquery is evaluated
-- against the statement's own snapshot, before the referential action fires.
DELETE FROM ci.entities e
 WHERE e.entity_type = 'Content'
   AND e.entity_id IN (
     SELECT id
       FROM ci.content
      WHERE source_system = 'instagram'
        AND source_id LIKE 'instagram:%.html#%'
        AND source_id NOT LIKE '%/%'
        AND external_id IS NULL
        AND coalesce(btrim(url), '') = ''
        AND source_data->>'URL' IS NULL
        AND text ~ 'https?://(www\.)?instagram\.com/'
   );

-- ## Verify after applying
--
-- Should now be 0 (no Instagram activity row hiding its own permalink in its
-- text):
--   SELECT count(*) FROM ci.content
--    WHERE source_system = 'instagram'
--      AND coalesce(btrim(url), '') = ''
--      AND source_data->>'URL' IS NULL
--      AND text ~ 'https?://(www\.)?instagram\.com/';
--
-- Should now be 0 (nothing dangling in the hand-cleaned tables):
--   SELECT count(*) FROM ci_search.vectors v
--    WHERE v.entity_type = 'content'
--      AND NOT EXISTS (SELECT 1 FROM ci.entities e WHERE e.entity_id = v.entity_id);
--
-- Instagram DMs (ci.communications) and the 33 sibling ci.events rows are
-- untouched; their counts should be UNCHANGED.
--
-- Re-import the Instagram export afterwards to repopulate: each like, save,
-- repost and story view comes back with its permalink, its owner handle, and
-- one content row per POST instead of one per activity entry.

-- migrate:down
-- No-op: irreversible data cleanup, same reasoning as
-- 20260819001323_cleanup_contentless_instagram_activity_rows and the other
-- backfill migrations in this directory. The values these rows lacked were
-- never persisted anywhere, so there is nothing to restore them to, and
-- nothing records which rows were deleted versus already absent. Re-importing
-- the Instagram export is the forward path.
