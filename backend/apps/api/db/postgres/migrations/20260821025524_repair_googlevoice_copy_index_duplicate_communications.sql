-- migrate:up
-- Remove the ci.communications rows a Google Voice export file produced when
-- the SAME file was imported twice under a copy index -- "… (2).html",
-- "…(1).html" -- now that datasources/googlevoice.ts strips that index before
-- the item is hashed (stripCopyIndex).
--
-- ## The bug
--
-- A Google Voice call/voicemail/message item carries no `item.id`, so
-- staging/identity.ts `hashItem` keys it on
-- `sha1(dataSource, classification, content.filename, isoTimestamp)`. The
-- filename is therefore half of its identity, and a Drive/Takeout copy index
-- makes one record hash several different ways. On the reference appliance one
-- 2013-06-14T15:07:34 call from Chris Spagnuolo sits in ci.communications
-- three times -- content_hash 52a8f91f… for "Chris Spagnuolo -
-- 2013-06-14T15_07_34Z.html", 55afe486… for "… (2).html" and 16e980aa… for
-- "… (3).html" -- describing the one call. Three content hashes are three
-- `source_id`s, so the `communications_source_triple_uniq` arbiter
-- (user_id, source_type, source_system, source_id) sees three unrelated rows
-- and can never merge them.
--
-- ## Why the rows are DELETED rather than left alone
--
-- This is a RE-KEY, not a tidy-up. The fixed parser hashes the copy under the
-- ORIGINAL file's name, so every one of these rows' provenance triples moves.
-- Leaving them would be strictly worse than doing nothing: the next import
-- writes the same record again under the new triple, the old row does not
-- conflict with it, and one duplicate becomes two -- permanently, because
-- nothing will ever emit the old triple again to update it.
--
-- Nothing unique is lost. Every row in range came from a file the SAME import
-- run also staged without the index, and on the reference appliance every one
-- of the 44 has a twin from that original file: 41 carry byte-identical
-- `content` at a timestamp within two seconds (Google Voice re-renders the
-- per-message `title` with jittered milliseconds between exports, which is why
-- they were not already collapsed by the arbiter), and the remaining 3 hold a
-- TAIL of the original's text -- e.g. "ot waiting forever." against the
-- original's "…Call me if your flight gets delayed or something so I'm not
-- waiting forever." Where the timestamps match exactly (call logs), the fixed
-- parser collapses the copy onto the surviving row at staging and it never
-- comes back; where the milliseconds drifted (messages), it comes back once,
-- under a triple that is finally stable.
--
-- ## Scope guards
--
-- Deliberately NARROW, because a "(n)" suffix is not always a copy:
--
--   1. `data_source = 'google_voice'` and `source_system = 'google_voice'`.
--      No other importer's filenames are examined or touched.
--   2. The index is recognised only when what remains ends in a COMPLETE
--      `T##_##_##Z` export timestamp -- the same anchor stripCopyIndex uses,
--      and the reason it exists: Google Voice truncates long filenames and
--      then appends its OWN "(n)" to break the collision, e.g. "Elisabeth
--      (Lisa) Turner - Missed - 2016-01-08T17_3(1).html" and "…T17_3(2).html",
--      which are two DIFFERENT calls minutes apart. 419 staged files on the
--      reference appliance have that shape and none is in range here.
--   3. The un-indexed filename must ALSO have been staged in the SAME import
--      run. That is what makes the file a copy of something we imported rather
--      than the only record of a conversation; without the original present,
--      the row stays.
--
-- If staging has been purged (ci_import.staged_items empty for these runs)
-- this migration selects and updates nothing, exactly as
-- 20260819000746_backfill_communications_thread_id_from_import_staging does.
-- The parser fix still holds for every future import.
--
-- ## Verified against a real appliance database before writing this migration
--
--   -- rows in range .......................................... 44
--   -- of which exact (time, content) duplicates of the original  8
--   -- of which same content within 2s (ms jitter) ............. 33
--   -- of which a text fragment of the original ................. 3
--   --
--   -- Reference audit for those 44 communication ids (ci.communications is
--   -- the only table with an FK -- to ci.entities; every other table below
--   -- holds a plain uuid and is cleaned by hand, exactly as in
--   -- 20260819001323_cleanup_contentless_instagram_activity_rows):
--   --   ci.entities                 44   <- deleted (cascades to ci.communications)
--   --   ci_search.vectors           44   <- deleted
--   --   ci_search.embeddings         2   <- deleted
--   --   ci.pipeline_state           48   <- deleted
--   --   ci.graph_deltas             44   <- deleted
--   --   ci.relationships (to)        4   <- deleted (SENT/RECEIVED from a Person)
--   --   ci.relationships (from)      0
--   --   ci_search.entity_tag         0
--   --   ci_search.index_skips        0
--   --   ci.pipeline_dead_letters     0
--   --   ci.content / ci.events       0   (a Google Voice HTML item becomes a
--   --                                     communication only; the MMS media
--   --                                     lane keys on the attachment's own
--   --                                     name, which stripCopyIndex does not
--   --                                     touch)
--
-- Idempotent: the working set joins ci.communications, so once these rows are
-- gone a second run materializes an EMPTY temp table and every statement
-- affects zero rows. The thread_id UPDATE is idempotent in its own right — a
-- value with the index already stripped no longer matches its own predicate.
--
-- The temp table is materialized BEFORE anything is deleted, so it still lists
-- the ids after the ci.entities delete cascades ci.communications away; that
-- delete goes last only because the hand-cleaned tables read better in
-- dependency order.

