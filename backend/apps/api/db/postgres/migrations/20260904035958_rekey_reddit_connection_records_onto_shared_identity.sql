-- migrate:up
-- Move every row the Reddit CONNECTION wrote before #2561 onto the identity and
-- the table that PR made canonical, in place.
--
-- ## What #2561 changed, and what it left behind
--
-- Before it, the three Reddit transforms (TransformPosts / TransformComments /
-- TransformSaved) wrote each post and comment TWICE: a `ci.content` row typed
-- `reddit_post` / `reddit_comment`, and a `ci.events` row typed `reddit_post`,
-- `reddit_comment`, `reddit_saved_post` or `reddit_saved_comment`. Both were
-- keyed `platformIdentity('reddit', <fullname>)` -- system `reddit`, id the raw
-- Reddit fullname `t3_xfkamy` / `t1_abc123`. (`reddit_posts`, `reddit_comments`
-- and `reddit_saved` all alias to `reddit` in SYSTEM_ALIASES, so the event and
-- the content row shared one key.)
--
-- #2561 replaced all three with RedditRecordWriter, which writes what the
-- GDPR-export importer writes:
--
--   * a dated post or comment the user WROTE -> `ci.communications`
--     (+ a `ci.content` row only when the record carries media),
--   * a SAVED or UNDATED record            -> `ci.content` alone,
--   * NO `ci.events` row, ever
--     (destinationsFor in import/push/canonical.ts agrees: reddit posts and
--     comments route to ['communications'] / ['communications','content'] /
--     ['content'], never to events),
--
-- under `redditIdentity(kind, fullname)` -- `reddit:<kind>:<bare id>`,
-- e.g. `reddit:post:xfkamy`, the spelling the importer has always stamped.
--
-- So the change moved BOTH halves of the record's identity: the `source_id`
-- (`t3_xfkamy` -> `reddit:post:xfkamy`) and the destination table. `source_id`
-- IS the unique key on every destination -- `content_source_identity_uniq`,
-- `events_source_identity_uniq` and `communications_source_identity_uniq` are
-- all `(user_id, source_system, source_id)` -- so every row already written by
-- the connection now sits under a key NOTHING will ever emit again. The next
-- arrival of the same post, from either pipeline, does not update it: it
-- inserts a second row beside it. That is the trap 20260904023747 (Google Maps
-- positional ids) and 20260821025524 (Google Voice copy index) were written
-- for, and leaving these rows is strictly worse than never having changed the
-- key.
--
-- ## Why the writer's own legacy sweep does not cover this
--
-- RedditRecordWriter.removeLegacyRows() deletes the old content + event rows
-- for a record -- but only for a record the sync hands it again, and for posts
-- and comments the sync never does:
--
--   * ci.providers' Reddit endpoints declare `"TTL": null` for Posts and
--     Comments (20260819151815). SyncOrchestrator.orchestrateHistorical()
--     returns early when `providerEndpoint.TTL == null`, so once the historical
--     walk exhausts its cursor those two endpoints are NEVER walked again.
--   * The incremental path (syncRedditUserListing in sync/redditListing.ts)
--     stops at the first item with `created_utc < since`, where `since` is the
--     previous sync's timestamp. An already-stored post is by definition older
--     than that, so it is never re-delivered either.
--
-- The sweep is therefore reachable only for records created AFTER the code
-- change -- which have no legacy rows -- plus the Saved endpoint, whose
-- `"TTL": 86400` does re-walk daily but only over items still saved and still
-- inside Reddit's ~1000-entry listing cap. A migration is the only thing that
-- reaches the rest.
--
-- ## What this migration does with each row
--
-- Scoped by SHAPE, not by run: `source_system = 'reddit'` AND a `source_id`
-- still wearing a bare fullname (`^t[1-6]_`). Nothing else in either pipeline
-- writes that shape -- the importer's ids all begin `reddit:` (its
-- `redditRecordId` call is a no-op on the bare ids the CSVs carry) -- so the
-- predicate selects exactly the connection's pre-#2561 rows and nothing else,
-- and re-running it is a no-op.
--
--   1. An authored, DATED post or comment becomes the `ci.communications` row
--      the writer would have written, and its content + event rows are then
--      deleted. Not deleted outright: `ci.content` has no time column, so the
--      event's `start_time` (the record's `created_utc`) is the only surviving
--      record of when the post happened, and dropping the pair would lose it
--      along with the body. Not re-keyed in place either: a content row for a
--      media-less post is a row the model no longer produces, so it would sit
--      beside the communication the next import writes and index the same text
--      twice -- the doubling this migration exists to prevent, moved rather
--      than fixed.
--   2. A SAVED record, or an authored one with no event row to date it, keeps
--      its `ci.content` row -- content alone IS its canonical home -- and is
--      re-keyed IN PLACE. In-place keeps the uuid, and `ci_search.vectors` /
--      `.embeddings` are keyed `(entity_type, entity_id)` on that uuid rather
--      than on `source_id`, so re-keying leaves no stale index rows and needs
--      no ci_search maintenance at all. The row is also retyped `social` (what
--      `contentRow` now emits for a media-less record) -- which additionally
--      takes it out of removeLegacyRows()' `LEGACY_CONTENT_TYPES`, so a later
--      sweep cannot delete the row this migration just made canonical.
--   3. A SAVED record whose content row is already gone -- the one shape steps
--      1 and 2 would otherwise drop -- has one minted from the event before the
--      event goes, so no record leaves this migration without a home.
--   4. EVERY legacy `ci.events` row is deleted. The model writes no Reddit
--      events on either pipeline, so re-keying one would only move an orphan.
--      Its `start_time` is not lost: it becomes the communication's `time` in
--      case 1 and `source_data.item_created_at` in cases 2 and 3 -- the same
--      field RedditRecordWriter puts it in.
--
-- Deletes carry the full entity teardown 20260821025524 established
-- (relationships, ci_search.{embeddings,vectors,entity_tag,index_skips},
-- ci.pipeline_state, ci.pipeline_dead_letters, ci.graph_deltas, then the
-- ci.entities base row, which cascades the detail row away). That matters here
-- beyond tidiness: an index row outlives its source row until something deletes
-- it explicitly, and would answer searches forever.
--
-- `ci.merge_candidates` is not an option for any of this: it is Person/Item
-- ONLY -- both detectors (`DuplicateDetectStage` -> 'Person',
-- `ObjectDuplicateDetectStage` -> 'Item') and `MergeCandidateService` (which
-- hydrates `people`) are typed to those two, and the live table holds nothing
-- else. Content, Event and Communication rows are outside that machinery, so
-- there is no dedup lane to hand this to.
--
-- The communications this creates carry no `ci_search` rows (nothing indexes
-- from SQL). They are picked up by the usual
-- `POST /api/maintenance/search-index/backfill`, the same as the rows
-- 20260818174213 created.

