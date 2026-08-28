-- migrate:up
-- Remove the empty ci.content rows a LinkedIn connection and a moderated
-- subreddit each wrote — already fixed for future imports in this same branch
-- (push/canonical.ts isSocialAffiliation, and the social.* arm of
-- destinationsFor that now reads it).
--
-- ## The bug
--
-- `destinationsFor` routed every `social.*` record to ['events', 'content'],
-- and `toContentInput` fills a content row's body from exactly three metadata
-- keys: Text/Description (via descriptionFor), Title, and URL. A LinkedIn
-- connection carries none of the first two and no URL at all — the profile URL
-- rides on the PERSON entity the same parser emits (datasources/linkedin.ts
-- pushes `{ entity: { type: 'contact', metadata: { URL } } }` beside the item),
-- never on the item — and a moderated subreddit carries only its own name.
--
-- ci.content has no title column, so `title` is dropped on the way in. What
-- landed was a row typed 'post' with a NULL text, a NULL url, a NULL
-- external_id and nothing else: an entry that names nothing, links to nothing
-- and embeds nothing, in every Content view.
--
-- ## Why these rows are DELETED rather than repaired in place
--
-- Because there is nothing they should be repaired INTO. The facts were never
-- lost — each connection is already:
--
--   * a ci.entities Person row carrying the profile URL in properties
--     ("Morgan Spadone", properties->>'URL' = https://www.linkedin.com/in/spadone), and
--   * a dated ci.events row (event_type='social', metadata.Title =
--     'Connected with Morgan Spadone').
--
-- and each moderated subreddit is already an event titled 'r/<sub>'. The
-- content row was a third, empty copy of a relationship and a membership —
-- neither of which is authored content. Filling its `text` from the Title
-- would have made 1,975 rows reading "Connected with <name>" that duplicate the
-- event verbatim and add nothing searchable that the Person entity does not
-- already carry.
--
-- A re-import does NOT remove them on its own: INGEST_REFRESH_COLUMNS.content
-- is [], so ingest is find-or-return and a second import of the same export
-- returns the existing blank row untouched. Deleting is the whole repair.
--
-- ## Why the fixed router cannot re-create them
--
-- `isSocialAffiliation` keys on the same (source_system, metadata.Kind) pair
-- this migration keys on, so a re-import of either export now sends these
-- records to 'events' alone. It also covers 'subscribed_subreddit' — a Kind
-- pushSubreddit emits for subscribed_subreddits.csv, which the reddit importer
-- does not read today — so enabling that file cannot reintroduce the shape.
--
-- ## Verified against a real appliance database before writing this migration
--
--   SELECT source_system, type, count(*) FROM ci.content
--    WHERE coalesce(btrim(text),'') = '' AND coalesce(btrim(url),'') = ''
--    GROUP BY 1, 2;
--   -- linkedin | post | 1975      <- every LinkedIn content row that exists
--   -- reddit   | post |    2      <- every Reddit content row that exists
--   -- (vcard/file 2085, amazon/app 92, amazon/media 33 also appear and are
--   --  NOT in range here: different sources, different causes, untouched.)
--
--   -- The predicate below selects exactly 1,977 rows: the 1,975 + 2 above and
--   -- nothing else. Zero LinkedIn or Reddit content rows are correct today, so
--   -- nothing correct is touched.
--
--   -- Reference audit for those 1,977 content ids (only ci.content and
--   -- ci.events carry FKs to ci.entities; ci.relationships, ci_search.*,
--   -- ci.pipeline_state and ci.graph_deltas hold plain uuid columns and are
--   -- cleaned by hand, exactly as in 20260819001323):
--   --   ci.entities                 1977   <- deleted (cascades to ci.content)
--   --   ci_search.embeddings        1977   <- deleted
--   --   ci_search.vectors           1977   <- deleted
--   --   ci.pipeline_state           3956   <- deleted (3,954 content rows, two
--   --                                      stages each, + 2 'entity' rows)
--   --   ci.graph_deltas             1977   <- deleted
--   --   ci.relationships (from/to)     0   <- deleted defensively
--   --   hbpe.content_context           0   <- FK, deleted defensively
--   --   hbpe.l2_content_cluster        0   <- FK, deleted defensively
--   --   ci_search.entity_tag           0
--   --   ci_search.index_skips          0
--   --   ci.pipeline_dead_letters       0
--   --   ci.entity_identifiers          0
--   --   ci.identifier_claims           0
--
-- ## Scope guards
--
-- Provenance first: source_type/source_system/source_data->>'Kind' together
-- name the exact records the fixed router now withholds, so no other source's
-- rows are considered at all. The three emptiness guards then make this safe
-- against a row of that provenance that somehow DOES carry a body — a repaired
-- row with a URL, or a future parser change that starts populating Text —
-- which survives untouched. `external_id IS NULL` is the same guard that keeps
-- a file-bearing row safe in 20260819001323.
--
-- Emptiness is spelled `!~ '[^[:space:]]'` (no non-whitespace character) rather
-- than `btrim(x) = ''`: btrim strips SPACES ONLY, so the btrim form reads a
-- body of "\n\n" as present. See the same note in import/doctor/checks.ts.
--
-- Idempotent: every statement reads the same temp table, and a second run
-- selects zero rows. The ci.entities delete goes last and takes ci.content with
-- it through content_id_entities_fk (ON DELETE CASCADE).

-- Guards a manual re-run inside a session that already ran this migration and
-- has not committed/disconnected (ON COMMIT DROP only clears it at commit).
DROP TABLE IF EXISTS _blank_affiliation_content;

CREATE TEMP TABLE _blank_affiliation_content ON COMMIT DROP AS
SELECT c.id
  FROM ci.content c
 WHERE c.source_type = 'ci-import-tools'
   AND (
        (c.source_system = 'linkedin' AND c.source_data ->> 'Kind' = 'connection')
     OR (
          c.source_system = 'reddit'
          AND c.source_data ->> 'Kind' IN ('moderated_subreddit', 'subscribed_subreddit')
        )
       )
   AND c.external_id IS NULL
   AND coalesce(c.text, '') !~ '[^[:space:]]'
   AND coalesce(c.url, '') !~ '[^[:space:]]';

DELETE FROM ci.relationships r
 USING _blank_affiliation_content bad
 WHERE r.from_entity_id = bad.id
    OR r.to_entity_id = bad.id;

DELETE FROM ci_search.embeddings emb
 USING _blank_affiliation_content bad
 WHERE emb.entity_type = 'content'
   AND emb.entity_id = bad.id;

DELETE FROM ci_search.vectors v
 USING _blank_affiliation_content bad
 WHERE v.entity_type = 'content'
   AND v.entity_id = bad.id;

-- Deliberately NOT filtered on entity_type = 'content', unlike the two
-- ci_search deletes above. The id being removed is a ci.entities entity_id, and
-- the ENTITY pipeline has stages of its own that key on it: the live appliance
-- holds 3,954 'content' rows here (index.embed + index.vector per row) plus 2
-- 'entity' rows (clean.identifier_normalize). Filtering by entity_type would
-- have stranded those 2 pointing at an id that no longer exists.
DELETE FROM ci.pipeline_state ps
 USING _blank_affiliation_content bad
 WHERE ps.entity_id = bad.id;

DELETE FROM ci.graph_deltas gd
 USING _blank_affiliation_content bad
 WHERE gd.entity_id = bad.id;

DELETE FROM hbpe.content_context cc
 USING _blank_affiliation_content bad
 WHERE cc.content_id = bad.id;

DELETE FROM hbpe.l2_content_cluster lc
 USING _blank_affiliation_content bad
 WHERE lc.content_id = bad.id;

-- Deleting the ci.entities base row removes the ci.content row with it
-- (content_id_entities_fk, ON DELETE CASCADE).
DELETE FROM ci.entities e
 USING _blank_affiliation_content bad
 WHERE e.entity_type = 'Content'
   AND e.entity_id = bad.id;

-- ## Post-migration verification
--
-- Should now be 0 (no LinkedIn/Reddit content row without text or url):
--   SELECT count(*) FROM ci.content
--    WHERE source_system IN ('linkedin', 'reddit')
--      AND coalesce(text, '') !~ '[^[:space:]]'
--      AND coalesce(url, '') !~ '[^[:space:]]';
--
-- Should be UNCHANGED — the facts live here, and none of them are touched:
--   SELECT count(*) FROM ci.events WHERE source_system IN ('linkedin', 'reddit');   -- 1977
--   SELECT count(*) FROM ci.entities
--    WHERE entity_type = 'Person' AND properties ->> 'Source' = 'LinkedIn';         -- 1940
--
-- Should now be 0 (nothing dangling in the hand-cleaned tables):
--   SELECT count(*) FROM ci_search.vectors v
--    WHERE v.entity_type = 'content'
--      AND NOT EXISTS (SELECT 1 FROM ci.entities e WHERE e.entity_id = v.entity_id);
--   -- Scoped to the entity types that ARE ci.entities rows: browser-activity,
--   -- position and file are pipeline_state types with no base row by design,
--   -- and an unscoped version reports 6,860 of them on a healthy appliance.
--   SELECT count(*) FROM ci.pipeline_state ps
--    WHERE ps.entity_type IN ('content', 'entity', 'event')
--      AND NOT EXISTS (SELECT 1 FROM ci.entities e WHERE e.entity_id = ps.entity_id);

-- migrate:down
-- No-op: irreversible data cleanup, same reasoning as
-- 20260819001323_cleanup_contentless_instagram_activity_rows and the other
-- cleanup migrations in this directory. The removed rows carried no text, no
-- url and no file — there is nothing to restore them to, and nothing records
-- which rows were deleted versus already absent. The connection's Person
-- entity and its event, which are where these facts actually live, are
-- untouched by the up migration and need no restoring.