-- The working set, computed ONCE (same shape as the temp table in
-- 20260819145023_rekey_google_voice_short_code_concepts).
CREATE TEMP TABLE _gv_copy_index_dupes ON COMMIT DROP AS
WITH staged AS (
  SELECT s.run_id,
         s.content_hash,
         s.filename,
         regexp_replace(
           s.filename,
           '(T[0-9]{2}_[0-9]{2}_[0-9]{2}Z)[[:space:]]*\([0-9]+\)(\.[A-Za-z0-9]+)$',
           '\1\2'
         ) AS original_filename
    FROM ci_import.staged_items s
   WHERE s.data_source = 'google_voice'
     AND s.filename IS NOT NULL
),
copies AS (
  SELECT k.content_hash
    FROM staged k
   WHERE k.filename <> k.original_filename
     AND EXISTS (
       SELECT 1
         FROM staged b
        WHERE b.run_id = k.run_id
          AND b.filename = k.original_filename
     )
)
SELECT DISTINCT c.id
  FROM ci.communications c
  JOIN copies k ON k.content_hash = c.source_id
 WHERE c.source_system = 'google_voice';

CREATE INDEX ON _gv_copy_index_dupes (id);

DELETE FROM ci.relationships r
 USING _gv_copy_index_dupes bad
 WHERE r.from_entity_id = bad.id
    OR r.to_entity_id = bad.id;

DELETE FROM ci_search.embeddings emb
 USING _gv_copy_index_dupes bad
 WHERE emb.entity_id = bad.id;

DELETE FROM ci_search.vectors v
 USING _gv_copy_index_dupes bad
 WHERE v.entity_id = bad.id;

DELETE FROM ci_search.entity_tag t
 USING _gv_copy_index_dupes bad
 WHERE t.entity_id = bad.id;

DELETE FROM ci_search.index_skips s
 USING _gv_copy_index_dupes bad
 WHERE s.entity_id = bad.id;

DELETE FROM ci.pipeline_state ps
 USING _gv_copy_index_dupes bad
 WHERE ps.entity_id = bad.id;

DELETE FROM ci.pipeline_dead_letters dl
 USING _gv_copy_index_dupes bad
 WHERE dl.entity_id = bad.id;