DROP TABLE IF EXISTS _reddit_legacy;
DROP TABLE IF EXISTS _reddit_to_communication;
DROP TABLE IF EXISTS _reddit_communication_rows;
DROP TABLE IF EXISTS _reddit_content_from_event;
DROP TABLE IF EXISTS _reddit_content_losers;

-- The working set: one row per (user_id, fullname), pairing the legacy content
-- row with the legacy event row that describes the same record. FULL OUTER so a
-- half-written record (either side missing) is still repaired.
CREATE TEMP TABLE _reddit_legacy ON COMMIT DROP AS
WITH legacy_content AS (
  SELECT c.id                                 AS content_id,
         c.user_id,
         c.source_id                          AS fullname,
         c.type                               AS content_type,
         c.text                               AS content_text,
         c.url                                AS content_url,
         COALESCE(c.source_data, '{}'::jsonb) AS source_data,
         c.connection_id                      AS content_connection_id,
         cb.name                              AS content_name
    FROM ci.content c
    JOIN ci.entities cb
      ON cb.entity_id = c.id AND cb.entity_type = 'Content'
   WHERE c.source_system = 'reddit'
     AND c.source_id ~ '^t[1-6]_'
),
legacy_events AS (
  SELECT e.event_id,
         e.user_id,
         e.source_id     AS fullname,
         e.event_type,
         e.start_time,
         e.connection_id AS event_connection_id,
         eb.name         AS event_name,
         eb.description  AS event_description
    FROM ci.events e
    JOIN ci.entities eb
      ON eb.entity_id = e.event_id AND eb.entity_type = 'Event'
   WHERE e.source_system = 'reddit'
     AND e.source_id ~ '^t[1-6]_'
),
paired AS (
  SELECT COALESCE(c.user_id, e.user_id)               AS user_id,
         COALESCE(c.fullname, e.fullname)             AS fullname,
         c.content_id,
         c.content_type,
         c.content_text,
         c.content_url,
         COALESCE(c.source_data, '{}'::jsonb)         AS source_data,
         c.content_connection_id,
         c.content_name,
         e.event_id,
         e.event_type,
         e.start_time,
         e.event_connection_id,
         e.event_name,
         e.event_description,
         -- The record kind, which the new key carries and the old one did not.
         -- The EVENT's own type states all four unambiguously, so it wins. Only
         -- when there is no event row does the content row have to answer, and
         -- it can: `source_data.saved` was set by the saved transform alone, and
         -- the `t1_` prefix tells a comment from a post.
         --
         -- Where the two DISAGREE (a post the user both wrote and saved: both
         -- old transforms find-or-created on the same key, so whichever ran
         -- first owns each row and they can differ), the event is still taken.
         -- The old key conflated authored and saved by construction -- one id
         -- for both -- so no reading of these rows recovers the pair; taking
         -- what the row says is the only honest choice available.
         CASE
           WHEN e.event_type = 'reddit_saved_post'    THEN 'saved_post'
           WHEN e.event_type = 'reddit_saved_comment' THEN 'saved_comment'
           WHEN e.event_type = 'reddit_post'          THEN 'post'
           WHEN e.event_type = 'reddit_comment'       THEN 'comment'
           WHEN (c.source_data ->> 'saved') = 'true'
             THEN CASE WHEN COALESCE(c.fullname, e.fullname) LIKE 't1\_%'
                       THEN 'saved_comment' ELSE 'saved_post' END
           ELSE CASE WHEN COALESCE(c.fullname, e.fullname) LIKE 't1\_%'
                     THEN 'comment' ELSE 'post' END
         END AS kind
    FROM legacy_content c
    FULL OUTER JOIN legacy_events e
      ON e.user_id = c.user_id
     AND e.fullname = c.fullname
)
SELECT p.*,
       -- redditRecordId(kind, fullname) in memory/identity/reddit.ts, verbatim:
       -- `reddit:<kind>:<bare id>`, the fullname's `t<n>_` prefix stripped.
       'reddit:' || p.kind || ':' || regexp_replace(p.fullname, '^t[1-6]_', '') AS new_source_id,
       -- The record's body, as `content` in RedditRecordWriter.write():
       -- `record.text.trim() || record.title?.trim() || ''`. The old content
       -- row's `text` already held exactly that (selftext-or-title for a post,
       -- the body for a comment); the event's description is the same string,
       -- and stands in when the content row is missing.
       COALESCE(NULLIF(btrim(p.content_text), ''), NULLIF(btrim(p.event_description), ''), '') AS body,
       -- The subreddit, for the `r/<name>` thread. Stored on source_data by the
       -- old transforms; recovered from the permalink, or from the event's own
       -- title, when the row that held it is missing. All four old event titles
       -- name it, each behind a fixed phrase:
       --
       --   Posted in r/x: T            Commented on 'y' in r/x
       --   Saved post in r/x: T        Saved comment on 'y' in r/x
       --
       -- The phrase is matched rather than the bare `r/` so a link_title that
       -- itself mentions a subreddit cannot win; the greedy `.*` puts the match
       -- on the LAST ' in r/', which is the real one.
       COALESCE(
         NULLIF(btrim(p.source_data ->> 'subreddit'), ''),
         substring(COALESCE(p.content_url, '') FROM '/r/([A-Za-z0-9_]+)'),
         substring(COALESCE(p.event_name, '')
                   FROM '(?:Posted in|Saved post in|Commented on .* in|Saved comment on .* in) r/([A-Za-z0-9_]+)')
       ) AS subreddit
  FROM paired p;

CREATE INDEX ON _reddit_legacy (user_id, new_source_id);

-- ------------------------------------------------- 1. authored + dated --

-- `NOT EXISTS` rather than an upsert: the importer may already have written
-- this exact communication (that convergence is the whole point of the shared
-- key), in which case the legacy rows still have to go but nothing new is
-- inserted.
CREATE TEMP TABLE _reddit_to_communication ON COMMIT DROP AS
SELECT l.user_id,
       l.fullname,
       l.kind,
       l.new_source_id,
       l.body,
       l.subreddit,
       l.source_data,
       l.content_id,
       l.content_name,
       l.event_id,
       l.event_name,
       l.start_time,
       COALESCE(l.content_connection_id, l.event_connection_id) AS connection_id,
       ci.gen_uuid_v7()                                         AS communication_id
  FROM _reddit_legacy l
 WHERE l.kind IN ('post', 'comment')
   AND l.start_time IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM ci.communications m
      WHERE m.user_id = l.user_id
        AND m.source_system = 'reddit'
        AND m.source_id = l.new_source_id
   );

-- The derived fields, computed once so the base row and the detail row cannot
-- drift: `clip(content, 140)` from RedditRecordWriter (one line, 140 chars, an
-- ellipsis on the 140th), and the subject, which only a POST has -- a comment
-- has no authored title and the writer deliberately leaves its subject blank.
--
-- The stored title is decorated on rows the old transforms wrote through their
-- own titling ("Posted in r/x: Title", "Saved post in r/x: Title"); the prefix
-- is stripped back off. A subreddit name is `[A-Za-z0-9_]+`, so the pattern
-- carries no regex metacharacter risk, and an undecorated title matches nothing
-- and passes through unchanged.
CREATE TEMP TABLE _reddit_communication_rows ON COMMIT DROP AS
SELECT c.*,
       CASE WHEN c.kind = 'post'
            THEN NULLIF(btrim(regexp_replace(COALESCE(c.content_name, c.event_name, ''),
                                             '^(Posted in|Saved post in) r/[A-Za-z0-9_]+: ', '')), '')
       END AS subject,
       CASE WHEN length(btrim(regexp_replace(c.body, '\s+', ' ', 'g'))) > 140
            THEN left(btrim(regexp_replace(c.body, '\s+', ' ', 'g')), 139) || '…'
            ELSE btrim(regexp_replace(c.body, '\s+', ' ', 'g'))
       END AS clipped
  FROM _reddit_to_communication c;