DELETE FROM ci.graph_deltas gd
 USING _gv_copy_index_dupes bad
 WHERE gd.entity_id = bad.id;

-- Last: the base row takes ci.communications with it through
-- communications_id_entities_fk (ON DELETE CASCADE). The temp table is a
-- materialized snapshot, so it still lists the ids after the cascade fires.
DELETE FROM ci.entities e
 WHERE e.entity_type = 'Communication'
   AND e.entity_id IN (SELECT id FROM _gv_copy_index_dupes);

-- Google Voice threads a file that names nobody on the file's own identity
-- ("googlevoice:file:<name>"), so a copy of a group-conversation file became a
-- SECOND thread holding the same messages. threadKeyFor now strips the index
-- too; bring the rows already written into line, so a conversation and its
-- replica share one thread instead of two. 7 rows on the reference appliance.
-- A plain UPDATE is safe here -- thread_id is a grouping key, not an identity
-- column: nothing arbitrates on it and no FK points at it.
UPDATE ci.communications c
   SET thread_id = regexp_replace(
         c.thread_id,
         '(T[0-9]{2}_[0-9]{2}_[0-9]{2}Z)[[:space:]]*\([0-9]+\)$',
         '\1'
       )
 WHERE c.source_system = 'google_voice'
   AND c.thread_id LIKE 'googlevoice:file:%'
   AND c.thread_id ~ '(T[0-9]{2}_[0-9]{2}_[0-9]{2}Z)[[:space:]]*\([0-9]+\)$';

-- ## Post-migration verification
--
-- Should now be 0 (no communication row left that came from a copy-indexed
-- file whose original was imported in the same run):
--   WITH staged AS (
--     SELECT run_id, content_hash, filename,
--            regexp_replace(filename,
--              '(T[0-9]{2}_[0-9]{2}_[0-9]{2}Z)[[:space:]]*\([0-9]+\)(\.[A-Za-z0-9]+)$',
--              '\1\2') AS original_filename
--       FROM ci_import.staged_items
--      WHERE data_source = 'google_voice' AND filename IS NOT NULL)
--   SELECT count(*) FROM ci.communications c
--     JOIN staged k ON k.content_hash = c.source_id
--    WHERE c.source_system = 'google_voice'
--      AND k.filename <> k.original_filename
--      AND EXISTS (SELECT 1 FROM staged b
--                   WHERE b.run_id = k.run_id AND b.filename = k.original_filename);
--
-- Should now be 0 (no file-derived Google Voice thread still carries an index):
--   SELECT count(*) FROM ci.communications
--    WHERE source_system = 'google_voice'
--      AND thread_id ~ 'T[0-9]{2}_[0-9]{2}_[0-9]{2}Z[[:space:]]*\([0-9]+\)$';
--
-- Should now be 0 (nothing dangling in the hand-cleaned tables):
--   SELECT count(*) FROM ci_search.vectors v
--    WHERE v.entity_type = 'communication'
--      AND NOT EXISTS (SELECT 1 FROM ci.entities e WHERE e.entity_id = v.entity_id);
--
-- The truncated-name calls Google Voice indexed itself must be UNCHANGED --
-- expect the same count before and after (419 on the reference appliance):
--   SELECT count(*) FROM ci_import.staged_items
--    WHERE data_source = 'google_voice'
--      AND filename ~ '\([0-9]+\)\.[A-Za-z0-9]+$'
--      AND filename !~ 'T[0-9]{2}_[0-9]{2}_[0-9]{2}Z[[:space:]]*\([0-9]+\)\.[A-Za-z0-9]+$';

-- migrate:down
-- No-op: irreversible data cleanup, same reasoning as
-- 20260819001323_cleanup_contentless_instagram_activity_rows and the other
-- repair migrations here. Nothing records which rows were deleted versus
-- already absent, and the deleted rows were replicas of rows that remain.
-- Re-importing the Google Voice export is the forward path.