-- The base CTI row first, mirroring 20260811061411's derivation of the display
-- label: subject, else preview, else the clip of content.
INSERT INTO ci.entities
  (entity_id, entity_type, name, description, properties,
   owner_user_id, linked_table, linked_id, created_at, updated_at)
SELECT r.communication_id,
       'Communication',
       COALESCE(NULLIF(btrim(r.subject), ''), NULLIF(r.clipped, '')),
       NULL,
       '{}'::jsonb,
       r.user_id,
       'communications',
       r.communication_id,
       r.start_time,
       r.start_time
  FROM _reddit_communication_rows r;

INSERT INTO ci.communications
  (id, "time", user_id, communication_type, direction, thread_id, subject, content,
   preview, attachments, connection_id, source_type, source_system, source_id, metadata)
SELECT r.communication_id,
       r.start_time,
       r.user_id,
       'post'::ci.communication_type,
       'outbound'::ci.communication_direction,
       CASE WHEN r.subreddit IS NOT NULL THEN 'r/' || r.subreddit END,
       r.subject,
       r.body,
       -- The writer sets `preview` only when clipping actually changed the text.
       CASE WHEN r.clipped <> r.body THEN r.clipped END,
       '[]'::jsonb,
       r.connection_id::text,
       'ETL',
       'reddit',
       r.new_source_id,
       -- RedditRecordWriter's `sourceData` bag, rebuilt over whatever the old
       -- transform stored (it kept `reddit_post_id`, `subreddit`, `score`,
       -- `author` and friends). Merged rather than replaced, exactly as the
       -- writer's own update path merges over an existing row's metadata.
       r.source_data || jsonb_strip_nulls(jsonb_build_object(
         'reddit_fullname', r.fullname,
         'reddit_id',       regexp_replace(r.fullname, '^t[1-6]_', ''),
         'kind',            r.kind,
         'permalink',       (SELECT l.content_url FROM _reddit_legacy l
                              WHERE l.user_id = r.user_id AND l.fullname = r.fullname),
         'subreddit',       r.subreddit,
         'item_created_at', to_char(r.start_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       ))
  FROM _reddit_communication_rows r;

-- The ledger follows the row. `ci.record_sources` is what disconnect and
-- undo-import key deletion on, so a communication with no arrival row would be
-- invisible to both.
--
-- Joined back to ci.communications rather than to the rows just inserted, so
-- that a record whose communication the IMPORTER had already written is
-- ledgered too: the connection genuinely evidenced it, its own arrival rows are
-- about to be deleted with the legacy content and event, and this is the
-- `recordArrival` the writer makes on exactly that dedup hit.
INSERT INTO ci.record_sources
  (user_id, record_table, record_id, source_type, source_system, source_id, connection_id, platform)
SELECT l.user_id, 'communications', m.id, 'ETL', 'reddit', l.new_source_id,
       COALESCE(l.content_connection_id, l.event_connection_id), 'reddit'
  FROM _reddit_legacy l
  JOIN ci.communications m
    ON m.user_id = l.user_id
   AND m.source_system = 'reddit'
   AND m.source_id = l.new_source_id
 WHERE l.kind IN ('post', 'comment')
   AND l.start_time IS NOT NULL
ON CONFLICT DO NOTHING;

-- ------------------------------- 1b. a saved record with no content row --

-- The only way step 3 could lose a record: a SAVED event whose content row is
-- already gone (its own transform wrote content first, so this needs the
-- content row to have been removed afterwards -- which removeLegacyRows does,
-- and can be interrupted between the two deletes). Content alone IS the
-- canonical home for a saved record, so the row is minted from the event
-- rather than the event being deleted out from under it. There is no permalink
-- to recover -- ci.events has no url column -- but the identity, the title and
-- the body all survive, which deleting would not.
CREATE TEMP TABLE _reddit_content_from_event ON COMMIT DROP AS
SELECT l.user_id,
       l.fullname,
       l.kind,
       l.new_source_id,
       l.subreddit,
       l.start_time,
       l.event_name,
       l.body,
       l.event_connection_id,
       ci.gen_uuid_v7() AS content_id
  FROM _reddit_legacy l
 WHERE l.content_id IS NULL
   AND l.kind IN ('saved_post', 'saved_comment')
   AND NOT EXISTS (
     SELECT 1
       FROM ci.content c
      WHERE c.user_id = l.user_id
        AND c.source_system = 'reddit'
        AND c.source_id = l.new_source_id
   );

INSERT INTO ci.entities
  (entity_id, entity_type, name, description, properties,
   owner_user_id, linked_table, linked_id, created_at, updated_at)
SELECT r.content_id, 'Content', r.event_name, NULL, '{}'::jsonb,
       r.user_id, 'content', r.content_id, now(), now()
  FROM _reddit_content_from_event r;

INSERT INTO ci.content
  (id, type, text, external_id, external_id_kind, user_id, connection_id,
   source_type, source_system, source_id, source_data)
SELECT r.content_id, 'social', NULLIF(r.body, ''), r.fullname, 'external_uri',
       r.user_id, r.event_connection_id, 'ETL', 'reddit', r.new_source_id,
       jsonb_strip_nulls(jsonb_build_object(
         'reddit_fullname', r.fullname,
         'reddit_id',       regexp_replace(r.fullname, '^t[1-6]_', ''),
         'kind',            r.kind,
         'subreddit',       r.subreddit,
         'item_created_at',
           CASE WHEN r.start_time IS NOT NULL
                THEN to_char(r.start_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
       ))
  FROM _reddit_content_from_event r;

INSERT INTO ci.record_sources
  (user_id, record_table, record_id, source_type, source_system, source_id, connection_id, platform)
SELECT r.user_id, 'content', r.content_id, 'ETL', 'reddit', r.new_source_id,
       r.event_connection_id, 'reddit'
  FROM _reddit_content_from_event r
ON CONFLICT DO NOTHING;

-- --------------------------------------------- 2. saved / undated: re-key --

-- A legacy content row whose new key is ALREADY taken by a different content
-- row (the importer got there first) cannot be re-keyed -- and does not need to
-- be: its twin is already correct. It joins the rows deleted below.
CREATE TEMP TABLE _reddit_content_losers ON COMMIT DROP AS
SELECT l.content_id AS id
  FROM _reddit_legacy l
 WHERE l.content_id IS NOT NULL
   AND (
     -- The record became a communication; its content row is superseded.
     EXISTS (SELECT 1 FROM _reddit_to_communication t
              WHERE t.content_id = l.content_id)
     OR EXISTS (SELECT 1 FROM ci.communications m
                 WHERE m.user_id = l.user_id
                   AND m.source_system = 'reddit'
                   AND m.source_id = l.new_source_id
                   AND l.kind IN ('post', 'comment')
                   AND l.start_time IS NOT NULL)
     -- Or a content row already holds the new key.
     OR EXISTS (SELECT 1 FROM ci.content c2
                 WHERE c2.user_id = l.user_id
                   AND c2.source_system = 'reddit'
                   AND c2.source_id = l.new_source_id
                   AND c2.id <> l.content_id)
   );

CREATE INDEX ON _reddit_content_losers (id);

UPDATE ci.content c
   SET source_id   = l.new_source_id,
       -- What `contentRow` now emits for a media-less Reddit record.
       type        = 'social',
       source_data = COALESCE(c.source_data, '{}'::jsonb)
                       || jsonb_strip_nulls(jsonb_build_object(
                            'reddit_fullname', l.fullname,
                            'reddit_id',       regexp_replace(l.fullname, '^t[1-6]_', ''),
                            'kind',            l.kind,
                            'permalink',       l.content_url,
                            'subreddit',       l.subreddit,
                            'item_created_at',
                              CASE WHEN l.start_time IS NOT NULL
                                   THEN to_char(l.start_time AT TIME ZONE 'UTC',
                                                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
                          )),
       updated_at  = now()
  FROM _reddit_legacy l
 WHERE c.id = l.content_id
   AND NOT EXISTS (SELECT 1 FROM _reddit_content_losers x WHERE x.id = c.id)
   AND c.source_id IS DISTINCT FROM l.new_source_id;

UPDATE ci.record_sources rs
   SET source_id = l.new_source_id
  FROM _reddit_legacy l
 WHERE rs.record_table = 'content'
   AND rs.record_id = l.content_id
   AND rs.source_id = l.fullname
   AND NOT EXISTS (SELECT 1 FROM _reddit_content_losers x WHERE x.id = l.content_id)
   AND NOT EXISTS (
     SELECT 1 FROM ci.record_sources other
      WHERE other.user_id = rs.user_id
        AND other.record_table = rs.record_table
        AND other.source_type = rs.source_type
        AND other.source_system = rs.source_system
        AND other.source_id = l.new_source_id
        AND other.platform IS NOT DISTINCT FROM rs.platform
   );

-- ------------------------------------------------------- 3. teardown --

-- ci.content.event_id FKs ci.events ON DELETE CASCADE, so a surviving re-keyed
-- content row still pointing at a legacy event would be deleted along with it.
UPDATE ci.content c
   SET event_id = NULL
  FROM _reddit_legacy l
 WHERE c.event_id = l.event_id
   AND l.event_id IS NOT NULL;

-- hbpe.l1_event_cluster's FK to ci.events carries no ON DELETE action, so its
-- rows have to go first or the delete below raises.
DELETE FROM hbpe.l1_event_cluster lc
 USING _reddit_legacy l
 WHERE lc.event_id = l.event_id;

DELETE FROM ci.record_sources rs
 USING _reddit_legacy l
 WHERE rs.record_table = 'events'
   AND rs.record_id = l.event_id;

DELETE FROM ci.record_sources rs
 USING _reddit_content_losers x
 WHERE rs.record_table = 'content'
   AND rs.record_id = x.id;

DELETE FROM ci.relationships r
 USING _reddit_legacy l
 WHERE l.event_id IS NOT NULL
   AND (r.from_entity_id = l.event_id OR r.to_entity_id = l.event_id);

DELETE FROM ci.relationships r
 USING _reddit_content_losers x
 WHERE r.from_entity_id = x.id OR r.to_entity_id = x.id;

DELETE FROM ci_search.embeddings e
 USING _reddit_legacy l
 WHERE e.entity_id = l.event_id;

DELETE FROM ci_search.embeddings e
 USING _reddit_content_losers x
 WHERE e.entity_id = x.id;

DELETE FROM ci_search.vectors v
 USING _reddit_legacy l
 WHERE v.entity_id = l.event_id;

DELETE FROM ci_search.vectors v
 USING _reddit_content_losers x
 WHERE v.entity_id = x.id;

DELETE FROM ci_search.entity_tag t
 USING _reddit_legacy l
 WHERE t.entity_id = l.event_id;

DELETE FROM ci_search.entity_tag t
 USING _reddit_content_losers x
 WHERE t.entity_id = x.id;

DELETE FROM ci_search.index_skips s
 USING _reddit_legacy l
 WHERE s.entity_id = l.event_id;

DELETE FROM ci_search.index_skips s
 USING _reddit_content_losers x
 WHERE s.entity_id = x.id;

DELETE FROM ci.pipeline_state ps
 USING _reddit_legacy l
 WHERE ps.entity_id = l.event_id;

DELETE FROM ci.pipeline_state ps
 USING _reddit_content_losers x
 WHERE ps.entity_id = x.id;

DELETE FROM ci.pipeline_dead_letters dl
 USING _reddit_legacy l
 WHERE dl.entity_id = l.event_id;

DELETE FROM ci.pipeline_dead_letters dl
 USING _reddit_content_losers x
 WHERE dl.entity_id = x.id;

DELETE FROM ci.graph_deltas gd
 USING _reddit_legacy l
 WHERE gd.entity_id = l.event_id;

DELETE FROM ci.graph_deltas gd
 USING _reddit_content_losers x
 WHERE gd.entity_id = x.id;

-- Last: the base rows, which take ci.events / ci.content with them through the
-- ON DELETE CASCADE half of the CTI FK. The temp tables are materialized
-- snapshots, so they still list the ids after the cascade fires.
DELETE FROM ci.entities en
 WHERE en.entity_type = 'Event'
   AND en.entity_id IN (SELECT event_id FROM _reddit_legacy WHERE event_id IS NOT NULL);

DELETE FROM ci.entities en
 WHERE en.entity_type = 'Content'
   AND en.entity_id IN (SELECT id FROM _reddit_content_losers);

-- migrate:down
-- No-op: irreversible, same reasoning as the other repair migrations here.
--
-- The pre-#2561 shape cannot be rebuilt from what survives. The bare fullname
-- is still derivable from the new id, but the two rows it keyed are not: the
-- `ci.events` rows are gone, and the authored records now live in a different
-- table under a row the old code has no writer for. Rolling the code back would
-- in any case re-emit fullname-keyed content and event rows on the next sync
-- and re-open the defect.
